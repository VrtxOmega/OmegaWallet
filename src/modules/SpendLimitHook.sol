// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/IOmegaModule.sol";

/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║      SPEND LIMIT HOOK — Per-Period Spending Guard            ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Isolated ERC-7579 Hook module. Enforces spending limits at the
 * execution layer — runs BEFORE every transaction.
 *
 * Unlike SessionKeyModule's per-session limits, this module enforces
 * global per-period limits on the entire account. Applies to ALL
 * transactions including owner-signed ones.
 *
 * NAEF INVARIANTS ENFORCED:
 *   INV-2: Spend ceiling (account-wide, per period)
 *   INV-6: Module isolation
 *
 * TACTICAL USE CASES:
 *   - "Daily Cap": Max $1000/day even if wallet is fully compromised
 *   - "Travel Mode": Reduce limits while abroad
 *   - "Degen Guard": Hard $50 cap for the next 4 hours
 */
contract SpendLimitHook is IOmegaHook {

    // ═══════════════════════════════════════════════════════════
    // TYPES
    // ═══════════════════════════════════════════════════════════

    struct SpendConfig {
        uint256 limitPerPeriod;   // max ETH (wei) per period
        uint256 periodDuration;   // period length in seconds
        uint256 currentPeriodStart;
        uint256 spentThisPeriod;
        bool active;
    }

    // ═══════════════════════════════════════════════════════════
    // STORAGE (per-account — INV-6)
    // ═══════════════════════════════════════════════════════════

    mapping(address => SpendConfig) private _configs;

    // ═══════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════

    event SpendLimitConfigured(
        address indexed account,
        uint256 limitPerPeriod,
        uint256 periodDuration
    );
    event SpendRecorded(
        address indexed account,
        uint256 amount,
        uint256 spentThisPeriod,
        uint256 remaining
    );
    event PeriodReset(address indexed account, uint256 newPeriodStart);

    // ═══════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════

    error SpendLimitExceeded(uint256 requested, uint256 remaining);
    error InvalidPeriodDuration();

    // ═══════════════════════════════════════════════════════════
    // ERC-7579 MODULE INTERFACE
    // ═══════════════════════════════════════════════════════════

    function onInstall(bytes calldata data) external override {
        if (data.length > 0) {
            (uint256 limitPerPeriod, uint256 periodDuration) =
                abi.decode(data, (uint256, uint256));
            _configure(msg.sender, limitPerPeriod, periodDuration);
        }
    }

    function onUninstall(bytes calldata) external override {
        delete _configs[msg.sender];
    }

    function isModuleType(uint256 moduleTypeId) external pure override returns (bool) {
        return moduleTypeId == MODULE_TYPE_HOOK;
    }

    // ═══════════════════════════════════════════════════════════
    // HOOK IMPLEMENTATION — INV-2 ENFORCEMENT
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Pre-execution hook. Checks and records ETH spend.
     *
     * INV-2: If the outgoing ETH value would exceed the period limit,
     * this function REVERTS, blocking the transaction entirely.
     *
     * Period auto-resets when the current period expires.
     *
     * @param target The call target (unused for spend tracking)
     * @param value  The ETH value being sent
     * @param data   The calldata (unused)
     * @return hookData Encoded spend amount for postHook
     */
    function preHook(
        address target,
        uint256 value,
        bytes calldata data
    ) external override returns (bytes memory hookData) {
        SpendConfig storage config = _configs[msg.sender];

        // If not configured, pass through
        if (!config.active) {
            return abi.encode(uint256(0));
        }

        // Auto-reset period if expired
        if (block.timestamp >= config.currentPeriodStart + config.periodDuration) {
            config.currentPeriodStart = block.timestamp;
            config.spentThisPeriod = 0;
            emit PeriodReset(msg.sender, block.timestamp);
        }

        // INV-2: Enforce spend ceiling
        if (value > 0) {
            uint256 remaining = config.limitPerPeriod - config.spentThisPeriod;
            if (value > remaining) {
                revert SpendLimitExceeded(value, remaining);
            }

            config.spentThisPeriod += value;

            emit SpendRecorded(
                msg.sender,
                value,
                config.spentThisPeriod,
                config.limitPerPeriod - config.spentThisPeriod
            );
        }

        return abi.encode(value);
    }

    /**
     * @notice Post-execution hook. Currently a no-op.
     *         Could be used to refund on failure if needed.
     */
    function postHook(
        bytes calldata,
        bool
    ) external override {
        // No-op. Spend was recorded in preHook.
        // If we wanted refund-on-failure, we'd check success here.
    }

    // ═══════════════════════════════════════════════════════════
    // CONFIGURATION (called by account via execute)
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Configure spend limits.
     * @param limitPerPeriod  Max ETH (wei) per period
     * @param periodDuration  Period length in seconds
     */
    function configure(uint256 limitPerPeriod, uint256 periodDuration) external {
        _configure(msg.sender, limitPerPeriod, periodDuration);
    }

    /**
     * @notice Temporarily override limits (e.g., "Degen Guard" mode).
     *         Sets a new limit and period, resetting the counter.
     * @param limitPerPeriod  New max ETH (wei)
     * @param periodDuration  New period in seconds
     */
    function setTemporaryLimit(uint256 limitPerPeriod, uint256 periodDuration) external {
        _configure(msg.sender, limitPerPeriod, periodDuration);
    }

    // ═══════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════

    function getSpendStatus(address account) external view returns (
        bool active,
        uint256 limitPerPeriod,
        uint256 spentThisPeriod,
        uint256 remaining,
        uint256 periodEndsAt
    ) {
        SpendConfig storage c = _configs[account];
        uint256 rem = c.active && c.spentThisPeriod < c.limitPerPeriod
            ? c.limitPerPeriod - c.spentThisPeriod
            : 0;
        return (
            c.active,
            c.limitPerPeriod,
            c.spentThisPeriod,
            rem,
            c.currentPeriodStart + c.periodDuration
        );
    }

    // ═══════════════════════════════════════════════════════════
    // INTERNALS
    // ═══════════════════════════════════════════════════════════

    function _configure(
        address account,
        uint256 limitPerPeriod,
        uint256 periodDuration
    ) internal {
        if (periodDuration == 0) revert InvalidPeriodDuration();

        _configs[account] = SpendConfig({
            limitPerPeriod: limitPerPeriod,
            periodDuration: periodDuration,
            currentPeriodStart: block.timestamp,
            spentThisPeriod: 0,
            active: true
        });

        emit SpendLimitConfigured(account, limitPerPeriod, periodDuration);
    }
}
