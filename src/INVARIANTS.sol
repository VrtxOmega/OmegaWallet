// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║            OMEGA WALLET — NAEF INVARIANTS                    ║
 * ║       Mathematical Laws That Must Hold Under Infinite Chaos  ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * These invariants are defined BEFORE code. Every contract, module,
 * and test must satisfy these axioms. Violation = HALT.
 *
 * ═══════════════════════════════════════════════════════════════
 * INVARIANT 1: ENTRYPOINT SOVEREIGNTY
 * ═══════════════════════════════════════════════════════════════
 * 
 *   ∀ tx ∈ state_transitions(OmegaAccount):
 *     msg.sender == ENTRY_POINT ∨ msg.sender == address(this)
 *
 *   No external address — not even the owner's EOA — can directly
 *   invoke execute() or executeBatch(). Everything flows through
 *   EntryPoint.validateUserOp() → execute().
 *
 * ═══════════════════════════════════════════════════════════════
 * INVARIANT 2: SESSION KEY SPEND CEILING
 * ═══════════════════════════════════════════════════════════════
 *
 *   ∀ sk ∈ sessionKeys:
 *     sk.spent <= sk.spendLimit
 *
 *   A session key's cumulative spend can NEVER exceed its limit
 *   under any combination of single, batch, or cross-module calls.
 *   This must hold even if executeBatch() is called with 2^256-1
 *   transfers each of value 1 wei.
 *
 * ═══════════════════════════════════════════════════════════════
 * INVARIANT 3: SESSION KEY TIME BOUNDS
 * ═══════════════════════════════════════════════════════════════
 *
 *   ∀ sk ∈ sessionKeys, ∀ t ∈ timestamps:
 *     sk.used(t) → sk.validAfter <= t <= sk.validUntil
 *
 *   A session key cannot authorize any operation outside its
 *   [validAfter, validUntil] window. EntryPoint enforces this
 *   via validationData packing.
 *
 * ═══════════════════════════════════════════════════════════════  
 * INVARIANT 4: SESSION KEY CONTRACT SCOPE
 * ═══════════════════════════════════════════════════════════════
 *
 *   ∀ sk ∈ sessionKeys where sk.allowedContracts.length > 0:
 *     ∀ target ∈ sk.executed_targets:
 *       target ∈ sk.allowedContracts
 *
 *   A scoped session key can ONLY call contracts in its allowlist.
 *   No delegatecall, no self-call, no proxy indirection can break
 *   this boundary.
 *
 * ═══════════════════════════════════════════════════════════════
 * INVARIANT 5: RECOVERY TIMELOCK
 * ═══════════════════════════════════════════════════════════════
 *
 *   ∀ recovery ∈ recovery_requests:
 *     executeRecovery(recovery) → 
 *       block.timestamp >= recovery.requestedAt + RECOVERY_TIMELOCK
 *       ∧ recovery.confirmations >= guardianThreshold
 *
 *   Owner rotation CANNOT execute before the timelock expires AND
 *   the guardian threshold is met. No combination of guardian
 *   collusion or timestamp manipulation can bypass both.
 *
 * ═══════════════════════════════════════════════════════════════
 * INVARIANT 6: MODULE ISOLATION
 * ═══════════════════════════════════════════════════════════════
 *
 *   ∀ module_a, module_b ∈ installed_modules where module_a ≠ module_b:
 *     storage(module_a) ∩ storage(module_b) == ∅
 *
 *   Modules cannot read or write each other's storage. A compromised
 *   module cannot escalate to core account state or other modules.
 *   Enforced via ERC-7579 module type isolation + delegatecall
 *   sandboxing.
 *
 * ═══════════════════════════════════════════════════════════════
 * INVARIANT 7: OWNER UNIQUENESS
 * ═══════════════════════════════════════════════════════════════
 *
 *   |{owner}| == 1 ∧ owner != address(0)
 *
 *   There is exactly one owner at all times. Owner can never be
 *   set to address(0). Only recovery or owner self-transfer can
 *   change the owner.
 *
 * ═══════════════════════════════════════════════════════════════
 * INVARIANT 8: PAYMASTER SOLVENCY
 * ═══════════════════════════════════════════════════════════════
 *
 *   ∀ t ∈ timestamps:
 *     paymaster.balance(t) >= sum(pending_sponsored_ops(t))
 *
 *   The Paymaster contract never sponsors a UserOp if insufficient
 *   deposit exists. Margin fees are always additive — they cannot
 *   cause the deposit to go negative.
 *
 * ═══════════════════════════════════════════════════════════════
 * INVARIANT 9: NO DELEGATECALL FROM MODULES
 * ═══════════════════════════════════════════════════════════════
 *
 *   ∀ call ∈ module_executions:
 *     call.type != DELEGATECALL
 *       ∨ call.target ∈ trusted_implementation_set
 *
 *   Modules execute via CALL, never DELEGATECALL to untrusted
 *   addresses. This prevents storage corruption and proxy attacks.
 *
 * ═══════════════════════════════════════════════════════════════
 * INVARIANT 10: BATCH ATOMICITY
 * ═══════════════════════════════════════════════════════════════
 *
 *   ∀ batch ∈ executeBatch() calls:
 *     (∀ i: batch[i].success) ∨ (∀ i: batch[i].reverted)
 *
 *   Batch execution is atomic. Either all calls succeed or the
 *   entire batch reverts. No partial execution state.
 */

/// @dev This file is documentation only. It does not compile.
///      Invariants are enforced in tests via Foundry invariant testing.
