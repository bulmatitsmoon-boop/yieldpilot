// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

interface ILpVaultWD {
    function withdraw(uint256 sharesIn) external returns (uint256 net);
    function shares(address) external view returns (uint256);
    function costBasis(address) external view returns (uint256);
    function valueOf(address) external view returns (uint256);
    function admin() external view returns (address);
}

interface IERC20WD {
    function balanceOf(address) external view returns (uint256);
}

/// @notice Withdraws 100% of the real admin's shares from the ETH/USDG LP vault. The 9% fee
///         (on profit only) applies normally here -- this is a real, no-whitelist exit.
///         Self-contained (forge-std only).
contract RealWithdrawAllLpVault is Script {
    address constant VAULT = 0x3f708457Eaf5E50aDD393568c9E09fE7AD009842;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant REAL_ADMIN = 0x1c033347CF32322c7a8F7E60A3b1CAce4222b4D8;
    address constant TREASURY = 0x94AE9Ed56FBD3F97f6745BEa5c61dd4C92D56ae8;

    function run() external {
        ILpVaultWD v = ILpVaultWD(VAULT);
        require(v.admin() == REAL_ADMIN, "admin mismatch");

        uint256 sharesIn = v.shares(REAL_ADMIN);
        require(sharesIn > 0, "nothing to withdraw");
        uint256 valueBefore = v.valueOf(REAL_ADMIN);
        uint256 basis = v.costBasis(REAL_ADMIN);
        uint256 usdgBefore = IERC20WD(USDG).balanceOf(REAL_ADMIN);
        uint256 treasuryBefore = IERC20WD(USDG).balanceOf(TREASURY);

        console2.log("shares to withdraw:", sharesIn);
        console2.log("value before (USDG units):", valueBefore);
        console2.log("cost basis (USDG units):", basis);

        vm.startBroadcast(REAL_ADMIN);
        uint256 net = v.withdraw(sharesIn);
        vm.stopBroadcast();

        uint256 fee = IERC20WD(USDG).balanceOf(TREASURY) - treasuryBefore;
        console2.log("net received (USDG units):", net);
        console2.log("fee paid to treasury (USDG units):", fee);
        console2.log("admin USDG gained:", IERC20WD(USDG).balanceOf(REAL_ADMIN) - usdgBefore);
        require(v.shares(REAL_ADMIN) == 0, "shares remain");
    }
}
