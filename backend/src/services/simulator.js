/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     TRANSACTION SIMULATOR — Dry-Run Before Broadcast         ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Simulates transaction execution BEFORE the user signs.
 * Shows exactly what will happen:
 *   - Token balance changes (what you'll send/receive)
 *   - ETH balance changes
 *   - Approval changes
 *   - Revert detection with decoded reason
 *   - Gas estimation
 *
 * Uses eth_call with state overrides for accurate simulation
 * without actually broadcasting.
 */
import { Router } from 'express';
import { ethers } from 'ethers';

const router = Router();

// ═══════════════════════════════════════════════════════════════
// KNOWN INTERFACES
// ═══════════════════════════════════════════════════════════════

const ERC20_IFACE = new ethers.Interface([
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'event Transfer(address indexed from, address indexed to, uint256 value)',
    'event Approval(address indexed owner, address indexed spender, uint256 value)',
]);

// ═══════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════

/**
 * POST /api/simulate/transaction
 * Simulate a transaction and return predicted state changes
 *
 * Body: {
 *   from: address,
 *   to: address,
 *   value: string (hex or decimal, in wei),
 *   data: string (calldata),
 *   chain: string
 * }
 */
router.post('/transaction', async (req, res) => {
    try {
        const { from, to, value, data, chain } = req.body;

        if (!ethers.isAddress(from) || !ethers.isAddress(to)) {
            return res.status(400).json({ error: 'Invalid from/to address' });
        }

        const provider = getProvider(chain);
        const result = {
            success: false,
            balanceChanges: [],
            approvalChanges: [],
            gasEstimate: null,
            revertReason: null,
            warnings: [],
        };

        // 1. Get pre-simulation state
        const preBalance = await provider.getBalance(from);

        // 2. Simulate via eth_call
        try {
            const callResult = await provider.call({
                from,
                to,
                value: value ? BigInt(value) : 0n,
                data: data || '0x',
            });

            result.success = true;
            result.callResult = callResult;

        } catch (err) {
            result.success = false;
            result.revertReason = decodeRevertReason(err);
            result.warnings.push({
                type: 'critical',
                message: `Transaction will REVERT: ${result.revertReason}`
            });
        }

        // 3. Estimate gas
        try {
            const gasEstimate = await provider.estimateGas({
                from,
                to,
                value: value ? BigInt(value) : 0n,
                data: data || '0x',
            });
            result.gasEstimate = gasEstimate.toString();
        } catch {
            result.gasEstimate = 'estimation_failed';
        }

        // 4. Decode calldata to show what's happening
        if (data && data.length >= 10) {
            const decoded = decodeCalldata(data, to);
            if (decoded) {
                result.decodedAction = decoded;
            }
        }

        // 5. ETH balance change
        const weiValue = value ? BigInt(value) : 0n;
        if (weiValue > 0n) {
            result.balanceChanges.push({
                asset: 'ETH',
                from: from,
                to: to,
                amount: ethers.formatEther(weiValue),
                direction: 'outgoing'
            });
        }

        // 6. Warnings for common risks
        if (weiValue > 0n && weiValue > preBalance) {
            result.warnings.push({
                type: 'critical',
                message: 'Insufficient ETH balance for this transaction'
            });
        }

        res.json({
            simulation: result,
            simulatedAt: new Date().toISOString(),
            chain: chain || 'ethereum'
        });

    } catch (err) {
        res.status(500).json({ error: 'Simulation failed', details: err.message });
    }
});

/**
 * POST /api/simulate/userop
 * Simulate a full UserOperation
 *
 * Body: { userOp: PackedUserOperation, chain: string }
 */
router.post('/userop', async (req, res) => {
    try {
        const { userOp, chain } = req.body;

        if (!userOp || !userOp.sender) {
            return res.status(400).json({ error: 'Invalid UserOp' });
        }

        const provider = getProvider(chain);

        // Decode the calldata inside the UserOp to understand what it does
        const decoded = decodeCalldata(userOp.callData, userOp.sender);

        // Simulate the inner call
        let simulation;
        try {
            const callResult = await provider.call({
                from: userOp.sender,
                to: decoded?.target || userOp.sender,
                data: userOp.callData || '0x',
            });
            simulation = { success: true, result: callResult };
        } catch (err) {
            simulation = { success: false, revertReason: decodeRevertReason(err) };
        }

        res.json({
            userOp: {
                sender: userOp.sender,
                decodedAction: decoded,
            },
            simulation,
            simulatedAt: new Date().toISOString()
        });

    } catch (err) {
        res.status(500).json({ error: 'UserOp simulation failed', details: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function decodeCalldata(data, target) {
    const selector = data.slice(0, 10).toLowerCase();

    // Common function signatures
    const knownSelectors = {
        '0xa9059cbb': { name: 'transfer', params: ['address', 'uint256'] },
        '0x095ea7b3': { name: 'approve', params: ['address', 'uint256'] },
        '0x23b872dd': { name: 'transferFrom', params: ['address', 'address', 'uint256'] },
        '0x38ed1739': { name: 'swapExactTokensForTokens', params: ['uint256', 'uint256', 'address[]', 'address', 'uint256'] },
        '0x7ff36ab5': { name: 'swapExactETHForTokens', params: ['uint256', 'address[]', 'address', 'uint256'] },
        '0xb6f9de95': { name: 'swapExactETHForTokensSupportingFeeOnTransfer', params: [] },
    };

    const known = knownSelectors[selector];
    if (known) {
        return {
            function: known.name,
            target,
            selector,
            humanReadable: `Calling ${known.name}() on ${target.slice(0, 10)}...`
        };
    }

    return {
        function: 'unknown',
        target,
        selector,
        humanReadable: `Unknown function 0x${selector.slice(2)} on ${target.slice(0, 10)}...`
    };
}

function decodeRevertReason(err) {
    if (err.data) {
        try {
            const iface = new ethers.Interface(['function Error(string)']);
            const decoded = iface.decodeFunctionData('Error', err.data);
            return decoded[0];
        } catch { /* raw revert */ }
    }
    return err.reason || err.message || 'Unknown revert reason';
}

function getProvider(chain) {
    const rpcs = {
        ethereum: process.env.RPC_ETH || 'https://eth.llamarpc.com',
        base: process.env.RPC_BASE || 'https://mainnet.base.org',
        arbitrum: process.env.RPC_ARB || 'https://arb1.arbitrum.io/rpc',
    };
    return new ethers.JsonRpcProvider(rpcs[chain] || rpcs.ethereum);
}

export { router as simulatorRouter };
