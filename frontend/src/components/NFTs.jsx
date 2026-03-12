import { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { N } from '../lib/networks';

export function NFTs({ wallets, activeIdx, net }) {
    const [nfts, setNfts] = useState([]);
    const [pinnedNfts, setPinnedNfts] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [selected, setSelected] = useState(null);
    const [saveStatus, setSaveStatus] = useState('');
    const [tab, setTab] = useState('onchain');
    const [pinning, setPinning] = useState(false);
    // Transfer state
    const [showTransfer, setShowTransfer] = useState(false);
    const [transferTo, setTransferTo] = useState('');
    const [transferScan, setTransferScan] = useState(null);
    const [transferScanning, setTransferScanning] = useState(false);
    const [transferring, setTransferring] = useState(false);
    const [transferStatus, setTransferStatus] = useState('');
    const nn = N(net);
    const active = wallets[activeIdx];
    const family = nn.family || 'evm';

    // Load pinned NFTs from encrypted ledger
    const loadPinned = async () => {
        if (!window.omega?.nft?.pinned) return;
        const res = await window.omega.nft.pinned();
        if (res.ok) setPinnedNfts(res.nfts);
    };

    useEffect(() => {
        setLoading(true);
        setNfts([]);
        setError(null);
        setSelected(null);
        setSaveStatus('');

        // Always load pinned
        loadPinned();

        if (family === 'evm') {
            if (!active || !window.omega?.nft) { setLoading(false); return; }
            window.omega.nft.list(active.address, net)
                .then(res => {
                    if (res.ok) setNfts(res.nfts);
                    else setError(res.error);
                    setLoading(false);
                })
                .catch(e => { setError(e.message); setLoading(false); });
        } else if (family === 'sol') {
            if (!active || !window.omega?.sol?.nfts) { setLoading(false); return; }
            // Derive SOL address first, then fetch NFTs
            window.omega.sol.deriveAddress(0)
                .then(res => {
                    if (!res.ok) { setError(res.error); setLoading(false); return; }
                    return window.omega.sol.nfts(res.address);
                })
                .then(res => {
                    if (res?.ok) setNfts(res.nfts);
                    else if (res) setError(res.error);
                    setLoading(false);
                })
                .catch(e => { setError(e.message); setLoading(false); });
        } else {
            setLoading(false);
        }
    }, [activeIdx, net]);

    // Check if an NFT is already pinned
    const isPinned = (nft) => {
        return pinnedNfts.some(p =>
            p.contract.toLowerCase() === nft.contract.toLowerCase() &&
            p.tokenId === nft.tokenId
        );
    };

    const pinNft = async (nft) => {
        setPinning(true);
        setSaveStatus('📌 Pinning to collection...');
        const res = await window.omega.nft.pin({ ...nft, chain: net });
        if (res.ok) {
            setSaveStatus(res.added ? '✅ Pinned to collection!' : '📌 Already in collection');
            await loadPinned();
        } else {
            setSaveStatus(`❌ ${res.error}`);
        }
        setPinning(false);
        setTimeout(() => setSaveStatus(''), 3000);
    };

    const unpinNft = async (nft) => {
        const res = await window.omega.nft.unpin(nft.contract, nft.tokenId);
        if (res.ok) {
            setSaveStatus('🗑 Removed from collection');
            await loadPinned();
            // If we're viewing the pinned tab and this was the selected one, deselect
            if (tab === 'collection') setSelected(null);
        }
        setTimeout(() => setSaveStatus(''), 3000);
    };

    // ── Transfer: Cerberus pre-flight + safeTransferFrom ──
    const scanRecipient = async () => {
        if (!ethers.isAddress(transferTo)) {
            setTransferScan({ verdict: 'INVALID', threatScore: -1, error: 'Invalid address' });
            return;
        }
        setTransferScanning(true);
        setTransferScan(null);
        const res = await window.omega.scanContract(transferTo, net);
        setTransferScan(res);
        setTransferScanning(false);
    };

    const executeTransfer = async (nft) => {
        setTransferring(true);
        setTransferStatus('⏳ Sending NFT...');
        const res = await window.omega.nft.transfer(nft.contract, nft.tokenId, transferTo, net);
        if (res.ok) {
            setTransferStatus(`✅ Sent! Tx: ${res.txHash.slice(0, 16)}...`);
            setShowTransfer(false);
            setTransferTo('');
            setTransferScan(null);
            // Refresh
            setSelected(null);
            await loadPinned();
            // Remove from local nfts list
            setNfts(prev => prev.filter(n =>
                !(n.contract.toLowerCase() === nft.contract.toLowerCase() && n.tokenId === nft.tokenId)
            ));
        } else {
            setTransferStatus(`❌ ${res.error}`);
        }
        setTransferring(false);
        setTimeout(() => setTransferStatus(''), 6000);
    };

    // Which list to show based on tab
    const displayNfts = tab === 'collection' ? pinnedNfts : nfts;
    const selectedNft = selected !== null ? displayNfts[selected] : null;

    return (
        <div className="fade-in">
            <div className="page-header">
                <h2>NFT Gallery</h2>
                <p>{active?.label} · {nn.name} · {tab === 'collection'
                    ? `${pinnedNfts.length} saved`
                    : `${nfts.length} NFT${nfts.length !== 1 ? 's' : ''} found`}</p>
            </div>

            {/* Tab Bar */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
                <button
                    className={`btn btn-sm ${tab === 'onchain' ? 'btn-primary' : 'btn-outline'}`}
                    onClick={() => { setTab('onchain'); setSelected(null); }}
                    style={{ fontSize: '0.8rem' }}>
                    🔗 On-Chain ({nfts.length})
                </button>
                <button
                    className={`btn btn-sm ${tab === 'collection' ? 'btn-primary' : 'btn-outline'}`}
                    onClick={() => { setTab('collection'); setSelected(null); }}
                    style={{ fontSize: '0.8rem' }}>
                    📌 My Collection ({pinnedNfts.length})
                </button>
            </div>

            {/* On-Chain Tab Content */}
            {tab === 'onchain' && (
                <>
                    {loading && (
                        <div className="glass-card" style={{ textAlign: 'center', padding: 40 }}>
                            <div style={{ fontSize: '2rem', marginBottom: 12 }}>🔍</div>
                            <div style={{ color: 'var(--text-secondary)' }}>Scanning for NFTs on {nn.name}...</div>
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 8 }}>
                                Scanning recent blocks for ERC-721 & ERC-1155 Transfer events
                            </div>
                        </div>
                    )}

                    {error && (
                        <div className="glass-card" style={{ borderColor: 'rgba(255,23,68,0.2)', padding: 20 }}>
                            <span style={{ color: '#ff1744' }}>⚠ {error}</span>
                        </div>
                    )}

                    {family !== 'evm' && family !== 'sol' && !loading && (
                        <div className="glass-card" style={{ textAlign: 'center', padding: 40 }}>
                            <div style={{ fontSize: '2rem', marginBottom: 12 }}>🖼️</div>
                            <div style={{ color: 'var(--text-secondary)' }}>
                                NFT gallery is available for EVM and Solana chains.
                            </div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 8 }}>
                                Switch to an EVM or Solana network to view NFTs.
                            </div>
                        </div>
                    )}

                    {!loading && !error && nfts.length === 0 && (family === 'evm' || family === 'sol') && (
                        <div className="glass-card" style={{ textAlign: 'center', padding: 40 }}>
                            <div style={{ fontSize: '3rem', marginBottom: 16, opacity: 0.3 }}>🖼️</div>
                            <div style={{ color: 'var(--text-secondary)', fontSize: '1rem', fontWeight: 600 }}>
                                No NFTs found
                            </div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 8 }}>
                                When you receive {family === 'sol' ? 'Metaplex' : 'ERC-721 / ERC-1155'} NFTs on {nn.name}, they'll appear here automatically.
                            </div>
                        </div>
                    )}
                </>
            )}

            {/* Collection Tab Empty State */}
            {tab === 'collection' && pinnedNfts.length === 0 && (
                <div className="glass-card" style={{ textAlign: 'center', padding: 40 }}>
                    <div style={{ fontSize: '3rem', marginBottom: 16, opacity: 0.3 }}>📌</div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '1rem', fontWeight: 600 }}>
                        No saved NFTs
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 8 }}>
                        Pin NFTs from the On-Chain tab to save them here. Pinned NFTs persist across sessions with offline image caching.
                    </div>
                </div>
            )}

            {/* NFT Grid */}
            {displayNfts.length > 0 && (
                <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                    gap: 16,
                }}>
                    {displayNfts.map((nft, i) => (
                        <div key={`${nft.contract}:${nft.tokenId}`} className="glass-card" style={{
                            padding: 0, overflow: 'hidden', cursor: 'pointer',
                            border: selected === i ? '2px solid var(--accent-gold)' : '1px solid var(--border-gold)',
                            transition: 'all 0.2s ease',
                        }}
                            onClick={() => setSelected(selected === i ? null : i)}>
                            {/* NFT Image */}
                            <div style={{
                                width: '100%', aspectRatio: '1', background: 'rgba(255,255,255,0.02)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                overflow: 'hidden',
                            }}>
                                {(nft.imageData || nft.image) ? (
                                    <img src={nft.imageData || nft.image} alt={nft.name}
                                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                        onError={(e) => { e.target.style.display = 'none'; }}
                                    />
                                ) : (
                                    <span style={{ fontSize: '3rem', opacity: 0.15 }}>🖼️</span>
                                )}
                            </div>
                            {/* NFT Info */}
                            <div style={{ padding: '12px 14px' }}>
                                <div style={{
                                    fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)',
                                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                    display: 'flex', alignItems: 'center', gap: 6,
                                }}>
                                    {tab === 'collection' && <span style={{ fontSize: '0.7rem' }}>📌</span>}
                                    {isPinned(nft) && tab === 'onchain' && <span style={{ fontSize: '0.7rem' }}>📌</span>}
                                    {nft.name}
                                </div>
                                <div style={{
                                    fontSize: '0.7rem', color: 'var(--text-gold)', marginTop: 4,
                                    display: 'flex', alignItems: 'center', gap: 4,
                                }}>
                                    <span style={{
                                        width: 10, height: 10, borderRadius: '50%',
                                        background: 'linear-gradient(135deg, var(--gold-300), var(--gold-500))',
                                        display: 'inline-block',
                                    }}></span>
                                    {nft.collection} ({nft.symbol})
                                </div>
                                <div style={{
                                    fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 4,
                                    fontFamily: 'var(--font-mono)',
                                }}>
                                    Token #{nft.tokenId.length > 8 ? nft.tokenId.slice(0, 8) + '...' : nft.tokenId}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Detail Panel */}
            {selectedNft && (
                <div className="glass-card" style={{
                    marginTop: 16, maxWidth: 600,
                    border: '1px solid var(--accent-gold)',
                }}>
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                        {(selectedNft.imageData || selectedNft.image) && (
                            <img src={selectedNft.imageData || selectedNft.image} alt={selectedNft.name}
                                style={{ width: 120, height: 120, borderRadius: 'var(--radius-sm)', objectFit: 'cover' }} />
                        )}
                        <div style={{ flex: 1, minWidth: 200 }}>
                            <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-gold)' }}>
                                {selectedNft.name}
                            </div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 4 }}>
                                Collection: {selectedNft.collection} ({selectedNft.symbol})
                            </div>
                            {selectedNft.description && (
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
                                    {selectedNft.description.slice(0, 200)}{selectedNft.description.length > 200 ? '...' : ''}
                                </div>
                            )}
                            <div style={{
                                fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 8,
                                fontFamily: 'var(--font-mono)', wordBreak: 'break-all',
                            }}>
                                Contract: {selectedNft.contract}
                            </div>
                            <div style={{
                                fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 4,
                                fontFamily: 'var(--font-mono)',
                            }}>
                                Token ID: {selectedNft.tokenId}
                            </div>
                            {selectedNft.chain && (
                                <div style={{
                                    fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 4,
                                    fontFamily: 'var(--font-mono)',
                                }}>
                                    Chain: {selectedNft.chain}
                                </div>
                            )}
                            {selectedNft.pinnedAt && (
                                <div style={{
                                    fontSize: '0.65rem', color: 'var(--gold-300)', marginTop: 4,
                                }}>
                                    📌 Pinned {new Date(selectedNft.pinnedAt).toLocaleDateString()}
                                </div>
                            )}

                            {/* Action Buttons */}
                            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                                {/* Pin / Unpin */}
                                {isPinned(selectedNft) ? (
                                    <button className="btn btn-outline btn-sm"
                                        style={{ fontSize: '0.75rem', borderColor: 'rgba(255,23,68,0.3)', color: 'var(--accent-danger)' }}
                                        onClick={() => unpinNft(selectedNft)}>
                                        🗑 Remove from Collection
                                    </button>
                                ) : (
                                    <button className="btn btn-outline btn-sm"
                                        style={{ fontSize: '0.75rem' }}
                                        disabled={pinning}
                                        onClick={() => pinNft(selectedNft)}>
                                        {pinning ? '⏳ Pinning...' : '📌 Pin to Collection'}
                                    </button>
                                )}
                                {/* Save to disk */}
                                {(selectedNft.imageData || selectedNft.image) && (
                                    <button className="btn btn-outline btn-sm"
                                        style={{ fontSize: '0.75rem' }}
                                        onClick={async () => {
                                            setSaveStatus('⏳ Downloading...');
                                            const res = await window.omega.nft.save(
                                                selectedNft.image || selectedNft.imageData,
                                                selectedNft.name
                                            );
                                            if (res.ok) {
                                                setSaveStatus(`✅ Saved (${(res.size / 1024).toFixed(0)} KB)`);
                                            } else if (res.error === 'Cancelled') {
                                                setSaveStatus('');
                                            } else {
                                                setSaveStatus(`❌ ${res.error}`);
                                            }
                                            setTimeout(() => setSaveStatus(''), 4000);
                                        }}>
                                        💾 Save Image
                                    </button>
                                )}
                                {/* Copy URI */}
                                {selectedNft.tokenURI && (
                                    <button className="btn btn-outline btn-sm"
                                        style={{ fontSize: '0.75rem' }}
                                        onClick={() => {
                                            navigator.clipboard.writeText(selectedNft.tokenURI);
                                            setSaveStatus('✓ Token URI copied');
                                            setTimeout(() => setSaveStatus(''), 2000);
                                        }}>
                                        📋 Copy URI
                                    </button>
                                )}
                                {/* Send NFT */}
                                {family === 'evm' && (
                                    <button className="btn btn-outline btn-sm"
                                        style={{ fontSize: '0.75rem' }}
                                        onClick={() => { setShowTransfer(!showTransfer); setTransferTo(''); setTransferScan(null); setTransferStatus(''); }}>
                                        {showTransfer ? '✕ Cancel' : '🚀 Send NFT'}
                                    </button>
                                )}
                            </div>

                            {/* Transfer Panel */}
                            {showTransfer && selectedNft && (
                                <div style={{
                                    marginTop: 12, padding: 12,
                                    background: 'rgba(212,160,23,0.05)', border: '1px solid var(--border-gold)',
                                    borderRadius: 'var(--radius-sm)',
                                }}>
                                    <div style={{ fontSize: '0.8rem', fontWeight: 700, marginBottom: 8, color: 'var(--text-gold)' }}>
                                        Send "{selectedNft.name}" to:
                                    </div>
                                    <div style={{ display: 'flex', gap: 8 }}>
                                        <input className="input" placeholder="0x... recipient address"
                                            value={transferTo} onChange={e => setTransferTo(e.target.value)}
                                            style={{ flex: 1, fontSize: '0.8rem' }} />
                                        <button className="btn btn-outline btn-sm"
                                            onClick={scanRecipient}
                                            disabled={transferScanning || !transferTo}
                                            style={{ fontSize: '0.75rem' }}>
                                            {transferScanning ? '⏳' : '🔍 Scan'}
                                        </button>
                                    </div>
                                    {/* Cerberus Scan Results */}
                                    {transferScan && (
                                        <div style={{
                                            marginTop: 8, padding: 8,
                                            borderRadius: 4, fontSize: '0.75rem',
                                            background: transferScan.verdict === 'PASS' ? 'rgba(0,230,118,0.08)' :
                                                transferScan.verdict === 'WARN' ? 'rgba(255,152,0,0.08)' :
                                                    transferScan.verdict === 'BLOCK' ? 'rgba(255,23,68,0.08)' : 'rgba(255,255,255,0.03)',
                                            border: `1px solid ${transferScan.verdict === 'PASS' ? 'rgba(0,230,118,0.3)' :
                                                transferScan.verdict === 'WARN' ? 'rgba(255,152,0,0.3)' :
                                                    'rgba(255,23,68,0.3)'}`,
                                        }}>
                                            <div style={{ fontWeight: 700, marginBottom: 4 }}>
                                                Cerberus: {transferScan.verdict}
                                                {transferScan.threatScore >= 0 && ` (${transferScan.threatScore}/100)`}
                                            </div>
                                            {transferScan.findings?.map((f, i) => (
                                                <div key={i} style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>
                                                    {f.type === 'critical' ? '🔴' : f.type === 'warning' ? '🟡' : '🟢'} {f.message}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    {/* Transfer Confirm */}
                                    {transferScan && transferScan.verdict !== 'INVALID' && (
                                        <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                                            {transferScan.verdict === 'BLOCK' ? (
                                                <div style={{ color: 'var(--accent-danger)', fontSize: '0.75rem', fontWeight: 700 }}>
                                                    ⛔ BLOCKED — High threat score. Transfer disabled.
                                                </div>
                                            ) : (
                                                <button className="btn btn-primary btn-sm"
                                                    onClick={() => executeTransfer(selectedNft)}
                                                    disabled={transferring}
                                                    style={{ fontSize: '0.75rem' }}>
                                                    {transferring ? '⏳ Sending...' : `✅ Confirm Send — ${selectedNft.name}`}
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Status Messages */}
                            {(saveStatus || transferStatus) && (
                                <div style={{
                                    fontSize: '0.7rem', marginTop: 6,
                                    color: (saveStatus + transferStatus).includes('✅') || (saveStatus + transferStatus).includes('✓') ? 'var(--accent-success)' :
                                        (saveStatus + transferStatus).includes('❌') || (saveStatus + transferStatus).includes('🗑') ? 'var(--accent-danger)' : 'var(--gold-300)',
                                }}>
                                    {saveStatus || transferStatus}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
