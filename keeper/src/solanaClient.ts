import * as anchor from "@coral-xyz/anchor";
import { getPositionTickArrays, getRaydiumPositionTickArrays } from "./lpVaultHelpers";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Transaction,
  SystemProgram,
  AddressLookupTableAccount,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  TransactionInstruction,
  AccountMeta,
} from "@solana/web3.js";
import { notifyTelegram } from "./telegramNotify";
import fs from "fs";
import os from "os";
import path from "path";
import { logger } from "./logger";
import { EpochContext } from "./rebalancer";
import { EPOCH_GATED_PROTOCOLS, getEntryEpochs, recordEntryIfFresh, clearEntry, ensureEntryForHeldPosition } from "./epochTracker";

// ─────────────────────────────────────────────────────────────────────────────
// Kamino mainnet constants
// ─────────────────────────────────────────────────────────────────────────────

const KAMINO_PROGRAM_ID = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KAMINO_MAIN_MARKET = new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");
const KAMINO_MARKET_AUTHORITY = new PublicKey("9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo");

// USDC reserve on Kamino main market
const KAMINO_USDC_RESERVE = new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const KAMINO_USDC_LIQUIDITY_SUPPLY = new PublicKey("Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6"); // verified from reserve.liquidity.supplyVault
const KAMINO_USDC_COLLATERAL_MINT = new PublicKey("B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D"); // verified from reserve.collateral.mintPubkey
const KAMINO_USDC_COLLATERAL_SUPPLY = new PublicKey("3DzjXRfxRm6iejfyyMynR4tScddaanrePJ1NJU2XnPPL"); // verified from reserve.collateral.supplyVault

// SOL (wSOL) reserve on Kamino main market — TODO: verify addresses at mainnet launch
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const KAMINO_SOL_RESERVE = new PublicKey("d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q"); // verified: owner=KLend
const KAMINO_SOL_LIQUIDITY_SUPPLY = new PublicKey("GafNuUXj9rxGLn4y79dPu6MHSuPWeJR6UtTWuexpGh3U"); // verified: 347k SOL balance
const KAMINO_SOL_COLLATERAL_MINT = new PublicKey("2UywZrUdyqs5vDchy7fKQJKau2RVyuzBev2XKGPDSiX1"); // verified: mintAuth=KaminoMarketAuth
const KAMINO_SOL_COLLATERAL_SUPPLY = new PublicKey("8NXMyRD91p3nof61BTkJvrfpGTASHygz1cUvc3HvwyGS"); // verified from reserve.collateral.supplyVault
const KAMINO_SCOPE_PRICES = new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH"); // Scope price feed used by both USDC and SOL reserves

// Kamino "Maple Market" — a separate, isolated USDC reserve on the SAME Kamino program.
// Registered 2026-07-30 as protocol slot "kamino-usdc-maple" (0% initial target — the
// rebalancer's normal cost/benefit comparison decides if/when it wins real weight).
// Proven end-to-end (deploy + recall, both directions) against real cloned mainnet state
// via the local-validator harness before this was wired up — see project memory.
// No new on-chain code: reuses deploy_to_kamino/recall_from_kamino exactly, just with a
// different reserve/market/authority/liquidity-supply/collateral-mint account set.
const KAMINO_MAPLE_MARKET = new PublicKey("6WEGfej9B9wjxRs6t4BYpb9iCXd8CpTpJ8fVSNzHCC5y");
const KAMINO_MAPLE_MARKET_AUTHORITY = new PublicKey("6QbtpY2jDNcncRFmVf343NThnCdaY8gCAsYATPnYQR9g"); // PDA ["lma", market]
const KAMINO_MAPLE_USDC_RESERVE = new PublicKey("Atj6UREVWa7WxbF2EMKNyfmYUY1U1txughe2gjhcPDCo");
const KAMINO_MAPLE_USDC_LIQUIDITY_SUPPLY = new PublicKey("BBcwMNSMyhhBnYE9pevEvkxKHGzTafMP9v3j7Kk7nAWM");
const KAMINO_MAPLE_USDC_COLLATERAL_MINT = new PublicKey("6M89FWrQaqcy3domy85J1a1wVMnviL86WeUqbqTXf1qb");
const KAMINO_MAPLE_USDC_COLLATERAL_SUPPLY = new PublicKey("25x4aEFoJE3bk4sdNLgHrrmchyop1JvcmGA4ccA6tWWT");

// ─────────────────────────────────────────────────────────────────────────────
// Marinade mainnet constants
// ─────────────────────────────────────────────────────────────────────────────
const MARINADE_PROGRAM = new PublicKey("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");
const MARINADE_STATE = new PublicKey("8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC");
const MSOL_MINT = new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");
const MARINADE_LIQ_POOL_SOL_LEG = new PublicKey("UefNb6z6yvArqe4cJHTXCqStRsKmWhGxnZzuHbikP5Q");
const MARINADE_LIQ_POOL_MSOL_LEG = new PublicKey("7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE");
const MARINADE_LIQ_POOL_MSOL_AUTH = new PublicKey("EyaSjUtSgo9aRD1f8LWXwdvkpDTmXAW54yoSHZRF14WL"); // fixed 2026-07-06: previous value failed ConstraintSeeds on real mainnet deploy, this is Marinade's own program-computed expected value from the error logs
const MARINADE_RESERVE_PDA = new PublicKey("Du3Ysj1wKbxPKkuPPnvzQLQh8oMSVifs3jGZjJWXFmHN"); // PDA seed "reserve"
const MARINADE_MSOL_MINT_AUTH = new PublicKey("3JLPCS1qM2zRw3Dp6V4hZnYHd4toMNPkNesXdX9tg6KM"); // PDA seed "st_mint"
const MARINADE_TREASURY_MSOL = new PublicKey("B1aLzaNMeFVAyQ6f3XbbUyKcH2YPHu2fqiEagmiF23VR");

// ─────────────────────────────────────────────────────────────────────────────
// Jito mainnet constants — TODO: verify program and pool addresses
// ─────────────────────────────────────────────────────────────────────────────
const JITOSOL_MINT = new PublicKey("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn");
// Jito uses their own fork of SPL Stake Pool — verified from mainnet transaction
const JITO_PROGRAM = new PublicKey("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy");
const JITO_POOL = new PublicKey("Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb"); // withdraw auth = 6iQKfEyh...

// Phantom Staked SOL. Runs on the SAME program as jitoSOL — SPoo1Ku8… is the standard SPL
// Stake Pool program, not a Jito fork (the JITO_PROGRAM comment above is wrong: verified
// on-chain 2026-07-21 that this program owns both jitoSOL's and PSOL's pools).
const PSOL_MINT = new PublicKey("pSo1f9nQXWgXibFtKf7NWYxb5enAM4qfP6UJSiXRQfL");
const PSOL_POOL = new PublicKey("pSPcvR8GmG9aKDUbn9nbKYjkxt9hxMS7kF1qqKJaPqJ");

/**
 * Every SPL stake pool the keeper can route to, keyed by the vault's protocol LABEL.
 *
 * WHY THIS EXISTS: deployToSolLst/recallFromSolLst were always generic — they take a pool
 * config as a parameter — but the only producer was getJitoPoolConfig(), which hardcoded
 * JITO_POOL, and both dispatch sites matched on the literal string "jito-sol". So
 * registering a second stake pool on the vault (psol-sol, 2026-07-21) created a live
 * hazard: the rebalancer would name it the winner, executeRebalance would RECALL funds out
 * of Marinade to fund the move, then fall through to `No deploy handler` and leave the
 * vault sitting in cash. Idle funds are the one outcome this product exists to prevent.
 *
 * Adding another SPL stake pool is now one entry here — no new dispatch branch.
 */
const SPL_STAKE_POOLS: Record<string, { pool: PublicKey; program: PublicKey }> = {
  "jito-sol": { pool: JITO_POOL, program: JITO_PROGRAM },
  "psol-sol": { pool: PSOL_POOL, program: JITO_PROGRAM },
};

// ─────────────────────────────────────────────────────────────────────────────
// Solend mainnet constants
// ─────────────────────────────────────────────────────────────────────────────
/** Format a raw token amount for user-facing alerts. SOL vaults are 9dp, USDC 6dp. */
function fmtAmount(raw: number, vaultName: string): string {
  const isSol = vaultName.toUpperCase().includes("SOL");
  const dec = isSol ? 9 : 6;
  return (raw / 10 ** dec).toFixed(isSol ? 4 : 2) + " " + (isSol ? "SOL" : "USDC");
}

// Must match MIN_IDLE_BPS in programs/yieldpilot/src/lib.rs — the vault always keeps
// this share of total_deposits idle so users can withdraw without waiting for a recall.
const MIN_IDLE_BPS = 1000; // 10%
// Dead-band thresholds for executeRebalance (see the long note there). Recalls pay a real
// protocol exit fee so they get a wider band; deploys only cost a signature.
const MIN_RECALL_BPS = 25; // 0.25% of deployable
const MIN_DEPLOY_BPS = 5;  // 0.05% of deployable

const SOLEND_PROGRAM = new PublicKey("So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo");
const SOLEND_MAIN_MARKET = new PublicKey("4UpD2fh7xH3VP9QQaXtsS1YY3bxzWhtfpks7FatyKvdY");
const SOLEND_USDC_RESERVE = new PublicKey("BgxfHJDzm44T7XG68MYKx7YisTjZu73tVovyZSjJMpmw");
const SOLEND_USDC_LIQUIDITY_SUPPLY = new PublicKey("8SheGtsopRUDzdiD6v6BR9a6bqZ9QwywYQY99Fp5meNf");
const SOLEND_USDC_COLLATERAL_MINT = new PublicKey("993dVFL2uXWYeoXuEBFXR4BijeXdTv4s6BzsCjJZuwqk");
const SOLEND_USDC_ORACLE = new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"); // fixed 2026-07-06: previous value was stale/wrong, verified against Solend's public API (reserve.liquidity.pythOracle)
const SOLEND_NULL_ORACLE = new PublicKey("nu11111111111111111111111111111111111111111"); // Solend's sentinel for "no switchboard oracle configured" — NOT the same as SystemProgram.programId; confirmed by decoding the real reserve account bytes 2026-07-07

// ───────────────────────────────────────────────────────────────────────────────
// Orca / Raydium LP vault constants
// ──────────────────────────────────────────────────────────────────────────────
const WHIRLPOOL_PROGRAM_ID = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const RAYDIUM_CLMM_PROGRAM_ID = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");

// MarginFi is intentionally not integrated — see apyFetcher.ts for why
// (their SDK cannot decode their own current mainnet state).

// ─────────────────────────────────────────────────────────────────────────────
// Types mirroring the on-chain Vault account
// ─────────────────────────────────────────────────────────────────────────────

export interface VaultState {
  admin: PublicKey;
  mint: PublicKey;
  vaultTokenAccount: PublicKey;
  sharesMint: PublicKey;
  treasury: PublicKey;
  gateMint: PublicKey;
  totalDeposits: anchor.BN;
  totalShares: anchor.BN;
  perfFeeBps: anchor.BN;
  autoCompound: boolean;
  autoRebalance: boolean;
  paused: boolean;
  lastCompoundTs: anchor.BN;
  bump: number;
  authorityBump: number;
  protocolCount: number;
  tvlCap: anchor.BN;
  name: string;
  protocols: {
    kind: any;
    externalState: PublicKey;
    vaultReceiptAccount: PublicKey;
    targetBps: anchor.BN;
    deployedBalance: anchor.BN;
    label: string;
  }[];
}

export interface LpVaultState {
  admin: PublicKey;
  keeper: PublicKey;
  treasury: PublicKey;
  protocol: any; // { orca: {} } | { raydium: {} } -- Anchor fieldless-enum encoding
  pool: PublicKey;
  position: PublicKey;
  protocolPosition: PublicKey;
  positionMint: PublicKey;
  positionTokenAccount: PublicKey;
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  vaultTokenAAccount: PublicKey;
  vaultTokenBAccount: PublicKey;
  lpSharesMint: PublicKey;
  tickLowerIndex: number;
  tickUpperIndex: number;
  totalLiquidity: anchor.BN;
  totalShares: anchor.BN;
  paused: boolean;
  positionActive: boolean;
  bump: number;
  authorityBump: number;
  name: string;
}

export interface KaminoAccounts {
  vaultAuthority: PublicKey;
  vaultCollateralAccount: PublicKey;
  reserve: PublicKey;
  lendingMarket: PublicKey;
  marketAuthority: PublicKey;
  liquidityMint: PublicKey;
  liquiditySupply: PublicKey;
  collateralMint: PublicKey;
  collateralSupply: PublicKey;
}

// ─────────────────────────────────────────────────────────────────────────────
// SolanaClient
// ─────────────────────────────────────────────────────────────────────────────

export class SolanaClient {
  public connection: Connection;
  public keeper: Keypair;
  public program: anchor.Program;

  constructor() {
    const rpcUrl = process.env.RPC_URL || "https://api.devnet.solana.com";

    // web3.js derives its websocket endpoint by swapping https:// for wss:// — and in
    // doing so it DROPS THE QUERY STRING. For a provider that authenticates via
    // `?api-key=…` (Helius, QuickNode) the socket therefore connects unauthenticated and
    // is rejected with 429, once per confirmTransaction, forever.
    //
    // Nothing breaks: confirmTransaction falls back to HTTP polling, which is why the
    // keeper kept succeeding while logging `ws error: Unexpected server response: 429`.
    // But every confirmation then waits on polling instead of a push notification, and
    // the noise masks real rate-limit problems — which is exactly what it did when the
    // QuickNode subscription lapsed 2026-07-24: genuine 429s were indistinguishable
    // from this permanent one.
    //
    // Carrying the query string over keeps the socket authenticated.
    const wsEndpoint = rpcUrl.startsWith("http")
      ? rpcUrl.replace(/^http/, "ws")
      : undefined;

    this.connection = new Connection(rpcUrl, {
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 60_000,
      ...(wsEndpoint ? { wsEndpoint } : {}),
    });

    // Load keeper keypair
    const keypairPath = (process.env.KEEPER_KEYPAIR_PATH || "~/.config/solana/id.json")
      .replace("~", os.homedir());
    const raw = JSON.parse(fs.readFileSync(path.resolve(keypairPath), "utf8"));
    this.keeper = Keypair.fromSecretKey(Uint8Array.from(raw));

    // Build Anchor provider
    const wallet = new anchor.Wallet(this.keeper);
    const provider = new anchor.AnchorProvider(this.connection, wallet, {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
    anchor.setProvider(provider);

    // Load IDL
    const idlPath = path.resolve(__dirname, process.env.IDL_PATH || "idl/yieldpilot.json");
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
    this.program = new anchor.Program(idl, provider);

    logger.info("SolanaClient initialized", {
      rpc: rpcUrl,
      keeper: this.keeper.publicKey.toBase58(),
    });
  }

  // ── Vault fetching ────────────────────────────────────────────────────────

  async fetchVault(vaultAddress: string): Promise<VaultState> {
    const pubkey = new PublicKey(vaultAddress);
    return await (this.program.account as any)["vault"].fetch(pubkey) as VaultState;
  }

  async fetchAllVaults(): Promise<{ address: string; state: VaultState }[]> {
    const addresses = (process.env.VAULT_ADDRESSES || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    const results = await Promise.allSettled(
      addresses.map(async addr => ({
        address: addr,
        state: await this.fetchVault(addr),
      }))
    );

    return results
      .filter((r): r is PromiseFulfilledResult<{ address: string; state: VaultState }> =>
        r.status === "fulfilled"
      )
      .map(r => r.value);
  }

  // ── PDA helpers ───────────────────────────────────────────────────────────

  getVaultAuthority(vaultPubkey: PublicKey, bump: number): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), vaultPubkey.toBuffer()],
      this.program.programId
    );
    return pda;
  }

  // ── Kamino account resolution ─────────────────────────────────────────────


  /**
   * Initialize all protocol token accounts (ATAs) for a vault authority.
   * This must be called once before any fund deployment can succeed.
   * Safe to call multiple times — uses idempotent instruction.
   */
  async setupVaultTokenAccounts(vaultAddress: string): Promise<void> {
    const vaultPubkey = new PublicKey(vaultAddress);
    const vault = await this.fetchVault(vaultAddress);
    const vaultAuthority = this.getVaultAuthority(vaultPubkey, vault.authorityBump);

    // All mints that need ATAs created for the vault authority
    const mints: { mint: PublicKey; label: string }[] = [
      { mint: KAMINO_USDC_COLLATERAL_MINT,   label: "kUSDC (Kamino USDC collateral)" },
      { mint: KAMINO_SOL_COLLATERAL_MINT,    label: "kSOL (Kamino SOL collateral)" },
      { mint: MSOL_MINT,                     label: "mSOL (Marinade)" },
      { mint: JITOSOL_MINT,                  label: "jitoSOL (Jito)" },
      { mint: PSOL_MINT,                     label: "PSOL (Phantom)" },
      { mint: SOLEND_USDC_COLLATERAL_MINT,   label: "cUSDC (Solend collateral)" },
    ];

    const tx = new Transaction();
    let needsSend = false;

    for (const { mint, label } of mints) {
      // Check if mint exists on-chain (skip if not — protocol not on this network)
      const mintInfo = await this.connection.getAccountInfo(mint).catch(() => null);
      if (!mintInfo) {
        logger.debug(`Skipping ATA init for ${label} — mint does not exist on this network`);
        continue;
      }

      const ata = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
      const ataInfo = await this.connection.getAccountInfo(ata).catch(() => null);
      if (ataInfo) {
        logger.debug(`ATA already exists for ${label}: ${ata.toBase58()}`);
        continue;
      }

      logger.info(`Initializing ATA for ${label}: ${ata.toBase58()}`);
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          this.keeper.publicKey,  // payer
          ata,                    // associatedToken
          vaultAuthority,         // owner
          mint,                   // mint
        )
      );
      needsSend = true;
    }

    if (!needsSend) {
      logger.info("All vault token accounts already initialized");
      return;
    }

    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.keeper.publicKey;
    tx.sign(this.keeper);

    const sig = await this.connection.sendRawTransaction(tx.serialize());
    await this.connection.confirmTransaction(sig, "confirmed");
    logger.info(`Vault token accounts initialized: ${sig}`);
  }

  getKaminoAccounts(vaultPubkey: PublicKey, vaultState: VaultState): KaminoAccounts {
    const vaultAuthority = this.getVaultAuthority(vaultPubkey, vaultState.authorityBump);

    // kUSDC ATA owned by vault authority
    const vaultCollateralAccount = getAssociatedTokenAddressSync(
      KAMINO_USDC_COLLATERAL_MINT,
      vaultAuthority,
      true // allowOwnerOffCurve = true for PDAs
    );

    return {
      vaultAuthority,
      vaultCollateralAccount,
      reserve: KAMINO_USDC_RESERVE,
      lendingMarket: KAMINO_MAIN_MARKET,
      marketAuthority: KAMINO_MARKET_AUTHORITY,
      liquidityMint: USDC_MINT,
      liquiditySupply: KAMINO_USDC_LIQUIDITY_SUPPLY,
      collateralMint: KAMINO_USDC_COLLATERAL_MINT,
      collateralSupply: KAMINO_USDC_COLLATERAL_SUPPLY,
    };
  }

  /** Same shape as getKaminoAccounts, pointed at the Maple Market's isolated USDC reserve. */
  getKaminoMapleAccounts(vaultPubkey: PublicKey, vaultState: VaultState): KaminoAccounts {
    const vaultAuthority = this.getVaultAuthority(vaultPubkey, vaultState.authorityBump);
    const vaultCollateralAccount = getAssociatedTokenAddressSync(
      KAMINO_MAPLE_USDC_COLLATERAL_MINT,
      vaultAuthority,
      true
    );
    return {
      vaultAuthority,
      vaultCollateralAccount,
      reserve: KAMINO_MAPLE_USDC_RESERVE,
      lendingMarket: KAMINO_MAPLE_MARKET,
      marketAuthority: KAMINO_MAPLE_MARKET_AUTHORITY,
      liquidityMint: USDC_MINT,
      liquiditySupply: KAMINO_MAPLE_USDC_LIQUIDITY_SUPPLY,
      collateralMint: KAMINO_MAPLE_USDC_COLLATERAL_MINT,
      collateralSupply: KAMINO_MAPLE_USDC_COLLATERAL_SUPPLY,
    };
  }

  // ── Transaction helpers ───────────────────────────────────────────────────

  /**
   * Resolve what actually happened to a transaction whose confirmation TIMED OUT.
   *
   * A timeout is not a failure. web3.js gives up at its 30s default, but under load the
   * tx frequently lands afterwards — and Anchor's .rpc() only returns the signature on
   * SUCCESS, so a naive retry resends a transaction that may already be on-chain. The
   * retry fires well inside the ~60-90s blockhash window, so the resend is valid and
   * would execute a SECOND time.
   *
   * Mirrors the frontend recovery path added in #118 (useYieldPilot.wrapTx) deliberately:
   * same detection, same signature extraction, same ~90s poll. One idiom, two callers.
   *
   * Returns: "landed" | "failed" | "unknown".
   */
  private async resolveTimedOutTx(err: any, label: string): Promise<{ state: "landed" | "failed" | "unknown"; sig?: string }> {
    const timedOut =
      err?.name === "TransactionExpiredTimeoutError" ||
      /was not confirmed in|Check signature/i.test(err?.message || "");
    // Prefer the structured signature; fall back to the first base58 run of >=40 chars
    // in the message ("Check signature <sig> using ..."), robust to surrounding punctuation.
    const sig: string | undefined =
      err?.signature || err?.message?.match(/[1-9A-HJ-NP-Za-km-z]{40,}/)?.[0];

    if (!timedOut || !sig) return { state: "failed" };

    logger.warn(`${label} confirmation timed out — polling chain before deciding`, { signature: sig });
    const start = Date.now();
    while (Date.now() - start < 90_000) {
      try {
        const st = await this.connection.getSignatureStatus(sig, { searchTransactionHistory: true });
        const v = st.value;
        if (v?.err) return { state: "failed", sig };
        if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) {
          return { state: "landed", sig };
        }
      } catch { /* transient RPC error — keep polling */ }
      await sleep(2000);
    }
    return { state: "unknown", sig };
  }

  async sendWithRetry(
    txFn: () => Promise<string>,
    label: string,
    maxAttempts = 3
  ): Promise<string | null> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const sig = await txFn();
        logger.info(`${label} confirmed`, { signature: sig, attempt });
        return sig;
      } catch (err: any) {
        const isLast = attempt === maxAttempts;
        logger.warn(`${label} failed (attempt ${attempt}/${maxAttempts})`, {
          error: err.message,
        });

        // Before resending, find out whether the previous attempt actually landed.
        const outcome = await this.resolveTimedOutTx(err, label);
        if (outcome.state === "landed") {
          logger.info(`${label} landed despite the timeout — not resending`, {
            signature: outcome.sig,
            attempt,
          });
          return outcome.sig!;
        }
        if (outcome.state === "unknown") {
          // Genuinely undetermined after ~90s. Resending here is the double-send we are
          // trying to prevent, and the keeper runs again on the next cycle anyway — so
          // ABORT rather than gamble. Deliberately asymmetric: a missed action costs one
          // cycle of yield, a duplicate costs real funds and is irreversible.
          logger.error(`${label} unresolved after 90s — ABORTING retries to avoid a double-send`, {
            signature: outcome.sig,
          });
          return null;
        }

        if (!isLast) {
          await sleep(1000 * 2 ** attempt);
        }
      }
    }
    logger.error(`${label} failed after ${maxAttempts} attempts`);
    return null;
  }

  // ── Keeper actions ────────────────────────────────────────────────────────

  async rebalance(
    vaultAddress: string,
    newAllocations: number[]
  ): Promise<string | null> {
    const vaultPubkey = new PublicKey(vaultAddress);
    return this.sendWithRetry(
      () =>
        this.program.methods
          .rebalance(newAllocations.map(n => new anchor.BN(n)))
          .accounts({
            admin: this.keeper.publicKey,
            vault: vaultPubkey,
          })
          .rpc(),
      `rebalance(${vaultAddress.slice(0, 8)}...)`
    );
  }

  async compound(vaultAddress: string): Promise<string | null> {
    const vaultPubkey = new PublicKey(vaultAddress);
    return this.sendWithRetry(
      () =>
        this.program.methods
          .compound()
          .accounts({
            admin: this.keeper.publicKey,
            vault: vaultPubkey,
          })
          .rpc(),
      `compound(${vaultAddress.slice(0, 8)}...)`
    );
  }

  async deployToKamino(
    vaultAddress: string,
    protocolIndex: number,
    amount: anchor.BN,
    oracleAccounts: PublicKey[] = [KAMINO_PROGRAM_ID, KAMINO_PROGRAM_ID, KAMINO_PROGRAM_ID, KAMINO_SCOPE_PRICES],
    // Lets a second (or third...) Kamino reserve reuse this exact same on-chain
    // instruction with a different account set — see getKaminoMapleAccounts.
    kaminoAccountsOverride?: KaminoAccounts
  ): Promise<string | null> {
    const vaultPubkey = new PublicKey(vaultAddress);
    const vault = await this.fetchVault(vaultAddress);
    const kamino = kaminoAccountsOverride ?? this.getKaminoAccounts(vaultPubkey, vault);

    return this.sendWithRetry(
      () =>
        this.program.methods
          .deployToKamino(protocolIndex, amount)
          .accounts({
            keeper: this.keeper.publicKey,
            vault: vaultPubkey,
            vaultAuthority: kamino.vaultAuthority,
            vaultTokenAccount: vault.vaultTokenAccount,
            vaultCollateralAccount: kamino.vaultCollateralAccount,
            kaminoReserve: kamino.reserve,
            kaminoLendingMarket: kamino.lendingMarket,
            kaminoMarketAuthority: kamino.marketAuthority,
            kaminoLiquidityMint: kamino.liquidityMint,
            kaminoLiquiditySupply: kamino.liquiditySupply,
            kaminoCollateralMint: kamino.collateralMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            kaminoProgram: KAMINO_PROGRAM_ID,
          })
          .remainingAccounts(
            oracleAccounts.map(pk => ({
              pubkey: pk,
              isSigner: false,
              isWritable: false,
            }))
          )
          .rpc(),
      `deployToKamino(${vaultAddress.slice(0, 8)}... ${amount.toString()} units)`
    );
  }

  async recallFromKamino(
    vaultAddress: string,
    protocolIndex: number,
    collateralAmount: anchor.BN,
    oracleAccounts: PublicKey[] = [KAMINO_PROGRAM_ID, KAMINO_PROGRAM_ID, KAMINO_PROGRAM_ID, KAMINO_SCOPE_PRICES],
    kaminoAccountsOverride?: KaminoAccounts
  ): Promise<string | null> {
    const vaultPubkey = new PublicKey(vaultAddress);
    const vault = await this.fetchVault(vaultAddress);
    const kamino = kaminoAccountsOverride ?? this.getKaminoAccounts(vaultPubkey, vault);

    return this.sendWithRetry(
      () =>
        this.program.methods
          .recallFromKamino(protocolIndex, collateralAmount)
          .accounts({
            keeper: this.keeper.publicKey,
            vault: vaultPubkey,
            vaultAuthority: kamino.vaultAuthority,
            vaultTokenAccount: vault.vaultTokenAccount,
            vaultCollateralAccount: kamino.vaultCollateralAccount,
            kaminoReserve: kamino.reserve,
            kaminoLendingMarket: kamino.lendingMarket,
            kaminoMarketAuthority: kamino.marketAuthority,
            kaminoLiquidityMint: kamino.liquidityMint,
            kaminoLiquiditySupply: kamino.liquiditySupply,
            kaminoCollateralMint: kamino.collateralMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            kaminoProgram: KAMINO_PROGRAM_ID,
          })
          .remainingAccounts(
            oracleAccounts.map(pk => ({
              pubkey: pk,
              isSigner: false,
              isWritable: false,
            }))
          )
          .rpc(),
      `recallFromKamino(${vaultAddress.slice(0, 8)}... ${collateralAmount.toString()} cTokens)`
    );
  }

  // ── Kamino SOL ────────────────────────────────────────────────────────────

  async deployToKaminoSol(
    vaultAddress: string,
    protocolIndex: number,
    amount: anchor.BN,
    oracleAccounts: PublicKey[] = [KAMINO_PROGRAM_ID, KAMINO_PROGRAM_ID, KAMINO_PROGRAM_ID, KAMINO_SCOPE_PRICES]
  ): Promise<string | null> {
    const vaultPubkey = new PublicKey(vaultAddress);
    const vault = await this.fetchVault(vaultAddress);
    const vaultAuthority = this.getVaultAuthority(vaultPubkey, vault.authorityBump);
    const vaultCollateralAccount = getAssociatedTokenAddressSync(
      KAMINO_SOL_COLLATERAL_MINT,
      vaultAuthority,
      true
    );

    return this.sendWithRetry(
      () =>
        this.program.methods
          .deployToKamino(protocolIndex, amount)
          .accounts({
            keeper: this.keeper.publicKey,
            vault: vaultPubkey,
            vaultAuthority,
            vaultTokenAccount: vault.vaultTokenAccount,
            vaultCollateralAccount,
            kaminoReserve: KAMINO_SOL_RESERVE,
            kaminoLendingMarket: KAMINO_MAIN_MARKET,
            kaminoMarketAuthority: KAMINO_MARKET_AUTHORITY,
            kaminoLiquidityMint: WSOL_MINT,
            kaminoLiquiditySupply: KAMINO_SOL_LIQUIDITY_SUPPLY,
            kaminoCollateralMint: KAMINO_SOL_COLLATERAL_MINT,
            tokenProgram: TOKEN_PROGRAM_ID,
            instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            kaminoProgram: KAMINO_PROGRAM_ID,
          })
          .remainingAccounts(
            oracleAccounts.map(pk => ({ pubkey: pk, isSigner: false, isWritable: false }))
          )
          .rpc(),
      `deployToKaminoSol(${vaultAddress.slice(0, 8)}... ${amount.toString()} lamports)`
    );
  }

  async recallFromKaminoSol(
    vaultAddress: string,
    protocolIndex: number,
    collateralAmount: anchor.BN,
    oracleAccounts: PublicKey[] = [KAMINO_PROGRAM_ID, KAMINO_PROGRAM_ID, KAMINO_PROGRAM_ID, KAMINO_SCOPE_PRICES]
  ): Promise<string | null> {
    const vaultPubkey = new PublicKey(vaultAddress);
    const vault = await this.fetchVault(vaultAddress);
    const vaultAuthority = this.getVaultAuthority(vaultPubkey, vault.authorityBump);
    const vaultCollateralAccount = getAssociatedTokenAddressSync(
      KAMINO_SOL_COLLATERAL_MINT,
      vaultAuthority,
      true
    );

    return this.sendWithRetry(
      () =>
        this.program.methods
          .recallFromKamino(protocolIndex, collateralAmount)
          .accounts({
            keeper: this.keeper.publicKey,
            vault: vaultPubkey,
            vaultAuthority,
            vaultTokenAccount: vault.vaultTokenAccount,
            vaultCollateralAccount,
            kaminoReserve: KAMINO_SOL_RESERVE,
            kaminoLendingMarket: KAMINO_MAIN_MARKET,
            kaminoMarketAuthority: KAMINO_MARKET_AUTHORITY,
            kaminoLiquidityMint: WSOL_MINT,
            kaminoLiquiditySupply: KAMINO_SOL_LIQUIDITY_SUPPLY,
            kaminoCollateralMint: KAMINO_SOL_COLLATERAL_MINT,
            tokenProgram: TOKEN_PROGRAM_ID,
            instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            kaminoProgram: KAMINO_PROGRAM_ID,
          })
          .remainingAccounts(
            oracleAccounts.map(pk => ({ pubkey: pk, isSigner: false, isWritable: false }))
          )
          .rpc(),
      `recallFromKaminoSol(${vaultAddress.slice(0, 8)}... ${collateralAmount.toString()} cTokens)`
    );
  }

  // ── Marinade ──────────────────────────────────────────────────────────────

  async deployToMarinade(vaultAddress: string, protocolIndex: number, lamports: anchor.BN): Promise<string | null> {
    const vaultPubkey = new PublicKey(vaultAddress);
    const vault = await this.fetchVault(vaultAddress);
    const vaultAuthority = this.getVaultAuthority(vaultPubkey, vault.authorityBump);
    const vaultMsolAccount = getAssociatedTokenAddressSync(MSOL_MINT, vaultAuthority, true);

    return this.sendWithRetry(
      () =>
        this.program.methods
          .deployToMarinade(protocolIndex, lamports)
          .accounts({
            keeper: this.keeper.publicKey,
            vault: vaultPubkey,
            vaultAuthority,
            vaultTokenAccount: vault.vaultTokenAccount,
            wsolMint: WSOL_MINT,
            marinadeState: MARINADE_STATE,
            msolMint: MSOL_MINT,
            liqPoolSolLeg: MARINADE_LIQ_POOL_SOL_LEG,
            liqPoolMsolLeg: MARINADE_LIQ_POOL_MSOL_LEG,
            liqPoolMsolLegAuthority: MARINADE_LIQ_POOL_MSOL_AUTH,
            reservePda: MARINADE_RESERVE_PDA,
            vaultMsolAccount: vaultMsolAccount,
            msolMintAuthority: MARINADE_MSOL_MINT_AUTH,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            marinadeProgram: new PublicKey("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD"),
          })
          .rpc(),
      `deployToMarinade(${vaultAddress.slice(0, 8)}... ${lamports.toString()} lamports)`
    );
  }

  async recallFromMarinade(vaultAddress: string, protocolIndex: number, msolAmount: anchor.BN): Promise<string | null> {
    const vaultPubkey = new PublicKey(vaultAddress);
    const vault = await this.fetchVault(vaultAddress);
    const vaultAuthority = this.getVaultAuthority(vaultPubkey, vault.authorityBump);
    const vaultMsolAccount = getAssociatedTokenAddressSync(MSOL_MINT, vaultAuthority, true);

    return this.sendWithRetry(
      () =>
        this.program.methods
          .recallFromMarinade(protocolIndex, msolAmount)
          .accounts({
            keeper: this.keeper.publicKey,
            vault: vaultPubkey,
            vaultAuthority,
            vaultTokenAccount: vault.vaultTokenAccount,
            marinadeState: MARINADE_STATE,
            msolMint: MSOL_MINT,
            liqPoolSolLeg: MARINADE_LIQ_POOL_SOL_LEG,
            liqPoolMsolLeg: MARINADE_LIQ_POOL_MSOL_LEG,
            treasuryMsolAccount: MARINADE_TREASURY_MSOL,
            vaultMsolAccount,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            marinadeProgram: new PublicKey("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD"),
          })
          .rpc(),
      `recallFromMarinade(${vaultAddress.slice(0, 8)}... ${msolAmount.toString()} mSOL)`
    );
  }

  // ── BlazeStake / Jito (SPL Stake Pool) ───────────────────────────────────

  /** Deploy SOL to an SPL Stake Pool (Jito). Pool state accounts must be passed in. */
  async deployToSolLst(
    vaultAddress: string,
    protocolIndex: number,
    lamports: anchor.BN,
    poolConfig: {
      stakePool: PublicKey;
      withdrawAuthority: PublicKey;
      reserveStake: PublicKey;
      managerFeeAccount: PublicKey;
      poolMint: PublicKey;
      lstMint: PublicKey;
      stakePoolProgram: PublicKey;
    }
  ): Promise<string | null> {
    const vaultPubkey = new PublicKey(vaultAddress);
    const vault = await this.fetchVault(vaultAddress);
    const vaultAuthority = this.getVaultAuthority(vaultPubkey, vault.authorityBump);
    const vaultLstAccount = getAssociatedTokenAddressSync(poolConfig.lstMint, vaultAuthority, true);

    return this.sendWithRetry(
      () =>
        this.program.methods
          .deployToSolLst(protocolIndex, lamports)
          .accounts({
            keeper: this.keeper.publicKey,
            vault: vaultPubkey,
            vaultAuthority,
            vaultLstAccount,
            stakePool: poolConfig.stakePool,
            withdrawAuthority: poolConfig.withdrawAuthority,
            reserveStake: poolConfig.reserveStake,
            managerFeeAccount: poolConfig.managerFeeAccount,
            poolMint: poolConfig.poolMint,
            vaultTokenAccount: vault.vaultTokenAccount,
            wsolMint: WSOL_MINT,
            stakePoolProgram: poolConfig.stakePoolProgram,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .rpc(),
      `deployToSolLst(${vaultAddress.slice(0, 8)}... ${lamports.toString()} lamports)`
    );
  }

  async recallFromSolLst(
    vaultAddress: string,
    protocolIndex: number,
    lstAmount: anchor.BN,
    poolConfig: {
      stakePool: PublicKey;
      withdrawAuthority: PublicKey;
      reserveStake: PublicKey;
      managerFeeAccount: PublicKey;
      poolMint: PublicKey;
      lstMint: PublicKey;
      stakePoolProgram: PublicKey;
    }
  ): Promise<string | null> {
    const vaultPubkey = new PublicKey(vaultAddress);
    const vault = await this.fetchVault(vaultAddress);
    const vaultAuthority = this.getVaultAuthority(vaultPubkey, vault.authorityBump);
    const vaultLstAccount = getAssociatedTokenAddressSync(poolConfig.lstMint, vaultAuthority, true);

    return this.sendWithRetry(
      () =>
        this.program.methods
          .recallFromSolLst(protocolIndex, lstAmount)
          .accounts({
            keeper: this.keeper.publicKey,
            vault: vaultPubkey,
            vaultAuthority,
            vaultLstAccount,
            stakePool: poolConfig.stakePool,
            withdrawAuthority: poolConfig.withdrawAuthority,
            reserveStake: poolConfig.reserveStake,
            managerFeeAccount: poolConfig.managerFeeAccount,
            poolMint: poolConfig.poolMint,
            vaultTokenAccount: vault.vaultTokenAccount,
            stakePoolProgram: poolConfig.stakePoolProgram,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc(),
      `recallFromSolLst(${vaultAddress.slice(0, 8)}... ${lstAmount.toString()} LST)`
    );
  }

  // ── Solend ────────────────────────────────────────────────────────────────

  async deployToSolend(vaultAddress: string, protocolIndex: number, amount: anchor.BN): Promise<string | null> {
    const vaultPubkey = new PublicKey(vaultAddress);
    const vault = await this.fetchVault(vaultAddress);
    const vaultAuthority = this.getVaultAuthority(vaultPubkey, vault.authorityBump);
    const vaultCollateralAccount = getAssociatedTokenAddressSync(SOLEND_USDC_COLLATERAL_MINT, vaultAuthority, true);
    // Lending market authority: PDA [lending_market] with bump from market state
    // Bump is 251 for the main market — hardcoded here, verify at mainnet launch
    const [lendingMarketAuthority] = PublicKey.findProgramAddressSync(
      [SOLEND_MAIN_MARKET.toBuffer()],
      SOLEND_PROGRAM
    );

    return this.sendWithRetry(
      () =>
        this.program.methods
          .deployToSolend(protocolIndex, amount)
          .accounts({
            keeper: this.keeper.publicKey,
            vault: vaultPubkey,
            vaultAuthority,
            vaultTokenAccount: vault.vaultTokenAccount,
            vaultCollateralAccount,
            reserve: SOLEND_USDC_RESERVE,
            reserveLiquiditySupply: SOLEND_USDC_LIQUIDITY_SUPPLY,
            reserveCollateralMint: SOLEND_USDC_COLLATERAL_MINT,
            lendingMarket: SOLEND_MAIN_MARKET,
            lendingMarketAuthority,
            pythOracle: SOLEND_USDC_ORACLE,
            switchboardOracle: SOLEND_NULL_ORACLE,
            tokenProgram: TOKEN_PROGRAM_ID,
            solendProgram: SOLEND_PROGRAM,
          })
          .rpc(),
      `deployToSolend(${vaultAddress.slice(0, 8)}... ${amount.toString()} USDC)`
    );
  }

  async recallFromSolend(vaultAddress: string, protocolIndex: number, collateralAmount: anchor.BN): Promise<string | null> {
    const vaultPubkey = new PublicKey(vaultAddress);
    const vault = await this.fetchVault(vaultAddress);
    const vaultAuthority = this.getVaultAuthority(vaultPubkey, vault.authorityBump);
    const vaultCollateralAccount = getAssociatedTokenAddressSync(SOLEND_USDC_COLLATERAL_MINT, vaultAuthority, true);
    const [lendingMarketAuthority] = PublicKey.findProgramAddressSync(
      [SOLEND_MAIN_MARKET.toBuffer()],
      SOLEND_PROGRAM
    );

    return this.sendWithRetry(
      () =>
        this.program.methods
          .recallFromSolend(protocolIndex, collateralAmount)
          .accounts({
            keeper: this.keeper.publicKey,
            vault: vaultPubkey,
            vaultAuthority,
            vaultCollateralAccount,
            vaultTokenAccount: vault.vaultTokenAccount,
            reserve: SOLEND_USDC_RESERVE,
            reserveCollateralMint: SOLEND_USDC_COLLATERAL_MINT,
            reserveLiquiditySupply: SOLEND_USDC_LIQUIDITY_SUPPLY,
            lendingMarket: SOLEND_MAIN_MARKET,
            lendingMarketAuthority,
            pythOracle: SOLEND_USDC_ORACLE,
            switchboardOracle: SOLEND_NULL_ORACLE,
            tokenProgram: TOKEN_PROGRAM_ID,
            solendProgram: SOLEND_PROGRAM,
          })
          .rpc(),
      `recallFromSolend(${vaultAddress.slice(0, 8)}... ${collateralAmount.toString()} cUSDC)`
    );
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  async getKeeperBalance(): Promise<number> {
    const lamports = await this.connection.getBalance(this.keeper.publicKey);
    return lamports / 1e9;
  }

  // Builds the epoch-cooldown context the rebalancer needs to refuse exiting an LST
  // position before its accrued yield exceeds its flat exit fee. epochLengthDays is
  // derived from a live slot-time sample rather than hardcoded, since mainnet slot
  // times drift (verified 2026-07-30: ~0.4225s/slot -> ~2.11 days/epoch, not the
  // ~2-3 day rule of thumb).
  //
  // `vaultState` is optional only for backwards compatibility with any caller that
  // doesn't have it handy — pass it whenever possible. With it, this backfills an
  // entry-epoch for every epoch-gated position the vault CURRENTLY HOLDS but has no
  // record for. That backfill is what makes the rebalancer's now fail-CLOSED cooldown
  // safe: without it, a position whose record was lost (fresh runner, wiped state file,
  // a deploy that happened before the tracker existed) could never be exited at all.
  // With it, the first cycle stamps "entered now" + blocks, and later cycles compare
  // normally. See epochTracker.ensureEntryForHeldPosition for the incident this fixes.
  async getEpochContext(vaultAddress: string, vaultState?: VaultState): Promise<EpochContext> {
    const [epochInfo, perfSamples] = await Promise.all([
      this.connection.getEpochInfo(),
      this.connection.getRecentPerformanceSamples(1),
    ]);
    const sample = perfSamples[0];
    const secsPerSlot = sample && sample.numSlots > 0
      ? sample.samplePeriodSecs / sample.numSlots
      : 0.4225; // fallback: last known-good live measurement
    const epochLengthDays = (epochInfo.slotsInEpoch * secsPerSlot) / 86_400;

    if (vaultState) {
      const held = vaultState.protocols.slice(0, vaultState.protocolCount);
      for (const p of held) {
        if (p.deployedBalance.toNumber() > 0) {
          ensureEntryForHeldPosition(vaultAddress, p.label, epochInfo.epoch);
        }
      }
    }

    return {
      currentEpoch: epochInfo.epoch,
      epochLengthDays,
      entryEpochs: getEntryEpochs(vaultAddress),
    };
  }

  async getVaultCollateralBalance(
    vaultAddress: string,
    vaultState: VaultState
  ): Promise<number> {
    const vaultPubkey = new PublicKey(vaultAddress);
    const kamino = this.getKaminoAccounts(vaultPubkey, vaultState);
    try {
      const balance = await this.connection.getTokenAccountBalance(
        kamino.vaultCollateralAccount
      );
      return Number(balance.value.amount);
    } catch {
      return 0;
    }
  }

  // ── Token account balance helper ─────────────────────────────────────────

  async getTokenBalance(account: PublicKey): Promise<number> {
    try {
      const bal = await this.connection.getTokenAccountBalance(account);
      return Number(bal.value.amount);
    } catch {
      return 0;
    }
  }

  // ── Jito pool config (decoded from on-chain stake pool state) ─────────────

  /** Decode any SPL stake pool's account into the config deployToSolLst/recallFromSolLst
   *  need. Offsets are fixed in the SPL StakePool layout and all three are verified:
   *  reserveStake@130 and managerFeeAccount@194 are proven by the live jitoSOL CPIs, and
   *  poolMint@162 was confirmed independently (decoding PSOL's pool at 162 yields
   *  pSo1f9nQ…, and jitoSOL's yields J1toso1u…).
   *
   *  poolMint is READ FROM THE CHAIN rather than taken from a constant — one less place
   *  for a per-pool value to be wrong. */
  async getSplStakePoolConfig(label: string) {
    const entry = SPL_STAKE_POOLS[label];
    if (!entry) throw new Error(`No SPL stake pool registered for label "${label}"`);
    const data = (await this.connection.getAccountInfo(entry.pool))?.data;
    if (!data || data.length < 226) throw new Error(`${label}: stake pool account not found or too small`);
    const reserveStake      = new PublicKey(data.slice(130, 162));
    const poolMint          = new PublicKey(data.slice(162, 194));
    const managerFeeAccount = new PublicKey(data.slice(194, 226));
    const [withdrawAuthority] = PublicKey.findProgramAddressSync(
      [entry.pool.toBuffer(), Buffer.from("withdraw")],
      entry.program
    );
    return {
      stakePool: entry.pool,
      withdrawAuthority,
      reserveStake,
      managerFeeAccount,
      poolMint,
      lstMint: poolMint,
      stakePoolProgram: entry.program,
    };
  }

  /** @deprecated use getSplStakePoolConfig("jito-sol") */
  async getJitoPoolConfig() {
    return this.getSplStakePoolConfig("jito-sol");
  }

  // ── Execute rebalance: move funds to match target allocations ─────────────
  //
  // Phase 1 - recall from over-deployed protocols (frees idle vault balance)
  // Phase 2 - deploy to under-deployed protocols (uses idle vault balance)

  async executeRebalance(vaultAddress: string, vault: VaultState, currentEpoch?: number): Promise<void> {
    const totalDeposits = vault.totalDeposits.toNumber();
    if (totalDeposits === 0) {
      logger.info("executeRebalance: vault empty, skipping");
      return;
    }

    const protocols = vault.protocols.slice(0, vault.protocolCount);

    // Target allocations are a split of DEPLOYABLE capital, not of totalDeposits.
    //
    // The program enforces two rules that are mutually unsatisfiable if read naively:
    //   1. targetBps across protocols must sum to EXACTLY 10000 (AllocationNotFull), and
    //   2. idle must never drop below totalDeposits * MIN_IDLE_BPS (the 10% withdrawal buffer).
    // So "80% of totalDeposits" can never actually be deployed — only 90% of the vault is
    // ever deployable. Basing targets on totalDeposits therefore over-asks by exactly the
    // buffer, and the greedy deploy loop silently resolves the shortfall by starving
    // whichever protocol it happens to reach LAST.
    //
    // Observed live 2026-07-17 on the SOL vault (0.1 SOL, marinade 80 / jito 20):
    // marinade (first) took its full 0.08, jito (last) got 0.01 instead of 0.02 — a 50%
    // underweight, decided purely by registration order rather than by anything intended.
    // The harness never caught it: it only ever deployed one protocol at a time.
    //
    // Scaling by deployableTotal makes the targets sum to exactly the deployable amount,
    // so every protocol gets its true share and the result no longer depends on iteration
    // order. This is also why the same scaling MUST apply to the recall phase — if the two
    // phases disagreed about what "target" means, they'd fight each other every cycle.
    const minIdle = Math.floor(totalDeposits * MIN_IDLE_BPS / 10_000);
    const deployableTotal = totalDeposits - minIdle;

    // Dead-band — never transact on dust.
    //
    // Protocol fees never land on round numbers, so a protocol's deployedBalance can
    // essentially NEVER exactly equal its target. Filtering on a bare `excess > 0` therefore
    // means the vault NEVER settles: a few lamports of drift trigger a real, fee-paying
    // protocol exit every single cycle, forever.
    //
    // Observed live 2026-07-17 immediately after the proportional-target fix: marinade sat
    // 25 lamports (0.000000025 SOL) over target, and the keeper dutifully recalled and
    // redeployed it every 45 minutes, posting "Deployed 0.0000 SOL" to the alert channel
    // each time. The wasted fees were trivial; the wasted CREDIBILITY was not — an alert
    // channel that cries wolf over dust trains people to ignore the alert that matters.
    //
    // Asymmetric on purpose: a recall is a REAL protocol exit paying a REAL fee (marinade
    // ~0.17-0.3%, jito ~0.1%), whereas a deploy only costs a signature. So recalls need a
    // wider band than deploys. Both are bps-of-deployable, so they scale with vault size
    // and stay unit-agnostic across SOL (9 decimals) and USDC (6).
    //
    // Sizing: must exceed the fee residue left by a legitimate rebalance (recalling 0.008
    // SOL at marinade's 0.17% leaves ~13.6k lamports ~= 0.019% of target) yet stay far below
    // REBALANCE_THRESHOLD_BPS (500 = 5%), so real rebalances are never suppressed.
    const minRecall = Math.floor(deployableTotal * MIN_RECALL_BPS / 10_000);
    const minDeploy = Math.floor(deployableTotal * MIN_DEPLOY_BPS / 10_000);

    const deltas = protocols.map((p, i) => ({
      index: i,
      label: Buffer.from(p.label).toString("utf8").replace(/\0/g, ""),
      deployed: p.deployedBalance.toNumber(),
      target: Math.floor(deployableTotal * p.targetBps.toNumber() / 10_000),
      receiptAccount: p.vaultReceiptAccount,
    }));

    // Phase 1: Recalls
    const toRecall = deltas
      .map(d => ({ ...d, excess: d.deployed - d.target }))
      .filter(d => d.excess > minRecall)
      .sort((a, b) => b.excess - a.excess);

    for (const d of toRecall) {
      logger.info("Recall from protocol", { label: d.label, excess: d.excess, deployed: d.deployed, target: d.target });
      try {
        const receiptBalance = await this.getTokenBalance(d.receiptAccount);
        if (receiptBalance === 0) { logger.warn("No receipt balance, skipping", { label: d.label }); continue; }
        const receiptToWithdraw = new anchor.BN(Math.max(1, Math.floor(receiptBalance * d.excess / d.deployed)));
        let sig: string | null = null;
        if (d.label === "kamino-usdc") {
          sig = await this.recallFromKamino(vaultAddress, d.index, receiptToWithdraw);
        } else if (d.label === "kamino-usdc-maple") {
          const mapleAccounts = this.getKaminoMapleAccounts(new PublicKey(vaultAddress), vault);
          sig = await this.recallFromKamino(
            vaultAddress, d.index, receiptToWithdraw,
            [KAMINO_PROGRAM_ID, KAMINO_PROGRAM_ID, KAMINO_PROGRAM_ID, KAMINO_SCOPE_PRICES],
            mapleAccounts
          );
        } else if (d.label === "kamino-sol") {
          sig = await this.recallFromKaminoSol(vaultAddress, d.index, receiptToWithdraw);
        } else if (d.label === "marinade-sol") {
          sig = await this.recallFromMarinade(vaultAddress, d.index, receiptToWithdraw);
        } else if (SPL_STAKE_POOLS[d.label]) {
          const cfg = await this.getSplStakePoolConfig(d.label);
          sig = await this.recallFromSolLst(vaultAddress, d.index, receiptToWithdraw, cfg);
        } else if (d.label === "solend-usdc") {
          sig = await this.recallFromSolend(vaultAddress, d.index, receiptToWithdraw);
        } else {
          logger.warn("No recall handler for protocol", { label: d.label });
        }
        // Recalls move real funds back out of a protocol — alert like deploys do.
        if (sig) {
          // A full exit (recalling down to target 0) clears the epoch-entry record,
          // so a later re-deploy starts a fresh cooldown window rather than inheriting
          // the old one. Partial recalls (target still > 0) are not a full exit and
          // leave the record intact.
          if (EPOCH_GATED_PROTOCOLS.has(d.label) && d.target === 0) {
            clearEntry(vaultAddress, d.label);
          }
          await notifyTelegram(
            `↩️ <b>Recalled</b> — ${d.label} → vault
` +
            `<a href="https://solscan.io/tx/${sig}">View transaction</a>`
          );
        }
      } catch (err: any) {
        logger.error("Recall failed", { label: d.label, error: err.message });
      }
    }

    // Phase 2: Deploys
    const toDeposit = deltas
      .map(d => ({ ...d, deficit: d.target - d.deployed }))
      .filter(d => d.deficit > minDeploy)
      .sort((a, b) => b.deficit - a.deficit);

    // The on-chain program reserves a MIN_IDLE_BPS (10%) withdrawal buffer:
    //   require!(idle - amount >= total_deposits * MIN_IDLE_BPS / BPS_DENOM)
    // Target allocations must sum to EXACTLY 100% (AllocationNotFull), so deploying
    // naively to targets always asks for 100% and is rejected with InsufficientIdle
    // (6012) — i.e. funds could never deploy at all. Cap deployable at idle - min_idle.
    // Found 2026-07-16: 5 real USDC at kamino target 100% failed 3/3 attempts.
    const idleBalance = await this.getTokenBalance(vault.vaultTokenAccount);
    let available = idleBalance - minIdle;
    logger.info("Idle vault balance after recalls", { idleBalance, minIdle, deployable: available });
    if (available <= 0) {
      logger.info("executeRebalance: all idle funds reserved for the withdrawal buffer, nothing to deploy");
      return;
    }

    for (const d of toDeposit) {
      if (available <= 0) break;
      const amount = new anchor.BN(Math.min(d.deficit, available));
      if (amount.isZero()) continue;

      logger.info("Deploy to protocol", { label: d.label, amount: amount.toString(), deficit: d.deficit });
      try {
        let sig: string | null = null;
        if (d.label === "kamino-usdc") {
          sig = await this.deployToKamino(vaultAddress, d.index, amount);
        } else if (d.label === "kamino-usdc-maple") {
          const mapleAccounts = this.getKaminoMapleAccounts(new PublicKey(vaultAddress), vault);
          sig = await this.deployToKamino(
            vaultAddress, d.index, amount,
            [KAMINO_PROGRAM_ID, KAMINO_PROGRAM_ID, KAMINO_PROGRAM_ID, KAMINO_SCOPE_PRICES],
            mapleAccounts
          );
        } else if (d.label === "kamino-sol") {
          sig = await this.deployToKaminoSol(vaultAddress, d.index, amount);
        } else if (d.label === "marinade-sol") {
          sig = await this.deployToMarinade(vaultAddress, d.index, amount);
        } else if (SPL_STAKE_POOLS[d.label]) {
          const cfg = await this.getSplStakePoolConfig(d.label);
          sig = await this.deployToSolLst(vaultAddress, d.index, amount, cfg);
        } else if (d.label === "solend-usdc") {
          sig = await this.deployToSolend(vaultAddress, d.index, amount);
        } else {
          logger.warn("No deploy handler for protocol", { label: d.label });
          continue;
        }
        // Fund movements are the most user-visible thing the keeper does, but they were
        // the ONLY action with no alert — notifyTelegram was wired to rebalance+compound
        // only. Found 2026-07-16: 4.5 USDC deployed to Kamino and the channel said nothing.
        if (sig) {
          // Only a fresh 0 -> nonzero deploy starts the epoch cooldown clock — a
          // top-up of an already-held position must not reset it (see epochTracker.ts).
          if (EPOCH_GATED_PROTOCOLS.has(d.label) && d.deployed === 0 && currentEpoch !== undefined) {
            recordEntryIfFresh(vaultAddress, d.label, true, currentEpoch);
          }
          await notifyTelegram(
            `⚡ <b>Deployed</b> — ${fmtAmount(amount.toNumber(), vault.name)} → ${d.label}
` +
            `<a href="https://solscan.io/tx/${sig}">View transaction</a>`
          );
        }
        available -= amount.toNumber();
      } catch (err: any) {
        logger.error("Deploy failed", { label: d.label, error: err.message });
      }
    }
  }

  // ── LP vault (Orca Whirlpools + Raydium CLMM) ────────────────────────────
  // See lp_vault.rs's module docs for the product design, lpVaultRebalancer.ts
  // for the reposition decision logic this feeds, and lpVaultHelpers.ts for
  // the PDA math used below.

  async fetchLpVault(lpVaultAddress: string): Promise<LpVaultState> {
    const pubkey = new PublicKey(lpVaultAddress);
    return await (this.program.account as any)["lpVault"].fetch(pubkey) as LpVaultState;
  }

  async fetchAllLpVaults(): Promise<{ address: string; state: LpVaultState }[]> {
    const addresses = (process.env.LP_VAULT_ADDRESSES || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    const results = await Promise.allSettled(
      addresses.map(async addr => ({
        address: addr,
        state: await this.fetchLpVault(addr),
      }))
    );

    return results
      .filter((r): r is PromiseFulfilledResult<{ address: string; state: LpVaultState }> =>
        r.status === "fulfilled"
      )
      .map(r => r.value);
  }

  /**
   * Read the current tick and (for Raydium) tick spacing directly from the
   * pool account bytes — same manual byte-offset decode as
   * app/src/hooks/useLpVault.ts's decodeWhirlpool/decodeRaydiumPool, kept
   * duplicated here for the same "no shared internal library today" reason
   * documented elsewhere in this codebase.
   */
  /**
   * Raw balances sitting in the LP vault's own token accounts.
   *
   * Used to pick a FUNDABLE range when redeploying: a vault that drifted out of range
   * holds almost entirely one token, and a centred range needs both. Returns raw
   * amounts (no decimal scaling) because the caller compares them against the pool
   * price in raw units, where 1.0001^tick is already decimals-adjusted.
   *
   * Missing accounts read as 0 rather than throwing — an uninitialised side is
   * genuinely a zero balance, and failing here would block recovery entirely.
   */
  async readLpVaultIdle(vault: LpVaultState): Promise<{ amountA: number; amountB: number }> {
    const read = async (acct: PublicKey): Promise<number> => {
      try {
        const b = await this.connection.getTokenAccountBalance(acct);
        return Number(b.value.amount) || 0;
      } catch {
        return 0;
      }
    };
    const [amountA, amountB] = await Promise.all([
      read(vault.vaultTokenAAccount),
      read(vault.vaultTokenBAccount),
    ]);
    return { amountA, amountB };
  }

  async readPoolTickCurrent(vault: LpVaultState): Promise<{ tickCurrent: number; tickSpacing: number }> {
    const info = await this.connection.getAccountInfo(vault.pool);
    if (!info) throw new Error(`Pool account not found: ${vault.pool.toBase58()}`);
    const isRaydium = "raydium" in (vault.protocol as any);
    if (isRaydium) {
      return {
        tickCurrent: info.data.readInt32LE(269),
        tickSpacing: info.data.readUInt16LE(235),
      };
    }
    return {
      tickCurrent: info.data.readInt32LE(81),
      tickSpacing: info.data.readUInt16LE(41),
    };
  }

  private readWhirlpoolVaults(data: Buffer): { tokenVaultA: PublicKey; tokenVaultB: PublicKey } {
    return {
      tokenVaultA: new PublicKey(data.subarray(133, 165)),
      tokenVaultB: new PublicKey(data.subarray(213, 245)),
    };
  }
  private readRaydiumPoolVaults(data: Buffer): { tokenVaultA: PublicKey; tokenVaultB: PublicKey } {
    return {
      tokenVaultA: new PublicKey(data.subarray(137, 169)),
      tokenVaultB: new PublicKey(data.subarray(169, 201)),
    };
  }

  /**
   * Fully exit an LP vault's active position (decrease all liquidity, close
   * the position) — keeper-signed, matches exit_orca_lp_position /
   * exit_raydium_lp_position's on-chain `keeper` constraint. Branches on
   * vault.protocol since each protocol needs different accounts, mirroring
   * the on-chain program's own separate-instructions-per-protocol design.
   *
   * NOTE: reopening a position (open_new_*_lp_position) is admin-gated, not
   * keeper-gated, on purpose — the keeper can pull a position out of harm's
   * way autonomously, but choosing a brand-new price range is a judgment
   * call reserved for the admin key. This method does not attempt that step;
   * callers should surface the "needs admin reopen" case loudly instead of
   * silently trying to sign an instruction the keeper key isn't authorized
   * for (see index.ts's runLpVaultCheck).
   */
  /**
   * Decode a Raydium CLMM pool's reward slots.
   *
   * Layout comes from Raydium's ON-CHAIN IDL, not guesswork: PoolState.reward_infos
   * sits at offset 397 with a 169-byte stride, and within each RewardInfo
   * reward_state@0, token_mint@57, token_vault@89.
   *
   * decrease_liquidity (used by withdraw AND exit) collects reward emissions in the
   * same instruction and validates
   *   remaining_accounts.len() == initialized_reward_count * 2
   * failing InvalidRewardInputAccountNumber (6030) otherwise. A slot counts as
   * initialized whenever reward_state != 0 — "Ended" (3) still counts.
   */
  readRaydiumRewards(poolData: Buffer): { mint: PublicKey; vault: PublicKey }[] {
    const BASE = 397, STRIDE = 169, STATE = 0, MINT = 57, VAULT = 89;
    const out: { mint: PublicKey; vault: PublicKey }[] = [];
    for (let i = 0; i < 3; i++) {
      const o = BASE + i * STRIDE;
      if (o + STRIDE > poolData.length) break;
      if (poolData[o + STATE] === 0) continue;
      out.push({
        mint: new PublicKey(poolData.subarray(o + MINT, o + MINT + 32)),
        vault: new PublicKey(poolData.subarray(o + VAULT, o + VAULT + 32)),
      });
    }
    return out;
  }

  /**
   * Build the remaining accounts decrease_liquidity expects, plus any idempotent ATA
   * creations needed so the recipients exist. The recipient is an ATA owned by the
   * vault authority for each reward mint; if it does not exist the CPI fails.
   */
  buildRaydiumRewardAccounts(
    rewards: { mint: PublicKey; vault: PublicKey }[],
    vaultAuthority: PublicKey
  ): { remaining: AccountMeta[]; preIxs: TransactionInstruction[] } {
    const remaining: AccountMeta[] = [];
    const preIxs: TransactionInstruction[] = [];
    for (const r of rewards) {
      const recipient = getAssociatedTokenAddressSync(r.mint, vaultAuthority, true);
      preIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          this.keeper.publicKey, recipient, vaultAuthority, r.mint
        )
      );
      remaining.push({ pubkey: r.vault, isSigner: false, isWritable: true });
      remaining.push({ pubkey: recipient, isSigner: false, isWritable: true });
    }
    return { remaining, preIxs };
  }

  /**
   * Send instructions as a VERSIONED (v0) transaction, optionally through an Address
   * Lookup Table.
   *
   * Raydium LP instructions do not fit a legacy transaction: initialize_raydium_lp_vault
   * is 1245 bytes against the 1232 limit once the required compute-budget instruction is
   * included, and there is no combination that fits without an ALT (measured on the local
   * harness — with an ALT the same transaction is 878 bytes). They also exceed the 200k
   * default compute budget, because open_position additionally creates Metaplex metadata.
   *
   * Set LP_ADDRESS_LOOKUP_TABLE to the published table. Without it this still sends a v0
   * transaction, which is fine for the smaller instructions but WILL fail on
   * initialize_raydium_lp_vault.
   */
  async sendV0(
    instructions: TransactionInstruction[],
    label: string,
    opts: { computeUnits?: number; extraSigners?: Keypair[] } = {}
  ): Promise<string | null> {
    const lookupTables: AddressLookupTableAccount[] = [];
    const altAddr = process.env.LP_ADDRESS_LOOKUP_TABLE;
    if (altAddr) {
      const fetched = await this.connection.getAddressLookupTable(new PublicKey(altAddr));
      if (fetched.value) lookupTables.push(fetched.value);
      else logger.warn(`LP_ADDRESS_LOOKUP_TABLE ${altAddr} not found on chain — sending without it`);
    }

    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnits ?? 600_000 }),
      ...instructions,
    ];

    return this.sendWithRetry(async () => {
      const { blockhash } = await this.connection.getLatestBlockhash();
      const msg = new TransactionMessage({
        payerKey: this.keeper.publicKey,
        recentBlockhash: blockhash,
        instructions: ixs,
      }).compileToV0Message(lookupTables);
      const tx = new VersionedTransaction(msg);
      tx.sign([this.keeper, ...(opts.extraSigners ?? [])]);
      const size = tx.serialize().length;
      if (size > 1232) {
        throw new Error(
          `${label}: transaction is ${size} bytes, over the 1232 limit. ` +
          `Set LP_ADDRESS_LOOKUP_TABLE to a published lookup table.`
        );
      }
      const sig = await this.connection.sendTransaction(tx);
      await this.connection.confirmTransaction(sig, "confirmed");
      return sig;
    }, label);
  }

  /**
   * Open a NEW position at `tickLower`/`tickUpper` and move the vault's idle tokens into
   * it. This is the second half of a reposition — without it the keeper can only exit,
   * and the vault sits in cash until a human intervenes.
   *
   * Returns { openSig, redeploySig, liquidity } so the caller can log what happened.
   *
   * ON SIZING: the client does not replicate Orca/Raydium's liquidity math. It asks for
   * the liquidity the vault held before the exit and, if the pool rejects it on slippage
   * (the required token amounts exceed what the idle balance can cover at the NEW price),
   * halves the request and retries. That converges on close-to-maximum deployment within
   * a few attempts without a second implementation of the AMM math to get wrong. It is
   * deliberately approximate — replicating the quote math on-chain or in the client is
   * the exact byte-offset/precision territory that has cost this project the most.
   */
  async repositionLpVault(
    lpVaultAddress: string,
    tickLower: number,
    tickUpper: number,
    targetLiquidity: anchor.BN
  ): Promise<{ openSig: string | null; redeploySig: string | null; liquidity: string } | null> {
    const lpVaultPubkey = new PublicKey(lpVaultAddress);
    const vault = await this.fetchLpVault(lpVaultAddress);
    const isRaydium = "raydium" in (vault.protocol as any);
    if (isRaydium) {
      logger.warn("  Raydium reposition not wired yet — Orca only for now");
      return null;
    }

    const [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_vault_authority"), lpVaultPubkey.toBuffer()],
      this.program.programId
    );

    // A fresh position NFT mint. It does not exist yet, so it must sign.
    const positionMint = Keypair.generate();
    const [position] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), positionMint.publicKey.toBuffer()],
      WHIRLPOOL_PROGRAM_ID
    );
    const positionTokenAccount = getAssociatedTokenAddressSync(
      positionMint.publicKey, vaultAuthorityPda, true
    );

    const openSig = await this.sendWithRetry(
      () =>
        this.program.methods
          .openNewOrcaLpPosition(tickLower, tickUpper)
          .accountsPartial({
            authority: this.keeper.publicKey,
            lpVault: lpVaultPubkey,
            vaultAuthority: vaultAuthorityPda,
            position,
            positionMint: positionMint.publicKey,
            positionTokenAccount,
            whirlpool: vault.pool,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            whirlpoolProgram: WHIRLPOOL_PROGRAM_ID,
          })
          .signers([positionMint])
          .rpc(),
      `openNewOrcaLpPosition(${lpVaultAddress.slice(0, 8)}...)`
    );
    if (!openSig) return { openSig: null, redeploySig: null, liquidity: "0" };

    const poolInfo = await this.connection.getAccountInfo(vault.pool);
    if (!poolInfo) throw new Error("pool vanished mid-reposition");
    const { tickSpacing } = await this.readPoolTickCurrent(vault);
    const { tokenVaultA, tokenVaultB } = this.readWhirlpoolVaults(poolInfo.data);
    const { tickArrayLower, tickArrayUpper } = getPositionTickArrays(
      vault.pool, tickLower, tickUpper, tickSpacing, WHIRLPOOL_PROGRAM_ID
    );

    // Halving ladder — see note above.
    let liquidity = targetLiquidity;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const sig = await this.program.methods
          .redeployOrcaLpLiquidity(liquidity, new anchor.BN("18446744073709551615"), new anchor.BN("18446744073709551615"))
          .accountsPartial({
            keeper: this.keeper.publicKey,
            lpVault: lpVaultPubkey,
            vaultAuthority: vaultAuthorityPda,
            vaultTokenAAccount: vault.vaultTokenAAccount,
            vaultTokenBAccount: vault.vaultTokenBAccount,
            whirlpool: vault.pool,
            position,
            positionTokenAccount,
            tokenVaultA,
            tokenVaultB,
            tickArrayLower,
            tickArrayUpper,
            tokenProgram: TOKEN_PROGRAM_ID,
            whirlpoolProgram: WHIRLPOOL_PROGRAM_ID,
          })
          .rpc();
        logger.info(`  Redeployed ${liquidity.toString()} liquidity (attempt ${attempt + 1})`);
        return { openSig, redeploySig: sig, liquidity: liquidity.toString() };
      } catch (err: any) {
        const msg = err.message || "";
        // 0x1781 = 6017 PriceSlippageCheck — asked for more than the idle can back.
        if (!/1781|PriceSlippage|SlippageExceeded/i.test(msg)) throw err;
        liquidity = liquidity.divn(2);
        if (liquidity.isZero()) break;
        logger.warn(`  Redeploy too large, halving to ${liquidity.toString()}`);
      }
    }

    logger.error("  Could not redeploy any liquidity — vault is left IDLE, will retry next run");
    return { openSig, redeploySig: null, liquidity: "0" };
  }

  async exitLpPosition(lpVaultAddress: string): Promise<string | null> {
    const lpVaultPubkey = new PublicKey(lpVaultAddress);
    const vault = await this.fetchLpVault(lpVaultAddress);
    const isRaydium = "raydium" in (vault.protocol as any);

    const [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_vault_authority"), lpVaultPubkey.toBuffer()],
      this.program.programId
    );

    const poolInfo = await this.connection.getAccountInfo(vault.pool);
    if (!poolInfo) throw new Error(`Pool account not found: ${vault.pool.toBase58()}`);

    if (isRaydium) {
      const { tickSpacing } = await this.readPoolTickCurrent(vault);
      const { tokenVaultA, tokenVaultB } = this.readRaydiumPoolVaults(poolInfo.data);
      const { tickArrayLower, tickArrayUpper } = getRaydiumPositionTickArrays(
        vault.pool, vault.tickLowerIndex, vault.tickUpperIndex, tickSpacing, RAYDIUM_CLMM_PROGRAM_ID
      );

      // Raydium's decrease_liquidity collects reward emissions in the same instruction
      // and validates the remaining-account count against the pool's initialized
      // rewards. Passing none fails InvalidRewardInputAccountNumber (6030) — proven on
      // the local harness. Recipients must already exist, hence the idempotent ATA
      // creations sent ahead of the exit in the same transaction.
      const rewards = this.readRaydiumRewards(poolInfo.data);
      const { remaining, preIxs } = this.buildRaydiumRewardAccounts(rewards, vaultAuthorityPda);
      logger.info(`  Raydium rewards: ${rewards.length} initialized -> ${remaining.length} remaining accounts`);

      const exitIx = await this.program.methods
        .exitRaydiumLpPosition()
        .accountsPartial({
          keeper: this.keeper.publicKey,
          lpVault: lpVaultPubkey,
          vaultAuthority: vaultAuthorityPda,
          vaultTokenAAccount: vault.vaultTokenAAccount,
          vaultTokenBAccount: vault.vaultTokenBAccount,
          positionNftAccount: vault.positionTokenAccount,
          poolState: vault.pool,
          protocolPosition: vault.protocolPosition,
          personalPosition: vault.position,
          positionNftMint: vault.positionMint,
          tickArrayLower,
          tickArrayUpper,
          tokenVault0: tokenVaultA,
          tokenVault1: tokenVaultB,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          raydiumProgram: RAYDIUM_CLMM_PROGRAM_ID,
        })
        .remainingAccounts(remaining)
        .instruction();

      // v0 + ALT: Raydium LP instructions do not fit a legacy transaction.
      return this.sendV0(
        [...preIxs, exitIx],
        `exitRaydiumLpPosition(${lpVaultAddress.slice(0, 8)}...)`
      );
    }

    const { tickSpacing } = await this.readPoolTickCurrent(vault);
    const { tokenVaultA, tokenVaultB } = this.readWhirlpoolVaults(poolInfo.data);
    const { tickArrayLower, tickArrayUpper } = getPositionTickArrays(
      vault.pool, vault.tickLowerIndex, vault.tickUpperIndex, tickSpacing, WHIRLPOOL_PROGRAM_ID
    );

    return this.sendWithRetry(
      () =>
        this.program.methods
          .exitOrcaLpPosition()
          .accountsPartial({
            keeper: this.keeper.publicKey,
            lpVault: lpVaultPubkey,
            vaultAuthority: vaultAuthorityPda,
            vaultTokenAAccount: vault.vaultTokenAAccount,
            vaultTokenBAccount: vault.vaultTokenBAccount,
            whirlpool: vault.pool,
            position: vault.position,
            positionMint: vault.positionMint,
            positionTokenAccount: vault.positionTokenAccount,
            tokenVaultA,
            tokenVaultB,
            tickArrayLower,
            tickArrayUpper,
            tokenProgram: TOKEN_PROGRAM_ID,
            whirlpoolProgram: WHIRLPOOL_PROGRAM_ID,
          })
          .rpc(),
      `exitOrcaLpPosition(${lpVaultAddress.slice(0, 8)}...)`
    );
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

