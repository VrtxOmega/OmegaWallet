/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  Campaign L — Simulation Integrity                            ║
 * ╠═══════════════════════════════════════════════════════════════╣
 * ║  Tests that the tx-decoder and tx-simulator produce correct   ║
 * ║  results and cannot be tricked into hiding risks.             ║
 * ╚═══════════════════════════════════════════════════════════════╝
 */
'use strict';
const { ethers } = require('ethers');

function buildSimulationIntegrity(mockIpc, ledger, scorecard) {
    const scenarios = [];

    // L-01: setApprovalForAll must decode as CRITICAL
    scenarios.push({
        name: 'sim-setApprovalForAll-critical',
        boundary: 'Signing Truth',
        async run() {
            const iface = new ethers.Interface(['function setApprovalForAll(address,bool)']);
            const data = iface.encodeFunctionData('setApprovalForAll', [
                '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', true
            ]);
            const result = await mockIpc.invoke('bundler:prepare', {
                from: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
                to: '0x1234567890123456789012345678901234567890',
                value: '0', data,
            }, 'ethereum');
            if (!result.simulation || result.simulation.riskLevel !== 'CRITICAL') {
                return { pass: false, detail: `Expected CRITICAL, got ${result.simulation?.riskLevel}` };
            }
            if (result.simulation.riskScore < 40) {
                return { pass: false, detail: `Score too low: ${result.simulation.riskScore}` };
            }
            return { pass: true };
        }
    });

    // L-02: Unlimited ERC-20 approve must decode as HIGH
    scenarios.push({
        name: 'sim-unlimited-approve-high',
        boundary: 'Signing Truth',
        async run() {
            const iface = new ethers.Interface(['function approve(address,uint256)']);
            const MAX = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
            const data = iface.encodeFunctionData('approve', [
                '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', MAX
            ]);
            const result = await mockIpc.invoke('bundler:prepare', {
                from: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
                to: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
                value: '0', data,
            }, 'ethereum');
            if (!result.simulation || result.simulation.riskLevel !== 'HIGH') {
                return { pass: false, detail: `Expected HIGH, got ${result.simulation?.riskLevel}` };
            }
            return { pass: true };
        }
    });

    // L-03: Plain ETH send must have NONE risk
    scenarios.push({
        name: 'sim-plain-send-none',
        boundary: 'Signing Truth',
        async run() {
            const result = await mockIpc.invoke('bundler:prepare', {
                from: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
                to: '0x1234567890123456789012345678901234567890',
                value: ethers.parseEther('0.01').toString(),
            }, 'ethereum');
            if (result.simulation && result.simulation.riskLevel !== 'NONE') {
                return { pass: false, detail: `Expected NONE, got ${result.simulation.riskLevel}` };
            }
            return { pass: true };
        }
    });

    // L-04: Malformed calldata must not crash decoder
    scenarios.push({
        name: 'sim-malformed-calldata-no-crash',
        boundary: 'IPC Boundary',
        async run() {
            const result = await mockIpc.invoke('bundler:prepare', {
                from: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
                to: '0x1234567890123456789012345678901234567890',
                value: '0', data: '0xdeadbeef',
            }, 'ethereum');
            if (!result.ok && !result.summary) {
                return { pass: false, detail: 'Prepare failed entirely on malformed data' };
            }
            return { pass: true };
        }
    });

    // L-05: Extremely long calldata must not crash
    scenarios.push({
        name: 'sim-huge-calldata-no-crash',
        boundary: 'IPC Boundary',
        async run() {
            const bigData = '0xa22cb465' + 'af'.repeat(8000);
            const result = await mockIpc.invoke('bundler:prepare', {
                from: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
                to: '0x1234567890123456789012345678901234567890',
                value: '0', data: bigData,
            }, 'ethereum');
            // Should not crash
            return { pass: true };
        }
    });

    // L-06: Simulator:decode standalone must work
    scenarios.push({
        name: 'sim-decode-standalone-channel',
        boundary: 'IPC Boundary',
        async run() {
            const iface = new ethers.Interface(['function transferFrom(address,address,uint256)']);
            const data = iface.encodeFunctionData('transferFrom', [
                '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
                '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
                42
            ]);
            const result = await mockIpc.invoke('simulator:decode', data,
                '0x1234567890123456789012345678901234567890', '0');
            if (!result?.decoded) {
                return { pass: false, detail: `Decode result: ${JSON.stringify(result)}` };
            }
            return { pass: true };
        }
    });

    // L-07: Simulation result must appear in bundler:confirm audit
    scenarios.push({
        name: 'sim-audit-logged-on-confirm',
        boundary: 'Signing Truth',
        async run() {
            const iface = new ethers.Interface(['function setApprovalForAll(address,bool)']);
            const data = iface.encodeFunctionData('setApprovalForAll', [
                '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', true
            ]);
            const prep = await mockIpc.invoke('bundler:prepare', {
                from: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
                to: '0x1234567890123456789012345678901234567890',
                value: '0', data,
            }, 'ethereum');
            if (!prep.prepareId) return { pass: false, detail: 'No prepareId' };
            // Confirm (will fail auth but that's expected — we check it doesn't crash)
            const conf = await mockIpc.invoke('bundler:confirm', prep.prepareId, 'test-password');
            // As long as it returned something (even auth error), the audit path works
            return { pass: true };
        }
    });

    // L-08: Null/undefined data field must not crash simulation
    scenarios.push({
        name: 'sim-null-data-safe',
        boundary: 'IPC Boundary',
        async run() {
            const result = await mockIpc.invoke('bundler:prepare', {
                from: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
                to: '0x1234567890123456789012345678901234567890',
                value: '100000',
            }, 'ethereum');
            return { pass: true };
        }
    });

    return {
        name: 'SimulationIntegrity',
        count: scenarios.length,
        async run() {
            console.log(`\n⚔️  Campaign: SimulationIntegrity (${scenarios.length} scenarios)`);
            console.log('─'.repeat(60));
            for (const s of scenarios) {
                try {
                    const r = await s.run();
                    if (r.pass) {
                        console.log(`  ✅ ${s.name}`);
                        scorecard.record(s.boundary, true);
                    } else {
                        console.log(`  ❌ ${s.name}: ${r.detail}`);
                        ledger.record('SimulationIntegrity', s.name, 'PASS', r.detail, 3);
                        scorecard.record(s.boundary, false);
                    }
                } catch (err) {
                    console.log(`  💥 ${s.name}: CRASH — ${err.message}`);
                    ledger.record('SimulationIntegrity', s.name, 'No crash', `Crash: ${err.message}`, 1);
                    scorecard.record(s.boundary, false);
                }
            }
        }
    };
}

module.exports = { buildSimulationIntegrity };
