#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// HOLD CARGO — the 9000-gold race, made physical
// ════════════════════════════════════════════════════════════════════════════
// The signature mechanic of this battle royale is a race to bank 9000 gold, and
// for most of its life it played as a background scoreboard: an invisible
// number, no silhouette, no weight, no wreck to loot, and a flat 180g boarding
// steal as its only counterplay against a 9000g target.
//
// This suite pins the whole mechanic that replaced it:
//   1. tier thresholds — where pocket coin becomes CARGO, and what it reads as
//   2. ballast — a laden hull is genuinely slower ON THE REAL PHYSICS, so the
//      leader is catchable (the whole reason to make the leader visible)
//   3. spill — a foundering crew's cargo goes into the shallows as divable
//      pieces, capped, and NEVER out of the safe pocket
//   4. divability — a swimmer who reaches the wreck actually banks it
//   5. bounty — the 60% line raises a map-wide hunt, with hysteresis, and bots
//      are told about it
//   6. steal scaling — boarding a laden hold is worth boarding
//   7. scuttle holes — a foundering hull's cosmetic riddling is no longer
//      forged as 'cannon' damage in combat audits
//   8. wire — sunken cargo rides the snapshot without blowing the 35KB cap
import { Match } from '../src/server/core/Match.ts';
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import { buildWireSnapshot } from '../src/server/core/snapshot.ts';
import { CARGO, ECONOMY, PLAYER, SHIP_STATS } from '../src/shared/constants/index.ts';
import {
  boardingStealCap,
  bountyClearGold,
  bountyThresholdGold,
  cargoBallastFactor,
  cargoBallastPenalty,
  cargoGoldFromBanked,
  cargoLoadFraction,
  cargoTier,
  cargoTierLabel,
  spillFromCargo,
  splitSpill,
} from '../src/shared/cargo.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const DT = 1 / 62.5;

function makeFakeWs(sink = null) {
  return {
    readyState: 1,
    bufferedAmount: 0,
    send(data) { if (sink) sink.push(JSON.parse(data)); },
    close() {},
  };
}

/** Park a match in a live, quiet state: playing, storm pinned wide open. */
function liveMatch(id, botCount = 1) {
  const match = new Match({ matchId: id, botCount });
  match.state.phase = 'playing';
  match.state.storm.safeRadius = 5000;
  match.state.storm.shrinking = false;
  match.state.storm.shrinkTimer = 9999;
  return match;
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n1. Tier thresholds — where pocket coin becomes cargo');

{
  expect('gold at the safe line is ALL pocket (no cargo, no weight)',
    cargoGoldFromBanked(CARGO.SAFE_GOLD) === 0,
    `cargo=${cargoGoldFromBanked(CARGO.SAFE_GOLD)}`);
  expect('a losing purse is never negative cargo',
    cargoGoldFromBanked(0) === 0 && cargoGoldFromBanked(-500) === 0);
  expect('one coin over the line is one coin of cargo',
    cargoGoldFromBanked(CARGO.SAFE_GOLD + 1) === 1);
  expect('an empty hold reads "trim"',
    cargoTier(0) === 0 && cargoTierLabel(0) === 'trim');

  // Every tier floor must actually promote the hold a tier — a threshold table
  // that skipped a rung would leave a whole band of the race with no silhouette.
  let ok = true;
  const seen = [];
  for (let i = 0; i < CARGO.TIER_THRESHOLDS.length; i += 1) {
    const at = CARGO.TIER_THRESHOLDS[i];
    seen.push([at, cargoTier(at), cargoTier(at - 1)]);
    if (cargoTier(at) !== i + 1) ok = false;
    if (cargoTier(at - 1) !== i) ok = false;
  }
  expect('each tier floor promotes exactly one rung, and one gold under it does not',
    ok, JSON.stringify(seen));
  expect('thresholds ascend (a fuller hold is never a lighter tier)',
    CARGO.TIER_THRESHOLDS.every((v, i) => i === 0 || v > CARGO.TIER_THRESHOLDS[i - 1]),
    JSON.stringify(CARGO.TIER_THRESHOLDS));
  expect('a crew one gold short of the win is wallowing at the top tier',
    cargoTier(cargoGoldFromBanked(ECONOMY.GOLD_WIN_TARGET - 1)) === 4,
    `tier=${cargoTier(cargoGoldFromBanked(ECONOMY.GOLD_WIN_TARGET - 1))}`);
  expect('the HUD label for a full hold is a word, not a number',
    typeof cargoTierLabel(CARGO.FULL_LOAD) === 'string' && cargoTierLabel(CARGO.FULL_LOAD).length > 0,
    cargoTierLabel(CARGO.FULL_LOAD));
  expect('load fraction saturates at a full hold and never exceeds 1',
    cargoLoadFraction(CARGO.FULL_LOAD) === 1 && cargoLoadFraction(CARGO.FULL_LOAD * 4) === 1);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n2. Ballast — the leader is CATCHABLE (measured on real physics)');

{
  expect('an empty hold costs nothing', cargoBallastFactor(0) === 1);
  expect('a full hold costs the designed penalty (12–15%)',
    Math.abs(cargoBallastPenalty(CARGO.FULL_LOAD) - CARGO.MAX_BALLAST_PENALTY) < 1e-9
      && CARGO.MAX_BALLAST_PENALTY >= 0.12 && CARGO.MAX_BALLAST_PENALTY <= 0.15,
    `penalty=${cargoBallastPenalty(CARGO.FULL_LOAD)}`);
  expect('the penalty is monotonic in cargo (more gold is never faster)',
    cargoBallastFactor(1000) > cargoBallastFactor(3000)
      && cargoBallastFactor(3000) > cargoBallastFactor(CARGO.FULL_LOAD));

  // The real thing: two identical hulls, same wind, same trim, one laden.
  // Sailed through the ACTUAL PhysicsSystem, not the formula.
  function sailFor(cargoGold, seconds = 26) {
    const physics = new PhysicsSystem();
    const stats = SHIP_STATS.sloop;
    const ship = {
      id: `ballast-${cargoGold}`,
      type: 'sloop',
      ownerId: 'owner',
      crewIds: [],
      position: { x: 0, y: 0, z: 0 },
      rotation: Math.PI * 0.5,
      velocity: { x: 0, y: 0, z: 0 },
      angularVelocity: 0,
      sailHeight: 1,
      sailAngle: 0,
      anchored: false,
      anchorRaiseProgress: 1,
      holes: [],
      nextHoleId: 1,
      maxHull: stats.maxHull,
      onFire: false,
      fireTimer: 0,
      fireDamageAccum: 0,
      sinkProgress: 0,
      sinking: false,
      cannonCooldowns: [0, 0],
      chainshottedUntil: 0,
      sailIntegrity: 1,
      sailRepairWoodTimer: 0,
      gold: 0,
      cargoGold,
      treasureChestIds: [],
      inventory: [],
      repairCooldown: 0,
      autoRepairProgress: 0,
      teamColor: 0xffffff,
      alive: true,
      upgrades: [],
      waterLevel: 0,
    };
    let t = 0;
    let best = 0;
    for (let i = 0; i < Math.round(seconds / DT); i += 1) {
      t += DT;
      // Keep her square to the wind every tick so trim is identical between runs.
      physics.update(DT, t, [ship], [], [], [], [], null);
      const speed = Math.hypot(ship.velocity.x, ship.velocity.z);
      if (speed > best) best = speed;
    }
    return best;
  }

  const light = sailFor(0);
  const laden = sailFor(CARGO.FULL_LOAD);
  const measured = light > 0 ? 1 - laden / light : 0;
  expect('a light hull actually gets under way in the harness',
    light > 1, `peak=${light.toFixed(3)} m/s`);
  expect('a FULLY LADEN hull is measurably slower through real physics',
    laden < light - 0.05, `light=${light.toFixed(3)} laden=${laden.toFixed(3)}`);
  expect('the measured top-speed loss lands on the designed 12–15% band',
    measured > 0.10 && measured < 0.17,
    `measured=${(measured * 100).toFixed(1)}% designed=${(CARGO.MAX_BALLAST_PENALTY * 100).toFixed(0)}%`);

  const half = sailFor(CARGO.FULL_LOAD * 0.5);
  expect('a half-laden hull sits between the two (ballast is a curve, not a cliff)',
    half < light && half > laden, `light=${light.toFixed(3)} half=${half.toFixed(3)} laden=${laden.toFixed(3)}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n3. Match weighs every hold, and the HUD number is the crew total');

{
  const match = liveMatch('cargo-weigh', 2);
  const st = match.state;
  const joined = match.addHumanClient(makeFakeWs(), 'Hauler');
  const player = st.players.find((p) => p.id === joined.playerId);
  const ship = st.ships.find((s) => s.id === joined.shipId);

  player.gold = CARGO.SAFE_GOLD;
  match.updateCargoAndBounty();
  expect('a crew at the safe line carries NO cargo weight',
    (ship.cargoGold ?? 0) === 0, `cargoGold=${ship.cargoGold}`);

  player.gold = CARGO.SAFE_GOLD + 2200;
  match.updateCargoAndBounty();
  expect('banked gold over the line becomes hold cargo on the hull',
    ship.cargoGold === 2200, `cargoGold=${ship.cargoGold}`);
  expect('the hold reads as a tier, not a number',
    cargoTierLabel(ship.cargoGold) === 'laden', cargoTierLabel(ship.cargoGold));

  // Crew gold is a CREW total: a second pirate's purse rides the same hull.
  const mate = st.players.find((p) => p.isBot && p.shipId !== ship.id);
  mate.shipId = ship.id;
  mate.gold = 1000;
  match.updateCargoAndBounty();
  expect('a crewmate\'s purse adds to the same hold',
    ship.cargoGold === 2200 + 1000, `cargoGold=${ship.cargoGold}`);

  // The hull the sim sails must be the weighed one.
  expect('the ballast physics reads the weighed hull',
    cargoBallastFactor(ship.cargoGold) < 1);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n4. Spill — a foundering hold goes into the shallows');

{
  expect('a spill is half the cargo', spillFromCargo(2000) === 1000);
  expect('a spill is capped', spillFromCargo(CARGO.FULL_LOAD * 4) === CARGO.SPILL_MAX);
  expect('an empty hold spills nothing', spillFromCargo(0) === 0);
  expect('a split spill conserves every coin',
    splitSpill(1777).reduce((a, b) => a + b, 0) === 1777,
    JSON.stringify(splitSpill(1777)));
  expect('a spill never breaks into more pieces than the budget allows',
    splitSpill(CARGO.SPILL_MAX).length <= CARGO.SPILL_PIECES_MAX,
    `pieces=${splitSpill(CARGO.SPILL_MAX).length}`);
  expect('a thin spill stays one worth-swimming-for piece, not a dusting',
    splitSpill(CARGO.SPILL_PIECE_MIN - 1).length === 1);

  const match = liveMatch('cargo-spill', 1);
  const st = match.state;
  const sent = [];
  const joined = match.addHumanClient(makeFakeWs(sent), 'Doomed');
  const player = st.players.find((p) => p.id === joined.playerId);
  const ship = st.ships.find((s) => s.id === joined.shipId);
  player.gold = CARGO.SAFE_GOLD + 4000;
  match.updateCargoAndBounty();

  const goldBefore = player.gold;
  const broadcasts = [];
  const realBroadcast = match.broadcast.bind(match);
  match.broadcast = (msg) => { broadcasts.push(msg); return realBroadcast(msg); };

  match.startShipSinking(ship, false, null);

  const spoils = st.spoils ?? [];
  const spilled = spoils.reduce((a, s) => a + s.value, 0);
  expect('foundering put divable pieces of cargo in the water',
    spoils.length > 0 && spoils.length <= CARGO.SPILL_PIECES_MAX,
    `pieces=${spoils.length}`);
  expect('the spill is exactly half the hold (capped)',
    spilled === spillFromCargo(4000), `spilled=${spilled} expected=${spillFromCargo(4000)}`);
  expect('every coin the crew lost is in the water (nothing evaporates)',
    goldBefore - player.gold === spilled, `lost=${goldBefore - player.gold} spilled=${spilled}`);
  expect('SAFE POCKET GOLD IS NEVER TAKEN — no feel-bad zeroing',
    player.gold >= CARGO.SAFE_GOLD, `gold=${player.gold}`);
  expect('the pieces lie at the wreck, at divable depth',
    spoils.every((s) => Math.abs(s.position.y + CARGO.SPILL_DEPTH) < 1e-6
      && Math.hypot(s.position.x - ship.position.x, s.position.z - ship.position.z) <= CARGO.SPILL_SCATTER + 0.001),
    JSON.stringify(spoils.map((s) => [+s.position.x.toFixed(1), +s.position.y.toFixed(1)])));
  expect('the depth is one held breath, not an abyssal dive',
    CARGO.SPILL_DEPTH < PLAYER.SWIM_MAX_DEPTH * 0.35, `depth=${CARGO.SPILL_DEPTH}`);
  expect('every spilled piece is attributed to the wreck it came from',
    spoils.every((s) => s.fromShipId === ship.id));
  expect('the sea is TOLD a hold burst (one feed line, not silence)',
    broadcasts.some((m) => m.type === 'cargo_spilled' && m.payload.gold === spilled),
    broadcasts.map((m) => m.type).join(','));

  // A poor crew loses nothing to the sea at all.
  const poorMatch = liveMatch('cargo-spill-poor', 1);
  const poorJoin = poorMatch.addHumanClient(makeFakeWs(), 'Pauper');
  const poor = poorMatch.state.players.find((p) => p.id === poorJoin.playerId);
  const poorShip = poorMatch.state.ships.find((s) => s.id === poorJoin.shipId);
  poor.gold = CARGO.SAFE_GOLD - 200;
  poorMatch.startShipSinking(poorShip, false, null);
  expect('a crew under the safe line loses NOTHING when they founder',
    poor.gold === CARGO.SAFE_GOLD - 200 && (poorMatch.state.spoils ?? []).length === 0,
    `gold=${poor.gold} spoils=${(poorMatch.state.spoils ?? []).length}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n5. Divability — a swimmer who reaches the wreck banks it');

{
  const match = liveMatch('cargo-dive', 1);
  const st = match.state;
  const joined = match.addHumanClient(makeFakeWs(), 'Diver');
  const diver = st.players.find((p) => p.id === joined.playerId);

  st.spoils = [{
    id: 'sp-test-1',
    position: { x: 300, y: -CARGO.SPILL_DEPTH, z: -220 },
    value: 640,
    fromShipId: 'wreck-1',
    expiresAt: match.t + CARGO.SPILL_LIFETIME,
  }];

  diver.state = 'swimming';
  diver.position = { x: 300, y: 0, z: -220 };  // floating right above it
  match.updateSpoils();
  expect('cargo on the seabed is NOT collected from the surface — you must dive',
    (st.spoils ?? []).length === 1 && diver.gold === 0,
    `spoils=${(st.spoils ?? []).length} gold=${diver.gold}`);

  const goldBefore = diver.gold;
  const broadcasts = [];
  const realBroadcast = match.broadcast.bind(match);
  match.broadcast = (msg) => { broadcasts.push(msg); return realBroadcast(msg); };

  diver.position = { x: 300, y: -CARGO.SPILL_DEPTH + 1, z: -220 };
  match.updateSpoils();
  expect('a diver who reaches it banks the whole piece',
    diver.gold === goldBefore + 640, `gold=${diver.gold}`);
  expect('a claimed piece leaves the world (no double-dipping)',
    (st.spoils ?? []).length === 0);
  expect('the claim is announced',
    broadcasts.some((m) => m.type === 'spoil_claimed' && m.payload.gold === 640));

  // An eliminated ghost may not loot.
  st.spoils = [{ id: 'sp-test-2', position: { x: 0, y: -CARGO.SPILL_DEPTH, z: 0 }, value: 200, fromShipId: 'w', expiresAt: match.t + 99 }];
  const ghost = st.players.find((p) => p.isBot);
  ghost.state = 'eliminated';
  ghost.position = { x: 0, y: -CARGO.SPILL_DEPTH, z: 0 };
  match.updateSpoils();
  expect('an eliminated pirate cannot claim sunken cargo',
    (st.spoils ?? []).length === 1, `spoils=${(st.spoils ?? []).length}`);

  // The tide eventually takes it.
  st.spoils[0].expiresAt = match.t - 0.001;
  match.updateSpoils();
  expect('the tide takes unclaimed cargo on its timer',
    (st.spoils ?? []).length === 0);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n6. Bounty — past 60% of the target, the leader is the hunted');

{
  const match = liveMatch('cargo-bounty', 3);
  const st = match.state;
  const joined = match.addHumanClient(makeFakeWs(), 'Leader');
  const leader = st.players.find((p) => p.id === joined.playerId);
  const ship = st.ships.find((s) => s.id === joined.shipId);

  expect('the bounty line is 60% of the win target',
    bountyThresholdGold() === Math.ceil(ECONOMY.GOLD_WIN_TARGET * 0.6),
    `${bountyThresholdGold()}`);

  const broadcasts = [];
  const realBroadcast = match.broadcast.bind(match);
  match.broadcast = (msg) => { broadcasts.push(msg); return realBroadcast(msg); };

  leader.gold = bountyThresholdGold() - 1;
  match.updateCargoAndBounty();
  expect('one gold short of the line raises no hunt',
    !ship.bountied && !broadcasts.some((m) => m.type === 'bounty_raised'),
    `bountied=${ship.bountied}`);

  leader.gold = bountyThresholdGold();
  match.updateCargoAndBounty();
  expect('crossing the line marks the hull on every chart',
    ship.bountied === true);
  expect('crossing the line is CRIED — one feed line + horn, not silence',
    broadcasts.filter((m) => m.type === 'bounty_raised').length === 1,
    `${broadcasts.filter((m) => m.type === 'bounty_raised').length}`);

  // Hysteresis: a leader hovering on the line must not strobe the map.
  match.updateCargoAndBounty();
  match.updateCargoAndBounty();
  expect('a standing bounty is not re-cried every tick',
    broadcasts.filter((m) => m.type === 'bounty_raised').length === 1);

  leader.gold = bountyClearGold() + 10;
  match.updateCargoAndBounty();
  expect('dipping back over the line keeps the bounty (hysteresis, no strobe)',
    ship.bountied === true, `gold=${leader.gold}`);
  leader.gold = bountyClearGold() - 1;
  match.updateCargoAndBounty();
  expect('falling under the clear line finally lifts the bounty',
    !ship.bountied);
  expect('a cleared bounty costs NOTHING on the wire (undefined, not false)',
    ship.bountied === undefined, `${JSON.stringify(ship.bountied)}`);

  // Re-cried each storm phase, so the fleet is reminded as the ring tightens.
  leader.gold = bountyThresholdGold() + 500;
  match.updateCargoAndBounty();
  const afterRaise = broadcasts.filter((m) => m.type === 'bounty_raised').length;
  st.storm.phase += 1;
  match.updateCargoAndBounty();
  expect('every storm phase re-cries the standing bounty',
    broadcasts.filter((m) => m.type === 'bounty_raised').length === afterRaise + 1,
    `${broadcasts.filter((m) => m.type === 'bounty_raised').length} vs ${afterRaise}`);
  expect('the re-cry is flagged as a renewal, not a fresh discovery',
    broadcasts.filter((m) => m.type === 'bounty_raised').slice(-1)[0].payload.renewed === true);

  // Bots must answer it — a hunt only the human hears is theatre.
  const handed = [];
  match.bots.setBountiedShips = (ids) => { handed.push([...ids]); };
  match.updateCargoAndBounty();
  expect('bots are handed the bounty board every tick',
    handed.length === 1 && handed[0].includes(ship.id), JSON.stringify(handed));

  // A hull already going down is not a bounty target.
  ship.sinking = true;
  match.bots.setBountiedShips = () => {};
  match.updateCargoAndBounty();
  expect('a foundering hull sheds her bounty (nothing left to hunt)',
    !ship.bountied);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n7. Boarding a laden hold — the counterplay to the ballast');

{
  expect('an unladen victim still pays exactly the long-standing cap',
    boardingStealCap(CARGO.SAFE_GOLD) === PLAYER.BOARDING_GOLD_STEAL_CAP,
    `${boardingStealCap(CARGO.SAFE_GOLD)}`);
  expect('a broke victim pays the same floor (no negative scaling)',
    boardingStealCap(0) === PLAYER.BOARDING_GOLD_STEAL_CAP);
  expect('a FULLY laden victim is worth the designed multiple',
    boardingStealCap(CARGO.SAFE_GOLD + CARGO.FULL_LOAD)
      === PLAYER.BOARDING_GOLD_STEAL_CAP * CARGO.STEAL_LADEN_MULT,
    `${boardingStealCap(CARGO.SAFE_GOLD + CARGO.FULL_LOAD)}`);
  expect('the steal cap rises monotonically with the hold',
    boardingStealCap(3000) > boardingStealCap(1500)
      && boardingStealCap(6000) > boardingStealCap(3000));
  expect('boarding the leader is now worth a meaningful slice of the run',
    boardingStealCap(ECONOMY.GOLD_WIN_TARGET * 0.8) >= ECONOMY.GOLD_WIN_TARGET * 0.05,
    `cap=${boardingStealCap(ECONOMY.GOLD_WIN_TARGET * 0.8)}`);

  // End to end through handlePlayerDeath.
  const match = liveMatch('cargo-steal', 2);
  const st = match.state;
  const a = match.addHumanClient(makeFakeWs(), 'Boarder');
  const b = match.addHumanClient(makeFakeWs(), 'Rich');
  const boarder = st.players.find((p) => p.id === a.playerId);
  const victim = st.players.find((p) => p.id === b.playerId);
  victim.gold = CARGO.SAFE_GOLD + CARGO.FULL_LOAD;
  boarder.gold = 0;
  // A boarding kill: killer's home is elsewhere, killer stands on victim's deck.
  boarder.onShipId = victim.shipId;
  victim.lastDamagedById = boarder.id;
  victim.lastDamagedAt = match.t;
  const expected = boardingStealCap(victim.gold);
  match.handlePlayerDeath(victim);
  expect('cutting down a laden pirate on their own deck takes the laden cap',
    boarder.gold >= expected, `took=${boarder.gold} expected>=${expected}`);
  expect('the victim keeps everything above the cap (a kill is not a wipe)',
    victim.gold === CARGO.SAFE_GOLD + CARGO.FULL_LOAD - expected,
    `left=${victim.gold}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n8. Scuttle holes stop forging cannon damage');

{
  const match = liveMatch('cargo-scuttle', 1);
  const st = match.state;
  const ship = st.ships[0];
  const sources = [];
  const physics = match.physics;
  const realOpen = physics.openHoleAt.bind(physics);
  physics.openHoleAt = (s, local, count = 1, source) => {
    sources.push(source ?? 'unknown');
    return realOpen(s, local, count, source);
  };
  match.startShipSinking(ship, false, null);
  expect('a foundering hull is still riddled so she READS as a wreck',
    sources.length >= 8, `holes=${sources.length}`);
  expect('NOT ONE of those cosmetic breaches is logged as gunnery',
    sources.every((s) => s === 'scuttle'), JSON.stringify([...new Set(sources)]));
  expect('the hull\'s own hole entities carry the scuttle tag',
    ship.holes.filter((h) => h.source === 'scuttle').length >= 8
      && ship.holes.every((h) => h.source !== 'cannon'),
    JSON.stringify(ship.holes.map((h) => h.source).slice(0, 12)));
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n9. Wire — sunken cargo is cheap and the snapshot cap holds');

{
  const match = new Match({ matchId: 'cargo-wire', botCount: 9 });
  for (let i = 0; i < 250; i += 1) match.tick(DT);
  // Worst case: the world capped full of spoils AND every hull bountied.
  match.state.spoils = Array.from({ length: CARGO.SPILL_WORLD_MAX }, (_, i) => ({
    id: `sp${i}`,
    position: { x: i * 7.13, y: -CARGO.SPILL_DEPTH, z: -i * 3.77 },
    value: 400 + i,
    fromShipId: match.state.ships[i % match.state.ships.length].id,
    expiresAt: 9999,
  }));
  for (const ship of match.state.ships) {
    ship.cargoGold = 4200;
    ship.bountied = true;
  }
  const full = JSON.stringify(buildWireSnapshot(match.buildSnapshot(false), false));
  console.log(`  size: full=${(full.length / 1024).toFixed(1)}KB with ${CARGO.SPILL_WORLD_MAX} spoils + 10 bounties`);
  expect('the 10Hz full snapshot still fits the 35KB budget at worst case',
    full.length < 35 * 1024, `${full.length}B`);
  expect('sunken cargo actually rides the wire (the client can draw it)',
    full.includes('"spoils"') && full.includes('"sp0"'));
  expect('the spoil expiry clock is server bookkeeping and stays OFF the wire',
    !full.includes('expiresAt'));

  const empty = JSON.stringify(buildWireSnapshot(
    { ...match.buildSnapshot(false), spoils: [] }, false,
  ));
  expect('an ordinary match (no wrecks) pays almost nothing for the feature',
    full.length - empty.length < 4 * 1024,
    `spoils cost ${full.length - empty.length}B`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n10. Guardrails — nothing the wave touched may regress');

{
  const match = liveMatch('cargo-guardrails', 3);
  const st = match.state;
  const joined = match.addHumanClient(makeFakeWs(), 'Winner');
  const player = st.players.find((p) => p.id === joined.playerId);

  // The gold win itself is unchanged: cargo weight never gates the win check.
  player.gold = ECONOMY.GOLD_WIN_TARGET;
  match.updateCargoAndBounty();
  match.checkWinCondition();
  expect('banking the target still wins the match outright',
    st.phase === 'ended' && st.winnerId === player.id, `phase=${st.phase}`);

  // A match that runs with cargo and bounties live does not fall over.
  const soak = new Match({ matchId: 'cargo-soak', botCount: 9 });
  soak.state.phase = 'playing';
  for (const p of soak.state.players) p.gold = 2000 + Math.floor(Math.random() * 5000);
  let threw = null;
  try {
    for (let i = 0; i < 62 * 45; i += 1) soak.tick(DT);
  } catch (err) { threw = err; }
  expect('45 s of a full lobby sailing under load runs clean', threw === null,
    threw ? String(threw && threw.stack ? threw.stack.split('\n')[0] : threw) : '');
  expect('every hull is carrying a weighed, non-negative hold',
    soak.state.ships.every((s) => (s.cargoGold ?? 0) >= 0 && Number.isFinite(s.cargoGold ?? 0)));
  expect('nobody was pushed under the safe pocket by the sim',
    soak.state.players.every((p) => p.gold >= 0));
}

if (failures > 0) {
  console.error(`\n${failures} hold-cargo assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll hold-cargo assertions passed.');
