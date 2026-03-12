/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  PROVIDER.JS — Injected EIP-1193 Provider                    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Runs in the PAGE's main world (not isolated).
 * Sets window.ethereum so dApps think we're MetaMask.
 * Zero keys. Zero crypto. Pure relay.
 */
(() => {
    if (window.ethereum?._isOmega) return; // Already injected

    let _reqId = 0;
    const _pending = new Map();
    const _listeners = {};
    let _connected = false; // Track actual wallet connection state

    // ── Poll connection state from background ─────────────────
    function _pollState() {
        try {
            window.postMessage({ type: 'OMEGA_PING' }, '*');
        } catch (_) { }
    }
    setInterval(_pollState, 5000);

    // Listen for connection state updates from inject.js
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;

        if (event.data?.type === 'OMEGA_CONNECTION_STATE') {
            _connected = event.data.connected;
        }

        if (event.data?.type === 'OMEGA_RESPONSE') {
            const { id, result, error } = event.data;
            const p = _pending.get(id);
            if (p) {
                _pending.delete(id);
                if (error) p.reject(new Error(typeof error === 'string' ? error : error.message || 'Unknown error'));
                else p.resolve(result);
            }
        }

        if (event.data?.type === 'OMEGA_EVENT') {
            const { event: evName, data } = event.data;
            (_listeners[evName] || []).forEach(fn => fn(data));
        }
    });

    // ── EIP-1193 Provider ─────────────────────────────────────
    const provider = {
        _isOmega: true,
        isMetaMask: true, // dApp compatibility
        isConnected: () => _connected,

        request: async ({ method, params }) => {
            // For connection requests, wait up to 3s for WS to establish
            if (method === 'eth_requestAccounts' && !_connected) {
                for (let i = 0; i < 15; i++) {
                    await new Promise(r => setTimeout(r, 200));
                    if (_connected) break;
                }
            }

            // Return immediate error if wallet is still offline
            if (!_connected) {
                return Promise.reject(new Error(
                    'OmegaWallet is not running. Please open OmegaWallet and unlock it.'
                ));
            }

            return new Promise((resolve, reject) => {
                const id = ++_reqId;
                _pending.set(id, {
                    resolve: (result) => {
                        // Auto-populate provider properties on successful connect
                        if (method === 'eth_requestAccounts' && Array.isArray(result) && result[0]) {
                            provider.selectedAddress = result[0];
                        }
                        if (method === 'eth_chainId' && result) {
                            provider.chainId = result;
                            provider.networkVersion = String(parseInt(result, 16));
                        }
                        resolve(result);
                    },
                    reject
                });
                window.postMessage({
                    type: 'OMEGA_REQUEST',
                    id, method, params: params || []
                }, '*');

                // 60s timeout
                setTimeout(() => {
                    if (_pending.has(id)) {
                        _pending.delete(id);
                        reject(new Error('OmegaWallet: request timed out'));
                    }
                }, 60000);
            });
        },

        on: (event, fn) => {
            if (!_listeners[event]) _listeners[event] = [];
            _listeners[event].push(fn);
        },

        removeListener: (event, fn) => {
            if (_listeners[event]) {
                _listeners[event] = _listeners[event].filter(f => f !== fn);
            }
        },

        // Legacy compatibility
        enable: () => provider.request({ method: 'eth_requestAccounts' }),
        send: (method, params) => provider.request({ method, params }),
        sendAsync: (payload, cb) => {
            provider.request({ method: payload.method, params: payload.params })
                .then(r => cb(null, { id: payload.id, jsonrpc: '2.0', result: r }))
                .catch(e => cb(e));
        },

        selectedAddress: null,
        chainId: null,
        networkVersion: null,
    };

    // Update cached values on events
    provider.on('accountsChanged', (accounts) => {
        provider.selectedAddress = accounts[0] || null;
    });
    provider.on('chainChanged', (chainId) => {
        provider.chainId = chainId;
        provider.networkVersion = String(parseInt(chainId, 16));
    });

    // ── Install ───────────────────────────────────────────────
    window.ethereum = provider;

    // Announce via EIP-6963 (modern dApp discovery)
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({
            info: {
                uuid: 'omega-wallet-bridge-v1',
                name: 'OmegaWallet',
                icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="80" font-size="80">Ω</text></svg>',
                rdns: 'com.omega.wallet'
            },
            provider
        })
    }));

    // Listen for EIP-6963 requests
    window.addEventListener('eip6963:requestProvider', () => {
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
            detail: Object.freeze({
                info: {
                    uuid: 'omega-wallet-bridge-v1',
                    name: 'OmegaWallet',
                    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="80" font-size="80">Ω</text></svg>',
                    rdns: 'com.omega.wallet'
                },
                provider
            })
        }));
    });

    console.log('[OmegaWallet] Phantom Bridge provider injected');
})();
