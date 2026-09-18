// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

struct LiquidityBucket {
    int24 tickLower;
    int24 tickUpper;
    uint16 weightBps;
}

struct PoolConfig {
    uint160 sqrtPriceX96;
    LiquidityBucket[] distribution;
    bool allowExternalDeposits;
    address vault0;
    address vault1;
    uint64 minDepositBlocks;
}

interface IWrapperInit {
    function initializePool(PoolConfig calldata config) external returns (int24 tick);
    function admin() external view returns (address);
}

/// @notice Initializes the real pool on YieldPilotHoodVault -- self-contained (only forge-std),
///         same reproducibility reasoning as the other RealVault*.s.sol scripts. currency0/1
///         were already fixed at wrapper deploy time (currency0=USDe, currency1=USDG, address-
///         sorted), so vault0 must be the USDe VaultV2 and vault1 the USDG VaultV2.
contract RealPoolInit is Script {
    address constant WRAPPER = 0x4f118199c64e253B59245CB976A0017F08A35A52;
    address constant USDE_VAULT = 0x92570f0D10CC39ACb80B630611a18bA091687337;
    address constant USDG_VAULT = 0xEA9C8BBEc3680c481100668410702564F468E6fb;
    address constant REAL_ADMIN = 0x1c033347CF32322c7a8F7E60A3b1CAce4222b4D8;

    // sqrtPriceX96 for 1 USDe (18 dec) == 1 USDG (6 dec) in real USD terms, computed precisely
    // (not a naive 1:1 raw ratio -- that would be off by 1e12 given the decimal mismatch).
    uint160 constant SQRT_PRICE_X96 = 79228162514264337593543;

    function run() external {
        IWrapperInit wrapper = IWrapperInit(WRAPPER);
        require(wrapper.admin() == REAL_ADMIN, "admin mismatch, wrong wrapper?");

        LiquidityBucket[] memory buckets = new LiquidityBucket[](1);
        buckets[0] = LiquidityBucket({tickLower: -600000, tickUpper: 600000, weightBps: 10000});

        PoolConfig memory config = PoolConfig({
            sqrtPriceX96: SQRT_PRICE_X96,
            distribution: buckets,
            allowExternalDeposits: true,
            vault0: USDE_VAULT,
            vault1: USDG_VAULT,
            minDepositBlocks: 0
        });

        vm.startBroadcast(REAL_ADMIN);
        int24 tick = wrapper.initializePool(config);
        vm.stopBroadcast();

        console2.log("REAL POOL INITIALIZED, tick:");
        console2.logInt(tick);
    }
}
