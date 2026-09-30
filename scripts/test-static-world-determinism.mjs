#!/usr/bin/env node
// STATIC WORLD DETERMINISM (b4.1a; performance-05, D30).
//
// The join payload is about to carry (seed, WORLD_VERSION) instead of the
// world, so the server and the client MUST generate the same bytes. This
// grades that on two genuinely separate module graphs:
//   server graph = src/shared/staticWorld.ts through tsx (what Match imports);
//   client graph = the same entry bundled by esbuild for the BROWSER platform
//                  (what Vite ships to the worker), imported from a temp file.
// For 3 seeds it compares every static section byte for byte AND the collision
// geometry derived from it (prop colliders + sub-colliders on the terrain
// height under them, a terrain grid per island, sea-rock primitives).
//
// Engine independence: JavaScriptCore and V8 do not share a libm, so the
// generator runs under withDeterministicMath. Proven here by perturbing the
// ENGINE's Math.sin/cos/atan2/hypot/exp/pow by ~1 ulp and demanding the same
// worldHash; a CONTROL row shows the raw generator does change under that
// perturbation (otherwise the libm row would be vacuous).
//
// Mutation: --mutate=draw perturbs ONE rng draw (global draw #1000) in the
// CLIENT graph only; the gate must FAIL.
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'src/shared/staticWorld.ts');
const MUTATE = (process.argv.find((a) => a.startsWith('--mutate=')) ?? '').slice('--mutate='.length)
  || process.env.PIRATES_BR_MUTATE_STATIC_WORLD || '';
const SEEDS = [20260801, 12345, 3141592653];

let failures = 0;
let passes = 0;
function expect(label, ok, detail = '') {
  if (ok) { passes += 1; console.log(`  ✓ ${label}`); }
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

if (MUTATE && MUTATE !== 'draw') {
  console.error(`✗ FAIL: unknown mutation "${MUTATE}" (known: draw)`);
  process.exit(1);
}

// ── the two module graphs ────────────────────────────────────────────────────
const server = await import(pathToFileURL(ENTRY).href);

const tmp = mkdtempSync(join(tmpdir(), 'pbr-static-world-'));
let client;
try {
  const perturbDraw = {
    name: 'perturb-one-draw',
    setup(b) {
      b.onLoad({ filter: /src[\\/]shared[\\/]utils[\\/]index\.ts$/ }, async (args) => {
        const { readFileSync } = await import('node:fs');
        let src = readFileSync(args.path, 'utf8');
        const head = 'export function mulberry32(seed: number): () => number {';
        if (!src.includes(head)) throw new Error('mutation anchor for mulberry32 not found');
        src = src.replace(head, 'function __mulberry32Raw(seed: number): () => number {')
          + '\nlet __draws = 0;\nexport function mulberry32(seed: number): () => number {\n'
          + '  const next = __mulberry32Raw(seed);\n'
          + '  return () => { const v = next(); __draws += 1; return __draws === 1000 ? (v + 0.5) % 1 : v; };\n}\n';
        return { contents: src, loader: 'ts' };
      });
    },
  };
  const out = join(tmp, 'staticWorld.client.mjs');
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    outfile: out,
    logLevel: 'silent',
    plugins: MUTATE === 'draw' ? [perturbDraw] : [],
  });
  client = await import(pathToFileURL(out).href);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`Static world determinism (WORLD_VERSION ${server.WORLD_VERSION}${MUTATE ? `, MUTATION ${MUTATE}` : ''}):`);
expect('both graphs agree on WORLD_VERSION', server.WORLD_VERSION === client.WORLD_VERSION && Number.isInteger(server.WORLD_VERSION) && server.WORLD_VERSION >= 1,
  `${server.WORLD_VERSION} vs ${client.WORLD_VERSION}`);
expect('the client graph is a separate module instance (bundled, not the tsx module)',
  client.generateStaticWorld !== server.generateStaticWorld && client.detMath !== server.detMath);

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SECTIONS = ['islands', 'spawns', 'seaPois', 'seaRocks'];

for (const seed of SEEDS) {
  console.log(`seed ${seed}:`);
  const t0 = performance.now();
  const a = server.generateStaticWorld(seed);
  const t1 = performance.now();
  const b = client.generateStaticWorld(seed);
  const ha = server.hashStaticWorld(a);
  const hb = client.hashStaticWorld(b);
  for (const key of SECTIONS) {
    const ja = server.canonicalJson(a[key]);
    const jb = client.canonicalJson(b[key]);
    let at = -1;
    if (ja !== jb) { at = 0; while (at < ja.length && ja[at] === jb[at]) at += 1; }
    expect(`${key}: server and client bytes identical (${ja.length} B)`, ja === jb && ja.length > 2,
      at >= 0 ? `first difference at byte ${at}: server …${ja.slice(Math.max(0, at - 60), at + 40)}… client …${jb.slice(Math.max(0, at - 60), at + 40)}…` : 'empty section');
  }
  const ga = server.staticColliderGeometry(a);
  const gb = client.staticColliderGeometry(b);
  let firstGeo = -1;
  for (let i = 0; i < Math.max(ga.length, gb.length); i++) {
    if (!Object.is(ga[i], gb[i])) { firstGeo = i; break; }
  }
  const props = a.islands.reduce((n, i) => n + (i.props?.length ?? 0), 0);
  expect(`collider geometry bit-identical (${ga.length} doubles over ${props} props, ${a.seaRocks.length} sea rocks, 14 terrain grids)`,
    firstGeo < 0 && ga.length > 10000 && props > 500 && a.seaRocks.length > 10,
    firstGeo >= 0 ? `first differing double #${firstGeo}: ${ga[firstGeo]} vs ${gb[firstGeo]}` : `too little geometry: ${ga.length} doubles, ${props} props`);
  expect(`colliderHash + worldHash equal (${ha.worldHash})`, ha.colliderHash === hb.colliderHash && ha.worldHash === hb.worldHash,
    `server ${ha.worldHash}/${ha.colliderHash} client ${hb.worldHash}/${hb.colliderHash}`);
  const again = server.hashStaticWorld(server.generateStaticWorld(seed));
  expect('regenerating in the same graph gives the same worldHash (no clock, no uuid, no Math.random leak)', again.worldHash === ha.worldHash);
  const staticText = SECTIONS.map((k) => JSON.stringify(a[k])).join('');
  expect('no per-match uuid left in the static sections (deltas address statics by stable ids)', !UUID_RE.test(staticText),
    staticText.match(UUID_RE)?.[0] ?? '');
  console.log(`    (server generation ${(t1 - t0).toFixed(0)} ms on this host, ${staticText.length} B of static JSON)`);
}

// ── engine independence ──────────────────────────────────────────────────────
console.log('libm independence (JSC vs V8):');
const { MapGenerator } = await import(pathToFileURL(join(ROOT, 'src/server/world/MapGenerator.ts')).href);
const rawProps = (seed) => {
  const gen = new MapGenerator(seed);
  const islands = gen.generateIslands();
  return JSON.stringify(islands.map((i) => [i.props, i.caves.map((c) => c.position), i.stamps]));
};
const baseHash = server.hashStaticWorld(server.generateStaticWorld(SEEDS[0])).worldHash;
const baseRaw = rawProps(SEEDS[0]);
const KEYS = ['sin', 'cos', 'tan', 'atan', 'atan2', 'exp', 'log', 'pow', 'hypot'];
const saved = Object.fromEntries(KEYS.map((k) => [k, Math[k]]));
let perturbedHash;
let perturbedRaw;
try {
  // A different libm: every result nudged by ~2 ulp (what JSC vs V8 looks like).
  for (const k of KEYS) { const f = saved[k]; Math[k] = (...args) => { const v = f(...args); return v * (1 + 4.440892098500626e-16); }; }
  perturbedHash = server.hashStaticWorld(server.generateStaticWorld(SEEDS[0])).worldHash;
  perturbedRaw = rawProps(SEEDS[0]);
} finally {
  for (const k of KEYS) Math[k] = saved[k];
}
expect('CONTROL: the raw generator DOES move under a different libm (the row below is not vacuous)', perturbedRaw !== baseRaw);
expect('generateStaticWorld is unmoved by a different libm (placement never calls the engine\'s trig)', perturbedHash === baseHash,
  `${baseHash} -> ${perturbedHash}`);
expect('the engine\'s Math is restored after generation', KEYS.every((k) => Math[k] === saved[k]));

console.log('deterministic kernels:');
const ulpErr = (d, r) => Math.abs(d - r) / Math.max(Math.abs(r) * 2.220446049250313e-16, 5e-324);
let worst = { sin: 0, cos: 0, atan2: 0, exp: 0, log: 0, pow: 0 };
const grid = [];
for (let i = 0; i < 4001; i++) grid.push((i - 2000) * 0.0173);
for (const x of grid) {
  const y = Math.sin(x * 1.7) * 40;
  const p = Math.abs(x) / 35 + 1e-3;
  const D = server.detMath;
  worst.sin = Math.max(worst.sin, ulpErr(D.sin(x), Math.sin(x)));
  worst.cos = Math.max(worst.cos, ulpErr(D.cos(x), Math.cos(x)));
  worst.atan2 = Math.max(worst.atan2, ulpErr(D.atan2(y, x), Math.atan2(y, x)));
  worst.exp = Math.max(worst.exp, ulpErr(D.exp(x / 10), Math.exp(x / 10)));
  worst.log = Math.max(worst.log, ulpErr(D.log(p), Math.log(p)));
  worst.pow = Math.max(worst.pow, ulpErr(D.pow(p, 1.35), Math.pow(p, 1.35)));
}
const bound = { sin: 2, cos: 2, atan2: 2, exp: 2, log: 2, pow: 16 };
expect(`kernels track the real functions (worst ulps: ${Object.entries(worst).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ')})`,
  Object.keys(bound).every((k) => worst[k] <= bound[k]));
const D = server.detMath;
expect('kernel edge cases: sin(0)=0, cos(0)=1, atan2(0,-1)=pi, atan2(-0,1)=-0, exp(0)=1, log(1)=0, pow(2,10)=1024, hypot(3,4)=5',
  D.sin(0) === 0 && D.cos(0) === 1 && D.atan2(0, -1) === Math.PI && Object.is(D.atan2(-0, 1), -0)
  && D.exp(0) === 1 && D.log(1) === 0 && D.pow(2, 10) === 1024 && D.hypot(3, 4) === 5);
let threw = false;
try { server.generateStaticWorld(SEEDS[0], server.WORLD_VERSION + 1); } catch { threw = true; }
expect('a foreign WORLD_VERSION is refused (the client falls back to world_sync, never guesses)', threw);

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} static world determinism: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
