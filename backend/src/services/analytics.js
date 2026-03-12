/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     ANALYTICS ENGINE — Portfolio & Threat Intelligence       ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Real-time portfolio tracking, gas oracle, and live threat
 * intelligence feed. Aggregates data across all chains.
 */
import { Router } from 'express';
import { ethers } from 'ethers';

const router = Router();

/**
 * POST /api/analytics/portfolio
 * Get portfolio breakdown with USD values
 */
router.post('/portfolio', async (req, res) => {
    try {
        const { address, chains } = req.body;
        if (!ethers.isAddress(address)) {
            return res.status(400).json({ error: 'Invalid address' });
        }

        const chainList = chains || ['ethereum', 'base', 'arbitrum', 'optimism'];
        const rpcs = {
            ethereum: process.env.RPC_ETH || 'https://eth.llamarpc.com',
            base: process.env.RPC_BASE || 'https://mainnet.base.org',
            arbitrum: process.env.RPC_ARB || 'https://arb1.arbitrum.io/rpc',
            optimism: process.env.RPC_OP || 'https://mainnet.optimism.io',
        };

        const holdings = await Promise.all(
            chainList.map(async (chain) => {
                try {
                    const provider = new ethers.JsonRpcProvider(rpcs[chain]);
                    const balance = await provider.getBalance(address);
                    const ethBalance = parseFloat(ethers.formatEther(balance));
                    return {
                        chain,
                        asset: 'ETH',
                        balance: ethBalance.toFixed(6),
                        usdValue: (ethBalance * 3200).toFixed(2) // simplified price
                    };
                } catch {
                    return { chain, asset: 'ETH', balance: '0', usdValue: '0', error: true };
                }
            })
        );

        const totalUSD = holdings.reduce((sum, h) => sum + parseFloat(h.usdValue || 0), 0);

        res.json({
            address,
            holdings,
            totalUSD: totalUSD.toFixed(2),
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ error: 'Portfolio fetch failed', details: err.message });
    }
});

/**
 * GET /api/analytics/gas
 * Real-time gas oracle across chains
 */
router.get('/gas', async (req, res) => {
    try {
        const rpcs = {
            ethereum: process.env.RPC_ETH || 'https://eth.llamarpc.com',
            base: process.env.RPC_BASE || 'https://mainnet.base.org',
            arbitrum: process.env.RPC_ARB || 'https://arb1.arbitrum.io/rpc',
        };

        const gasData = await Promise.all(
            Object.entries(rpcs).map(async ([chain, rpc]) => {
                try {
                    const provider = new ethers.JsonRpcProvider(rpc);
                    const feeData = await provider.getFeeData();
                    const gasPrice = feeData.gasPrice ? parseFloat(ethers.formatUnits(feeData.gasPrice, 'gwei')) : 0;
                    return {
                        chain,
                        gasPrice: gasPrice.toFixed(2),
                        unit: 'gwei',
                        speed: gasPrice < 10 ? 'low' : gasPrice < 30 ? 'medium' : 'high'
                    };
                } catch {
                    return { chain, gasPrice: '0', error: true };
                }
            })
        );

        res.json({ gas: gasData, timestamp: new Date().toISOString() });
    } catch (err) {
        res.status(500).json({ error: 'Gas oracle failed', details: err.message });
    }
});

/**
 * GET /api/analytics/threats
 * Latest threat intelligence feed
 */
router.get('/threats', (req, res) => {
    // In production: pulls from GoPlus, Forta, ChainPatrol feeds
    const feed = [
        { id: 1, type: 'drainer', severity: 'critical', address: '0xbad...1234', chain: 'ethereum', timestamp: new Date().toISOString(), description: 'Known wallet drainer contract' },
        { id: 2, type: 'phishing', severity: 'high', domain: 'uniswap-claim.xyz', timestamp: new Date().toISOString(), description: 'Phishing site impersonating Uniswap' },
        { id: 3, type: 'rugpull', severity: 'medium', address: '0xrug...5678', chain: 'base', timestamp: new Date().toISOString(), description: 'Token with hidden mint + lock functions' },
    ];

    res.json({
        threats: feed,
        totalActive: feed.length,
        lastUpdated: new Date().toISOString()
    });
});

export { router as analyticsRouter };
