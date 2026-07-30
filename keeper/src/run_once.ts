import "dotenv/config";
import { logger } from "./logger";
import { fetchAllApys } from "./apyFetcher";
import { SolanaClient } from "./solanaClient";
import { computeRebalanceDecision, shouldCompound } from "./rebalancer";
import { notifyTelegram } from "./telegramNotify";
import { checkNewDeposits } from "./depositWatcher";

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
    // `state` was read by fetchAllVaults() BEFORE any rebalance below. rebalance()
    // writes new targetBps ON-CHAIN, which does NOT update this local object — so
    // executeRebalance must be given a FRESH read or it deploys against the OLD
    // allocation. Tracked separately so the re-read only costs an RPC call when a
    // rebalance actually happened.
    let currentState = state;
    const epochContext = await client.getEpochContext(address);

    if (state.autoRebalance) {
      const decision = computeRebalanceDecision(state, apys, epochContext);
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
          // MUST re-read: the targets we just wrote are on-chain, but `state` predates
          // them. Deploying against the stale copy sends funds to the allocation we
          // just abandoned, and the NEXT cycle then has to recall and re-deploy —
          // paying real, unrecoverable exit fees to undo work we shouldn't have done.
          //
          // Observed live 2026-07-17 on the SOL vault: the keeper correctly rebalanced
          // to jito 0 / marinade 8000 / kamino-sol 2000, then immediately deployed
          // 0.018054 SOL to JITO (whose target it had just set to 0) while kamino-sol
          // — the protocol it had just chosen — received nothing. Latent since PR #101
          // and masked until now: every earlier rebalance either changed nothing or hit
          // an empty vault, so the stale copy happened to match the fresh one.
          currentState = await client.fetchVault(address);
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
    await client.executeRebalance(address, currentState, epochContext.currentEpoch);
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

async function runDepositWatch(client: SolanaClient) {
  logger.info("── Deposit watch ──");
  const vaults = await client.fetchAllVaults();
  for (const { address, state } of vaults) {
    await checkNewDeposits(client, address, state.name).catch(err => {
      logger.warn(`Deposit watch failed (non-fatal): ${address.slice(0, 8)}... — ${err.message}`);
    });
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
  await runDepositWatch(client);
  await runHealthCheck(client);

  logger.info("✓ Single run complete.");
}

main().catch(err => {
  logger.error("Fatal error", { error: err.message });
  process.exit(1);
});
