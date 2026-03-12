import { createContext, useContext, useState, useEffect } from 'react';

const WalletContext = createContext(null);

/**
 * WalletProvider — Central state for wallets, active index, network, and lock status.
 * Eliminates prop drilling across all view components.
 */
export function WalletProvider({ children }) {
    const [wallets, setWallets] = useState([]);
    const [activeIdx, setActiveIdx] = useState(0);
    const [net, setNet] = useState('ethereum');
    const [state, setState] = useState('loading'); // 'loading' | 'onboard' | 'unlock' | 'ready'

    const changeNet = async (n) => {
        setNet(n);
        if (window.omega?.updateSettings) {
            await window.omega.updateSettings({ network: n });
        }
    };

    const refreshWallets = async () => {
        const r = await window.omega.vault.getWallets();
        if (r.ok) {
            setWallets(r.wallets);
            setActiveIdx(r.active);
        }
    };

    const lock = async () => {
        await window.omega.vault.lock();
        setWallets([]);
        setState('unlock');
    };

    const reset = async () => {
        await window.omega.vault.destroy();
        setWallets([]);
        setState('onboard');
    };

    const onCreated = () => {
        window.omega.vault.getWallets().then(r => {
            if (r.ok) {
                setWallets(r.wallets);
                setActiveIdx(r.active || 0);
                setState('ready');
            }
        });
    };

    const onUnlocked = (res) => {
        setWallets(res.wallets);
        setActiveIdx(res.active || 0);
        setState('ready');
        if (window.omega?.vault?.signalUnlocked) {
            window.omega.vault.signalUnlocked();
        }
    };

    // Check vault state on mount
    useEffect(() => {
        if (!window.omega) {
            setState('onboard');
            return;
        }
        window.omega.vault.exists().then(exists => {
            setState(exists ? 'unlock' : 'onboard');
        });
    }, []);

    // Load persisted network on ready
    useEffect(() => {
        if (state === 'ready') {
            window.omega.getSettings().then(r => {
                if (r.ok && r.settings?.network) setNet(r.settings.network);
            });
        }
    }, [state]);

    // Auto-Lock listener
    useEffect(() => {
        if (state !== 'ready' || !window.omega?.vault?.onAutoLocked) return;
        window.omega.vault.onAutoLocked(() => {
            setWallets([]);
            setState('unlock');
        });
    }, [state]);

    return (
        <WalletContext.Provider value={{
            wallets, setWallets, activeIdx, setActiveIdx,
            net, setNet: changeNet, state, setState,
            refreshWallets, lock, reset, onCreated, onUnlocked,
        }}>
            {children}
        </WalletContext.Provider>
    );
}

/** Hook to consume wallet context. */
export function useWallet() {
    const ctx = useContext(WalletContext);
    if (!ctx) throw new Error('useWallet must be used within WalletProvider');
    return ctx;
}
