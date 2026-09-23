#!/usr/bin/env node
// test-handedness: port is port (b1.6c, physics-04 + vm:physics:2).
//
// The ship-local frame is +z bow, +x on the helmsman's LEFT. The physics was
// always self-consistent; the NAMES were mirrored: a breach on the left rail
// was announced "STARBOARD", "wind on the starboard beam" came from the left,
// and the +x brace station said "Brace the Yard to Starboard". This gate pins
// the one helper (sideOfLocalX: +x = port) to the real locomotion and helm,
// then runs the SHIPPED label expressions (extracted from Match, HudController
// and InteractionPrompts) against it. Every predicate also runs a negative
// control on the f5fee97e formula, which must FAIL it, so no check is vacuous.
//
//   node --import tsx scripts/test-handedness.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { stepPirate } from '../src/shared/locomotion.ts';
import {
  toShipWorldPoint, sideOfLocalX, sideOfBearing, sideTitle, handOfSide, hullSectionSide, hullSectionLocalX,
} from '../src/shared/interactions.ts';
import { angleWrap, getBraceStationLocals } from '../src/shared/utils/index.ts';
import { SHIP_STATS } from '../src/shared/constants/index.ts';
import { applyShipRudderSteering, PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';

let failed = 0;
let checks = 0;
function check(ok, label, detail = '') {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
}
/** Negative control: the old formula must FAIL the same predicate. */
function control(predicateHolds, label) {
  check(!predicateHolds, `control: ${label} is caught`);
}
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const radToDeg = (r) => (r * 180) / Math.PI;
const THREE = { MathUtils: { radToDeg } };

// ── 1. The helper against the real frame ──────────────────────────────────
check(sideOfLocalX(1) === 'port' && sideOfLocalX(-1) === 'starboard', 'sideOfLocalX: +x = port, -x = starboard');
const STBD_X = -1; // the local x the helper calls starboard
check(sideOfLocalX(STBD_X) === 'starboard', 'helper starboard sample is -x');

for (const rot of [0, 1.1, -2.3, 3.0]) {
  const ship = { position: { x: 0, y: 0, z: 0 }, rotation: rot };
  const stbd = toShipWorldPoint({ x: STBD_X, z: 0 }, ship);
  const walk = (key) => {
    const k = { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, crouching: false, state: 'alive', atCrowNest: false, onShipId: null };
    stepPirate(k, { [key]: true, yaw: rot, pitch: 0 }, 0.1, { ship: null, islands: [], jumpBlocked: false });
    return (stbd.x * k.velocity.x + stbd.z * k.velocity.z) / Math.max(1e-6, Math.hypot(k.velocity.x, k.velocity.z));
  };
  const r = walk('right');
  const l = walk('left');
  check(r > 0.99, `rot ${rot}: RIGHT at yaw = ship.rotation walks toward the helper's starboard`, `dot ${r.toFixed(3)}`);
  check(l < -0.99, `rot ${rot}: LEFT walks toward port`, `dot ${l.toFixed(3)}`);
  // f5fee97e called +x starboard: its starboard point is the one RIGHT walks AWAY from.
  const oldStbd = toShipWorldPoint({ x: 1, z: 0 }, ship);
  const k = { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, crouching: false, state: 'alive', atCrowNest: false, onShipId: null };
  stepPirate(k, { right: true, yaw: rot, pitch: 0 }, 0.1, { ship: null, islands: [], jumpBlocked: false });
  control(oldStbd.x * k.velocity.x + oldStbd.z * k.velocity.z > 0, `rot ${rot}: old "+x = starboard" walk`);
}

// Helm: steer right and the bow swings to the helper's starboard.
{
  const type = Object.keys(SHIP_STATS)[0];
  const stats = SHIP_STATS[type];
  const ship = { type, rotation: 0.7, rudderAngle: 0, angularVelocity: 0, waterLevel: 0, aground: false, velocity: { x: stats.maxSpeed * 0.6, y: 0, z: 0 } };
  const start = ship.rotation;
  for (let i = 0; i < 90; i++) { applyShipRudderSteering(ship, 1 / 62.5, +1); ship.rotation += ship.angularVelocity / 62.5; }
  const swing = angleWrap(ship.rotation - start);
  check(Math.abs(swing) > 0.02 && sideOfBearing(swing) === 'starboard', `helm RIGHT (${type}) swings the bow to starboard`, `swing ${radToDeg(swing).toFixed(1)} deg -> ${sideOfBearing(swing)}`);
}

// ── 2. Holes and damage sides ─────────────────────────────────────────────
{
  const phys = PhysicsSystem.prototype;
  const keyPlus = phys.impactHullSection.call({}, { x: 2, z: 0.1 });
  const keyMinus = phys.impactHullSection.call({}, { x: -2, z: 0.1 });
  check(hullSectionLocalX(keyPlus) === 1 && hullSectionLocalX(keyMinus) === -1, 'hullSectionLocalX agrees with PhysicsSystem.impactHullSection', `+x key '${keyPlus}', -x key '${keyMinus}'`);
  check(hullSectionSide(keyPlus) === 'port', 'a hole at +x is labelled port', `key '${keyPlus}' -> ${hullSectionSide(keyPlus)}`);
  check(hullSectionSide(keyMinus) === 'starboard', 'a hole at -x is labelled starboard');
  check(hullSectionSide('bow') === 'bow' && hullSectionSide('stern') === 'stern', 'bow and stern pass through');
  control(keyPlus === 'port', 'printing the raw +x key');

  // The ship_hit payload side, the expression Match actually ships.
  const match = src('src/server/core/Match.ts');
  const m = match.match(/const side = ([^;]*?);[^\n]*\n\s*const payload = \{\n\s*targetId: ship\.id,\n\s*incoming: true/);
  check(!!m, 'Match ship_hit side expression found');
  if (m) {
    const sideOf = new Function('local', 'sideOfLocalX', `return ${m[1]};`);
    check(sideOf({ x: 2, z: 0.5 }, sideOfLocalX) === 'port', 'ship_hit: a ball through the +x rail reads PORT', `got ${sideOf({ x: 2, z: 0.5 }, sideOfLocalX)}`);
    check(sideOf({ x: -2, z: 0.5 }, sideOfLocalX) === 'starboard', 'ship_hit: a ball through the -x rail reads STARBOARD');
    check(sideOf({ x: 0.2, z: 3 }, sideOfLocalX) === 'bow' && sideOf({ x: 0.2, z: -3 }, sideOfLocalX) === 'stern', 'ship_hit: bow and stern');
  }
  const oldSide = (local) => (Math.abs(local.z) > Math.abs(local.x) ? (local.z > 0 ? 'bow' : 'stern') : (local.x > 0 ? 'starboard' : 'port'));
  control(oldSide({ x: 2, z: 0.5 }) === 'port', 'old ship_hit side');
}

// ── 3. Wind bearing (phrase, plain gloss, vane arrow) ─────────────────────
{
  const hud = src('src/client/ui/HudController.ts');
  const method = (name) => {
    const m = hud.match(new RegExp(`private ${name}\\(relative: number\\): string \\{\\n([\\s\\S]*?)\\n  \\}\\n`));
    return m ? m[1] : null;
  };
  const deps = ['THREE', 'angleWrap', 'sideOfBearing', 'handOfSide', 'sideOfLocalX'];
  const run = (body) => new Function(...deps, 'relative', body).bind(null, THREE, angleWrap, sideOfBearing, handOfSide, sideOfLocalX);
  const phraseBody = method('windBearingPhrase');
  const glossBody = method('windPlainGloss');
  check(!!phraseBody && !!glossBody, 'HudController windBearingPhrase + windPlainGloss found');
  // `relative` is the yaw the wind BLOWS TOWARD minus the heading. Wind FROM
  // -x (starboard) blows toward +x: local x = sin(rel) = +1, rel = +pi/2.
  const cases = [
    { rel: Math.PI / 2, phrase: 'on the starboard beam', gloss: ' — from your right', what: 'wind from -x' },
    { rel: -Math.PI / 2, phrase: 'on the port beam', gloss: ' — from your left', what: 'wind from +x' },
    { rel: Math.PI * 0.75, phrase: 'on the starboard bow', gloss: ' — from ahead-right', what: 'wind from ahead, -x' },
    { rel: -Math.PI * 0.25, phrase: 'on the port quarter', gloss: ' — from behind-left', what: 'wind from astern, +x' },
  ];
  if (phraseBody && glossBody) {
    const phrase = run(phraseBody);
    const gloss = run(glossBody);
    for (const c of cases) {
      check(phrase(c.rel) === c.phrase, `${c.what} reads "${c.phrase}"`, `got "${phrase(c.rel)}"`);
      check(gloss(c.rel) === c.gloss, `${c.what} glosses "${c.gloss.slice(3)}"`, `got "${gloss(c.rel)}"`);
    }
  }
  // f5fee97e: side = wrapped < 0 ? 'port' : 'starboard'.
  const oldSide = (rel) => (angleWrap(rel + Math.PI) < 0 ? 'port' : 'starboard');
  control(oldSide(Math.PI / 2) === 'starboard', 'old phrase side for wind from -x');

  // Vane: the arrow streams DOWNWIND with the bow up the screen. Facing the
  // bow, port is screen-left, so wind blowing toward +x (port) must point the
  // arrow LEFT (CSS rotate is clockwise; the tip's screen x = sin(angle)).
  const vm = hud.match(/private updateWindVane[\s\S]*?vane\.arrow\.style\.transform = `rotate\(\$\{([^}]+)\}deg\)`/);
  check(!!vm, 'HudController vane rotate expression found');
  if (vm) {
    const cssDeg = (rel) => new Function('degrees', `return ${vm[1]};`)(Math.round(radToDeg(angleWrap(rel))));
    for (const rel of [Math.PI / 2, Math.PI / 4, -Math.PI / 3]) {
      const tipX = Math.sin((cssDeg(rel) * Math.PI) / 180);
      const want = handOfSide(sideOfBearing(rel)) === 'left' ? -1 : 1;
      check(Math.sign(tipX) === want, `vane: wind blowing toward ${sideOfBearing(rel)} points the arrow ${want < 0 ? 'left' : 'right'}`, `css ${cssDeg(rel)} deg`);
    }
    control(Math.sign(Math.sin((90 * Math.PI) / 180)) === -1, 'old vane rotate(+deg) for wind toward port');
  }
}

// ── 4. Brace prompt ───────────────────────────────────────────────────────
{
  const prompts = src('src/client/systems/InteractionPrompts.ts');
  const m = prompts.match(/Brace the Yard to \$\{([^`]*?)\} \(/);
  check(!!m, 'InteractionPrompts brace side expression found');
  const stats = SHIP_STATS[Object.keys(SHIP_STATS)[0]];
  for (const brace of getBraceStationLocals(stats)) {
    const want = brace.x > 0 ? 'Port' : 'Starboard';
    if (m) {
      const got = new Function('brace', 'sideOfLocalX', 'sideTitle', `return ${m[1]};`)(brace, sideOfLocalX, sideTitle);
      check(got === want, `brace station at x ${brace.x.toFixed(2)} (dir ${brace.dir}) says "to ${want}"`, `got "${got}"`);
    }
    // It hauls its own rail's brace: dir raises sailAngle by dir, and the sail
    // yaws by +sailAngle (ShipRenderer), which swings the +x yardarm AFT
    // (z' = -x sin a). The yardarm on the station's side must go aft.
    const a = brace.dir * 0.3;
    const tipZ = -Math.sign(brace.x) * Math.sin(a);
    check(tipZ < 0 && Math.sign(brace.dir) === Math.sign(brace.x), `brace station dir ${brace.dir}: its own ${sideOfLocalX(brace.x)} yardarm goes aft`);
  }
  control(((b) => (b.dir > 0 ? 'Starboard' : 'Port'))({ x: 1, dir: 1 }) === 'Port', 'old brace label');
}

// ── 5. No display path prints a raw HullSections key or a sign ternary ────
{
  const files = [
    'src/client/ui/HudController.ts', 'src/client/ui/hudModel.ts', 'src/client/systems/InteractionPrompts.ts',
    'src/client/core/Game.ts', 'src/server/core/Match.ts',
    ...readdirSync(new URL('../src/server/systems/bots/', import.meta.url)).filter((f) => f.endsWith('.ts')).map((f) => `src/server/systems/bots/${f}`),
  ];
  const SIGN_TERNARY = /\?\s*'(port|starboard|Port|Starboard|PORT|STARBOARD|left|right)'\s*:\s*'(port|starboard|Port|Starboard|PORT|STARBOARD|left|right)'/;
  const KEY_IN_TEXT = /\$\{[^}]*\bsection\b[^}]*\}/;
  const offenders = [];
  for (const f of files) {
    let text = src(f);
    // Data, not display: Match's section picker returns a HullSections KEY.
    text = text.replace(/private getHullSectionFromLocal[\s\S]*?\n  \}\n/, '');
    text.split('\n').forEach((line, i) => {
      if (SIGN_TERNARY.test(line) || KEY_IN_TEXT.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 110)}`);
    });
  }
  check(offenders.length === 0, 'no display path names a side from a raw sign or prints a HullSections key', offenders.join(' | '));
  check(SIGN_TERNARY.test("const side = wrapped < 0 ? 'port' : 'starboard';"), 'control: the sign-ternary grep catches the old wind line');
  check(KEY_IN_TEXT.test('`HULL · ${ev.section.toUpperCase()}`'), 'control: the raw-key grep catches a printed key');
}

console.log(`\n${checks} checks, ${failed} failed`);
if (failed > 0) { console.log('test-handedness: FAIL'); process.exit(1); }
console.log('test-handedness: PASS');
