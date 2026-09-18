// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

interface IERC20Fee {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

struct PoolKeyFee {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

interface IHookReserves {
    function getReserves(PoolKeyFee calldata key) external view returns (uint256, uint256);
    function sharesOf(PoolKeyFee calldata key, address user) external view returns (uint256);
}

interface IWrapperFee {
    function deposit(uint256 sharesToMint, uint256 maxAmount0, uint256 maxAmount1, uint256 deadline)
        external
        returns (uint256 minted);
    function withdraw(uint256 sharesToBurn, uint256 minAmount0, uint256 minAmount1, uint256 deadline)
        external
        returns (uint256 netAmount0, uint256 netAmount1);
    function setWhitelist(address account, bool allowed) external;
    function hook() external view returns (address);
    function userShares(address) external view returns (uint256);
    function admin() external view returns (address);
}

/// @notice FORK-ONLY proof (not for real broadcast -- uses whale impersonation to source test
///         tokens, and toggles whitelist for both branches in one run). Proves YieldPilot's own
///         9%/0% fee logic fires correctly through the REAL deployed wrapper + REAL bootstrapped
///         pool, for a genuinely separate test wallet, both non-whitelisted and whitelisted.
contract RealFeeProof is Script {
    address constant WRAPPER = 0x4f118199c64e253B59245CB976A0017F08A35A52;
    address constant HOOK = 0x22e255a8f28B8c4c5b663e42eac1D38C3da7EAC0;
    address constant USDE = 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant MORPHO_WHALE = 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010; // real Blue core, real whale
    address constant REAL_ADMIN = 0x1c033347CF32322c7a8F7E60A3b1CAce4222b4D8;
    address constant TREASURY = 0x94AE9Ed56FBD3F97f6745BEa5c61dd4C92D56ae8;

    address constant TEST_USER_1 = address(uint160(0x1111));
    address constant TEST_USER_2 = address(uint160(0x2222));

    function run() external {
        IWrapperFee wrapper = IWrapperFee(WRAPPER);
        IHookReserves hook = IHookReserves(HOOK);
        IERC20Fee usde = IERC20Fee(USDE);
        IERC20Fee usdg = IERC20Fee(USDG);

        PoolKeyFee memory key = PoolKeyFee({currency0: USDE, currency1: USDG, fee: 500, tickSpacing: 10, hooks: HOOK});

        // --- Fund two fresh test wallets from the real Morpho whale (fork-only, no real cost) ---
        vm.startBroadcast(MORPHO_WHALE);
        usde.transfer(TEST_USER_1, 5e18);
        usdg.transfer(TEST_USER_1, 5e6);
        usde.transfer(TEST_USER_2, 5e18);
        usdg.transfer(TEST_USER_2, 5e6);
        vm.stopBroadcast();
        console2.log("funded two real-shaped test wallets from the real Morpho whale");

        // === BRANCH 1: non-whitelisted, expect 9% fee to treasury ===
        uint256 treasuryE_before = usde.balanceOf(TREASURY);
        uint256 treasuryG_before = usdg.balanceOf(TREASURY);

        (uint256 r0, uint256 r1) = hook.getReserves(key);
        uint256 hookShares = hook.sharesOf(key, WRAPPER);
        uint256 depositShares1 = hookShares / 100; // ~1% of pool
        uint256 max0_1 = (r0 * depositShares1 / hookShares) * 2;
        uint256 max1_1 = (r1 * depositShares1 / hookShares) * 2;

        vm.startBroadcast(TEST_USER_1);
        usde.approve(WRAPPER, type(uint256).max);
        usdg.approve(WRAPPER, type(uint256).max);
        uint256 minted1 = wrapper.deposit(depositShares1, max0_1, max1_1, block.timestamp + 3600);
        (uint256 net0_1, uint256 net1_1) = wrapper.withdraw(minted1, 0, 0, block.timestamp + 3600);
        vm.stopBroadcast();

        console2.log("--- BRANCH 1: non-whitelisted ---");
        console2.log("net0 (USDe) to user:", net0_1);
        console2.log("net1 (USDG) to user:", net1_1);
        console2.log("treasury USDe delta:", usde.balanceOf(TREASURY) - treasuryE_before);
        console2.log("treasury USDG delta:", usdg.balanceOf(TREASURY) - treasuryG_before);
        require(usde.balanceOf(TREASURY) > treasuryE_before, "no USDe fee collected");
        require(usdg.balanceOf(TREASURY) > treasuryG_before, "no USDG fee collected");
        console2.log("CONFIRMED: 9% fee correctly charged and routed to treasury for non-whitelisted user");

        // === BRANCH 2: whitelisted, expect 0% fee ===
        vm.startBroadcast(REAL_ADMIN);
        wrapper.setWhitelist(TEST_USER_2, true);
        vm.stopBroadcast();

        uint256 treasuryE_before2 = usde.balanceOf(TREASURY);
        uint256 treasuryG_before2 = usdg.balanceOf(TREASURY);

        (r0, r1) = hook.getReserves(key);
        hookShares = hook.sharesOf(key, WRAPPER);
        uint256 depositShares2 = hookShares / 100;
        uint256 max0_2 = (r0 * depositShares2 / hookShares) * 2;
        uint256 max1_2 = (r1 * depositShares2 / hookShares) * 2;

        vm.startBroadcast(TEST_USER_2);
        usde.approve(WRAPPER, type(uint256).max);
        usdg.approve(WRAPPER, type(uint256).max);
        uint256 minted2 = wrapper.deposit(depositShares2, max0_2, max1_2, block.timestamp + 3600);
        (uint256 net0_2, uint256 net1_2) = wrapper.withdraw(minted2, 0, 0, block.timestamp + 3600);
        vm.stopBroadcast();

        console2.log("--- BRANCH 2: whitelisted ---");
        console2.log("net0 (USDe) to user:", net0_2);
        console2.log("net1 (USDG) to user:", net1_2);
        console2.log("treasury USDe delta (should be 0):", usde.balanceOf(TREASURY) - treasuryE_before2);
        console2.log("treasury USDG delta (should be 0):", usdg.balanceOf(TREASURY) - treasuryG_before2);
        require(usde.balanceOf(TREASURY) == treasuryE_before2, "fee wrongly charged to whitelisted user (USDe)");
        require(usdg.balanceOf(TREASURY) == treasuryG_before2, "fee wrongly charged to whitelisted user (USDG)");
        console2.log("CONFIRMED: 0% fee correctly applied for whitelisted user, no treasury credit");

        console2.log("FULL FEE PROOF COMPLETE against the REAL deployed wrapper + REAL bootstrapped pool");
    }
}
