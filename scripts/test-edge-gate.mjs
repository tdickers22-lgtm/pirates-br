#!/usr/bin/env node
/**
 * Edge-trigger smoke test — proves that the same input.seq applied N times only
 * fires the action ONCE. This is the pattern used in Match.consumeOneShot().
 *
 * Run: node scripts/test-edge-gate.mjs
 *
 * If anything below logs FAIL, the press-style input bug has regressed and the
 * server will start consuming items / firing actions every tick again.
 */

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

// Mirror Match.consumeOneShot exactly — keep this in sync.
function makeClient() {
  return {
    consumedSeq: {
      interact: -1,
      trade: -1,
      wheel: -1,
      reload: -1,
      jump: -1,
      placeKeg: -1,
      dropChest: -1,
      special: -1,
      barrelTakeAll: -1,
      cannonAmmo: -1,
      slot: -1,
    },
  };
}
function consumeOneShot(client, action, seq) {
  if (client.consumedSeq[action] === seq) return false;
  client.consumedSeq[action] = seq;
  return true;
}

console.log('Edge-trigger gate (Match.consumeOneShot)');

// Case 1: replayed input only consumes once.
{
  const c = makeClient();
  let consumed = 0;
  for (let tick = 0; tick < 60; tick++) {
    if (consumeOneShot(c, 'wheel', 42)) consumed += 1;
  }
  expect(
    'A single input.seq replayed for 60 ticks consumes wheel exactly once',
    consumed === 1,
    `consumed=${consumed} (expected 1)`,
  );
}

// Case 2: a fresh seq re-arms the gate.
{
  const c = makeClient();
  let consumed = 0;
  for (const seq of [10, 10, 10, 11, 11, 12]) {
    if (consumeOneShot(c, 'wheel', seq)) consumed += 1;
  }
  expect(
    'Each new seq fires once (10,10,10,11,11,12 → 3 consumes)',
    consumed === 3,
    `consumed=${consumed} (expected 3)`,
  );
}

// Case 3: actions are independent.
{
  const c = makeClient();
  const wheel = consumeOneShot(c, 'wheel', 7);
  const interact = consumeOneShot(c, 'interact', 7);
  const trade = consumeOneShot(c, 'trade', 7);
  const wheelDup = consumeOneShot(c, 'wheel', 7);
  expect(
    'Different actions on the same seq each fire once',
    wheel && interact && trade && !wheelDup,
    `wheel=${wheel} interact=${interact} trade=${trade} wheelDup=${wheelDup}`,
  );
}

// Case 4: monotonic-but-revisited seq does not duplicate.
{
  const c = makeClient();
  consumeOneShot(c, 'reload', 100);
  consumeOneShot(c, 'reload', 101);
  const replay = consumeOneShot(c, 'reload', 101);
  const newer = consumeOneShot(c, 'reload', 102);
  expect(
    'Replay of last-consumed seq returns false; next seq returns true',
    !replay && newer,
    `replay=${replay} newer=${newer}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} edge-gate assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll edge-gate assertions passed.');
