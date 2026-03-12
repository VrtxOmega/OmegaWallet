import { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { N, short } from '../lib/networks';
import { WalletPicker } from './Sidebar';

export function Batch({ wallets, net }) {
    const [fromIdx, setFromIdx] = useState(0);
    const [rows, setRows] = useState([{ addr: '', amt: '' }]);
    const [asset, setAsset] = useState('native');
    const [tokens, setTokens] = useState([]);
    const [scans, setScans] = useState([null]);
    const [status, setStatus] = useState('');
    const [busy, setBusy] = useState(false);
    const [strictMode, setStrictMode] = useState(false);
    const [whitelist, setWhitelist] = useState([]);
    const [batchPw, setBatchPw] = useState('');
    const [batchErr, setBatchErr] = useState('');
    const nn = N(net);
    const family = nn.family || 'evm';

    useEffect(() => {
        window.omega.getSettings().then(r => {
            if (r.ok && r.settings) {
                setStrictMode(!!r.settings.strictModeEnabled);
                setWhitelist(r.settings.addressWhitelist || []);
            }
        });
        if (window.omega?.token && wallets[fromIdx]) {
            window.omega.token.getBalances(wallets[fromIdx].address, net).then(r => {
                if (r.ok) setTokens(r.balances);
            });
        }
    }, [fromIdx, net]);

    const add = () => { setRows([...rows, { addr: '', amt: '' }]); setScans([...scans, null]); };
    const rm = i => {
        if (rows.length > 1) {
            setRows(rows.filter((_, j) => j !== i));
            setScans(scans.filter((_, j) => j !== i));
        }
    };
    const upd = (i, k, v) => {
        const u = [...rows]; u[i][k] = v; setRows(u);
        if (k === 'addr' && ethers.isAddress(v) && window.omega) {
            const s = [...scans]; s[i] = { verdict: 'SCANNING', threatScore: -1 }; setScans(s);
            window.omega.scanContract(v, net).then(res => {
                setScans(prev => { const n = [...prev]; n[i] = res; return n; });
            });
        } else if (k === 'addr' && !ethers.isAddress(v)) {
            const s = [...scans]; s[i] = null; setScans(s);
        }
    };
    const total = rows.reduce((s, r) => s + (parseFloat(r.amt) || 0), 0);

    const sim = async () => {
        const v = rows.filter(r => r.addr && r.amt);
        if (!v.length) return setStatus('⚠ Add at least one recipient');
        setStatus(`⏳ Simulating ${v.length} transfers via IPC...`);
        let allPass = true;
        for (const r of v) {
            if (!ethers.isAddress(r.addr)) { allPass = false; setStatus('⚠ Invalid address in batch'); break; }
            if (parseFloat(r.amt) <= 0) { allPass = false; setStatus('⚠ Amount must be greater than 0'); break; }
            let payload = { from: wallets[fromIdx].address, to: r.addr, value: ethers.parseEther(r.amt).toString(), chain: net };
            if (asset !== 'native') {
                const t = tokens.find(x => x.address === asset);
                if (!t) { allPass = false; break; }
                const data = new ethers.Interface(['function transfer(address,uint256)'])
                    .encodeFunctionData('transfer', [r.addr, ethers.parseUnits(r.amt, t.decimals)]);
                payload = { from: wallets[fromIdx].address, to: asset, value: '0', data, chain: net };
            }
            const res = await window.omega.simulateTx(payload);
            if (!res.simulation?.success) { allPass = false; break; }
        }
        if (allPass) setStatus(`✅ Batch sim passed — ${v.length} transfers, ${total.toFixed(4)} ${asset === 'native' ? nn.sym : tokens.find(t => t.address === asset)?.symbol}`);
        else if (!status.startsWith('⚠')) setStatus('❌ Batch sim failed — one or more transfers would revert');
    };

    const exec = async () => {
        const v = rows.filter(r => r.addr && r.amt);
        if (!v.length) return setStatus('⚠ Add at least one recipient');
        if (!batchPw) { setBatchErr('Enter vault password to sign batch'); return; }
        setBatchErr('');

        // Fresh-auth once for entire batch
        const auth = await window.omega.auth.freshAuth(batchPw);
        if (!auth.ok) { setBatchErr(auth.error || 'Incorrect password'); return; }
        const token = auth.token;

        setBusy(true); setStatus('⏳ Executing batch via IPC...');
        const hashes = [];
        for (const r of v) {
            let res;
            if (asset === 'native') {
                // Two-phase: prepare then confirm with fresh-auth token
                const prep = await window.omega.prepareTx(
                    { from: wallets[fromIdx].address, to: r.addr, value: ethers.parseEther(r.amt).toString() }, net
                );
                if (!prep.ok) { setStatus(`❌ Prepare failed at tx ${hashes.length + 1}: ${prep.error}`); setBusy(false); return; }
                res = await window.omega.confirmTx(prep.prepareId, token);
            } else {
                res = await window.omega.token.transfer(asset, r.addr, r.amt, net);
            }
            if (res.ok) hashes.push(res.txHash);
            else { setStatus(`❌ Failed at tx ${hashes.length + 1}: ${res.error}`); setBusy(false); return; }
        }
        setStatus(`✅ Batch done! ${hashes.length} txs from ${wallets[fromIdx].label}`);
        setBusy(false); setBatchPw('');
    };

    return (
        <div className="fade-in">
            <div className="page-header"><h2>Batch Transfer</h2>
                <p>Multi-send on {nn.name} — IPC bundled</p></div>
            {family !== 'evm' ? (
                <div className="glass-card" style={{ textAlign: 'center', padding: 40, maxWidth: 500 }}>
                    <div style={{ fontSize: '2rem', marginBottom: 12 }}>📦</div>
                    <div style={{ color: 'var(--text-secondary)' }}>
                        Batch transfers are currently available for EVM chains only.
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 8 }}>
                        Switch to an EVM network in Settings to use batch transfers.
                    </div>
                </div>
            ) : (
                <div className="glass-card" style={{ maxWidth: 600 }}>
                    <div style={{ marginBottom: 16 }}>
                        <WalletPicker wallets={wallets} selected={fromIdx} onChange={setFromIdx} label={`From (${nn.name})`} />
                        <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'block', marginTop: 12 }}>Batch Asset</label>
                        <select className="input" value={asset} onChange={e => setAsset(e.target.value)}
                            style={{ cursor: 'pointer', color: 'var(--text-gold)', background: 'var(--bg-card)', border: '1px solid var(--border-gold)' }}>
                            <option value="native">{nn.sym} (Native) {tokens.find(t => t.address === 'native') ? `— Bal: ${parseFloat(tokens.find(t => t.address === 'native').formatted).toFixed(4)}` : ''}</option>
                            {tokens.filter(t => t.address !== 'native').map((t, i) => (
                                <option key={i} value={t.address}>{t.symbol} — Bal: {parseFloat(t.formatted).toFixed(4)}</option>
                            ))}
                        </select>
                    </div>
                    {rows.map((r, i) => (
                        <div key={i} style={{ marginBottom: 16 }}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                {strictMode ? (
                                    <select className="input" value={r.addr} onChange={e => upd(i, 'addr', e.target.value)} style={{ flex: 3, padding: '8px 12px' }}>
                                        <option value="">Select whitelisted address...</option>
                                        {whitelist.map((w, wi) => (
                                            <option key={wi} value={w.address}>{w.label} ({short(w.address)})</option>
                                        ))}
                                    </select>
                                ) : (
                                    <input className="input" placeholder="0x... recipient" style={{ flex: 3 }}
                                        value={r.addr} onChange={e => upd(i, 'addr', e.target.value)} />
                                )}
                                <input className="input" placeholder={nn.sym} type="number" step="0.001" style={{ flex: 1 }}
                                    value={r.amt} onChange={e => upd(i, 'amt', e.target.value)} />
                                <button className="btn btn-outline btn-sm" onClick={() => rm(i)}
                                    style={{ padding: '8px', minWidth: 36, color: 'var(--accent-danger)' }}>✕</button>
                            </div>
                            {scans[i] && (
                                <div style={{
                                    marginTop: 6, padding: '6px 10px', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem',
                                    background: scans[i].verdict === 'PASS' ? 'rgba(0,230,118,0.06)' :
                                        scans[i].verdict === 'SCANNING' ? 'rgba(255,193,7,0.06)' : 'rgba(255,23,68,0.06)',
                                    border: `1px solid ${scans[i].verdict === 'PASS' ? 'rgba(0,230,118,0.2)' :
                                        scans[i].verdict === 'SCANNING' ? 'rgba(255,193,7,0.2)' : 'rgba(255,23,68,0.2)'}`
                                }}>
                                    <span className={`threat-badge ${scans[i].verdict?.toLowerCase()}`}>
                                        {scans[i].verdict === 'SCANNING' ? '⏳ Scanning...'
                                            : `⛨ ${scans[i].verdict} — Threat: ${scans[i].threatScore}`}
                                    </span>
                                    {scans[i].findings?.length > 0 && (
                                        <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>
                                            {scans[i].findings.map((f, j) => (<div key={j}>• [{f.type}] {f.message}</div>))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    ))}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
                        <button className="btn btn-outline btn-sm" onClick={add}>+ Add Recipient</button>
                        <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                            Total: {total.toFixed(4)} {nn.sym}</div>
                    </div>
                    {status && <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', padding: '8px 0' }}>{status}</div>}
                    <div style={{ marginTop: 12 }}>
                        <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>
                            🔒 Vault password required to execute batch
                        </label>
                        <input type="password" className="input" placeholder="Vault password"
                            value={batchPw} onChange={e => setBatchPw(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && exec()}
                            style={{ width: '100%', padding: '8px 12px', fontSize: '0.85rem', marginBottom: 8 }} />
                        {batchErr && <div style={{ color: 'var(--accent-danger)', fontSize: '0.75rem', marginBottom: 8 }}>✗ {batchErr}</div>}
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        <button className="btn btn-outline" style={{ flex: 1 }} onClick={sim}>Simulate Batch</button>
                        <button className="btn btn-primary" style={{ flex: 2 }} onClick={exec} disabled={busy}>
                            {busy ? '⏳ Executing...' : '🔐 Sign & Execute Batch'}</button>
                    </div>
                </div>
            )}
        </div>
    );
}
