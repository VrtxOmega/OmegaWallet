// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@account-abstraction/core/BasePaymaster.sol";
import "@account-abstraction/interfaces/IEntryPoint.sol";
import "@account-abstraction/core/UserOperationLib.sol";

/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║          OMEGA PAYMASTER — B2B Gas Sponsorship Engine        ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ERC-4337 Paymaster with configurable margin. Revenue engine for
 * OmegaWallet B2B model.
 *
 * BUSINESS MODEL:
 *   - Event hosts/dApp devs deposit ETH into gas pools
 *   - Paymaster sponsors user transactions from the pool
 *   - Configurable margin (5-10%) on top of actual gas cost
 *   - Protocol collects margin as revenue
 *
 * NAEF INVARIANTS ENFORCED:
 *   INV-8: Paymaster solvency — never sponsors if insufficient deposit
 *
 * SECURITY MODEL:
 *   - Per-sponsor deposit tracking
 *   - Spending limits per user per sponsor
 *   - Admin-only margin configuration
 *   - Emergency withdrawal by sponsors
 */
contract OmegaPaymaster is BasePaymaster {
    using UserOperationLib for PackedUserOperation;

    // ═══════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════

    uint256 public constant MAX_MARGIN_BPS = 2000; // 20% max margin
    uint256 public constant BPS_DENOMINATOR = 10000;

    // ═══════════════════════════════════════════════════════════
    // STORAGE
    // ═══════════════════════════════════════════════════════════

    /// @notice Protocol margin in basis points (100 = 1%)
    uint256 public marginBps;

    /// @notice Per-sponsor gas pool deposits
    mapping(address => uint256) public sponsorDeposits;

    /// @notice Per-sponsor per-user spending limits
    /// sponsor => user => maxGasWei
    mapping(address => mapping(address => uint256)) public userLimits;

    /// @notice Per-sponsor per-user cumulative gas spent
    mapping(address => mapping(address => uint256)) public userSpent;

    /// @notice Protocol revenue accumulated (from margins)
    uint256 public protocolRevenue;

    // ═══════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════

    event SponsorDeposited(address indexed sponsor, uint256 amount, uint256 newBalance);
    event SponsorWithdrawn(address indexed sponsor, uint256 amount, uint256 newBalance);
    event GasSponsored(address indexed sponsor, address indexed user, uint256 gasCost, uint256 margin);
    event MarginUpdated(uint256 oldMargin, uint256 newMargin);
    event UserLimitSet(address indexed sponsor, address indexed user, uint256 limit);
    event RevenueWithdrawn(address indexed to, uint256 amount);

    // ═══════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════

    error MarginTooHigh(uint256 requested, uint256 max);
    error InsufficientSponsorDeposit(address sponsor, uint256 required, uint256 available);
    error UserLimitExceeded(address user, uint256 requested, uint256 remaining);
    error NoRevenueToWithdraw();

    // ═══════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════

    constructor(
        IEntryPoint entryPoint_,
        address owner_,
        uint256 initialMarginBps
    ) BasePaymaster(entryPoint_, owner_) {
        if (initialMarginBps > MAX_MARGIN_BPS) {
            revert MarginTooHigh(initialMarginBps, MAX_MARGIN_BPS);
        }
        marginBps = initialMarginBps;
    }

    // ═══════════════════════════════════════════════════════════
    // SPONSOR MANAGEMENT
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Deposit ETH into a sponsor's gas pool.
     *         Anyone can fund a sponsor pool.
     */
    function deposit(address sponsor) external payable {
        sponsorDeposits[sponsor] += msg.value;
        emit SponsorDeposited(sponsor, msg.value, sponsorDeposits[sponsor]);
    }

    /**
     * @notice Sponsor withdraws remaining funds from their pool.
     * @param amount Amount to withdraw
     */
    function withdrawSponsor(uint256 amount) external {
        require(sponsorDeposits[msg.sender] >= amount, "Insufficient deposit");
        sponsorDeposits[msg.sender] -= amount;
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");
        emit SponsorWithdrawn(msg.sender, amount, sponsorDeposits[msg.sender]);
    }

    /**
     * @notice Sponsor sets per-user gas limits.
     * @param user     The user address
     * @param maxGas   Maximum gas cost (in wei) this user can consume
     */
    function setUserLimit(address user, uint256 maxGas) external {
        userLimits[msg.sender][user] = maxGas;
        emit UserLimitSet(msg.sender, user, maxGas);
    }

    // ═══════════════════════════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════════════════════════

    function setMargin(uint256 newMarginBps) external onlyOwner {
        if (newMarginBps > MAX_MARGIN_BPS) {
            revert MarginTooHigh(newMarginBps, MAX_MARGIN_BPS);
        }
        uint256 old = marginBps;
        marginBps = newMarginBps;
        emit MarginUpdated(old, newMarginBps);
    }

    function withdrawRevenue(address to) external onlyOwner {
        uint256 amount = protocolRevenue;
        if (amount == 0) revert NoRevenueToWithdraw();
        protocolRevenue = 0;
        (bool success, ) = to.call{value: amount}("");
        require(success, "Transfer failed");
        emit RevenueWithdrawn(to, amount);
    }

    // ═══════════════════════════════════════════════════════════
    // ERC-4337 PAYMASTER VALIDATION
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Validate a UserOp for sponsorship.
     *
     * paymasterData layout:
     *   [0:20] sponsor address
     *
     * INV-8: Solvency check — sponsor must have sufficient deposit.
     */
    function _validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32,
        uint256 maxCost
    ) internal override returns (bytes memory context, uint256 validationData) {
        // Decode sponsor from paymasterData
        require(userOp.paymasterAndData.length >= 52, "Invalid paymasterData");
        address sponsor = address(bytes20(userOp.paymasterAndData[20:40]));

        // Calculate cost with margin
        uint256 costWithMargin = maxCost + (maxCost * marginBps / BPS_DENOMINATOR);

        // INV-8: Solvency check
        if (sponsorDeposits[sponsor] < costWithMargin) {
            revert InsufficientSponsorDeposit(sponsor, costWithMargin, sponsorDeposits[sponsor]);
        }

        // Check per-user limit if set
        address sender = userOp.sender;
        uint256 limit = userLimits[sponsor][sender];
        if (limit > 0) {
            uint256 newSpent = userSpent[sponsor][sender] + costWithMargin;
            if (newSpent > limit) {
                revert UserLimitExceeded(sender, costWithMargin, limit - userSpent[sponsor][sender]);
            }
        }

        // Reserve funds
        sponsorDeposits[sponsor] -= costWithMargin;

        // Pack context for postOp
        context = abi.encode(sponsor, sender, costWithMargin, maxCost);
        validationData = 0; // valid
    }

    /**
     * @notice Post-operation accounting.
     *         Refund unused gas to sponsor, collect margin as revenue.
     */
    function _postOp(
        PostOpMode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256
    ) internal override {
        (address sponsor, address user, uint256 reserved, uint256 maxCost) =
            abi.decode(context, (address, address, uint256, uint256));

        // Calculate actual cost with margin
        uint256 actualMargin = actualGasCost * marginBps / BPS_DENOMINATOR;
        uint256 actualTotal = actualGasCost + actualMargin;

        // Refund excess to sponsor
        if (reserved > actualTotal) {
            sponsorDeposits[sponsor] += (reserved - actualTotal);
        }

        // Record user spend
        userSpent[sponsor][user] += actualTotal;

        // Collect margin as protocol revenue
        protocolRevenue += actualMargin;

        emit GasSponsored(sponsor, user, actualGasCost, actualMargin);
    }

    // ═══════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════

    function getSponsorBalance(address sponsor) external view returns (uint256) {
        return sponsorDeposits[sponsor];
    }

    function getUserRemaining(address sponsor, address user) external view returns (uint256) {
        uint256 limit = userLimits[sponsor][user];
        if (limit == 0) return type(uint256).max; // no limit
        uint256 spent = userSpent[sponsor][user];
        return spent >= limit ? 0 : limit - spent;
    }

    receive() external payable {
        sponsorDeposits[msg.sender] += msg.value;
    }
}
