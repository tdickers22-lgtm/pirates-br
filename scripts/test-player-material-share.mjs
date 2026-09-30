#!/usr/bin/env node
// b1-ask-05 / b1.7b-heap: procedural pirates share one material per look.
// The renderer keeps a cloned uniform set (~4.8 KB heap) per drawn material; 35
// phone pirates were ~700 materials. Checks: two pirates of one crew share every
// material (health bar excepted, it is written per avatar), a recolour swaps to
// the new crew's set without touching another pirate, a corpse fade takes
// private copies first, and shared ones are registered so disposal skips them.
// Run: node --import tsx scripts/test-player-material-share.mjs
import * as THREE from 'three';
const { makePlayerMesh, applyPlayerTeamColor, ownPlayerMaterials } = await import('../src/client/rendering/factories/PlayerMeshFactory.ts');
const { assets } = await import('../src/client/assets/AssetLibrary.ts');
let fails = 0;
const expect = (label, ok, detail = '') => { console.log(`  ${ok ? '✓' : '✗ FAIL:'} ${label}${ok ? '' : ` ${detail}`}`); if (!ok) fails++; };
const mats = (root, skipHealth = true) => {
  const out = new Set();
  const hb = skipHealth ? root.userData.healthBar?.root : null;
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (let p = o; p; p = p.parent) if (p === hb) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) out.add(m);
  });
  return out;
};
const a = makePlayerMesh(0xc0392b, 'pirate', 'captain');
const b = makePlayerMesh(0xc0392b, 'pirate', 'captain');
const c = makePlayerMesh(0x2980b9, 'pirate', 'crew');
const ma = mats(a), mb = mats(b);
expect(`two same-crew pirates share every body material (${ma.size} looks)`, [...ma].every((m) => mb.has(m)) && ma.size === mb.size);
expect('every body material is registered shared (disposal skips it)', [...ma].every((m) => assets.isShared(m)));
const hbA = a.userData.healthBar.fill.material, hbB = b.userData.healthBar.fill.material;
expect('health bar fill stays per avatar (written every frame)', hbA !== hbB && !assets.isShared(hbA));
const total = new Set([...mats(a), ...mats(b), ...mats(c)]).size;
expect(`three pirates, two crews: <= 26 distinct materials (got ${total})`, total <= 26);
const coatBefore = a.userData.teamMaterials.coatMat.color.getHex();
applyPlayerTeamColor(b, 0x27ae60);
expect('recolouring one pirate leaves its crewmate untouched', a.userData.teamMaterials.coatMat.color.getHex() === coatBefore);
expect('the recoloured pirate wears the new colour', b.userData.teamMaterials.coatMat.color.getHex() === 0x27ae60
  && [...mats(b)].includes(b.userData.teamMaterials.coatMat));
ownPlayerMaterials(a);
const own = mats(a);
expect('a fading corpse holds only private copies', [...own].every((m) => !mb.has(m) && !assets.isShared(m)));
for (const m of own) m.opacity = 0.2;
expect('fading the corpse does not fade anyone else', [...mats(c)].every((m) => m.opacity === 1));
console.log(fails ? `\nplayer material share: ${fails} failure(s)` : '\nplayer material share: all green');
process.exit(fails ? 1 : 0);
