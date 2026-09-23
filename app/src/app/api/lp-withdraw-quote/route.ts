import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import IDL from "@/idl/yieldpilot.mainnet.json";

/**
 * Server-side LP withdraw quote — same reasoning as lp-deposit-quote/route.ts (Hermes has
 * no WebAssembly support, so Orca's WASM quote math can't run on-device in the Yield
 * Wallet app). Mirrors useLpVault.ts's getWithdrawQuote / getRaydiumWithdrawQuote exactly,
 * including the idleA/idleB pro-rata addition documented there (the deployed-position
 * quote alone undercounts what a real withdraw pays out).
 *
 * GET /api/lp-withdraw-quote?lpVault=<address>&shares=<raw>&slippageBps=<bps>
 * -> { tokenMinA, tokenMinB, idleA, idleB } as decimal strings
 */
const RPC_TARGET = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";

function readU128LE(data: Buffer, offset: number): bigint {
  const low = data.readBigUInt64LE(offset);
  const high = data.readBigUInt64LE(offset + 8);
  return (high << 64n) | low;
}
function decodeWhirlpoolSqrtPrice(data: Buffer): bigint {
  return readU128LE(data, 65);
}
function decodeRaydiumSqrtPriceX64(data: Buffer): bigint {
  return readU128LE(data, 253);
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const lpVaultAddress = searchParams.get("lpVault");
    const sharesStr = searchParams.get("shares");
    const slippageBps = Number(searchParams.get("slippageBps") ?? "100");
    if (!lpVaultAddress || !sharesStr) {
      return NextResponse.json({ error: "lpVault and shares are required" }, { status: 400 });
    }

    const connection = new Connection(RPC_TARGET, "confirmed");
    const provider = new anchor.AnchorProvider(
      connection,
      { publicKey: PublicKey.default, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any,
      { commitment: "confirmed" }
    );
    const program = new anchor.Program(IDL as any, provider);
    const raw: any = await (program.account as any)["lpVault"].fetch(new PublicKey(lpVaultAddress));
    const shares = new anchor.BN(sharesStr);
    const tickLowerIndex = raw.tickLowerIndex as number;
    const tickUpperIndex = raw.tickUpperIndex as number;
    const totalShares: anchor.BN = raw.totalShares;
    if (totalShares.isZero()) {
      return NextResponse.json({ error: "Vault has no shares outstanding" }, { status: 400 });
    }
    const isRaydium = "raydium" in (raw.protocol as object);

    const poolAccountInfo = await connection.getAccountInfo(raw.pool as PublicKey);
    if (!poolAccountInfo) {
      return NextResponse.json({ error: "Pool account not found" }, { status: 404 });
    }

    let tokenMinA: string, tokenMinB: string;

    if (isRaydium) {
      const totalLiquidity: anchor.BN = raw.totalLiquidity;
      const liquidityDelta = shares.mul(totalLiquidity).div(totalShares);
      const { LiquidityMathUtil, TickUtil } = await import("@raydium-io/raydium-sdk-v2");
      const sqrtPriceCurrentX64 = new anchor.BN(decodeRaydiumSqrtPriceX64(poolAccountInfo.data).toString());
      const sqrtPriceLowerX64 = TickUtil.getSqrtPriceAtTick(tickLowerIndex);
      const sqrtPriceUpperX64 = TickUtil.getSqrtPriceAtTick(tickUpperIndex);
      const slippage = slippageBps / 10_000;
      const { amountSlippageA, amountSlippageB } = LiquidityMathUtil.getAmountsFromLiquidityWithSlippage(
        sqrtPriceCurrentX64, sqrtPriceLowerX64, sqrtPriceUpperX64, liquidityDelta, false, false, slippage
      );
      tokenMinA = amountSlippageA.toString();
      tokenMinB = amountSlippageB.toString();
    } else {
      const totalLiquidity = BigInt((raw.totalLiquidity as anchor.BN).toString());
      const totalSharesBig = BigInt(totalShares.toString());
      const liquidityDelta = (BigInt(shares.toString()) * totalLiquidity) / totalSharesBig;
      const { decreaseLiquidityQuote } = await import("@orca-so/whirlpools-core");
      const sqrtPrice = decodeWhirlpoolSqrtPrice(poolAccountInfo.data);
      const quote = decreaseLiquidityQuote(liquidityDelta, slippageBps, sqrtPrice, tickLowerIndex, tickUpperIndex);
      tokenMinA = quote.tokenMinA.toString();
      tokenMinB = quote.tokenMinB.toString();
    }

    // Pro-rata idle balance -- see useLpVault.ts's getWithdrawQuote comment for why this
    // is returned SEPARATELY (display-only) rather than folded into tokenMinA/tokenMinB,
    // which stay exactly as the deployed-position quote computed for the on-chain CPI's
    // slippage floor.
    const [vaultABalance, vaultBBalance] = await Promise.all([
      connection.getTokenAccountBalance(raw.vaultTokenAAccount as PublicKey).catch(() => null),
      connection.getTokenAccountBalance(raw.vaultTokenBAccount as PublicKey).catch(() => null),
    ]);
    const totalSharesBig = BigInt(totalShares.toString());
    const sharesBig = BigInt(shares.toString());
    const idleA = vaultABalance ? (BigInt(vaultABalance.value.amount) * sharesBig) / totalSharesBig : 0n;
    const idleB = vaultBBalance ? (BigInt(vaultBBalance.value.amount) * sharesBig) / totalSharesBig : 0n;

    return NextResponse.json({ tokenMinA, tokenMinB, idleA: idleA.toString(), idleB: idleB.toString() });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? String(err) }, { status: 500 });
  }
}
