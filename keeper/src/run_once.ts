import "dotenv/config";
import { logger } from "./logger";
import { fetchAllApys } from "./apyFetcher";
import { SolanaClient } from "./solanaClient";
import { computeRebalanceDecision, shouldCompound } from "./rebalancer";
import { notifyTelegram } from "./telegramNotify";

/**
 * run_once.ts — single-cycle keeper run for GitHub Actions scheduled workflow.
 * Does one APY-poll+rebalance pass, one compound check, one health check, then exits.
 * Replaces the always-on droplet process (which OOM'd repeatedly on a 512MB box).
 */

function validateEnv() {
  const required = ["PROGRAM_ID", "VAULT_ADDRESSES", "KEEPER_KEYPAIR_PATH"];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    logger.error("Missing required environment variables", { missing });
    process.exit(1);
  }
}

async function runApyPollAndRebalance(client: SolanaClient) {
  logger.info("── APY poll + rebalance check ──");
  const apys = await fetchAllApys();
  const vaults = await client.fetchAllVaults();

  if (vaults.length === 0) {
    logger.warn("No vaults found — check VAULT_ADDRESSES");
    return;
  }

  for (const { address, state } of vaults) {
    logger.info(`Checking vault: ${address.slice(0, 8)}... (${state.name})`);

    // auto_rebalance gates whether we CHANGE target allocations — it must NOT gate
    // deploying idle funds to the targets already set. This previously did `continue`,
    // so turning auto-rebalance off (e.g. to pin allocations while a protocol is known
    // broken) silently meant deposits were NEVER deployed and sat idle forever.
    // Found 2026-07-16 with 5 real USDC stuck idle at kamino target 100%.
    if (state.autoRebalance) {
      const decision = computeRebalanceDecision(state, apys);
      logger.info(`  Rebalance decision: ${decision.reason}`, {
        current: decision.currentAllocations,
        proposed: decision.newAllocations,
        apyImprovementBps: decision.expectedApyImprovement,
      });
      if (decision.shouldRebalance) {
        logger.info("  Sending rebalance transaction...");
        const sig = await client.rebalance(address, decision.newAllocations);
        if (sig) {
          logger.info("  ✓ Target allocations updated", { signature: sig });
          await notifyTelegram(
            `⚡ <b>Rebalanced</b> — ${state.name}
` +
            `${decision.reason}
` +
            `<a href="https://solscan.io/tx/${sig}">View transaction</a>`
          );
        }
      }
    } else {
      logger.info("  Auto-rebalance off — target allocations left unchanged");
    }

    // ALWAYS sync deployment to whatever the current targets are, regardless of
    // auto_rebalance. With targets pinned (e.g. kamino 100% / solend 0%) this deploys
    // only to the healthy protocol and sends nothing to the disabled one.
    logger.info("  Syncing fund deployment to current targets...");
    await client.executeRebalance(address, state);
  }
}

async function runCompound(client: SolanaClient) {
  logger.info("── Compound check ──");
  const vaults = await client.fetchAllVaults();
  for (const { address, state } of vaults) {
    const { compound, reason } = shouldCompound(state);
    logger.info(`Vault ${address.slice(0, 8)}...: ${reason}`);
    if (compound) {
      logger.info("  Sending compound transaction...");
      const sig = await client.compound(address);
      if (sig) {
        logger.info("  ✓ Compounded", { signature: sig });
        await notifyTelegram(
          `🔄 <b>Compounded</b> — ${state.name}\n` +
          `<a href="https://solscan.io/tx/${sig}">View transaction</a>`
        );
      }
    }
  }
}

async function runHealthCheck(client: SolanaClient) {
  const balanceSol = await client.getKeeperBalance();
  if (balanceSol < 0.05) {
    logger.warn("⚠️  Keeper wallet balance low!", { balance: `${balanceSol.toFixed(4)} SOL` });
  }
  logger.info("Health check", { keeperBalance: `${balanceSol.toFixed(4)} SOL` });
}

async function main() {
  logger.info("⚡ YieldPilot Keeper — single run (GitHub Actions cron)");
  validateEnv();
  const client = new SolanaClient();

  const balance = await client.getKeeperBalance();
  logger.info(`Keeper wallet: ${client.keeper.publicKey.toBase58()} (${balance.toFixed(4)} SOL)`);
  if (balance < 0.02) {
    logger.error("Keeper wallet has insufficient SOL for transactions.");
    process.exit(1);
  }

  const setupVaults = process.env.VAULT_ADDRESSES?.split(",").map(a => a.trim()) ?? [];
  for (const vaultAddr of setupVaults) {
    await client.setupVaultTokenAccounts(vaultAddr).catch(err => {
      logger.warn(`Vault account setup failed (non-fatal): ${vaultAddr.slice(0, 8)}... — ${err.message}`);
    });
  }

  await runApyPollAndRebalance(client);
  await runCompound(client);
  await runHealthCheck(client);

  logger.info("✓ Single run complete.");
}

main().catch(err => {
  logger.error("Fatal error", { error: err.message });
  process.exit(1);
});
