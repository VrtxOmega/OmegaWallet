/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║       FRESH-AUTH GATE — Privileged Action Controller          ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Separates "vault unlocked" (convenience) from "freshly authenticated"
 * (proof of recent identity). All sensitive IPC actions go through here.
 *
 * Design:
 *   - authenticate(password) → issues short-lived opaque token
 *   - requireFresh(action, tokenOrPassword) → verifies or throws
 *   - Exponential cooldown on repeated auth failure
 *   - Full audit trail (encrypted, rolling)
 *   - Single-use nonce tracking for replay prevention
 */
const crypto = require('crypto');

// ─── Constants ───────────────────────────────────────────────
const FRESH_WINDOW_MS      = 30_000;       // 30s fresh-auth window
const TOKEN_BYTES          = 32;            // 256-bit opaque token
const MAX_AUDIT_ENTRIES    = 500;           // Rolling log cap
const NONCE_EXPIRY_MS      = 60_000;        // 1 min nonce lifetime

// Cooldown curve: [attempts → lockout_ms]
const COOLDOWN_CURVE = [
    { threshold: 3,  lockoutMs: 30_000  },  // 3 fails → 30s
    { threshold: 5,  lockoutMs: 120_000 },  // 5 fails → 2min
    { threshold: 8,  lockoutMs: 600_000 },  // 8 fails → 10min
];

class FreshAuth {
    /**
     * @param {object} ledger — encrypted-ledger instance (must have verifyPassword)
     */
    constructor(ledger) {
        this._ledger = ledger;

        // Current fresh-auth state
        this._token = null;
        this._expiresAt = 0;
        this._authenticatedAt = 0;

        // Failure tracking for cooldown
        this._failCount = 0;
        this._failTimestamps = [];
        this._lockedUntil = 0;

        // Nonce registry (requestId → { action, createdAt, used })
        this._nonces = new Map();

        // In-memory audit log (flushed to ledger periodically)
        this._auditBuffer = [];
    }

    // ═════════════════════════════════════════════════════════
    // PUBLIC API
    // ═════════════════════════════════════════════════════════

    /**
     * Authenticate with password, issue a fresh-auth token.
     * @param {string} password — vault password
     * @returns {{ ok, token?, expiresAt?, error? }}
     */
    authenticate(password) {
        const now = Date.now();

        // Check cooldown
        if (now < this._lockedUntil) {
            const remaining = Math.ceil((this._lockedUntil - now) / 1000);
            this._audit('auth:attempt', false, `COOLDOWN: ${remaining}s remaining`);
            return {
                ok: false,
                error: `Too many failed attempts. Try again in ${remaining}s.`,
                lockedUntil: this._lockedUntil,
            };
        }

        // Validate input
        if (!password || typeof password !== 'string') {
            this._audit('auth:attempt', false, 'INVALID_INPUT');
            return { ok: false, error: 'Password required.' };
        }

        // Verify against ledger
        try {
            this._ledger.verifyPassword(password);
        } catch {
            this._recordFailure(now);
            this._audit('auth:attempt', false, 'WRONG_PASSWORD');
            return { ok: false, error: 'Incorrect password.' };
        }

        // Success — issue token
        this._failCount = 0;
        this._failTimestamps = [];
        this._token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
        this._authenticatedAt = now;
        this._expiresAt = now + FRESH_WINDOW_MS;

        this._audit('auth:success', true);

        return {
            ok: true,
            token: this._token,
            expiresAt: this._expiresAt,
            windowMs: FRESH_WINDOW_MS,
        };
    }

    /**
     * Require fresh authentication for a sensitive action.
     * Accepts either a valid token or raw password.
     *
     * @param {string} action — action identifier (e.g. 'vault:getKey')
     * @param {string} tokenOrPassword — fresh-auth token or vault password
     * @returns {{ ok, requestId?, error? }}
     */
    requireFresh(action, tokenOrPassword) {
        const now = Date.now();

        if (!tokenOrPassword || typeof tokenOrPassword !== 'string') {
            this._audit(action, false, 'FRESH_AUTH_REQUIRED');
            return { ok: false, error: 'FRESH_AUTH_REQUIRED' };
        }

        // Try token first (fast path)
        if (this._token && tokenOrPassword === this._token && now < this._expiresAt) {
            const requestId = this._issueNonce(action, now);
            this._audit(action, true, `token:valid, nonce:${requestId}`);
            return { ok: true, requestId };
        }

        // Token invalid/expired — try as password
        const authResult = this.authenticate(tokenOrPassword);
        if (!authResult.ok) {
            this._audit(action, false, authResult.error);
            return { ok: false, error: authResult.error };
        }

        // Password succeeded — grant
        const requestId = this._issueNonce(action, now);
        this._audit(action, true, `password:verified, nonce:${requestId}`);
        return { ok: true, requestId, token: authResult.token, expiresAt: authResult.expiresAt };
    }

    /**
     * Validate and consume a single-use nonce/requestId.
     * @param {string} requestId
     * @returns {boolean}
     */
    consumeNonce(requestId) {
        const entry = this._nonces.get(requestId);
        if (!entry) return false;
        if (entry.used) return false;
        if (Date.now() > entry.createdAt + NONCE_EXPIRY_MS) {
            this._nonces.delete(requestId);
            return false;
        }
        entry.used = true;
        return true;
    }

    /**
     * Explicitly revoke fresh-auth status.
     */
    revoke() {
        this._token = null;
        this._expiresAt = 0;
        this._authenticatedAt = 0;
        this._audit('auth:revoked', true);
    }

    /**
     * Check current fresh-auth status.
     */
    status() {
        const now = Date.now();
        const isFresh = !!(this._token && now < this._expiresAt);
        return {
            isFresh,
            expiresAt: isFresh ? this._expiresAt : null,
            remainingMs: isFresh ? this._expiresAt - now : 0,
            failCount: this._failCount,
            lockedUntil: now < this._lockedUntil ? this._lockedUntil : null,
        };
    }

    /**
     * Get the audit log.
     * @param {number} count — max entries to return
     */
    getAuditLog(count = 50) {
        return this._auditBuffer.slice(-count);
    }

    /**
     * Flush audit buffer to encrypted ledger.
     */
    flushToLedger() {
        if (!this._ledger._initialized || this._auditBuffer.length === 0) return;
        try {
            for (const entry of this._auditBuffer) {
                this._ledger.recordAuditEntry(entry);
            }
            this._auditBuffer = [];
        } catch { /* ledger locked or unavailable */ }
    }

    // ═════════════════════════════════════════════════════════
    // PRIVATE
    // ═════════════════════════════════════════════════════════

    _recordFailure(now) {
        this._failCount++;
        this._failTimestamps.push(now);

        // Clean old timestamps (keep last 60s)
        this._failTimestamps = this._failTimestamps.filter(t => t > now - 60_000);

        // Apply cooldown curve
        for (const level of COOLDOWN_CURVE) {
            if (this._failCount >= level.threshold) {
                this._lockedUntil = now + level.lockoutMs;
            }
        }
    }

    _issueNonce(action, now) {
        // Garbage-collect expired nonces
        for (const [id, entry] of this._nonces) {
            if (now > entry.createdAt + NONCE_EXPIRY_MS) this._nonces.delete(id);
        }

        const requestId = crypto.randomBytes(16).toString('hex');
        this._nonces.set(requestId, { action, createdAt: now, used: false });
        return requestId;
    }

    _audit(action, success, detail = '') {
        const entry = {
            action,
            success,
            detail,
            timestamp: new Date().toISOString(),
            ts: Date.now(),
        };
        this._auditBuffer.push(entry);

        // Cap in-memory buffer
        if (this._auditBuffer.length > MAX_AUDIT_ENTRIES) {
            this._auditBuffer = this._auditBuffer.slice(-MAX_AUDIT_ENTRIES);
        }
    }
}

module.exports = { FreshAuth };
