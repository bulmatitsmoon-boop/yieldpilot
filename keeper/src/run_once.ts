import "dotenv/config";
import { logger } from "./logger";
import { fetchAllApys } from "./apyFetcher";
import { SolanaClient } from "./solanaClient";
import { computeRebalanceDecision, shouldCompound } from "./rebalancer";
import { computeLpRepositionDecision, LpVaultRangeState } from "./lpVaultRebalancer";
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
    // `state` was read by fetchAllVaults() BEFORE any rebalance below. rebalance()
    // writes new targetBps ON-CHAIN, which does NOT update this local object — so
    // executeRebalance must be given a FRESH read or it deploys against the OLD
    // allocation. Tracked separately so the re-read only costs an RPC call when a
    // rebalance actually happened.
    let currentState = state;

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
    await client.executeRebalance(address, currentState);
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

/**
 * Phase 2, not yet public — see lp_vault.rs's module docs. Checks every vault
 * in LP_VAULT_ADDRESSES (unset/empty is fine, just skips this job — distinct
 * from the main VAULT_ADDRESSES, which stays required) for whether its active
 * position has drifted out of range or near the edge, and pulls it out via
 * exitOrcaLpPosition/exitRaydiumLpPosition if so.
 *
 * Deliberately does NOT attempt to reopen a position — open_new_*_lp_position
 * is admin-gated on-chain (choosing a new price range is a judgment call, not
 * something to automate), so this job surfaces that as a loud warning log
 * instead of silently failing a transaction the keeper key can't sign.
 *
 * Ported from index.ts (the old always-on droplet daemon) — this run_once.ts
 * script is what actually executes in production (GitHub Actions cron); the
 * LP check was originally wired only into index.ts, which stopped running
 * entirely once the droplet was destroyed 2026-07-14, silently orphaning this
 * job before it ever shipped.
 */
async function runLpVaultCheck(client: SolanaClient) {
  logger.info("── LP vault reposition check ──");
  const lpVaults = await client.fetchAllLpVaults();
  if (lpVaults.length === 0) {
    logger.debug("No LP vaults configured (LP_VAULT_ADDRESSES) — skipping");
    return;
  }

  for (const { address, state } of lpVaults) {
    logger.info(`Checking LP vault: ${address.slice(0, 8)}... (${state.name})`);

    if (state.paused) {
      logger.info("  Paused — skipping");
      continue;
    }

    let tickCurrent: number;
    let tickSpacing: number;
    try {
      ({ tickCurrent, tickSpacing } = await client.readPoolTickCurrent(state));
    } catch (err: any) {
      logger.error("  Failed to read pool tick — skipping this vault", { error: err.message });
      continue;
    }

    const rangeState: LpVaultRangeState = {
      tickLowerIndex: state.tickLowerIndex,
      tickUpperIndex: state.tickUpperIndex,
      tickSpacing,
      positionActive: state.positionActive,
    };

    let decision;
    try {
      decision = computeLpRepositionDecision(rangeState, tickCurrent);
    } catch (err: any) {
      logger.error("  Reposition decision failed — skipping this vault", { error: err.message });
      continue;
    }

    logger.info(`  Reposition decision: ${decision.reason}`, {
      tickCurrent,
      currentRange: [state.tickLowerIndex, state.tickUpperIndex],
      suggestedRange: [decision.newTickLowerIndex, decision.newTickUpperIndex],
    });

    if (!decision.shouldReposition) continue;

    logger.info("  Exiting position...");
    const liquidityBefore = state.totalLiquidity;
    const sig = await client.exitLpPosition(address);
    if (!sig) continue;
    logger.info(`  ✓ Position exited`, { signature: sig });

    // Immediately re-enter. An LP vault holding cash earns nothing, so leaving the
    // reposition half-done is worse than not repositioning at all. open_new_* now
    // accepts the keeper (it used to be admin-only, which forced manual intervention).
    logger.info(`  Re-entering at [${decision.newTickLowerIndex}, ${decision.newTickUpperIndex}]...`);
    const result = await client.repositionLpVault(
      address,
      decision.newTickLowerIndex!,
      decision.newTickUpperIndex!,
      liquidityBefore
    );
    if (result?.redeploySig) {
      logger.info(`  ✓ Repositioned`, { signature: result.redeploySig, liquidity: result.liquidity });
      await notifyTelegram(`🔄 LP repositioned — ${address.slice(0, 8)}… now [${decision.newTickLowerIndex}, ${decision.newTickUpperIndex}]`);
    } else {
      logger.error(`  ⚠️  Vault ${address} is EXITED BUT NOT REDEPLOYED — funds are idle and earning nothing. Will retry next run.`);
      await notifyTelegram(`⚠️ LP vault ${address.slice(0, 8)}… is idle: exited but could not redeploy. Retrying next run.`);
    }
  }
}

/**
 * Self-heal: a vault with no active position is a vault earning nothing. This catches
 * the case where a previous run exited but failed to redeploy (crash, RPC blip, a
 * redeploy that could not be sized), independently of whether we just repositioned.
 */
async function runLpIdleRecovery(client: SolanaClient, addresses: string[]) {
  for (const address of addresses) {
    let state: any;
    try {
      state = await client.fetchLpVault(address);
    } catch { continue; }
    if (state.positionActive) continue;

    logger.warn(`  LP vault ${address.slice(0, 8)}… has NO ACTIVE POSITION — funds are idle, recovering`);
    let tickCurrent: number, tickSpacing: number;
    try {
      ({ tickCurrent, tickSpacing } = await client.readPoolTickCurrent(state));
    } catch (err: any) {
      logger.error("  Could not read pool tick — skipping", { error: err.message });
      continue;
    }
    // Pick a range the vault can actually FUND. A blind centred range needs both
    // tokens, and a vault that is sitting idle usually got there by drifting out of
    // range — which converts it almost entirely into ONE token. Proposing a centred
    // range then fails to redeploy and the vault stays idle, so "recovery" would
    // loop forever without recovering anything.
    //
    // Here the balances are genuinely knowable (the funds ARE in the token accounts,
    // unlike at reposition-decision time), so read them and pass them in.
    let idleAmountA: number | undefined, idleAmountB: number | undefined;
    try {
      ({ amountA: idleAmountA, amountB: idleAmountB } = await client.readLpVaultIdle(state));
    } catch (err: any) {
      logger.warn("  Could not read idle balances — falling back to a centred range", { error: err.message });
    }

    const halfWidth = tickSpacing * 32;
    const decision = computeLpRepositionDecision(
      {
        // Synthesise the "current range" as the width we want to reopen at; the
        // vault has no active position, so its stored range is only a width hint.
        tickLowerIndex: tickCurrent - halfWidth,
        tickUpperIndex: tickCurrent + halfWidth,
        tickSpacing,
        positionActive: false,
        idleAmountA,
        idleAmountB,
      },
      tickCurrent
    );
    const lower = decision.newTickLowerIndex;
    const upper = decision.newTickUpperIndex;
    logger.info(`  Recovery range ${decision.rangeShape} [${lower}, ${upper}]`, { idleAmountA, idleAmountB });

    const result = await client.repositionLpVault(address, lower, upper, state.totalLiquidity);
    if (result?.redeploySig) {
      logger.info(`  ✓ Recovered idle vault into [${lower}, ${upper}]`, { signature: result.redeploySig });
      await notifyTelegram(`🔄 LP vault ${address.slice(0, 8)}… recovered from idle into [${lower}, ${upper}]`);
    } else {
      logger.error(`  ⚠️  Recovery failed — vault ${address} still idle`);
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
  await runLpVaultCheck(client);
  // Safety net: any vault left without an active position is earning nothing. Recover it
  // regardless of whether this run repositioned, so a failed redeploy on a previous run
  // does not strand funds indefinitely.
  {
    const lpAddresses = (process.env.LP_VAULT_ADDRESSES || "").split(",").map(a => a.trim()).filter(Boolean);
    if (lpAddresses.length) await runLpIdleRecovery(client, lpAddresses);
  }
  await runHealthCheck(client);

  logger.info("✓ Single run complete.");
}

main().catch(err => {
  logger.error("Fatal error", { error: err.message });
  process.exit(1);
});
