import { NextRequest, NextResponse } from 'next/server';

// Server-only env var (not NEXT_PUBLIC_) — never exposed to the client bundle,
// and never hardcoded in source. Falls back to the public mainnet RPC only if
// unset; that public endpoint is heavily rate-limited, so the real endpoint
// should always be set in Vercel's project env vars.
const RPC_TARGET = process.env.MAINNET_RPC_URL || 'https://api.mainnet-beta.solana.com';

export async function POST(req: NextRequest) {
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
