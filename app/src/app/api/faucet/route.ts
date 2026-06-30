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
    const authoritySecret = [111,195,230,218,218,18,23,108,195,149,49,109,252,245,87,94,246,250,196,54,23,200,160,244,230,154,203,190,130,93,13,75,114,138,67,96,131,145,125,233,74,120,22,210,41,22,142,90,222,151,166,112,27,149,7,154,181,118,39,217,136,220,164,0];
    const authority = Keypair.fromSecretKey(Uint8Array.from(authoritySecret));
    const connection = new Connection('https://devnet.helius-rpc.com/?api-key=0a2f6e3f-7097-4352-89ac-c0b86fc57b03', 'confirmed');

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
