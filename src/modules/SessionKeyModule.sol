// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/IOmegaModule.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║         SESSION KEY MODULE — Scoped Ephemeral Access         ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Isolated ERC-7579 Validator module. Manages ephemeral session keys
 * with triple-bounded permissions:
 *
 *   1. TIME BOUNDS (INV-3): validAfter ≤ block.timestamp ≤ validUntil
 *   2. SPEND CEILING (INV-2): cumulative spend ≤ spendLimit
 *   3. CONTRACT SCOPE (INV-4): target ∈ allowedContracts (if scoped)
 *
 * Storage is per-account (account → key → SessionData).
 * Module isolation (INV-6): this contract cannot access OmegaAccount
 * storage or any other module's storage.
 *
 * TACTICAL USE CASES:
 *   - "Degen Guard": Session key capped at $50 for 4 hours
 *   - "DeFi Ops": Session key scoped to Uniswap router only
 *   - "Event Burner": Session key for POS system, 24h validity
 */
contract SessionKeyModule is IOmegaValidator {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // ═══════════════════════════════════════════════════════════
    // TYPES
    // ═══════════════════════════════════════════════════════════

    struct SessionData {
        bool active;
        uint48 validAfter;            // INV-3: start timestamp
        uint48 validUntil;            // INV-3: expiry timestamp
        uint256 spendLimit;           // INV-2: max wei per session
        uint256 spent;                // INV-2: running counter
        address[] allowedContracts;   // INV-4: empty = allow all
    }

    // ═══════════════════════════════════════════════════════════
    // STORAGE (per-account isolation — INV-6)
    // ═══════════════════════════════════════════════════════════

    /// @dev account => sessionKey => SessionData
    mapping(address => mapping(address => SessionData)) private _sessions;

    /// @dev account => list of all session key addresses
    mapping(address => address[]) private _sessionList;

    // ═══════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════

    event SessionCreated(
        address indexed account,
        address indexed key,
        uint48 validUntil,
        uint256 spendLimit,
        uint256 allowedContractsCount
    );
    event SessionRevoked(address indexed account, address indexed key);
    event SessionSpendRecorded(
        address indexed account,
        address indexed key,
        uint256 amount,
        uint256 newTotal
    );

    // ═══════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════

    error SessionNotActive();
    error SessionExpired();
    error SpendLimitExceeded(uint256 requested, uint256 remaining);
    error ContractNotAllowed(address target);
    error InvalidTimeRange();
    error KeyAlreadyRegistered();

    // ═══════════════════════════════════════════════════════════
    // ERC-7579 MODULE INTERFACE
    // ═══════════════════════════════════════════════════════════

    /// @inheritdoc IOmegaModule
    function onInstall(bytes calldata data) external override {
        // Decode initial session keys if provided
        if (data.length > 0) {
            (
                address[] memory keys,
                uint48[] memory validAfters,
                uint48[] memory validUntils,
                uint256[] memory spendLimits,
                address[][] memory allowedContracts
            ) = abi.decode(data, (address[], uint48[], uint48[], uint256[], address[][]));

            for (uint256 i = 0; i < keys.length; i++) {
                _createSession(
                    msg.sender,
                    keys[i],
                    validAfters[i],
                    validUntils[i],
                    spendLimits[i],
                    allowedContracts[i]
                );
            }
        }
    }

    /// @inheritdoc IOmegaModule
    function onUninstall(bytes calldata) external override {
        // Revoke all sessions for this account
        address[] storage keys = _sessionList[msg.sender];
        for (uint256 i = 0; i < keys.length; i++) {
            delete _sessions[msg.sender][keys[i]];
        }
        delete _sessionList[msg.sender];
    }

    /// @inheritdoc IOmegaModule
    function isModuleType(uint256 moduleTypeId) external pure override returns (bool) {
        return moduleTypeId == MODULE_TYPE_VALIDATOR;
    }

    // ═══════════════════════════════════════════════════════════
    // VALIDATOR — SIGNATURE VALIDATION
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Validate a signature against registered session keys.
     *
     * INV-3: Time bounds packed into validationData for EntryPoint enforcement.
     * The EntryPoint itself checks block.timestamp against these bounds,
     * providing a trustless time enforcement layer.
     *
     * @param userOpHash The hash of the UserOp
     * @param signature  The 65-byte ECDSA signature from the session key holder
     * @return validationData Packed: [20-byte 0=valid] [6-byte validUntil] [6-byte validAfter]
     */
    function validateSignature(
        bytes32 userOpHash,
        bytes calldata signature
    ) external view override returns (uint256 validationData) {
        // msg.sender is the OmegaAccount calling this module
        address account = msg.sender;

        bytes32 ethHash = userOpHash.toEthSignedMessageHash();
        address signer = ethHash.recover(signature);

        SessionData storage session = _sessions[account][signer];

        if (!session.active) {
            return 1; // SIG_VALIDATION_FAILED
        }

        // INV-3: Pack time bounds for EntryPoint enforcement
        return _packValidationData(false, session.validUntil, session.validAfter);
    }

    // ═══════════════════════════════════════════════════════════
    // SESSION MANAGEMENT (called by account via execute)
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Create a new session key.
     * @param key              The session key's public address
     * @param validAfter       Start timestamp
     * @param validUntil       Expiry timestamp
     * @param spendLimit       Maximum cumulative ETH spend (in wei)
     * @param allowedContracts Contracts this key can interact with (empty = all)
     */
    function createSession(
        address key,
        uint48 validAfter,
        uint48 validUntil,
        uint256 spendLimit,
        address[] calldata allowedContracts
    ) external {
        _createSession(msg.sender, key, validAfter, validUntil, spendLimit, allowedContracts);
    }

    /**
     * @notice Revoke a session key immediately.
     * @param key The session key to revoke
     */
    function revokeSession(address key) external {
        _sessions[msg.sender][key].active = false;
        emit SessionRevoked(msg.sender, key);
    }

    /**
     * @notice Record a spend against a session key. Called by hook module.
     *
     * INV-2: Enforces spend ceiling. Reverts if exceeded.
     * INV-4: Enforces contract scope. Reverts if target not allowed.
     *
     * @param key    The session key that authorized this op
     * @param target The contract being called
     * @param value  The ETH value being sent
     */
    function recordSpend(
        address key,
        address target,
        uint256 value
    ) external {
        address account = msg.sender;
        SessionData storage session = _sessions[account][key];

        if (!session.active) revert SessionNotActive();

        // INV-4: Contract scope check
        if (session.allowedContracts.length > 0) {
            bool allowed = false;
            for (uint256 i = 0; i < session.allowedContracts.length; i++) {
                if (session.allowedContracts[i] == target) {
                    allowed = true;
                    break;
                }
            }
            if (!allowed) revert ContractNotAllowed(target);
        }

        // INV-2: Spend ceiling enforcement
        uint256 newTotal = session.spent + value;
        if (newTotal > session.spendLimit) {
            revert SpendLimitExceeded(value, session.spendLimit - session.spent);
        }
        session.spent = newTotal;

        emit SessionSpendRecorded(account, key, value, newTotal);
    }

    // ═══════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════

    function getSession(
        address account,
        address key
    ) external view returns (
        bool active,
        uint48 validAfter,
        uint48 validUntil,
        uint256 spendLimit,
        uint256 spent,
        address[] memory allowedContracts
    ) {
        SessionData storage s = _sessions[account][key];
        return (s.active, s.validAfter, s.validUntil, s.spendLimit, s.spent, s.allowedContracts);
    }

    function getSessionCount(address account) external view returns (uint256) {
        return _sessionList[account].length;
    }

    function getRemainingBudget(
        address account,
        address key
    ) external view returns (uint256) {
        SessionData storage s = _sessions[account][key];
        if (!s.active || s.spent >= s.spendLimit) return 0;
        return s.spendLimit - s.spent;
    }

    // ═══════════════════════════════════════════════════════════
    // INTERNALS
    // ═══════════════════════════════════════════════════════════

    function _createSession(
        address account,
        address key,
        uint48 validAfter,
        uint48 validUntil,
        uint256 spendLimit,
        address[] memory allowedContracts
    ) internal {
        if (validAfter >= validUntil) revert InvalidTimeRange();
        if (_sessions[account][key].active) revert KeyAlreadyRegistered();

        _sessions[account][key] = SessionData({
            active: true,
            validAfter: validAfter,
            validUntil: validUntil,
            spendLimit: spendLimit,
            spent: 0,
            allowedContracts: allowedContracts
        });

        _sessionList[account].push(key);

        emit SessionCreated(account, key, validUntil, spendLimit, allowedContracts.length);
    }

    function _packValidationData(
        bool sigFailed,
        uint48 validUntil,
        uint48 validAfter
    ) internal pure returns (uint256) {
        return
            (sigFailed ? 1 : 0) |
            (uint256(validUntil) << 160) |
            (uint256(validAfter) << 208);
    }
}
