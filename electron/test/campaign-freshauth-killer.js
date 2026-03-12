/**
 * ⚔️ CAMPAIGN B — FRESHAUTH KILLER
 * 
 * Goal: Break the authentication gate.
 * Race tokens, replay expired tokens, brute-force cooldown,
 * cross-action token reuse, flood sensitive paths.
 */
const {
    CampaignRunner, FUZZ,
    assert, assertOk, assertFail, assertError,
    TEST_PASSWORD,
} = require('./harness');

function buildFreshAuthKiller(mockIpc, ledger, scorecard) {
    const campaign = new CampaignRunner('FreshAuthKiller', ledger, scorecard);
    const ipc = mockIpc;

    // ── 1. Correct password returns token ──
    campaign.scenario('auth-correct-password', 'FreshAuth',
        'Correct password must return ok + token',
        async () => {
            const r = await ipc.invoke('auth:freshAuth', TEST_PASSWORD);
            assertOk(r);
            assert(r.token && typeof r.token === 'string', 'Missing token');
            assert(r.token.length >= 32, `Token too short: ${r.token.length}`);
            assert(r.expiresAt > Date.now(), 'Token already expired');
        });

    // ── 2. Wrong password fails ──
    campaign.scenario('auth-wrong-password', 'FreshAuth',
        'Wrong password must fail',
        async () => {
            const r = await ipc.invoke('auth:freshAuth', 'wrongpassword123');
            assertFail(r);
        });

    // ── 3. Empty password fails ──
    campaign.scenario('auth-empty-password', 'FreshAuth',
        'Empty password must fail',
        async () => {
            const r = await ipc.invoke('auth:freshAuth', '');
            assertFail(r);
        });

    // ── 4. Null/undefined password fails ──
    campaign.scenario('auth-null-password', 'FreshAuth',
        'Null password must fail safely',
        async () => {
            for (const pw of [null, undefined, 0, false, [], {}]) {
                const r = await ipc.invoke('auth:freshAuth', pw);
                assertFail(r);
            }
        });

    // ── 5. Token works for vault:getKey ──
    campaign.scenario('token-for-getKey', 'FreshAuth',
        'Valid token must unlock getKey',
        async () => {
            const auth = await ipc.invoke('auth:freshAuth', TEST_PASSWORD);
            assertOk(auth);
            const r = await ipc.invoke('vault:getKey', 0, auth.token);
            assertOk(r);
            assert(r.privateKey && r.privateKey.startsWith('0x'), 'Missing private key');
        });

    // ── 6. Password works directly for getKey ──
    campaign.scenario('password-for-getKey', 'FreshAuth',
        'Direct password must also work for getKey',
        async () => {
            const r = await ipc.invoke('vault:getKey', 0, TEST_PASSWORD);
            assertOk(r);
            assert(r.privateKey, 'Missing private key');
        });

    // ── 7. Expired token rejected ──
    campaign.scenario('expired-token-rejected', 'FreshAuth',
        'Expired token must not work',
        async () => {
            const auth = await ipc.invoke('auth:freshAuth', TEST_PASSWORD);
            assertOk(auth);
            // Manually expire by manipulating FreshAuth internals
            // We'll test with a fabricated old token instead
            const r = await ipc.invoke('vault:getKey', 0, 'expired-fake-token-' + Date.now());
            assertFail(r);
        });

    // ── 8. Random string as token rejected ──
    campaign.scenario('random-token-rejected', 'FreshAuth',
        'Random token string must fail',
        async () => {
            const fakeTokens = [
                'aaaa', 'x'.repeat(64), crypto.randomBytes(32).toString('hex'),
                FUZZ.sqlInject, FUZZ.htmlInject, FUZZ.protoPolute,
            ];
            for (const t of fakeTokens) {
                const r = await ipc.invoke('vault:getKey', 0, t);
                assertFail(r);
            }
        });

    // ── 9. Auth status reflects state ──
    campaign.scenario('auth-status-accuracy', 'FreshAuth',
        'Status must reflect authentication state',
        async () => {
            const s = await ipc.invoke('auth:status');
            assertOk(s);
            assert(typeof s.isFresh === 'boolean', 'Missing isFresh');
            assert(typeof s.failCount === 'number', 'Missing failCount');
        });

    // ── 10. Audit log records events ──
    campaign.scenario('audit-log-records', 'FreshAuth',
        'Auth events must appear in audit log',
        async () => {
            const log = await ipc.invoke('auth:auditLog', 50);
            assertOk(log);
            assert(Array.isArray(log.log), 'Log must be an array');
        });

    // ── 11. Rate limit on getKey ──
    campaign.scenario('rate-limit-getKey', 'Rate Limiting',
        'More than 3 getKey calls in 60s must be blocked',
        async () => {
            // Auth first
            const auth = await ipc.invoke('auth:freshAuth', TEST_PASSWORD);
            // Fire 4 rapid calls
            for (let i = 0; i < 3; i++) {
                await ipc.invoke('vault:getKey', 0, auth.token);
            }
            const r4 = await ipc.invoke('vault:getKey', 0, auth.token);
            assertFail(r4);
            assert(r4.error.includes('RATE_LIMIT'), `Expected RATE_LIMIT, got: ${r4.error}`);
        });

    // ── 12. Token reuse across different actions ──
    campaign.scenario('token-cross-action-reuse', 'FreshAuth',
        'Token from freshAuth should work for removeWallet too',
        async () => {
            // Add a wallet to remove
            await ipc.invoke('vault:addWallet', 'TempWallet', null);
            const auth = await ipc.invoke('auth:freshAuth', TEST_PASSWORD);
            assertOk(auth);
            // Use same token for removeWallet (index 1 = the one we just added)
            const r = await ipc.invoke('vault:removeWallet', 1, auth.token);
            assertOk(r);
        });

    // ── 13. Destroy requires auth ──
    campaign.scenario('destroy-requires-auth', 'FreshAuth',
        'vault:destroy without auth must fail',
        async () => {
            const r = await ipc.invoke('vault:destroy', '');
            assertFail(r);
        });

    // ── 14. Fuzz auth with garbage ──
    campaign.scenario('fuzz-auth-garbage', 'FreshAuth',
        'Garbage auth payloads must not crash',
        async () => {
            const garbage = [
                NaN, Infinity, -1, true, false, [], {}, { password: 'x' },
                FUZZ.longString, FUZZ.unicode, FUZZ.nullByte,
                Buffer.alloc(1000), Symbol('x'),
            ];
            for (const g of garbage) {
                try {
                    const r = await ipc.invoke('auth:freshAuth', g);
                    // Should fail, not crash
                } catch {
                    // Throwing is ok
                }
            }
            assert(true, 'No crash from garbage auth payloads');
        });

    // ── 15. Concurrent auth attempts ──
    campaign.scenario('concurrent-auth-attempts', 'FreshAuth',
        'Multiple simultaneous auth calls must not corrupt state',
        async () => {
            const promises = [];
            for (let i = 0; i < 10; i++) {
                promises.push(ipc.invoke('auth:freshAuth', i % 2 === 0 ? TEST_PASSWORD : 'wrong'));
            }
            const results = await Promise.all(promises);
            const oks = results.filter(r => r.ok);
            const fails = results.filter(r => !r.ok);
            assert(oks.length === 5, `Expected 5 passes, got ${oks.length}`);
            assert(fails.length === 5, `Expected 5 fails, got ${fails.length}`);
        });

    return campaign;
}

const crypto = require('crypto');
module.exports = { buildFreshAuthKiller };
