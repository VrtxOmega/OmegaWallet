# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in OmegaWallet, please report it responsibly.

**Email:** [security contact — configure before public release]

Please include:
- Description of the vulnerability
- Steps to reproduce
- Impact assessment
- Your suggested fix (optional)

We will acknowledge receipt within 48 hours and provide an initial assessment within 7 days.

**Do not open a public issue for security vulnerabilities.**

---

## Architecture Summary

OmegaWallet uses a **split-process trust boundary**:

| Layer | Trust Level | Access |
|---|---|---|
| Renderer (React) | Untrusted | No keys, no vault, no RPC URLs |
| Main Process (Node) | Privileged | Vault, signing, RPC proxy, simulation |

Communication crosses one boundary: Electron IPC via `contextBridge`.

### Key Security Properties

- **71 IPC handlers**, each with schema validation before execution
- **Two-phase signing**: `bundler:prepare` → `bundler:confirm` with FreshAuth
- **AES-256-GCM** encrypted vault on disk
- **FreshAuth**: single-use, time-limited tokens for destructive/sensitive operations
- **Spend limits**: configurable daily caps, enforced server-side
- **Transaction simulation**: calldata decoded and risk-scored before signing
- **RPC proxy**: URLs never exposed to renderer

### What the Renderer Cannot Do

- Access private keys or seed phrases
- Call RPC endpoints directly
- Sign transactions without FreshAuth
- Bypass schema validation
- Read the vault file

---

## Validation Status

**Internal adversarial validation suite passed — not externally audited.**

- 141 attack scenarios across 15 campaigns
- 7 security boundaries tested at 100%
- Zero S5 (key leak), S4 (auth bypass), S3 (policy bypass)
- Test environment: mocked Electron IPC + temporary vault directory

See `KNOWN_LIMITATIONS.md` for what this validation does **not** cover.

---

## Supported Versions

| Version | Status |
|---|---|
| 5.0.0-rc1 | Current (feature-frozen) |

---

## Scope

This security policy applies to the OmegaWallet Electron desktop application.
It does not cover third-party on-ramp providers, external dApps, or DEX aggregator APIs.
