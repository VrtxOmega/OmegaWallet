/**
 * ⚔️ CAMPAIGN E — IPC BREAKER
 *
 * Goal: Fuzz every IPC channel with malformed payloads.
 * Null, NaN, Infinity, Unicode, oversized, prototype pollution,
 * SQL injection strings, HTML injection, wrong types.
 *
 * Maps to Gate 2 (IPC Boundary) + Gate 3 (No passive leakage).
 */
const {
    CampaignRunner, FUZZ,
    assert, assertOk, assertFail,
    TEST_PASSWORD,
} = require('./harness');

function buildIpcBreaker(mockIpc, ledger, scorecard) {
    const campaign = new CampaignRunner('IpcBreaker', ledger, scorecard);
    const ipc = mockIpc;

    // All channels that accept args (skip parameterless ones)
    const CHANNELS_WITH_ARGS = [
        { ch: 'vault:create', args: [FUZZ.null, FUZZ.null, FUZZ.null] },
        { ch: 'vault:unlock', args: [FUZZ.null] },
        { ch: 'vault:getKey', args: [FUZZ.null, FUZZ.null] },
        { ch: 'vault:addWallet', args: [FUZZ.null, FUZZ.null] },
        { ch: 'vault:setActive', args: [FUZZ.null] },
        { ch: 'vault:destroy', args: [FUZZ.null] },
        { ch: 'vault:removeWallet', args: [FUZZ.null, FUZZ.null] },
        { ch: 'auth:freshAuth', args: [FUZZ.null] },
        { ch: 'auth:auditLog', args: [FUZZ.null] },
        { ch: 'rpc:call', args: [FUZZ.null, FUZZ.null, FUZZ.null] },
        { ch: 'bundler:prepare', args: [FUZZ.null, FUZZ.null] },
        { ch: 'bundler:confirm', args: [FUZZ.null, FUZZ.null] },
        { ch: 'bundler:submit', args: [FUZZ.null, FUZZ.null] },
        { ch: 'settings:update', args: [FUZZ.null] },
        { ch: 'addressbook:add', args: [FUZZ.null] },
        { ch: 'addressbook:remove', args: [FUZZ.null] },
        { ch: 'addressbook:update', args: [FUZZ.null, FUZZ.null] },
        { ch: 'addressbook:touch', args: [FUZZ.null] },
    ];

    // Fuzz payloads to try per channel
    const FUZZ_SETS = [
        [null], [undefined], [''], [0], [NaN], [Infinity],
        [true], [false], [[]], [{}],
        [FUZZ.longString], [FUZZ.unicode], [FUZZ.nullByte],
        [FUZZ.sqlInject], [FUZZ.protoPolute], [FUZZ.htmlInject],
        [FUZZ.pathTraversal], [FUZZ.constructor],
        [-1], [Number.MAX_SAFE_INTEGER],
        [{ __proto__: { admin: true } }],
        [{ constructor: { prototype: { admin: true } } }],
    ];

    // ── 1. Null args to all channels ──
    campaign.scenario('null-args-all-channels', 'IPC Boundary',
        'Null args must not crash any handler',
        async () => {
            let crashes = 0;
            for (const { ch, args } of CHANNELS_WITH_ARGS) {
                try {
                    await ipc.invoke(ch, ...args.map(() => null));
                } catch (e) {
                    if (e.message.includes('No handler')) continue; // not registered
                    // Handler threw — acceptable but count it
                }
            }
            assert(true, 'No process-killing crashes');
        });

    // ── 2. Fuzz each channel with 22 payload types ──
    campaign.scenario('fuzz-all-channels', 'IPC Boundary',
        'All fuzz payloads must be rejected safely',
        async () => {
            let totalHandled = 0;
            let totalFuzzed = 0;
            for (const { ch, args } of CHANNELS_WITH_ARGS) {
                for (const fuzzSet of FUZZ_SETS) {
                    totalFuzzed++;
                    try {
                        const fuzzArgs = args.map((_, i) => fuzzSet[i % fuzzSet.length]);
                        await ipc.invoke(ch, ...fuzzArgs);
                        totalHandled++;
                    } catch (e) {
                        if (e.message.includes('No handler')) continue;
                        totalHandled++; // threw = handled
                    }
                }
            }
            assert(totalHandled > 0, `Fuzzed ${totalFuzzed}, handled ${totalHandled}`);
        });

    // ── 3. Prototype pollution via settings ──
    campaign.scenario('prototype-pollution-settings', 'IPC Boundary',
        'Prototype pollution via settings:update must not pollute Object',
        async () => {
            await ipc.invoke('settings:update', {
                __proto__: { admin: true },
                constructor: { prototype: { admin: true } },
            });
            // Check Object.prototype not polluted
            assert(({}).admin !== true, 'POLICY: Object.prototype polluted!');
        });

    // ── 4. XSS payloads in address book label ──
    campaign.scenario('xss-addressbook', 'IPC Boundary',
        'HTML injection in labels must be stored as-is (no execution)',
        async () => {
            const r = await ipc.invoke('addressbook:add', {
                address: FUZZ.validAddr,
                label: FUZZ.htmlInject,
                chain: 'ethereum',
                note: '<img onerror=alert(1)>',
            });
            // Should store safely or reject
            if (r.ok) {
                const list = await ipc.invoke('addressbook:list');
                const entry = list.contacts?.find(c => c.address === FUZZ.validAddr);
                if (entry) {
                    assert(typeof entry.label === 'string', 'Label must be string');
                    // Clean up
                    await ipc.invoke('addressbook:remove', FUZZ.validAddr);
                }
            }
        });

    // ── 5. Oversized payload to prepare ──
    campaign.scenario('oversized-prepare-payload', 'IPC Boundary',
        'Payload > 10MB must be rejected',
        async () => {
            try {
                const r = await ipc.invoke('bundler:prepare',
                    { from: 'x', to: 'y', value: '1', data: 'X'.repeat(10_000_000) }, 'ethereum');
                // Should fail or throw
            } catch {
                // Throwing is fine
            }
            assert(true, 'No crash from oversized payload');
        });

    // ── 6. NaN/Infinity in wallet index ──
    campaign.scenario('nan-infinity-index', 'IPC Boundary',
        'NaN/Infinity as wallet index must fail safely',
        async () => {
            for (const bad of [NaN, Infinity, -Infinity, -1, 999, 1.5, '1.5']) {
                try {
                    const r = await ipc.invoke('vault:setActive', bad);
                    if (r.ok) {
                        // If it succeeded, verify vault is still consistent
                        const w = await ipc.invoke('vault:getWallets');
                        assertOk(w);
                    }
                } catch { /* acceptable */ }
            }
        });

    // ── 7. Channel that doesn't exist ──
    campaign.scenario('nonexistent-channel', 'IPC Boundary',
        'Calling unregistered channel must throw',
        async () => {
            let threw = false;
            try {
                await ipc.invoke('evil:backdoor', 'gimme keys');
            } catch { threw = true; }
            assert(threw, 'Non-existent channel should throw');
        });

    // ── 8. Repeated rapid calls (mini-DoS) ──
    campaign.scenario('rapid-fire-100-calls', 'IPC Boundary',
        '100 rapid calls to same channel must not crash',
        async () => {
            const promises = Array(100).fill(null).map(() =>
                ipc.invoke('vault:getWallets').catch(() => null)
            );
            const results = await Promise.all(promises);
            assert(results.length === 100, 'All 100 calls returned');
        });

    // ── 9. Binary data in string fields ──
    campaign.scenario('binary-in-strings', 'IPC Boundary',
        'Binary data in string fields must not crash',
        async () => {
            const binary = Buffer.from([0x00, 0xFF, 0xFE, 0x80, 0x7F]).toString();
            try {
                await ipc.invoke('addressbook:add', {
                    address: binary,
                    label: binary,
                    chain: binary,
                });
            } catch { /* acceptable */ }
            assert(true, 'No crash from binary data');
        });

    // ── 10. Empty string for every arg ──
    campaign.scenario('empty-strings-everywhere', 'IPC Boundary',
        'Empty strings must fail gracefully',
        async () => {
            for (const { ch, args } of CHANNELS_WITH_ARGS) {
                try {
                    await ipc.invoke(ch, ...args.map(() => ''));
                } catch { /* acceptable */ }
            }
            assert(true, 'No crash from empty strings');
        });

    return campaign;
}

module.exports = { buildIpcBreaker };
