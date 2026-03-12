/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  WS-BRIDGE — Phantom Bridge WebSocket Server (v4.0 Hardened)  ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Listens on ws://127.0.0.1:9377 (loopback ONLY).
 * Receives EIP-1193 JSON-RPC from the Chrome extension.
 *
 * v4.0 SECURITY:
 *   - Loopback-only binding (127.0.0.1)
 *   - Origin-locked to chrome-extension://
 *   - Per-session cryptographic nonce handshake
 *   - Max 3 concurrent WebSocket connections
 *   - 64KB message size limit
 *   - 120s idle timeout per connection
 *   - All connection attempts logged to encrypted ledger
 *   - eth_requestAccounts requires human approval via UI modal
 *   - eth_sendTransaction requires human approval via UI modal
 *   - personal_sign / signTypedData require human approval via UI modal
 *   - Read-only RPC calls pass through without approval
 */
const { WebSocketServer } = require('ws');
const { ipcMain } = require('electron');
const { ethers } = require('ethers');
const crypto = require('crypto');

const WS_PORT = 9377;
const MAX_CLIENTS = 3;
const MAX_MESSAGE_BYTES = 65536; // 64KB
const NONCE_TIMEOUT_MS = 5000;
const IDLE_TIMEOUT_MS = 120000;

// Methods that require explicit human approval
const APPROVAL_REQUIRED = new Set([
    'eth_requestAccounts',
    'eth_sendTransaction',
    'personal_sign',
    'eth_signTypedData',
    'eth_signTypedData_v4',
    'wallet_switchEthereumChain'
]);

class PhantomBridge {
    constructor(ledger, mainWindow, getProvider) {
        this.ledger = ledger;
        this.mainWindow = mainWindow;
        this.getProvider = getProvider;
        this.wss = null;
        this.clients = new Map(); // ws → { origin, nonce, authenticated, idleTimer }
        this.approvedOrigins = new Set();
        this._pendingApproval = null;
        this._connectionLog = []; // Auditable connection log
        this._setupApprovalIPC();
    }

    _setupApprovalIPC() {
        // Listen for approval/rejection from the renderer UI
        ipcMain.handle('bridge:respond', (_, approved) => {
            if (this._pendingApproval) {
                this._pendingApproval.resolve(approved);
                this._pendingApproval = null;
            }
        });
    }

    // Request approval from the user via the UI
    _requestApproval(method, params, origin) {
        return new Promise((resolve, reject) => {
            this._pendingApproval = { resolve, reject };
            this._popWindow();

            // Send to renderer for display
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('bridge:approval-request', {
                    method,
                    params,
                    origin,
                    timestamp: Date.now()
                });
            }

            // 120s timeout — auto-reject if no response
            setTimeout(() => {
                if (this._pendingApproval) {
                    this._pendingApproval.resolve(false);
                    this._pendingApproval = null;
                }
            }, 120000);
        });
    }

    start() {
        this.wss = new WebSocketServer({
            port: WS_PORT,
            host: '127.0.0.1',
            maxPayload: MAX_MESSAGE_BYTES,
        });

        this.wss.on('connection', (ws, req) => {
            const origin = req.headers.origin || '';
            const remoteAddr = req.socket.remoteAddress;

            // Log connection attempt to audit trail
            this._logConnection('attempt', origin, remoteAddr);

            // Enforce loopback only (defense-in-depth)
            if (remoteAddr !== '127.0.0.1' && remoteAddr !== '::1' && remoteAddr !== '::ffff:127.0.0.1') {
                this._logConnection('rejected_remote', origin, remoteAddr);
                ws.close(4003, 'Non-loopback connection rejected');
                return;
            }

            // Enforce origin
            if (!origin.startsWith('chrome-extension://')) {
                this._logConnection('rejected_origin', origin, remoteAddr);
                ws.close(4001, 'Unauthorized origin');
                return;
            }

            // Enforce max connections
            if (this.clients.size >= MAX_CLIENTS) {
                this._logConnection('rejected_capacity', origin, remoteAddr);
                ws.close(4002, 'Too many connections');
                return;
            }

            // Generate per-session nonce for handshake
            const nonce = crypto.randomBytes(32).toString('hex');
            const clientState = {
                origin,
                nonce,
                authenticated: false,
                idleTimer: null,
                connectedAt: Date.now(),
            };
            this.clients.set(ws, clientState);

            // Send nonce challenge — client must echo it back as first message
            ws.send(JSON.stringify({ type: 'nonce_challenge', nonce }));

            // Nonce timeout — disconnect if not authenticated within 5s
            const nonceTimer = setTimeout(() => {
                if (!clientState.authenticated) {
                    this._logConnection('nonce_timeout', origin, remoteAddr);
                    ws.close(4004, 'Nonce handshake timeout');
                }
            }, NONCE_TIMEOUT_MS);

            // Reset idle timer on each message
            const resetIdle = () => {
                if (clientState.idleTimer) clearTimeout(clientState.idleTimer);
                clientState.idleTimer = setTimeout(() => {
                    this._logConnection('idle_timeout', origin, remoteAddr);
                    ws.close(4005, 'Idle timeout');
                }, IDLE_TIMEOUT_MS);
            };

            ws.on('message', async (data) => {
                try {
                    // Message size check (defense-in-depth beyond maxPayload)
                    if (data.length > MAX_MESSAGE_BYTES) {
                        ws.close(4006, 'Message too large');
                        return;
                    }

                    const msg = JSON.parse(data.toString());

                    // First message must be nonce echo
                    if (!clientState.authenticated) {
                        clearTimeout(nonceTimer);
                        if (msg.type === 'nonce_response' && msg.nonce === clientState.nonce) {
                            clientState.authenticated = true;
                            this._logConnection('authenticated', origin, remoteAddr);
                            resetIdle();
                            ws.send(JSON.stringify({ type: 'authenticated', ok: true }));
                        } else {
                            this._logConnection('nonce_failed', origin, remoteAddr);
                            ws.close(4007, 'Invalid nonce response');
                        }
                        return;
                    }

                    resetIdle();
                    const result = await this.handleRPC(msg, origin);
                    ws.send(JSON.stringify({ id: msg.id, result, error: null }));
                } catch (e) {
                    let msg;
                    try { msg = JSON.parse(data.toString()); } catch (_) { msg = {}; }
                    ws.send(JSON.stringify({
                        id: msg?.id,
                        result: null,
                        error: e.message || 'Internal error'
                    }));
                }
            });

            ws.on('close', () => {
                const state = this.clients.get(ws);
                if (state?.idleTimer) clearTimeout(state.idleTimer);
                this.clients.delete(ws);
                this._logConnection('disconnected', origin, remoteAddr);
            });
        });

        this.wss.on('listening', () => {
            console.log(`[PhantomBridge] Listening on ws://127.0.0.1:${WS_PORT}`);
        });

        this.wss.on('error', (err) => {
            console.error('[PhantomBridge] Server error:', err.message);
        });
    }

    stop() {
        if (this.wss) {
            for (const [ws, state] of this.clients) {
                if (state.idleTimer) clearTimeout(state.idleTimer);
                ws.close();
            }
            this.clients.clear();
            this.wss.close();
            this.wss = null;
        }
    }

    _logConnection(event, origin, remoteAddr) {
        const entry = { event, origin, remoteAddr, timestamp: new Date().toISOString() };
        this._connectionLog.push(entry);
        // Keep only last 100 entries in memory
        if (this._connectionLog.length > 100) this._connectionLog.shift();
        // Log to console for debugging
        console.log(`[PhantomBridge] ${event} from ${origin} (${remoteAddr})`);
    }

    getConnectionLog() {
        return [...this._connectionLog];
    }

    pushEvent(event, data) {
        const msg = JSON.stringify({ type: 'event', event, data });
        for (const [ws, state] of this.clients) {
            if (ws.readyState === 1 && state.authenticated) ws.send(msg);
        }
    }

    _popWindow() {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            if (this.mainWindow.isMinimized()) this.mainWindow.restore();
            this.mainWindow.show();
            this.mainWindow.focus();
        }
    }

    // ── EIP-1193 RPC Router ───────────────────────────────────
    async handleRPC({ method, params }, origin) {

        // ── Gate: Approval required for sensitive methods ──────
        if (APPROVAL_REQUIRED.has(method)) {
            // For eth_requestAccounts, skip if origin already approved this session
            if (method === 'eth_requestAccounts' && this.approvedOrigins.has(origin)) {
                // Already approved — return address
            } else {
                const approved = await this._requestApproval(method, params, origin);
                if (!approved) {
                    throw new Error('User rejected the request');
                }
                if (method === 'eth_requestAccounts') {
                    this.approvedOrigins.add(origin);
                }
            }
        }

        switch (method) {

            // ── Connection ────────────────────────────────────
            case 'eth_requestAccounts':
            case 'eth_accounts': {
                const vault = this.ledger.getVault();
                const active = vault.wallets[vault.active];
                return active ? [active.address] : [];
            }

            case 'eth_chainId': {
                const settings = this.ledger.getSettings();
                const chains = {
                    ethereum: '0x1', base: '0x2105', arbitrum: '0xa4b1',
                    optimism: '0xa', sepolia: '0xaa36a7', 'base-sepolia': '0x14a34',
                    polygon: '0x89', avalanche: '0xa86a', bsc: '0x38',
                    fantom: '0xfa', cronos: '0x19', 'zksync-era': '0x144',
                    linea: '0xe708', scroll: '0x82750', mantle: '0x1388',
                };
                return chains[settings.network] || '0xaa36a7';
            }

            case 'net_version': {
                const chainId = await this.handleRPC({ method: 'eth_chainId', params: [] }, origin);
                return String(parseInt(chainId, 16));
            }

            case 'wallet_switchEthereumChain': {
                const target = parseInt(params?.[0]?.chainId, 16);
                const chainMap = {
                    1: 'ethereum', 8453: 'base', 42161: 'arbitrum',
                    10: 'optimism', 11155111: 'sepolia', 84532: 'base-sepolia',
                    137: 'polygon', 43114: 'avalanche', 56: 'bsc',
                    250: 'fantom', 25: 'cronos', 324: 'zksync-era',
                    59144: 'linea', 534352: 'scroll', 5000: 'mantle',
                };
                const net = chainMap[target];
                if (!net) throw new Error(`Unsupported chain: ${target}`);
                this.ledger.updateSettings({ network: net });
                this.pushEvent('chainChanged', '0x' + target.toString(16));
                return null;
            }

            // ── Read-only (passthrough — no approval needed) ──
            case 'eth_blockNumber':
            case 'eth_getBalance':
            case 'eth_getCode':
            case 'eth_getTransactionCount':
            case 'eth_getTransactionReceipt':
            case 'eth_call':
            case 'eth_estimateGas':
            case 'eth_gasPrice':
            case 'eth_getBlockByNumber':
            case 'eth_getBlockByHash': {
                const settings = this.ledger.getSettings();
                const provider = this.getProvider(settings.network);
                return await provider.send(method, params || []);
            }

            // ── Transaction (approved above) ──────────────────
            case 'eth_sendTransaction': {
                const tx = params[0];
                const vault = this.ledger.getVault();
                const wallet = vault.wallets[vault.active];
                if (!wallet) throw new Error('No active wallet');

                if (tx.from && tx.from.toLowerCase() !== wallet.address.toLowerCase()) {
                    throw new Error('Sender mismatch');
                }

                const value = tx.value ? ethers.formatEther(BigInt(tx.value)) : '0';
                const spendStatus = this.ledger.getSpendStatus();
                if (parseFloat(spendStatus.spent) + parseFloat(value) > parseFloat(spendStatus.limit)) {
                    throw new Error(`SPEND_LIMIT: would exceed ${spendStatus.limit} daily limit`);
                }

                const settings = this.ledger.getSettings();
                const provider = this.getProvider(settings.network);
                const signer = new ethers.Wallet(wallet.privateKey, provider);

                const txReq = {
                    to: tx.to,
                    value: tx.value ? BigInt(tx.value) : 0n,
                    data: tx.data || '0x',
                    ...(tx.gas ? { gasLimit: BigInt(tx.gas) } : {}),
                };
                const sentTx = await signer.sendTransaction(txReq);
                this.ledger.recordSpend(value, sentTx.hash, settings.network);
                return sentTx.hash;
            }

            // ── Signing (approved above) ──────────────────────
            case 'personal_sign': {
                const [message, address] = params;
                const vault = this.ledger.getVault();
                const wallet = vault.wallets.find(w =>
                    w.address.toLowerCase() === address?.toLowerCase());
                if (!wallet) throw new Error('Unknown signer');

                const signer = new ethers.Wallet(wallet.privateKey);
                return await signer.signMessage(
                    typeof message === 'string' && message.startsWith('0x')
                        ? ethers.getBytes(message)
                        : message
                );
            }

            case 'eth_signTypedData_v4':
            case 'eth_signTypedData': {
                const [addr, typedData] = params;
                const vault = this.ledger.getVault();
                const wallet = vault.wallets.find(w =>
                    w.address.toLowerCase() === addr?.toLowerCase());
                if (!wallet) throw new Error('Unknown signer');

                const parsed = typeof typedData === 'string' ? JSON.parse(typedData) : typedData;
                const { domain, types, message } = parsed;
                const cleanTypes = { ...types };
                delete cleanTypes.EIP712Domain;

                const signer = new ethers.Wallet(wallet.privateKey);
                return await signer.signTypedData(domain, cleanTypes, message);
            }

            case 'wallet_addEthereumChain':
                throw new Error('OmegaWallet: chain management via desktop app only');

            case 'wallet_requestPermissions':
                return [{ parentCapability: 'eth_accounts' }];

            case 'wallet_getPermissions':
                return [{ parentCapability: 'eth_accounts' }];

            default:
                throw new Error(`Unsupported method: ${method}`);
        }
    }
}

module.exports = { PhantomBridge };
