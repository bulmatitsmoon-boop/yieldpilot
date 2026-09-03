// Real end-to-end proof of deploy_lp_idle_b_to_solend / recall_lp_idle_b_from_solend
// (the LP idle-capital lending backstop, Phase 1 -- USDC leg only, see project
// memory project_lp_idle_capital_lending_backstop). Against a real cloned
// mainnet Solend USDC reserve on a local validator. Zero SOL at risk.
//
// Minimal setup: init a Raydium LP vault (creates vault_token_b_account), then
// directly SPL-transfer USDC into it -- bypassing the deposit/position flow
// entirely, since the two lending instructions only need idle tokens in that
// account, not an active position.
const anchor = require("@coral-xyz/anchor");
const { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction, TransactionInstruction } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createSyncNativeInstruction, createTransferInstruction } = require("@solana/spl-token");
const fs = require("fs"), path = require("path"), os = require("os");

const RPC = "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey("3tAEmHXZ51YVLe9ts8b9cMcgQPgaSamLxLtxR31VpREi");
const CLMM = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const POOL = new PublicKey("3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv");
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const VAULT_0 = new PublicKey("4ct7br2vTPzfdmY3S5HLtTxcGSBfn6pnw98hsS6v359A");
const VAULT_1 = new PublicKey("5it83u57VRrVgc51oNV19TTmAJuffPx5GtGwQr7gQNUo");

// Solend main pool (adapters/solend.rs main_pool module).
const SOLEND_PROGRAM = new PublicKey("So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo");
const LENDING_MARKET = new PublicKey("4UpD2fh7xH3VP9QQaXtsS1YY3bxzWhtfpks7FatyKvdY");
const USDC_RESERVE = new PublicKey("BgxfHJDzm44T7XG68MYKx7YisTjZu73tVovyZSjJMpmw");
const USDC_LIQUIDITY_SUPPLY = new PublicKey("8SheGtsopRUDzdiD6v6BR9a6bqZ9QwywYQY99Fp5meNf");
const USDC_COLLATERAL_MINT = new PublicKey("993dVFL2uXWYeoXuEBFXR4BijeXdTv4s6BzsCjJZuwqk");
const USDC_ORACLE = new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX");

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

  {
    const pd = (await connection.getAccountInfo(POOL)).data;
    let o = 8 + 1 + 32 * 7 + 1 + 1;
    const spacing = pd.readUInt16LE(o);
    o += 2 + 16 + 16;
    const tickNow = pd.readInt32LE(o);
    const align = (t) => Math.round(t / spacing) * spacing;
    TICK_LOWER = align(tickNow - 20);
    TICK_UPPER = align(tickNow + 20);
  }

  for (let i = 0; i < 60; i++) {
    const bal = await connection.getBalance(admin.publicKey);
    if (bal > 10e9) break;
    try { await connection.confirmTransaction(await connection.requestAirdrop(admin.publicKey, 5e9), "confirmed"); }
    catch (e) { console.log("    airdrop attempt " + i + " failed:", (e.message||"").split(String.fromCharCode(10))[0]); }
  }
  console.log("    admin SOL balance:", (await connection.getBalance(admin.publicKey)) / 1e9);

  const [lpVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_vault"), SOL_MINT.toBuffer(), USDC_MINT.toBuffer(), admin.publicKey.toBuffer(), Buffer.from([1])], PROGRAM_ID);
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
  const [tickArrayBitmapExtension] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_tick_array_bitmap_extension"), POOL.toBuffer()], CLMM);

  const nftAccount = getAssociatedTokenAddressSync(nftMintKp.publicKey, vaultAuthority, true);
  const vaultTokenA = getAssociatedTokenAddressSync(SOL_MINT, vaultAuthority, true);
  const vaultTokenB = getAssociatedTokenAddressSync(USDC_MINT, vaultAuthority, true);

  console.log("[1] lp_vault:", lpVault.toBase58());

  await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({
    fromPubkey: admin.publicKey, toPubkey: vaultAuthority, lamports: 0.5 * 1e9,
  })), []);

  const adminWsol = getAssociatedTokenAddressSync(SOL_MINT, admin.publicKey);
  const adminUsdc = getAssociatedTokenAddressSync(USDC_MINT, admin.publicKey);
  const prep = new Transaction();
  if (!(await connection.getAccountInfo(adminWsol))) {
    prep.add(createAssociatedTokenAccountInstruction(admin.publicKey, adminWsol, admin.publicKey, SOL_MINT));
  }
  prep.add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: adminWsol, lamports: 5 * 1e9 }));
  prep.add(createSyncNativeInstruction(adminWsol));
  await provider.sendAndConfirm(prep, []);
  console.log("    admin USDC:", (await connection.getTokenAccountBalance(adminUsdc)).value.uiAmountString);

  console.log("\n[2] >>> initialize_raydium_lp_vault (minimal setup) <<<\n");
  const { ComputeBudgetProgram, AddressLookupTableProgram, TransactionMessage, VersionedTransaction } = require("@solana/web3.js");
  const ix = await program.methods.initializeRaydiumLpVault({
      keeper: admin.publicKey, treasury: admin.publicKey,
      tickLowerIndex: TICK_LOWER, tickUpperIndex: TICK_UPPER,
      tickArrayLowerStartIndex: arrayStart(TICK_LOWER), tickArrayUpperStartIndex: arrayStart(TICK_UPPER),
      name: "LENDING TEST VAULT",
    }).accounts({
      admin: admin.publicKey, lpVault, vaultAuthority,
      tokenAMint: SOL_MINT, tokenBMint: USDC_MINT,
      vaultTokenAAccount: vaultTokenA, vaultTokenBAccount: vaultTokenB,
      lpSharesMint: sharesMintKp.publicKey,
      positionNftMint: nftMintKp.publicKey, positionNftAccount: nftAccount, metadataAccount,
      poolState: POOL, protocolPosition, tickArrayLower, tickArrayUpper, personalPosition,
      tokenAccount0: adminWsol, tokenAccount1: adminUsdc,
      tokenVault0: VAULT_0, tokenVault1: VAULT_1, tickArrayBitmapExtension,
      rent: SYSVAR_RENT_PUBKEY, systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      metadataProgram: METADATA_PROGRAM, raydiumProgram: CLMM,
    }).instruction();

  const slot = await connection.getSlot("finalized");
  const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({ authority: admin.publicKey, payer: admin.publicKey, recentSlot: slot });
  const staticAddrs = [CLMM, METADATA_PROGRAM, POOL, VAULT_0, VAULT_1, SOL_MINT, USDC_MINT, tickArrayLower, tickArrayUpper, protocolPosition, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId, SYSVAR_RENT_PUBKEY, tickArrayBitmapExtension];
  const extendIx = AddressLookupTableProgram.extendLookupTable({ payer: admin.publicKey, authority: admin.publicKey, lookupTable: altAddress, addresses: staticAddrs });
  await provider.sendAndConfirm(new Transaction().add(createIx).add(extendIx), []);
  await new Promise(r => setTimeout(r, 1500));
  const alt = (await connection.getAddressLookupTable(altAddress)).value;

  const sendV0 = async (ixn, extraSigners = []) => {
    const m = new TransactionMessage({
      payerKey: admin.publicKey, recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ixn],
    }).compileToV0Message([alt]);
    const t = new VersionedTransaction(m);
    t.sign([admin, ...extraSigners]);
    const sg = await connection.sendTransaction(t);
    await connection.confirmTransaction(sg, "confirmed");
    return sg;
  };
  const logErr = (label, e) => {
    console.error("*** " + label + " FAILED ***:", (e.message || "").split("\n")[0]);
    const lg = e.logs || e.transactionLogs || [];
    if (lg.length) console.error("=== LOGS ===\n" + lg.slice(-16).join("\n"));
  };

  try {
    console.log("*** INIT SUCCESS *** tx:", await sendV0(ix, [nftMintKp, sharesMintKp]));
  } catch (e) { logErr("INIT", e); process.exit(1); }

  // Fund vault_token_b_account directly with idle USDC, bypassing deposit/position.
  console.log("\n[3] funding vault_token_b_account with idle USDC directly\n");
  const fundAmount = 5000 * 1e6; // 5000 USDC
  try {
    await provider.sendAndConfirm(new Transaction().add(
      createTransferInstruction(adminUsdc, vaultTokenB, admin.publicKey, fundAmount)
    ), []);
    console.log("    vault_token_b idle:", (await connection.getTokenAccountBalance(vaultTokenB)).value.uiAmountString, "USDC");
  } catch (e) { logErr("FUND", e); process.exit(1); }

  // ── deploy_lp_idle_b_to_solend ──────────────────────────────────────────
  console.log("\n[4] >>> deploy_lp_idle_b_to_solend — FIRST EVER CPI <<<\n");
  const [lendingReceiptB] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_lending_receipt_b"), lpVault.toBuffer()], PROGRAM_ID);
  const [lendingMarketAuthority] = PublicKey.findProgramAddressSync(
    [LENDING_MARKET.toBuffer()], SOLEND_PROGRAM);

  const deployAmount = 2000 * 1e6; // deploy 2000 of the 5000 idle USDC
  try {
    const dIx = await program.methods.deployLpIdleBToSolend(new anchor.BN(deployAmount))
      .accounts({
        keeper: admin.publicKey, lpVault, vaultAuthority,
        vaultTokenBAccount: vaultTokenB, lendingReceiptB,
        reserve: USDC_RESERVE, reserveLiquiditySupply: USDC_LIQUIDITY_SUPPLY,
        reserveCollateralMint: USDC_COLLATERAL_MINT,
        lendingMarket: LENDING_MARKET, lendingMarketAuthority,
        pythOracle: USDC_ORACLE, switchboardOracle: new PublicKey("nu11111111111111111111111111111111111111111"),
        clockSysvar: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
        txInstructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        solendProgram: SOLEND_PROGRAM,
      }).instruction();
    console.log("*** DEPLOY SUCCESS *** tx:", await sendV0(dIx));
    const lv = await program.account.lpVault.fetch(lpVault);
    console.log("    lending_deployed_b:", lv.lendingDeployedB.toString());
    console.log("    vault_token_b idle:", (await connection.getTokenAccountBalance(vaultTokenB)).value.uiAmountString, "USDC");
    console.log("    lending_receipt_b (cUSDC):", (await connection.getTokenAccountBalance(lendingReceiptB)).value.uiAmountString);
  } catch (e) { logErr("DEPLOY", e); process.exit(1); }

  // ── recall_lp_idle_b_from_solend ────────────────────────────────────────
  console.log("\n[5] >>> recall_lp_idle_b_from_solend <<<\n");
  try {
    const collateralBal = await connection.getTokenAccountBalance(lendingReceiptB);
    const recallAmount = new anchor.BN(collateralBal.value.amount).divn(2); // recall half
    const rIx = await program.methods.recallLpIdleBFromSolend(recallAmount)
      .accounts({
        keeper: admin.publicKey, lpVault, vaultAuthority,
        lendingReceiptB, vaultTokenBAccount: vaultTokenB,
        reserve: USDC_RESERVE, reserveCollateralMint: USDC_COLLATERAL_MINT,
        reserveLiquiditySupply: USDC_LIQUIDITY_SUPPLY,
        lendingMarket: LENDING_MARKET, lendingMarketAuthority,
        pythOracle: USDC_ORACLE, switchboardOracle: new PublicKey("nu11111111111111111111111111111111111111111"),
        clockSysvar: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        txInstructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        solendProgram: SOLEND_PROGRAM,
      }).instruction();
    console.log("*** RECALL SUCCESS *** tx:", await sendV0(rIx));
    const lv = await program.account.lpVault.fetch(lpVault);
    console.log("    lending_deployed_b after recall:", lv.lendingDeployedB.toString());
    console.log("    vault_token_b idle after recall:", (await connection.getTokenAccountBalance(vaultTokenB)).value.uiAmountString, "USDC");
    console.log("    lending_receipt_b (cUSDC) after recall:", (await connection.getTokenAccountBalance(lendingReceiptB)).value.uiAmountString);
  } catch (e) { logErr("RECALL", e); process.exit(1); }

  console.log("\n=== ALL STEPS PASSED ===");
})().catch(e => { console.error("SETUP FAILED:", e.message); if (e.logs) console.error(e.logs.slice(-12).join("\n")); process.exit(1); });
