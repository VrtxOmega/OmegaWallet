/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  WC-BRIDGE — WalletConnect v2 Integration (Sign Client)       ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Connects OmegaWallet to any dApp via WalletConnect v2 protocol.
 * User pastes a WC URI → session proposal → approval → JSON-RPC relay.
 *
 * Security:
 *   - All session proposals require human approval via UI modal
 *   - All transactions/signing requests require human approval
 *   - Sessions persist across restarts (built into WC SDK)
 *   - Spend-limit enforcement on eth_sendTransaction
 */
const { SignClient } = require('@walletconnect/sign-client');
const { ipcMain } = require('electron');
const { ethers } = require('ethers');

const WC_PROJECT_ID = process.env.OMEGA_WC_PROJECT_ID || '14e694d2a22db8118cc5973d4a423188';

class WCBridge {
    constructor(ledger, mainWindow, getProvider) {
        this.ledger = ledger;
        this.mainWindow = mainWindow;
        this.getProvider = getProvider;
        this.client = null;
        this._pendingRequests = new Map(); // keyed by counter ID
        this._pendingReqCounter = 0;
    }

    async start() {
        try {
            this.client = await SignClient.init({
                projectId: WC_PROJECT_ID,
                metadata: {
                    name: 'OmegaWallet',
                    description: 'State-grade shielded smart wallet',
                    url: 'https://omegawallet.io',
                    icons: ['https://omegawallet.io/icon.png'],
                },
            });
            console.log('[WCBridge] SignClient initialized');
            this._setupEventListeners();
            this._registerIPC();
        } catch (err) {
            console.error('[WCBridge] Init failed:', err.message);
        }
    }

    _setupEventListeners() {
        // ── Session Proposal — dApp wants to connect ──────────
        this.client.on('session_proposal', async (event) => {
            console.log('[WCBridge] Session proposal from:', event.params.proposer.metadata.name);
            this._popWindow();

            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('wc:proposal', {
                    id: event.id,
                    proposer: event.params.proposer.metadata,
                    requiredNamespaces: event.params.requiredNamespaces,
                    optionalNamespaces: event.params.optionalNamespaces,
                });
            }
        });

        // ── Session Request — dApp sends an RPC call ──────────
        this.client.on('session_request', async (event) => {
            const method = event.params.request.method;
            const params = event.params.request.params;
            const chainId = event.params.chainId;
            console.log(`[WCBridge] Request: ${method} | chain: ${chainId} | params:`, JSON.stringify(params).slice(0, 200));
            try {
                const result = await this._handleRequest(event);
                console.log(`[WCBridge] Success: ${method} =>`, JSON.stringify(result).slice(0, 200));
                await this.client.respond({
                    topic: event.topic,
                    response: { id: event.id, jsonrpc: '2.0', result },
                });
            } catch (err) {
                console.error(`[WCBridge] FAILED: ${method} =>`, err.message, err.stack);
                // Send error to renderer so user can see what went wrong
                if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                    this.mainWindow.webContents.send('wc:error', {
                        method, chainId, error: err.message, timestamp: Date.now()
                    });
                }
                await this.client.respond({
                    topic: event.topic,
                    response: {
                        id: event.id,
                        jsonrpc: '2.0',
                        error: { code: -32603, message: err.message },
                    },
                });
            }
        });

        // ── Session Delete — dApp disconnected ────────────────
        this.client.on('session_delete', (event) => {
            console.log('[WCBridge] Session deleted:', event.topic);
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('wc:session-deleted', event.topic);
            }
        });
    }

    _registerIPC() {
        // Pair with a WC URI
        ipcMain.handle('wc:pair', async (_, uri) => {
            if (!this.client) return { ok: false, error: 'WalletConnect not initialized' };
            if (!uri || !uri.startsWith('wc:')) return { ok: false, error: 'Invalid WC URI' };
            try {
                await this.client.pair({ uri });
                return { ok: true };
            } catch (err) {
                return { ok: false, error: err.message };
            }
        });

        // Approve a session proposal
        ipcMain.handle('wc:approve', async (_, id, accountAddress) => {
            if (!this.client) return { ok: false, error: 'WalletConnect not initialized' };
            try {
                // Build namespaces from what the dApp requested
                const proposal = this.client.proposal.get(id);
                const namespaces = {};

                // Handle required namespaces
                const required = proposal.requiredNamespaces || {};
                for (const [key, ns] of Object.entries(required)) {
                    const chains = ns.chains || [key.includes(':') ? key : `${key}:1`];
                    namespaces[key] = {
                        accounts: chains.map(c => `${c}:${accountAddress}`),
                        methods: ns.methods || [],
                        events: ns.events || [],
                        chains,
                    };
                }

                // Handle optional namespaces — include eip155 if not in required
                const optional = proposal.optionalNamespaces || {};
                for (const [key, ns] of Object.entries(optional)) {
                    if (namespaces[key]) continue; // Already handled
                    const chains = ns.chains || [key.includes(':') ? key : `${key}:1`];
                    namespaces[key] = {
                        accounts: chains.map(c => `${c}:${accountAddress}`),
                        methods: ns.methods || [],
                        events: ns.events || [],
                        chains,
                    };
                }

                // Default: if nothing, at least expose eip155
                if (Object.keys(namespaces).length === 0) {
                    namespaces.eip155 = {
                        accounts: [`eip155:1:${accountAddress}`],
                        methods: ['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4'],
                        events: ['chainChanged', 'accountsChanged'],
                        chains: ['eip155:1'],
                    };
                }

                const { acknowledged } = await this.client.approve({ id, namespaces });
                await acknowledged();
                console.log('[WCBridge] Session approved');
                return { ok: true };
            } catch (err) {
                console.error('[WCBridge] Approve error:', err.message);
                return { ok: false, error: err.message };
            }
        });

        // Reject a session proposal
        ipcMain.handle('wc:reject', async (_, id) => {
            if (!this.client) return { ok: false, error: 'WalletConnect not initialized' };
            try {
                await this.client.reject({ id, reason: { code: 4001, message: 'User rejected' } });
                return { ok: true };
            } catch (err) {
                return { ok: false, error: err.message };
            }
        });

        // Disconnect a session
        ipcMain.handle('wc:disconnect', async (_, topic) => {
            if (!this.client) return { ok: false, error: 'WalletConnect not initialized' };
            try {
                await this.client.disconnect({ topic, reason: { code: 6000, message: 'User disconnect' } });
                return { ok: true };
            } catch (err) {
                return { ok: false, error: err.message };
            }
        });

        // List active sessions
        ipcMain.handle('wc:sessions', async () => {
            if (!this.client) return { ok: true, sessions: [] };
            const sessions = this.client.session.getAll();
            return {
                ok: true,
                sessions: sessions.map(s => ({
                    topic: s.topic,
                    peer: s.peer.metadata,
                    namespaces: s.namespaces,
                    expiry: s.expiry,
                })),
            };
        });

        // Respond to a pending transaction/sign request
        ipcMain.handle('wc:respondRequest', (_, requestId, approved) => {
            const pending = this._pendingRequests.get(requestId);
            if (pending) {
                pending.resolve(approved);
                this._pendingRequests.delete(requestId);
            }
            return { ok: true };
        });
    }

    // ── Handle JSON-RPC requests from dApps ───────────────────
    async _handleRequest(event) {
        const { method, params } = event.params.request;
        const wcChainId = event.params.chainId; // e.g. "eip155:8453"

        // Resolve the correct chain from the WC session context
        const numericChainId = wcChainId ? parseInt(wcChainId.split(':').pop()) : null;
        const chainMap = {
            1: 'ethereum', 8453: 'base', 42161: 'arbitrum',
            10: 'optimism', 11155111: 'sepolia', 84532: 'base-sepolia',
            137: 'polygon', 43114: 'avalanche', 56: 'bsc',
            250: 'fantom', 25: 'cronos', 324: 'zksync-era',
            59144: 'linea', 534352: 'scroll', 5000: 'mantle',
        };
        // Use the dApp's chain, fallback to internal setting
        const resolvedNetwork = (numericChainId && chainMap[numericChainId])
            ? chainMap[numericChainId]
            : this.ledger.getSettings().network;

        console.log(`[WCBridge] Resolved chain: ${wcChainId} => ${resolvedNetwork}`);

        switch (method) {
            case 'eth_sendTransaction': {
                // Request approval from user
                const approved = await this._requestApproval('eth_sendTransaction', params, event);
                if (!approved) throw new Error('User rejected the request');

                const tx = params[0];
                const vault = this.ledger.getVault();
                const wallet = vault.wallets[vault.active];
                if (!wallet) throw new Error('No active wallet');

                // Spend limit check
                const value = tx.value ? ethers.formatEther(BigInt(tx.value)) : '0';
                const spendStatus = this.ledger.getSpendStatus();
                if (parseFloat(spendStatus.spent) + parseFloat(value) > parseFloat(spendStatus.limit)) {
                    throw new Error(`SPEND_LIMIT: would exceed ${spendStatus.limit} daily limit`);
                }

                const settings = this.ledger.getSettings();
                const provider = this.getProvider(resolvedNetwork);
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

            case 'personal_sign': {
                const approved = await this._requestApproval('personal_sign', params, event);
                if (!approved) throw new Error('User rejected the request');

                const [message, address] = params;
                const vault = this.ledger.getVault();
                const wallet = vault.wallets.find(w =>
                    w.address.toLowerCase() === address?.toLowerCase()) || vault.wallets[vault.active];
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
                const approved = await this._requestApproval(method, params, event);
                if (!approved) throw new Error('User rejected the request');

                const [addr, typedData] = params;
                const vault = this.ledger.getVault();
                const wallet = vault.wallets.find(w =>
                    w.address.toLowerCase() === addr?.toLowerCase()) || vault.wallets[vault.active];
                if (!wallet) throw new Error('Unknown signer');

                const parsed = typeof typedData === 'string' ? JSON.parse(typedData) : typedData;
                const { domain, types, message } = parsed;
                const cleanTypes = { ...types };
                delete cleanTypes.EIP712Domain;

                const signer = new ethers.Wallet(wallet.privateKey);
                return await signer.signTypedData(domain, cleanTypes, message);
            }

            case 'eth_accounts': {
                const vault = this.ledger.getVault();
                const active = vault.wallets[vault.active];
                return active ? [active.address] : [];
            }

            case 'eth_chainId': {
                const chains = {
                    ethereum: '0x1', base: '0x2105', arbitrum: '0xa4b1',
                    optimism: '0xa', sepolia: '0xaa36a7', 'base-sepolia': '0x14a34',
                    polygon: '0x89', avalanche: '0xa86a', bsc: '0x38',
                    fantom: '0xfa', cronos: '0x19', 'zksync-era': '0x144',
                    linea: '0xe708', scroll: '0x82750', mantle: '0x1388',
                };
                return chains[resolvedNetwork] || '0x1';
            }

            case 'wallet_switchEthereumChain':
            case 'wallet_addEthereumChain': {
                const targetChainId = parseInt(params?.[0]?.chainId, 16);
                const chainMap = {
                    1: 'ethereum', 8453: 'base', 42161: 'arbitrum',
                    10: 'optimism', 11155111: 'sepolia', 84532: 'base-sepolia',
                    137: 'polygon', 43114: 'avalanche', 56: 'bsc',
                    250: 'fantom', 25: 'cronos', 324: 'zksync-era',
                    59144: 'linea', 534352: 'scroll', 5000: 'mantle',
                };
                const net = chainMap[targetChainId];
                if (!net) throw new Error(`Unsupported chain: ${targetChainId}`);
                this.ledger.updateSettings({ network: net });
                // Notify renderer of chain change
                if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                    this.mainWindow.webContents.send('wc:chainChanged', {
                        network: net, chainId: '0x' + targetChainId.toString(16)
                    });
                }
                return null;
            }

            // Read-only RPC — passthrough
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
                const provider = this.getProvider(resolvedNetwork);
                return await provider.send(method, params || []);
            }

            default:
                throw new Error(`Unsupported method: ${method}`);
        }
    }

    // Request human approval via the renderer UI
    _requestApproval(method, params, event) {
        return new Promise((resolve) => {
            this._popWindow();

            const session = this.client.session.get(event.topic);
            const peerName = session?.peer?.metadata?.name || 'Unknown dApp';

            // Unique ID for this pending request
            const requestId = ++this._pendingReqCounter;

            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('wc:request', {
                    requestId,
                    method,
                    params,
                    peerName,
                    peerUrl: session?.peer?.metadata?.url || '',
                    timestamp: Date.now(),
                });
            }

            // Store resolver keyed by requestId
            this._pendingRequests.set(requestId, { resolve });

            // 120s timeout — auto-reject
            setTimeout(() => {
                if (this._pendingRequests.has(requestId)) {
                    this._pendingRequests.get(requestId).resolve(false);
                    this._pendingRequests.delete(requestId);
                }
            }, 120000);
        });
    }

    _popWindow() {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            if (this.mainWindow.isMinimized()) this.mainWindow.restore();
            this.mainWindow.show();
            this.mainWindow.focus();
        }
    }

    stop() {
        // Sessions persist in SDK storage — just cleanup listeners
        console.log('[WCBridge] Stopped');
    }
}

module.exports = { WCBridge };
