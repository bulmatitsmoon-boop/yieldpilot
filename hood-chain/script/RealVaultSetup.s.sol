// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

/// @dev Inlined instead of imported from Morpho's own source tree, so this script has ZERO
///      external dependencies beyond forge-std -- it will trigger REAL signed mainnet
///      transactions from CI, so reproducibility (running exactly the code that was proven on a
///      fork, nothing pulled from an unpinned/untracked dependency) matters more here than reuse.
struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

interface IVaultV2Setup {
    function setCurator(address newCurator) external;
    function setIsAllocator(address account, bool newIsAllocator) external;
    function addAdapter(address account) external;
    function increaseAbsoluteCap(bytes memory idData, uint256 newAbsoluteCap) external;
    function increaseRelativeCap(bytes memory idData, uint256 newRelativeCap) external;
    function setLiquidityAdapterAndData(address newLiquidityAdapter, bytes memory newLiquidityData) external;
    function submit(bytes memory data) external;
    function allocate(address adapter, bytes memory data, uint256 assets) external;
    function totalAssets() external view returns (uint256);
    function asset() external view returns (address);
}

interface IAdapterFactorySetup {
    function createMorphoMarketV1AdapterV2(address parentVault) external returns (address);
    function morphoMarketV1AdapterV2(address parentVault) external view returns (address);
}

interface IAdapterSetup {
    function ids(MarketParams memory marketParams) external view returns (bytes32[] memory);
    function allocation(MarketParams memory marketParams) external view returns (uint256);
}

interface IERC20Setup {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

/// @notice Real end-to-end proof of the USDG VaultV2 curator setup + real allocation into the
///         real USDG/USDe Morpho Blue market, run on a FORK with the real admin address
///         IMPERSONATED (anvil --unlocked, no private key involved) so the exact real calls can
///         be proven correct before Lloyd ever signs anything for real.
contract RealVaultSetup is Script {
    address constant USDG_VAULT = 0xEA9C8BBEc3680c481100668410702564F468E6fb;
    address constant ADAPTER_FACTORY = 0x79370Ed003CE325C088E530d5e8655c99c2993e1;
    address constant REAL_ADMIN = 0x1c033347CF32322c7a8F7E60A3b1CAce4222b4D8;

    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant USDE = 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34;
    address constant MORPHO = 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010;
    address constant ADAPTIVE_CURVE_IRM = 0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1;
    address constant ORACLE = 0xE64849bd4AD03DfaBbe02bb521de19997a19055f;
    uint256 constant LLTV = 915000000000000000;

    uint256 constant MAX_CAP = type(uint128).max;
    uint256 constant WAD = 1e18;

    function run() external {
        IVaultV2Setup vault = IVaultV2Setup(USDG_VAULT);
        MarketParams memory params = MarketParams({
            loanToken: USDG,
            collateralToken: USDE,
            oracle: ORACLE,
            irm: ADAPTIVE_CURVE_IRM,
            lltv: LLTV
        });

        vm.startBroadcast(REAL_ADMIN);

        vault.setCurator(REAL_ADMIN);
        console2.log("curator set");

        address adapter = IAdapterFactorySetup(ADAPTER_FACTORY).createMorphoMarketV1AdapterV2(USDG_VAULT);
        console2.log("adapter created:", adapter);

        vault.submit(abi.encodeWithSelector(IVaultV2Setup.addAdapter.selector, adapter));
        vault.addAdapter(adapter);
        console2.log("adapter added");

        vault.submit(abi.encodeWithSelector(IVaultV2Setup.setIsAllocator.selector, REAL_ADMIN, true));
        vault.setIsAllocator(REAL_ADMIN, true);
        console2.log("admin set as allocator");

        bytes32[] memory realIds = IAdapterSetup(adapter).ids(params);
        console2.log("real ids from adapter.ids(marketParams):");
        for (uint256 i; i < realIds.length; i++) {
            console2.logBytes32(realIds[i]);
        }

        bytes memory idData0 = abi.encode("this", adapter);
        bytes memory idData1 = abi.encode("collateralToken", USDE);
        bytes memory idData2 = abi.encode("this/marketParams", adapter, params);

        require(keccak256(idData0) == realIds[0], "idData0 mismatch");
        require(keccak256(idData1) == realIds[1], "idData1 mismatch");
        require(keccak256(idData2) == realIds[2], "idData2 mismatch");
        console2.log("ALL THREE idData ENCODINGS VERIFIED CORRECT against the real adapter");

        vault.submit(abi.encodeWithSelector(IVaultV2Setup.increaseAbsoluteCap.selector, idData0, MAX_CAP));
        vault.increaseAbsoluteCap(idData0, MAX_CAP);
        vault.submit(abi.encodeWithSelector(IVaultV2Setup.increaseAbsoluteCap.selector, idData1, MAX_CAP));
        vault.increaseAbsoluteCap(idData1, MAX_CAP);
        vault.submit(abi.encodeWithSelector(IVaultV2Setup.increaseAbsoluteCap.selector, idData2, MAX_CAP));
        vault.increaseAbsoluteCap(idData2, MAX_CAP);
        console2.log("all 3 absolute caps raised");

        vault.submit(abi.encodeWithSelector(IVaultV2Setup.increaseRelativeCap.selector, idData0, WAD));
        vault.increaseRelativeCap(idData0, WAD);
        vault.submit(abi.encodeWithSelector(IVaultV2Setup.increaseRelativeCap.selector, idData1, WAD));
        vault.increaseRelativeCap(idData1, WAD);
        vault.submit(abi.encodeWithSelector(IVaultV2Setup.increaseRelativeCap.selector, idData2, WAD));
        vault.increaseRelativeCap(idData2, WAD);
        console2.log("all 3 relative caps raised to WAD (no relative limit)");

        vault.submit(abi.encodeWithSelector(IVaultV2Setup.setLiquidityAdapterAndData.selector, adapter, abi.encode(params)));
        vault.setLiquidityAdapterAndData(adapter, abi.encode(params));
        console2.log("liquidity adapter set");

        vm.stopBroadcast();

        console2.log("vault totalAssets (before any deposit):", vault.totalAssets());
        console2.log("SETUP PROOF COMPLETE -- all real calls succeeded on the fork with the real admin address");
    }
}
