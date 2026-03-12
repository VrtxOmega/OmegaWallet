// OmegaWallet — CODEBASE FROZEN
// Freeze date: 2026-03-12
// Version: 5.0.0-rc1
//
// ALLOWED: Bug fixes, UI polish, documentation
// BLOCKED: New features, new IPC channels, new dependencies
//
// Handlers: 71
// Components: 21
// Campaigns: 15 (141 scenarios)
// Boundaries: 7/7 at 100%
//
// Validation: Internal adversarial suite passed — not externally audited.
//
module.exports = {
    version: '5.0.0-rc1',
    frozen: true,
    frozenAt: '2026-03-12T12:01:00Z',
    handlers: 71,
    components: 21,
    campaigns: 15,
    scenarios: 141,
    boundaries: '7/7',
    status: 'FEATURE_FREEZE',
    allowed: ['bugfix', 'polish', 'documentation'],
    blocked: ['new-feature', 'new-ipc', 'new-dependency', 'architecture-change'],
};
