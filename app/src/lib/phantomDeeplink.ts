"use client";

/// Phantom's mobile "Connect" deeplink protocol -- distinct from the earlier "Browse"
/// universal link (see useConnectWallet.ts), which just opens the whole site inside
/// Phantom's own in-app browser. This protocol instead round-trips: leave to Phantom,
/// approve, come BACK to this exact browser tab -- matching how Lloyd described the flow
/// he wants ("hit connect, Phantom pops up, verify, back in browser").
///
/// CONNECT ONLY for now. Signing transactions this way needs its own two-phase design
/// (build tx, redirect out, resume on the NEXT page load rather than in the original
/// call) -- see the "NOT YET IMPLEMENTED" note further down and PhantomDeeplinkAdapter's
/// stubbed signTransaction, which throws a clear error rather than hanging.
///
/// Reference: https://docs.phantom.com/phantom-deeplinks
///
/// Every request is encrypted with a fresh X25519 keypair generated on our side
/// (nacl.box), Diffie-Hellman'd against Phantom's own encryption public key (received
/// once, at connect time) to derive a shared secret used for every later message.
///
/// State (the dapp keypair + shared secret + session token) has to survive a full page
/// reload, since leaving to the Phantom app and coming back is a real navigation, not an
/// in-page async call -- localStorage is the only place that can live. This is
/// per-viewer session state for an in-flight wallet handshake, not financial state, so it
/// fits the "browser storage for per-viewer convenience" bar even on a money app.

import nacl from "tweetnacl";
import bs58 from "bs58";

const CLUSTER = process.env.NEXT_PUBLIC_SOLANA_NETWORK === "devnet" ? "devnet" : "mainnet-beta";
const PHANTOM_BASE = "https://phantom.app/ul/v1";

const SS_DAPP_SECRET = "phantom_dl_dapp_secret"; // base58, our X25519 secret key
const SS_SHARED_SECRET = "phantom_dl_shared_secret"; // base58, derived after connect
const SS_SESSION = "phantom_dl_session"; // Phantom's session token
const SS_PUBLIC_KEY = "phantom_dl_public_key"; // connected wallet address, base58
const SS_PENDING = "phantom_dl_pending"; // what we were doing when we redirected out

export interface PendingAction {
  kind: "connect" | "sign";
  label?: string; // e.g. "Deposit 10 USDC" -- shown on return, purely cosmetic
  returnTo: string; // pathname+search to send the user back to after our own redirect page
}

export interface PhantomResult {
  ok: boolean;
  kind: "connect" | "sign";
  publicKey?: string;
  signature?: string;
  /// Base64-encoded, Phantom-signed transaction bytes (from the `signTransaction` deeplink
  /// method) -- the caller still has to broadcast this themselves, since Phantom hands
  /// back a signed transaction rather than sending it. See WalletProvider.tsx's
  /// PhantomReturnHandler for where that broadcast actually happens.
  signedTransactionB64?: string;
  /// True for a "sign" result between decrypting Phantom's response and finishing the
  /// broadcast+confirm -- lets the UI show "Confirming..." rather than a premature
  /// "Transaction confirmed." before the transaction has actually landed.
  pending?: boolean;
  error?: string;
  label?: string;
}

function getOrCreateDappKeyPair(): nacl.BoxKeyPair {
  const stored = localStorage.getItem(SS_DAPP_SECRET);
  if (stored) {
    const secretKey = bs58.decode(stored);
    return nacl.box.keyPair.fromSecretKey(secretKey);
  }
  const kp = nacl.box.keyPair();
  localStorage.setItem(SS_DAPP_SECRET, bs58.encode(kp.secretKey));
  return kp;
}

function buildUrl(path: string, params: Record<string, string>): string {
  const q = new URLSearchParams(params);
  return `${PHANTOM_BASE}/${path}?${q.toString()}`;
}

export function isConnected(): boolean {
  return !!localStorage.getItem(SS_PUBLIC_KEY) && !!localStorage.getItem(SS_SESSION);
}

export function getConnectedPublicKey(): string | null {
  return localStorage.getItem(SS_PUBLIC_KEY);
}

export function clearSession(): void {
  [SS_SHARED_SECRET, SS_SESSION, SS_PUBLIC_KEY].forEach((k) => localStorage.removeItem(k));
}

/// Kicks off a Connect round trip. Never returns -- the page navigates away.
export function startConnect(label?: string): void {
  const dapp = getOrCreateDappKeyPair();
  const pending: PendingAction = { kind: "connect", label, returnTo: window.location.pathname + window.location.search };
  localStorage.setItem(SS_PENDING, JSON.stringify(pending));

  const url = buildUrl("connect", {
    dapp_encryption_public_key: bs58.encode(dapp.publicKey),
    cluster: CLUSTER,
    app_url: window.location.origin,
    redirect_link: window.location.origin + window.location.pathname,
  });
  window.location.href = url;
}

/// Kicks off a signTransaction round trip. Never returns -- the page navigates away, and
/// resumes on the NEXT page load via handleReturnIfPresent() (kind: "sign"). The caller
/// must have already built and serialized the FULL unsigned transaction (all instructions,
/// feePayer, recentBlockhash already set) -- this function only handles the Phantom
/// encryption/redirect protocol, not transaction construction.
///
/// Uses Phantom's `signTransaction` deeplink method deliberately, not
/// `signAndSendTransaction` -- Phantom deprecated the latter (checked their docs
/// 2026-09-22) in favor of `signTransaction`/`signAllTransactions`, which return a signed
/// transaction for the dapp to broadcast itself rather than having Phantom broadcast it.
export function startSign(unsignedTxBase58: string, label: string | undefined, returnTo: string): void {
  const dappSecretB58 = localStorage.getItem(SS_DAPP_SECRET);
  const sharedSecretB58 = localStorage.getItem(SS_SHARED_SECRET);
  const session = localStorage.getItem(SS_SESSION);
  if (!dappSecretB58 || !sharedSecretB58 || !session) {
    throw new Error("No active Phantom session -- reconnect and try again.");
  }
  const dappKeyPair = nacl.box.keyPair.fromSecretKey(bs58.decode(dappSecretB58));
  const sharedSecret = bs58.decode(sharedSecretB58);

  const pending: PendingAction = { kind: "sign", label, returnTo };
  localStorage.setItem(SS_PENDING, JSON.stringify(pending));

  const nonce = nacl.randomBytes(24);
  const payload = JSON.stringify({ transaction: unsignedTxBase58, session });
  const encrypted = nacl.box.after(Buffer.from(payload, "utf8"), nonce, sharedSecret);

  const url = buildUrl("signTransaction", {
    dapp_encryption_public_key: bs58.encode(dappKeyPair.publicKey),
    nonce: bs58.encode(nonce),
    redirect_link: window.location.origin + window.location.pathname,
    payload: bs58.encode(encrypted),
  });
  window.location.href = url;
}

/// Call once on every page load (before anything else reads connection state). If the
/// current URL is a Phantom deeplink return, decrypts it, updates session storage, cleans
/// the URL (so a refresh doesn't re-process a stale response), and returns a result the
/// caller can show to the user. Returns null on an ordinary page load.
export function handleReturnIfPresent(): PhantomResult | null {
  const params = new URLSearchParams(window.location.search);
  const pendingRaw = localStorage.getItem(SS_PENDING);
  if (!params.has("phantom_encryption_public_key") && !params.has("errorCode") && !params.has("data")) {
    return null; // not a Phantom return at all
  }
  const pending: PendingAction | null = pendingRaw ? JSON.parse(pendingRaw) : null;
  localStorage.removeItem(SS_PENDING);

  // Strip Phantom's query params so a refresh/back-nav doesn't replay this.
  const cleanUrl = pending?.returnTo || window.location.pathname;
  window.history.replaceState({}, "", cleanUrl);

  const kind: "connect" | "sign" = pending?.kind || (params.has("phantom_encryption_public_key") && !localStorage.getItem(SS_SESSION) ? "connect" : "sign");

  if (params.has("errorCode")) {
    const result: PhantomResult = { ok: false, kind, error: params.get("errorMessage") || params.get("errorCode") || "Rejected", label: pending?.label };
    return result;
  }

  try {
    const dappSecretB58 = localStorage.getItem(SS_DAPP_SECRET);
    if (!dappSecretB58) throw new Error("Missing local key -- session storage was cleared mid-flow.");
    const dappKeyPair = nacl.box.keyPair.fromSecretKey(bs58.decode(dappSecretB58));

    if (kind === "connect") {
      const phantomPubkey = bs58.decode(params.get("phantom_encryption_public_key")!);
      const nonce = bs58.decode(params.get("nonce")!);
      const data = bs58.decode(params.get("data")!);
      const sharedSecret = nacl.box.before(phantomPubkey, dappKeyPair.secretKey);
      const decrypted = nacl.box.open.after(data, nonce, sharedSecret);
      if (!decrypted) throw new Error("Could not decrypt Phantom's response.");
      const { public_key, session } = JSON.parse(Buffer.from(decrypted).toString("utf8"));

      localStorage.setItem(SS_SHARED_SECRET, bs58.encode(sharedSecret));
      localStorage.setItem(SS_SESSION, session);
      localStorage.setItem(SS_PUBLIC_KEY, public_key);

      const result: PhantomResult = { ok: true, kind: "connect", publicKey: public_key, label: pending?.label };
      return result;
    } else {
      const sharedSecretB58 = localStorage.getItem(SS_SHARED_SECRET);
      if (!sharedSecretB58) throw new Error("No active session -- reconnect and try again.");
      const sharedSecret = bs58.decode(sharedSecretB58);
      const nonce = bs58.decode(params.get("nonce")!);
      const data = bs58.decode(params.get("data")!);
      const decrypted = nacl.box.open.after(data, nonce, sharedSecret);
      if (!decrypted) throw new Error("Could not decrypt Phantom's response.");
      // Phantom's signTransaction method returns { transaction: <base58 signed tx> }, not a
      // signature -- it signs but does not broadcast. Re-encode to base64 since that's what
      // @solana/web3.js's Transaction.from()/sendRawTransaction expect elsewhere in the app.
      const { transaction } = JSON.parse(Buffer.from(decrypted).toString("utf8"));
      if (!transaction) throw new Error("Phantom's response had no signed transaction.");
      const signedTransactionB64 = Buffer.from(bs58.decode(transaction)).toString("base64");

      const result: PhantomResult = { ok: true, kind: "sign", signedTransactionB64, pending: true, label: pending?.label };
      return result;
    }
  } catch (e) {
    const result: PhantomResult = { ok: false, kind, error: e instanceof Error ? e.message : "Failed to process Phantom's response.", label: pending?.label };
    return result;
  }
}

