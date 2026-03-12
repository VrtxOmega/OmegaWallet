import { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { short } from '../lib/networks';

export function AddressBook({ net }) {
    const [contacts, setContacts] = useState([]);
    const [newAddr, setNewAddr] = useState('');
    const [newLabel, setNewLabel] = useState('');
    const [newNotes, setNewNotes] = useState('');
    const [newChain, setNewChain] = useState('all');
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [editing, setEditing] = useState(null);
    const [editLabel, setEditLabel] = useState('');
    const [editNotes, setEditNotes] = useState('');
    const [search, setSearch] = useState('');

    const load = async () => {
        const res = await window.omega.addressbook.list();
        if (res.ok) setContacts(res.contacts);
    };

    useEffect(() => { load(); }, []);

    const handleAdd = async () => {
        if (!newAddr) return setError('Address required');
        if (!ethers.isAddress(newAddr)) return setError('Invalid EVM address');
        setError('');
        const res = await window.omega.addressbook.add({
            address: newAddr, label: newLabel || 'Unnamed',
            chain: newChain, notes: newNotes,
        });
        if (res.ok) {
            setSuccess(`Added (${res.count} contacts)`);
            setNewAddr(''); setNewLabel(''); setNewNotes('');
            load();
        } else { setError(res.error); }
        setTimeout(() => setSuccess(''), 3000);
    };

    const handleRemove = async (address) => {
        const res = await window.omega.addressbook.remove(address);
        if (res.ok) load();
    };

    const handleUpdate = async (address) => {
        const res = await window.omega.addressbook.update(address, { label: editLabel, notes: editNotes });
        if (res.ok) { setEditing(null); load(); }
    };

    const filtered = contacts.filter(c => {
        const q = search.toLowerCase();
        return !q || c.label.toLowerCase().includes(q) || c.address.toLowerCase().includes(q) ||
            c.notes?.toLowerCase().includes(q);
    });

    return (
        <div className="fade-in">
            <div className="page-header">
                <h2>Address Book</h2>
                <p>{contacts.length} contact{contacts.length !== 1 ? 's' : ''}</p>
            </div>

            {/* Add New Contact */}
            <div className="glass-card" style={{ marginBottom: 16 }}>
                <div style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: 12, color: 'var(--text-gold)' }}>
                    ➕ Add Contact
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <input className="input" placeholder="0x... address" value={newAddr}
                        onChange={e => setNewAddr(e.target.value)}
                        style={{ flex: 2, minWidth: 200, fontSize: '0.8rem' }} />
                    <input className="input" placeholder="Label" value={newLabel}
                        onChange={e => setNewLabel(e.target.value)}
                        style={{ flex: 1, minWidth: 120, fontSize: '0.8rem' }} />
                    <select className="input" value={newChain} onChange={e => setNewChain(e.target.value)}
                        style={{ width: 100, fontSize: '0.8rem', background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-gold)' }}>
                        <option value="all">All Chains</option>
                        <option value="ethereum">Ethereum</option>
                        <option value="base">Base</option>
                        <option value="arbitrum">Arbitrum</option>
                        <option value="solana">Solana</option>
                        <option value="bitcoin">Bitcoin</option>
                    </select>
                </div>
                <input className="input" placeholder="Notes (optional)" value={newNotes}
                    onChange={e => setNewNotes(e.target.value)}
                    style={{ marginTop: 8, width: '100%', fontSize: '0.8rem' }} />
                <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                    <button className="btn btn-primary btn-sm" onClick={handleAdd}
                        style={{ fontSize: '0.8rem' }}>
                        Save Contact
                    </button>
                    {error && <span style={{ color: '#ff1744', fontSize: '0.75rem' }}>⚠ {error}</span>}
                    {success && <span style={{ color: '#00e676', fontSize: '0.75rem' }}>✅ {success}</span>}
                </div>
            </div>

            {/* Search */}
            {contacts.length > 3 && (
                <input className="input" placeholder="🔍 Search contacts..."
                    value={search} onChange={e => setSearch(e.target.value)}
                    style={{ width: '100%', marginBottom: 16, fontSize: '0.8rem' }} />
            )}

            {/* Contact List */}
            {filtered.length === 0 && contacts.length === 0 && (
                <div className="glass-card" style={{ textAlign: 'center', padding: 40 }}>
                    <div style={{ fontSize: '3rem', opacity: 0.3 }}>📇</div>
                    <div style={{ color: 'var(--text-secondary)', fontWeight: 600, marginTop: 8 }}>
                        No contacts yet
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 8 }}>
                        Add addresses you frequently send to. They'll appear as options when sending tokens or NFTs.
                    </div>
                </div>
            )}

            {filtered.map(c => (
                <div key={c.address} className="glass-card" style={{
                    marginBottom: 8, padding: '12px 16px',
                    border: editing === c.address ? '1px solid var(--accent-gold)' : undefined,
                }}>
                    {editing === c.address ? (
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <input className="input" value={editLabel} onChange={e => setEditLabel(e.target.value)}
                                placeholder="Label" style={{ flex: 1, fontSize: '0.8rem' }} />
                            <input className="input" value={editNotes} onChange={e => setEditNotes(e.target.value)}
                                placeholder="Notes" style={{ flex: 2, fontSize: '0.8rem' }} />
                            <button className="btn btn-primary btn-sm" onClick={() => handleUpdate(c.address)}
                                style={{ fontSize: '0.75rem' }}>✓ Save</button>
                            <button className="btn btn-outline btn-sm" onClick={() => setEditing(null)}
                                style={{ fontSize: '0.75rem' }}>✕</button>
                        </div>
                    ) : (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                            <div style={{ flex: 1, minWidth: 200 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                                        {c.label}
                                    </span>
                                    <span style={{
                                        fontSize: '0.6rem', padding: '1px 6px', borderRadius: 4,
                                        background: 'rgba(212,160,23,0.1)', color: 'var(--gold-300)',
                                    }}>
                                        {c.chain === 'all' ? '🌐 All' : c.chain}
                                    </span>
                                </div>
                                <div style={{ fontSize: '0.7rem', fontFamily: 'var(--font-mono)', color: 'var(--text-gold)', marginTop: 2 }}>
                                    {c.address}
                                </div>
                                {c.notes && (
                                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>
                                        {c.notes}
                                    </div>
                                )}
                                <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: 4 }}>
                                    Added {new Date(c.addedAt).toLocaleDateString()}
                                    {c.lastUsed && ` · Last used ${new Date(c.lastUsed).toLocaleDateString()}`}
                                </div>
                            </div>
                            <div style={{ display: 'flex', gap: 6 }}>
                                <button className="btn btn-outline btn-sm"
                                    style={{ fontSize: '0.7rem' }}
                                    onClick={() => { navigator.clipboard.writeText(c.address); }}>
                                    📋
                                </button>
                                <button className="btn btn-outline btn-sm"
                                    style={{ fontSize: '0.7rem' }}
                                    onClick={() => { setEditing(c.address); setEditLabel(c.label); setEditNotes(c.notes || ''); }}>
                                    ✏️
                                </button>
                                <button className="btn btn-outline btn-sm"
                                    style={{ fontSize: '0.7rem', borderColor: 'rgba(255,23,68,0.3)', color: '#ff1744' }}
                                    onClick={() => handleRemove(c.address)}>
                                    🗑
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}
