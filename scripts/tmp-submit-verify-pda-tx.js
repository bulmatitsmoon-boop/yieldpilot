// Signs and submits the "initialize verify PDA" transaction that
// `solana-verify export-pda-tx` produced (built with zero private-key material
// — it only needed the admin wallet's PUBLIC key as --uploader). This step is
// the one part that actually needs the upgrade authority's signature, since the
// verify PDA is only trustworthy if it was genuinely signed by the program's
// real authority.
const { Connection, Keypair, Transaction, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const fs = require('fs');

const TX_BASE58 = process.env.VERIFY_TX_BASE58;

(async () => {
  const rpcUrl = process.env.RPC_URL;
  const adminPath = process.env.ADMIN_KEYPAIR_PATH;
  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(adminPath, 'utf8')));
  const admin = Keypair.fromSecretKey(secretKey);
  console.log('signer pubkey:', admin.publicKey.toBase58());

  const conn = new Connection(rpcUrl, 'confirmed');
  const bytes = bs58.decode(TX_BASE58);

  let sig;
  try {
    const tx = Transaction.from(bytes);
    tx.partialSign(admin);
    sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  } catch (e) {
    console.log('legacy Transaction parse failed, trying VersionedTransaction:', e.message);
    const vtx = VersionedTransaction.deserialize(bytes);
    vtx.sign([admin]);
    sig = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false });
  }
  await conn.confirmTransaction(sig, 'confirmed');
  console.log('TX SIGNATURE:', sig);
  console.log('Verify PDA initialized. Next: solana-verify remote submit-job --program-id <id> --uploader <this pubkey> to queue the OtterSec worker.');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
