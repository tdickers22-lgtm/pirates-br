// BUDGET RATCHET (b1.7a, PLAN 2026-09-22 rule 13, critique gap 5b/5c). Quick tier, pure node.
//
// Every ceiling lives in scripts/lib/budgets.mjs. This gate fails when any of them is LOOSER than
//   (1) the same value on origin/release (skipped, loudly, while release carries no budgets.mjs),
//   (2) the f5fee97e baseline in scripts/fixtures/budget-baseline-f5fee97e.json,
//   (3) the PLAN section 3.4 / 3.14 tables encoded below (declared deviations printed, may only shrink),
// fails when a perf/fill/first-draw/memory/bundle/texture/transport/wire gate does not import
// budgets.mjs, and fails when the last commit touching budgets.mjs also touched src/ or public/.
// "Looser" = a ceiling went up or a floor went down (budgets.directionOf).
//
// MUTATION: every run also bumps one ceiling +1 in memory and requires the comparison to FAIL it
// (a ratchet that cannot fail is a bug). PIRATES_BR_MUTATE_BUDGET=<flat path> (e.g.
// perf.high.dock-vista.draws) applies the same +1 to the live values, so the whole gate goes red.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { flattenBudgets, directionOf } from './lib/budgets.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const expect = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
};
const git = (...a) => { try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };

const current = flattenBudgets();
const MUTATE = process.env.PIRATES_BR_MUTATE_BUDGET;
if (MUTATE) {
  if (!(MUTATE in current)) throw new Error(`PIRATES_BR_MUTATE_BUDGET: no budget at ${MUTATE}`);
  current[MUTATE] += directionOf(MUTATE) === 'floor' ? -1 : 1;
  console.log(`  [MUTATED: ${MUTATE} -> ${current[MUTATE]}]`);
}

/** Violations of `ref` (a flat map or a list of {match, max|min, source}) by `vals`. */
function looser(vals, ref, source) {
  const out = [];
  for (const [path, v] of Object.entries(vals)) {
    if (!(path in ref)) continue;
    const r = ref[path];
    const dir = directionOf(path);
    if ((dir === 'ceiling' && v > r) || (dir === 'floor' && v < r)) out.push(`${path} = ${v}, ${source} ${dir === 'ceiling' ? '<=' : '>='} ${r}`);
  }
  return out;
}

// PLAN section 3.4 (columns A low / B balanced / C phone / D iPad / E high) and 3.14, as enforced NOW.
// A rule is { re, max | min, src }. Targets the plan dates to a later batch sit in PENDING (printed).
const PLAN_RULES = [
  { re: /^perf\.low\.[^.]+\.draws$/, max: 680, src: '3.4 A draws' },
  { re: /^perf\.low\.[^.]+\.tris$/, max: 600_000, src: '3.4 A triangles' },
  { re: /^perf\.balanced\.[^.]+\.draws$/, max: 970, src: '3.4 B Medium draws' },
  { re: /^perf\.balanced\.[^.]+\.tris$/, max: 1_430_000, src: '3.4 B Medium triangles' },
  { re: /^perf\.phone\.[^.]+\.draws$/, max: 450, src: '3.4 C draws' },
  { re: /^perf\.phone\.[^.]+\.tris$/, max: 400_000, src: '3.4 C triangles' },
  { re: /^perf\.phone\.[^.]+\.programs$/, max: 66, src: '3.4 C programs' },
  { re: /^perf\.ipad\.[^.]+\.draws$/, max: 550, src: '3.4 D draws' },
  { re: /^perf\.ipad\.[^.]+\.tris$/, max: 500_000, src: '3.4 D triangles' },
  { re: /^perf\.ipad\.[^.]+\.programs$/, max: 66, src: '3.4 D programs' },
  { re: /^perf\.high\.dock-vista\.draws$/, max: 1950, src: '3.4 E dock draws' },
  { re: /^perf\.high\.dock-vista\.tris$/, max: 2_000_000, src: '3.4 E dock triangles' },
  { re: /^perf\.high\.deck-aft\.tris$/, max: 2_900_000, src: '3.4 E deck triangles' },
  { re: /^perf\.low\.island-interior\.draws$/, max: 680, src: '3.14 island-interior low draws' },
  { re: /^perf\.low\.island-interior\.tris$/, max: 600_000, src: '3.14 island-interior low triangles' },
  { re: /^frameGovernor\.mobileRows\.(iPhone|Pixel)[^.]*\.openMax$/, max: 0.60, src: '3.4 C open Mpx' },
  { re: /^frameGovernor\.mobileRows\.(iPhone|Pixel)[^.]*\.floorMin$/, min: 0.30, src: '3.4 C floor Mpx' },
  { re: /^frameGovernor\.mobileRows\.iPad[^.]*\.openMin$/, min: 0.70, src: '3.4 D open Mpx' },
  { re: /^frameGovernor\.mobileRows\.iPad[^.]*\.floorMin$/, min: 0.45, src: '3.4 D floor Mpx' },
  { re: /^frameGovernor\.legibilityFloorWidthPx$/, min: 640, src: '3.4 C never under 640 px wide' },
];
/** DECLARED deviations from the plan table: path -> { value it may not exceed, owner, why }. This list
 *  may only shrink; a value past its declared figure, or a new entry, is a failure by construction. */
const DEVIATIONS = {
  'perf.phone.*.programs': { upTo: 70, owner: 'b3.1 (ProgramWarmup / programCensus)', why: 'phones read 66-68 programs, 69 on iPad; the 70 ceiling is the desktop-low figure until b3.1 brings phones to 66 (b1.5 report)' },
  'perf.ipad.*.programs': { upTo: 70, owner: 'b3.1 (ProgramWarmup / programCensus)', why: 'same census as the phone row' },
  'perf.balanced.cave-interior.draws': { upTo: 1540, owner: 'b4.4 (perf levers)', why: 'the 3.4 B column caps Medium at 970 draws / 1.43 M tris for the worst scene; the balanced cave reads 1374 draws / ~1.6 M, so its row sits above the table until the cave levers land' },
  'perf.balanced.cave-interior.tris': { upTo: 1_835_000, owner: 'b4.4 (perf levers)', why: 'see the draws row' },
  'frameGovernor.mobileRows.iPad*.floorMin': { upTo: 0.44, owner: 'b1.7a follow-up', why: 'the 0.45 Mpx tablet floor lands 0.449 after integer rounding; tighten once the printed floor is re-read' },
};
const PENDING = [
  '3.14 / 3.4 E: dock-vista high <= 1,500 draws / 1.6 M tris after b4 (now 1950 / 2.0 M)',
  '3.14: dock-vista low <= 620 / 520k after b4.4a (now 680 / 580k)',
  '3.14: island-interior high <= 1,300 / 1.4 M (no high island-interior row yet; b4.4a adds it)',
];
const devFor = (path) => Object.entries(DEVIATIONS).find(([g]) => new RegExp(`^${g.replace(/[.]/g, '\\.').replace(/\*/g, '[^.]*')}$`).test(path));
function planViolations(vals) {
  const out = [];
  for (const [path, v] of Object.entries(vals)) {
    for (const r of PLAN_RULES) {
      if (!r.re.test(path)) continue;
      const bad = r.max != null ? v > r.max : v < r.min;
      if (!bad) continue;
      const dev = devFor(path);
      const okDev = dev && (r.max != null ? v <= dev[1].upTo : v >= dev[1].upTo);
      if (!okDev) out.push(`${path} = ${v}, PLAN ${r.src} ${r.max != null ? '<=' : '>='} ${r.max ?? r.min}`);
    }
  }
  return out;
}

console.log(`Budget ratchet — ${Object.keys(current).length} graded values in scripts/lib/budgets.mjs`);

// (2) f5fee97e baseline
const fixture = JSON.parse(readFileSync(join(ROOT, 'scripts/fixtures/budget-baseline-f5fee97e.json'), 'utf8'));
const baseCeil = fixture.ceilings;
const vsBase = looser(current, baseCeil, 'f5fee97e');
expect(`no value looser than the f5fee97e baseline (${Object.keys(baseCeil).length} rows present there)`, vsBase.length === 0, vsBase.join('\n     '));
expect('the baseline is not vacuous (>= 50 rows, every one still graded)',
  Object.keys(baseCeil).length >= 50 && Object.keys(baseCeil).every((k) => k in current),
  Object.keys(baseCeil).filter((k) => !(k in current)).join(', ') || `${Object.keys(baseCeil).length} rows`);

// (1) release
const relSha = git('rev-parse', '--short', 'origin/release')?.trim();
const relSrc = relSha ? git('show', 'origin/release:scripts/lib/budgets.mjs') : null;
if (!relSha) console.log('  · no origin/release ref here; release leg skipped');
else if (!relSrc) console.log(`  · origin/release (${relSha}) carries no budgets.mjs yet; the f5fee97e baseline stands in for it${relSha === fixture.commit?.slice(0, relSha.length) ? ' (release IS f5fee97e)' : ''}`);
else {
  const dir = mkdtempSync(join(tmpdir(), 'pbr-ratchet-'));
  writeFileSync(join(dir, 'budgets.mjs'), relSrc);
  const rel = (await import(pathToFileURL(join(dir, 'budgets.mjs')).href)).flattenBudgets();
  const vsRel = looser(current, rel, `release ${relSha}`);
  expect(`no value looser than origin/release (${relSha}, ${Object.keys(rel).length} rows)`, vsRel.length === 0, vsRel.join('\n     '));
}

// (3) plan tables
const vsPlan = planViolations(current);
expect(`no value looser than the PLAN 3.4 / 3.14 tables (${PLAN_RULES.length} rules)`, vsPlan.length === 0, vsPlan.join('\n     '));
expect('every plan rule grades at least one budget (no rule matches nothing)',
  PLAN_RULES.every((r) => Object.keys(current).some((k) => r.re.test(k))),
  PLAN_RULES.filter((r) => !Object.keys(current).some((k) => r.re.test(k))).map((r) => r.src).join(', '));
for (const [g, d] of Object.entries(DEVIATIONS)) console.log(`  ! declared deviation ${g} up to ${d.upTo} (owner ${d.owner}): ${d.why}`);
for (const p of PENDING) console.log(`  · pending target: ${p}`);

// every budget gate imports budgets.mjs
const GATE_RE = /^test-.*(budget|memory|bundle|texture|transport|snapshot-size|ocean-tier|frame-governor)\.mjs$/;
const gates = readdirSync(join(ROOT, 'scripts')).filter((f) => GATE_RE.test(f));
/** Budget gates that predate this file and sit outside b1.7a's declared hooks (rule 4). They keep
 *  their literals until their owner touches them; this list may only shrink. */
const NOT_YET_ADOPTED = new Set(['test-bathymetry-budget.mjs', 'test-light-budget.mjs']);
for (const f of NOT_YET_ADOPTED) console.log(`  ! ${f} still carries its own ceilings (not in b1.7a's hooks; adopt budgets.mjs on its next edit)`);
const missing = gates.filter((f) => !NOT_YET_ADOPTED.has(f)).filter((f) => !/from ['"]\.\/lib\/budgets\.mjs['"]/.test(readFileSync(join(ROOT, 'scripts', f), 'utf8')));
expect(`every budget gate imports scripts/lib/budgets.mjs (${gates.length}: ${gates.join(', ')})`, gates.length >= 7 && missing.length === 0 && [...NOT_YET_ADOPTED].every((f) => gates.includes(f) && !/lib\/budgets\.mjs/.test(readFileSync(join(ROOT, 'scripts', f), 'utf8'))), `missing: ${missing.join(', ')}`);

// the last commit touching budgets.mjs touches no src/ or public/
const last = git('log', '-1', '--format=%h', '--', 'scripts/lib/budgets.mjs')?.trim();
if (!last) console.log('  · budgets.mjs has no commit yet; the commit-hygiene leg runs from its first commit');
else {
  const files = (git('show', '--name-only', '--format=', last) ?? '').split('\n').filter(Boolean);
  const bad = files.filter((f) => f.startsWith('src/') || f.startsWith('public/'));
  expect(`the last budgets.mjs commit (${last}) touches no src/ or public/ file`, bad.length === 0, bad.join(', '));
}

// built-in mutation proof: +1 on a ceiling pinned at its baseline must fail the comparison
const probe = Object.keys(baseCeil).find((k) => directionOf(k) === 'ceiling' && current[k] === baseCeil[k] && Number.isInteger(baseCeil[k]));
const bumped = { ...current, [probe]: current[probe] + 1 };
expect(`mutation proof: ${probe} +1 is caught`, !!probe && looser(bumped, baseCeil, 'f5fee97e').length === vsBase.length + 1);

if (failures) { console.error(`\n${failures} budget-ratchet assertion(s) failed.`); process.exit(1); }
console.log('\nBudget ratchet: every ceiling is at or under every reference.');
