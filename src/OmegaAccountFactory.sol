// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "./OmegaAccount.sol";

/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║           OMEGA ACCOUNT FACTORY — CREATE2 Deployer           ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Deterministic Smart Account deployment. Given an owner + salt,
 * the resulting account address is predictable before deployment.
 *
 * This enables:
 *   - Counterfactual addresses (receive funds before deploying)
 *   - Gas-efficient first-use deployment via EntryPoint
 *   - Consistent cross-chain addresses (same owner+salt = same address)
 */
contract OmegaAccountFactory {

    /// @notice The singleton implementation contract
    OmegaAccount public immutable accountImplementation;

    /// @notice Emitted when a new account is deployed
    event AccountCreated(address indexed account, address indexed owner, uint256 salt);

    constructor(IEntryPoint entryPoint_) {
        accountImplementation = new OmegaAccount(entryPoint_);
    }

    /**
     * @notice Deploy a new OmegaAccount via CREATE2.
     * @param owner The initial owner of the account
     * @param salt Unique salt for deterministic address
     * @return The deployed account address
     *
     * @dev If the account already exists at the predicted address,
     *      returns the existing address without redeploying.
     */
    function createAccount(
        address owner,
        uint256 salt
    ) external returns (OmegaAccount) {
        address predicted = getAddress(owner, salt);

        // If already deployed, return existing
        if (predicted.code.length > 0) {
            return OmegaAccount(payable(predicted));
        }

        // Deploy proxy pointing to implementation, initialized with owner
        ERC1967Proxy proxy = new ERC1967Proxy{salt: bytes32(salt)}(
            address(accountImplementation),
            abi.encodeCall(OmegaAccount.initialize, (owner))
        );

        emit AccountCreated(address(proxy), owner, salt);
        return OmegaAccount(payable(address(proxy)));
    }

    /**
     * @notice Predict the address of an account before deployment.
     * @param owner The owner of the account
     * @param salt Unique salt
     * @return The predicted address
     */
    function getAddress(
        address owner,
        uint256 salt
    ) public view returns (address) {
        bytes memory proxyBytecode = abi.encodePacked(
            type(ERC1967Proxy).creationCode,
            abi.encode(
                address(accountImplementation),
                abi.encodeCall(OmegaAccount.initialize, (owner))
            )
        );

        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                bytes32(salt),
                keccak256(proxyBytecode)
            )
        );

        return address(uint160(uint256(hash)));
    }
}
