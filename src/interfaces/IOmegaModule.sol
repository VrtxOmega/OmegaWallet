// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║             OMEGA MODULE INTERFACE — ERC-7579                ║
 * ║          Isolated Plugin Contract Standard                   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Every OmegaWallet module implements this interface.
 * Modules are isolated — they cannot access each other's storage.
 * The core account delegates specific operations to installed modules.
 */

/// @dev Module type identifiers (ERC-7579 aligned)
uint256 constant MODULE_TYPE_VALIDATOR = 1;    // signature validation
uint256 constant MODULE_TYPE_EXECUTOR = 2;     // execution logic
uint256 constant MODULE_TYPE_FALLBACK = 3;     // fallback handler
uint256 constant MODULE_TYPE_HOOK = 4;         // pre/post execution hooks

interface IOmegaModule {
    /// @notice Called when this module is installed on an account
    /// @param data ABI-encoded initialization parameters
    function onInstall(bytes calldata data) external;

    /// @notice Called when this module is uninstalled from an account
    /// @param data ABI-encoded cleanup parameters
    function onUninstall(bytes calldata data) external;

    /// @notice Check if this module is of the given type
    /// @param moduleTypeId The type to check against
    /// @return True if this module is of the given type
    function isModuleType(uint256 moduleTypeId) external view returns (bool);
}

/// @notice Validator modules can validate UserOp signatures
interface IOmegaValidator is IOmegaModule {
    /// @notice Validate a UserOp signature
    /// @param userOpHash The hash of the UserOp being validated
    /// @param signature The signature bytes to validate
    /// @return validationData Packed validation result (see ERC-4337)
    function validateSignature(
        bytes32 userOpHash,
        bytes calldata signature
    ) external view returns (uint256 validationData);
}

/// @notice Hook modules run before/after execution
interface IOmegaHook is IOmegaModule {
    /// @notice Called before execution. Can revert to block.
    /// @param target The call target
    /// @param value The ETH value
    /// @param data The calldata
    /// @return hookData Data passed to postHook
    function preHook(
        address target,
        uint256 value,
        bytes calldata data
    ) external returns (bytes memory hookData);

    /// @notice Called after execution.
    /// @param hookData Data from preHook
    /// @param success Whether the execution succeeded
    function postHook(
        bytes calldata hookData,
        bool success
    ) external;
}
