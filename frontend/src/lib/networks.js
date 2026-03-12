// ═════════════════════════════════════════════════════════════
// Network Configuration — RPC keys intentionally removed from frontend.
// All RPC calls route through IPC (window.omega) in Electron mode.
// Browser fallback uses public endpoints only.
// ═════════════════════════════════════════════════════════════

export const NETS = {
    // ── EVM Chains ─────────────────────────────────────────
    sepolia: { name: '🧪 Sepolia', id: 11155111, sym: 'ETH', family: 'evm', explorer: 'https://sepolia.etherscan.io' },
    'base-sepolia': { name: '🧪 Base Sepolia', id: 84532, sym: 'ETH', family: 'evm', explorer: 'https://sepolia.basescan.org' },
    ethereum: { name: 'Ethereum', id: 1, sym: 'ETH', family: 'evm', explorer: 'https://etherscan.io' },
    base: { name: 'Base', id: 8453, sym: 'ETH', family: 'evm', explorer: 'https://basescan.org' },
    arbitrum: { name: 'Arbitrum', id: 42161, sym: 'ETH', family: 'evm', explorer: 'https://arbiscan.io' },
    optimism: { name: 'Optimism', id: 10, sym: 'ETH', family: 'evm', explorer: 'https://optimistic.etherscan.io' },
    polygon: { name: 'Polygon', id: 137, sym: 'MATIC', family: 'evm', explorer: 'https://polygonscan.com' },
    avalanche: { name: 'Avalanche', id: 43114, sym: 'AVAX', family: 'evm', explorer: 'https://snowtrace.io' },
    bsc: { name: 'BNB Chain', id: 56, sym: 'BNB', family: 'evm', explorer: 'https://bscscan.com' },
    fantom: { name: 'Fantom', id: 250, sym: 'FTM', family: 'evm', explorer: 'https://ftmscan.com' },
    cronos: { name: 'Cronos', id: 25, sym: 'CRO', family: 'evm', explorer: 'https://cronoscan.com' },
    'zksync-era': { name: 'zkSync Era', id: 324, sym: 'ETH', family: 'evm', explorer: 'https://explorer.zksync.io' },
    linea: { name: 'Linea', id: 59144, sym: 'ETH', family: 'evm', explorer: 'https://lineascan.build' },
    scroll: { name: 'Scroll', id: 534352, sym: 'ETH', family: 'evm', explorer: 'https://scrollscan.com' },
    mantle: { name: 'Mantle', id: 5000, sym: 'MNT', family: 'evm', explorer: 'https://mantlescan.xyz' },
    // ── Non-EVM Chains ─────────────────────────────────────
    bitcoin: { name: 'Bitcoin', id: 0, sym: 'BTC', family: 'btc', explorer: 'https://blockstream.info' },
    solana: { name: 'Solana', id: 0, sym: 'SOL', family: 'sol', explorer: 'https://solscan.io' },
};

/** Resolve a network key to its config object. Falls back to Ethereum. */
export function N(net) {
    return NETS[net] || NETS.ethereum;
}

/** Shorten an address to 0x1234…abcd format. */
export function short(addr) {
    return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '—';
}

/** Detect if running inside Electron (window.omega exists). */
export const isElectron = typeof window !== 'undefined' && window.omega;
