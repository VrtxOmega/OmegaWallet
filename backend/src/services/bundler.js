/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║       BUNDLER SERVICE — ERC-4337 UserOp Submission           ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Accepts UserOperations from the frontend, validates them locally,
 * and submits to an ERC-4337 bundler (Stackup, Pimlico, Alchemy).
 *
 * Optionally routes through Tor/Nym to sever IP linkage.
 */
import { Router } from 'express';
import { ethers } from 'ethers';

const router = Router();

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

const BUNDLER_RPC = process.env.BUNDLER_RPC || 'https://api.stackup.sh/v1/node/YOUR_KEY';
const ENTRY_POINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

// ═══════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════

/**
 * POST /api/bundler/submit
 * Submit a signed UserOperation to the bundler
 *
 * Body: { userOp: PackedUserOperation, chain: "ethereum" | "base" | "arbitrum" }
 */
router.post('/submit', async (req, res) => {
    try {
        const { userOp, chain } = req.body;

        if (!userOp || !userOp.sender) {
            return res.status(400).json({ error: 'Invalid UserOp: missing sender' });
        }

        // Local pre-validation
        const validation = validateUserOp(userOp);
        if (!validation.valid) {
            return res.status(400).json({ error: validation.reason });
        }

        // Submit to bundler via JSON-RPC
        const bundlerUrl = getBundlerUrl(chain);
        const response = await fetch(bundlerUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: Date.now(),
                method: 'eth_sendUserOperation',
                params: [userOp, ENTRY_POINT_V07]
            })
        });

        const result = await response.json();

        if (result.error) {
            return res.status(400).json({
                error: 'Bundler rejected UserOp',
                details: result.error
            });
        }

        res.json({
            status: 'submitted',
            userOpHash: result.result,
            chain
        });

    } catch (err) {
        res.status(500).json({ error: 'Bundler submission failed', details: err.message });
    }
});

/**
 * POST /api/bundler/status
 * Check UserOp receipt status
 *
 * Body: { userOpHash: string, chain: string }
 */
router.post('/status', async (req, res) => {
    try {
        const { userOpHash, chain } = req.body;
        const bundlerUrl = getBundlerUrl(chain);

        const response = await fetch(bundlerUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: Date.now(),
                method: 'eth_getUserOperationReceipt',
                params: [userOpHash]
            })
        });

        const result = await response.json();
        res.json(result.result || { status: 'pending' });

    } catch (err) {
        res.status(500).json({ error: 'Status check failed', details: err.message });
    }
});

/**
 * GET /api/bundler/gas
 * Get current gas estimates for UserOp packaging
 */
router.get('/gas', async (req, res) => {
    try {
        const chain = req.query.chain || 'ethereum';
        const provider = getProvider(chain);
        const feeData = await provider.getFeeData();

        res.json({
            maxFeePerGas: feeData.maxFeePerGas?.toString(),
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString(),
            gasPrice: feeData.gasPrice?.toString(),
            chain
        });

    } catch (err) {
        res.status(500).json({ error: 'Gas estimation failed', details: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function validateUserOp(userOp) {
    if (!ethers.isAddress(userOp.sender)) {
        return { valid: false, reason: 'Invalid sender address' };
    }
    if (!userOp.signature || userOp.signature === '0x') {
        return { valid: false, reason: 'Missing signature' };
    }
    return { valid: true };
}

function getBundlerUrl(chain) {
    const bundlers = {
        ethereum: process.env.BUNDLER_RPC_ETH || BUNDLER_RPC,
        base: process.env.BUNDLER_RPC_BASE || BUNDLER_RPC,
        arbitrum: process.env.BUNDLER_RPC_ARB || BUNDLER_RPC,
        optimism: process.env.BUNDLER_RPC_OP || BUNDLER_RPC,
    };
    return bundlers[chain] || BUNDLER_RPC;
}

function getProvider(chain) {
    const rpcs = {
        ethereum: process.env.RPC_ETH || 'https://eth.llamarpc.com',
        base: process.env.RPC_BASE || 'https://mainnet.base.org',
        arbitrum: process.env.RPC_ARB || 'https://arb1.arbitrum.io/rpc',
        optimism: process.env.RPC_OP || 'https://mainnet.optimism.io',
    };
    return new ethers.JsonRpcProvider(rpcs[chain] || rpcs.ethereum);
}

export { router as bundlerRouter };
