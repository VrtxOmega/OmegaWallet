import { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { N } from '../lib/networks';
import { WalletPicker } from './Sidebar';

export function Send({ wallets, net }) {
    const [fromIdx, setFromIdx] = useState(0);
    const [to, setTo] = useState('');
    const [amt, setAmt] = useState('');
    const [asset, setAsset] = useState('native');
    const [tokens, setTokens] = useState([]);
    const [scanning, setScanning] = useState(false);
    const [scan, setScan] = useState(null);
    const [status, setStatus] = useState('');
    const [sending, setSending] = useState(false);
    const [showConfirm, setShowConfirm] = useState(false);
    const [btcFees, setBtcFees] = useState(null);
    const [btcFeeTier, setBtcFeeTier] = useState('halfHour');
    const [copyFeedback, setCopyFeedback] = useState('');
    const [gasInfo, setGasInfo] = useState(null);
    const [contacts, setContacts] = useState([]);
    const [showContacts, setShowContacts] = useState(false);
    const [sendPw, setSendPw] = useState('');
    const [sendErr, setSendErr] = useState('');
    const [prepareId, setPrepareId] = useState(null);
    const [txSummary, setTxSummary] = useState(null);
    const [txSimulation, setTxSimulation] = useState(null);
    const nn = N(net);
    const family = nn.family || 'evm';

    // Fetch EVM tokens for asset picker
    useEffect(() => {
        if (family !== 'evm') return;
        if (window.omega?.token && wallets[fromIdx]) {
            window.omega.token.getBalances(wallets[fromIdx].address, net).then(r => {
                if (r.ok) setTokens(r.balances);
            });
        }
    }, [fromIdx, net]);

    // BTC fee estimation
    useEffect(() => {
        if (family !== 'btc') return;
        window.omega?.btc?.getFees().then(r => { if (r.ok) setBtcFees(r.fees); });
    }, [net]);

    // Fetch address book contacts
    useEffect(() => {
        if (window.omega?.addressbook) {
            window.omega.addressbook.list().then(r => {
                if (r.ok) setContacts(r.contacts || []);
            });
        }
    }, []);

    // Cerberus scan for EVM addresses
    useEffect(() => {
        if (family !== 'evm') { setScan(null); return; }
        if (to && ethers.isAddress(to)) {
            setScanning(true); setScan(null);
            window.omega.scanContract(to, net).then(r => { setScan(r); setScanning(false); });
        } else { setScan(null); }
    }, [to, net]);

    const cp = (txt) => {
        navigator.clipboard.writeText(txt);
        setCopyFeedback('✓ Copied');
        setTimeout(() => setCopyFeedback(''), 1500);
    };

    // ── MAX button: fill max available balance ─────────────
    const fillMax = async () => {
        if (family === 'btc') {
            const res = await window.omega.btc.deriveAddress(fromIdx);
            if (res.ok) {
                const bal = await window.omega.btc.getBalance(res.address);
                if (bal.ok) setAmt((bal.balance.confirmed / 1e8).toFixed(8));
            }
        } else if (family === 'sol') {
            const res = await window.omega.sol.deriveAddress(fromIdx);
            if (res.ok) {
                const bal = await window.omega.sol.getBalance(res.address);
                if (bal.ok) setAmt(Math.max(0, bal.balance.sol - 0.005).toFixed(6)); // Reserve 0.005 SOL for fees
            }
        } else {
            const nativeBal = tokens.find(b => b.address === 'native');
            if (asset === 'native' && nativeBal) {
                // Reserve 0.005 for gas
                setAmt(Math.max(0, parseFloat(nativeBal.formatted) - 0.005).toFixed(6));
            } else {
                const t = tokens.find(b => b.address === asset);
                if (t) setAmt(parseFloat(t.formatted).toFixed(6));
            }
        }
    };

    // ── EVM Send ──────────────────────────────────────────────
    const doSim = async () => {
        if (!to || !amt) return setStatus('⚠ Fill in recipient and amount');
        if (!ethers.isAddress(to)) return setStatus('⚠ Invalid EVM address');
        if (parseFloat(amt) <= 0) return setStatus('⚠ Amount must be greater than 0');
        setStatus('⏳ Simulating via IPC...');
        let payload = { from: wallets[fromIdx].address, to, value: ethers.parseEther(amt).toString(), chain: net };
        if (asset !== 'native') {
            const t = tokens.find(x => x.address === asset);
            if (!t) return setStatus('⚠ Token not found');
            const data = new ethers.Interface(['function transfer(address,uint256)'])
                .encodeFunctionData('transfer', [to, ethers.parseUnits(amt, t.decimals)]);
            payload = { from: wallets[fromIdx].address, to: asset, value: '0', data, chain: net };
        }
        const r = await window.omega.simulateTx(payload);
        if (r.simulation?.success) {
            setStatus(`✅ Simulation passed — Gas: ${r.simulation.gasEstimate}`);
        } else {
            const reason = r.simulation?.revertReason || r.simulation?.warnings?.[0]?.message || 'Unknown';
            setStatus(`❌ Would fail: ${reason}`);
        }
    };

    const doSendEVM = async () => {
        if (!sendPw) { setSendErr('Enter vault password to sign'); return; }
        setSending(true); setStatus('⏳ Signing via IPC cleanroom...'); setSendErr('');
        let r;
        if (asset === 'native' && prepareId) {
            // Two-phase: confirm prepared tx with fresh auth
            r = await window.omega.confirmTx(prepareId, sendPw);
        } else if (asset === 'native') {
            // Fallback legacy
            r = await window.omega.submitUserOp({ from: wallets[fromIdx].address, to, value: ethers.parseEther(amt).toString() }, net);
        } else {
            r = await window.omega.token.transfer(asset, to, amt, net);
        }
        if (r.ok) {
            const spendTxt = r.spendStatus ? ` · Spend: ${r.spendStatus.spent}/${r.spendStatus.limit}` : '';
            setStatus(`✅ Sent! TX: ${r.txHash.slice(0, 10)}...${r.txHash.slice(-8)}${spendTxt}`);
            setSendPw(''); setPrepareId(null); setTxSummary(null); setTxSimulation(null);
        } else {
            setSendErr(r.error || 'Transaction failed');
            setStatus(`❌ ${r.error}`);
        }
        setSending(false); setShowConfirm(false);
    };

    // ── BTC Send ──────────────────────────────────────────────
    const doSendBTC = async () => {
        setSending(true); setStatus('⏳ Building BTC transaction...');
        try {
            const feeRate = btcFees ? btcFees[btcFeeTier] : 5;
            const sats = Math.round(parseFloat(amt) * 1e8);
            const r = await window.omega.btc.send(fromIdx, to, sats, feeRate);
            if (r.ok) {
                setStatus(`✅ BTC Sent! TX: ${r.txHash.slice(0, 10)}...${r.txHash.slice(-8)} · Fee: ${r.fee} sats`);
            } else {
                setStatus(`❌ ${r.error}`);
            }
        } catch (e) { setStatus(`❌ ${e.message}`); }
        setSending(false); setShowConfirm(false);
    };

    // ── SOL Send ──────────────────────────────────────────────
    const doSendSOL = async () => {
        setSending(true); setStatus('⏳ Building SOL transaction...');
        try {
            const r = await window.omega.sol.send(fromIdx, to, parseFloat(amt));
            if (r.ok) {
                setStatus(`✅ SOL Sent! TX: ${r.txHash.slice(0, 12)}...`);
            } else {
                setStatus(`❌ ${r.error}`);
            }
        } catch (e) { setStatus(`❌ ${e.message}`); }
        setSending(false); setShowConfirm(false);
    };

    // ── Confirmation gate ─────────────────────────────────────
    const requestSend = async () => {
        if (!to || !amt) return setStatus('⚠ Fill in recipient and amount');
        if (parseFloat(amt) <= 0) return setStatus('⚠ Amount must be greater than 0');
        if (family === 'evm' && !ethers.isAddress(to)) return setStatus('⚠ Invalid EVM address');
        if (family === 'evm' && scan?.verdict === 'BLOCK') return setStatus('🚫 Cerberus BLOCKED this target');
        // Fetch gas estimation for EVM
        if (family === 'evm') {
            setGasInfo(null);
            let payload = { from: wallets[fromIdx].address, to, value: asset === 'native' ? ethers.parseEther(amt || '0').toString() : '0', chain: net };
            if (asset !== 'native') {
                const t = tokens.find(x => x.address === asset);
                if (t) {
                    const data = new ethers.Interface(['function transfer(address,uint256)'])
                        .encodeFunctionData('transfer', [to, ethers.parseUnits(amt, t.decimals)]);
                    payload = { ...payload, to: asset, data };
                }
            }
            window.omega.gasEstimate(payload).then(g => { if (g.ok) setGasInfo(g); });
        }
        // For EVM native sends, call prepareTx to get main-process-built summary
        if (family === 'evm' && asset === 'native') {
            const prep = await window.omega.prepareTx(
                { from: wallets[fromIdx].address, to, value: ethers.parseEther(amt).toString() }, net
            );
            if (prep.ok) {
                setPrepareId(prep.prepareId);
                setTxSummary(prep.summary);
                setTxSimulation(prep.simulation || null);
            } else {
                setStatus(`❌ ${prep.error}`); return;
            }
        }
        setSendPw(''); setSendErr('');
        setShowConfirm(true);
    };

    const confirmSend = () => {
        if (family === 'btc') return doSendBTC();
        if (family === 'sol') return doSendSOL();
        return doSendEVM();
    };

    const addressPlaceholder = family === 'btc' ? 'bc1...' : family === 'sol' ? 'Base58 address...' : '0x...';
    const amountLabel = family === 'btc' ? 'Amount (BTC)' : `Amount (${asset === 'native' ? nn.sym : tokens.find(t => t.address === asset)?.symbol || ''})`;

    return (
        <div className="fade-in">
            <div className="page-header"><h2>Send</h2>
                <p>Transfer {nn.sym} on {nn.name}
                    {family === 'evm' && ' — Cerberus + Simulator pre-flight'}
                    {family === 'btc' && ' — BIP84 SegWit · Blockstream'}
                    {family === 'sol' && ' — Ed25519 · Solana RPC'}
                </p></div>
            <div className="glass-card" style={{ maxWidth: 500 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <WalletPicker wallets={wallets} selected={fromIdx} onChange={setFromIdx} label={`From (${nn.name})`} />
                    <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Recipient</label>
                    <div style={{ display: 'flex', gap: 8, position: 'relative' }}>
                        <input className="input" placeholder={addressPlaceholder} value={to} onChange={e => { setTo(e.target.value); setShowContacts(false); }} style={{ flex: 1 }} />
                        <button className="btn btn-outline btn-sm" title="Pick from contacts"
                            onClick={() => setShowContacts(!showContacts)}
                            style={{ padding: '8px 10px', fontSize: '1rem' }}>
                            📇
                        </button>
                        <div style={{ display: 'flex', alignItems: 'center', minWidth: 32 }}>
                            {scanning && <span style={{ color: 'var(--gold-300)' }}>⏳</span>}
                        </div>
                        {showContacts && contacts.length > 0 && (
                            <div className="contact-picker">
                                {contacts.map(c => (
                                    <div key={c.address} className="contact-picker-item"
                                        onClick={() => {
                                            setTo(c.address);
                                            setShowContacts(false);
                                            if (window.omega?.addressbook?.touch) window.omega.addressbook.touch(c.address);
                                        }}>
                                        <div style={{ fontWeight: 600, fontSize: '0.8rem', color: 'var(--text-primary)' }}>{c.label}</div>
                                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: 'var(--text-gold)' }}>
                                            {c.address.slice(0, 10)}...{c.address.slice(-6)}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                        {showContacts && contacts.length === 0 && (
                            <div className="contact-picker" style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                                No contacts yet. Add some in Address Book.
                            </div>
                        )}
                    </div>
                    {scan && family === 'evm' && (
                        <div style={{
                            padding: 12, borderRadius: 'var(--radius-md)',
                            background: scan.verdict === 'PASS' ? 'rgba(0,230,118,0.06)' : scan.verdict === 'WARN' ? 'rgba(255,193,7,0.06)' : 'rgba(255,23,68,0.06)',
                            border: `1px solid ${scan.verdict === 'PASS' ? 'rgba(0,230,118,0.2)' : 'rgba(255,23,68,0.2)'}`
                        }}>
                            <span className={`threat-badge ${scan.verdict?.toLowerCase()}`}>
                                ⛨ {scan.verdict} — Threat: {scan.threatScore}</span>
                            {scan.findings?.length > 0 && (
                                <div style={{ marginTop: 8, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                    {scan.findings.map((f, i) => (<div key={i}>• [{f.type}] {f.message}</div>))}
                                </div>
                            )}
                        </div>
                    )}
                    {family === 'evm' && (
                        <>
                            <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Asset</label>
                            <select className="input" value={asset} onChange={e => setAsset(e.target.value)}
                                style={{ cursor: 'pointer', color: 'var(--text-gold)', background: 'var(--bg-card)', border: '1px solid var(--border-gold)' }}>
                                <option value="native">{nn.sym} (Native) {tokens.find(t => t.address === 'native') ? `— Bal: ${parseFloat(tokens.find(t => t.address === 'native').formatted).toFixed(4)}` : ''}</option>
                                {tokens.filter(t => t.address !== 'native').map((t, i) => (
                                    <option key={i} value={t.address}>{t.symbol} — Bal: {parseFloat(t.formatted).toFixed(4)}</option>
                                ))}
                            </select>
                        </>
                    )}
                    {/* BTC Fee Tier Selector */}
                    {family === 'btc' && btcFees && (
                        <>
                            <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Fee Priority</label>
                            <div style={{ display: 'flex', gap: 6 }}>
                                {[
                                    ['fastest', '🚀 Fast', btcFees.fastest],
                                    ['halfHour', '⚡ Normal', btcFees.halfHour],
                                    ['hour', '⏱ Slow', btcFees.hour],
                                    ['economy', '🐢 Economy', btcFees.economy],
                                ].map(([key, label, rate]) => (
                                    <button key={key}
                                        className={`btn btn-sm ${btcFeeTier === key ? 'btn-primary' : 'btn-outline'}`}
                                        onClick={() => setBtcFeeTier(key)}
                                        style={{ flex: 1, fontSize: '0.7rem', padding: '6px 4px' }}>
                                        {label}<br /><span style={{ fontSize: '0.6rem', opacity: 0.7 }}>{rate} sat/vB</span>
                                    </button>
                                ))}
                            </div>
                        </>
                    )}
                    <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                        {amountLabel}
                    </label>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <input className="input" placeholder="0.0" type="number" step="0.001"
                            value={amt} onChange={e => setAmt(e.target.value)} style={{ flex: 1 }} />
                        <button className="btn btn-outline btn-sm" onClick={fillMax}
                            style={{ minWidth: 50, fontSize: '0.7rem', fontWeight: 700 }}>MAX</button>
                    </div>
                    {status && <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', padding: '4px 0' }}>{status}</div>}
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        {family === 'evm' && (
                            <button className="btn btn-outline btn-sm" style={{ flex: 1 }} onClick={doSim}>Simulate</button>
                        )}
                        <button className="btn btn-primary" style={{ flex: 2 }} onClick={requestSend} disabled={sending}>
                            {sending ? '⏳ Sending...' : `Sign & Send ${nn.sym}`}</button>
                    </div>
                </div>
            </div>

            {/* ── Confirmation Modal ────────────────────────── */}
            {showConfirm && (
                <div style={{
                    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                    background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    zIndex: 9999,
                }}>
                    <div className="glass-card" style={{
                        maxWidth: 420, width: '90%',
                        border: '2px solid var(--accent-gold)',
                        boxShadow: '0 0 40px rgba(212,160,23,0.2)',
                    }}>
                        <div style={{ textAlign: 'center', marginBottom: 20 }}>
                            <div style={{ fontSize: '2rem', marginBottom: 8 }}>⚠️</div>
                            <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-gold)' }}>
                                Confirm Transaction
                            </div>
                        </div>
                        <div style={{
                            background: 'rgba(0,0,0,0.3)', borderRadius: 'var(--radius-sm)',
                            padding: 16, marginBottom: 16,
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                                <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Network</span>
                                <span style={{ color: 'var(--text-gold)', fontSize: '0.8rem', fontWeight: 700 }}>{nn.name}</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                                <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>From</span>
                                <span style={{ color: 'var(--text-primary)', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>
                                    {wallets[fromIdx]?.label}
                                </span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                                <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>To</span>
                                <span style={{ color: 'var(--text-primary)', fontSize: '0.7rem', fontFamily: 'var(--font-mono)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}
                                    onClick={() => cp(to)} title="Click to copy">
                                    {to.slice(0, 12)}...{to.slice(-8)} 📋
                                </span>
                            </div>
                            <div style={{
                                display: 'flex', justifyContent: 'space-between', padding: '12px 0 0',
                                borderTop: '1px solid rgba(212,160,23,0.15)',
                            }}>
                                <span style={{ color: 'var(--text-gold)', fontSize: '1rem', fontWeight: 700 }}>Amount</span>
                                <span style={{ color: 'var(--text-primary)', fontSize: '1.1rem', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                                    {amt} {nn.sym}
                                </span>
                            </div>
                            {family === 'btc' && btcFees && (
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
                                    <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Fee rate</span>
                                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                                        {btcFees[btcFeeTier]} sat/vB ({btcFeeTier})
                                    </span>
                                </div>
                            )}
                            {family === 'evm' && gasInfo && (
                                <div style={{
                                    marginTop: 8, padding: '8px 0',
                                    borderTop: '1px solid rgba(212,160,23,0.1)',
                                }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                                        <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Gas</span>
                                        <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                                            {parseInt(gasInfo.gasUnits).toLocaleString()} units
                                        </span>
                                    </div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                                        <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Gas Price</span>
                                        <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                                            {parseFloat(gasInfo.gasPriceGwei).toFixed(2)} gwei
                                        </span>
                                    </div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <span style={{ color: 'var(--text-gold)', fontSize: '0.8rem', fontWeight: 700 }}>Est. Cost</span>
                                        <span style={{ color: 'var(--text-primary)', fontSize: '0.8rem', fontWeight: 700 }}>
                                            {parseFloat(gasInfo.costEth).toFixed(6)} ETH (~${gasInfo.costUsd})
                                        </span>
                                    </div>
                                </div>
                            )}
                            {family === 'evm' && !gasInfo && (
                                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 8, textAlign: 'center' }}>
                                    ⏳ Estimating gas...
                                </div>
                            )}
                        </div>
                            {copyFeedback && (
                                <div style={{ textAlign: 'center', fontSize: '0.75rem', color: 'var(--accent-success)', marginBottom: 8 }}>
                                    {copyFeedback}
                                </div>
                            )}
                            {txSummary && (
                                <div style={{
                                    background: 'rgba(0,230,118,0.04)', border: '1px solid rgba(0,230,118,0.15)',
                                    borderRadius: 'var(--radius-sm)', padding: '8px 12px', marginBottom: 12,
                                    fontSize: '0.7rem', color: 'var(--text-muted)'
                                }}>
                                    🛡️ Built by: {txSummary.builtBy} · {txSummary.network}
                                </div>
                            )}
                            {txSimulation && txSimulation.riskLevel !== 'NONE' && (
                                <div style={{
                                    background: txSimulation.riskLevel === 'CRITICAL' ? 'rgba(244,67,54,0.08)' :
                                        txSimulation.riskLevel === 'HIGH' ? 'rgba(255,152,0,0.08)' :
                                        'rgba(255,235,59,0.06)',
                                    border: `1px solid ${txSimulation.riskLevel === 'CRITICAL' ? 'rgba(244,67,54,0.4)' :
                                        txSimulation.riskLevel === 'HIGH' ? 'rgba(255,152,0,0.3)' :
                                        'rgba(255,235,59,0.25)'}`,
                                    borderRadius: 'var(--radius-sm)', padding: '10px 12px', marginBottom: 12,
                                }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                        <span style={{
                                            fontSize: '0.65rem', fontWeight: 700,
                                            padding: '2px 8px', borderRadius: 4,
                                            background: txSimulation.riskLevel === 'CRITICAL' ? '#f44336' :
                                                txSimulation.riskLevel === 'HIGH' ? '#ff9800' :
                                                txSimulation.riskLevel === 'MEDIUM' ? '#ffc107' : '#4caf50',
                                            color: txSimulation.riskLevel === 'MEDIUM' ? '#000' : '#fff',
                                        }}>{txSimulation.riskLevel} RISK</span>
                                        <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                            Transaction Simulation
                                        </span>
                                        {txSimulation.recommendation === 'REJECT' && (
                                            <span style={{ fontSize: '0.65rem', color: '#f44336', fontWeight: 700, marginLeft: 'auto' }}>
                                                ❌ REJECT RECOMMENDED
                                            </span>
                                        )}
                                    </div>
                                    <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                                        <div style={{ fontWeight: 600, marginBottom: 4 }}>Predicted actions:</div>
                                        {(txSimulation.actions || []).map((a, i) => (
                                            <div key={i} style={{
                                                padding: '3px 0', display: 'flex', alignItems: 'flex-start', gap: 6,
                                            }}>
                                                <span>{a.risk === 'CRITICAL' ? '🔴' : a.risk === 'HIGH' ? '🟠' : a.risk === 'MEDIUM' ? '🟡' : '🟢'}</span>
                                                <span>{a.description}</span>
                                            </div>
                                        ))}
                                    </div>
                                    {txSimulation.warnings?.length > 0 && (
                                        <div style={{ marginTop: 6 }}>
                                            {txSimulation.warnings.map((w, i) => (
                                                <div key={i} style={{
                                                    fontSize: '0.68rem', padding: '2px 0',
                                                    color: w.type === 'critical' ? '#f44336' : 'var(--text-muted)',
                                                }}>⚠ {w.message}</div>
                                            ))}
                                        </div>
                                    )}
                                    <div style={{ marginTop: 6, fontSize: '0.6rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                                        Confidence: {txSimulation.confidence} · Actual chain execution may differ
                                    </div>
                                </div>
                            )}
                            <div style={{ marginBottom: 12 }}>
                                <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>
                                    🔒 Vault password required to sign
                                </label>
                                <input type="password" className="input" placeholder="Vault password"
                                    value={sendPw} onChange={e => setSendPw(e.target.value)}
                                    onKeyDown={e => e.key === 'Enter' && confirmSend()}
                                    style={{ width: '100%', padding: '8px 12px', fontSize: '0.85rem' }} autoFocus />
                                {sendErr && <div style={{ color: 'var(--accent-danger)', fontSize: '0.75rem', marginTop: 6 }}>✗ {sendErr}</div>}
                            </div>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button className="btn btn-outline" style={{ flex: 1 }}
                                    onClick={() => { setShowConfirm(false); setSendPw(''); setSendErr(''); setPrepareId(null); setTxSummary(null); setTxSimulation(null); }}>Cancel</button>
                                <button className="btn btn-primary" style={{ flex: 2 }}
                                    onClick={confirmSend} disabled={sending}>
                                    {sending ? '⏳ Signing...' : '🔐 Confirm & Sign'}
                                </button>
                            </div>
                    </div>
                </div>
            )}
        </div>
    );
}
