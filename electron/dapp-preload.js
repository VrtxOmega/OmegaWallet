/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  DAPP-PRELOAD — Native EIP-1193 Provider Injection            ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Runs in the BrowserView with contextIsolation: FALSE.
 * This means we share the same `window` as the dApp page.
 *
 * window.ethereum is set as a REAL JavaScript object BEFORE
 * any page script runs — this is the only way to guarantee
 * that all wallet libraries (wagmi, RainbowKit, Web3Modal,
 * custom SDKs) detect the wallet on first probe.
 *
 * Security model:
 *   nodeIntegration: false — page cannot use require() or Node APIs
 *   ipcRenderer is a closure variable — NOT on window, NOT accessible
 *   to page scripts. The page only sees window.ethereum.
 *
 * This is the same architecture used by MetaMask's Electron tools
 * and Brave browser's built-in wallet.
 */
const { ipcRenderer } = require('electron');

// ═══════════════════════════════════════════════════════════════
// INTERNAL STATE — closure-scoped, invisible to page
// ═══════════════════════════════════════════════════════════════

const _pending = new Map();
const _listeners = {};
let _reqId = 0;
let _accounts = [];
let _chainId = null;

// ═══════════════════════════════════════════════════════════════
// IPC WIRING — ipcRenderer stays in closure, never on window
// ═══════════════════════════════════════════════════════════════

ipcRenderer.on('dapp:rpc-result', (_, { id, result, error }) => {
    const p = _pending.get(id);
    if (!p) return;
    _pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(result);
});

ipcRenderer.on('dapp:event', (_, { event, data }) => {
    if (event === 'accountsChanged') _accounts = data || [];
    if (event === 'chainChanged') _chainId = data;
    _emit(event, data);
});

// Get initial state
ipcRenderer.invoke('dapp:getState').then((state) => {
    if (state) {
        _accounts = state.accounts || [];
        _chainId = state.chainId || null;
    }
});

// ═══════════════════════════════════════════════════════════════
// INTERNALS
// ═══════════════════════════════════════════════════════════════

function _emit(event, data) {
    const fns = _listeners[event] || [];
    for (let i = 0; i < fns.length; i++) {
        try { fns[i](data); } catch (e) { /* silent */ }
    }
}

function _request(args) {
    return new Promise((resolve, reject) => {
        const id = ++_reqId;
        _pending.set(id, { resolve, reject });

        ipcRenderer.send('dapp:rpc-request', {
            id,
            method: args.method,
            params: args.params || [],
        });

        // Approval-requiring methods get 120s, reads get 30s
        const timeout = [
            'eth_sendTransaction', 'personal_sign',
            'eth_signTypedData', 'eth_signTypedData_v4',
            'eth_requestAccounts',
        ].includes(args.method) ? 120000 : 30000;

        setTimeout(() => {
            if (_pending.has(id)) {
                _pending.delete(id);
                reject(new Error('OmegaWallet: request timed out'));
            }
        }, timeout);
    });
}

// ═══════════════════════════════════════════════════════════════
// PROVIDER — real JS object on window.ethereum
// ═══════════════════════════════════════════════════════════════

const provider = {
    // Identity
    _isOmega: true,
    isMetaMask: true,
    isCoinbaseWallet: false,
    isBraveWallet: false,
    isRabby: false,
    isPhantom: false,
    _events: {},
    _eventsCount: 0,

    isConnected() { return true; },

    // Core EIP-1193
    request: _request,

    // ── EventEmitter ────────────────────────────────────────
    on(event, fn) {
        if (!_listeners[event]) _listeners[event] = [];
        _listeners[event].push(fn);
        return provider;
    },

    addListener(event, fn) { return provider.on(event, fn); },

    off(event, fn) {
        if (_listeners[event]) {
            _listeners[event] = _listeners[event].filter(f => f !== fn);
        }
        return provider;
    },

    removeListener(event, fn) { return provider.off(event, fn); },

    removeAllListeners(event) {
        if (event) delete _listeners[event];
        else Object.keys(_listeners).forEach(k => delete _listeners[k]);
        return provider;
    },

    emit(event, ...args) {
        const fns = _listeners[event] || [];
        for (let i = 0; i < fns.length; i++) {
            try { fns[i](...args); } catch (e) { /* silent */ }
        }
        return fns.length > 0;
    },

    once(event, fn) {
        const wrapped = (...args) => {
            provider.removeListener(event, wrapped);
            fn(...args);
        };
        return provider.on(event, wrapped);
    },

    listenerCount(event) {
        return (_listeners[event] || []).length;
    },

    listeners(event) {
        return (_listeners[event] || []).slice();
    },

    // ── Legacy methods ──────────────────────────────────────
    enable() {
        return _request({ method: 'eth_requestAccounts' });
    },

    send(methodOrPayload, paramsOrCb) {
        if (typeof methodOrPayload === 'string') {
            return _request({ method: methodOrPayload, params: paramsOrCb });
        }
        if (typeof paramsOrCb === 'function') {
            _request({ method: methodOrPayload.method, params: methodOrPayload.params })
                .then(r => paramsOrCb(null, { id: methodOrPayload.id, jsonrpc: '2.0', result: r }))
                .catch(e => paramsOrCb(e));
            return;
        }
        return _request({
            method: methodOrPayload.method,
            params: methodOrPayload.params,
        });
    },

    sendAsync(payload, cb) {
        _request({ method: payload.method, params: payload.params })
            .then(r => cb(null, { id: payload.id, jsonrpc: '2.0', result: r }))
            .catch(e => cb(e));
    },

    // ── MetaMask compatibility ──────────────────────────────
    _metamask: {
        isUnlocked: () => Promise.resolve(true),
        requestBatch: () => Promise.resolve([]),
    },

    // ── Dynamic properties ──────────────────────────────────
    get selectedAddress() { return _accounts[0] || null; },
    get chainId() { return _chainId; },
    get networkVersion() {
        return _chainId ? String(parseInt(_chainId, 16)) : null;
    },
    get providers() { return [provider]; },
};

// ═══════════════════════════════════════════════════════════════
// INJECTION — set window.ethereum BEFORE any page script runs
// ═══════════════════════════════════════════════════════════════

// With contextIsolation: false, this directly modifies the page's window
window.ethereum = provider;

// Also freeze the provider identity to prevent dApp tampering
Object.defineProperty(provider, 'isMetaMask', {
    value: true,
    writable: false,
    configurable: false,
});

// ═══════════════════════════════════════════════════════════════
// EIP-6963 — modern wallet discovery
// ═══════════════════════════════════════════════════════════════

const omegaInfo = Object.freeze({
    uuid: 'b7f299dd-omega-wallet-dapp',
    name: 'OmegaWallet',
    icon: 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
        '<rect width="100" height="100" rx="20" fill="#0a0a0f"/>' +
        '<text x="50" y="72" text-anchor="middle" font-size="60" fill="#d4a843">\u03A9</text>' +
        '</svg>'
    ),
    rdns: 'com.omega.wallet',
});

// Also announce as MetaMask so dApp "MetaMask" buttons trigger our provider
// (dApp wallet SDKs filter EIP-6963 providers by rdns: 'io.metamask')
const metamaskInfo = Object.freeze({
    uuid: 'b7f299dd-omega-wallet-metamask',
    name: 'MetaMask',
    icon: 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
        '<rect width="100" height="100" rx="20" fill="#f6851b"/>' +
        '<text x="50" y="72" text-anchor="middle" font-size="50" fill="#fff">M</text>' +
        '</svg>'
    ),
    rdns: 'io.metamask',
});

function announceProviders() {
    try {
        // Announce as OmegaWallet
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
            detail: Object.freeze({ info: omegaInfo, provider }),
        }));
        // Announce as MetaMask (for dApp MetaMask buttons)
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
            detail: Object.freeze({ info: metamaskInfo, provider }),
        }));
    } catch (e) { /* silent */ }
}

// Announce when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        announceProviders();
    });
} else {
    announceProviders();
}

// Re-announce when dApps request discovery
window.addEventListener('eip6963:requestProvider', announceProviders);

console.log('[OmegaWallet] window.ethereum injected — real object, pre-page-script');
