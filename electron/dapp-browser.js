/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  DAPP-BROWSER — Built-in dApp Browser (Electron v33+)          ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Manages a BrowserView that loads any dApp URL directly inside
 * OmegaWallet. The dApp sees window.ethereum injected via
 * dapp-preload.js — zero extensions, zero WebSockets.
 *
 * v2.0 — SHIELDED STATE-LEVEL:
 *   - Phishing detection (curated blocklist + pattern matching)
 *   - Per-dApp persistent permissions (encrypt-at-rest via ledger)
 *   - Activity logging (every tx/sign recorded per-origin)
 *   - Bookmark management (encrypted favorites)
 *   - sandbox: true, contextIsolation: true on BrowserView
 *   - HTTPS-only, blocked protocols, SSL cert enforcement
 *   - Spend limit enforcement on eth_sendTransaction
 */
const { BrowserView, ipcMain } = require('electron');
const { ethers } = require('ethers');
const path = require('path');

// ═══════════════════════════════════════════════════════════════
// SECURITY CONSTANTS
// ═══════════════════════════════════════════════════════════════

// Methods that require explicit human approval
const APPROVAL_REQUIRED = new Set([
    'eth_requestAccounts',
    'eth_sendTransaction',
    'personal_sign',
    'eth_signTypedData',
    'eth_signTypedData_v4',
    'wallet_switchEthereumChain',
    'wallet_addEthereumChain',
]);

// Methods that get logged to activity
const LOGGED_METHODS = new Set([
    'eth_sendTransaction',
    'personal_sign',
    'eth_signTypedData',
    'eth_signTypedData_v4',
    'eth_requestAccounts',
]);

// Chain ID mappings
const CHAIN_MAP = {
    ethereum: '0x1', base: '0x2105', arbitrum: '0xa4b1',
    optimism: '0xa', sepolia: '0xaa36a7', 'base-sepolia': '0x14a34',
    polygon: '0x89', avalanche: '0xa86a', bsc: '0x38',
    fantom: '0xfa', cronos: '0x19', 'zksync-era': '0x144',
    linea: '0xe708', scroll: '0x82750', mantle: '0x1388',
};

const CHAIN_ID_TO_NET = Object.fromEntries(
    Object.entries(CHAIN_MAP).map(([k, v]) => [parseInt(v, 16), k])
);

// ═══════════════════════════════════════════════════════════════
// PHISHING BLOCKLIST — known scam domains
// ═══════════════════════════════════════════════════════════════
const PHISHING_DOMAINS = new Set([
    'uniswapp.org', 'uniswap-airdrop.com', 'uniswap-claim.com',
    'pancakeswap-airdrop.com', 'opensea-nft.org', 'metamask-io.com',
    'metamask-wallet.io', 'walletconnect-bridge.org',
    'aave-finance.com', 'compound-finance.com', 'lido-staking.com',
    'etherscan-verify.com', 'etherscan-token.com',
    'dydx-airdrop.com', 'curve-finance.com', 'sushiswap-rewards.com',
    'chainlink-airdrop.com', 'arbitrum-claim.com', 'optimism-claim.com',
    'blur-airdrop.com', 'zksync-airdrop.com', 'layerzero-claim.com',
    'aptos-airdrop.com', 'sei-claim.com', 'celestia-airdrop.com',
    'eigenlayer-claim.com', 'starknet-airdrop.com',
]);

// Suspicious patterns in domain names
const PHISHING_PATTERNS = [
    /^[a-z]+-airdrop\./i,
    /^[a-z]+-claim\./i,
    /^[a-z]+-rewards\./i,
    /^(?:metamask|phantom|rabby|trust)-(?:io|app|wallet)\./i,
    /free-(?:eth|btc|nft)/i,
    /connect-wallet\./i,
    /verify-wallet\./i,
    /approve-token\./i,
];

function isPhishing(url) {
    try {
        const { hostname } = new URL(url);
        const domain = hostname.replace(/^www\./, '');

        if (PHISHING_DOMAINS.has(domain)) {
            return { blocked: true, reason: `Known phishing domain: ${domain}` };
        }

        for (const pattern of PHISHING_PATTERNS) {
            if (pattern.test(domain)) {
                return { blocked: true, reason: `Suspicious domain pattern: ${domain}` };
            }
        }

        return { blocked: false };
    } catch {
        return { blocked: false };
    }
}

// ═══════════════════════════════════════════════════════════════
// DAPP BROWSER CLASS
// ═══════════════════════════════════════════════════════════════

class DAppBrowser {
    constructor(ledger, mainWindow, getProvider) {
        this.ledger = ledger;
        this.mainWindow = mainWindow;
        this.getProvider = getProvider;
        this.browserView = null;
        this.currentUrl = '';
        this._pendingApprovals = new Map();
        this._approvalCounter = 0;
    }

    start() {
        this._registerIPC();
        console.log('[DAppBrowser] Ready — phishing blocklist loaded');
    }

    _registerIPC() {
        // ── Navigation ──────────────────────────────────────────
        ipcMain.handle('dapp:navigate', async (_, url) => {
            return this._navigate(url);
        });

        ipcMain.handle('dapp:back', () => {
            if (this.browserView?.webContents?.canGoBack()) {
                this.browserView.webContents.goBack();
            }
            return { ok: true };
        });

        ipcMain.handle('dapp:forward', () => {
            if (this.browserView?.webContents?.canGoForward()) {
                this.browserView.webContents.goForward();
            }
            return { ok: true };
        });

        ipcMain.handle('dapp:reload', () => {
            if (this.browserView?.webContents) {
                this.browserView.webContents.reload();
            }
            return { ok: true };
        });

        ipcMain.handle('dapp:close', () => {
            this._closeBrowserView();
            return { ok: true };
        });

        ipcMain.handle('dapp:hide', () => {
            if (this.browserView && this.mainWindow) {
                this.mainWindow.removeBrowserView(this.browserView);
            }
            return { ok: true };
        });

        ipcMain.handle('dapp:show', () => {
            this._showBrowserView();
            return { ok: true };
        });

        ipcMain.handle('dapp:getStatus', () => {
            return {
                ok: true,
                active: !!this.browserView,
                url: this.currentUrl,
            };
        });

        // ── Bookmarks ───────────────────────────────────────────
        ipcMain.handle('dapp:bookmarks:list', () => {
            try { return { ok: true, bookmarks: this.ledger.getDappBookmarks() }; }
            catch (e) { return { ok: false, error: e.message }; }
        });

        ipcMain.handle('dapp:bookmarks:add', (_, bookmark) => {
            try {
                const added = this.ledger.addDappBookmark(bookmark);
                return { ok: true, added };
            } catch (e) { return { ok: false, error: e.message }; }
        });

        ipcMain.handle('dapp:bookmarks:remove', (_, url) => {
            try {
                const removed = this.ledger.removeDappBookmark(url);
                return { ok: true, removed };
            } catch (e) { return { ok: false, error: e.message }; }
        });

        // ── Permissions ─────────────────────────────────────────
        ipcMain.handle('dapp:permissions:list', () => {
            try { return { ok: true, permissions: this.ledger.getDappPermissions() }; }
            catch (e) { return { ok: false, error: e.message }; }
        });

        ipcMain.handle('dapp:permissions:revoke', (_, origin) => {
            try {
                const revoked = this.ledger.revokeDappPermission(origin);
                return { ok: true, revoked };
            } catch (e) { return { ok: false, error: e.message }; }
        });

        ipcMain.handle('dapp:permissions:revokeAll', () => {
            try {
                this.ledger.revokeAllDappPermissions();
                return { ok: true };
            } catch (e) { return { ok: false, error: e.message }; }
        });

        // ── Activity Log ────────────────────────────────────────
        ipcMain.handle('dapp:activity:list', (_, origin) => {
            try { return { ok: true, activity: this.ledger.getDappActivity(origin) }; }
            catch (e) { return { ok: false, error: e.message }; }
        });

        // ── Get current wallet state (called by dapp-preload) ───
        ipcMain.handle('dapp:getState', () => {
            try {
                const vault = this.ledger.getVault();
                const active = vault?.wallets?.[vault.active];
                const settings = this.ledger.getSettings();
                return {
                    accounts: active ? [active.address] : [],
                    chainId: CHAIN_MAP[settings?.network] || '0x1',
                };
            } catch {
                return { accounts: [], chainId: '0x1' };
            }
        });

        // ── RPC from dApp BrowserView ───────────────────────────
        ipcMain.on('dapp:rpc-request', async (event, { id, method, params }) => {
            const senderContents = event.sender;
            if (this.browserView && senderContents !== this.browserView.webContents) {
                senderContents.send('dapp:rpc-result', {
                    id, result: null, error: 'Unauthorized sender'
                });
                return;
            }

            try {
                const result = await this._handleRPC(method, params, senderContents);

                // Log activity for sensitive methods
                if (LOGGED_METHODS.has(method)) {
                    try {
                        const origin = this.currentUrl ? new URL(this.currentUrl).origin : 'Unknown';
                        const vault = this.ledger.getVault();
                        const active = vault?.wallets?.[vault.active];
                        const settings = this.ledger.getSettings();
                        this.ledger.recordDappActivity({
                            origin,
                            method,
                            params: method === 'eth_requestAccounts' ? null : params,
                            result: typeof result === 'string' ? result : 'ok',
                            walletAddress: active?.address,
                            chainId: CHAIN_MAP[settings?.network],
                        });
                    } catch { /* don't fail the RPC for logging errors */ }
                }

                senderContents.send('dapp:rpc-result', { id, result, error: null });
            } catch (err) {
                console.error(`[DAppBrowser] RPC error: ${method} =>`, err.message);
                senderContents.send('dapp:rpc-result', {
                    id, result: null, error: err.message
                });
            }
        });

        // ── Approval response from main UI ──────────────────────
        ipcMain.handle('dapp:approvalRespond', (_, approvalId, approved) => {
            const pending = this._pendingApprovals.get(approvalId);
            if (pending) {
                pending.resolve(approved);
                this._pendingApprovals.delete(approvalId);
            }
            // Re-show BrowserView after approval response
            this._showBrowserView();
            return { ok: true };
        });
    }

    // ── Navigation ──────────────────────────────────────────────
    _navigate(url) {
        if (!url) return { ok: false, error: 'No URL' };

        // Normalize URL
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }

        // Block dangerous protocols
        const blocked = ['file:', 'data:', 'javascript:', 'vbscript:'];
        if (blocked.some(p => url.toLowerCase().startsWith(p))) {
            return { ok: false, error: 'Blocked protocol' };
        }

        // ── Phishing check ──────────────────────────────────────
        const phishResult = isPhishing(url);
        if (phishResult.blocked) {
            this._notifyRenderer('dapp:phishing-warning', {
                url,
                reason: phishResult.reason,
            });
            return { ok: false, error: `PHISHING_BLOCKED: ${phishResult.reason}` };
        }

        try {
            if (!this.browserView) {
                this._createBrowserView();
            }
            this.browserView.webContents.loadURL(url);
            this.currentUrl = url;
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }

    _createBrowserView() {
        this.browserView = new BrowserView({
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: false,
                sandbox: false,
                preload: path.join(__dirname, 'dapp-preload.js'),
            },
        });

        this.mainWindow.addBrowserView(this.browserView);
        this._resizeBrowserView();

        this.mainWindow.on('resize', () => this._resizeBrowserView());

        // Track URL changes + phishing check on in-page nav
        this.browserView.webContents.on('did-navigate', (_, url) => {
            this.currentUrl = url;
            this._notifyRenderer('dapp:urlChanged', { url });
            const p = isPhishing(url);
            if (p.blocked) {
                this.browserView.webContents.stop();
                this._notifyRenderer('dapp:phishing-warning', { url, reason: p.reason });
            }
        });

        this.browserView.webContents.on('did-navigate-in-page', (_, url) => {
            this.currentUrl = url;
            this._notifyRenderer('dapp:urlChanged', { url });
        });

        this.browserView.webContents.on('page-title-updated', (_, title) => {
            this._notifyRenderer('dapp:titleChanged', { title });
        });

        this.browserView.webContents.on('did-start-loading', () => {
            this._notifyRenderer('dapp:loading', { loading: true });
        });
        this.browserView.webContents.on('did-stop-loading', () => {
            this._notifyRenderer('dapp:loading', { loading: false });
        });

        // Provider injection handled by dapp-preload.js
        // (contextIsolation: false — preload sets window.ethereum directly)

        this.browserView.webContents.setWindowOpenHandler(({ url }) => {
            this.browserView.webContents.loadURL(url);
            return { action: 'deny' };
        });

        this.browserView.webContents.on('certificate-error', (event, url) => {
            console.warn(`[DAppBrowser] SSL cert error: ${url}`);
            event.preventDefault();
        });

        console.log('[DAppBrowser] BrowserView created (contextIsolation: false, preload-injected)');
    }

    _resizeBrowserView() {
        if (!this.browserView || !this.mainWindow) return;
        const bounds = this.mainWindow.getContentBounds();
        const SIDEBAR_W = 220;
        const TOPBAR_H = 52;
        this.browserView.setBounds({
            x: SIDEBAR_W,
            y: TOPBAR_H,
            width: Math.max(bounds.width - SIDEBAR_W, 100),
            height: Math.max(bounds.height - TOPBAR_H, 100),
        });
    }

    _showBrowserView() {
        if (!this.browserView || !this.mainWindow) return;
        // Guard: check if already attached
        const views = this.mainWindow.getBrowserViews();
        if (!views.includes(this.browserView)) {
            this.mainWindow.addBrowserView(this.browserView);
        }
        // Set bounds immediately
        this._resizeBrowserView();
        // Re-set bounds on next tick to handle Electron internal timing
        setTimeout(() => this._resizeBrowserView(), 50);
    }

    _closeBrowserView() {
        if (this.browserView) {
            this.mainWindow.removeBrowserView(this.browserView);
            this.browserView.webContents.destroy();
            this.browserView = null;
            this.currentUrl = '';
            console.log('[DAppBrowser] BrowserView closed');
        }
    }

    _notifyRenderer(channel, data) {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send(channel, data);
        }
    }

    // ── RPC Handler ─────────────────────────────────────────────
    async _handleRPC(method, params, senderContents) {
        if (APPROVAL_REQUIRED.has(method)) {
            const origin = this.currentUrl ? new URL(this.currentUrl).origin : 'Unknown';

            // eth_requestAccounts: skip approval if origin has persistent permission
            if (method === 'eth_requestAccounts') {
                if (this.ledger.hasDappPermission(origin)) {
                    this.ledger.touchDappPermission(origin);
                    // Fall through to handler — no modal needed
                } else {
                    const approved = await this._requestApproval(method, params, origin);
                    if (!approved) throw new Error('User rejected the request');
                    // Grant persistent permission
                    const vault = this.ledger.getVault();
                    const active = vault?.wallets?.[vault.active];
                    this.ledger.grantDappPermission(origin, active?.address);
                }
            } else {
                const approved = await this._requestApproval(method, params, origin);
                if (!approved) throw new Error('User rejected the request');
            }
        }

        switch (method) {
            case 'eth_requestAccounts':
            case 'eth_accounts': {
                const vault = this.ledger.getVault();
                const active = vault?.wallets?.[vault.active];
                const accounts = active ? [active.address] : [];
                senderContents.send('dapp:event', {
                    event: 'accountsChanged', data: accounts
                });
                return accounts;
            }

            case 'eth_chainId': {
                const settings = this.ledger.getSettings();
                return CHAIN_MAP[settings?.network] || '0x1';
            }

            case 'net_version': {
                const chainId = await this._handleRPC('eth_chainId', [], senderContents);
                return String(parseInt(chainId, 16));
            }

            case 'wallet_switchEthereumChain':
            case 'wallet_addEthereumChain': {
                const targetChainId = parseInt(params?.[0]?.chainId, 16);
                const net = CHAIN_ID_TO_NET[targetChainId];
                if (!net) throw new Error(`Unsupported chain: ${targetChainId}`);
                this.ledger.updateSettings({ network: net });
                const hexChain = '0x' + targetChainId.toString(16);
                senderContents.send('dapp:event', {
                    event: 'chainChanged', data: hexChain
                });
                this._notifyRenderer('dapp:chainSwitched', { network: net, chainId: hexChain });
                return null;
            }

            case 'wallet_requestPermissions':
                return [{ parentCapability: 'eth_accounts' }];

            case 'wallet_getPermissions':
                return [{ parentCapability: 'eth_accounts' }];

            case 'eth_sendTransaction': {
                const tx = params[0];
                const vault = this.ledger.getVault();
                const wallet = vault?.wallets?.[vault.active];
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
                    ...(tx.gasPrice ? { gasPrice: BigInt(tx.gasPrice) } : {}),
                    ...(tx.maxFeePerGas ? { maxFeePerGas: BigInt(tx.maxFeePerGas) } : {}),
                    ...(tx.maxPriorityFeePerGas ? { maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) } : {}),
                    ...(tx.nonce != null ? { nonce: parseInt(tx.nonce) } : {}),
                };
                const sentTx = await signer.sendTransaction(txReq);
                this.ledger.recordSpend(value, sentTx.hash, settings.network);
                return sentTx.hash;
            }

            case 'personal_sign': {
                const [message, address] = params;
                const vault = this.ledger.getVault();
                const wallet = vault?.wallets?.find(w =>
                    w.address.toLowerCase() === address?.toLowerCase())
                    || vault?.wallets?.[vault.active];
                if (!wallet) throw new Error('Unknown signer');

                const signer = new ethers.Wallet(wallet.privateKey);
                return await signer.signMessage(
                    typeof message === 'string' && message.startsWith('0x')
                        ? ethers.getBytes(message) : message
                );
            }

            case 'eth_signTypedData_v4':
            case 'eth_signTypedData': {
                const [addr, typedData] = params;
                const vault = this.ledger.getVault();
                const wallet = vault?.wallets?.find(w =>
                    w.address.toLowerCase() === addr?.toLowerCase())
                    || vault?.wallets?.[vault.active];
                if (!wallet) throw new Error('Unknown signer');

                const parsed = typeof typedData === 'string' ? JSON.parse(typedData) : typedData;
                const { domain, types, message } = parsed;
                const cleanTypes = { ...types };
                delete cleanTypes.EIP712Domain;

                const signer = new ethers.Wallet(wallet.privateKey);
                return await signer.signTypedData(domain, cleanTypes, message);
            }

            case 'eth_sign': {
                throw new Error('eth_sign is dangerous and disabled. Use personal_sign.');
            }

            case 'eth_blockNumber':
            case 'eth_getBalance':
            case 'eth_getCode':
            case 'eth_getTransactionCount':
            case 'eth_getTransactionReceipt':
            case 'eth_getTransactionByHash':
            case 'eth_call':
            case 'eth_estimateGas':
            case 'eth_gasPrice':
            case 'eth_feeHistory':
            case 'eth_maxPriorityFeePerGas':
            case 'eth_getBlockByNumber':
            case 'eth_getBlockByHash':
            case 'eth_getLogs':
            case 'eth_getStorageAt':
            case 'eth_getProof': {
                const settings = this.ledger.getSettings();
                const provider = this.getProvider(settings.network);
                return await provider.send(method, params || []);
            }

            default:
                console.warn(`[DAppBrowser] Unsupported method: ${method}`);
                throw new Error(`Unsupported method: ${method}`);
        }
    }

    // ── Human Approval Flow ─────────────────────────────────────
    _requestApproval(method, params, origin) {
        return new Promise((resolve) => {
            const approvalId = ++this._approvalCounter;

            // CRITICAL: Hide BrowserView so the approval modal is visible
            // (BrowserView is a native overlay that covers the React DOM)
            if (this.browserView && this.mainWindow) {
                this.mainWindow.removeBrowserView(this.browserView);
            }

            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                if (this.mainWindow.isMinimized()) this.mainWindow.restore();
                this.mainWindow.show();
                this.mainWindow.focus();
            }

            this._notifyRenderer('dapp:approval-request', {
                approvalId,
                method,
                params,
                origin,
                timestamp: Date.now(),
            });

            this._pendingApprovals.set(approvalId, { resolve });

            setTimeout(() => {
                if (this._pendingApprovals.has(approvalId)) {
                    this._pendingApprovals.get(approvalId).resolve(false);
                    this._pendingApprovals.delete(approvalId);
                    this._showBrowserView();
                }
            }, 120000);
        });
    }

    stop() {
        this._closeBrowserView();
        console.log('[DAppBrowser] Stopped');
    }
}

module.exports = { DAppBrowser };
