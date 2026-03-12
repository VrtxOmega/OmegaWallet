// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/IOmegaModule.sol";

/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     BATCH EXECUTOR MODULE — One Signature, N Transfers       ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Isolated ERC-7579 Executor module. Enables intent-based multi-wallet
 * distribution with atomic execution.
 *
 * NAEF INVARIANTS ENFORCED:
 *   INV-6: Module isolation
 *   INV-10: Batch atomicity — all succeed or all revert
 *
 * TACTICAL USE CASES:
 *   - Payroll: Distribute to 50 team wallets in one signature
 *   - Event: Split payment to vendor (98%) + protocol (2%)
 *   - Sweep: Pull dust from N burner wallets into cold vault
 */
contract BatchExecutorModule is IOmegaModule {

    // ═══════════════════════════════════════════════════════════
    // TYPES
    // ═══════════════════════════════════════════════════════════

    /// @notice A batch distribution intent
    struct BatchIntent {
        address token;          // address(0) = native ETH
        address[] recipients;
        uint256[] amounts;
    }

    // ═══════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════

    event BatchExecuted(
        address indexed account,
        address indexed token,
        uint256 recipientCount,
        uint256 totalValue
    );

    // ═══════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════

    error ArrayLengthMismatch();
    error EmptyBatch();
    error ETHTransferFailed(address recipient, uint256 amount);
    error TokenTransferFailed(address token, address recipient, uint256 amount);
    error InsufficientBalance(uint256 required, uint256 available);

    // ═══════════════════════════════════════════════════════════
    // ERC-7579 MODULE INTERFACE
    // ═══════════════════════════════════════════════════════════

    function onInstall(bytes calldata) external override {}
    function onUninstall(bytes calldata) external override {}

    function isModuleType(uint256 moduleTypeId) external pure override returns (bool) {
        return moduleTypeId == MODULE_TYPE_EXECUTOR;
    }

    // ═══════════════════════════════════════════════════════════
    // BATCH EXECUTION — INV-10: ATOMIC
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Execute a batch distribution of ETH.
     *
     * INV-10: If any transfer fails, the entire batch reverts.
     * All-or-nothing execution. No partial state.
     *
     * Called by the account via: account.execute(batchModule, totalValue, calldata)
     *
     * @param recipients Array of recipient addresses
     * @param amounts    Array of amounts (in wei) per recipient
     */
    function distributETH(
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external payable {
        if (recipients.length == 0) revert EmptyBatch();
        if (recipients.length != amounts.length) revert ArrayLengthMismatch();

        uint256 totalRequired = 0;
        for (uint256 i = 0; i < amounts.length; i++) {
            totalRequired += amounts[i];
        }

        if (msg.value < totalRequired) {
            revert InsufficientBalance(totalRequired, msg.value);
        }

        // INV-10: Atomic distribution
        for (uint256 i = 0; i < recipients.length; i++) {
            (bool success, ) = recipients[i].call{value: amounts[i]}("");
            if (!success) revert ETHTransferFailed(recipients[i], amounts[i]);
        }

        // Refund excess
        uint256 excess = msg.value - totalRequired;
        if (excess > 0) {
            (bool refunded, ) = msg.sender.call{value: excess}("");
            if (!refunded) revert ETHTransferFailed(msg.sender, excess);
        }

        emit BatchExecuted(msg.sender, address(0), recipients.length, totalRequired);
    }

    /**
     * @notice Execute a batch distribution of ERC-20 tokens.
     *
     * INV-10: Atomic — all transfers succeed or entire batch reverts.
     * Requires prior approval from the account to this module.
     *
     * @param token      The ERC-20 token address
     * @param recipients Array of recipient addresses
     * @param amounts    Array of token amounts per recipient
     */
    function distributeERC20(
        address token,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external {
        if (recipients.length == 0) revert EmptyBatch();
        if (recipients.length != amounts.length) revert ArrayLengthMismatch();

        uint256 totalValue = 0;

        // INV-10: Atomic ERC-20 distribution
        for (uint256 i = 0; i < recipients.length; i++) {
            totalValue += amounts[i];

            (bool success, bytes memory data) = token.call(
                abi.encodeWithSignature(
                    "transferFrom(address,address,uint256)",
                    msg.sender,
                    recipients[i],
                    amounts[i]
                )
            );

            if (!success || (data.length > 0 && !abi.decode(data, (bool)))) {
                revert TokenTransferFailed(token, recipients[i], amounts[i]);
            }
        }

        emit BatchExecuted(msg.sender, token, recipients.length, totalValue);
    }

    /**
     * @notice Execute an equal split of ETH to N recipients.
     *         Any remainder dust goes to the first recipient.
     *
     * @param recipients Array of recipient addresses
     */
    function splitETH(address[] calldata recipients) external payable {
        if (recipients.length == 0) revert EmptyBatch();

        uint256 share = msg.value / recipients.length;
        uint256 remainder = msg.value % recipients.length;

        for (uint256 i = 0; i < recipients.length; i++) {
            uint256 amount = share + (i == 0 ? remainder : 0);
            (bool success, ) = recipients[i].call{value: amount}("");
            if (!success) revert ETHTransferFailed(recipients[i], amount);
        }

        emit BatchExecuted(msg.sender, address(0), recipients.length, msg.value);
    }
}
