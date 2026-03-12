import { useState } from 'react';
import { N, short } from '../lib/networks';

function DropGroup({ label, icon, items, view, setView, defaultOpen }) {
    const [open, setOpen] = useState(defaultOpen || items.some(i => i.id === view));
    const hasActive = items.some(i => i.id === view);

    return (
        <div className="nav-group">
            <button
                className={`nav-group-header ${hasActive ? 'has-active' : ''}`}
                onClick={() => setOpen(!open)}
            >
                <span className="nav-group-icon">{icon}</span>
                <span className="nav-group-label">{label}</span>
                <span className={`nav-chevron ${open ? 'open' : ''}`}>›</span>
            </button>
            {open && (
                <div className="nav-group-items">
                    {items.map(i => (
                        <button key={i.id}
                            className={`nav-item nav-sub ${view === i.id ? 'active' : ''}`}
                            onClick={() => setView(i.id)}>
                            <span>{i.icon}</span>{i.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

export function Sidebar({ view, setView, wallets, activeIdx, net }) {
    const active = wallets[activeIdx];

    return (
        <aside className="sidebar">
            <div className="sidebar-logo">
                <div className="omega-icon">Ω</div><h1>OmegaWallet</h1>
            </div>
            <nav>
                {/* ── Always visible ──────────────────────────── */}
                <button className={`nav-item ${view === 'dashboard' ? 'active' : ''}`}
                    onClick={() => setView('dashboard')}><span>◆</span>Dashboard</button>
                <button className={`nav-item ${view === 'buy' ? 'active' : ''}`}
                    onClick={() => setView('buy')}><span>💳</span>Buy</button>
                <button className={`nav-item ${view === 'send' ? 'active' : ''}`}
                    onClick={() => setView('send')}><span>↗</span>Send</button>
                <button className={`nav-item ${view === 'receive' ? 'active' : ''}`}
                    onClick={() => setView('receive')}><span>📥</span>Receive</button>
                <button className={`nav-item ${view === 'swap' ? 'active' : ''}`}
                    onClick={() => setView('swap')}><span>🔄</span>Swap</button>
                <button className={`nav-item ${view === 'history' ? 'active' : ''}`}
                    onClick={() => setView('history')}><span>⏱</span>History</button>

                <div className="nav-divider" />

                {/* ── Assets dropdown ─────────────────────────── */}
                <DropGroup label="Assets" icon="💎" view={view} setView={setView} items={[
                    { id: 'nfts', icon: '🖼', label: 'NFTs' },
                    { id: 'batch', icon: '⫘', label: 'Batch Transfer' },
                    { id: 'approvals', icon: '🛡', label: 'Approvals' },
                ]} />

                {/* ── Connect dropdown ────────────────────────── */}
                <DropGroup label="Connect" icon="🔗" view={view} setView={setView} items={[
                    { id: 'dapp-browser', icon: '🌐', label: 'dApp Browser' },
                    { id: 'connect', icon: '📡', label: 'WalletConnect' },
                    { id: 'addressbook', icon: '📇', label: 'Contacts' },
                ]} />

                {/* ── Tools dropdown ──────────────────────────── */}
                <DropGroup label="Tools" icon="⛨" view={view} setView={setView} items={[
                    { id: 'security', icon: '🔒', label: 'Security' },
                    { id: 'modules', icon: '◫', label: 'Modules' },
                ]} />

                <div className="nav-divider" />

                {/* ── Settings always visible ─────────────────── */}
                <button className={`nav-item ${view === 'settings' ? 'active' : ''}`}
                    onClick={() => setView('settings')}><span>⚙</span>Settings</button>
            </nav>
            <div style={{ marginTop: 'auto', padding: '16px 0' }}>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', padding: '8px 16px' }}>
                    {active?.label || 'Wallet'}<br />
                    {short(active?.address)}<br />
                    {wallets.length} wallet{wallets.length !== 1 ? 's' : ''}<br />
                    {N(net).name} · Chain {N(net).id}<br />
                    Shield: Active
                </div>
            </div>
        </aside>
    );
}

export function WalletPicker({ wallets, selected, onChange, label }) {
    if (wallets.length <= 1) {
        return (
            <div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 4 }}>{label || 'From'}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--text-gold)', padding: '4px 0' }}>
                    {wallets[0]?.label} — {short(wallets[0]?.address)}</div>
            </div>
        );
    }
    return (
        <div>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 4 }}>{label || 'From'}</div>
            <select className="input" value={selected} onChange={e => onChange(parseInt(e.target.value))}
                style={{ cursor: 'pointer', color: 'var(--text-gold)', background: 'var(--bg-card)', border: '1px solid var(--border-gold)' }}>
                {wallets.map((w, i) => (
                    <option key={i} value={i} style={{ background: '#111', color: 'var(--gold-300)' }}>
                        {w.label} — {short(w.address)}</option>
                ))}
            </select>
        </div>
    );
}
