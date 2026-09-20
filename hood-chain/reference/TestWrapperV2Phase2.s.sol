// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DualPoolHook} from "../src/alf/DualPoolHook.sol";
import {YieldPilotHoodVaultV2} from "../src/wrapper/YieldPilotHoodVaultV2.sol";

/// @notice FORK-ONLY test, phase 2 (run after warping time forward): profit-only fee checks.
contract TestWrapperV2Phase2 is Script {
    address constant USDE = 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant WHALE = 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010;
    address constant TREASURY = 0x94AE9Ed56FBD3F97f6745BEa5c61dd4C92D56ae8;
    address constant USER = address(uint160(0x1111));
    address constant USER2 = address(uint160(0x2222));

    function run() external {
        YieldPilotHoodVaultV2 w = YieldPilotHoodVaultV2(vm.envAddress("WRAPPER"));
        DualPoolHook hook = DualPoolHook(vm.envAddress("HOOK"));
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(USDE), currency1: Currency.wrap(USDG), fee: 500, tickSpacing: 10, hooks: IHooks(address(hook))
        });
        uint256 s0 = w.scale0();
        uint256 s1 = w.scale1();

        // ---------- CASE 1: long-held position with real accrued yield ----------
        uint256 basis = w.costBasis(USER);
        uint256 shares = w.userShares(USER);
        uint256 t0 = IERC20(USDE).balanceOf(TREASURY);
        uint256 t1 = IERC20(USDG).balanceOf(TREASURY);

        vm.startBroadcast(USER);
        (uint256 net0, uint256 net1) = w.withdraw(shares, 0, 0, block.timestamp + 3600);
        vm.stopBroadcast();

        uint256 fee0 = IERC20(USDE).balanceOf(TREASURY) - t0;
        uint256 fee1 = IERC20(USDG).balanceOf(TREASURY) - t1;
        uint256 value = (net0 + fee0) * s0 + (net1 + fee1) * s1;
        uint256 profit = value > basis ? value - basis : 0;
        uint256 expectedFee = (profit * 900) / 10_000;
        uint256 actualFee = fee0 * s0 + fee1 * s1;
        console2.log("CASE 1 (held, with yield)");
        console2.log("  cost basis (1e18 = $1):", basis);
        console2.log("  value withdrawn       :", value);
        console2.log("  PROFIT                :", profit);
        console2.log("  expected 9% of profit :", expectedFee);
        console2.log("  actual fee charged    :", actualFee);
        console2.log("  fee as % of principal (bps x100):", (actualFee * 1_000_000) / basis);
        require(actualFee + 2e12 >= expectedFee && actualFee <= expectedFee + 2e12, "FEE != 9% OF PROFIT");
        require(actualFee < basis / 100, "fee looks like a % of principal");

        // ---------- CASE 2: deposit then immediately withdraw -> no profit -> no fee ----------
        vm.startBroadcast(WHALE);
        IERC20(USDE).transfer(USER2, 10e18);
        IERC20(USDG).transfer(USER2, 10e6);
        vm.stopBroadcast();

        (uint256 r0, uint256 r1) = hook.getReserves(key);
        uint256 hs = hook.sharesOf(key, address(w));
        vm.startBroadcast(USER2);
        IERC20(USDE).approve(address(w), type(uint256).max);
        IERC20(USDG).approve(address(w), type(uint256).max);
        uint256 minted = w.deposit(hs / 3, (r0 * 4) / 10, (r1 * 4) / 10, block.timestamp + 3600);
        uint256 basis2 = w.costBasis(USER2);
        uint256 u0 = IERC20(USDE).balanceOf(TREASURY);
        uint256 u1 = IERC20(USDG).balanceOf(TREASURY);
        (uint256 n0, uint256 n1) = w.withdraw(minted, 0, 0, block.timestamp + 3600);
        vm.stopBroadcast();

        uint256 f0 = IERC20(USDE).balanceOf(TREASURY) - u0;
        uint256 f1 = IERC20(USDG).balanceOf(TREASURY) - u1;
        uint256 v2 = (n0 + f0) * s0 + (n1 + f1) * s1;
        console2.log("CASE 2 (deposit then immediate withdraw)");
        console2.log("  cost basis            :", basis2);
        console2.log("  value back            :", v2);
        console2.log("  fee charged           :", f0 * s0 + f1 * s1);
        require(f0 * s0 + f1 * s1 <= 2e12, "fee charged on a no-profit round trip");
        require(v2 + 4e12 >= basis2, "depositor lost value to share-mint accounting");

        console2.log("ALL V2 CHECKS PASSED");
    }
}
