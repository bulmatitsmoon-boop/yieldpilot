#!/usr/bin/env ts-node
/**
 * test_solend_deposit_retry.ts — retest deployToSolend with a tiny, deliberately
 * buffer-safe amount (0.01 USDC), calling the Anchor method directly (not via
 * sendWithRetry, which swallows errors) so we get the full raw error/logs after
 * fresh code-level re-verification found no discrepancy against Solend's real
 * source and live on-chain account state.
 *
 * Usage: RPC_URL=... KEEPER_KEYPAIR_PATH=... PROGRAM_ID=... IDL_PATH=... ts-node test_solend_deposit_retry.ts
 */
import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SolanaClient } from "../solanaClient";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SOLEND_PROGRAM = new PublicKey("So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo");
const SOLEND_MAIN_MARKET = new PublicKey("4UpD2fh7xH3VP9QQaXtsS1YY3bxzWhtfpks7FatyKvdY");
const SOLEND_USDC_RESERVE = new PublicKey("BgxfHJDzm44T7XG68MYKx7YisTjZu73tVovyZSjJMpmw");
const SOLEND_USDC_LIQUIDITY_SUPPLY = new PublicKey("8SheGtsopRUDzdiD6v6BR9a6bqZ9QwywYQY99Fp5meNf");
const SOLEND_USDC_COLLATERAL_MINT = new PublicKey("993dVFL2uXWYeoXuEBFXR4BijeXdTv4s6BzsCjJZuwqk");
const SOLEND_USDC_ORACLE = new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX");
const SOLEND_NULL_ORACLE = new PublicKey("nu11111111111111111111111111111111111111111");

async function main() {
  const client = new SolanaClient();
  const usdcVault = "5heGDKagzMLe9tEvLBBwPjURRzrSxENywAJifm3pRifC";
  const vaultPubkey = new PublicKey(usdcVault);

  const vault = await client.fetchVault(usdcVault);
  const solendIdx = (vault.protocols as any[]).findIndex((p: any) => Buffer.from(p.label).toString().startsWith("solend-usdc"));
  if (solendIdx === -1) throw new Error("solend-usdc protocol not registered on this vault");

  const vaultAuthority = client.getVaultAuthority(vaultPubkey, vault.authorityBump);
  const vaultCollateralAccount = getAssociatedTokenAddressSync(SOLEND_USDC_COLLATERAL_MINT, vaultAuthority, true);
  const [lendingMarketAuthority] = PublicKey.findProgramAddressSync(
    [SOLEND_MAIN_MARKET.toBuffer()],
    SOLEND_PROGRAM
  );
  console.log("Derived lendingMarketAuthority:", lendingMarketAuthority.toBase58());

  console.log("Deploying 10,000 (0.01 USDC) to Solend directly (raw call, no retry-swallow)...");
  try {
    const sig = await client.program.methods
      .deployToSolend(solendIdx, new anchor.BN(10_000))
      .accounts({
        keeper: client.keeper.publicKey,
        vault: vaultPubkey,
        vaultAuthority,
        vaultTokenAccount: vault.vaultTokenAccount,
        vaultCollateralAccount,
        reserve: SOLEND_USDC_RESERVE,
        reserveLiquiditySupply: SOLEND_USDC_LIQUIDITY_SUPPLY,
        reserveCollateralMint: SOLEND_USDC_COLLATERAL_MINT,
        lendingMarket: SOLEND_MAIN_MARKET,
        lendingMarketAuthority,
        pythOracle: SOLEND_USDC_ORACLE,
        switchboardOracle: SOLEND_NULL_ORACLE,
        tokenProgram: TOKEN_PROGRAM_ID,
        solendProgram: SOLEND_PROGRAM,
      })
      .rpc({ commitment: "confirmed" });
    console.log("SUCCESS. deployToSolend tx:", sig);
  } catch (err: any) {
    console.error("FAILED:", err.message ?? err);
    if (err.logs) {
      console.error("=== FULL LOGS ===");
      console.error(err.logs.join("\n"));
    }
    throw err;
  }
}

main().catch(() => process.exit(1));
