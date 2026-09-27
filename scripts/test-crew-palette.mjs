#!/usr/bin/env node
/**
 * test-crew-palette (b3.5d; crossdevice-15, vm:mechanicshud:5, PLAN D33).
 *
 * Grades the crew dye palette the way a colour-blind player meets it:
 *  1. The maths is real: CIEDE2000 known answers (Sharma, Wu & Dalal 2005
 *     test pairs) and the Machado 2009 simulation collapses red/green under
 *     deut/prot and blue/yellow under trit (a no-op simulation FAILS here).
 *  2. Every pair of the twelve dyes clears CREW_MIN_DELTA_E (20) under
 *     simulated deuteranopia, protanopia, tritanopia AND normal vision.
 *  3. For every mode's crew count (Solo 12, Duos 9, Squads 6) the greedy
 *     pickCrewColor sequence, and a late join after a founder, only ever puts
 *     distinct dyes >= 20 apart in one match.
 *  4. Match.ts dyes every hull (bot fill AND human crews) through
 *     pickCrewColor; no private TEAM_COLORS list survives.
 *  5. The accessibility settings: colour-blind HUD crew colours, reduced
 *     flashing, HUD text scale (parse/clamp in hudModel.ts, wired in
 *     MenuController and the crew strip in HudController).
 *
 * Run: node --import tsx scripts/test-crew-palette.mjs
 */
import fs from 'node:fs';
const P = await import('../src/shared/crewPalette.ts');
const { MODES } = await import('../src/shared/constants/index.ts');
const hud = await import('../src/client/ui/hudModel.ts');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log(`  FAIL ${msg}`); } };
const hex = (c) => '0x' + c.toString(16).toUpperCase().padStart(6, '0');

// 1. The maths can fail.
const sharma = [
  [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
  [[50, 0, 0], [50, -1, 2], 2.3669],
  [[50, 2.5, 0], [73, 25, -18], 27.1492],
  [[50, 2.5, 0], [50, 3.1736, 0.5854], 1.0],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
];
for (const [a, b, want] of sharma) {
  const got = P.deltaE2000(a, b);
  ok(Math.abs(got - want) < 1e-3, `CIEDE2000 ${JSON.stringify(a)} vs ${JSON.stringify(b)} = ${got.toFixed(4)}, want ${want}`);
}
const redGreen = (m) => P.visionDeltaE(0xCC3333, 0x33AA33, m);
ok(redGreen('deut') < redGreen('normal') * 0.5, `deut sim collapses red/green (${redGreen('deut').toFixed(1)} vs normal ${redGreen('normal').toFixed(1)})`);
ok(redGreen('prot') < redGreen('normal') * 0.5, `prot sim collapses red/green (${redGreen('prot').toFixed(1)})`);
const blueYellow = (m) => P.visionDeltaE(0x3366CC, 0x66CC66, m);
ok(P.visionDeltaE(0x3399CC, 0x99CC33, 'trit') < P.visionDeltaE(0x3399CC, 0x99CC33, 'normal'), 'trit sim changes blue/green-yellow distances');
ok(blueYellow('trit') !== blueYellow('normal'), 'trit sim is not the identity');

// 2. The palette itself.
const pal = P.CREW_PALETTE;
const maxCrews = Math.max(...Object.values(MODES).map((m) => m.crews));
ok(pal.length >= maxCrews, `palette holds ${pal.length} dyes, the biggest mode fields ${maxCrews} crews`);
ok(new Set(pal).size === pal.length, 'palette dyes are distinct');
let worst = { d: Infinity };
for (let i = 0; i < pal.length; i++) {
  for (let j = i + 1; j < pal.length; j++) {
    for (const mode of P.VISION_MODES) {
      const d = P.visionDeltaE(pal[i], pal[j], mode);
      if (d < worst.d) worst = { d, a: pal[i], b: pal[j], mode };
      if (d < P.CREW_MIN_DELTA_E) ok(false, `${hex(pal[i])} vs ${hex(pal[j])} under ${mode}: dE2000 ${d.toFixed(1)} < ${P.CREW_MIN_DELTA_E}`);
      else pass++;
    }
  }
}
console.log(`  worst pair ${hex(worst.a)} vs ${hex(worst.b)} under ${worst.mode}: dE2000 ${worst.d.toFixed(2)} (bar ${P.CREW_MIN_DELTA_E})`);
ok(P.CREW_MIN_DELTA_E >= 20, 'the bar is not loosened below 20');

// 3. Greedy assignment per mode, and a late join after a founder.
for (const [id, spec] of Object.entries(MODES)) {
  const inUse = [];
  for (let n = 0; n < spec.crews; n++) inUse.push(P.pickCrewColor(inUse));
  ok(new Set(inUse).size === inUse.length, `${id}: ${spec.crews} crews get ${new Set(inUse).size} distinct dyes`);
  const min = P.minPairDeltaE(inUse);
  ok(min >= P.CREW_MIN_DELTA_E, `${id}: min co-present dE2000 ${min.toFixed(1)} >= ${P.CREW_MIN_DELTA_E}`);
  const afterFounder = inUse.slice(1);
  afterFounder.push(P.pickCrewColor(afterFounder));
  ok(P.minPairDeltaE(afterFounder) >= P.CREW_MIN_DELTA_E && new Set(afterFounder).size === afterFounder.length,
    `${id}: a late join after a founder still gets a distinct safe dye`);
}
ok(P.pickCrewColor([]) === pal[0], 'first hull gets palette[0]');
const two = [pal[0]];
const second = P.pickCrewColor(two);
const bestSecond = Math.max(...pal.slice(1).map((c) => P.worstDeltaE(c, pal[0])));
ok(Math.abs(P.worstDeltaE(second, pal[0]) - bestSecond) < 1e-9, 'greedy: the second hull gets the dye farthest from the first');

// 4. Match wiring (static).
const match = fs.readFileSync(new URL('../src/server/core/Match.ts', import.meta.url), 'utf8');
ok(!/const TEAM_COLORS\s*=/.test(match), 'Match.ts no longer carries its own TEAM_COLORS list');
ok(/from '\.\.\/\.\.\/shared\/crewPalette\.js'/.test(match), 'Match.ts imports shared/crewPalette');
ok((match.match(/pickCrewColor\(/g) ?? []).length >= 2, 'Match.ts dyes bot hulls and human crews through pickCrewColor');

// 5. Accessibility settings.
ok(typeof hud.parseA11ySettings === 'function' && typeof hud.hudCrewColor === 'function', 'hudModel exports parseA11ySettings + hudCrewColor');
if (typeof hud.parseA11ySettings === 'function') {
  const d = hud.parseA11ySettings(null);
  ok(d.colorVision === 'normal' && d.reducedFlashing === false && d.hudTextScale === 1, 'defaults: normal vision, flashing on, text 100 %');
  const c = hud.parseA11ySettings(JSON.stringify({ colorVision: 'deut', reducedFlashing: true, hudTextScale: 9 }));
  ok(c.colorVision === 'deut' && c.reducedFlashing === true && c.hudTextScale === hud.HUD_TEXT_SCALE_MAX, 'parse keeps deut + reduced flashing, clamps text scale');
  ok(hud.parseA11ySettings(JSON.stringify({ colorVision: 'purple', hudTextScale: 0.1 })).colorVision === 'normal', 'unknown vision mode -> normal');
  ok(hud.parseA11ySettings(JSON.stringify({ hudTextScale: 0.1 })).hudTextScale === hud.HUD_TEXT_SCALE_MIN, 'text scale clamps low');
  ok(hud.parseA11ySettings('{corrupt').colorVision === 'normal', 'corrupt record -> defaults');
}
if (typeof hud.hudCrewColor === 'function') {
  ok(hud.hudCrewColor(pal[3], 'normal') === '#' + pal[3].toString(16).padStart(6, '0'), 'normal vision: HUD paints the hull dye');
  for (const mode of P.CVD_MODES) {
    const mapped = pal.map((c) => parseInt(hud.hudCrewColor(c, mode).slice(1), 16));
    ok(new Set(mapped).size === pal.length, `${mode}: HUD crew colours stay one per crew`);
    let min = Infinity;
    for (let i = 0; i < mapped.length; i++) for (let j = i + 1; j < mapped.length; j++) min = Math.min(min, P.visionDeltaE(mapped[i], mapped[j], mode));
    const hull = P.minPairDeltaE(pal, [mode]);
    ok(min >= hull - 1e-9, `${mode}: colour-blind HUD colours are at least as far apart as the hull dyes (${min.toFixed(1)} vs ${hull.toFixed(1)})`);
  }
}
const menu = fs.readFileSync(new URL('../src/client/menu/MenuController.ts', import.meta.url), 'utf8');
for (const id of ['settings-color-vision', 'settings-reduced-flashing', 'settings-hud-text-scale']) ok(menu.includes(id), `MenuController mounts #${id}`);
ok(/applyA11ySettings\(/.test(menu), 'MenuController applies the settings to the document');
const hudCtl = fs.readFileSync(new URL('../src/client/ui/HudController.ts', import.meta.url), 'utf8');
ok(/hudCrewColor\(/.test(hudCtl), 'HudController paints the crew strip through hudCrewColor');

console.log(`${fail || !pass ? "FAIL" : "PASS"} test-crew-palette: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
