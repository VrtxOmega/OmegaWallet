// Popup status check
const dot = document.getElementById('dot');
const status = document.getElementById('status');

chrome.runtime.sendMessage({ type: 'GET_WS_STATUS' }, (res) => {
    if (res?.connected) {
        dot.className = 'dot on';
        status.textContent = 'Connected to OmegaWallet';
    } else {
        dot.className = 'dot off';
        status.textContent = 'OmegaWallet not detected';
    }
});

// Live updates
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'WS_STATUS') {
        dot.className = msg.connected ? 'dot on' : 'dot off';
        status.textContent = msg.connected
            ? 'Connected to OmegaWallet'
            : 'OmegaWallet not detected';
    }
});
