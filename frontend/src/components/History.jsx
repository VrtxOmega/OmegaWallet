import { useState, useEffect } from 'react';
import { N, NETS, short } from '../lib/networks';

export function History({ wallets, activeIdx, net }) {
    const [history, setHistory] = useState([]);
    const [btcHistory, setBtcHistory] = useState([]);
    const [solHistory, setSolHistory] = useState([]);
    const [loading, setLoading] = useState(true);
    const [tab, setTab] = useState('ledger');
    const nn = N(net);
    const active = wallets?.[activeIdx];

    // ── Build explorer TX URL ──────────────────────────────
    const txUrl = (hash, network) => {
        const n = NETS[network] || nn;
        if (!n.explorer) return null;
        if (n.family === 'btc') return `${n.explorer}/tx/${hash}`;
        if (n.family === 'sol') return `${n.explorer}/tx/${hash}`;
        return `${n.explorer}/tx/${hash}`;
    };

    const openTx = (url) => {
        if (url && window.omega?.openExternal) window.omega.openExternal(url);
    };

    useEffect(() => {
        setLoading(true);
        setHistory([]);
        setBtcHistory([]);
        setSolHistory([]);

        // Local encrypted ledger (EVM)
        if (window.omega?.getSpendHistory) {
            window.omega.getSpendHistory().then(r => {
                if (r.ok) setHistory(r.history || []);
                setLoading(false);
            });
        }

        // BTC history
        if (window.omega?.btc && active) {
            window.omega.btc.deriveAddress(activeIdx).then(res => {
                if (res.ok) {
                    window.omega.btc.getHistory(res.address).then(r => {
                        if (r.ok) setBtcHistory(r.history || []);
                    });
                }
            }).catch(() => { });
        }

        // SOL history
        if (window.omega?.sol && active) {
            window.omega.sol.deriveAddress(activeIdx).then(res => {
                if (res.ok) {
                    window.omega.sol.getHistory(res.address).then(r => {
                        if (r.ok) setSolHistory(r.history || []);
                    });
                }
            }).catch(() => { });
        }
    }, [net, activeIdx]);

    const tabs = [
        { id: 'ledger', label: `Ledger (${history.length})`, icon: '📒' },
        { id: 'btc', label: `BTC (${btcHistory.length})`, icon: '₿' },
        { id: 'sol', label: `SOL (${solHistory.length})`, icon: '◎' },
    ];

    return (
        <div className="fade-in">
            <div className="page-header"><h2>Transaction History</h2>
                <p>{active?.label} · Multi-Chain Ledger</p></div>

            {/* Tab bar */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
                {tabs.map(t => (
                    <button key={t.id}
                        className={`btn btn-sm ${tab === t.id ? 'btn-primary' : 'btn-outline'}`}
                        onClick={() => setTab(t.id)}
                        style={{ fontSize: '0.8rem' }}>
                        {t.icon} {t.label}
                    </button>
                ))}
            </div>

            {/* Ledger tab */}
            {tab === 'ledger' && (
                <div className="glass-card" style={{ padding: 0, overflow: 'hidden', maxWidth: 800 }}>
                    {loading ? (
                        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>⏳ Loading secure ledger...</div>
                    ) : history.length === 0 ? (
                        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>No transactions in local ledger.</div>
                    ) : (
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                            <thead>
                                <tr style={{ background: 'rgba(255,255,255,0.02)', color: 'var(--text-secondary)', textAlign: 'left' }}>
                                    <th style={{ padding: '12px 16px', fontWeight: 600 }}>Date/Time</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 600 }}>Network</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 600 }}>Amount</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 600 }}>TX Hash</th>
                                </tr>
                            </thead>
                            <tbody>
                                {history.map((tx, i) => {
                                    const txNet = tx.network || 'ethereum';
                                    const txNN = NETS[txNet] || { sym: 'ETH', name: txNet };
                                    const url = txUrl(tx.txHash, txNet);
                                    return (
                                        <tr key={i} style={{ borderTop: i > 0 ? '1px solid rgba(212,160,23,0.1)' : 'none' }}>
                                            <td style={{ padding: '12px 16px', color: 'var(--text-primary)' }}>{new Date(tx.timestamp).toLocaleString()}</td>
                                            <td style={{ padding: '12px 16px', color: 'var(--text-gold)' }}>{txNN.name}</td>
                                            <td style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)' }}>{tx.amount} {txNN.sym}</td>
                                            <td style={{ padding: '12px 16px' }}>
                                                <div style={{ display: 'flex', gap: 4 }}>
                                                    {url && (
                                                        <button className="explorer-link" onClick={() => openTx(url)} title="View on explorer">
                                                            {short(tx.txHash)} ↗
                                                        </button>
                                                    )}
                                                    <button className="btn btn-outline btn-sm" style={{ padding: '4px 8px', fontSize: '0.7rem' }}
                                                        onClick={() => navigator.clipboard.writeText(tx.txHash)}>
                                                        📋
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </div>
            )}

            {/* BTC tab */}
            {tab === 'btc' && (
                <div className="glass-card" style={{ padding: 0, overflow: 'hidden', maxWidth: 800 }}>
                    {btcHistory.length === 0 ? (
                        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>No Bitcoin transactions found.</div>
                    ) : (
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                            <thead>
                                <tr style={{ background: 'rgba(247,147,26,0.05)', color: 'var(--text-secondary)', textAlign: 'left' }}>
                                    <th style={{ padding: '12px 16px', fontWeight: 600 }}>Date/Time</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 600 }}>Status</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 600 }}>Fee (sats)</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 600 }}>TX ID</th>
                                </tr>
                            </thead>
                            <tbody>
                                {btcHistory.map((tx, i) => {
                                    const url = `https://blockstream.info/tx/${tx.txid}`;
                                    return (
                                        <tr key={i} style={{ borderTop: i > 0 ? '1px solid rgba(247,147,26,0.1)' : 'none' }}>
                                            <td style={{ padding: '12px 16px', color: 'var(--text-primary)' }}>{new Date(tx.timestamp).toLocaleString()}</td>
                                            <td style={{ padding: '12px 16px' }}>
                                                <span style={{
                                                    fontSize: '0.7rem', padding: '2px 8px', borderRadius: 12,
                                                    background: tx.confirmed ? 'rgba(0,230,118,0.1)' : 'rgba(255,193,7,0.1)',
                                                    color: tx.confirmed ? 'var(--accent-success)' : '#ffc107',
                                                }}>
                                                    {tx.confirmed ? '✓ Confirmed' : '⏳ Pending'}
                                                </span>
                                            </td>
                                            <td style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>{tx.fee}</td>
                                            <td style={{ padding: '12px 16px' }}>
                                                <div style={{ display: 'flex', gap: 4 }}>
                                                    <button className="explorer-link" onClick={() => openTx(url)} title="View on Blockstream">
                                                        {tx.txid.slice(0, 8)}...{tx.txid.slice(-6)} ↗
                                                    </button>
                                                    <button className="btn btn-outline btn-sm" style={{ padding: '4px 8px', fontSize: '0.7rem' }}
                                                        onClick={() => navigator.clipboard.writeText(tx.txid)}>
                                                        📋
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </div>
            )}

            {/* SOL tab */}
            {tab === 'sol' && (
                <div className="glass-card" style={{ padding: 0, overflow: 'hidden', maxWidth: 800 }}>
                    {solHistory.length === 0 ? (
                        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>No Solana transactions found.</div>
                    ) : (
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                            <thead>
                                <tr style={{ background: 'rgba(153,69,255,0.05)', color: 'var(--text-secondary)', textAlign: 'left' }}>
                                    <th style={{ padding: '12px 16px', fontWeight: 600 }}>Date/Time</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 600 }}>Status</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 600 }}>Slot</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 600 }}>Signature</th>
                                </tr>
                            </thead>
                            <tbody>
                                {solHistory.map((tx, i) => {
                                    const url = `https://solscan.io/tx/${tx.txid}`;
                                    return (
                                        <tr key={i} style={{ borderTop: i > 0 ? '1px solid rgba(153,69,255,0.1)' : 'none' }}>
                                            <td style={{ padding: '12px 16px', color: 'var(--text-primary)' }}>{new Date(tx.timestamp).toLocaleString()}</td>
                                            <td style={{ padding: '12px 16px' }}>
                                                <span style={{
                                                    fontSize: '0.7rem', padding: '2px 8px', borderRadius: 12,
                                                    background: tx.err ? 'rgba(255,23,68,0.1)' : 'rgba(0,230,118,0.1)',
                                                    color: tx.err ? 'var(--accent-danger)' : 'var(--accent-success)',
                                                }}>
                                                    {tx.err ? '✕ Failed' : '✓ Confirmed'}
                                                </span>
                                            </td>
                                            <td style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>{tx.slot}</td>
                                            <td style={{ padding: '12px 16px' }}>
                                                <div style={{ display: 'flex', gap: 4 }}>
                                                    <button className="explorer-link" onClick={() => openTx(url)} title="View on SolScan">
                                                        {tx.txid.slice(0, 8)}...{tx.txid.slice(-6)} ↗
                                                    </button>
                                                    <button className="btn btn-outline btn-sm" style={{ padding: '4px 8px', fontSize: '0.7rem' }}
                                                        onClick={() => navigator.clipboard.writeText(tx.txid)}>
                                                        📋
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </div>
            )}
        </div>
    );
}
