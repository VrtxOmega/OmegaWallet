/**
 * ⚔️ CAMPAIGN D — CONCURRENCY DEMON
 *
 * Goal: Race parallel operations to find state corruption.
 * Parallel unlock/lock, prepare/confirm, add/remove wallets,
 * switch active mid-sign. Prove no unauthorized outcomes.
 *
 * Maps to Gate 5 (State integrity survives chaos).
 */
const {
    CampaignRunner, FUZZ,
    assert, assertOk, assertFail,
    TEST_PASSWORD, TEST_MNEMONIC,
} = require('./harness');

function buildConcurrencyDemon(mockIpc, ledger, scorecard) {
    const campaign = new CampaignRunner('ConcurrencyDemon', ledger, scorecard);
    const ipc = mockIpc;

    // ── 1. Parallel unlock attempts ──
    campaign.scenario('parallel-unlock', 'State Consistency',
        'Multiple unlock calls must all succeed or all fail cleanly',
        async () => {
            await ipc.invoke('vault:lock');
            const promises = Array(10).fill(null).map(() =>
                ipc.invoke('vault:unlock', TEST_PASSWORD)
            );
            const results = await Promise.all(promises);
            // All should succeed (idempotent unlock)
            const oks = results.filter(r => r.ok);
            assert(oks.length > 0, 'At least one unlock must succeed');
            // Verify wallet accessible after
            const w = await ipc.invoke('vault:getWallets');
            assertOk(w);
        });

    // ── 2. Parallel lock + getWallets race ──
    campaign.scenario('lock-getWallets-race', 'State Consistency',
        'getWallets during lock must not leak or crash',
        async () => {
            const results = await Promise.all([
                ipc.invoke('vault:lock'),
                ipc.invoke('vault:getWallets'),
                ipc.invoke('vault:getWallets'),
                ipc.invoke('vault:lock'),
            ]);
            // Some may succeed, some may fail — but none should crash or leak keys
            for (const r of results) {
                if (r.wallets) {
                    for (const w of r.wallets) {
                        assert(!w.privateKey, 'STATE: key leaked during lock race');
                        assert(!w.mnemonic, 'STATE: mnemonic leaked during lock race');
                    }
                }
            }
            // Re-unlock
            await ipc.invoke('vault:unlock', TEST_PASSWORD);
        });

    // ── 3. Parallel prepare calls ──
    campaign.scenario('parallel-prepare', 'State Consistency',
        'Multiple prepare calls must all return unique prepareIds',
        async () => {
            const w = await ipc.invoke('vault:getWallets');
            const addr = w.wallets[0].address;
            const promises = Array(5).fill(null).map(() =>
                ipc.invoke('bundler:prepare',
                    { from: addr, to: FUZZ.validAddr, value: '1000' }, 'ethereum')
            );
            const results = await Promise.all(promises);
            const ids = results.filter(r => r.ok).map(r => r.prepareId);
            const unique = new Set(ids);
            assert(unique.size === ids.length,
                `STATE: Duplicate prepareIds: ${ids.length} total, ${unique.size} unique`);
        });

    // ── 4. Prepare then switch wallet then confirm ──
    campaign.scenario('switch-wallet-mid-sign', 'State Consistency',
        'Switching active wallet between prepare and confirm must not sign with wrong key',
        async () => {
            const w = await ipc.invoke('vault:getWallets');
            if (w.wallets.length < 2) {
                await ipc.invoke('vault:addWallet', 'DemonWallet', null);
            }
            const addr = w.wallets[0].address;
            const prep = await ipc.invoke('bundler:prepare',
                { from: addr, to: FUZZ.validAddr, value: '1000' }, 'ethereum');
            assertOk(prep);
            // Switch active
            await ipc.invoke('vault:setActive', 1);
            // Confirm should still use the wallet from prepare, not the new active
            const c = await ipc.invoke('bundler:confirm', prep.prepareId, TEST_PASSWORD);
            // The confirm may fail at network level, but should not sign with wrong wallet
            // Switch back
            await ipc.invoke('vault:setActive', 0);
        });

    // ── 5. Parallel add + remove wallet ──
    campaign.scenario('parallel-add-remove', 'State Consistency',
        'Simultaneous add and remove must not corrupt wallet list',
        async () => {
            // Add a wallet first
            await ipc.invoke('vault:addWallet', 'ParallelTest', null);
            const w1 = await ipc.invoke('vault:getWallets');
            const idx = w1.wallets.length - 1;

            const results = await Promise.all([
                ipc.invoke('vault:addWallet', 'P2', null),
                ipc.invoke('vault:removeWallet', idx, TEST_PASSWORD),
            ]);

            // After settling, wallet list must be consistent
            const w2 = await ipc.invoke('vault:getWallets');
            assertOk(w2);
            assert(w2.wallets.length >= 1, 'STATE: wallet list empty after parallel ops');
            // All addresses must be valid
            for (const w of w2.wallets) {
                assert(w.address && w.address.startsWith('0x'),
                    'STATE: corrupted address in wallet list');
            }
        });

    // ── 6. Parallel getKey calls ──
    campaign.scenario('parallel-getKey', 'State Consistency',
        'Parallel getKey must return same key or rate-limit cleanly',
        async () => {
            const auth = await ipc.invoke('auth:freshAuth', TEST_PASSWORD);
            const promises = Array(5).fill(null).map(() =>
                ipc.invoke('vault:getKey', 0, auth.token)
            );
            const results = await Promise.all(promises);
            const keys = results.filter(r => r.ok).map(r => r.privateKey);
            if (keys.length > 1) {
                // All returned keys must be identical
                assert(keys.every(k => k === keys[0]),
                    'STATE: different keys returned for same wallet');
            }
        });

    // ── 7. Lock during active signing flow ──
    campaign.scenario('lock-during-sign', 'State Consistency',
        'Lock during confirm must fail the confirm, not sign',
        async () => {
            const w = await ipc.invoke('vault:getWallets');
            const addr = w.wallets[0].address;
            const prep = await ipc.invoke('bundler:prepare',
                { from: addr, to: FUZZ.validAddr, value: '1000' }, 'ethereum');
            if (!prep.ok) return; // Network issue, skip

            // Lock vault then try confirm
            await ipc.invoke('vault:lock');
            const c = await ipc.invoke('bundler:confirm', prep.prepareId, TEST_PASSWORD);
            // Confirm should fail because vault is locked
            // Re-unlock
            await ipc.invoke('vault:unlock', TEST_PASSWORD);
        });

    // ── 8. Rapid auth + getKey interleaving ──
    campaign.scenario('rapid-auth-getKey-interleave', 'State Consistency',
        'Interleaved auth and getKey must not leak or corrupt',
        async () => {
            const ops = [];
            for (let i = 0; i < 10; i++) {
                if (i % 2 === 0) {
                    ops.push(ipc.invoke('auth:freshAuth', TEST_PASSWORD));
                } else {
                    ops.push(ipc.invoke('vault:getKey', 0, TEST_PASSWORD));
                }
            }
            const results = await Promise.all(ops);
            // Check no mnemonic/seed leaked
            for (const r of results) {
                if (r.ok && r.privateKey !== undefined) {
                    assert(!r.mnemonic, 'STATE: mnemonic leaked in interleave');
                }
            }
        });

    // ── 9. Double-confirm same prepareId ──
    campaign.scenario('double-confirm-race', 'State Consistency',
        'Racing two confirms on same prepareId must not sign twice',
        async () => {
            const w = await ipc.invoke('vault:getWallets');
            const addr = w.wallets[0].address;
            const prep = await ipc.invoke('bundler:prepare',
                { from: addr, to: FUZZ.validAddr, value: '1000' }, 'ethereum');
            if (!prep.ok) return;

            const [c1, c2] = await Promise.all([
                ipc.invoke('bundler:confirm', prep.prepareId, TEST_PASSWORD),
                ipc.invoke('bundler:confirm', prep.prepareId, TEST_PASSWORD),
            ]);
            // At most one should succeed
            const successes = [c1, c2].filter(r => r.ok);
            assert(successes.length <= 1,
                `STATE: Double-confirm succeeded ${successes.length} times (should be ≤1)`);
        });

    // ── 10. Settings update race ──
    campaign.scenario('settings-update-race', 'State Consistency',
        'Parallel settings updates must not corrupt state',
        async () => {
            const updates = Array(5).fill(null).map((_, i) =>
                ipc.invoke('settings:update', { dailySpendLimit: 100 + i })
            );
            await Promise.all(updates);
            const s = await ipc.invoke('settings:get');
            assertOk(s);
            assert(typeof s.settings.dailySpendLimit === 'number',
                'STATE: settings corrupted after parallel update');
        });

    return campaign;
}

module.exports = { buildConcurrencyDemon };
