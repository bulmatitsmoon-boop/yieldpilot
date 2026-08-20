/**
 * lpVaultHelpers.ts — client/keeper-side PDA helpers for the LP vault
 * (Orca Whirlpools + Raydium CLMM). Wired into the keeper's polling loop
 * as of the reposition-check job in index.ts — see lpVaultRebalancer.ts
 * for the decision logic and solanaClient.ts's exitLpPosition for how
 * these PDAs get used in an actual instruction.
 *
 * The on-chain program treats tick_array_lower/tick_array_upper (and
 * Raydium's protocol_position/personal_position) as plain unchecked
 * accounts — each protocol's own program validates them. It's the
 * CALLER's job to derive the right addresses before building a
 * transaction. This is genuinely off-chain math, verified against each
 * protocol's real SDK, not guessed.
 */
import { PublicKey } from "@solana/web3.js";

// ── Orca Whirlpools ──────────────────────────────────────────────────────────
// Verified against orca-so/whirlpools, legacy-sdk/whirlpool/src/utils/public/pda-utils.ts.

const ORCA_TICK_ARRAY_SEED = "tick_array";
const ORCA_TICKS_PER_ARRAY = 88;

/**
 * Round a tick index down to the start of the tick array that contains it.
 * Matches Orca's own TickArrayUtil logic: start index is the nearest
 * multiple of (tickSpacing * TICKS_PER_ARRAY) at or below tickIndex —
 * rounding toward negative infinity for negative ticks (JS integer division
 * truncates toward zero, so we correct for that explicitly below).
 */
export function getStartTickIndex(tickIndex: number, tickSpacing: number): number {
  const ticksInArray = tickSpacing * ORCA_TICKS_PER_ARRAY;
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
      Buffer.from(ORCA_TICK_ARRAY_SEED),
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

// ── Raydium CLMM ──────────────────────────────────────────────────────────────
// Verified against raydium-io/raydium-clmm's PDA seed constants and against
// @raydium-io/raydium-sdk-v2's own compiled pda.js — same reasoning as
// adapters/raydium.rs's PDA seed notes. IMPORTANT: Raydium encodes tick
// indices as BIG-ENDIAN bytes, unlike Orca's decimal-string encoding above —
// a detail that would silently derive the wrong address if confused.

const RAYDIUM_TICK_ARRAY_SEED = "tick_array";
const RAYDIUM_POSITION_SEED = "position";
const RAYDIUM_TICKS_PER_ARRAY = 60; // TICK_ARRAY_SIZE, verified against @raydium-io/raydium-sdk-v2's constants.js

function i32ToBeBytes(n: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(n, 0);
  return buf;
}

export function getRaydiumTickArrayStartIndex(tickIndex: number, tickSpacing: number): number {
  const ticksInArray = tickSpacing * RAYDIUM_TICKS_PER_ARRAY;
  return Math.floor(tickIndex / ticksInArray) * ticksInArray;
}

export function getRaydiumTickArrayPda(
  poolState: PublicKey,
  tickIndex: number,
  tickSpacing: number,
  programId: PublicKey
): { address: PublicKey; startTickIndex: number } {
  const startTickIndex = getRaydiumTickArrayStartIndex(tickIndex, tickSpacing);
  const [address] = PublicKey.findProgramAddressSync(
    [Buffer.from(RAYDIUM_TICK_ARRAY_SEED), poolState.toBuffer(), i32ToBeBytes(startTickIndex)],
    programId
  );
  return { address, startTickIndex };
}

export function getRaydiumPositionTickArrays(
  poolState: PublicKey,
  tickLowerIndex: number,
  tickUpperIndex: number,
  tickSpacing: number,
  programId: PublicKey
): { tickArrayLower: PublicKey; tickArrayUpper: PublicKey } {
  return {
    tickArrayLower: getRaydiumTickArrayPda(poolState, tickLowerIndex, tickSpacing, programId).address,
    tickArrayUpper: getRaydiumTickArrayPda(poolState, tickUpperIndex, tickSpacing, programId).address,
  };
}

export function getRaydiumProtocolPositionPda(
  poolState: PublicKey,
  tickLowerIndex: number,
  tickUpperIndex: number,
  programId: PublicKey
): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [Buffer.from(RAYDIUM_POSITION_SEED), poolState.toBuffer(), i32ToBeBytes(tickLowerIndex), i32ToBeBytes(tickUpperIndex)],
    programId
  );
  return address;
}
