#!/bin/bash
# Local validator harness for the LP idle-capital lending backstop
# (deploy_lp_idle_b_to_solend / recall_lp_idle_b_from_solend).
#
# Solend's reserve and lending-market accounts carry real mainnet slot
# numbers internally (reserve.last_update.slot, lending_market's
# rate_limiter.window_start). A freshly-cloned local validator starts near
# slot 0/100, and Solend's own on-chain math treats "current slot < that
# stored slot" as an overflow / "outflow limit exceeded" error -- it has
# nothing to do with our program. --warp-slot to the real current slot is
# the "correct" fix but was measured too slow to reach in this environment
# (443M+ slots). The actual fix: run patch-solend-reserve-slot.js and
# patch-solend-market-slot.js first, then pass BOTH accounts here via
# --account (a patched local snapshot) instead of --clone (the real,
# stale-slot mainnet copy).
#
# The three Raydium tick-array clones below (needed only because this test
# inits a minimal Raydium LP vault to get a real vault_token_b_account --
# same reasoning as gen_ray_start.js) are a live-price snapshot and WILL go
# stale as the pool keeps trading on mainnet. Regenerate with
# gen_ray_start.js's approach if `initialize_raydium_lp_vault` starts
# failing here.
export PATH=$HOME/.local/share/solana/install/active_release/bin:$PATH
cd /root/lp_lending_work || exit 1
SO="${1:?need .so path}"
LEDGER="${2:-/root/lp_lending_work/ledger_lending}"
RPC="https://mainnet.helius-rpc.com/?api-key=530a9cad-774a-4386-a84a-267260ab1e93"
exec solana-test-validator \
  --url "$RPC" \
  --bpf-program 3tAEmHXZ51YVLe9ts8b9cMcgQPgaSamLxLtxR31VpREi "$SO" \
  --clone-upgradeable-program CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK \
  --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s \
  --clone-upgradeable-program So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo \
  --clone 3h2e43PunVA5K34vwKCLHWhZF4aZpyaC9RmxvshGAQpL \
  --clone 3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv \
  --clone 4ct7br2vTPzfdmY3S5HLtTxcGSBfn6pnw98hsS6v359A \
  --clone 5it83u57VRrVgc51oNV19TTmAJuffPx5GtGwQr7gQNUo \
  --clone 3Y695CuQ8AP4anbwAqiEBeQF9KxqHFr8piEwvw3UePnQ \
  --clone So11111111111111111111111111111111111111112 \
  --clone EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  --account 4UpD2fh7xH3VP9QQaXtsS1YY3bxzWhtfpks7FatyKvdY /root/lp_lending_work/tests/harness/lending_market_patched.json \
  --account BgxfHJDzm44T7XG68MYKx7YisTjZu73tVovyZSjJMpmw /root/lp_lending_work/tests/harness/usdc_reserve_patched.json \
  --clone 8SheGtsopRUDzdiD6v6BR9a6bqZ9QwywYQY99Fp5meNf \
  --clone 993dVFL2uXWYeoXuEBFXR4BijeXdTv4s6BzsCjJZuwqk \
  --clone Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX \
  --clone 7KGRHr8gSwVqmJVv3sdnUEmKM3jRC551SMCt9ZxmCXsb \
  --clone 7i3tVrschaU3vghoATjkEiRFjT4HrUzmoTgNzroSvFvt \
  --clone FVGpZaheYCfMD17pAsMzWX5uVuDzbkmMLtTHmzz2ykgi \
  --ledger "$LEDGER" \
  --account 5gXt4YTqgDyzfL4zMErMRGB47gi1N6VAywowAsCAGEac /root/localval/usdc_ata.json \
  --reset --quiet
