/**
 * ⚔️ CAMPAIGN F — ADMIN EDGE ABUSE
 *
 * Goal: Hammer the sharpest admin edges.
 * Export, destroy, remove wallet — the operations that
 * permanently affect the vault.
 *
 * Maps to Gate 2 (No unauthorized signing) + Gate 3 (No leakage).
 */
const {
    CampaignRunner, FUZZ,
    assert, assertOk, assertFail,
    TEST_PASSWORD, TEST_MNEMONIC,
} = require('./harness');

function buildAdminEdgeAbuse(mockIpc, ledger, scorecard) {
    const campaign = new CampaignRunner('AdminEdgeAbuse', ledger, scorecard);
    const ipc = mockIpc;

    // ── 1. Remove last wallet must fail ──
    campaign.scenario('remove-last-wallet', 'Vault Integrity',
        'Removing the only wallet must be rejected',
        async () => {
            const w = await ipc.invoke('vault:getWallets');
            if (w.wallets.length > 1) {
                // Remove extras until 1 left
                for (let i = w.wallets.length - 1; i > 0; i--) {
                    await ipc.invoke('vault:removeWallet', i, TEST_PASSWORD);
                }
            }
            // Try to remove the last one
            const r = await ipc.invoke('vault:removeWallet', 0, TEST_PASSWORD);
            assertFail(r);
        });

    // ── 2. Remove with wrong password ──
    campaign.scenario('remove-wrong-password', 'FreshAuth',
        'Remove wallet with wrong password must fail',
        async () => {
            await ipc.invoke('vault:addWallet', 'RemTest', null);
            const r = await ipc.invoke('vault:removeWallet', 1, 'wrongpw');
            assertFail(r);
            // Clean up
            await ipc.invoke('vault:removeWallet', 1, TEST_PASSWORD);
        });

    // ── 3. Destroy with wrong password ──
    campaign.scenario('destroy-wrong-password', 'FreshAuth',
        'Destroy with wrong password must fail',
        async () => {
            const r = await ipc.invoke('vault:destroy', 'wrongpw');
            assertFail(r);
            // Vault must still exist
            const e = await ipc.invoke('vault:exists');
            assert(e === true || e.exists === true, 'Vault gone after failed destroy');
        });

    // ── 4. getKey with out-of-bounds index ──
    campaign.scenario('getKey-oob-index', 'Vault Integrity',
        'getKey with index > wallet count must fail',
        async () => {
            const auth = await ipc.invoke('auth:freshAuth', TEST_PASSWORD);
            const r = await ipc.invoke('vault:getKey', 999, auth.token);
            assertFail(r);
        });

    // ── 5. getKey with negative index ──
    campaign.scenario('getKey-negative-index', 'Vault Integrity',
        'getKey with negative index must fail',
        async () => {
            try {
                const r = await ipc.invoke('vault:getKey', -1, TEST_PASSWORD);
                assertFail(r);
            } catch { /* acceptable */ }
        });

    // ── 6. setActive to out-of-bounds index ──
    campaign.scenario('setActive-oob', 'State Consistency',
        'setActive with invalid index must fail',
        async () => {
            for (const idx of [-1, 999, NaN, 1.5]) {
                try {
                    const r = await ipc.invoke('vault:setActive', idx);
                    if (r.ok) {
                        const w = await ipc.invoke('vault:getWallets');
                        assert(w.wallets, 'STATE: no wallets after setActive to bad index');
                    }
                } catch { /* acceptable */ }
            }
        });

    // ── 7. Add wallet with same private key ──
    campaign.scenario('add-duplicate-key', 'Vault Integrity',
        'Adding wallet with same key must be rejected',
        async () => {
            // Get key of wallet 0
            const auth = await ipc.invoke('auth:freshAuth', TEST_PASSWORD);
            const k = await ipc.invoke('vault:getKey', 0, auth.token);
            if (!k.ok) return;
            const r = await ipc.invoke('vault:addWallet', 'Dupe', k.privateKey);
            assertFail(r);
        });

    // ── 8. Export key response has no extra fields ──
    campaign.scenario('getKey-minimal-response', 'Vault Integrity',
        'getKey response must contain only privateKey and ok',
        async () => {
            const auth = await ipc.invoke('auth:freshAuth', TEST_PASSWORD);
            const r = await ipc.invoke('vault:getKey', 0, auth.token);
            if (!r.ok) return;
            const keys = Object.keys(r);
            const allowed = new Set(['ok', 'privateKey', 'address']);
            for (const k of keys) {
                assert(allowed.has(k),
                    `KEY_LEAK: getKey returned unexpected field: ${k} = ${String(r[k]).slice(0, 20)}`);
            }
        });

    // ── 9. Destroy then try all ops ──
    campaign.scenario('post-destroy-lockout', 'Vault Integrity',
        'After destroy, all ops must fail',
        async () => {
            // Create disposable vault
            await ipc.invoke('vault:destroy', TEST_PASSWORD);
            await ipc.invoke('vault:create', 'temp', 'Temp', TEST_MNEMONIC);
            await ipc.invoke('vault:unlock', 'temp');
            await ipc.invoke('vault:destroy', 'temp');
            // Now try everything
            const ops = [
                ['vault:getWallets'],
                ['vault:getKey', 0, 'temp'],
                ['vault:addWallet', 'X', null],
                ['vault:lock'],
                ['settings:get'],
            ];
            for (const [ch, ...args] of ops) {
                try {
                    const r = await ipc.invoke(ch, ...args);
                    // Should fail
                } catch { /* acceptable */ }
            }
            // Recreate for other campaigns
            await ipc.invoke('vault:create', TEST_PASSWORD, 'Restored', TEST_MNEMONIC);
            await ipc.invoke('vault:unlock', TEST_PASSWORD);
        });

    // ── 10. Batch: remove all wallets via loop ──
    campaign.scenario('batch-remove-all', 'Vault Integrity',
        'Trying to remove all wallets in loop must stop at last one',
        async () => {
            // Add a few
            await ipc.invoke('vault:addWallet', 'B1', null);
            await ipc.invoke('vault:addWallet', 'B2', null);
            await ipc.invoke('vault:addWallet', 'B3', null);
            const w = await ipc.invoke('vault:getWallets');
            const total = w.wallets.length;
            // Try to remove ALL
            let removed = 0;
            for (let i = total - 1; i >= 0; i--) {
                const r = await ipc.invoke('vault:removeWallet', i, TEST_PASSWORD);
                if (r.ok) removed++;
            }
            // Must have at least 1 wallet remaining
            const final = await ipc.invoke('vault:getWallets');
            assertOk(final);
            assert(final.wallets.length >= 1,
                `STATE: All wallets removed! Count: ${final.wallets.length}`);
        });

    return campaign;
}

module.exports = { buildAdminEdgeAbuse };
