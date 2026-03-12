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
 * ║         OMEGA WALLET — CORE UNIT TESTS                       ║
 * ║     Verify basic functionality before invariant testing       ║
 * ╚═══════════════════════════════════════════════════════════════╝
 */
contract OmegaAccountTest is Test {
    EntryPoint public entryPoint;
    OmegaAccountFactory public factory;
    OmegaAccount public account;
    SessionKeyModule public sessionModule;
    SpendLimitHook public spendHook;
    BatchExecutorModule public batchModule;
    SocialRecoveryModule public recoveryModule;

    address public owner;
    uint256 public ownerKey;
    address public sessionSigner;
    uint256 public sessionSignerKey;
    address public guardian1;
    address public guardian2;
    address public guardian3;

    function setUp() public {
        // Deploy EntryPoint
        entryPoint = new EntryPoint();

        // Generate keys
        (owner, ownerKey) = makeAddrAndKey("owner");
        (sessionSigner, sessionSignerKey) = makeAddrAndKey("sessionSigner");
        guardian1 = makeAddr("guardian1");
        guardian2 = makeAddr("guardian2");
        guardian3 = makeAddr("guardian3");

        // Deploy factory + account
        factory = new OmegaAccountFactory(IEntryPoint(address(entryPoint)));
        account = factory.createAccount(owner, 0);

        // Deploy modules
        sessionModule = new SessionKeyModule();
        spendHook = new SpendLimitHook();
        batchModule = new BatchExecutorModule();
        recoveryModule = new SocialRecoveryModule();

        // Fund account
        vm.deal(address(account), 100 ether);
    }

    // ═══════════════════════════════════════════════════════════
    // INV-1: ENTRYPOINT SOVEREIGNTY
    // ═══════════════════════════════════════════════════════════

    function test_INV1_directExecuteReverts() public {
        // No external address can call execute directly
        vm.prank(owner);
        vm.expectRevert(OmegaAccount.OnlyEntryPointOrSelf.selector);
        account.execute(address(0x1234), 1 ether, "");
    }

    function test_INV1_directExecuteBatchReverts() public {
        BaseAccount.Call[] memory calls = new BaseAccount.Call[](1);
        calls[0] = BaseAccount.Call(address(0x1234), 1 ether, "");

        vm.prank(owner);
        vm.expectRevert(OmegaAccount.OnlyEntryPointOrSelf.selector);
        account.executeBatch(calls);
    }

    function test_INV1_randomAddressCannotExecute() public {
        address rando = makeAddr("rando");
        vm.prank(rando);
        vm.expectRevert(OmegaAccount.OnlyEntryPointOrSelf.selector);
        account.execute(address(0x1234), 1 ether, "");
    }

    function test_INV1_fuzz_noAddressCanExecute(address attacker) public {
        vm.assume(attacker != address(entryPoint));
        vm.assume(attacker != address(account));
        vm.prank(attacker);
        vm.expectRevert(OmegaAccount.OnlyEntryPointOrSelf.selector);
        account.execute(address(0x1234), 1 ether, "");
    }

    // ═══════════════════════════════════════════════════════════
    // INV-7: OWNER UNIQUENESS
    // ═══════════════════════════════════════════════════════════

    function test_INV7_ownerIsSet() public view {
        assertEq(account.owner(), owner);
        assertTrue(account.owner() != address(0));
    }

    function test_INV7_cannotTransferToZero() public {
        vm.prank(address(account));
        vm.expectRevert(OmegaAccount.InvalidOwner.selector);
        account.transferOwnership(address(0));
    }

    function test_INV7_onlyOwnerCanTransfer() public {
        address rando = makeAddr("rando");
        vm.prank(rando);
        vm.expectRevert(OmegaAccount.OnlyOwner.selector);
        account.transferOwnership(rando);
    }

    function test_INV7_ownerTransferWorks() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(address(account));
        account.transferOwnership(newOwner);
        assertEq(account.owner(), newOwner);
    }

    // ═══════════════════════════════════════════════════════════
    // MODULE INSTALLATION — INV-6
    // ═══════════════════════════════════════════════════════════

    function test_INV6_installModule() public {
        vm.prank(owner);
        account.installModule(MODULE_TYPE_VALIDATOR, address(sessionModule), "");
        assertTrue(account.isModuleInstalled(MODULE_TYPE_VALIDATOR, address(sessionModule)));
    }

    function test_INV6_cannotInstallTwice() public {
        vm.prank(owner);
        account.installModule(MODULE_TYPE_VALIDATOR, address(sessionModule), "");

        vm.prank(owner);
        vm.expectRevert(OmegaAccount.ModuleAlreadyInstalled.selector);
        account.installModule(MODULE_TYPE_VALIDATOR, address(sessionModule), "");
    }

    function test_INV6_uninstallModule() public {
        vm.prank(owner);
        account.installModule(MODULE_TYPE_VALIDATOR, address(sessionModule), "");

        vm.prank(owner);
        account.uninstallModule(MODULE_TYPE_VALIDATOR, address(sessionModule), "");
        assertFalse(account.isModuleInstalled(MODULE_TYPE_VALIDATOR, address(sessionModule)));
    }

    function test_INV6_randoCannotInstall() public {
        address rando = makeAddr("rando");
        vm.prank(rando);
        vm.expectRevert(OmegaAccount.OnlyOwner.selector);
        account.installModule(MODULE_TYPE_VALIDATOR, address(sessionModule), "");
    }

    function test_INV6_wrongModuleTypeReverts() public {
        // SessionKeyModule is VALIDATOR type, installing as HOOK should fail
        vm.prank(owner);
        vm.expectRevert(OmegaAccount.ModuleTypeMismatch.selector);
        account.installModule(MODULE_TYPE_HOOK, address(sessionModule), "");
    }

    // ═══════════════════════════════════════════════════════════
    // SESSION KEY MODULE — INV-2, INV-3, INV-4
    // ═══════════════════════════════════════════════════════════

    function test_INV3_sessionKeyTimeRange() public {
        uint48 validAfter = uint48(block.timestamp + 1 hours);
        uint48 validUntil = uint48(block.timestamp + 24 hours);

        vm.prank(address(account));
        sessionModule.createSession(
            sessionSigner,
            validAfter,
            validUntil,
            10 ether,
            new address[](0)
        );

        (bool active, uint48 vAfter, uint48 vUntil, uint256 limit, uint256 spent,) =
            sessionModule.getSession(address(account), sessionSigner);

        assertTrue(active);
        assertEq(vAfter, validAfter);
        assertEq(vUntil, validUntil);
        assertEq(limit, 10 ether);
        assertEq(spent, 0);
    }

    function test_INV3_invalidTimeRangeReverts() public {
        // validAfter >= validUntil should revert
        vm.prank(address(account));
        vm.expectRevert(SessionKeyModule.InvalidTimeRange.selector);
        sessionModule.createSession(
            sessionSigner,
            uint48(block.timestamp + 24 hours),  // after
            uint48(block.timestamp + 1 hours),   // until (before after)
            10 ether,
            new address[](0)
        );
    }

    function test_INV2_spendCeilingEnforced() public {
        vm.prank(address(account));
        sessionModule.createSession(
            sessionSigner,
            uint48(block.timestamp),
            uint48(block.timestamp + 24 hours),
            5 ether, // 5 ETH limit
            new address[](0)
        );

        // Record 3 ETH spend — should pass
        vm.prank(address(account));
        sessionModule.recordSpend(sessionSigner, address(0x1234), 3 ether);

        // Record 3 more ETH — should revert (3+3 > 5)
        vm.prank(address(account));
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionKeyModule.SpendLimitExceeded.selector,
                3 ether,
                2 ether // remaining
            )
        );
        sessionModule.recordSpend(sessionSigner, address(0x1234), 3 ether);
    }

    function test_INV4_contractScopeEnforced() public {
        address allowedContract = makeAddr("allowedContract");
        address blockedContract = makeAddr("blockedContract");

        address[] memory allowed = new address[](1);
        allowed[0] = allowedContract;

        vm.prank(address(account));
        sessionModule.createSession(
            sessionSigner,
            uint48(block.timestamp),
            uint48(block.timestamp + 24 hours),
            10 ether,
            allowed
        );

        // Allowed contract — should pass
        vm.prank(address(account));
        sessionModule.recordSpend(sessionSigner, allowedContract, 1 ether);

        // Blocked contract — should revert
        vm.prank(address(account));
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionKeyModule.ContractNotAllowed.selector,
                blockedContract
            )
        );
        sessionModule.recordSpend(sessionSigner, blockedContract, 1 ether);
    }

    // ═══════════════════════════════════════════════════════════
    // SOCIAL RECOVERY — INV-5
    // ═══════════════════════════════════════════════════════════

    function _setupGuardians() internal {
        address[] memory guardians = new address[](3);
        guardians[0] = guardian1;
        guardians[1] = guardian2;
        guardians[2] = guardian3;

        vm.prank(address(account));
        recoveryModule.setupGuardians(guardians, 2); // 2-of-3
    }

    function test_INV5_recoveryRequiresThreshold() public {
        _setupGuardians();
        address newOwner = makeAddr("newOwner");

        // Guardian 1 initiates
        vm.prank(guardian1);
        recoveryModule.initiateRecovery(address(account), newOwner);

        // Try to execute with only 1 confirmation (threshold is 2)
        vm.warp(block.timestamp + 49 hours); // past timelock
        vm.expectRevert(
            abi.encodeWithSelector(
                SocialRecoveryModule.ThresholdNotMet.selector,
                1, 2
            )
        );
        recoveryModule.executeRecovery(address(account));
    }

    function test_INV5_recoveryRequiresTimelock() public {
        _setupGuardians();
        address newOwner = makeAddr("newOwner");

        // Guardian 1 initiates, Guardian 2 confirms
        vm.prank(guardian1);
        recoveryModule.initiateRecovery(address(account), newOwner);
        vm.prank(guardian2);
        recoveryModule.confirmRecovery(address(account));

        // Try to execute immediately (before 48h)
        vm.expectRevert();
        recoveryModule.executeRecovery(address(account));
    }

    function test_INV5_recoveryWorksAfterTimelockAndThreshold() public {
        _setupGuardians();
        address newOwner = makeAddr("newOwner");

        vm.prank(guardian1);
        recoveryModule.initiateRecovery(address(account), newOwner);
        vm.prank(guardian2);
        recoveryModule.confirmRecovery(address(account));

        // Warp past timelock
        vm.warp(block.timestamp + 49 hours);

        // Should succeed now
        bytes memory callData = recoveryModule.executeRecovery(address(account));
        assertTrue(callData.length > 0);
    }

    function test_INV5_nonGuardianCannotInitiate() public {
        _setupGuardians();
        address rando = makeAddr("rando");

        vm.prank(rando);
        vm.expectRevert(SocialRecoveryModule.NotGuardian.selector);
        recoveryModule.initiateRecovery(address(account), rando);
    }

    // ═══════════════════════════════════════════════════════════
    // SPEND LIMIT HOOK — INV-2 (account-wide)
    // ═══════════════════════════════════════════════════════════

    function test_INV2_accountWideSpendLimit() public {
        // Configure 10 ETH per day limit
        vm.prank(address(account));
        spendHook.configure(10 ether, 1 days);

        // 8 ETH — should pass
        vm.prank(address(account));
        spendHook.preHook(address(0x1234), 8 ether, "");

        // 3 more ETH — should revert (8+3 > 10)
        vm.prank(address(account));
        vm.expectRevert(
            abi.encodeWithSelector(
                SpendLimitHook.SpendLimitExceeded.selector,
                3 ether,
                2 ether
            )
        );
        spendHook.preHook(address(0x1234), 3 ether, "");
    }

    function test_INV2_periodAutoResets() public {
        vm.prank(address(account));
        spendHook.configure(10 ether, 1 days);

        // Use full budget
        vm.prank(address(account));
        spendHook.preHook(address(0x1234), 10 ether, "");

        // Next day — should reset
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(address(account));
        spendHook.preHook(address(0x1234), 10 ether, ""); // should pass
    }

    // ═══════════════════════════════════════════════════════════
    // BATCH EXECUTOR — INV-10
    // ═══════════════════════════════════════════════════════════

    function test_INV10_batchDistributesETH() public {
        address r1 = makeAddr("r1");
        address r2 = makeAddr("r2");
        address r3 = makeAddr("r3");

        address[] memory recipients = new address[](3);
        recipients[0] = r1;
        recipients[1] = r2;
        recipients[2] = r3;

        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 1 ether;
        amounts[1] = 2 ether;
        amounts[2] = 3 ether;

        batchModule.distributETH{value: 6 ether}(recipients, amounts);

        assertEq(r1.balance, 1 ether);
        assertEq(r2.balance, 2 ether);
        assertEq(r3.balance, 3 ether);
    }

    function test_INV10_batchArrayMismatchReverts() public {
        address[] memory recipients = new address[](2);
        recipients[0] = makeAddr("r1");
        recipients[1] = makeAddr("r2");

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1 ether;

        vm.expectRevert(BatchExecutorModule.ArrayLengthMismatch.selector);
        batchModule.distributETH{value: 1 ether}(recipients, amounts);
    }

    function test_INV10_splitETHEqual() public {
        address r1 = makeAddr("r1");
        address r2 = makeAddr("r2");

        address[] memory recipients = new address[](2);
        recipients[0] = r1;
        recipients[1] = r2;

        batchModule.splitETH{value: 10 ether}(recipients);

        assertEq(r1.balance, 5 ether);
        assertEq(r2.balance, 5 ether);
    }

    // ═══════════════════════════════════════════════════════════
    // FACTORY — DETERMINISTIC DEPLOYMENT
    // ═══════════════════════════════════════════════════════════

    function test_factoryDeterministicAddress() public {
        address predicted = factory.getAddress(owner, 42);
        OmegaAccount deployed = factory.createAccount(owner, 42);
        assertEq(address(deployed), predicted);
    }

    function test_factoryIdempotent() public {
        OmegaAccount first = factory.createAccount(owner, 99);
        OmegaAccount second = factory.createAccount(owner, 99);
        assertEq(address(first), address(second));
    }

    function test_factoryDifferentSaltsDifferentAddresses() public {
        OmegaAccount a = factory.createAccount(owner, 0);
        OmegaAccount b = factory.createAccount(owner, 1);
        assertTrue(address(a) != address(b));
    }
}
