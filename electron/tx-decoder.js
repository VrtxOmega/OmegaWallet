/**
 * ═══════════════════════════════════════════════════════════════
 * OmegaWallet — Transaction Calldata Decoder
 * ═══════════════════════════════════════════════════════════════
 *
 * Stateless decoder: maps 4‑byte function selectors to human‑readable
 * actions with risk classification.  Runs main‑process only — renderer
 * never sees raw calldata analysis.
 *
 * No external dependencies, no network calls.
 */
'use strict';

const { ethers } = require('ethers');

// ═══════════════════════════════════════════════════════════════
// SELECTOR REGISTRY  (hex → metadata)
// ═══════════════════════════════════════════════════════════════

const SELECTORS = {
    // ── ERC-20 ─────────────────────────────────────────────────
    '0x095ea7b3': {
        name: 'approve',
        standard: 'ERC-20',
        sig: 'approve(address,uint256)',
        params: ['address', 'uint256'],
        riskFn: (args) => {
            const MAX_SAFE = BigInt('0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
            const amount = BigInt(args[1]);
            if (amount >= MAX_SAFE) {
                return {
                    risk: 'HIGH', score: 35,
                    description: `Grant UNLIMITED spending approval to ${shortAddr(args[0])}`,
                    warning: 'This contract can spend ALL your tokens of this type without limit',
                };
            }
            return {
                risk: 'MEDIUM', score: 15,
                description: `Approve ${ethers.formatUnits(amount, 18)} tokens to ${shortAddr(args[0])}`,
                warning: null,
            };
        },
    },
    '0xa9059cbb': {
        name: 'transfer',
        standard: 'ERC-20',
        sig: 'transfer(address,uint256)',
        params: ['address', 'uint256'],
        riskFn: (args) => ({
            risk: 'LOW', score: 5,
            description: `Transfer ${ethers.formatUnits(BigInt(args[1]), 18)} tokens to ${shortAddr(args[0])}`,
            warning: null,
        }),
    },
    '0x23b872dd': {
        name: 'transferFrom',
        standard: 'ERC-20/721',
        sig: 'transferFrom(address,address,uint256)',
        params: ['address', 'address', 'uint256'],
        riskFn: (args) => ({
            risk: 'MEDIUM', score: 15,
            description: `Transfer asset from ${shortAddr(args[0])} to ${shortAddr(args[1])}`,
            warning: null,
        }),
    },

    // ── ERC-721 ────────────────────────────────────────────────
    '0xa22cb465': {
        name: 'setApprovalForAll',
        standard: 'ERC-721/1155',
        sig: 'setApprovalForAll(address,bool)',
        params: ['address', 'bool'],
        riskFn: (args) => {
            const approved = args[1] === true || args[1] === '1' ||
                args[1] === 'true' || BigInt(args[1]) === 1n;
            if (approved) {
                return {
                    risk: 'CRITICAL', score: 50,
                    description: `Grant FULL CONTROL of your NFTs to ${shortAddr(args[0])}`,
                    warning: 'This contract can transfer, sell, or move ALL your NFTs in this collection without asking again',
                };
            }
            return {
                risk: 'LOW', score: 0,
                description: `Revoke approval for ${shortAddr(args[0])}`,
                warning: null,
            };
        },
    },
    '0x42842e0e': {
        name: 'safeTransferFrom',
        standard: 'ERC-721',
        sig: 'safeTransferFrom(address,address,uint256)',
        params: ['address', 'address', 'uint256'],
        riskFn: (args) => ({
            risk: 'MEDIUM', score: 15,
            description: `Transfer NFT #${args[2]} from ${shortAddr(args[0])} to ${shortAddr(args[1])}`,
            warning: null,
        }),
    },
    '0xb88d4fde': {
        name: 'safeTransferFrom',
        standard: 'ERC-721',
        sig: 'safeTransferFrom(address,address,uint256,bytes)',
        params: ['address', 'address', 'uint256', 'bytes'],
        riskFn: (args) => ({
            risk: 'MEDIUM', score: 15,
            description: `Transfer NFT #${args[2]} from ${shortAddr(args[0])} to ${shortAddr(args[1])} (with data)`,
            warning: null,
        }),
    },

    // ── ERC-1155 ───────────────────────────────────────────────
    '0xf242432a': {
        name: 'safeTransferFrom',
        standard: 'ERC-1155',
        sig: 'safeTransferFrom(address,address,uint256,uint256,bytes)',
        params: ['address', 'address', 'uint256', 'uint256', 'bytes'],
        riskFn: (args) => ({
            risk: 'MEDIUM', score: 15,
            description: `Transfer ${args[3]}× token #${args[2]} from ${shortAddr(args[0])} to ${shortAddr(args[1])}`,
            warning: null,
        }),
    },
    '0x2eb2c2d6': {
        name: 'safeBatchTransferFrom',
        standard: 'ERC-1155',
        sig: 'safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)',
        params: ['address', 'address', 'uint256[]', 'uint256[]', 'bytes'],
        riskFn: (args) => ({
            risk: 'HIGH', score: 30,
            description: `Batch transfer multiple tokens from ${shortAddr(args[0])} to ${shortAddr(args[1])}`,
            warning: 'Multiple assets moving in a single call',
        }),
    },

    // ── Common dangerous patterns ──────────────────────────────
    '0xd505accf': {
        name: 'permit',
        standard: 'ERC-2612',
        sig: 'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
        params: ['address', 'address', 'uint256', 'uint256', 'uint8', 'bytes32', 'bytes32'],
        riskFn: (args) => ({
            risk: 'HIGH', score: 35,
            description: `Off-chain permit: approve ${shortAddr(args[1])} to spend tokens from ${shortAddr(args[0])}`,
            warning: 'Permit-based approvals bypass normal approve flow',
        }),
    },
};

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function shortAddr(addr) {
    if (!addr || typeof addr !== 'string') return '???';
    if (addr.length < 10) return addr;
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Decode ABI-encoded parameters from calldata (after 4-byte selector).
 * Returns array of decoded values as strings.
 */
function decodeParams(data, paramTypes) {
    try {
        const coder = ethers.AbiCoder.defaultAbiCoder();
        const payload = '0x' + data.slice(10); // strip selector
        const decoded = coder.decode(paramTypes, payload);
        return decoded.map(v => v.toString());
    } catch {
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════
// MAIN DECODER
// ═══════════════════════════════════════════════════════════════

/**
 * Decode transaction calldata into human-readable actions.
 *
 * @param {string} data   - hex calldata (e.g. '0x095ea7b3...')
 * @param {string} to     - destination address
 * @param {string} value  - wei value being sent
 * @returns {object}      - { actions[], riskLevel, riskScore, confidence, decoded }
 */
function decodeTxCalldata(data, to, value) {
    const result = {
        actions: [],
        riskLevel: 'NONE',
        riskScore: 0,
        confidence: 'HIGH',
        decoded: false,
        functionName: null,
        standard: null,
    };

    // No calldata = simple ETH transfer
    if (!data || data === '0x' || data.length < 10) {
        if (value && BigInt(value || '0') > 0n) {
            result.actions.push({
                type: 'transfer',
                description: `Send ${ethers.formatEther(BigInt(value))} ETH to ${shortAddr(to)}`,
                risk: 'NONE',
            });
        }
        return result;
    }

    // Extract 4-byte selector
    const selector = data.slice(0, 10).toLowerCase();
    const entry = SELECTORS[selector];

    if (!entry) {
        // Unknown function — can't decode, lower confidence
        result.confidence = 'LOW';
        result.riskScore = 10;
        result.riskLevel = 'LOW';
        result.actions.push({
            type: 'unknown',
            description: `Unknown contract call (${selector}) to ${shortAddr(to)}`,
            risk: 'LOW',
        });

        // If also sending ETH, note it
        if (value && BigInt(value || '0') > 0n) {
            result.actions.push({
                type: 'transfer',
                description: `Also sending ${ethers.formatEther(BigInt(value))} ETH`,
                risk: 'MEDIUM',
            });
            result.riskScore += 10;
        }

        result.riskLevel = scoreToLevel(result.riskScore);
        return result;
    }

    // Decode parameters
    const args = decodeParams(data, entry.params);
    result.functionName = entry.name;
    result.standard = entry.standard;

    if (args) {
        result.decoded = true;
        const analysis = entry.riskFn(args);
        result.riskScore = analysis.score;
        result.riskLevel = analysis.risk;
        result.actions.push({
            type: entry.name,
            description: analysis.description,
            risk: analysis.risk,
            warning: analysis.warning,
        });
    } else {
        // Known selector but failed to decode args
        result.confidence = 'MEDIUM';
        result.riskScore = 20;
        result.riskLevel = 'MEDIUM';
        result.actions.push({
            type: entry.name,
            description: `${entry.name} call to ${shortAddr(to)} (parameters could not be decoded)`,
            risk: 'MEDIUM',
        });
    }

    // ETH being sent alongside contract call
    if (value && BigInt(value || '0') > 0n) {
        result.actions.push({
            type: 'transfer',
            description: `Also sending ${ethers.formatEther(BigInt(value))} ETH`,
            risk: 'LOW',
        });
    }

    result.riskLevel = scoreToLevel(result.riskScore);
    return result;
}

function scoreToLevel(score) {
    if (score >= 50) return 'CRITICAL';
    if (score >= 30) return 'HIGH';
    if (score >= 15) return 'MEDIUM';
    if (score > 0) return 'LOW';
    return 'NONE';
}

module.exports = { decodeTxCalldata, shortAddr, SELECTORS };
