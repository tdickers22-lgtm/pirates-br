#!/usr/bin/env node
// STATIC SERVING GUARD — BOOT-01 (netcode-33). Drives the REAL LobbyServer over
// a real socket on a kernel-chosen port and reads the bytes and the headers it
// actually puts on the wire.
//
// The three things it is the net under, all of them invisible on localhost and
// all of them measured on this tree:
//
//  1. NOTHING WAS COMPRESSED. 26.3 MB of GLB went out raw because Node does not
//     compress and no platform in DEPLOY.md compresses for it. ~22 s on a
//     10 Mbit line before the name field works.
//  2. `immutable` FOR A YEAR ON AN UNHASHED NAME. Vite copies public/ verbatim,
//     so `/assets/models/palm_a.glb` keeps its name across every Blender
//     re-export — and every returning player kept the OLD model until their
//     cache evicted. The only repair was renaming the file.
//  3. EVERY MODEL WAS application/octet-stream. There is no `.glb` in
//     MIME_TYPES, so a CDN or proxy in front of the origin cannot tell what it
//     is holding.
//
// It is deliberately NOT a mock: a header assertion against a hand-built
// response object would have passed on the day all three of those were true.
import { createRequire } from 'node:module';
import http from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist/client');

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error('  ✗ FAIL: dist/client/index.html is missing — run `npm run build` before this suite');
  process.exit(1);
}

// The siblings are a BUILD artefact, so make sure they exist before grading the
// server that serves them (idempotent; ~0.3 s once the tree is warm). This also
// grades the compressor: a broken one shows up as a missing sibling below.
const { compressTree, COMPRESSIBLE } = await import('./postbuild-compress.mjs');
const totals = compressTree(DIST);
console.log(`static serving guard — ${totals.files} compressible files, `
  + `${(totals.raw / 1048576).toFixed(1)} MB raw → ${(totals.br / 1048576).toFixed(1)} MB brotli\n`);

const { LobbyServer, PRECOMPRESSED_EXTENSIONS } = await import('../src/server/core/LobbyServer.ts');

// The server's list and the compressor's list are two halves of one contract:
// an extension the server looks for and the build never writes is a silent
// uncompressed download, and the reverse is dead bytes on disk.
const serverExts = [...(PRECOMPRESSED_EXTENSIONS ?? [])].sort().join(",");
const buildExts = [...COMPRESSIBLE].sort().join(',');
expect('the server and the build agree on what gets a precompressed sibling',
  serverExts === buildExts, `server: ${serverExts}\n     build:  ${buildExts}`);

const server = new LobbyServer();
server.init(0);
await new Promise((resolve) => {
  const wait = () => (server.boundPort ? resolve() : setTimeout(wait, 20));
  wait();
});
const PORT = server.boundPort;

/** Raw request — no fetch, because undici silently decompresses the body and
 *  the whole point here is the encoded bytes. */
function get(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const MODEL = '/assets/models/palm_a.glb';
const modelFile = path.join(DIST, 'assets/models/palm_a.glb');
const modelBytes = readFileSync(modelFile);

try {
  // ── 1. the model's identity on the wire ────────────────────────────────────
  const plain = await get(MODEL);
  expect('a GLB is served as model/gltf-binary, not application/octet-stream',
    plain.headers['content-type'] === 'model/gltf-binary', `got ${plain.headers['content-type']}`);
  expect('an uncompressed GLB body is byte-identical to the file on disk',
    plain.status === 200 && plain.body.equals(modelBytes),
    `status ${plain.status}, ${plain.body.length} B vs ${modelBytes.length} B`);
  expect('a GLB carries an ETag and Vary: Accept-Encoding',
    !!plain.headers.etag && /accept-encoding/i.test(String(plain.headers.vary ?? '')),
    `etag=${plain.headers.etag} vary=${plain.headers.vary}`);

  // ── 2. THE STALE-MODEL BUG. An unhashed path may never be immutable. ───────
  const modelCache = String(plain.headers['cache-control'] ?? '');
  expect('an unhashed /assets/models/ path is NOT immutable (a re-export must reach returning players)',
    !/immutable/.test(modelCache) && /max-age=0/.test(modelCache), `cache-control: ${modelCache}`);

  // ── 3. …and the converse: a Vite-hashed name still gets the full year. ─────
  const hashed = readFileSync(path.join(DIST, 'index.html'), 'utf8')
    .match(/\/assets\/[A-Za-z0-9_.-]*-[A-Za-z0-9_-]{8}\.js/);
  expect('index.html references a content-hashed bundle', !!hashed, 'no hashed /assets/*.js in index.html');
  if (hashed) {
    const bundle = await get(hashed[0]);
    expect('a content-hashed bundle IS immutable for a year',
      /immutable/.test(String(bundle.headers['cache-control'] ?? '')),
      `cache-control: ${bundle.headers['cache-control']}`);
  }

  // ── 4. precompressed siblings, both encodings, byte-exact after decode ─────
  const br = await get(MODEL, { 'accept-encoding': 'gzip, deflate, br' });
  const brSize = statSync(`${modelFile}.br`).size;
  expect('brotli is preferred when the client accepts it',
    br.headers['content-encoding'] === 'br', `content-encoding: ${br.headers['content-encoding']}`);
  expect('the brotli body decodes to exactly the file on disk',
    br.headers['content-encoding'] === 'br' && brotliDecompressSync(br.body).equals(modelBytes));
  expect('Content-Length is the ENCODED length (the loading bar reads it)',
    Number(br.headers['content-length']) === brSize && br.body.length === brSize,
    `header ${br.headers['content-length']}, body ${br.body.length}, file ${brSize}`);
  expect('the compressed model is a fraction of the raw one',
    brSize < modelBytes.length * 0.6, `${brSize} B vs ${modelBytes.length} B raw`);

  const gz = await get(MODEL, { 'accept-encoding': 'gzip, deflate' });
  expect('a client without brotli gets gzip, not the raw file',
    gz.headers['content-encoding'] === 'gzip' && gunzipSync(gz.body).equals(modelBytes),
    `content-encoding: ${gz.headers['content-encoding']}`);

  // ── 5. revalidation is what makes max-age=0 cheap ─────────────────────────
  const revalidated = await get(MODEL, { 'accept-encoding': 'gzip, deflate, br', 'if-none-match': String(br.headers.etag) });
  expect('an unchanged model answers 304 with no body',
    revalidated.status === 304 && revalidated.body.length === 0,
    `status ${revalidated.status}, ${revalidated.body.length} B`);
  expect('the ETag distinguishes the encodings (a shared cache must not mix them)',
    br.headers.etag !== plain.headers.etag && br.headers.etag !== gz.headers.etag,
    `plain ${plain.headers.etag} br ${br.headers.etag} gzip ${gz.headers.etag}`);
  const wrongEtag = await get(MODEL, { 'if-none-match': 'W/"deadbeef-0"' });
  expect('a STALE validator gets the bytes, not a 304',
    wrongEtag.status === 200 && wrongEtag.body.length === modelBytes.length, `status ${wrongEtag.status}`);

  // ── 6. the document itself must never be cached ────────────────────────────
  const doc = await get('/');
  expect('index.html stays no-cache',
    doc.status === 200 && String(doc.headers['cache-control']) === 'no-cache',
    `status ${doc.status}, cache-control ${doc.headers['cache-control']}`);

  // ── 7. the whole boot payload, which is the number netcode-33 is about ─────
  const modelsRaw = totals.raw;
  expect('the built client compresses to under 40% of its raw size',
    totals.br < modelsRaw * 0.4, `${(totals.br / 1048576).toFixed(2)} MB of ${(modelsRaw / 1048576).toFixed(2)} MB`);
} finally {
  server.httpServer?.close?.();
}

console.log(failures === 0 ? '\nAll static serving assertions passed' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
