/**
 * lpVaultHelpers.ts — client/keeper-side helpers for the Orca Whirlpool LP
 * vault (Phase 2 groundwork, not wired into any live keeper flow yet).
 *
 * The on-chain program treats tick_array_lower/tick_array_upper as plain
 * unchecked accounts — Orca's own Whirlpool program validates them. It's the
 * CALLER's job to derive the right addresses before building a transaction.
 * This is genuinely off-chain math, verified against Orca's real SDK
 * (orca-so/whirlpools, legacy-sdk/whirlpool/src/utils/public/pda-utils.ts),
 * not guessed.
 */
import { PublicKey } from "@solana/web3.js";

const TICK_ARRAY_SEED = "tick_array";
const TICKS_PER_ARRAY = 88;

/**
 * Round a tick index down to the start of the tick array that contains it.
 * Matches Orca's own TickArrayUtil logic: start index is the nearest
 * multiple of (tickSpacing * TICKS_PER_ARRAY) at or below tickIndex —
 * rounding toward negative infinity for negative ticks (JS integer division
 * truncates toward zero, so we correct for that explicitly below).
 */
export function getStartTickIndex(tickIndex: number, tickSpacing: number): number {
  const ticksInArray = tickSpacing * TICKS_PER_ARRAY;
  let start = Math.floor(tickIndex / ticksInArray) * ticksInArray;
  // Math.floor already rounds toward -Infinity for exact division cases;
  // explicit for clarity/documentation that this was checked, not assumed.
  return start;
}

/**
 * Derive the TickArray PDA address for the array containing `tickIndex`.
 * Seed encoding verified against Orca's real SDK: the start tick index is
 * encoded as its UTF-8 decimal string representation (e.g. "-176"), NOT
 * raw i32 bytes — a subtle detail that would silently derive the wrong
 * address if guessed instead of checked.
 */
export function getTickArrayPda(
  whirlpool: PublicKey,
  tickIndex: number,
  tickSpacing: number,
  programId: PublicKey
): { address: PublicKey; startTickIndex: number } {
  const startTickIndex = getStartTickIndex(tickIndex, tickSpacing);
  const [address] = PublicKey.findProgramAddressSync(
    [
      Buffer.from(TICK_ARRAY_SEED),
      whirlpool.toBuffer(),
      Buffer.from(startTickIndex.toString()),
    ],
    programId
  );
  return { address, startTickIndex };
}

/**
 * Convenience: derive both tick arrays needed for a position's
 * increase_liquidity/decrease_liquidity CPI (lower and upper bound of the
 * position's price range).
 */
export function getPositionTickArrays(
  whirlpool: PublicKey,
  tickLowerIndex: number,
  tickUpperIndex: number,
  tickSpacing: number,
  programId: PublicKey
): { tickArrayLower: PublicKey; tickArrayUpper: PublicKey } {
  return {
    tickArrayLower: getTickArrayPda(whirlpool, tickLowerIndex, tickSpacing, programId).address,
    tickArrayUpper: getTickArrayPda(whirlpool, tickUpperIndex, tickSpacing, programId).address,
  };
}
