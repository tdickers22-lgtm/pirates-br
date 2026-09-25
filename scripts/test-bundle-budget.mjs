// THE BUNDLE GATE (b3.1f; performance-10, vm:performance:2).
//
// A phone on 4G pays for every byte of JavaScript twice: once on the wire and
// once in parse/compile before the menu can paint. Until this gate the whole
// game (menu, HUD, renderer, world builders, debug tooling) shipped as ONE
// entry chunk, so the Play button waited on all of it. This builds the client
// with the repo's own vite.config.ts into a temp dir (never dist/) and grades
// the real rollup output:
//
//   entry        the entry chunk itself                        <= BUNDLE_BUDGETS_KB.entryBr
//   toMenu       entry + its STATIC import closure             <= BUNDLE_BUDGETS_KB.toMenuBr
//                (what the browser must fetch and run before the menu shell can show)
//   total        every JS chunk + worker                       <= BUNDLE_BUDGETS_KB.totalBr
//   any chunk                                                  <= BUNDLE_BUDGETS_KB.chunkBr
//   shell        the menu (src/client/menu/MenuController.ts) is in the static closure
//                and the game (src/client/core/Game.ts) is NOT: the game chunk is a
//                dynamic import kicked at the menu, awaited on Play. A static
//                closure that merely got small by dropping the menu would pass the
//                byte rows and still park the player on a loading veil, so the
//                shell row grades WHERE the menu lives, not only how big things are.
//
// KB = 1024 bytes of brotli (quality 11, the same encoder postbuild-compress
// uses). Decoders (three's meshopt/basis/zstd wasm wrappers, KTX2Loader) are
// excluded from every row and printed on their own: they are paid by the first
// world GLB, in the world stage (test-model-transport grades that set).
//
// Mutation (rule 5, the gate's proof it can fail):
//   --mutate   a build-time plugin appends a STATIC `import './core/Game.js'` to
//              src/client/main.ts (the file on disk is untouched): the game lands
//              in the entry closure and the shell + toMenu rows must FAIL.
// --report     prints the 25 biggest modules per chunk (brotli is per chunk, so
//              module sizes are minified rendered bytes).
//
// Logic tier, no port, no browser: `node scripts/test-bundle-budget.mjs` (~10-20 s).
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { brotliCompressSync, constants as zc } from 'node:zlib';
import { build } from 'vite';
import { BUNDLE_BUDGETS_KB } from './lib/budgets.mjs';

const ROOT = process.cwd();
const MUTATE = process.argv.includes('--mutate');
const REPORT = process.argv.includes('--report');
const DECODER_RE = /three\/examples\/jsm\/(libs\/(meshopt_decoder|basis|zstddec)|loaders\/KTX2Loader)/;
const MENU_ID = join('src', 'client', 'menu', 'MenuController.ts');
const GAME_ID = join('src', 'client', 'core', 'Game.ts');

let failures = 0;
let checks = 0;
const failed = [];
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; failed.push(label); console.log(`  ✗ FAIL: ${label}${detail ? ` (${detail})` : ''}`); }
}
const br = (buf) => brotliCompressSync(buf, { params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_SIZE_HINT]: buf.length } }).length;
const kb = (n) => (n / 1024).toFixed(1);
const rel = (id) => relative(ROOT, id.replace(/^\0/, '').split('?')[0]).split(sep).join('/');

const mutatePlugin = {
  name: 'b3.1f-mutate-static-game',
  enforce: 'pre',
  transform(code, id) {
    if (!MUTATE || !id.split('?')[0].endsWith(join('src', 'client', 'main.ts'))) return null;
    return { code: `import { Game as __StaticGame } from './core/Game.js';\n(globalThis).__staticGame = __StaticGame;\n${code}`, map: null };
  },
};

const outDir = mkdtempSync(join(tmpdir(), 'pbr-bundle-'));
let output;
try {
  const t0 = Date.now();
  const result = await build({
    configFile: join(ROOT, 'vite.config.ts'),
    logLevel: 'silent',
    plugins: [mutatePlugin],
    build: { outDir, emptyOutDir: true, reportCompressedSize: false, sourcemap: false },
  });
  output = (Array.isArray(result) ? result[0] : result).output;
  console.log(`vite build -> ${outDir} in ${((Date.now() - t0) / 1000).toFixed(1)} s${MUTATE ? ' (MUTATED: static Game import in main.ts)' : ''}`);

  const chunks = output.filter((o) => o.type === 'chunk');
  const byFile = new Map(chunks.map((c) => [c.fileName, c]));
  // Per chunk: brotli of the whole chunk, split into decoder / non-decoder by rendered share.
  const sized = new Map();
  for (const c of chunks) {
    const whole = br(Buffer.from(c.code));
    const mods = Object.entries(c.modules);
    const rendered = mods.reduce((s, [, m]) => s + m.renderedLength, 0) || 1;
    const decoderRendered = mods.filter(([id]) => DECODER_RE.test(id)).reduce((s, [, m]) => s + m.renderedLength, 0);
    const decoderBr = decoderRendered === rendered ? whole : Math.round(whole * (decoderRendered / rendered));
    sized.set(c.fileName, { whole, decoderBr, graded: whole - decoderBr, mods });
  }
  // Workers are emitted as assets (vite worker plugin), not chunks.
  const assetsDir = join(outDir, 'assets');
  const workerFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.js') && !byFile.has(`assets/${f}`));
  const workerBr = workerFiles.reduce((s, f) => s + br(readFileSync(join(assetsDir, f))), 0);

  const entries = chunks.filter((c) => c.isEntry);
  expect('exactly one entry chunk', entries.length === 1, `${entries.length}: ${entries.map((c) => c.fileName).join(', ')}`);
  const entry = entries[0];
  const closure = new Set();
  const walk = (f) => { if (closure.has(f)) return; closure.add(f); for (const d of byFile.get(f)?.imports ?? []) walk(d); };
  walk(entry.fileName);
  const closureIds = new Set([...closure].flatMap((f) => Object.keys(byFile.get(f).modules).map(rel)));
  const graded = (files) => [...files].reduce((s, f) => s + sized.get(f).graded, 0);
  const decoders = chunks.reduce((s, c) => s + sized.get(c.fileName).decoderBr, 0);

  console.log('\nchunks (brotli KB, decoders excluded / whole):');
  for (const c of [...chunks].sort((a, b) => sized.get(b.fileName).whole - sized.get(a.fileName).whole)) {
    const s = sized.get(c.fileName);
    const tag = c.isEntry ? 'entry' : closure.has(c.fileName) ? 'static' : c.isDynamicEntry ? 'dynamic' : 'shared';
    console.log(`  ${c.fileName.padEnd(40)} ${kb(s.graded).padStart(7)} / ${kb(s.whole).padStart(7)}  ${tag}  (${c.code.length} B min, ${s.mods.length} modules)`);
    if (REPORT) {
      for (const [id, m] of [...s.mods].sort((a, b) => b[1].renderedLength - a[1].renderedLength).slice(0, 25)) {
        console.log(`      ${String(m.renderedLength).padStart(8)}  ${rel(id)}`);
      }
    }
  }
  console.log(`  workers ${workerFiles.join(', ') || '(none)'}: ${kb(workerBr)} KB br; decoders excluded everywhere: ${kb(decoders)} KB br\n`);

  const B = BUNDLE_BUDGETS_KB;
  const entryKb = sized.get(entry.fileName).graded / 1024;
  const toMenuKb = graded(closure) / 1024;
  const totalKb = (graded(byFile.keys()) + workerBr) / 1024;
  const biggest = [...sized.entries()].sort((a, b) => b[1].graded - a[1].graded)[0];
  expect(`entry chunk ${entryKb.toFixed(1)} KB br <= ${B.entryBr}`, entryKb <= B.entryBr);
  expect(`JS to menu (entry + static closure, ${closure.size} chunks) ${toMenuKb.toFixed(1)} KB br <= ${B.toMenuBr}`, toMenuKb <= B.toMenuBr, [...closure].join(', '));
  expect(`total JS (every chunk + workers) ${totalKb.toFixed(1)} KB br <= ${B.totalBr}`, totalKb <= B.totalBr);
  expect(`no chunk over ${B.chunkBr} KB br (biggest ${biggest[0]} ${kb(biggest[1].graded)})`, biggest[1].graded / 1024 <= B.chunkBr);
  expect(`menu shell: ${MENU_ID.split(sep).join('/')} is in the static closure`, closureIds.has(MENU_ID.split(sep).join('/')));
  const gameChunk = chunks.find((c) => Object.keys(c.modules).map(rel).includes(GAME_ID.split(sep).join('/')));
  expect(`game off the menu path: ${GAME_ID.split(sep).join('/')} is NOT in the static closure`, !closureIds.has(GAME_ID.split(sep).join('/')));
  expect('game chunk is a dynamic import the entry kicks (modulepreload at the menu, awaited on Play)',
    !!gameChunk && gameChunk.isDynamicEntry && !closure.has(gameChunk.fileName)
      && [...closure].some((f) => (byFile.get(f).dynamicImports ?? []).includes(gameChunk.fileName)),
    gameChunk ? `${gameChunk.fileName} dynamicEntry=${gameChunk.isDynamicEntry}` : 'no chunk holds Game.ts');
  // The dynamic import must not cost a round trip: index.html modulepreloads the game chunk and its static deps.
  const html = readFileSync(join(outDir, 'index.html'), 'utf8');
  const preloaded = new Set([...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="\/([^"]+)"/g)].map((m) => m[1]));
  const gameDeps = new Set();
  const walkInto = (f, into) => { if (into.has(f)) return; into.add(f); for (const d of byFile.get(f)?.imports ?? []) walkInto(d, into); };
  if (gameChunk) walkInto(gameChunk.fileName, gameDeps);
  const notPreloaded = [...gameDeps].filter((f) => !closure.has(f) && !preloaded.has(f));
  expect(`index.html modulepreloads the game chunk and its static deps (${gameDeps.size} chunks)`, !!gameChunk && notPreloaded.length === 0, `missing: ${notPreloaded.join(', ') || (gameChunk ? '' : 'no game chunk')}`);
} finally {
  try { rmSync(outDir, { recursive: true, force: true }); } catch { /* temp */ }
}

console.log(`\n${checks} checks, ${failures} failed${MUTATE ? ' (mutated run: a failure is the expected outcome)' : ''}`);
if (MUTATE) {
  // The mutation must fail the row it targets, not merely any row (a base that is red elsewhere proves nothing).
  if (!failed.some((l) => l.startsWith('game off the menu path'))) { console.log('test-bundle-budget --mutate: MUTATION NOT CAUGHT (the game-off-the-menu-path row stayed green)'); process.exit(1); }
  console.log('test-bundle-budget --mutate: MUTATION CAUGHT'); process.exit(0);
}
console.log(failures ? `test-bundle-budget: ${failures} FAIL` : 'test-bundle-budget: PASS');
process.exit(failures ? 1 : 0);
