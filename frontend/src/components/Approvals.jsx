import { useState, useEffect } from 'react';
import { N, short } from '../lib/networks';

export function Approvals({ wallets, activeIdx, net }) {
    const [approvals, setApprovals] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [revoking, setRevoking] = useState(null);
    const [scannedAt, setScannedAt] = useState(null);
    const nn = N(net);
    const active = wallets[activeIdx];
    const family = nn.family || 'evm';

    const scan = async () => {
        if (!active || family !== 'evm') return;
        setLoading(true);
        setError(null);
        const res = await window.omega.approval.scan(active.address, net);
        if (res.ok) {
            setApprovals(res.approvals);
            setScannedAt(res.scannedAt);
        } else {
            setError(res.error);
        }
        setLoading(false);
    };

    useEffect(() => { scan(); }, [activeIdx, net]);

    const handleRevoke = async (a) => {
        const key = `${a.tokenAddress}:${a.spender}`;
        setRevoking(key);
        const res = await window.omega.approval.revoke(a.tokenAddress, a.spender, net);
        if (res.ok) {
            setApprovals(prev => prev.filter(x =>
                !(x.tokenAddress === a.tokenAddress && x.spender === a.spender)
            ));
        } else {
            setError(res.error);
        }
        setRevoking(null);
    };

    const unlimited = approvals.filter(a => a.isUnlimited);
    const limited = approvals.filter(a => !a.isUnlimited);

    return (
        <div className="fade-in">
            <div className="page-header">
                <h2>Token Approvals</h2>
                <p>{active?.label} · {nn.name} · {approvals.length} active approval{approvals.length !== 1 ? 's' : ''}</p>
            </div>

            {family !== 'evm' && (
                <div className="glass-card" style={{ textAlign: 'center', padding: 40 }}>
                    <div style={{ fontSize: '2rem', opacity: 0.3 }}>🛡️</div>
                    <div style={{ color: 'var(--text-secondary)', marginTop: 8 }}>
                        Token approvals are only available on EVM chains.
                    </div>
                </div>
            )}

            {family === 'evm' && (
                <>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                        <button className="btn btn-outline btn-sm" onClick={scan} disabled={loading}
                            style={{ fontSize: '0.8rem' }}>
                            {loading ? '⏳ Scanning...' : '🔍 Scan Approvals'}
                        </button>
                        {scannedAt && (
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', alignSelf: 'center' }}>
                                Last scan: {new Date(scannedAt).toLocaleTimeString()}
                            </span>
                        )}
                    </div>

                    {error && (
                        <div className="glass-card" style={{ borderColor: 'rgba(255,23,68,0.2)' }}>
                            <span style={{ color: '#ff1744' }}>⚠ {error}</span>
                        </div>
                    )}

                    {loading && (
                        <div className="glass-card" style={{ textAlign: 'center', padding: 40 }}>
                            <div style={{ color: 'var(--text-secondary)' }}>
                                Checking allowances across {nn.name} spenders...
                            </div>
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 8 }}>
                                Scanning Uniswap, 1inch, SushiSwap, Permit2, OpenSea...
                            </div>
                        </div>
                    )}

                    {!loading && approvals.length === 0 && !error && (
                        <div className="glass-card" style={{ textAlign: 'center', padding: 40 }}>
                            <div style={{ fontSize: '3rem', opacity: 0.3 }}>✅</div>
                            <div style={{ color: 'var(--text-secondary)', fontSize: '1rem', fontWeight: 600, marginTop: 8 }}>
                                No active approvals
                            </div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 8 }}>
                                Your tokens have no outstanding allowances on known DEX routers.
                            </div>
                        </div>
                    )}

                    {/* Unlimited Approvals - DANGER */}
                    {unlimited.length > 0 && (
                        <div className="glass-card" style={{ border: '1px solid rgba(255,23,68,0.3)', marginBottom: 16 }}>
                            <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#ff1744', marginBottom: 12 }}>
                                ⚠ Unlimited Approvals ({unlimited.length})
                            </div>
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 12 }}>
                                These contracts can spend unlimited tokens on your behalf. Revoke any you don't actively use.
                            </div>
                            {unlimited.map(a => (
                                <ApprovalRow key={`${a.tokenAddress}:${a.spender}`} a={a}
                                    revoking={revoking} onRevoke={handleRevoke} />
                            ))}
                        </div>
                    )}

                    {/* Limited Approvals */}
                    {limited.length > 0 && (
                        <div className="glass-card">
                            <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-gold)', marginBottom: 12 }}>
                                Limited Approvals ({limited.length})
                            </div>
                            {limited.map(a => (
                                <ApprovalRow key={`${a.tokenAddress}:${a.spender}`} a={a}
                                    revoking={revoking} onRevoke={handleRevoke} />
                            ))}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

function ApprovalRow({ a, revoking, onRevoke }) {
    const key = `${a.tokenAddress}:${a.spender}`;
    return (
        <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 0', borderBottom: '1px solid rgba(212,160,23,0.1)',
            gap: 12, flexWrap: 'wrap',
        }}>
            <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                    {a.token}
                    <span style={{
                        fontSize: '0.65rem', marginLeft: 8, padding: '2px 6px', borderRadius: 4,
                        background: a.isUnlimited ? 'rgba(255,23,68,0.15)' : 'rgba(0,230,118,0.1)',
                        color: a.isUnlimited ? '#ff1744' : '#00e676',
                    }}>
                        {a.isUnlimited ? '∞ UNLIMITED' : `${parseFloat(a.formatted).toFixed(2)}`}
                    </span>
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-gold)', marginTop: 2 }}>
                    → {a.spenderLabel}
                </div>
                <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                    {a.spender}
                </div>
            </div>
            <button className="btn btn-outline btn-sm"
                style={{
                    fontSize: '0.75rem',
                    borderColor: 'rgba(255,23,68,0.3)', color: '#ff1744',
                }}
                disabled={revoking === key}
                onClick={() => onRevoke(a)}>
                {revoking === key ? '⏳ Revoking...' : '🗑 Revoke'}
            </button>
        </div>
    );
}
