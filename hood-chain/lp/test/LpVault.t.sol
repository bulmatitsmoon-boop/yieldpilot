// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {YieldPilotV3LpVault, IV3Pool, ISwapRouter02} from "../src/YieldPilotV3LpVault.sol";

contract LpVaultForkTest is Test {
    address constant NPM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant P_ETH = 0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a;
    address constant P_NVDA = 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3;
    address constant P_SPCX = 0xc61284332117c3FB23A2A56cceFFD07F7aF60029;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address trader = address(0x7AD3);
    address treasury = address(0x7EA5);

    function setUp() public {
        vm.createSelectFork("https://rpc.mainnet.chain.robinhood.com");
    }

    function _vault(address pool, uint256 cap) internal returns (YieldPilotV3LpVault v) {
        return _vaultW(pool, cap, 4000);
    }

    function _vaultW(address pool, uint256 cap, int24 w) internal returns (YieldPilotV3LpVault v) {
        (, int24 tick,,,,,) = IV3Pool(pool).slot0();
        int24 sp = IV3Pool(pool).tickSpacing();
        int24 lo = ((tick - w) / sp) * sp;
        int24 hi = ((tick + w) / sp) * sp;
        v = new YieldPilotV3LpVault(pool, NPM, ROUTER, USDG, address(this), address(this), treasury, cap, lo, hi);
    }

    function _fund(address who, uint256 amt, YieldPilotV3LpVault v) internal {
        deal(USDG, who, amt);
        vm.prank(who);
        IERC20(USDG).approve(address(v), type(uint256).max);
    }

    function _churn(YieldPilotV3LpVault v, uint256 usdgSize, uint256 rounds) internal {
        IERC20 o = v.other();
        deal(USDG, trader, usdgSize * 3);
        vm.startPrank(trader);
        IERC20(USDG).approve(ROUTER, type(uint256).max);
        o.approve(ROUTER, type(uint256).max);
        for (uint256 i; i < rounds; i++) {
            uint256 got = ISwapRouter02(ROUTER).exactInputSingle(
                ISwapRouter02.ExactInputSingleParams(USDG, address(o), v.poolFee(), trader, usdgSize, 0, 0)
            );
            ISwapRouter02(ROUTER).exactInputSingle(
                ISwapRouter02.ExactInputSingleParams(address(o), USDG, v.poolFee(), trader, got, 0, 0)
            );
        }
        vm.stopPrank();
    }

    function _run(string memory name, address pool) internal {
        console2.log("=====", name);
        YieldPilotV3LpVault v = _vault(pool, 10_000e6);
        _fund(alice, 1000e6, v);
        _fund(bob, 1000e6, v);

        vm.prank(alice);
        uint256 sA = v.deposit(100e6);
        uint256 navA = v.totalAssets();
        console2.log("alice deposit 100 USDG -> NAV (USDG units):", navA);
        console2.log("alice shares:", sA);
        assertGe(navA, 98_500_000, "zap lost >1.5%");
        assertGt(v.tokenId(), 0);

        vm.prank(bob);
        uint256 sB = v.deposit(100e6);
        console2.log("bob shares (should ~ alice):", sB);
        assertApproxEqRel(sB, sA, 0.02e18);

        // instant exit while nothing earned: must not charge a fee on principal
        uint256 tb = IERC20(USDG).balanceOf(treasury);
        vm.prank(alice);
        uint256 netA = v.withdraw(sA);
        console2.log("alice instant round trip, got back:", netA);
        assertGe(netA, 98_000_000, "round trip lost >2%");
        assertEq(IERC20(USDG).balanceOf(treasury), tb, "fee charged with no profit");

        // earn fees: churn volume through the pool, then bob exits
        _churn(v, 20_000e6, 6);
        deal(USDG, address(v), IERC20(USDG).balanceOf(address(v)) + 10e6); // +$10 profit, deterministic
        vm.warp(block.timestamp + 7 hours);
        vm.roll(block.number + 100);
        v.maintain();
        uint256 valueBob = v.valueOf(bob);
        console2.log("bob value after churn (basis ~99-100e6):", valueBob);
        uint256 basis = v.costBasis(bob);
        tb = IERC20(USDG).balanceOf(treasury);
        vm.prank(bob);
        uint256 netB = v.withdraw(sB);
        uint256 fee = IERC20(USDG).balanceOf(treasury) - tb;
        console2.log("bob basis:", basis);
        console2.log("bob net:", netB);
        console2.log("fee to treasury:", fee);
        uint256 gross = netB + fee;
        assertGt(gross, basis, "expected a profit");
        assertApproxEqAbs(fee, ((gross - basis) * 900) / 10_000, 2, "fee != 9% of profit");
        assertGt(fee, 0.5e6, "fee should be ~ 9% of ~$10");
    }

    function test_ETH_USDG() public { _run("ETH/USDG 0.05%", P_ETH); }
    function test_NVDA_USDG() public { _run("NVDA/USDG 0.05%", P_NVDA); }
    function test_SPCX_USDG() public { _run("SPCX/USDG 0.05%", P_SPCX); }

    function test_manipulated_spot_blocks_deposit() public {
        YieldPilotV3LpVault v = _vault(P_SPCX, 10_000e6);
        _fund(alice, 1000e6, v);
        IERC20 o = v.other();
        deal(USDG, trader, 500_000e6);
        vm.startPrank(trader);
        IERC20(USDG).approve(ROUTER, type(uint256).max);
        try ISwapRouter02(ROUTER).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams(USDG, address(o), v.poolFee(), trader, 500_000e6, 0, 0)
        ) {} catch {}
        vm.stopPrank();
        (, int24 spot,,,,,) = IV3Pool(P_SPCX).slot0();
        console2.log("spot tick after manipulation:", int256(spot));
        vm.prank(alice);
        vm.expectRevert(YieldPilotV3LpVault.PriceDeviates.selector);
        v.deposit(100e6);
    }

    function test_cap_and_rebalance_and_admin_limits() public {
        YieldPilotV3LpVault v = _vault(P_NVDA, 150e6);
        _fund(alice, 1000e6, v);
        vm.prank(alice);
        uint256 s = v.deposit(100e6);
        vm.prank(alice);
        vm.expectRevert(YieldPilotV3LpVault.CapExceeded.selector);
        v.deposit(100e6);

        vm.prank(alice);
        vm.expectRevert(YieldPilotV3LpVault.NotKeeper.selector);
        v.maintain();
        vm.expectRevert(YieldPilotV3LpVault.NothingToDo.selector);
        v.maintain(); // fresh vault: nothing to do

        // user can still fully exit after the rebalance
        vm.prank(alice);
        uint256 net = v.withdraw(s);
        console2.log("exit after rebalance:", net);
        assertGe(net, 97_000_000);
    }

    function test_auto_recenter_when_price_drifts() public {
        YieldPilotV3LpVault v = _vaultW(P_SPCX, 100_000e6, 300);
        _fund(alice, 1000e6, v);
        vm.prank(alice);
        uint256 s = v.deposit(500e6);
        int24 lo0 = v.tickLower();
        int24 hi0 = v.tickUpper();
        uint256 navBefore = v.totalAssets();

        IERC20 o = v.other();
        deal(USDG, trader, 3_000_000e6);
        vm.startPrank(trader);
        IERC20(USDG).approve(ROUTER, type(uint256).max);
        int24 center = (lo0 + hi0) / 2;
        for (uint256 i; i < 60; i++) {
            (, int24 cur,,,,,) = IV3Pool(P_SPCX).slot0();
            if (cur >= center + 285) break;
            try ISwapRouter02(ROUTER).exactInputSingle(
                ISwapRouter02.ExactInputSingleParams(USDG, address(o), v.poolFee(), trader, 20_000e6, 0, 0)
            ) {} catch {}
        }
        vm.stopPrank();
        (, int24 spot,,,,,) = IV3Pool(P_SPCX).slot0();
        console2.log("range lo:", int256(lo0)); console2.log("range hi:", int256(hi0));
        console2.log("spot after push:", int256(spot));
        vm.warp(block.timestamp + 13 hours);
        vm.roll(block.number + 200);

        uint8 act = v.maintain();
        console2.log("action (1=recenter):", act);
        console2.log("new lo:", int256(v.tickLower())); console2.log("new hi:", int256(v.tickUpper()));
        assertEq(act, 1);
        assertEq(v.tickUpper() - v.tickLower(), hi0 - lo0, "width changed");
        assertGe(v.totalAssets(), (navBefore * 97) / 100);
        vm.expectRevert(YieldPilotV3LpVault.NothingToDo.selector);
        v.maintain(); // cooldown

        vm.prank(alice);
        uint256 net = v.withdraw(s);
        console2.log("exit after auto-recenter:", net);
        assertGe(net, 480e6);
    }
}
