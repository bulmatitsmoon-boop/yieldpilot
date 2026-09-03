// Signs and submits the "initialize verify PDA" transaction that
// `solana-verify export-pda-tx` produced (built with zero private-key material
// -- it only needed the admin wallet's PUBLIC key as --uploader). This step is
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

  // WAS signing+submitting whatever blockhash solana-verify baked into the
  // transaction it handed us. Failed live 2026-09-03 with "Blockhash not
  // found" -- the tx solana-verify produced was already stale by the time this
  // step ran (root cause of the timing not fully pinned down: the "build and
  // export" step returned suspiciously fast, well under what a real
  // deterministic docker build takes -- but regardless of WHY, trusting an
  // externally-produced blockhash across a step boundary is fragile). Fix:
  // always refresh to a blockhash fetched RIGHT HERE, immediately before
  // signing -- the rest of the transaction (instructions, fee payer) is
  // unaffected by this, only the expiry window changes.
  const { blockhash } = await conn.getLatestBlockhash('finalized');
  console.log('fresh blockhash:', blockhash);

  let sig;
  try {
    const tx = Transaction.from(bytes);
    tx.recentBlockhash = blockhash;
    tx.signatures = [];
    tx.partialSign(admin);
    sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  } catch (e) {
    console.log('legacy Transaction path failed, trying VersionedTransaction:', e.message);
    const vtx = VersionedTransaction.deserialize(bytes);
    vtx.message.recentBlockhash = blockhash;
    vtx.signatures = [];
    vtx.sign([admin]);
    sig = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false });
  }
  await conn.confirmTransaction(sig, 'confirmed');
  console.log('TX SIGNATURE:', sig);
  console.log('Verify PDA initialized. Next: solana-verify remote submit-job --program-id <id> --uploader <this pubkey> to queue the OtterSec worker.');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
