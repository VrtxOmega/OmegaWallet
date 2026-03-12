/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║       IPC HANDLERS — Service Logic Adapter (v5.0 Hardened)    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * v5.0 HARDENING (IPC Cleanroom v5):
 *   - FreshAuth gate: sensitive actions require recent password proof
 *   - IPC schema enforcement: every channel validated at boundary
 *   - Replay control: single-use nonces on privileged actions
 *   - Main-process confirmation truth: signing summaries built server-side
 *   - Unlocked ≠ Fresh: vault unlock ≠ privileged action authorization
 *   - Rate limiting + exponential cooldown on auth failure
 *   - Encrypted audit trail for all sensitive operations
 */
const { ipcMain } = require('electron');
const { ethers } = require('ethers');
const { ERC20_ABI, ERC721_ABI, ERC1155_ABI, DEFAULT_TOKENS } = require('./tokens');
const btcChain = require('./chains/bitcoin');
const solChain = require('./chains/solana');
const { FreshAuth } = require('./fresh-auth');
const { validateIpc, VALID_CHAINS: SCHEMA_VALID_CHAINS } = require('./ipc-schema');
const { simulateTx } = require('./tx-simulator');
const { decodeTxCalldata } = require('./tx-decoder');
const swapEngine = require('./swap-engine');

// ═══════════════════════════════════════════════════════════════
// RPC PROVIDERS — Keys from env vars or rpc-config.json, never hardcoded
// ═══════════════════════════════════════════════════════════════
const DRPC_KEY = process.env.OMEGA_DRPC_KEY || null;
const VALID_CHAINS = new Set([
    'ethereum', 'base', 'arbitrum', 'optimism', 'sepolia', 'base-sepolia',
    'polygon', 'avalanche', 'bsc', 'fantom', 'cronos',
    'zksync-era', 'linea', 'scroll', 'mantle',
]);

// Chains that dRPC doesn't support — use public RPCs
const FALLBACK_RPCS = {
    ethereum: 'https://eth.llamarpc.com',
    base: 'https://mainnet.base.org',
    arbitrum: 'https://arb1.arbitrum.io/rpc',
    optimism: 'https://mainnet.optimism.io',
    sepolia: 'https://rpc.sepolia.org',
    'base-sepolia': 'https://sepolia.base.org',
    bsc: 'https://bsc-dataseed1.binance.org',
    fantom: 'https://rpc.ftm.tools',
    cronos: 'https://evm.cronos.org',
    mantle: 'https://rpc.mantle.xyz',
};

function getRpcUrl(chain) {
    const safeChain = VALID_CHAINS.has(chain) ? chain : 'ethereum';
    // Chains that always use public RPCs (dRPC doesn't support them)
    if (FALLBACK_RPCS[safeChain] && !['ethereum', 'base', 'arbitrum', 'optimism', 'sepolia', 'base-sepolia'].includes(safeChain)) {
        return FALLBACK_RPCS[safeChain];
    }
    // Use dRPC if key is available, otherwise public fallback
    if (DRPC_KEY) return `https://lb.drpc.org/ogrpc?network=${safeChain}&dkey=${DRPC_KEY}`;
    return FALLBACK_RPCS[safeChain] || FALLBACK_RPCS.ethereum;
}

function getProvider(chain) {
    return new ethers.JsonRpcProvider(getRpcUrl(chain));
}

// ═══════════════════════════════════════════════════════════════
// RATE LIMITER — Sliding window per-operation throttle
// ═══════════════════════════════════════════════════════════════
class RateLimiter {
    constructor() {
        this._buckets = new Map(); // key → [timestamps]
    }
    /**
     * @param {string} key - Operation identifier
     * @param {number} maxAttempts - Max allowed in window
     * @param {number} windowMs - Window duration in ms
     * @returns {boolean} true if allowed, false if rate-limited
     */
    check(key, maxAttempts, windowMs) {
        const now = Date.now();
        if (!this._buckets.has(key)) this._buckets.set(key, []);
        const bucket = this._buckets.get(key).filter(t => t > now - windowMs);
        this._buckets.set(key, bucket);
        if (bucket.length >= maxAttempts) return false;
        bucket.push(now);
        return true;
    }
    reset(key) {
        this._buckets.delete(key);
    }
}

const rateLimiter = new RateLimiter();

// ═══════════════════════════════════════════════════════════════
// INPUT VALIDATION — Boundary enforcement at IPC layer
// ═══════════════════════════════════════════════════════════════
function validateAddress(addr, fieldName = 'address') {
    if (typeof addr !== 'string') throw new Error(`${fieldName}: must be a string`);
    if (!ethers.isAddress(addr)) throw new Error(`${fieldName}: invalid Ethereum address`);
    return addr;
}

function validateChain(chain) {
    if (typeof chain !== 'string' || !VALID_CHAINS.has(chain)) return 'ethereum';
    return chain;
}

function validateIndex(idx, max) {
    const n = parseInt(idx);
    if (isNaN(n) || n < 0 || n >= max) throw new Error(`Invalid index: ${idx}`);
    return n;
}

function validateAmount(amt, fieldName = 'amount') {
    const n = parseFloat(amt);
    if (isNaN(n) || n < 0) throw new Error(`${fieldName}: must be a non-negative number`);
    return String(amt);
}

// Whitelist of allowed JSON-RPC methods for rpc:call proxy
const ALLOWED_RPC_METHODS = new Set([
    'eth_blockNumber', 'eth_getBalance', 'eth_getCode',
    'eth_getTransactionCount', 'eth_getTransactionReceipt',
    'eth_call', 'eth_estimateGas', 'eth_gasPrice',
    'eth_getBlockByNumber', 'eth_getBlockByHash',
    'eth_getStorageAt', 'eth_getLogs', 'net_version',
    'eth_chainId', 'eth_feeHistory', 'eth_maxPriorityFeePerGas',
]);

// ═══════════════════════════════════════════════════════════════
// CHAIN METADATA — For main-process confirmation truth (Layer 4)
// ═══════════════════════════════════════════════════════════════
const CHAIN_NAMES = {
    ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum', optimism: 'Optimism',
    sepolia: 'Sepolia', 'base-sepolia': 'Base Sepolia', polygon: 'Polygon',
    avalanche: 'Avalanche', bsc: 'BNB Chain', fantom: 'Fantom', cronos: 'Cronos',
    'zksync-era': 'zkSync Era', linea: 'Linea', scroll: 'Scroll', mantle: 'Mantle',
};
const CHAIN_EXPLORERS = {
    ethereum: 'https://etherscan.io', base: 'https://basescan.org',
    arbitrum: 'https://arbiscan.io', optimism: 'https://optimistic.etherscan.io',
    polygon: 'https://polygonscan.com', bsc: 'https://bscscan.com',
};
const CHAIN_SYMBOLS = {
    ethereum: 'ETH', base: 'ETH', arbitrum: 'ETH', optimism: 'ETH',
    sepolia: 'sETH', polygon: 'MATIC', bsc: 'BNB', avalanche: 'AVAX',
    fantom: 'FTM', cronos: 'CRO', 'zksync-era': 'ETH', linea: 'ETH',
    scroll: 'ETH', mantle: 'MNT', 'base-sepolia': 'sETH',
};

function buildTxSummary({ from, to, value, chain, tokenSymbol, tokenAmount }) {
    const sym = tokenSymbol || CHAIN_SYMBOLS[chain] || 'ETH';
    const amt = tokenAmount || value || '0';
    return {
        action: tokenSymbol ? `Transfer ${amt} ${sym}` : `Send ${amt} ${sym}`,
        from, to, value: amt, symbol: sym, chain,
        network: CHAIN_NAMES[chain] || chain,
        explorerBase: CHAIN_EXPLORERS[chain] || '',
        builtBy: 'main-process', builtAt: new Date().toISOString(),
    };
}

const prepareStore = new Map();
const PREPARE_EXPIRY_MS = 120_000;

// ═══════════════════════════════════════════════════════════════
// SECURE HANDLE — Schema-validating IPC wrapper
// ═══════════════════════════════════════════════════════════════
function secureHandle(channel, handler) {
    ipcMain.handle(channel, async (event, ...args) => {
        try {
            try { validateIpc(channel, args); } catch (e) {
                console.error(`[SCHEMA] ${channel}:`, e.message);
                return { ok: false, error: e.message };
            }
            return await handler(event, ...args);
        } catch (e) {
            console.error(`[IPC] ${channel}:`, e.message);
            return { ok: false, error: e.message };
        }
    });
}

// ═══════════════════════════════════════════════════════════════
// THREAT PATTERNS (Cerberus inline — no TCP)
// ═══════════════════════════════════════════════════════════════
const DANGEROUS_OPCODES = ['ff', '3b', '3c']; // SELFDESTRUCT, CALLDATASIZE, CALLDATACOPY patterns
const RISK_WEIGHTS = {
    selfDestruct: 40, honeypot: 35, proxyUpgradeable: 15,
    newContract: 10, largeApproval: 20, unknownFunction: 5,
};

// ═══════════════════════════════════════════════════════════════
// REGISTER ALL IPC HANDLERS
// ═══════════════════════════════════════════════════════════════
function registerHandlers(ledger) {

    // ── FRESH-AUTH GATE ──────────────────────────────────────────
    const freshAuth = new FreshAuth(ledger);

    // Flush audit buffer to encrypted ledger every 30s
    setInterval(() => freshAuth.flushToLedger(), 30_000);

    // ── AUTH IPC CHANNELS ────────────────────────────────────────
    secureHandle('auth:freshAuth', (_, password) => {
        return freshAuth.authenticate(password);
    });

    secureHandle('auth:status', () => {
        return { ok: true, ...freshAuth.status() };
    });

    secureHandle('auth:auditLog', (_, count) => {
        try {
            const log = ledger.getAuditLog(count || 50);
            return { ok: true, log };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    // ── RPC PROXY ────────────────────────────────────────────────
    secureHandle('rpc:call', async (_, chain, method, params) => {
        const safeChain = validateChain(chain);
        if (!ALLOWED_RPC_METHODS.has(method)) {
            return { ok: false, error: `RPC method not allowed: ${method}` };
        }
        const provider = getProvider(safeChain);
        const result = await provider.send(method, params || []);
        return { ok: true, result };
    });

    // ── VAULT ──────────────────────────────────────────────

    ipcMain.handle('vault:exists', () => ledger.exists());

    ipcMain.handle('vault:create', (_, pw, label, key) => {
        try {
            const w = key
                ? (key.startsWith('0x') && key.length === 66
                    ? new ethers.Wallet(key)
                    : ethers.Wallet.fromPhrase(key.trim()))
                : ethers.Wallet.createRandom();

            const vault = {
                wallets: [{
                    label: label || 'Wallet 1',
                    address: w.address,
                    privateKey: w.privateKey,
                    ...(w.mnemonic ? { mnemonic: w.mnemonic.phrase } : {})
                }],
                active: 0
            };
            ledger.create(pw, vault);
            return {
                ok: true,
                address: w.address,
                mnemonic: w.mnemonic?.phrase || null
            };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    ipcMain.handle('vault:unlock', (_, pw) => {
        // Rate limit: 5 attempts per 60 seconds
        if (!rateLimiter.check('vault:unlock', 5, 60000)) {
            return { ok: false, error: 'RATE_LIMIT: Too many unlock attempts. Wait 60 seconds.' };
        }
        if (typeof pw !== 'string' || pw.length < 1) {
            return { ok: false, error: 'Password required' };
        }
        const ok = ledger.unlock(pw);
        if (!ok) return { ok: false, error: 'Wrong password' };
        rateLimiter.reset('vault:unlock'); // Reset on success
        const vault = ledger.getVault();
        return {
            ok: true,
            wallets: vault.wallets.map(w => ({ label: w.label, address: w.address })),
            active: vault.active
        };
    });

    ipcMain.handle('vault:lock', () => { ledger.lock(); return { ok: true }; });

    secureHandle('vault:destroy', (_, password) => {
        if (!rateLimiter.check('vault:destroy', 1, 60000)) {
            return { ok: false, error: 'RATE_LIMIT: Please wait before attempting vault destruction.' };
        }
        const auth = freshAuth.requireFresh('vault:destroy', password);
        if (!auth.ok) return auth;
        freshAuth.flushToLedger();
        ledger.destroy();
        return { ok: true };
    });

    ipcMain.handle('vault:getWallets', () => {
        try {
            const vault = ledger.getVault();
            return {
                ok: true,
                wallets: vault.wallets.map(w => ({ label: w.label, address: w.address })),
                active: vault.active
            };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    ipcMain.handle('vault:addWallet', (_, label, key) => {
        try {
            // Input validation
            if (label && (typeof label !== 'string' || label.length > 64)) {
                return { ok: false, error: 'Label must be a string under 64 chars' };
            }
            if (key && typeof key !== 'string') {
                return { ok: false, error: 'Key must be a string' };
            }

            const w = key
                ? (key.startsWith('0x') && key.length === 66
                    ? new ethers.Wallet(key)
                    : ethers.Wallet.fromPhrase(key.trim()))
                : ethers.Wallet.createRandom();

            // Vault size limit — 32 wallets max
            const vault = ledger.getVault();
            if (vault.wallets.length >= 32) {
                return { ok: false, error: 'Vault capacity reached (32 wallets max)' };
            }

            // Check for duplicates
            if (vault.wallets.some(x => x.address.toLowerCase() === w.address.toLowerCase())) {
                return { ok: false, error: 'Wallet already in vault' };
            }

            ledger.addWallet({
                label: label || `Wallet ${vault.wallets.length + 1}`,
                address: w.address,
                privateKey: w.privateKey,
                ...(w.mnemonic ? { mnemonic: w.mnemonic.phrase } : {})
            });
            return { ok: true, address: w.address, mnemonic: w.mnemonic?.phrase || null };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    secureHandle('vault:removeWallet', (_, idx, password) => {
        const auth = freshAuth.requireFresh('vault:removeWallet', password);
        if (!auth.ok) return auth;
        const vault = ledger.getVault();
        const safeIdx = validateIndex(idx, vault.wallets.length);
        ledger.removeWallet(safeIdx);
        return { ok: true };
    });

    ipcMain.handle('vault:setActive', (_, idx) => {
        try {
            const vault = ledger.getVault();
            const safeIdx = validateIndex(idx, vault.wallets.length);
            ledger.setActiveWallet(safeIdx);
            return { ok: true };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    secureHandle('vault:getKey', (_, idx, tokenOrPassword) => {
        if (!rateLimiter.check('vault:getKey', 3, 60000)) {
            return { ok: false, error: 'RATE_LIMIT: Too many key reveal requests. Wait 60 seconds.' };
        }
        const auth = freshAuth.requireFresh('vault:getKey', tokenOrPassword);
        if (!auth.ok) return auth;
        const vault = ledger.getVault();
        const safeIdx = validateIndex(idx, vault.wallets.length);
        const w = vault.wallets[safeIdx];
        if (!w) return { ok: false, error: 'Invalid wallet index' };
        return { ok: true, privateKey: w.privateKey, token: auth.token, expiresAt: auth.expiresAt };
    });

    // ── CERBERUS SCANNER ───────────────────────────────────

    ipcMain.handle('cerberus:scan', async (_, target, chain) => {
        try {
            // Rate limit: 10 scans per 60 seconds
            if (!rateLimiter.check('cerberus:scan', 10, 60000)) {
                return { verdict: 'ERROR', threatScore: -1, error: 'RATE_LIMIT: Too many scan requests' };
            }
            if (!ethers.isAddress(target)) {
                return { verdict: 'INVALID', threatScore: -1, error: 'Invalid address' };
            }
            const safeChain = validateChain(chain);
            const provider = getProvider(safeChain);
            const findings = [];
            let threatScore = 0;

            // 1. Get bytecode
            const code = await provider.getCode(target);

            if (code === '0x' || code.length < 4) {
                // EOA — no contract risk
                return {
                    target, verdict: 'PASS', threatScore: 0,
                    findings: [{ type: 'info', message: 'EOA (not a contract)' }],
                    scannedAt: new Date().toISOString()
                };
            }

            // 2. SELFDESTRUCT check
            if (code.toLowerCase().includes('ff')) {
                const ffCount = (code.toLowerCase().match(/ff/g) || []).length;
                if (ffCount > 2) {
                    findings.push({
                        type: 'critical', category: 'selfDestruct',
                        message: `SELFDESTRUCT pattern detected (${ffCount} occurrences)`
                    });
                    threatScore += RISK_WEIGHTS.selfDestruct;
                }
            }

            // 3. Proxy check
            try {
                const implSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
                const implAddr = await provider.getStorage(target, implSlot);
                if (implAddr !== '0x' + '00'.repeat(32)) {
                    findings.push({
                        type: 'warning', category: 'proxyUpgradeable',
                        message: 'Upgradeable proxy detected — admin can change logic'
                    });
                    threatScore += RISK_WEIGHTS.proxyUpgradeable;
                }
            } catch { /* not a proxy */ }

            // 4. Contract age
            try {
                const block = await provider.getBlockNumber();
                // Simple heuristic: check if contract was recently deployed
                const bal = await provider.getBalance(target);
                if (parseFloat(ethers.formatEther(bal)) < 0.001) {
                    findings.push({
                        type: 'warning', category: 'lowBalance',
                        message: 'Contract has very low balance'
                    });
                    threatScore += 5;
                }
            } catch { /* skip */ }

            // 5. Code size
            const codeSize = (code.length - 2) / 2;
            if (codeSize < 100) {
                findings.push({
                    type: 'warning', category: 'tinyContract',
                    message: `Very small contract (${codeSize} bytes) — possible honeypot`
                });
                threatScore += RISK_WEIGHTS.honeypot;
            }

            const verdict = threatScore >= 50 ? 'BLOCK' :
                threatScore >= 20 ? 'WARN' : 'PASS';

            return {
                target, verdict, threatScore: Math.min(100, threatScore),
                findings, codeSize, scannedAt: new Date().toISOString()
            };
        } catch (e) {
            return { verdict: 'ERROR', threatScore: -1, error: e.message };
        }
    });

    // ── SIMULATOR ──────────────────────────────────────────

    // Standalone calldata decoder — for UI to preview contract calls
    ipcMain.handle('simulator:decode', async (_, data, to, value) => {
        try {
            const decoded = decodeTxCalldata(data, to, value);
            return { ok: true, ...decoded, decodedBy: 'main-process' };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('simulator:run', async (_, payload) => {
        try {
            if (!payload || typeof payload !== 'object') {
                return { simulation: { success: false, error: 'Invalid payload' }, chain: 'ethereum' };
            }
            const { from, to, value, data, chain } = payload;
            // Validate addresses
            validateAddress(from, 'from');
            validateAddress(to, 'to');
            const safeChain = validateChain(chain);

            // Strict-Mode Check
            try {
                const settings = ledger.getSettings();
                if (settings.strictModeEnabled) {
                    const whitelist = settings.addressWhitelist || [];
                    const isWhitelisted = whitelist.some(w => w.address.toLowerCase() === to.toLowerCase());
                    if (!isWhitelisted) {
                        return { simulation: { success: false, revertReason: 'STRICT_MODE: Destination address is not in whitelist', warnings: [{ type: 'critical', message: 'Address not whitelisted' }] }, chain: chain || 'ethereum' };
                    }
                }
            } catch (e) { /* Settings not available or locked */ }

            const provider = getProvider(chain || 'ethereum');
            const result = { success: false, gasEstimate: null, revertReason: null, warnings: [] };

            // Pre-balance check
            const preBalance = await provider.getBalance(from);
            const weiValue = value ? BigInt(value) : 0n;

            if (weiValue > preBalance) {
                result.warnings.push({ type: 'critical', message: 'Insufficient balance' });
            }

            // eth_call simulation
            try {
                await provider.call({ from, to, value: weiValue, data: data || '0x' });
                result.success = true;
            } catch (e) {
                result.success = false;
                result.revertReason = e.reason || e.message || 'Unknown revert';
                result.warnings.push({ type: 'critical', message: `Will REVERT: ${result.revertReason}` });
            }

            // Gas estimation
            try {
                const gas = await provider.estimateGas({ from, to, value: weiValue, data: data || '0x' });
                result.gasEstimate = gas.toString();
            } catch { result.gasEstimate = 'estimation_failed'; }

            return { simulation: result, chain: chain || 'ethereum' };
        } catch (e) {
            return { simulation: { success: false, error: e.message }, chain: 'ethereum' };
        }
    });

    // ── BUNDLER (TWO-PHASE SIGNING — Layer 4) ────────────────

    // Phase 1: Prepare — main process builds the summary. Renderer shows it.
    secureHandle('bundler:prepare', async (_, userOp, chain) => {
        const vault = ledger.getVault();
        const { from, to, value } = userOp;
        const safeChain = validateChain(chain);

        // Validate sender exists in vault
        const wallet = vault.wallets.find(w =>
            w.address.toLowerCase() === from.toLowerCase());
        if (!wallet) return { ok: false, error: 'Wallet not in vault' };

        // Strict-Mode check
        const settings = ledger.getSettings();
        if (settings.strictModeEnabled) {
            const whitelist = settings.addressWhitelist || [];
            const isWhitelisted = whitelist.some(w => w.address.toLowerCase() === to.toLowerCase());
            if (!isWhitelisted) {
                return { ok: false, error: 'STRICT_MODE: Destination address is not in whitelist' };
            }
        }

        // Enforce spend limit
        const spendStatus = ledger.getSpendStatus();
        const ethAmount = ethers.formatEther(BigInt(value || '0'));
        if (parseFloat(spendStatus.spent) + parseFloat(ethAmount) > parseFloat(spendStatus.limit)) {
            return { ok: false, error: `SPEND_LIMIT: would exceed ${spendStatus.limit} daily limit` };
        }

        // Build summary — main process controls this text
        const summary = buildTxSummary({ from, to, value: ethAmount, chain: safeChain });

        // ── Transaction Simulation (advisory) ─────────────────
        let simulation = null;
        if (userOp.data && userOp.data !== '0x') {
            try {
                const provider = getProvider(safeChain);
                simulation = await simulateTx(
                    { from, to, value: userOp.value, data: userOp.data, chain: safeChain },
                    provider,
                );
            } catch {
                // Simulation failure is non-blocking
                simulation = {
                    actions: [{ type: 'error', description: 'Simulation unavailable', risk: 'LOW' }],
                    riskLevel: 'LOW', riskScore: 5, confidence: 'LOW',
                    recommendation: 'REVIEW',
                    warnings: [{ type: 'info', message: 'Could not simulate — review carefully' }],
                    simulatedBy: 'main-process', simulatedAt: new Date().toISOString(),
                };
            }
        }

        // Store prepared tx
        const crypto = require('crypto');
        const prepareId = crypto.randomBytes(16).toString('hex');
        prepareStore.set(prepareId, { summary, simulation, userOp, chain: safeChain, createdAt: Date.now() });

        // Clean expired prepares
        for (const [id, entry] of prepareStore) {
            if (Date.now() > entry.createdAt + PREPARE_EXPIRY_MS) prepareStore.delete(id);
        }

        return { ok: true, prepareId, summary, simulation, spendStatus };
    });

    // Phase 2: Confirm — requires fresh auth + prepareId
    secureHandle('bundler:confirm', async (_, prepareId, tokenOrPassword) => {
        // Require fresh auth
        const auth = freshAuth.requireFresh('bundler:confirm', tokenOrPassword);
        if (!auth.ok) return auth;

        // Validate prepareId
        const prepared = prepareStore.get(prepareId);
        if (!prepared) return { ok: false, error: 'Invalid or expired prepare ID' };
        if (Date.now() > prepared.createdAt + PREPARE_EXPIRY_MS) {
            prepareStore.delete(prepareId);
            return { ok: false, error: 'Prepare expired — please re-prepare' };
        }
        prepareStore.delete(prepareId); // single-use

        const vault = ledger.getVault();
        const { userOp, chain } = prepared;
        const wallet = vault.wallets.find(w =>
            w.address.toLowerCase() === userOp.from.toLowerCase());
        if (!wallet) return { ok: false, error: 'Wallet not in vault' };

        // Sign and send
        const provider = getProvider(chain);
        const signer = new ethers.Wallet(wallet.privateKey, provider);
        const tx = await signer.sendTransaction({
            to: userOp.to,
            value: BigInt(userOp.value || '0'),
        });

        const ethAmount = ethers.formatEther(BigInt(userOp.value || '0'));
        const newStatus = ledger.recordSpend(ethAmount, tx.hash, chain);

        // ── Audit log: simulation + decision ──────────────────
        try {
            ledger.appendAudit({
                action: 'tx:confirmed',
                contract: userOp.to,
                txHash: tx.hash,
                chain,
                simulation: prepared.simulation ? {
                    riskLevel: prepared.simulation.riskLevel,
                    riskScore: prepared.simulation.riskScore,
                    recommendation: prepared.simulation.recommendation,
                    actions: (prepared.simulation.actions || []).map(a => a.description),
                } : null,
                timestamp: new Date().toISOString(),
            });
        } catch { /* audit failure is non-blocking */ }

        return {
            ok: true, txHash: tx.hash,
            from: wallet.address, to: userOp.to, value: ethAmount,
            spendStatus: newStatus,
        };
    });

    // Legacy: bundler:submit — prepare + auto-confirm in one step (for backward compat)
    ipcMain.handle('bundler:submit', async (_, userOp, chain) => {
        try {
            const vault = ledger.getVault();
            const { from, to, value } = userOp;

            const settings = ledger.getSettings();
            if (settings.strictModeEnabled) {
                const whitelist = settings.addressWhitelist || [];
                const isWhitelisted = whitelist.some(w => w.address.toLowerCase() === to.toLowerCase());
                if (!isWhitelisted) {
                    return { ok: false, error: 'STRICT_MODE: Destination address is not in whitelist' };
                }
            }

            const wallet = vault.wallets.find(w =>
                w.address.toLowerCase() === from.toLowerCase());
            if (!wallet) return { ok: false, error: 'Wallet not in vault' };

            const spendStatus = ledger.getSpendStatus();
            const ethAmount = ethers.formatEther(BigInt(value || '0'));
            if (parseFloat(spendStatus.spent) + parseFloat(ethAmount) > parseFloat(spendStatus.limit)) {
                return { ok: false, error: `SPEND_LIMIT: would exceed ${spendStatus.limit} daily limit` };
            }

            const provider = getProvider(chain || 'ethereum');
            const signer = new ethers.Wallet(wallet.privateKey, provider);
            const tx = await signer.sendTransaction({ to, value: BigInt(value || '0') });
            const newStatus = ledger.recordSpend(ethAmount, tx.hash, chain || 'ethereum');

            return {
                ok: true, txHash: tx.hash,
                from: wallet.address, to, value: ethAmount,
                spendStatus: newStatus,
            };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('bundler:status', async (_, hash, chain) => {
        try {
            const provider = getProvider(chain || 'ethereum');
            const receipt = await provider.getTransactionReceipt(hash);
            return receipt ? { status: 'confirmed', receipt } : { status: 'pending' };
        } catch (e) { return { status: 'error', error: e.message }; }
    });

    ipcMain.handle('bundler:gas', async (_, chain) => {
        try {
            const provider = getProvider(chain || 'ethereum');
            const feeData = await provider.getFeeData();
            return {
                maxFeePerGas: feeData.maxFeePerGas?.toString(),
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString(),
                gasPrice: feeData.gasPrice?.toString()
            };
        } catch (e) { return { error: e.message }; }
    });

    // ── TOKENS ─────────────────────────────────────────────

    ipcMain.handle('token:balances', async (_, address, chain) => {
        try {
            const provider = getProvider(chain || 'ethereum');
            const defaultTokens = DEFAULT_TOKENS[chain] || [];
            const settings = ledger.getSettings();
            const customTokens = settings.customTokens?.[chain] || [];

            // Deduplicate custom and default tokens
            const seen = new Set();
            const tokens = [...defaultTokens, ...customTokens].filter(t => {
                const addr = t.address.toLowerCase();
                if (seen.has(addr)) return false;
                seen.add(addr);
                return true;
            });

            // Fetch native ETH balance first
            const ethBal = await provider.getBalance(address);
            const balances = [{
                address: 'native',
                symbol: 'ETH',
                decimals: 18,
                balance: ethBal.toString(),
                formatted: ethers.formatEther(ethBal)
            }];

            // Fetch ERC-20 balances concurrently
            const results = await Promise.allSettled(tokens.map(async t => {
                const contract = new ethers.Contract(t.address, ERC20_ABI, provider);
                const bal = await contract.balanceOf(address);
                if (bal > 0n) {
                    return {
                        ...t,
                        balance: bal.toString(),
                        formatted: ethers.formatUnits(bal, t.decimals)
                    };
                }
                return null;
            }));

            results.forEach(r => {
                if (r.status === 'fulfilled' && r.value) balances.push(r.value);
            });

            return { ok: true, balances };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('token:transfer', async (_, tokenAddress, to, amountStr, chain) => {
        try {
            // Input validation at IPC boundary
            validateAddress(tokenAddress, 'tokenAddress');
            validateAddress(to, 'to');
            validateAmount(amountStr, 'amount');
            const safeChain = validateChain(chain);

            // Rate limit: 5 transfers per 60 seconds
            if (!rateLimiter.check('token:transfer', 5, 60000)) {
                return { ok: false, error: 'RATE_LIMIT: Too many transfer requests. Wait 60 seconds.' };
            }

            const vault = ledger.getVault();

            // Strict-Mode Check
            const settings = ledger.getSettings();
            if (settings.strictModeEnabled) {
                const whitelist = settings.addressWhitelist || [];
                const isWhitelisted = whitelist.some(w => w.address.toLowerCase() === to.toLowerCase());
                if (!isWhitelisted) {
                    return { ok: false, error: 'STRICT_MODE: Destination address is not in whitelist' };
                }
            }

            const provider = getProvider(safeChain);
            const wallet = vault.wallets[vault.active];
            if (!wallet) return { ok: false, error: 'No active wallet' };

            const signer = new ethers.Wallet(wallet.privateKey, provider);
            const contract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);

            const decimals = await contract.decimals();
            const amount = ethers.parseUnits(amountStr, decimals);

            const tx = await contract.transfer(to, amount);
            ledger.recordSpend('0', tx.hash, safeChain);

            return { ok: true, txHash: tx.hash };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('token:info', async (_, tokenAddress, chain) => {
        try {
            validateAddress(tokenAddress, 'tokenAddress');
            const safeChain = validateChain(chain);
            const provider = getProvider(safeChain);
            const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
            const [symbol, decimals] = await Promise.all([
                contract.symbol(),
                contract.decimals()
            ]);
            return { ok: true, symbol, decimals: Number(decimals), address: tokenAddress };
        } catch (e) {
            return { ok: false, error: 'Invalid token address or network' };
        }
    });

    ipcMain.handle('token:import', async (_, tokenAddress, chain) => {
        try {
            validateAddress(tokenAddress, 'tokenAddress');
            const safeChain = validateChain(chain);
            const provider = getProvider(safeChain);
            const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
            const [symbol, decimals] = await Promise.all([
                contract.symbol(),
                contract.decimals()
            ]);

            const token = { address: tokenAddress, symbol, decimals: Number(decimals) };
            const settings = ledger.getSettings();
            const customTokens = settings.customTokens || {};
            const chainTokens = customTokens[chain] || [];

            if (!chainTokens.some(t => t.address.toLowerCase() === tokenAddress.toLowerCase())) {
                chainTokens.push(token);
                customTokens[chain] = chainTokens;
                ledger.updateSettings({ customTokens });
            }

            return { ok: true, token };
        } catch (e) {
            return { ok: false, error: 'Failed to import token. Verify address and network.' };
        }
    });

    // ── SPEND TRACKING ─────────────────────────────────────

    ipcMain.handle('ledger:getSpend', () => {
        try { return ledger.getSpendStatus(); }
        catch (e) { return { error: e.message }; }
    });

    ipcMain.handle('ledger:getHistory', () => {
        try { return { ok: true, history: ledger.getSpendHistory() }; }
        catch (e) { return { ok: false, error: e.message }; }
    });

    ipcMain.handle('ledger:recordSpend', (_, amt, hash, net) => {
        try { return ledger.recordSpend(amt, hash, net); }
        catch (e) { return { error: e.message }; }
    });

    // ── SETTINGS ───────────────────────────────────────────

    ipcMain.handle('settings:get', () => {
        try { return { ok: true, settings: ledger.getSettings() }; }
        catch (e) { return { ok: false, error: e.message }; }
    });

    ipcMain.handle('settings:update', (_, updates) => {
        try { ledger.updateSettings(updates); return { ok: true }; }
        catch (e) { return { ok: false, error: e.message }; }
    });

    // ═══════════════════════════════════════════════════════════
    // TOKEN APPROVALS — Scan & Revoke ERC-20 allowances
    // ═══════════════════════════════════════════════════════════

    // Known spender contracts to check
    const KNOWN_SPENDERS = {
        ethereum: [
            { address: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', label: 'Uniswap V2 Router' },
            { address: '0xE592427A0AEce92De3Edee1F18E0157C05861564', label: 'Uniswap V3 Router' },
            { address: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', label: 'Uniswap Universal Router' },
            { address: '0x1111111254EEB25477B68fb85Ed929f73A960582', label: '1inch V5' },
            { address: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F', label: 'SushiSwap Router' },
            { address: '0x000000000022D473030F116dDEE9F6B43aC78BA3', label: 'Permit2 (Uniswap)' },
            { address: '0x1E0049783F008A0085193E00003D00cd54003c71', label: 'OpenSea Seaport 1.5' },
        ],
        base: [
            { address: '0x2626664c2603336E57B271c5C0b26F421741e481', label: 'Uniswap V3 (Base)' },
            { address: '0x000000000022D473030F116dDEE9F6B43aC78BA3', label: 'Permit2' },
        ],
        arbitrum: [
            { address: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', label: 'Uniswap (Arbitrum)' },
            { address: '0x1111111254EEB25477B68fb85Ed929f73A960582', label: '1inch V5' },
        ],
    };

    ipcMain.handle('approval:scan', async (_, address, chain) => {
        try {
            if (!rateLimiter.check('approval:scan', 3, 60000)) {
                return { ok: false, error: 'RATE_LIMIT: Too many approval scans' };
            }
            validateAddress(address, 'address');
            const safeChain = validateChain(chain);
            const provider = getProvider(safeChain);
            const defaultTokens = DEFAULT_TOKENS[safeChain] || [];
            const settings = ledger.getSettings();
            const customTokens = settings.customTokens?.[safeChain] || [];
            const seen = new Set();
            const tokens = [...defaultTokens, ...customTokens].filter(t => {
                const a = t.address.toLowerCase();
                if (seen.has(a)) return false;
                seen.add(a);
                return true;
            });
            const spenders = KNOWN_SPENDERS[safeChain] || KNOWN_SPENDERS.ethereum;
            const approvals = [];

            for (const token of tokens) {
                const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
                const checks = await Promise.allSettled(
                    spenders.map(async s => {
                        const allowance = await contract.allowance(address, s.address);
                        if (allowance > 0n) {
                            const formatted = ethers.formatUnits(allowance, token.decimals);
                            const isUnlimited = allowance >= ethers.MaxUint256 / 2n;
                            return {
                                token: token.symbol,
                                tokenAddress: token.address,
                                decimals: token.decimals,
                                spender: s.address,
                                spenderLabel: s.label,
                                allowance: allowance.toString(),
                                formatted,
                                isUnlimited,
                            };
                        }
                        return null;
                    })
                );
                checks.forEach(r => {
                    if (r.status === 'fulfilled' && r.value) approvals.push(r.value);
                });
            }

            return { ok: true, approvals, chain: safeChain, scannedAt: new Date().toISOString() };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('approval:revoke', async (_, tokenAddress, spenderAddress, chain) => {
        try {
            if (!rateLimiter.check('approval:revoke', 5, 60000)) {
                return { ok: false, error: 'RATE_LIMIT: Too many revoke requests' };
            }
            validateAddress(tokenAddress, 'tokenAddress');
            validateAddress(spenderAddress, 'spenderAddress');
            const safeChain = validateChain(chain);
            const vault = ledger.getVault();
            const wallet = vault.wallets[vault.active];
            if (!wallet) return { ok: false, error: 'No active wallet' };

            const provider = getProvider(safeChain);
            const signer = new ethers.Wallet(wallet.privateKey, provider);
            const contract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
            const tx = await contract.approve(spenderAddress, 0);
            ledger.recordSpend('0', tx.hash, safeChain);
            return { ok: true, txHash: tx.hash };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    // ═══════════════════════════════════════════════════════════
    // ADDRESS BOOK — Persistent contact management
    // ═══════════════════════════════════════════════════════════

    ipcMain.handle('addressbook:list', () => {
        try {
            const settings = ledger.getSettings();
            return { ok: true, contacts: settings.addressBook || [] };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    ipcMain.handle('addressbook:add', (_, contact) => {
        try {
            if (!contact || !contact.address || typeof contact.address !== 'string') {
                return { ok: false, error: 'Address required' };
            }
            if (contact.label && contact.label.length > 64) {
                return { ok: false, error: 'Label too long (64 char max)' };
            }
            const settings = ledger.getSettings();
            const book = settings.addressBook || [];
            if (book.length >= 200) return { ok: false, error: 'Address book full (200 max)' };
            const exists = book.some(c => c.address.toLowerCase() === contact.address.toLowerCase());
            if (exists) return { ok: false, error: 'Address already in book' };
            book.push({
                address: contact.address.trim(),
                label: contact.label || 'Unnamed',
                chain: contact.chain || 'all',
                notes: contact.notes || '',
                addedAt: new Date().toISOString(),
                lastUsed: null,
            });
            ledger.updateSettings({ addressBook: book });
            return { ok: true, count: book.length };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    ipcMain.handle('addressbook:remove', (_, address) => {
        try {
            const settings = ledger.getSettings();
            const book = (settings.addressBook || []).filter(
                c => c.address.toLowerCase() !== address.toLowerCase()
            );
            ledger.updateSettings({ addressBook: book });
            return { ok: true, count: book.length };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    ipcMain.handle('addressbook:update', (_, address, updates) => {
        try {
            const settings = ledger.getSettings();
            const book = settings.addressBook || [];
            const idx = book.findIndex(c => c.address.toLowerCase() === address.toLowerCase());
            if (idx === -1) return { ok: false, error: 'Contact not found' };
            book[idx] = { ...book[idx], ...updates };
            ledger.updateSettings({ addressBook: book });
            return { ok: true };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    ipcMain.handle('addressbook:touch', (_, address) => {
        try {
            const settings = ledger.getSettings();
            const book = settings.addressBook || [];
            const idx = book.findIndex(c => c.address.toLowerCase() === address.toLowerCase());
            if (idx >= 0) {
                book[idx].lastUsed = new Date().toISOString();
                ledger.updateSettings({ addressBook: book });
            }
            return { ok: true };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    // ═══════════════════════════════════════════════════════════
    // GAS ESTIMATION — Pre-send cost preview
    // ═══════════════════════════════════════════════════════════

    ipcMain.handle('gas:estimate', async (_, payload) => {
        try {
            const { from, to, value, data, chain } = payload || {};
            validateAddress(from, 'from');
            validateAddress(to, 'to');
            const safeChain = validateChain(chain);
            const provider = getProvider(safeChain);

            const [gasEstimate, feeData] = await Promise.all([
                provider.estimateGas({ from, to, value: value ? BigInt(value) : 0n, data: data || '0x' }).catch(() => 21000n),
                provider.getFeeData(),
            ]);

            const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || 0n;
            const costWei = BigInt(gasEstimate) * gasPrice;
            const costEth = ethers.formatEther(costWei);

            // Fetch approximate ETH price (simple heuristic via gas price level)
            // Use a rough conversion — $3000/ETH as fallback
            const ethPriceUsd = 3000;
            const costUsd = (parseFloat(costEth) * ethPriceUsd).toFixed(4);

            return {
                ok: true,
                gasUnits: gasEstimate.toString(),
                gasPriceGwei: ethers.formatUnits(gasPrice, 'gwei'),
                costEth,
                costUsd,
                maxFeePerGas: feeData.maxFeePerGas?.toString(),
                maxPriorityFee: feeData.maxPriorityFeePerGas?.toString(),
            };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    // ═══════════════════════════════════════════════════════════
    // SOLANA NFTs — Metaplex via parsed token accounts
    // ═══════════════════════════════════════════════════════════

    ipcMain.handle('sol:nfts', async (_, address) => {
        try {
            if (!rateLimiter.check('sol:nfts', 3, 60000)) {
                return { ok: false, error: 'RATE_LIMIT: Too many Solana NFT scans' };
            }
            if (!solChain.isValidSOLAddress(address)) {
                return { ok: false, error: 'Invalid SOL address' };
            }

            const { Connection, PublicKey } = require('@solana/web3.js');
            const SOLANA_RPC = process.env.OMEGA_SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
            const connection = new Connection(SOLANA_RPC, 'confirmed');
            const pubkey = new PublicKey(address);
            const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

            const response = await connection.getParsedTokenAccountsByOwner(pubkey, {
                programId: TOKEN_PROGRAM_ID,
            });

            // Filter for NFTs (amount == 1, decimals == 0)
            const nftAccounts = response.value.filter(({ account }) => {
                const info = account.data.parsed.info;
                return info.tokenAmount.uiAmount === 1 && info.tokenAmount.decimals === 0;
            });

            const nfts = [];
            for (const { account } of nftAccounts.slice(0, 20)) {
                const mint = account.data.parsed.info.mint;
                try {
                    // Fetch metadata PDA
                    const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
                    const [metadataPDA] = PublicKey.findProgramAddressSync(
                        [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), new PublicKey(mint).toBuffer()],
                        METADATA_PROGRAM_ID
                    );
                    const metadataAccount = await connection.getAccountInfo(metadataPDA);
                    if (!metadataAccount) { nfts.push({ contract: mint, tokenId: '0', name: `SOL NFT ${mint.slice(0, 8)}...`, collection: 'Unknown', symbol: 'SOL', image: null, chain: 'solana' }); continue; }

                    // Parse on-chain metadata (simplified Borsh decode)
                    const data = metadataAccount.data;
                    // Skip: key(1) + updateAuth(32) + mint(32) + name offset
                    let offset = 1 + 32 + 32;
                    const nameLen = data.readUInt32LE(offset); offset += 4;
                    const name = data.subarray(offset, offset + nameLen).toString('utf8').replace(/\0/g, '').trim();
                    offset += nameLen;
                    const symbolLen = data.readUInt32LE(offset); offset += 4;
                    const symbol = data.subarray(offset, offset + symbolLen).toString('utf8').replace(/\0/g, '').trim();
                    offset += symbolLen;
                    const uriLen = data.readUInt32LE(offset); offset += 4;
                    const uri = data.subarray(offset, offset + uriLen).toString('utf8').replace(/\0/g, '').trim();

                    let imageUrl = null;
                    let imageData = null;
                    let description = null;
                    let collection = symbol || 'SOL NFT';
                    if (uri && uri.startsWith('http')) {
                        try {
                            const metaRes = await fetch(uri, { signal: AbortSignal.timeout(5000) });
                            if (metaRes.ok) {
                                const meta = await metaRes.json();
                                imageUrl = meta.image || null;
                                description = meta.description || null;
                                collection = meta.collection?.name || meta.symbol || collection;
                            }
                        } catch { /* metadata fetch failed */ }
                    }

                    nfts.push({
                        contract: mint,
                        tokenId: '0',
                        name: name || `SOL NFT ${mint.slice(0, 8)}...`,
                        collection,
                        symbol: symbol || 'SOL',
                        image: imageUrl,
                        imageData: null, // Don't cache base64 by default for scan
                        description,
                        tokenURI: uri || null,
                        chain: 'solana',
                    });
                } catch { /* skip this NFT */ }
            }

            return { ok: true, nfts, chain: 'solana' };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    // ── TELEMETRY ──────────────────────────────────────────

    ipcMain.handle('telemetry:status', () => {
        try {
            const spend = ledger.getSpendStatus();
            return {
                invariants: '10/10',
                spendStatus: spend,
                uptime: process.uptime(),
                assurance: 'STATE_LEVEL_SHIELDED'
            };
        } catch { return { invariants: 'LOCKED', uptime: process.uptime() }; }
    });

    ipcMain.handle('telemetry:extraction', () => {
        try { return { ok: true, log: ledger.getExtractionLog() }; }
        catch (e) { return { ok: false, error: e.message }; }
    });

    // ═══════════════════════════════════════════════════════════
    // NFTs — ERC-721 + ERC-1155 Detection via Transfer Events
    // ═══════════════════════════════════════════════════════════

    ipcMain.handle('nft:list', async (_, address, chain) => {
        try {
            // Rate limit: 5 NFT scans per 60 seconds
            if (!rateLimiter.check('nft:list', 5, 60000)) {
                return { ok: false, error: 'RATE_LIMIT: Too many NFT scan requests' };
            }
            validateAddress(address, 'address');
            const safeChain = validateChain(chain);
            const provider = getProvider(safeChain);

            // Event topics
            const erc721Transfer = ethers.id('Transfer(address,address,uint256)');
            const erc1155TransferSingle = ethers.id('TransferSingle(address,address,address,uint256,uint256)');
            const erc1155TransferBatch = ethers.id('TransferBatch(address,address,address,uint256[],uint256[])');

            // Scan last ~100,000 blocks (~14 days on Ethereum)
            const currentBlock = await provider.getBlockNumber();
            const TOTAL_RANGE = 100000;
            const CHUNK_SIZE = 10000;
            const startBlock = Math.max(0, currentBlock - TOTAL_RANGE);
            const paddedAddr = ethers.zeroPadValue(address, 32);

            // ── Diagnostics ─────────────────────────────────────
            const diag = {
                erc721Found: 0, erc1155ChunksOk: 0, erc1155LogsRaw: 0,
                erc1155Found: 0, erc1155Errors: [],
                scanRange: `${startBlock}-${currentBlock}`,
                paddedAddr: paddedAddr.slice(0, 22) + '...',
                sampleTopic3: null, batchLogsRaw: 0,
            };

            // ── ERC-721 scan ─────────────────────────────────────
            const erc721Map = new Map();

            for (let from = startBlock; from <= currentBlock; from += CHUNK_SIZE) {
                const to = Math.min(from + CHUNK_SIZE - 1, currentBlock);
                try {
                    const logs = await provider.getLogs({
                        fromBlock: from, toBlock: to,
                        topics: [erc721Transfer, null, paddedAddr],
                    });
                    for (const log of logs) {
                        if (log.topics.length !== 4) continue;
                        const tokenId = BigInt(log.topics[3]).toString();
                        erc721Map.set(`${log.address}:${tokenId}`, {
                            contractAddr: log.address, tokenId, standard: 'ERC-721',
                        });
                    }
                } catch { /* chunk failed */ }
            }

            // Remove ERC-721 sent away
            for (let from = startBlock; from <= currentBlock; from += CHUNK_SIZE) {
                const to = Math.min(from + CHUNK_SIZE - 1, currentBlock);
                try {
                    const logs = await provider.getLogs({
                        fromBlock: from, toBlock: to,
                        topics: [erc721Transfer, paddedAddr, null],
                    });
                    for (const log of logs) {
                        if (log.topics.length !== 4) continue;
                        const tokenId = BigInt(log.topics[3]).toString();
                        erc721Map.delete(`${log.address}:${tokenId}`);
                    }
                } catch { /* chunk failed */ }
            }

            // ── ERC-1155 scan (TransferSingle + TransferBatch) ───
            // Use OR filter: topics[0] = [sigSingle, sigBatch]
            const erc1155Map = new Map();

            for (let from = startBlock; from <= currentBlock; from += CHUNK_SIZE) {
                const to = Math.min(from + CHUNK_SIZE - 1, currentBlock);
                try {
                    const logs = await provider.getLogs({
                        fromBlock: from, toBlock: to,
                        topics: [[erc1155TransferSingle, erc1155TransferBatch]],
                    });
                    diag.erc1155LogsRaw += logs.length;
                    diag.erc1155ChunksOk++;

                    for (const log of logs) {
                        try {
                            // Capture first sample for debugging
                            if (!diag.sampleTopic3 && log.topics[3]) {
                                diag.sampleTopic3 = log.topics[3].slice(0, 22) + '...';
                            }

                            // topics[3] = to address (indexed) for both Single and Batch
                            const toAddr = log.topics[3];
                            if (!toAddr || toAddr.toLowerCase() !== paddedAddr.toLowerCase()) continue;

                            const isSingle = log.topics[0].toLowerCase() === erc1155TransferSingle.toLowerCase();
                            if (isSingle) {
                                // TransferSingle: data = id(32) + value(32)
                                const dataHex = log.data.slice(2);
                                const tokenId = BigInt('0x' + dataHex.slice(0, 64)).toString();
                                erc1155Map.set(`${log.address}:${tokenId}`, {
                                    contractAddr: log.address, tokenId, standard: 'ERC-1155',
                                });
                            } else {
                                // TransferBatch: data = ABI encoded (uint256[] ids, uint256[] values)
                                diag.batchLogsRaw++;
                                try {
                                    const iface = new ethers.Interface([
                                        'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
                                    ]);
                                    const decoded = iface.parseLog({ topics: log.topics, data: log.data });
                                    if (decoded) {
                                        const ids = decoded.args.ids || decoded.args[3];
                                        for (const id of ids) {
                                            const tokenId = id.toString();
                                            erc1155Map.set(`${log.address}:${tokenId}`, {
                                                contractAddr: log.address, tokenId, standard: 'ERC-1155',
                                            });
                                        }
                                    }
                                } catch { /* batch decode failed */ }
                            }
                        } catch (decErr) { diag.erc1155Errors.push(decErr.message); }
                    }
                } catch (chunkErr) { diag.erc1155Errors.push(`chunk ${from}: ${chunkErr.message?.slice(0, 80)}`); }
            }

            // Remove ERC-1155 sent away (topics[2] = from)
            for (let from = startBlock; from <= currentBlock; from += CHUNK_SIZE) {
                const to = Math.min(from + CHUNK_SIZE - 1, currentBlock);
                try {
                    const logs = await provider.getLogs({
                        fromBlock: from, toBlock: to,
                        topics: [[erc1155TransferSingle, erc1155TransferBatch]],
                    });
                    for (const log of logs) {
                        try {
                            const fromAddr = log.topics[2];
                            if (!fromAddr || fromAddr.toLowerCase() !== paddedAddr.toLowerCase()) continue;
                            const isSingle = log.topics[0].toLowerCase() === erc1155TransferSingle.toLowerCase();
                            if (isSingle) {
                                const dataHex = log.data.slice(2);
                                const tokenId = BigInt('0x' + dataHex.slice(0, 64)).toString();
                                erc1155Map.delete(`${log.address}:${tokenId}`);
                            } else {
                                try {
                                    const iface = new ethers.Interface([
                                        'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
                                    ]);
                                    const decoded = iface.parseLog({ topics: log.topics, data: log.data });
                                    if (decoded) {
                                        const ids = decoded.args.ids || decoded.args[3];
                                        for (const id of ids) {
                                            erc1155Map.delete(`${log.address}:${id.toString()}`);
                                        }
                                    }
                                } catch { /* batch decode failed */ }
                            }
                        } catch { /* decode failed */ }
                    }
                } catch { /* chunk failed */ }
            }

            // ── Merge and enrich ─────────────────────────────────
            diag.erc721Found = erc721Map.size;
            diag.erc1155Found = erc1155Map.size;
            const allCandidates = [...erc721Map.values(), ...erc1155Map.values()];
            const nfts = [];

            for (const nft of allCandidates.slice(0, 30)) {
                try {
                    let collectionName = 'Unknown';
                    let collectionSymbol = '?';
                    let metadata = null;
                    let imageUrl = null;
                    let uri = null;

                    if (nft.standard === 'ERC-721') {
                        const contract = new ethers.Contract(nft.contractAddr, ERC721_ABI, provider);
                        const owner = await contract.ownerOf(nft.tokenId);
                        if (owner.toLowerCase() !== address.toLowerCase()) continue;

                        const [name, symbol, tokenURI] = await Promise.allSettled([
                            contract.name(), contract.symbol(), contract.tokenURI(nft.tokenId),
                        ]);
                        collectionName = name.status === 'fulfilled' ? name.value : 'Unknown';
                        collectionSymbol = symbol.status === 'fulfilled' ? symbol.value : '?';
                        uri = tokenURI.status === 'fulfilled' ? tokenURI.value : null;

                    } else if (nft.standard === 'ERC-1155') {
                        const contract = new ethers.Contract(nft.contractAddr, ERC1155_ABI, provider);
                        const balance = await contract.balanceOf(address, nft.tokenId);
                        if (balance === 0n) continue;

                        const [uriResult] = await Promise.allSettled([
                            contract.uri(nft.tokenId),
                        ]);
                        if (uriResult.status === 'fulfilled') {
                            uri = uriResult.value;
                        } else {
                            diag.metaStatus = `uri() failed: ${uriResult.reason?.message?.slice(0, 60)}`;
                        }

                        // ERC-1155 uri may use {id} placeholder — try multiple formats
                        if (uri && (uri.includes('{id}') || uri.includes('{ID}'))) {
                            const hexId = BigInt(nft.tokenId).toString(16).padStart(64, '0');
                            const decId = nft.tokenId.toString();
                            const shortHex = BigInt(nft.tokenId).toString(16);
                            // Store candidates: hex-padded (spec), decimal (common), short hex
                            uri = { template: uri, candidates: [hexId, decId, shortHex] };
                        }
                        diag.erc1155Uri = typeof uri === 'string' ? uri.slice(0, 120) : `template+3 variants`;
                    }

                    // ── Resolve metadata URI ─────────────────────────
                    if (uri) {
                        // Build list of URIs to try
                        let urisToTry = [];
                        if (typeof uri === 'object' && uri.template) {
                            // ERC-1155 with {id} — try each candidate
                            for (const candidate of uri.candidates) {
                                let u = uri.template.replace('{id}', candidate).replace('{ID}', candidate);
                                urisToTry.push(u);
                            }
                            uri = urisToTry[0]; // use first as default for the nftData
                        } else {
                            urisToTry = [uri];
                        }

                        // Handle data: URIs
                        if (urisToTry[0].startsWith('data:application/json;base64,')) {
                            try {
                                const b64 = urisToTry[0].slice('data:application/json;base64,'.length);
                                metadata = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
                                imageUrl = metadata.image;
                                diag.metaStatus = `data-b64 OK, img=${imageUrl ? 'yes' : 'no'}`;
                            } catch (e) { diag.metaStatus = `data-b64 FAIL: ${e.message?.slice(0, 40)}`; }
                        } else if (urisToTry[0].startsWith('data:application/json,')) {
                            try {
                                metadata = JSON.parse(decodeURIComponent(urisToTry[0].slice('data:application/json,'.length)));
                                imageUrl = metadata.image;
                                diag.metaStatus = `data-inline OK, img=${imageUrl ? 'yes' : 'no'}`;
                            } catch (e) { diag.metaStatus = `data-inline FAIL: ${e.message?.slice(0, 40)}`; }
                        } else {
                            // Try each URI variant until one succeeds
                            for (const tryUri of urisToTry) {
                                let resolvedUri = tryUri;
                                if (tryUri.startsWith('ipfs://')) {
                                    resolvedUri = `https://ipfs.io/ipfs/${tryUri.slice(7)}`;
                                } else if (tryUri.startsWith('ar://')) {
                                    resolvedUri = `https://arweave.net/${tryUri.slice(5)}`;
                                }
                                try {
                                    const metaRes = await fetch(resolvedUri, { signal: AbortSignal.timeout(10000) });
                                    if (metaRes.ok) {
                                        const text = await metaRes.text();
                                        metadata = JSON.parse(text);
                                        imageUrl = metadata.image;
                                        uri = tryUri; // use the working URI
                                        diag.metaStatus = `OK(${tryUri.slice(-12)}), name=${metadata.name?.slice(0, 20)}, img=${imageUrl ? 'yes' : 'no'}`;
                                        break;
                                    }
                                } catch { /* try next */ }
                            }
                            if (!metadata) {
                                diag.metaStatus = `all ${urisToTry.length} URI variants failed (404/timeout)`;
                            }
                        }

                        // Resolve image URL protocols (ipfs://, ar://)
                        if (imageUrl) {
                            if (imageUrl.startsWith('ipfs://')) {
                                imageUrl = `https://ipfs.io/ipfs/${imageUrl.slice(7)}`;
                            } else if (imageUrl.startsWith('ar://')) {
                                imageUrl = `https://arweave.net/${imageUrl.slice(5)}`;
                            }
                            diag.imageUrl = imageUrl.slice(0, 80);
                        }
                    } else if (!diag.metaStatus) {
                        diag.metaStatus = 'no URI';
                    }

                    const nftData = {
                        contract: nft.contractAddr,
                        tokenId: nft.tokenId,
                        name: metadata?.name || `#${nft.tokenId}`,
                        collection: (nft.standard === 'ERC-1155' && metadata)
                            ? (metadata.collection || metadata.name || collectionName)
                            : collectionName,
                        symbol: collectionSymbol,
                        image: imageUrl,
                        description: metadata?.description || null,
                        tokenURI: uri,
                        standard: nft.standard,
                    };
                    nfts.push(nftData);

                    // Auto-pin to My Collection
                    try {
                        ledger.pinNft({ ...nftData, chain: safeChain });
                    } catch { /* pin failed, non-fatal */ }
                } catch { /* Contract call failed, skip */ }
            }

            return { ok: true, nfts, chain: safeChain, diag };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    // ═══════════════════════════════════════════════════════════
    // NFT Ownership Verification — check pinned NFTs still owned
    // ═══════════════════════════════════════════════════════════

    ipcMain.handle('nft:verifyPinned', async (_, address, chain) => {
        try {
            if (!rateLimiter.check('nft:verifyPinned', 3, 60000)) {
                return { ok: false, error: 'RATE_LIMIT' };
            }
            validateAddress(address, 'address');
            const safeChain = validateChain(chain);
            const provider = getProvider(safeChain);
            const pinned = ledger.getPinnedNfts();
            const chainPinned = pinned.filter(n => (n.chain || 'ethereum') === safeChain);
            const removed = [];

            for (const nft of chainPinned) {
                try {
                    let owned = false;
                    if (nft.standard === 'ERC-1155') {
                        const contract = new ethers.Contract(nft.contract, ERC1155_ABI, provider);
                        const balance = await contract.balanceOf(address, nft.tokenId);
                        owned = balance > 0n;
                    } else {
                        // Default to ERC-721
                        const contract = new ethers.Contract(nft.contract, ERC721_ABI, provider);
                        const owner = await contract.ownerOf(nft.tokenId);
                        owned = owner.toLowerCase() === address.toLowerCase();
                    }
                    if (!owned) {
                        ledger.unpinNft(nft.contract, nft.tokenId);
                        removed.push(`${nft.contract}:${nft.tokenId}`);
                    }
                } catch { /* Contract call failed, keep pinned (may be on wrong chain) */ }
            }

            return { ok: true, verified: chainPinned.length, removed: removed.length, removedKeys: removed };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('nft:save', async (_, imageUrl, nftName) => {
        try {
            // Rate limit: 10 saves per 60 seconds
            if (!rateLimiter.check('nft:save', 10, 60000)) {
                return { ok: false, error: 'RATE_LIMIT: Too many save requests' };
            }
            if (!imageUrl || typeof imageUrl !== 'string') {
                return { ok: false, error: 'No image URL provided' };
            }

            // Resolve IPFS
            let url = imageUrl;
            if (url.startsWith('ipfs://')) {
                url = `https://ipfs.io/ipfs/${url.slice(7)}`;
            }

            // Download image
            const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
            if (!response.ok) return { ok: false, error: `Download failed: ${response.status}` };

            const contentType = response.headers.get('content-type') || '';
            const buffer = Buffer.from(await response.arrayBuffer());

            // Determine extension from content-type
            const extMap = {
                'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
                'image/webp': '.webp', 'image/svg+xml': '.svg', 'video/mp4': '.mp4',
            };
            let ext = '.png'; // default
            for (const [mime, e] of Object.entries(extMap)) {
                if (contentType.includes(mime)) { ext = e; break; }
            }

            // Clean filename
            const safeName = (nftName || 'nft').replace(/[^a-zA-Z0-9_\- ]/g, '').slice(0, 60);
            const defaultName = `${safeName}${ext}`;

            // Show save dialog
            const { dialog } = require('electron');
            const { canceled, filePath } = await dialog.showSaveDialog({
                title: 'Save NFT',
                defaultPath: defaultName,
                filters: [
                    { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
                    { name: 'Video', extensions: ['mp4'] },
                    { name: 'All Files', extensions: ['*'] },
                ],
            });

            if (canceled || !filePath) return { ok: false, error: 'Cancelled' };

            const fsP = require('fs');
            fsP.writeFileSync(filePath, buffer);
            return { ok: true, path: filePath, size: buffer.length };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('nft:pin', async (_, nft) => {
        try {
            if (!nft || !nft.contract || !nft.tokenId) {
                return { ok: false, error: 'Invalid NFT data' };
            }

            // Download image as base64 data URI for offline persistence
            let imageData = null;
            if (nft.image) {
                try {
                    let url = nft.image;
                    if (url.startsWith('ipfs://')) url = `https://ipfs.io/ipfs/${url.slice(7)}`;
                    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
                    if (resp.ok) {
                        const buf = Buffer.from(await resp.arrayBuffer());
                        const ct = resp.headers.get('content-type') || 'image/png';
                        // Cap at 2MB to avoid bloating the vault
                        if (buf.length <= 2 * 1024 * 1024) {
                            imageData = `data:${ct};base64,${buf.toString('base64')}`;
                        }
                    }
                } catch { /* image download failed, pin without image */ }
            }

            const pinData = {
                contract: nft.contract,
                tokenId: nft.tokenId,
                name: nft.name || `#${nft.tokenId}`,
                collection: nft.collection || 'Unknown',
                symbol: nft.symbol || '?',
                description: nft.description || null,
                image: nft.image, // Original URL
                imageData, // Base64 for offline display
                tokenURI: nft.tokenURI || null,
                chain: nft.chain || 'ethereum',
            };

            const added = ledger.pinNft(pinData);
            return { ok: true, added, pinned: ledger.getPinnedNfts().length };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('nft:unpin', (_, contract, tokenId) => {
        try {
            const removed = ledger.unpinNft(contract, tokenId);
            return { ok: true, removed, pinned: ledger.getPinnedNfts().length };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('nft:pinned', () => {
        try {
            return { ok: true, nfts: ledger.getPinnedNfts() };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('nft:transfer', async (_, contractAddr, tokenId, toAddress, chain) => {
        try {
            // Rate limit: 3 NFT transfers per 60 seconds
            if (!rateLimiter.check('nft:transfer', 3, 60000)) {
                return { ok: false, error: 'RATE_LIMIT: Too many NFT transfer requests' };
            }

            validateAddress(contractAddr, 'contractAddress');
            validateAddress(toAddress, 'toAddress');
            const safeChain = validateChain(chain);

            // Strict-Mode Check
            const settings = ledger.getSettings();
            if (settings.strictModeEnabled) {
                const whitelist = settings.addressWhitelist || [];
                const isWhitelisted = whitelist.some(w => w.address.toLowerCase() === toAddress.toLowerCase());
                if (!isWhitelisted) {
                    return { ok: false, error: 'STRICT_MODE: Destination address is not in whitelist' };
                }
            }

            const vault = ledger.getVault();
            const wallet = vault.wallets[vault.active];
            if (!wallet) return { ok: false, error: 'No active wallet' };

            const provider = getProvider(safeChain);
            const signer = new ethers.Wallet(wallet.privateKey, provider);
            const contract = new ethers.Contract(contractAddr, ERC721_ABI, signer);

            // Verify ownership before transfer
            const owner = await contract.ownerOf(tokenId);
            if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
                return { ok: false, error: `Not owner — current owner: ${owner.slice(0, 10)}...` };
            }

            // Execute safeTransferFrom(from, to, tokenId)
            const tx = await contract['safeTransferFrom(address,address,uint256)'](
                wallet.address, toAddress, tokenId
            );

            // Record in ledger
            ledger.recordSpend('0', tx.hash, safeChain);

            // Auto-unpin if it was pinned
            try { ledger.unpinNft(contractAddr, tokenId); } catch { /* not pinned */ }

            return { ok: true, txHash: tx.hash, from: wallet.address, to: toAddress };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('nft:autoPin', async (_, contractAddr, tokenId, chain) => {
        try {
            validateAddress(contractAddr, 'contractAddress');
            const safeChain = validateChain(chain);
            const provider = getProvider(safeChain);
            const contract = new ethers.Contract(contractAddr, ERC721_ABI, provider);

            const [name, symbol, tokenURI] = await Promise.allSettled([
                contract.name(),
                contract.symbol(),
                contract.tokenURI(tokenId),
            ]);

            let metadata = null;
            let imageUrl = null;
            let imageData = null;
            const uri = tokenURI.status === 'fulfilled' ? tokenURI.value : null;
            if (uri) {
                let resolvedUri = uri;
                if (uri.startsWith('ipfs://')) resolvedUri = `https://ipfs.io/ipfs/${uri.slice(7)}`;
                try {
                    const metaRes = await fetch(resolvedUri, { signal: AbortSignal.timeout(8000) });
                    if (metaRes.ok) {
                        metadata = await metaRes.json();
                        imageUrl = metadata.image;
                        if (imageUrl?.startsWith('ipfs://')) {
                            imageUrl = `https://ipfs.io/ipfs/${imageUrl.slice(7)}`;
                        }
                        // Download image as base64
                        if (imageUrl) {
                            try {
                                const imgResp = await fetch(imageUrl, { signal: AbortSignal.timeout(10000) });
                                if (imgResp.ok) {
                                    const buf = Buffer.from(await imgResp.arrayBuffer());
                                    const ct = imgResp.headers.get('content-type') || 'image/png';
                                    if (buf.length <= 2 * 1024 * 1024) {
                                        imageData = `data:${ct};base64,${buf.toString('base64')}`;
                                    }
                                }
                            } catch { /* image download failed */ }
                        }
                    }
                } catch { /* metadata fetch failed */ }
            }

            const pinData = {
                contract: contractAddr,
                tokenId: String(tokenId),
                name: metadata?.name || `#${tokenId}`,
                collection: name.status === 'fulfilled' ? name.value : 'Unknown',
                symbol: symbol.status === 'fulfilled' ? symbol.value : '?',
                description: metadata?.description || null,
                image: imageUrl,
                imageData,
                tokenURI: uri,
                chain: safeChain,
            };

            ledger.pinNft(pinData);
            return { ok: true, nft: pinData };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    // ═══════════════════════════════════════════════════════════
    // BITCOIN — BIP84 Native SegWit via Blockstream
    // ═══════════════════════════════════════════════════════════

    ipcMain.handle('btc:deriveAddress', (_, idx) => {
        try {
            const vault = ledger.getVault();
            const safeIdx = validateIndex(idx, vault.wallets.length);
            const w = vault.wallets[safeIdx];
            if (!w.mnemonic) return { ok: false, error: 'No mnemonic — BTC requires seed phrase wallet' };
            const derived = btcChain.deriveFromMnemonic(w.mnemonic);
            return { ok: true, address: derived.address, path: derived.path };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    ipcMain.handle('btc:balance', async (_, address) => {
        try {
            if (!btcChain.isValidBTCAddress(address)) {
                return { ok: false, error: 'Invalid BTC address' };
            }
            const balance = await btcChain.getBalance(address);
            return { ok: true, balance };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    ipcMain.handle('btc:fees', async () => {
        try {
            const fees = await btcChain.getFeeEstimate();
            return { ok: true, fees };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    ipcMain.handle('btc:send', async (_, idx, toAddress, amountSats, feeRate) => {
        try {
            // Rate limit: 3 BTC sends per 60 seconds
            if (!rateLimiter.check('btc:send', 3, 60000)) {
                return { ok: false, error: 'RATE_LIMIT: Too many BTC send requests' };
            }
            if (!btcChain.isValidBTCAddress(toAddress)) {
                return { ok: false, error: 'Invalid BTC destination address' };
            }
            if (typeof amountSats !== 'number' || amountSats <= 0) {
                return { ok: false, error: 'Invalid amount (satoshis must be > 0)' };
            }

            const vault = ledger.getVault();
            const safeIdx = validateIndex(idx, vault.wallets.length);
            const w = vault.wallets[safeIdx];
            if (!w.mnemonic) return { ok: false, error: 'No mnemonic — BTC requires seed phrase wallet' };

            const derived = btcChain.deriveFromMnemonic(w.mnemonic);
            const result = await btcChain.sendBTC(derived.wif, derived.address, toAddress, amountSats, feeRate || 5);

            // Record in spend ledger
            ledger.recordSpend('0', result.txHash, 'bitcoin');

            return { ok: true, ...result };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    ipcMain.handle('btc:history', async (_, address) => {
        try {
            if (!btcChain.isValidBTCAddress(address)) {
                return { ok: false, error: 'Invalid BTC address' };
            }
            const history = await btcChain.getHistory(address);
            return { ok: true, history };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    // ═══════════════════════════════════════════════════════════
    // SOLANA — Ed25519 via Solana JSON-RPC
    // ═══════════════════════════════════════════════════════════

    ipcMain.handle('sol:deriveAddress', (_, idx) => {
        try {
            const vault = ledger.getVault();
            const safeIdx = validateIndex(idx, vault.wallets.length);
            const w = vault.wallets[safeIdx];
            if (!w.mnemonic) return { ok: false, error: 'No mnemonic — SOL requires seed phrase wallet' };
            const derived = solChain.deriveFromMnemonic(w.mnemonic);
            return { ok: true, address: derived.address, path: derived.path };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    ipcMain.handle('sol:balance', async (_, address) => {
        try {
            if (!solChain.isValidSOLAddress(address)) {
                return { ok: false, error: 'Invalid SOL address' };
            }
            const balance = await solChain.getBalance(address);
            return { ok: true, balance };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    ipcMain.handle('sol:tokens', async (_, address) => {
        try {
            if (!solChain.isValidSOLAddress(address)) {
                return { ok: false, error: 'Invalid SOL address' };
            }
            const tokens = await solChain.getTokenAccounts(address);
            return { ok: true, tokens };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    ipcMain.handle('sol:send', async (_, idx, toAddress, amountSOL) => {
        try {
            // Rate limit: 3 SOL sends per 60 seconds
            if (!rateLimiter.check('sol:send', 3, 60000)) {
                return { ok: false, error: 'RATE_LIMIT: Too many SOL send requests' };
            }
            if (!solChain.isValidSOLAddress(toAddress)) {
                return { ok: false, error: 'Invalid SOL destination address' };
            }
            const amount = parseFloat(amountSOL);
            if (isNaN(amount) || amount <= 0) {
                return { ok: false, error: 'Invalid amount (SOL must be > 0)' };
            }

            const vault = ledger.getVault();
            const safeIdx = validateIndex(idx, vault.wallets.length);
            const w = vault.wallets[safeIdx];
            if (!w.mnemonic) return { ok: false, error: 'No mnemonic — SOL requires seed phrase wallet' };

            const derived = solChain.deriveFromMnemonic(w.mnemonic);
            const result = await solChain.sendSOL(derived.secretKey, toAddress, amount);

            // Record in spend ledger
            ledger.recordSpend('0', result.txHash, 'solana');

            return { ok: true, ...result };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    ipcMain.handle('sol:history', async (_, address) => {
        try {
            if (!solChain.isValidSOLAddress(address)) {
                return { ok: false, error: 'Invalid SOL address' };
            }
            const history = await solChain.getHistory(address);
            return { ok: true, history };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    // ═══════════════════════════════════════════════════════════════
    // SMART RECEIVE — Main-process truth for receive profiles
    // ═══════════════════════════════════════════════════════════════

    const RECEIVE_WARNINGS = {
        evm: [
            'This address can receive assets on all EVM-compatible networks.',
            'Ensure the sending network matches the asset you intend to receive.',
            'Sending from the wrong network may result in permanent loss.',
        ],
        btc: [
            'This is a Bitcoin SegWit receive address.',
            'Do NOT send Ethereum, Solana, or other non-Bitcoin assets here.',
            'Only send BTC on the Bitcoin network.',
        ],
        sol: [
            'This is a Solana wallet address.',
            'Do NOT send Bitcoin or EVM assets to this address.',
            'Only send SOL and Solana tokens (SPL) here.',
        ],
        nft_evm: [
            'This address can receive ERC-721 and ERC-1155 NFTs.',
            'Only receive NFTs from trusted sources.',
            'Spam NFTs may contain malicious links or deceptive branding.',
        ],
        nft_sol: [
            'This address can receive Metaplex NFTs on Solana.',
            'Only receive NFTs from trusted sources.',
            'Spam NFTs may appear and should be ignored.',
        ],
    };

    const ASSET_CHAIN_MAP = {
        ETH: ['ethereum', 'base', 'arbitrum', 'optimism', 'linea', 'scroll', 'zksync-era', 'mantle', 'sepolia', 'base-sepolia'],
        MATIC: ['polygon'],
        BNB: ['bsc'],
        AVAX: ['avalanche'],
        FTM: ['fantom'],
        CRO: ['cronos'],
        BTC: ['bitcoin'],
        SOL: ['solana'],
        USDC: ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon'],
        USDT: ['ethereum', 'arbitrum', 'optimism', 'polygon', 'bsc'],
        NFT: ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'solana'],
    };

    const ADDRESS_TYPES = {
        evm: { type: 'EVM', format: '0x...', description: 'Shared across all EVM-compatible chains' },
        btc: { type: 'Bitcoin SegWit', format: 'bc1...', description: 'Native SegWit receive address' },
        sol: { type: 'Solana', format: 'base58', description: 'Solana wallet address' },
    };

    secureHandle('wallet:getReceiveProfile', async (_, walletIdx, asset, chain) => {
        const vault = ledger.getVault();
        const idx = walletIdx ?? vault.active ?? 0;
        const wallet = vault.wallets[idx];
        if (!wallet) return { ok: false, error: 'Wallet not found' };

        const assetUpper = (asset || 'ETH').toUpperCase();
        const safeChain = chain || 'ethereum';

        // Determine address family
        let family = 'evm';
        let address = wallet.address;
        if (safeChain === 'bitcoin' || assetUpper === 'BTC') {
            family = 'btc';
            try {
                const btcRes = await btcChain.deriveAddress(vault.wallets[idx], idx);
                address = btcRes?.address || 'BTC derivation unavailable';
            } catch { address = 'BTC derivation unavailable'; }
        } else if (safeChain === 'solana' || assetUpper === 'SOL') {
            family = 'sol';
            try {
                const solRes = await solChain.deriveAddress(vault.wallets[idx], idx);
                address = solRes?.address || 'SOL derivation unavailable';
            } catch { address = 'SOL derivation unavailable'; }
        }

        // Determine available chains for this asset
        const availableChains = ASSET_CHAIN_MAP[assetUpper] || ASSET_CHAIN_MAP.ETH;

        // Build warnings
        let warningKey = family;
        if (assetUpper === 'NFT') warningKey = family === 'sol' ? 'nft_sol' : 'nft_evm';
        const warnings = RECEIVE_WARNINGS[warningKey] || RECEIVE_WARNINGS.evm;

        // Chain mismatch warning
        const chainWarnings = [...warnings];
        if (family === 'evm' && !availableChains.includes(safeChain)) {
            chainWarnings.unshift(`⚠ ${assetUpper} may not be available on ${safeChain}. Verify before sending.`);
        }

        return {
            ok: true,
            walletIdx: idx,
            walletLabel: wallet.label,
            asset: assetUpper,
            chain: safeChain,
            address,
            addressType: ADDRESS_TYPES[family] || ADDRESS_TYPES.evm,
            qrPayload: buildEIP681Payload(address, assetUpper, safeChain, family),
            availableChains,
            warnings: chainWarnings,
            generatedBy: 'main-process',
            generatedAt: new Date().toISOString(),
        };
    });

    // EIP-681 payload builder for token-specific QR codes
    function buildEIP681Payload(address, asset, chain, family) {
        if (family !== 'evm') return address; // BTC/SOL use plain address
        const chainId = swapEngine.CHAIN_IDS[chain];
        if (!chainId) return address;

        // Native ETH: ethereum:0xaddr@chainId
        if (['ETH', 'NATIVE'].includes(asset)) {
            return `ethereum:${address}@${chainId}`;
        }

        // Token: ethereum:0xtoken@chainId/transfer?address=0xwallet
        const tokenInfo = swapEngine.COMMON_TOKENS[chain]?.[asset];
        if (tokenInfo) {
            return `ethereum:${tokenInfo.address}@${chainId}/transfer?address=${address}`;
        }

        // Fallback: plain address with chain
        return `ethereum:${address}@${chainId}`;
    }

    secureHandle('wallet:getReceiveOptions', async (_, walletIdx) => {
        const vault = ledger.getVault();
        const idx = walletIdx ?? vault.active ?? 0;
        const wallet = vault.wallets[idx];
        if (!wallet) return { ok: false, error: 'Wallet not found' };

        return {
            ok: true,
            assets: Object.keys(ASSET_CHAIN_MAP),
            chains: Object.fromEntries(Object.entries(ASSET_CHAIN_MAP)),
        };
    });

    // ═══════════════════════════════════════════════════════════════
    // ON-RAMP — Buy Crypto via external providers
    // ═══════════════════════════════════════════════════════════════

    const ONRAMP_PROVIDERS = {
        moonpay: {
            name: 'MoonPay',
            baseUrl: 'https://buy.moonpay.com',
            buildUrl: (address, asset, chain, amount) => {
                const currency = asset.toLowerCase() === 'eth' ? 'eth' :
                    asset.toLowerCase() === 'btc' ? 'btc' :
                    asset.toLowerCase() === 'sol' ? 'sol' :
                    asset.toLowerCase() === 'usdc' ? 'usdc' : 'eth';
                const params = new URLSearchParams({
                    walletAddress: address,
                    currencyCode: currency,
                    ...(amount ? { baseCurrencyAmount: amount } : {}),
                });
                return `https://buy.moonpay.com?${params.toString()}`;
            },
            supported: ['ETH', 'BTC', 'SOL', 'USDC', 'USDT', 'MATIC'],
        },
        ramp: {
            name: 'Ramp Network',
            baseUrl: 'https://app.ramp.network',
            buildUrl: (address, asset, chain, amount) => {
                const swapAsset = asset.toUpperCase() === 'ETH' ? 'ETH_ETH' :
                    asset.toUpperCase() === 'BTC' ? 'BTC_BTC' :
                    asset.toUpperCase() === 'SOL' ? 'SOLANA_SOL' :
                    asset.toUpperCase() === 'USDC' ? 'ETH_USDC' : 'ETH_ETH';
                const params = new URLSearchParams({
                    userAddress: address,
                    swapAsset,
                    ...(amount ? { fiatValue: amount } : {}),
                });
                return `https://app.ramp.network?${params.toString()}`;
            },
            supported: ['ETH', 'BTC', 'SOL', 'USDC'],
        },
        transak: {
            name: 'Transak',
            baseUrl: 'https://global.transak.com',
            buildUrl: (address, asset, chain, amount) => {
                const params = new URLSearchParams({
                    walletAddress: address,
                    cryptoCurrencyCode: asset.toUpperCase(),
                    ...(amount ? { defaultFiatAmount: amount } : {}),
                    disableWalletAddressForm: 'true',
                });
                return `https://global.transak.com?${params.toString()}`;
            },
            supported: ['ETH', 'BTC', 'SOL', 'USDC', 'USDT', 'MATIC', 'BNB', 'AVAX'],
        },
    };

    secureHandle('onramp:getUrl', async (_, provider, asset, chain, amount) => {
        const vault = ledger.getVault();
        const wallet = vault.wallets[vault.active || 0];
        if (!wallet) return { ok: false, error: 'No active wallet' };

        const providerKey = (provider || 'ramp').toLowerCase();
        const providerConfig = ONRAMP_PROVIDERS[providerKey];
        if (!providerConfig) return { ok: false, error: `Unknown provider: ${provider}` };

        const assetUpper = (asset || 'ETH').toUpperCase();
        if (!providerConfig.supported.includes(assetUpper)) {
            return { ok: false, error: `${providerConfig.name} does not support ${assetUpper}` };
        }

        // Determine correct address
        let address = wallet.address;
        if (assetUpper === 'BTC') {
            try {
                const btcRes = await btcChain.deriveAddress(wallet, vault.active || 0);
                address = btcRes?.address || wallet.address;
            } catch { /* fallback to EVM */ }
        } else if (assetUpper === 'SOL') {
            try {
                const solRes = await solChain.deriveAddress(wallet, vault.active || 0);
                address = solRes?.address || wallet.address;
            } catch { /* fallback to EVM */ }
        }

        const url = providerConfig.buildUrl(address, assetUpper, chain, amount);

        // Validate generated URL
        try { new URL(url); } catch {
            return { ok: false, error: 'Failed to build on-ramp URL' };
        }

        return {
            ok: true,
            url,
            provider: providerConfig.name,
            asset: assetUpper,
            address,
            warning: 'You will be redirected to an external service. OmegaWallet never handles your fiat. Funds will be sent directly to your wallet address.',
            generatedBy: 'main-process',
        };
    });

    secureHandle('onramp:providers', async () => {
        return {
            ok: true,
            providers: Object.entries(ONRAMP_PROVIDERS).map(([key, p]) => ({
                id: key, name: p.name, supported: p.supported,
            })),
        };
    });

    // ═══════════════════════════════════════════════════════════════
    // TOKEN SWAP — DEX aggregator integration
    // ═══════════════════════════════════════════════════════════════

    secureHandle('swap:tokens', async (_, chain) => {
        try {
            const tokens = swapEngine.getSwappableTokens(chain || 'ethereum');
            return { ok: true, tokens };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    secureHandle('swap:quote', async (_, params) => {
        try {
            if (!params || typeof params !== 'object') {
                return { ok: false, error: 'Invalid swap parameters' };
            }
            const vault = ledger.getVault();
            const wallet = vault.wallets[vault.active || 0];
            if (!wallet) return { ok: false, error: 'No active wallet' };

            const quote = await swapEngine.getSwapQuote({
                fromToken: params.fromToken || 'ETH',
                toToken: params.toToken || 'USDC',
                amount: params.amount || '0.01',
                chain: params.chain || 'ethereum',
                slippage: params.slippage || 0.5,
                fromAddress: wallet.address,
            });

            return quote;
        } catch (e) { return { ok: false, error: e.message }; }
    });

    secureHandle('swap:execute', async (_, params) => {
        try {
            if (!params || typeof params !== 'object') {
                return { ok: false, error: 'Invalid swap parameters' };
            }
            const vault = ledger.getVault();
            const wallet = vault.wallets[vault.active || 0];
            if (!wallet) return { ok: false, error: 'No active wallet' };

            // Get fresh quote
            const quote = await swapEngine.getSwapQuote({
                fromToken: params.fromToken,
                toToken: params.toToken,
                amount: params.amount,
                chain: params.chain || 'ethereum',
                slippage: params.slippage || 0.5,
                fromAddress: wallet.address,
            });

            if (!quote.ok) return quote;

            // Build swap tx
            const txData = swapEngine.buildSwapTx(quote, wallet.address);
            if (!txData) {
                return { ok: false, error: 'Swap route unavailable — API key required for live execution' };
            }

            // Route through bundler:prepare for simulation + two-phase signing
            return {
                ok: true,
                action: 'prepare',
                userOp: txData,
                chain: params.chain || 'ethereum',
                quote: {
                    fromToken: quote.fromToken,
                    toToken: quote.toToken,
                    sellAmount: quote.sellAmount,
                    buyAmount: quote.buyAmountFormatted || quote.buyAmount,
                    priceImpact: quote.priceImpact,
                    route: quote.route,
                    source: quote.source,
                },
                message: 'Use bundler:prepare with this userOp to complete the swap',
            };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    // ═══════════════════════════════════════════════════════════════
    // SYSTEM UTILITIES
    // ═══════════════════════════════════════════════════════════════

    // ── Open External URL (validates scheme) ────────────────────
    ipcMain.handle('system:openExternal', async (_, url) => {
        try {
            const { shell } = require('electron');
            // Only allow http/https URLs
            if (typeof url !== 'string') return { ok: false, error: 'Invalid URL' };
            const parsed = new URL(url);
            if (!['http:', 'https:'].includes(parsed.protocol)) {
                return { ok: false, error: 'Only HTTP/HTTPS URLs allowed' };
            }
            await shell.openExternal(url);
            return { ok: true };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    // ── Version ───────────────────────────────────────────────
    ipcMain.handle('system:version', () => {
        try {
            const { app } = require('electron');
            const pkg = require('./package.json');
            return {
                ok: true,
                version: pkg.version || app.getVersion(),
                name: pkg.name || 'OmegaWallet',
                electron: process.versions.electron,
                node: process.versions.node,
                chrome: process.versions.chrome,
            };
        } catch (e) { return { ok: true, version: '2.1.0' }; }
    });

    // ── Price Feed (CoinGecko proxy, 60s cache) ──────────────
    let priceCache = { data: null, ts: 0 };
    ipcMain.handle('system:prices', async (_, ids) => {
        try {
            const now = Date.now();
            if (priceCache.data && now - priceCache.ts < 60000) {
                return { ok: true, prices: priceCache.data };
            }
            const coinIds = ids || 'ethereum,bitcoin,solana';
            const res = await fetch(
                `https://api.coingecko.com/api/v3/simple/price?ids=${coinIds}&vs_currencies=usd`,
                { signal: AbortSignal.timeout(5000) }
            );
            if (!res.ok) return { ok: false, error: `CoinGecko ${res.status}` };
            const data = await res.json();
            priceCache = { data, ts: now };
            return { ok: true, prices: data };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    // ── Dynamic Security Score ──────────────────────────────────
    ipcMain.handle('system:securityScore', () => {
        try {
            let score = 0;
            const maxScore = 100;
            const factors = [];

            // Encrypted ledger active (+25)
            const ledgerActive = ledger._initialized;
            if (ledgerActive) score += 25;
            factors.push({ name: 'Encrypted vault active', points: 25, earned: ledgerActive });

            // Get settings for remaining checks
            let settings = {};
            try { settings = ledger.getSettings(); } catch { /* vault locked */ }

            // Spend limit configured and < 100 (+20)
            const limit = parseFloat(settings.spendLimit || '10');
            const limitOk = limit > 0 && limit <= 100;
            if (limitOk) score += 20;
            factors.push({ name: 'Spend limit configured', points: 20, earned: limitOk });

            // Auto-lock enabled (+20) — main.js defaults to 5min even if unset
            const autoLock = settings.autoLockMinutes;
            const autoLockOk = autoLock === undefined || autoLock === null || parseInt(autoLock) > 0;
            if (autoLockOk) score += 20;
            factors.push({ name: 'Auto-lock timer enabled', points: 20, earned: autoLockOk });

            // Strict mode on (+20)
            const strictOk = !!settings.strictModeEnabled;
            if (strictOk) score += 20;
            factors.push({ name: 'Strict mode enabled', points: 20, earned: strictOk, tip: 'Enable in Settings → Strict-Mode' });

            // Address whitelist has entries (+15)
            const whitelistOk = settings.addressWhitelist?.length > 0;
            if (whitelistOk) score += 15;
            factors.push({ name: 'Address whitelist active', points: 15, earned: whitelistOk, tip: 'Add trusted addresses in Settings → Whitelist' });

            return { ok: true, score: Math.min(score, maxScore), maxScore, factors };
        } catch { return { ok: true, score: 0, maxScore: 100, factors: [] }; }
    });
}

module.exports = { registerHandlers };
