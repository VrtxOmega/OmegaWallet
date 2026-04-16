# Contributing to OmegaWallet

OmegaWallet is part of the **VERITAS & Sovereign Ecosystem**. Contributions are welcome provided they maintain the project's security posture, architectural invariants, and documentation standards.

---

## Before You Contribute

- Read [SECURITY.md](./SECURITY.md) to understand the threat model and trust boundaries.
- Read [KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md) to understand current scope and gaps.
- Check open issues and pull requests to avoid duplicate work.

**The core invariant is non-negotiable:** the renderer process cannot sign. Any contribution that weakens the IPC boundary, exposes keys to the renderer, or bypasses FreshAuth will not be merged.

---

## Repository Layout

```
electron/     Electron main process: vault, signing, IPC handlers, FreshAuth
frontend/     React UI (Vite): renderer only — no key or RPC access
extension/    Browser extension: EIP-1193 provider, background, popup
backend/      Express.js API: ERC-4337 bundler proxy, RPC proxy, Cerberus
src/          Solidity smart contracts (Foundry)
script/       Foundry deployment scripts
test/         Top-level test entry points
```

---

## Development Setup

See the [Quickstart](./README.md#quickstart) section in the README for full setup instructions per component.

---

## Branch Convention

| Branch pattern | Purpose |
|---|---|
| `main` | Production-ready, feature-frozen for current release cycle |
| `feat/<name>` | New feature development |
| `fix/<name>` | Bug fixes |
| `docs/<name>` | Documentation-only changes |
| `chore/<name>` | Tooling, dependency updates, repo hygiene |

Open a pull request against `main`. Keep PRs focused — one concern per PR.

---

## Code Standards

### General

- Match the style of the file you are editing.
- No commented-out code left in PRs.
- No secrets, private keys, mnemonics, or real credentials in any committed file.
- All `.env` files are excluded by `.gitignore` — never bypass this.

### JavaScript / Node.js (electron/, backend/, extension/)

- ES modules (`type: module`) are used in `backend/` and `extension/`; `electron/` uses CommonJS. Do not mix module systems within a package without justification.
- Schema-validate all IPC message payloads — do not add unvalidated IPC channels.
- New IPC handlers must be registered in `electron/ipc-handlers.js` with a corresponding schema entry in `electron/ipc-schema.js`.

### Solidity (src/)

- Solidity 0.8.28, optimizer 200 runs, via-ir.
- Follow checks-effects-interactions for any function with external calls.
- New contracts must have unit tests and, where applicable, fuzz tests under `test/`.
- Run `forge test` before submitting. All tests must pass.

### React (frontend/)

- Renderer must never receive private keys, seed phrases, or RPC URLs — not even as props, state, or IPC return values.
- Keep UI components free of direct ethers.js signing calls.

---

## Pull Request Checklist

Before opening a PR, confirm:

- [ ] `forge test` passes (if Solidity changes)
- [ ] Backend tests pass: `cd backend && npm test`
- [ ] Electron tests pass: `cd electron && node test/run-all.js` (if applicable)
- [ ] No secrets or credentials introduced
- [ ] No new unvalidated IPC channels
- [ ] Documentation updated if behavior changes
- [ ] PR description explains the change and why

---

## Security Vulnerabilities

Do **not** open a public issue for security vulnerabilities. See [SECURITY.md](./SECURITY.md) for the responsible disclosure process.

---

## License

By contributing to this repository, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
