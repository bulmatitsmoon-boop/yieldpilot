// Robinhood Chain mainnet -- ETH/USDG Uniswap v3 (0.05%) LP vault. Verified on-chain after
// deploy, not guessed. See hood-chain/lp/ at the repo root for the contract + deploy script.
//
// EXPERIMENTAL: single pool, small deposit cap, admin cannot withdraw user funds, a bot
// (the "keeper") runs the only two admin-gated actions (rebalance / compound) on a schedule
// and only when the contract's own rules say one is due -- see the contract's `maintain()`.

export const LP_VAULT_ADDRESS = "0x3f708457Eaf5E50aDD393568c9E09fE7AD009842" as const;
export const LP_POOL_ADDRESS = "0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a" as const; // WETH/USDG 0.05%
export const LP_KEEPER_ADDRESS = "0xc7254227754f196f08D4d5691766AeD3fCECfFBC" as const;
export const LP_FEE_BPS = 900; // 9%, PROFIT ONLY (cost-basis accounting)
