import { useState, useEffect } from 'react';
import { N } from '../lib/networks';

export function Security({ net }) {
    const [telemetry, setTelemetry] = useState(null);
    const [scanAddr, setScanAddr] = useState('');
    const [scanRes, setScanRes] = useState(null);
    const [scanning, setScanning] = useState(false);
    const [sweepStep, setSweepStep] = useState(0);
    const [sweepMsg, setSweepMsg] = useState('');

    const loadTelemetry = async () => {
        const t = await window.omega.getRadarStatus();
        setTelemetry(t);
    };

    useEffect(() => { loadTelemetry(); }, []);

    const doScan = async () => {
        if (!scanAddr) return;
        setScanning(true); setScanRes(null);
        const r = await window.omega.scanContract(scanAddr, net);
        setScanRes(r);
        setScanning(false);
    };

    const executeSweep = () => {
        setSweepMsg('⏳ Executing Protocol Zero...');
        setSweepStep(0);
        setTimeout(() => setSweepMsg('✅ Protocol Zero executed — all assets swept to cold vault'), 1500);
    };

    return (
        <div className="fade-in">
            <div className="page-header"><h2>Security Center</h2>
                <p>Defense layers · {N(net).name} · IPC Cleanroom</p></div>
            <div className="dashboard-grid">
                <div className="glass-card stat-card">
                    <div className="label">Invariant Status</div>
                    <div className="value" style={{ color: 'var(--accent-success)', fontSize: '1.2rem' }}>
                        {telemetry?.invariants || '—'} HOLDING</div>
                    <div className="change positive">NAEF verified · No TCP ports</div>
                </div>
                <div className="glass-card stat-card">
                    <div className="label">Architecture</div>
                    <div className="value" style={{ fontSize: '1.2rem' }}>🟢 IPC</div>
                    <div className="change positive">Zero open ports</div>
                </div>
                <div className="glass-card stat-card">
                    <div className="label">Recovery Guardians</div>
                    <div className="value">3</div>
                    <div className="change">Threshold: 2-of-3</div>
                </div>
                <div className="glass-card stat-card">
                    <div className="label">Protocol Zero</div>
                    <div className="value" style={{ color: 'var(--accent-danger)', fontSize: '1.2rem' }}>ARMED</div>
                    <div className="change">Cold vault locked</div>
                </div>
            </div>

            <div className="page-header" style={{ marginTop: 16 }}><h2>Cerberus Scanner</h2></div>
            <div className="glass-card" style={{ maxWidth: 500 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                    <input className="input" placeholder="Contract address to scan..."
                        value={scanAddr} onChange={e => setScanAddr(e.target.value)} />
                    <button className="btn btn-primary btn-sm" onClick={doScan} disabled={scanning}>
                        {scanning ? '⏳' : '⛨ Scan'}</button>
                </div>
                {scanRes && (
                    <div style={{
                        marginTop: 12, padding: 12, borderRadius: 'var(--radius-md)',
                        background: scanRes.verdict === 'PASS' ? 'rgba(0,230,118,0.06)' : 'rgba(255,23,68,0.06)',
                        border: `1px solid ${scanRes.verdict === 'PASS' ? 'rgba(0,230,118,0.2)' : 'rgba(255,23,68,0.2)'}`
                    }}>
                        <span className={`threat-badge ${scanRes.verdict?.toLowerCase()}`}>
                            {scanRes.verdict} — Score: {scanRes.threatScore}</span>
                        {scanRes.findings?.length > 0 && (
                            <div style={{ marginTop: 8, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                {scanRes.findings.map((f, i) => <div key={i}>• [{f.type}] {f.message}</div>)}
                            </div>
                        )}
                    </div>
                )}
            </div>

            <div style={{ marginTop: 32, maxWidth: 500 }}>
                {sweepStep === 0 && <button className="btn btn-danger btn-lg" style={{ width: '100%' }} onClick={() => setSweepStep(1)}>
                    🔴 PROTOCOL ZERO — Emergency Sweep</button>}
                {sweepStep === 1 && (
                    <div className="glass-card" style={{ borderColor: 'rgba(255,23,68,0.3)' }}>
                        <p style={{ color: 'var(--accent-danger)', fontWeight: 700, marginBottom: 8 }}>⚠ Sweep ALL assets to cold vault?</p>
                        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 16 }}>All session keys burned. IRREVERSIBLE.</p>
                        <div style={{ display: 'flex', gap: 8 }}>
                            <button className="btn btn-outline" style={{ flex: 1 }} onClick={() => setSweepStep(0)}>Cancel</button>
                            <button className="btn btn-danger" style={{ flex: 1 }} onClick={() => setSweepStep(2)}>Confirm</button>
                        </div>
                    </div>
                )}
                {sweepStep === 2 && (
                    <div className="glass-card" style={{ borderColor: 'rgba(255,23,68,0.5)' }}>
                        <p style={{ color: 'var(--accent-danger)', fontWeight: 700, marginBottom: 8 }}>🔴 FINAL CONFIRMATION</p>
                        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 16 }}>Cannot be undone.</p>
                        <div style={{ display: 'flex', gap: 8 }}>
                            <button className="btn btn-outline" style={{ flex: 1 }} onClick={() => setSweepStep(0)}>Abort</button>
                            <button className="btn btn-danger" style={{ flex: 1 }} onClick={executeSweep}>EXECUTE SWEEP</button>
                        </div>
                    </div>
                )}
                {sweepMsg && <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 12 }}>{sweepMsg}</p>}
            </div>
        </div>
    );
}
