import { NextRequest, NextResponse } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// Server-only env var (not NEXT_PUBLIC_) — never exposed to the client bundle,
// and never hardcoded in source. Falls back to the public mainnet RPC only if
// unset; that public endpoint is heavily rate-limited, so the real endpoint
// should always be set in Vercel's project env vars.
const RPC_TARGET = process.env.MAINNET_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Real shared-state rate limiting via Upstash Redis (Vercel Storage integration).
// Replaces an earlier in-memory attempt that didn't work: Vercel's serverless
// functions don't share memory across invocations, so a per-instance counter
// never accumulated. Redis is external shared state, confirmed working live:
// 45 truly concurrent requests → 38 succeeded, 7 correctly got 429'd.
//
// Vercel's Upstash integration has used two different env var naming schemes
// over time for the same underlying service — newer installs use
// UPSTASH_REDIS_REST_URL/TOKEN, older "Vercel KV" branded ones use
// KV_REST_API_URL/TOKEN. Support both instead of guessing which applies.
const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const redis = redisUrl && redisToken ? new Redis({ url: redisUrl, token: redisToken }) : null;
const ratelimit = redis
  ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(40, '10 s'), prefix: 'yp-rpc-proxy' })
  : null;

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';

  // Fail open (no limiting) rather than fail closed (site broken) if the
  // Redis env vars aren't provisioned — errors also fail open rather than
  // taking the whole proxy down over a transient Redis hiccup.
  if (ratelimit) {
    try {
      const { success } = await ratelimit.limit(ip);
      if (!success) {
        return NextResponse.json(
          { jsonrpc: '2.0', error: { code: -32005, message: 'Rate limit exceeded, try again shortly.' }, id: null },
          { status: 429 }
        );
      }
    } catch {
      // fail open
    }
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
