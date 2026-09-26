#!/usr/bin/env node
/**
 * test-captions (b3.5e; crossdevice-16, PLAN D33).
 *
 * Grades the audio-cue captions:
 *  1. The curated list (CueCaptions.CAPTION_CUES): >= 25 cues, every one with a
 *     label, the spec's named cues present (water rushing in, cannon fire,
 *     footsteps, ship bell, storm closing, chest, pirate down), >= 15 key cues.
 *  2. Static: every curated id is emitted by SoundEngine through this.cue(...),
 *     every emitted id is curated, and each emit sits BEFORE the method's
 *     "no AudioContext" return (a muted phone still gets captions).
 *  3. Arrow math relative to camera yaw (8 sectors, turns with the camera).
 *  4. The store: 3 lines max, 2.5 s lifetime, dedupe/refresh, off/key/all,
 *     remote-only cues skip your own sound, max distance, 'all' lines evicted first.
 *  5. Behaviour through a real SoundEngine with NO AudioContext: a remote cannon
 *     to port captions "← Cannon fire", your own cannon does not, a remote
 *     footstep behind reads "↓ Footsteps", and a NEW breach on your hull in
 *     updateFlood paints "Water rushing in" (a hull first heard already holed does not).
 *  6. Wiring: A11ySettings.captions parse (default off), Settings row, HUD mount.
 *
 * Run: node --import tsx scripts/test-captions.mjs
 */
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log(`  FAIL ${msg}`); } };

const C = await import('../src/client/ui/CueCaptions.ts');
const hud = await import('../src/client/ui/hudModel.ts');
const { CAPTION_CUES, captionArrow, CaptionStore, captionAllowed, CAPTION_MAX_LINES, CAPTION_TTL_S } = C;

// 1. The list.
const ids = Object.keys(CAPTION_CUES);
ok(ids.length >= 25, `>= 25 curated cues (got ${ids.length})`);
for (const id of ids) {
  const d = CAPTION_CUES[id];
  ok(typeof d.label === 'string' && d.label.trim().length >= 3 && d.label.length <= 28, `${id}: label '${d.label}' 3..28 chars`);
  ok(d.tier === 'key' || d.tier === 'all', `${id}: tier key|all`);
  ok(!/[—–;]/.test(d.label), `${id}: label has no dash/semicolon`);
}
const labels = ids.map((id) => CAPTION_CUES[id].label);
ok(new Set(labels).size === labels.length, 'labels are unique');
const keyCount = ids.filter((id) => CAPTION_CUES[id].tier === 'key').length;
ok(keyCount >= 15, `>= 15 key cues (got ${keyCount})`);
for (const [id, label] of [['water_rushing', 'Water rushing in'], ['cannon_fire', 'Cannon fire'], ['footsteps', 'Footsteps'],
  ['ship_bell', null], ['storm_closing', null], ['chest_lifted', null], ['pirate_down', null]]) {
  ok(!!CAPTION_CUES[id] && CAPTION_CUES[id].tier === 'key', `spec cue ${id} is curated at key tier`);
  if (label) ok(CAPTION_CUES[id]?.label === label, `${id} reads '${label}'`);
}

// 2. Static: SoundEngine emits every id, before the no-context return.
const se = fs.readFileSync(new URL('../src/client/audio/SoundEngine.ts', import.meta.url), 'utf8');
const emitted = new Set();
for (const m of se.matchAll(/this\.cue\(([^;]*?)\);/g)) for (const q of m[1].matchAll(/(?<!=== )'([a-z_]+)'/g)) emitted.add(q[1]); // not the `kind === 'ram'` test
for (const id of ids) ok(emitted.has(id), `SoundEngine emits '${id}'`);
for (const id of emitted) ok(ids.includes(id), `emitted '${id}' is curated (has a label)`);
{
  // Split into top-level class methods; in each method that emits, the emit precedes `!this.ctx`.
  const methodRe = /\n {2}(?:private |public )?([a-zA-Z]\w*)\([^)]*\)(?::[^{\n]+)? \{\n([\s\S]*?)\n {2}\}\n/g;
  let checked = 0;
  for (const m of se.matchAll(methodRe)) {
    const body = m[2];
    const iCue = body.search(/this\.cue\(|this\.captionBreaches\(/);
    if (iCue < 0) continue;
    checked++;
    const iCtx = body.search(/!this\.ctx|!ctx\b|this\.ctx\?\?|const ctx = this\.ctx;\s*\n\s*if \(!ctx/);
    ok(iCtx < 0 || iCue < iCtx, `${m[1]}(): caption emitted before the no-AudioContext return`);
  }
  ok(checked >= 25, `>= 25 emitting methods found by the scan (got ${checked})`);
}

// 3. Arrow math. Camera looking down -Z (three.js default): right is +X.
const A = (dx, dz, fx = 0, fz = -1) => captionArrow(dx, dz, fx, fz);
ok(A(0, -10) === '↑', `ahead -> ↑ (got ${A(0, -10)})`);
ok(A(10, 0) === '→', `+X with forward -Z -> → (got ${A(10, 0)})`);
ok(A(0, 10) === '↓', `behind -> ↓ (got ${A(0, 10)})`);
ok(A(-10, 0) === '←', `-X -> ← (got ${A(-10, 0)})`);
ok(A(7, -7) === '↗' && A(7, 7) === '↘' && A(-7, 7) === '↙' && A(-7, -7) === '↖', 'diagonals');
ok(A(10, 0, 1, 0) === '↑', `turn to face +X: the +X source is now ahead (got ${A(10, 0, 1, 0)})`);
ok(A(0, 10, 1, 0) === '→', `facing +X, +Z is to the right (got ${A(0, 10, 1, 0)})`);
ok(A(0, 10, 0, 1) === '↑' && A(0, -10, 0, 1) === '↓', 'facing +Z flips ahead/behind');
ok(A(10, 1) === '→' && A(10, -1) === '→', 'small offsets stay in the side sector');
ok(A(0.5, 0.5) === '', 'on top of you: no arrow');
ok(A(NaN, 3) === '' && A(3, 3, 0, 0) === '', 'non-finite / zero forward: no arrow');
ok(A(0, -10, 0, -5) === '↑', 'unnormalised forward is fine');

// 4. The store.
{
  const s = new CaptionStore();
  s.setListener({ x: 0, y: 0, z: 0 }, 0, -1);
  ok(s.push('cannon_fire', 0, 'key', { x: -50, y: 0, z: 0 }, 50), 'remote cannon accepted');
  ok(s.lines(0.1)[0]?.text === '← Cannon fire', `line reads '← Cannon fire' (got '${s.lines(0.1)[0]?.text}')`);
  s.setListener({ x: 0, y: 0, z: 0 }, -1, 0);
  ok(s.lines(0.2)[0]?.arrow === '↑', 'camera turns to face the gun: arrow follows to ↑');
  s.push('cannon_fire', 1.0, 'key', { x: 0, y: 0, z: 50 }, 50);
  ok(s.lines(1.1).length === 1, 'repeat cue dedupes to one line');
  ok(s.lines(1.0 + CAPTION_TTL_S - 0.01).length === 1, 'repeat refreshed the 2.5 s lifetime');
  ok(s.lines(1.0 + CAPTION_TTL_S + 0.01).length === 0, `gone after ${CAPTION_TTL_S} s`);
  s.push('gunshot', 10, 'key', null, 40);
  s.push('footsteps', 10, 'key', null, 5);
  s.push('explosion', 10, 'key', null, 40);
  s.push('hull_struck', 10.5, 'key', null, 40);
  const l = s.lines(10.6);
  ok(l.length === CAPTION_MAX_LINES, `3 lines max (got ${l.length})`);
  ok(!l.some((x) => x.id === 'gunshot') && l[l.length - 1].id === 'hull_struck', 'oldest line dropped for the newest');
  ok(!s.push('thunder', 11, 'key', null, 300), "'all'-tier thunder hidden under key cues");
  ok(s.push('thunder', 11, 'all', null, 300), "'all'-tier thunder shown under all");
  ok(!s.push('storm_closing', 11, 'off'), 'off shows nothing');
  const s2 = new CaptionStore();
  s2.push('thunder', 0, 'all'); s2.push('gunshot', 0.1, 'all', null, 30); s2.push('explosion', 0.2, 'all', null, 30);
  s2.push('hull_struck', 0.3, 'all', null, 30);
  ok(!s2.lines(0.4).some((x) => x.id === 'thunder') && s2.lines(0.4).some((x) => x.id === 'gunshot'), "a full strip evicts the 'all' line before an older key line");
  ok(!captionAllowed('cannon_fire', 'all', 0) && !captionAllowed('footsteps', 'all', undefined), 'your own cannon / feet are not captioned');
  ok(captionAllowed('footsteps', 'key', 12) && !captionAllowed('footsteps', 'key', 45), 'footsteps within 30 m only');
  ok(captionAllowed('storm_closing', 'key') && !captionAllowed('anchor_dropped', 'key', 5), 'tier filter');
}

// 5. Behaviour through SoundEngine with no AudioContext (never unlocked = a muted phone).
{
  const { SoundEngine } = await import('../src/client/audio/SoundEngine.ts');
  hud.setActiveA11ySettings({ ...hud.A11Y_DEFAULTS, captions: 'key' });
  const eng = new SoundEngine();
  ok(eng.getContextState() !== 'running', 'engine has no running AudioContext');
  C.cueCaptions.clear();
  eng.setListenerPose({ x: 0, y: 2, z: 0 }, { x: 0, y: 0, z: -1 });
  eng.playCannonFire(120, { x: -120, y: 0, z: 0 });
  let lines = C.cueCaptions.lines(performance.now() / 1000);
  ok(lines.some((x) => x.text === '← Cannon fire'), `remote cannon to port -> '← Cannon fire' (got ${JSON.stringify(lines.map((x) => x.text))})`);
  C.cueCaptions.clear();
  eng.playCannonFire(0, { x: 2, y: 0, z: 0 });
  ok(C.cueCaptions.lines(performance.now() / 1000).length === 0, 'own cannon (distance 0) not captioned');
  eng.playFootstep('deck', true, 6, { x: 0, y: 2, z: 6 });
  lines = C.cueCaptions.lines(performance.now() / 1000);
  ok(lines.some((x) => x.text === '↓ Footsteps'), `footsteps behind -> '↓ Footsteps' (got ${JSON.stringify(lines.map((x) => x.text))})`);
  eng.playStormShrink();
  ok(C.cueCaptions.lines(performance.now() / 1000).some((x) => x.label === 'Storm closing in'), 'storm shrink captioned');
  C.cueCaptions.clear();
  const holes = [];
  const frame = () => ({
    dt: 1 / 60, listener: { x: 0, y: 2, z: 0 }, aboardShipId: 'own',
    ships: [{ id: 'own', position: { x: 0, y: 0, z: 0 }, alive: true }, { id: 'far', position: { x: 0, y: 0, z: 30 }, alive: true }],
    emitters: (id) => (id === 'own' ? holes : id === 'far' ? [{ holeId: 9, worldPos: { x: 0, y: 0, z: 30 }, v: 1, submergedInside: false, strength: 1 }] : []),
  });
  eng.updateFlood(frame());
  ok(C.cueCaptions.lines(performance.now() / 1000).length === 0, 'first frame: no holes on own hull, and the rival hull first heard already holed, no caption');
  holes.push({ holeId: 3, worldPos: { x: 4, y: 0, z: 0 }, v: 1, submergedInside: false, strength: 0.8 });
  eng.updateFlood(frame());
  lines = C.cueCaptions.lines(performance.now() / 1000);
  ok(lines.some((x) => x.text === '→ Water rushing in'), `new breach to starboard -> '→ Water rushing in' (got ${JSON.stringify(lines.map((x) => x.text))})`);
  C.cueCaptions.clear();
  eng.updateFlood(frame());
  ok(C.cueCaptions.lines(performance.now() / 1000).length === 0, 'the same hole next frame is not new');
  holes.length = 0; eng.updateFlood(frame());
  holes.push({ holeId: 3, worldPos: { x: -4, y: 0, z: 0 }, v: 1, submergedInside: false, strength: 1 });
  eng.updateFlood(frame());
  ok(C.cueCaptions.lines(performance.now() / 1000).some((x) => x.label === 'Water rushing in'), 'a patched hole punched again is new');
  hud.setActiveA11ySettings({ ...hud.A11Y_DEFAULTS, captions: 'off' });
  C.cueCaptions.clear();
  eng.playCannonFire(120, { x: -120, y: 0, z: 0 });
  ok(C.cueCaptions.lines(performance.now() / 1000).length === 0, 'captions off: nothing');
}

// 6. Wiring.
ok(hud.parseA11ySettings(null).captions === 'off', 'captions default off');
ok(hud.parseA11ySettings('{"captions":"key"}').captions === 'key' && hud.parseA11ySettings('{"captions":"all"}').captions === 'all', 'captions parse key/all');
ok(hud.parseA11ySettings('{"captions":"loud"}').captions === 'off', 'junk captions -> off');
const menu = fs.readFileSync(new URL('../src/client/menu/MenuController.ts', import.meta.url), 'utf8');
ok(/settings-captions/.test(menu) && /save\(\{ captions:/.test(menu), 'Settings has the Captions select and saves it');
const hudSrc = fs.readFileSync(new URL('../src/client/ui/HudController.ts', import.meta.url), 'utf8');
ok(/mountCueCaptions\(\)/.test(hudSrc), 'HudController mounts the caption strip');

console.log(`test-captions: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
