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

interface IOldWrapper {
    function setWhitelist(address account, bool allowed) external;
    function whitelist(address) external view returns (bool);
    function withdraw(uint256 sharesToBurn, uint256 minAmount0, uint256 minAmount1, uint256 deadline)
        external
        returns (uint256, uint256);
    function userShares(address) external view returns (uint256);
}

interface INewWrapper {
    function initializePool(PoolConfig calldata config) external returns (int24);
    function bootstrap(uint256 amount0, uint256 amount1) external;
    function bootstrapped() external view returns (bool);
    function userShares(address) external view returns (uint256);
    function costBasis(address) external view returns (uint256);
    function admin() external view returns (address);
}

interface IERC20Migrate {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// @notice Moves the real position from the OLD wrapper (9%-of-principal fee, share-mint bug) to
///         the V2 wrapper (9%-of-profit fee, fixed share math): whitelist admin on the old wrapper
///         so the exit is fee-free, withdraw everything, then initialise + bootstrap the V2 pool
///         with the admin's full USDe/USDG balances. Self-contained (forge-std only).
contract RealMigrateToV2 is Script {
    address constant OLD_WRAPPER = 0x4f118199c64e253B59245CB976A0017F08A35A52;
    address constant NEW_WRAPPER = 0x63025eC5d9dAB3d89A8Ae3A987941E77c12DAfE0;
    address constant USDE = 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant USDE_VAULT = 0x92570f0D10CC39ACb80B630611a18bA091687337;
    address constant USDG_VAULT = 0xEA9C8BBEc3680c481100668410702564F468E6fb;
    address constant REAL_ADMIN = 0x1c033347CF32322c7a8F7E60A3b1CAce4222b4D8;
    address constant TREASURY = 0x94AE9Ed56FBD3F97f6745BEa5c61dd4C92D56ae8;

    function run() external {
        IOldWrapper oldW = IOldWrapper(OLD_WRAPPER);
        INewWrapper newW = INewWrapper(NEW_WRAPPER);
        IERC20Migrate usde = IERC20Migrate(USDE);
        IERC20Migrate usdg = IERC20Migrate(USDG);

        require(newW.admin() == REAL_ADMIN, "new wrapper admin mismatch -- wrong address?");
        require(!newW.bootstrapped(), "new wrapper already bootstrapped");

        uint256 oldShares = oldW.userShares(REAL_ADMIN);
        require(oldShares > 0, "nothing in the old wrapper");
        uint256 tE = usde.balanceOf(TREASURY);
        uint256 tG = usdg.balanceOf(TREASURY);
        console2.log("old wrapper shares to exit:", oldShares);

        LiquidityBucket[] memory buckets = new LiquidityBucket[](1);
        buckets[0] = LiquidityBucket({tickLower: -600000, tickUpper: 600000, weightBps: 10000});
        PoolConfig memory cfg = PoolConfig({
            sqrtPriceX96: 79228162514264337593543,
            distribution: buckets,
            allowExternalDeposits: true,
            vault0: USDE_VAULT,
            vault1: USDG_VAULT,
            minDepositBlocks: 0
        });

        vm.startBroadcast(REAL_ADMIN);

        // 1. fee-free exit from the old wrapper
        if (!oldW.whitelist(REAL_ADMIN)) oldW.setWhitelist(REAL_ADMIN, true);
        oldW.withdraw(oldShares, 0, 0, block.timestamp + 3600);

        uint256 amount0 = usde.balanceOf(REAL_ADMIN);
        uint256 amount1 = usdg.balanceOf(REAL_ADMIN);
        console2.log("USDe leaving old wrapper -> new:", amount0);
        console2.log("USDG leaving old wrapper -> new:", amount1);
        require(amount0 > 0 && amount1 > 0, "exit returned nothing");

        // 2. stand up the V2 pool
        newW.initializePool(cfg);
        usde.approve(NEW_WRAPPER, amount0);
        usdg.approve(NEW_WRAPPER, amount1);
        newW.bootstrap(amount0, amount1);

        vm.stopBroadcast();

        console2.log("old wrapper admin shares now (want 0):", oldW.userShares(REAL_ADMIN));
        console2.log("NEW wrapper admin shares:", newW.userShares(REAL_ADMIN));
        console2.log("NEW wrapper admin cost basis (1e18=$1):", newW.costBasis(REAL_ADMIN));
        console2.log("fee sent to treasury during exit, USDe (want 0):", usde.balanceOf(TREASURY) - tE);
        console2.log("fee sent to treasury during exit, USDG (want 0):", usdg.balanceOf(TREASURY) - tG);
        console2.log("MIGRATION COMPLETE");
    }
}
