import { useState } from 'react';

export function Onboarding({ onReady }) {
    const [mode, setMode] = useState(null);
    const [pw, setPw] = useState('');
    const [pw2, setPw2] = useState('');
    const [imp, setImp] = useState('');
    const [label, setLabel] = useState('');
    const [err, setErr] = useState('');
    const [seed, setSeed] = useState('');
    const [step, setStep] = useState(1);

    const create = async () => {
        if (pw.length < 8) return setErr('Password must be 8+ characters');
        if (pw !== pw2) return setErr('Passwords do not match');
        setErr('');
        const res = await window.omega.vault.create(pw, label || 'Wallet 1', null);
        if (!res.ok) return setErr(res.error);
        if (res.mnemonic) { setSeed(res.mnemonic); setStep(2); }
        else onReady();
    };

    const confirmSeed = () => onReady();

    const doImport = async () => {
        if (pw.length < 8) return setErr('Password must be 8+ characters');
        setErr('');
        const res = await window.omega.vault.create(pw, label || 'Wallet 1', imp.trim());
        if (!res.ok) return setErr(res.error);
        onReady();
    };

    if (!mode) return (
        <div className="onboarding-container fade-in"><div className="onboarding-card">
            <div className="omega-icon" style={{ width: 64, height: 64, fontSize: '2rem', margin: '0 auto 24px' }}>Ω</div>
            <h1 style={{
                fontSize: '1.8rem', fontWeight: 900, textAlign: 'center', marginBottom: 8,
                background: 'linear-gradient(135deg,var(--gold-300),var(--gold-500))',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent'
            }}>OmegaWallet</h1>
            <p style={{ color: 'var(--text-secondary)', textAlign: 'center', marginBottom: 36, fontSize: '0.85rem' }}>
                State-grade shielded smart wallet</p>
            <button className="btn btn-primary btn-lg" style={{ width: '100%', marginBottom: 12 }}
                onClick={() => setMode('create')}>Create New Wallet</button>
            <button className="btn btn-outline btn-lg" style={{ width: '100%' }}
                onClick={() => setMode('import')}>Import Existing Wallet</button>
        </div></div>
    );

    if (mode === 'create' && step === 2) return (
        <div className="onboarding-container fade-in"><div className="onboarding-card">
            <h2 style={{ marginBottom: 8 }}>Backup Your Seed Phrase</h2>
            <p style={{ color: 'var(--accent-danger)', fontSize: '0.8rem', marginBottom: 16 }}>
                ⚠ Write this down. Anyone with this phrase controls your wallet.</p>
            <div style={{
                background: 'rgba(0,0,0,0.5)', border: '1px solid var(--border-gold)',
                borderRadius: 'var(--radius-md)', padding: 16, marginBottom: 24,
                fontFamily: 'var(--font-mono)', fontSize: '0.9rem', lineHeight: 1.8,
                color: 'var(--gold-300)', wordSpacing: '4px'
            }}>{seed}</div>
            <button className="btn btn-primary btn-lg" style={{ width: '100%' }} onClick={confirmSeed}>
                I've Saved My Seed Phrase</button>
        </div></div>
    );

    return (
        <div className="onboarding-container fade-in"><div className="onboarding-card">
            <button className="btn btn-outline btn-sm" style={{ marginBottom: 24 }}
                onClick={() => { setMode(null); setErr(''); setStep(1); }}>← Back</button>
            <h2 style={{ marginBottom: 20 }}>{mode === 'create' ? 'Create New Wallet' : 'Import Wallet'}</h2>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>
                Wallet Label (optional)</label>
            <input className="input" placeholder="e.g. Main, Trading, Cold..."
                value={label} onChange={e => setLabel(e.target.value)} style={{ marginBottom: 16 }} />
            {mode === 'import' && (<>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>
                    Private Key or Seed Phrase</label>
                <textarea className="input" rows={3} placeholder="0x... or 12-word mnemonic"
                    value={imp} onChange={e => setImp(e.target.value)} style={{ marginBottom: 16, resize: 'none' }} />
            </>)}
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>
                Vault Password (8+ chars)</label>
            <input className="input" type="password" placeholder="••••••••"
                value={pw} onChange={e => setPw(e.target.value)} style={{ marginBottom: 12 }} />
            {mode === 'create' && <input className="input" type="password" placeholder="Confirm password"
                value={pw2} onChange={e => setPw2(e.target.value)} style={{ marginBottom: 16 }} />}
            {err && <div style={{ color: 'var(--accent-danger)', fontSize: '0.8rem', marginBottom: 12 }}>{err}</div>}
            <button className="btn btn-primary btn-lg" style={{ width: '100%' }}
                onClick={mode === 'create' ? create : doImport}>
                {mode === 'create' ? 'Generate Wallet' : 'Import & Encrypt'}</button>
        </div></div>
    );
}
