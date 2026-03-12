/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║       ENCRYPTED LEDGER — AES-256-GCM + scrypt                ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Zero localStorage. All sensitive state encrypted to disk.
 * Key derived from master password via scrypt (Node built-in).
 *
 * Tables:
 *   vault       — encrypted wallet keys
 *   spend       — 24h rolling spend accumulator
 *   sessions    — ephemeral session key records
 *   extraction  — paymaster margin telemetry
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32; // AES-256
const SALT_LEN = 16;
const IV_LEN = 12;  // GCM standard
const TAG_LEN = 16; // GCM auth tag

class EncryptedLedger {
    constructor() {
        this._key = null;
        this._salt = null;
        this._dbPath = null;
        this._data = null;
        this._initialized = false;
    }

    /** Derive AES key from password via scrypt */
    _deriveKey(password, salt) {
        return crypto.scryptSync(password, salt, KEY_LEN, {
            N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P
        });
    }

    /** Encrypt plaintext to buffer: salt(16) + iv(12) + tag(16) + ciphertext */
    _encrypt(data) {
        const json = JSON.stringify(data);
        const iv = crypto.randomBytes(IV_LEN);
        const cipher = crypto.createCipheriv('aes-256-gcm', this._key, iv);
        const enc = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return Buffer.concat([this._salt, iv, tag, enc]);
    }

    /** Decrypt buffer back to object */
    _decrypt(buf, password) {
        const salt = buf.subarray(0, SALT_LEN);
        const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
        const tag = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
        const enc = buf.subarray(SALT_LEN + IV_LEN + TAG_LEN);

        const key = this._deriveKey(password, salt);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);

        const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
        return { data: JSON.parse(dec.toString('utf8')), key, salt };
    }

    /** Get ledger file path — lazy-loads Electron app */
    _getPath() {
        if (!this._dbPath) {
            const { app } = require('electron');
            const userDataPath = app.getPath('userData');
            this._dbPath = path.join(userDataPath, 'omega_ledger.enc');
        }
        return this._dbPath;
    }

    /** Save encrypted data to disk */
    _flush() {
        const encrypted = this._encrypt(this._data);
        fs.writeFileSync(this._getPath(), encrypted);
    }

    /** Check if a ledger file exists */
    exists() {
        return fs.existsSync(this._getPath());
    }

    /** Create new ledger with password */
    create(password, initialVault) {
        this._salt = crypto.randomBytes(SALT_LEN);
        this._key = this._deriveKey(password, this._salt);
        this._data = {
            vault: initialVault || { wallets: [], active: 0 },
            spend: {},        // { '2026-03-06': { total: '0', txs: [] } }
            sessions: [],     // session key records
            extraction: [],   // paymaster margin telemetry
            settings: {
                network: 'ethereum',
                spendLimit: '10',
                proxyMode: 'tor',
                autoLockMinutes: 15,
                strictModeEnabled: false,
                addressWhitelist: []
            }
        };
        this._initialized = true;
        this._flush();
        return true;
    }

    /** Unlock existing ledger with password */
    unlock(password) {
        const buf = fs.readFileSync(this._getPath());
        try {
            const { data, key, salt } = this._decrypt(buf, password);
            this._key = key;
            this._salt = salt;
            this._data = data;
            this._initialized = true;
            return true;
        } catch {
            return false;
        }
    }

    /** Lock ledger — wipe key from memory */
    lock() {
        if (this._key) this._key.fill(0);
        this._key = null;
        this._data = null;
        this._initialized = false;
    }

    /** Destroy ledger file entirely */
    destroy() {
        this.lock();
        const p = this._getPath();
        if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    /** Verify password without modifying in-memory state */
    verifyPassword(password) {
        if (!this._initialized || !this._salt || !this._key) {
            throw new Error('Vault not initialized');
        }
        const testKey = this._deriveKey(password, this._salt);
        if (!crypto.timingSafeEqual(testKey, this._key)) {
            throw new Error('Password mismatch');
        }
        return true;
    }

    // ═══════════════════════════════════════════════════════════
    // VAULT — wallet management
    // ═══════════════════════════════════════════════════════════

    getVault() {
        if (!this._initialized) throw new Error('Ledger locked');
        return this._data.vault;
    }

    setVault(vault) {
        if (!this._initialized) throw new Error('Ledger locked');
        this._data.vault = vault;
        this._flush();
    }

    addWallet(wallet) {
        if (!this._initialized) throw new Error('Ledger locked');
        this._data.vault.wallets.push(wallet);
        this._flush();
    }

    removeWallet(index) {
        if (!this._initialized) throw new Error('Ledger locked');
        if (this._data.vault.wallets.length <= 1) throw new Error('Cannot remove last wallet');
        this._data.vault.wallets.splice(index, 1);
        if (this._data.vault.active >= this._data.vault.wallets.length) {
            this._data.vault.active = 0;
        }
        this._flush();
    }

    setActiveWallet(index) {
        if (!this._initialized) throw new Error('Ledger locked');
        this._data.vault.active = index;
        this._flush();
    }

    // ═══════════════════════════════════════════════════════════
    // SPEND TRACKING — NAEF invariant enforcement
    // ═══════════════════════════════════════════════════════════

    /** Get today's date key */
    _today() {
        return new Date().toISOString().split('T')[0];
    }

    /** Get current 24h spend total */
    getSpendStatus() {
        if (!this._initialized) throw new Error('Ledger locked');
        const today = this._today();
        const entry = this._data.spend[today] || { total: '0', txs: [] };
        const limit = this._data.settings?.spendLimit || '10';
        return {
            date: today,
            spent: entry.total,
            limit,
            remaining: (parseFloat(limit) - parseFloat(entry.total)).toFixed(6),
            txCount: entry.txs.length,
            blocked: parseFloat(entry.total) >= parseFloat(limit)
        };
    }

    /** Record a spend — ENFORCES limit, throws if exceeded */
    recordSpend(amount, txHash, network) {
        if (!this._initialized) throw new Error('Ledger locked');
        const today = this._today();
        if (!this._data.spend[today]) {
            this._data.spend[today] = { total: '0', txs: [] };
        }
        const entry = this._data.spend[today];
        const newTotal = parseFloat(entry.total) + parseFloat(amount);
        const limit = parseFloat(this._data.settings?.spendLimit || '10');

        if (newTotal > limit) {
            throw new Error(`SPEND_LIMIT_EXCEEDED: ${newTotal.toFixed(6)} > ${limit} limit`);
        }

        entry.total = newTotal.toFixed(6);
        entry.txs.push({
            amount,
            txHash,
            network,
            timestamp: new Date().toISOString()
        });
        this._flush();
        return this.getSpendStatus();
    }

    /** Get flattened and sorted transaction history */
    getSpendHistory() {
        if (!this._initialized) throw new Error('Ledger locked');
        const history = [];
        for (const [date, entry] of Object.entries(this._data.spend || {})) {
            for (const tx of entry.txs || []) {
                history.push({ ...tx, date });
            }
        }
        return history.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }

    // ═══════════════════════════════════════════════════════════
    // SETTINGS
    // ═══════════════════════════════════════════════════════════

    getSettings() {
        if (!this._initialized) throw new Error('Ledger locked');
        return this._data.settings || {};
    }

    updateSettings(updates) {
        if (!this._initialized) throw new Error('Ledger locked');
        this._data.settings = { ...this._data.settings, ...updates };
        this._flush();
    }

    // ═══════════════════════════════════════════════════════════
    // EXTRACTION TELEMETRY
    // ═══════════════════════════════════════════════════════════

    recordExtraction(entry) {
        if (!this._initialized) throw new Error('Ledger locked');
        this._data.extraction.push({
            ...entry,
            timestamp: new Date().toISOString()
        });
        // Keep last 1000 entries
        if (this._data.extraction.length > 1000) {
            this._data.extraction = this._data.extraction.slice(-1000);
        }
        this._flush();
    }

    getExtractionLog() {
        if (!this._initialized) throw new Error('Ledger locked');
        return this._data.extraction || [];
    }

    // ═══════════════════════════════════════════════════════════
    // SECURITY AUDIT LOG — encrypted rolling log of sensitive events
    // ═══════════════════════════════════════════════════════════

    recordAuditEntry(entry) {
        if (!this._initialized) throw new Error('Ledger locked');
        if (!this._data.auditLog) this._data.auditLog = [];
        this._data.auditLog.push({
            ...entry,
            timestamp: entry.timestamp || new Date().toISOString(),
        });
        // Cap at 500 entries
        if (this._data.auditLog.length > 500) {
            this._data.auditLog = this._data.auditLog.slice(-500);
        }
        this._flush();
    }

    getAuditLog(count = 50) {
        if (!this._initialized) throw new Error('Ledger locked');
        const log = this._data.auditLog || [];
        return log.slice(-count);
    }

    // ═══════════════════════════════════════════════════════════
    // PINNED NFTs — persistent collection in encrypted vault
    // ═══════════════════════════════════════════════════════════

    getPinnedNfts() {
        if (!this._initialized) throw new Error('Ledger locked');
        return this._data.pinnedNfts || [];
    }

    pinNft(nft) {
        if (!this._initialized) throw new Error('Ledger locked');
        if (!this._data.pinnedNfts) this._data.pinnedNfts = [];
        // Deduplicate by contract + tokenId
        const key = `${nft.contract}:${nft.tokenId}`.toLowerCase();
        if (this._data.pinnedNfts.some(n => `${n.contract}:${n.tokenId}`.toLowerCase() === key)) {
            return false; // Already pinned
        }
        // Cap at 100 pinned NFTs
        if (this._data.pinnedNfts.length >= 100) {
            throw new Error('Pinned NFT limit reached (100 max)');
        }
        this._data.pinnedNfts.push({
            ...nft,
            pinnedAt: new Date().toISOString(),
        });
        this._flush();
        return true;
    }

    unpinNft(contract, tokenId) {
        if (!this._initialized) throw new Error('Ledger locked');
        if (!this._data.pinnedNfts) return false;
        const key = `${contract}:${tokenId}`.toLowerCase();
        const before = this._data.pinnedNfts.length;
        this._data.pinnedNfts = this._data.pinnedNfts.filter(
            n => `${n.contract}:${n.tokenId}`.toLowerCase() !== key
        );
        if (this._data.pinnedNfts.length < before) {
            this._flush();
            return true;
        }
        return false;
    }

    // ═══════════════════════════════════════════════════════════
    // DAPP BOOKMARKS — persistent favorites (encrypted)
    // ═══════════════════════════════════════════════════════════

    getDappBookmarks() {
        if (!this._initialized) throw new Error('Ledger locked');
        return this._data.dappBookmarks || [];
    }

    addDappBookmark(bookmark) {
        if (!this._initialized) throw new Error('Ledger locked');
        if (!this._data.dappBookmarks) this._data.dappBookmarks = [];
        if (!bookmark?.url) throw new Error('URL required');
        const url = bookmark.url.replace(/\/+$/, '').toLowerCase();
        if (this._data.dappBookmarks.some(b => b.url.replace(/\/+$/, '').toLowerCase() === url)) {
            return false;
        }
        if (this._data.dappBookmarks.length >= 50) {
            throw new Error('Bookmark limit reached (50 max)');
        }
        this._data.dappBookmarks.push({
            url: bookmark.url,
            name: bookmark.name || new URL(bookmark.url).hostname,
            icon: bookmark.icon || null,
            addedAt: new Date().toISOString(),
        });
        this._flush();
        return true;
    }

    removeDappBookmark(url) {
        if (!this._initialized) throw new Error('Ledger locked');
        if (!this._data.dappBookmarks) return false;
        const norm = url.replace(/\/+$/, '').toLowerCase();
        const before = this._data.dappBookmarks.length;
        this._data.dappBookmarks = this._data.dappBookmarks.filter(
            b => b.url.replace(/\/+$/, '').toLowerCase() !== norm
        );
        if (this._data.dappBookmarks.length < before) {
            this._flush();
            return true;
        }
        return false;
    }

    // ═══════════════════════════════════════════════════════════
    // DAPP PERMISSIONS — approved origins with revoke (encrypted)
    // ═══════════════════════════════════════════════════════════

    getDappPermissions() {
        if (!this._initialized) throw new Error('Ledger locked');
        return this._data.dappPermissions || [];
    }

    grantDappPermission(origin, walletAddress) {
        if (!this._initialized) throw new Error('Ledger locked');
        if (!this._data.dappPermissions) this._data.dappPermissions = [];
        if (!origin) throw new Error('Origin required');
        const norm = origin.toLowerCase();
        if (this._data.dappPermissions.some(p => p.origin.toLowerCase() === norm)) {
            return false;
        }
        if (this._data.dappPermissions.length >= 200) {
            throw new Error('Permission limit reached (200 max)');
        }
        this._data.dappPermissions.push({
            origin,
            walletAddress,
            grantedAt: new Date().toISOString(),
            lastUsed: new Date().toISOString(),
        });
        this._flush();
        return true;
    }

    touchDappPermission(origin) {
        if (!this._initialized) throw new Error('Ledger locked');
        if (!this._data.dappPermissions) return false;
        const norm = origin.toLowerCase();
        const perm = this._data.dappPermissions.find(p => p.origin.toLowerCase() === norm);
        if (perm) {
            perm.lastUsed = new Date().toISOString();
            this._flush();
            return true;
        }
        return false;
    }

    hasDappPermission(origin) {
        if (!this._initialized) throw new Error('Ledger locked');
        if (!this._data.dappPermissions) return false;
        return this._data.dappPermissions.some(
            p => p.origin.toLowerCase() === origin.toLowerCase()
        );
    }

    revokeDappPermission(origin) {
        if (!this._initialized) throw new Error('Ledger locked');
        if (!this._data.dappPermissions) return false;
        const norm = origin.toLowerCase();
        const before = this._data.dappPermissions.length;
        this._data.dappPermissions = this._data.dappPermissions.filter(
            p => p.origin.toLowerCase() !== norm
        );
        if (this._data.dappPermissions.length < before) {
            this._flush();
            return true;
        }
        return false;
    }

    revokeAllDappPermissions() {
        if (!this._initialized) throw new Error('Ledger locked');
        this._data.dappPermissions = [];
        this._flush();
        return true;
    }

    // ═══════════════════════════════════════════════════════════
    // DAPP ACTIVITY — per-dApp signing/tx log (encrypted)
    // ═══════════════════════════════════════════════════════════

    getDappActivity(origin) {
        if (!this._initialized) throw new Error('Ledger locked');
        const log = this._data.dappActivity || [];
        if (origin) return log.filter(e => e.origin.toLowerCase() === origin.toLowerCase());
        return log;
    }

    recordDappActivity(entry) {
        if (!this._initialized) throw new Error('Ledger locked');
        if (!this._data.dappActivity) this._data.dappActivity = [];
        this._data.dappActivity.push({
            origin: entry.origin || 'Unknown',
            method: entry.method,
            params: entry.params ? JSON.stringify(entry.params).slice(0, 500) : null,
            result: entry.result || null,
            walletAddress: entry.walletAddress || null,
            chainId: entry.chainId || null,
            timestamp: new Date().toISOString(),
        });
        if (this._data.dappActivity.length > 500) {
            this._data.dappActivity = this._data.dappActivity.slice(-500);
        }
        this._flush();
    }
}
module.exports = { EncryptedLedger };

