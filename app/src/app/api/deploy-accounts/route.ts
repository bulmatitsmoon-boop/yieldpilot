import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";

// Single source of truth for the protocol-specific accounts needed to build a
// deploy_to_* instruction client-side. Mirrors api/recall-accounts/route.ts exactly
// (same constants, same protocol-decoding approach) — kept as a separate route because
// deploy_to_* and recall_from_* take different account shapes for the same protocol,
// not because the underlying addresses differ. If you rotate any of these addresses,
// update BOTH this file, recall-accounts/route.ts, and keeper/src/solanaClient.ts.
//
// Used by the deposit flow (app/src/hooks/useYieldPilot.ts) to bundle a trailing
// deploy_to_<protocol> instruction after deposit() in the same transaction — see the
// paired-deposit change in programs/yieldpilot/src/lib.rs (any signer may call
// deploy_to_* as long as a matching deposit() call for the same user sits elsewhere
// in the same transaction). This is what makes a deposit land directly in the earning
// protocol with zero idle time, instead of waiting on the next keeper cron cycle.

const RPC_TARGET = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM = "1".repeat(32);
const SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111";

// ── Kamino ───────────────────────────────────────────────────────────────────
const KAMINO_PROGRAM_ID = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const KAMINO_MAIN_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const KAMINO_MARKET_AUTHORITY = "9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const KAMINO_USDC_RESERVE = "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59";
const KAMINO_USDC_LIQUIDITY_SUPPLY = "Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6";
const KAMINO_USDC_COLLATERAL_MINT = "B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D";
const KAMINO_SOL_RESERVE = "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q";
const KAMINO_SOL_LIQUIDITY_SUPPLY = "GafNuUXj9rxGLn4y79dPu6MHSuPWeJR6UtTWuexpGh3U";
const KAMINO_SOL_COLLATERAL_MINT = "2UywZrUdyqs5vDchy7fKQJKau2RVyuzBev2XKGPDSiX1";
const KAMINO_SCOPE_PRICES = "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH";

// ── Marinade ─────────────────────────────────────────────────────────────────
const MARINADE_PROGRAM = "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD";
const MARINADE_STATE = "8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC";
const MSOL_MINT = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
const MARINADE_LIQ_POOL_SOL_LEG = "UefNb6z6yvArqe4cJHTXCqStRsKmWhGxnZzuHbikP5Q";
const MARINADE_LIQ_POOL_MSOL_LEG = "7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE";
const MARINADE_LIQ_POOL_MSOL_AUTH = "EyaSjUtSgo9aRD1f8LWXwdvkpDTmXAW54yoSHZRF14WL";
const MARINADE_RESERVE_PDA = "Du3Ysj1wKbxPKkuPPnvzQLQh8oMSVifs3jGZjJWXFmHN";
const MARINADE_MSOL_MINT_AUTH = "3JLPCS1qM2zRw3Dp6V4hZnYHd4toMNPkNesXdX9tg6KM";

// ── SPL Stake Pools (Jito, PSOL) ─────────────────────────────────────────────
const SPL_STAKE_POOL_PROGRAM = "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy";
const JITO_POOL = "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb";
const JITOSOL_MINT = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const PSOL_POOL = "pSPcvR8GmG9aKDUbn9nbKYjkxt9hxMS7kF1qqKJaPqJ";
const PSOL_MINT = "pSo1f9nQXWgXibFtKf7NWYxb5enAM4qfP6UJSiXRQfL";
const SPL_STAKE_POOLS: Record<string, { pool: string; mint: string }> = {
  "jito-sol": { pool: JITO_POOL, mint: JITOSOL_MINT },
  "psol-sol": { pool: PSOL_POOL, mint: PSOL_MINT },
};

// ── Solend ───────────────────────────────────────────────────────────────────
const SOLEND_PROGRAM = "So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo";
const SOLEND_MAIN_MARKET = "4UpD2fh7xH3VP9QQaXtsS1YY3bxzWhtfpks7FatyKvdY";
const SOLEND_USDC_RESERVE = "BgxfHJDzm44T7XG68MYKx7YisTjZu73tVovyZSjJMpmw";
const SOLEND_USDC_LIQUIDITY_SUPPLY = "8SheGtsopRUDzdiD6v6BR9a6bqZ9QwywYQY99Fp5meNf";
const SOLEND_USDC_COLLATERAL_MINT = "993dVFL2uXWYeoXuEBFXR4BijeXdTv4s6BzsCjJZuwqk";
const SOLEND_USDC_ORACLE = "Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX";
const SOLEND_NULL_ORACLE = "nu11111111111111111111111111111111111111111";

export async function GET(req: NextRequest) {
  const label = req.nextUrl.searchParams.get("label");
  if (!label) {
    return NextResponse.json({ error: "missing ?label=" }, { status: 400 });
  }

  try {
    if (label === "kamino-usdc" || label === "kamino-sol") {
      const isSol = label === "kamino-sol";
      return NextResponse.json({
        instructionName: "deployToKamino",
        accounts: {
          kaminoReserve: isSol ? KAMINO_SOL_RESERVE : KAMINO_USDC_RESERVE,
          kaminoLendingMarket: KAMINO_MAIN_MARKET,
          kaminoMarketAuthority: KAMINO_MARKET_AUTHORITY,
          kaminoLiquidityMint: isSol ? WSOL_MINT : USDC_MINT,
          kaminoLiquiditySupply: isSol ? KAMINO_SOL_LIQUIDITY_SUPPLY : KAMINO_USDC_LIQUIDITY_SUPPLY,
          kaminoCollateralMint: isSol ? KAMINO_SOL_COLLATERAL_MINT : KAMINO_USDC_COLLATERAL_MINT,
          tokenProgram: TOKEN_PROGRAM,
          instructionSysvar: SYSVAR_INSTRUCTIONS,
          kaminoProgram: KAMINO_PROGRAM_ID,
        },
        // Kamino's RefreshReserve CPI needs these as remaining accounts — mirrors the
        // keeper's own default (see solanaClient.ts).
        remainingAccounts: [KAMINO_PROGRAM_ID, KAMINO_PROGRAM_ID, KAMINO_PROGRAM_ID, KAMINO_SCOPE_PRICES],
      });
    }

    if (label === "marinade-sol") {
      return NextResponse.json({
        instructionName: "deployToMarinade",
        accounts: {
          wsolMint: WSOL_MINT,
          marinadeState: MARINADE_STATE,
          msolMint: MSOL_MINT,
          liqPoolSolLeg: MARINADE_LIQ_POOL_SOL_LEG,
          liqPoolMsolLeg: MARINADE_LIQ_POOL_MSOL_LEG,
          liqPoolMsolLegAuthority: MARINADE_LIQ_POOL_MSOL_AUTH,
          reservePda: MARINADE_RESERVE_PDA,
          msolMintAuthority: MARINADE_MSOL_MINT_AUTH,
          systemProgram: SYSTEM_PROGRAM,
          tokenProgram: TOKEN_PROGRAM,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM,
          marinadeProgram: MARINADE_PROGRAM,
        },
      });
    }

    if (label in SPL_STAKE_POOLS) {
      // Same live-decode approach as recall-accounts — reserve_stake and
      // manager_fee_account live inside the pool's own account data, no fixed constant.
      const { pool, mint } = SPL_STAKE_POOLS[label];
      const connection = new Connection(RPC_TARGET);
      const poolInfo = await connection.getAccountInfo(new PublicKey(pool));
      if (!poolInfo || poolInfo.data.length < 226) {
        return NextResponse.json({ error: `Could not fetch/decode ${label} stake pool account` }, { status: 502 });
      }
      const reserveStake = new PublicKey(poolInfo.data.slice(130, 162)).toBase58();
      const managerFeeAccount = new PublicKey(poolInfo.data.slice(194, 226)).toBase58();
      const [withdrawAuthority] = PublicKey.findProgramAddressSync(
        [new PublicKey(pool).toBuffer(), Buffer.from("withdraw")],
        new PublicKey(SPL_STAKE_POOL_PROGRAM)
      );
      return NextResponse.json({
        instructionName: "deployToSolLst",
        accounts: {
          stakePool: pool,
          withdrawAuthority: withdrawAuthority.toBase58(),
          reserveStake,
          managerFeeAccount,
          poolMint: mint,
          wsolMint: WSOL_MINT,
          stakePoolProgram: SPL_STAKE_POOL_PROGRAM,
          systemProgram: SYSTEM_PROGRAM,
          tokenProgram: TOKEN_PROGRAM,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM,
        },
      });
    }

    if (label === "solend-usdc") {
      const [lendingMarketAuthority] = PublicKey.findProgramAddressSync(
        [new PublicKey(SOLEND_MAIN_MARKET).toBuffer()],
        new PublicKey(SOLEND_PROGRAM)
      );
      return NextResponse.json({
        instructionName: "deployToSolend",
        accounts: {
          reserve: SOLEND_USDC_RESERVE,
          reserveCollateralMint: SOLEND_USDC_COLLATERAL_MINT,
          reserveLiquiditySupply: SOLEND_USDC_LIQUIDITY_SUPPLY,
          lendingMarket: SOLEND_MAIN_MARKET,
          lendingMarketAuthority: lendingMarketAuthority.toBase58(),
          pythOracle: SOLEND_USDC_ORACLE,
          switchboardOracle: SOLEND_NULL_ORACLE,
          tokenProgram: TOKEN_PROGRAM,
          solendProgram: SOLEND_PROGRAM,
        },
      });
    }

    return NextResponse.json({ error: `Unknown protocol label: ${label}` }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || String(err) }, { status: 500 });
  }
}
