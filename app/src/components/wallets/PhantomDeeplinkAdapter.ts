"use client";

import { BaseSignerWalletAdapter, WalletName, WalletReadyState, WalletNotConnectedError } from "@solana/wallet-adapter-base";
import type { Transaction, TransactionVersion, VersionedTransaction } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import * as pd from "@/lib/phantomDeeplink";

export const PhantomDeeplinkWalletName = "Phantom (Connect)" as WalletName<"Phantom (Connect)">;

/// Phantom's real Connect deeplink (see lib/phantomDeeplink.ts) -- for mobile browsers
/// with no injected provider, where the standard PhantomWalletAdapter is permanently
/// "NotDetected" and unusable. Replaces the old "open the whole site inside Phantom's
/// in-app browser" fallback with a round trip that returns to THIS browser tab.
///
/// CONNECT is fully implemented via this adapter's standard wallet-adapter interface.
/// SIGNING IS NOT, and structurally can't be: Phantom's sign methods require the exact
/// same full-page-navigation round trip connect does, so whatever code called
/// signTransaction/sendTransaction through the normal wallet-adapter Promise contract
/// cannot itself resume after the redirect -- the page reloads, destroying that call
/// stack. signTransaction/signAllTransactions below throw a clear, immediate error rather
/// than hanging forever on a promise that can never resolve -- this is a permanent
/// property of this transport, not a TODO.
///
/// The REAL deposit/withdraw signing path (added 2026-09-29) lives OUTSIDE this adapter
/// interface entirely: useYieldPilot.ts detects this adapter by name and, instead of
/// calling the standard signTransaction, builds the transaction, serializes it, and calls
/// phantomDeeplink.startSign() directly -- a real "redirect out, resume on the next page
/// load" flow, mirroring how connect() already works. The resume/broadcast half lives in
/// WalletProvider.tsx's PhantomReturnHandler. See phantomDeeplink.ts for the encryption
/// protocol both connect and sign share.
export class PhantomDeeplinkWalletAdapter extends BaseSignerWalletAdapter<"Phantom (Connect)"> {
  name = PhantomDeeplinkWalletName;
  url = "https://phantom.app";
  icon = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTA4IiBoZWlnaHQ9IjEwOCIgdmlld0JveD0iMCAwIDEwOCAxMDgiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3Qgd2lkdGg9IjEwOCIgaGVpZ2h0PSIxMDgiIHJ4PSIyNiIgZmlsbD0iIzUzNEJCMSIvPjwvc3ZnPg==";
  readyState = WalletReadyState.Loadable; // always available -- no browser detection needed
  supportedTransactionVersions: ReadonlySet<TransactionVersion> = new Set(["legacy"]);

  private _publicKey: PublicKey | null = null;
  private _connecting = false;

  constructor() {
    super();
    if (typeof window !== "undefined" && pd.isConnected()) {
      const pk = pd.getConnectedPublicKey();
      if (pk) this._publicKey = new PublicKey(pk);
    }
  }

  get publicKey(): PublicKey | null {
    return this._publicKey;
  }

  get connecting(): boolean {
    return this._connecting;
  }

  /// Called by the app right after a page load that might be a Phantom redirect return
  /// (see WalletProvider.tsx). If it was a successful connect return, adopts the new
  /// public key and emits the standard wallet-adapter "connect" event so every existing
  /// useWallet() consumer updates automatically -- no other app code needs to know this
  /// adapter exists.
  handlePossibleReturn(result: pd.PhantomResult): void {
    if (result.kind !== "connect") return;
    if (result.ok && result.publicKey) {
      this._publicKey = new PublicKey(result.publicKey);
      this.emit("connect", this._publicKey);
    }
  }

  /// wallet-adapter-react calls this on every mount if this wallet was the last one
  /// selected (persisted in localStorage). Left at the default, that would silently
  /// redirect the user to Phantom on every fresh page load with no click at all --
  /// override to a no-op. Restoring a still-live sessionStorage session already happens
  /// in the constructor; there is nothing else safe to do automatically here.
  async autoConnect(): Promise<void> {
    return;
  }

  async connect(): Promise<void> {
    if (this.connected || this.connecting) return;
    this._connecting = true;
    try {
      pd.startConnect(); // redirects away; this promise deliberately never resolves
      await new Promise(() => {});
    } finally {
      this._connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    pd.clearSession();
    this._publicKey = null;
    this.emit("disconnect");
  }

  /// Deliberately unreachable in normal use: useYieldPilot.ts calls phantomDeeplink.startSign()
  /// directly for this adapter instead of going through wallet-adapter's signTransaction, since
  /// the redirect this requires can never let this method actually return a value. Thrown only
  /// as a safety net if some other, not-yet-updated call site tries the standard interface.
  async signTransaction<T extends Transaction | VersionedTransaction>(_transaction: T): Promise<T> {
    if (!this.publicKey) throw new WalletNotConnectedError();
    throw new Error(
      "This connect method can't sign through the standard wallet interface -- the caller needs to use phantomDeeplink.startSign() directly instead."
    );
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(_transactions: T[]): Promise<T[]> {
    if (!this.publicKey) throw new WalletNotConnectedError();
    throw new Error(
      "This connect method can't sign through the standard wallet interface -- the caller needs to use phantomDeeplink.startSign() directly instead."
    );
  }
}
