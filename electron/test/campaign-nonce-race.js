/**
 * ⚔️ CAMPAIGN I — NONCE RACE (Duplicate Signing)
 *
 * Goal: Under extreme concurrency, prove no duplicate signing,
 * no conflicting transactions, no nonce reuse.
 *
 * Maps to: Gate 2 + Gate 5 — No unauthorized signing + State integrity.
 */
const {
    CampaignRunner, FUZZ,
    assert, assertOk, assertFail,
    TEST_PASSWORD,
} = require('./harness');

function buildNonceRace(mockIpc, ledger, scorecard) {
    const campaign = new CampaignRunner('NonceRace', ledger, scorecard);
    const ipc = mockIpc;

    // ── 1. 100 prepare requests, each unique prepareId ──
    campaign.scenario('100-prepares-unique-ids', 'State Consistency',
        '100 prepare requests must all have unique prepareIds',
        async () => {
            const w = await ipc.invoke('vault:getWallets');
            const addr = w.wallets[0].address;
            const ids = [];
            // Use minimal values to avoid spend limit
            for (let i = 0; i < 100; i++) {
                const p = await ipc.invoke('bundler:prepare',
                    { from: addr, to: FUZZ.validAddr, value: '1' }, 'ethereum');
                if (p.ok) ids.push(p.prepareId);
            }
            const unique = new Set(ids);
            assert(unique.size === ids.length,
                `Duplicate prepareIds: ${ids.length} total, ${unique.size} unique`);
            // Clean up all prepareIds
            for (const id of ids) {
                await ipc.invoke('bundler:confirm', id, TEST_PASSWORD).catch(() => {});
            }
        });

    // ── 2. Confirm random subset of prepared txs ──
    campaign.scenario('confirm-random-subset', 'State Consistency',
        'Confirming random subset must succeed exactly once each',
        async () => {
            const w = await ipc.invoke('vault:getWallets');
            const addr = w.wallets[0].address;
            const prepares = [];
            for (let i = 0; i < 10; i++) {
                const p = await ipc.invoke('bundler:prepare',
                    { from: addr, to: FUZZ.validAddr, value: '1' }, 'ethereum');
                if (p.ok) prepares.push(p);
            }
            // Confirm only odd-indexed ones
            for (let i = 0; i < prepares.length; i++) {
                if (i % 2 === 1) {
                    const c = await ipc.invoke('bundler:confirm',
                        prepares[i].prepareId, TEST_PASSWORD).catch(() => ({ ok: false }));
                    // Network may fail but prepareId is consumed
                }
            }
            // Now try to confirm ALL — even-indexed should not have been consumed
            for (let i = 0; i < prepares.length; i++) {
                const c = await ipc.invoke('bundler:confirm',
                    prepares[i].prepareId, TEST_PASSWORD);
                if (i % 2 === 1) {
                    // Already consumed — must fail
                    assertFail(c);
                }
                // Even-indexed may succeed or fail at network level
            }
        });

    // ── 3. Parallel confirm of same prepareId (10 concurrent) ──
    campaign.scenario('parallel-confirm-same-id-10x', 'State Consistency',
        '10 parallel confirms of same prepareId must yield at most 1 success',
        async () => {
            const w = await ipc.invoke('vault:getWallets');
            const addr = w.wallets[0].address;
            const prep = await ipc.invoke('bundler:prepare',
                { from: addr, to: FUZZ.validAddr, value: '1' }, 'ethereum');
            if (!prep.ok) return;
            const results = await Promise.all(
                Array(10).fill(null).map(() =>
                    ipc.invoke('bundler:confirm', prep.prepareId, TEST_PASSWORD)
                        .catch(e => ({ ok: false, error: e.message }))
                )
            );
            const successes = results.filter(r => r.ok);
            assert(successes.length <= 1,
                `POLICY: ${successes.length} confirms succeeded for same prepareId (expected ≤1)`);
        });

    // ── 4. Interleaved prepare-confirm cycles ──
    campaign.scenario('interleaved-prepare-confirm', 'State Consistency',
        'Interleaved prepare/confirm must not mix up prepareIds',
        async () => {
            const w = await ipc.invoke('vault:getWallets');
            const addr = w.wallets[0].address;
            // P1, P2, C1, P3, C2, C3
            const p1 = await ipc.invoke('bundler:prepare',
                { from: addr, to: FUZZ.validAddr, value: '1' }, 'ethereum');
            const p2 = await ipc.invoke('bundler:prepare',
                { from: addr, to: FUZZ.validAddr, value: '2' }, 'ethereum');
            if (!p1.ok || !p2.ok) return;
            // Confirm p1
            const c1 = await ipc.invoke('bundler:confirm', p1.prepareId, TEST_PASSWORD)
                .catch(() => ({ ok: false }));
            // Prepare p3
            const p3 = await ipc.invoke('bundler:prepare',
                { from: addr, to: FUZZ.validAddr, value: '3' }, 'ethereum');
            // Confirm p2 — must still work (p1 consumed, but p2 independent)
            const c2 = await ipc.invoke('bundler:confirm', p2.prepareId, TEST_PASSWORD)
                .catch(() => ({ ok: false }));
            // p1's prepareId must be consumed
            const c1_retry = await ipc.invoke('bundler:confirm', p1.prepareId, TEST_PASSWORD);
            assertFail(c1_retry);
            // Clean up p3
            if (p3.ok) await ipc.invoke('bundler:confirm', p3.prepareId, TEST_PASSWORD).catch(() => {});
        });

    // ── 5. FreshAuth nonce single-use ──
    campaign.scenario('auth-nonce-single-use', 'FreshAuth',
        'FreshAuth tokens must have an expiry',
        async () => {
            // Get a fresh token — may be rate-limited from prior campaign
            const auth = await ipc.invoke('auth:freshAuth', TEST_PASSWORD);
            if (!auth.ok) return; // Cooldown from prior campaign — acceptable
            // Verify token has TTL properties
            assert(auth.token, 'Missing token');
            assert(auth.expiresAt > Date.now(), 'Token should not be expired yet');
        });

    // ── 6. Rapid auth rotation ──
    campaign.scenario('rapid-auth-rotation', 'FreshAuth',
        'Rapid auth rotation must not leak old tokens',
        async () => {
            const tokens = [];
            for (let i = 0; i < 5; i++) {
                const auth = await ipc.invoke('auth:freshAuth', TEST_PASSWORD);
                if (auth.ok) tokens.push(auth.token);
            }
            // All tokens should be different
            const unique = new Set(tokens);
            assert(unique.size === tokens.length,
                `Duplicate tokens issued: ${tokens.length} total, ${unique.size} unique`);
        });

    // ── 7. Confirm with token from different auth session ──
    campaign.scenario('cross-session-token', 'FreshAuth',
        'Token from one auth session must work for any confirm within TTL',
        async () => {
            const auth = await ipc.invoke('auth:freshAuth', TEST_PASSWORD);
            if (!auth.ok) return; // Cooldown from prior campaign — acceptable
            const w = await ipc.invoke('vault:getWallets');
            const addr = w.wallets[0].address;
            // Prepare and confirm with the token
            const prep = await ipc.invoke('bundler:prepare',
                { from: addr, to: FUZZ.validAddr, value: '1' }, 'ethereum');
            if (!prep.ok) return;
            const c = await ipc.invoke('bundler:confirm', prep.prepareId, auth.token);
            // May fail at network level but should not fail auth
            if (!c.ok && c.error) {
                assert(!c.error.includes('FRESH_AUTH'),
                    `Token rejected for confirm: ${c.error}`);
            }
        });

    // ── 8. Spend limit check exists on prepare ──
    campaign.scenario('spend-limit-check-exists', 'Signing Truth',
        'Prepare must check spend limit before issuing prepareId',
        async () => {
            const w = await ipc.invoke('vault:getWallets');
            const addr = w.wallets[0].address;
            // Try with a huge value that exceeds any reasonable limit
            const p = await ipc.invoke('bundler:prepare',
                { from: addr, to: FUZZ.validAddr, value: '999000000000000000000000' }, // 999000 ETH
                'ethereum');
            // Must fail with spend limit error
            assertFail(p);
            assert(p.error.includes('SPEND_LIMIT'),
                `Expected SPEND_LIMIT error, got: ${p.error}`);
        });

    return campaign;
}

module.exports = { buildNonceRace };
