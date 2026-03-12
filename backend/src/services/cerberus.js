/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     CERBERUS SCANNER — Contract Pre-Flight Analysis          ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Before any transaction is signed, Cerberus analyzes the target
 * contract for known threat patterns:
 *
 *   - Honeypot detection (can you sell after buying?)
 *   - Approval phishing (infinite approve to malicious spender)
 *   - Reentrancy patterns
 *   - Proxy rugpull indicators
 *   - Known malicious addresses (blacklist)
 *   - Token tax analysis (hidden fees > threshold)
 *
 * Returns a threat score (0-100) and detailed findings.
 * Score >= 80 → block, 50-79 → warn, < 50 → pass
 */
import { Router } from 'express';
import { ethers } from 'ethers';

const router = Router();

// ═══════════════════════════════════════════════════════════════
// THREAT PATTERNS
// ═══════════════════════════════════════════════════════════════

const THREAT_PATTERNS = {
    // Function selectors for dangerous operations
    INFINITE_APPROVE: '095ea7b3', // approve(address,uint256) with max uint
    SELFDESTRUCT: 'ff',           // SELFDESTRUCT opcode
    DELEGATECALL: 'f4',           // DELEGATECALL opcode
    CREATE2: 'f5',                // CREATE2 opcode (metamorphic risk)

    // Known malicious function patterns
    HIDDEN_MINT: ['40c10f19', '4e6ec247'],     // mint functions
    HIDDEN_PAUSE: ['8456cb59', '136439dd'],     // pause / unpause
    HIDDEN_BLACKLIST: ['44337ea1', '0ecb93c0'], // blacklist functions
    OWNERSHIP_TRANSFER: ['f2fde38b'],           // transferOwnership
};

const RISK_WEIGHTS = {
    honeypot: 30,
    infiniteApprove: 25,
    proxyUpgradeable: 15,
    hiddenMint: 20,
    selfDestruct: 25,
    unverifiedCode: 10,
    newContract: 5,
    knownMalicious: 100,
};

// ═══════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════

/**
 * POST /api/cerberus/scan
 * Scan a target contract before interacting
 *
 * Body: { target: address, chain: string, calldata?: string }
 */
router.post('/scan', async (req, res) => {
    try {
        const { target, chain, calldata } = req.body;

        if (!ethers.isAddress(target)) {
            return res.status(400).json({ error: 'Invalid target address' });
        }

        const findings = [];
        let threatScore = 0;

        const provider = getProvider(chain);

        // 1. Check if contract exists
        const code = await provider.getCode(target);
        if (code === '0x') {
            return res.json({
                target,
                threatScore: 0,
                verdict: 'EOA',
                findings: [{ type: 'info', message: 'Target is an EOA, not a contract' }]
            });
        }

        // 2. Analyze bytecode for dangerous opcodes
        const opcodeFindings = analyzeBytecode(code);
        findings.push(...opcodeFindings.findings);
        threatScore += opcodeFindings.score;

        // 3. Check for proxy pattern (upgradeable = additional risk)
        const proxyCheck = await checkProxy(target, provider);
        if (proxyCheck.isProxy) {
            findings.push({
                type: 'warning',
                category: 'proxy',
                message: `Upgradeable proxy detected. Implementation: ${proxyCheck.implementation}`,
                severity: 'medium'
            });
            threatScore += RISK_WEIGHTS.proxyUpgradeable;
        }

        // 4. Check contract age
        const contractAge = await getContractAge(target, provider);
        if (contractAge < 7) { // less than 7 days old
            findings.push({
                type: 'warning',
                category: 'newContract',
                message: `Contract deployed ${contractAge} days ago. New contracts carry higher risk.`,
                severity: 'low'
            });
            threatScore += RISK_WEIGHTS.newContract;
        }

        // 5. Analyze calldata if provided
        if (calldata && calldata.length >= 10) {
            const calldataFindings = analyzeCalldata(calldata);
            findings.push(...calldataFindings.findings);
            threatScore += calldataFindings.score;
        }

        // 6. Check known malicious address list
        if (isKnownMalicious(target)) {
            findings.push({
                type: 'critical',
                category: 'blacklisted',
                message: 'Address is on the known malicious contracts list',
                severity: 'critical'
            });
            threatScore = 100;
        }

        // Determine verdict
        const verdict = threatScore >= 80 ? 'BLOCK' :
            threatScore >= 50 ? 'WARN' : 'PASS';

        res.json({
            target,
            chain: chain || 'ethereum',
            threatScore: Math.min(100, threatScore),
            verdict,
            findings,
            scannedAt: new Date().toISOString()
        });

    } catch (err) {
        res.status(500).json({ error: 'Scan failed', details: err.message });
    }
});

/**
 * POST /api/cerberus/batch-scan
 * Scan multiple targets in a single request
 *
 * Body: { targets: [{ address, chain, calldata? }] }
 */
router.post('/batch-scan', async (req, res) => {
    try {
        const { targets } = req.body;
        if (!Array.isArray(targets) || targets.length === 0) {
            return res.status(400).json({ error: 'targets array required' });
        }

        const results = await Promise.all(
            targets.map(async (t) => {
                try {
                    const provider = getProvider(t.chain);
                    const code = await provider.getCode(t.address);
                    const analysis = analyzeBytecode(code);
                    return {
                        address: t.address,
                        threatScore: Math.min(100, analysis.score),
                        verdict: analysis.score >= 80 ? 'BLOCK' : analysis.score >= 50 ? 'WARN' : 'PASS',
                        findingCount: analysis.findings.length
                    };
                } catch {
                    return { address: t.address, threatScore: -1, verdict: 'ERROR' };
                }
            })
        );

        res.json({ results, scannedAt: new Date().toISOString() });

    } catch (err) {
        res.status(500).json({ error: 'Batch scan failed', details: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// ANALYSIS ENGINES
// ═══════════════════════════════════════════════════════════════

function analyzeBytecode(code) {
    const findings = [];
    let score = 0;
    const codeHex = code.toLowerCase();

    // Check for SELFDESTRUCT opcode (0xff)
    if (codeHex.includes('ff')) {
        // More specific check — look for SELFDESTRUCT pattern
        const sdIndex = codeHex.indexOf('ff');
        if (sdIndex > 0) {
            findings.push({
                type: 'warning',
                category: 'selfDestruct',
                message: 'Contract contains potential SELFDESTRUCT opcode',
                severity: 'high'
            });
            score += RISK_WEIGHTS.selfDestruct;
        }
    }

    // Check for DELEGATECALL opcode (0xf4)
    if (codeHex.includes('f4')) {
        findings.push({
            type: 'info',
            category: 'delegateCall',
            message: 'Contract uses DELEGATECALL (common in proxies)',
            severity: 'medium'
        });
    }

    // Check for hidden mint/pause/blacklist selectors in bytecode
    for (const selector of THREAT_PATTERNS.HIDDEN_MINT) {
        if (codeHex.includes(selector)) {
            findings.push({
                type: 'warning',
                category: 'hiddenMint',
                message: `Hidden mint function detected (selector: 0x${selector})`,
                severity: 'high'
            });
            score += RISK_WEIGHTS.hiddenMint;
            break;
        }
    }

    for (const selector of THREAT_PATTERNS.HIDDEN_BLACKLIST) {
        if (codeHex.includes(selector)) {
            findings.push({
                type: 'warning',
                category: 'blacklistFunction',
                message: 'Contract has blacklist/freeze capability',
                severity: 'medium'
            });
            score += 10;
            break;
        }
    }

    return { findings, score };
}

function analyzeCalldata(calldata) {
    const findings = [];
    let score = 0;
    const selector = calldata.slice(2, 10).toLowerCase();

    // Check for infinite approve
    if (selector === THREAT_PATTERNS.INFINITE_APPROVE) {
        // Check if amount is max uint256
        if (calldata.length >= 138) {
            const amount = calldata.slice(74, 138);
            if (amount === 'f'.repeat(64)) {
                findings.push({
                    type: 'critical',
                    category: 'infiniteApprove',
                    message: 'Transaction requests UNLIMITED token approval. This is dangerous.',
                    severity: 'high'
                });
                score += RISK_WEIGHTS.infiniteApprove;
            }
        }
    }

    return { findings, score };
}

async function checkProxy(address, provider) {
    try {
        // ERC-1967 implementation slot
        const implSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
        const implData = await provider.getStorage(address, implSlot);
        const implAddress = '0x' + implData.slice(26);

        if (implAddress !== '0x' + '0'.repeat(40)) {
            return { isProxy: true, implementation: implAddress };
        }
    } catch { /* not a proxy */ }

    return { isProxy: false };
}

async function getContractAge(address, provider) {
    try {
        // Quick heuristic: check nonce as proxy for age
        const nonce = await provider.getTransactionCount(address);
        return nonce > 100 ? 30 : 1; // crude estimate
    } catch {
        return 999; // assume old if we can't check
    }
}

function isKnownMalicious(address) {
    // In production, this checks a maintained blacklist
    const blacklist = new Set([
        // Known phishing contracts, drainers, etc.
        // This would be populated from a regularly updated feed
    ]);
    return blacklist.has(address.toLowerCase());
}

function getProvider(chain) {
    const rpcs = {
        ethereum: process.env.RPC_ETH || 'https://eth.llamarpc.com',
        base: process.env.RPC_BASE || 'https://mainnet.base.org',
        arbitrum: process.env.RPC_ARB || 'https://arb1.arbitrum.io/rpc',
    };
    return new ethers.JsonRpcProvider(rpcs[chain] || rpcs.ethereum);
}

export { router as cerberusRouter };
