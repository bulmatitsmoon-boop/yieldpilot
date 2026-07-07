import { NextRequest, NextResponse } from 'next/server';

// Server-only env var (not NEXT_PUBLIC_) — never exposed to the client bundle,
// and never hardcoded in source. Falls back to the public mainnet RPC only if
// unset; that public endpoint is heavily rate-limited, so the real endpoint
// should always be set in Vercel's project env vars.
const RPC_TARGET = process.env.MAINNET_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Basic per-IP rate limit. This proxy now forwards to a paid Helius endpoint
// with an embedded API key, so an unauthenticated open door here means anyone
// hammering it directly (bypassing the actual dApp) racks up cost on that key.
// In-memory sliding window: resets on cold start / doesn't share state across
// concurrent Vercel instances, so it's a basic deterrent, not a hard cap —
// good enough to stop casual abuse without adding external infra (Redis/Upstash)
// tonight. Revisit if real abuse shows up in Helius usage dashboards.
const WINDOW_MS = 10_000;
const MAX_REQUESTS_PER_WINDOW = 40;
const requestLog = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) ?? []).filter(t => now - t < WINDOW_MS);
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  // Prevent unbounded growth if many distinct IPs hit this in one instance's lifetime.
  if (requestLog.size > 5000) requestLog.clear();
  return timestamps.length > MAX_REQUESTS_PER_WINDOW;
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';

  if (isRateLimited(ip)) {
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32005, message: 'Rate limit exceeded, try again shortly.' }, id: null },
      { status: 429 }
    );
  }

  const body = await req.text();
  try {
    const res = await fetch(RPC_TARGET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const data = await res.text();
    return new NextResponse(data, {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32000, message: `RPC proxy error: ${err.message}` }, id: null },
      { status: 502 }
    );
  }
}
