#!/bin/bash
# Orca LP harness, parameterised on which .so to load, so the SAME cloned pool
# state can be run against the pre-fix and post-fix binaries back to back.
export PATH=$HOME/.local/share/solana/install/active_release/bin:$PATH
cd /root/localval || exit 1
SO="${1:?need .so path}"
LEDGER="${2:-/root/localval/ledger_fee}"
# RPC endpoint is read from the environment, never hardcoded. Set MAINNET_RPC before
# running: export MAINNET_RPC="https://mainnet.helius-rpc.com/?api-key=<your-key>"
# (an earlier version had a live key baked in here — scrubbed in the pre-public audit).
RPC="${MAINNET_RPC:?set MAINNET_RPC to your mainnet RPC endpoint before running}"
# Tick arrays covering the position range + swap-routing span around the LIVE
# mainnet tick at the time this list was last refreshed (2026-09-01,
# tick_current -22844). MUST be refreshed again whenever this script starts
# failing with a Whirlpool CPI error immediately after a deposit/swap (e.g.
# "account not owned by the executing program") — that means the pool has
# moved far enough that these addresses no longer cover the range the
# harness's live-tick-derived TICK_LOWER/TICK_UPPER computes. Regenerate by
# deriving tick_array PDAs for arrayStart(tickCurrent) +/- {0,1,2}*352 off the
# pool's current on-chain tick_current, then verify each one actually exists
# on mainnet before swapping in — do not guess. IMPORTANT: comments must NOT
# be placed inside the backslash-continued --clone chain below — bash splices
# continued lines BEFORE comment parsing, so a `#` mid-chain swallows every
# argument after it until the next unescaped newline, silently truncating the
# command (confirmed live 2026-09-01: solana-test-validator failed to start
# with a bare "Found argument ''" error and no indication which line broke).
exec solana-test-validator \
  --url "$RPC" \
  --bpf-program 8c7Boyk91MWkn5jabf5CnYD8DrG6p4hYm9eDdAAWXEKH "$SO" \
  --clone-upgradeable-program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc \
  --clone 2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ \
  --clone Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE \
  --clone EUuUbDcafPrmVTD5M6qoJAoyyNbihBhugADAxRMn5he9 \
  --clone 2WLWEuKDgkDUccTpbwYp1GToYktiSB1cXvreHUwiSUVP \
  --clone So11111111111111111111111111111111111111112 \
  --clone EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  --account 5gXt4YTqgDyzfL4zMErMRGB47gi1N6VAywowAsCAGEac /root/localval/usdc_ata.json \
  --clone 7T6JQngtMoLfPoxT6ZpbzY1uGiWkGPgwLC2vR1sTjPsn \
  --clone 7ayWKntkc7zDBSUHQPjBKexQRzGf9XUgCiSZN1xj6Bey \
  --clone Dsb9ogdvNLTtefz48ZBb6XUewrsHGmwQ82W8RMiQc5E1 \
  --clone 32wMhfqGgeaftnPacPR6pqBPL3agbd7to1oUsqo6y14F \
  --clone 8NPFeBD52yqJWnsmBNma9qXXGEjXa6WatYcLMXjzSeyK \
  --ledger "$LEDGER" \
  --reset --quiet
