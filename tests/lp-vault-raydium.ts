/**
 * tests/lp-vault-raydium.ts — local-validator integration test for the
 * Raydium CLMM side of the LP vault, against a REAL cloned mainnet pool.
 *
 * ============================== STATUS: DRAFT / UNVERIFIED ==============================
 * Written without access to a local `anchor`/`solana-test-validator`
 * toolchain — it has NOT been run. Mirrors tests/lp-vault-orca.ts's
 * structure and honesty about what's actually filled in vs. stubbed; read
 * that file's top-of-file notes too, since the funding/quote TODOs are the
 * same shape here.
 * ==========================================================================================
 *
 * Pool used: a real SOL/USDC Raydium CLMM pool, verified live via Raydium's
 * own API (api-v3.raydium.io/pools/info/mint, 2026-07-09):
 *   id (pool_state): 3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv
 *   programId:        CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
 *   mintA (SOL):      So11111111111111111111111111111111111111112
 *   mintB (USDC):     EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
 *   tickSpacing:      1
 * Distinct from the Orca pool used in lp-vault-orca.ts — different pool,
 * different program, chosen independently and re-verified against
 * Raydium's real API rather than reusing the Orca address by assumption.
 *
 * ── TODO before this can pass (same shape as lp-vault-orca.ts) ─────────────
 * (1) Fund the test wallet with real USDC — Circle's mint authority isn't
 *     ours, so this needs either a manually-crafted local token account
 *     (spl-token AccountLayout.encode -> solana-test-validator --account)
 *     or cloning a whale's existing USDC token account. Not wired in here.
 * (2) Compute real deposit/withdraw liquidity + slippage bounds from the
 *     live pool's price via LiquidityMathUtil/TickUtil (see
 *     app/src/hooks/useLpVault.ts's getRaydiumDepositQuote /
 *     getRaydiumWithdrawQuote) rather than a placeholder amount.
 *
 * Anchor.toml additions needed (documented, not applied — same reasoning as
 * lp-vault-orca.ts: this changes what `anchor test` clones for the whole
 * suite, a deliberate call rather than a silent side effect):
 *
 *   [[test.validator.clone]]
 *   address = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"  # Raydium CLMM program
 *
 *   [[test.validator.clone]]
 *   address = "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv"  # SOL/USDC pool_state
 *
 *   [[test.validator.clone]]
 *   address = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"  # USDC mint
 *
 *   [[test.validator.clone]]
 *   address = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"  # Metaplex Token Metadata program
 *
 *   # Plus the pool's token vaults and whichever tick arrays cover the
 *   # range this test opens a position in — same "fetch dynamically rather
 *   # than hardcode" reasoning as lp-vault-orca.ts, since which tick arrays
 *   # exist can drift as the real pool trades. An uninitialized tick array
 *   # fails the CPI with a clear error, which is an acceptable fallback if
 *   # the clone list is incomplete.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Yieldpilot } from "../target/types/yieldpilot";
import {
  createAssociatedTokenAccount, getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";

// ── Real mainnet addresses (cloned into the local validator) ────────────────
const RAYDIUM_CLMM_PROGRAM_ID = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const SOL_USDC_POOL_STATE = new PublicKey("3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv");
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const POOL_TICK_SPACING = 1;

// Same PDA derivation as adapters/raydium.rs's PDA seed notes and
// app/src/hooks/useLpVault.ts's Raydium helpers — big-endian tick encoding,
// unlike Orca's decimal-string encoding. Duplicated here rather than shared,
// same "no shared internal library today" reasoning as the Orca test file.
const RAYDIUM_TICKS_PER_ARRAY = 60; // TICK_ARRAY_SIZE, verified against @raydium-io/raydium-sdk-v2

function i32ToBeBytes(n: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(n, 0);
  return buf;
}
function getTickArrayStartIndex(tickIndex: number, tickSpacing: number): number {
  const ticksInArray = tickSpacing * RAYDIUM_TICKS_PER_ARRAY;
  return Math.floor(tickIndex / ticksInArray) * ticksInArray;
}
function getTickArrayPda(poolState: PublicKey, tickIndex: number, tickSpacing: number): PublicKey {
  const startTickIndex = getTickArrayStartIndex(tickIndex, tickSpacing);
  const [address] = PublicKey.findProgramAddressSync(
    [Buffer.from("tick_array"), poolState.toBuffer(), i32ToBeBytes(startTickIndex)],
    RAYDIUM_CLMM_PROGRAM_ID
  );
  return address;
}
function getProtocolPositionPda(poolState: PublicKey, tickLowerIndex: number, tickUpperIndex: number): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), poolState.toBuffer(), i32ToBeBytes(tickLowerIndex), i32ToBeBytes(tickUpperIndex)],
    RAYDIUM_CLMM_PROGRAM_ID
  );
  return address;
}
function getPersonalPositionPda(positionNftMint: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), positionNftMint.toBuffer()],
    RAYDIUM_CLMM_PROGRAM_ID
  );
  return address;
}
// Standard Metaplex Token Metadata PDA seeds — not Raydium-specific.
function getMetadataPda(mint: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID
  );
  return address;
}

async function readPoolTickCurrentAndVaults(connection: anchor.web3.Connection) {
  const info = await connection.getAccountInfo(SOL_USDC_POOL_STATE);
  if (!info) throw new Error("pool_state account not found — did you clone it into the local validator?");
  // Byte offsets verified against @raydium-io/raydium-sdk-v2's compiled
  // PoolInfoLayout (see app/src/hooks/useLpVault.ts's decodeRaydiumPool for
  // the full field-by-field derivation).
  const data = info.data;
  return {
    tickCurrent: data.readInt32LE(269),
    tokenVaultA: new PublicKey(data.subarray(137, 169)),
    tokenVaultB: new PublicKey(data.subarray(169, 201)),
  };
}

describe("LP vault — Raydium CLMM (local validator, cloned mainnet pool)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Yieldpilot as Program<Yieldpilot>;
  const admin = provider.wallet as anchor.Wallet;
  const keeper = Keypair.generate();
  const alice = Keypair.generate();

  let lpVaultPda: PublicKey;
  let vaultAuthorityPda: PublicKey;
  let sharesMint: Keypair;
  let vaultTokenAAccount: PublicKey; // SOL
  let vaultTokenBAccount: PublicKey; // USDC
  let positionNftMintKeypair: Keypair;
  let positionNftAccount: PublicKey;
  let metadataAccount: PublicKey;
  let protocolPositionPda: PublicKey;
  let personalPositionPda: PublicKey;

  let aliceTokenAAccount: PublicKey; // SOL (WSOL — freely wrappable, same as the Orca test)
  let aliceTokenBAccount: PublicKey; // USDC — see TODO block, must be pre-funded externally
  let aliceSharesAccount: PublicKey;
  let alicePositionPda: PublicKey;

  let tickLowerIndex: number;
  let tickUpperIndex: number;
  let tickArrayLowerStartIndex: number;
  let tickArrayUpperStartIndex: number;
  let tickArrayLower: PublicKey;
  let tickArrayUpper: PublicKey;
  let tokenVaultA: PublicKey;
  let tokenVaultB: PublicKey;

  before(async () => {
    const sig = await provider.connection.requestAirdrop(alice.publicKey, 5e9);
    await provider.connection.confirmTransaction(sig);
    const sig2 = await provider.connection.requestAirdrop(keeper.publicKey, 1e9);
    await provider.connection.confirmTransaction(sig2);

    const { tickCurrent, tokenVaultA: vA, tokenVaultB: vB } = await readPoolTickCurrentAndVaults(provider.connection);
    tokenVaultA = vA;
    tokenVaultB = vB;

    const align = (t: number) => Math.round(t / POOL_TICK_SPACING) * POOL_TICK_SPACING;
    tickLowerIndex = align(tickCurrent - 4000);
    tickUpperIndex = align(tickCurrent + 4000);
    tickArrayLowerStartIndex = getTickArrayStartIndex(tickLowerIndex, POOL_TICK_SPACING);
    tickArrayUpperStartIndex = getTickArrayStartIndex(tickUpperIndex, POOL_TICK_SPACING);
    tickArrayLower = getTickArrayPda(SOL_USDC_POOL_STATE, tickLowerIndex, POOL_TICK_SPACING);
    tickArrayUpper = getTickArrayPda(SOL_USDC_POOL_STATE, tickUpperIndex, POOL_TICK_SPACING);
    protocolPositionPda = getProtocolPositionPda(SOL_USDC_POOL_STATE, tickLowerIndex, tickUpperIndex);

    [lpVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_vault"), SOL_MINT.toBuffer(), USDC_MINT.toBuffer(), admin.publicKey.toBuffer()],
      program.programId
    );
    [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_vault_authority"), lpVaultPda.toBuffer()],
      program.programId
    );
    [alicePositionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_position"), lpVaultPda.toBuffer(), alice.publicKey.toBuffer()],
      program.programId
    );

    sharesMint = Keypair.generate();
    positionNftMintKeypair = Keypair.generate();
    personalPositionPda = getPersonalPositionPda(positionNftMintKeypair.publicKey);
    metadataAccount = getMetadataPda(positionNftMintKeypair.publicKey);

    vaultTokenAAccount = await getAssociatedTokenAddress(SOL_MINT, vaultAuthorityPda, true);
    vaultTokenBAccount = await getAssociatedTokenAddress(USDC_MINT, vaultAuthorityPda, true);
    positionNftAccount = await getAssociatedTokenAddress(positionNftMintKeypair.publicKey, vaultAuthorityPda, true);

    aliceTokenAAccount = await createAssociatedTokenAccount(provider.connection, alice, SOL_MINT, alice.publicKey);
    aliceTokenBAccount = await getAssociatedTokenAddress(USDC_MINT, alice.publicKey);
    // NOTE: not funded here — see TODO block at the top of this file, same
    // limitation as tests/lp-vault-orca.ts.
    aliceSharesAccount = await getAssociatedTokenAddress(sharesMint.publicKey, alice.publicKey);
  });

  it("initializes a Raydium LP vault at a real cloned pool", async () => {
    await program.methods
      .initializeRaydiumLpVault({
        keeper: keeper.publicKey,
        treasury: admin.publicKey,
        tickLowerIndex,
        tickUpperIndex,
        tickArrayLowerStartIndex,
        tickArrayUpperStartIndex,
        name: "SOL/USDC Raydium LP (test)",
      })
      .accountsPartial({
        admin: admin.publicKey,
        lpVault: lpVaultPda,
        vaultAuthority: vaultAuthorityPda,
        tokenAMint: SOL_MINT,
        tokenBMint: USDC_MINT,
        vaultTokenAAccount,
        vaultTokenBAccount,
        lpSharesMint: sharesMint.publicKey,
        positionNftMint: positionNftMintKeypair.publicKey,
        positionNftAccount,
        metadataAccount,
        poolState: SOL_USDC_POOL_STATE,
        protocolPosition: protocolPositionPda,
        tickArrayLower,
        tickArrayUpper,
        personalPosition: personalPositionPda,
        tokenAccount0: vaultTokenAAccount,
        tokenAccount1: vaultTokenBAccount,
        tokenVault0: tokenVaultA,
        tokenVault1: tokenVaultB,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        metadataProgram: METADATA_PROGRAM_ID,
        raydiumProgram: RAYDIUM_CLMM_PROGRAM_ID,
      })
      .signers([sharesMint, positionNftMintKeypair])
      .rpc();

    const vault = await program.account.lpVault.fetch(lpVaultPda);
    assert.equal(vault.pool.toBase58(), SOL_USDC_POOL_STATE.toBase58());
    assert.equal(vault.protocolPosition.toBase58(), protocolPositionPda.toBase58());
    assert.equal(vault.tickLowerIndex, tickLowerIndex);
    assert.equal(vault.tickUpperIndex, tickUpperIndex);
    assert.isTrue(vault.positionActive);
    assert.equal(vault.totalLiquidity.toString(), "0");
  });

  it("deposits real liquidity from alice and mints proportional shares", async () => {
    // Same limitation as tests/lp-vault-orca.ts's equivalent test — needs a
    // real deposit quote (see app/src/hooks/useLpVault.ts's
    // getRaydiumDepositQuote, which uses @raydium-io/raydium-sdk-v2's real
    // LiquidityMathUtil/TickUtil against this pool's live sqrtPrice) and a
    // funded alice USDC account.
    throw new Error(
      "TODO: compute a real deposit quote via getRaydiumDepositQuote before calling depositRaydiumLp — not filled in in this draft."
    );
  });

  it("withdraws shares back and returns real SOL/USDC to alice", async () => {
    throw new Error("TODO: mirror the deposit test's TODO — compute a real withdraw quote and call withdrawRaydiumLp.");
  });

  it("keeper can exit the position and admin can reopen at a new range", async () => {
    throw new Error("TODO: call exitRaydiumLpPosition as keeper, then openNewRaydiumLpPosition as admin, assert position_active toggles correctly.");
  });
});
