import assert from "node:assert/strict";

const REPOSITION_BUFFER_BPS = parseInt(process.env.LP_REPOSITION_BUFFER_BPS || "1000");
const BPS_DENOM = 10_000;

function computeLpRepositionDecision(vault, tickCurrent) {
  const rangeWidth = vault.tickUpperIndex - vault.tickLowerIndex;
  if (rangeWidth <= 0) {
    throw new Error(`Invalid LP vault range: tickLowerIndex (${vault.tickLowerIndex}) >= tickUpperIndex (${vault.tickUpperIndex})`);
  }
  if (vault.tickSpacing <= 0) {
    throw new Error(`Invalid tickSpacing: ${vault.tickSpacing}`);
  }

  const align = (t) => Math.round(t / vault.tickSpacing) * vault.tickSpacing;
  const halfWidth = Math.floor(rangeWidth / 2);
  const newTickLowerIndex = align(tickCurrent - halfWidth);
  const newTickUpperIndex = align(tickCurrent + halfWidth);

  if (!vault.positionActive) {
    return { shouldReposition: false, reason: "no active position", newTickLowerIndex, newTickUpperIndex };
  }

  const buffer = Math.floor((rangeWidth * REPOSITION_BUFFER_BPS) / BPS_DENOM);
  const outOfRange = tickCurrent < vault.tickLowerIndex || tickCurrent > vault.tickUpperIndex;
  const nearEdge = !outOfRange && (
    tickCurrent < vault.tickLowerIndex + buffer || tickCurrent > vault.tickUpperIndex - buffer
  );
  const shouldReposition = outOfRange || nearEdge;

  return { shouldReposition, reason: outOfRange ? "out of range" : nearEdge ? "near edge" : "in range", newTickLowerIndex, newTickUpperIndex };
}

let passed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL: ${name}`);
    console.log(`  ${e.message}`);
    process.exitCode = 1;
  }
}

const baseVault = { tickLowerIndex: -1000, tickUpperIndex: 1000, tickSpacing: 4, positionActive: true };

check("price comfortably in range -> no reposition", () => {
  const d = computeLpRepositionDecision(baseVault, 0);
  assert.equal(d.shouldReposition, false);
  assert.equal(d.reason, "in range");
});

check("price exactly at lower edge (boundary, inclusive) -> in-range boundary case handled without throwing", () => {
  const d = computeLpRepositionDecision(baseVault, -1000);
  // tickCurrent === tickLowerIndex: not < tickLowerIndex, so not "outOfRange"
  // by the strict-inequality definition; but well within the 10% buffer
  // zone, so nearEdge should trigger.
  assert.equal(d.shouldReposition, true);
  assert.equal(d.reason, "near edge");
});

check("price outside range (below) -> reposition, out of range", () => {
  const d = computeLpRepositionDecision(baseVault, -1500);
  assert.equal(d.shouldReposition, true);
  assert.equal(d.reason, "out of range");
});

check("price outside range (above) -> reposition, out of range", () => {
  const d = computeLpRepositionDecision(baseVault, 1500);
  assert.equal(d.shouldReposition, true);
  assert.equal(d.reason, "out of range");
});

check("price near edge within buffer (10% of 2000-wide range = 200) -> reposition, near edge", () => {
  // upper edge at 1000, buffer 200 -> anything >= 800 should trigger
  const d = computeLpRepositionDecision(baseVault, 850);
  assert.equal(d.shouldReposition, true);
  assert.equal(d.reason, "near edge");
});

check("price just outside the buffer zone -> no reposition", () => {
  // upper edge at 1000, buffer 200 -> 799 should NOT trigger (799 < 800)
  const d = computeLpRepositionDecision(baseVault, 799);
  assert.equal(d.shouldReposition, false);
});

check("inactive position -> never reposition regardless of price", () => {
  const inactiveVault = { ...baseVault, positionActive: false };
  const d = computeLpRepositionDecision(inactiveVault, 99999); // wildly out of range
  assert.equal(d.shouldReposition, false);
  assert.equal(d.reason, "no active position");
});

check("suggested new range preserves width and re-centers on current tick, aligned to tick spacing", () => {
  const d = computeLpRepositionDecision(baseVault, -1500);
  const oldWidth = baseVault.tickUpperIndex - baseVault.tickLowerIndex;
  const newWidth = d.newTickUpperIndex - d.newTickLowerIndex;
  assert.equal(newWidth, oldWidth, "range width should be preserved");
  assert.equal(Math.abs(d.newTickLowerIndex % baseVault.tickSpacing), 0, "new lower tick must be spacing-aligned");
  assert.equal(Math.abs(d.newTickUpperIndex % baseVault.tickSpacing), 0, "new upper tick must be spacing-aligned");
  // re-centered near -1500 (within half a tick-spacing unit of rounding)
  const center = (d.newTickLowerIndex + d.newTickUpperIndex) / 2;
  assert.ok(Math.abs(center - (-1500)) <= baseVault.tickSpacing, `center ${center} should be close to -1500`);
});

check("invalid range (lower >= upper) throws instead of silently misbehaving", () => {
  assert.throws(() => computeLpRepositionDecision({ tickLowerIndex: 100, tickUpperIndex: 100, tickSpacing: 4, positionActive: true }, 50));
});

check("invalid tickSpacing throws", () => {
  assert.throws(() => computeLpRepositionDecision({ tickLowerIndex: -100, tickUpperIndex: 100, tickSpacing: 0, positionActive: true }, 0));
});

console.log(`\n${passed} check(s) passed.`);
