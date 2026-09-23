#!/usr/bin/env node
// test-hud-visibility (b1.5f; mechanicshud-06/07/14, liveplay-13, vm:mechanicshud:6).
// Pure, sub-second. Grades src/client/ui/hudModel.ts against the HUD spec table
// (PLAN section 3, mechanics+HUD C) and checks that HudController actually paints
// through it:
//   1. 12 canonical contexts -> the visible set equals the spec table
//   2. <= 12 always-on elements on desktop, <= 8 on a phone, in every context
//   3. 10 contradiction rows on hudMessagePlan (priority dead > sinking >
//      flooding > outside ring > carrying loot > default; one alarm slot; no
//      banner over an emergency; the crosshair is a dot until aiming)
//   4. every UiRefs id has a writer outside UiRefs.ts (dead DOM sweep)
//   5. wiring: HudController imports the model; no "dead in the water"; the dead
//      #damage-vignette is gone; the notice, party chip and next-target exist.
// Run: node --import tsx scripts/test-hud-visibility.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++;
  else { fails++; console.log(`FAIL ${name}${detail ? ` :: ${detail}` : ''}`); }
};

let M = null;
try {
  M = await import('../src/client/ui/hudModel.ts');
} catch (err) {
  check('import src/client/ui/hudModel.ts', false, String(err?.message ?? err).split('\n')[0]);
}

const base = {
  playerState: 'alive', device: 'desktop', inParty: false, nearOwnShip: false,
  atCannon: false, atHelm: false, atRepairPrompt: false, wheelHeld: false, mapOpen: false,
  aiming: false, holding: 'firearm', scopeShowing: false, alarmUp: false, bannerUp: false, serverNotice: false,
};
const ALWAYS = ['compass', 'stormLine', 'objective', 'gold', 'shipsAfloat', 'minimap', 'feed', 'health', 'weaponCard', 'crosshair', 'prompt'];
const minus = (arr, ...drop) => arr.filter((x) => !drop.includes(x));

// ── 1. the spec table ───────────────────────────────────────────────────────
const TABLE = [
  ['spawn ashore', {}, ALWAYS],
  ['on deck', { nearOwnShip: true }, [...ALWAYS, 'shipCard']],
  ['at the helm', { nearOwnShip: true, atHelm: true }, [...minus(ALWAYS, 'weaponCard', 'crosshair'), 'shipCard']],
  ['at a cannon', { nearOwnShip: true, atCannon: true }, [...minus(ALWAYS, 'weaponCard'), 'shipCard', 'stores', 'ammoDisplay']],
  ['hold flooding (repair prompt, alarm up)', { nearOwnShip: true, atRepairPrompt: true, alarmUp: true, holding: 'tool' },
    [...minus(ALWAYS, 'crosshair'), 'shipCard', 'stores', 'alarm']],
  ['swimming', { playerState: 'swimming' }, ALWAYS],
  ['outside the ring (banner wants in)', { alarmUp: true, bannerUp: true }, [...ALWAYS, 'alarm']],
  ['downed', { playerState: 'downed' }, [...minus(ALWAYS, 'crosshair'), 'downedCard']],
  ['respawn held', { playerState: 'respawning' }, [...minus(ALWAYS, 'crosshair', 'weaponCard'), 'respawnCard']],
  ['spectating', { playerState: 'eliminated' }, ['spectateBanner', 'deathBar', 'minimap', 'shipsAfloat', 'feed']],
  ['supply wheel held', { nearOwnShip: true, wheelHeld: true }, [...ALWAYS, 'shipCard', 'stores', 'supplyWheel']],
  ['map open (party)', { mapOpen: true, inParty: true }, [...minus(ALWAYS, 'crosshair'), 'crewStrip', 'partyChip', 'map']],
];
if (M) {
  for (const [name, patch, want] of TABLE) {
    const got = [...M.hudVisibility({ ...base, ...patch })].sort();
    const exp = [...new Set(want)].sort();
    check(`table: ${name}`, JSON.stringify(got) === JSON.stringify(exp), `got ${got.join(',')} want ${exp.join(',')}`);
  }
  // ── 2. budgets ────────────────────────────────────────────────────────────
  for (const [name, patch] of TABLE) {
    for (const party of [false, true]) {
      const d = M.alwaysOnCount(M.hudVisibility({ ...base, ...patch, inParty: party }));
      check(`desktop always-on <= 12: ${name}${party ? ' (party)' : ''}`, d <= 12, `${d}`);
      const p = M.alwaysOnCount(M.hudVisibility({ ...base, ...patch, inParty: party, device: 'phone' }));
      check(`phone always-on <= 8: ${name}${party ? ' (party)' : ''}`, p <= 8, `${p}`);
    }
  }
  check('stores never always-on', !M.hudVisibility(base).has('stores') && !M.hudVisibility({ ...base, nearOwnShip: true }).has('stores'));
  check('ammo once: no big ammo readout with a gun in hand', !M.hudVisibility(base).has('ammoDisplay'));

  // ── 3. contradiction rows ─────────────────────────────────────────────────
  const ms = {
    playerState: 'alive', shipSinking: false, shipLeaks: 0, shipWater: 0, shipOnFire: false,
    outsideRing: false, metresOutside: null, eyeCollapse: false, lootCarried: 0, lootSellAt: null,
    defaultObjective: 'Objective: dig a chest', sailAlarm: null, bannerRequested: null, wheelGlyph: '[1]',
  };
  const plan = (p) => M.hudMessagePlan({ ...ms, ...p });
  const rows = [
    ['dead + outside ring: no storm objective', plan({ playerState: 'eliminated', outsideRing: true, metresOutside: 80 }),
      (r) => r.tier === 'dead' && !/storm|ring/i.test(r.objective) && r.alarm === null],
    ['respawn held + sinking: dead tier, no ship alarm', plan({ playerState: 'respawning', respawnSeconds: 7, shipSinking: true }),
      (r) => r.tier === 'dead' && r.alarm === null && /7 s/.test(r.objective)],
    ['4 leaks: objective is the repair, not "dig a chest"', plan({ shipLeaks: 4, shipWater: 0.2 }),
      (r) => r.tier === 'flooding' && /patch/i.test(r.objective) && !/dig/i.test(r.objective)],
    ['4 leaks + outside ring: flooding outranks the ring', plan({ shipLeaks: 4, outsideRing: true, metresOutside: 40 }),
      (r) => r.tier === 'flooding' && /LEAK/.test(r.alarm ?? '')],
    ['sinking + 8 leaks: island banner suppressed', plan({ shipSinking: true, shipLeaks: 8, bannerRequested: 'PARLEY POINT' }),
      (r) => r.tier === 'sinking' && r.banner === null && r.alarm === 'SHIP IS SINKING'],
    ['flooding: banner suppressed', plan({ shipLeaks: 1, bannerRequested: 'PARLEY POINT' }), (r) => r.banner === null],
    ['calm: banner allowed', plan({ bannerRequested: 'PARLEY POINT' }), (r) => r.banner === 'PARLEY POINT' && r.alarm === null],
    ['outside ring: ONE alarm, objective does not repeat it', plan({ outsideRing: true, metresOutside: 120 }),
      (r) => r.tier === 'outside' && /120 m/.test(r.alarm ?? '') && !/OUTSIDE/i.test(r.objective)],
    ['carrying loot beats the default objective', plan({ lootCarried: 2, lootSellAt: 'Gull Rock' }),
      (r) => r.tier === 'loot' && /Gull Rock/.test(r.objective)],
    ['bucket hint names the wheel and the slot', plan({ shipWater: 0.3 }),
      (r) => /Hold \[1\] wheel, pick Bucket \(3\)/.test(r.objective)],
  ];
  for (const [name, r, ok] of rows) check(`contradiction: ${name}`, ok(r), JSON.stringify(r));
  check('Adrift replaces "Under way · dead in the water"', M.shipMotionWord(false, false, 0.05) === 'Adrift');
  check('crosshair: blunderbuss at rest is a dot', M.crosshairMode({ ...base, holding: 'blunderbuss' }) === 'dot');
  check('crosshair: blunderbuss aiming is the ring', M.crosshairMode({ ...base, holding: 'blunderbuss', aiming: true }) === 'ring');
}

// ── 4. dead DOM sweep: every UiRefs id has a writer ─────────────────────────
const uiRefs = readFileSync(join(ROOT, 'src/client/ui/UiRefs.ts'), 'utf8');
const keys = [...uiRefs.matchAll(/^\s{4}(\w+):\s*require/gm)].map((m) => m[1]);
const srcFiles = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts') && !p.endsWith('UiRefs.ts')) srcFiles.push(readFileSync(p, 'utf8')); } };
walk(join(ROOT, 'src/client'));
const all = srcFiles.join('\n');
check('UiRefs parsed', keys.length > 20, `${keys.length}`);
for (const k of keys) check(`UiRefs.${k} has a writer`, new RegExp(`\\bui\\.${k}\\b|\\bui\\[\\s*'${k}'`).test(all));

// ── 5. wiring ───────────────────────────────────────────────────────────────
const hud = readFileSync(join(ROOT, 'src/client/ui/HudController.ts'), 'utf8');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
check('HudController paints through hudMessagePlan', /hudMessagePlan\(/.test(hud));
check('HudController paints through hudVisibility', /hudVisibility\(/.test(hud));
check('HudController picks the crosshair via crosshairMode', /crosshairMode\(/.test(hud));
check('no "dead in the water" copy on the ship card', !/'dead in the water'/.test(hud));
check('dead #damage-vignette deleted', !/id="damage-vignette"/.test(html) && !/damageVignette/.test(uiRefs));
check('#server-notice banner exists', /id="server-notice"/.test(html));
check('#party-chip exists', /id="party-chip"/.test(html));
check('death bar has a next-target button', /id="death-next-btn"/.test(html));

console.log(`test-hud-visibility: ${passes} pass, ${fails} fail`);
process.exit(fails ? 1 : 0);
