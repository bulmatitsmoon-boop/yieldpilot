// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {YieldPilotV3LpVault, IV3Pool} from "../src/YieldPilotV3LpVault.sol";

/// @notice Deploys the ETH/USDG (Uniswap v3, 0.05%) LP vault on Robinhood Chain mainnet.
///         Range = current tick -/+ 4000 (about 0.67x to 1.5x), rounded to the pool's tick spacing.
///         Env: KEEPER (bot wallet, required, must differ from admin), CAP_USDG (6-dec units, default $500).
contract DeployLpVault is Script {
    address constant POOL = 0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a; // WETH/USDG 0.05%
    address constant NPM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant ADMIN = 0x1c033347CF32322c7a8F7E60A3b1CAce4222b4D8;
    address constant TREASURY = 0x94AE9Ed56FBD3F97f6745BEa5c61dd4C92D56ae8;
    int24 constant HALF_WIDTH = 4000;

    function run() external {
        address keeper = vm.envAddress("KEEPER");
        uint256 cap = vm.envOr("CAP_USDG", uint256(500e6));
        require(keeper != address(0) && keeper != ADMIN, "keeper must be a separate non-zero wallet");
        require(block.chainid == 4663, "not Robinhood Chain mainnet");

        (, int24 tick,,,,,) = IV3Pool(POOL).slot0();
        int24 spacing = IV3Pool(POOL).tickSpacing();
        int24 lo = _floor(tick - HALF_WIDTH, spacing);
        int24 hi = _floor(tick + HALF_WIDTH, spacing);
        console2.log("current tick:", int256(tick));
        console2.log("range lo:", int256(lo));
        console2.log("range hi:", int256(hi));
        console2.log("cap (USDG units):", cap);
        console2.log("keeper:", keeper);

        vm.startBroadcast(ADMIN);
        YieldPilotV3LpVault v = new YieldPilotV3LpVault(POOL, NPM, ROUTER, USDG, ADMIN, keeper, TREASURY, cap, lo, hi);
        vm.stopBroadcast();

        require(v.admin() == ADMIN && v.keeper() == keeper && v.treasury() == TREASURY, "role wiring wrong");
        require(address(v.pool()) == POOL && address(v.usdg()) == USDG, "pool wiring wrong");
        require(v.depositCap() == cap && v.tickLower() == lo && v.tickUpper() == hi, "params wrong");
        require(v.totalShares() == 0 && v.tokenId() == 0, "vault not empty");
        console2.log("LP VAULT DEPLOYED AT:", address(v));
    }

    function _floor(int24 t, int24 spacing) internal pure returns (int24) {
        int24 r = t % spacing;
        if (r < 0) r += spacing;
        return t - r;
    }
}
