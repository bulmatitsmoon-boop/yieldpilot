// FIRST EVER EXECUTION of the Phase 2 Raydium CLMM LP adapter, against a real cloned
// mainnet SOL/USDC pool on a local validator. Zero SOL at risk.
//
// Raydium traps this has to get right (all documented in adapters/raydium.rs):
//   - tick_array seed is BIG-ENDIAN i32, not Orca's decimal string
//   - protocol_position: ["position", pool, tick_lower_be, tick_upper_be]
//   - personal_position:  ["position", position_nft_mint]
//   - open_position mints an NFT WITH Metaplex metadata
const anchor = require("@coral-xyz/anchor");
const { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } = require("@solana/spl-token");
const fs = require("fs"), path = require("path"), os = require("os");

const RPC = "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey("8c7Boyk91MWkn5jabf5CnYD8DrG6p4hYm9eDdAAWXEKH");
const CLMM = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const POOL = new PublicKey("3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv");
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const VAULT_0 = new PublicKey("4ct7br2vTPzfdmY3S5HLtTxcGSBfn6pnw98hsS6v359A");
const VAULT_1 = new PublicKey("5it83u57VRrVgc51oNV19TTmAJuffPx5GtGwQr7gQNUo");

// tick_spacing 1, arrays hold 60 ticks.
//
// The range is DERIVED FROM THE LIVE POOL at runtime, never hardcoded. The cloned pool
// keeps trading on mainnet, so a baked-in range goes stale and silently lands the position
// out of range, where it earns no fees and every subsequent "pass" proves nothing. The old
// values here (-25500..-25460) were written when tick_current was -25488; by 2026-07-24 the
// pool was at -25894, i.e. 400+ ticks away and completely outside the range.
let TICK_LOWER, TICK_UPPER;
const SPAN = 60;
const beI32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const arrayStart = (t) => Math.floor(t / SPAN) * SPAN;

(async () => {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(path.resolve(os.homedir(), ".config/solana/id.json"), "utf8"))));
  const connection = new Connection(RPC, { commitment: "confirmed" });
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.resolve(__dirname, "idl_p2.json"), "utf8"));
  const program = new anchor.Program(idl, provider);

  // Read the live pool and centre the range on it. Raydium's PoolState layout:
  // disc8 + bump1 + ammConfig32 + owner32 + mint0/1 32+32 + vault0/1 32+32 + observation32
  // + decimals0/1 1+1 + tickSpacing2 + liquidity16 + sqrtPriceX64 16 -> tickCurrent
  {
    const pd = (await connection.getAccountInfo(POOL)).data;
    let o = 8 + 1 + 32 * 7 + 1 + 1;
    const spacing = pd.readUInt16LE(o);
    o += 2 + 16 + 16;
    const tickNow = pd.readInt32LE(o);
    const align = (t) => Math.round(t / spacing) * spacing;
    TICK_LOWER = align(tickNow - 20);
    TICK_UPPER = align(tickNow + 20);
    console.log('[live] tick_current', tickNow, '| spacing', spacing,
                '| derived range', TICK_LOWER, '->', TICK_UPPER);
  }

  for (let i = 0; i < 12; i++) {
    if ((await connection.getBalance(admin.publicKey)) > 3000e9) break;
    try { await connection.confirmTransaction(await connection.requestAirdrop(admin.publicKey, 500e9), "confirmed"); }
    catch { break; }
  }

  const poolInfo = await connection.getAccountInfo(POOL);
  console.log("[0] pool cloned:", !!poolInfo, "| owner:", poolInfo && poolInfo.owner.toBase58());
  if (!poolInfo) throw new Error("pool not cloned");
  console.log("    tick_current:", poolInfo.data.readInt32LE(269), "| tick_spacing:", poolInfo.data.readUInt16LE(235));
  console.log("    our range   :", TICK_LOWER, "->", TICK_UPPER);

  const [lpVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_vault"), SOL_MINT.toBuffer(), USDC_MINT.toBuffer(), admin.publicKey.toBuffer()], PROGRAM_ID);
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_vault_authority"), lpVault.toBuffer()], PROGRAM_ID);

  const nftMintKp = Keypair.generate();
  const sharesMintKp = Keypair.generate();

  const [personalPosition] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), nftMintKp.publicKey.toBuffer()], CLMM);
  const [protocolPosition] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), POOL.toBuffer(), beI32(TICK_LOWER), beI32(TICK_UPPER)], CLMM);
  const [tickArrayLower] = PublicKey.findProgramAddressSync(
    [Buffer.from("tick_array"), POOL.toBuffer(), beI32(arrayStart(TICK_LOWER))], CLMM);
  const [tickArrayUpper] = PublicKey.findProgramAddressSync(
    [Buffer.from("tick_array"), POOL.toBuffer(), beI32(arrayStart(TICK_UPPER))], CLMM);
  const [metadataAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM.toBuffer(), nftMintKp.publicKey.toBuffer()], METADATA_PROGRAM);

  const nftAccount = getAssociatedTokenAddressSync(nftMintKp.publicKey, vaultAuthority, true);
  const vaultTokenA = getAssociatedTokenAddressSync(SOL_MINT, vaultAuthority, true);
  const vaultTokenB = getAssociatedTokenAddressSync(USDC_MINT, vaultAuthority, true);

  console.log("\n[1] lp_vault          :", lpVault.toBase58());
  console.log("    personal_position :", personalPosition.toBase58());
  console.log("    protocol_position :", protocolPosition.toBase58());
  console.log("    tick arrays       :", arrayStart(TICK_LOWER), "/", arrayStart(TICK_UPPER));

  // Raydium's open_position uses vault_authority as funder too — pre-fund the PDA.
  await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({
    fromPubkey: admin.publicKey, toPubkey: vaultAuthority, lamports: 0.5 * 1e9,
  })), []);
  console.log("    vault_authority funded: 0.5 SOL");

  // token_account_0/1 must ALREADY exist — Raydium's open_position pulls the initial
  // liquidity from them. They cannot be the vault ATAs, which this same instruction
  // `init`s (Anchor validates them against pre-instruction state -> AccountNotInitialized).
  // So they are the funder's own accounts: admin's WSOL + USDC.
  const { createAssociatedTokenAccountInstruction, createSyncNativeInstruction } = require("@solana/spl-token");
  const adminWsol = getAssociatedTokenAddressSync(SOL_MINT, admin.publicKey);
  const adminUsdc = getAssociatedTokenAddressSync(USDC_MINT, admin.publicKey);
  const prep = new Transaction();
  if (!(await connection.getAccountInfo(adminWsol))) {
    prep.add(createAssociatedTokenAccountInstruction(admin.publicKey, adminWsol, admin.publicKey, SOL_MINT));
  }
  prep.add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: adminWsol, lamports: 1500 * 1e9 }));
  prep.add(createSyncNativeInstruction(adminWsol));
  await provider.sendAndConfirm(prep, []);
  console.log("    admin WSOL:", (await connection.getTokenAccountBalance(adminWsol)).value.uiAmountString,
              "| admin USDC:", (await connection.getTokenAccountBalance(adminUsdc)).value.uiAmountString);

  console.log("\n[2] >>> initialize_raydium_lp_vault — FIRST EVER Raydium CPI <<<\n");
  try {
    const ix = await program.methods.initializeRaydiumLpVault({
        keeper: admin.publicKey,
        treasury: admin.publicKey,
        tickLowerIndex: TICK_LOWER,
        tickUpperIndex: TICK_UPPER,
        tickArrayLowerStartIndex: arrayStart(TICK_LOWER),
        tickArrayUpperStartIndex: arrayStart(TICK_UPPER),
        name: "LOCAL RAYDIUM SOL-USDC",
      }).accounts({
        admin: admin.publicKey,
        lpVault, vaultAuthority,
        tokenAMint: SOL_MINT, tokenBMint: USDC_MINT,
        vaultTokenAAccount: vaultTokenA, vaultTokenBAccount: vaultTokenB,
        lpSharesMint: sharesMintKp.publicKey,
        positionNftMint: nftMintKp.publicKey,
        positionNftAccount: nftAccount,
        metadataAccount,
        poolState: POOL,
        protocolPosition, tickArrayLower, tickArrayUpper, personalPosition,
        tokenAccount0: adminWsol, tokenAccount1: adminUsdc,
        tokenVault0: VAULT_0, tokenVault1: VAULT_1,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        metadataProgram: METADATA_PROGRAM,
        raydiumProgram: CLMM,
      }).instruction();

    // position_nft_mint is init'd by Raydium, so it must sign the outer tx even though
    // our IDL does not mark it a signer (same shape as the Orca fix).
    const pm = ix.keys.find(k => k.pubkey.equals(nftMintKp.publicKey));
    console.log("    position_nft_mint isSigner as built:", pm ? pm.isSigner : "NOT IN IX");

    // Two hard constraints, both measured on this harness:
    //   1. Raydium open_position + Metaplex metadata blows the 200k default CU budget.
    //   2. With 26 accounts + the CU instruction the LEGACY tx is 1245 bytes > the 1232
    //      limit. There is no combination that fits: drop the CU bump and it fits but
    //      runs out of compute.
    // So this instruction REQUIRES a versioned (v0) transaction with an Address Lookup
    // Table. The keeper and frontend both build legacy transactions today — this is real
    // work for them, not a harness artifact.
    const {
      ComputeBudgetProgram, AddressLookupTableProgram,
      TransactionMessage, VersionedTransaction,
    } = require("@solana/web3.js");

    const slot = await connection.getSlot("finalized");
    const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({
      authority: admin.publicKey, payer: admin.publicKey, recentSlot: slot,
    });
    // Only STATIC accounts belong in the table — the freshly generated mints/PDAs of
    // this transaction cannot be pre-published.
    const staticAddrs = [
      CLMM, METADATA_PROGRAM, POOL, VAULT_0, VAULT_1, SOL_MINT, USDC_MINT,
      tickArrayLower, tickArrayUpper, protocolPosition,
      TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId, SYSVAR_RENT_PUBKEY,
    ];
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: admin.publicKey, authority: admin.publicKey,
      lookupTable: altAddress, addresses: staticAddrs,
    });
    await provider.sendAndConfirm(new Transaction().add(createIx).add(extendIx), []);
    // A lookup table is only usable one slot after it is extended.
    await new Promise(r => setTimeout(r, 1500));
    const alt = (await connection.getAddressLookupTable(altAddress)).value;
    console.log("    ALT:", altAddress.toBase58(), "with", alt.state.addresses.length, "addresses");

    const msg = new TransactionMessage({
      payerKey: admin.publicKey,
      recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ix],
    }).compileToV0Message([alt]);
    const vtx = new VersionedTransaction(msg);
    console.log("    v0 tx size:", vtx.serialize().length, "bytes (legacy was 1245, limit 1232)");
    vtx.sign([admin, nftMintKp, sharesMintKp]);
    const sig = await connection.sendTransaction(vtx);
    await connection.confirmTransaction(sig, "confirmed");
    console.log("*** SUCCESS *** tx:", sig);
    const pp = await connection.getAccountInfo(personalPosition);
    console.log("    personal_position:", pp ? pp.data.length + " bytes, owner " + pp.owner.toBase58() : "NOT CREATED");
    const nft = await connection.getTokenAccountBalance(nftAccount).catch(() => null);
    console.log("    position NFT     :", nft ? nft.value.amount + " (expect 1)" : "n/a");

    // ── [3] DEPOSIT — Raydium increase_liquidity ──────────────────────────────
    console.log("\n[3] >>> deposit_raydium_lp <<<\n");
    const userShares = getAssociatedTokenAddressSync(sharesMintKp.publicKey, admin.publicKey);
    const [userPositionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_position"), lpVault.toBuffer(), admin.publicKey.toBuffer()], PROGRAM_ID);
    await provider.sendAndConfirm(new Transaction().add(
      createAssociatedTokenAccountInstruction(admin.publicKey, userShares, admin.publicKey, sharesMintKp.publicKey)), []);

    const wsolBefore = await connection.getTokenAccountBalance(adminWsol);
    const usdcBefore = await connection.getTokenAccountBalance(adminUsdc);
    console.log("    user WSOL:", wsolBefore.value.uiAmountString, "| user USDC:", usdcBefore.value.uiAmountString);

    try {
      // Sized to a few percent of pool liquidity. The old 200_000_000 was ~0.0001% of a
      // 1.5e14 pool, where our cut of any realistic swap rounds to ZERO — so no path here
      // would ever face accrued fees, which is exactly the blind spot that hid the Orca
      // close_position bug. Caps must be <= the user's balance: the handler transfers the
      // max in first and refunds the remainder.
      const dIx = await program.methods.depositRaydiumLp(
          new anchor.BN(5_000_000_000_000), new anchor.BN(1200 * 1e9), new anchor.BN(45_000 * 1e6), true,
        ).accounts({
          user: admin.publicKey, lpVault, vaultAuthority, userPosition: userPositionPda,
          userTokenAAccount: adminWsol, userTokenBAccount: adminUsdc, userSharesAccount: userShares,
          vaultTokenAAccount: vaultTokenA, vaultTokenBAccount: vaultTokenB,
          lpSharesMint: sharesMintKp.publicKey,
          nftAccount, poolState: POOL, protocolPosition, personalPosition,
          tickArrayLower, tickArrayUpper, tokenVault0: VAULT_0, tokenVault1: VAULT_1,
          tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
          raydiumProgram: CLMM,
        }).instruction();

      const dMsg = new TransactionMessage({
        payerKey: admin.publicKey,
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), dIx],
      }).compileToV0Message([alt]);
      const dTx = new VersionedTransaction(dMsg);
      console.log("    v0 deposit tx size:", dTx.serialize().length, "bytes");
      dTx.sign([admin]);
      const dSig = await connection.sendTransaction(dTx);
      await connection.confirmTransaction(dSig, "confirmed");
      console.log("*** DEPOSIT SUCCESS *** tx:", dSig);

      const wsolAfter = await connection.getTokenAccountBalance(adminWsol);
      const usdcAfter = await connection.getTokenAccountBalance(adminUsdc);
      const shAfter = await connection.getTokenAccountBalance(userShares);
      console.log("    WSOL spent:", (Number(wsolBefore.value.amount) - Number(wsolAfter.value.amount)) / 1e9);
      console.log("    USDC spent:", (Number(usdcBefore.value.amount) - Number(usdcAfter.value.amount)) / 1e6);
      console.log("    LP shares :", shAfter.value.uiAmountString);
      const vA = await connection.getTokenAccountBalance(vaultTokenA);
      const vB = await connection.getTokenAccountBalance(vaultTokenB);
      console.log("    vault idle:", vA.value.uiAmountString, "WSOL /", vB.value.uiAmountString, "USDC  <- both 0 means the refund fix works");
    } catch (e) {
      console.error("*** DEPOSIT FAILED ***:", (e.message || "").split("\n")[0]);
      const lg = e.logs || (e.transactionLogs || []);
      if (lg.length) console.error("\n=== LOGS ===\n" + lg.slice(-14).join("\n"));
      return;
    }

    // Raydium's decrease_liquidity COLLECTS REWARDS in the same instruction and takes
    // the reward accounts as REMAINING accounts: [reward_vault, recipient] per active
    // reward. Count is validated -> InvalidRewardInputAccountNumber (6030) on mismatch.
    // This pool has exactly ONE reward slot (RAY, state=Ended), read from PoolState
    // reward_infos at offset 397, stride 169 — both taken from Raydium's on-chain IDL,
    // not guessed. Ended still counts: the slot is not Uninitialized.
    const RAY_MINT = new PublicKey("4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R");
    const REWARD_VAULT = new PublicKey("HsBUudV9Y2Z2dJTieWFgK3zhrpX4ELvnfHcAwSBVqDGX");
    const rewardRecipient = getAssociatedTokenAddressSync(RAY_MINT, vaultAuthority, true);
    if (!(await connection.getAccountInfo(rewardRecipient))) {
      await provider.sendAndConfirm(new Transaction().add(
        createAssociatedTokenAccountInstruction(admin.publicKey, rewardRecipient, vaultAuthority, RAY_MINT)), []);
    }
    // MEASURED by sweeping 0..9: this pool needs exactly TWO — valid_reward_count(1) x
    // reward_group_account_num(2) = [reward_vault, recipient]. No mint account, so
    // need_reward_mint is false for a plain SPL reward token.
    const rewardRemaining = [
      { pubkey: REWARD_VAULT, isSigner: false, isWritable: true },
      { pubkey: rewardRecipient, isSigner: false, isWritable: true },
    ];
    console.log("    reward remaining accounts:", rewardRemaining.length, "(1 active reward: RAY)");

    // Helper: send any instruction as a v0 tx through the ALT with a raised CU budget.
    const sendV0 = async (ixn, extraSigners = []) => {
      const m = new TransactionMessage({
        payerKey: admin.publicKey,
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ixn],
      }).compileToV0Message([alt]);
      const t = new VersionedTransaction(m);
      t.sign([admin, ...extraSigners]);
      const sg = await connection.sendTransaction(t);
      await connection.confirmTransaction(sg, "confirmed");
      return sg;
    };
    const logErr = (label, e) => {
      console.error(`*** ${label} FAILED ***:`, (e.message || "").split("\n")[0]);
      const lg = e.logs || e.transactionLogs || [];
      if (lg.length) console.error("=== LOGS ===\n" + lg.slice(-12).join("\n"));
    };

    // ── [4] WITHDRAW ─────────────────────────────────────────────────────────
    console.log("\n[4] >>> withdraw_raydium_lp <<<\n");
    const shBal = await connection.getTokenAccountBalance(userShares);
    const halfShares = new anchor.BN(shBal.value.amount).divn(2);
    console.log("    withdrawing half:", halfShares.toString(), "of", shBal.value.amount);
    try {
      const wIx = await program.methods.withdrawRaydiumLp(halfShares, new anchor.BN(0), new anchor.BN(0))
        .accounts({
          user: admin.publicKey, lpVault, vaultAuthority, userPosition: userPositionPda,
          userTokenAAccount: adminWsol, userTokenBAccount: adminUsdc, userSharesAccount: userShares,
          vaultTokenAAccount: vaultTokenA, vaultTokenBAccount: vaultTokenB,
          lpSharesMint: sharesMintKp.publicKey, nftAccount, poolState: POOL,
          protocolPosition, personalPosition, tickArrayLower, tickArrayUpper,
          tokenVault0: VAULT_0, tokenVault1: VAULT_1,
          tokenProgram: TOKEN_PROGRAM_ID, raydiumProgram: CLMM,
        }).remainingAccounts(rewardRemaining).instruction();
      console.log("*** WITHDRAW SUCCESS *** tx:", await sendV0(wIx));
      const w1 = await connection.getTokenAccountBalance(adminWsol);
      const s1 = await connection.getTokenAccountBalance(userShares);
      console.log("    user WSOL:", w1.value.uiAmountString, "| shares left:", s1.value.uiAmountString);
    } catch (e) { logErr("WITHDRAW", e); }

    // ── [5] EXIT ─────────────────────────────────────────────────────────────
    console.log("\n[5] >>> exit_raydium_lp_position <<<\n");
    try {
      const eIx = await program.methods.exitRaydiumLpPosition().accounts({
          keeper: admin.publicKey, lpVault, vaultAuthority,
          vaultTokenAAccount: vaultTokenA, vaultTokenBAccount: vaultTokenB,
          positionNftAccount: nftAccount, poolState: POOL, protocolPosition, personalPosition,
          positionNftMint: nftMintKp.publicKey, tickArrayLower, tickArrayUpper,
          tokenVault0: VAULT_0, tokenVault1: VAULT_1,
          systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID,
          raydiumProgram: CLMM,
        }).remainingAccounts(rewardRemaining).instruction();
      console.log("*** EXIT SUCCESS *** tx:", await sendV0(eIx));
      const lv = await program.account.lpVault.fetch(lpVault);
      const vA = await connection.getTokenAccountBalance(vaultTokenA);
      const vB = await connection.getTokenAccountBalance(vaultTokenB);
      console.log("    position_active:", lv.positionActive, "| vault idle:", vA.value.uiAmountString, "WSOL /", vB.value.uiAmountString, "USDC");
    } catch (e) { logErr("EXIT", e); return; }

    // ── [6] OPEN NEW POSITION at a different range ───────────────────────────
    // Fresh range, also derived live — the pool has moved during the test.
    const pdN = (await connection.getAccountInfo(POOL)).data;
    let oN = 8 + 1 + 32 * 7 + 1 + 1;
    const spacingN = pdN.readUInt16LE(oN);
    oN += 2 + 16 + 16;
    const tickN = pdN.readInt32LE(oN);
    const alignN = (t) => Math.round(t / spacingN) * spacingN;
    const N_LOWER = alignN(tickN - 30), N_UPPER = alignN(tickN + 30);
    const nStart = arrayStart(N_LOWER), nStartU = arrayStart(N_UPPER);
    console.log("\n[6] >>> open_new_raydium_lp_position", N_LOWER, "->", N_UPPER, "<<<\n");
    const nftKp2 = Keypair.generate();
    const [pp2] = PublicKey.findProgramAddressSync([Buffer.from("position"), nftKp2.publicKey.toBuffer()], CLMM);
    const [protoPos2] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), POOL.toBuffer(), beI32(N_LOWER), beI32(N_UPPER)], CLMM);
    const [ta2L] = PublicKey.findProgramAddressSync([Buffer.from("tick_array"), POOL.toBuffer(), beI32(nStart)], CLMM);
    const [ta2U] = PublicKey.findProgramAddressSync([Buffer.from("tick_array"), POOL.toBuffer(), beI32(nStartU)], CLMM);
    const [md2] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), METADATA_PROGRAM.toBuffer(), nftKp2.publicKey.toBuffer()], METADATA_PROGRAM);
    const nftAcct2 = getAssociatedTokenAddressSync(nftKp2.publicKey, vaultAuthority, true);
    try {
      const oIx = await program.methods.openNewRaydiumLpPosition(N_LOWER, N_UPPER, nStart, nStartU).accounts({
          admin: admin.publicKey, lpVault, vaultAuthority,
          positionNftMint: nftKp2.publicKey, positionNftAccount: nftAcct2, metadataAccount: md2,
          poolState: POOL, protocolPosition: protoPos2, tickArrayLower: ta2L, tickArrayUpper: ta2U,
          personalPosition: pp2, tokenAccount0: vaultTokenA, tokenAccount1: vaultTokenB,
          tokenVault0: VAULT_0, tokenVault1: VAULT_1, rent: SYSVAR_RENT_PUBKEY,
          systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          metadataProgram: METADATA_PROGRAM, raydiumProgram: CLMM,
        }).instruction();
      console.log("*** OPEN_NEW SUCCESS *** tx:", await sendV0(oIx, [nftKp2]));
      const npi = await connection.getAccountInfo(pp2);
      console.log("    new personal_position:", npi ? npi.data.length + " bytes" : "NOT CREATED");
    } catch (e) { logErr("OPEN_NEW", e); return; }

    // ── [7] REDEPLOY into the new position ───────────────────────────────────
    console.log("\n[7] >>> redeploy_raydium_lp_liquidity <<<\n");
    try {
      const rIx = await program.methods.redeployRaydiumLpLiquidity(
          // Sized against the ~0.0006 WSOL / ~0.01 USDC the vault actually holds after
          // exit. The redeploy handler clamps the caps to idle (bug #6 fix), so asking
          // for more liquidity than idle can back fails Raydiums PriceSlippageCheck.
          new anchor.BN(5_000_000), new anchor.BN(2 * 1e9), new anchor.BN(500 * 1e6),
        ).accounts({
          keeper: admin.publicKey, lpVault, vaultAuthority,
          vaultTokenAAccount: vaultTokenA, vaultTokenBAccount: vaultTokenB,
          nftAccount: nftAcct2, poolState: POOL, protocolPosition: protoPos2, personalPosition: pp2,
          tickArrayLower: ta2L, tickArrayUpper: ta2U, tokenVault0: VAULT_0, tokenVault1: VAULT_1,
          tokenProgram: TOKEN_PROGRAM_ID, raydiumProgram: CLMM,
        }).instruction();
      console.log("*** REDEPLOY SUCCESS *** tx:", await sendV0(rIx));
      const lv = await program.account.lpVault.fetch(lpVault);
      console.log("    position_active:", lv.positionActive, "| range:", lv.tickLowerIndex, "->", lv.tickUpperIndex);
    } catch (e) { logErr("REDEPLOY", e); }
  } catch (e) {
    console.error("*** FAILED ***:", (e.message || "").split("\n")[0]);
    if (e.logs) console.error("\n=== LOGS ===\n" + e.logs.slice(-18).join("\n"));
    process.exit(1);
  }
})().catch(e => { console.error("SETUP FAILED:", e.message); if (e.logs) console.error(e.logs.slice(-12).join("\n")); process.exit(1); });
