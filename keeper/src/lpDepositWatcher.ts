import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { logger } from "./logger";
import { notifyTelegram } from "./telegramNotify";
import type { SolanaClient } from "./solanaClient";

/**
 * lpDepositWatcher.ts — the LP-vault equivalent of depositWatcher.ts. Announces real
 * Orca/Raydium LP deposits and withdrawals to Telegram as they happen.
 *
 * WHY THIS DIDN'T EXIST UNTIL NOW: depositWatcher.ts only ever watched the Safe
 * vaults (VAULT_ADDRESSES) for the `Deposited` event. LP vaults emit their own
 * `LpDeposited`/`LpWithdrawn` events (see lp_vault.rs), and nothing ever listened for
 * them — confirmed live 2026-10-20, right after Phase 2 went public, so every real LP
 * deposit/withdrawal since launch has been silent in the alert channel.
 *
 * Real amounts come from the DEPOSITING/WITHDRAWING USER's own pre/post token-balance
 * deltas on the transaction, not from the event's `liquidity_amount` field — that's a
 * protocol-internal u128 liquidity unit (each protocol's own math), not a human-
 * meaningful token amount. Same technique the portfolio page's own activity feed
 * already uses (see portfolio/page.tsx's ActivityEntry). This also sidesteps a real
 * atomicity trap: the VAULT's own token accounts are funded and drained again within
 * the same atomic transaction (user ATA -> vault ATA -> protocol pool), so their net
 * pre/post delta is ~0 and useless for this; the user's own wallet balance moves by
 * the real amount and nothing else touches it mid-transaction.
 */

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
function symbolForMint(mint: string): string {
  if (mint === SOL_MINT) return "SOL";
  if (mint === USDC_MINT) return "USDC";
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

const STATE_PATH = path.resolve(__dirname, "..", "state", "lp-deposit-watch.json");

function readState(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state: Record<string, string>) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

export async function checkNewLpActivity(client: SolanaClient, lpVaultAddress: string, lpVaultName: string) {
  const state = readState();
  const vaultPk = new PublicKey(lpVaultAddress);
  const lastSig = state[lpVaultAddress];

  // First time this LP vault has ever been watched: record the current newest
  // signature as the baseline rather than spam-announcing its whole history.
  // Same bootstrap pattern as depositWatcher.ts.
  if (!lastSig) {
    const newest = await client.connection.getSignaturesForAddress(vaultPk, { limit: 1 });
    if (newest[0]) {
      state[lpVaultAddress] = newest[0].signature;
      writeState(state);
    }
    return;
  }

  const sigInfos = await client.connection.getSignaturesForAddress(vaultPk, { until: lastSig, limit: 50 });
  if (sigInfos.length === 0) return; // nothing new since last check

  const vault = await client.fetchLpVault(lpVaultAddress);
  const tokenAMint = vault.tokenAMint.toBase58();
  const tokenBMint = vault.tokenBMint.toBase58();
  const symA = symbolForMint(tokenAMint);
  const symB = symbolForMint(tokenBMint);

  const parser = new anchor.EventParser(client.program.programId, client.program.coder as any);

  // Oldest first, so Telegram messages land in chronological order.
  for (const info of [...sigInfos].reverse()) {
    const tx = await client.connection.getParsedTransaction(info.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx?.meta?.logMessages) continue;

    for (const event of parser.parseLogs(tx.meta.logMessages)) {
      // Anchor's EventParser lowercases the first letter of the IDL event name,
      // same convention verified live for depositWatcher.ts's "deposited".
      const isDeposit = event.name === "lpDeposited";
      const isWithdraw = event.name === "lpWithdrawn";
      if (!isDeposit && !isWithdraw) continue;
      const eventVault = (event.data.lpVault as PublicKey).toBase58();
      if (eventVault !== lpVaultAddress) continue;

      const user = (event.data.user as PublicKey).toBase58();

      const pre = tx.meta.preTokenBalances ?? [];
      const post = tx.meta.postTokenBalances ?? [];
      let deltaA = 0;
      let deltaB = 0;
      for (const p of post) {
        if (p.owner !== user) continue;
        const before = pre.find((b) => b.accountIndex === p.accountIndex);
        const delta = (p.uiTokenAmount.uiAmount ?? 0) - (before?.uiTokenAmount.uiAmount ?? 0);
        if (p.mint === tokenAMint) deltaA += delta;
        else if (p.mint === tokenBMint) deltaB += delta;
      }
      const amtA = Math.abs(deltaA);
      const amtB = Math.abs(deltaB);

      logger.info(isDeposit ? "  New LP deposit detected" : "  New LP withdraw detected", {
        vault: lpVaultName, user, amtA, amtB,
      });

      const emoji = isDeposit ? "💧" : "🏧";
      const verb = isDeposit ? "LP Deposit" : "LP Withdraw";
      const prep = isDeposit ? "from" : "to";
      await notifyTelegram(
        `${emoji} <b>${verb}</b> — ${lpVaultName}\n` +
        `${amtA.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symA} + ${amtB.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symB} ${prep} ${user.slice(0, 4)}...${user.slice(-4)}\n` +
        `<a href="https://solscan.io/tx/${info.signature}">View transaction</a>`
      );
    }
  }

  // sigInfos[0] is the newest of this batch (getSignaturesForAddress returns newest-first).
  state[lpVaultAddress] = sigInfos[0].signature;
  writeState(state);
}
