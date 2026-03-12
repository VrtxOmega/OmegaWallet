/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║       OMEGA MAIN — IPC Command Center + Phantom Bridge        ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Zero TCP ports for internal comms (all IPC).
 * Phantom Bridge: ws://127.0.0.1:9377 for Chrome extension relay.
 * Initializes encrypted ledger, registers IPC handlers,
 * starts WS bridge, and creates the BrowserWindow.
 *
 * v2.1: System tray, single-instance lock, window state persistence.
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { ethers } = require('ethers');
const { EncryptedLedger } = require('./encrypted-ledger');
const { registerHandlers } = require('./ipc-handlers');
const { PhantomBridge } = require('./ws-bridge');
const { WCBridge } = require('./wc-bridge');
const { DAppBrowser } = require('./dapp-browser');

let mainWindow;
let tray = null;
let isQuitting = false;
const ledger = new EncryptedLedger();
let bridge = null;
let wcBridge = null;
let dappBrowser = null;

// ── RPC Key Config (file > env > public fallback) ────────────
function loadRpcKey() {
    const keyFile = path.join(app.getPath('userData'), 'rpc-config.json');
    try {
        if (fs.existsSync(keyFile)) {
            const cfg = JSON.parse(fs.readFileSync(keyFile, 'utf-8'));
            if (cfg.drpcKey) return cfg.drpcKey;
        }
    } catch { /* fall through */ }
    return process.env.OMEGA_DRPC_KEY || null;
}

// Public RPC fallbacks (rate-limited, no API key required)
const PUBLIC_RPCS = {
    ethereum: 'https://eth.llamarpc.com',
    base: 'https://mainnet.base.org',
    arbitrum: 'https://arb1.arbitrum.io/rpc',
    optimism: 'https://mainnet.optimism.io',
    sepolia: 'https://rpc.sepolia.org',
    'base-sepolia': 'https://sepolia.base.org',
};

// RPC providers (shared with ws-bridge)
const RPC_KEY = loadRpcKey();
function getRpcUrl(chain) {
    const safeChain = PUBLIC_RPCS[chain] ? chain : 'ethereum';
    if (RPC_KEY) return `https://lb.drpc.org/ogrpc?network=${safeChain}&dkey=${RPC_KEY}`;
    return PUBLIC_RPCS[safeChain] || PUBLIC_RPCS.ethereum;
}
function getProvider(chain) {
    return new ethers.JsonRpcProvider(getRpcUrl(chain));
}

// ── Window State Persistence ─────────────────────────────────
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
    try {
        const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        const { screen } = require('electron');
        const displays = screen.getAllDisplays();
        const onScreen = displays.some(d => {
            const b = d.bounds;
            return state.x >= b.x && state.x < b.x + b.width &&
                state.y >= b.y && state.y < b.y + b.height;
        });
        return onScreen ? state : null;
    } catch { return null; }
}

function saveWindowState() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
        const bounds = mainWindow.getBounds();
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            x: bounds.x, y: bounds.y,
            width: bounds.width, height: bounds.height,
            isMaximized: mainWindow.isMaximized(),
        }), 'utf-8');
    } catch { /* silent */ }
}

// ── Window ───────────────────────────────────────────────────
function createWindow() {
    const saved = loadWindowState();
    const opts = {
        width: saved?.width || 1000,
        height: saved?.height || 720,
        minWidth: 800,
        minHeight: 600,
        title: 'Ω OmegaWallet',
        icon: path.join(__dirname, 'icon.ico'),
        backgroundColor: '#050505',
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js')
        }
    };
    if (saved?.x != null) { opts.x = saved.x; opts.y = saved.y; }

    mainWindow = new BrowserWindow(opts);
    if (saved?.isMaximized) mainWindow.maximize();

    mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'));

    // ── CSP Headers ─────────────────────────────────────────
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': [
                    "default-src 'self'; " +
                    "script-src 'self'; " +
                    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
                    "font-src 'self' https://fonts.gstatic.com; " +
                    "img-src 'self' data: https://ipfs.io https://cloudflare-ipfs.com https://w3s.link https://arweave.net https://*.coingecko.com; " +
                    "connect-src 'self' https://lb.drpc.org https://api.coingecko.com https://blockstream.info https://api.mainnet-beta.solana.com; " +
                    "frame-src 'none';"
                ],
            }
        });
    });

    mainWindow.once('ready-to-show', () => { mainWindow.show(); });

    // Debounced state save
    let stateTimer = null;
    const debouncedSave = () => {
        if (stateTimer) clearTimeout(stateTimer);
        stateTimer = setTimeout(saveWindowState, 500);
    };
    mainWindow.on('resize', debouncedSave);
    mainWindow.on('move', debouncedSave);
    mainWindow.on('maximize', debouncedSave);
    mainWindow.on('unmaximize', debouncedSave);

    // Close → hide to tray (keep Phantom Bridge alive)
    mainWindow.on('close', (e) => {
        if (!isQuitting) { e.preventDefault(); mainWindow.hide(); }
    });

    // Crash recovery
    mainWindow.webContents.on('render-process-gone', (_, d) => {
        console.error('[OmegaWallet] Renderer crashed:', d.reason);
    });
    mainWindow.webContents.on('unresponsive', () => {
        console.warn('[OmegaWallet] Window unresponsive');
    });

    mainWindow.on('closed', () => { mainWindow = null; });
}

// ── System Tray ──────────────────────────────────────────────
function createTray() {
    const iconPath = path.join(__dirname, 'icon.png');
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip('Ω OmegaWallet');

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Show OmegaWallet', click: () => {
                if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
            }
        },
        { type: 'separator' },
        { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    });
}

// ── Single Instance Lock ─────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    console.log('[OmegaWallet] Another instance running. Quitting.');
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });

    app.whenReady().then(() => {
        registerHandlers(ledger);
        createWindow();
        createTray();

        // Start Phantom Bridge WebSocket server
        bridge = new PhantomBridge(ledger, mainWindow, getProvider);
        bridge.start();

        // Start WalletConnect v2 Bridge
        wcBridge = new WCBridge(ledger, mainWindow, getProvider);
        wcBridge.start();

        // Start Built-in dApp Browser
        dappBrowser = new DAppBrowser(ledger, mainWindow, getProvider);
        dappBrowser.start();

        // ── Auto-Lock Timer ──────────────────────────────────
        // Lock vault after inactivity (default 5 min).
        // Resets on any IPC call (user interaction).
        const AUTO_LOCK_DEFAULT_S = 300; // 5 minutes
        let autoLockTimer = null;

        function resetAutoLock() {
            if (autoLockTimer) clearTimeout(autoLockTimer);
            // Only set timer if vault is unlocked
            if (!ledger._initialized) return;

            let timeout = AUTO_LOCK_DEFAULT_S;
            try {
                const s = ledger.getSettings();
                if (s.autoLockMinutes != null) timeout = s.autoLockMinutes * 60;
                if (timeout <= 0) return; // 0 = disabled
            } catch { /* vault locked, no settings */ }

            autoLockTimer = setTimeout(() => {
                if (ledger._initialized) {
                    ledger.lock();
                    console.log('[OmegaWallet] Auto-locked after inactivity');
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('vault:auto-locked');
                    }
                }
            }, timeout * 1000);
        }

        // Reset timer on ANY IPC call (proves user is active)
        const origEmit = ipcMain.emit.bind(ipcMain);
        ipcMain.emit = function (channel, ...args) {
            if (channel.startsWith('vault:') || channel.startsWith('bundler:') ||
                channel.startsWith('token:') || channel.startsWith('settings:') ||
                channel.startsWith('cerberus:') || channel.startsWith('simulator:')) {
                resetAutoLock();
            }
            return origEmit(channel, ...args);
        };

        // Lock on system lock/suspend
        const { powerMonitor } = require('electron');
        powerMonitor.on('lock-screen', () => {
            if (ledger._initialized) {
                ledger.lock();
                console.log('[OmegaWallet] Locked — system screen locked');
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('vault:auto-locked');
                }
            }
        });
        powerMonitor.on('suspend', () => {
            if (ledger._initialized) {
                ledger.lock();
                console.log('[OmegaWallet] Locked — system suspended');
            }
        });

        // Start auto-lock on first unlock
        ipcMain.on('vault-unlocked-signal', () => resetAutoLock());
    });

    app.on('window-all-closed', () => { /* stay in tray */ });

    app.on('before-quit', () => {
        isQuitting = true;
        saveWindowState();
        if (bridge) { try { bridge.stop(); } catch { } }
        ledger.lock(); // Wipe key from memory
    });
}

