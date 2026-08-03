#!/usr/bin/env node
// THE GATE ON "THIS NAME IS SAFE TO MERGE AWAY".
//
// The static batcher used to refuse every named mesh, which was safe and cost
// almost the whole saving: a GLB names every node it writes, so a pier arrived
// as 38 draw calls of which 36 were refused for carrying a Blender name no line
// of this repo reads. The rule now merges a name that came out of a GLB unless
// StaticBatcher's ADDRESSED_NAMES says otherwise — and that list is the entire
// safety argument, so it has to be impossible to forget.
//
// Two halves, and each one fails on its own:
//
//   SOURCE. Re-derive the addressed set from the source itself — every string
//   literal that reaches getObjectByName(…) or an `o.name === '…'` test in src/
//   or scripts/ — and fail when one is neither in ADDRESSED_NAMES nor in the
//   explicitly-classified NOT-AN-OBJECT list below. Adding a lookup without
//   listing the name breaks the build rather than the tavern door.
//
//   LIVE. Join a match and check the two things the source half cannot see: the
//   tavern's `door` — a GLB node name, therefore mergeable but for the list —
//   is still attached to the scene the Game holds a reference into; and a pier
//   is actually down at its material count instead of its mesh count.
//
// MUTATION PROOF — run, not asserted:
//   * drop 'door' from ADDRESSED_NAMES      → SOURCE half fails, naming the file
//     the lookup lives in (DockBuilder.ts)
//   * restore `if (mesh.name) return false` → LIVE dock budget fails on all ten
//     piers, 34–52 draws against a budget of 20
//   * add a getObjectByName('nope') in src/ → SOURCE half fails
//
// WHAT THE DOOR CHECK IS AND IS NOT. Dropping 'door' does NOT orphan the door
// today, and the check below does not catch it: the tavern's door carries a
// material no other mesh in the tavern uses, and a bucket of one is never
// merged. So the attachment assertion is an invariant kept honest by the source
// half, not a gate proven to fail on its own — say so rather than let a later
// reader take a passing line for a proof. It earns its place the day an asset
// gives two nodes one material and one of them is addressed.
//
//   PIRATES_GL=swiftshader node scripts/test-decor-batch.mjs
import { chromium } from 'playwright';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { browserArgs } from './lib/browser-args.mjs';
import { sessionQuery } from './perf-probe.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const URL_BASE = (process.env.PIRATES_BR_TEST_URL ?? 'http://127.0.0.1:3101').replace(/\/$/, '');

/**
 * Literals the greps find that do not name an Object3D.
 *
 * Every entry is classified on purpose: an unclassified literal is what makes
 * this test fail, and "it looked harmless" is exactly the reasoning the gate
 * exists to refuse.
 */
const NOT_AN_OBJECT_NAME = new Map([
  ['Deserter', 'a scoreboard row — player name'],
  ['Pirate', 'the default player name'],
  ['Grave_Dirt', 'a MATERIAL name (PropScatterer tints by material)'],
  ['Sand_Pad', 'a MATERIAL name (PropScatterer tints by material)'],
]);

/** Names the batcher is allowed to merge despite a lookup, with the reason. */
const MERGE_SAFE_ANYWAY = new Map([
  // (empty — every addressed literal is protected. Kept so a future exemption
  //  has to be written down next to its reason rather than deleted from a set.)
]);

function walkSources(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walkSources(path, out);
    else if (/\.(ts|mjs|js)$/.test(entry)) out.push(path);
  }
  return out;
}

function addressedLiterals() {
  const found = new Map();
  const SELF = join(ROOT, 'scripts/test-decor-batch.mjs');
  for (const file of [...walkSources(join(ROOT, 'src')), ...walkSources(join(ROOT, 'scripts'))]) {
    // This file's own prose quotes the very calls it hunts for.
    if (file === SELF) continue;
    // COMMENT LINES ARE NOT LOOKUPS. Both StaticBatcher's header and this test's
    // mutation recipe spell out `o.name === '…'` in prose, and a gate that
    // cannot read a sentence fails on the documentation for itself.
    const text = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n');
    for (const re of [/getObjectByName\(\s*['"]([^'"]+)['"]\s*\)/g, /\.name\s*===\s*['"]([^'"]+)['"]/g]) {
      for (const m of text.matchAll(re)) {
        if (!found.has(m[1])) found.set(m[1], file.slice(ROOT.length));
      }
    }
  }
  return found;
}

/** ADDRESSED_NAMES, read out of the source rather than imported — the batcher
 *  pulls in three and the whole asset library, and this half needs neither. */
function declaredAddressedNames() {
  const text = readFileSync(join(ROOT, 'src/client/world/island/StaticBatcher.ts'), 'utf8');
  const block = text.match(/ADDRESSED_NAMES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!block) throw new Error('ADDRESSED_NAMES not found in StaticBatcher.ts');
  return new Set([...block[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]));
}

const LIVE = () => {
  const g = window.__piratesBR;
  const scene = g.renderer.scene;

  // Is `node` still hanging off the scene the renderer draws?
  const attached = (node) => {
    for (let n = node; n; n = n.parent) if (n === scene) return true;
    return false;
  };

  const doors = [];
  scene.traverse((o) => { if (o.name === 'door') doors.push(o); });
  const registered = (g.tavernDoors ?? []).map((d) => ({ attached: attached(d.node), name: d.node.name }));

  // Draw calls under every `decor-dock`, and how many distinct materials those
  // draws use — the floor a merge cannot go below.
  const docks = [];
  for (const [, group] of g.islandMeshes ?? []) {
    const root = group.userData.detailRoot ?? group;
    root.traverse((o) => {
      if (o.name !== 'decor-dock') return;
      let draws = 0;
      const mats = new Set();
      o.traverse((n) => {
        if (!(n.isMesh || n.isPoints || n.isLine || n.isSprite)) return;
        draws += 1;
        const m = Array.isArray(n.material) ? n.material[0] : n.material;
        if (m) mats.add(m.uuid);
      });
      docks.push({ draws, mats: mats.size });
    });
  }
  return { doorsInScene: doors.length, registered, docks };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const failures = [];

  // ── source half ────────────────────────────────────────────────────
  const declared = declaredAddressedNames();
  const literals = addressedLiterals();
  for (const [name, where] of literals) {
    if (declared.has(name) || NOT_AN_OBJECT_NAME.has(name) || MERGE_SAFE_ANYWAY.has(name)) continue;
    failures.push(`unclassified node-name lookup '${name}' (${where}) — add it to ADDRESSED_NAMES in `
      + 'src/client/world/island/StaticBatcher.ts, or classify it in this test');
  }
  console.log(`  source: ${literals.size} name lookups, ${declared.size} addressed names declared`);

  // ── live half ──────────────────────────────────────────────────────
  const browser = await chromium.launch({ args: browserArgs(['--mute-audio']) });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  try {
    page.on('pageerror', (e) => console.error(`  [pageerror] ${String(e.message).slice(0, 200)}`));
    await page.goto(`${URL_BASE}/?${sessionQuery(['debug', 'quality=low'])}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 240_000 });
    await sleep(14_000);
    const live = await page.evaluate(LIVE);

    // 1. Every registered tavern door is still in the graph. This is the check
    //    that catches a merge eating a node someone is holding: the reference
    //    survives the merge, so nothing throws — the door simply stops existing.
    if (live.registered.length === 0) {
      failures.push('no tavern doors registered — the live half proved nothing');
    }
    for (const d of live.registered) {
      if (!d.attached) failures.push(`a registered tavern door ('${d.name}') is no longer parented to the scene`);
    }
    console.log(`  live: ${live.registered.length} registered tavern doors, ${live.doorsInScene} 'door' nodes in scene`);

    // 2. A pier is at its material count, not its mesh count. 38.2 draws per
    //    copy before the rule changed, 16.0 after, and 16.0 is the number of
    //    distinct materials in the pier — i.e. the batcher is exhausted. The
    //    budget sits just above the material floor so a REGRESSION fails and an
    //    asset gaining a material does not.
    if (live.docks.length === 0) failures.push('no decor-dock found — the dock budget proved nothing');
    for (const d of live.docks) {
      const budget = d.mats + 4;
      if (d.draws > budget) {
        failures.push(`a decor-dock draws ${d.draws} times for ${d.mats} materials (budget ${budget}) — `
          + 'the static batcher stopped merging it');
      }
    }
    const worst = live.docks.reduce((a, b) => (b.draws > a.draws ? b : a), { draws: 0, mats: 0 });
    console.log(`  live: ${live.docks.length} piers, worst ${worst.draws} draws / ${worst.mats} materials`);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  if (failures.length > 0) {
    console.error('\nFAIL — decor batching');
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log('PASS — decor batching');
}

main().catch((e) => { console.error(e); process.exit(1); });
