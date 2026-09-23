#!/usr/bin/env node
// critique-06 / D37 — EVERY SHIPPED GLB HAS A SOURCE, AND NONE IS GENERATOR OUTPUT.
//
// "No AI slop" was only ever checked structurally (bone counts, tri bands), so a
// text-to-3D mesh dropped into public/assets/models would have passed every gate.
// This suite makes provenance a gate failure, not a review comment:
//
//   1. every GLB in public/assets/models has a row in PROVENANCE.json, no row is
//      an orphan, and the committed file equals a fresh `provenance-scan` (a new
//      or renamed GLB without a rescan FAILS);
//   2. a script row names a scripts/blender build script that exists, is not a
//      helper module, exports GLBs (itself or through an exec'd helper) and still
//      carries the literal output name (a dangling script FAILS);
//   3. a LICENSES.md row is CC0 or CC-BY with an http(s) source URL and an author;
//   4. no generator string (the banned text/image-to-3D tools, their API hosts,
//      text-to-3d / image-to-3d calls) in any GLB's asset.generator,
//      asset.copyright or any extras object, nor in any text file under
//      scripts/ or src/;
//   5. a script-built GLB's asset.generator is the Blender exporter (or a
//      declared packer: gltfpack / glTF-Transform for the b3.1a pack step).
//
// SELF-TEST FIRST, every run: the auditor is pointed at throwaway fixtures and
// must pass a clean one and FAIL each of: a GLB whose asset.generator is a
// generator tool, a GLB with no PROVENANCE row, a scripts/ file calling a
// text-to-3D API, a row whose script is gone, a CC-BY-NC licence row, and a
// generator string hidden in node extras. A gate that cannot fail is a bug.
//
// Run: node scripts/test-asset-provenance.mjs
//      [--models <dir>] [--provenance <file>] [--scripts <dir>] [--text <dir>]...
//      (overrides point the REAL check at another tree: the red-first runs)
// Regenerate the file after adding/renaming a GLB: node scripts/provenance-scan.mjs
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, auditProvenance, scanProvenance, provenanceDoc } from './provenance-scan.mjs';

let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ FAIL: ${label}${detail ? `\n      ${detail}` : ''}`); }
}

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const texts = args.flatMap((a, i) => (a === '--text' ? [args[i + 1]] : []));

/** Rewrite a GLB's JSON chunk (keeps the BIN chunk byte for byte). */
function patchGlb(src, dst, mutate) {
  const b = readFileSync(src);
  const len = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + len).toString('utf8'));
  mutate(json);
  let text = Buffer.from(JSON.stringify(json), 'utf8');
  const pad = (4 - (text.length % 4)) % 4;
  text = Buffer.concat([text, Buffer.alloc(pad, 0x20)]);
  const rest = b.subarray(20 + len);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + text.length + rest.length, 8);
  head.writeUInt32LE(text.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  writeFileSync(dst, Buffer.concat([head, text, rest]));
}

// ── self-test on fixtures ────────────────────────────────────────────────────
console.log('self-test (fixtures must fail):');
const tmp = mkdtempSync(join(tmpdir(), 'pbr-provenance-'));
try {
  const realModels = join(ROOT, 'public/assets/models');
  const realBlender = join(ROOT, 'scripts/blender');
  /** One fixture tree: models/{bedroll,crate}.glb, blender/{build_camp,build_props}.py, text/. */
  const fixture = (name, { glbMutate, extraGlb, extraText, dropScript, licenseRow } = {}) => {
    const d = join(tmp, name), models = join(d, 'models'), blender = join(d, 'blender'), text = join(d, 'text');
    for (const p of [models, blender, text]) mkdirSync(p, { recursive: true });
    for (const s of ['build_camp.py', 'build_props.py']) copyFileSync(join(realBlender, s), join(blender, s));
    copyFileSync(join(realModels, 'crate.glb'), join(models, 'crate.glb'));
    patchGlb(join(realModels, 'bedroll.glb'), join(models, 'bedroll.glb'), glbMutate ?? (() => {}));
    writeFileSync(join(text, 'ok.mjs'), '// a tripod, sea luma, corroding iron: ordinary words\n');
    const cfg = { modelsDir: models, scriptsDir: blender, textRoots: [text], skipFiles: [], overrides: {} };
    const { rows } = scanProvenance(cfg);
    if (licenseRow) {
      writeFileSync(join(models, 'LICENSES.md'), `| File | Source | Author | License |\n|---|---|---|---|\n${licenseRow}\n`);
      copyFileSync(join(realModels, 'crate.glb'), join(models, 'lic_prop.glb'));
      rows.push({ glb: 'lic_prop.glb', kind: 'license', ...(() => { const c = licenseRow.split('|').map((x) => x.trim()); return { source: c[2], author: c[3], license: c[4] }; })() });
    }
    writeFileSync(join(models, 'PROVENANCE.json'), JSON.stringify(provenanceDoc(rows), null, 1));
    if (extraGlb) copyFileSync(join(realModels, 'crate.glb'), join(models, extraGlb));
    if (extraText) writeFileSync(join(text, 'fetch_mesh.mjs'), extraText);
    if (dropScript) rmSync(join(blender, dropScript));
    return auditProvenance({ ...cfg, provenancePath: join(models, 'PROVENANCE.json'), licensesPath: join(models, 'LICENSES.md') });
  };
  const has = (res, re) => res.failures.some((f) => re.test(f));
  const show = (res) => res.failures.slice(0, 3).join(' | ') || '(no failures)';

  const clean = fixture('clean');
  expect(`clean fixture passes (2 GLBs, 2 script rows): ${show(clean)}`, clean.failures.length === 0 && clean.stats.scriptRows === 2);

  const gen = fixture('generator', { glbMutate: (j) => { j.asset.generator = 'Hunyuan3D'; } });
  expect(`asset.generator 'Hunyuan3D' FAILS: ${show(gen)}`, has(gen, /generator string in bedroll\.glb asset\.generator/));

  const copy = fixture('copyright', { glbMutate: (j) => { j.asset.copyright = 'made with Meshy'; } });
  expect(`asset.copyright naming a generator FAILS: ${show(copy)}`, has(copy, /asset\.copyright: Meshy/));

  const ext = fixture('extras', { glbMutate: (j) => { j.nodes[0].extras = { source: 'tripo3d export' }; } });
  expect(`a generator string in node extras FAILS: ${show(ext)}`, has(ext, /\$\.nodes\[0\]\.extras: Tripo/));

  const miss = fixture('missing-row', { extraGlb: 'mystery_prop.glb' });
  expect(`a GLB with no PROVENANCE row FAILS: ${show(miss)}`, has(miss, /missing row: mystery_prop\.glb/));

  const api = fixture('api-call', {
    extraText: "const r = await fetch('https://api.example.com/v2/text-to-3d', { method: 'POST', body: JSON.stringify({ prompt: 'pirate' }) });\n",
  });
  expect(`a scripts/ file calling a text-to-3D API FAILS: ${show(api)}`, has(api, /generator string in .*fetch_mesh\.mjs:1: text\/image-to-3D/));

  const host = fixture('api-host', { extraText: "requests.post('https://hyperhuman.deemos.com/api/v2/rodin', json=job)\n" });
  expect(`a scripts/ file posting to a generator host FAILS: ${show(host)}`, has(host, /fetch_mesh\.mjs:1: (Rodin|Hyper3D)/));

  const dangling = fixture('dangling', { dropScript: 'build_camp.py' });
  expect(`a row whose build script is gone FAILS: ${show(dangling)}`, has(dangling, /dangling script: bedroll\.glb/));

  const nc = fixture('license-nc', { licenseRow: '| lic_prop.glb | https://example.org/prop | Someone | CC-BY-NC 4.0 |' });
  expect(`a CC-BY-NC licence row FAILS: ${show(nc)}`, has(nc, /licence row: lic_prop\.glb licence "CC-BY-NC 4\.0" is not CC0\/CC-BY/));

  const okLic = fixture('license-ok', { licenseRow: '| lic_prop.glb | https://example.org/prop | Someone | CC0 |' });
  expect(`a CC0 licence row with URL + author passes: ${show(okLic)}`, okLic.failures.length === 0 && okLic.stats.licenseRows === 1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ── the real tree ───────────────────────────────────────────────────────────
console.log('repo:');
const cfg = {};
if (opt('--models')) cfg.modelsDir = opt('--models');
if (opt('--provenance')) cfg.provenancePath = opt('--provenance');
if (opt('--scripts')) cfg.scriptsDir = opt('--scripts');
if (texts.length) cfg.textRoots = texts;
const res = auditProvenance(cfg);
const { glbs, scriptRows, licenseRows, textFiles, generators } = res.stats;
console.log(`  ${glbs} GLBs: ${scriptRows} script rows, ${licenseRows} licence rows; ${textFiles} text files scanned; generators ${JSON.stringify(generators)}`);
for (const f of res.failures.slice(0, 25)) console.error(`    - ${f}`);
if (res.failures.length > 25) console.error(`    ... +${res.failures.length - 25} more`);
expect(`every GLB has a source and no generator string anywhere (${res.failures.length} failures)`, res.failures.length === 0);
expect('not vacuous: GLBs found, every one is a script or licence row, text files scanned', glbs > 0 && scriptRows + licenseRows === glbs && textFiles > 100);

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
