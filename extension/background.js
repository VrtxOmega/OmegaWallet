/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  BACKGROUND.JS — Service Worker (Hardened WebSocket Relay)    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Maintains a WebSocket connection to OmegaWallet Electron app.
 * Relays EIP-1193 JSON-RPC calls from content scripts.
 *
 * HARDENED:
 *   - Silent reconnect (no Chrome error badges)
 *   - Request queue when offline (flushes on reconnect)
 *   - Exponential backoff (max 30s)
 *   - 3s initial connection delay
 */

const WS_URL = 'ws://127.0.0.1:9377';
let ws = null;
let wsReady = false;
let reconnectTimer = null;
let reconnectDelay = 2000;
const pending = new Map();
const offlineQueue = []; // Queued requests when WS is offline
const MAX_QUEUE = 20;    // Prevent memory leak

// ── WebSocket Management ──────────────────────────────────────
function connect() {
    if (ws) {
        try {
            if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) return;
        } catch (_) { }
        ws = null;
    }

    try {
        ws = new WebSocket(WS_URL);
    } catch (_) {
        ws = null;
        scheduleReconnect();
        return;
    }

    ws.onopen = () => {
        // DON'T set wsReady yet — must complete nonce handshake first
        reconnectDelay = 2000;
        console.log('[OmegaBridge] WebSocket connected, awaiting nonce challenge...');
    };

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);

            // ── Step 1: Server sends nonce_challenge ──────────────
            if (msg.type === 'nonce_challenge' && msg.nonce) {
                console.log('[OmegaBridge] Nonce challenge received, responding...');
                ws.send(JSON.stringify({ type: 'nonce_response', nonce: msg.nonce }));
                return;
            }

            // ── Step 2: Server confirms authentication ───────────
            if (msg.type === 'authenticated' && msg.ok) {
                wsReady = true;
                console.log('[OmegaBridge] Authenticated! Bridge is live.');
                chrome.runtime.sendMessage({ type: 'WS_STATUS', connected: true }).catch(() => { });
                flushQueue();
                return;
            }

            // ── Normal response to a pending RPC request ─────────
            if (msg.id && pending.has(msg.id)) {
                const { resolve } = pending.get(msg.id);
                pending.delete(msg.id);
                resolve(msg);
                return;
            }

            // ── Pushed events (chainChanged, accountsChanged) ────
            if (msg.type === 'event') {
                chrome.tabs.query({}, (tabs) => {
                    for (const tab of tabs) {
                        chrome.tabs.sendMessage(tab.id, {
                            type: 'OMEGA_EVENT',
                            event: msg.event,
                            data: msg.data
                        }).catch(() => { });
                    }
                });
            }
        } catch (_) { }
    };

    ws.onclose = () => {
        wsReady = false;
        ws = null;
        chrome.runtime.sendMessage({ type: 'WS_STATUS', connected: false }).catch(() => { });
        scheduleReconnect();
    };

    ws.onerror = () => {
        wsReady = false;
    };
}

function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
        connect();
    }, reconnectDelay);
}

function flushQueue() {
    while (offlineQueue.length > 0 && wsReady) {
        const queued = offlineQueue.shift();
        sendToWallet(queued.method, queued.params, queued.id)
            .then(queued.resolve)
            .catch(queued.reject);
    }
}

function sendToWallet(method, params, id) {
    return new Promise((resolve, reject) => {
        if (!wsReady || !ws) {
            // Return proper EIP-1193 error immediately instead of silent queue
            // Code 4100 = Unauthorized (wallet unavailable)
            reject({
                code: 4100,
                message: 'OmegaWallet is not running. Please open OmegaWallet and unlock it.'
            });
            return;
        }

        try {
            pending.set(id, { resolve });
            ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
        } catch (_) {
            pending.delete(id);
            reject({
                code: -32603,
                message: 'Failed to send request to OmegaWallet'
            });
            return;
        }

        // 120s timeout (longer — approval may take time)
        setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id);
                reject({
                    code: -32603,
                    message: 'OmegaWallet request timed out'
                });
            }
        }, 120000);
    });
}

// ── Message Handler (from content scripts) ────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'OMEGA_REQUEST') {
        sendToWallet(msg.method, msg.params, msg.id)
            .then(response => {
                sendResponse({ result: response.result, error: response.error });
            })
            .catch(err => {
                sendResponse({ error: err.message });
            });
        return true;
    }

    if (msg.type === 'GET_WS_STATUS') {
        sendResponse({ connected: wsReady, queueLength: offlineQueue.length });
        return;
    }

    if (msg.type === 'GET_CONNECTION_STATE') {
        sendResponse({ connected: wsReady });
        return;
    }
});

// ── Init ──────────────────────────────────────────────────────
setTimeout(connect, 3000);

chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'keepAlive') {
        if (!wsReady) connect();
    }
});
