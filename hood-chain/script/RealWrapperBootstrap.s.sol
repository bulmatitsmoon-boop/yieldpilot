// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

interface IERC20Bootstrap {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IWrapperBootstrap {
    function bootstrap(uint256 amount0, uint256 amount1) external;
    function userShares(address) external view returns (uint256);
    function bootstrapped() external view returns (bool);
}

/// @notice Bootstraps the real YieldPilotHoodVault pool with the admin's ENTIRE real USDe
///         (currency0) and USDG (currency1) balances. Self-contained, same reproducibility
///         reasoning as the other RealVault*.s.sol scripts.
contract RealWrapperBootstrap is Script {
    address constant WRAPPER = 0x4f118199c64e253B59245CB976A0017F08A35A52;
    address constant USDE = 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant REAL_ADMIN = 0x1c033347CF32322c7a8F7E60A3b1CAce4222b4D8;

    function run() external {
        IERC20Bootstrap usde = IERC20Bootstrap(USDE);
        IERC20Bootstrap usdg = IERC20Bootstrap(USDG);
        IWrapperBootstrap wrapper = IWrapperBootstrap(WRAPPER);

        require(!wrapper.bootstrapped(), "already bootstrapped");

        uint256 amount0 = usde.balanceOf(REAL_ADMIN);
        uint256 amount1 = usdg.balanceOf(REAL_ADMIN);
        console2.log("bootstrapping with real USDe (amount0):", amount0);
        console2.log("bootstrapping with real USDG (amount1):", amount1);
        require(amount0 > 0 && amount1 > 0, "need both tokens");

        vm.startBroadcast(REAL_ADMIN);
        usde.approve(WRAPPER, amount0);
        usdg.approve(WRAPPER, amount1);
        wrapper.bootstrap(amount0, amount1);
        vm.stopBroadcast();

        console2.log("REAL BOOTSTRAP COMPLETE. admin wrapper-shares:", wrapper.userShares(REAL_ADMIN));
    }
}
