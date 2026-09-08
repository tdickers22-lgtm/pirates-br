#!/usr/bin/env node
/**
 * THE HUD's ids ARE A CONTRACT, AND NOTHING CHECKED IT.
 *
 * The client reaches into the document by string: `document.getElementById('ship-status')`,
 * `querySelector('#wg-fill')`. TypeScript cannot see through a string literal, so an id
 * renamed in index.html (or deleted with the panel it belonged to) type-checks perfectly and
 * fails silently at runtime — the element is null, the guard swallows it, and one HUD line
 * simply stops updating. That is exactly how the HUD accumulated dead panels: nobody could
 * tell a live id from a fossil.
 *
 * This gate reads both sides and grades them:
 *
 *   MISSING  — an id the client asks for that no markup declares. Always a FAIL: it is a
 *              line of HUD that can never paint.
 *   ORPHAN   — an id inside the HUD block (between the HUD-BLOCK sentinels) that no source
 *              file and no stylesheet mentions. FAIL too: dead markup is what the
 *              simplification pass exists to delete, and a panel nobody drives is a panel
 *              nobody should ship. Outside the block (menu, end screen) the same finding is
 *              printed as advice, because those regions belong to other lanes.
 *
 * Ids created at runtime (feed rows, crew rows, wheel entries) never appear in markup, so
 * the scan also accepts an id that some source file ASSIGNS (`.id = 'x'`, `id="x"` inside a
 * template string). Anything genuinely dynamic goes in DYNAMIC_OK below with a reason.
 *
 * node scripts/tools/check-hud-ids.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;

/** ids the client legitimately builds at runtime or reads from an injected clone. */
const DYNAMIC_OK = new Set([
  // MenuController clones #legend-body into the How to Play panel; the clone is
  // re-hosted under a different id by the mirror, not authored in index.html.
  'howto-legend-clone',
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|mts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const css = ['src/client/styles/menu.css', 'src/client/styles/hud.css']
  .map((f) => readFileSync(join(ROOT, f), 'utf8'))
  .join('\n');
const sources = walk(join(ROOT, 'src')).map((f) => ({ f, text: readFileSync(f, 'utf8') }));
const allSrc = sources.map((s) => s.text).join('\n');

/** Declared: every id="..." in the shipped markup. */
const declared = new Set([...html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));

/** Asked for: getElementById('x'), querySelector('#x'), requireElement('x'), must('x'). */
const asked = new Map(); // id -> first file that asks
for (const { f, text } of sources) {
  const ids = [
    ...[...text.matchAll(/getElementById\(\s*['"`]([A-Za-z0-9_-]+)['"`]/g)].map((m) => m[1]),
    ...[...text.matchAll(/querySelector(?:All)?\(\s*['"`]#([A-Za-z0-9_-]+)/g)].map((m) => m[1]),
    ...[...text.matchAll(/\b(?:requireElement|optionalElement|must)(?:<[^>]*>)?\(\s*['"`]([A-Za-z0-9_-]+)['"`]/g)].map((m) => m[1]),
  ];
  for (const id of ids) if (!asked.has(id)) asked.set(id, f.slice(ROOT.length));
}

/** Assigned at runtime: el.id = 'x' or an id="x" inside a template literal in source. */
const assigned = new Set([
  ...[...allSrc.matchAll(/\.id\s*=\s*['"`]([A-Za-z0-9_-]+)['"`]/g)].map((m) => m[1]),
  ...[...allSrc.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]),
]);

/** Ids built from a template (`slot-${i}`): accept the prefix. */
const templatePrefixes = [...allSrc.matchAll(/['"`]([A-Za-z][A-Za-z0-9_-]*-)\$\{/g)].map((m) => m[1]);
const builtByTemplate = (id) => templatePrefixes.some((pre) => id.startsWith(pre));

/** The in-match HUD subtree is graded strictly; the rest of the document is advisory. */
const hudBlock = html.slice(
  html.indexOf('<!-- HUD-BLOCK-START'),
  html.indexOf('<!-- HUD-BLOCK-END'),
);
if (hudBlock.length < 100) {
  console.log('FAIL check-hud-ids: HUD-BLOCK-START/END sentinels missing from index.html');
  process.exit(1);
}
const inHud = new Set([...hudBlock.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));

const missing = [];
for (const [id, file] of asked) {
  if (declared.has(id) || assigned.has(id) || DYNAMIC_OK.has(id)) continue;
  missing.push(`${id}  (asked for by ${file})`);
}

const orphans = [];
const advisory = [];
for (const id of declared) {
  if (asked.has(id) || DYNAMIC_OK.has(id) || builtByTemplate(id)) continue;
  // A styled id is doing a job even if no code touches it (pure-CSS panels).
  if (new RegExp(`#${id}\\b`).test(css)) continue;
  if (new RegExp(`['"\`#]${id}\\b`).test(allSrc)) continue;
  (inHud.has(id) ? orphans : advisory).push(id);
}

console.log(`OK: index.html declares ${declared.size} ids (${inHud.size} in the HUD block); src asks for ${asked.size}`);
for (const m of missing) console.log(`✗ MISSING ${m}`);
for (const o of orphans) console.log(`✗ ORPHAN  ${o}  (in the HUD block, driven by nothing)`);
for (const a of advisory) console.log(`! unused id outside the HUD block: ${a}`);

if (missing.length || orphans.length) {
  console.log(`FAIL check-hud-ids: ${missing.length} missing, ${orphans.length} orphan`);
  process.exit(1);
}
console.log('✓ every id the client reads exists, and every id in the markup is used');
console.log('PASS check-hud-ids');
