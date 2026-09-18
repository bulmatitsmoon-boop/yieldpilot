// Real, live contracts on Robinhood Chain mainnet — verified on-chain, not guessed.
// See the "hood-chain" folder at the repo root for the deploy scripts that produced these.

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const ROBINHOOD_EXPLORER_URL = "https://robinhoodchain.blockscout.com";

export const ROBINHOOD_CHAIN_PARAMS = {
  chainId: `0x${ROBINHOOD_CHAIN_ID.toString(16)}`,
  chainName: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: [ROBINHOOD_RPC_URL],
  blockExplorerUrls: [ROBINHOOD_EXPLORER_URL],
} as const;

export const HOOD_WRAPPER_ADDRESS = "0x4f118199c64e253B59245CB976A0017F08A35A52" as const;
export const HOOK_ADDRESS = "0x22e255a8f28B8c4c5b663e42eac1D38C3da7EAC0" as const;
export const HOOD_ADMIN_ADDRESS = "0x1c033347CF32322c7a8F7E60A3b1CAce4222b4D8" as const;
export const HOOD_TREASURY_ADDRESS = "0x94AE9Ed56FBD3F97f6745BEa5c61dd4C92D56ae8" as const;

export const USDE_ADDRESS = "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34" as const;
export const USDG_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;

// Pool key -- fixed at deploy time. currency0/currency1 are address-sorted, NOT in "deposit
// order" -- USDe happens to sort below USDG, so currency0=USDe, currency1=USDG.
export const POOL_KEY = {
  currency0: USDE_ADDRESS,
  currency1: USDG_ADDRESS,
  fee: 500,
  tickSpacing: 10,
  hooks: HOOK_ADDRESS,
} as const;

export const TOKEN_META = {
  [USDE_ADDRESS]: { symbol: "USDe", decimals: 18 },
  [USDG_ADDRESS]: { symbol: "USDG", decimals: 6 },
} as const;
