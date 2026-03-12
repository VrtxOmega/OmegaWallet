import { useState, useEffect } from 'react';
import './App.css';

// ═════════════════════════════════════════════════════════════
// Ω OMEGA WALLET v4.0 — Modular IPC Cleanroom Edition
// Zero TCP ports. Zero localStorage. All state via window.omega.
// AES-256-GCM encrypted ledger. Cerberus pre-flight via IPC.
// ═════════════════════════════════════════════════════════════

import { WalletProvider, useWallet } from './context/WalletContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Toaster } from './components/Toaster';
import { Onboarding } from './components/Onboarding';
import { UnlockScreen } from './components/UnlockScreen';
import { Sidebar } from './components/Sidebar';
import { Dashboard } from './components/Dashboard';
import { Send } from './components/Send';
import { Batch } from './components/Batch';
import { History } from './components/History';
import { NFTs } from './components/NFTs';
import { Modules } from './components/Modules';
import { Security } from './components/Security';
import { WalletConnect } from './components/WalletConnect';
import { DAppBrowser } from './components/DAppBrowser';
import { Approvals } from './components/Approvals';
import { AddressBook } from './components/AddressBook';
import { Receive } from './components/Receive';
import { BuyCrypto } from './components/BuyCrypto';
import { Swap } from './components/Swap';
import { Settings } from './components/Settings';
import { RpcStatus, SecurityOverlay } from './components/RpcStatus';
import { short } from './lib/networks';

function AppShell() {
    const {
        wallets, activeIdx, setActiveIdx,
        net, setNet, state,
        refreshWallets, lock, reset, onCreated, onUnlocked,
    } = useWallet();

    const [view, _setView] = useState('dashboard');
    const [bridgeReq, setBridgeReq] = useState(null);
    const [wcProposal, setWcProposal] = useState(null);
    const [wcRequest, setWcRequest] = useState(null);

    // Wrap setView to hide/show BrowserView on tab switch
    const setView = (newView) => {
        // If leaving dApp Browser, hide the BrowserView
        if (view === 'dapp-browser' && newView !== 'dapp-browser') {
            window.omega?.dapp?.hide?.();
        }
        // If entering dApp Browser, show the BrowserView
        if (newView === 'dapp-browser' && view !== 'dapp-browser') {
            window.omega?.dapp?.show?.();
        }
        _setView(newView);
    };

    // Listen for Phantom Bridge approval requests
    useEffect(() => {
        if (!window.omega?.onBridgeRequest) return;
        window.omega.onBridgeRequest((data) => setBridgeReq(data));
    }, []);

    // Listen for WalletConnect proposals and requests (GLOBAL — works on any page)
    useEffect(() => {
        if (!window.omega?.wc) return;
        window.omega.wc.onProposal((data) => setWcProposal(data));
        window.omega.wc.onRequest((data) => setWcRequest(data));
    }, []);

    const [wcError, setWcError] = useState(null);
    useEffect(() => {
        if (!window.omega?.wc?.onError) return;
        window.omega.wc.onError((data) => setWcError(data));
    }, []);

    // Listen for WalletConnect chain changes (dApp requested network switch)
    useEffect(() => {
        if (!window.omega?.wc?.onChainChanged) return;
        window.omega.wc.onChainChanged((data) => {
            if (data?.network) setNet(data.network);
        });
    }, []);

    const respondBridge = (approved) => {
        if (window.omega?.bridgeRespond) window.omega.bridgeRespond(approved);
        setBridgeReq(null);
    };

    const approveWcProposal = async () => {
        if (!wcProposal || !wallets[activeIdx]) return;
        await window.omega.wc.approve(wcProposal.id, wallets[activeIdx].address);
        setWcProposal(null);
    };

    const rejectWcProposal = async () => {
        if (!wcProposal) return;
        await window.omega.wc.reject(wcProposal.id);
        setWcProposal(null);
    };

    const respondWcRequest = async (approved) => {
        if (!wcRequest) return;
        await window.omega.wc.respondRequest(wcRequest.requestId, approved);
        setWcRequest(null);
    };

    // ── Gate: Loading / Onboarding / Unlock ──
    if (state === 'loading') return (
        <div className="onboarding-container"><div className="onboarding-card">
            <div className="omega-icon" style={{ width: 64, height: 64, fontSize: '2rem', margin: '0 auto 24px' }}>Ω</div>
            <p style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>Initializing IPC cleanroom...</p>
        </div></div>
    );
    if (state === 'onboard') return <Onboarding onReady={onCreated} />;
    if (state === 'unlock') return <UnlockScreen onUnlock={onUnlocked} onReset={reset} />;

    // ── View Router ──
    const ViewComponent = () => {
        switch (view) {
            case 'dashboard': return (
                <ErrorBoundary fallbackLabel="Dashboard">
                    <Dashboard wallets={wallets} activeIdx={activeIdx} net={net} />
                </ErrorBoundary>
            );
            case 'send': return (
                <ErrorBoundary fallbackLabel="Send">
                    <Send wallets={wallets} net={net} />
                </ErrorBoundary>
            );
            case 'receive': return (
                <ErrorBoundary fallbackLabel="Receive">
                    <Receive wallets={wallets} activeIdx={activeIdx} net={net} />
                </ErrorBoundary>
            );
            case 'buy': return (
                <ErrorBoundary fallbackLabel="Buy Crypto">
                    <BuyCrypto wallets={wallets} activeIdx={activeIdx} net={net} />
                </ErrorBoundary>
            );
            case 'swap': return (
                <ErrorBoundary fallbackLabel="Swap">
                    <Swap wallets={wallets} activeIdx={activeIdx} net={net} />
                </ErrorBoundary>
            );
            case 'batch': return (
                <ErrorBoundary fallbackLabel="Batch Transfer">
                    <Batch wallets={wallets} net={net} />
                </ErrorBoundary>
            );
            case 'history': return (
                <ErrorBoundary fallbackLabel="History">
                    <History wallets={wallets} activeIdx={activeIdx} net={net} />
                </ErrorBoundary>
            );
            case 'nfts': return (
                <ErrorBoundary fallbackLabel="NFTs">
                    <NFTs wallets={wallets} activeIdx={activeIdx} net={net} />
                </ErrorBoundary>
            );
            case 'modules': return (
                <ErrorBoundary fallbackLabel="Modules">
                    <Modules />
                </ErrorBoundary>
            );
            case 'security': return (
                <ErrorBoundary fallbackLabel="Security">
                    <Security net={net} />
                </ErrorBoundary>
            );
            case 'approvals': return (
                <ErrorBoundary fallbackLabel="Approvals">
                    <Approvals wallets={wallets} activeIdx={activeIdx} net={net} />
                </ErrorBoundary>
            );
            case 'addressbook': return (
                <ErrorBoundary fallbackLabel="Address Book">
                    <AddressBook net={net} />
                </ErrorBoundary>
            );
            case 'connect': return (
                <ErrorBoundary fallbackLabel="WalletConnect">
                    <WalletConnect wallets={wallets} activeIdx={activeIdx} />
                </ErrorBoundary>
            );
            case 'dapp-browser': return (
                <ErrorBoundary fallbackLabel="dApp Browser">
                    <DAppBrowser wallets={wallets} activeIdx={activeIdx} net={net} />
                </ErrorBoundary>
            );
            case 'settings': return (
                <ErrorBoundary fallbackLabel="Settings">
                    <Settings wallets={wallets} activeIdx={activeIdx} setActiveIdx={setActiveIdx}
                        onLock={lock} onReset={reset} net={net} setNet={setNet} refreshWallets={refreshWallets} />
                </ErrorBoundary>
            );
            default: return (
                <ErrorBoundary fallbackLabel="Dashboard">
                    <Dashboard wallets={wallets} activeIdx={activeIdx} net={net} />
                </ErrorBoundary>
            );
        }
    };

    return (
        <>
            <Toaster />
            <div className="app-layout">
                <Sidebar view={view} setView={setView} wallets={wallets} activeIdx={activeIdx} net={net} />
                <main className="main-content">
                    <RpcStatus net={net} />
                    {wcError && (
                        <div style={{
                            margin: '0 16px 12px', padding: '10px 14px', borderRadius: 'var(--radius-sm)',
                            background: 'rgba(255,23,68,0.08)', border: '1px solid rgba(255,23,68,0.3)',
                            fontSize: '0.78rem', color: '#ff6b6b', display: 'flex', alignItems: 'flex-start', gap: 10
                        }}>
                            <div style={{ flex: 1 }}>
                                <div style={{ fontWeight: 700, marginBottom: 4 }}>⚠ WalletConnect Error</div>
                                <div><strong>Method:</strong> {wcError.method} | <strong>Chain:</strong> {wcError.chainId}</div>
                                <div style={{ fontFamily: 'var(--font-mono)', marginTop: 4, wordBreak: 'break-all' }}>{wcError.error}</div>
                            </div>
                            <button onClick={() => setWcError(null)} style={{
                                background: 'none', border: 'none', color: '#ff6b6b', cursor: 'pointer', fontSize: '1rem'
                            }}>✕</button>
                        </div>
                    )}
                    <ViewComponent />
                </main>
                <SecurityOverlay />
                {bridgeReq && (
                    <div style={{
                        position: 'fixed', inset: 0, zIndex: 10000,
                        background: 'rgba(0,0,0,0.85)', display: 'flex',
                        alignItems: 'center', justifyContent: 'center'
                    }}>
                        <div className="glass-card" style={{
                            maxWidth: 440, width: '90%', border: '1px solid var(--border-gold)',
                            boxShadow: '0 0 40px rgba(212,168,67,0.15)'
                        }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                                <div className="omega-icon" style={{ width: 40, height: 40, fontSize: '1.2rem' }}>Ω</div>
                                <div>
                                    <div style={{ fontWeight: 700, color: 'var(--text-gold)' }}>Phantom Bridge Request</div>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>A dApp is requesting access</div>
                                </div>
                            </div>
                            <div style={{
                                background: 'rgba(212,160,23,0.05)', border: '1px solid var(--border-gold)',
                                borderRadius: 'var(--radius-sm)', padding: 12, marginBottom: 16, fontSize: '0.8rem'
                            }}>
                                <div style={{ marginBottom: 8 }}>
                                    <span style={{ color: 'var(--text-muted)' }}>Method: </span>
                                    <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-warning)' }}>
                                        {bridgeReq.method}</span>
                                </div>
                                <div style={{ marginBottom: 8 }}>
                                    <span style={{ color: 'var(--text-muted)' }}>Origin: </span>
                                    <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
                                        {bridgeReq.origin || 'Unknown'}</span>
                                </div>
                                {bridgeReq.params && bridgeReq.params.length > 0 && (
                                    <div>
                                        <span style={{ color: 'var(--text-muted)' }}>Payload: </span>
                                        <pre style={{
                                            fontFamily: 'var(--font-mono)', fontSize: '0.7rem',
                                            color: 'var(--text-secondary)', whiteSpace: 'pre-wrap',
                                            wordBreak: 'break-all', marginTop: 4, maxHeight: 120, overflow: 'auto'
                                        }}>{JSON.stringify(bridgeReq.params, null, 2)}</pre>
                                    </div>
                                )}
                            </div>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button className="btn btn-outline" style={{ flex: 1, color: 'var(--accent-danger)' }}
                                    onClick={() => respondBridge(false)}>✕ Reject</button>
                                <button className="btn btn-primary" style={{ flex: 2 }}
                                    onClick={() => respondBridge(true)}>✓ Approve</button>
                            </div>
                        </div>
                    </div>
                )}

                {/* ── WalletConnect Session Proposal (GLOBAL) ─────── */}
                {wcProposal && (
                    <div style={{
                        position: 'fixed', inset: 0, zIndex: 10000,
                        background: 'rgba(0,0,0,0.85)', display: 'flex',
                        alignItems: 'center', justifyContent: 'center'
                    }}>
                        <div className="glass-card" style={{
                            maxWidth: 440, width: '90%', border: '1px solid var(--border-gold)',
                            boxShadow: '0 0 40px rgba(212,168,67,0.15)'
                        }}>
                            <h3 style={{ marginBottom: 16, color: 'var(--gold-300)' }}>🔗 WalletConnect — Connection Request</h3>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                                {wcProposal.proposer?.icons?.[0] && (
                                    <img src={wcProposal.proposer.icons[0]} alt=""
                                        style={{ width: 40, height: 40, borderRadius: 8 }} />
                                )}
                                <div>
                                    <div style={{ fontWeight: 700 }}>{wcProposal.proposer?.name || 'Unknown dApp'}</div>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                        {wcProposal.proposer?.url || ''}</div>
                                </div>
                            </div>
                            <div style={{
                                background: 'rgba(0,0,0,0.3)', borderRadius: 'var(--radius-sm)',
                                padding: '10px 12px', marginBottom: 16, fontSize: '0.78rem'
                            }}>
                                <div style={{ color: 'var(--text-secondary)', marginBottom: 6 }}>Connecting as:</div>
                                <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', wordBreak: 'break-all' }}>
                                    {wallets[activeIdx]?.label} — {wallets[activeIdx]?.address}
                                </div>
                            </div>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button className="btn btn-outline" style={{ flex: 1, color: 'var(--accent-danger)' }}
                                    onClick={rejectWcProposal}>✕ Reject</button>
                                <button className="btn btn-primary" style={{ flex: 2 }}
                                    onClick={approveWcProposal}>✓ Approve</button>
                            </div>
                        </div>
                    </div>
                )}

                {/* ── WalletConnect Transaction/Sign Request (GLOBAL) ── */}
                {wcRequest && (
                    <div style={{
                        position: 'fixed', inset: 0, zIndex: 10000,
                        background: 'rgba(0,0,0,0.85)', display: 'flex',
                        alignItems: 'center', justifyContent: 'center'
                    }}>
                        <div className="glass-card" style={{
                            maxWidth: 440, width: '90%', border: '1px solid rgba(255,193,7,0.3)',
                            boxShadow: '0 0 40px rgba(255,193,7,0.1)'
                        }}>
                            <h3 style={{ marginBottom: 16, color: 'var(--gold-300)' }}>
                                {wcRequest.method === 'eth_sendTransaction' ? '💸 Send Transaction' :
                                    wcRequest.method === 'personal_sign' ? '✍ Sign Message' :
                                        '📝 Sign Request'}
                            </h3>
                            <div style={{ fontSize: '0.8rem', marginBottom: 12 }}>
                                <strong>{wcRequest.peerName}</strong>
                                <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>{wcRequest.peerUrl}</span>
                            </div>
                            <div style={{
                                background: 'rgba(0,0,0,0.3)', borderRadius: 'var(--radius-sm)',
                                padding: '10px 12px', marginBottom: 16, fontSize: '0.72rem',
                                fontFamily: 'var(--font-mono)', maxHeight: 160, overflow: 'auto',
                                wordBreak: 'break-all', color: 'var(--text-secondary)'
                            }}>
                                {JSON.stringify(wcRequest.params, null, 2)}
                            </div>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button className="btn btn-outline" style={{ flex: 1, color: 'var(--accent-danger)' }}
                                    onClick={() => respondWcRequest(false)}>✕ Reject</button>
                                <button className="btn btn-primary" style={{ flex: 2 }}
                                    onClick={() => respondWcRequest(true)}>✓ Approve</button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </>
    );
}

function App() {
    return (
        <ErrorBoundary fallbackLabel="Application">
            <WalletProvider>
                <AppShell />
            </WalletProvider>
        </ErrorBoundary>
    );
}

export default App;
