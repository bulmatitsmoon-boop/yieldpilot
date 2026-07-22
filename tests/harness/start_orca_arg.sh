#!/bin/bash
# Orca LP harness, parameterised on which .so to load, so the SAME cloned pool
# state can be run against the pre-fix and post-fix binaries back to back.
export PATH=$HOME/.local/share/solana/install/active_release/bin:$PATH
cd /root/localval || exit 1
SO="${1:?need .so path}"
LEDGER="${2:-/root/localval/ledger_fee}"
RPC="https://mainnet.helius-rpc.com/?api-key=REDACTED-ROTATED-KEY"
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
  --clone 4W47R82p72U1Nc2NvisATodthbCi4BFnT9cgDK8npfZF \
  --clone HME5BJtcqSa2Y1sLPXrftqZ9HRwKV4bGhnw41qw5Leka \
  --clone ChxrcGgr1UNLhgE6bge26EQRwDzbv9Q6co5ea12no6JP \
  --clone 2s4eJvC4t2oscWNFDw4sZShL3SfB3Zifmr6R8Qayp7mU \
  --clone DXi5Z4FeJKHm4kcZPdmfoWSkJG7sj5s3wrvnpxy3DAny \
  --clone 65cUCgkA4THMitgKTyatqDnKHPSytxkt5GGJ1VMVNarC \
  --clone 8Rs3qKaVGBndwNdeDqHcayatonVzdBrdYoq27CKyjuE7 \
  --ledger "$LEDGER" \
  --reset --quiet
