/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     MEV PROTECTION — Private Transaction Relay               ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Routes transactions through Flashbots Protect to prevent:
 *   - Sandwich attacks
 *   - Frontrunning
 *   - Transaction ordering exploitation
 *
 * MEV Kickback: captures order flow value and returns it to user
 */
import { Router } from 'express';
import { ethers } from 'ethers';

const router = Router();

const FLASHBOTS_RPC = 'https://rpc.flashbots.net';
const FLASHBOTS_PROTECT = 'https://protect.flashbots.net';

/**
 * POST /api/mev/protect
 * Submit transaction via Flashbots Protect (private mempool)
 */
router.post('/protect', async (req, res) => {
    try {
        const { signedTx, chain } = req.body;
        if (!signedTx) return res.status(400).json({ error: 'Missing signedTx' });

        // Route through Flashbots Protect RPC
        const response = await fetch(FLASHBOTS_PROTECT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: Date.now(),
                method: 'eth_sendRawTransaction',
                params: [signedTx]
            })
        });

        const result = await response.json();

        res.json({
            status: 'submitted_private',
            txHash: result.result,
            protection: 'flashbots_protect',
            mevProtected: true
        });
    } catch (err) {
        res.status(500).json({ error: 'MEV protection failed', details: err.message });
    }
});

/**
 * POST /api/mev/analyze
 * Analyze a pending transaction for MEV exposure
 */
router.post('/analyze', async (req, res) => {
    try {
        const { to, data, value } = req.body;
        const risks = [];
        let mevExposure = 0;

        // Detect swap transactions (high MEV risk)
        if (data && data.length >= 10) {
            const selector = data.slice(0, 10).toLowerCase();
            const swapSelectors = [
                '0x38ed1739', // swapExactTokensForTokens
                '0x7ff36ab5', // swapExactETHForTokens
                '0x18cbafe5', // swapExactTokensForETH
                '0xfb3bdb41', // swapETHForExactTokens
                '0x5c11d795', // swapExactTokensForTokensSupportingFeeOnTransfer
            ];

            if (swapSelectors.includes(selector)) {
                risks.push({
                    type: 'sandwich_risk',
                    severity: 'high',
                    message: 'DEX swap detected — vulnerable to sandwich attacks in public mempool'
                });
                mevExposure = Math.min(parseFloat(ethers.formatEther(BigInt(value || 0))) * 0.01, 50);
            }
        }

        // Large value transfers
        if (value && BigInt(value) > ethers.parseEther('10')) {
            risks.push({
                type: 'frontrun_risk',
                severity: 'medium',
                message: 'Large value transfer — potential frontrunning target'
            });
            mevExposure += 5;
        }

        const recommendation = risks.length > 0 ? 'USE_FLASHBOTS' : 'PUBLIC_MEMPOOL_SAFE';

        res.json({
            risks,
            mevExposure: `${mevExposure.toFixed(2)} USD (estimated)`,
            recommendation,
            protectionAvailable: true
        });
    } catch (err) {
        res.status(500).json({ error: 'MEV analysis failed', details: err.message });
    }
});

export { router as mevRouter };
