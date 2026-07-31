#!/usr/bin/env node
/**
 * The two HUD holes that made dying unreadable, driven against the real DOM in a
 * real match:
 *
 *  1. The respawn count was painted straight off `player.respawnTimer` in the last
 *     snapshot, so when snapshots stalled — island streaming pinning the main
 *     thread, or a loaded host dilating the sim — the number simply stopped.
 *     Observed: "Respawning in 20" for 60+ seconds, then a silent elimination
 *     with the same digits still on screen. The count is now anchored to a local
 *     deadline armed from the server's timer (the staged match start already
 *     solved this the same way), and elimination owns the centre outright.
 *  2. Identical feed lines stacked instead of coalescing: five byte-identical
 *     "Chest stowed aboard…" toasts filled the panel, every one of them clipped
 *     at the same word so the gold figure — the entire payload — was past the cut.
 *
 * ── AND THE FOUR THINGS DYING STILL GOT WRONG ────────────────────────────────
 *  3. The screen named the wrong death. Killed by the storm and killed by a
 *     shark both read "DROWNED — you went under in open water with no hull left
 *     to climb back onto", because the cause was read off where the body was
 *     lying instead of off the blow that landed. Every cause the server can now
 *     tag is checked here for a title, a lesson and a stats line of its own.
 *  4. The elimination card collided with itself and with the live HUD: RETURN TO
 *     PORT printed on top of the copy, and the ship's-orders legend, the minimap
 *     and the feed printed through all of it. Every row's rect is measured.
 *  5. Storm damage was invisible. 100 → 74 → 0 at the wheel with no vignette, no
 *     pulse, no bar flash — the damage watch discarded every loss under half a
 *     point and the tempest bills 0.06 hp per snapshot.
 *  6. The spectate camera sat 34 cm above the spot you fell, which in open water
 *     is under the swell: four observed eliminations, four black screens.
 *
 * Each case is exercised by calling the real HudController against the real
 * elements, so the snapshot stall can be held still instead of waited for.
 *
 * ── HOW THIS SUITE WAITS ─────────────────────────────────────────────────────
 * It used to CRASH rather than fail on a contended host. Three reasons, all
 * fixed here, all of them the instrument lying about the game:
 *
 *  • `waitForFunction(fn, { timeout })` passes the options bag as the page
 *    function's ARGUMENT. The timeout was never applied; the default was.
 *  • The horn wait was soft-caught and then every later step assumed the match
 *    existed anyway. With no local player, `p.state = …` threw inside
 *    `page.evaluate`, the rejection escaped the top-level await, and the run
 *    died with a stack trace, a leaked browser and no accounting of which
 *    assertions had passed.
 *  • Nothing bounded the suite as a whole, so a slow host multiplied several
 *    90-second defaults into an open-ended hang.
 *
 * Now: one suite deadline, every wait clamped to what is left of it, an
 * explicit precondition (a local player and a world — which is all the HUD
 * checks actually need, horn or no horn), and any unexpected throw is reported
 * as a named failure instead of a crash.
 */
import { chromium } from 'playwright';
import { browserArgs } from './lib/browser-args.mjs';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2]
  ?? '/private/tmp/claude-501/-Users-tobiasdicker/10a91956-1f9b-4664-ae78-2d985d4991c4/scratchpad/fixwave1/net';
mkdirSync(OUT, { recursive: true });

/** Whole-suite budget. Every individual wait is clamped to what is left of it,
 *  so a loaded box degrades into a clean failure at a knowable time instead of
 *  compounding per-step defaults into a hang. */
const SUITE_BUDGET_MS = Number(process.env.PIRATES_HUD_BUDGET_MS ?? 300_000);
const DEADLINE = Date.now() + SUITE_BUDGET_MS;
const left = () => DEADLINE - Date.now();
/** Never hand Playwright a zero/negative timeout — it means "no timeout". */
const budget = (want) => Math.max(1_000, Math.min(want, left()));

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const browser = await chromium.launch({ args: browserArgs() });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.setDefaultTimeout(90_000);

/** A screenshot is evidence, never a gate: on a GPU-contended host it can take
 *  twenty seconds and it must not be what fails the suite. */
async function shot(name) {
  try {
    await page.screenshot({ path: `${OUT}/${name}`, timeout: budget(30_000) });
  } catch (err) {
    console.log(`    (screenshot ${name} skipped: ${err.message.split('\n')[0]})`);
  }
}

/** Deadline-anchored wait. Resolves true/false — never throws, so a slow host
 *  produces a named failure rather than an unhandled rejection. */
async function waitFor(pageFn, label, wantMs) {
  try {
    // The options bag is the THIRD argument; as the second it is the page
    // function's arg and the timeout silently does nothing.
    await page.waitForFunction(pageFn, null, { timeout: budget(wantMs) });
    return true;
  } catch (err) {
    console.log(`    (wait "${label}" gave up after ${(budget(wantMs) / 1000).toFixed(0)}s)`);
    return false;
  }
}

// A concurrent edit anywhere in the tree makes Vite full-reload this tab and
// destroys the execution context mid-assertion — which used to fail the suite
// for a reason that has nothing to do with the game. Stub the HMR client out:
// the modules already loaded are the ones under test.
await page.route('**/@vite/client*', (route) => route.fulfill({
  status: 200,
  contentType: 'application/javascript',
  body: [
    'export const createHotContext = () => ({ on(){}, off(){}, send(){}, accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, data:{} });',
    'export const updateStyle = () => {};',
    'export const removeStyle = () => {};',
    'export const injectQuery = (u) => u;',
    'export default {};',
  ].join('\n'),
}));
// The first-voyage card tour is modal and would swallow every key and click.
await page.addInitScript(() => {
  try { localStorage.setItem('piratesBR.seenControls', '1'); } catch { /* private mode */ }
});

try {
  await page.goto('http://127.0.0.1:3000/?debug', { waitUntil: 'domcontentloaded', timeout: budget(60_000) });
  await page.waitForSelector('#menu-solo-btn', { timeout: budget(60_000) });
  await page.click('#menu-solo-btn', { noWaitAfter: true });

  const joined = await waitFor(() => window.__piratesBR?.network?.isJoined?.() === true, 'join', 90_000);
  expect('the client joins a match', joined, 'network.isJoined() never went true');

  // THE REAL PRECONDITION. These checks drive HudController directly against a
  // local player and a world; they do not need the horn. Waiting on the horn
  // and then carrying on regardless is what turned a late horn into a crash.
  const ready = joined && await waitFor(
    () => {
      const g = window.__piratesBR;
      return !!(g?.hud && g.getLocalPlayer?.() && g.state?.storm && g.state?.ships?.length);
    },
    'local player + world',
    90_000,
  );

  if (!ready) {
    // A named, single-line failure — not a stack trace from inside an evaluate.
    const why = await page.evaluate(() => {
      const g = window.__piratesBR;
      return {
        handle: !!g,
        hud: !!g?.hud,
        localPlayer: !!g?.getLocalPlayer?.(),
        phase: g?.state?.phase ?? null,
        ships: g?.state?.ships?.length ?? 0,
        storm: !!g?.state?.storm,
      };
    }).catch((e) => ({ evaluateFailed: e.message.split('\n')[0] }));
    expect('a local player and a world exist to drive the HUD against', false, JSON.stringify(why));
  } else {
    // The horn can be a long time coming on a contended host (that is defect #3,
    // and this suite is not the one that measures it). Noted, never assumed.
    const horn = await waitFor(() => window.__piratesBR?.state?.phase === 'playing', 'horn', 60_000);
    if (!horn) console.log('  (note: horn never blew — host is dilating; HUD checks continue)');
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));

    // ── Respawn countdown ────────────────────────────────────────
    // Freeze the world where a stall would freeze it: the local player is respawning
    // and NO new snapshot ever lands, so `respawnTimer` never changes again. Before
    // the fix that pinned the digits forever.
    console.log('Respawn countdown under a snapshot stall:');
    // Both readings are taken inside ONE evaluate, against the page's own clock. A
    // screenshot on this contended host can eat twenty seconds, so anything measured
    // across two round trips measures Playwright, not the countdown.
    const respawn = await page.evaluate(async () => {
      const g = window.__piratesBR;
      // THE STALL, literally: stop applying snapshots. Every later frame now reads
      // the same `respawnTimer` forever, which is exactly the state the HUD was in
      // when it froze on "Respawning in 20" for a minute.
      g.network.onSnapshot = null;
      g.network.onHotSnapshot = null;
      const prompt = () => document.getElementById('interact-prompt').textContent;
      const pin = () => {
        const p = g.getLocalPlayer();
        p.state = 'respawning';
        // Exactly the defect: the snapshot never moved, so this field never changes.
        p.respawnTimer = 20;
        // Home ship inside the ring, so the countdown is genuinely running (a ship in
        // the storm HOLDS the respawn server-side, and the HUD now says so).
        const home = g.state.ships.find((s) => s.id === p.shipId);
        if (home) {
          home.alive = true; home.sinking = false;
          home.position = { x: g.state.storm.centerX, y: 0, z: g.state.storm.centerZ };
        }
        g.hud.updateHud();
      };
      pin();
      const first = prompt();
      const startedAt = performance.now();
      await new Promise((r) => setTimeout(r, 4200));
      pin();
      return {
        first,
        later: prompt(),
        elapsedSec: (performance.now() - startedAt) / 1000,
        stillStale: g.getLocalPlayer().respawnTimer,
      };
    });
    console.log(`    t=0  → "${respawn.first}"`);
    // The digits lead; the CAUSE rides the same line (see the blackout case
    // below — "Respawning in 8" told a dead pirate the wait and never the why).
    expect('arms at the server value', /^Respawning in 20\b/.test(respawn.first), `got "${respawn.first}"`);
    console.log(`    t=${respawn.elapsedSec.toFixed(1)}s → "${respawn.later}" (server field still ${respawn.stillStale})`);
    const ticked = /^Respawning in (\d+)\b/.exec(respawn.later);
    const wantSec = 20 - respawn.elapsedSec;
    expect('the count keeps falling while the server field is frozen',
      !!ticked && Math.abs(Number(ticked[1]) - wantSec) <= 1.5,
      `after ${respawn.elapsedSec.toFixed(1)}s expected ~${wantSec.toFixed(0)}, got "${respawn.later}"`);
    await shot('respawn-counting.png');

    // ── The respawn blackout names WHAT KILLED YOU ───────────────
    // Defect: you went from playing to a dark screen counting down, and no line
    // anywhere said what had just happened. `kill_event.cause` is threaded to
    // the HUD for respawnable deaths exactly as `game_over.cause` is for finals.
    console.log('The respawn blackout names the cause, not just the wait:');
    const blackout = await page.evaluate(() => {
      const g = window.__piratesBR;
      const p = g.getLocalPlayer();
      const read = (cause) => {
        g.hud.noteEliminationCause(cause);
        p.state = 'respawning';
        p.respawnTimer = 8;
        const home = g.state.ships.find((s) => s.id === p.shipId);
        if (home) {
          home.alive = true; home.sinking = false;
          home.position = { x: g.state.storm.centerX, y: 0, z: g.state.storm.centerZ };
        }
        // Re-arm the local deadline for each reading (both halves, or the
        // second cause reads a deadline that has already run out).
        g.hud.respawnDeadlineMs = 0;
        g.hud.respawnServerTimer = -1;
        g.hud.updateHud();
        return document.getElementById('interact-prompt').textContent;
      };
      const out = { storm: read('storm'), shark: read('shark'), blade: read('blade') };
      g.hud.noteEliminationCause(null);
      return out;
    });
    for (const [cause, line] of Object.entries(blackout)) console.log(`    ${cause} → "${line}"`);
    expect('a storm respawn says the storm took you', /storm took you/i.test(blackout.storm), blackout.storm);
    expect('a shark respawn says a shark had you', /shark/i.test(blackout.shark), blackout.shark);
    expect('a blade respawn says you were cut down', /blade|cut/i.test(blackout.blade), blackout.blade);
    expect('the wait is still on the line', /Respawning in \d+/.test(blackout.storm), blackout.storm);

    // ── Elimination ──────────────────────────────────────────────
    console.log('Elimination flips the centre immediately:');
    const elim = await page.evaluate(() => {
      const g = window.__piratesBR;
      const p = g.getLocalPlayer();
      p.state = 'eliminated';
      g.hud.updateHud();
      return {
        prompt: document.getElementById('interact-prompt').textContent,
        label: document.getElementById('context-label').textContent,
      };
    });
    console.log(`    → "${elim.prompt}" / "${elim.label}"`);
    expect('no stale respawn digits survive the kill', !/Respawning in/.test(elim.prompt), elim.prompt);
    expect('the state is named out loud', /eliminated/i.test(elim.prompt) && /spectating/i.test(elim.prompt),
      elim.prompt);
    await shot('eliminated.png');

    // ── The elimination screen names the RIGHT death, and fits ───
    // The audit's headline: killed by the storm and by a shark, both screens
    // read "DROWNED — you went under in open water with no hull left to climb
    // back onto". The server now tags the blow that landed and the client paints
    // that; and the card is one bounded column, so RETURN TO PORT stopped
    // printing on top of the copy.
    console.log('The elimination screen names the actual killer:');
    const reading = await page.evaluate(() => {
      const g = window.__piratesBR;
      const p = g.getLocalPlayer();
      const out = {};
      // Baseline: the HUD is genuinely up right now, so "hidden behind the
      // death screen" is a change and not a tautology.
      p.state = 'alive';
      document.body.classList.remove('showing-death-screen');
      document.getElementById('hud').classList.add('visible');
      // The first-voyage tour lives ABOVE the death screen in z-order; dying
      // with it open used to print "SAIL — take the wheel" over the news that
      // you were dead. Open it deliberately so the check is real.
      document.getElementById('onboard-cards').classList.add('visible');
      const hudBefore = getComputedStyle(document.getElementById('hud')).display;
      const tourBefore = getComputedStyle(document.getElementById('onboard-cards')).display;
      const rows = ['death-title', 'death-cause', 'death-stats', 'death-wait', 'death-actions'];
      for (const cause of ['storm', 'shark', 'drowned', 'fall', 'fire', 'cannon', 'gunshot', 'blade', 'explosion', 'ship_sunk']) {
        g.hud.noteEliminationCause(cause);
        p.state = 'eliminated';
        g.hud.updateHud();
        const boxes = rows.map((id) => {
          const el = document.getElementById(id);
          const b = el.getBoundingClientRect();
          return { id, top: b.top, bottom: b.bottom, left: b.left, right: b.right };
        });
        // Any two rows sharing screen space is the collision the audit shot.
        let overlaps = 0;
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            if (a.bottom > b.top + 0.5 && b.bottom > a.top + 0.5
              && a.right > b.left + 0.5 && b.right > a.left + 0.5) overlaps += 1;
          }
        }
        const panel = document.getElementById('death-panel').getBoundingClientRect();
        out[cause] = {
          title: document.getElementById('death-title').textContent,
          cause: document.getElementById('death-cause').textContent,
          reason: document.getElementById('death-stats').textContent,
          overlaps,
          // The card must sit inside the window, not run off it.
          insideViewport: panel.top >= -1 && panel.bottom <= window.innerHeight + 1,
          hudDisplay: getComputedStyle(document.getElementById('hud')).display,
          tourDisplay: getComputedStyle(document.getElementById('onboard-cards')).display,
          // Two HUD layers that live on <body>, not inside #hud.
          strayDisplays: ['server-load-chip', 'story-cutscene-overlay']
            .map((id) => document.getElementById(id))
            .filter(Boolean)
            .map((el) => getComputedStyle(el).display),
        };
      }
      // Leave the storm reading on screen — it is the one the shot captures.
      g.hud.noteEliminationCause('storm');
      g.hud.updateHud();
      return { hudBefore, tourBefore, causes: out };
    });
    const causes = reading.causes;
    for (const [cause, read] of Object.entries(causes)) {
      console.log(`    ${cause.padEnd(9)} → "${read.title}" | overlaps=${read.overlaps} hud=${read.hudDisplay}`);
    }
    expect('a storm death is not called a drowning', /STORM/i.test(causes.storm.title), causes.storm.title);
    expect('a shark death names the shark', /SHARK/i.test(causes.shark.title), causes.shark.title);
    expect('a drowning is still called a drowning', /DROWNED/i.test(causes.drowned.title), causes.drowned.title);
    expect('a fall names the fall', /ROCKS|FALL/i.test(causes.fall.title), causes.fall.title);
    expect('fire names the fire', /BURN/i.test(causes.fire.title), causes.fire.title);
    expect('a cannon round names the gun', /DECK|CANNON/i.test(causes.cannon.title), causes.cannon.title);
    expect('a bullet names the shot', /SHOT/i.test(causes.gunshot.title), causes.gunshot.title);
    expect('a cutlass names the blade', /CUT DOWN/i.test(causes.blade.title), causes.blade.title);
    expect('a keg names the blast', /BLOWN APART/i.test(causes.explosion.title), causes.explosion.title);
    expect('a sunk hull still says so', /SHIP SUNK/i.test(causes.ship_sunk.title), causes.ship_sunk.title);
    expect('every cause paints real copy (no undefined in the one screen a loser reads)',
      Object.values(causes).every((c) => c.title && !/undefined/.test(c.title)
        && c.cause && c.cause.length > 20 && !/undefined/.test(c.cause)
        && c.reason && !/undefined/.test(c.reason)),
      JSON.stringify(causes.storm));
    expect('no two rows of the elimination card overlap',
      Object.values(causes).every((c) => c.overlaps === 0),
      JSON.stringify(Object.fromEntries(Object.entries(causes).map(([k, v]) => [k, v.overlaps]))));
    expect('the card fits the window',
      Object.values(causes).every((c) => c.insideViewport), 'a death panel ran off the screen');
    expect('the live HUD is hidden behind the elimination screen',
      reading.hudBefore !== 'none' && Object.values(causes).every((c) => c.hudDisplay === 'none'),
      `hud was "${reading.hudBefore}" before, "${causes.storm.hudDisplay}" behind the screen`);
    expect('the first-voyage tour does not print over the elimination screen',
      reading.tourBefore !== 'none' && Object.values(causes).every((c) => c.tourDisplay === 'none'),
      `tour was "${reading.tourBefore}" before, "${causes.storm.tourDisplay}" behind the screen`);
    expect('no <body>-level HUD layer shows through the wash either',
      Object.values(causes).every((c) => c.strayDisplays.every((d) => d === 'none')),
      JSON.stringify(causes.storm.strayDisplays));
    await shot('death-cause-storm.png');
    // Back to a live HUD for the feed checks below.
    await page.evaluate(() => {
      const g = window.__piratesBR;
      g.hud.noteEliminationCause(null);
      g.getLocalPlayer().state = 'alive';
      document.body.classList.remove('showing-death-screen');
      document.getElementById('death-screen').style.display = 'none';
      document.getElementById('onboard-cards').classList.remove('visible');
    });

    // ── Storm damage is SEEN, not just subtracted ────────────────
    // The audit watched HP go 100 → 74 → 0 at the wheel with no vignette, no
    // pulse, no sound: the frame-by-frame damage watch threw away every loss
    // under half a point, and the tempest bills 0.6 hp per SECOND — which lands
    // as 0.06 per snapshot. Every phase but the last two was invisible by
    // construction. Chips are banked now, and unbroken damage raises a separate
    // escalating attrition read.
    //
    // Driven by feeding the local player the exact chips the wire delivers
    // (0.06 hp at 10 Hz) with the snapshot stream held still, so the read is of
    // the real frame loop and the real CombatFx, on a real match.
    console.log('Storm-rate chip damage raises a visible read:');
    const attrition = await page.evaluate(async () => {
      const g = window.__piratesBR;
      g.network.onSnapshot = null;
      g.network.onHotSnapshot = null;
      const p = g.getLocalPlayer();
      p.state = 'alive';
      p.health = 100;
      p.atHelm = true; // the station the audit was standing at
      document.body.classList.remove('showing-death-screen');
      document.getElementById('death-screen').style.display = 'none';
      const read = () => ({
        hp: +p.health.toFixed(2),
        attrition: +(document.getElementById('attrition-vignette')?.style.opacity ?? 0),
        hurt: +(document.getElementById('hurt-vignette')?.style.opacity ?? 0),
        barFlash: (document.getElementById('health-bar-wrap')?.style.filter ?? '') !== '',
      });
      const samples = [];
      // 8 seconds of phase-1 tempest, billed exactly as the server bills it.
      for (let i = 0; i < 80; i++) {
        p.health = Math.max(1, p.health - 0.06);
        await new Promise((r) => setTimeout(r, 100));
        samples.push(read());
      }
      const peak = samples.reduce((a, b) => ({
        attrition: Math.max(a.attrition, b.attrition),
        hurt: Math.max(a.hurt, b.hurt),
        barFlash: a.barFlash || b.barFlash,
      }), { attrition: 0, hurt: 0, barFlash: false });
      const early = samples[6] ?? samples[0];
      const late = samples[samples.length - 1];
      p.atHelm = false;
      return { peak, early: early.attrition, late: late.attrition, hpAfter: late.hp, count: samples.length };
    });
    console.log(`    → ${JSON.stringify(attrition)}`);
    expect('storm-rate chips raise the attrition vignette at all',
      attrition.peak.attrition > 0.15, JSON.stringify(attrition.peak));
    expect('…and it ESCALATES the longer the weather has you',
      attrition.late > attrition.early + 0.05,
      `early=${attrition.early} late=${attrition.late}`);
    expect('the same chips still land a hit flash',
      attrition.peak.hurt > 0.05, JSON.stringify(attrition.peak));
    expect('the health bar itself announces the loss',
      attrition.peak.barFlash === true, JSON.stringify(attrition.peak));
    await shot('storm-attrition.png');

    // ── The spectate camera climbs out of the water ──────────────
    // Four observed eliminations, four near-black voids: the death camera parks
    // the eye 34 cm above the spot you fell, which in open water is UNDER the
    // swell, and the dying vignette is a 94%-black ellipse on top of that.
    console.log('The spectate camera leaves the corpse behind:');
    const spectate = await page.evaluate(async () => {
      const g = window.__piratesBR;
      const p = g.getLocalPlayer();
      p.state = 'eliminated';
      const before = {
        camY: +g.renderer.camera.position.y.toFixed(2),
        vignette: +(document.getElementById('death-vignette')?.style.opacity ?? 0),
      };
      // Let the lift run its full rise (Game.SPECTATE_RISE_SECONDS) on real
      // frames. The rise is integrated on the RENDER clock, so a 9-fps CI box
      // takes several times the wall clock a 60-fps player would — wait for the
      // rise to finish rather than for a stopwatch that only holds at 60 fps.
      const until = performance.now() + 40_000;
      while (g.spectateLift < 0.995 && performance.now() < until) {
        await new Promise((r) => setTimeout(r, 120));
      }
      const settleFrom = performance.now();
      while (performance.now() - settleFrom < 700) await new Promise((r) => setTimeout(r, 60));
      const cam = g.renderer.camera.position;
      return {
        before,
        roseInMs: Math.round(performance.now() - settleFrom),
        camY: +cam.y.toFixed(2),
        // What the camera is looking down at — the body it lifted off.
        anchorY: g.localDeathAnchor ? +g.localDeathAnchor.pos.y.toFixed(2) : null,
        lift: +g.spectateLift.toFixed(3),
        fillLight: g.spectateLight ? +g.spectateLight.intensity.toFixed(2) : null,
        fillVisible: g.spectateLight ? !!g.spectateLight.visible : false,
        vignette: +(document.getElementById('death-vignette')?.style.opacity ?? 0),
        deathScreenUp: getComputedStyle(document.getElementById('death-screen')).display !== 'none',
      };
    });
    console.log(`    → ${JSON.stringify(spectate)}`);
    expect('the camera actually rises off the body', spectate.lift > 0.95, `lift=${spectate.lift}`);
    expect('and ends up well clear of the waterline',
      spectate.camY > 3.5, `camY=${spectate.camY} (was ${spectate.before.camY})`);
    expect('a fill light exists so a night death is not black on black',
      spectate.fillVisible && (spectate.fillLight ?? 0) > 0.5, JSON.stringify(spectate));
    expect('the dying vignette eases off instead of blinding the spectator',
      spectate.vignette < 0.42, `vignette=${spectate.vignette}`);
    await shot('spectate-camera.png');

    // ── Respawn held (ship in the storm) ─────────────────────────
    console.log('A respawn the server is holding says so:');
    const heldText = await page.evaluate(() => {
      const g = window.__piratesBR;
      const p = g.getLocalPlayer();
      p.state = 'respawning';
      p.respawnTimer = 20;
      const home = g.state.ships.find((s) => s.id === p.shipId);
      if (home) {
        home.alive = true; home.sinking = false;
        // Well outside the ring — server-side this pauses the timer entirely.
        home.position = { x: g.state.storm.centerX + g.state.storm.safeRadius + 400, y: 0, z: g.state.storm.centerZ };
      }
      g.hud.updateHud();
      return document.getElementById('interact-prompt').textContent;
    });
    console.log(`    → "${heldText}"`);
    expect('a held respawn is not counted down as if it were running', /held/i.test(heldText), heldText);

    // ── Feed coalescing ──────────────────────────────────────────
    console.log('Duplicate toasts coalesce and the payline fits:');
    // Every reading is taken inside ONE evaluate: feed lines expire on a 3s timer, and
    // a GPU-contended screenshot between two calls is easily slower than that.
    const feed = await page.evaluate(async () => {
      const g = window.__piratesBR;
      const el = document.getElementById('kill-feed');
      g.hud.resetForMatch();
      const msg = 'Chest stowed aboard: base 690 gold before Tallyman payout.';
      for (let i = 0; i < 5; i++) g.hud.pushFeed(msg, '#d9c17e');
      await new Promise((r) => requestAnimationFrame(r));
      const coalescedRows = el.children.length;
      const row = el.children[0];
      const reading = {
        rowCount: coalescedRows,
        text: row ? row.textContent : '',
        clipped: row ? row.scrollWidth > row.clientWidth + 1 : true,
        whiteSpace: row ? getComputedStyle(row).whiteSpace : '',
        distinctRows: 0,
      };
      // A different message must still get its own row — coalescing keys on the text.
      g.hud.pushFeed('A pirate was eliminated.', '#e7e1d4');
      await new Promise((r) => requestAnimationFrame(r));
      reading.distinctRows = el.children.length;
      return reading;
    });
    console.log(`    rows=${feed.rowCount} text="${feed.text}" clipped=${feed.clipped}`);
    expect('five identical toasts become one row', feed.rowCount === 1, `rowCount=${feed.rowCount}`);
    expect('the repeat count is on the line', /×5/.test(feed.text), feed.text);
    expect('the payline is not clipped', feed.clipped === false,
      `whiteSpace=${feed.whiteSpace}`);
    expect('the gold figure survives', /690 gold/.test(feed.text), feed.text);
    expect('a different message still gets its own row', feed.distinctRows === 2,
      `rows=${feed.distinctRows}`);
    await shot('feed-coalesced.png');

    // ── Server-overload chip ─────────────────────────────────────
    // Snapshots are still stalled from the respawn case above, so the sim clock the
    // client can see has stopped advancing while its own wall clock has not — the
    // same arithmetic a host running at 7% real time produces. The chip needs the
    // 5s measurement window plus its 1.5s anti-flicker dwell before it speaks.
    console.log('Sim dilation is announced instead of silently endured:');
    const chip = await page.evaluate(async () => {
      const g = window.__piratesBR;
      // Drive the HUD ourselves for the full window: the frame loop is the normal
      // driver, but this host is contended enough that frames are not something a
      // test should assume.
      const until = performance.now() + 9_000;
      while (performance.now() < until) {
        g.hud.updateHud();
        await new Promise((r) => setTimeout(r, 150));
      }
      const el = document.getElementById('server-load-chip');
      if (!el) {
        return {
          present: false,
          phase: g.state?.phase,
          serverTime: g.state?.serverTime,
          samples: g.hud.simRateSamples?.length,
          tripSince: g.hud.simTripSince,
        };
      }
      const box = el.getBoundingClientRect();
      return {
        present: true,
        visible: getComputedStyle(el).display !== 'none' && box.width > 0,
        display: getComputedStyle(el).display,
        inDoc: document.body.contains(el),
        width: Math.round(box.width),
        text: el.textContent,
        top: Math.round(box.top),
        phase: window.__piratesBR.state?.phase,
      };
    });
    console.log(`    → ${JSON.stringify(chip)}`);
    if (chip.phase !== 'playing') {
      // The chip only speaks about the LIVE sim: before the horn `serverTime` is 0 by
      // design and every reading would look like an infinite deficit. A host so loaded
      // that the 8s countdown never finished is defect #3 with the volume all the way
      // up, but it is not a state this assertion can be made in.
      console.log(`  — SKIPPED: horn never blew (phase=${chip.phase}); chip is correctly silent pre-horn`);
    } else {
      expect('a dilating sim raises the overload chip', chip.present && chip.visible, JSON.stringify(chip));
      expect('the chip names the problem and the size of it',
        /overloaded/i.test(chip.text ?? '') && /\d+s behind/.test(chip.text ?? ''), chip.text);
      await shot('overload-chip.png');
    }
  }
} catch (err) {
  // Anything unexpected is a FAILING ASSERTION with a readable cause, not a
  // crash: the run still prints its tally and still closes the browser.
  expect('the suite runs to the end without throwing', false,
    `${err?.message?.split('\n')[0] ?? err}  (${(SUITE_BUDGET_MS - left()) / 1000 | 0}s in, ${(left() / 1000) | 0}s of budget left)`);
} finally {
  await browser.close().catch(() => {});
}

if (failures > 0) {
  console.error(`\n${failures} HUD assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll HUD death/feed assertions passed.');
