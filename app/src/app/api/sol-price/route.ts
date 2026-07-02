import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Fallback only used if the live price fetch fails — a rough recent value,
// not treated as authoritative. Real conversions always prefer the live fetch.
const FALLBACK_SOL_USD = 150;

export async function GET() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", {
      next: { revalidate: 60 },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const usd = data?.solana?.usd;
    if (!usd || typeof usd !== "number") throw new Error("Malformed response");
    return NextResponse.json({ usd, live: true }, { headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" } });
  } catch (err: any) {
    return NextResponse.json({ usd: FALLBACK_SOL_USD, live: false });
  }
}
