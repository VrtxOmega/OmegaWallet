/**
 * ═══════════════════════════════════════════════════════════════
 * OmegaWallet — Transaction Simulator
 * ═══════════════════════════════════════════════════════════════
 *
 * Combines calldata decoding + contract analysis into a complete
 * simulation result.  Runs EXCLUSIVELY on the main process —
 * renderer never sees this logic.
 *
 * Advisory only — results are clearly marked as "predicted actions"
 * with a confidence level.
 */
'use strict';

const { ethers } = require('ethers');
const { decodeTxCalldata, shortAddr } = require('./tx-decoder');

// ═══════════════════════════════════════════════════════════════
// CONTRACT ANALYSIS (lightweight, no Cerberus TCP needed)
// ═══════════════════════════════════════════════════════════════

/**
 * Quick contract fingerprinting — is it a contract? How big?
 * Is it a proxy?  Returns metadata without heavy scanning.
 */
async function analyzeContract(provider, address) {
    const info = {
        isContract: false,
        codeSize: 0,
        isProxy: false,
        hasLowBalance: false,
    };

    try {
        const code = await provider.getCode(address);
        if (code === '0x' || code.length < 4) return info;

        info.isContract = true;
        info.codeSize = (code.length - 2) / 2;

        // Proxy detection (EIP-1967 implementation slot)
        try {
            const implSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
            const implAddr = await provider.getStorage(address, implSlot);
            if (implAddr !== '0x' + '00'.repeat(32)) {
                info.isProxy = true;
            }
        } catch { /* not a proxy */ }

        // Balance check
        try {
            const bal = await provider.getBalance(address);
            if (parseFloat(ethers.formatEther(bal)) < 0.001) {
                info.hasLowBalance = true;
            }
        } catch { /* skip */ }

    } catch { /* provider error — degrade gracefully */ }

    return info;
}

// ═══════════════════════════════════════════════════════════════
// RECOMMENDATION ENGINE
// ═══════════════════════════════════════════════════════════════

function computeRecommendation(riskScore, confidence, contractInfo) {
    // CRITICAL risk → always REJECT
    if (riskScore >= 50) return 'REJECT';

    // HIGH risk + suspicious contract → REJECT
    if (riskScore >= 30 && contractInfo.isContract) {
        if (contractInfo.codeSize < 100 || contractInfo.hasLowBalance) {
            return 'REJECT';
        }
        return 'REVIEW';
    }

    // MEDIUM risk → REVIEW
    if (riskScore >= 15) return 'REVIEW';

    // LOW risk → SAFE
    return 'SAFE';
}

// ═══════════════════════════════════════════════════════════════
// MAIN SIMULATION
// ═══════════════════════════════════════════════════════════════

/**
 * Simulate a transaction and produce human-readable risk analysis.
 *
 * This runs on the MAIN PROCESS.  The renderer receives the result
 * as part of the prepare response.  Results are advisory.
 *
 * @param {object} params          - { from, to, value, data, chain }
 * @param {object|null} provider   - ethers provider (optional — for contract analysis)
 * @returns {object}               - simulation result
 */
async function simulateTx({ from, to, value, data, chain }, provider) {
    const simulation = {
        actions: [],
        riskLevel: 'NONE',
        riskScore: 0,
        confidence: 'HIGH',
        recommendation: 'SAFE',
        warnings: [],
        contractInfo: null,
        decoded: false,
        simulatedBy: 'main-process',
        simulatedAt: new Date().toISOString(),
    };

    // ── Step 1: Decode calldata ──────────────────────────────
    const decoded = decodeTxCalldata(data, to, value);
    simulation.actions = decoded.actions;
    simulation.riskScore = decoded.riskScore;
    simulation.riskLevel = decoded.riskLevel;
    simulation.confidence = decoded.confidence;
    simulation.decoded = decoded.decoded;

    // ── Step 2: Contract analysis (if provider available) ────
    if (provider && to) {
        try {
            const contractInfo = await analyzeContract(provider, to);
            simulation.contractInfo = contractInfo;

            // Adjust risk for contract properties
            if (contractInfo.isContract) {
                if (contractInfo.codeSize < 100) {
                    simulation.riskScore += 20;
                    simulation.warnings.push({
                        type: 'warning',
                        message: `Tiny contract (${contractInfo.codeSize} bytes) — possible honeypot`,
                    });
                }

                if (contractInfo.isProxy) {
                    simulation.riskScore += 10;
                    simulation.warnings.push({
                        type: 'info',
                        message: 'Upgradeable proxy — contract logic can be changed by admin',
                    });
                }

                if (contractInfo.hasLowBalance) {
                    simulation.warnings.push({
                        type: 'info',
                        message: 'Contract has very low ETH balance',
                    });
                }
            }
        } catch {
            // Provider error — degrade confidence, don't block
            simulation.confidence = 'LOW';
        }
    }

    // ── Step 3: Add warnings for high-risk decoded actions ───
    for (const action of simulation.actions) {
        if (action.warning) {
            simulation.warnings.push({
                type: action.risk === 'CRITICAL' ? 'critical' : 'warning',
                message: action.warning,
            });
        }
    }

    // ── Step 4: Compute final level + recommendation ─────────
    simulation.riskLevel = scoreToLevel(simulation.riskScore);
    simulation.recommendation = computeRecommendation(
        simulation.riskScore,
        simulation.confidence,
        simulation.contractInfo || {},
    );

    return simulation;
}

function scoreToLevel(score) {
    if (score >= 50) return 'CRITICAL';
    if (score >= 30) return 'HIGH';
    if (score >= 15) return 'MEDIUM';
    if (score > 0) return 'LOW';
    return 'NONE';
}

module.exports = { simulateTx, analyzeContract };
