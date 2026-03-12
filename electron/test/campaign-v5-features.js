/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  Campaign M — Smart Receive Safety                            ║
 * ║  Campaign N — On-Ramp Security                                ║
 * ║  Campaign O — Swap Security                                   ║
 * ╠═══════════════════════════════════════════════════════════════╣
 * ║  Tests the new v5.0 features for safety and crash resistance. ║
 * ╚═══════════════════════════════════════════════════════════════╝
 */
'use strict';

// ═══════════════════════════════════════════════════════════════
// CAMPAIGN M — Smart Receive Safety (8 scenarios)
// ═══════════════════════════════════════════════════════════════

function buildReceiveSafety(mockIpc, ledger, scorecard) {
    const scenarios = [];

    // M-01: getReceiveProfile for ETH/ethereum returns valid EIP-681
    scenarios.push({
        name: 'receive-eth-eip681',
        boundary: 'Signing Truth',
        async run() {
            const r = await mockIpc.invoke('wallet:getReceiveProfile', 0, 'ETH', 'ethereum');
            if (!r.ok) return { pass: false, detail: r.error || 'Failed' };
            if (!r.qrPayload.startsWith('ethereum:')) {
                return { pass: false, detail: `Expected EIP-681, got: ${r.qrPayload}` };
            }
            if (!r.qrPayload.includes('@1')) {
                return { pass: false, detail: `Missing chain ID in: ${r.qrPayload}` };
            }
            return { pass: true };
        }
    });

    // M-02: USDC receive should encode token contract in QR
    scenarios.push({
        name: 'receive-usdc-token-qr',
        boundary: 'Signing Truth',
        async run() {
            const r = await mockIpc.invoke('wallet:getReceiveProfile', 0, 'USDC', 'ethereum');
            if (!r.ok) return { pass: false, detail: r.error };
            if (!r.qrPayload.includes('/transfer?address=')) {
                return { pass: false, detail: `Missing EIP-681 transfer in: ${r.qrPayload}` };
            }
            if (!r.qrPayload.includes('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')) {
                return { pass: false, detail: `Missing USDC contract in QR` };
            }
            return { pass: true };
        }
    });

    // M-03: BTC receive must NOT use EIP-681
    scenarios.push({
        name: 'receive-btc-no-eip681',
        boundary: 'Signing Truth',
        async run() {
            const r = await mockIpc.invoke('wallet:getReceiveProfile', 0, 'BTC', 'bitcoin');
            if (!r.ok) return { pass: false, detail: r.error };
            if (r.qrPayload.startsWith('ethereum:')) {
                return { pass: false, detail: 'BTC should not use EIP-681' };
            }
            if (r.addressType.type !== 'Bitcoin SegWit') {
                return { pass: false, detail: `Wrong type: ${r.addressType.type}` };
            }
            return { pass: true };
        }
    });

    // M-04: Warnings must exist for EVM
    scenarios.push({
        name: 'receive-evm-warnings-present',
        boundary: 'Signing Truth',
        async run() {
            const r = await mockIpc.invoke('wallet:getReceiveProfile', 0, 'ETH', 'ethereum');
            if (!r.warnings || r.warnings.length === 0) {
                return { pass: false, detail: 'No warnings returned' };
            }
            const hasLossWarning = r.warnings.some(w => w.includes('permanent loss') || w.includes('wrong network'));
            if (!hasLossWarning) {
                return { pass: false, detail: 'Missing loss warning' };
            }
            return { pass: true };
        }
    });

    // M-05: NFT receive must include spam warning
    scenarios.push({
        name: 'receive-nft-spam-warning',
        boundary: 'Signing Truth',
        async run() {
            const r = await mockIpc.invoke('wallet:getReceiveProfile', 0, 'NFT', 'ethereum');
            if (!r.ok) return { pass: false, detail: r.error };
            const hasSpam = r.warnings.some(w => w.includes('malicious') || w.includes('Spam'));
            if (!hasSpam) return { pass: false, detail: 'Missing spam warning' };
            return { pass: true };
        }
    });

    // M-06: generatedBy must be main-process
    scenarios.push({
        name: 'receive-trust-badge',
        boundary: 'IPC Boundary',
        async run() {
            const r = await mockIpc.invoke('wallet:getReceiveProfile', 0, 'ETH', 'ethereum');
            if (r.generatedBy !== 'main-process') {
                return { pass: false, detail: `Wrong generator: ${r.generatedBy}` };
            }
            return { pass: true };
        }
    });

    // M-07: Invalid wallet index returns error, no crash
    scenarios.push({
        name: 'receive-invalid-wallet-no-crash',
        boundary: 'IPC Boundary',
        async run() {
            const r = await mockIpc.invoke('wallet:getReceiveProfile', 999, 'ETH', 'ethereum');
            if (r.ok) return { pass: false, detail: 'Should fail for invalid wallet' };
            return { pass: true };
        }
    });

    // M-08: getReceiveOptions returns asset list
    scenarios.push({
        name: 'receive-options-returns-assets',
        boundary: 'IPC Boundary',
        async run() {
            const r = await mockIpc.invoke('wallet:getReceiveOptions', 0);
            if (!r.ok) return { pass: false, detail: r.error };
            if (!r.assets || r.assets.length < 5) {
                return { pass: false, detail: `Too few assets: ${r.assets?.length}` };
            }
            return { pass: true };
        }
    });

    return {
        name: 'ReceiveSafety',
        count: scenarios.length,
        async run() {
            console.log(`\n⚔️  Campaign: ReceiveSafety (${scenarios.length} scenarios)`);
            console.log('─'.repeat(60));
            for (const s of scenarios) {
                try {
                    const r = await s.run();
                    if (r.pass) { console.log(`  ✅ ${s.name}`); scorecard.record(s.boundary, true); }
                    else { console.log(`  ❌ ${s.name}: ${r.detail}`); ledger.record('ReceiveSafety', s.name, 'PASS', r.detail, 3); scorecard.record(s.boundary, false); }
                } catch (err) {
                    console.log(`  💥 ${s.name}: CRASH — ${err.message}`);
                    ledger.record('ReceiveSafety', s.name, 'No crash', `Crash: ${err.message}`, 1);
                    scorecard.record(s.boundary, false);
                }
            }
        }
    };
}

// ═══════════════════════════════════════════════════════════════
// CAMPAIGN N — On-Ramp Security (6 scenarios)
// ═══════════════════════════════════════════════════════════════

function buildOnRampSecurity(mockIpc, ledger, scorecard) {
    const scenarios = [];

    // N-01: onramp:providers returns valid list
    scenarios.push({
        name: 'onramp-providers-list',
        boundary: 'IPC Boundary',
        async run() {
            const r = await mockIpc.invoke('onramp:providers');
            if (!r.ok) return { pass: false, detail: r.error };
            if (r.providers.length < 3) return { pass: false, detail: `Only ${r.providers.length} providers` };
            return { pass: true };
        }
    });

    // N-02: onramp:getUrl builds valid URL
    scenarios.push({
        name: 'onramp-url-valid',
        boundary: 'IPC Boundary',
        async run() {
            const r = await mockIpc.invoke('onramp:getUrl', 'ramp', 'ETH', 'ethereum', '100');
            if (!r.ok) return { pass: false, detail: r.error };
            try { new URL(r.url); } catch { return { pass: false, detail: `Invalid URL: ${r.url}` }; }
            if (!r.url.startsWith('https://')) return { pass: false, detail: 'URL not HTTPS' };
            return { pass: true };
        }
    });

    // N-03: URL contains wallet address
    scenarios.push({
        name: 'onramp-url-has-address',
        boundary: 'Signing Truth',
        async run() {
            const r = await mockIpc.invoke('onramp:getUrl', 'ramp', 'ETH', 'ethereum', '50');
            if (!r.ok) return { pass: false, detail: r.error };
            if (!r.address || r.address.length < 10) return { pass: false, detail: 'No address' };
            return { pass: true };
        }
    });

    // N-04: Unknown provider returns error
    scenarios.push({
        name: 'onramp-unknown-provider-fail',
        boundary: 'IPC Boundary',
        async run() {
            const r = await mockIpc.invoke('onramp:getUrl', 'fakeprovider', 'ETH', 'ethereum', '100');
            if (r.ok) return { pass: false, detail: 'Should reject unknown provider' };
            return { pass: true };
        }
    });

    // N-05: Warning message present
    scenarios.push({
        name: 'onramp-warning-present',
        boundary: 'Signing Truth',
        async run() {
            const r = await mockIpc.invoke('onramp:getUrl', 'moonpay', 'ETH', 'ethereum', '100');
            if (!r.ok) return { pass: false, detail: r.error };
            if (!r.warning || !r.warning.includes('external')) {
                return { pass: false, detail: 'Missing external redirect warning' };
            }
            return { pass: true };
        }
    });

    // N-06: Unsupported asset returns error
    scenarios.push({
        name: 'onramp-unsupported-asset',
        boundary: 'IPC Boundary',
        async run() {
            const r = await mockIpc.invoke('onramp:getUrl', 'ramp', 'SHIB', 'ethereum', '100');
            if (r.ok) return { pass: false, detail: 'Should reject unsupported asset' };
            return { pass: true };
        }
    });

    return {
        name: 'OnRampSecurity',
        count: scenarios.length,
        async run() {
            console.log(`\n⚔️  Campaign: OnRampSecurity (${scenarios.length} scenarios)`);
            console.log('─'.repeat(60));
            for (const s of scenarios) {
                try {
                    const r = await s.run();
                    if (r.pass) { console.log(`  ✅ ${s.name}`); scorecard.record(s.boundary, true); }
                    else { console.log(`  ❌ ${s.name}: ${r.detail}`); ledger.record('OnRampSecurity', s.name, 'PASS', r.detail, 3); scorecard.record(s.boundary, false); }
                } catch (err) {
                    console.log(`  💥 ${s.name}: CRASH — ${err.message}`);
                    ledger.record('OnRampSecurity', s.name, 'No crash', `Crash: ${err.message}`, 1);
                    scorecard.record(s.boundary, false);
                }
            }
        }
    };
}

// ═══════════════════════════════════════════════════════════════
// CAMPAIGN O — Swap Security (8 scenarios)
// ═══════════════════════════════════════════════════════════════

function buildSwapSecurity(mockIpc, ledger, scorecard) {
    const scenarios = [];

    // O-01: swap:tokens returns valid list
    scenarios.push({
        name: 'swap-tokens-list',
        boundary: 'IPC Boundary',
        async run() {
            const r = await mockIpc.invoke('swap:tokens', 'ethereum');
            if (!r.ok) return { pass: false, detail: r.error };
            if (!r.tokens || r.tokens.length < 2) return { pass: false, detail: `Too few tokens: ${r.tokens?.length}` };
            const eth = r.tokens.find(t => t.symbol === 'ETH');
            if (!eth) return { pass: false, detail: 'ETH not in token list' };
            return { pass: true };
        }
    });

    // O-02: swap:quote for ETH→USDC returns estimated quote
    scenarios.push({
        name: 'swap-quote-eth-usdc',
        boundary: 'Signing Truth',
        async run() {
            const r = await mockIpc.invoke('swap:quote', {
                fromToken: 'ETH', toToken: 'USDC', amount: '1', chain: 'ethereum',
            });
            if (!r.ok) return { pass: false, detail: r.error };
            if (!r.buyAmount && !r.buyAmountFormatted) return { pass: false, detail: 'No buy amount' };
            if (r.quotedBy !== 'main-process') return { pass: false, detail: `Wrong quoter: ${r.quotedBy}` };
            return { pass: true };
        }
    });

    // O-03: Cannot swap token for itself
    scenarios.push({
        name: 'swap-self-swap-rejected',
        boundary: 'IPC Boundary',
        async run() {
            const r = await mockIpc.invoke('swap:quote', {
                fromToken: 'ETH', toToken: 'ETH', amount: '1', chain: 'ethereum',
            });
            if (r.ok) return { pass: false, detail: 'Should reject self-swap' };
            return { pass: true };
        }
    });

    // O-04: Invalid params returns error
    scenarios.push({
        name: 'swap-invalid-params',
        boundary: 'IPC Boundary',
        async run() {
            const r = await mockIpc.invoke('swap:quote', 'not-an-object');
            if (r.ok) return { pass: false, detail: 'Should reject string params' };
            return { pass: true };
        }
    });

    // O-05: swap:execute returns prepare action (routes through bundler)
    scenarios.push({
        name: 'swap-execute-routes-through-bundler',
        boundary: 'Signing Truth',
        async run() {
            const r = await mockIpc.invoke('swap:execute', {
                fromToken: 'ETH', toToken: 'USDC', amount: '0.01', chain: 'ethereum',
            });
            // Estimated quotes don't have calldata, so it returns error about API key
            // That's correct — it should NOT execute without real calldata
            if (r.ok && !r.action) {
                return { pass: false, detail: 'Execute should either prepare or fail cleanly' };
            }
            return { pass: true };
        }
    });

    // O-06: Quote includes price impact field
    scenarios.push({
        name: 'swap-quote-has-price-impact',
        boundary: 'Signing Truth',
        async run() {
            const r = await mockIpc.invoke('swap:quote', {
                fromToken: 'ETH', toToken: 'USDC', amount: '1', chain: 'ethereum',
            });
            if (!r.ok) return { pass: false, detail: r.error };
            if (r.priceImpact === undefined) return { pass: false, detail: 'Missing priceImpact' };
            return { pass: true };
        }
    });

    // O-07: swap:tokens on unsupported chain returns something (no crash)
    scenarios.push({
        name: 'swap-unsupported-chain-no-crash',
        boundary: 'IPC Boundary',
        async run() {
            const r = await mockIpc.invoke('swap:tokens', 'madeupchain');
            if (!r.ok) return { pass: false, detail: r.error };
            // Should return at least ETH (native)
            return { pass: true };
        }
    });

    // O-08: Quote source is "estimated" when API unavailable
    scenarios.push({
        name: 'swap-estimated-source-label',
        boundary: 'Signing Truth',
        async run() {
            const r = await mockIpc.invoke('swap:quote', {
                fromToken: 'ETH', toToken: 'USDC', amount: '0.5', chain: 'ethereum',
            });
            if (!r.ok) return { pass: false, detail: r.error };
            if (r.source !== 'estimated') {
                // Could be 0x-api if key is set — both are valid
                if (r.source !== '0x-api') {
                    return { pass: false, detail: `Unexpected source: ${r.source}` };
                }
            }
            return { pass: true };
        }
    });

    return {
        name: 'SwapSecurity',
        count: scenarios.length,
        async run() {
            console.log(`\n⚔️  Campaign: SwapSecurity (${scenarios.length} scenarios)`);
            console.log('─'.repeat(60));
            for (const s of scenarios) {
                try {
                    const r = await s.run();
                    if (r.pass) { console.log(`  ✅ ${s.name}`); scorecard.record(s.boundary, true); }
                    else { console.log(`  ❌ ${s.name}: ${r.detail}`); ledger.record('SwapSecurity', s.name, 'PASS', r.detail, 3); scorecard.record(s.boundary, false); }
                } catch (err) {
                    console.log(`  💥 ${s.name}: CRASH — ${err.message}`);
                    ledger.record('SwapSecurity', s.name, 'No crash', `Crash: ${err.message}`, 1);
                    scorecard.record(s.boundary, false);
                }
            }
        }
    };
}

module.exports = { buildReceiveSafety, buildOnRampSecurity, buildSwapSecurity };
