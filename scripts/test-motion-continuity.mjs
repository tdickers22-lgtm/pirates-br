#!/usr/bin/env node
/**
 * MOTION CONTINUITY — does a thing that is moving keep moving between snapshots,
 * and does a man standing on a deck stay where he is standing?
 *
 * The other half of "no lag". Every other perf gate in this repo grades the
 * FRAME: draws, triangles, longest task, allocation. All of them can be green on
 * a client that feels awful, because perceived smoothness is not the frame rate,
 * it is whether the picture MOVES smoothly — and a 60fps client rendering a
 * target that only changes 31 times a second is a 31Hz picture with 60 frames
 * drawn of it.
 *
 * TWO CONTRACTS, both measured in metres, both backend-independent.
 *
 * 1. CARRY. The server sends position and velocity at 31.25Hz (SNAPSHOT_RATE=2
 *    over a 62.5Hz sim). Between two of those the client knows exactly where the
 *    entity is going: it has the velocity. If the render target does not advance
 *    at that velocity, the entity is frozen for the whole interval and then
 *    teleports when the next snapshot lands. `carry` is
 *
 *        |target(age = one snapshot interval) − target(age = 0)| / (speed × interval)
 *
 *    1.0 = the target moves exactly as fast as the entity really is. 0.0 = the
 *    target does not move at all between snapshots, and every snapshot is a jump
 *    of speed × 32ms. At a bot's 5.5 m/s that is 17.6cm, thirty-one times a
 *    second, forever.
 *
 *    HOW IT IS MEASURED WITHOUT A FAST FRAME RATE. `getPlayerRenderPosition`
 *    reads the snapshot age off the clock, so the age can be INJECTED: pin
 *    `lastSnapshotAt`, evaluate the target, pin it a snapshot-interval earlier,
 *    evaluate again, put the clock back. Both evaluations happen inside one
 *    synchronous block with the world state held still, so the answer is the
 *    interpolator's own transfer function and owes nothing to how fast this
 *    machine draws. That is what makes it gradeable on SwiftShader.
 *
 * 2. DECK WELD. A pirate standing on a moving hull must be drawn at the same
 *    place on the planking every frame. The server guarantees it (PhysicsSystem
 *    carries passengers with the hull before it writes the snapshot), so any
 *    drift is the CLIENT drawing the two things with different arithmetic. This
 *    takes the DRAWN hull transform and the DRAWN pirate, converts the pirate
 *    into hull-local coordinates, and compares against the hull-local offset the
 *    server actually sent. The difference is how far across the deck he has
 *    slid — in metres of planking, read off the two transforms that are on the
 *    screen, so it cannot be argued with.
 *
 *    Only players who are ALIVE, aboard, not swimming, not in a corpse animation
 *    and not at the helm/a cannon are counted (a station pins the pose by design).
 *
 * WHAT A FAILURE LOOKS LIKE TO THE PLAYER. Low carry is the sewing-machine gait:
 * an opponent running past you accelerates and stalls thirty-one times a second.
 * Deck slip is the crewmate who moonwalks along the deck of a ship under sail,
 * and the reason a hull at speed never feels solid underfoot.
 *
 * THE RUN. One page, one solo match against bots on the pinned map, bot peace on
 * so the sampled world is bots sailing and walking rather than bots shooting the
 * probe. Samples once per frame for the run window; every sample is a complete
 * age sweep, so a slow frame costs samples, never accuracy.
 *
 * WHAT IT READ, before and after the two fixes it was written for
 * (60s windows, pinned map, SwiftShader, same bot fleet):
 *
 *                                      before        after
 *   remote carry   median / p10        0.00 / 0.00   1.00 / 1.00
 *   local  carry   median              1.00          1.00      (the control)
 *   per-snapshot jump, remote          0.16m = 57px  0.00m
 *   deck slip      mean / p95 / worst  0.48 / 1.09 / 9.66m   0.00 / 0.00 / 0.02m
 *   deck slip (y)  mean / p95 / worst  0.30 / 0.70 / 1.10m   0.02 / 0.04 / 0.28m
 *
 * That table is the mutation proof. Both assertions in this file went red on the
 * build before the fix and green on the build after, with no threshold moved
 * between the two runs.
 *
 * Requires the dev stack up (vite on 3000, game server on 8090) — or point it
 * somewhere else, which is how it runs beside a live match:
 *
 * Usage:
 *   node scripts/test-motion-continuity.mjs
 *   node scripts/test-motion-continuity.mjs --seconds 60
 *   node scripts/test-motion-continuity.mjs --url http://127.0.0.1:3101 --server 8091
 *   node scripts/test-motion-continuity.mjs --report        # print, never fail
 */
import process from 'node:process';
import { chromium } from 'playwright';
import { browserArgs, describeGl } from './lib/browser-args.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const ROOT_URL = (arg('url', process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3000')).replace(/\/$/, '');
const SERVER_PORT = arg('server', process.env.PIRATES_BR_SERVER_PORT ?? null);
const SECONDS = Number.parseInt(arg('seconds', '60'), 10);
const REPORT_ONLY = has('report');
/**
 * Small on purpose, and it costs the run nothing. Every number this suite grades
 * is a distance in metres between two transforms — not one of them is a function
 * of resolution — while the SAMPLE COUNT is: each sample is a whole age sweep
 * taken once per frame, so on the software rasteriser the run is frame-starved
 * and a quarter of the pixels is three times the evidence. (The one number that
 * does read the viewport, the per-snapshot jump in PIXELS, is reported in the
 * viewport it was measured in and is not graded.)
 */
const VIEWPORT = { width: 480, height: 270 };

/** One hot-snapshot interval: SNAPSHOT_RATE(2) × SERVER_TICK_MS(16). */
const SNAPSHOT_INTERVAL_MS = 32;

/**
 * THE TRIPWIRES.
 *
 * CARRY. A target that advances at the entity's own velocity scores 1.0. The
 * floor is 0.6 rather than something tighter for two honest reasons: the deck
 * case blends the hull's extrapolation with the walker's own, and the swim case
 * pulls the visual onto the wave surface, so neither is a pure straight line.
 * What 0.6 catches is the failure this gate was written for — a target that does
 * not advance AT ALL between snapshots, which scores 0.00 and is what the remote
 * player path measured before the fix.
 *
 * DECK SLIP. 0.25m is a quarter of a stride: below it a pirate reads as bolted to
 * the plank he is standing on, above it he is visibly travelling across the deck
 * of a ship under sail. Measured at 1.6-2.4m before the fix on a hull at speed
 * (the hull mesh smooths toward its target with a 55ms time constant while the
 * pirate on it was placed from the UNSMOOTHED server position, so the two were
 * drawn a third of a metre apart at 6 knots and further the faster she sailed).
 */
const CARRY_FLOOR = 0.6;
const DECK_SLIP_CEILING_M = 0.25;
/**
 * Vertical weld. The drawn hull rides the wave heave and settles as she floods;
 * the crew has to ride it with her. 0.70m at p95 before the fix — a pirate drawn
 * knee-deep in the planking or hovering above it — against 0.07m after, which is
 * the y easing following the heave and is the right size for a footfall.
 */
const DECK_SLIP_Y_CEILING_M = 0.15;
/** Below this speed the carry ratio is a division by noise, so it is not scored. */
const MOVING_SPEED_MPS = 1.5;
/**
 * A run that sampled almost nothing has not passed; it has failed to measure.
 *
 * These are low because the evidence is expensive to come by, not because the
 * bar is. One carry sample is one age sweep on one moving body, taken once per
 * frame — and on the software rasteriser this scene runs at three to eight frames
 * a second, of which the walk cycle has a body moving for about two thirds. A
 * 60s window buys 20-60 of them. What makes that enough is the SPREAD: the
 * broken path scored 0.00 at every percentile including p10, and the fixed one
 * 1.00 at every percentile, in the same runs, on the same bodies. There is no
 * distribution here for a small sample to get wrong. The deck reading is the
 * opposite problem — every pirate aboard every hull contributes one per frame,
 * so it clears 1000 without trying, and a run that does not is a run in which no
 * hull was under way with anyone on it.
 */
const MIN_CARRY_SAMPLES = 12;
const MIN_DECK_SAMPLES = 200;

const sessionQuery = (extra = []) => ['debug', ...(SERVER_PORT ? [`server=${SERVER_PORT}`] : []), ...extra].join('&');

/**
 * Installed in the page. Runs one sample per animation frame: an age sweep for
 * every player the renderer is drawing, plus the deck-weld reading for everyone
 * aboard a hull. Kept to plain arithmetic — it runs inside the frame loop it is
 * measuring, so it must not be able to change what it measures.
 */
const SAMPLER = `(() => {
  const g = window.__piratesBR;
  const acc = {
    carry: [], deck: [], deckY: [], snapGaps: [], frames: 0, started: performance.now(),
    localCarry: [], worstJumpPx: 0, worstJumpM: 0, worstSlip: null, err: null,
    census: {}, maxSpeed: 0,
  };
  window.__mc = acc;
  let lastSnapAt = -1;
  const V = window.__mcV = { clone: (v) => ({ x: v.x, y: v.y, z: v.z }) };

  const sample = () => {
    try {
      const st = g.state;
      if (!st || st.phase !== 'playing') return;
      acc.frames++;
      const cs = g.clientState;

      // Snapshot arrival cadence: lastSnapshotAt only moves when one is applied.
      if (cs.lastSnapshotAt !== lastSnapAt) {
        if (lastSnapAt > 0) acc.snapGaps.push(cs.lastSnapshotAt - lastSnapAt);
        lastSnapAt = cs.lastSnapshotAt;
      }

      const cam = g.renderer.camera;
      const fovRad = (cam.fov * Math.PI) / 180;
      const pxPerRad = window.innerHeight / (2 * Math.tan(fovRad / 2));

      const saved = cs.lastSnapshotAt;
      const now = performance.now();
      for (const p of st.players) {
        if (p.state !== 'alive' || p.cannonBallistic) continue;
        const speed = Math.hypot(p.velocity.x, p.velocity.z);
        const isLocal = p.id === g.localPlayerId;
        const where = (isLocal ? 'local' : p.shipId === null ? 'skeleton' : 'bot')
          + (p.atHelm ? '@helm' : p.atCannon ? '@cannon' : p.onShipId ? '@deck' : '@shore')
          + (speed >= 1.5 ? '-moving' : '-still');
        acc.census[where] = (acc.census[where] || 0) + 1;
        if (speed > acc.maxSpeed) acc.maxSpeed = speed;
        const lead = isLocal ? (p.state === 'swimming' ? 0.05 : 0.055) : 0.035;

        if (speed >= ${MOVING_SPEED_MPS}) {
          const want = speed * ${SNAPSHOT_INTERVAL_MS} / 1000;
          const carryOf = (lead) => {
            cs.lastSnapshotAt = now;
            const a = V.clone(g.getPlayerRenderPosition(p, lead));
            cs.lastSnapshotAt = now - ${SNAPSHOT_INTERVAL_MS};
            const b = V.clone(g.getPlayerRenderPosition(p, lead));
            cs.lastSnapshotAt = saved;
            const moved = Math.hypot(b.x - a.x, b.z - a.z);
            return { carry: want > 0 ? moved / want : 1, moved, at: a };
          };
          // THE SAME PIRATE, DOWN BOTH BRANCHES. A bot match never produces a
          // remote pirate on foot — bots man stations and skeletons stand — so the
          // remote path would go ungraded for want of a moving body. It is the id
          // that selects the branch, so nulling it for the length of one evaluation
          // routes THIS moving pirate through the code every opponent takes, with
          // his own real position, velocity and state. Restored in the same
          // synchronous block; nothing else can observe it gone.
          const idSaved = g.localPlayerId;
          if (isLocal) g.localPlayerId = null;
          const asRemote = carryOf(0.035);
          if (isLocal) g.localPlayerId = idSaved;
          acc.carry.push(asRemote.carry);
          if (isLocal) acc.localCarry.push(carryOf(lead).carry);

          const jumpM = Math.max(0, want - asRemote.moved);
          const dist = Math.max(1, Math.hypot(asRemote.at.x - cam.position.x, asRemote.at.z - cam.position.z));
          const jumpPx = (jumpM / dist) * pxPerRad;
          if (jumpM > acc.worstJumpM) acc.worstJumpM = jumpM;
          if (jumpPx > acc.worstJumpPx) acc.worstJumpPx = jumpPx;
        }

        // ── deck weld ──
        if (!p.onShipId || p.atHelm || p.atCannon) continue;
        const ship = g.shipsById.get(p.onShipId);
        const hull = g.shipRenderer.getShipGroup(p.onShipId);
        const mesh = g.playerMeshes.get(p.id);
        if (!ship || !hull || !mesh || !mesh.userData.initialized || mesh.userData.corpse) continue;
        const shipSpeed = Math.hypot(ship.velocity.x, ship.velocity.z);
        if (shipSpeed < 1.0) continue; // a hull at anchor cannot slide anyone
        const c = Math.cos(ship.rotation), s = Math.sin(ship.rotation);
        const sdx = p.position.x - ship.position.x, sdz = p.position.z - ship.position.z;
        const wantX = sdx * c - sdz * s, wantZ = sdx * s + sdz * c;
        const hc = Math.cos(hull.rotation.y), hs = Math.sin(hull.rotation.y);
        const ddx = mesh.position.x - hull.position.x, ddz = mesh.position.z - hull.position.z;
        const gotX = ddx * hc - ddz * hs, gotZ = ddx * hs + ddz * hc;
        const slip = Math.hypot(gotX - wantX, gotZ - wantZ);
        acc.deck.push(slip);
        // Vertical: how far the pirate is drawn above/below the plank the server
        // put him on, once the drawn hull's heave is accounted for.
        acc.deckY.push(Math.abs((mesh.position.y - hull.position.y) - (p.position.y - ship.position.y)));
        if (!acc.worstSlip || slip > acc.worstSlip.slip) {
          acc.worstSlip = { slip, shipSpeed, isLocal, walking: speed };
        }
      }
      cs.lastSnapshotAt = saved;
    } catch (e) {
      acc.err = String(e && e.message ? e.message : e);
    }
  };

  const loop = () => { sample(); acc.raf = requestAnimationFrame(loop); };
  acc.raf = requestAnimationFrame(loop);
})()`;

/**
 * Keep one pirate genuinely on the move for the whole window, walking out and
 * back so he stays near where he spawned. Without this the run has no body in
 * motion at all: measured over a 60s bot match, the fastest anything on two legs
 * moved was 0.9 m/s — bots hold their stations and skeletons stand still — so
 * every carry sample in the run comes from this walk.
 */
async function walkAbout(page, totalMs) {
  const end = Date.now() + totalMs;
  const legs = ['w', 'w', 's', 's'];
  let i = 0;
  while (Date.now() < end) {
    const key = legs[i++ % legs.length];
    await page.keyboard.down(key);
    await page.waitForTimeout(Math.min(2500, Math.max(0, end - Date.now())));
    await page.keyboard.up(key);
    await page.waitForTimeout(Math.min(400, Math.max(0, end - Date.now())));
  }
}

const pct = (arr, p) => {
  if (arr.length === 0) return null;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * p))];
};
const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);
const f = (v, d = 2) => (v === null || v === undefined ? '--' : v.toFixed(d));

async function main() {
  console.log(`motion continuity — ${describeGl()}`);
  console.log(`  client ${ROOT_URL}${SERVER_PORT ? `  server :${SERVER_PORT}` : ''}  window ${SECONDS}s`);

  const browser = await chromium.launch({ headless: true, args: browserArgs(['--mute-audio']) });
  const failures = [];
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => console.error(`  [pageerror] ${e.message.slice(0, 160)}`));
    await page.goto(`${ROOT_URL}/?${sessionQuery(['quality=low'])}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', undefined, { timeout: 180_000 });
    // Let the streamed island builds finish before sampling: a frame spent
    // building an island is not a frame anyone is judging motion in.
    await page.waitForTimeout(8_000);
    await page.evaluate(() => window.__piratesBR.setBotPeace(true));
    await page.evaluate(SAMPLER);
    await walkAbout(page, SECONDS * 1000);
    const r = await page.evaluate(() => {
      const a = window.__mc;
      cancelAnimationFrame(a.raf);
      return {
        carry: a.carry, localCarry: a.localCarry, deck: a.deck, deckY: a.deckY, snapGaps: a.snapGaps,
        frames: a.frames, err: a.err, worstJumpPx: a.worstJumpPx, worstJumpM: a.worstJumpM,
        worstSlip: a.worstSlip, census: a.census, maxSpeed: a.maxSpeed,
      };
    });
    await page.close();

    if (r.err) console.log(`  sampler error: ${r.err}`);
    console.log(`  frames sampled ${r.frames}  remote-carry n=${r.carry.length}  local-carry n=${r.localCarry.length}  deck n=${r.deck.length}`);

    const gaps = r.snapGaps.filter((g) => g > 0);
    console.log(`  snapshot arrivals: median ${f(pct(gaps, 0.5), 1)}ms  p95 ${f(pct(gaps, 0.95), 1)}ms  worst ${f(Math.max(0, ...gaps), 1)}ms  (n=${gaps.length})`);

    const remoteCarry = { mean: mean(r.carry), p10: pct(r.carry, 0.1), median: pct(r.carry, 0.5) };
    const localCarry = { mean: mean(r.localCarry), median: pct(r.localCarry, 0.5) };
    console.log(`  CARRY remote: mean ${f(remoteCarry.mean)}  median ${f(remoteCarry.median)}  p10 ${f(remoteCarry.p10)}`);
    console.log(`  CARRY local : mean ${f(localCarry.mean)}  median ${f(localCarry.median)}`);
    console.log(`  worst per-snapshot jump (remote): ${f(r.worstJumpM)}m = ${f(r.worstJumpPx, 1)}px at its own range`);

    console.log(`  census (player-frames): ${Object.entries(r.census).map(([k, v]) => `${k}=${v}`).join(' ')}  maxSpeed ${f(r.maxSpeed, 1)}`);
    const deck = { mean: mean(r.deck), p95: pct(r.deck, 0.95), worst: r.deck.length ? Math.max(...r.deck) : null };
    console.log(`  DECK SLIP: mean ${f(deck.mean)}m  p95 ${f(deck.p95)}m  worst ${f(deck.worst)}m`);
    console.log(`  DECK SLIP (vertical): mean ${f(mean(r.deckY))}m  p95 ${f(pct(r.deckY, 0.95))}m  worst ${f(r.deckY.length ? Math.max(...r.deckY) : null)}m`);
    if (r.worstSlip) {
      console.log(`    worst sample: ${f(r.worstSlip.slip)}m of planking, hull ${f(r.worstSlip.shipSpeed, 1)} m/s, `
        + `${r.worstSlip.isLocal ? 'local' : 'remote'} pirate walking ${f(r.worstSlip.walking, 1)} m/s`);
    }

    if (r.carry.length < MIN_CARRY_SAMPLES) {
      failures.push(`only ${r.carry.length} remote carry samples (need ${MIN_CARRY_SAMPLES}) — the run measured nothing`);
    } else if (remoteCarry.median < CARRY_FLOOR) {
      failures.push(`remote entities do not carry between snapshots: median carry ${f(remoteCarry.median)} < ${CARRY_FLOOR} `
        + `— every snapshot is a ${f(r.worstJumpM)}m jump (${f(r.worstJumpPx, 1)}px)`);
    }
    if (r.localCarry.length >= MIN_CARRY_SAMPLES && localCarry.median < CARRY_FLOOR) {
      failures.push(`the local pirate does not carry between snapshots: median carry ${f(localCarry.median)} < ${CARRY_FLOOR}`);
    }
    if (r.deck.length < MIN_DECK_SAMPLES) {
      failures.push(`only ${r.deck.length} deck samples (need ${MIN_DECK_SAMPLES}) — no hull was under way with anyone aboard`);
    } else {
      if (deck.p95 > DECK_SLIP_CEILING_M) {
        failures.push(`pirates slide across a moving deck: p95 slip ${f(deck.p95)}m > ${DECK_SLIP_CEILING_M}m `
          + `(worst ${f(deck.worst)}m)`);
      }
      const deckYp95 = pct(r.deckY, 0.95);
      if (deckYp95 > DECK_SLIP_Y_CEILING_M) {
        failures.push(`pirates do not ride the deck they are drawn on: p95 vertical slip ${f(deckYp95)}m `
          + `> ${DECK_SLIP_Y_CEILING_M}m`);
      }
    }
  } finally {
    await browser.close();
  }

  if (failures.length === 0) {
    console.log('\nPASS — moving things move between snapshots, and the deck holds its crew.');
    return;
  }
  console.log('');
  for (const msg of failures) console.log(`FAIL — ${msg}`);
  if (REPORT_ONLY) {
    console.log('(--report: not failing the run)');
    return;
  }
  process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
