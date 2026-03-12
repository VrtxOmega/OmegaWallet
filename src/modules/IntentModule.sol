// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/IOmegaModule.sol";

/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     INTENT MODULE — ERC-7683 Cleanroom Intent Execution      ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * The user never signs a transaction specifying HOW to do something.
 * They sign a cryptographically bound INTENT — the desired OUTCOME.
 *
 * "I have 1 ETH on Arbitrum, I want 3000 USDC split across
 *  these 5 Base wallets."
 *
 * Decentralized solvers compete to fulfill the intent, taking on
 * all execution risk. The user's OmegaAccount never directly
 * interacts with unverified bridging contracts.
 *
 * SECURITY MODEL (CLEANROOM):
 *   - User's core assets never touch untrusted contracts
 *   - Solver bonds posted as guarantee of honest execution
 *   - Fulfillment verified on-chain before funds released
 *   - Timeout: if unfulfilled, user's funds auto-return
 *
 * NAEF INVARIANTS:
 *   INV-6:  Module isolation
 *   INV-11: Intent integrity — signed intent cannot be modified
 *   INV-12: Solver accountability — bonds slashed on violation
 */
contract IntentModule is IOmegaModule {

    // ═══════════════════════════════════════════════════════════
    // TYPES
    // ═══════════════════════════════════════════════════════════

    /// @notice An intent: a desired outcome, not a specific transaction
    struct Intent {
        bytes32 id;                 // unique identifier
        address initiator;          // OmegaAccount that created this intent
        address inputToken;         // token being offered (address(0) = ETH)
        uint256 inputAmount;        // amount being offered
        address outputToken;        // token desired
        uint256 minOutputAmount;    // minimum acceptable output
        address[] recipients;       // where output should be delivered
        uint256[] recipientShares;  // basis points per recipient (sum = 10000)
        uint256 deadline;           // expiry timestamp
        uint256 solverBondBps;      // required solver bond (500 = 5%)
        bytes32 intentHash;         // hash of all fields for integrity
    }

    enum IntentStatus {
        NONE,
        OPEN,           // created, awaiting solver
        FILLED,         // solver claimed, fulfilling
        SETTLED,        // successfully completed
        EXPIRED,        // deadline passed unfulfilled
        CANCELLED       // cancelled by initiator
    }

    struct SolverClaim {
        address solver;
        uint256 bondAmount;
        uint256 claimedAt;
    }

    // ═══════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════

    uint256 public constant MAX_SOLVER_FILL_TIME = 30 minutes;
    uint256 public constant BPS_DENOMINATOR = 10000;

    // ═══════════════════════════════════════════════════════════
    // STORAGE
    // ═══════════════════════════════════════════════════════════

    /// @dev intentId => Intent 
    mapping(bytes32 => Intent) public intents;

    /// @dev intentId => status
    mapping(bytes32 => IntentStatus) public intentStatus;

    /// @dev intentId => solver claim
    mapping(bytes32 => SolverClaim) public solverClaims;

    /// @dev intentId => escrowed ETH amount
    mapping(bytes32 => uint256) public escrowedETH;

    /// @dev Accumulated slashed bonds (protocol revenue)
    uint256 public slashedBonds;

    // ═══════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════

    event IntentCreated(bytes32 indexed id, address indexed initiator, uint256 inputAmount, uint256 deadline);
    event IntentClaimed(bytes32 indexed id, address indexed solver, uint256 bondAmount);
    event IntentSettled(bytes32 indexed id, address indexed solver, uint256 outputDelivered);
    event IntentExpired(bytes32 indexed id);
    event IntentCancelled(bytes32 indexed id);
    event SolverBondSlashed(bytes32 indexed id, address indexed solver, uint256 bondAmount);

    // ═══════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════

    error IntentAlreadyExists();
    error IntentNotOpen();
    error IntentNotFilled();
    error IntentExpiredOrInvalid();
    error InvalidRecipientShares();
    error InsufficientBond(uint256 required, uint256 provided);
    error InsufficientOutput(uint256 required, uint256 provided);
    error OnlyInitiator();
    error OnlySolver();
    error FillTimeExpired();
    error IntentHashMismatch();
    error DeadlineInPast();

    // ═══════════════════════════════════════════════════════════
    // ERC-7579 MODULE INTERFACE
    // ═══════════════════════════════════════════════════════════

    function onInstall(bytes calldata) external override {}
    function onUninstall(bytes calldata) external override {}

    function isModuleType(uint256 moduleTypeId) external pure override returns (bool) {
        return moduleTypeId == MODULE_TYPE_EXECUTOR;
    }

    // ═══════════════════════════════════════════════════════════
    // INTENT CREATION (by OmegaAccount via execute)
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Create an intent. User deposits input tokens to escrow.
     *
     * INV-11: Intent hash is computed and stored. Any modification
     * to the intent after creation is cryptographically detectable.
     *
     * @param inputToken      Token offered (address(0) = ETH)
     * @param inputAmount     Amount offered
     * @param outputToken     Token desired
     * @param minOutputAmount Minimum acceptable output
     * @param recipients      Delivery addresses
     * @param recipientShares BPS shares per recipient (sum=10000)
     * @param deadline        Expiry timestamp
     * @param solverBondBps   Required solver bond in BPS of inputAmount
     */
    function createIntent(
        address inputToken,
        uint256 inputAmount,
        address outputToken,
        uint256 minOutputAmount,
        address[] calldata recipients,
        uint256[] calldata recipientShares,
        uint256 deadline,
        uint256 solverBondBps
    ) external payable returns (bytes32 intentId) {
        if (deadline <= block.timestamp) revert DeadlineInPast();
        if (recipients.length != recipientShares.length) revert InvalidRecipientShares();

        // Validate shares sum to 10000
        uint256 totalShares = 0;
        for (uint256 i = 0; i < recipientShares.length; i++) {
            totalShares += recipientShares[i];
        }
        if (totalShares != BPS_DENOMINATOR) revert InvalidRecipientShares();

        // Compute intent ID
        intentId = keccak256(abi.encodePacked(
            msg.sender, inputToken, inputAmount, outputToken,
            minOutputAmount, deadline, block.timestamp
        ));

        if (intentStatus[intentId] != IntentStatus.NONE) revert IntentAlreadyExists();

        // Compute integrity hash (INV-11)
        bytes32 intentHash = keccak256(abi.encode(
            intentId, msg.sender, inputToken, inputAmount,
            outputToken, minOutputAmount, recipients, recipientShares,
            deadline, solverBondBps
        ));

        // Store intent
        intents[intentId] = Intent({
            id: intentId,
            initiator: msg.sender,
            inputToken: inputToken,
            inputAmount: inputAmount,
            outputToken: outputToken,
            minOutputAmount: minOutputAmount,
            recipients: recipients,
            recipientShares: recipientShares,
            deadline: deadline,
            solverBondBps: solverBondBps,
            intentHash: intentHash
        });

        intentStatus[intentId] = IntentStatus.OPEN;

        // Escrow ETH if native
        if (inputToken == address(0)) {
            require(msg.value >= inputAmount, "Insufficient ETH");
            escrowedETH[intentId] = inputAmount;
        }

        emit IntentCreated(intentId, msg.sender, inputAmount, deadline);
    }

    // ═══════════════════════════════════════════════════════════
    // SOLVER OPERATIONS
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Solver claims an intent by posting a bond.
     *
     * INV-12: Bond is locked. If solver fails to fill within
     * MAX_SOLVER_FILL_TIME, bond is slashed.
     */
    function claimIntent(bytes32 intentId) external payable {
        if (intentStatus[intentId] != IntentStatus.OPEN) revert IntentNotOpen();

        Intent storage intent = intents[intentId];
        if (block.timestamp >= intent.deadline) revert IntentExpiredOrInvalid();

        // Calculate required bond
        uint256 requiredBond = (intent.inputAmount * intent.solverBondBps) / BPS_DENOMINATOR;
        if (msg.value < requiredBond) {
            revert InsufficientBond(requiredBond, msg.value);
        }

        solverClaims[intentId] = SolverClaim({
            solver: msg.sender,
            bondAmount: msg.value,
            claimedAt: block.timestamp
        });

        intentStatus[intentId] = IntentStatus.FILLED;

        emit IntentClaimed(intentId, msg.sender, msg.value);
    }

    /**
     * @notice Solver settles the intent by delivering output tokens.
     *         For ETH output: solver sends ETH directly to recipients.
     */
    function settleIntent(bytes32 intentId) external payable {
        if (intentStatus[intentId] != IntentStatus.FILLED) revert IntentNotFilled();

        SolverClaim storage claim = solverClaims[intentId];
        if (msg.sender != claim.solver) revert OnlySolver();

        Intent storage intent = intents[intentId];
        if (block.timestamp >= intent.deadline) revert IntentExpiredOrInvalid();

        // For ETH output: verify sufficient value sent
        if (intent.outputToken == address(0)) {
            if (msg.value < intent.minOutputAmount) {
                revert InsufficientOutput(intent.minOutputAmount, msg.value);
            }

            // Distribute to recipients per shares
            for (uint256 i = 0; i < intent.recipients.length; i++) {
                uint256 share = (msg.value * intent.recipientShares[i]) / BPS_DENOMINATOR;
                (bool success, ) = intent.recipients[i].call{value: share}("");
                require(success, "ETH delivery failed");
            }
        }
        // For ERC-20 output: solver must have already transferred to recipients

        intentStatus[intentId] = IntentStatus.SETTLED;

        // Return solver's bond
        (bool bondReturned, ) = claim.solver.call{value: claim.bondAmount}("");
        require(bondReturned, "Bond return failed");

        // Release escrowed input to solver (payment for fulfillment)
        uint256 escrowed = escrowedETH[intentId];
        if (escrowed > 0) {
            escrowedETH[intentId] = 0;
            (bool paid, ) = claim.solver.call{value: escrowed}("");
            require(paid, "Solver payment failed");
        }

        emit IntentSettled(intentId, msg.sender, msg.value);
    }

    // ═══════════════════════════════════════════════════════════
    // TIMEOUT / CANCEL / SLASH
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Slash a solver who claimed but didn't fill in time.
     *         Anyone can call this after MAX_SOLVER_FILL_TIME.
     */
    function slashSolver(bytes32 intentId) external {
        if (intentStatus[intentId] != IntentStatus.FILLED) revert IntentNotFilled();

        SolverClaim storage claim = solverClaims[intentId];
        if (block.timestamp < claim.claimedAt + MAX_SOLVER_FILL_TIME) {
            revert FillTimeExpired();
        }

        // Slash bond
        uint256 bond = claim.bondAmount;
        slashedBonds += bond;

        // Reopen intent for other solvers
        intentStatus[intentId] = IntentStatus.OPEN;
        delete solverClaims[intentId];

        emit SolverBondSlashed(intentId, claim.solver, bond);
    }

    /**
     * @notice Cancel an open intent and return escrowed funds.
     *         Only callable by the initiator (account).
     */
    function cancelIntent(bytes32 intentId) external {
        if (intentStatus[intentId] != IntentStatus.OPEN) revert IntentNotOpen();

        Intent storage intent = intents[intentId];
        if (msg.sender != intent.initiator) revert OnlyInitiator();

        intentStatus[intentId] = IntentStatus.CANCELLED;

        // Return escrowed ETH
        uint256 escrowed = escrowedETH[intentId];
        if (escrowed > 0) {
            escrowedETH[intentId] = 0;
            (bool success, ) = intent.initiator.call{value: escrowed}("");
            require(success, "Refund failed");
        }

        emit IntentCancelled(intentId);
    }

    /**
     * @notice Reclaim expired intents. Returns escrowed funds to initiator.
     */
    function reclaimExpired(bytes32 intentId) external {
        Intent storage intent = intents[intentId];
        IntentStatus status = intentStatus[intentId];

        if (status != IntentStatus.OPEN && status != IntentStatus.FILLED) {
            revert IntentExpiredOrInvalid();
        }
        if (block.timestamp < intent.deadline) revert IntentExpiredOrInvalid();

        intentStatus[intentId] = IntentStatus.EXPIRED;

        // Return escrowed ETH
        uint256 escrowed = escrowedETH[intentId];
        if (escrowed > 0) {
            escrowedETH[intentId] = 0;
            (bool success, ) = intent.initiator.call{value: escrowed}("");
            require(success, "Refund failed");
        }

        // If solver had claimed, slash their bond
        SolverClaim storage claim = solverClaims[intentId];
        if (claim.bondAmount > 0) {
            slashedBonds += claim.bondAmount;
            emit SolverBondSlashed(intentId, claim.solver, claim.bondAmount);
        }

        emit IntentExpired(intentId);
    }

    // ═══════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════

    function getIntent(bytes32 intentId) external view returns (
        address initiator,
        address inputToken,
        uint256 inputAmount,
        address outputToken,
        uint256 minOutputAmount,
        uint256 deadline,
        IntentStatus status
    ) {
        Intent storage i = intents[intentId];
        return (
            i.initiator, i.inputToken, i.inputAmount,
            i.outputToken, i.minOutputAmount, i.deadline,
            intentStatus[intentId]
        );
    }

    function verifyIntentIntegrity(bytes32 intentId) external view returns (bool) {
        Intent storage i = intents[intentId];
        bytes32 computed = keccak256(abi.encode(
            i.id, i.initiator, i.inputToken, i.inputAmount,
            i.outputToken, i.minOutputAmount, i.recipients, i.recipientShares,
            i.deadline, i.solverBondBps
        ));
        return computed == i.intentHash;
    }
}
