// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

interface IVaultV2MaxRate {
    function setMaxRate(uint256 newMaxRate) external;
    function maxRate() external view returns (uint64);
    function isAllocator(address) external view returns (bool);
    function totalAssets() external view returns (uint256);
}

/// @notice Sets VaultV2's `maxRate` on the real USDG vault. It was 0, which caps the share price
///         at "what was deposited" forever, so interest earned in the Morpho Blue market stayed
///         stuck on the adapter and never reached depositors. 20% APR is far above what the
///         market pays (~4-5%) yet still bounds how fast the share price can be pumped.
///         Self-contained (only forge-std), same reproducibility reasoning as the other scripts.
contract RealSetMaxRate is Script {
    address constant USDG_VAULT = 0xEA9C8BBEc3680c481100668410702564F468E6fb;
    address constant REAL_ADMIN = 0x1c033347CF32322c7a8F7E60A3b1CAce4222b4D8;

    // 20% APR expressed per-second, WAD-scaled -- same formula shape as Morpho's own MAX_MAX_RATE
    // (200e16 / 365 days), just at 20e16.
    uint256 constant NEW_MAX_RATE = uint256(20e16) / uint256(365 days);

    function run() external {
        IVaultV2MaxRate vault = IVaultV2MaxRate(USDG_VAULT);

        require(vault.isAllocator(REAL_ADMIN), "admin is not an allocator on this vault");
        console2.log("maxRate before:", uint256(vault.maxRate()));
        console2.log("new maxRate:", NEW_MAX_RATE);
        console2.log("vault totalAssets before:", vault.totalAssets());

        vm.startBroadcast(REAL_ADMIN);
        vault.setMaxRate(NEW_MAX_RATE);
        vm.stopBroadcast();

        console2.log("maxRate after:", uint256(vault.maxRate()));
        require(uint256(vault.maxRate()) == NEW_MAX_RATE, "maxRate not set");
    }
}
