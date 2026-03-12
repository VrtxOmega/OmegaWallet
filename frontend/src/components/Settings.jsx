import { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { N, NETS, short } from '../lib/networks';

export function Settings({ wallets, activeIdx, setActiveIdx, onLock, onReset, net, setNet, refreshWallets }) {
    const [showKey, setShowKey] = useState(false);
    const [activePK, setActivePK] = useState('');
    const [copied, setCopied] = useState('');
    const [limit, setLimit] = useState('10');
    const [proxy, setProxy] = useState('tor');
    const [confirmReset, setConfirmReset] = useState(false);
    const [addMode, setAddMode] = useState(null);
    const [newLabel, setNewLabel] = useState('');
    const [newKey, setNewKey] = useState('');
    const [addErr, setAddErr] = useState('');
    const [removeIdx, setRemoveIdx] = useState(-1);
    const [newToken, setNewToken] = useState('');
    const [importing, setImporting] = useState(false);
    const [tokenMsg, setTokenMsg] = useState('');
    const [autoLockMinutes, setAutoLockMinutes] = useState('15');
    const [strictMode, setStrictMode] = useState(false);
    const [whitelist, setWhitelist] = useState([]);
    const [newWlAddr, setNewWlAddr] = useState('');
    const [newWlLabel, setNewWlLabel] = useState('');
    const [versionInfo, setVersionInfo] = useState(null);

    const nn = N(net);
    const active = wallets[activeIdx];

    useEffect(() => {
        window.omega.getSettings().then(r => {
            if (r.ok && r.settings) {
                setLimit(r.settings.spendLimit || '10');
                setProxy(r.settings.proxyMode || 'tor');
                setAutoLockMinutes(r.settings.autoLockMinutes?.toString() || '15');
                setStrictMode(!!r.settings.strictModeEnabled);
                setWhitelist(r.settings.addressWhitelist || []);
            }
        });
        // Fetch version info
        if (window.omega?.getVersion) {
            window.omega.getVersion().then(r => { if (r.ok) setVersionInfo(r); });
        }
    }, []);

    const cp = (txt, lbl) => {
        navigator.clipboard.writeText(txt).then(() => { setCopied(lbl); setTimeout(() => setCopied(''), 2000); });
    };

    const saveLimit = async v => { setLimit(v); await window.omega.updateSettings({ spendLimit: v }); };
    const saveProxy = async m => { setProxy(m); await window.omega.updateSettings({ proxyMode: m }); };
    const saveAutoLock = async v => { setAutoLockMinutes(v); await window.omega.updateSettings({ autoLockMinutes: parseInt(v) }); };

    const toggleStrictMode = async () => {
        const v = !strictMode;
        setStrictMode(v);
        await window.omega.updateSettings({ strictModeEnabled: v });
    };

    const addWhitelist = async () => {
        if (!newWlAddr) return;
        const nw = [...whitelist, { address: newWlAddr.trim(), label: newWlLabel || 'Unknown' }];
        setWhitelist(nw);
        await window.omega.updateSettings({ addressWhitelist: nw });
        setNewWlAddr(''); setNewWlLabel('');
    };

    const removeWhitelist = async (i) => {
        const nw = whitelist.filter((_, idx) => idx !== i);
        setWhitelist(nw);
        await window.omega.updateSettings({ addressWhitelist: nw });
    };

    const [revealPw, setRevealPw] = useState('');
    const [revealErr, setRevealErr] = useState('');
    const [revealPending, setRevealPending] = useState(false);

    const revealKey = async () => {
        if (!revealPw) { setRevealErr('Enter your vault password'); return; }
        setRevealErr('');
        const r = await window.omega.vault.getKey(activeIdx, revealPw);
        if (r.ok) { setActivePK(r.privateKey); setShowKey(true); setRevealPw(''); setRevealPending(false); }
        else { setRevealErr(r.error || 'Incorrect password'); }
    };

    const addWallet = async () => {
        const res = await window.omega.vault.addWallet(
            newLabel || `Wallet ${wallets.length + 1}`,
            addMode === 'import' ? newKey.trim() : null
        );
        if (!res.ok) return setAddErr(res.error);
        setAddMode(null); setNewLabel(''); setNewKey(''); setAddErr('');
        refreshWallets();
    };

    const [removePw, setRemovePw] = useState('');
    const [removeErr, setRemoveErr] = useState('');

    const removeWallet = async (idx) => {
        if (!removePw) { setRemoveErr('Enter vault password'); return; }
        setRemoveErr('');
        const res = await window.omega.vault.removeWallet(idx, removePw);
        if (res.ok) { setRemoveIdx(-1); setRemovePw(''); setRemoveErr(''); refreshWallets(); }
        else { setRemoveErr(res.error || 'Failed'); }
    };

    const switchActive = async (idx) => {
        await window.omega.vault.setActive(idx);
        setActiveIdx(idx);
    };

    const importToken = async () => {
        if (!newToken || !ethers.isAddress(newToken)) return setTokenMsg('❌ Invalid address');
        setImporting(true); setTokenMsg('⏳ Fetching token info...');
        const res = await window.omega.token.import(newToken.trim(), net);
        setImporting(false);
        if (res.ok) { setTokenMsg(`✅ Imported ${res.token.symbol} (${res.token.decimals} dec)`); setNewToken(''); }
        else { setTokenMsg(`❌ ${res.error}`); }
    };

    return (
        <div className="fade-in">
            <div className="page-header"><h2>Settings</h2><p>Wallet vault & configuration · {nn.name}</p></div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 500 }}>

                {/* Wallet Manager */}
                <div className="glass-card">
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: 12, color: 'var(--text-gold)' }}>
                        Wallet Vault ({wallets.length})</div>
                    {wallets.map((w, i) => (
                        <div key={i} style={{
                            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0',
                            borderBottom: i < wallets.length - 1 ? '1px solid rgba(212,160,23,0.1)' : 'none'
                        }}>
                            <button className={`btn btn-sm ${i === activeIdx ? 'btn-primary' : 'btn-outline'}`}
                                onClick={() => switchActive(i)} style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
                                {w.label} — {short(w.address)}</button>
                            <button className="btn btn-outline btn-sm"
                                onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(w.address); cp(w.address, w.label); }}
                                title={w.address} style={{ padding: '4px 8px', fontSize: '0.7rem' }}>
                                {copied === w.label ? '✓' : '📋'}</button>
                            {wallets.length > 1 && (
                                removeIdx === i ? (
                                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                                        <input type="password" className="input" placeholder="Password"
                                            value={removePw} onChange={e => setRemovePw(e.target.value)}
                                            onKeyDown={e => e.key === 'Enter' && removeWallet(i)}
                                            style={{ width: 100, padding: '4px 6px', fontSize: '0.7rem' }} autoFocus />
                                        <button className="btn btn-danger btn-sm" style={{ padding: '4px 8px' }} onClick={() => removeWallet(i)}>Del</button>
                                        <button className="btn btn-outline btn-sm" style={{ padding: '4px 8px' }} onClick={() => { setRemoveIdx(-1); setRemovePw(''); setRemoveErr(''); }}>✕</button>
                                        {removeErr && <div style={{ width: '100%', color: 'var(--accent-danger)', fontSize: '0.65rem' }}>✗ {removeErr}</div>}
                                    </div>
                                ) : (
                                    <button className="btn btn-outline btn-sm" style={{ padding: '4px 8px', color: 'var(--accent-danger)' }}
                                        onClick={() => setRemoveIdx(i)}>🗑</button>
                                )
                            )}
                        </div>
                    ))}
                    <div style={{ marginTop: 12 }}>
                        {!addMode ? (
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button className="btn btn-outline btn-sm" style={{ flex: 1 }} onClick={() => setAddMode('create')}>
                                    + Generate New</button>
                                <button className="btn btn-outline btn-sm" style={{ flex: 1 }} onClick={() => setAddMode('import')}>
                                    + Import Key</button>
                            </div>
                        ) : (
                            <div style={{
                                background: 'rgba(212,160,23,0.05)', border: '1px solid var(--border-gold)',
                                borderRadius: 'var(--radius-md)', padding: 12
                            }}>
                                <div style={{ fontSize: '0.8rem', fontWeight: 700, marginBottom: 8 }}>
                                    {addMode === 'create' ? 'Generate New Wallet' : 'Import Wallet'}</div>
                                <input className="input" placeholder="Label (optional)" value={newLabel}
                                    onChange={e => setNewLabel(e.target.value)} style={{ marginBottom: 8 }} />
                                {addMode === 'import' && (
                                    <textarea className="input" rows={2} placeholder="Private key (0x...) or seed phrase"
                                        value={newKey} onChange={e => setNewKey(e.target.value)} style={{ marginBottom: 8, resize: 'none' }} />
                                )}
                                {addErr && <div style={{ color: 'var(--accent-danger)', fontSize: '0.75rem', marginBottom: 8 }}>{addErr}</div>}
                                <div style={{ display: 'flex', gap: 8 }}>
                                    <button className="btn btn-outline btn-sm" style={{ flex: 1 }} onClick={() => { setAddMode(null); setAddErr(''); }}>Cancel</button>
                                    <button className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={addWallet}>Add</button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Active Wallet Details */}
                <div className="glass-card">
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: 12, color: 'var(--text-gold)' }}>
                        Public Receiving Address — {active?.label}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem', color: 'var(--text-primary)', marginBottom: 12, background: 'rgba(255,255,255,0.02)', padding: '12px', borderRadius: 'var(--radius-sm)', wordBreak: 'break-all', border: '1px solid rgba(255,255,255,0.05)' }}>
                        {active?.address}</div>
                    <button className="btn btn-outline btn-sm" onClick={() => cp(active?.address, 'addr')}>
                        {copied === 'addr' ? '✓ Copied' : 'Copy Address'}</button>
                </div>

                {/* Private Key */}
                <div className="glass-card" style={{ borderColor: 'rgba(255,23,68,0.15)' }}>
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: 12, color: 'var(--accent-danger)' }}>
                        Private Key — {active?.label}</div>
                    {showKey ? (<>
                        <div style={{
                            fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-primary)',
                            wordBreak: 'break-all', background: 'rgba(255,23,68,0.05)',
                            border: '1px solid rgba(255,23,68,0.15)', borderRadius: 'var(--radius-sm)',
                            padding: 12, marginBottom: 8
                        }}>{activePK}</div>
                        <div style={{ display: 'flex', gap: 8 }}>
                            <button className="btn btn-outline btn-sm" onClick={() => cp(activePK, 'key')}>
                                {copied === 'key' ? '✓ Copied' : 'Copy Key'}</button>
                            <button className="btn btn-outline btn-sm" onClick={() => { setShowKey(false); setActivePK(''); }}>Hide</button>
                        </div>
                    </>) : revealPending ? (<>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 8 }}>
                            🔒 Re-enter your vault password to export this key
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <input type="password" className="input" placeholder="Vault password"
                                value={revealPw} onChange={e => setRevealPw(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && revealKey()}
                                style={{ flex: 1, padding: '6px 10px', fontSize: '0.8rem' }} autoFocus />
                            <button className="btn btn-danger btn-sm" onClick={revealKey}>Confirm</button>
                            <button className="btn btn-outline btn-sm" onClick={() => { setRevealPending(false); setRevealPw(''); setRevealErr(''); }}>Cancel</button>
                        </div>
                        {revealErr && <div style={{ color: 'var(--accent-danger)', fontSize: '0.75rem', marginTop: 6 }}>✗ {revealErr}</div>}
                    </>) : (
                        <button className="btn btn-danger btn-sm" onClick={() => setRevealPending(true)}>⚠ Reveal Private Key</button>
                    )}
                </div>

                {/* Network */}
                <div className="glass-card">
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: 12 }}>Network</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
                        EVM Chains
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                        {Object.entries(NETS).filter(([, n]) => n.family === 'evm').map(([k, n]) => (
                            <button key={k} className={`btn btn-sm ${net === k ? 'btn-primary' : 'btn-outline'}`}
                                onClick={() => setNet(k)} style={{ fontSize: '0.75rem', padding: '4px 10px' }}>{n.name}</button>
                        ))}
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
                        Non-EVM Chains
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {Object.entries(NETS).filter(([, n]) => n.family !== 'evm').map(([k, n]) => (
                            <button key={k} className={`btn btn-sm ${net === k ? 'btn-primary' : 'btn-outline'}`}
                                onClick={() => setNet(k)} style={{ fontSize: '0.75rem', padding: '4px 10px' }}>
                                {k === 'bitcoin' ? '₿' : '◎'} {n.name}
                            </button>
                        ))}
                    </div>
                    <div style={{ marginTop: 10, fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                        {nn.family === 'evm' ? `Chain ID: ${nn.id} · ` : ''}{nn.sym} · {nn.family?.toUpperCase() || 'EVM'}</div>
                </div>

                {/* Custom Tokens */}
                <div className="glass-card">
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: 12 }}>Custom Tokens ({nn.name})</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <input className="input" placeholder="0x... contract address" value={newToken} onChange={e => setNewToken(e.target.value)} />
                        <button className="btn btn-outline btn-sm" onClick={importToken} disabled={importing}>
                            {importing ? '⏳' : '+ Import'}</button>
                    </div>
                    {tokenMsg && (
                        <div style={{ fontSize: '0.75rem', marginTop: 8, color: tokenMsg.includes('✅') ? 'var(--accent-success)' : tokenMsg.includes('⏳') ? 'var(--gold-300)' : 'var(--accent-danger)' }}>
                            {tokenMsg}</div>
                    )}
                </div>

                {/* Auto-Lock */}
                <div className="glass-card">
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: 12 }}>Auto-Lock Timer (Dead Man's Switch)</div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <select className="input" value={autoLockMinutes} onChange={e => saveAutoLock(e.target.value)} style={{ padding: '8px 12px' }}>
                            <option value="0">Never (Require Manual Lock)</option>
                            <option value="5">5 Minutes</option>
                            <option value="15">15 Minutes</option>
                            <option value="30">30 Minutes</option>
                            <option value="60">1 Hour</option>
                        </select>
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Automatically locks vault on inactivity</span>
                    </div>
                </div>

                {/* Strict-Mode Whitelist */}
                <div className="glass-card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                        <div style={{ fontSize: '0.85rem', fontWeight: 700 }}>Strict-Mode Address Whitelist</div>
                        <button className={`btn btn-sm ${strictMode ? 'btn-danger' : 'btn-outline'}`} onClick={toggleStrictMode}>
                            {strictMode ? 'On (Enforced)' : 'Off (Disabled)'}</button>
                    </div>
                    {strictMode && (
                        <div style={{ border: '1px solid rgba(255,23,68,0.2)', padding: 12, borderRadius: 8, background: 'rgba(255,23,68,0.05)', marginBottom: 16, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                            <strong>⚠ Strict Mode Active:</strong> Outbound transactions to non-whitelisted addresses will be mathematically blocked at the IPC boundary. Prevents clipboard-poisoning malware.
                        </div>
                    )}
                    <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                        <input className="input" placeholder="0x... address" value={newWlAddr} onChange={e => setNewWlAddr(e.target.value)} style={{ flex: 2 }} />
                        <input className="input" placeholder="Label (e.g. Binance Deposit)" value={newWlLabel} onChange={e => setNewWlLabel(e.target.value)} style={{ flex: 1 }} />
                        <button className="btn btn-outline btn-sm" onClick={addWhitelist}>+ Add</button>
                    </div>
                    {whitelist.length > 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {whitelist.map((w, i) => (
                                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.2)', padding: '8px 12px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.05)' }}>
                                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                                        <span style={{ fontSize: '0.85rem', color: 'var(--text-gold)', fontWeight: 600 }}>{w.label}</span>
                                        <span style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{w.address}</span>
                                    </div>
                                    <button className="btn btn-outline btn-sm" style={{ padding: '2px 8px', borderColor: 'rgba(255,23,68,0.5)', color: 'var(--accent-danger)' }} onClick={() => removeWhitelist(i)}>Remove</button>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textAlign: 'center', padding: 12 }}>No addresses in whitelist.</div>
                    )}
                </div>

                {/* Spend Limits */}
                <div className="glass-card">
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: 12 }}>Spend Limits (Encrypted Ledger)</div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input className="input" value={limit} onChange={e => saveLimit(e.target.value)}
                            style={{ width: 80 }} type="number" min="0" step="1" />
                        <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{nn.sym} per day</span>
                        <span style={{ color: 'var(--accent-success)', fontSize: '0.75rem' }}>✓ Stored encrypted</span>
                    </div>
                </div>

                {/* RPC Proxy */}
                <div className="glass-card">
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: 12 }}>RPC Proxy</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                        {[['direct', 'Direct'], ['tor', '🧅 Tor'], ['nym', 'Nym']].map(([m, l]) => (
                            <button key={m} className={`btn btn-sm ${proxy === m ? 'btn-primary' : 'btn-outline'}`}
                                onClick={() => saveProxy(m)}>{l}</button>
                        ))}
                    </div>
                    <div style={{ marginTop: 8, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        {proxy === 'direct' ? 'Direct RPC' : proxy === 'tor' ? 'Routing via Tor SOCKS5' : 'Routing via Nym mixnet'}</div>
                </div>

                {/* Lock / Reset */}
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button className="btn btn-outline" style={{ flex: 1 }} onClick={onLock}>🔒 Lock Vault</button>
                    {!confirmReset ? (
                        <button className="btn btn-danger" style={{ flex: 1 }} onClick={() => setConfirmReset(true)}>Reset Vault</button>
                    ) : (
                        <div style={{ flex: 1, display: 'flex', gap: 4 }}>
                            <button className="btn btn-outline btn-sm" style={{ flex: 1 }} onClick={() => setConfirmReset(false)}>Cancel</button>
                            <button className="btn btn-danger btn-sm" style={{ flex: 1 }} onClick={onReset}>Delete All</button>
                        </div>
                    )}
                </div>

                {/* Version Footer */}
                <div style={{
                    marginTop: 16, padding: '16px 0', borderTop: '1px solid rgba(255,193,7,0.08)',
                    textAlign: 'center', fontSize: '0.7rem', color: 'var(--text-muted)',
                    fontFamily: 'var(--font-mono)',
                }}>
                    <div style={{ marginBottom: 4, color: 'var(--text-gold)' }}>
                        Ω OmegaWallet {versionInfo ? `v${versionInfo.version}` : 'v2.1.0'}
                    </div>
                    {versionInfo && (
                        <div>
                            Electron {versionInfo.electron} · Node {versionInfo.node} · Chromium {versionInfo.chrome}
                        </div>
                    )}
                    <div style={{ marginTop: 4 }}>High-Assurance Shielded Wallet · IPC Cleanroom Architecture</div>
                </div>
            </div>
        </div>
    );
}
