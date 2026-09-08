#!/usr/bin/env node
// PRECOMPRESSED SIBLINGS for the built client — the other half of netcode-33.
//
// The game server streams files off disk (LobbyServer.serveHttp). It used to
// stream them RAW: 26.3 MB of GLB and a 918 KB bundle went out uncompressed on
// every first load, because nothing in the stack compresses — Node does not,
// and the platforms DEPLOY.md names (Fly, Render) pass origin bytes through.
// ~27 MB is roughly 22 s on a 10 Mbit line before the name field is usable.
//
// Compressing per request is the wrong repair: the bytes are identical for
// every player, so a core spent gzipping them is a core spent recomputing a
// constant, and it would be spent again for every joiner. So compression is a
// BUILD step and the server just picks the sibling the client can read.
//
// Runs automatically as npm's `postbuild`. Idempotent: a sibling newer than its
// source is left alone, so a rebuild of one chunk does not recompress 27 MB.
import { createRequire } from 'node:module';
import { brotliCompressSync, gzipSync, constants as zc } from 'node:zlib';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Must equal PRECOMPRESSED_EXTENSIONS in src/server/core/LobbyServer.ts —
 *  a sibling the server will not look for is wasted disk, and an extension the
 *  server looks for and never finds is a silent uncompressed download.
 *  test-static-serving.mjs asserts the two sets are identical. */
export const COMPRESSIBLE = new Set([
  '.js', '.css', '.html', '.json', '.map', '.svg', '.txt',
  '.glb', '.gltf', '.bin', '.ktx2', '.wasm',
]);

/** Below this, HTTP framing costs more than the compression saves. */
const MIN_BYTES = 1024;
/** Brotli quality 11 is worth minutes on text and is NOT worth them on 27 MB of
 *  mesh data: on this tree q9 gets within ~2% of q11 on the GLBs at a twentieth
 *  of the CPU. Text (the bundle) is small and shipped to everyone, so it gets 11. */
const BIG_BINARY = 512 * 1024;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

/** True when `sibling` exists and is not older than `source`. */
function fresh(sibling, sourceMtimeMs) {
  if (!existsSync(sibling)) return false;
  try {
    return statSync(sibling).mtimeMs >= sourceMtimeMs;
  } catch {
    return false;
  }
}

/**
 * Write `.br` and `.gz` siblings beside every compressible file under `dir`.
 * @returns {{files:number, raw:number, br:number, gz:number, skipped:number}}
 */
export function compressTree(dir, { log = false } = {}) {
  const totals = { files: 0, raw: 0, br: 0, gz: 0, skipped: 0 };
  for (const file of walk(dir)) {
    const ext = path.extname(file);
    if (!COMPRESSIBLE.has(ext)) continue;
    const st = statSync(file);
    if (st.size < MIN_BYTES) continue;
    totals.files += 1;
    totals.raw += st.size;
    const brPath = `${file}.br`;
    const gzPath = `${file}.gz`;
    if (fresh(brPath, st.mtimeMs) && fresh(gzPath, st.mtimeMs)) {
      totals.skipped += 1;
      totals.br += statSync(brPath).size;
      totals.gz += statSync(gzPath).size;
      continue;
    }
    const buf = readFileSync(file);
    const quality = st.size >= BIG_BINARY ? 9 : 11;
    const br = brotliCompressSync(buf, {
      params: {
        [zc.BROTLI_PARAM_QUALITY]: quality,
        [zc.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    });
    const gz = gzipSync(buf, { level: 9 });
    writeFileSync(brPath, br);
    writeFileSync(gzPath, gz);
    // Stamp both siblings at the source's mtime so `fresh` is a plain
    // comparison and a rebuild that rewrites a file invalidates them.
    const at = new Date();
    utimesSync(brPath, at, st.mtime);
    utimesSync(gzPath, at, st.mtime);
    totals.br += br.length;
    totals.gz += gz.length;
    if (log) {
      console.log(`  ${path.relative(dir, file)}  ${(st.size / 1024).toFixed(0)}K`
        + ` → br ${(br.length / 1024).toFixed(0)}K, gz ${(gz.length / 1024).toFixed(0)}K`);
    }
  }
  return totals;
}

const invokedDirectly = (() => {
  try {
    return createRequire(import.meta.url).resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
  } catch {
    return path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
  }
})();

if (invokedDirectly) {
  const dir = path.resolve(process.argv[2] ?? path.join(ROOT, 'dist/client'));
  if (!existsSync(dir)) {
    console.error(`[compress] ${dir} does not exist — build the client first`);
    process.exit(1);
  }
  const t0 = Date.now();
  const totals = compressTree(dir, { log: process.argv.includes('--verbose') });
  const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
  console.log(`[compress] ${totals.files} files (${totals.skipped} already fresh) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`[compress] raw ${mb(totals.raw)} → brotli ${mb(totals.br)} (${(100 * totals.br / Math.max(1, totals.raw)).toFixed(0)}%), gzip ${mb(totals.gz)}`);
}
