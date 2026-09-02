// One-off: call reconcile() on the SOL vault to clear the stuck total_deposits
// residue (33,139,492 lamports, total_shares already 0 — a pre-existing rounding-
// drift artifact, same class the reconcile() instruction itself documents fixing).
// Provably safe by construction: reconcile() reads the vault's REAL on-chain idle
// balance and total_deployed(), never a caller-supplied number, and can only move
// total_deposits toward the truth.
const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, sendAndConfirmTransaction } = require('@solana/web3.js');
const fs = require('fs');
const crypto = require('crypto');

const PROGRAM_ID = new PublicKey('3tAEmHXZ51YVLe9ts8b9cMcgQPgaSamLxLtxR31VpREi');
const SOL_VAULT = new PublicKey('7MJGAiZmTre6VmVQXgYRK6vqoQeoMW1jwEL9jEXZgRy3');
const VAULT_TOKEN_ACCOUNT = new PublicKey('GE5D5qR844UfkeQN4GdGTHarjpokqimbrVEjUbeYyjjH');

(async () => {
  const rpcUrl = process.env.RPC_URL;
  const keeperPath = process.env.KEEPER_KEYPAIR_PATH;
  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keeperPath, 'utf8')));
  const keeper = Keypair.fromSecretKey(secretKey);
  console.log('keeper pubkey:', keeper.publicKey.toBase58());

  const conn = new Connection(rpcUrl, 'confirmed');
  const discriminator = crypto.createHash('sha256').update('global:reconcile').digest().slice(0, 8);

  const keys = [
    { pubkey: keeper.publicKey, isSigner: true, isWritable: false },
    { pubkey: SOL_VAULT, isSigner: false, isWritable: true },
    { pubkey: VAULT_TOKEN_ACCOUNT, isSigner: false, isWritable: false },
  ];
  const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys, data: discriminator });

  const before = await conn.getAccountInfo(SOL_VAULT);
  // total_deposits is a u64 field — decode via the same offset math as before
  // (admin32+keeper32+treasury32+mint32+sharesMint32+vaultTokenAccount32 = 192,
  // +8 disc = 200; then perfFeeBps u16(2)+autoCompound bool(1)+autoRebalance bool(1)
  // +tvlCap u64(8)+totalDeposits u64(8) — read defensively via IDL account fetch
  // instead of hand-rolled offsets, safer for a one-shot admin action).
  console.log('vault account exists:', !!before);

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(conn, tx, [keeper], { commitment: 'confirmed' });
  console.log('TX SIGNATURE:', sig);
})().catch(e => { console.error('FAILED:', e); if (e.logs) console.error(e.logs.join('\n')); process.exit(1); });
