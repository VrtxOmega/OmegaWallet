import { useState, useEffect, useRef } from 'react';
import { N } from '../lib/networks';

const POPULAR_DAPPS = [
    { name: 'Uniswap', url: 'https://app.uniswap.org', icon: '🦄', desc: 'Swap tokens' },
    { name: 'Aave', url: 'https://app.aave.com', icon: '👻', desc: 'Lend & borrow' },
    { name: 'OpenSea', url: 'https://opensea.io', icon: '🌊', desc: 'NFT marketplace' },
    { name: '1inch', url: 'https://app.1inch.io', icon: '🐴', desc: 'DEX aggregator' },
    { name: 'Lido', url: 'https://stake.lido.fi', icon: '🏔', desc: 'Liquid staking' },
    { name: 'Curve', url: 'https://curve.fi', icon: '📈', desc: 'Stable swaps' },
    { name: 'Compound', url: 'https://app.compound.finance', icon: '🏦', desc: 'Lending protocol' },
    { name: 'Aerodrome', url: 'https://aerodrome.finance', icon: '✈', desc: 'Base DEX' },
    { name: 'GMX', url: 'https://app.gmx.io', icon: '📊', desc: 'Perpetuals' },
    { name: 'Morpho', url: 'https://app.morpho.org', icon: '🦋', desc: 'Lending optimizer' },
    { name: 'Balancer', url: 'https://app.balancer.fi', icon: '⚖', desc: 'Liquidity pools' },
    { name: 'Zapper', url: 'https://zapper.xyz', icon: '⚡', desc: 'DeFi dashboard' },
];

const METHOD_LABELS = {
    'eth_requestAccounts': '🔗 Connect Wallet',
    'eth_sendTransaction': '💸 Send Transaction',
    'personal_sign': '✍ Sign Message',
    'eth_signTypedData_v4': '📝 Sign Typed Data',
    'eth_signTypedData': '📝 Sign Typed Data',
    'wallet_switchEthereumChain': '🔄 Switch Chain',
    'wallet_addEthereumChain': '🔄 Add Chain',
};

export function DAppBrowser({ wallets, activeIdx, net }) {
    const [url, setUrl] = useState('');
    const [currentUrl, setCurrentUrl] = useState('');
    const [pageTitle, setPageTitle] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isActive, setIsActive] = useState(false);
    const [approval, setApproval] = useState(null);
    const [phishingWarning, setPhishingWarning] = useState(null);
    const [history, setHistory] = useState([]);
    const [bookmarks, setBookmarks] = useState([]);
    const [permissions, setPermissions] = useState([]);
    const [activity, setActivity] = useState([]);
    const [tab, setTab] = useState('home'); // home | permissions | activity
    const inputRef = useRef(null);
    const active = wallets[activeIdx];

    // Load data and subscribe to events
    useEffect(() => {
        if (!window.omega?.dapp) return;

        window.omega.dapp.onUrlChanged((d) => {
            setCurrentUrl(d.url);
            setUrl(d.url);
            setHistory(prev => {
                const last = prev[prev.length - 1];
                if (last !== d.url) return [...prev.slice(-19), d.url];
                return prev;
            });
        });
        window.omega.dapp.onTitleChanged((d) => setPageTitle(d.title));
        window.omega.dapp.onLoading((d) => setIsLoading(d.loading));
        window.omega.dapp.onApprovalRequest((d) => setApproval(d));
        window.omega.dapp.onPhishingWarning((d) => setPhishingWarning(d));

        window.omega.dapp.getStatus().then(s => {
            if (s.active) {
                setIsActive(true);
                setCurrentUrl(s.url);
                setUrl(s.url);
            }
        });

        refreshData();
    }, []);

    const refreshData = async () => {
        if (!window.omega?.dapp) return;
        const [bm, pm, act] = await Promise.all([
            window.omega.dapp.bookmarksList(),
            window.omega.dapp.permissionsList(),
            window.omega.dapp.activityList(),
        ]);
        if (bm.ok) setBookmarks(bm.bookmarks);
        if (pm.ok) setPermissions(pm.permissions);
        if (act.ok) setActivity(act.activity);
    };

    const navigate = async (targetUrl) => {
        if (!targetUrl?.trim()) return;
        const r = await window.omega.dapp.navigate(targetUrl.trim());
        if (r.ok) {
            setIsActive(true);
            setCurrentUrl(targetUrl.trim());
        }
    };

    const goBack = () => window.omega.dapp.back();
    const goForward = () => window.omega.dapp.forward();
    const doReload = () => window.omega.dapp.reload();
    const doClose = async () => {
        await window.omega.dapp.close();
        setIsActive(false);
        setCurrentUrl('');
        setPageTitle('');
        setUrl('');
        refreshData();
    };

    const respondApproval = async (approved) => {
        if (!approval) return;
        await window.omega.dapp.approvalRespond(approval.approvalId, approved);
        setApproval(null);
        refreshData(); // Refresh permissions after approval
    };

    const toggleBookmark = async (dappUrl, name) => {
        const isBookmarked = bookmarks.some(b =>
            b.url.replace(/\/+$/, '').toLowerCase() === dappUrl.replace(/\/+$/, '').toLowerCase());
        if (isBookmarked) {
            await window.omega.dapp.bookmarksRemove(dappUrl);
        } else {
            await window.omega.dapp.bookmarksAdd({ url: dappUrl, name });
        }
        refreshData();
    };

    const revokePermission = async (origin) => {
        await window.omega.dapp.permissionsRevoke(origin);
        refreshData();
    };

    const revokeAllPermissions = async () => {
        await window.omega.dapp.permissionsRevokeAll();
        refreshData();
    };

    const isBookmarked = (dappUrl) =>
        bookmarks.some(b =>
            b.url.replace(/\/+$/, '').toLowerCase() === dappUrl?.replace(/\/+$/, '').toLowerCase());

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') navigate(url);
    };

    const domain = (() => {
        try { return new URL(currentUrl).hostname; }
        catch { return ''; }
    })();

    const formatTime = (ts) => {
        try { return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
        catch { return ts; }
    };

    return (
        <div className="fade-in" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
            {/* ── URL Bar ──────────────────────────────────────── */}
            <div style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px',
                background: 'rgba(0,0,0,0.3)', borderBottom: '1px solid var(--border-dim)',
                flexShrink: 0,
            }}>
                {isActive && (
                    <>
                        <button className="btn-icon" onClick={goBack} title="Back" id="dapp-back-btn">←</button>
                        <button className="btn-icon" onClick={goForward} title="Forward" id="dapp-fwd-btn">→</button>
                        <button className="btn-icon" onClick={doReload} title="Reload" id="dapp-reload-btn">
                            {isLoading ? '⏳' : '⟳'}
                        </button>
                    </>
                )}
                <div style={{
                    flex: 1, display: 'flex', alignItems: 'center', gap: 8,
                    background: 'rgba(255,255,255,0.04)', borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-dim)', padding: '6px 12px',
                }}>
                    {isActive && currentUrl.startsWith('https://') && (
                        <span style={{ color: 'var(--accent-success)', fontSize: '0.75rem' }}>🔒</span>
                    )}
                    <input
                        ref={inputRef}
                        placeholder="Enter dApp URL (e.g., app.uniswap.org)"
                        value={url}
                        onChange={e => setUrl(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onFocus={e => e.target.select()}
                        style={{
                            flex: 1, background: 'transparent', border: 'none', outline: 'none',
                            color: 'var(--text-primary)', fontSize: '0.82rem',
                            fontFamily: 'var(--font-mono)',
                        }}
                        id="dapp-url-input"
                    />
                    {isActive && (
                        <button style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            fontSize: '1rem', color: isBookmarked(currentUrl) ? 'var(--gold-400)' : 'var(--text-muted)',
                        }}
                            onClick={() => toggleBookmark(currentUrl, pageTitle || domain)}
                            title={isBookmarked(currentUrl) ? 'Remove bookmark' : 'Add bookmark'}
                            id="dapp-bookmark-btn">
                            {isBookmarked(currentUrl) ? '★' : '☆'}
                        </button>
                    )}
                </div>
                <button className="btn btn-primary btn-sm" onClick={() => navigate(url)}
                    disabled={!url.trim()} id="dapp-go-btn">Go</button>
                {isActive && (
                    <button className="btn btn-outline btn-sm" onClick={doClose}
                        style={{ color: 'var(--accent-danger)', borderColor: 'rgba(255,23,68,0.3)' }}
                        id="dapp-close-btn">✕ Close</button>
                )}
            </div>

            {/* ── Active Session Info ──────────────────────────── */}
            {isActive && (
                <div style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '4px 16px',
                    background: 'rgba(212,160,23,0.04)',
                    borderBottom: '1px solid rgba(212,160,23,0.1)',
                    fontSize: '0.72rem', flexShrink: 0,
                }}>
                    <span style={{ color: 'var(--accent-success)' }}>● Connected</span>
                    <span style={{ color: 'var(--text-muted)' }}>|</span>
                    <span style={{ color: 'var(--text-secondary)' }}>
                        {active?.label} — {active?.address?.slice(0, 6)}…{active?.address?.slice(-4)}
                    </span>
                    <span style={{ color: 'var(--text-muted)' }}>|</span>
                    <span style={{ color: 'var(--text-gold)' }}>{N(net).name}</span>
                    {pageTitle && (
                        <>
                            <span style={{ color: 'var(--text-muted)' }}>|</span>
                            <span style={{ color: 'var(--text-secondary)', overflow: 'hidden',
                                textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
                                {pageTitle}
                            </span>
                        </>
                    )}
                </div>
            )}

            {/* ── Content ─────────────────────────────────────── */}
            {!isActive ? (
                <div style={{ flex: 1, overflow: 'auto', padding: '24px 16px' }}>
                    <div className="page-header">
                        <h2>🌐 dApp Browser</h2>
                        <p>Navigate to any decentralized application — your wallet is natively connected</p>
                    </div>

                    {/* Tab bar */}
                    <div style={{ display: 'flex', gap: 4, marginBottom: 20 }}>
                        {[
                            { id: 'home', label: '🏠 Home' },
                            { id: 'permissions', label: `🔐 Permissions (${permissions.length})` },
                            { id: 'activity', label: `📋 Activity (${activity.length})` },
                        ].map(t => (
                            <button key={t.id}
                                className={`btn ${tab === t.id ? 'btn-primary' : 'btn-outline'} btn-sm`}
                                onClick={() => setTab(t.id)} id={`dapp-tab-${t.id}`}>
                                {t.label}
                            </button>
                        ))}
                    </div>

                    {tab === 'home' && (
                        <>
                            {/* Quick connect info */}
                            <div className="glass-card" style={{
                                maxWidth: 600, marginBottom: 24, display: 'flex', alignItems: 'center', gap: 16,
                                borderColor: 'rgba(0,230,118,0.15)', background: 'rgba(0,230,118,0.03)'
                            }}>
                                <div style={{ fontSize: '2rem' }}>Ω</div>
                                <div>
                                    <div style={{ fontWeight: 700, fontSize: '0.9rem', marginBottom: 4 }}>
                                        Native Wallet Injection + Phishing Shield
                                    </div>
                                    <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                                        Every dApp sees OmegaWallet instantly. Known scam domains are blocked automatically.
                                        Approved dApps are remembered. All activity is logged and encrypted.
                                    </div>
                                </div>
                            </div>

                            {/* Bookmarks */}
                            {bookmarks.length > 0 && (
                                <div style={{ marginBottom: 20 }}>
                                    <div style={{ marginBottom: 8, fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                                        ★ Bookmarks
                                    </div>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxWidth: 750 }}>
                                        {bookmarks.map(b => (
                                            <div key={b.url} style={{
                                                display: 'flex', alignItems: 'center', gap: 8,
                                                background: 'rgba(255,193,7,0.04)', border: '1px solid var(--border-gold)',
                                                borderRadius: 'var(--radius-sm)', padding: '6px 12px', cursor: 'pointer',
                                            }}>
                                                <span onClick={() => { setUrl(b.url); navigate(b.url); }}
                                                    style={{ fontSize: '0.8rem', color: 'var(--text-gold)', fontWeight: 600 }}>
                                                    {b.name}
                                                </span>
                                                <button onClick={() => toggleBookmark(b.url, b.name)}
                                                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)',
                                                        cursor: 'pointer', fontSize: '0.7rem' }}>✕</button>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Popular dApps */}
                            <div style={{ marginBottom: 12, fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                                Popular dApps
                            </div>
                            <div style={{
                                display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
                                gap: 10, maxWidth: 750,
                            }}>
                                {POPULAR_DAPPS.map(d => (
                                    <button key={d.url} className="glass-card dapp-card"
                                        onClick={() => { setUrl(d.url); navigate(d.url); }}
                                        style={{ cursor: 'pointer', textAlign: 'left', padding: '14px 16px',
                                            transition: 'all 0.2s', border: '1px solid var(--border-dim)', position: 'relative',
                                        }}
                                        id={`dapp-shortcut-${d.name.toLowerCase()}`}>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); toggleBookmark(d.url, d.name); }}
                                            style={{
                                                position: 'absolute', top: 6, right: 8, background: 'none',
                                                border: 'none', cursor: 'pointer', fontSize: '0.8rem',
                                                color: isBookmarked(d.url) ? 'var(--gold-400)' : 'var(--text-muted)',
                                            }}>
                                            {isBookmarked(d.url) ? '★' : '☆'}
                                        </button>
                                        <div style={{ fontSize: '1.4rem', marginBottom: 6 }}>{d.icon}</div>
                                        <div style={{ fontWeight: 700, fontSize: '0.82rem', marginBottom: 2 }}>{d.name}</div>
                                        <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{d.desc}</div>
                                    </button>
                                ))}
                            </div>

                            {/* Recent */}
                            {history.length > 0 && (
                                <div style={{ marginTop: 24 }}>
                                    <div style={{ marginBottom: 8, fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                                        Recent
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 600 }}>
                                        {[...new Set(history)].reverse().slice(0, 5).map(u => (
                                            <button key={u} className="recent-url"
                                                onClick={() => { setUrl(u); navigate(u); }}
                                                style={{
                                                    textAlign: 'left', padding: '8px 12px', fontSize: '0.75rem',
                                                    fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)',
                                                    background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-dim)',
                                                    borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                                                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                                }}>{u}</button>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </>
                    )}

                    {tab === 'permissions' && (
                        <div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                                    Approved dApps
                                </div>
                                {permissions.length > 0 && (
                                    <button className="btn btn-outline btn-sm"
                                        style={{ color: 'var(--accent-danger)', borderColor: 'rgba(255,23,68,0.3)' }}
                                        onClick={revokeAllPermissions}
                                        id="dapp-revoke-all">Revoke All</button>
                                )}
                            </div>
                            {permissions.length === 0 ? (
                                <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem', padding: '40px 0', textAlign: 'center' }}>
                                    No dApps have been approved yet
                                </div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 600 }}>
                                    {permissions.map(p => (
                                        <div key={p.origin} className="glass-card" style={{
                                            padding: '12px 16px', display: 'flex', alignItems: 'center',
                                            justifyContent: 'space-between',
                                        }}>
                                            <div>
                                                <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{p.origin}</div>
                                                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                                                    Wallet: {p.walletAddress?.slice(0, 6)}…{p.walletAddress?.slice(-4)} · Last used: {formatTime(p.lastUsed)}
                                                </div>
                                            </div>
                                            <button className="btn btn-outline btn-sm"
                                                style={{ color: 'var(--accent-danger)', borderColor: 'rgba(255,23,68,0.3)' }}
                                                onClick={() => revokePermission(p.origin)}
                                                id={`revoke-${p.origin}`}>Revoke</button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {tab === 'activity' && (
                        <div>
                            <div style={{ marginBottom: 16, fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                                dApp Activity Log ({activity.length} entries)
                            </div>
                            {activity.length === 0 ? (
                                <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem', padding: '40px 0', textAlign: 'center' }}>
                                    No dApp activity recorded yet
                                </div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 700 }}>
                                    {[...activity].reverse().slice(0, 50).map((a, i) => (
                                        <div key={i} style={{
                                            display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                                            background: 'rgba(255,255,255,0.02)',
                                            border: '1px solid var(--border-dim)',
                                            borderRadius: 'var(--radius-sm)', fontSize: '0.78rem',
                                        }}>
                                            <div style={{ fontSize: '1rem', width: 24, textAlign: 'center' }}>
                                                {METHOD_LABELS[a.method]?.slice(0, 2) || '🔹'}
                                            </div>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div style={{ fontWeight: 600 }}>
                                                    {METHOD_LABELS[a.method]?.slice(2) || a.method}
                                                </div>
                                                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)',
                                                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                    {a.origin}
                                                </div>
                                            </div>
                                            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textAlign: 'right', flexShrink: 0 }}>
                                                {formatTime(a.timestamp)}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            ) : (
                <div style={{
                    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: 'var(--text-muted)', fontSize: '0.8rem',
                }}>
                    {isLoading && <span>Loading {domain}...</span>}
                </div>
            )}

            {/* ── Phishing Warning Modal ─────────────────────── */}
            {phishingWarning && (
                <div style={{
                    position: 'fixed', inset: 0, zIndex: 10001,
                    background: 'rgba(139,0,0,0.9)', display: 'flex',
                    alignItems: 'center', justifyContent: 'center',
                }}>
                    <div className="glass-card" style={{
                        maxWidth: 460, width: '90%', border: '2px solid var(--accent-danger)',
                        boxShadow: '0 0 60px rgba(255,23,68,0.3)',
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                            <div style={{ fontSize: '2.5rem' }}>⚠️</div>
                            <div>
                                <div style={{ fontWeight: 900, fontSize: '1.1rem', color: 'var(--accent-danger)' }}>
                                    PHISHING DETECTED
                                </div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                    This site has been blocked to protect your wallet
                                </div>
                            </div>
                        </div>
                        <div style={{
                            background: 'rgba(255,23,68,0.08)', border: '1px solid rgba(255,23,68,0.3)',
                            borderRadius: 'var(--radius-sm)', padding: 12, marginBottom: 16,
                        }}>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>Blocked URL:</div>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: '#ff6b6b', wordBreak: 'break-all' }}>
                                {phishingWarning.url}
                            </div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 8 }}>Reason:</div>
                            <div style={{ fontSize: '0.78rem', color: '#ff6b6b' }}>
                                {phishingWarning.reason}
                            </div>
                        </div>
                        <button className="btn btn-primary" style={{ width: '100%' }}
                            onClick={() => setPhishingWarning(null)}
                            id="dapp-phishing-dismiss">
                            ✓ Go Back to Safety
                        </button>
                    </div>
                </div>
            )}

            {/* ── Approval Modal ──────────────────────────────── */}
            {approval && (
                <div style={{
                    position: 'fixed', inset: 0, zIndex: 10000,
                    background: 'rgba(0,0,0,0.85)', display: 'flex',
                    alignItems: 'center', justifyContent: 'center',
                }}>
                    <div className="glass-card" style={{
                        maxWidth: 460, width: '90%', border: '1px solid var(--border-gold)',
                        boxShadow: '0 0 40px rgba(212,168,67,0.15)',
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                            <div className="omega-icon" style={{ width: 40, height: 40, fontSize: '1.2rem' }}>Ω</div>
                            <div>
                                <div style={{ fontWeight: 700, color: 'var(--text-gold)' }}>
                                    {METHOD_LABELS[approval.method] || approval.method}
                                </div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                    {approval.origin}
                                </div>
                            </div>
                        </div>
                        <div style={{
                            background: 'rgba(0,0,0,0.3)', borderRadius: 'var(--radius-sm)',
                            padding: '10px 12px', marginBottom: 12, fontSize: '0.78rem',
                        }}>
                            <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>Signing as:</div>
                            <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', wordBreak: 'break-all' }}>
                                {active?.label} — {active?.address}
                            </div>
                        </div>
                        {approval.method === 'eth_requestAccounts' && (
                            <div style={{
                                background: 'rgba(0,230,118,0.05)', border: '1px solid rgba(0,230,118,0.2)',
                                borderRadius: 'var(--radius-sm)', padding: '8px 12px', marginBottom: 12,
                                fontSize: '0.72rem', color: 'var(--accent-success)',
                            }}>
                                ✓ Approving will remember this dApp — no repeat prompts
                            </div>
                        )}
                        {approval.params && approval.params.length > 0 && (
                            <div style={{
                                background: 'rgba(212,160,23,0.05)', border: '1px solid var(--border-gold)',
                                borderRadius: 'var(--radius-sm)', padding: 12, marginBottom: 16,
                            }}>
                                <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', marginBottom: 6 }}>Payload</div>
                                <pre style={{
                                    fontFamily: 'var(--font-mono)', fontSize: '0.68rem',
                                    color: 'var(--text-secondary)', whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-all', maxHeight: 150, overflow: 'auto', margin: 0,
                                }}>{JSON.stringify(approval.params, null, 2)}</pre>
                            </div>
                        )}
                        <div style={{ display: 'flex', gap: 8 }}>
                            <button className="btn btn-outline" style={{ flex: 1, color: 'var(--accent-danger)' }}
                                onClick={() => respondApproval(false)} id="dapp-approval-reject">✕ Reject</button>
                            <button className="btn btn-primary" style={{ flex: 2 }}
                                onClick={() => respondApproval(true)} id="dapp-approval-approve">✓ Approve</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
