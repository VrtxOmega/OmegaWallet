import { useState, useEffect } from 'react';
import { N, short } from '../lib/networks';

const TOKEN_ICONS = {
    ETH: '⟠', WETH: '⟠', USDC: '💲', USDT: '₮', DAI: '◆',
    LINK: '⬡', UNI: '🦄', WBTC: '₿', MATIC: '⬡', BNB: '◆', AVAX: '🔺',
};

const SLIPPAGE_OPTIONS = [0.1, 0.5, 1.0, 3.0];

export function Swap({ wallets, activeIdx, net }) {
    const [tokens, setTokens] = useState([]);
    const [fromToken, setFromToken] = useState('ETH');
    const [toToken, setToToken] = useState('USDC');
    const [amount, setAmount] = useState('0.01');
    const [slippage, setSlippage] = useState(0.5);
    const [quote, setQuote] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [swapResult, setSwapResult] = useState(null);
    const [step, setStep] = useState('input'); // input | quote | confirm | done

    const active = wallets[activeIdx];

    // Fetch tokens on mount and chain change
    useEffect(() => {
        if (!window.omega?.swap) return;
        window.omega.swap.getTokens(net).then(r => {
            if (r.ok) setTokens(r.tokens);
        });
    }, [net]);

    const handleGetQuote = async () => {
        setLoading(true); setError(''); setQuote(null);
        try {
            const r = await window.omega.swap.getQuote({
                fromToken, toToken, amount, chain: net, slippage,
            });
            if (r.ok) { setQuote(r); setStep('quote'); }
            else setError(r.error || 'Failed to get quote');
        } catch (e) { setError(e.message); }
        finally { setLoading(false); }
    };

    const handleSwap = async () => {
        setLoading(true); setError('');
        try {
            const r = await window.omega.swap.execute({
                fromToken, toToken, amount, chain: net, slippage,
            });
            if (r.ok) { setSwapResult(r); setStep('done'); }
            else setError(r.error || 'Swap failed');
        } catch (e) { setError(e.message); }
        finally { setLoading(false); }
    };

    const flipTokens = () => {
        setFromToken(toToken); setToToken(fromToken);
        setQuote(null); setStep('input');
    };

    const resetSwap = () => {
        setQuote(null); setSwapResult(null); setStep('input'); setError('');
    };

    const priceImpactColor = (impact) => {
        const v = parseFloat(impact || '0');
        if (v > 5) return '#ff1744';
        if (v > 2) return '#ff9100';
        if (v > 1) return '#ffea00';
        return '#00e676';
    };

    return (
        <div className="page-container">
            <h2 style={{ margin: '0 0 20px', fontSize: '1.3rem', color: 'var(--text-primary)' }}>
                🔄 Swap
            </h2>

            {/* ── Step: Input ──────────────────────────────────── */}
            {step === 'input' && (
                <>
                    {/* From Token */}
                    <div style={{
                        background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
                        borderRadius: 'var(--radius-md)', padding: 16, marginBottom: 4,
                    }}>
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 8 }}>You sell</div>
                        <div style={{ display: 'flex', gap: 10 }}>
                            <input type="text" className="input" value={amount}
                                onChange={e => setAmount(e.target.value)}
                                placeholder="0.0"
                                style={{ flex: 2, fontSize: '1.2rem', padding: '10px 12px' }} />
                            <select className="input" value={fromToken}
                                onChange={e => { setFromToken(e.target.value); setQuote(null); }}
                                style={{
                                    flex: 1, cursor: 'pointer', fontSize: '0.9rem',
                                    background: 'var(--bg-card)', color: 'var(--text-gold)',
                                    border: '1px solid var(--border-gold)',
                                }}>
                                <option value="ETH" style={{ background: '#111' }}>⟠ ETH</option>
                                {tokens.filter(t => t.symbol !== 'ETH').map(t => (
                                    <option key={t.symbol} value={t.symbol} style={{ background: '#111' }}>
                                        {t.icon || TOKEN_ICONS[t.symbol] || '🪙'} {t.symbol}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {/* Flip Button */}
                    <div style={{ display: 'flex', justifyContent: 'center', margin: '0 0 4px' }}>
                        <button onClick={flipTokens} style={{
                            background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
                            borderRadius: '50%', width: 36, height: 36, cursor: 'pointer',
                            fontSize: '1rem', color: 'var(--text-gold)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>⇅</button>
                    </div>

                    {/* To Token */}
                    <div style={{
                        background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
                        borderRadius: 'var(--radius-md)', padding: 16, marginBottom: 16,
                    }}>
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 8 }}>You receive</div>
                        <div style={{ display: 'flex', gap: 10 }}>
                            <div style={{
                                flex: 2, fontSize: '1.2rem', padding: '10px 12px',
                                color: quote ? 'var(--text-gold)' : 'var(--text-muted)',
                                fontFamily: 'var(--font-mono)',
                            }}>
                                {quote ? quote.buyAmountFormatted || quote.buyAmount : '—'}
                            </div>
                            <select className="input" value={toToken}
                                onChange={e => { setToToken(e.target.value); setQuote(null); }}
                                style={{
                                    flex: 1, cursor: 'pointer', fontSize: '0.9rem',
                                    background: 'var(--bg-card)', color: 'var(--text-gold)',
                                    border: '1px solid var(--border-gold)',
                                }}>
                                {tokens.map(t => (
                                    <option key={t.symbol} value={t.symbol} style={{ background: '#111' }}>
                                        {t.icon || TOKEN_ICONS[t.symbol] || '🪙'} {t.symbol}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {/* Slippage */}
                    <div style={{ marginBottom: 16 }}>
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 6 }}>
                            Slippage Tolerance
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                            {SLIPPAGE_OPTIONS.map(s => (
                                <button key={s}
                                    className={`btn ${slippage === s ? 'btn-primary' : 'btn-outline'}`}
                                    style={{ fontSize: '0.75rem', padding: '6px 12px' }}
                                    onClick={() => setSlippage(s)}>
                                    {s}%
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Get Quote */}
                    <button className="btn btn-primary"
                        style={{ width: '100%', padding: '12px', fontSize: '0.9rem' }}
                        onClick={handleGetQuote}
                        disabled={loading || !amount || fromToken === toToken}>
                        {loading ? '⏳ Fetching Quote...' : `Get Quote: ${amount} ${fromToken} → ${toToken}`}
                    </button>
                </>
            )}

            {/* ── Step: Quote ─────────────────────────────────── */}
            {step === 'quote' && quote && (
                <div style={{
                    background: 'var(--bg-card)', border: '1px solid var(--border-gold)',
                    borderRadius: 'var(--radius-md)', padding: 20,
                }}>
                    <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>
                        🔄 Swap Quote
                    </div>

                    {/* Sell / Buy Summary */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                        <div>
                            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Sell</div>
                            <div style={{ fontSize: '1.1rem', color: 'var(--text-primary)' }}>
                                {TOKEN_ICONS[fromToken] || '🪙'} {amount} {fromToken}
                            </div>
                        </div>
                        <div style={{ fontSize: '1.2rem', color: 'var(--text-muted)' }}>→</div>
                        <div style={{ textAlign: 'right' }}>
                            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Receive</div>
                            <div style={{ fontSize: '1.1rem', color: '#00e676' }}>
                                {TOKEN_ICONS[toToken] || '🪙'} {quote.buyAmountFormatted || quote.buyAmount} {toToken}
                            </div>
                        </div>
                    </div>

                    {/* Details Grid */}
                    <div style={{
                        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px',
                        padding: '12px 14px', background: 'rgba(0,0,0,0.2)', borderRadius: 'var(--radius-sm)',
                        marginBottom: 16, fontSize: '0.7rem',
                    }}>
                        <div style={{ color: 'var(--text-muted)' }}>Price Impact</div>
                        <div style={{ textAlign: 'right', color: priceImpactColor(quote.priceImpact) }}>
                            {quote.priceImpact}%
                        </div>
                        <div style={{ color: 'var(--text-muted)' }}>Slippage</div>
                        <div style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>
                            {quote.slippage}%
                        </div>
                        <div style={{ color: 'var(--text-muted)' }}>Est. Gas</div>
                        <div style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>
                            {quote.estimatedGas ? `~${parseInt(quote.estimatedGas).toLocaleString()} gas` : '—'}
                        </div>
                        <div style={{ color: 'var(--text-muted)' }}>Route</div>
                        <div style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>
                            {quote.route?.map(r => r.name).join(' → ') || '—'}
                        </div>
                        <div style={{ color: 'var(--text-muted)' }}>Source</div>
                        <div style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>
                            {quote.source || '—'}
                        </div>
                        <div style={{ color: 'var(--text-muted)' }}>Network</div>
                        <div style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>
                            {N(net).name}
                        </div>
                    </div>

                    {/* Price impact warning */}
                    {parseFloat(quote.priceImpact || '0') > 2 && (
                        <div style={{
                            background: 'rgba(255,23,68,0.08)', border: '1px solid rgba(255,23,68,0.3)',
                            borderRadius: 'var(--radius-sm)', padding: '8px 12px', marginBottom: 12,
                            fontSize: '0.7rem', color: '#ff6b6b',
                        }}>
                            ⚠ High price impact ({quote.priceImpact}%). Consider reducing swap size.
                        </div>
                    )}

                    {/* Estimated source notice */}
                    {quote.source === 'estimated' && (
                        <div style={{
                            background: 'rgba(255,235,59,0.06)', border: '1px solid rgba(255,235,59,0.15)',
                            borderRadius: 'var(--radius-sm)', padding: '8px 12px', marginBottom: 12,
                            fontSize: '0.68rem', color: 'var(--text-muted)',
                        }}>
                            📊 Estimated quote (API unavailable). Actual rate may differ. Set your 0x API key for live routing.
                        </div>
                    )}

                    {/* Actions */}
                    <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-outline" style={{ flex: 1 }} onClick={resetSwap}>
                            ← Edit
                        </button>
                        <button className="btn btn-primary" style={{ flex: 2, padding: '12px' }}
                            onClick={handleSwap} disabled={loading}>
                            {loading ? '⏳ Executing...' : `🔄 Swap ${fromToken} → ${toToken}`}
                        </button>
                    </div>
                </div>
            )}

            {/* ── Step: Done ──────────────────────────────────── */}
            {step === 'done' && swapResult && (
                <div style={{
                    background: 'var(--bg-card)', border: '1px solid rgba(0,230,118,0.3)',
                    borderRadius: 'var(--radius-md)', padding: 20, textAlign: 'center',
                }}>
                    {swapResult.action === 'prepare' ? (
                        <>
                            <div style={{ fontSize: '2rem', marginBottom: 8 }}>✅</div>
                            <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
                                Swap Ready for Signing
                            </div>
                            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 12 }}>
                                {swapResult.quote?.sellAmount} {swapResult.quote?.fromToken} → {swapResult.quote?.buyAmount} {swapResult.quote?.toToken}
                            </div>
                            <div style={{
                                fontSize: '0.68rem', color: 'var(--text-muted)', padding: '8px 12px',
                                background: 'rgba(0,0,0,0.2)', borderRadius: 'var(--radius-sm)', marginBottom: 12,
                            }}>
                                Route through Send → the transaction is prepared for your review and signing via the standard two-phase confirmation.
                            </div>
                        </>
                    ) : (
                        <>
                            <div style={{ fontSize: '2rem', marginBottom: 8 }}>🚀</div>
                            <div style={{ fontSize: '0.9rem', fontWeight: 600, color: '#00e676' }}>
                                Swap Submitted
                            </div>
                        </>
                    )}
                    <button className="btn btn-outline" style={{ width: '100%', marginTop: 12 }} onClick={resetSwap}>
                        New Swap
                    </button>
                </div>
            )}

            {/* ── Error ───────────────────────────────────────── */}
            {error && (
                <div style={{
                    marginTop: 12, padding: '8px 14px', borderRadius: 'var(--radius-sm)',
                    background: 'rgba(255,23,68,0.08)', border: '1px solid rgba(255,23,68,0.3)',
                    fontSize: '0.75rem', color: '#ff6b6b',
                }}>
                    ✗ {error}
                </div>
            )}

            {/* ── Wallet Info ─────────────────────────────────── */}
            <div style={{
                marginTop: 16, padding: '10px 14px',
                background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm)', display: 'flex', justifyContent: 'space-between',
                fontSize: '0.68rem', color: 'var(--text-muted)',
            }}>
                <span>🏷️ {active?.label} · {short(active?.address)}</span>
                <span>{N(net).name}</span>
            </div>

            {/* ── Trust Badge ─────────────────────────────────── */}
            <div style={{
                marginTop: 8, fontSize: '0.6rem', color: 'var(--text-muted)', textAlign: 'center',
                fontStyle: 'italic',
            }}>
                🛡 Swap routes computed by: main-process · Execution through two-phase signing
            </div>
        </div>
    );
}
