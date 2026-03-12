import { useState } from 'react';

export function UnlockScreen({ onUnlock, onReset }) {
    const [pw, setPw] = useState('');
    const [err, setErr] = useState('');
    const [showConfirm, setShowConfirm] = useState(false);

    const unlock = async () => {
        const res = await window.omega.vault.unlock(pw);
        if (!res.ok) return setErr(res.error || 'Wrong password');
        onUnlock(res);
    };

    const doReset = async () => {
        await window.omega.vault.destroy();
        onReset();
    };

    return (
        <div className="onboarding-container fade-in"><div className="onboarding-card">
            <div className="omega-icon" style={{ width: 64, height: 64, fontSize: '2rem', margin: '0 auto 24px' }}>Ω</div>
            <h2 style={{ textAlign: 'center', marginBottom: 8 }}>Welcome Back</h2>
            <p style={{ color: 'var(--text-muted)', textAlign: 'center', marginBottom: 24, fontSize: '0.75rem' }}>
                Encrypted ledger · AES-256-GCM</p>
            <input className="input" type="password" placeholder="Enter vault password"
                value={pw} onChange={e => setPw(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && unlock()} style={{ marginBottom: 12 }} />
            {err && <div style={{ color: 'var(--accent-danger)', fontSize: '0.8rem', marginBottom: 12 }}>{err}</div>}
            <button className="btn btn-primary btn-lg" style={{ width: '100%', marginBottom: 12 }} onClick={unlock}>Unlock</button>
            {!showConfirm ? (
                <button className="btn btn-outline btn-sm" style={{ width: '100%' }} onClick={() => setShowConfirm(true)}>Reset Vault</button>
            ) : (
                <div style={{ display: 'flex', gap: 8, width: '100%' }}>
                    <button className="btn btn-outline btn-sm" style={{ flex: 1 }} onClick={() => setShowConfirm(false)}>Cancel</button>
                    <button className="btn btn-danger btn-sm" style={{ flex: 1 }} onClick={doReset}>Delete All Wallets</button>
                </div>
            )}
        </div></div>
    );
}
