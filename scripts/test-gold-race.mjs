#!/usr/bin/env node
// GOLD RACE PRESENTATION + D19 SPAWN KIT (b3.5c; D18, D19, mechanicshud-12/13).
//   D18: the chip is plain gold (no "/8000"); the "Gold race: <leader> 4,100 / 8,000"
//   line appears only once a CREW (summed like Match.crewGold) is past 50 %;
//   the end board ranks placement (winner, survivors, last death first) with
//   gold (plunder) the order between survivors.
//   D19: the spawn kit keeps four weapons; the Wrecker's Glass spawns with
//   reserve 2 (ammo crate still refills to reserveMax) and is never aim-assisted.
// Run: node --import tsx scripts/test-gold-race.mjs
import fs from 'node:fs';
const { goldRacePlan } = await import('../src/client/ui/goldRace.ts');
const { ECONOMY, WEAPONS, WRECKERS_GLASS_SPAWN_RESERVE } = await import('../src/shared/constants/index.ts');
const { WeaponSystem } = await import('../src/server/systems/WeaponSystem.ts');
const { aimAssistAllowed } = await import('../src/client/input/AimAssist.ts');

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };
const T = ECONOMY.GOLD_WIN_TARGET;
const P = (id, name, gold, shipId, state = 'alive') => ({ id, name, gold, shipId, state });

// 1. Chip: plain gold, never the target.
let v = goldRacePlan([P('me', 'Me', 1234, 's1'), P('b', 'Mara', 900, 's2')], 'me');
ok(v.chip === '1,234', `chip is plain gold "${v.chip}"`);
ok(!v.chip.includes('/') && !v.chip.includes(String(T)), 'chip never shows the target');
ok(v.line === null, 'no race line while every crew is under 50 %');
// 2. Exactly 50 % is not "past" it.
v = goldRacePlan([P('me', 'Me', 0, 's1'), P('b', 'Mara', T / 2, 's2')], 'me');
ok(v.line === null, `no race line at exactly 50 % (${T / 2})`);
// 3. Past 50 %: "Gold race: Mara 4,100 / 8,000".
v = goldRacePlan([P('me', 'Me', 300, 's1'), P('b', 'Mara', 4100, 's2')], 'me', 8000);
ok(v.line === 'Gold race: Mara 4,100 / 8,000', `race line "${v.line}"`);
ok(v.chip === '300', 'chip stays your own plain gold once the race shows');
// 4. Crew gold is summed per hull (duos: 2,100 + 2,000 = 4,100 > 4,000).
v = goldRacePlan([P('a', 'Ann', 2100, 's9'), P('c', 'Cid', 2000, 's9'), P('me', 'Me', 3900, 's1')], 'me', 8000);
ok(v.line === 'Gold race: Ann 4,100 / 8,000', `crew sum leads, richest member named: "${v.line}"`);
// 5. The eliminated do not count (Match.crewGold skips them).
v = goldRacePlan([P('a', 'Ann', 2100, 's9'), P('c', 'Cid', 2000, 's9', 'eliminated'), P('me', 'Me', 10, 's1')], 'me', 8000);
ok(v.line === null, 'an eliminated crewmate\'s gold leaves the race total');
// 6. Your own crew leading reads "You".
v = goldRacePlan([P('me', 'Me', 5000, 's1'), P('b', 'Mara', 4500, 's2')], 'me', 8000);
ok(v.line === 'Gold race: You 5,000 / 8,000' && v.leaderIsYou, `you lead: "${v.line}"`);

// 7. HUD source: the chip no longer prints "/GOLD_WIN_TARGET"; the objective consults the plan.
const hud = fs.readFileSync(new URL('../src/client/ui/HudController.ts', import.meta.url), 'utf8');
ok(!/goldAmount\.textContent\s*=\s*`\$\{player\.gold\}\/\$\{ECONOMY\.GOLD_WIN_TARGET\}`/.test(hud), 'HudController chip is not "gold/target"');
ok(/goldRacePlan\(this\.view\.state\?\.players \?\? \[\], this\.view\.localPlayerId\)\.line/.test(hud), 'objective line reads goldRacePlan().line');
// 8. End board: winner, then survivors richest first, then the eliminated last death first.
const match = fs.readFileSync(new URL('../src/server/core/Match.ts', import.meta.url), 'utf8');
const board = match.slice(match.indexOf('private buildEndBoard('), match.indexOf('private handleMessage('));
const iWin = board.indexOf('if (winnerPlayer) take(winnerPlayer.id)');
const iAlive = board.indexOf('r.alive && !taken.has(r.playerId)).sort((a, b) => b.gold - a.gold)');
const iDead = board.indexOf('[...this.eliminationOrder].reverse()');
ok(iWin > 0 && iAlive > iWin && iDead > iAlive, 'end board ranks placement (winner > survivors by plunder > last death first)');

// 9. D19 spawn kit.
const kit = new WeaponSystem().createDefaultWeapons();
ok(kit.length === 4, `spawn kit keeps 4 weapons (${kit.map((w) => w.weaponId).join(', ')})`);
const glass = kit.find((w) => w.weaponId === 'eye_of_reach');
ok(WRECKERS_GLASS_SPAWN_RESERVE === 2 && glass?.reserve === 2 && glass?.ammo === 1, `Wrecker's Glass spawns 1 | ${glass?.reserve} (want 1 | 2)`);
ok(kit.filter((w) => w.weaponId !== 'eye_of_reach' && w.weaponId !== 'cutlass').every((w) => w.reserve === WEAPONS[w.weaponId].reserveMax),
  'the other firearms spawn with a full reserve');
for (const scheme of ['touch', 'gamepad']) {
  ok(!aimAssistAllowed({ scheme, enabled: true, context: 'foot', weaponId: 'eye_of_reach', scoped: false }),
    `no aim assist on the Glass (${scheme})`);
}
ok(aimAssistAllowed({ scheme: 'touch', enabled: true, context: 'foot', weaponId: 'flintknock', scoped: false }),
  'control: the pistol is assisted on touch (the row above can fail)');

console.log(fails ? `\nFAIL ${fails}` : '\nPASS test-gold-race');
process.exit(fails ? 1 : 0);
