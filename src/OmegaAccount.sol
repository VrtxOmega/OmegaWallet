// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@account-abstraction/core/BaseAccount.sol";
import "@account-abstraction/interfaces/IEntryPoint.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import "./interfaces/IOmegaModule.sol";

/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║               OMEGA ACCOUNT v1.0 — MINIMAL CORE             ║
 * ║          ERC-4337 + ERC-7579 Modular Smart Account           ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Design principle: This contract does ALMOST NOTHING.
 *
 *   1. Holds the owner address (single source of truth)
 *   2. Validates owner ECDSA signature against EntryPoint
 *   3. Executes calls (single + batch) — gated by EntryPoint only
 *   4. Manages a module registry (install/uninstall plugins)
 *   5. Delegates to modules via CALL (never DELEGATECALL to untrusted)
 *
 * Everything else — session keys, batch distribution, social recovery,
 * spending limits, security scanning — lives in isolated modules.
 *
 * NAEF INVARIANTS ENFORCED:
 *   INV-1: EntryPoint Sovereignty (msg.sender == ENTRY_POINT)
 *   INV-6: Module Isolation (modules cannot access each other's storage)
 *   INV-7: Owner Uniqueness (exactly one owner, never address(0))
 *   INV-9: No delegatecall from modules to untrusted targets
 *   INV-10: Batch Atomicity (all-or-nothing execution)
 */
contract OmegaAccount is BaseAccount, Initializable, UUPSUpgradeable {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // ═══════════════════════════════════════════════════════════
    // IMMUTABLE STATE
    // ═══════════════════════════════════════════════════════════

    IEntryPoint private immutable _entryPoint;

    // ═══════════════════════════════════════════════════════════
    // MUTABLE STATE (minimal surface)
    // ═══════════════════════════════════════════════════════════

    /// @notice The sole owner. INV-7: exactly one, never address(0).
    address public owner;

    /// @notice Installed modules by type
    /// moduleType => module address => installed
    mapping(uint256 => mapping(address => bool)) private _modules;

    /// @notice Active validator modules (checked during sig validation)
    address[] private _validators;

    /// @notice Active hook modules (called pre/post execution)
    address[] private _hooks;

    // ═══════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════

    event OmegaInitialized(address indexed owner, IEntryPoint indexed entryPoint);
    event OwnerTransferred(address indexed oldOwner, address indexed newOwner);
    event ModuleInstalled(uint256 indexed moduleType, address indexed module);
    event ModuleUninstalled(uint256 indexed moduleType, address indexed module);

    // ═══════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════

    error OnlyOwner();
    error OnlyEntryPointOrSelf();
    error InvalidOwner();
    error ModuleAlreadyInstalled();
    error ModuleNotInstalled();
    error ModuleTypeMismatch();
    error HookRejected();

    // ═══════════════════════════════════════════════════════════
    // CONSTRUCTOR + INITIALIZATION
    // ═══════════════════════════════════════════════════════════

    /// @param entryPoint_ The ERC-4337 EntryPoint v0.7 address (immutable)
    constructor(IEntryPoint entryPoint_) {
        _entryPoint = entryPoint_;
        _disableInitializers();
    }

    /// @notice Initialize the account with an owner. Called once via proxy.
    /// @param owner_ The initial owner address. INV-7: must not be address(0).
    function initialize(address owner_) public initializer {
        if (owner_ == address(0)) revert InvalidOwner();
        owner = owner_;
        emit OmegaInitialized(owner_, _entryPoint);
    }

    // ═══════════════════════════════════════════════════════════
    // ERC-4337 CORE — INV-1: ENTRYPOINT SOVEREIGNTY
    // ═══════════════════════════════════════════════════════════

    /// @inheritdoc BaseAccount
    function entryPoint() public view virtual override returns (IEntryPoint) {
        return _entryPoint;
    }

    /**
     * @notice Validate UserOp signature.
     *
     * Order of validation:
     *   1. Try owner ECDSA signature
     *   2. Try each installed validator module
     *   3. If none match → SIG_VALIDATION_FAILED
     *
     * INV-1: Only callable via EntryPoint (enforced by BaseAccount)
     */
    function _validateSignature(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash
    ) internal virtual override returns (uint256 validationData) {
        bytes32 ethHash = userOpHash.toEthSignedMessageHash();

        // 1. Check owner signature
        address signer = ethHash.recover(userOp.signature);
        if (signer == owner) {
            return 0; // Valid, no time restrictions
        }

        // 2. Check installed validator modules
        uint256 validatorCount = _validators.length;
        for (uint256 i = 0; i < validatorCount; i++) {
            uint256 result = IOmegaValidator(_validators[i]).validateSignature(
                userOpHash,
                userOp.signature
            );
            if (result != SIG_VALIDATION_FAILED) {
                return result; // Module accepted the signature
            }
        }

        // 3. No valid signer found
        return SIG_VALIDATION_FAILED;
    }

    // ═══════════════════════════════════════════════════════════
    // EXECUTION — INV-1, INV-10
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Execute a single call. INV-1: EntryPoint or self only.
     *         Runs all installed hooks pre/post execution.
     */
    function execute(
        address target,
        uint256 value,
        bytes calldata data
    ) external virtual override {
        _requireForExecute();
        _executeWithHooks(target, value, data);
    }

    /**
     * @notice Execute a batch of calls. INV-10: Atomic — all or nothing.
     *         Runs hooks on each call in the batch.
     */
    function executeBatch(
        Call[] calldata calls
    ) external virtual override {
        _requireForExecute();

        uint256 callsLength = calls.length;
        for (uint256 i = 0; i < callsLength; i++) {
            _executeWithHooks(calls[i].target, calls[i].value, calls[i].data);
        }
    }

    /// @notice INV-1: Only EntryPoint or self-call (for module callbacks)
    function _requireForExecute() internal view virtual override {
        if (msg.sender != address(entryPoint()) && msg.sender != address(this)) {
            revert OnlyEntryPointOrSelf();
        }
    }

    // ═══════════════════════════════════════════════════════════
    // MODULE MANAGEMENT — INV-6: ISOLATION
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Install a module. Owner-only.
     * @param moduleTypeId The module type (VALIDATOR, EXECUTOR, FALLBACK, HOOK)
     * @param module The module contract address
     * @param initData Initialization data passed to module.onInstall()
     */
    function installModule(
        uint256 moduleTypeId,
        address module,
        bytes calldata initData
    ) external {
        _requireOwnerOrSelf();
        if (_modules[moduleTypeId][module]) revert ModuleAlreadyInstalled();
        if (!IOmegaModule(module).isModuleType(moduleTypeId)) revert ModuleTypeMismatch();

        _modules[moduleTypeId][module] = true;

        // Track in type-specific lists for iteration
        if (moduleTypeId == MODULE_TYPE_VALIDATOR) {
            _validators.push(module);
        } else if (moduleTypeId == MODULE_TYPE_HOOK) {
            _hooks.push(module);
        }

        // Call module's onInstall — via CALL, never DELEGATECALL (INV-9)
        IOmegaModule(module).onInstall(initData);

        emit ModuleInstalled(moduleTypeId, module);
    }

    /**
     * @notice Uninstall a module. Owner-only.
     * @param moduleTypeId The module type
     * @param module The module contract address
     * @param deInitData Cleanup data passed to module.onUninstall()
     */
    function uninstallModule(
        uint256 moduleTypeId,
        address module,
        bytes calldata deInitData
    ) external {
        _requireOwnerOrSelf();
        if (!_modules[moduleTypeId][module]) revert ModuleNotInstalled();

        _modules[moduleTypeId][module] = false;

        // Remove from type-specific lists
        if (moduleTypeId == MODULE_TYPE_VALIDATOR) {
            _removeFromArray(_validators, module);
        } else if (moduleTypeId == MODULE_TYPE_HOOK) {
            _removeFromArray(_hooks, module);
        }

        IOmegaModule(module).onUninstall(deInitData);

        emit ModuleUninstalled(moduleTypeId, module);
    }

    /// @notice Check if a module is installed
    function isModuleInstalled(
        uint256 moduleTypeId,
        address module
    ) external view returns (bool) {
        return _modules[moduleTypeId][module];
    }

    // ═══════════════════════════════════════════════════════════
    // OWNER MANAGEMENT — INV-7
    // ═══════════════════════════════════════════════════════════

    /// @notice Transfer ownership. Can be called by owner or by self
    ///         (allowing recovery modules to rotate the owner via execute).
    function transferOwnership(address newOwner) external {
        _requireOwnerOrSelf();
        if (newOwner == address(0)) revert InvalidOwner();
        address oldOwner = owner;
        owner = newOwner;
        emit OwnerTransferred(oldOwner, newOwner);
    }

    // ═══════════════════════════════════════════════════════════
    // UUPS UPGRADE — Owner-only
    // ═══════════════════════════════════════════════════════════

    function _authorizeUpgrade(address) internal view override {
        _requireOwnerOrSelf();
    }

    // ═══════════════════════════════════════════════════════════
    // INTERNALS
    // ═══════════════════════════════════════════════════════════

    /// @dev Execute a call with pre/post hooks. INV-9: hooks called via CALL.
    function _executeWithHooks(
        address target,
        uint256 value,
        bytes calldata data
    ) internal {
        // Pre-hooks: any hook can revert to block the transaction
        uint256 hookCount = _hooks.length;
        bytes[] memory hookData = new bytes[](hookCount);

        for (uint256 i = 0; i < hookCount; i++) {
            hookData[i] = IOmegaHook(_hooks[i]).preHook(target, value, data);
        }

        // Execute the actual call
        (bool success, ) = target.call{value: value}(data);
        if (!success) {
            // Bubble up revert data
            assembly {
                let ptr := mload(0x40)
                let size := returndatasize()
                returndatacopy(ptr, 0, size)
                revert(ptr, size)
            }
        }

        // Post-hooks
        for (uint256 i = 0; i < hookCount; i++) {
            IOmegaHook(_hooks[i]).postHook(hookData[i], success);
        }
    }

    /// @dev Require msg.sender is owner or self (for module-initiated calls)
    function _requireOwnerOrSelf() internal view {
        if (msg.sender != owner && msg.sender != address(this)) revert OnlyOwner();
    }

    /// @dev Remove an address from an array (swap-and-pop)
    function _removeFromArray(address[] storage arr, address target) internal {
        uint256 len = arr.length;
        for (uint256 i = 0; i < len; i++) {
            if (arr[i] == target) {
                arr[i] = arr[len - 1];
                arr.pop();
                return;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    // RECEIVE ETH
    // ═══════════════════════════════════════════════════════════

    receive() external payable {}
}
