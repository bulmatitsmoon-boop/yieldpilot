/**
 * tests/lp-vault-orca.ts — local-validator integration test for the Orca
 * side of the LP vault, against a REAL cloned mainnet Whirlpool.
 *
 * ============================== STATUS: DRAFT / UNVERIFIED ==============================
 * This file was written without access to a local `anchor`/`solana-test-validator`
 * toolchain — it has NOT been run. Treat every line as "should be correct by
 * inspection," not "confirmed working," until someone actually runs it and
 * fixes whatever breaks (account ordering, PDA seeds, cloned-account edge
 * cases — exactly the class of bug unit math tests in verify-lp-math.mjs
 * cannot catch). See the TODO block below for the one manual step needed
 * before `anchor test` can run this end to end.
 * ==========================================================================================
 *
 * What this actually tests that verify-lp-math.mjs (app/scripts/) doesn't:
 * real account resolution and CPI wiring — PDA derivation matching what the
 * live Whirlpool program expects, correct account ordering in the Anchor
 * Accounts structs, and the actual on-chain math (not a JS reimplementation
 * of it) for initialize_orca_lp_vault / deposit_orca_lp / withdraw_orca_lp /
 * exit_orca_lp_position.
 *
 * Pool used: the real SOL/USDC Whirlpool on mainnet, verified live via
 * Orca's own API (2026-07-09):
 *   address:      Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE
 *   tokenA (SOL): So11111111111111111111111111111111111111112
 *   tokenB (USDC):EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
 *   tickSpacing:  4
 * This is a real, highly-liquid pool — safe to clone read-only state from
 * without needing to fabricate a whole synthetic pool from scratch.
 *
 * ── TODO before this can pass ──────────────────────────────────────────────
 * Cloning the pool gives you REAL SOL/USDC mints, which means the test
 * wallet needs real-looking token balances to deposit — but nothing in a
 * fresh local validator has USDC (its mint authority is Circle's, not
 * something a test can mint against). Two ways to unblock this, neither
 * wired in automatically here:
 *   (a) Run `solana-test-validator` manually (not via `anchor test`) with
 *       `--account <aliceUsdcAccountPubkey> <fabricated-token-account.json>`
 *       — craft a raw SPL token account (mint=USDC, owner=alice, amount=huge)
 *       via `spl-token`'s AccountLayout.encode and dump it as a JSON account
 *       file in solana-test-validator's expected format, OR
 *   (b) Point `[test.validator] url` at a fork of a wallet that already
 *       holds a large USDC balance and clone THAT token account address
 *       directly (simpler, but ties the test to a specific whale wallet that
 *       could theoretically move funds/close the account before you next run
 *       this — less durable than (a)).
 * Neither is implemented here — this file assumes `aliceTokenBAccount`
 * already holds USDC by the time `before()` finishes. Get one of the above
 * working first.
 *
 * Corresponding Anchor.toml additions needed (see PR #69's description) —
 * NOT yet added to the real Anchor.toml, since [test.validator] pointed at
 * a mainnet RPC also changes plain `anchor test` for the main Vault suite
 * (tests/yieldpilot.ts) unless scoped carefully. Suggested minimal form:
 *
 *   [test.validator]
 *   url = "https://api.mainnet-beta.solana.com"
 *
 *   [[test.validator.clone]]
 *   address = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"  # Whirlpool program
 *
 *   [[test.validator.clone]]
 *   address = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE"  # SOL/USDC Whirlpool
 *
 *   [[test.validator.clone]]
 *   address = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"  # USDC mint
 *
 *   # Plus the pool's token vaults and any tick arrays covering the price
 *   # range this test opens a position in — fetch these dynamically in
 *   # before() via getTickArrayPda() below rather than hardcoding them,
 *   # since which tick arrays exist/are initialized can drift as the real
 *   # pool trades. If an uninitialized tick array is hit, the CPI will
 *   # fail with a clear "tick array not initialized" style error — that's
 *   # informative, not a silent failure, so it's an acceptable fallback if
 *   # the clone list above is incomplete.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Yieldpilot } from "../target/types/yieldpilot";
import {
  createAssociatedTokenAccount, getAssociatedTokenAddress, getAccount,
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";

// ── Real mainnet addresses (cloned into the local validator) ────────────────
const WHIRLPOOL_PROGRAM_ID = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const SOL_USDC_WHIRLPOOL = new PublicKey("Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE");
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WHIRLPOOL_TICK_SPACING = 4;

// Same tick-array derivation as keeper/src/lpVaultHelpers.ts and
// app/src/hooks/useLpVault.ts — kept duplicated per those files' own notes
// about there being no shared internal library today.
const TICKS_PER_ARRAY = 88;
function getStartTickIndex(tickIndex: number, tickSpacing: number): number {
  const ticksInArray = tickSpacing * TICKS_PER_ARRAY;
  return Math.floor(tickIndex / ticksInArray) * ticksInArray;
}
function getTickArrayPda(whirlpool: PublicKey, tickIndex: number, tickSpacing: number): PublicKey {
  const startTickIndex = getStartTickIndex(tickIndex, tickSpacing);
  const [address] = PublicKey.findProgramAddressSync(
    [Buffer.from("tick_array"), whirlpool.toBuffer(), Buffer.from(startTickIndex.toString())],
    WHIRLPOOL_PROGRAM_ID
  );
  return address;
}

async function readWhirlpoolTickCurrent(connection: anchor.web3.Connection): Promise<number> {
  const info = await connection.getAccountInfo(SOL_USDC_WHIRLPOOL);
  if (!info) throw new Error("Whirlpool account not found — did you clone it into the local validator?");
  // tick_current_index lives at byte offset 65 (sqrt_price, 16 bytes) + 65 = 81... see
  // app/src/hooks/useLpVault.ts's decodeWhirlpool for the full verified byte layout.
  // Offset 81: tick_current_index (i32).
  return info.data.readInt32LE(81);
}

describe("LP vault — Orca Whirlpools (local validator, cloned mainnet pool)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Yieldpilot as Program<Yieldpilot>;
  const admin = provider.wallet as anchor.Wallet;
  const keeper = Keypair.generate();
  const alice = Keypair.generate();

  let lpVaultPda: PublicKey;
  let vaultAuthorityPda: PublicKey;
  let vaultAuthorityBump: number;
  let sharesMint: Keypair;
  let vaultTokenAAccount: PublicKey; // SOL
  let vaultTokenBAccount: PublicKey; // USDC
  let positionKeypair: Keypair;
  let positionMintKeypair: Keypair;
  let positionTokenAccount: PublicKey;

  let aliceTokenAAccount: PublicKey; // SOL (WSOL — freely wrappable, no funding trick needed)
  let aliceTokenBAccount: PublicKey; // USDC — see TODO block above, must be pre-funded externally
  let aliceSharesAccount: PublicKey;
  let alicePositionPda: PublicKey;

  let tickLowerIndex: number;
  let tickUpperIndex: number;
  let tickArrayLower: PublicKey;
  let tickArrayUpper: PublicKey;

  before(async () => {
    const sig = await provider.connection.requestAirdrop(alice.publicKey, 5e9);
    await provider.connection.confirmTransaction(sig);
    const sig2 = await provider.connection.requestAirdrop(keeper.publicKey, 1e9);
    await provider.connection.confirmTransaction(sig2);

    // Pick a fairly wide range centered on the pool's current tick, rounded
    // to valid tick-spacing multiples (Whirlpool rejects non-aligned ticks).
    const tickCurrent = await readWhirlpoolTickCurrent(provider.connection);
    const align = (t: number) => Math.round(t / WHIRLPOOL_TICK_SPACING) * WHIRLPOOL_TICK_SPACING;
    tickLowerIndex = align(tickCurrent - 4000);
    tickUpperIndex = align(tickCurrent + 4000);
    tickArrayLower = getTickArrayPda(SOL_USDC_WHIRLPOOL, tickLowerIndex, WHIRLPOOL_TICK_SPACING);
    tickArrayUpper = getTickArrayPda(SOL_USDC_WHIRLPOOL, tickUpperIndex, WHIRLPOOL_TICK_SPACING);

    [lpVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_vault"), SOL_MINT.toBuffer(), USDC_MINT.toBuffer(), admin.publicKey.toBuffer()],
      program.programId
    );
    [vaultAuthorityPda, vaultAuthorityBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_vault_authority"), lpVaultPda.toBuffer()],
      program.programId
    );
    [alicePositionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_position"), lpVaultPda.toBuffer(), alice.publicKey.toBuffer()],
      program.programId
    );

    sharesMint = Keypair.generate();
    positionKeypair = Keypair.generate();
    positionMintKeypair = Keypair.generate();

    vaultTokenAAccount = await getAssociatedTokenAddress(SOL_MINT, vaultAuthorityPda, true);
    vaultTokenBAccount = await getAssociatedTokenAddress(USDC_MINT, vaultAuthorityPda, true);
    positionTokenAccount = await getAssociatedTokenAddress(positionMintKeypair.publicKey, vaultAuthorityPda, true);

    aliceTokenAAccount = await createAssociatedTokenAccount(provider.connection, alice, SOL_MINT, alice.publicKey);
    aliceTokenBAccount = await getAssociatedTokenAddress(USDC_MINT, alice.publicKey);
    // NOTE: aliceTokenBAccount is NOT created/funded here — see the TODO
    // block at the top of this file. This before() will not by itself
    // produce a usable USDC balance for alice.
    aliceSharesAccount = await getAssociatedTokenAddress(sharesMint.publicKey, alice.publicKey);

    // Wrap some of alice's airdropped SOL into WSOL so she has something to
    // deposit as token A without needing any external funding trick.
    // (createAssociatedTokenAccount + a SystemProgram transfer + syncNative
    // is the standard WSOL-wrapping pattern; omitted here for brevity — see
    // @solana/spl-token's `createSyncNativeInstruction` if wiring this in.)
  });

  it("initializes an Orca LP vault at a real cloned Whirlpool", async () => {
    await program.methods
      .initializeOrcaLpVault({
        keeper: keeper.publicKey,
        treasury: admin.publicKey,
        tickLowerIndex,
        tickUpperIndex,
        tickArrayLowerStartIndex: 0, // unused by Orca's InitLpVaultParams path, Raydium-only field
        tickArrayUpperStartIndex: 0,
        name: "SOL/USDC Orca LP (test)",
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
        position: positionKeypair.publicKey,
        positionMint: positionMintKeypair.publicKey,
        positionTokenAccount,
        whirlpool: SOL_USDC_WHIRLPOOL,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        whirlpoolProgram: WHIRLPOOL_PROGRAM_ID,
      })
      .signers([sharesMint, positionKeypair, positionMintKeypair])
      .rpc();

    const vault = await program.account.lpVault.fetch(lpVaultPda);
    assert.equal(vault.pool.toBase58(), SOL_USDC_WHIRLPOOL.toBase58());
    assert.equal(vault.tickLowerIndex, tickLowerIndex);
    assert.equal(vault.tickUpperIndex, tickUpperIndex);
    assert.isTrue(vault.positionActive);
    assert.equal(vault.totalLiquidity.toString(), "0");
  });

  it("deposits real liquidity from alice and mints proportional shares", async () => {
    // Requires aliceTokenBAccount (USDC) to actually hold a balance — see
    // the TODO block at the top of this file. This will fail with an SPL
    // "insufficient funds" style error until that's wired up.
    const lpVault = await program.account.lpVault.fetch(lpVaultPda);
    const tokenAAmount = new BN(0.1 * 1e9); // 0.1 SOL

    // A real deposit would compute liquidityAmount/tokenMaxA/tokenMaxB via
    // getDepositQuote in app/src/hooks/useLpVault.ts (Orca's real WASM quote
    // math) rather than a placeholder — left as a TODO for whoever wires
    // this test up for real, since that quote function needs the live pool's
    // current sqrtPrice, which this test already reads in before().
    throw new Error(
      "TODO: compute a real deposit quote (see app/src/hooks/useLpVault.ts's " +
      "getDepositQuote) before calling depositOrcaLp — not filled in in this draft."
    );
  });

  it("withdraws shares back and returns real SOL/USDC to alice", async () => {
    throw new Error("TODO: mirror the deposit test's TODO — compute a real withdraw quote and call withdrawOrcaLp.");
  });

  it("keeper can exit the position and admin can reopen at a new range", async () => {
    throw new Error("TODO: call exitOrcaLpPosition as keeper, then openNewOrcaLpPosition as admin, assert position_active toggles correctly.");
  });
});
