// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/IOmegaModule.sol";

/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║       SOCIAL RECOVERY MODULE — Guardian-Based Recovery       ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Isolated ERC-7579 Executor module. Enables guardian-threshold
 * recovery of account ownership with mandatory timelock.
 *
 * NAEF INVARIANTS ENFORCED:
 *   INV-5: Recovery cannot execute before timelock AND threshold met
 *   INV-6: Module isolation — separate storage from core account
 *   INV-7: Owner always valid (new owner != address(0))
 *
 * SECURITY MODEL:
 *   - N-of-M guardian threshold (e.g., 3-of-5)
 *   - 48-hour mandatory timelock after threshold reached
 *   - Owner can cancel recovery during timelock window
 *   - Guardian collusion bounded by threshold + timelock
 */
contract SocialRecoveryModule is IOmegaModule {

    // ═══════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════

    /// @notice INV-5: Minimum time between threshold reached and execution
    uint256 public constant RECOVERY_TIMELOCK = 48 hours;

    // ═══════════════════════════════════════════════════════════
    // TYPES
    // ═══════════════════════════════════════════════════════════

    struct RecoveryConfig {
        address[] guardians;
        uint256 threshold;
        mapping(address => bool) isGuardian;
    }

    struct RecoveryRequest {
        address newOwner;
        uint256 confirmations;
        uint256 initiatedAt;
        bool active;
        mapping(address => bool) confirmed;
    }

    // ═══════════════════════════════════════════════════════════
    // STORAGE (per-account — INV-6)
    // ═══════════════════════════════════════════════════════════

    mapping(address => RecoveryConfig) private _configs;
    mapping(address => RecoveryRequest) private _requests;

    // ═══════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════

    event GuardiansConfigured(address indexed account, uint256 guardianCount, uint256 threshold);
    event RecoveryInitiated(address indexed account, address indexed newOwner, address indexed initiator);
    event RecoveryConfirmed(address indexed account, address indexed guardian, uint256 totalConfirmations);
    event RecoveryCancelled(address indexed account);
    event RecoveryExecuted(address indexed account, address indexed newOwner);

    // ═══════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════

    error NotGuardian();
    error InvalidThreshold();
    error InvalidNewOwner();
    error NoActiveRecovery();
    error AlreadyConfirmed();
    error TimelockNotExpired(uint256 readyAt);
    error ThresholdNotMet(uint256 current, uint256 required);
    error RecoveryAlreadyActive();

    // ═══════════════════════════════════════════════════════════
    // ERC-7579 MODULE INTERFACE
    // ═══════════════════════════════════════════════════════════

    function onInstall(bytes calldata data) external override {
        if (data.length > 0) {
            (address[] memory guardians, uint256 threshold) =
                abi.decode(data, (address[], uint256));
            _setupGuardians(msg.sender, guardians, threshold);
        }
    }

    function onUninstall(bytes calldata) external override {
        // Clear all guardian state
        RecoveryConfig storage config = _configs[msg.sender];
        for (uint256 i = 0; i < config.guardians.length; i++) {
            config.isGuardian[config.guardians[i]] = false;
        }
        delete _configs[msg.sender].guardians;
        _configs[msg.sender].threshold = 0;

        // Clear any active recovery
        _requests[msg.sender].active = false;
    }

    function isModuleType(uint256 moduleTypeId) external pure override returns (bool) {
        return moduleTypeId == MODULE_TYPE_EXECUTOR;
    }

    // ═══════════════════════════════════════════════════════════
    // GUARDIAN MANAGEMENT (called by account owner via execute)
    // ═══════════════════════════════════════════════════════════

    function setupGuardians(
        address[] calldata guardians,
        uint256 threshold
    ) external {
        _setupGuardians(msg.sender, guardians, threshold);
    }

    // ═══════════════════════════════════════════════════════════
    // RECOVERY FLOW
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Step 1: Guardian initiates recovery.
     * @param account   The account to recover
     * @param newOwner  The proposed new owner
     */
    function initiateRecovery(address account, address newOwner) external {
        RecoveryConfig storage config = _configs[account];
        if (!config.isGuardian[msg.sender]) revert NotGuardian();
        if (newOwner == address(0)) revert InvalidNewOwner();
        if (_requests[account].active) revert RecoveryAlreadyActive();

        RecoveryRequest storage req = _requests[account];
        req.newOwner = newOwner;
        req.confirmations = 1;
        req.initiatedAt = block.timestamp;
        req.active = true;
        req.confirmed[msg.sender] = true;

        emit RecoveryInitiated(account, newOwner, msg.sender);
    }

    /**
     * @notice Step 2: Additional guardians confirm.
     * @param account The account being recovered
     */
    function confirmRecovery(address account) external {
        RecoveryConfig storage config = _configs[account];
        if (!config.isGuardian[msg.sender]) revert NotGuardian();

        RecoveryRequest storage req = _requests[account];
        if (!req.active) revert NoActiveRecovery();
        if (req.confirmed[msg.sender]) revert AlreadyConfirmed();

        req.confirmed[msg.sender] = true;
        req.confirmations++;

        emit RecoveryConfirmed(account, msg.sender, req.confirmations);
    }

    /**
     * @notice Step 3: Execute recovery after timelock.
     *
     * INV-5: BOTH conditions must be met:
     *   - confirmations >= threshold
     *   - block.timestamp >= initiatedAt + RECOVERY_TIMELOCK
     *
     * @param account The account to recover
     * @return callData The encoded transferOwnership call for the account to execute
     */
    function executeRecovery(address account) external returns (bytes memory callData) {
        RecoveryRequest storage req = _requests[account];
        if (!req.active) revert NoActiveRecovery();

        RecoveryConfig storage config = _configs[account];

        // INV-5: Threshold check
        if (req.confirmations < config.threshold) {
            revert ThresholdNotMet(req.confirmations, config.threshold);
        }

        // INV-5: Timelock check
        uint256 readyAt = req.initiatedAt + RECOVERY_TIMELOCK;
        if (block.timestamp < readyAt) {
            revert TimelockNotExpired(readyAt);
        }

        address newOwner = req.newOwner;

        // Clear recovery state
        _clearRecovery(account);

        emit RecoveryExecuted(account, newOwner);

        // Return the calldata for OmegaAccount.transferOwnership(newOwner)
        return abi.encodeWithSignature("transferOwnership(address)", newOwner);
    }

    /**
     * @notice Owner cancels an active recovery during timelock.
     *         Called by account (msg.sender == account).
     */
    function cancelRecovery() external {
        if (!_requests[msg.sender].active) revert NoActiveRecovery();
        _clearRecovery(msg.sender);
        emit RecoveryCancelled(msg.sender);
    }

    // ═══════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════

    function getRecoveryStatus(address account) external view returns (
        bool active,
        address newOwner,
        uint256 confirmations,
        uint256 threshold,
        uint256 readyAt
    ) {
        RecoveryRequest storage req = _requests[account];
        RecoveryConfig storage config = _configs[account];
        return (
            req.active,
            req.newOwner,
            req.confirmations,
            config.threshold,
            req.active ? req.initiatedAt + RECOVERY_TIMELOCK : 0
        );
    }

    function isGuardian(address account, address addr) external view returns (bool) {
        return _configs[account].isGuardian[addr];
    }

    function getGuardianCount(address account) external view returns (uint256) {
        return _configs[account].guardians.length;
    }

    // ═══════════════════════════════════════════════════════════
    // INTERNALS
    // ═══════════════════════════════════════════════════════════

    function _setupGuardians(
        address account,
        address[] memory guardians,
        uint256 threshold
    ) internal {
        if (threshold == 0 || threshold > guardians.length) revert InvalidThreshold();

        RecoveryConfig storage config = _configs[account];

        // Clear old guardians
        for (uint256 i = 0; i < config.guardians.length; i++) {
            config.isGuardian[config.guardians[i]] = false;
        }
        delete config.guardians;

        // Set new guardians
        for (uint256 i = 0; i < guardians.length; i++) {
            config.isGuardian[guardians[i]] = true;
            config.guardians.push(guardians[i]);
        }
        config.threshold = threshold;

        emit GuardiansConfigured(account, guardians.length, threshold);
    }

    function _clearRecovery(address account) internal {
        RecoveryRequest storage req = _requests[account];
        RecoveryConfig storage config = _configs[account];

        // Clear confirmations
        for (uint256 i = 0; i < config.guardians.length; i++) {
            req.confirmed[config.guardians[i]] = false;
        }
        req.active = false;
        req.newOwner = address(0);
        req.confirmations = 0;
        req.initiatedAt = 0;
    }
}
