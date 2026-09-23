import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import IDL from "@/idl/yieldpilot.mainnet.json";

/**
 * Server-side LP deposit quote — exists ONLY because Hermes (React Native's JS engine,
 * used by the Yield Wallet app) has no WebAssembly support, and Orca's official quote
 * function (@orca-so/whirlpools-core) is WASM. Rather than hand-rolling concentrated-
 * liquidity fixed-point math on-device -- exactly the kind of thing that silently
 * mispays someone instead of failing loudly -- this route runs the SAME verified math
 * the website's useLpVault.ts already uses (Orca's real WASM quote fn, Raydium's real
 * SDK math), server-side in Node (which does support WASM), and returns the numbers.
 *
 * GET /api/lp-deposit-quote?lpVault=<address>&tokenAAmount=<raw base units>&slippageBps=<bps>
 * -> { liquidityDelta, tokenMaxA, tokenMaxB } as decimal strings (too large for JS numbers)
 */
const RPC_TARGET = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";

function readU128LE(data: Buffer, offset: number): bigint {
  const low = data.readBigUInt64LE(offset);
  const high = data.readBigUInt64LE(offset + 8);
  return (high << 64n) | low;
}

// Same verified offsets as useLpVault.ts's decodeWhirlpool/decodeRaydiumPool.
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
    const tokenAAmountStr = searchParams.get("tokenAAmount");
    const slippageBps = Number(searchParams.get("slippageBps") ?? "100");
    if (!lpVaultAddress || !tokenAAmountStr) {
      return NextResponse.json({ error: "lpVault and tokenAAmount are required" }, { status: 400 });
    }

    const connection = new Connection(RPC_TARGET, "confirmed");
    const provider = new anchor.AnchorProvider(
      connection,
      { publicKey: PublicKey.default, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any,
      { commitment: "confirmed" }
    );
    const program = new anchor.Program(IDL as any, provider);
    const raw: any = await (program.account as any)["lpVault"].fetch(new PublicKey(lpVaultAddress));
    const tokenAAmount = new anchor.BN(tokenAAmountStr);
    const tickLowerIndex = raw.tickLowerIndex as number;
    const tickUpperIndex = raw.tickUpperIndex as number;
    const isRaydium = "raydium" in (raw.protocol as object);

    const poolAccountInfo = await connection.getAccountInfo(raw.pool as PublicKey);
    if (!poolAccountInfo) {
      return NextResponse.json({ error: "Pool account not found" }, { status: 404 });
    }

    if (isRaydium) {
      const { LiquidityMathUtil, TickUtil } = await import("@raydium-io/raydium-sdk-v2");
      const sqrtPriceCurrentX64 = new anchor.BN(decodeRaydiumSqrtPriceX64(poolAccountInfo.data).toString());
      const sqrtPriceLowerX64 = TickUtil.getSqrtPriceAtTick(tickLowerIndex);
      const sqrtPriceUpperX64 = TickUtil.getSqrtPriceAtTick(tickUpperIndex);
      const hugeAmountB = new anchor.BN(2).pow(new anchor.BN(64)).subn(1);
      const liquidityDelta = LiquidityMathUtil.getLiquidityFromAmounts(
        sqrtPriceCurrentX64, sqrtPriceLowerX64, sqrtPriceUpperX64, tokenAAmount, hugeAmountB
      );
      const slippage = slippageBps / 10_000;
      const { amountSlippageA, amountSlippageB } = LiquidityMathUtil.getAmountsFromLiquidityWithSlippage(
        sqrtPriceCurrentX64, sqrtPriceLowerX64, sqrtPriceUpperX64, liquidityDelta, true, true, slippage
      );
      return NextResponse.json({
        liquidityDelta: liquidityDelta.toString(),
        tokenMaxA: amountSlippageA.toString(),
        tokenMaxB: amountSlippageB.toString(),
      });
    } else {
      const { increaseLiquidityQuoteA } = await import("@orca-so/whirlpools-core");
      const sqrtPrice = decodeWhirlpoolSqrtPrice(poolAccountInfo.data);
      const quote = increaseLiquidityQuoteA(
        BigInt(tokenAAmount.toString()),
        slippageBps,
        sqrtPrice,
        tickLowerIndex,
        tickUpperIndex
      );
      return NextResponse.json({
        liquidityDelta: quote.liquidityDelta.toString(),
        tokenMaxA: quote.tokenMaxA.toString(),
        tokenMaxB: quote.tokenMaxB.toString(),
      });
    }
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? String(err) }, { status: 500 });
  }
}
