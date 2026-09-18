// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

interface IERC20Deposit {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IVaultV2Deposit {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function totalAssets() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Deposits the admin wallet's ENTIRE real USDG balance into the real USDG VaultV2 --
///         self-contained (only forge-std), same reproducibility reasoning as RealVaultSetup.s.sol.
contract RealVaultDeposit is Script {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant USDG_VAULT = 0xEA9C8BBEc3680c481100668410702564F468E6fb;
    address constant REAL_ADMIN = 0x1c033347CF32322c7a8F7E60A3b1CAce4222b4D8;

    function run() external {
        IERC20Deposit usdg = IERC20Deposit(USDG);
        IVaultV2Deposit vault = IVaultV2Deposit(USDG_VAULT);

        uint256 amount = usdg.balanceOf(REAL_ADMIN);
        console2.log("depositing real USDG amount:", amount);
        require(amount > 0, "no USDG balance to deposit");

        vm.startBroadcast(REAL_ADMIN);

        usdg.approve(USDG_VAULT, amount);
        uint256 shares = vault.deposit(amount, REAL_ADMIN);

        vm.stopBroadcast();

        console2.log("real shares minted:", shares);
        console2.log("vault totalAssets after deposit:", vault.totalAssets());
        console2.log("admin vault share balance:", vault.balanceOf(REAL_ADMIN));
    }
}
