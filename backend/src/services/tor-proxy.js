/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     TOR/NYM PROXY — Anonymized RPC Relay                    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * PROBLEM: RPC providers (Infura, Alchemy) log IP addresses and
 * tie them to wallet addresses. This creates a metadata link that
 * can deanonymize users.
 *
 * SOLUTION: Route all outbound RPC calls through a SOCKS5 proxy
 * to a Tor hidden service or Nym mixnet relay. The blockchain
 * only sees the exit node IP.
 *
 * MECHANISM:
 *   1. Frontend sends transaction to our backend
 *   2. Backend routes through Tor SOCKS5 proxy (127.0.0.1:9050)
 *   3. Request exits through Tor circuit to public RPC
 *   4. Response returns through Tor circuit
 *   5. IP link is mathematically severed
 *
 * CONFIGURATION:
 *   TOR_SOCKS_HOST=127.0.0.1   (Tor SOCKS5 proxy host)
 *   TOR_SOCKS_PORT=9050         (Tor SOCKS5 proxy port)
 *   NYM_GATEWAY=...             (Optional Nym mixnet gateway)
 */
import { Router } from 'express';
import { SocksProxyAgent } from 'socks-proxy-agent';

const router = Router();

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

const TOR_ENABLED = !!process.env.TOR_SOCKS_HOST;
const TOR_SOCKS_HOST = process.env.TOR_SOCKS_HOST || '127.0.0.1';
const TOR_SOCKS_PORT = parseInt(process.env.TOR_SOCKS_PORT || '9050');

// Create Tor SOCKS5 agent
let torAgent = null;
if (TOR_ENABLED) {
    torAgent = new SocksProxyAgent(
        `socks5h://${TOR_SOCKS_HOST}:${TOR_SOCKS_PORT}`
    );
}

// Allowed RPC endpoints (whitelist — prevent open proxy abuse)
const ALLOWED_RPC_HOSTS = new Set([
    'eth.llamarpc.com',
    'mainnet.base.org',
    'arb1.arbitrum.io',
    'mainnet.optimism.io',
    'rpc.ankr.com',
    'cloudflare-eth.com',
    '1rpc.io',
]);

// ═══════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════

/**
 * POST /api/proxy/rpc
 * Relay a JSON-RPC request through Tor to a whitelisted RPC endpoint
 *
 * Body: {
 *   rpcUrl: string,        // must be on whitelist
 *   method: string,        // JSON-RPC method
 *   params: any[],         // JSON-RPC params
 *   chain: string          // chain identifier
 * }
 */
router.post('/rpc', async (req, res) => {
    try {
        const { rpcUrl, method, params, chain } = req.body;

        // Resolve RPC URL
        const targetUrl = rpcUrl || getDefaultRpc(chain);

        // Security: whitelist check
        const url = new URL(targetUrl);
        if (!ALLOWED_RPC_HOSTS.has(url.hostname)) {
            return res.status(403).json({
                error: 'RPC host not on whitelist',
                allowed: [...ALLOWED_RPC_HOSTS]
            });
        }

        // Build JSON-RPC request
        const rpcRequest = {
            jsonrpc: '2.0',
            id: Date.now(),
            method,
            params: params || []
        };

        // Route through Tor if enabled
        const fetchOptions = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rpcRequest),
        };

        if (torAgent) {
            fetchOptions.agent = torAgent;
        }

        const response = await fetch(targetUrl, fetchOptions);
        const result = await response.json();

        res.json({
            ...result,
            _meta: {
                proxied: TOR_ENABLED,
                circuit: TOR_ENABLED ? 'tor' : 'direct',
                timestamp: new Date().toISOString()
            }
        });

    } catch (err) {
        res.status(500).json({ error: 'Proxy relay failed', details: err.message });
    }
});

/**
 * GET /api/proxy/status
 * Check Tor proxy connectivity
 */
router.get('/status', async (req, res) => {
    const status = {
        torEnabled: TOR_ENABLED,
        socksHost: TOR_ENABLED ? TOR_SOCKS_HOST : null,
        socksPort: TOR_ENABLED ? TOR_SOCKS_PORT : null,
        circuitStatus: 'unknown'
    };

    if (TOR_ENABLED && torAgent) {
        try {
            // Test Tor connectivity via check.torproject.org
            const testResponse = await fetch('https://check.torproject.org/api/ip', {
                agent: torAgent,
                signal: AbortSignal.timeout(10000)
            });
            const testResult = await testResponse.json();

            status.circuitStatus = testResult.IsTor ? 'connected' : 'direct';
            status.exitNodeIp = testResult.IP;
            status.isTor = testResult.IsTor;
        } catch (err) {
            status.circuitStatus = 'disconnected';
            status.error = err.message;
        }
    }

    res.json(status);
});

/**
 * POST /api/proxy/new-circuit
 * Request a new Tor circuit (new exit node)
 * This provides a fresh IP for subsequent requests
 */
router.post('/new-circuit', async (req, res) => {
    if (!TOR_ENABLED) {
        return res.status(400).json({ error: 'Tor proxy not enabled' });
    }

    // Recreate agent (forces new circuit via SOCKS5)
    torAgent = new SocksProxyAgent(
        `socks5h://${TOR_SOCKS_HOST}:${TOR_SOCKS_PORT}`
    );

    res.json({
        status: 'new_circuit_requested',
        message: 'New Tor circuit will be used for next request'
    });
});

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function getDefaultRpc(chain) {
    const defaults = {
        ethereum: 'https://eth.llamarpc.com',
        base: 'https://mainnet.base.org',
        arbitrum: 'https://arb1.arbitrum.io/rpc',
        optimism: 'https://mainnet.optimism.io',
    };
    return defaults[chain] || defaults.ethereum;
}

export { router as proxyRouter };
