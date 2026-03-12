/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  INJECT.JS — Content Script (runs in page context)           ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Injects provider.js into the page's main world so it can set
 * window.ethereum. Content scripts run in an isolated world and
 * cannot modify window.ethereum directly.
 *
 * HARDENED: All chrome.runtime calls wrapped in try/catch to
 * survive extension reloads (Extension context invalidated).
 */
const script = document.createElement('script');
script.src = chrome.runtime.getURL('provider.js');
script.onload = () => script.remove();
(document.head || document.documentElement).appendChild(script);

// ── Bridge: page ↔ background service worker ──────────────────
// provider.js posts messages to window → we relay to background
window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === 'OMEGA_PING') {
        // Provider is polling connection state — ask background
        try {
            chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATE' }, (res) => {
                window.postMessage({
                    type: 'OMEGA_CONNECTION_STATE',
                    connected: !chrome.runtime.lastError && res?.connected === true
                }, '*');
            });
        } catch (_) {
            // Extension context invalidated (reloaded) — report disconnected
            window.postMessage({
                type: 'OMEGA_CONNECTION_STATE',
                connected: false
            }, '*');
        }
        return;
    }
    if (event.data?.type !== 'OMEGA_REQUEST') return;

    try {
        chrome.runtime.sendMessage({
            type: 'OMEGA_REQUEST',
            id: event.data.id,
            method: event.data.method,
            params: event.data.params
        }, (response) => {
            // Handle cases where background can't respond
            if (chrome.runtime.lastError || !response) {
                window.postMessage({
                    type: 'OMEGA_RESPONSE',
                    id: event.data.id,
                    result: undefined,
                    error: chrome.runtime.lastError?.message || 'OmegaWallet is not available'
                }, '*');
                return;
            }
            window.postMessage({
                type: 'OMEGA_RESPONSE',
                id: event.data.id,
                result: response.result,
                error: response.error?.message || response.error
            }, '*');
        });
    } catch (_) {
        // Extension context invalidated — return error to dApp
        window.postMessage({
            type: 'OMEGA_RESPONSE',
            id: event.data.id,
            result: undefined,
            error: 'OmegaWallet extension was reloaded. Please refresh this page.'
        }, '*');
    }
});

// Listen for events pushed from background (chainChanged, accountsChanged)
try {
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'OMEGA_EVENT') {
            window.postMessage({
                type: 'OMEGA_EVENT',
                event: msg.event,
                data: msg.data
            }, '*');
        }
    });
} catch (_) {
    // Extension context invalidated — silently ignore
}
