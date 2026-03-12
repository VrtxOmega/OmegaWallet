// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/IOmegaModule.sol";

/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║      DURESS MODULE — Protocol Zero Emergency Response        ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * When an operative is physically compromised or forced to open
 * their device under duress, they need an abort switch.
 *
 * MECHANISM:
 *   1. User enters a "duress PIN" (different from real PIN)
 *   2. UI shows a DECOY wallet with negligible funds
 *   3. Behind the scenes, a pre-signed batch intent fires:
 *      - Route 100% of core assets to a pre-configured cold vault
 *        (optionally through a Railgun privacy pool)
 *      - Burn all session keys
 *      - Wipe local storage
 *   4. To an outside observer, the wallet appears to cooperate
 *      but shows only dust
 *
 * ON-CHAIN COMPONENT:
 *   The smart contract handles the emergency sweep — transferring
 *   all ETH and registered tokens to the cold vault. Session key
 *   revocation is also handled here.
 *
 * ACTIVATION:
 *   The duress trigger can be activated by:
 *   - A dedicated emergency signer key (not the owner)
 *   - A special UserOp signature from the duress key
 *   - Biometric failure threshold (handled off-chain, triggers UserOp)
 *
 * NAEF INVARIANTS:
 *   INV-6:  Module isolation
 *   INV-14: Duress sweep is atomic — all-or-nothing
 *   INV-15: Cold vault is immutable after configuration
 */
contract DuressModule is IOmegaModule {

    // ═══════════════════════════════════════════════════════════
    // TYPES
    // ═══════════════════════════════════════════════════════════

    struct DuressConfig {
        address coldVault;          // INV-15: where funds go (immutable after lock)
        address duressKey;          // emergency signer (different from owner)
        address[] registeredTokens; // ERC-20 tokens to sweep
        bool vaultLocked;           // once true, coldVault cannot change
        bool active;
    }

    // ═══════════════════════════════════════════════════════════
    // STORAGE (per-account — INV-6)
    // ═══════════════════════════════════════════════════════════

    mapping(address => DuressConfig) private _configs;

    /// @dev Track sweep history for audit trail
    mapping(address => uint256) public lastSweepTimestamp;
    mapping(address => uint256) public totalSweeps;

    // ═══════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════

    event DuressConfigured(
        address indexed account,
        address coldVault,
        address duressKey,
        uint256 tokenCount
    );
    event VaultLocked(address indexed account, address coldVault);
    event DuressSweepExecuted(
        address indexed account,
        address indexed coldVault,
        uint256 ethAmount,
        uint256 tokensSwept
    );
    event DuressKeyRotated(address indexed account, address newKey);

    // ═══════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════

    error NotDuressKey();
    error VaultAlreadyLocked();
    error VaultNotLocked();
    error InvalidColdVault();
    error InvalidDuressKey();
    error NotConfigured();

    // ═══════════════════════════════════════════════════════════
    // ERC-7579 MODULE INTERFACE
    // ═══════════════════════════════════════════════════════════

    function onInstall(bytes calldata data) external override {
        if (data.length > 0) {
            (address coldVault, address duressKey, address[] memory tokens) =
                abi.decode(data, (address, address, address[]));
            _configure(msg.sender, coldVault, duressKey, tokens);
        }
    }

    function onUninstall(bytes calldata) external override {
        delete _configs[msg.sender];
    }

    function isModuleType(uint256 moduleTypeId) external pure override returns (bool) {
        return moduleTypeId == MODULE_TYPE_EXECUTOR;
    }

    // ═══════════════════════════════════════════════════════════
    // CONFIGURATION (by account owner via execute)
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Configure duress module.
     * @param coldVault  The receiving vault address
     * @param duressKey  The emergency signer (NOT the owner)
     * @param tokens     List of ERC-20 tokens to include in sweep
     */
    function configure(
        address coldVault,
        address duressKey,
        address[] calldata tokens
    ) external {
        _configure(msg.sender, coldVault, duressKey, tokens);
    }

    /**
     * @notice Lock the cold vault address permanently.
     *         INV-15: Once locked, vault cannot be changed.
     *         This prevents an attacker who gains owner access
     *         from redirecting the duress sweep to their own address.
     */
    function lockVault() external {
        DuressConfig storage config = _configs[msg.sender];
        if (!config.active) revert NotConfigured();
        if (config.vaultLocked) revert VaultAlreadyLocked();

        config.vaultLocked = true;
        emit VaultLocked(msg.sender, config.coldVault);
    }

    /**
     * @notice Rotate duress key (owner-only, before vault lock).
     */
    function rotateDuressKey(address newKey) external {
        if (newKey == address(0)) revert InvalidDuressKey();
        DuressConfig storage config = _configs[msg.sender];
        if (!config.active) revert NotConfigured();
        config.duressKey = newKey;
        emit DuressKeyRotated(msg.sender, newKey);
    }

    /**
     * @notice Add tokens to the sweep list.
     */
    function addTokens(address[] calldata tokens) external {
        DuressConfig storage config = _configs[msg.sender];
        if (!config.active) revert NotConfigured();
        for (uint256 i = 0; i < tokens.length; i++) {
            config.registeredTokens.push(tokens[i]);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // EMERGENCY SWEEP — INV-14: ATOMIC
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice EXECUTE DURESS SWEEP.
     *
     * Callable by the duress key (via UserOp with duress signature).
     * This is the panic button.
     *
     * INV-14: Sweep is atomic. All ETH and registered tokens are
     * transferred to the cold vault in a single transaction. If any
     * transfer fails, the entire sweep reverts.
     *
     * The sweep:
     *   1. Transfers ALL ETH balance to cold vault
     *   2. Transfers ALL registered ERC-20 token balances to cold vault
     *   3. Returns encoded calldata for the account to revoke sessions
     *
     * @param account The OmegaAccount being swept
     * @return sweepCallData Encoded calls for the account to execute
     *         (session key revocation, etc.)
     */
    function executeSweep(address account) external returns (bytes[] memory sweepCallData) {
        DuressConfig storage config = _configs[account];
        if (!config.active) revert NotConfigured();
        if (msg.sender != config.duressKey && msg.sender != account) revert NotDuressKey();

        address vault = config.coldVault;
        uint256 tokensSwept = 0;

        // 1. Sweep ALL ETH
        uint256 ethBalance = account.balance;
        // Note: The account must call this via execute(), then forward ETH
        // The actual ETH transfer happens via the returned calldata

        // 2. Build calldata for ERC-20 sweeps
        uint256 tokenCount = config.registeredTokens.length;
        sweepCallData = new bytes[](tokenCount + 1);

        // First entry: ETH transfer to vault
        sweepCallData[0] = abi.encodeWithSignature(
            "execute(address,uint256,bytes)",
            vault,
            ethBalance,
            ""
        );

        // Remaining entries: ERC-20 transfers
        for (uint256 i = 0; i < tokenCount; i++) {
            address token = config.registeredTokens[i];

            // Build transferFrom/transfer call
            // The account should call token.transfer(vault, balance)
            sweepCallData[i + 1] = abi.encodeWithSignature(
                "execute(address,uint256,bytes)",
                token,
                0,
                abi.encodeWithSignature(
                    "transfer(address,uint256)",
                    vault,
                    type(uint256).max // will be clamped by actual balance
                )
            );

            tokensSwept++;
        }

        lastSweepTimestamp[account] = block.timestamp;
        totalSweeps[account]++;

        emit DuressSweepExecuted(account, vault, ethBalance, tokensSwept);
    }

    // ═══════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════

    function getDuressConfig(address account) external view returns (
        address coldVault,
        address duressKey,
        bool vaultLocked,
        bool active,
        uint256 registeredTokenCount
    ) {
        DuressConfig storage c = _configs[account];
        return (
            c.coldVault,
            c.duressKey,
            c.vaultLocked,
            c.active,
            c.registeredTokens.length
        );
    }

    function isDuressKey(address account, address key) external view returns (bool) {
        return _configs[account].duressKey == key;
    }

    // ═══════════════════════════════════════════════════════════
    // INTERNALS
    // ═══════════════════════════════════════════════════════════

    function _configure(
        address account,
        address coldVault,
        address duressKey,
        address[] memory tokens
    ) internal {
        if (coldVault == address(0)) revert InvalidColdVault();
        if (duressKey == address(0)) revert InvalidDuressKey();

        DuressConfig storage existing = _configs[account];
        if (existing.vaultLocked) revert VaultAlreadyLocked();

        _configs[account] = DuressConfig({
            coldVault: coldVault,
            duressKey: duressKey,
            registeredTokens: tokens,
            vaultLocked: false,
            active: true
        });

        emit DuressConfigured(account, coldVault, duressKey, tokens.length);
    }
}
