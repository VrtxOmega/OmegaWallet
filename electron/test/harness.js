/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  SWARM TEST HARNESS — Orchestrator + Mock IPC + Fuzz Engine  ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Infrastructure layer for adversarial swarm testing.
 * Mocks Electron's ipcMain so handlers register as plain functions.
 * Provides: test runner, assertions, fuzz payloads, failure ledger,
 * severity classification, boundary scorecard.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════
// SEVERITY MODEL
// ═══════════════════════════════════════════════════════════════
const SEV = {
    IDEAL: 0,        // No issue
    CRASH: 1,        // App dies, no security violation
    STATE_INCON: 2,  // Bad UX, possible corruption
    POLICY_BYPASS: 3,// Dangerous — policy violated
    UNAUTH_ACTION: 4,// Very dangerous — unauthorized sensitive action
    KEY_LEAK: 5,     // Release blocker — key/signing compromise
};

const SEV_LABELS = ['IDEAL', 'CRASH', 'STATE_INCON', 'POLICY_BYPASS', 'UNAUTH_ACTION', 'KEY_LEAK'];

// ═══════════════════════════════════════════════════════════════
// MOCK IPC MAIN
// ═══════════════════════════════════════════════════════════════
class MockIpcMain {
    constructor() { this.handlers = new Map(); this._listeners = new Map(); }
    handle(channel, fn) { this.handlers.set(channel, fn); }
    on(channel, fn) { this._listeners.set(channel, fn); }
    removeHandler(channel) { this.handlers.delete(channel); }

    // Invoke a handler as if renderer called it
    async invoke(channel, ...args) {
        const h = this.handlers.get(channel);
        if (!h) throw new Error(`No handler for channel: ${channel}`);
        // Pass a fake event object as first arg (like Electron does)
        const event = { sender: { send: () => {} } };
        return h(event, ...args);
    }
}

// ═══════════════════════════════════════════════════════════════
// TEST VAULT FACTORY
// ═══════════════════════════════════════════════════════════════
const TEST_PASSWORD = 'SwarmTest!2026#Secure';
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function createTestVaultDir() {
    const dir = path.join(require('os').tmpdir(), `omega-swarm-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function cleanupDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ═══════════════════════════════════════════════════════════════
// FAILURE LEDGER
// ═══════════════════════════════════════════════════════════════
class FailureLedger {
    constructor() { this.entries = []; this.startTime = Date.now(); }

    record(agent, scenario, expected, actual, severity, repro = '') {
        this.entries.push({
            timestamp: new Date().toISOString(),
            elapsed_ms: Date.now() - this.startTime,
            agent, scenario, expected, actual,
            severity, sevLabel: SEV_LABELS[severity] || 'UNKNOWN',
            repro,
        });
    }

    get failures() { return this.entries.filter(e => e.severity > 0); }
    get criticals() { return this.entries.filter(e => e.severity >= 3); }
    get keyLeaks() { return this.entries.filter(e => e.severity >= 5); }

    summary() {
        const counts = [0, 0, 0, 0, 0, 0];
        this.entries.forEach(e => counts[e.severity]++);
        return {
            total: this.entries.length,
            passed: counts[0],
            crashes: counts[1],
            stateIncon: counts[2],
            policyBypass: counts[3],
            unauthAction: counts[4],
            keyLeak: counts[5],
        };
    }

    print() {
        const s = this.summary();
        console.log('\n╔═══════════════════════════════════════════╗');
        console.log('║          FAILURE LEDGER SUMMARY            ║');
        console.log('╚═══════════════════════════════════════════╝');
        console.log(`  Total scenarios:  ${s.total}`);
        console.log(`  ✅ Passed (S0):   ${s.passed}`);
        console.log(`  💥 Crash (S1):    ${s.crashes}`);
        console.log(`  ⚠️  State (S2):    ${s.stateIncon}`);
        console.log(`  🚨 Policy (S3):   ${s.policyBypass}`);
        console.log(`  ❌ Unauth (S4):   ${s.unauthAction}`);
        console.log(`  🔴 Key Leak (S5): ${s.keyLeak}`);
        if (this.failures.length > 0) {
            console.log('\n── FAILURES ────────────────────────────────');
            this.failures.forEach(f => {
                console.log(`  [${f.sevLabel}] ${f.agent}::${f.scenario}`);
                console.log(`    Expected: ${f.expected}`);
                console.log(`    Actual:   ${f.actual}`);
                if (f.repro) console.log(`    Repro:    ${f.repro}`);
            });
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// BOUNDARY SCORECARD
// ═══════════════════════════════════════════════════════════════
class BoundaryScorecard {
    constructor() {
        this.scores = {
            'IPC Boundary': { pass: 0, fail: 0 },
            'FreshAuth': { pass: 0, fail: 0 },
            'Vault Integrity': { pass: 0, fail: 0 },
            'Signing Truth': { pass: 0, fail: 0 },
            'Recovery Path': { pass: 0, fail: 0 },
            'Rate Limiting': { pass: 0, fail: 0 },
            'State Consistency': { pass: 0, fail: 0 },
        };
    }

    record(boundary, passed) {
        if (!this.scores[boundary]) this.scores[boundary] = { pass: 0, fail: 0 };
        if (passed) this.scores[boundary].pass++;
        else this.scores[boundary].fail++;
    }

    print() {
        console.log('\n╔═══════════════════════════════════════════╗');
        console.log('║          BOUNDARY SCORECARD               ║');
        console.log('╚═══════════════════════════════════════════╝');
        for (const [name, s] of Object.entries(this.scores)) {
            const total = s.pass + s.fail;
            if (total === 0) continue;
            const pct = ((s.pass / total) * 100).toFixed(1);
            const icon = s.fail === 0 ? '✅' : '❌';
            console.log(`  ${icon} ${name.padEnd(20)} ${s.pass}/${total} (${pct}%)`);
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// FUZZ PAYLOAD GENERATOR
// ═══════════════════════════════════════════════════════════════
const FUZZ = {
    // Strings
    empty: '',
    nullByte: '\x00',
    unicode: '🔥💀\u202E\uFEFF',
    longString: 'A'.repeat(100_000),
    sqlInject: "'; DROP TABLE wallets; --",
    protoPolute: '__proto__',
    constructor: 'constructor',
    htmlInject: '<script>alert(1)</script>',
    pathTraversal: '../../../etc/passwd',

    // Numbers
    nan: NaN,
    infinity: Infinity,
    negInfinity: -Infinity,
    maxInt: Number.MAX_SAFE_INTEGER,
    negMaxInt: -Number.MAX_SAFE_INTEGER,
    float: 0.1 + 0.2,
    negative: -1,
    zero: 0,

    // Types
    null: null,
    undefined: undefined,
    true: true,
    false: false,
    emptyObj: {},
    emptyArr: [],
    nestedJunk: { a: { b: { c: { d: { e: 'deep' } } } } },
    circularRef: (() => { const o = {}; o.self = o; return o; })(),
    bigPayload: { data: 'X'.repeat(10_000_000) },

    // Addresses
    validAddr: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', // vitalik.eth
    shortAddr: '0x1234',
    longAddr: '0x' + 'a'.repeat(100),
    noPrefix: 'd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    zeroAddr: '0x' + '0'.repeat(40),

    // Chains
    validChain: 'ethereum',
    badChain: 'notachain',
    emptyChain: '',

    // Build random fuzz set for channel args
    randomArgs(count) {
        const pool = [
            this.empty, this.nullByte, this.unicode, this.longString,
            this.sqlInject, this.protoPolute, this.htmlInject,
            this.nan, this.infinity, this.null, this.undefined,
            this.true, this.false, this.emptyObj, this.emptyArr,
            this.negative, this.zero, this.shortAddr, this.badChain,
            42, -99, 3.14, '', 0,
        ];
        const args = [];
        for (let i = 0; i < count; i++) {
            args.push(pool[Math.floor(Math.random() * pool.length)]);
        }
        return args;
    },
};

// ═══════════════════════════════════════════════════════════════
// ASSERTION HELPERS
// ═══════════════════════════════════════════════════════════════
function assert(condition, msg) {
    if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function assertOk(result, msg = '') {
    assert(result && result.ok === true, `Expected ok:true, got ${JSON.stringify(result)} ${msg}`);
}

function assertFail(result, msg = '') {
    assert(result && result.ok === false, `Expected ok:false, got ${JSON.stringify(result)} ${msg}`);
}

function assertError(result, pattern, msg = '') {
    assertFail(result, msg);
    if (pattern && result.error) {
        assert(result.error.includes(pattern),
            `Expected error containing "${pattern}", got "${result.error}" ${msg}`);
    }
}

function assertThrows(fn, msg = '') {
    let threw = false;
    try { fn(); } catch { threw = true; }
    assert(threw, `Expected throw, none occurred ${msg}`);
}

async function assertThrowsAsync(fn, msg = '') {
    let threw = false;
    try { await fn(); } catch { threw = true; }
    assert(threw, `Expected async throw, none occurred ${msg}`);
}

// ═══════════════════════════════════════════════════════════════
// CAMPAIGN RUNNER
// ═══════════════════════════════════════════════════════════════
class CampaignRunner {
    constructor(name, ledger, scorecard) {
        this.name = name;
        this.ledger = ledger;
        this.scorecard = scorecard;
        this.scenarios = [];
        this.passed = 0;
        this.failed = 0;
    }

    // Register a test scenario
    scenario(name, boundary, expectedBehavior, fn) {
        this.scenarios.push({ name, boundary, expectedBehavior, fn });
    }

    // Run all scenarios
    async run() {
        console.log(`\n⚔️  Campaign: ${this.name} (${this.scenarios.length} scenarios)`);
        console.log('─'.repeat(60));

        for (const s of this.scenarios) {
            try {
                await s.fn();
                this.passed++;
                this.ledger.record(this.name, s.name, s.expectedBehavior, 'PASS', SEV.IDEAL);
                this.scorecard.record(s.boundary, true);
                process.stdout.write(`  ✅ ${s.name}\n`);
            } catch (err) {
                this.failed++;
                // Classify severity from error message
                const sev = err.message.includes('KEY_LEAK') ? SEV.KEY_LEAK
                    : err.message.includes('UNAUTH') ? SEV.UNAUTH_ACTION
                    : err.message.includes('POLICY') ? SEV.POLICY_BYPASS
                    : err.message.includes('STATE') ? SEV.STATE_INCON
                    : SEV.CRASH;
                this.ledger.record(this.name, s.name, s.expectedBehavior, err.message, sev, err.stack?.split('\n')[1]?.trim());
                this.scorecard.record(s.boundary, false);
                process.stdout.write(`  ❌ ${s.name}: ${err.message.slice(0, 80)}\n`);
            }
        }
        console.log(`  ── ${this.passed}/${this.scenarios.length} passed ──\n`);
    }
}

// ═══════════════════════════════════════════════════════════════
// SETUP: Wire mock ipcMain BEFORE requiring ipc-handlers
// ═══════════════════════════════════════════════════════════════
function setupTestEnvironment(vaultDir) {
    const mockIpc = new MockIpcMain();

    // Inject mock ipcMain into require cache
    const electronMock = {
        ipcMain: mockIpc,
        app: { getPath: (key) => vaultDir, getVersion: () => '2.1.0-test' },
        shell: { openExternal: async () => {} },
        BrowserWindow: { getAllWindows: () => [{ webContents: { send: () => {} } }] },
    };

    // Override electron require
    const Module = require('module');
    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, parent, ...rest) {
        if (request === 'electron') return 'electron';
        return origResolve.call(this, request, parent, ...rest);
    };
    require.cache['electron'] = { id: 'electron', filename: 'electron', loaded: true, exports: electronMock };

    // Set vault dir env
    process.env.OMEGA_VAULT_DIR = vaultDir;
    process.env.OMEGA_DRPC_KEY = 'test-key';

    return { mockIpc, electronMock };
}

module.exports = {
    SEV, SEV_LABELS,
    MockIpcMain,
    FailureLedger,
    BoundaryScorecard,
    CampaignRunner,
    FUZZ,
    assert, assertOk, assertFail, assertError, assertThrows, assertThrowsAsync,
    createTestVaultDir, cleanupDir, setupTestEnvironment,
    TEST_PASSWORD, TEST_MNEMONIC,
};
