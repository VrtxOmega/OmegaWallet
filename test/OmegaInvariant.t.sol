// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/OmegaAccount.sol";
import "../src/OmegaAccountFactory.sol";
import "../src/modules/SessionKeyModule.sol";
import "../src/modules/SpendLimitHook.sol";
import "../src/modules/BatchExecutorModule.sol";
import "../src/modules/SocialRecoveryModule.sol";
import "../src/interfaces/IOmegaModule.sol";
import "@account-abstraction/interfaces/IEntryPoint.sol";
import "@account-abstraction/core/EntryPoint.sol";

/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     OMEGA WALLET — STATEFUL INVARIANT FUZZING HARNESS        ║
 * ║   Foundry fires millions of random calls trying to break     ║
 * ║   every NAEF invariant. If it can't break it, it's solid.    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * This test contract defines:
 *   1. A Handler contract that exposes randomized state transitions
 *   2. Invariant assertions that must hold after ANY sequence of calls
 *
 * Foundry's invariant tester will call Handler functions in random
 * order with random parameters. After each call sequence, it checks
 * every invariant_* function. If any assertion fails, the exact
 * call sequence that broke it is reported.
 */

/// @notice Handler: exposes all state-mutating functions to the fuzzer
contract OmegaHandler is Test {
    EntryPoint public entryPoint;
    OmegaAccountFactory public factory;
    OmegaAccount public account;
    SessionKeyModule public sessionModule;
    SpendLimitHook public spendHook;
    SocialRecoveryModule public recoveryModule;

    address public owner;
    address public sessionKey1;
    address public sessionKey2;
    address public guardian1;
    address public guardian2;
    address public guardian3;

    // Ghost variables for tracking invariants
    uint256 public totalSessionsCreated;
    uint256 public totalSessionsRevoked;
    uint256 public totalRecoveryAttempts;
    uint256 public totalSpendRecorded;
    mapping(address => uint256) public ghostSessionSpend;
    mapping(address => uint256) public ghostSessionLimit;

    constructor(
        OmegaAccount _account,
        SessionKeyModule _sessionModule,
        SpendLimitHook _spendHook,
        SocialRecoveryModule _recoveryModule,
        address _owner,
        EntryPoint _entryPoint
    ) {
        account = _account;
        sessionModule = _sessionModule;
        spendHook = _spendHook;
        recoveryModule = _recoveryModule;
        owner = _owner;
        entryPoint = _entryPoint;

        sessionKey1 = makeAddr("sk1");
        sessionKey2 = makeAddr("sk2");
        guardian1 = makeAddr("g1");
        guardian2 = makeAddr("g2");
        guardian3 = makeAddr("g3");
    }

    // ─── SESSION KEY MUTATIONS ───────────────────────────────

    function createSession(
        uint48 duration,
        uint256 spendLimit
    ) external {
        duration = uint48(bound(duration, 1 hours, 365 days));
        spendLimit = bound(spendLimit, 0.001 ether, 1000 ether);

        address key = totalSessionsCreated % 2 == 0 ? sessionKey1 : sessionKey2;

        // Skip if already active
        (bool active,,,,,) = sessionModule.getSession(address(account), key);
        if (active) return;

        vm.prank(address(account));
        sessionModule.createSession(
            key,
            uint48(block.timestamp),
            uint48(block.timestamp) + duration,
            spendLimit,
            new address[](0)
        );

        ghostSessionLimit[key] = spendLimit;
        ghostSessionSpend[key] = 0;
        totalSessionsCreated++;
    }

    function recordSessionSpend(uint256 amount) external {
        amount = bound(amount, 0.001 ether, 100 ether);

        address key = totalSessionsCreated % 2 == 0 ? sessionKey1 : sessionKey2;
        (bool active,,, uint256 limit, uint256 spent,) =
            sessionModule.getSession(address(account), key);

        if (!active) return;
        if (spent + amount > limit) return; // would revert, skip

        vm.prank(address(account));
        sessionModule.recordSpend(key, address(0x1234), amount);

        ghostSessionSpend[key] += amount;
        totalSpendRecorded += amount;
    }

    function revokeSession() external {
        address key = totalSessionsRevoked % 2 == 0 ? sessionKey1 : sessionKey2;
        (bool active,,,,,) = sessionModule.getSession(address(account), key);
        if (!active) return;

        vm.prank(address(account));
        sessionModule.revokeSession(key);
        totalSessionsRevoked++;
    }

    // ─── SPEND LIMIT MUTATIONS ───────────────────────────────

    function configureSpendLimit(uint256 limit, uint256 period) external {
        limit = bound(limit, 0.01 ether, 1000 ether);
        period = bound(period, 1 hours, 30 days);

        vm.prank(address(account));
        spendHook.configure(limit, period);
    }

    function triggerSpendHook(uint256 value) external {
        value = bound(value, 0.001 ether, 50 ether);

        (bool active, uint256 limitPerPeriod, uint256 spentThisPeriod,,) =
            spendHook.getSpendStatus(address(account));

        if (!active) return;
        if (spentThisPeriod + value > limitPerPeriod) return;

        vm.prank(address(account));
        spendHook.preHook(address(0x1234), value, "");
    }

    // ─── RECOVERY MUTATIONS ─────────────────────────────────

    function setupGuardians() external {
        address[] memory guardians = new address[](3);
        guardians[0] = guardian1;
        guardians[1] = guardian2;
        guardians[2] = guardian3;

        vm.prank(address(account));
        recoveryModule.setupGuardians(guardians, 2);
    }

    function initiateRecovery(address newOwner) external {
        if (newOwner == address(0)) return;
        if (!recoveryModule.isGuardian(address(account), guardian1)) return;

        (bool active,,,,) = recoveryModule.getRecoveryStatus(address(account));
        if (active) return;

        vm.prank(guardian1);
        recoveryModule.initiateRecovery(address(account), newOwner);
        totalRecoveryAttempts++;
    }

    // ─── TIME MANIPULATION ──────────────────────────────────

    function warpTime(uint256 delta) external {
        delta = bound(delta, 1, 7 days);
        vm.warp(block.timestamp + delta);
    }

    // ─── DIRECT ATTACK ATTEMPTS ─────────────────────────────

    function attackDirectExecute(address attacker) external {
        vm.assume(attacker != address(entryPoint));
        vm.assume(attacker != address(account));

        vm.prank(attacker);
        try account.execute(address(0x1234), 1 ether, "") {
            // If this succeeds, INV-1 is broken
            revert("INV-1 VIOLATED: Direct execute succeeded");
        } catch {
            // Expected: should always revert
        }
    }

    function attackTransferOwnership(address attacker) external {
        vm.assume(attacker != owner);
        vm.assume(attacker != address(account));

        vm.prank(attacker);
        try account.transferOwnership(attacker) {
            revert("INV-7 VIOLATED: Unauthorized ownership transfer");
        } catch {
            // Expected
        }
    }
}

/// @notice Invariant test suite
contract OmegaInvariantTest is Test {
    EntryPoint public entryPoint;
    OmegaAccountFactory public factory;
    OmegaAccount public account;
    SessionKeyModule public sessionModule;
    SpendLimitHook public spendHook;
    SocialRecoveryModule public recoveryModule;
    OmegaHandler public handler;

    address public owner;

    function setUp() public {
        entryPoint = new EntryPoint();
        (owner,) = makeAddrAndKey("owner");

        factory = new OmegaAccountFactory(IEntryPoint(address(entryPoint)));
        account = factory.createAccount(owner, 0);

        sessionModule = new SessionKeyModule();
        spendHook = new SpendLimitHook();
        recoveryModule = new SocialRecoveryModule();

        handler = new OmegaHandler(
            account, sessionModule, spendHook, recoveryModule, owner, entryPoint
        );

        vm.deal(address(account), 1000 ether);

        // Tell Foundry to only call handler functions
        targetContract(address(handler));
    }

    // ═══════════════════════════════════════════════════════════
    // INVARIANT ASSERTIONS — Must hold after ANY call sequence
    // ═══════════════════════════════════════════════════════════

    /// @notice INV-7: Owner is NEVER address(0)
    function invariant_ownerNeverZero() public view {
        assertTrue(account.owner() != address(0), "INV-7 VIOLATED: owner is zero");
    }

    /// @notice INV-7: Exactly one owner exists
    function invariant_ownerIsOriginal() public view {
        // Owner can only change via recovery or self-call
        // Since our handler doesn't execute recovery, owner should remain
        assertEq(account.owner(), owner, "INV-7: owner changed unexpectedly");
    }

    /// @notice INV-2: Session key spend never exceeds limit
    function invariant_sessionSpendNeverExceedsLimit() public view {
        address sk1 = handler.sessionKey1();
        address sk2 = handler.sessionKey2();

        (bool active1,,, uint256 limit1, uint256 spent1,) =
            sessionModule.getSession(address(account), sk1);
        if (active1) {
            assertLe(spent1, limit1, "INV-2 VIOLATED: sk1 spend > limit");
        }

        (bool active2,,, uint256 limit2, uint256 spent2,) =
            sessionModule.getSession(address(account), sk2);
        if (active2) {
            assertLe(spent2, limit2, "INV-2 VIOLATED: sk2 spend > limit");
        }
    }

    /// @notice INV-2: Ghost variable tracking matches on-chain state
    function invariant_spendTrackingConsistent() public view {
        address sk1 = handler.sessionKey1();
        address sk2 = handler.sessionKey2();

        (bool active1,,,,uint256 spent1,) =
            sessionModule.getSession(address(account), sk1);
        if (active1) {
            assertEq(
                spent1,
                handler.ghostSessionSpend(sk1),
                "Ghost spend tracking mismatch for sk1"
            );
        }

        (bool active2,,,,uint256 spent2,) =
            sessionModule.getSession(address(account), sk2);
        if (active2) {
            assertEq(
                spent2,
                handler.ghostSessionSpend(sk2),
                "Ghost spend tracking mismatch for sk2"
            );
        }
    }

    /// @notice INV-2: Account-wide spend limit never exceeded within a period
    function invariant_accountSpendNeverExceedsPeriod() public view {
        (bool active, uint256 limit, uint256 spent,,) =
            spendHook.getSpendStatus(address(account));
        if (active) {
            assertLe(spent, limit, "INV-2 VIOLATED: account spend > period limit");
        }
    }

    /// @notice INV-5: If recovery is active, it has valid state
    function invariant_recoveryStateValid() public view {
        (bool active, address newOwner, uint256 confirmations, uint256 threshold,) =
            recoveryModule.getRecoveryStatus(address(account));
        if (active) {
            assertTrue(newOwner != address(0), "INV-5: active recovery with zero newOwner");
            assertGt(confirmations, 0, "INV-5: active recovery with zero confirmations");
        }
    }
}
