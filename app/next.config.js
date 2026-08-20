/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_RPC_URL: process.env.NEXT_PUBLIC_RPC_URL || 'https://yieldpilot-chi.vercel.app/api/rpc',
    NEXT_PUBLIC_SOLANA_NETWORK: process.env.NEXT_PUBLIC_SOLANA_NETWORK || 'devnet',
    NEXT_PUBLIC_PROGRAM_ID: process.env.NEXT_PUBLIC_PROGRAM_ID || '8c7Boyk91MWkn5jabf5CnYD8DrG6p4hYm9eDdAAWXEKH',
    NEXT_PUBLIC_VAULT_ADDRESSES: process.env.NEXT_PUBLIC_VAULT_ADDRESSES || '8KcoRt5DcCbXBaqDVDorEbW2J6GofTrRyy9Afzb8wwaE',
    NEXT_PUBLIC_ADMIN_WALLET: process.env.NEXT_PUBLIC_ADMIN_WALLET || '8i7kydJHwi3Cdp46Xugyux2vWJmTScYDvnJrBiBihBnP',
  },
  reactStrictMode: true,
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      os: false,
      path: false,
      crypto: false,
    };
    // Required for @orca-so/whirlpools-core (WASM-based, used by the LP
    // vault's liquidity-quote math — see useLpVault.ts). Not yet build-
    // tested; this is the standard webpack 5 flag for wasm-pack's browser
    // target, but flagging it as unverified rather than assuming it's
    // sufficient on its own.
    config.experiments = { ...config.experiments, asyncWebAssembly: true, layers: true };
    return config;
  },
};

module.exports = nextConfig;
