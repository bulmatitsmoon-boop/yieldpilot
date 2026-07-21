import sys

p = "programs/yieldpilot/src/adapters/raydium.rs"
s = open(p, encoding="utf-8").read()

# Raydium CLMM increase_liquidity / decrease_liquidity account order is:
#   0 nft_owner, 1 nft_account, 2 POOL_STATE, 3 protocol_position, 4 personal_position,
#   5 tick_array_lower, 6 tick_array_upper, 7 token_account_0, 8 token_account_1,
#   9 token_vault_0, 10 token_vault_1, 11 token_program
#
# Ours had pool_state at index 4 instead of 2, so Raydium deserialized
# protocol_position as the pool -> AccountOwnedByWrongProgram (3007) on pool_state.
# Both meta lists (increase and decrease) had the identical mistake, so this broke
# Raydium deposit AND withdraw. Found by the local harness 2026-07-20.
OLD = """        AccountMeta::new(*ctx.accounts.protocol_position.key, false),
        AccountMeta::new(*ctx.accounts.personal_position.key, false),
        AccountMeta::new(*ctx.accounts.pool_state.key, false),"""

NEW = """        AccountMeta::new(*ctx.accounts.pool_state.key, false),
        AccountMeta::new(*ctx.accounts.protocol_position.key, false),
        AccountMeta::new(*ctx.accounts.personal_position.key, false),"""

n = s.count(OLD)
if n != 2:
    sys.exit("FAIL: expected 2 mis-ordered meta lists (increase + decrease), found %d" % n)
s = s.replace(OLD, NEW)
open(p, "w", encoding="utf-8").write(s)
print("reordered pool_state to index 2 in BOTH increase_liquidity and decrease_liquidity")
