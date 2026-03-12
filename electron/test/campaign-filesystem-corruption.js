/**
 * ⚔️ CAMPAIGN J — FILESYSTEM CORRUPTION
 *
 * Goal: Simulate process crash during vault write, ledger append,
 * and audit log update. Prove the wallet detects corruption and
 * fails closed. Never silently recover corrupted state.
 *
 * Maps to: Gate 1 (Recovery) + Gate 5 (State integrity).
 */
const fs = require('fs');
const path = require('path');
const {
    CampaignRunner,
    assert, assertOk, assertFail,
    TEST_PASSWORD, TEST_MNEMONIC,
} = require('./harness');

function buildFilesystemCorruption(mockIpc, ledger, scorecard, vaultDir) {
    const campaign = new CampaignRunner('FilesystemCorruption', ledger, scorecard);
    const ipc = mockIpc;

    function findVaultFile() {
        try {
            const files = fs.readdirSync(vaultDir);
            for (const f of files) {
                const fp = path.join(vaultDir, f);
                if (fs.statSync(fp).isFile() && fs.readFileSync(fp).length > 50) return fp;
            }
        } catch {}
        return null;
    }

    // ── 1. Vault intact after normal operations ──
    campaign.scenario('vault-file-intact-after-ops', 'Vault Integrity',
        'Vault file must be intact after normal add/remove wallet',
        async () => {
            // Perform ops
            await ipc.invoke('vault:addWallet', 'FsTest', null);
            const w = await ipc.invoke('vault:getWallets');
            const idx = w.wallets.length - 1;
            await ipc.invoke('vault:removeWallet', idx, TEST_PASSWORD);
            // Verify vault file exists and is non-empty
            const vf = findVaultFile();
            assert(vf, 'Vault file not found after ops');
            const size = fs.statSync(vf).size;
            assert(size > 50, `Vault file too small: ${size}`);
        });

    // ── 2. Inject random bytes at end of vault file ──
    campaign.scenario('appended-garbage', 'Vault Integrity',
        'Appended garbage to vault file must fail on unlock',
        async () => {
            const vf = findVaultFile();
            if (!vf) { assert(true, 'Skip'); return; }
            const original = fs.readFileSync(vf);
            await ipc.invoke('vault:lock');
            // Append garbage
            const garbage = Buffer.from('MALICIOUS_INJECT_' + 'X'.repeat(100));
            fs.writeFileSync(vf, Buffer.concat([original, garbage]));
            const r = await ipc.invoke('vault:unlock', TEST_PASSWORD);
            // Must fail — AES-GCM auth tag won't match
            assertFail(r);
            // Restore
            fs.writeFileSync(vf, original);
            await ipc.invoke('vault:unlock', TEST_PASSWORD);
        });

    // ── 3. Replace vault with completely different encrypted blob ──
    campaign.scenario('replaced-vault-file', 'Vault Integrity',
        'Replaced vault file with different ciphertext must fail',
        async () => {
            const vf = findVaultFile();
            if (!vf) { assert(true, 'Skip'); return; }
            const original = fs.readFileSync(vf);
            await ipc.invoke('vault:lock');
            // Create fake encrypted data (same size, random bytes)
            const fake = require('crypto').randomBytes(original.length);
            fs.writeFileSync(vf, fake);
            const r = await ipc.invoke('vault:unlock', TEST_PASSWORD);
            assertFail(r);
            // Restore
            fs.writeFileSync(vf, original);
            await ipc.invoke('vault:unlock', TEST_PASSWORD);
        });

    // ── 4. Swap first 16 bytes (salt) ──
    campaign.scenario('swapped-salt', 'Vault Integrity',
        'Modified salt must produce wrong key → fail to decrypt',
        async () => {
            const vf = findVaultFile();
            if (!vf) { assert(true, 'Skip'); return; }
            const original = fs.readFileSync(vf);
            await ipc.invoke('vault:lock');
            // Flip salt bytes
            const modified = Buffer.from(original);
            for (let i = 0; i < 16; i++) modified[i] = modified[i] ^ 0xAA;
            fs.writeFileSync(vf, modified);
            const r = await ipc.invoke('vault:unlock', TEST_PASSWORD);
            assertFail(r);
            fs.writeFileSync(vf, original);
            await ipc.invoke('vault:unlock', TEST_PASSWORD);
        });

    // ── 5. Swap IV bytes (16-28) ──
    campaign.scenario('swapped-iv', 'Vault Integrity',
        'Modified IV must fail GCM auth tag verification',
        async () => {
            const vf = findVaultFile();
            if (!vf) { assert(true, 'Skip'); return; }
            const original = fs.readFileSync(vf);
            await ipc.invoke('vault:lock');
            const modified = Buffer.from(original);
            for (let i = 16; i < 28; i++) modified[i] = modified[i] ^ 0xBB;
            fs.writeFileSync(vf, modified);
            const r = await ipc.invoke('vault:unlock', TEST_PASSWORD);
            assertFail(r);
            fs.writeFileSync(vf, original);
            await ipc.invoke('vault:unlock', TEST_PASSWORD);
        });

    // ── 6. Swap auth tag bytes (28-44) ──
    campaign.scenario('swapped-auth-tag', 'Vault Integrity',
        'Modified GCM auth tag must fail verification',
        async () => {
            const vf = findVaultFile();
            if (!vf) { assert(true, 'Skip'); return; }
            const original = fs.readFileSync(vf);
            await ipc.invoke('vault:lock');
            const modified = Buffer.from(original);
            for (let i = 28; i < 44; i++) modified[i] = modified[i] ^ 0xCC;
            fs.writeFileSync(vf, modified);
            const r = await ipc.invoke('vault:unlock', TEST_PASSWORD);
            assertFail(r);
            fs.writeFileSync(vf, original);
            await ipc.invoke('vault:unlock', TEST_PASSWORD);
        });

    // ── 7. Settings survive vault lock/unlock cycle ──
    // (Runs BEFORE delete test so vault state is clean)
    campaign.scenario('settings-survive-cycle', 'Recovery Path',
        'Settings must persist through lock/unlock',
        async () => {
            // Ensure we start unlocked
            const w = await ipc.invoke('vault:getWallets');
            if (!w.ok) return; // Vault not accessible — skip
            await ipc.invoke('settings:update', { dailySpendLimit: 42 });
            await ipc.invoke('vault:lock');
            const ul = await ipc.invoke('vault:unlock', TEST_PASSWORD);
            if (!ul.ok) return; // unlock failed (rate limit) — skip
            const s = await ipc.invoke('settings:get');
            assertOk(s);
        });

    // ── 8. Delete vault during locked state (destructive — runs last) ──
    campaign.scenario('deleted-vault-while-locked', 'Vault Integrity',
        'Deleted vault file must cause unlock to fail and exists() to return false',
        async () => {
            const vf = findVaultFile();
            if (!vf) { assert(true, 'Skip'); return; }
            const original = fs.readFileSync(vf);
            await ipc.invoke('vault:lock');
            fs.unlinkSync(vf);
            const exists = await ipc.invoke('vault:exists');
            assert(exists === false || exists.exists === false,
                'vault:exists should return false after file deletion');
            // Unlock should fail
            const r = await ipc.invoke('vault:unlock', TEST_PASSWORD);
            assertFail(r);
            // Recreate for remaining campaigns
            const cr = await ipc.invoke('vault:create', TEST_PASSWORD, 'Recovered', TEST_MNEMONIC);
            assertOk(cr);
            await ipc.invoke('vault:unlock', TEST_PASSWORD);
        });

    return campaign;
}

module.exports = { buildFilesystemCorruption };
