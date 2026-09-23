#!/usr/bin/env node
// test-ammo-truth (b1.6e, mechanicshud-02).
//
// The HUD said every gun had infinite reserve ("1/∞") while the server reserve
// was 5, and R on an empty reserve did nothing at all: no sound, no line. This
// gate drives the REAL WeaponSystem through 6 blunderbuss shots and checks the
// SHIPPED weapon-card expression (extracted from HudController) against server
// truth at every step, then that the 7th reload is refused with 'no_ammo' and
// that Match sends that refusal back for R and for the trigger.
//
//   node --import tsx scripts/test-ammo-truth.mjs
import { readFileSync } from 'node:fs';
import { WeaponSystem } from '../src/server/systems/WeaponSystem.ts';
import { WEAPONS } from '../src/shared/constants/index.ts';

const failures = [];
let checks = 0;
const expect = (ok, label) => { checks += 1; console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failures.push(label); };

const hud = readFileSync(new URL('../src/client/ui/HudController.ts', import.meta.url), 'utf8');
const match = readFileSync(new URL('../src/server/core/Match.ts', import.meta.url), 'utf8');

// The shipped card expression: `weapon && WEAPONS[...].ammoMax > 0 ? `${weapon.ammo} | ${weapon.reserve}` : ''`.
const m = /ammoEl\.textContent = (weapon && WEAPONS\[weapon\.weaponId\]\.ammoMax > 0\s*\?\s*`[^`]*`\s*:\s*'[^']*')/.exec(hud);
expect(!!m, 'the weapon-card ammo expression is found in HudController (extraction not vacuous)');
// eslint-disable-next-line no-new-func
const cardText = m ? new Function('weapon', 'WEAPONS', `return ${m[1]};`) : () => '';
const truth = (w) => `${w.ammo} | ${w.reserve}`;

const ws = new WeaponSystem(() => 0.5);
const player = {
  id: 'p1', crewId: 'c1', shipId: null, state: 'alive', atCannon: false, activeSlot: 0,
  position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, knockbackVelocity: { x: 0, y: 0, z: 0 },
  shipBoundaryGraceTimer: 0, crouching: false, grounded: true, weapons: ws.createDefaultWeapons(),
};
const gun = player.weapons[0];
expect(gun.weaponId === 'blunderbuss' && gun.ammo === 1 && gun.reserve === 5, `start: blunderbuss ${truth(gun)} (1 | 5)`);
expect(cardText(gun, WEAPONS) === truth(gun), `step 0 card "${cardText(gun, WEAPONS)}" == server "${truth(gun)}"`);

let shots = 0;
for (let i = 1; i <= 6; i++) {
  const traces = ws.tryFire(player, null, 0, 0, 0);
  if (traces.length > 0) shots += 1;
  expect(cardText(gun, WEAPONS) === truth(gun), `shot ${i}: card "${cardText(gun, WEAPONS)}" == server "${truth(gun)}"`);
  ws.update(WEAPONS[gun.weaponId].reloadTime + 0.1, [player]);
  expect(cardText(gun, WEAPONS) === truth(gun), `after reload ${i}: card "${cardText(gun, WEAPONS)}" == server "${truth(gun)}"`);
}
expect(shots === 6, `6 shots discharged (got ${shots})`);
expect(gun.ammo === 0 && gun.reserve === 0, `dry after 6: ${truth(gun)}`);

const why = ws.startReload(player);
expect(why === 'no_ammo', `7th reload -> reason ${why} (want no_ammo)`);
expect(gun.reloading === false, '7th reload starts nothing');
const dry = ws.tryFire(player, null, 0, 0, 0);
expect(dry.length === 0 && ws.lastRefusal === 'no_ammo', `trigger on a dry gun -> no shot, reason ${ws.lastRefusal}`);
// Negative control: a gun with reserve left is NOT refused.
player.weapons[1].ammo = 0;
player.activeSlot = 1;
expect(ws.startReload(player) === null && player.weapons[1].reloading, 'control: a reload with reserve left starts and is not refused');

expect(/const noReload = this\.weapons\.startReload\(player\);\s*if \(noReload\) this\.sendInteractRefused\(client, 'reload', noReload\);/.test(match),
  "Match: R on an empty reserve sends interact_refused {intent:'reload', reason:'no_ammo'}");
expect(/traces\.length === 0 \? this\.weapons\.lastRefusal : null[\s\S]{0,120}sendInteractRefused\(client, 'fire', held\)/.test(match),
  "Match: a dry trigger sends interact_refused {intent:'fire', reason:'no_ammo'}");

// No '∞' for firearms: every '∞' in HudController sits in the ammoMax === 0 (melee) branch.
const lines = hud.split('\n');
const inf = lines.map((l, i) => [l, i]).filter(([l]) => l.includes('∞'));
const offenders = inf.filter(([, i]) => !lines.slice(Math.max(0, i - 3), i).some((l) => /ammoMax === 0/.test(l)));
expect(offenders.length === 0, `no '∞' readout for firearms in HudController (${offenders.map(([, i]) => `:${i + 1}`).join(' ') || 'none'})`);
expect(!/\/∞/.test(hud), "no '/∞' reserve string anywhere in HudController");

console.log(`\ntest-ammo-truth: ${checks} checks, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
