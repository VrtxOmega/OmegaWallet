# Ω OmegaWallet

**Security-first desktop wallet. Electron + React. Split-process trust boundary.**

> Internal adversarial validation suite passed — not externally audited.

---

## What It Is

A desktop Ethereum wallet built on a **renderer-cannot-sign** architecture.
The React UI has zero access to private keys, vault encryption, or RPC endpoints.
All sensitive operations run in the Electron main process behind validated IPC.

**Status:** v5.0.0-rc1 (feature-frozen)

## Architecture

```
┌───────────────────────────────────────┐
│  RENDERER (untrusted)                 │
│  React + Vite                         │
│  21 components                        │
│  Cannot access: keys, vault, RPC URLs │
└──────────────┬────────────────────────┘
               │ contextBridge (71 IPC channels)
┌──────────────▼────────────────────────┐
│  MAIN PROCESS (privileged)            │
│  AES-256-GCM encrypted vault          │
│  Two-phase signing (prepare → confirm)│
│  FreshAuth per sensitive operation    │
│  Transaction simulation + decoder     │
│  Schema validation on every IPC call  │
│  DEX aggregator (swap engine)         │
│  RPC proxy (URLs never exposed)       │
└───────────────────────────────────────┘
```

## Features

| Feature | Description |
|---|---|
| **Dashboard** | Multi-chain balances, tokens, security score |
| **Send** | Two-phase signing with transaction simulation |
| **Receive** | Real QR codes (scannable), EIP-681 token payloads |
| **Swap** | DEX aggregator (0x API + estimation), slippage, price impact |
| **Buy** | On-ramp integration (MoonPay, Ramp, Transak) |
| **NFTs** | ERC-721/1155 + Solana, gallery, transfer |
| **Approvals** | Active approval dashboard with one-click revoke |
| **WalletConnect** | v2 session management |
| **History** | Encrypted audit ledger |
| **Batch** | Multi-recipient transfers |

## Chains

EVM: Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, Avalanche, zkSync, Linea, Scroll, Mantle, Cronos, Fantom  
Non-EVM: Bitcoin (SegWit), Solana

## Quick Start

```bash
# Install dependencies
cd electron && npm install
cd ../frontend && npm install

# Development
cd frontend && npm run dev        # Vite dev server
cd ../electron && npm start       # Electron main process
```

## Security

See [`SECURITY.md`](SECURITY.md) for the full security policy, architecture summary,
and responsible disclosure process.

See [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md) for an honest list of what has
**not** been validated.

### Validation Summary

- 141 attack scenarios across 15 adversarial campaigns
- 7 security boundaries tested at 100%
- Zero key leaks, zero auth bypasses, zero policy bypasses
- Test environment: mocked Electron IPC + temporary vault directory

## Project Structure

```
OmegaWallet/
├── electron/                    # Main process (privileged)
│   ├── main.js                  # Electron entry
│   ├── ipc-handlers.js          # 71 IPC handlers
│   ├── ipc-schema.js            # Per-channel validation
│   ├── preload.js               # contextBridge
│   ├── encrypted-ledger.js      # AES-256-GCM vault
│   ├── fresh-auth.js            # Single-use auth tokens
│   ├── tx-decoder.js            # Calldata decoder
│   ├── tx-simulator.js          # Risk analysis engine
│   ├── swap-engine.js           # DEX aggregator
│   ├── tokens.js                # Token registry
│   ├── chains/                  # BTC + SOL support
│   └── test/                    # 15 adversarial campaigns
├── frontend/                    # Renderer (untrusted)
│   └── src/
│       ├── App.jsx              # Router
│       ├── components/          # 21 components
│       ├── lib/networks.js      # Chain config
│       └── index.css            # Design system
├── SECURITY.md
├── KNOWN_LIMITATIONS.md
├── FREEZE.js                    # Feature freeze manifest
└── README.md
```

## License

MIT
