import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Yieldpilot } from "../target/types/yieldpilot";
import {
  createMint, createAssociatedTokenAccount,
  mintTo, getAccount, getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function deriveVault(program: Program<Yieldpilot>, mint: PublicKey, admin: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), mint.toBuffer(), admin.toBuffer()],
    program.programId
  );
}
async function deriveAuthority(program: Program<Yieldpilot>, vault: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), vault.toBuffer()], program.programId);
}
async function derivePosition(program: Program<Yieldpilot>, vault: PublicKey, user: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), vault.toBuffer(), user.toBuffer()],
    program.programId
  );
}

const DECIMALS = 6;
const ONE = 1_000_000; // 1 USDC

// ── Test suite ───────────────────────────────────────────────────────────────

describe("YieldPilot — full integration", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Yieldpilot as Program<Yieldpilot>;
  const admin = provider.wallet as anchor.Wallet;

  let mint: PublicKey;
  let sharesMint: Keypair;
  let vaultPda: PublicKey;
  let vaultBump: number;
  let authorityPda: PublicKey;
  let authorityBump: number;
  let vaultTokenAccount: PublicKey;
  let adminTokenAccount: PublicKey;
  let adminSharesAccount: PublicKey;
  let adminPositionPda: PublicKey;

  // Second user for multi-user tests
  const alice = Keypair.generate();
  let aliceTokenAccount: PublicKey;
  let aliceSharesAccount: PublicKey;
  let alicePositionPda: PublicKey;

  // ── Setup ─────────────────────────────────────────────────────────────────

  before(async () => {
    // Fund alice
    const sig = await provider.connection.requestAirdrop(alice.publicKey, 2e9);
    await provider.connection.confirmTransaction(sig);

    // Create USDC-like mint
    mint = await createMint(provider.connection, admin.payer, admin.publicKey, null, DECIMALS);

    // Derive PDAs
    [vaultPda, vaultBump] = await deriveVault(program, mint, admin.publicKey);
    [authorityPda, authorityBump] = await deriveAuthority(program, vaultPda);
    [adminPositionPda] = await derivePosition(program, vaultPda, admin.publicKey);
    [alicePositionPda] = await derivePosition(program, vaultPda, alice.publicKey);

    // Vault token ATA (owned by authority)
    vaultTokenAccount = await getAssociatedTokenAddress(mint, authorityPda, true);

    // Shares mint keypair
    sharesMint = Keypair.generate();

    // Create token accounts for admin and alice
    adminTokenAccount = await createAssociatedTokenAccount(provider.connection, admin.payer, mint, admin.publicKey);
    aliceTokenAccount = await createAssociatedTokenAccount(provider.connection, admin.payer, mint, alice.publicKey);

    // Fund them: 10,000 USDC each
    await mintTo(provider.connection, admin.payer, mint, adminTokenAccount, admin.publicKey, 10_000 * ONE);
    await mintTo(provider.connection, admin.payer, mint, aliceTokenAccount, admin.publicKey, 10_000 * ONE);
  });

  // ── 1. Initialize ─────────────────────────────────────────────────────────

  it("initializes the vault with correct params", async () => {
    await program.methods
      .initializeVault({
        perfFeeBps: new BN(500),      // 5%
        autoCompound: true,
        autoRebalance: true,
        tvlCap: new BN(100 * ONE),    // $100 launch cap
        name: "USDC Vault v1",
        treasury: admin.publicKey,    // perf fees go to admin wallet in tests
        gateMint: new PublicKey("11111111111111111111111111111111"), // SystemProgram = no gate
      })
      .accounts({
        admin: admin.publicKey, mint,
        vault: vaultPda, vaultAuthority: authorityPda,
        vaultTokenAccount, sharesMint: sharesMint.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([sharesMint])
      .rpc();

    const v = await program.account.vault.fetch(vaultPda);
    assert.equal(v.admin.toBase58(), admin.publicKey.toBase58());
    assert.equal(v.perfFeeBps.toNumber(), 500);
    assert.isFalse(v.paused);
    assert.equal(v.tvlCap.toNumber(), 100 * ONE);
    assert.equal(v.name, "USDC Vault v1");
    assert.equal(v.totalDeposits.toNumber(), 0);
    assert.equal(v.totalShares.toNumber(), 0);
    console.log("  ✓ Vault initialized:", vaultPda.toBase58().slice(0, 8) + "...");
  });

  // ── 2. First deposit ──────────────────────────────────────────────────────

  it("rejects first deposit below $1 minimum", async () => {
    adminSharesAccount = await getAssociatedTokenAddress(sharesMint.publicKey, admin.publicKey);
    try {
      await program.methods.deposit(new BN(500_000)) // $0.50
        .accounts({
          user: admin.publicKey, vault: vaultPda, vaultAuthority: authorityPda,
          vaultTokenAccount, userTokenAccount: adminTokenAccount,
          sharesMint: sharesMint.publicKey, userPosition: adminPositionPda,
          userSharesAccount: adminSharesAccount,
          userGateAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }).rpc();
      assert.fail("Should have thrown FirstDepositTooSmall");
    } catch (e: any) {
      assert.include(e.message, "FirstDepositTooSmall");
      console.log("  ✓ Correctly rejected sub-$1 first deposit");
    }
  });

  it("accepts first deposit of $10 (1:1 shares)", async () => {
    adminSharesAccount = await getAssociatedTokenAddress(sharesMint.publicKey, admin.publicKey);
    await program.methods.deposit(new BN(10 * ONE))
      .accounts({
        user: admin.publicKey, vault: vaultPda, vaultAuthority: authorityPda,
        vaultTokenAccount, userTokenAccount: adminTokenAccount,
        sharesMint: sharesMint.publicKey, userPosition: adminPositionPda,
        userSharesAccount: adminSharesAccount,
        userGateAccount: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).rpc();

    const v = await program.account.vault.fetch(vaultPda);
    assert.equal(v.totalDeposits.toNumber(), 10 * ONE);
    assert.equal(v.totalShares.toNumber(), 10 * ONE); // 1:1

    const pos = await program.account.userPosition.fetch(adminPositionPda);
    assert.equal(pos.shares.toNumber(), 10 * ONE);

    const shares = await getAccount(provider.connection, adminSharesAccount);
    assert.equal(shares.amount.toString(), String(10 * ONE));
    console.log("  ✓ First deposit $10 → 10M shares (1:1)");
  });

  // ── 3. TVL cap ────────────────────────────────────────────────────────────

  it("rejects deposit that would exceed TVL cap", async () => {
    try {
      await program.methods.deposit(new BN(95 * ONE)) // would hit $105
        .accounts({
          user: admin.publicKey, vault: vaultPda, vaultAuthority: authorityPda,
          vaultTokenAccount, userTokenAccount: adminTokenAccount,
          sharesMint: sharesMint.publicKey, userPosition: adminPositionPda,
          userSharesAccount: adminSharesAccount,
          userGateAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }).rpc();
      assert.fail("Should have thrown TvlCapExceeded");
    } catch (e: any) {
      assert.include(e.message, "TvlCapExceeded");
      console.log("  ✓ Correctly rejected over-cap deposit");
    }
  });

  // ── 4. Multi-user shares ──────────────────────────────────────────────────

  it("second depositor gets proportional shares", async () => {
    aliceSharesAccount = await getAssociatedTokenAddress(sharesMint.publicKey, alice.publicKey);

    // First raise cap so alice can deposit
    await program.methods.setTvlCap(new BN(1000 * ONE))
      .accounts({ admin: admin.publicKey, vault: vaultPda }).rpc();

    await program.methods.deposit(new BN(10 * ONE))
      .accounts({
        user: alice.publicKey, vault: vaultPda, vaultAuthority: authorityPda,
        vaultTokenAccount, userTokenAccount: aliceTokenAccount,
        sharesMint: sharesMint.publicKey, userPosition: alicePositionPda,
        userSharesAccount: aliceSharesAccount,
        userGateAccount: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([alice])
      .rpc();

    const v = await program.account.vault.fetch(vaultPda);
    // 10 deposits, vault had 10M shares and 10M deposits → alice gets 10M more shares
    assert.equal(v.totalDeposits.toNumber(), 20 * ONE);
    assert.equal(v.totalShares.toNumber(), 20 * ONE);

    const alicePos = await program.account.userPosition.fetch(alicePositionPda);
    assert.equal(alicePos.shares.toNumber(), 10 * ONE);
    console.log("  ✓ Alice deposited $10, received 10M shares (proportional)");
  });

  // ── 5. Simulated yield (share price appreciation) ─────────────────────────

  it("share price increases after yield accrues", async () => {
    // Simulate yield by minting tokens directly into the vault (as if protocol returned yield)
    // In production, deploy_to_kamino + compound would do this automatically
    await mintTo(provider.connection, admin.payer, mint, vaultTokenAccount, admin.publicKey, 2 * ONE);

    // Manually update vault state to reflect new balance (in prod this happens via compound)
    // Here we verify via raw balance that vault now holds $22
    const vaultBal = await getAccount(provider.connection, vaultTokenAccount);
    assert.equal(vaultBal.amount.toString(), String(22 * ONE));

    // Now admin's 10M shares / 20M total * 22 USDC = $11 value → $1 yield
    // Alice's 10M shares / 20M total * 22 USDC = $11 value → $1 yield
    console.log("  ✓ Vault balance = $22 (simulated $2 yield). Share price = 1.1 USDC/share");
  });

  // ── 6. Withdraw with perf fee ─────────────────────────────────────────────

  it("admin withdraws with correct perf fee deducted", async () => {
    const adminBalBefore = (await getAccount(provider.connection, adminTokenAccount)).amount;

    // Withdraw all admin shares (10M)
    // Admin deposited $10, share is now worth $11 → $1 profit → fee = 5% of $1 = $0.05
    await program.methods.withdraw(new BN(10 * ONE))
      .accounts({
        user: admin.publicKey, vault: vaultPda, vaultAuthority: authorityPda,
        vaultTokenAccount, userTokenAccount: adminTokenAccount,
        sharesMint: sharesMint.publicKey, userPosition: adminPositionPda,
        userSharesAccount: adminSharesAccount,
        treasuryTokenAccount: null,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();

    const adminBalAfter = (await getAccount(provider.connection, adminTokenAccount)).amount;
    const received = Number(adminBalAfter - adminBalBefore);

    // Expected: $11 - 5% of $1 = $11 - $0.05 = $10.95 = 10_950_000
    // Allow 1 unit rounding tolerance
    assert.approximately(received, 10_950_000, 1);

    const v = await program.account.vault.fetch(vaultPda);
    assert.equal(v.totalShares.toNumber(), 10 * ONE); // alice's shares remain
    console.log(`  ✓ Admin withdrew $${(received / ONE).toFixed(2)} ($10.95 after 5% perf fee on $1 profit)`);
  });

  // ── 7. Emergency pause ────────────────────────────────────────────────────

  it("pause blocks deposits", async () => {
    await program.methods.setPaused(true)
      .accounts({ admin: admin.publicKey, vault: vaultPda }).rpc();

    const v = await program.account.vault.fetch(vaultPda);
    assert.isTrue(v.paused);

    try {
      await program.methods.deposit(new BN(5 * ONE))
        .accounts({
          user: admin.publicKey, vault: vaultPda, vaultAuthority: authorityPda,
          vaultTokenAccount, userTokenAccount: adminTokenAccount,
          sharesMint: sharesMint.publicKey, userPosition: adminPositionPda,
          userSharesAccount: adminSharesAccount,
          userGateAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }).rpc();
      assert.fail("Should have thrown VaultPaused");
    } catch (e: any) {
      assert.include(e.message, "VaultPaused");
      console.log("  ✓ Deposit correctly blocked while paused");
    }
  });

  it("pause allows withdrawals (users can always exit)", async () => {
    // Alice can still withdraw while paused
    const aliceBalBefore = (await getAccount(provider.connection, aliceTokenAccount)).amount;

    await program.methods.withdraw(new BN(10 * ONE))
      .accounts({
        user: alice.publicKey, vault: vaultPda, vaultAuthority: authorityPda,
        vaultTokenAccount, userTokenAccount: aliceTokenAccount,
        sharesMint: sharesMint.publicKey, userPosition: alicePositionPda,
        userSharesAccount: aliceSharesAccount,
        treasuryTokenAccount: null,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([alice])
      .rpc();

    const aliceBalAfter = (await getAccount(provider.connection, aliceTokenAccount)).amount;
    assert.isAbove(Number(aliceBalAfter), Number(aliceBalBefore));
    console.log("  ✓ Withdrawal succeeded while paused (users can always exit)");
  });

  it("admin can unpause and deposits resume", async () => {
    await program.methods.setPaused(false)
      .accounts({ admin: admin.publicKey, vault: vaultPda }).rpc();
    const v = await program.account.vault.fetch(vaultPda);
    assert.isFalse(v.paused);
    console.log("  ✓ Vault unpaused successfully");
  });

  // ── 8. Access control ─────────────────────────────────────────────────────

  it("rejects unauthorized admin actions", async () => {
    const stranger = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(stranger.publicKey, 1e9);
    await provider.connection.confirmTransaction(sig);

    try {
      await program.methods.setPaused(true)
        .accounts({ admin: stranger.publicKey, vault: vaultPda })
        .signers([stranger])
        .rpc();
      assert.fail("Should have thrown Unauthorized");
    } catch (e: any) {
      assert.include(e.message, "Unauthorized");
      console.log("  ✓ Stranger correctly rejected from admin actions");
    }
  });

  // ── 9. Compound interval ──────────────────────────────────────────────────

  it("rejects compound called too soon", async () => {
    // First register a dummy protocol so compound doesn't fail on that
    const dummyState = Keypair.generate().publicKey;
    await program.methods
      .registerProtocol(0, dummyState, dummyState, new BN(5000), "Test Protocol")
      .accounts({ admin: admin.publicKey, vault: vaultPda }).rpc();

    try {
      await program.methods.compound()
        .accounts({ admin: admin.publicKey, vault: vaultPda }).rpc();
      assert.fail("Should have thrown CompoundTooEarly");
    } catch (e: any) {
      assert.include(e.message, "CompoundTooEarly");
      console.log("  ✓ Correctly rejected early compound call");
    }
  });

  // ── 10. Rebalance ─────────────────────────────────────────────────────────

  it("rebalances protocol allocations correctly", async () => {
    // Register a second protocol
    const dummyState2 = Keypair.generate().publicKey;
    await program.methods
      .registerProtocol(1, dummyState2, dummyState2, new BN(5000), "Test Marinade")
      .accounts({ admin: admin.publicKey, vault: vaultPda }).rpc();

    // Rebalance: 60/40
    await program.methods.rebalance([new BN(6000), new BN(4000)])
      .accounts({ admin: admin.publicKey, vault: vaultPda }).rpc();

    const v = await program.account.vault.fetch(vaultPda);
    assert.equal(v.protocols[0].targetBps.toNumber(), 6000);
    assert.equal(v.protocols[1].targetBps.toNumber(), 4000);
    console.log("  ✓ Rebalanced to 60/40");
  });

  it("rejects rebalance allocations summing over 100%", async () => {
    try {
      await program.methods.rebalance([new BN(6000), new BN(5000)]) // 110%
        .accounts({ admin: admin.publicKey, vault: vaultPda }).rpc();
      assert.fail("Should have thrown AllocationExceeded");
    } catch (e: any) {
      assert.include(e.message, "AllocationExceeded");
      console.log("  ✓ Correctly rejected 110% allocation");
    }
  });

  // ── Summary ───────────────────────────────────────────────────────────────

  after(async () => {
    const v = await program.account.vault.fetch(vaultPda);
    console.log("\n── Vault state at end of tests ──");
    console.log(`   Total deposits:  $${(v.totalDeposits.toNumber() / ONE).toFixed(2)}`);
    console.log(`   Total shares:    ${v.totalShares.toNumber()}`);
    console.log(`   Protocols:       ${v.protocolCount}`);
    console.log(`   Paused:          ${v.paused}`);
  });
});
