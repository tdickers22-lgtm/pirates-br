#!/usr/bin/env node
// PROVENANCE SCAN (critique gap 6a, D37, b1.1h).
//
// Every GLB that ships in public/assets/models must say where it came from:
//   * kind 'script'  — the scripts/blender build script that WRITES it, found by
//                      the literal output name in that script (a writer call such
//                      as build_keg("keg"), name = "rowboat", ("boulder_a", ...),
//                      "pirate_base.glb"), or for a <name>_far.glb the far-LOD
//                      builder that quotes <name> and writes f'{name}_far.glb';
//   * kind 'license' — a row of public/assets/models/LICENSES.md (third-party
//                      CC0 / CC-BY source with a URL, author and licence).
// Nothing else is a source. Output: public/assets/models/PROVENANCE.json (sorted,
// no hashes or line numbers, so it only changes when the asset set or its writers change).
//
//   node scripts/provenance-scan.mjs            # rescan and rewrite PROVENANCE.json
//   node scripts/provenance-scan.mjs --check    # rescan, exit 1 if the file drifted
//
// The auditor (`auditProvenance`) is what test-asset-provenance runs; it lives
// here so the scan and the gate can never disagree about a rule. Its checks:
//   1. every GLB on disk has a row in the committed PROVENANCE.json, no row names
//      a GLB that is gone, and the committed rows equal a fresh scan;
//   2. a script row names a script that exists under scripts/blender, is not a
//      helper module, can export, and still contains the literal output name;
//   3. a licence row is CC0 or CC-BY and carries an http(s) source URL + author;
//   4. no generator string (text/image-to-3D tools) in any GLB's asset.generator,
//      asset.copyright or any extras object, nor in any text file under scripts/
//      or src/ (a call to such an API is a gate failure, not a review comment);
//   5. a script row's asset.generator is a Blender export (or a declared packer).
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, join, basename, extname } from 'node:path';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Generator tools whose output is banned (D4, D37). Letter-bounded so ordinary
 * words do not trip them: "tripod" is not the tripo tool, "sea luma" is not the
 * luma tool, "corroding" is not the rodin tool; underscores still count as a
 * boundary so tool ids like generate_<tool>_model are caught.
 */
export const GENERATOR_PATTERNS = [
  ['Hunyuan3D', /hunyuan/i],
  ['Rodin', /(?<![a-z])rodin(?![a-z])/i],
  ['Hyper3D', /hyper[-_ ]?3d|deemos/i],
  ['Tripo', /(?<![a-z])tripo(?:[-_ ]?(?:3d|sr|ai))?(?![a-z])/i],
  ['Meshy', /(?<![a-z])meshy(?![a-z])/i],
  ['Luma', /luma[-_ ]?(?:ai|labs|genie)\b|lumalabs|luma\.ai/i],
  ['CSM', /(?<![a-z])csm(?:\.ai)?(?![a-z])/i],
  ['Kaedim', /kaedim/i],
  ['Sloyd', /sloyd/i],
  ['text/image-to-3D', /(?:text|image|img|txt)[-_ ]?(?:to|2)[-_ ]?(?:3d|mesh)(?![a-z])/i],
];

/** asset.generator values a script-built GLB may carry. */
export const EXPORTER_ALLOW = /Khronos glTF Blender I\/O|gltfpack|glTF-Transform|pirates-br _pirate_clips\.py/; // b3.2b: the clip library is written by the in-repo pure-Python writer (no Blender mesh, animation only)
export const LICENSE_OK = /^(?:CC0(?:[- ]1\.0)?|CC[- ]BY(?:[- ](?:3\.0|4\.0))?)$/i;

/**
 * Ambiguity resolutions: two scripts both carry a writer for the name. Each is a
 * decision with evidence; the auditor still checks the chosen script has the
 * literal. `alsoWrittenBy` stays in the row so the second writer is visible.
 */
export const OVERRIDES = {
  'shark.glb': {
    script: 'scripts/blender/build_fauna_v2.py',
    reason: 'shipped shark.glb is skinned (1 skin) = build_shark_hero/export_skinned in build_fauna_v2.py; build_animals.py build_shark() is the superseded rigid version (c0f262fb)',
  },
};

const SKIP_DIRS = new Set(['node_modules', '__pycache__', '.cache', '.git', 'dist', 'test-results']);
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.json', '.md', '.sh', '.html', '.glsl', '.vert', '.frag', '.txt', '.yml', '.yaml', '.toml', '.css']);
const EXPORT_CALL = /export_collection_vc\(|export_skinned\(|export_scene\.gltf\(|ship_asset\(/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Parse a .glb's JSON chunk (no BIN needed). Throws on a malformed file. */
export function readGlbJson(path) {
  const b = readFileSync(path);
  if (b.length < 20 || b.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glTF binary');
  const len = b.readUInt32LE(12);
  if (b.readUInt32LE(16) !== 0x4e4f534a) throw new Error('first chunk is not JSON');
  return JSON.parse(b.subarray(20, 20 + len).toString('utf8'));
}

function lineOf(text, index) { return text.slice(0, index).split('\n').length; }

/** Helper modules (leading _) that carry an export call, by file name. */
function exportingHelpers(scriptsDir) {
  if (!existsSync(scriptsDir)) return [];
  return readdirSync(scriptsDir).filter((f) => f.startsWith('_') && f.endsWith('.py'))
    .filter((f) => EXPORT_CALL.test(readFileSync(join(scriptsDir, f), 'utf8')));
}

/** A script exports if it calls an exporter itself or pulls in a helper that does (exec(open("_x.py")) / import _x). */
function exportsGlb(text, helpers) {
  if (EXPORT_CALL.test(text)) return true;
  return helpers.some((h) => text.includes(`${h}"`) || text.includes(`${h}'`) || new RegExp(`(?:^|\\n)\\s*(?:from|import)\\s+${esc(h.slice(0, -3))}\\b`).test(text));
}

function loadScripts(scriptsDir) {
  if (!existsSync(scriptsDir)) return [];
  const helpers = exportingHelpers(scriptsDir);
  return readdirSync(scriptsDir).filter((f) => f.endsWith('.py')).sort().map((f) => {
    const text = readFileSync(join(scriptsDir, f), 'utf8');
    return { file: f, text, helper: f.startsWith('_'), canExport: exportsGlb(text, helpers) };
  });
}

/**
 * Writer statement for `name`, tier 1 (code: name = "x", a call or tuple whose
 * first argument is "x", def f(name="x"), 'name': "x", "x.glb") before tier 2
 * (a bare x.glb, e.g. the header comment that names the output). Part names and
 * comparisons ("barrel" as a sub-mesh, style == "keg") are not writers.
 */
function writerHit(text, name) {
  const q = `['"]${esc(name)}['"]`;
  const tier1 = new RegExp(
    `(?:\\bname\\s*=\\s*${q}|\\(\\s*${q}|['"]name['"]\\s*:\\s*${q}|\\bdef \\w+\\(\\s*name\\s*=\\s*${q}|['"]${esc(name)}\\.glb['"])`);
  let m = tier1.exec(text);
  if (m) return { tier: 1, line: lineOf(text, m.index), match: m[0] };
  m = new RegExp(`\\b${esc(name)}\\.glb\\b`).exec(text);
  return m ? { tier: 2, line: lineOf(text, m.index), match: m[0] } : null;
}

function farHit(text, base) {
  if (!/_far\.glb/.test(text)) return null;
  const m = new RegExp(`['"]${esc(base)}['"]`).exec(text);
  return m ? { line: lineOf(text, m.index), match: m[0] } : null;
}

/** Rows of a markdown LICENSES table keyed by header names (file/asset, source/url, author, license). */
export function parseLicenses(path) {
  if (!path || !existsSync(path)) return [];
  const rows = [];
  let header = null;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) { header = null; continue; }
    const cells = line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    if (!header) { header = cells.map((c) => c.toLowerCase()); continue; }
    const get = (...keys) => { const i = header.findIndex((h) => keys.some((k) => h.includes(k))); return i >= 0 ? cells[i] ?? '' : ''; };
    const url = (get('source', 'url').match(/https?:\/\/[^\s)>\]]+/) || [''])[0];
    rows.push({ files: get('file', 'asset', 'glb'), url, author: get('author', 'creator'), license: get('licen').replace(/[`*]/g, '') });
  }
  return rows;
}

/** Fresh scan: one row per GLB, or an `unresolved` entry saying why not. */
export function scanProvenance({
  modelsDir = join(ROOT, 'public/assets/models'),
  scriptsDir = join(ROOT, 'scripts/blender'),
  licensesPath = join(modelsDir, 'LICENSES.md'),
  overrides = OVERRIDES,
} = {}) {
  const scripts = loadScripts(scriptsDir);
  const licenses = parseLicenses(licensesPath);
  const relScript = (f) => relative(ROOT, join(scriptsDir, f)).split('\\').join('/');
  const glbs = readdirSync(modelsDir).filter((f) => f.endsWith('.glb')).sort();
  const rows = [], unresolved = [];
  for (const glb of glbs) {
    const name = glb.slice(0, -4);
    const writers = scripts.filter((s) => !s.helper && s.canExport);
    let hits = writers.filter((s) => s.file !== 'build_far_lods.py' || name.endsWith('_far'))
      .map((s) => ({ s, hit: writerHit(s.text, name) })).filter((h) => h.hit);
    if (hits.some((h) => h.hit.tier === 1)) hits = hits.filter((h) => h.hit.tier === 1);
    let via = 'literal-name';
    if (!hits.length && name.endsWith('_far')) {
      via = 'far-lod';
      hits = writers.map((s) => ({ s, hit: farHit(s.text, name.slice(0, -4)) })).filter((h) => h.hit);
    }
    const lic = licenses.find((r) => new RegExp(`(?:^|[\\s,/\`])${esc(glb)}(?:$|[\\s,\`])`).test(r.files));
    const ov = overrides[glb];
    let pick = null;
    if (ov) pick = hits.find((h) => relScript(h.s.file) === ov.script) || null;
    else if (hits.length === 1) pick = hits[0];
    if (pick) {
      const row = { glb, kind: 'script', script: relScript(pick.s.file), via, literal: pick.hit.match };
      const others = hits.filter((h) => h !== pick).map((h) => relScript(h.s.file));
      if (others.length) row.alsoWrittenBy = others;
      if (ov) row.reason = ov.reason;
      rows.push(row);
    } else if (lic) {
      rows.push({ glb, kind: 'license', source: lic.url, author: lic.author, license: lic.license });
    } else {
      unresolved.push({ glb, why: hits.length > 1 ? `ambiguous writers: ${hits.map((h) => h.s.file).join(', ')} (add an OVERRIDES entry with evidence)` : ov ? `override script ${ov.script} has no writer literal` : 'no build script writes this literal name and no LICENSES.md row' });
    }
  }
  return { rows, unresolved };
}

export function provenanceDoc(rows) {
  return {
    about: 'Where every shipped GLB comes from (D37). Generated by scripts/provenance-scan.mjs; gated by scripts/test-asset-provenance.mjs. Do not hand-edit: rerun the scan.',
    count: rows.length,
    rows,
  };
}

function* walkText(dir, skipAbs) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walkText(p, skipAbs); continue; }
    if (!TEXT_EXT.has(extname(e.name)) || skipAbs.has(p)) continue;
    if (statSync(p).size > 4 * 1024 * 1024) continue;
    yield p;
  }
}

function generatorIn(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  for (const [tool, re] of GENERATOR_PATTERNS) { const m = re.exec(s); if (m) return `${tool} ("${m[0]}")`; }
  return null;
}

function collectExtras(node, path, out) {
  if (Array.isArray(node)) { node.forEach((v, i) => collectExtras(v, `${path}[${i}]`, out)); return; }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'extras') out.push([`${path}.extras`, v]);
    collectExtras(v, `${path}.${k}`, out);
  }
}

/**
 * The gate. Returns { failures: string[], stats }. Directories are injectable so
 * the test can prove every rule fails on a fixture.
 */
export function auditProvenance({
  modelsDir = join(ROOT, 'public/assets/models'),
  scriptsDir = join(ROOT, 'scripts/blender'),
  provenancePath = join(modelsDir, 'PROVENANCE.json'),
  licensesPath = join(modelsDir, 'LICENSES.md'),
  textRoots = [join(ROOT, 'scripts'), join(ROOT, 'src')],
  skipFiles = [join(ROOT, 'scripts/provenance-scan.mjs'), join(ROOT, 'scripts/test-asset-provenance.mjs')],
  overrides = OVERRIDES,
} = {}) {
  const failures = [];
  const fail = (m) => failures.push(m);
  const glbs = existsSync(modelsDir) ? readdirSync(modelsDir).filter((f) => f.endsWith('.glb')).sort() : [];
  if (!glbs.length) fail(`VACUOUS: no GLBs in ${modelsDir}`);

  // 1. committed rows cover the disk, and equal a fresh scan
  let committed = null;
  try { committed = JSON.parse(readFileSync(provenancePath, 'utf8')); } catch (e) { fail(`PROVENANCE.json unreadable: ${e.message}`); }
  const rowOf = new Map((committed?.rows ?? []).map((r) => [r.glb, r]));
  for (const g of glbs) if (!rowOf.has(g)) fail(`missing row: ${g} has no PROVENANCE row`);
  for (const g of rowOf.keys()) if (!glbs.includes(g)) fail(`orphan row: ${g} is in PROVENANCE.json but not on disk`);
  const fresh = scanProvenance({ modelsDir, scriptsDir, licensesPath, overrides });
  for (const u of fresh.unresolved) fail(`unresolved: ${u.glb}: ${u.why}`);
  if (committed) {
    const want = JSON.stringify(provenanceDoc(fresh.rows));
    if (JSON.stringify(committed) !== want) {
      const diff = fresh.rows.filter((r) => JSON.stringify(rowOf.get(r.glb)) !== JSON.stringify(r)).map((r) => r.glb);
      if (diff.length || committed.count !== fresh.rows.length) fail(`stale PROVENANCE.json: rows differ from a fresh scan for ${diff.slice(0, 6).join(', ') || '(count)'}${diff.length > 6 ? ` +${diff.length - 6}` : ''} (rerun node scripts/provenance-scan.mjs)`);
    }
  }

  // 2/3. each committed row is a real source
  const licenses = parseLicenses(licensesPath);
  const helpers = exportingHelpers(scriptsDir);
  let scriptRows = 0, licenseRows = 0;
  for (const [g, r] of rowOf) {
    if (r.kind === 'script') {
      scriptRows++;
      const abs = resolve(ROOT, r.script || '');
      const inDir = abs.startsWith(resolve(scriptsDir) + '/');
      if (!r.script || !inDir || !existsSync(abs)) { fail(`dangling script: ${g} -> ${r.script} does not exist under ${relative(ROOT, scriptsDir)}`); continue; }
      const text = readFileSync(abs, 'utf8');
      if (basename(abs).startsWith('_')) fail(`dangling script: ${g} -> ${r.script} is a helper module, not a build script`);
      if (!exportsGlb(text, helpers)) fail(`dangling script: ${g} -> ${r.script} never exports a GLB`);
      const name = g.slice(0, -4);
      const ok = r.via === 'far-lod' ? farHit(text, name.slice(0, -4)) : writerHit(text, name);
      if (!ok) fail(`dangling script: ${g} -> ${r.script} no longer carries the literal output name`);
    } else if (r.kind === 'license') {
      licenseRows++;
      const lic = licenses.find((l) => l.files.includes(g));
      if (!lic) fail(`licence row: ${g} has no row in LICENSES.md`);
      if (!LICENSE_OK.test(String(r.license || '').trim())) fail(`licence row: ${g} licence "${r.license}" is not CC0/CC-BY`);
      if (!/^https?:\/\/\S+$/.test(String(r.source || ''))) fail(`licence row: ${g} has no source URL`);
      if (!String(r.author || '').trim()) fail(`licence row: ${g} has no author`);
    } else fail(`bad row kind for ${g}: ${r.kind}`);
  }

  // 4/5. GLB headers and extras
  const generators = new Map();
  for (const g of glbs) {
    let j;
    try { j = readGlbJson(join(modelsDir, g)); } catch (e) { fail(`${g}: unreadable GLB (${e.message})`); continue; }
    const gen = j.asset?.generator ?? '';
    generators.set(gen, (generators.get(gen) || 0) + 1);
    for (const [field, v] of [['asset.generator', gen], ['asset.copyright', j.asset?.copyright ?? '']]) {
      const hit = generatorIn(v); if (hit) fail(`generator string in ${g} ${field}: ${hit}`);
    }
    const extras = []; collectExtras(j, '$', extras);
    for (const [p, v] of extras) { const hit = generatorIn(v); if (hit) fail(`generator string in ${g} ${p}: ${hit}`); }
    if (rowOf.get(g)?.kind === 'script' && !EXPORTER_ALLOW.test(gen)) fail(`${g}: script row but asset.generator "${gen}" is not a Blender export or a declared packer`);
  }

  // 4b. text under scripts/ and src/
  const skip = new Set(skipFiles.map((f) => resolve(f)));
  let textFiles = 0;
  for (const root of textRoots) {
    for (const p of walkText(root, skip)) {
      textFiles++;
      const text = readFileSync(p, 'utf8');
      for (const [tool, re] of GENERATOR_PATTERNS) {
        const m = re.exec(text);
        if (m) fail(`generator string in ${relative(ROOT, p)}:${lineOf(text, m.index)}: ${tool} ("${m[0]}")`);
      }
    }
  }
  if (!textFiles) fail('VACUOUS: no text files scanned under scripts/ and src/');
  return { failures, stats: { glbs: glbs.length, scriptRows, licenseRows, textFiles, generators: Object.fromEntries(generators) } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const out = join(ROOT, 'public/assets/models/PROVENANCE.json');
  const { rows, unresolved } = scanProvenance();
  for (const u of unresolved) console.error(`  ✗ ${u.glb}: ${u.why}`);
  const text = JSON.stringify(provenanceDoc(rows), null, 1) + '\n';
  const bySource = {};
  for (const r of rows) { const k = r.kind === 'script' ? r.script : `LICENSES.md (${r.license})`; bySource[k] = (bySource[k] || 0) + 1; }
  console.log(`provenance: ${rows.length} rows, ${unresolved.length} unresolved, ${Object.keys(bySource).length} sources`);
  if (check) {
    const same = existsSync(out) && readFileSync(out, 'utf8') === text;
    console.log(same ? '  ✓ PROVENANCE.json is current' : '  ✗ PROVENANCE.json drifted from the scan (rerun without --check)');
    process.exit(same && !unresolved.length ? 0 : 1);
  }
  if (unresolved.length) process.exit(1);
  writeFileSync(out, text);
  console.log(`  wrote ${relative(ROOT, out)}`);
}
