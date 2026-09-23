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
  // Fixes a REAL bug found live 2026-09-23 (reproduced locally with `next start` before
  // this fix, not guessed): the two LP quote API routes (api/lp-deposit-quote,
  // api/lp-withdraw-quote) call @orca-so/whirlpools-core, a WASM package, from a server
  // route. Webpack's asyncWebAssembly handling only ever emitted the .wasm binary into
  // .next/static/wasm/ (the CLIENT asset path) even for this server-side import — it
  // never wrote it into .next/server/chunks/ at all, confirmed by listing the actual
  // build output — so the deployed function threw ENOENT looking for a file that
  // genuinely doesn't exist anywhere in the server bundle. This isn't a Vercel file-
  // tracing gap (tried outputFileTracingIncludes first; had no effect, since the file
  // was missing before tracing even runs).
  //
  // The real fix: exclude this package from webpack's server bundle entirely via
  // serverExternalPackages, so Node's own `require()` loads it directly from
  // node_modules at runtime using its "main" (dist/nodejs) build, which does a plain
  // fs.readFileSync for its wasm file -- a pattern Vercel's tracer handles natively,
  // with no webpack chunk system involved at all.
  serverExternalPackages: ["@orca-so/whirlpools-core"],
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
