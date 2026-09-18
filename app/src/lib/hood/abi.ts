// Minimal ABI fragments -- only what the frontend actually calls. Full source lives in
// hood-chain/reference/YieldPilotHoodVault.sol and the dryrun DualPoolHook copy.

export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

export const hoodVaultAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "sharesToMint", type: "uint256" },
      { name: "maxAmount0", type: "uint256" },
      { name: "maxAmount1", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "minted", type: "uint256" }],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "sharesToBurn", type: "uint256" },
      { name: "minAmount0", type: "uint256" },
      { name: "minAmount1", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [
      { name: "netAmount0", type: "uint256" },
      { name: "netAmount1", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "userShares",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "totalShares",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "whitelist",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "bootstrapped",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "previewUserHookShares",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const hookAbi = [
  {
    type: "function",
    name: "getReserves",
    stateMutability: "view",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
    ],
    outputs: [
      { name: "token0", type: "uint256" },
      { name: "token1", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "sharesOf",
    stateMutability: "view",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "user", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;
