#!/usr/bin/env node
/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  SWARM ORCHESTRATOR — OmegaWallet Adversarial Test Runner    ║
 * ╠═══════════════════════════════════════════════════════════════╣
 * ║  Runs all attack campaigns in VERITAS gate order.            ║
 * ║  Produces: Failure Ledger, Boundary Scorecard, Patch Queue.  ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Usage: node test/run-all.js
 */
const path = require('path');
const fs = require('fs');
const {
    FailureLedger, BoundaryScorecard,
    createTestVaultDir, cleanupDir, setupTestEnvironment,
    TEST_PASSWORD, TEST_MNEMONIC, SEV_LABELS,
} = require('./harness');

// Attack campaign builders — Phase 1 (Logical)
const { buildSigningLiar } = require('./campaign-signing-liar');
const { buildFreshAuthKiller } = require('./campaign-freshauth-killer');
const { buildVaultCorruptor } = require('./campaign-vault-corruptor');
const { buildConcurrencyDemon } = require('./campaign-concurrency-demon');
const { buildIpcBreaker } = require('./campaign-ipc-breaker');
const { buildAdminEdgeAbuse } = require('./campaign-admin-edge-abuse');
// Phase 2 (Environmental)
const { buildRpcLies } = require('./campaign-rpc-lies');
const { buildSigningDesync } = require('./campaign-signing-desync');
const { buildNonceRace } = require('./campaign-nonce-race');
const { buildFilesystemCorruption } = require('./campaign-filesystem-corruption');
const { buildRendererCompromise } = require('./campaign-renderer-compromise');
// Phase 3 (v5.0 Feature Campaigns)
const { buildSimulationIntegrity } = require('./campaign-simulation-integrity');
const { buildReceiveSafety, buildOnRampSecurity, buildSwapSecurity } = require('./campaign-v5-features');

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════
async function main() {
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║  ⚔️  OMEGA SWARM — Extreme-Condition Adversarial Suite   ║');
    console.log('║  141 attack scenarios · 15 campaigns · VERITAS gates     ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log(`  Started: ${new Date().toISOString()}`);
    console.log(`  Node:    ${process.version}\n`);

    const startTime = Date.now();
    const ledger = new FailureLedger();
    const scorecard = new BoundaryScorecard();

    // ── Setup: Mock IPC + temp vault dir ──
    const vaultDir = createTestVaultDir();
    console.log(`  Vault dir: ${vaultDir}`);

    let mockIpc;
    try {
        const env = setupTestEnvironment(vaultDir);
        mockIpc = env.mockIpc;

        // Load encrypted-ledger (resolves path via app.getPath which we mocked)
        const { EncryptedLedger } = require(path.resolve(__dirname, '..', 'encrypted-ledger.js'));
        const encLedger = new EncryptedLedger();

        // Load ipc-handlers — call registerHandlers which hooks into our mock ipcMain
        const { registerHandlers } = require(path.resolve(__dirname, '..', 'ipc-handlers.js'));
        registerHandlers(encLedger);

        console.log(`  Handlers registered: ${mockIpc.handlers.size}`);
        console.log('');

        // ── Create initial vault ──
        const createResult = await mockIpc.invoke('vault:create', TEST_PASSWORD, 'SwarmWallet', TEST_MNEMONIC);
        if (!createResult.ok) throw new Error(`Vault creation failed: ${createResult.error}`);
        const unlockResult = await mockIpc.invoke('vault:unlock', TEST_PASSWORD);
        if (!unlockResult.ok) throw new Error(`Vault unlock failed: ${unlockResult.error}`);
        console.log(`  Wallet: ${createResult.address}`);
        console.log('');

        // ═══════════════════════════════════════════════════════
        // CAMPAIGNS — Run in VERITAS gate priority order
        // ═══════════════════════════════════════════════════════

        // Gate 4 — Confirmation truth (most critical for user safety)
        const c1 = buildSigningLiar(mockIpc, ledger, scorecard);
        await c1.run();

        // Refresh vault state between campaigns
        try { await mockIpc.invoke('vault:unlock', TEST_PASSWORD); } catch {}

        // Gate 2 — No unauthorized signing
        const c2 = buildFreshAuthKiller(mockIpc, ledger, scorecard);
        await c2.run();

        try { await mockIpc.invoke('vault:unlock', TEST_PASSWORD); } catch {}

        // Gate 1+3 — Recovery + No passive leakage
        const c3 = buildVaultCorruptor(mockIpc, ledger, scorecard, vaultDir);
        await c3.run();

        try { await mockIpc.invoke('vault:unlock', TEST_PASSWORD); } catch {}

        // Gate 5 — State integrity survives chaos
        const c4 = buildConcurrencyDemon(mockIpc, ledger, scorecard);
        await c4.run();

        try { await mockIpc.invoke('vault:unlock', TEST_PASSWORD); } catch {}

        // Gate 2+3 — IPC boundary fuzzing
        const c5 = buildIpcBreaker(mockIpc, ledger, scorecard);
        await c5.run();

        try { await mockIpc.invoke('vault:unlock', TEST_PASSWORD); } catch {}

        // Gate 2+3 — Admin edge abuse
        const c6 = buildAdminEdgeAbuse(mockIpc, ledger, scorecard);
        await c6.run();

        // ═══════════════════════════════════════════════════════
        // PHASE 2 — ENVIRONMENTAL ATTACK SURFACES
        // ═══════════════════════════════════════════════════════

        try { await mockIpc.invoke('vault:unlock', TEST_PASSWORD); } catch {}

        // RPC lies — malicious node simulation
        const c7 = buildRpcLies(mockIpc, ledger, scorecard);
        await c7.run();

        try { await mockIpc.invoke('vault:unlock', TEST_PASSWORD); } catch {}

        // Signing desync — summary mismatch attacks
        const c8 = buildSigningDesync(mockIpc, ledger, scorecard);
        await c8.run();

        try { await mockIpc.invoke('vault:unlock', TEST_PASSWORD); } catch {}

        // Nonce race — duplicate signing prevention
        const c9 = buildNonceRace(mockIpc, ledger, scorecard);
        await c9.run();

        try { await mockIpc.invoke('vault:unlock', TEST_PASSWORD); } catch {}

        // Filesystem corruption — crash during write simulation
        const c10 = buildFilesystemCorruption(mockIpc, ledger, scorecard, vaultDir);
        await c10.run();

        try { await mockIpc.invoke('vault:unlock', TEST_PASSWORD); } catch {}

        // Renderer compromise — hostile UI simulation
        const c11 = buildRendererCompromise(mockIpc, ledger, scorecard);
        await c11.run();

        try { await mockIpc.invoke('vault:unlock', TEST_PASSWORD); } catch {}

        // Phase 3 — v5.0 Feature Tests
        // Re-create vault to ensure clean state after destructive campaigns
        try { await mockIpc.invoke('vault:destroy', TEST_PASSWORD); } catch {}
        const reCreate = await mockIpc.invoke('vault:create', TEST_PASSWORD, 'SwarmWallet', TEST_MNEMONIC);
        if (!reCreate.ok) console.log('  ⚠ Vault re-create for Phase 3:', reCreate.error);
        const reUnlock = await mockIpc.invoke('vault:unlock', TEST_PASSWORD);
        if (!reUnlock.ok) console.log('  ⚠ Vault re-unlock for Phase 3:', reUnlock.error);
        console.log('\\n  Phase 3 vault ready\\n');

        const c12 = buildSimulationIntegrity(mockIpc, ledger, scorecard);
        await c12.run();

        try { await mockIpc.invoke('vault:unlock', TEST_PASSWORD); } catch {}

        const c13 = buildReceiveSafety(mockIpc, ledger, scorecard);
        await c13.run();

        try { await mockIpc.invoke('vault:unlock', TEST_PASSWORD); } catch {}

        const c14 = buildOnRampSecurity(mockIpc, ledger, scorecard);
        await c14.run();

        try { await mockIpc.invoke('vault:unlock', TEST_PASSWORD); } catch {}

        const c15 = buildSwapSecurity(mockIpc, ledger, scorecard);
        await c15.run();

    } catch (err) {
        console.error(`\n🔴 FATAL SETUP ERROR: ${err.message}`);
        console.error(err.stack);
        ledger.record('Orchestrator', 'setup', 'Clean start', err.message, 1);
    } finally {
        cleanupDir(vaultDir);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    // ═══════════════════════════════════════════════════════════
    // OUTPUT 1: FAILURE LEDGER
    // ═══════════════════════════════════════════════════════════
    ledger.print();

    // ═══════════════════════════════════════════════════════════
    // OUTPUT 2: BOUNDARY SCORECARD
    // ═══════════════════════════════════════════════════════════
    scorecard.print();

    // ═══════════════════════════════════════════════════════════
    // OUTPUT 3: PATCH QUEUE
    // ═══════════════════════════════════════════════════════════
    console.log('\n╔═══════════════════════════════════════════╗');
    console.log('║          PATCH QUEUE                      ║');
    console.log('╚═══════════════════════════════════════════╝');

    const failures = ledger.failures;
    if (failures.length === 0) {
        console.log('  🟢 No patches needed — all scenarios passed.');
    } else {
        // Group by severity
        const grouped = {};
        for (const f of failures) {
            if (!grouped[f.severity]) grouped[f.severity] = [];
            grouped[f.severity].push(f);
        }
        // Print highest severity first
        for (let sev = 5; sev >= 1; sev--) {
            if (!grouped[sev]) continue;
            const icon = sev >= 4 ? '🔴' : sev >= 3 ? '🟠' : sev >= 2 ? '🟡' : '⚪';
            console.log(`\n  ${icon} ${SEV_LABELS[sev]} (${grouped[sev].length}):`);
            for (const f of grouped[sev]) {
                console.log(`    → [${f.agent}] ${f.scenario}`);
                console.log(`      Fix: ${f.actual.slice(0, 100)}`);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    // RELEASE GATE VERDICT
    // ═══════════════════════════════════════════════════════════
    const summary = ledger.summary();
    console.log('\n╔═══════════════════════════════════════════╗');
    console.log('║          RELEASE GATE VERDICT             ║');
    console.log('╚═══════════════════════════════════════════╝');
    console.log(`  Elapsed:    ${elapsed}s`);
    console.log(`  Scenarios:  ${summary.total}`);
    console.log(`  Passed:     ${summary.passed}`);

    let releaseReady = true;
    if (summary.keyLeak > 0) {
        console.log('  🔴 S5 KEY LEAK:       RELEASE BLOCKED');
        releaseReady = false;
    }
    if (summary.unauthAction > 0) {
        console.log('  🔴 S4 UNAUTH ACTION:  RELEASE BLOCKED');
        releaseReady = false;
    }
    if (summary.policyBypass > 0) {
        console.log('  🟠 S3 POLICY BYPASS:  PATCH REQUIRED');
        releaseReady = false;
    }
    if (summary.stateIncon > 0) {
        console.log(`  🟡 S2 STATE INCON:    ${summary.stateIncon} (review needed)`);
    }
    if (summary.crashes > 0) {
        console.log(`  ⚪ S1 CRASHES:        ${summary.crashes} (pre-release acceptable)`);
    }

    if (releaseReady) {
        console.log('\n  ✅ VERDICT: RELEASE GATE PASSED');
        console.log('     Zero S5, Zero S4, Zero S3.');
        console.log('     Wallet survived hostile pressure.');
    } else {
        console.log('\n  ❌ VERDICT: RELEASE GATE FAILED');
        console.log('     Fix all S3+ issues before open-source release.');
    }

    console.log(`\n  Completed: ${new Date().toISOString()}\n`);

    // Write machine-readable report
    const reportPath = path.join(__dirname, 'swarm-report.json');
    fs.writeFileSync(reportPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        elapsed_s: parseFloat(elapsed),
        summary,
        scorecard: scorecard.scores,
        failures: ledger.failures,
        releaseReady,
    }, null, 2));
    console.log(`  Report: ${reportPath}\n`);

    process.exit(releaseReady ? 0 : 1);
}

main().catch(err => {
    console.error('ORCHESTRATOR CRASH:', err);
    process.exit(2);
});
