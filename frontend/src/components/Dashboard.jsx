import { useState, useEffect } from 'react';
import { N, NETS, short } from '../lib/networks';

export function Dashboard({ wallets, activeIdx, net }) {
    const [bal, setBal] = useState('—');
    const [tokens, setTokens] = useState([]);
    const [loading, setLoading] = useState(true);
    const [spend, setSpend] = useState(null);
    const [copied, setCopied] = useState('');
    // Multi-chain balances
    const [btcBalance, setBtcBalance] = useState(null);
    const [solBalance, setSolBalance] = useState(null);
    const [btcAddr, setBtcAddr] = useState(null);
    const [solAddr, setSolAddr] = useState(null);
    // USD prices
    const [prices, setPrices] = useState(null);
    // Security score
    const [secScore, setSecScore] = useState(null);
    const [scoreOpen, setScoreOpen] = useState(false);
    const nn = N(net);
    const family = nn.family || 'evm';
    const active = wallets[activeIdx];

    const cp = (txt, label) => {
        navigator.clipboard.writeText(txt);
        setCopied(label);
        setTimeout(() => setCopied(''), 1500);
    };

    // ── EVM Balance Fetch (active chain only — for Balance card) ─
    const fetchBalance = () => {
        if (!active) return;
        if (family !== 'evm') { setLoading(false); return; }
        if (window.omega?.token) {
            window.omega.token.getBalances(active.address, net).then(res => {
                if (res.ok) {
                    const eth = res.balances.find(b => b.address === 'native');
                    setBal(eth ? parseFloat(eth.formatted).toFixed(6) : '0.000000');
                    setTokens(res.balances.filter(b => b.address !== 'native'));
                    setLoading(false);
                }
            }).catch(() => { setBal('0.000000'); setLoading(false); });
        }
        if (window.omega?.getSpendStatus) window.omega.getSpendStatus().then(s => setSpend(s));
    };

    // ── Cross-Chain Portfolio Aggregation ─────────────────────
    const PORTFOLIO_CHAINS = ['ethereum', 'base', 'arbitrum', 'optimism'];
    const [chainBalances, setChainBalances] = useState({});
    const [portfolioTab, setPortfolioTab] = useState('all');

    const fetchAllChains = async () => {
        if (!active || !window.omega?.token) return;
        const results = {};
        await Promise.allSettled(PORTFOLIO_CHAINS.map(async (chain) => {
            try {
                const res = await window.omega.token.getBalances(active.address, chain);
                if (res.ok) {
                    const native = res.balances.find(b => b.address === 'native');
                    results[chain] = {
                        native: parseFloat(native?.formatted || '0'),
                        tokens: res.balances.filter(b => b.address !== 'native'),
                    };
                }
            } catch { /* offline or unsupported */ }
        }));
        setChainBalances(prev => ({ ...prev, ...results }));
    };

    // ── BTC/SOL Derivation + Balance ───────────────────────
    const fetchMultiChain = async () => {
        if (!window.omega?.btc || !window.omega?.sol) return;
        try {
            const btcRes = await window.omega.btc.deriveAddress(activeIdx);
            if (btcRes.ok) {
                setBtcAddr(btcRes.address);
                const balRes = await window.omega.btc.getBalance(btcRes.address);
                if (balRes.ok) setBtcBalance(balRes.balance);
            }
        } catch { /* No mnemonic or offline */ }
        try {
            const solRes = await window.omega.sol.deriveAddress(activeIdx);
            if (solRes.ok) {
                setSolAddr(solRes.address);
                const balRes = await window.omega.sol.getBalance(solRes.address);
                if (balRes.ok) setSolBalance(balRes.balance);
            }
        } catch { /* No mnemonic or offline */ }
    };

    // ── Prices + Security Score ─────────────────────────────
    const fetchPrices = async () => {
        if (!window.omega?.getPrice) return;
        const res = await window.omega.getPrice('ethereum,bitcoin,solana');
        if (res.ok) setPrices(res.prices);
    };

    const fetchSecurityScore = async () => {
        if (!window.omega?.getSecurityScore) return;
        const res = await window.omega.getSecurityScore();
        if (res.ok) setSecScore(res);
    };

    useEffect(() => {
        setLoading(true);
        setBtcBalance(null);
        setSolBalance(null);
        setBtcAddr(null);
        setSolAddr(null);
        fetchBalance();
        fetchMultiChain();
        fetchAllChains();
        fetchPrices();
        fetchSecurityScore();
        const interval = setInterval(() => {
            fetchBalance();
            fetchMultiChain();
            fetchAllChains();
            fetchPrices();
        }, 30000);
        return () => clearInterval(interval);
    }, [activeIdx, net]);

    // ── USD Calculations (Cross-Chain) ───────────────────────
    const ethUsd = prices?.ethereum?.usd || 0;
    const btcUsd = prices?.bitcoin?.usd || 0;
    const solUsd = prices?.solana?.usd || 0;
    const STABLES = new Set(['USDC', 'USDT', 'DAI', 'FRAX', 'LUSD', 'TUSD', 'PYUSD', 'GHO', 'crvUSD', 'USDe']);

    // Per-chain USD values
    const chainUsdValues = {};
    for (const chain of PORTFOLIO_CHAINS) {
        const cb = chainBalances[chain];
        if (!cb) continue;
        const nativeVal = cb.native * ethUsd;
        const tokenVal = cb.tokens.reduce((sum, t) => {
            const b = parseFloat(t.formatted) || 0;
            if (STABLES.has(t.symbol)) return sum + b;
            if (t.symbol === 'WETH') return sum + b * ethUsd;
            return sum;
        }, 0);
        chainUsdValues[chain] = nativeVal + tokenVal;
    }

    const btcBal = btcBalance ? btcBalance.confirmed / 1e8 : 0;
    const solBal = solBalance ? solBalance.sol : 0;
    const btcValue = btcBal * btcUsd;
    const solValue = solBal * solUsd;
    chainUsdValues['bitcoin'] = btcValue;
    chainUsdValues['solana'] = solValue;

    const totalUsd = Object.values(chainUsdValues).reduce((s, v) => s + v, 0);

    // Active chain balance for the Balance card
    const ethBal = parseFloat(bal) || 0;
    const ethValue = ethBal * ethUsd;
    const tokenUsd = tokens.reduce((sum, t) => {
        const b = parseFloat(t.formatted) || 0;
        if (STABLES.has(t.symbol)) return sum + b;
        if (t.symbol === 'WETH') return sum + b * ethUsd;
        return sum;
    }, 0);

    // Portfolio tab filter
    const displayUsd = portfolioTab === 'all' ? totalUsd : (chainUsdValues[portfolioTab] || 0);

    // Chain name labels for tabs
    const CHAIN_LABELS = { ethereum: 'ETH', base: 'Base', arbitrum: 'ARB', optimism: 'OP', bitcoin: 'BTC', solana: 'SOL' };
    const activeTabs = ['all', ...Object.keys(chainUsdValues).filter(k => chainUsdValues[k] > 0.01)];

    // ── Security Score Color ─────────────────────────────────
    const scoreColor = secScore
        ? secScore.score >= 80 ? 'var(--accent-success)'
        : secScore.score >= 50 ? 'var(--accent-warning)'
        : 'var(--accent-danger)'
        : 'var(--text-muted)';

    // ── Skeleton Component ───────────────────────────────────
    const Skeleton = ({ width, height }) => (
        <div className="skeleton" style={{ width: width || '60%', height: height || '2rem', borderRadius: 'var(--radius-sm)' }} />
    );

    return (
        <div className="fade-in">
            <div className="page-header">
                <h2>Dashboard</h2>
                <p>{nn.name} Network · {active?.label} · IPC Cleanroom</p>
            </div>

            {/* Total Portfolio Value — Cross-Chain */}
            {prices && totalUsd > 0 && (
                <div className="glass-card stat-card" style={{
                    marginBottom: 16,
                    background: 'linear-gradient(135deg, rgba(255,193,7,0.06) 0%, rgba(255,193,7,0.02) 100%)',
                    border: '1px solid rgba(255,193,7,0.2)',
                }}>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                        {activeTabs.map(tab => (
                            <button key={tab} onClick={() => setPortfolioTab(tab)} style={{
                                padding: '3px 10px',
                                fontSize: '0.7rem',
                                borderRadius: 12,
                                border: portfolioTab === tab ? '1px solid var(--gold-400)' : '1px solid rgba(255,255,255,0.1)',
                                background: portfolioTab === tab ? 'rgba(255,193,7,0.15)' : 'transparent',
                                color: portfolioTab === tab ? 'var(--gold-300)' : 'var(--text-muted)',
                                cursor: 'pointer',
                                fontWeight: portfolioTab === tab ? 600 : 400,
                            }}>
                                {tab === 'all' ? '💰 All Chains' : CHAIN_LABELS[tab] || tab}
                            </button>
                        ))}
                    </div>
                    <div className="value" style={{ fontSize: '2rem', color: 'var(--gold-300)' }}>
                        ${displayUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                    <div className="change" style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>
                        {portfolioTab === 'all' ? 'Cross-chain total' : (CHAIN_LABELS[portfolioTab] || portfolioTab)} · via CoinGecko
                    </div>
                </div>
            )}

            <div className="dashboard-grid">
                <div className="glass-card stat-card">
                    <div className="label">Balance — {active?.label} ({nn.name})</div>
                    {loading ? <Skeleton /> : (
                        <>
                            <div className="value">{bal} {nn.sym}</div>
                            {prices && ethUsd > 0 && (
                                <div className="change" style={{ color: 'var(--text-gold)' }}>
                                    ≈ ${ethValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                                </div>
                            )}
                        </>
                    )}
                    <div className="change positive">Shielded · {nn.name}</div>
                </div>
                {btcBalance && (
                    <div className="glass-card stat-card" style={{ borderColor: 'rgba(247,147,26,0.2)' }}>
                        <div className="label" style={{ color: '#f7931a' }}>₿ Bitcoin</div>
                        <div className="value">{btcBalance.formatted} BTC</div>
                        {prices && btcUsd > 0 && (
                            <div className="change" style={{ color: '#f7931a' }}>
                                ≈ ${btcValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                            </div>
                        )}
                        <div className="change">Native SegWit · BIP84</div>
                    </div>
                )}
                {solBalance && (
                    <div className="glass-card stat-card" style={{ borderColor: 'rgba(153,69,255,0.2)' }}>
                        <div className="label" style={{ color: '#9945FF' }}>◎ Solana</div>
                        <div className="value">{solBalance.formatted} SOL</div>
                        {prices && solUsd > 0 && (
                            <div className="change" style={{ color: '#9945FF' }}>
                                ≈ ${solValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                            </div>
                        )}
                        <div className="change">Ed25519 · Mainnet</div>
                    </div>
                )}
                <div className="glass-card stat-card">
                    <div className="label">Security Score</div>
                    {secScore ? (
                        <>
                            <div className="value" style={{ color: scoreColor }}>
                                {secScore.score}/{secScore.maxScore}
                            </div>
                            <div className="change" style={{ color: scoreColor }}>
                                {secScore.score >= 80 ? '🛡 Hardened' : secScore.score >= 50 ? '⚡ Moderate' : '⚠ Needs attention'}
                            </div>
                            {secScore.factors?.length > 0 && (
                                <>
                                    <div onClick={() => setScoreOpen(!scoreOpen)} style={{ cursor: 'pointer', fontSize: '0.7rem', color: 'var(--text-gold)', marginTop: 6, userSelect: 'none' }}>
                                        {scoreOpen ? '▾' : '▸'} Details
                                    </div>
                                    {scoreOpen && (
                                        <div style={{ fontSize: '0.7rem', lineHeight: '1.6', marginTop: 6 }}>
                                            {secScore.factors.map((f, i) => (
                                                <div key={i} style={{ color: f.earned ? 'var(--accent-success)' : 'var(--text-muted)', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                                                    <span>{f.earned ? '✓' : '✗'} {f.name}</span>
                                                    <span style={{ opacity: 0.6 }}>+{f.points}</span>
                                                </div>
                                            ))}
                                            {secScore.factors.filter(f => !f.earned && f.tip).length > 0 && (
                                                <div style={{ marginTop: 6, padding: '4px 6px', background: 'rgba(255,193,7,0.08)', borderRadius: 4, color: 'var(--text-gold)', fontSize: '0.65rem' }}>
                                                    {secScore.factors.filter(f => !f.earned && f.tip).map((f, i) => (
                                                        <div key={i}>→ {f.tip}</div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </>
                            )}
                        </>
                    ) : <Skeleton />}
                </div>
                <div className="glass-card stat-card">
                    <div className="label">Wallets in Vault</div>
                    <div className="value">{wallets.length}</div>
                    <div className="change">Active: {active?.label}</div>
                </div>
                <div className="glass-card stat-card">
                    <div className="label">Daily Spend</div>
                    <div className="value">{spend ? spend.spent : '0.000000'} {nn.sym}</div>
                    <div className="change">of {spend ? spend.limit : '10'} limit · {spend ? spend.txCount : 0} txs</div>
                </div>
            </div>

            {tokens.length > 0 && (
                <>
                    <div className="page-header" style={{ marginTop: 24, marginBottom: 12 }}><h2>Tokens</h2></div>
                    <div className="dashboard-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
                        {tokens.map((t, i) => (
                            <div key={i} className="glass-card stat-card" style={{ padding: '16px' }}>
                                <div className="label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <div style={{ width: 16, height: 16, borderRadius: '50%', background: 'linear-gradient(135deg,var(--gold-300),var(--gold-500))' }}></div>
                                    {t.symbol}
                                </div>
                                <div className="value" style={{ fontSize: '1.2rem', marginTop: 8 }}>{parseFloat(t.formatted).toFixed(4)}</div>
                                <div className="change">Token Balance</div>
                            </div>
                        ))}
                    </div>
                </>
            )}

            <div className="page-header" style={{ marginTop: 24 }}><h2>Multi-Chain Addresses</h2></div>
            <div className="glass-card" style={{ maxWidth: 700 }}>
                {/* EVM */}
                <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-gold)', marginBottom: 6 }}>
                        {active?.label} — EVM ({nn.name})
                    </div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--text-primary)', cursor: 'pointer', background: 'rgba(255,255,255,0.02)', padding: '10px 12px', borderRadius: 'var(--radius-sm)', wordBreak: 'break-all', border: '1px solid rgba(255,255,255,0.05)' }}
                        onClick={() => cp(active?.address, 'evm')}
                        title="Click to copy">
                        {active?.address} {copied === 'evm' ? '✓' : '📋'}
                    </div>
                </div>
                {/* BTC */}
                {btcAddr && (
                    <div style={{ marginBottom: 16 }}>
                        <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#f7931a', marginBottom: 6 }}>
                            {active?.label} — Bitcoin (BIP84 SegWit)
                        </div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--text-primary)', cursor: 'pointer', background: 'rgba(247,147,26,0.03)', padding: '10px 12px', borderRadius: 'var(--radius-sm)', wordBreak: 'break-all', border: '1px solid rgba(247,147,26,0.12)' }}
                            onClick={() => cp(btcAddr, 'btc')}
                            title="Click to copy">
                            {btcAddr} {copied === 'btc' ? '✓' : '📋'}
                        </div>
                    </div>
                )}
                {/* SOL */}
                {solAddr && (
                    <div>
                        <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#9945FF', marginBottom: 6 }}>
                            {active?.label} — Solana (Ed25519)
                        </div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--text-primary)', cursor: 'pointer', background: 'rgba(153,69,255,0.03)', padding: '10px 12px', borderRadius: 'var(--radius-sm)', wordBreak: 'break-all', border: '1px solid rgba(153,69,255,0.12)' }}
                            onClick={() => cp(solAddr, 'sol')}
                            title="Click to copy">
                            {solAddr} {copied === 'sol' ? '✓' : '📋'}
                        </div>
                    </div>
                )}
                {!btcAddr && !solAddr && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                        BTC/SOL addresses require a mnemonic-based wallet. Import-only wallets support EVM only.
                    </div>
                )}
                <div style={{ marginTop: 12, fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                    All addresses derived from the same seed · Click to copy · Encrypted Ledger
                </div>
            </div>
        </div>
    );
}
