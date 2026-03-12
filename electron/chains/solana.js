/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  SOLANA MODULE — Ed25519 via Solana JSON-RPC                   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Derives Solana addresses from mnemonic via m/44'/501'/0'/0'.
 * Uses Solana JSON-RPC (public endpoint or Helius).
 * All operations go through IPC, never exposed to renderer.
 */
const {
    Connection,
    PublicKey,
    Keypair,
    SystemProgram,
    Transaction,
    LAMPORTS_PER_SOL,
    clusterApiUrl,
} = require('@solana/web3.js');
const { derivePath } = require('ed25519-hd-key');
const bip39 = require('bip39');
const bs58 = require('bs58');

// ═══════════════════════════════════════════════════════════════
// RPC CONNECTION
// ═══════════════════════════════════════════════════════════════
const SOLANA_RPC = process.env.OMEGA_SOLANA_RPC || clusterApiUrl('mainnet-beta');

function getConnection() {
    return new Connection(SOLANA_RPC, 'confirmed');
}

// ═══════════════════════════════════════════════════════════════
// KEY DERIVATION — Ed25519 via BIP44 path
// ═══════════════════════════════════════════════════════════════

/**
 * Derive Solana keypair from mnemonic.
 * Path: m/44'/501'/0'/0'
 * @returns {{ address, secretKey, path }}
 */
function deriveFromMnemonic(mnemonic) {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const path = "m/44'/501'/0'/0'";
    const derived = derivePath(path, seed.toString('hex'));
    const keypair = Keypair.fromSeed(derived.key);

    return {
        address: keypair.publicKey.toBase58(),
        secretKey: bs58.encode(keypair.secretKey),
        path,
    };
}

/**
 * Reconstruct Keypair from stored secret key.
 */
function keypairFromSecret(secretKeyB58) {
    const secretKey = bs58.decode(secretKeyB58);
    return Keypair.fromSecretKey(secretKey);
}

// ═══════════════════════════════════════════════════════════════
// BALANCE
// ═══════════════════════════════════════════════════════════════

async function getBalance(address) {
    const connection = getConnection();
    const pubkey = new PublicKey(address);
    const lamports = await connection.getBalance(pubkey);

    return {
        lamports,
        formatted: (lamports / LAMPORTS_PER_SOL).toFixed(9),
        sol: lamports / LAMPORTS_PER_SOL,
    };
}

// ═══════════════════════════════════════════════════════════════
// SPL TOKEN ACCOUNTS
// ═══════════════════════════════════════════════════════════════

async function getTokenAccounts(address) {
    const connection = getConnection();
    const pubkey = new PublicKey(address);

    const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

    const response = await connection.getParsedTokenAccountsByOwner(pubkey, {
        programId: TOKEN_PROGRAM_ID,
    });

    return response.value
        .map(({ account }) => {
            const info = account.data.parsed.info;
            return {
                mint: info.mint,
                balance: info.tokenAmount.uiAmount,
                decimals: info.tokenAmount.decimals,
                formatted: info.tokenAmount.uiAmountString,
            };
        })
        .filter(t => t.balance > 0);
}

// ═══════════════════════════════════════════════════════════════
// SOL TRANSFER
// ═══════════════════════════════════════════════════════════════

/**
 * Send SOL from one address to another.
 * @param {string} secretKeyB58 - Base58-encoded secret key
 * @param {string} toAddress - Recipient Solana address
 * @param {number} amountSOL - Amount in SOL
 * @returns {{ txHash, fee }}
 */
async function sendSOL(secretKeyB58, toAddress, amountSOL) {
    const connection = getConnection();
    const sender = keypairFromSecret(secretKeyB58);
    const recipient = new PublicKey(toAddress);

    const lamports = Math.round(amountSOL * LAMPORTS_PER_SOL);

    // Check balance
    const balance = await connection.getBalance(sender.publicKey);
    if (balance < lamports + 5000) { // 5000 lamports for fee buffer
        throw new Error(`Insufficient SOL. Have ${(balance / LAMPORTS_PER_SOL).toFixed(4)}, need ${amountSOL}`);
    }

    const transaction = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: sender.publicKey,
            toPubkey: recipient,
            lamports,
        })
    );

    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = sender.publicKey;

    // Sign and send
    transaction.sign(sender);
    const txHash = await connection.sendRawTransaction(transaction.serialize());

    // Confirm
    await connection.confirmTransaction(txHash, 'confirmed');

    return {
        txHash,
        fee: 5000, // base fee in lamports
    };
}

// ═══════════════════════════════════════════════════════════════
// HISTORY — Recent signatures
// ═══════════════════════════════════════════════════════════════

async function getHistory(address) {
    const connection = getConnection();
    const pubkey = new PublicKey(address);

    const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 25 });

    return signatures.map(sig => ({
        txid: sig.signature,
        confirmed: sig.confirmationStatus === 'finalized' || sig.confirmationStatus === 'confirmed',
        slot: sig.slot,
        timestamp: sig.blockTime ? sig.blockTime * 1000 : Date.now(),
        err: sig.err,
        memo: sig.memo,
    }));
}

// ═══════════════════════════════════════════════════════════════
// ADDRESS VALIDATION
// ═══════════════════════════════════════════════════════════════

function isValidSOLAddress(addr) {
    try {
        new PublicKey(addr);
        return PublicKey.isOnCurve(new PublicKey(addr).toBytes());
    } catch {
        return false;
    }
}

module.exports = {
    deriveFromMnemonic,
    keypairFromSecret,
    getBalance,
    getTokenAccounts,
    sendSOL,
    getHistory,
    isValidSOLAddress,
};
