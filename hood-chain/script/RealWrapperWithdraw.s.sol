// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

interface IWrapperWithdraw {
    function withdraw(uint256 sharesToBurn, uint256 minAmount0, uint256 minAmount1, uint256 deadline)
        external
        returns (uint256 netAmount0, uint256 netAmount1);
    function userShares(address) external view returns (uint256);
    function whitelist(address) external view returns (bool);
}

interface IERC20Withdraw {
    function balanceOf(address) external view returns (uint256);
}

/// @notice Withdraws 10% of the real admin's real wrapper shares -- a REAL, non-whitelisted
///         withdrawal through the wrapper (not the raw vault), to prove the real 9% fee fires
///         and lands in the real treasury, visible on the live homepage stats afterward.
contract RealWrapperWithdraw is Script {
    address constant WRAPPER = 0x4f118199c64e253B59245CB976A0017F08A35A52;
    address constant USDE = 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant REAL_ADMIN = 0x1c033347CF32322c7a8F7E60A3b1CAce4222b4D8;
    address constant TREASURY = 0x94AE9Ed56FBD3F97f6745BEa5c61dd4C92D56ae8;

    function run() external {
        IWrapperWithdraw wrapper = IWrapperWithdraw(WRAPPER);
        IERC20Withdraw usde = IERC20Withdraw(USDE);
        IERC20Withdraw usdg = IERC20Withdraw(USDG);

        require(!wrapper.whitelist(REAL_ADMIN), "admin is whitelisted -- fee would be 0, wrong test");

        uint256 shares = wrapper.userShares(REAL_ADMIN);
        uint256 withdrawShares = shares / 10; // 10%
        console2.log("total admin shares:", shares);
        console2.log("withdrawing shares:", withdrawShares);

        uint256 treasuryEBefore = usde.balanceOf(TREASURY);
        uint256 treasuryGBefore = usdg.balanceOf(TREASURY);

        vm.startBroadcast(REAL_ADMIN);
        (uint256 net0, uint256 net1) = wrapper.withdraw(withdrawShares, 0, 0, block.timestamp + 3600);
        vm.stopBroadcast();

        console2.log("net0 (USDe) to admin:", net0);
        console2.log("net1 (USDG) to admin:", net1);
        console2.log("REAL treasury USDe delta (the real fee):", usde.balanceOf(TREASURY) - treasuryEBefore);
        console2.log("REAL treasury USDG delta (the real fee):", usdg.balanceOf(TREASURY) - treasuryGBefore);
    }
}
