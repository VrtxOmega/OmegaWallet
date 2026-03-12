import { useState, useEffect, useRef } from 'react';
import { N, NETS, short } from '../lib/networks';
import QRCode from 'qrcode';

// ── Real QR Code Component (scannable from phones/exchanges) ─
function QRCodeCanvas({ data, size = 200 }) {
    const canvasRef = useRef(null);

    useEffect(() => {
        if (!data || !canvasRef.current) return;
        QRCode.toCanvas(canvasRef.current, data, {
            width: size,
            margin: 2,
            color: { dark: '#1a1a2e', light: '#ffffff' },
            errorCorrectionLevel: 'H',
        }).catch(() => {
            // Fallback: draw text if QR fails
            const ctx = canvasRef.current?.getContext('2d');
            if (ctx) {
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, size, size);
                ctx.fillStyle = '#1a1a2e';
                ctx.font = '10px monospace';
                ctx.fillText(data.slice(0, 30), 10, size / 2);
            }
        });
    }, [data, size]);

    return <canvas ref={canvasRef} style={{ borderRadius: 8 }} />;
}

const ASSET_OPTIONS = [
    { id: 'ETH', label: 'Ethereum', icon: '⟠', family: 'evm' },
    { id: 'BTC', label: 'Bitcoin', icon: '₿', family: 'btc' },
    { id: 'SOL', label: 'Solana', icon: '◎', family: 'sol' },
    { id: 'USDC', label: 'USD Coin', icon: '💲', family: 'evm' },
    { id: 'USDT', label: 'Tether', icon: '₮', family: 'evm' },
    { id: 'MATIC', label: 'Polygon', icon: '⬡', family: 'evm' },
    { id: 'BNB', label: 'BNB', icon: '◆', family: 'evm' },
    { id: 'AVAX', label: 'Avalanche', icon: '🔺', family: 'evm' },
    { id: 'NFT', label: 'NFT', icon: '🖼', family: 'evm' },
];

const CHAIN_ICONS = {
    ethereum: '⟠', base: '🔵', arbitrum: '🔷', optimism: '🔴',
    polygon: '⬡', bsc: '◆', avalanche: '🔺', fantom: '👻',
    cronos: '🔶', 'zksync-era': '⚡', linea: '━', scroll: '📜',
    mantle: '🟢', bitcoin: '₿', solana: '◎',
    sepolia: '🧪', 'base-sepolia': '🧪',
};

export function Receive({ wallets, activeIdx, net }) {
    const [asset, setAsset] = useState('ETH');
    const [chain, setChain] = useState(net || 'ethereum');
    const [profile, setProfile] = useState(null);
    const [loading, setLoading] = useState(false);
    const [copied, setCopied] = useState('');
    const [fullscreen, setFullscreen] = useState(false);

    // Fetch receive profile when asset/chain/wallet changes
    useEffect(() => {
        if (!window.omega?.receive) return;
        setLoading(true);
        window.omega.receive.getProfile(activeIdx, asset, chain)
            .then(r => { if (r.ok) setProfile(r); })
            .catch(() => {})
            .finally(() => setLoading(false));
    }, [activeIdx, asset, chain]);

    // Update chain when asset changes
    useEffect(() => {
        const assetDef = ASSET_OPTIONS.find(a => a.id === asset);
        if (assetDef?.family === 'btc') setChain('bitcoin');
        else if (assetDef?.family === 'sol') setChain('solana');
        else if (!['bitcoin', 'solana'].includes(chain)) { /* keep */ }
        else setChain('ethereum');
    }, [asset]);

    const copyAddress = () => {
        if (!profile?.address) return;
        navigator.clipboard.writeText(profile.address);
        setCopied(`Address copied\n${profile.address.slice(0, 6)}…${profile.address.slice(-4)}\n${N(chain).name || chain} / ${asset}`);
        setTimeout(() => setCopied(''), 3000);
    };

    const riskColor = (w) =>
        w.startsWith('⚠') || w.includes('NOT') || w.includes('permanent loss') ? '#ff6b6b' : 'var(--text-muted)';

    // Determine if QR payload is EIP-681 (shows explanation)
    const isEIP681 = profile?.qrPayload?.startsWith('ethereum:');

    return (
        <div className="page-container">
            <h2 style={{ margin: '0 0 20px', fontSize: '1.3rem', color: 'var(--text-primary)' }}>
                📥 Receive
            </h2>

            {/* ── Selectors Row ──────────────────────────────── */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                {/* Asset Selector */}
                <div>
                    <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>
                        Asset
                    </label>
                    <select className="input" value={asset} onChange={e => setAsset(e.target.value)}
                        style={{ width: '100%', cursor: 'pointer', background: 'var(--bg-card)', color: 'var(--text-gold)', border: '1px solid var(--border-gold)' }}>
                        {ASSET_OPTIONS.map(a => (
                            <option key={a.id} value={a.id} style={{ background: '#111' }}>
                                {a.icon} {a.label}
                            </option>
                        ))}
                    </select>
                </div>

                {/* Chain Selector */}
                <div>
                    <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>
                        Network
                    </label>
                    <select className="input" value={chain} onChange={e => setChain(e.target.value)}
                        disabled={['BTC', 'SOL'].includes(asset)}
                        style={{ width: '100%', cursor: 'pointer', background: 'var(--bg-card)', color: 'var(--text-gold)', border: '1px solid var(--border-gold)' }}>
                        {(profile?.availableChains || [net]).map(c => (
                            <option key={c} value={c} style={{ background: '#111' }}>
                                {CHAIN_ICONS[c] || '⬡'} {N(c).name || c}
                            </option>
                        ))}
                    </select>
                </div>
            </div>

            {/* ── Wallet Label ────────────────────────────────── */}
            <div style={{
                fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 12,
                display: 'flex', alignItems: 'center', gap: 6,
            }}>
                🏷️ {profile?.walletLabel || wallets[activeIdx]?.label || 'Wallet'}
                <span style={{ color: 'var(--text-gold)', fontFamily: 'var(--font-mono)' }}>
                    {short(wallets[activeIdx]?.address)}
                </span>
            </div>

            {/* ── Address Card + QR ──────────────────────────── */}
            {loading ? (
                <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                    ⏳ Loading receive profile...
                </div>
            ) : profile ? (
                <div style={{
                    background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-md)', padding: 20, marginBottom: 16,
                }}>
                    {/* Address Type Badge */}
                    <div style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12,
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{
                                fontSize: '0.6rem', fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                                background: 'rgba(0,230,118,0.15)', color: '#00e676',
                            }}>
                                {profile.addressType?.type}
                            </span>
                            <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                                {profile.addressType?.description}
                            </span>
                        </div>
                        <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                            {profile.addressType?.format}
                        </span>
                    </div>

                    {/* QR Code — Real scannable QR */}
                    <div style={{
                        background: '#fff', borderRadius: 12, padding: 16, marginBottom: 12,
                        cursor: 'pointer', display: 'flex', justifyContent: 'center',
                    }} onClick={() => setFullscreen(true)} title="Click for full-screen QR">
                        <QRCodeCanvas data={profile.qrPayload} size={200} />
                    </div>

                    {/* EIP-681 indicator */}
                    {isEIP681 && (
                        <div style={{
                            textAlign: 'center', fontSize: '0.6rem', color: 'var(--text-muted)',
                            marginBottom: 8, fontStyle: 'italic',
                        }}>
                            📲 EIP-681 encoded · Chain + {asset !== 'ETH' && asset !== 'NFT' ? 'token contract' : 'native asset'} embedded in QR
                        </div>
                    )}

                    {/* Full Address */}
                    <div style={{
                        fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--text-gold)',
                        wordBreak: 'break-all', textAlign: 'center', marginBottom: 12,
                        padding: '8px 12px', background: 'rgba(0,0,0,0.2)', borderRadius: 'var(--radius-sm)',
                    }}>
                        {profile.address}
                    </div>

                    {/* Short Preview */}
                    <div style={{
                        textAlign: 'center', fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 16,
                    }}>
                        First 6: <strong>{profile.address?.slice(0, 6)}</strong> · Last 4: <strong>{profile.address?.slice(-4)}</strong>
                    </div>

                    {/* Action Buttons */}
                    <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-primary" style={{ flex: 1 }} onClick={copyAddress}>
                            📋 Copy Address
                        </button>
                        <button className="btn btn-outline" style={{ flex: 1 }} onClick={() => setFullscreen(true)}>
                            🔍 Full Screen QR
                        </button>
                    </div>

                    {/* Copy Feedback */}
                    {copied && (
                        <div style={{
                            marginTop: 8, textAlign: 'center', fontSize: '0.72rem',
                            color: '#00e676', whiteSpace: 'pre-line',
                            background: 'rgba(0,230,118,0.06)', padding: '6px 12px',
                            borderRadius: 'var(--radius-sm)',
                        }}>
                            ✓ {copied}
                        </div>
                    )}
                </div>
            ) : null}

            {/* ── Safety Warnings ─────────────────────────────── */}
            {profile?.warnings?.length > 0 && (
                <div style={{
                    background: 'rgba(255,235,59,0.04)', border: '1px solid rgba(255,235,59,0.15)',
                    borderRadius: 'var(--radius-sm)', padding: '12px 14px', marginBottom: 16,
                }}>
                    <div style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
                        ⚠ Safety Notice
                    </div>
                    {profile.warnings.map((w, i) => (
                        <div key={i} style={{
                            fontSize: '0.68rem', padding: '2px 0',
                            color: riskColor(w),
                        }}>
                            • {w}
                        </div>
                    ))}
                </div>
            )}

            {/* ── Main-Process Trust Badge ──────────────────── */}
            {profile && (
                <div style={{
                    fontSize: '0.6rem', color: 'var(--text-muted)', textAlign: 'center',
                    fontStyle: 'italic',
                }}>
                    🛡 Generated by: {profile.generatedBy} · {new Date(profile.generatedAt).toLocaleTimeString()}
                </div>
            )}

            {/* ── Fullscreen QR Modal ──────────────────────────── */}
            {fullscreen && profile && (
                <div style={{
                    position: 'fixed', inset: 0, zIndex: 9999,
                    background: 'rgba(0,0,0,0.95)',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    cursor: 'pointer',
                }} onClick={() => setFullscreen(false)}>
                    <div style={{ marginBottom: 24, fontSize: '1.2rem', color: '#fff' }}>
                        Receive {asset} on {N(chain).name || chain}
                    </div>
                    <div style={{ background: '#fff', borderRadius: 16, padding: 24 }}>
                        <QRCodeCanvas data={profile.qrPayload} size={320} />
                    </div>
                    {isEIP681 && (
                        <div style={{ marginTop: 10, fontSize: '0.65rem', color: '#00e676' }}>
                            📲 EIP-681 · {profile.qrPayload}
                        </div>
                    )}
                    <div style={{
                        marginTop: 12, fontFamily: 'var(--font-mono)', fontSize: '0.85rem',
                        color: 'var(--text-gold)', wordBreak: 'break-all', maxWidth: 400, textAlign: 'center',
                    }}>
                        {profile.address}
                    </div>
                    <div style={{ marginTop: 12, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        Tap anywhere to close
                    </div>
                </div>
            )}
        </div>
    );
}
