#!/usr/bin/env node
// THE GILDED WRECK + THE UNCHARTED SEA.
//
// The pacing audit's P1 was a mid-match engagement drought: a mean 7.5 crews
// still afloat at 360 s because nothing between ring shrinks pulls crews
// together. The fix is ONE dynamic convergence event — a half-sunk ghost
// galleon that rises at the ANNOUNCED next ring centre, carries loot worth
// fighting over, and is claimed by the storm at the end of the phase — plus
// four fixed uncharted micro-POIs so the dead water between islands pays a
// pirate for knowing it.
//
// This suite drives the REAL Match (no mocks) and pins:
//   1. she rises on schedule, at the announced next ring centre, and never on
//      dry land;
//   2. her loot is real, reachable and worth the sail — chests that bank and a
//      powder store that is ordnance only;
//   3. looting works through the ORDINARY paths (chest proximity → carry →
//      stow; barrel take-all), because that is the whole design;
//   4. she despawns on schedule and takes only what is still lying on her —
//      anything a crew got clear is theirs;
//   5. bots actually converge (that is the difference between an event and a
//      decoration);
//   6. the POIs are deterministic, in open water, and did not disturb one
//      metre of the fixed world.
//
//   node --import tsx scripts/test-wreck-event.mjs
import { Match } from '../src/server/core/Match.ts';
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { buildWireSnapshot } from '../src/server/core/snapshot.ts';
import { SERVER_TICK_MS, WRECK_EVENT, SEA_POI, WORLD } from '../src/shared/constants/index.ts';
import { getIslandSurfaceY, getIslandMaxRadius, dist2D } from '../src/shared/utils/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const DT = SERVER_TICK_MS / 1000;
function makeMatch(id, botCount = 9) {
  const match = new Match({ matchId: id, botCount });
  match.state.phase = 'playing';
  return match;
}
/** Collapse the CURRENT storm phase to a couple of seconds. The phase clock
 *  itself is pinned by the storm suites; here we only need the transition to
 *  actually happen, and simulating 400 real seconds per assertion is minutes of
 *  wall clock for nothing. */
function hurryStorm(match, seconds = 1) {
  const storm = match.state.storm;
  storm.shrinkTimer = seconds;
  storm.shrinkDuration = seconds;
}
/** Advance the real sim by `seconds` of ticks. */
function run(match, seconds) {
  const steps = Math.ceil(seconds / DT);
  for (let i = 0; i < steps; i++) match.tick();
}

// ══ 1. She rises on schedule, at the announced ring centre ══════════════════
console.log('The Gilded Wreck rises:');
{
  const match = makeMatch('wreck-rise');
  // Remember the centre the storm ANNOUNCES before the phase she spawns in.
  let announced = null;
  let phaseAtRise = -1;
  let riseTime = -1;
  // Real StormSystem, real ring transition — just not in real time.
  let shrinkingAtRise = false;
  for (let phase = 0; phase <= WRECK_EVENT.SPAWN_PHASE; phase++) hurryStorm(match, 1);
  const steps = Math.ceil(((WRECK_EVENT.SPAWN_PHASE * 2.5) + 8) / DT);
  for (let i = 0; i < steps; i++) {
    const before = { x: match.state.storm.nextCenterX, z: match.state.storm.nextCenterZ };
    const wasShrinking = match.state.storm.shrinking;
    match.tick();
    if (match.state.wreck && riseTime < 0) {
      announced = before;
      phaseAtRise = match.state.storm.phase;
      shrinkingAtRise = wasShrinking || match.state.storm.shrinking;
      riseTime = match.t;
      break;
    }
  }
  const wreck = match.state.wreck;
  expect('she rises inside the match, unprompted', !!wreck, `t=${match.t.toFixed(0)}s`);
  expect(`she rises as ring ${WRECK_EVENT.SPAWN_PHASE} starts to CLOSE, not on a wall-clock`,
    phaseAtRise === WRECK_EVENT.SPAWN_PHASE && shrinkingAtRise,
    `phase=${phaseAtRise} shrinking=${shrinkingAtRise}`);
  expect('and never before the ring moves — the opening is still peaceful',
    riseTime > 0, `t=${riseTime.toFixed(1)}s`);
  expect('she lands ON the announced next ring centre (or the nearest water to it)',
    !!wreck && !!announced && dist2D(wreck.position.x, wreck.position.z, announced.x, announced.z) < 300,
    wreck && announced
      ? `${dist2D(wreck.position.x, wreck.position.z, announced.x, announced.z).toFixed(0)}m off (${announced.x.toFixed(0)}, ${announced.z.toFixed(0)})`
      : 'no wreck');
  expect('she is afloat, not aground on an island',
    !!wreck && !match.state.islands.some((island) =>
      getIslandSurfaceY(island, wreck.position.x, wreck.position.z) > -2.0));
  expect('she is inside the world bounds',
    !!wreck && Math.hypot(wreck.position.x, wreck.position.z) < WORLD.HALF - 40);
  // Not merely off the beach: a shoal inside her length would have her rise
  // THROUGH the rock and leave her chests inside a collider that shoves a
  // boarding party straight back out — loot nobody can reach.
  expect('and not merged into a shoal — her length is clear of every sea rock',
    !!wreck && !match.state.seaRocks.some((rock) =>
      dist2D(rock.position.x, rock.position.z, wreck.position.x, wreck.position.z)
        < rock.colliderBoundsRadius + WRECK_EVENT.HULL_HALF_LENGTH),
    (() => {
      const r = wreck && match.state.seaRocks
        .map((k) => ({ k, gap: dist2D(k.position.x, k.position.z, wreck.position.x, wreck.position.z) - k.colliderBoundsRadius }))
        .sort((a, b) => a.gap - b.gap)[0];
      return r ? `nearest shoal edge ${r.gap.toFixed(1)}m off her centre` : 'no wreck';
    })());
  expect('she is on a clock, one storm phase long',
    !!wreck && Math.abs(wreck.claimAt - wreck.spawnedAt - WRECK_EVENT.LOOT_SECONDS) < 1e-6);
  expect('she rises exactly once — a second phase change does not raise a second hull',
    (() => {
      const seen = wreck?.id;
      run(match, 5);
      return match.state.wreck?.id === seen;
    })());
  match.stop();
}

// ══ 2. The hoard ═══════════════════════════════════════════════════════════
console.log('\nHer cargo:');
{
  const match = makeMatch('wreck-loot');
  const wreck = match.forceRaiseGildedWreck();
  const host = match.state.islands.find((island) => island.id === wreck.hostIslandId);
  const chests = wreck.chestIds.map((id) => host.chests.find((c) => c.id === id)).filter(Boolean);
  const barrels = wreck.barrelIds.map((id) => host.barrels.find((b) => b.id === id)).filter(Boolean);

  // THE PRIZE. Her contract changed when the pacing instrumentation showed the
  // fleet converging on her and leaving without a fight: three equal chests
  // split nine crews into three winners and six shrugs, and nobody contests a
  // buffet. She now carries her ordinary chests PLUS one indivisible strongbox
  // worth more than all of them, and it is the first id she offers.
  const strongbox = chests.find((c) => c.id === WRECK_EVENT.STRONGBOX_ID);
  const plain = chests.filter((c) => c.id !== WRECK_EVENT.STRONGBOX_ID);
  expect(`${WRECK_EVENT.CHESTS} chests and the Gilded Strongbox are aboard and reachable`,
    chests.length === WRECK_EVENT.CHESTS + 1 && !!strongbox, `${chests.length}`);
  expect('the strongbox is the first thing she offers — the prize, not a prize',
    wreck.chestIds[0] === WRECK_EVENT.STRONGBOX_ID, wreck.chestIds.join(','));
  expect('and it is worth more than every other chest on her put together',
    !!strongbox && strongbox.value === WRECK_EVENT.STRONGBOX_VALUE
      && strongbox.value > plain.reduce((sum, c) => sum + c.value, 0),
    `${strongbox?.value} vs ${plain.reduce((sum, c) => sum + c.value, 0)}`);
  expect(`${WRECK_EVENT.BARRELS} supply barrels are aboard`,
    barrels.length === WRECK_EVENT.BARRELS, `${barrels.length}`);
  expect('her ordinary chests are worth banking (richer than an island chest)',
    plain.every((c) => c.value >= WRECK_EVENT.CHEST_VALUE_MIN && c.value <= WRECK_EVENT.CHEST_VALUE_MAX),
    plain.map((c) => c.value).join(','));
  expect('her chests are FLOATING, not buried — you swim them off her',
    chests.every((c) => c.floating && !c.buried && c.digProgress >= 1));
  expect('her cargo lies ON her, not scattered across the sea',
    [...chests, ...barrels].every((e) =>
      dist2D(e.position.x, e.position.z, wreck.position.x, wreck.position.z)
        < WRECK_EVENT.HULL_HALF_LENGTH * 1.6));
  const supplies = barrels.flatMap((b) => b.loot.map((s) => s.item));
  expect('the powder store is ordnance and coin only — no fruit, no planks',
    supplies.length > 0 && supplies.every((item) =>
      item === 'gold' || item === 'cannonball' || item === 'firebomb_ball'
      || item === 'chainshot' || item.endsWith('_ammo')),
    supplies.join(','));
  match.stop();
}

// ══ 3. Looting her works through the ORDINARY paths ════════════════════════
console.log('\nLooting her:');
{
  const match = makeMatch('wreck-take');
  const wreck = match.forceRaiseGildedWreck();
  const host = match.state.islands.find((island) => island.id === wreck.hostIslandId);
  const chest = host.chests.find((c) => c.id === wreck.chestIds[0]);
  const barrel = host.barrels.find((b) => b.id === wreck.barrelIds[0]);

  // Clear her water of hulls first. She rises at the announced ring centre,
  // which now and then is exactly where a crew happens to be floating, and a
  // swimmer dropped inside a hull is (correctly) shoved clear of it — measured
  // at 2-11 m, well past INTERACT_RANGE. That is swimmer-vs-hull collision
  // doing its job, and it has nothing to say about the chest path this section
  // is here to pin, so sail the traffic out of her berth before boarding.
  for (const s of match.state.ships) {
    if (dist2D(s.position.x, s.position.z, wreck.position.x, wreck.position.z) < 90) {
      s.position.x += 600;
    }
  }

  // Put a pirate in the water alongside her, the way a boarding party arrives.
  const pirate = match.state.players.find((p) => p.isBot);
  pirate.position = { x: chest.position.x, y: 0.4, z: chest.position.z };
  pirate.state = 'swimming';
  pirate.onShipId = null;
  pirate.carryingChestId = null;

  // PhysicsSystem owns proximity — one real tick has to be enough to see her.
  match.tick();
  expect('a swimmer alongside is offered her chest by the ordinary chest path',
    pirate.nearChestId === chest.id, `nearChestId=${pirate.nearChestId}`);

  const taken = match.tryTakeChest(pirate);
  expect('the chest lifts off her', !!taken && pirate.carryingChestId === chest.id);
  expect('carrying it clears its floating state (it is on a shoulder now)', !chest.floating);

  // And the powder store, through the take-all barrel path.
  pirate.position = { x: barrel.position.x, y: 0.4, z: barrel.position.z };
  match.tick();
  expect('a swimmer alongside is offered her supply barrel',
    pirate.nearBarrelId === barrel.id, `nearBarrelId=${pirate.nearBarrelId}`);
  const before = pirate.gold;
  const beforeAmmo = JSON.stringify(pirate.weapons.map((w) => w?.reserve ?? null));
  const event = match.islands.tryTakeAllFromNearbyBarrel(pirate, match.state.islands, match.state.ships);
  expect('take-all empties her powder store into the boarding party',
    !!event && event.taken && barrel.loot.length === 0);
  expect('and something actually landed (coin or shot)',
    pirate.gold > before || JSON.stringify(pirate.weapons.map((w) => w?.reserve ?? null)) !== beforeAmmo
    || match.state.ships.some((s) => s.inventory.length > 0));
  match.stop();
}

// ══ 4. The storm takes her back, and only what is still on her ═════════════
console.log('\nThe storm claims her:');
{
  // Two crews and a short clock: this is about WHAT the sea takes, not about
  // what nine bot crews got up to for two and a half minutes first.
  const match = makeMatch('wreck-claim', 2);
  const wreck = match.forceRaiseGildedWreck();
  const host = match.state.islands.find((island) => island.id === wreck.hostIslandId);
  const islandChestsBefore = host.chests.length - wreck.chestIds.length;

  // One chest gets carried clear before the sea closes.
  const rescued = host.chests.find((c) => c.id === wreck.chestIds[0]);
  const pirate = match.state.players.find((p) => p.isBot);
  rescued.carriedByPlayerId = pirate.id;
  rescued.floating = false;
  pirate.carryingChestId = rescued.id;
  // A second chest is dragged clear of her and left in the water — also saved.
  const dragged = host.chests.find((c) => c.id === wreck.chestIds[1]);
  dragged.position.x = wreck.position.x + 400;

  const wreckId = wreck.id;
  match.state.wreck.claimAt = match.t + 0.2;
  run(match, 1.5);

  expect('she is gone when her phase runs out', !match.state.wreck, `${match.state.wreck?.id ?? 'null'}`);
  expect('the storm took the cargo still lying on her',
    !host.chests.some((c) => wreck.chestIds.includes(c.id) && c.id !== rescued.id && c.id !== dragged.id)
    && !host.barrels.some((b) => wreck.barrelIds.includes(b.id)));
  expect('what a crew got clear is theirs — the chest on a shoulder survives her',
    (() => {
      const kept = host.chests.find((c) => c.id === rescued.id);
      // Still in the crew's hands: on the shoulder, or already stowed in the hold
      // (a bot carrying treasure onto its own deck stows it, which is the point).
      return !!kept && (kept.carriedByPlayerId === pirate.id || !!kept.storedOnShipId);
    })());
  expect('and so does a chest dragged out of her reach',
    host.chests.some((c) => c.id === dragged.id));
  expect('the island she was filed on is otherwise untouched',
    host.chests.filter((c) => !wreck.chestIds.includes(c.id)).length === islandChestsBefore);
  expect('and she never comes back',
    (() => { run(match, 8); return !match.state.wreck && !!wreckId; })());
  match.stop();
}

// ══ 5. Bots converge on her ════════════════════════════════════════════════
console.log('\nCrews converge:');
{
  const match = makeMatch('wreck-converge');
  // Let the lobby settle into its normal spread first.
  run(match, 25);
  const wreck = match.forceRaiseGildedWreck();
  const spread = () => {
    const live = match.state.ships.filter((s) => s.alive && !s.sinking);
    return live.reduce((sum, s) => sum + dist2D(s.position.x, s.position.z, wreck.position.x, wreck.position.z), 0)
      / Math.max(1, live.length);
  };
  const before = spread();
  // Sail her ACTUAL loot window, not a 60 s slice of it. The lobby settles
  // 450-700 m out and a sloop crosses that in minutes, so at t+60 s whether
  // anyone had reached boarding water was a lottery on the starting spread
  // (measured: 2 runs in 6 still outside 220 m at 60 s, all 6 well inside by
  // the end of her life). She is up for LOOT_SECONDS; judge her over it.
  const SAIL = Math.min(150, WRECK_EVENT.LOOT_SECONDS - 20);
  // Closest APPROACH, not distance at one instant: a crew that comes alongside,
  // takes her chests and sails on has answered the question, and should not be
  // failed for having a bow pointed away when the clock stops.
  let closest = Infinity;
  for (let i = 0, steps = Math.ceil(SAIL / DT); i < steps; i++) {
    match.tick();
    if (i % 25) continue;                      // sample ~2.5x/s, not every tick
    for (const s of match.state.ships) {
      if (!s.alive) continue;
      const d = dist2D(s.position.x, s.position.z, wreck.position.x, wreck.position.z);
      if (d < closest) closest = d;
    }
  }
  const after = spread();
  console.log(`  mean crew distance to her: ${before.toFixed(0)}m → ${after.toFixed(0)}m`
    + `  (closest approach ${closest.toFixed(0)}m)`);
  expect('the fleet closes on her rather than drifting away', after < before,
    `${before.toFixed(0)} → ${after.toFixed(0)}`);
  expect('at least one crew comes inside boarding water of her', closest < 220,
    `closest approach ${closest.toFixed(0)}m over ${SAIL}s`);
  match.stop();
}

// ══ 5b. …and CONVERT: her deck is stripped and the prize is hunted ═════════
//
// Converging was never the problem. Six instrumented matches had crews closing
// from 600 m to a 390 m mean with a 26-96 m closest approach in 6/6 — and then
// looting nothing (four chests still on her deck at every storm claim), fighting
// nobody, and drifting off. An event that only gathers people is scenery. This
// pins the two links that turn the gathering into a fight: bot crews take her
// loot, and the hull that ends up with the strongbox is cried and hunted.
console.log('\nCrews convert:');
{
  const match = makeMatch('wreck-convert');
  run(match, 25);
  const wreck = match.forceRaiseGildedWreck();
  const host = match.state.islands.find((island) => island.id === wreck.hostIslandId);

  let everTaken = 0;
  let prizeHull = null;
  let huntersOnPrize = 0;
  const SAIL = Math.min(150, WRECK_EVENT.LOOT_SECONDS - 20);
  for (let i = 0, steps = Math.ceil(SAIL / DT); i < steps; i++) {
    match.tick();
    if (i % 25) continue;
    const held = wreck.chestIds.filter((id) => {
      const c = host.chests.find((ch) => ch.id === id);
      return !!c && (c.carriedByPlayerId || c.storedOnShipId);
    }).length;
    if (held > everTaken) everTaken = held;
    const box = host.chests.find((c) => c.id === WRECK_EVENT.STRONGBOX_ID);
    const holderShipId = box?.storedOnShipId
      ?? (box?.carriedByPlayerId
        ? match.state.players.find((p) => p.id === box.carriedByPlayerId)?.shipId
        : null);
    if (!holderShipId) continue;
    prizeHull = match.state.ships.find((s) => s.id === holderShipId) ?? prizeHull;
    let hunters = 0;
    for (const bot of match.bots.bots.values()) {
      if (bot.shipId !== holderShipId && bot.behavior === 'engage' && bot.targetShipId === holderShipId) hunters += 1;
    }
    if (hunters > huntersOnPrize) huntersOnPrize = hunters;
  }
  console.log(`  chests off her: ${everTaken}  ·  hunters on the prize: ${huntersOnPrize}`);
  expect('bot crews actually STRIP her — the loot moves', everTaken > 0, `${everTaken} taken`);
  expect('and the crew holding the strongbox is cried on every chart',
    !prizeHull || prizeHull.bountied === true, `bountied=${prizeHull?.bountied}`);
  expect('the prize is hunted — a carried strongbox drags the fight with it',
    !prizeHull || huntersOnPrize > 0, `${huntersOnPrize} hunters`);
  match.stop();
}

// ══ 6. The uncharted sea ═══════════════════════════════════════════════════
console.log('\nSea micro-POIs:');
{
  const a = new MapGenerator(12345);
  const aIslands = a.generateIslands();
  const aPois = a.generateSeaPois(aIslands);
  a.attachSeaPoiLoot(aPois, aIslands);

  const b = new MapGenerator(99999);
  const bIslands = b.generateIslands();
  const bPois = b.generateSeaPois(bIslands);
  b.attachSeaPoiLoot(bPois, bIslands);

  expect(`${SEA_POI.COUNT} sites exist`, aPois.length === SEA_POI.COUNT, `${aPois.length}`);
  expect('every kind is represented (cluster, flotsam, lone mast)',
    new Set(aPois.map((p) => p.kind)).size === 3, aPois.map((p) => p.kind).join(','));
  expect('sites are identical across match seeds (uncharted, but LEARNABLE)',
    JSON.stringify(aPois) === JSON.stringify(bPois));
  expect('every site sits in genuine dead water (≥170m from any coast)',
    aPois.every((poi) => aIslands.every((island) =>
      Math.hypot(poi.position.x - island.position.x, poi.position.z - island.position.z)
        - getIslandMaxRadius(island) >= 170)));
  const barrels = aPois.flatMap((p) => p.barrelIds);
  expect('the floating sites carry lootable barrels', barrels.length >= 3, `${barrels.length}`);
  expect('every POI barrel is filed on a real island and sits at the waterline',
    barrels.every((id) => {
      const barrel = aIslands.flatMap((i) => i.barrels).find((entry) => entry.id === id);
      return !!barrel && barrel.position.y > 0 && barrel.position.y < 1.4 && barrel.loot.length > 0;
    }));
  expect('the lone mast stands on a REAL shoal (a sea rock with colliders)',
    (() => {
      const spawns = a.generateShipSpawns(aIslands);
      const rocks = a.generateSeaRocks(aIslands, spawns, aPois);
      const mast = aPois.find((p) => p.kind === 'shoal_mast');
      const shoal = rocks.find((r) => r.id === `${mast.id}-shoal`);
      return !!shoal && shoal.colliders.length > 0
        && dist2D(shoal.position.x, shoal.position.z, mast.position.x, mast.position.z) < 1e-6;
    })());

  // The fixed world must not have moved by a metre.
  const bare = new MapGenerator(12345);
  const bareIslands = bare.generateIslands();
  const signature = (islands) => JSON.stringify(islands.map((i) => ({
    id: i.id, pos: i.position, props: i.props?.length ?? 0, chests: i.chests.length,
  })));
  expect('seeding the POIs left every island placement bit-identical',
    signature(bareIslands) === signature(aIslands.map((i) => ({ ...i, barrels: [] }))));
}

// ══ 7. Wire budget ═════════════════════════════════════════════════════════
console.log('\nWire:');
{
  const match = makeMatch('wreck-wire');
  run(match, 4);
  match.forceRaiseGildedWreck();
  const full = JSON.stringify(buildWireSnapshot(match.buildSnapshot(false), false));
  console.log(`  full snapshot with the wreck up: ${(full.length / 1024).toFixed(1)}KB`);
  expect('a live wreck + four POIs still fit the 35KB full-snapshot budget',
    full.length < 35 * 1024, `${full.length}B`);
  expect('the wreck rides every full snapshot (the beacon cannot wait 19s)',
    full.includes('"wreck"'));
  match.stop();
}

console.log(failures === 0
  ? '\nThe Gilded Wreck rises, pays, and sinks on time.'
  : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
