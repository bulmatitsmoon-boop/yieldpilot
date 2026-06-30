import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";
import { logger } from "./logger";

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

// ─────────────────────────────────────────────────────────────────────────────
// Marinade mainnet constants
// ─────────────────────────────────────────────────────────────────────────────
const MARINADE_PROGRAM = new PublicKey("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");
const MARINADE_STATE = new PublicKey("8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC");
const MSOL_MINT = new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");
const MARINADE_LIQ_POOL_SOL_LEG = new PublicKey("UefNb6z6yvArqe4cJHTXCqStRsKmWhGxnZzuHbikP5Q");
const MARINADE_LIQ_POOL_MSOL_LEG = new PublicKey("7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE");
const MARINADE_LIQ_POOL_MSOL_AUTH = new PublicKey("JCDfVPvoz71ciFV2dy6gfazgja3ZMQKXkqkm5J6HP2j5"); // PDA seed "liq_pool_msol_mint"
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

// ─────────────────────────────────────────────────────────────────────────────
// Solend mainnet constants
// ─────────────────────────────────────────────────────────────────────────────
const SOLEND_PROGRAM = new PublicKey("So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo");
const SOLEND_MAIN_MARKET = new PublicKey("4UpD2fh7xH3VP9QQaXtsS1YY3bxzWhtfpks7FatyKvdY");
const SOLEND_USDC_RESERVE = new PublicKey("BgxfHJDzm44T7XG68MYKx7YisTjZu73tVovyZSjJMpmw");
const SOLEND_USDC_LIQUIDITY_SUPPLY = new PublicKey("8SheGtsopRUDzdiD6v6BR9a6bqZ9QwywYQY99Fp5meNf");
const SOLEND_USDC_COLLATERAL_MINT = new PublicKey("993dVFL2uXWYeoXuEBFXR4BijeXdTv4s6BzsCjJZuwqk");
const SOLEND_USDC_ORACLE = new PublicKey("ExzpbWgczTgd8J58BrnESndmzBkRVfc6PhyfpdGgLjkf");

// ─────────────────────────────────────────────────────────────────────────────
// MarginFi mainnet constants
// ─────────────────────────────────────────────────────────────────────────────
const MARGINFI_PROGRAM = new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
const MARGINFI_MAIN_GROUP = new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8");
const MARGINFI_USDC_BANK = new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB"); // verified: $625k TVL

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
    this.connection = new Connection(rpcUrl, {
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 60_000,
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
    const idlPath = path.resolve(__dirname, "idl/yieldpilot.json");
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

  // ── Transaction helpers ───────────────────────────────────────────────────

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
    oracleAccounts: PublicKey[] = []
  ): Promise<string | null> {
    const vaultPubkey = new PublicKey(vaultAddress);
    const vault = await this.fetchVault(vaultAddress);
    const kamino = this.getKaminoAccounts(vaultPubkey, vault);

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
            kaminoCollateralSupply: kamino.collateralSupply,
            tokenProgram: TOKEN_PROGRAM_ID,
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
    oracleAccounts: PublicKey[] = []
  ): Promise<string | null> {
    const vaultPubkey = new PublicKey(vaultAddress);
    const vault = await this.fetchVault(vaultAddress);
    const kamino = this.getKaminoAccounts(vaultPubkey, vault);

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
            kaminoCollateralSupply: kamino.collateralSupply,
            tokenProgram: TOKEN_PROGRAM_ID,
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
    oracleAccounts: PublicKey[] = []
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
            kaminoCollateralSupply: KAMINO_SOL_COLLATERAL_SUPPLY,
            tokenProgram: TOKEN_PROGRAM_ID,
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
    oracleAccounts: PublicKey[] = []
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
            kaminoCollateralSupply: KAMINO_SOL_COLLATERAL_SUPPLY,
            tokenProgram: TOKEN_PROGRAM_ID,
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
            stakePoolProgram: poolConfig.stakePoolProgram,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
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
            stakePoolProgram: poolConfig.stakePoolProgram,
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
            tokenProgram: TOKEN_PROGRAM_ID,
            solendProgram: SOLEND_PROGRAM,
          })
          .rpc(),
      `recallFromSolend(${vaultAddress.slice(0, 8)}... ${collateralAmount.toString()} cUSDC)`
    );
  }

  // ── MarginFi ──────────────────────────────────────────────────────────────

  async deployToMarginFi(vaultAddress: string, protocolIndex: number, amount: anchor.BN): Promise<string | null> {
    const vaultPubkey = new PublicKey(vaultAddress);
    const vault = await this.fetchVault(vaultAddress);
    const vaultAuthority = this.getVaultAuthority(vaultPubkey, vault.authorityBump);

    // marginfi_account PDA: ["marginfi_account", group, authority] with MarginFi program
    // The vault stores its marginfi_account address in vault_receipt_account field
    const [marginfiAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("marginfi_account"), MARGINFI_MAIN_GROUP.toBuffer(), vaultAuthority.toBuffer()],
      MARGINFI_PROGRAM
    );

    // Bank liquidity vault: PDA ["liquidity_vault", bank] with MarginFi program
    const [bankLiquidityVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("liquidity_vault"), MARGINFI_USDC_BANK.toBuffer()],
      MARGINFI_PROGRAM
    );

    return this.sendWithRetry(
      () =>
        this.program.methods
          .deployToMarginfi(protocolIndex, amount)
          .accounts({
            keeper: this.keeper.publicKey,
            vault: vaultPubkey,
            vaultAuthority,
            vaultTokenAccount: vault.vaultTokenAccount,
            marginfiGroup: MARGINFI_MAIN_GROUP,
            marginfiAccount,
            bank: MARGINFI_USDC_BANK,
            bankLiquidityVault,
            tokenProgram: TOKEN_PROGRAM_ID,
            marginfiProgram: MARGINFI_PROGRAM,
          })
          .rpc(),
      `deployToMarginFi(${vaultAddress.slice(0, 8)}... ${amount.toString()} USDC)`
    );
  }

  async recallFromMarginFi(vaultAddress: string, protocolIndex: number, amount: anchor.BN, withdrawAll = false): Promise<string | null> {
    const vaultPubkey = new PublicKey(vaultAddress);
    const vault = await this.fetchVault(vaultAddress);
    const vaultAuthority = this.getVaultAuthority(vaultPubkey, vault.authorityBump);

    const [marginfiAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("marginfi_account"), MARGINFI_MAIN_GROUP.toBuffer(), vaultAuthority.toBuffer()],
      MARGINFI_PROGRAM
    );

    const [bankLiquidityVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("liquidity_vault"), MARGINFI_USDC_BANK.toBuffer()],
      MARGINFI_PROGRAM
    );

    const [bankLiquidityVaultAuth] = PublicKey.findProgramAddressSync(
      [Buffer.from("liquidity_vault_auth"), MARGINFI_USDC_BANK.toBuffer()],
      MARGINFI_PROGRAM
    );

    return this.sendWithRetry(
      () =>
        this.program.methods
          .recallFromMarginfi(protocolIndex, amount, withdrawAll)
          .accounts({
            keeper: this.keeper.publicKey,
            vault: vaultPubkey,
            vaultAuthority,
            vaultTokenAccount: vault.vaultTokenAccount,
            marginfiGroup: MARGINFI_MAIN_GROUP,
            marginfiAccount,
            bank: MARGINFI_USDC_BANK,
            bankLiquidityVault,
            bankLiquidityVaultAuthority: bankLiquidityVaultAuth,
            tokenProgram: TOKEN_PROGRAM_ID,
            marginfiProgram: MARGINFI_PROGRAM,
          })
          .rpc(),
      `recallFromMarginFi(${vaultAddress.slice(0, 8)}... ${amount.toString()} USDC)`
    );
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  async getKeeperBalance(): Promise<number> {
    const lamports = await this.connection.getBalance(this.keeper.publicKey);
    return lamports / 1e9;
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

  async getJitoPoolConfig() {
    const data = (await this.connection.getAccountInfo(JITO_POOL))?.data;
    if (!data || data.length < 226) throw new Error("Jito pool account not found or too small");
    const reserveStake = new PublicKey(data.slice(130, 162));
    const managerFeeAccount = new PublicKey(data.slice(194, 226));
    const [withdrawAuthority] = PublicKey.findProgramAddressSync(
      [JITO_POOL.toBuffer(), Buffer.from("withdraw")],
      JITO_PROGRAM
    );
    return {
      stakePool: JITO_POOL,
      withdrawAuthority,
      reserveStake,
      managerFeeAccount,
      poolMint: JITOSOL_MINT,
      lstMint: JITOSOL_MINT,
      stakePoolProgram: JITO_PROGRAM,
    };
  }

  // ── Execute rebalance: move funds to match target allocations ─────────────
  //
  // Phase 1 - recall from over-deployed protocols (frees idle vault balance)
  // Phase 2 - deploy to under-deployed protocols (uses idle vault balance)

  async executeRebalance(vaultAddress: string, vault: VaultState): Promise<void> {
    const totalDeposits = vault.totalDeposits.toNumber();
    if (totalDeposits === 0) {
      logger.info("executeRebalance: vault empty, skipping");
      return;
    }

    const protocols = vault.protocols.slice(0, vault.protocolCount);
    const deltas = protocols.map((p, i) => ({
      index: i,
      label: Buffer.from(p.label).toString("utf8").replace(/ /g, ""),
      deployed: p.deployedBalance.toNumber(),
      target: Math.floor(totalDeposits * p.targetBps.toNumber() / 10_000),
      receiptAccount: p.vaultReceiptAccount,
    }));

    // Phase 1: Recalls
    const toRecall = deltas
      .map(d => ({ ...d, excess: d.deployed - d.target }))
      .filter(d => d.excess > 0)
      .sort((a, b) => b.excess - a.excess);

    for (const d of toRecall) {
      logger.info("Recall from protocol", { label: d.label, excess: d.excess, deployed: d.deployed, target: d.target });
      try {
        if (d.label === "marginfi-usdc" || d.label === "marginfi-sol") {
          const withdrawAll = d.target === 0;
          await this.recallFromMarginFi(vaultAddress, d.index, new anchor.BN(d.excess), withdrawAll);
        } else {
          const receiptBalance = await this.getTokenBalance(d.receiptAccount);
          if (receiptBalance === 0) { logger.warn("No receipt balance, skipping", { label: d.label }); continue; }
          const receiptToWithdraw = new anchor.BN(Math.max(1, Math.floor(receiptBalance * d.excess / d.deployed)));
          if (d.label === "kamino-usdc") {
            await this.recallFromKamino(vaultAddress, d.index, receiptToWithdraw);
          } else if (d.label === "kamino-sol") {
            await this.recallFromKaminoSol(vaultAddress, d.index, receiptToWithdraw);
          } else if (d.label === "marinade-sol") {
            await this.recallFromMarinade(vaultAddress, d.index, receiptToWithdraw);
          } else if (d.label === "jito-sol") {
            const cfg = await this.getJitoPoolConfig();
            await this.recallFromSolLst(vaultAddress, d.index, receiptToWithdraw, cfg);
          } else if (d.label === "solend-usdc") {
            await this.recallFromSolend(vaultAddress, d.index, receiptToWithdraw);
          } else {
            logger.warn("No recall handler for protocol", { label: d.label });
          }
        }
      } catch (err: any) {
        logger.error("Recall failed", { label: d.label, error: err.message });
      }
    }

    // Phase 2: Deploys
    const toDeposit = deltas
      .map(d => ({ ...d, deficit: d.target - d.deployed }))
      .filter(d => d.deficit > 0)
      .sort((a, b) => b.deficit - a.deficit);

    let available = await this.getTokenBalance(vault.vaultTokenAccount);
    logger.info("Idle vault balance after recalls", { available });

    for (const d of toDeposit) {
      if (available <= 0) break;
      const amount = new anchor.BN(Math.min(d.deficit, available));
      if (amount.isZero()) continue;

      logger.info("Deploy to protocol", { label: d.label, amount: amount.toString(), deficit: d.deficit });
      try {
        if (d.label === "kamino-usdc") {
          await this.deployToKamino(vaultAddress, d.index, amount);
        } else if (d.label === "kamino-sol") {
          await this.deployToKaminoSol(vaultAddress, d.index, amount);
        } else if (d.label === "marinade-sol") {
          await this.deployToMarinade(vaultAddress, d.index, amount);
        } else if (d.label === "jito-sol") {
          const cfg = await this.getJitoPoolConfig();
          await this.deployToSolLst(vaultAddress, d.index, amount, cfg);
        } else if (d.label === "marginfi-usdc" || d.label === "marginfi-sol") {
          await this.deployToMarginFi(vaultAddress, d.index, amount);
        } else if (d.label === "solend-usdc") {
          await this.deployToSolend(vaultAddress, d.index, amount);
        } else {
          logger.warn("No deploy handler for protocol", { label: d.label });
          continue;
        }
        available -= amount.toNumber();
      } catch (err: any) {
        logger.error("Deploy failed", { label: d.label, error: err.message });
      }
    }
  }

}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
