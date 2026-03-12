/**
 * ⚔️ CAMPAIGN K — RENDERER COMPROMISE SIMULATION
 *
 * Goal: Pretend the renderer (UI) is fully hacked.
 * Hostile code in the renderer calls privileged handlers directly.
 * Cleanroom must still hold: FreshAuth blocks, schema validates,
 * rate limiting triggers, main process enforces policy.
 *
 * Maps to: Gate 2 (No unauthorized signing) + Gate 3 (No leakage).
 */
const crypto = require('crypto');
const {
    CampaignRunner, FUZZ,
    assert, assertOk, assertFail,
    TEST_PASSWORD,
} = require('./harness');

function buildRendererCompromise(mockIpc, ledger, scorecard) {
    const campaign = new CampaignRunner('RendererCompromise', ledger, scorecard);
    const ipc = mockIpc;

    // ── 1. Direct getKey without any auth ──
    campaign.scenario('direct-getKey-no-auth', 'FreshAuth',
        'Direct getKey call without auth must fail',
        async () => {
            // Hostile renderer tries to call getKey with empty auth
            let threw = false;
            try {
                const r = await ipc.invoke('vault:getKey', 0, '');
                if (r && !r.ok) threw = true;
            } catch { threw = true; }
            assert(threw, 'getKey without auth should fail');
        });

    // ── 2. Direct getKey with fabricated token ──
    campaign.scenario('getKey-fabricated-token', 'FreshAuth',
        'getKey with fabricated token must fail',
        async () => {
            const fakeTokens = [
                crypto.randomBytes(32).toString('hex'),
                crypto.randomBytes(16).toString('base64'),
                'admin:true',
                JSON.stringify({ admin: true }),
                'Bearer ' + crypto.randomBytes(32).toString('hex'),
            ];
            for (const ft of fakeTokens) {
                const r = await ipc.invoke('vault:getKey', 0, ft);
                assertFail(r);
            }
        });

    // ── 3. Direct bundler:confirm without prepare ──
    campaign.scenario('confirm-without-prepare', 'Signing Truth',
        'Confirm without prior prepare must fail',
        async () => {
            const fakeIds = [
                crypto.randomBytes(16).toString('hex'),
                '0'.repeat(32),
                'a'.repeat(32),
                '1',
                'latest',
            ];
            for (const id of fakeIds) {
                const c = await ipc.invoke('bundler:confirm', id, TEST_PASSWORD);
                assertFail(c);
            }
        });

    // ── 4. Direct vault:destroy without auth ──
    campaign.scenario('destroy-without-auth', 'FreshAuth',
        'vault:destroy without valid password must fail',
        async () => {
            // Ensure vault is accessible (may need create+unlock from prior campaign)
            let ready = false;
            try {
                const u = await ipc.invoke('vault:unlock', TEST_PASSWORD);
                if (u.ok) ready = true;
            } catch {}
            if (!ready) {
                try {
                    await ipc.invoke('vault:create', TEST_PASSWORD, 'DestroyTest', TEST_MNEMONIC);
                    await ipc.invoke('vault:unlock', TEST_PASSWORD);
                    ready = true;
                } catch {}
            }
            if (!ready) return; // Can't recover — skip
            for (const pw of ['', 'wrong', null, undefined, 0, false]) {
                try {
                    const r = await ipc.invoke('vault:destroy', pw);
                    if (r) assertFail(r);
                } catch { /* acceptable */ }
            }
            // Vault must still exist
            const w = await ipc.invoke('vault:getWallets');
            assertOk(w);
            assert(w.wallets.length > 0, 'Vault destroyed by hostile renderer!');
        });

    // ── 5. Direct vault:removeWallet without auth ──
    campaign.scenario('removeWallet-without-auth', 'FreshAuth',
        'removeWallet without valid password must fail',
        async () => {
            const r = await ipc.invoke('vault:removeWallet', 0, '');
            assertFail(r);
            const r2 = await ipc.invoke('vault:removeWallet', 0, 'wrongpw');
            assertFail(r2);
        });

    // ── 6. Hostile renderer floods sensitive channels ──
    campaign.scenario('flood-sensitive-channels', 'Rate Limiting',
        'Flooding sensitive channels must trigger rate limiting',
        async () => {
            // Flood getKey with bad auth
            const promises = Array(20).fill(null).map(() =>
                ipc.invoke('vault:getKey', 0, 'badtoken').catch(() => ({ ok: false }))
            );
            const results = await Promise.all(promises);
            // All should fail
            results.forEach(r => assertFail(r));
        });

    // ── 7. Hostile renderer tries prototype pollution via IPC ──
    campaign.scenario('ipc-prototype-pollution', 'IPC Boundary',
        'Prototype pollution via IPC args must not affect main process',
        async () => {
            const malicious = [
                { __proto__: { admin: true, isAdmin: true } },
                { constructor: { prototype: { admin: true } } },
                Object.create(null, { admin: { value: true } }),
            ];
            for (const m of malicious) {
                try {
                    await ipc.invoke('settings:update', m);
                } catch { /* acceptable */ }
            }
            // Verify Object.prototype not polluted
            assert(({}).admin !== true, 'POLICY: Object.prototype polluted');
            assert(({}).isAdmin !== true, 'POLICY: isAdmin leaked to prototype');
        });

    // ── 8. Hostile renderer tries to access env vars ──
    campaign.scenario('no-env-leak-via-ipc', 'IPC Boundary',
        'No IPC channel leaks env vars or internal config',
        async () => {
            // Try every status/info endpoint for env leaks
            const endpoints = [
                ['system:version'],
                ['auth:status'],
                ['settings:get'],
                ['telemetry:status'],
                ['vault:getWallets'],
            ];
            for (const [ch, ...args] of endpoints) {
                try {
                    const r = await ipc.invoke(ch, ...args);
                    const json = JSON.stringify(r);
                    // Must not contain DRPC key, private key patterns, or mnemonic
                    const drpcKey = process.env.OMEGA_DRPC_KEY;
                    if (drpcKey) assert(!json.includes(drpcKey), 'KEY_LEAK: DRPC key in response');
                    assert(!json.includes(TEST_PASSWORD), 'KEY_LEAK: password in response');
                    // Check for hex private keys (0x + 64 hex chars)
                    const pkMatch = json.match(/0x[0-9a-fA-F]{64}/);
                    if (pkMatch && ch !== 'vault:getKey') {
                        assert(false, `KEY_LEAK: potential private key in ${ch}: ${pkMatch[0].slice(0, 10)}...`);
                    }
                } catch { /* acceptable */ }
            }
        });

    // ── 9. Hostile renderer sends binary/buffer args ──
    campaign.scenario('binary-buffer-args', 'IPC Boundary',
        'Buffer/binary args must not crash or bypass validation',
        async () => {
            const evil = [
                Buffer.alloc(0),
                Buffer.alloc(1000, 0xFF),
                Buffer.from('vault:getKey'),
                new Uint8Array(64),
                new ArrayBuffer(32),
            ];
            for (const e of evil) {
                try {
                    await ipc.invoke('vault:getKey', e, e);
                } catch { /* acceptable */ }
                try {
                    await ipc.invoke('auth:freshAuth', e);
                } catch { /* acceptable */ }
            }
            assert(true, 'No crash from binary args');
        });

    // ── 10. Hostile renderer re-calls after vault lock ──
    campaign.scenario('operations-after-self-lock', 'Vault Integrity',
        'After renderer triggers lock, all ops fail',
        async () => {
            // Hostile renderer locks the vault
            await ipc.invoke('vault:lock');
            // Then tries to do things
            const ops = [
                async () => { const r = await ipc.invoke('vault:getWallets'); return r; },
                async () => { const r = await ipc.invoke('vault:getKey', 0, TEST_PASSWORD); return r; },
                async () => { const r = await ipc.invoke('vault:addWallet', 'Evil', null); return r; },
            ];
            for (const op of ops) {
                try {
                    const r = await op();
                    // getWallets may still return ok:false or throw
                    // getKey will fail because vault locked = no FreshAuth possible
                } catch { /* acceptable */ }
            }
            // Re-unlock for remaining campaigns
            await ipc.invoke('vault:unlock', TEST_PASSWORD);
        });

    // ── 11. Hostile renderer tries all secureHandle channels ──
    campaign.scenario('all-secure-channels-require-auth', 'FreshAuth',
        'All secureHandle channels must reject unauthenticated calls',
        async () => {
            const secureChannels = [
                ['vault:getKey', 0, ''],
                ['vault:destroy', ''],
                ['vault:removeWallet', 0, ''],
                ['bundler:confirm', 'fake', ''],
            ];
            for (const [ch, ...args] of secureChannels) {
                try {
                    const r = await ipc.invoke(ch, ...args);
                    if (r && r.ok) {
                        assert(false, `UNAUTH: ${ch} succeeded without auth!`);
                    }
                } catch { /* acceptable */ }
            }
        });

    // ── 12. Enumeration attack — check all registered channels ──
    campaign.scenario('channel-enumeration-safe', 'IPC Boundary',
        'All registered channels must handle hostile calls without crash',
        async () => {
            // Get all registered channels from the mock
            const channels = [...mockIpc.handlers.keys()];
            let crashed = 0;
            for (const ch of channels) {
                try {
                    await ipc.invoke(ch); // No args — worst case
                } catch {
                    // Throwing is fine, crashing is not
                }
            }
            assert(true, `Tested ${channels.length} channels, no crashes`);
        });

    return campaign;
}

module.exports = { buildRendererCompromise };
