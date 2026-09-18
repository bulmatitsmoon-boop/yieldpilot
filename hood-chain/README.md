# YieldPilot on Robinhood Chain

Robinhood Chain (Arbitrum-style L2, chain ID 4663 mainnet / 46630 testnet) side of YieldPilot,
separate from and independent of the Solana program in the rest of this repo — same brand, no
shared admin keys, no cross-chain control (deliberate decision).

## Live real contracts, Robinhood Chain mainnet

- Our `AllowlistedFactory`: `0xe92d417C82f2c217757E1cAc38d32c8d06250334`
- Our `DualPoolHook` (Uniswap v4, owned by the wrapper below): `0x22e255a8f28B8c4c5b663e42eac1D38C3da7EAC0`
- `YieldPilotHoodVault` (`reference/YieldPilotHoodVault.sol`): `0x4f118199c64e253B59245CB976A0017F08A35A52`
  - `admin`: the real admin wallet (see repo secrets, never hardcoded here)
  - `treasury`: the real treasury wallet, distinct from admin
  - Non-upgradeable by deliberate decision — a compromised admin key can only call fixed
    admin-gated functions (whitelist, treasury, pause), never replace contract logic
- Real Morpho VaultV2 for USDG: `0xEA9C8BBEc3680c481100668410702564F468E6fb`
- Real Morpho VaultV2 for USDe: `0x92570f0D10CC39ACb80B630611a18bA091687337` (currently idle — no
  real Morpho market exists yet with USDe as the loan asset on this chain)

`reference/YieldPilotHoodVault.sol` is committed for reference/audit — it needs the full
Uniswap v4-core + OpenZeppelin dependency tree to actually recompile, which this lightweight repo
folder does not vendor. Its bytecode is already live at the address above; this file is not
re-deployed by anything in this folder.

## `script/RealVaultSetup.s.sol`

Deliberately **self-contained** (only depends on `forge-std`, nothing else) so it always runs
exactly the code that was proven on a mainnet fork before ever touching a real key — no
unpinned/untracked dependency can silently change what a CI-triggered real transaction does.

Performs, against the real USDG VaultV2 above: `setCurator` -> create the real Morpho adapter ->
`addAdapter` -> `setIsAllocator` -> raise all 3 real caps (verified against the adapter's own
`ids()` output) -> `setLiquidityAdapterAndData`. All of VaultV2's curator-function timelocks are 0
by default (checked directly in Morpho's source), so submit+execute land in the same run.

Triggered via the `hood-vault-setup.yml` workflow (`workflow_dispatch`), signed with the
`HOOD_ADMIN_KEY` repository secret — never pasted into chat or held by Claude directly.
