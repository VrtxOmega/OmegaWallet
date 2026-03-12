/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║       PRELOAD — Typed IPC Armor Plate                        ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Exposes window.omega API via contextBridge.
 * The renderer has ZERO access to Node, fs, or the ledger directly.
 * Every call is a typed IPC invoke that the main process validates.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('omega', {
    // ── Auth (Fresh-Auth Gate) ─────────────────────────────
    auth: {
        freshAuth: (pw) => ipcRenderer.invoke('auth:freshAuth', pw),
        status: () => ipcRenderer.invoke('auth:status'),
        auditLog: (count) => ipcRenderer.invoke('auth:auditLog', count),
    },

    // ── Vault ──────────────────────────────────────────────
    vault: {
        exists: () => ipcRenderer.invoke('vault:exists'),
        create: (pw, label, key) => ipcRenderer.invoke('vault:create', pw, label, key),
        unlock: (pw) => ipcRenderer.invoke('vault:unlock', pw),
        lock: () => ipcRenderer.invoke('vault:lock'),
        destroy: (pw) => ipcRenderer.invoke('vault:destroy', pw),
        getWallets: () => ipcRenderer.invoke('vault:getWallets'),
        addWallet: (label, key) => ipcRenderer.invoke('vault:addWallet', label, key),
        removeWallet: (idx, pw) => ipcRenderer.invoke('vault:removeWallet', idx, pw),
        setActive: (idx) => ipcRenderer.invoke('vault:setActive', idx),
        getKey: (idx, tokenOrPw) => ipcRenderer.invoke('vault:getKey', idx, tokenOrPw),
        // Auto-lock support
        onAutoLocked: (callback) => {
            ipcRenderer.on('vault:auto-locked', () => callback());
        },
        signalUnlocked: () => ipcRenderer.send('vault-unlocked-signal'),
    },

    // ── Cerberus Scanner ───────────────────────────────────
    scanContract: (target, chain) => ipcRenderer.invoke('cerberus:scan', target, chain),

    // ── Transaction Simulator ──────────────────────────────
    simulateTx: (payload) => ipcRenderer.invoke('simulator:run', payload),

    // ── Bundler (Two-Phase Signing) ─────────────────────────
    submitUserOp: (userOp, chain) => ipcRenderer.invoke('bundler:submit', userOp, chain),
    prepareTx: (userOp, chain) => ipcRenderer.invoke('bundler:prepare', userOp, chain),
    confirmTx: (prepareId, tokenOrPw) => ipcRenderer.invoke('bundler:confirm', prepareId, tokenOrPw),
    getOpStatus: (hash, chain) => ipcRenderer.invoke('bundler:status', hash, chain),
    getGas: (chain) => ipcRenderer.invoke('bundler:gas', chain),

    // ── Tokens ─────────────────────────────────────────────
    token: {
        getBalances: (addr, chain) => ipcRenderer.invoke('token:balances', addr, chain),
        transfer: (tokenAddr, to, amt, chain) => ipcRenderer.invoke('token:transfer', tokenAddr, to, amt, chain),
        getInfo: (tokenAddr, chain) => ipcRenderer.invoke('token:info', tokenAddr, chain),
        import: (tokenAddr, chain) => ipcRenderer.invoke('token:import', tokenAddr, chain)
    },

    // ── Spend Tracking ─────────────────────────────────────
    getSpendStatus: () => ipcRenderer.invoke('ledger:getSpend'),
    getSpendHistory: () => ipcRenderer.invoke('ledger:getHistory'),
    recordSpend: (amt, hash, net) => ipcRenderer.invoke('ledger:recordSpend', amt, hash, net),

    // ── Simulator ─────────────────────────────────────────
    simulator: {
        decode: (data, to, value) => ipcRenderer.invoke('simulator:decode', data, to, value),
    },

    // ── Settings ───────────────────────────────────────────
    getSettings: () => ipcRenderer.invoke('settings:get'),
    updateSettings: (updates) => ipcRenderer.invoke('settings:update', updates),

    // ── NFTs ───────────────────────────────────────────────
    nft: {
        list: (address, chain) => ipcRenderer.invoke('nft:list', address, chain),
        save: (imageUrl, nftName) => ipcRenderer.invoke('nft:save', imageUrl, nftName),
        pin: (nft) => ipcRenderer.invoke('nft:pin', nft),
        unpin: (contract, tokenId) => ipcRenderer.invoke('nft:unpin', contract, tokenId),
        pinned: () => ipcRenderer.invoke('nft:pinned'),
        transfer: (contract, tokenId, to, chain) => ipcRenderer.invoke('nft:transfer', contract, tokenId, to, chain),
        autoPin: (contract, tokenId, chain) => ipcRenderer.invoke('nft:autoPin', contract, tokenId, chain),
        verifyPinned: (address, chain) => ipcRenderer.invoke('nft:verifyPinned', address, chain),
    },

    // ── Telemetry ──────────────────────────────────────────
    getRadarStatus: () => ipcRenderer.invoke('telemetry:status'),
    getExtractionLog: () => ipcRenderer.invoke('telemetry:extraction'),

    // ── Token Approvals ───────────────────────────────────
    approval: {
        scan: (address, chain) => ipcRenderer.invoke('approval:scan', address, chain),
        revoke: (tokenAddr, spenderAddr, chain) => ipcRenderer.invoke('approval:revoke', tokenAddr, spenderAddr, chain),
    },

    // ── Address Book ──────────────────────────────────────
    addressbook: {
        list: () => ipcRenderer.invoke('addressbook:list'),
        add: (contact) => ipcRenderer.invoke('addressbook:add', contact),
        remove: (address) => ipcRenderer.invoke('addressbook:remove', address),
        update: (address, updates) => ipcRenderer.invoke('addressbook:update', address, updates),
        touch: (address) => ipcRenderer.invoke('addressbook:touch', address),
    },

    // ── Gas Estimation ────────────────────────────────────
    gasEstimate: (payload) => ipcRenderer.invoke('gas:estimate', payload),

    // ── Smart Receive ────────────────────────────────────
    receive: {
        getProfile: (walletIdx, asset, chain) => ipcRenderer.invoke('wallet:getReceiveProfile', walletIdx, asset, chain),
        getOptions: (walletIdx) => ipcRenderer.invoke('wallet:getReceiveOptions', walletIdx),
    },

    // ── Buy Crypto (On-Ramp) ─────────────────────────────
    onramp: {
        getUrl: (provider, asset, chain, amount) => ipcRenderer.invoke('onramp:getUrl', provider, asset, chain, amount),
        getProviders: () => ipcRenderer.invoke('onramp:providers'),
    },

    // ── Token Swap ───────────────────────────────────────
    swap: {
        getTokens: (chain) => ipcRenderer.invoke('swap:tokens', chain),
        getQuote: (params) => ipcRenderer.invoke('swap:quote', params),
        execute: (params) => ipcRenderer.invoke('swap:execute', params),
    },

    // ── RPC Proxy (v4.0) — renderer never constructs RPC URLs ──
    rpc: {
        call: (chain, method, params) => ipcRenderer.invoke('rpc:call', chain, method, params),
    },

    // ── Bitcoin (v5.0) ────────────────────────────────────
    btc: {
        deriveAddress: (idx) => ipcRenderer.invoke('btc:deriveAddress', idx),
        getBalance: (address) => ipcRenderer.invoke('btc:balance', address),
        getFees: () => ipcRenderer.invoke('btc:fees'),
        send: (idx, to, amountSats, feeRate) => ipcRenderer.invoke('btc:send', idx, to, amountSats, feeRate),
        getHistory: (address) => ipcRenderer.invoke('btc:history', address),
    },

    // ── Solana (v5.0) ─────────────────────────────────────
    sol: {
        deriveAddress: (idx) => ipcRenderer.invoke('sol:deriveAddress', idx),
        getBalance: (address) => ipcRenderer.invoke('sol:balance', address),
        getTokens: (address) => ipcRenderer.invoke('sol:tokens', address),
        send: (idx, to, amountSOL) => ipcRenderer.invoke('sol:send', idx, to, amountSOL),
        getHistory: (address) => ipcRenderer.invoke('sol:history', address),
        nfts: (address) => ipcRenderer.invoke('sol:nfts', address),
    },

    // ── Phantom Bridge Approval ──────────────────────────
    onBridgeRequest: (callback) => {
        ipcRenderer.on('bridge:approval-request', (_, data) => callback(data));
    },
    bridgeRespond: (approved) => ipcRenderer.invoke('bridge:respond', approved),

    // ── WalletConnect v2 ───────────────────────────────────
    wc: {
        pair: (uri) => ipcRenderer.invoke('wc:pair', uri),
        approve: (id, address) => ipcRenderer.invoke('wc:approve', id, address),
        reject: (id) => ipcRenderer.invoke('wc:reject', id),
        disconnect: (topic) => ipcRenderer.invoke('wc:disconnect', topic),
        sessions: () => ipcRenderer.invoke('wc:sessions'),
        respondRequest: (requestId, approved) => ipcRenderer.invoke('wc:respondRequest', requestId, approved),
        onProposal: (cb) => { ipcRenderer.on('wc:proposal', (_, d) => cb(d)); },
        onRequest: (cb) => { ipcRenderer.on('wc:request', (_, d) => cb(d)); },
        onSessionDeleted: (cb) => { ipcRenderer.on('wc:session-deleted', (_, t) => cb(t)); },
        onError: (cb) => { ipcRenderer.on('wc:error', (_, d) => cb(d)); },
        onChainChanged: (cb) => { ipcRenderer.on('wc:chainChanged', (_, d) => cb(d)); },
    },

    // ── Built-in dApp Browser ──────────────────────────────
    dapp: {
        navigate: (url) => ipcRenderer.invoke('dapp:navigate', url),
        back: () => ipcRenderer.invoke('dapp:back'),
        forward: () => ipcRenderer.invoke('dapp:forward'),
        reload: () => ipcRenderer.invoke('dapp:reload'),
        close: () => ipcRenderer.invoke('dapp:close'),
        hide: () => ipcRenderer.invoke('dapp:hide'),
        show: () => ipcRenderer.invoke('dapp:show'),
        getStatus: () => ipcRenderer.invoke('dapp:getStatus'),
        approvalRespond: (id, approved) => ipcRenderer.invoke('dapp:approvalRespond', id, approved),
        // Bookmarks
        bookmarksList: () => ipcRenderer.invoke('dapp:bookmarks:list'),
        bookmarksAdd: (bm) => ipcRenderer.invoke('dapp:bookmarks:add', bm),
        bookmarksRemove: (url) => ipcRenderer.invoke('dapp:bookmarks:remove', url),
        // Permissions
        permissionsList: () => ipcRenderer.invoke('dapp:permissions:list'),
        permissionsRevoke: (origin) => ipcRenderer.invoke('dapp:permissions:revoke', origin),
        permissionsRevokeAll: () => ipcRenderer.invoke('dapp:permissions:revokeAll'),
        // Activity
        activityList: (origin) => ipcRenderer.invoke('dapp:activity:list', origin),
        // Events
        onUrlChanged: (cb) => { ipcRenderer.on('dapp:urlChanged', (_, d) => cb(d)); },
        onTitleChanged: (cb) => { ipcRenderer.on('dapp:titleChanged', (_, d) => cb(d)); },
        onLoading: (cb) => { ipcRenderer.on('dapp:loading', (_, d) => cb(d)); },
        onChainSwitched: (cb) => { ipcRenderer.on('dapp:chainSwitched', (_, d) => cb(d)); },
        onApprovalRequest: (cb) => { ipcRenderer.on('dapp:approval-request', (_, d) => cb(d)); },
        onPhishingWarning: (cb) => { ipcRenderer.on('dapp:phishing-warning', (_, d) => cb(d)); },
    },

    // ── System Utilities ──────────────────────────────────
    openExternal: (url) => ipcRenderer.invoke('system:openExternal', url),
    getVersion: () => ipcRenderer.invoke('system:version'),
    getPrice: (ids) => ipcRenderer.invoke('system:prices', ids),
    getSecurityScore: () => ipcRenderer.invoke('system:securityScore'),
});
