import { useState, useEffect } from 'react';

/**
 * RpcStatus — Polls network health every 30s through IPC.
 * Only renders when RPC is offline, showing a warning banner.
 * RPC keys are NOT exposed in frontend — health check goes through IPC.
 */
export function RpcStatus({ net }) {
    const [online, setOnline] = useState(true);
    const [lastCheck, setLastCheck] = useState(null);

    useEffect(() => {
        let mounted = true;
        const check = async () => {
            try {
                // Route health check through IPC if available
                if (window.omega?.token) {
                    // Use a lightweight IPC call as health probe
                    await Promise.race([
                        window.omega.getGas(net),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
                    ]);
                    if (mounted) { setOnline(true); setLastCheck(Date.now()); }
                } else {
                    // No IPC, skip check
                    if (mounted) { setOnline(true); setLastCheck(Date.now()); }
                }
            } catch {
                if (mounted) { setOnline(false); setLastCheck(Date.now()); }
            }
        };
        check();
        const interval = setInterval(check, 30000);
        return () => { mounted = false; clearInterval(interval); };
    }, [net]);

    if (online) return null;
    return (
        <div style={{
            background: 'rgba(255,23,68,0.08)', border: '1px solid rgba(255,23,68,0.25)',
            borderRadius: 'var(--radius-sm)', padding: '8px 16px', marginBottom: 16,
            display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.8rem'
        }}>
            <span style={{ color: '#ff1744', fontSize: '1rem' }}>⚠</span>
            <span style={{ color: '#ff8a80' }}>RPC offline — network data may be stale. Retrying every 30s...</span>
            {lastCheck && <span style={{ color: 'var(--text-muted)', marginLeft: 'auto', fontSize: '0.7rem' }}>
                Last check: {new Date(lastCheck).toLocaleTimeString()}</span>}
        </div>
    );
}

export function SecurityOverlay() {
    return (
        <div className="security-overlay">
            <div className="shield-icon safe">⛨</div>
            <div>
                <div style={{ fontSize: '0.8rem', fontWeight: 600 }}>IPC Cleanroom</div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Zero TCP · AES-256</div>
            </div>
        </div>
    );
}
