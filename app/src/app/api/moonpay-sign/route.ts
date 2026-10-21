import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import crypto from "crypto";

/**
 * /api/moonpay-sign — server-side URL signing for the MoonPay on-ramp widget.
 *
 * MoonPay requires any widget URL carrying walletAddress (ours always does, so the
 * purchased crypto lands directly in the user's own wallet) to be signed — the widget
 * refuses to load otherwise ("Signature check failed", confirmed live 2026-10-20 the
 * first time a real user clicked the button). The secret key that signs it can never
 * reach the client, which is exactly why this needs its own API route rather than being
 * computed in BuyCryptoButton.tsx directly.
 *
 * Algorithm verified against MoonPay's own published test vector
 * (dev.moonpay.com/widget/on-ramp/customization/url-signing) before trusting it:
 * HMAC-SHA256(secretKey, queryStringIncludingLeadingQuestionMark), base64-encoded, and
 * for the SDK integration path (not the raw-URL path) returned un-encoded -- the SDK's
 * own updateSignature() handles that. Getting the "include the leading ?" detail wrong
 * is the single most common mistake per their own troubleshooting table, which is why
 * this is tested against their fixed vector in a one-off script before being trusted
 * here, not just copied from the doc's prose description.
 */
export async function POST(req: NextRequest) {
  const secretKey = process.env.MOONPAY_SECRET_KEY;
  if (!secretKey) {
    return NextResponse.json({ error: "MoonPay signing is not configured." }, { status: 503 });
  }

  const { urlForSignature } = await req.json().catch(() => ({ urlForSignature: null }));
  if (!urlForSignature || typeof urlForSignature !== "string") {
    return NextResponse.json({ error: "Missing urlForSignature." }, { status: 400 });
  }

  let queryString: string;
  try {
    queryString = new URL(urlForSignature).search; // includes the leading "?"
  } catch {
    return NextResponse.json({ error: "urlForSignature is not a valid URL." }, { status: 400 });
  }

  const signature = crypto.createHmac("sha256", secretKey).update(queryString).digest("base64");
  return NextResponse.json({ signature });
}
