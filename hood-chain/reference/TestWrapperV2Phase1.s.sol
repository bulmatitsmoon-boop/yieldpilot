// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HookMiner} from "../src/utils/HookMiner.sol";
import {AllowlistedFactory} from "../src/AllowlistedFactory.sol";
import {DualPoolHook} from "../src/alf/DualPoolHook.sol";
import {LiquidityBucket} from "../src/alf/types/Distribution.sol";
import {YieldPilotHoodVaultV2} from "../src/wrapper/YieldPilotHoodVaultV2.sol";

/// @notice FORK-ONLY test, phase 1: deploy V2 stack, init pool, bootstrap as admin, then a test
///         user deposits ~100% of the pool. Phase 2 (after time is warped) withdraws and checks fees.
contract TestWrapperV2Phase1 is Script {
    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
    );
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant USDE = 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant USDE_VAULT = 0x92570f0D10CC39ACb80B630611a18bA091687337;
    address constant USDG_VAULT = 0xEA9C8BBEc3680c481100668410702564F468E6fb;
    address constant WHALE = 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010;
    address constant ADMIN = 0x1c033347CF32322c7a8F7E60A3b1CAce4222b4D8;
    address constant TREASURY = 0x94AE9Ed56FBD3F97f6745BEa5c61dd4C92D56ae8;
    address constant DEPLOYER = address(uint160(0xD3110));
    address constant USER = address(uint160(0x1111));

    function run() external {
        // ---- deploy (as DEPLOYER) ----
        vm.startBroadcast(DEPLOYER);
        bytes memory code = type(DualPoolHook).creationCode;
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = keccak256(code);
        AllowlistedFactory factory = new AllowlistedFactory(hashes);
        address predicted = vm.computeCreateAddress(DEPLOYER, vm.getNonce(DEPLOYER) + 1);
        bytes memory args = abi.encode(IPoolManager(POOL_MANAGER), uint32(800_000), predicted, uint64(3_600));
        (, bytes32 salt) = HookMiner.find(address(factory), HOOK_FLAGS, code, args);
        DualPoolHook hook = DualPoolHook(factory.deploy(code, args, salt));
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(USDE),
            currency1: Currency.wrap(USDG),
            fee: 500,
            tickSpacing: 10,
            hooks: IHooks(address(hook))
        });
        YieldPilotHoodVaultV2 wrapper = new YieldPilotHoodVaultV2(hook, key, ADMIN, TREASURY);
        require(address(wrapper) == predicted, "prediction failed");
        vm.stopBroadcast();

        // ---- fund actors from the real Morpho whale (fork only) ----
        vm.startBroadcast(WHALE);
        IERC20(USDE).transfer(ADMIN, 15e18);
        IERC20(USDG).transfer(ADMIN, 16e6);
        IERC20(USDE).transfer(USER, 40e18);
        IERC20(USDG).transfer(USER, 40e6);
        vm.stopBroadcast();

        // ---- admin: init pool + bootstrap ----
        LiquidityBucket[] memory buckets = new LiquidityBucket[](1);
        buckets[0] = LiquidityBucket({tickLower: -600000, tickUpper: 600000, weightBps: 10000});
        DualPoolHook.PoolConfig memory cfg = DualPoolHook.PoolConfig({
            sqrtPriceX96: 79228162514264337593543,
            distribution: buckets,
            allowExternalDeposits: true,
            vault0: IERC4626(USDE_VAULT),
            vault1: IERC4626(USDG_VAULT),
            minDepositBlocks: 0
        });
        vm.startBroadcast(ADMIN);
        wrapper.initializePool(cfg);
        IERC20(USDE).approve(address(wrapper), type(uint256).max);
        IERC20(USDG).approve(address(wrapper), type(uint256).max);
        wrapper.bootstrap(15e18, 16e6);
        vm.stopBroadcast();

        console2.log("WRAPPER=", address(wrapper));
        console2.log("HOOK=", address(hook));
        console2.log("admin shares:", wrapper.userShares(ADMIN));
        console2.log("admin costBasis (18dec USD):", wrapper.costBasis(ADMIN));

        // ---- user deposits ~100% of the pool ----
        (uint256 r0, uint256 r1) = hook.getReserves(key);
        uint256 hookShares = hook.sharesOf(key, address(wrapper));
        uint256 want = hookShares; // 100% of pool
        vm.startBroadcast(USER);
        IERC20(USDE).approve(address(wrapper), type(uint256).max);
        IERC20(USDG).approve(address(wrapper), type(uint256).max);
        uint256 minted = wrapper.deposit(want, (r0 * 11) / 10, (r1 * 11) / 10, block.timestamp + 3600);
        vm.stopBroadcast();

        console2.log("user minted wrapper shares:", minted);
        console2.log("user costBasis (18dec USD):", wrapper.costBasis(USER));
        console2.log("share fairness: admin shares == user shares?", wrapper.userShares(ADMIN) == wrapper.userShares(USER));
        console2.log("admin shares:", wrapper.userShares(ADMIN));
        console2.log("user shares: ", wrapper.userShares(USER));
    }
}
