<div align="center">
  <img src="https://raw.githubusercontent.com/VrtxOmega/Gravity-Omega/master/omega_icon.png" width="100" alt="VERITAS" />
  <h1>OMEGA WALLET</h1>
  <p><strong>Security-First Desktop Ethereum Wallet</strong></p>
  <p><em>Renderer cannot sign. That is the invariant.</em></p>
</div>

![Status](https://img.shields.io/badge/Status-ACTIVE-success?style=for-the-badge&labelColor=000000&color=d4af37)
![Stack](https://img.shields.io/badge/Stack-Electron%20%2B%20React-informational?style=for-the-badge&labelColor=000000)
![Security](https://img.shields.io/badge/Security-Split%20Process-critical?style=for-the-badge&labelColor=000000)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge&labelColor=000000)

---

A desktop Ethereum wallet built on a **renderer-cannot-sign** architecture. The React UI has zero access to private keys — all cryptographic operations execute in the isolated Electron main process behind a validated IPC bridge.

> Internal adversarial validation suite passed — not externally audited.

## Architecture

`
+-----------------------------------+
|  RENDERER (React UI)              |
|    Balance display, TX builder    |
|    Token management, Send forms   |
|    NO access to keys or signing   |
+-----------------------------------+
        | IPC Bridge (validated) |
+-----------------------------------+
|  MAIN PROCESS (Electron)          |
|    Key storage (AES-256 vault)    |
|    Transaction signing            |
|    RPC provider management        |
|    Cerberus security scanner      |
+-----------------------------------+
`

| Layer | Boundary | Access |
|-------|----------|--------|
| **Renderer** | React SPA | Balances, TX construction, UI — **NO signing** |
| **Preload** | IPC Bridge | Validated message passing only |
| **Main** | Electron Node.js | Key vault, signing, RPC, security scanning |

## Features

- **Split-Process Trust Boundary** - Private keys never exist in the renderer process
- **AES-256 Encrypted Vault** - Local key storage with password-derived encryption
- **Multi-Wallet Management** - Create, import, and switch between multiple wallets
- **ERC-20 Token Support** - View balances, send tokens, custom token import
- **ERC-4337 Account Abstraction** - Programmable smart wallet operations
- **Cerberus Security Scanner** - Real-time contract interaction risk analysis
- **Transaction Builder** - Visual TX construction with gas estimation
- **Encrypted Local Ledger** - AES-256 encrypted transaction history

## Quick Start

`ash
npm install
npm start
`

### Build for Production

`ash
npm run build
npm run package
`

## Security Model

| Principle | Implementation |
|-----------|---------------|
| **Key Isolation** | Private keys exist only in Electron main process memory |
| **Encrypted At Rest** | AES-256-CBC with PBKDF2 key derivation |
| **IPC Validation** | Every message type whitelisted, payload schema-checked |
| **No Remote Keys** | Zero cloud key storage, zero key transmission |
| **Cerberus Scanning** | Contract bytecode analysis before interaction |

> **Disclaimer**: This wallet has passed internal adversarial testing but has not been externally audited. Use at your own risk with amounts you can afford to lose.

## License

MIT

---

<div align="center">
  <sub>Built by <a href="https://github.com/VrtxOmega">RJ Lopez</a> | VERITAS Framework</sub>
</div>