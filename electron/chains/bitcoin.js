/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  BITCOIN MODULE — BIP84 Native SegWit via Blockstream API     ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Derives bc1... addresses from mnemonic via BIP84 (m/84'/0'/0'/0/0).
 * Uses Blockstream REST API — no RPC keys needed.
 * All operations go through IPC, never exposed to renderer.
 */
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { BIP32Factory } = require('bip32');
const bip39 = require('bip39');

const bip32 = BIP32Factory(ecc);

// Initialize bitcoinjs-lib with the ECC library
bitcoin.initEccLib(ecc);

const BLOCKSTREAM_API = 'https://blockstream.info/api';
const MEMPOOL_API = 'https://mempool.space/api';

// ═══════════════════════════════════════════════════════════════
// KEY DERIVATION — BIP84 Native SegWit
// ═══════════════════════════════════════════════════════════════

/**
 * Derive BTC native SegWit (bc1...) address from mnemonic.
 * Path: m/84'/0'/0'/0/0
 * @returns {{ address, pubkey, wif, path }}
 */
function deriveFromMnemonic(mnemonic) {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = bip32.fromSeed(seed);
    const path = "m/84'/0'/0'/0/0";
    const child = root.derivePath(path);

    const { address } = bitcoin.payments.p2wpkh({
        pubkey: Buffer.from(child.publicKey),
        network: bitcoin.networks.bitcoin,
    });

    return {
        address,
        pubkey: child.publicKey.toString('hex'),
        wif: child.toWIF(),
        path,
    };
}

// ═══════════════════════════════════════════════════════════════
// BALANCE + UTXO — Blockstream REST API
// ═══════════════════════════════════════════════════════════════

async function getBalance(address) {
    const res = await fetch(`${BLOCKSTREAM_API}/address/${address}`);
    if (!res.ok) throw new Error(`Blockstream API error: ${res.status}`);
    const data = await res.json();

    const confirmed = data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum;
    const unconfirmed = data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum;

    return {
        confirmed,         // satoshis
        unconfirmed,       // satoshis
        total: confirmed + unconfirmed,
        formatted: (confirmed / 1e8).toFixed(8),
        formattedTotal: ((confirmed + unconfirmed) / 1e8).toFixed(8),
    };
}

async function getUTXOs(address) {
    const res = await fetch(`${BLOCKSTREAM_API}/address/${address}/utxo`);
    if (!res.ok) throw new Error(`UTXO fetch failed: ${res.status}`);
    return res.json();
}

// ═══════════════════════════════════════════════════════════════
// FEE ESTIMATION — Mempool.space
// ═══════════════════════════════════════════════════════════════

async function getFeeEstimate() {
    const res = await fetch(`${MEMPOOL_API}/v1/fees/recommended`);
    if (!res.ok) throw new Error(`Fee estimate failed: ${res.status}`);
    const data = await res.json();
    return {
        fastest: data.fastestFee,     // sat/vB
        halfHour: data.halfHourFee,
        hour: data.hourFee,
        economy: data.economyFee,
        minimum: data.minimumFee,
    };
}

// ═══════════════════════════════════════════════════════════════
// TRANSACTION BUILDING + SIGNING
// ═══════════════════════════════════════════════════════════════

/**
 * Build, sign, and broadcast a BTC transaction.
 * @param {string} wif - Wallet Import Format private key
 * @param {string} fromAddress - Sender bc1... address
 * @param {string} toAddress - Recipient address
 * @param {number} amountSats - Amount in satoshis
 * @param {number} feeRate - Fee rate in sat/vB
 * @returns {{ txHash, fee, hex }}
 */
async function sendBTC(wif, fromAddress, toAddress, amountSats, feeRate) {
    // Get UTXOs
    const utxos = await getUTXOs(fromAddress);
    if (!utxos.length) throw new Error('No UTXOs available');

    const keyPair = bitcoin.ECPair ? bitcoin.ECPair.fromWIF(wif) : null;
    // For newer bitcoinjs-lib, use Psbt
    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });

    // Sort UTXOs by value descending for efficient coin selection
    utxos.sort((a, b) => b.value - a.value);

    let inputSum = 0;
    const selectedUtxos = [];

    // Estimate tx size: ~68 vB per input + ~31 vB per output + 10 vB overhead
    // Start with 2 outputs (send + change)
    for (const utxo of utxos) {
        selectedUtxos.push(utxo);
        inputSum += utxo.value;

        const estimatedSize = selectedUtxos.length * 68 + 2 * 31 + 10;
        const estimatedFee = estimatedSize * feeRate;

        if (inputSum >= amountSats + estimatedFee) break;
    }

    const txSize = selectedUtxos.length * 68 + 2 * 31 + 10;
    const fee = txSize * feeRate;

    if (inputSum < amountSats + fee) {
        throw new Error(`Insufficient BTC. Have ${(inputSum / 1e8).toFixed(8)}, need ${((amountSats + fee) / 1e8).toFixed(8)} (incl. fee)`);
    }

    // Fetch raw transactions for UTXO non-witness inputs
    for (const utxo of selectedUtxos) {
        // For native SegWit (P2WPKH), we need the witnessUtxo
        const script = bitcoin.payments.p2wpkh({
            pubkey: Buffer.from(keyPair ? keyPair.publicKey : bitcoin.ECPair.fromWIF(wif).publicKey),
            network: bitcoin.networks.bitcoin,
        }).output;

        psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            witnessUtxo: {
                script,
                value: utxo.value,
            },
        });
    }

    // Add output: recipient
    psbt.addOutput({ address: toAddress, value: amountSats });

    // Add change output if needed
    const change = inputSum - amountSats - fee;
    if (change > 546) { // Dust threshold
        psbt.addOutput({ address: fromAddress, value: change });
    }

    // Sign all inputs
    const signer = bitcoin.ECPair ? bitcoin.ECPair.fromWIF(wif, bitcoin.networks.bitcoin) : null;
    if (signer) {
        for (let i = 0; i < selectedUtxos.length; i++) {
            psbt.signInput(i, signer);
        }
    }

    psbt.finalizeAllInputs();
    const rawTx = psbt.extractTransaction().toHex();

    // Broadcast
    const broadcastRes = await fetch(`${BLOCKSTREAM_API}/tx`, {
        method: 'POST',
        body: rawTx,
    });

    if (!broadcastRes.ok) {
        const err = await broadcastRes.text();
        throw new Error(`Broadcast failed: ${err}`);
    }

    const txHash = await broadcastRes.text();

    return { txHash, fee, hex: rawTx };
}

// ═══════════════════════════════════════════════════════════════
// HISTORY — Last 25 transactions
// ═══════════════════════════════════════════════════════════════

async function getHistory(address) {
    const res = await fetch(`${BLOCKSTREAM_API}/address/${address}/txs`);
    if (!res.ok) throw new Error(`History fetch failed: ${res.status}`);
    const txs = await res.json();

    return txs.slice(0, 25).map(tx => ({
        txid: tx.txid,
        confirmed: tx.status.confirmed,
        blockHeight: tx.status.block_height || null,
        timestamp: tx.status.block_time ? tx.status.block_time * 1000 : Date.now(),
        fee: tx.fee,
        size: tx.size,
        inputs: tx.vin.length,
        outputs: tx.vout.length,
    }));
}

// ═══════════════════════════════════════════════════════════════
// ADDRESS VALIDATION
// ═══════════════════════════════════════════════════════════════

function isValidBTCAddress(addr) {
    try {
        bitcoin.address.toOutputScript(addr, bitcoin.networks.bitcoin);
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    deriveFromMnemonic,
    getBalance,
    getUTXOs,
    getFeeEstimate,
    sendBTC,
    getHistory,
    isValidBTCAddress,
};
