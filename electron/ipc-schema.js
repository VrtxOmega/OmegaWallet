/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║       IPC SCHEMA — Declarative Boundary Enforcement           ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Every IPC channel has a declared schema. No loose objects cross
 * the boundary. Validation runs before any handler logic.
 *
 * Type syntax: "fieldName:type:constraint=value"
 *   ?fieldName = optional
 *
 * Constraints:
 *   min=N, max=N (string length or numeric value)
 *   maxSize=N (JSON serialized byte limit for objects/arrays)
 *   len=N (exact hex length, excluding 0x prefix)
 */
const { ethers } = require('ethers');

// ─── Valid chains (mirrors ipc-handlers) ─────────────────────
const VALID_CHAINS = new Set([
    'ethereum', 'base', 'arbitrum', 'optimism', 'sepolia', 'base-sepolia',
    'polygon', 'avalanche', 'bsc', 'fantom', 'cronos',
    'zksync-era', 'linea', 'scroll', 'mantle',
]);

// ─── Allowed RPC methods (mirrors ipc-handlers) ─────────────
const ALLOWED_RPC_METHODS = new Set([
    'eth_blockNumber', 'eth_getBalance', 'eth_getCode',
    'eth_getTransactionCount', 'eth_getTransactionReceipt',
    'eth_call', 'eth_estimateGas', 'eth_gasPrice',
    'eth_getBlockByNumber', 'eth_getBlockByHash',
    'eth_getStorageAt', 'eth_getLogs', 'net_version',
    'eth_chainId', 'eth_feeHistory', 'eth_maxPriorityFeePerGas',
]);

// ─── Type Validators ─────────────────────────────────────────
const TYPES = {
    string(v, opts) {
        if (typeof v !== 'string') return 'must be a string';
        if (opts.min !== undefined && v.length < opts.min) return `min length ${opts.min}`;
        if (opts.max !== undefined && v.length > opts.max) return `max length ${opts.max}`;
        return null;
    },
    uint(v) {
        if (!Number.isInteger(v) || v < 0) return 'must be a non-negative integer';
        if (v > 1_000_000) return 'exceeds maximum (1000000)';
        return null;
    },
    address(v) {
        if (typeof v !== 'string') return 'must be a string';
        if (!ethers.isAddress(v)) return 'invalid Ethereum address';
        return null;
    },
    chain(v) {
        if (typeof v !== 'string') return 'must be a string';
        if (!VALID_CHAINS.has(v)) return `invalid chain: ${v}`;
        return null;
    },
    amount(v) {
        if (typeof v !== 'string' && typeof v !== 'number') return 'must be string or number';
        const n = parseFloat(v);
        if (isNaN(n) || n < 0) return 'must be a non-negative number';
        if (n > 1e18) return 'exceeds maximum';
        return null;
    },
    hex(v, opts) {
        if (typeof v !== 'string') return 'must be a string';
        const clean = v.startsWith('0x') ? v.slice(2) : v;
        if (!/^[0-9a-fA-F]*$/.test(clean)) return 'invalid hex';
        if (opts.len !== undefined && clean.length !== opts.len) return `expected ${opts.len} hex chars`;
        return null;
    },
    rpcMethod(v) {
        if (typeof v !== 'string') return 'must be a string';
        if (!ALLOWED_RPC_METHODS.has(v)) return `blocked RPC method: ${v}`;
        return null;
    },
    array(v, opts) {
        if (!Array.isArray(v)) return 'must be an array';
        const maxSize = opts.maxSize || 8192;
        try {
            if (JSON.stringify(v).length > maxSize) return `exceeds max size (${maxSize} bytes)`;
        } catch { return 'not serializable'; }
        return null;
    },
    object(v, opts) {
        if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'must be a plain object';
        const maxSize = opts.maxSize || 4096;
        try {
            if (JSON.stringify(v).length > maxSize) return `exceeds max size (${maxSize} bytes)`;
        } catch { return 'not serializable'; }
        return null;
    },
    bool(v) {
        if (typeof v !== 'boolean') return 'must be a boolean';
        return null;
    },
    url(v) {
        if (typeof v !== 'string') return 'must be a string';
        if (v.length > 2048) return 'URL too long';
        try { new URL(v); } catch { return 'invalid URL'; }
        return null;
    },
    tokenId(v) {
        if (typeof v !== 'string' && typeof v !== 'number') return 'must be string or number';
        return null;
    },
};

// ─── Parse a type declaration "type:constraint=val" ──────────
function parseTypeDecl(decl) {
    const parts = decl.split(':');
    const type = parts[0];
    const opts = {};
    for (let i = 1; i < parts.length; i++) {
        const [k, v] = parts[i].split('=');
        opts[k] = v !== undefined ? Number(v) : true;
    }
    return { type, opts };
}

// ─── Schema Registry ─────────────────────────────────────────
const SCHEMAS = {
    // Vault
    'vault:exists':        { args: [] },
    'vault:create':        { args: ['string:min=8:max=256', 'string:max=50', '?string'] },
    'vault:unlock':        { args: ['string:min=1:max=256'] },
    'vault:lock':          { args: [] },
    'vault:destroy':       { args: ['string:min=1:max=256'] },
    'vault:getWallets':    { args: [] },
    'vault:addWallet':     { args: ['string:max=50', '?string'] },
    'vault:removeWallet':  { args: ['uint', 'string:min=1:max=256'] },
    'vault:setActive':     { args: ['uint'] },
    'vault:getKey':        { args: ['uint', 'string:min=1:max=256'] },

    // Auth
    'auth:freshAuth':      { args: ['string:min=1:max=256'] },
    'auth:status':         { args: [] },
    'auth:auditLog':       { args: ['?uint'] },

    // Cerberus
    'cerberus:scan':       { args: ['address', 'chain'] },

    // Simulator
    'simulator:run':       { args: ['object:maxSize=8192'] },
    'simulator:decode':    { args: ['string:max=100000', '?address', '?string'] },

    // Bundler
    'bundler:submit':      { args: ['object:maxSize=8192', 'chain'] },
    'bundler:prepare':     { args: ['object:maxSize=8192', 'chain'] },
    'bundler:confirm':     { args: ['string:min=1:max=128', 'string:min=1:max=256'] },
    'bundler:status':      { args: ['string:min=1:max=128', 'chain'] },
    'bundler:gas':         { args: ['chain'] },

    // Tokens
    'token:balances':      { args: ['address', 'chain'] },
    'token:transfer':      { args: ['address', 'address', 'amount', 'chain'] },
    'token:info':          { args: ['address', 'chain'] },
    'token:import':        { args: ['address', 'chain'] },

    // Spend
    'ledger:getSpend':     { args: [] },
    'ledger:getHistory':   { args: [] },
    'ledger:recordSpend':  { args: ['amount', 'string:max=128', 'string:max=50'] },

    // Settings
    'settings:get':        { args: [] },
    'settings:update':     { args: ['object:maxSize=4096'] },

    // NFT
    'nft:list':            { args: ['address', 'chain'] },
    'nft:save':            { args: ['url', 'string:max=200'] },
    'nft:pin':             { args: ['object:maxSize=2048'] },
    'nft:unpin':           { args: ['string:max=128', 'tokenId'] },
    'nft:pinned':          { args: [] },
    'nft:transfer':        { args: ['address', 'tokenId', 'address', 'chain'] },
    'nft:autoPin':         { args: ['address', 'tokenId', 'chain'] },
    'nft:verifyPinned':    { args: ['address', 'chain'] },

    // Approvals
    'approval:scan':       { args: ['address', 'chain'] },
    'approval:revoke':     { args: ['address', 'address', 'chain'] },

    // Address Book
    'addressbook:list':    { args: [] },
    'addressbook:add':     { args: ['object:maxSize=1024'] },
    'addressbook:remove':  { args: ['address'] },
    'addressbook:update':  { args: ['address', 'object:maxSize=1024'] },
    'addressbook:touch':   { args: ['address'] },

    // Gas
    'gas:estimate':        { args: ['object:maxSize=4096'] },

    // Smart Receive
    'wallet:getReceiveProfile': { args: ['?uint', '?string:max=20', '?string:max=50'] },
    'wallet:getReceiveOptions': { args: ['?uint'] },

    // On-ramp
    'onramp:getUrl':       { args: ['string:max=50', '?string:max=20', '?string:max=50', '?string:max=20'] },
    'onramp:providers':    { args: [] },

    // Swap
    'swap:tokens':         { args: ['?string:max=50'] },
    'swap:quote':          { args: ['object:maxSize=4096'] },
    'swap:execute':        { args: ['object:maxSize=4096'] },

    // RPC proxy
    'rpc:call':            { args: ['chain', 'rpcMethod', 'array:maxSize=8192'] },

    // BTC
    'btc:deriveAddress':   { args: ['uint'] },
    'btc:balance':         { args: ['string:max=100'] },
    'btc:fees':            { args: [] },
    'btc:send':            { args: ['uint', 'string:max=100', 'uint', 'uint'] },
    'btc:history':         { args: ['string:max=100'] },

    // SOL
    'sol:deriveAddress':   { args: ['uint'] },
    'sol:balance':         { args: ['string:max=100'] },
    'sol:tokens':          { args: ['string:max=100'] },
    'sol:send':            { args: ['uint', 'string:max=100', 'amount'] },
    'sol:history':         { args: ['string:max=100'] },
    'sol:nfts':            { args: ['string:max=100'] },

    // Bridge
    'bridge:respond':      { args: ['bool'] },

    // WalletConnect
    'wc:pair':             { args: ['string:max=1024'] },
    'wc:approve':          { args: ['uint', 'address'] },
    'wc:reject':           { args: ['uint'] },
    'wc:disconnect':       { args: ['string:max=256'] },
    'wc:sessions':         { args: [] },
    'wc:respondRequest':   { args: ['uint', 'bool'] },

    // dApp Browser
    'dapp:navigate':       { args: ['url'] },
    'dapp:back':           { args: [] },
    'dapp:forward':        { args: [] },
    'dapp:reload':         { args: [] },
    'dapp:close':          { args: [] },
    'dapp:hide':           { args: [] },
    'dapp:show':           { args: [] },
    'dapp:getStatus':      { args: [] },
    'dapp:approvalRespond':{ args: ['string:max=128', 'bool'] },
    'dapp:bookmarks:list': { args: [] },
    'dapp:bookmarks:add':  { args: ['object:maxSize=1024'] },
    'dapp:bookmarks:remove': { args: ['url'] },
    'dapp:permissions:list': { args: [] },
    'dapp:permissions:revoke': { args: ['string:max=512'] },
    'dapp:permissions:revokeAll': { args: [] },
    'dapp:activity:list':  { args: ['?string:max=512'] },

    // System
    'system:openExternal': { args: ['url'] },
    'system:version':      { args: [] },
    'system:prices':       { args: ['?string:max=256'] },
    'system:securityScore':{ args: [] },

    // Telemetry
    'telemetry:status':    { args: [] },
    'telemetry:extraction':{ args: [] },
};

/**
 * Validate IPC arguments against schema.
 * @param {string} channel — IPC channel name
 * @param {any[]} args — arguments array
 * @throws {Error} on schema violation
 */
function validateIpc(channel, args) {
    const schema = SCHEMAS[channel];
    if (!schema) {
        // Unknown channel — strict rejection
        throw new Error(`IPC_SCHEMA: unknown channel "${channel}"`);
    }

    const decls = schema.args;
    for (let i = 0; i < decls.length; i++) {
        const decl = decls[i];
        const isOptional = decl.startsWith('?');
        const cleanDecl = isOptional ? decl.slice(1) : decl;
        const value = args[i];

        // Optional and not provided
        if (isOptional && (value === undefined || value === null)) continue;

        // Required but missing
        if (!isOptional && (value === undefined || value === null)) {
            throw new Error(`IPC_SCHEMA: ${channel} arg[${i}] is required`);
        }

        const { type, opts } = parseTypeDecl(cleanDecl);
        const validator = TYPES[type];
        if (!validator) throw new Error(`IPC_SCHEMA: unknown type "${type}"`);

        const err = validator(value, opts);
        if (err) {
            throw new Error(`IPC_SCHEMA: ${channel} arg[${i}] (${type}): ${err}`);
        }
    }

    // Reject extra arguments beyond schema
    if (args.length > decls.length) {
        throw new Error(`IPC_SCHEMA: ${channel} expected ${decls.length} args, got ${args.length}`);
    }
}

module.exports = { validateIpc, SCHEMAS, VALID_CHAINS, ALLOWED_RPC_METHODS };
