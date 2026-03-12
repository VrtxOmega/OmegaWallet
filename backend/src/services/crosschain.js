/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     CROSS-CHAIN ROUTER — Multi-Chain Intent Resolution       ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Aggregates balances across ETH, Base, Arbitrum, Optimism.
 * Routes cross-chain intents via bridge aggregators.
 * State-level: never touches unverified bridge contracts directly.
 */
import { Router } from 'express';
import { ethers } from 'ethers';

const router = Router();

const CHAINS = {
    ethereum: { id: 1, rpc: process.env.RPC_ETH || 'https://eth.llamarpc.com', name: 'Ethereum', symbol: 'ETH' },
    base: { id: 8453, rpc: process.env.RPC_BASE || 'https://mainnet.base.org', name: 'Base', symbol: 'ETH' },
    arbitrum: { id: 42161, rpc: process.env.RPC_ARB || 'https://arb1.arbitrum.io/rpc', name: 'Arbitrum', symbol: 'ETH' },
    optimism: { id: 10, rpc: process.env.RPC_OP || 'https://mainnet.optimism.io', name: 'Optimism', symbol: 'ETH' },
};

// Well-known token addresses per chain
const USDC = {
    ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
};

/**
 * POST /api/crosschain/balances
 * Aggregate balances across all supported chains
 */
router.post('/balances', async (req, res) => {
    try {
        const { address } = req.body;
        if (!ethers.isAddress(address)) {
            return res.status(400).json({ error: 'Invalid address' });
        }

        const balances = await Promise.all(
            Object.entries(CHAINS).map(async ([key, chain]) => {
                try {
                    const provider = new ethers.JsonRpcProvider(chain.rpc);
                    const balance = await provider.getBalance(address);
                    return {
                        chain: key,
                        chainId: chain.id,
                        name: chain.name,
                        nativeBalance: ethers.formatEther(balance),
                        nativeSymbol: chain.symbol
                    };
                } catch {
                    return { chain: key, chainId: chain.id, name: chain.name, nativeBalance: '0', error: true };
                }
            })
        );

        const totalETH = balances.reduce((sum, b) => sum + parseFloat(b.nativeBalance), 0);

        res.json({
            address,
            totalNativeETH: totalETH.toFixed(6),
            chains: balances,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ error: 'Balance aggregation failed', details: err.message });
    }
});

/**
 * POST /api/crosschain/quote
 * Get a cross-chain transfer quote
 */
router.post('/quote', async (req, res) => {
    try {
        const { fromChain, toChain, token, amount } = req.body;

        if (!CHAINS[fromChain] || !CHAINS[toChain]) {
            return res.status(400).json({ error: 'Unsupported chain' });
        }

        // Estimate bridge fee (simplified — production would use LI.FI/Socket API)
        const bridgeFeePercent = 0.3; // 0.3% bridge fee estimate
        const gasFee = 0.002; // estimated gas in ETH
        const estimatedTime = fromChain === toChain ? 15 : 300; // seconds

        const amountFloat = parseFloat(amount);
        const bridgeFee = amountFloat * (bridgeFeePercent / 100);
        const outputAmount = amountFloat - bridgeFee - gasFee;

        res.json({
            fromChain,
            toChain,
            inputAmount: amount,
            outputAmount: outputAmount.toFixed(6),
            bridgeFee: bridgeFee.toFixed(6),
            gasFee: gasFee.toFixed(6),
            estimatedSeconds: estimatedTime,
            route: fromChain === toChain ? 'direct' : 'bridge',
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ error: 'Quote failed', details: err.message });
    }
});

/**
 * GET /api/crosschain/chains
 * List supported chains
 */
router.get('/chains', (req, res) => {
    res.json({
        chains: Object.entries(CHAINS).map(([key, chain]) => ({
            id: key,
            chainId: chain.id,
            name: chain.name,
            symbol: chain.symbol
        }))
    });
});

export { router as crossChainRouter };
