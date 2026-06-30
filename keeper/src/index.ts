import "dotenv/config";
import cron from "node-cron";
import { logger } from "./logger";
import { fetchAllApys, ProtocolApy } from "./apyFetcher";
import { SolanaClient } from "./solanaClient";
import { computeRebalanceDecision, shouldCompound } from "./rebalancer";
import fs from "fs";
import path from "path";

// ─────────────────────────────────────────────────────────────────────────────
// Validate environment
// ─────────────────────────────────────────────────────────────────────────────

function validateEnv() {
  const required = ["PROGRAM_ID", "VAULT_ADDRESSES", "KEEPER_KEYPAIR_PATH"];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    logger.error("Missing required environment variables", { missing });
    process.exit(1);
  }
  // Ensure IDL exists
  const idlPath = path.resolve(__dirname, "idl/yieldpilot.json");
  if (!fs.existsSync(idlPath)) {
    logger.error(
      `IDL not found at ${idlPath}. Run 'anchor build' then copy target/idl/yieldpilot.json to src/idl/`
    );
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Keeper state
// ─────────────────────────────────────────────────────────────────────────────

interface KeeperStats {
  apyPolls: number;
  rebalances: number;
  compounds: number;
  errors: number;
  lastApyPoll: Date | null;
  lastRebalance: Date | null;
  lastCompound: Date | null;
  latestApys: ProtocolApy[];
}

const stats: KeeperStats = {
  apyPolls: 0,
  rebalances: 0,
  compounds: 0,
  errors: 0,
  lastApyPoll: null,
  lastRebalance: null,
  lastCompound: null,
  latestApys: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// Core keeper jobs
// ─────────────────────────────────────────────────────────────────────────────

async function runApyPollAndRebalance(client: SolanaClient) {
  logger.info("── APY poll + rebalance check ──");
  stats.apyPolls++;
  stats.lastApyPoll = new Date();

  // 1. Fetch latest APYs
  const apys = await fetchAllApys();
  stats.latestApys = apys;

  // 2. Check each vault
  const vaults = await client.fetchAllVaults();

  if (vaults.length === 0) {
    logger.warn("No vaults found — check VAULT_ADDRESSES in .env");
    return;
  }

  for (const { address, state } of vaults) {
    logger.info(`Checking vault: ${address.slice(0, 8)}... (${state.name})`);

    if (!state.autoRebalance) {
      logger.info("  Auto-rebalance off — skipping");
      continue;
    }

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
        stats.rebalances++;
        stats.lastRebalance = new Date();
        logger.info(`  ✓ Target allocations updated`, {
          signature: sig,
          newAllocations: decision.newAllocations,
        });
      } else {
        stats.errors++;
      }
    }

    // Always sync funds to current targets even if targets did not change.
    // Handles newly-deposited funds that have not been deployed yet.
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
        stats.compounds++;
        stats.lastCompound = new Date();
        logger.info(`  ✓ Compounded`, { signature: sig });
      } else {
        stats.errors++;
      }
    }
  }
}

async function runHealthCheck(client: SolanaClient) {
  const balanceSol = await client.getKeeperBalance();
  const LOW_BALANCE_THRESHOLD = 0.05; // 0.05 SOL

  if (balanceSol < LOW_BALANCE_THRESHOLD) {
    logger.warn("⚠️  Keeper wallet balance low!", {
      balance: `${balanceSol.toFixed(4)} SOL`,
      address: client.keeper.publicKey.toBase58(),
    });
  }

  logger.info("Health check", {
    keeperBalance: `${balanceSol.toFixed(4)} SOL`,
    uptime: `${Math.floor(process.uptime() / 60)}min`,
    stats: {
      apyPolls: stats.apyPolls,
      rebalances: stats.rebalances,
      compounds: stats.compounds,
      errors: stats.errors,
    },
    latestApys: stats.latestApys.map(a => `${a.name}(${a.asset}): ${a.apyPercent.toFixed(2)}%`),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  logger.info("⚡ YieldPilot Keeper starting up...");
  validateEnv();

  const client = new SolanaClient();

  // Confirm keeper has funds
  const balance = await client.getKeeperBalance();
  logger.info(`Keeper wallet: ${client.keeper.publicKey.toBase58()} (${balance.toFixed(4)} SOL)`);

  // Initialize protocol token accounts (ATAs) for each vault — safe to run every startup
  const setupVaults = process.env.VAULT_ADDRESSES?.split(",").map(a => a.trim()) ?? [];
  for (const vaultAddr of setupVaults) {
    logger.info(`Setting up vault token accounts: ${vaultAddr.slice(0, 8)}...`);
    await client.setupVaultTokenAccounts(vaultAddr).catch(err => {
      logger.warn(`Vault account setup failed (non-fatal): ${vaultAddr.slice(0, 8)}... — ${err.message}`);
    });
  }

  if (balance < 0.02) {
    logger.error("Keeper wallet has insufficient SOL for transactions. Fund it and restart.");
    process.exit(1);
  }

  // ── Cron schedules ────────────────────────────────────────────────────────

  const apyCron = process.env.APY_POLL_CRON || "*/15 * * * *"; // every 15 min
  const compoundCron = process.env.COMPOUND_CRON || "0 * * * *";  // every hour
  const healthCron = "*/5 * * * *"; // every 5 min

  logger.info("Scheduling cron jobs", { apyCron, compoundCron });

  // APY poll + rebalance
  cron.schedule(apyCron, async () => {
    try {
      await runApyPollAndRebalance(client);
    } catch (err: any) {
      stats.errors++;
      logger.error("APY poll/rebalance error", { error: err.message });
    }
  });

  // Compound
  cron.schedule(compoundCron, async () => {
    try {
      await runCompound(client);
    } catch (err: any) {
      stats.errors++;
      logger.error("Compound error", { error: err.message });
    }
  });

  // Health check
  cron.schedule(healthCron, async () => {
    try {
      await runHealthCheck(client);
    } catch (err: any) {
      logger.error("Health check error", { error: err.message });
    }
  });

  // ── Run immediately on startup ────────────────────────────────────────────
  logger.info("Running initial checks...");
  try {
    await runApyPollAndRebalance(client);
    await runCompound(client);
    await runHealthCheck(client);
  } catch (err: any) {
    logger.error("Startup check failed", { error: err.message });
  }

  logger.info("✓ Keeper running. Press Ctrl+C to stop.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────────────────────

process.on("SIGINT", () => {
  logger.info("Shutting down keeper...", { finalStats: stats });
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", { reason });
});

main().catch(err => {
  logger.error("Fatal error", { error: err.message });
  process.exit(1);
});
