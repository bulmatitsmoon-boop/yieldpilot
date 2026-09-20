// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {HookMiner} from "../src/utils/HookMiner.sol";
import {AllowlistedFactory} from "../src/AllowlistedFactory.sol";
import {DualPoolHook} from "../src/alf/DualPoolHook.sol";
import {YieldPilotHoodVaultV2} from "../src/wrapper/YieldPilotHoodVaultV2.sol";

/// @notice REAL Robinhood Chain mainnet deploy of the V2 stack (profit-only fee + share-mint fix):
///         a fresh AllowlistedFactory + a fresh DualPoolHook (owned by the V2 wrapper's predicted
///         address) + the V2 wrapper, in ONE script so the creation-code hash the factory pins is
///         the exact one used to deploy (cross-invocation hash drift bit us on V1). Infrastructure
///         only -- no pool initialised, no funds moved. Reuses the already-live USDe/USDG VaultV2s.
contract DeployRealMainnetV2 is Script {
    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
    );

    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant USDE = 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34;
    address constant REAL_ADMIN = 0x1c033347CF32322c7a8F7E60A3b1CAce4222b4D8;
    address constant REAL_TREASURY = 0x94AE9Ed56FBD3F97f6745BEa5c61dd4C92D56ae8;

    function run() external returns (AllowlistedFactory factory, DualPoolHook hook, YieldPilotHoodVaultV2 wrapper) {
        address deployer = msg.sender;

        vm.startBroadcast();

        bytes memory hookCreationCode = type(DualPoolHook).creationCode;
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = keccak256(hookCreationCode);
        factory = new AllowlistedFactory(hashes);
        console2.log("factory deployed at:", address(factory));

        uint256 nonceAfterHook = vm.getNonce(deployer) + 1;
        address predictedWrapper = vm.computeCreateAddress(deployer, nonceAfterHook);
        console2.log("predicted wrapper address:", predictedWrapper);

        bytes memory constructorArgs =
            abi.encode(IPoolManager(POOL_MANAGER), uint32(800_000), predictedWrapper, uint64(3_600));
        (address expectedHook, bytes32 salt) = HookMiner.find(address(factory), HOOK_FLAGS, hookCreationCode, constructorArgs);
        hook = DualPoolHook(factory.deploy(hookCreationCode, constructorArgs, salt));
        require(address(hook) == expectedHook, "hook address mismatch");
        require(hook.owner() == predictedWrapper, "hook owner not wrapper (nonce math wrong)");
        console2.log("hook deployed at:", address(hook));

        bool usdgFirst = USDG < USDE;
        PoolKey memory key = PoolKey({
            currency0: usdgFirst ? Currency.wrap(USDG) : Currency.wrap(USDE),
            currency1: usdgFirst ? Currency.wrap(USDE) : Currency.wrap(USDG),
            fee: 500,
            tickSpacing: 10,
            hooks: IHooks(address(hook))
        });

        wrapper = new YieldPilotHoodVaultV2(hook, key, REAL_ADMIN, REAL_TREASURY);
        require(address(wrapper) == predictedWrapper, "wrapper address prediction failed");
        require(hook.factory() == address(factory), "hook.factory() mismatch");
        require(address(wrapper.hook()) == address(hook), "wrapper.hook() mismatch");
        require(wrapper.admin() == REAL_ADMIN, "wrapper admin mismatch");
        require(wrapper.treasury() == REAL_TREASURY, "wrapper treasury mismatch");

        vm.stopBroadcast();

        console2.log("wrapper V2 deployed at:", address(wrapper));
        console2.log("scale0 (USDe):", wrapper.scale0());
        console2.log("scale1 (USDG):", wrapper.scale1());
    }
}
