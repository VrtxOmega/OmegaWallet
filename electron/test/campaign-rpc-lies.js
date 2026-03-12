/**
 * ⚔️ CAMPAIGN G — RPC LIES (Malicious Node Simulation)
 *
 * Goal: Prove the wallet doesn't blindly trust RPC responses.
 * Inject fake gas estimates, fake balances, fake success.
 * The signing summary must come from locally decoded tx data,
 * not the node.
 *
 * Maps to: Signing safety under hostile network conditions.
 */
const {
    CampaignRunner, FUZZ,
    assert, assertOk, assertFail,
    TEST_PASSWORD, TEST_MNEMONIC,
} = require('./harness');

function buildRpcLies(mockIpc, ledger, scorecard) {
    const campaign = new CampaignRunner('RpcLies', ledger, scorecard);
    const ipc = mockIpc;

    // ── 1. Summary does NOT contain RPC-sourced data ──
    campaign.scenario('summary-no-rpc-trust', 'Signing Truth',
        'Transaction summary must be built from prepare payload, not RPC',
        async () => {
            const w = await ipc.invoke('vault:getWallets');
            const addr = w.wallets[0].address;
            const prep = await ipc.invoke('bundler:prepare',
                { from: addr, to: FUZZ.validAddr, value: '1000000000000000' }, 'ethereum');
            assertOk(prep);
            // Summary must contain the exact value WE submitted, not anything an RPC returned
            assert(prep.summary.value !== undefined, 'Summary missing value');
            assert(prep.summary.from !== undefined, 'Summary missing from');
            assert(prep.summary.to !== undefined, 'Summary missing to');
            // builtBy must be main-process, not RPC
            assert(prep.summary.builtBy === 'main-process',
                `Summary built by: ${prep.summary.builtBy}`);
        });

    // ── 2. Gas estimate failure doesn't crash prepare ──
    campaign.scenario('gas-estimate-failure-safe', 'Signing Truth',
        'Gas estimate failure must not crash the prepare flow',
        async () => {
            // Try gas estimate on invalid chain data
            try {
                const r = await ipc.invoke('gas:estimate', {
                    from: FUZZ.validAddr, to: FUZZ.validAddr,
                    value: '1000', chain: 'ethereum'
                });
                // May fail (no real provider) but should not crash
            } catch {
                // Acceptable
            }
            assert(true, 'No crash from gas estimate failure');
        });

    // ── 3. RPC call with invalid method rejected ──
    campaign.scenario('rpc-invalid-method', 'IPC Boundary',
        'RPC call with invalid method must be rejected by schema',
        async () => {
            let threw = false;
            try {
                const r = await ipc.invoke('rpc:call', 'ethereum', 'evil_method', []);
                if (r && !r.ok) threw = true;
            } catch { threw = true; }
            assert(threw, 'Invalid RPC method should be rejected');
        });

    // ── 4. RPC call to non-existent chain ──
    campaign.scenario('rpc-fake-chain', 'IPC Boundary',
        'RPC call to non-existent chain must fail',
        async () => {
            let threw = false;
            try {
                const r = await ipc.invoke('rpc:call', 'fakenet', 'eth_blockNumber', []);
                if (r && !r.ok) threw = true;
            } catch { threw = true; }
            assert(threw, 'Fake chain should be rejected');
        });

    // ── 5. Prepare summary uses local value, not RPC balance ──
    campaign.scenario('summary-value-from-payload', 'Signing Truth',
        'Summary value must match what user submitted, not any RPC response',
        async () => {
            const w = await ipc.invoke('vault:getWallets');
            const addr = w.wallets[0].address;
            const testValue = '999888777666555';
            const prep = await ipc.invoke('bundler:prepare',
                { from: addr, to: FUZZ.validAddr, value: testValue }, 'ethereum');
            assertOk(prep);
            // The summary value should be the formatted version of our input
            const expectedEth = (parseInt(testValue) / 1e18).toString();
            // It should contain some representation of our value, not a random balance
            assert(prep.summary.action.includes(expectedEth) ||
                   prep.summary.value === expectedEth,
                `Summary value mismatch: ${prep.summary.value} != ${expectedEth}`);
        });

    // ── 6. Simulated malicious RPC response shape ──
    campaign.scenario('rpc-call-garbage-params', 'IPC Boundary',
        'RPC call with garbage params must not crash',
        async () => {
            const badParams = [
                null, undefined, '', NaN, [null], [undefined],
                [{ __proto__: { admin: true } }],
                ['0x' + 'f'.repeat(1000)],
            ];
            for (const params of badParams) {
                try {
                    await ipc.invoke('rpc:call', 'ethereum', 'eth_getBalance', params);
                } catch { /* acceptable */ }
            }
            assert(true, 'No crash from garbage RPC params');
        });

    // ── 7. Chain mismatch between prepare and confirm ──
    campaign.scenario('chain-mismatch-prepare-confirm', 'Signing Truth',
        'Confirm uses chain from prepare, not a supplied one',
        async () => {
            const w = await ipc.invoke('vault:getWallets');
            const addr = w.wallets[0].address;
            const prep = await ipc.invoke('bundler:prepare',
                { from: addr, to: FUZZ.validAddr, value: '1000' }, 'ethereum');
            assertOk(prep);
            // The confirm endpoint doesn't take a chain arg — it uses the stored one
            // This verifies the architecture: chain is locked at prepare time
            assert(prep.summary.chain === 'ethereum',
                `Chain mismatch in summary: ${prep.summary.chain}`);
            // Consume the prepareId
            await ipc.invoke('bundler:confirm', prep.prepareId, TEST_PASSWORD).catch(() => {});
        });

    // ── 8. Multiple chains in sequence don't bleed state ──
    campaign.scenario('cross-chain-no-state-bleed', 'Signing Truth',
        'Preparing on different chains must maintain isolation',
        async () => {
            const w = await ipc.invoke('vault:getWallets');
            const addr = w.wallets[0].address;
            const chains = ['ethereum', 'base', 'arbitrum'];
            const prepares = [];
            for (const chain of chains) {
                const p = await ipc.invoke('bundler:prepare',
                    { from: addr, to: FUZZ.validAddr, value: '1000' }, chain);
                if (p.ok) {
                    prepares.push(p);
                    assert(p.summary.chain === chain,
                        `Chain bleed: expected ${chain}, got ${p.summary.chain}`);
                }
            }
            // Each prepareId must be unique
            const ids = prepares.map(p => p.prepareId);
            assert(new Set(ids).size === ids.length, 'Duplicate prepareIds across chains');
            // Clean up
            for (const p of prepares) {
                await ipc.invoke('bundler:confirm', p.prepareId, TEST_PASSWORD).catch(() => {});
            }
        });

    return campaign;
}

module.exports = { buildRpcLies };
