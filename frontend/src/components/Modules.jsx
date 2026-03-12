import { useState } from 'react';

export function Modules() {
    const [mods, setMods] = useState([
        { name: 'Session Keys', icon: '🔑', desc: 'Time-bounded, spend-limited ephemeral keys', on: true, color: '#d4a017' },
        { name: 'Social Recovery', icon: '🛡', desc: 'N-of-M guardian threshold + 48h timelock', on: true, color: '#00e676' },
        { name: 'Batch Executor', icon: '📦', desc: 'Atomic multi-wallet distribution', on: true, color: '#ffc107' },
        { name: 'Spend Limit', icon: '🚫', desc: 'Per-period account-wide spending guard', on: true, color: '#ff9100' },
        { name: 'Intent Engine', icon: '🎯', desc: 'ERC-7683 cleanroom intent execution', on: true, color: '#00b0ff' },
        { name: 'Stealth Addresses', icon: '👻', desc: 'ERC-5564 one-time receive addresses', on: true, color: '#b8860b' },
        { name: 'Protocol Zero', icon: '🔴', desc: 'Duress sweep — panic button to cold vault', on: false, color: '#ff1744' },
        { name: 'Paymaster', icon: '⛽', desc: 'B2B gas sponsorship with margin', on: true, color: '#ffd54f' },
    ]);
    const toggle = i => { const u = [...mods]; u[i].on = !u[i].on; setMods(u); };

    return (
        <div className="fade-in">
            <div className="page-header"><h2>Module Loadout</h2>
                <p>ERC-7579 modular architecture — click to install/uninstall</p></div>
            <div className="module-grid">
                {mods.map((m, i) => (
                    <div key={i} className="glass-card module-card" onClick={() => toggle(i)} style={{ cursor: 'pointer' }}>
                        <div className="module-icon" style={{ background: `${m.color}20`, color: m.color }}>{m.icon}</div>
                        <div className="module-name">{m.name}</div>
                        <div className="module-desc">{m.desc}</div>
                        <div className={`module-status ${m.on ? 'active' : 'inactive'}`}>
                            {m.on ? '● Installed' : '○ Click to Install'}</div>
                    </div>
                ))}
            </div>
        </div>
    );
}
