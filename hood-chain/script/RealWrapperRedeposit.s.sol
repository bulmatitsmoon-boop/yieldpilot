// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

struct PoolKeyRedeposit {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

interface IERC20Redeposit {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IHookRedeposit {
    function getReserves(PoolKeyRedeposit calldata key) external view returns (uint256, uint256);
    function sharesOf(PoolKeyRedeposit calldata key, address user) external view returns (uint256);
}

interface IWrapperRedeposit {
    function deposit(uint256 sharesToMint, uint256 maxAmount0, uint256 maxAmount1, uint256 deadline)
        external
        returns (uint256 minted);
    function userShares(address) external view returns (uint256);
}

/// @notice Re-deposits the real admin's entire current USDe+USDG balance back into the real
///         wrapper (the amount withdrawn earlier during the fee-tracking proof), so the full
///         position sits earning/idle over the weekend rather than half-withdrawn.
///         Self-contained, same reproducibility reasoning as the other RealVault*.s.sol scripts.
contract RealWrapperRedeposit is Script {
    address constant WRAPPER = 0x4f118199c64e253B59245CB976A0017F08A35A52;
    address constant HOOK = 0x22e255a8f28B8c4c5b663e42eac1D38C3da7EAC0;
    address constant USDE = 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant REAL_ADMIN = 0x1c033347CF32322c7a8F7E60A3b1CAce4222b4D8;

    function run() external {
        IERC20Redeposit usde = IERC20Redeposit(USDE);
        IERC20Redeposit usdg = IERC20Redeposit(USDG);
        IHookRedeposit hook = IHookRedeposit(HOOK);
        IWrapperRedeposit wrapper = IWrapperRedeposit(WRAPPER);

        PoolKeyRedeposit memory key = PoolKeyRedeposit({currency0: USDE, currency1: USDG, fee: 500, tickSpacing: 10, hooks: HOOK});

        uint256 amount0 = usde.balanceOf(REAL_ADMIN);
        uint256 amount1 = usdg.balanceOf(REAL_ADMIN);
        console2.log("real USDe balance to redeposit:", amount0);
        console2.log("real USDG balance to redeposit:", amount1);
        require(amount0 > 0 && amount1 > 0, "nothing to redeposit");

        (uint256 r0, uint256 r1) = hook.getReserves(key);
        uint256 hookShares = hook.sharesOf(key, WRAPPER);
        // Same proportional math the frontend preview uses -- floor to whichever side is
        // the tighter constraint so neither maxAmount is exceeded.
        uint256 sharesFrom0 = (amount0 * hookShares) / r0;
        uint256 sharesFrom1 = (amount1 * hookShares) / r1;
        uint256 sharesToMint = sharesFrom0 < sharesFrom1 ? sharesFrom0 : sharesFrom1;
        console2.log("computed sharesToMint:", sharesToMint);

        vm.startBroadcast(REAL_ADMIN);
        usde.approve(WRAPPER, amount0);
        usdg.approve(WRAPPER, amount1);
        uint256 minted = wrapper.deposit(sharesToMint, amount0, amount1, block.timestamp + 3600);
        vm.stopBroadcast();

        console2.log("REAL REDEPOSIT COMPLETE. shares minted:", minted);
        console2.log("admin total wrapper shares now:", wrapper.userShares(REAL_ADMIN));
        console2.log("admin remaining USDe:", usde.balanceOf(REAL_ADMIN));
        console2.log("admin remaining USDG:", usdg.balanceOf(REAL_ADMIN));
    }
}
