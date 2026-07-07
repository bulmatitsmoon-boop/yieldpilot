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
// never accumulated (proven live — 45 rapid requests all succeeded when it
// should have started blocking after 40). Redis is external shared state, so
// this actually works across every instance/region.
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

  // TEMPORARY DEBUG HEADERS — remove once rate limiting is confirmed working live.
  const debugHeaders: Record<string, string> = {
    'X-Debug-Ratelimit-Enabled': String(!!ratelimit),
    'X-Debug-Ip': ip,
  };

  // Fail open (no limiting) rather than fail closed (site broken) if the
  // Redis env vars aren't provisioned yet — better than a hard outage while
  // the Upstash database is being set up.
  if (ratelimit) {
    try {
      const { success, remaining, limit } = await ratelimit.limit(ip);
      debugHeaders['X-Debug-Ratelimit-Success'] = String(success);
      debugHeaders['X-Debug-Ratelimit-Remaining'] = String(remaining);
      debugHeaders['X-Debug-Ratelimit-Limit'] = String(limit);
      if (!success) {
        return NextResponse.json(
          { jsonrpc: '2.0', error: { code: -32005, message: 'Rate limit exceeded, try again shortly.' }, id: null },
          { status: 429, headers: debugHeaders }
        );
      }
    } catch (err: any) {
      debugHeaders['X-Debug-Ratelimit-Error'] = String(err.message ?? err);
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
      headers: { 'Content-Type': 'application/json', ...debugHeaders },
    });
  } catch (err: any) {
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32000, message: `RPC proxy error: ${err.message}` }, id: null },
      { status: 502, headers: debugHeaders }
    );
  }
}
