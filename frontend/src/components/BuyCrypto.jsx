import { useState, useEffect } from 'react';
import { N, short } from '../lib/networks';

const PROVIDER_ICONS = {
    moonpay: '🌙',
    ramp: '🔼',
    transak: '🔄',
};

const ASSET_ICONS = {
    ETH: '⟠', BTC: '₿', SOL: '◎', USDC: '💲', USDT: '₮',
    MATIC: '⬡', BNB: '◆', AVAX: '🔺',
};

const FIAT_AMOUNTS = ['25', '50', '100', '250', '500', '1000'];

export function BuyCrypto({ wallets, activeIdx, net }) {
    const [providers, setProviders] = useState([]);
    const [selectedProvider, setSelectedProvider] = useState('ramp');
    const [asset, setAsset] = useState('ETH');
    const [amount, setAmount] = useState('100');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [urlResult, setUrlResult] = useState(null);
    const [confirmed, setConfirmed] = useState(false);

    const active = wallets[activeIdx];

    // Fetch providers on mount
    useEffect(() => {
        if (!window.omega?.onramp) return;
        window.omega.onramp.getProviders().then(r => {
            if (r.ok) {
                setProviders(r.providers);
                if (r.providers.length > 0) setSelectedProvider(r.providers[0].id);
            }
        });
    }, []);

    const currentProvider = providers.find(p => p.id === selectedProvider);
    const supportedAssets = currentProvider?.supported || ['ETH', 'BTC', 'SOL'];

    const handleBuy = async () => {
        setLoading(true); setError(''); setUrlResult(null); setConfirmed(false);
        try {
            const r = await window.omega.onramp.getUrl(selectedProvider, asset, net, amount);
            if (r.ok) {
                setUrlResult(r);
            } else {
                setError(r.error || 'Failed to generate on-ramp URL');
            }
        } catch (e) {
            setError(e.message || 'Failed to connect to on-ramp');
        } finally {
            setLoading(false);
        }
    };

    const launchOnRamp = async () => {
        if (!urlResult?.url) return;
        try {
            await window.omega.openExternal(urlResult.url);
            setConfirmed(true);
        } catch (e) {
            setError('Failed to open browser: ' + e.message);
        }
    };

    return (
        <div className="page-container">
            <h2 style={{ margin: '0 0 20px', fontSize: '1.3rem', color: 'var(--text-primary)' }}>
                💳 Buy Crypto
            </h2>

            {/* ── Info Banner ─────────────────────────────────── */}
            <div style={{
                background: 'rgba(0,230,118,0.04)', border: '1px solid rgba(0,230,118,0.15)',
                borderRadius: 'var(--radius-sm)', padding: '10px 14px', marginBottom: 16,
                fontSize: '0.7rem', color: 'var(--text-muted)',
            }}>
                🛡 OmegaWallet connects you to third-party on-ramp providers. Your private keys never leave this device.
                On-ramp providers are not audited by OmegaWallet.
            </div>

            {/* ── Provider Selection ──────────────────────────── */}
            <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 8, display: 'block' }}>
                    Provider
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                    {providers.map(p => (
                        <button key={p.id}
                            className={`btn ${selectedProvider === p.id ? 'btn-primary' : 'btn-outline'}`}
                            style={{ flex: 1, fontSize: '0.78rem', padding: '10px 8px' }}
                            onClick={() => { setSelectedProvider(p.id); setUrlResult(null); }}>
                            {PROVIDER_ICONS[p.id] || '🔗'} {p.name}
                        </button>
                    ))}
                </div>
            </div>

            {/* ── Asset Selection ─────────────────────────────── */}
            <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 8, display: 'block' }}>
                    Buy
                </label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {supportedAssets.map(a => (
                        <button key={a}
                            className={`btn ${asset === a ? 'btn-primary' : 'btn-outline'}`}
                            style={{ fontSize: '0.78rem', padding: '8px 14px', minWidth: 70 }}
                            onClick={() => { setAsset(a); setUrlResult(null); }}>
                            {ASSET_ICONS[a] || '🪙'} {a}
                        </button>
                    ))}
                </div>
            </div>

            {/* ── Amount ──────────────────────────────────────── */}
            <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 8, display: 'block' }}>
                    Amount (USD)
                </label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                    {FIAT_AMOUNTS.map(a => (
                        <button key={a}
                            className={`btn ${amount === a ? 'btn-primary' : 'btn-outline'}`}
                            style={{ fontSize: '0.75rem', padding: '6px 12px' }}
                            onClick={() => { setAmount(a); setUrlResult(null); }}>
                            ${a}
                        </button>
                    ))}
                </div>
                <input type="text" className="input" value={amount}
                    onChange={e => { setAmount(e.target.value); setUrlResult(null); }}
                    placeholder="Custom amount (USD)"
                    style={{ width: '100%', padding: '8px 12px', fontSize: '0.85rem' }} />
            </div>

            {/* ── Destination Address ─────────────────────────── */}
            <div style={{
                background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm)', padding: '10px 14px', marginBottom: 16,
            }}>
                <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                    Funds will be sent to:
                </div>
                <div style={{
                    fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--text-gold)',
                    wordBreak: 'break-all',
                }}>
                    {urlResult?.address || active?.address || '—'}
                </div>
                <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginTop: 4 }}>
                    {active?.label} · {N(net).name}
                </div>
            </div>

            {/* ── Generate & Launch ───────────────────────────── */}
            {!urlResult ? (
                <button className="btn btn-primary" style={{ width: '100%', padding: '12px', fontSize: '0.9rem' }}
                    onClick={handleBuy} disabled={loading || !amount}>
                    {loading ? '⏳ Preparing...' : `💳 Buy ${asset} with ${currentProvider?.name || 'Provider'}`}
                </button>
            ) : (
                <div style={{
                    background: 'var(--bg-card)', border: '1px solid var(--border-gold)',
                    borderRadius: 'var(--radius-md)', padding: 16,
                }}>
                    <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
                        ✅ Ready to Buy {urlResult.asset} via {urlResult.provider}
                    </div>

                    {/* Safety Warning */}
                    <div style={{
                        background: 'rgba(255,235,59,0.06)', border: '1px solid rgba(255,235,59,0.15)',
                        borderRadius: 'var(--radius-sm)', padding: '8px 12px', marginBottom: 12,
                        fontSize: '0.68rem', color: 'var(--text-muted)',
                    }}>
                        ⚠ {urlResult.warning}
                    </div>

                    {/* Checklist */}
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
                        <div>✓ Your address will be pre-filled</div>
                        <div>✓ Fiat handled entirely by the on-ramp provider</div>
                        <div>✓ Private keys remain on this device</div>
                        <div>✓ Funds sent directly to your wallet address</div>
                    </div>

                    <button className="btn btn-primary"
                        style={{ width: '100%', padding: '12px', fontSize: '0.9rem' }}
                        onClick={launchOnRamp}>
                        🌐 Open {urlResult.provider} in Browser
                    </button>

                    {confirmed && (
                        <div style={{
                            marginTop: 10, textAlign: 'center', fontSize: '0.72rem', color: '#00e676',
                        }}>
                            ✓ Browser launched. Complete purchase in your browser. Funds will arrive in your wallet automatically.
                        </div>
                    )}

                    <button className="btn btn-outline" style={{ width: '100%', marginTop: 8, fontSize: '0.75rem' }}
                        onClick={() => { setUrlResult(null); setConfirmed(false); }}>
                        ← Change Options
                    </button>
                </div>
            )}

            {error && (
                <div style={{
                    marginTop: 12, padding: '8px 14px', borderRadius: 'var(--radius-sm)',
                    background: 'rgba(255,23,68,0.08)', border: '1px solid rgba(255,23,68,0.3)',
                    fontSize: '0.75rem', color: '#ff6b6b',
                }}>
                    ✗ {error}
                </div>
            )}

            {/* ── Trust Badge ─────────────────────────────────── */}
            <div style={{
                marginTop: 16, fontSize: '0.6rem', color: 'var(--text-muted)', textAlign: 'center',
                fontStyle: 'italic',
            }}>
                🛡 On-ramp URL generated by: main-process · Provider URLs validated before launch
            </div>
        </div>
    );
}
