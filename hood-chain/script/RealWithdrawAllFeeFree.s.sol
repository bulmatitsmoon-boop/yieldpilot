// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

interface IOldWrapperWD {
    function setWhitelist(address account, bool allowed) external;
    function whitelist(address) external view returns (bool);
    function withdraw(uint256 sharesToBurn, uint256 minAmount0, uint256 minAmount1, uint256 deadline)
        external
        returns (uint256, uint256);
    function userShares(address) external view returns (uint256);
    function admin() external view returns (address);
}

interface IERC20WD {
    function balanceOf(address) external view returns (uint256);
}

/// @notice Withdraws the admin's ENTIRE position from the OLD wrapper with no fee. The old wrapper
///         charges 9% of the whole withdrawal (principal included), so the admin is whitelisted first.
///         Self-contained (forge-std only).
contract RealWithdrawAllFeeFree is Script {
    address constant OLD_WRAPPER = 0x4f118199c64e253B59245CB976A0017F08A35A52;
    address constant USDE = 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant REAL_ADMIN = 0x1c033347CF32322c7a8F7E60A3b1CAce4222b4D8;
    address constant TREASURY = 0x94AE9Ed56FBD3F97f6745BEa5c61dd4C92D56ae8;

    function run() external {
        IOldWrapperWD w = IOldWrapperWD(OLD_WRAPPER);
        require(w.admin() == REAL_ADMIN, "admin mismatch");
        uint256 shares = w.userShares(REAL_ADMIN);
        require(shares > 0, "nothing to withdraw");

        uint256 aE = IERC20WD(USDE).balanceOf(REAL_ADMIN);
        uint256 aG = IERC20WD(USDG).balanceOf(REAL_ADMIN);
        uint256 tE = IERC20WD(USDE).balanceOf(TREASURY);
        uint256 tG = IERC20WD(USDG).balanceOf(TREASURY);
        console2.log("shares to withdraw:", shares);

        vm.startBroadcast(REAL_ADMIN);
        if (!w.whitelist(REAL_ADMIN)) w.setWhitelist(REAL_ADMIN, true);
        (uint256 n0, uint256 n1) = w.withdraw(shares, 0, 0, block.timestamp + 3600);
        vm.stopBroadcast();

        console2.log("received USDe (18 dec):", n0);
        console2.log("received USDG (6 dec):", n1);
        console2.log("admin USDe gained:", IERC20WD(USDE).balanceOf(REAL_ADMIN) - aE);
        console2.log("admin USDG gained:", IERC20WD(USDG).balanceOf(REAL_ADMIN) - aG);
        require(IERC20WD(USDE).balanceOf(TREASURY) == tE && IERC20WD(USDG).balanceOf(TREASURY) == tG, "a fee was charged");
        require(w.userShares(REAL_ADMIN) == 0, "shares remain");
    }
}
