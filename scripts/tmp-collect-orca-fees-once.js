// One-off: call collect_orca_lp_fees on the mainnet Orca LP vault, signed by the
// keeper wallet. All accounts below were independently derived and cross-checked
// against the real on-chain LpVault/Whirlpool accounts before this ran.
const {
  Connection, PublicKey, Keypair, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} = require('@solana/web3.js');
const fs = require('fs');
const crypto = require('crypto');

const PROGRAM_ID = new PublicKey('3tAEmHXZ51YVLe9ts8b9cMcgQPgaSamLxLtxR31VpREi');
const LP_VAULT = new PublicKey('FhuthBKSw2TWZRrzxGFm3fcetuDsPLxFhqfM6KdcSyax');
const VAULT_AUTHORITY = new PublicKey('4iQSC19A53oKTB8KHJJiU5skFAgD9C1C9EsTLDyszjhY');
const VAULT_TOKEN_A = new PublicKey('GkYXPQnQS6NToiLpoDtueMsfzYaBYxHEVnZKNkoK7aLE');
const VAULT_TOKEN_B = new PublicKey('7kPNFJxjyQsibTWTjzw55j4KGajVmrLAx6Wosv4Pwmgr');
const WHIRLPOOL = new PublicKey('Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE');
const POSITION = new PublicKey('6pfSGk6YNATyWKqzQ35FU5YqGmLZTYV7V9B3UY2WYixM');
const POSITION_TOKEN_ACCOUNT = new PublicKey('2oZ6jAuFYmeQtzeidxpMrAgv4FoNS7SBEf28aHy4JzBS');
const TOKEN_VAULT_A = new PublicKey('EUuUbDcafPrmVTD5M6qoJAoyyNbihBhugADAxRMn5he9');
const TOKEN_VAULT_B = new PublicKey('2WLWEuKDgkDUccTpbwYp1GToYktiSB1cXvreHUwiSUVP');
const TICK_ARRAY_LOWER = new PublicKey('FwXDtbEdnyiVRT4XYAYx7YfgoYyUhh2r9hxfr4VUaHz1');
const TICK_ARRAY_UPPER = new PublicKey('76W6gGZiGiNvZa2jKyEq3GvLcVukDCusKQYzJQS95htJ');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');

(async () => {
  const rpcUrl = process.env.RPC_URL;
  const keeperPath = process.env.KEEPER_KEYPAIR_PATH;
  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keeperPath, 'utf8')));
  const keeper = Keypair.fromSecretKey(secretKey);
  console.log('signer pubkey:', keeper.publicKey.toBase58());

  const conn = new Connection(rpcUrl, 'confirmed');

  const discriminator = crypto.createHash('sha256').update('global:collect_orca_lp_fees').digest().slice(0, 8);

  const keys = [
    { pubkey: keeper.publicKey, isSigner: true, isWritable: false },
    { pubkey: LP_VAULT, isSigner: false, isWritable: true },
    { pubkey: VAULT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: VAULT_TOKEN_A, isSigner: false, isWritable: true },
    { pubkey: VAULT_TOKEN_B, isSigner: false, isWritable: true },
    { pubkey: WHIRLPOOL, isSigner: false, isWritable: true },
    { pubkey: POSITION, isSigner: false, isWritable: true },
    { pubkey: POSITION_TOKEN_ACCOUNT, isSigner: false, isWritable: false },
    { pubkey: TOKEN_VAULT_A, isSigner: false, isWritable: true },
    { pubkey: TOKEN_VAULT_B, isSigner: false, isWritable: true },
    { pubkey: TICK_ARRAY_LOWER, isSigner: false, isWritable: true },
    { pubkey: TICK_ARRAY_UPPER, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: WHIRLPOOL_PROGRAM, isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys, data: discriminator });

  // Read balances before, for a real before/after diff instead of trusting logs alone.
  const [balABefore, balBBefore] = await Promise.all([
    conn.getTokenAccountBalance(VAULT_TOKEN_A),
    conn.getTokenAccountBalance(VAULT_TOKEN_B),
  ]);
  console.log('vault_token_a (SOL) BEFORE:', balABefore.value.uiAmountString);
  console.log('vault_token_b (USDC) BEFORE:', balBBefore.value.uiAmountString);

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(conn, tx, [keeper], { commitment: 'confirmed' });
  console.log('TX SIGNATURE:', sig);

  const [balAAfter, balBAfter] = await Promise.all([
    conn.getTokenAccountBalance(VAULT_TOKEN_A),
    conn.getTokenAccountBalance(VAULT_TOKEN_B),
  ]);
  console.log('vault_token_a (SOL) AFTER:', balAAfter.value.uiAmountString);
  console.log('vault_token_b (USDC) AFTER:', balBAfter.value.uiAmountString);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
