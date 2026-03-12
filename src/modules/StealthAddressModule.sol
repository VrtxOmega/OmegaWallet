// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/IOmegaModule.sol";

/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   STEALTH ADDRESS MODULE — ERC-5564 One-Time Receive Addrs   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * The wallet NEVER uses the same receiving address twice.
 * 
 * When someone sends you funds, their client computes a one-time
 * stealth address from your public meta-key. You receive the funds,
 * but an outside observer sees a brand new, disconnected wallet
 * being funded out of nowhere.
 *
 * CRYPTOGRAPHIC MECHANISM:
 *   1. Receiver publishes a stealth meta-address (public spend + view keys)
 *   2. Sender generates an ephemeral keypair
 *   3. Sender computes: stealthAddr = spendKey + H(ephemeral * viewKey) * G  
 *   4. Sender publishes ephemeral pubkey via an Announcer contract
 *   5. Receiver scans announcements to discover funds sent to them
 *
 * ON-CHAIN COMPONENT:
 *   This contract serves as the announcement registry. The actual
 *   stealth address derivation happens off-chain (frontend/SDK).
 *
 * NAEF INVARIANTS:
 *   INV-6:  Module isolation
 *   INV-13: Address unlinkability — no on-chain link between
 *           stealth addresses and the OmegaAccount
 */
contract StealthAddressModule is IOmegaModule {

    // ═══════════════════════════════════════════════════════════
    // TYPES
    // ═══════════════════════════════════════════════════════════

    /// @notice Stealth meta-address: published by receiver
    struct StealthMetaAddress {
        bytes spendingPubKey;   // compressed secp256k1 public key (33 bytes)
        bytes viewingPubKey;    // compressed secp256k1 public key (33 bytes)
        uint256 schemeId;       // 1 = secp256k1, 2 = ed25519
    }

    /// @notice Announcement: published by sender when sending to stealth addr
    struct Announcement {
        uint256 schemeId;
        address stealthAddress;     // the computed one-time address
        bytes ephemeralPubKey;      // sender's ephemeral public key
        bytes viewTag;              // first byte of shared secret (fast scan filter)
        uint256 timestamp;
    }

    // ═══════════════════════════════════════════════════════════
    // STORAGE
    // ═══════════════════════════════════════════════════════════

    /// @dev account => stealth meta-address
    mapping(address => StealthMetaAddress) private _metaAddresses;

    /// @dev Global announcements log (append-only)
    Announcement[] private _announcements;

    /// @dev account => list of announcement indices they should scan
    /// Note: this exists purely for efficiency. The receiver can
    /// also scan ALL announcements using their viewing key.
    mapping(address => uint256[]) private _accountAnnouncements;

    // ═══════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════

    event StealthMetaAddressRegistered(
        address indexed account,
        uint256 schemeId
    );

    /// @notice ERC-5564 compatible announcement
    event StealthAnnouncement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes viewTag
    );

    // ═══════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════

    error InvalidPubKeyLength();
    error UnsupportedScheme();
    error MetaAddressNotSet();

    // ═══════════════════════════════════════════════════════════
    // ERC-7579 MODULE INTERFACE
    // ═══════════════════════════════════════════════════════════

    function onInstall(bytes calldata data) external override {
        if (data.length > 0) {
            (bytes memory spendKey, bytes memory viewKey, uint256 schemeId) =
                abi.decode(data, (bytes, bytes, uint256));
            _registerMetaAddress(msg.sender, spendKey, viewKey, schemeId);
        }
    }

    function onUninstall(bytes calldata) external override {
        delete _metaAddresses[msg.sender];
    }

    function isModuleType(uint256 moduleTypeId) external pure override returns (bool) {
        return moduleTypeId == MODULE_TYPE_EXECUTOR;
    }

    // ═══════════════════════════════════════════════════════════
    // META-ADDRESS MANAGEMENT (receiver side)
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Register your stealth meta-address.
     *         This is PUBLIC — it's safe to publish because it only
     *         contains public keys, not private keys.
     *
     * @param spendingPubKey Compressed secp256k1 spending public key (33 bytes)
     * @param viewingPubKey  Compressed secp256k1 viewing public key (33 bytes)
     * @param schemeId       Cryptographic scheme (1 = secp256k1)
     */
    function registerMetaAddress(
        bytes calldata spendingPubKey,
        bytes calldata viewingPubKey,
        uint256 schemeId
    ) external {
        _registerMetaAddress(msg.sender, spendingPubKey, viewingPubKey, schemeId);
    }

    // ═══════════════════════════════════════════════════════════
    // ANNOUNCEMENT REGISTRY (sender side)
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Announce a stealth transaction.
     *
     * Called by the sender AFTER computing the stealth address
     * and sending funds to it. The announcement contains:
     *   - The ephemeral public key (for receiver to derive the private key)
     *   - The view tag (for fast filtering during scanning)
     *   - The stealth address (where funds were sent)
     *
     * INV-13: The announcement does NOT reveal who the intended
     * receiver is. Only the holder of the viewing key can identify
     * announcements meant for them.
     *
     * @param schemeId        Cryptographic scheme identifier
     * @param stealthAddress  The one-time stealth address
     * @param ephemeralPubKey Sender's ephemeral public key
     * @param viewTag         First byte of shared secret for fast filtering
     */
    function announce(
        uint256 schemeId,
        address stealthAddress,
        bytes calldata ephemeralPubKey,
        bytes calldata viewTag
    ) external {
        if (schemeId == 0) revert UnsupportedScheme();

        uint256 index = _announcements.length;

        _announcements.push(Announcement({
            schemeId: schemeId,
            stealthAddress: stealthAddress,
            ephemeralPubKey: ephemeralPubKey,
            viewTag: viewTag,
            timestamp: block.timestamp
        }));

        emit StealthAnnouncement(
            schemeId,
            stealthAddress,
            msg.sender,
            ephemeralPubKey,
            viewTag
        );
    }

    // ═══════════════════════════════════════════════════════════
    // SCANNING (receiver side — typically done off-chain)
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Get announcements in a range for off-chain scanning.
     * @param fromIndex Start index (inclusive)
     * @param toIndex   End index (exclusive)
     */
    function getAnnouncements(
        uint256 fromIndex,
        uint256 toIndex
    ) external view returns (Announcement[] memory) {
        if (toIndex > _announcements.length) {
            toIndex = _announcements.length;
        }

        uint256 count = toIndex - fromIndex;
        Announcement[] memory result = new Announcement[](count);

        for (uint256 i = 0; i < count; i++) {
            result[i] = _announcements[fromIndex + i];
        }

        return result;
    }

    function getAnnouncementCount() external view returns (uint256) {
        return _announcements.length;
    }

    // ═══════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════

    function getMetaAddress(address account) external view returns (
        bytes memory spendingPubKey,
        bytes memory viewingPubKey,
        uint256 schemeId
    ) {
        StealthMetaAddress storage meta = _metaAddresses[account];
        return (meta.spendingPubKey, meta.viewingPubKey, meta.schemeId);
    }

    function hasMetaAddress(address account) external view returns (bool) {
        return _metaAddresses[account].schemeId != 0;
    }

    // ═══════════════════════════════════════════════════════════
    // INTERNALS
    // ═══════════════════════════════════════════════════════════

    function _registerMetaAddress(
        address account,
        bytes memory spendingPubKey,
        bytes memory viewingPubKey,
        uint256 schemeId
    ) internal {
        if (schemeId == 0) revert UnsupportedScheme();
        if (spendingPubKey.length != 33) revert InvalidPubKeyLength();
        if (viewingPubKey.length != 33) revert InvalidPubKeyLength();

        _metaAddresses[account] = StealthMetaAddress({
            spendingPubKey: spendingPubKey,
            viewingPubKey: viewingPubKey,
            schemeId: schemeId
        });

        emit StealthMetaAddressRegistered(account, schemeId);
    }
}
