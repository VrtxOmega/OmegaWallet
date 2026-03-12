# Known Limitations

This document lists known limitations, gaps, and areas where OmegaWallet has **not** been validated.
Honesty about boundaries is part of the security posture.

---

## Not Externally Audited

OmegaWallet has passed an internal adversarial test suite (141 scenarios, 15 campaigns).
This suite was designed and executed by the development team.
It has **not** been reviewed by an independent security auditor, penetration testing firm, or formal verification tool.

## No Long-Runtime Burn Test

The test suite runs in under 15 seconds. There is no extended burn test that runs the wallet
under sustained load for hours or days to detect:
- Memory leaks
- File handle exhaustion
- Gradual state corruption
- Timer drift in FreshAuth expiry

## No MITM Simulation

RPC calls are proxied through the main process, but the test suite does not simulate:
- Man-in-the-middle attacks on the RPC connection
- TLS certificate pinning failures
- DNS hijacking of RPC endpoints

## No Hardware Wallet Integration

YubiKey and Ledger hardware wallet integration is planned but not implemented.
All signing currently happens in software using in-memory keys derived from the encrypted vault.

## No Formal Verification

The vault encryption, FreshAuth token system, and two-phase signing protocol have not been
formally verified using tools like TLA+, Alloy, or Coq. Correctness is validated by
adversarial testing, not proof.

## Test Harness Limitations

- Tests run against **mocked Electron IPC**, not a live Electron process
- The renderer/main process split is not exercised at the OS level during testing
- No real blockchain transactions are signed or broadcast
- No real RPC responses are validated (RPC tests use mock providers)

## DEX Aggregator & On-Ramp Trust

- Swap quotes from 0x API and 1inch are taken at face value; no on-chain verification of quoted rates
- On-ramp providers (MoonPay, Ramp, Transak) are third-party services not audited by OmegaWallet
- Provider URLs are validated for format (HTTPS) but not for content or redirect safety

## No Multi-Device Sync

The vault is local to a single machine. There is no cloud backup, cross-device sync,
or remote recovery mechanism. If the machine is lost and the seed phrase is not backed up,
funds are unrecoverable.

## No Rate-Limit Evasion Testing

The rate limiter is tested for enforcement (2 tests), but there is no campaign that
specifically attempts to evade or circumvent rate limiting through timing attacks,
concurrent requests, or process restarts.

## No Accessibility Audit

The UI has not been audited for WCAG compliance, screen reader compatibility,
or keyboard-only navigation.

---

**This list will be updated as limitations are addressed or new ones are discovered.**
