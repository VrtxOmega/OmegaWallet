import { useState, useEffect } from 'react';

// ═════════════════════════════════════════════════════════════
// TOAST SYSTEM — Fire-and-forget notifications
// Singleton pattern: toast.success/error/warning/info callable from anywhere.
// ═════════════════════════════════════════════════════════════

let _toastId = 0;
let _toastListeners = [];

export const toast = {
    _emit(type, msg) {
        const id = ++_toastId;
        _toastListeners.forEach(fn => fn({ id, type, msg }));
        return id;
    },
    success: (msg) => toast._emit('success', msg),
    error: (msg) => toast._emit('error', msg),
    warning: (msg) => toast._emit('warning', msg),
    info: (msg) => toast._emit('info', msg),
};

export function Toaster() {
    const [items, setItems] = useState([]);
    useEffect(() => {
        const handler = (t) => {
            setItems(prev => [...prev, t]);
            setTimeout(() => {
                setItems(prev => prev.map(x => x.id === t.id ? { ...x, exiting: true } : x));
                setTimeout(() => setItems(prev => prev.filter(x => x.id !== t.id)), 250);
            }, 3000);
        };
        _toastListeners.push(handler);
        return () => { _toastListeners = _toastListeners.filter(fn => fn !== handler); };
    }, []);
    if (!items.length) return null;
    return (
        <div className="toast-container">
            {items.map(t => (
                <div key={t.id} className={`toast ${t.type} ${t.exiting ? 'exiting' : ''}`}>
                    <span>{t.type === 'success' ? '✓' : t.type === 'error' ? '✕' : t.type === 'warning' ? '⚠' : 'ℹ'}</span>
                    {t.msg}
                </div>
            ))}
        </div>
    );
}
