const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, sendAndConfirmTransaction } = require('@solana/web3.js');
const fs = require('fs');

const PROGRAM_ID = new PublicKey('3tAEmHXZ51YVLe9ts8b9cMcgQPgaSamLxLtxR31VpREi');
const LP_VAULT = new PublicKey('FhuthBKSw2TWZRrzxGFm3fcetuDsPLxFhqfM6KdcSyax');
const NEW_KEEPER = new PublicKey('DzBe4ag5Ehjd3eE3wa5JVnqcVM2mQ8FFd2ZmxKjVvY2M');
const DISCRIMINATOR = Buffer.from([195, 255, 74, 201, 136, 30, 81, 123]);

(async () => {
  const rpcUrl = process.env.RPC_URL;
  const adminPath = process.env.ADMIN_KEYPAIR_PATH;
  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(adminPath, 'utf8')));
  const admin = Keypair.fromSecretKey(secretKey);
  console.log('admin pubkey:', admin.publicKey.toBase58());

  const conn = new Connection(rpcUrl, 'confirmed');

  const before = await conn.getAccountInfo(LP_VAULT);
  const keeperBefore = new PublicKey(before.data.slice(40, 72));
  console.log('keeper BEFORE:', keeperBefore.toBase58());

  const data = Buffer.concat([DISCRIMINATOR, NEW_KEEPER.toBuffer()]);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: LP_VAULT, isSigner: false, isWritable: true },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(conn, tx, [admin], { commitment: 'confirmed' });
  console.log('TX SIGNATURE:', sig);

  const after = await conn.getAccountInfo(LP_VAULT);
  const keeperAfter = new PublicKey(after.data.slice(40, 72));
  console.log('keeper AFTER:', keeperAfter.toBase58());
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
