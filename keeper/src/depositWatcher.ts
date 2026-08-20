import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { logger } from "./logger";
import { notifyTelegram } from "./telegramNotify";
import type { SolanaClient } from "./solanaClient";

/**
 * depositWatcher.ts — announces real deposits to Telegram as they happen, instead of
 * only on Rebalanced/Compounded. The program already emits a `Deposited` event on
 * every deposit; nothing previously watched for it.
 *
 * State (last-processed signature per vault) is a small file committed back to the
 * repo by the workflow — same auto-commit pattern already used for IDL syncing in
 * build.yml. Deliberately NOT a new secret/Redis dependency: this repo's Upstash
 * instance is a Vercel-managed integration whose value isn't readable back via the
 * Vercel API, and a committed state file needs zero new infrastructure.
 */

const STATE_PATH = path.resolve(__dirname, "..", "state", "deposit-watch.json");

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

export async function checkNewDeposits(client: SolanaClient, vaultAddress: string, vaultName: string) {
  const state = readState();
  const vaultPk = new PublicKey(vaultAddress);
  const lastSig = state[vaultAddress];

  // First time this vault has ever been watched: just record the current newest
  // signature as the baseline. Without this, the very first run would "discover"
  // and spam-announce every historical deposit since the vault's creation.
  if (!lastSig) {
    const newest = await client.connection.getSignaturesForAddress(vaultPk, { limit: 1 });
    if (newest[0]) {
      state[vaultAddress] = newest[0].signature;
      writeState(state);
    }
    return;
  }

  const sigInfos = await client.connection.getSignaturesForAddress(vaultPk, { until: lastSig, limit: 50 });
  if (sigInfos.length === 0) return; // nothing new since last check

  const isSol = vaultName.toUpperCase().includes("SOL");
  const decimals = isSol ? 1e9 : 1e6;
  const symbol = isSol ? "SOL" : "USDC";
  const parser = new anchor.EventParser(client.program.programId, client.program.coder as any);

  // Oldest first, so Telegram messages land in chronological order.
  for (const info of [...sigInfos].reverse()) {
    const tx = await client.connection.getTransaction(info.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx?.meta?.logMessages) continue;

    for (const event of parser.parseLogs(tx.meta.logMessages)) {
      // Anchor's EventParser lowercases the first letter of the IDL event name
      // ("Deposited" in lib.rs -> "deposited" here) — verified live against a real
      // deposit transaction, not assumed.
      if (event.name !== "deposited") continue;
      const eventVault = (event.data.vault as PublicKey).toBase58();
      if (eventVault !== vaultAddress) continue;

      const amount = Number(event.data.amount) / decimals;
      const user = (event.data.user as PublicKey).toBase58();
      logger.info("  New deposit detected", { vault: vaultName, amount, user });

      await notifyTelegram(
        `💰 <b>Deposit</b> — ${vaultName}\n` +
        `${amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symbol} from ${user.slice(0, 4)}...${user.slice(-4)}\n` +
        `<a href="https://solscan.io/tx/${info.signature}">View transaction</a>`
      );
    }
  }

  // sigInfos[0] is the newest of this batch (getSignaturesForAddress returns newest-first).
  state[vaultAddress] = sigInfos[0].signature;
  writeState(state);
}
