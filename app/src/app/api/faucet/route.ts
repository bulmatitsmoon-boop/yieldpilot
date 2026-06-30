import { NextRequest, NextResponse } from 'next/server';
import {
  Connection, Keypair, PublicKey, Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getOrCreateAssociatedTokenAccount,
  createMintToInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

const GATE_MINT = new PublicKey('2f4EaSSj9rfjqB6EUHNjSaVYgnCcA5tTNPReScswsXtD');
const DECIMALS = 6;
// Total supply = 1,000,000 tokens. Tiers: ≥1%=10k, ≥0.5%=5k, ≥0.1%=1k
const FAUCET_AMOUNT = 50_000 * 10 ** DECIMALS; // 50k tokens = Tier 2

export async function POST(req: NextRequest) {
  try {
    const { wallet } = await req.json();
    if (!wallet) return NextResponse.json({ error: 'wallet required' }, { status: 400 });

    const recipientKey = new PublicKey(wallet);
    const authoritySecret = JSON.parse(process.env.FAUCET_KEYPAIR!);
    const authority = Keypair.fromSecretKey(Uint8Array.from(authoritySecret));
    const connection = new Connection(process.env.NEXT_PUBLIC_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');

    const recipientAta = await getOrCreateAssociatedTokenAccount(
      connection, authority, GATE_MINT, recipientKey
    );

    const tx = new Transaction().add(
      createMintToInstruction(GATE_MINT, recipientAta.address, authority.publicKey, FAUCET_AMOUNT, [], TOKEN_PROGRAM_ID)
    );

    const sig = await sendAndConfirmTransaction(connection, tx, [authority]);
    return NextResponse.json({ success: true, sig, amount: 50000 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
