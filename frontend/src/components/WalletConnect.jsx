import { useState, useEffect } from 'react';

export function WalletConnect({ wallets, activeIdx }) {
    const [uri, setUri] = useState('');
    const [sessions, setSessions] = useState([]);
    const [proposal, setProposal] = useState(null);
    const [request, setRequest] = useState(null);
    const [status, setStatus] = useState('');
    const [loading, setLoading] = useState(false);

    const active = wallets[activeIdx];

    // Load sessions on mount
    const refreshSessions = async () => {
        if (!window.omega?.wc) return;
        const r = await window.omega.wc.sessions();
        if (r.ok) setSessions(r.sessions);
    };

    useEffect(() => {
        refreshSessions();

        // Listen for session proposals from dApps
        if (window.omega?.wc?.onProposal) {
            window.omega.wc.onProposal((data) => {
                setProposal(data);
            });
        }

        // Listen for transaction/sign requests from dApps
        if (window.omega?.wc?.onRequest) {
            window.omega.wc.onRequest((data) => {
                setRequest(data);
            });
        }

        // Listen for session deletions
        if (window.omega?.wc?.onSessionDeleted) {
            window.omega.wc.onSessionDeleted(() => {
                refreshSessions();
            });
        }
    }, []);

    // ── Pair with WC URI ─────────────────────────────────────
    const doPair = async () => {
        if (!uri.trim()) return;
        setLoading(true);
        setStatus('');
        const r = await window.omega.wc.pair(uri.trim());
        if (r.ok) {
            setStatus('✓ Pairing initiated — waiting for session proposal...');
            setUri('');
        } else {
            setStatus(`✗ ${r.error}`);
        }
        setLoading(false);
    };

    // ── Approve session proposal ─────────────────────────────
    const approveProposal = async () => {
        if (!proposal || !active) return;
        setLoading(true);
        const r = await window.omega.wc.approve(proposal.id, active.address);
        if (r.ok) {
            setStatus('✓ Connected!');
            refreshSessions();
        } else {
            setStatus(`✗ ${r.error}`);
        }
        setProposal(null);
        setLoading(false);
    };

    const rejectProposal = async () => {
        if (!proposal) return;
        await window.omega.wc.reject(proposal.id);
        setProposal(null);
        setStatus('Session rejected');
    };

    // ── Respond to transaction/sign request ───────────────────
    const respondRequest = async (approved) => {
        if (!request) return;
        await window.omega.wc.respondRequest(request.requestId, approved);
        setRequest(null);
        setStatus(approved ? '✓ Request approved' : 'Request rejected');
    };

    // ── Disconnect a session ─────────────────────────────────
    const disconnect = async (topic) => {
        await window.omega.wc.disconnect(topic);
        setSessions(prev => prev.filter(s => s.topic !== topic));
        setStatus('Session disconnected');
    };

    // Format method name for display
    const methodLabel = (m) => {
        const labels = {
            'eth_sendTransaction': '💸 Send Transaction',
            'personal_sign': '✍ Sign Message',
            'eth_signTypedData_v4': '📝 Sign Typed Data',
            'eth_signTypedData': '📝 Sign Typed Data',
        };
        return labels[m] || m;
    };

    return (
        <div className="fade-in">
            <div className="page-header"><h2>WalletConnect</h2>
                <p>Connect to any dApp via WalletConnect v2</p></div>

            {/* ── URI Paste ────────────────────────────────── */}
            <div className="glass-card" style={{ maxWidth: 600 }}>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 6, display: 'block' }}>
                    Paste WalletConnect URI</label>
                <div style={{ display: 'flex', gap: 8 }}>
                    <input className="input" placeholder="wc:a1b2c3...@2?relay-protocol=irn&symKey=..."
                        value={uri} onChange={e => setUri(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && doPair()}
                        style={{ flex: 1 }} />
                    <button className="btn btn-primary" onClick={doPair} disabled={loading || !uri.trim()}>
                        {loading ? '⏳' : '🔗 Connect'}
                    </button>
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 8 }}>
                    On the dApp, click "WalletConnect" → copy the link (usually an icon next to the QR code)
                </div>
                {status && (
                    <div style={{
                        marginTop: 12, padding: '8px 12px', borderRadius: 'var(--radius-sm)',
                        fontSize: '0.8rem',
                        background: status.startsWith('✓') ? 'rgba(0,230,118,0.06)' : status.startsWith('✗') ? 'rgba(255,23,68,0.06)' : 'rgba(255,255,255,0.03)',
                        color: status.startsWith('✓') ? 'var(--accent-success)' : status.startsWith('✗') ? 'var(--accent-danger)' : 'var(--text-secondary)',
                        border: `1px solid ${status.startsWith('✓') ? 'rgba(0,230,118,0.2)' : status.startsWith('✗') ? 'rgba(255,23,68,0.2)' : 'rgba(255,255,255,0.05)'}`
                    }}>{status}</div>
                )}
            </div>

            {/* ── Session Proposal Modal ───────────────────── */}
            {proposal && (
                <div style={{
                    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                    background: 'rgba(0,0,0,0.7)', display: 'flex',
                    alignItems: 'center', justifyContent: 'center', zIndex: 9999
                }}>
                    <div className="glass-card" style={{
                        maxWidth: 440, width: '90%', borderColor: 'rgba(212,160,23,0.3)'
                    }}>
                        <h3 style={{ marginBottom: 16, color: 'var(--gold-300)' }}>🔗 Connection Request</h3>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                            {proposal.proposer?.icons?.[0] && (
                                <img src={proposal.proposer.icons[0]} alt=""
                                    style={{ width: 40, height: 40, borderRadius: 8 }} />
                            )}
                            <div>
                                <div style={{ fontWeight: 700 }}>{proposal.proposer?.name || 'Unknown dApp'}</div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                    {proposal.proposer?.url || ''}
                                </div>
                            </div>
                        </div>
                        <div style={{
                            background: 'rgba(0,0,0,0.3)', borderRadius: 'var(--radius-sm)',
                            padding: '10px 12px', marginBottom: 16, fontSize: '0.78rem'
                        }}>
                            <div style={{ color: 'var(--text-secondary)', marginBottom: 6 }}>Connecting as:</div>
                            <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', wordBreak: 'break-all' }}>
                                {active?.label} — {active?.address}
                            </div>
                        </div>
                        {proposal.proposer?.description && (
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: 16 }}>
                                {proposal.proposer.description}
                            </div>
                        )}
                        <div style={{ display: 'flex', gap: 8 }}>
                            <button className="btn btn-outline" style={{ flex: 1 }} onClick={rejectProposal}>
                                Reject</button>
                            <button className="btn btn-primary" style={{ flex: 2 }} onClick={approveProposal}
                                disabled={loading}>
                                {loading ? '⏳' : 'Approve Connection'}</button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Transaction/Sign Request Modal ──────────── */}
            {request && (
                <div style={{
                    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                    background: 'rgba(0,0,0,0.7)', display: 'flex',
                    alignItems: 'center', justifyContent: 'center', zIndex: 9999
                }}>
                    <div className="glass-card" style={{
                        maxWidth: 440, width: '90%', borderColor: 'rgba(255,193,7,0.3)'
                    }}>
                        <h3 style={{ marginBottom: 16, color: 'var(--gold-300)' }}>
                            {methodLabel(request.method)}</h3>
                        <div style={{ fontSize: '0.8rem', marginBottom: 8 }}>
                            <strong>{request.peerName}</strong>
                            <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>{request.peerUrl}</span>
                        </div>
                        <div style={{
                            background: 'rgba(0,0,0,0.3)', borderRadius: 'var(--radius-sm)',
                            padding: '10px 12px', marginBottom: 16, fontSize: '0.72rem',
                            fontFamily: 'var(--font-mono)', maxHeight: 160, overflow: 'auto',
                            wordBreak: 'break-all', color: 'var(--text-secondary)'
                        }}>
                            {JSON.stringify(request.params, null, 2)}
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                            <button className="btn btn-outline" style={{ flex: 1 }}
                                onClick={() => respondRequest(false)}>Reject</button>
                            <button className="btn btn-primary" style={{ flex: 2 }}
                                onClick={() => respondRequest(true)}>Approve</button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Active Sessions ──────────────────────────── */}
            <div className="page-header" style={{ marginTop: 24 }}>
                <h2>Active Sessions ({sessions.length})</h2>
            </div>
            {sessions.length === 0 ? (
                <div className="glass-card" style={{ textAlign: 'center', padding: 40, maxWidth: 500 }}>
                    <div style={{ fontSize: '2rem', marginBottom: 12 }}>🔌</div>
                    <div style={{ color: 'var(--text-secondary)' }}>No active WalletConnect sessions</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 8 }}>
                        Paste a WC URI above to connect to a dApp
                    </div>
                </div>
            ) : (
                <div style={{ display: 'grid', gap: 12, maxWidth: 600 }}>
                    {sessions.map(s => (
                        <div key={s.topic} className="glass-card" style={{
                            display: 'flex', alignItems: 'center', gap: 12
                        }}>
                            {s.peer?.icons?.[0] && (
                                <img src={s.peer.icons[0]} alt=""
                                    style={{ width: 36, height: 36, borderRadius: 8 }} />
                            )}
                            <div style={{ flex: 1 }}>
                                <div style={{ fontWeight: 700, fontSize: '0.85rem' }}>
                                    {s.peer?.name || 'Unknown'}
                                </div>
                                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                                    {s.peer?.url || ''}
                                </div>
                                <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 2 }}>
                                    Expires: {new Date(s.expiry * 1000).toLocaleDateString()}
                                </div>
                            </div>
                            <button className="btn btn-danger btn-sm" onClick={() => disconnect(s.topic)}>
                                Disconnect
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
