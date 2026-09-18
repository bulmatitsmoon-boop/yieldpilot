// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

interface IVaultV2Withdraw {
    function balanceOf(address) external view returns (uint256);
    function redeem(uint256 shares, address receiver, address onBehalf) external returns (uint256);
}

interface IERC20Withdraw {
    function balanceOf(address) external view returns (uint256);
}

/// @notice Redeems the admin's ENTIRE real share balance from the real USDG VaultV2, pulling
///         from the real Morpho market automatically if the vault's own idle balance is
///         insufficient (confirmed from VaultV2's real `exit()` source). Self-contained, same
///         reproducibility reasoning as the other RealVault*.s.sol scripts.
contract RealVaultWithdraw is Script {
    address constant USDG_VAULT = 0xEA9C8BBEc3680c481100668410702564F468E6fb;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant REAL_ADMIN = 0x1c033347CF32322c7a8F7E60A3b1CAce4222b4D8;

    function run() external {
        IVaultV2Withdraw vault = IVaultV2Withdraw(USDG_VAULT);
        IERC20Withdraw usdg = IERC20Withdraw(USDG);

        uint256 shares = vault.balanceOf(REAL_ADMIN);
        console2.log("redeeming real shares:", shares);
        require(shares > 0, "no shares to redeem");

        uint256 usdgBefore = usdg.balanceOf(REAL_ADMIN);

        vm.startBroadcast(REAL_ADMIN);
        uint256 assets = vault.redeem(shares, REAL_ADMIN, REAL_ADMIN);
        vm.stopBroadcast();

        uint256 usdgAfter = usdg.balanceOf(REAL_ADMIN);
        console2.log("real USDG assets redeemed:", assets);
        console2.log("admin USDG balance before:", usdgBefore);
        console2.log("admin USDG balance after:", usdgAfter);
    }
}
