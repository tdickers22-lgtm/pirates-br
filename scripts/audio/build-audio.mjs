#!/usr/bin/env node
// build-audio.mjs — the ONLY way a sound enters public/assets/audio (D31, audio-01/audio-14).
//
//   node scripts/audio/build-audio.mjs            fetch (cached) + build every key
//   node scripts/audio/build-audio.mjs --key cannon.fire   rebuild one key (manifest keeps the rest)
//
// Reads scripts/audio/sources.json (source -> url/page/author/licence; key -> tier/kind/variants),
// refuses any licence outside allowedLicenses, fetches each source once into
// ~/.cache/pirates-br/audio-src (zips are read with `unzip -p`), then per variant:
//   decode (ffmpeg -> f32 PCM 44.1 kHz) -> trim / split-on-silence / pitch -> seamless loop
//   (equal-power crossfade of the tail into the head) for beds -> loudness to the kind's
//   target (-18 one-shots, -26 beds, -24 UI; EBU R128 integrated, gain + -1 dBFS limiter,
//   iterated until within 0.5 LU) -> MP3 (libmp3lame CBR, decodes on iOS Safari and Firefox)
//   -> decode the MP3 back and MEASURE what shipped: loudness, peak, duration and, for loops,
//   the loop points (the encoder's lead-in found by cross-correlating against the PCM we fed).
// Writes public/assets/audio/{manifest.json, LICENSES.md} and rebuilds public/credits.json. test-audio-manifest
// re-measures every file, so a hand-dropped or hand-edited file fails the gate.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../..');
export const SOURCES_PATH = path.join(HERE, 'sources.json');
export const OUT_DIR = path.join(ROOT, 'public/assets/audio');
const CACHE = path.join(os.homedir(), '.cache/pirates-br/audio-src');
const SR = 44100;

/** Licences that can never ship, whatever sources.json says (D3/D31). */
export const FORBIDDEN_LICENSE = /\b(NC|ND|non-?commercial|personal|editorial|sonniss|pixabay|mixkit)\b/i;

/** PCM goes to ffmpeg through a temp file, never stdin: piped input hung ffmpeg for minutes
 *  on some clips (seen twice on 2026-09-25), and a hung build is worse than a slow one. */
let tmpSeq = 0;
function pcmFile(pcm) {
  const f = path.join(os.tmpdir(), `pbr-audio-${process.pid}-${tmpSeq++}.f32`);
  fs.writeFileSync(f, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  return f;
}

function ffmpeg(args, input) {
  let tmp = null;
  if (input) {
    tmp = pcmFile(input);
    args = args.map((a) => (a === 'pipe:0' ? tmp : a));
  }
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'info', ...args], {
    maxBuffer: 1 << 30, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (tmp) fs.rmSync(tmp, { force: true });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status ?? r.signal}): ${r.stderr?.toString().trim().split('\n').pop()} :: ${args.join(' ')}`);
  return r;
}

/** EBU R128 integrated loudness + sample peak of a file or of f32 PCM. Shared with the gate.
 *  R128 gates in 400 ms blocks, so a 100 ms footstep measured once reads as its energy spread
 *  over 400 ms (4-6 LU low) and normalising it to target would crush it into the limiter.
 *  Sub-400 ms clips are therefore measured TILED to >= 1.2 s (the loudness while it sounds);
 *  longer clips get 0.5 s of trailing silence so the last block holds their tail (silent
 *  blocks fall under the -70 LUFS absolute gate). */
export function measure(input, channels = 1) {
  const dur = typeof input === 'string' ? probeDuration(input) : input.length / channels / SR;
  const tile = dur < 0.4 ? ['-stream_loop', String(Math.ceil(1.2 / Math.max(dur, 0.01)) - 1)] : [];
  const src = typeof input === 'string'
    ? [...tile, '-i', input]
    : [...tile, '-f', 'f32le', '-ar', String(SR), '-ac', String(channels), '-i', 'pipe:0'];
  const af = dur < 0.4 ? 'ebur128=framelog=verbose:peak=sample' : 'apad=pad_dur=0.5,ebur128=framelog=verbose:peak=sample';
  const r = ffmpeg([...src, '-af', af, '-f', 'null', '-'], typeof input === 'string' ? undefined : input);
  const err = r.stderr.toString();
  const summary = err.slice(err.lastIndexOf('Summary:'));
  const lufs = Number(/I:\s+(-?[\d.]+|-inf) LUFS/.exec(summary)?.[1]);
  const peakDb = Number(/Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(summary)?.[1]);
  return { lufs, peakDb };
}

export function probeDuration(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(out.toString().trim());
}

function decodePcm(file, channels, extraAf = []) {
  const af = [...extraAf, `aresample=${SR}`].join(',');
  const r = ffmpeg(['-i', file, '-af', af, '-ac', String(channels), '-f', 'f32le', '-ar', String(SR), 'pipe:1']);
  const b = r.stdout;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

function fetchSource(id, src) {
  fs.mkdirSync(CACHE, { recursive: true });
  const name = decodeURIComponent(path.basename(new URL(src.url).pathname)).replace(/[^\w.#-]+/g, '_');
  const file = path.join(CACHE, name);
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    console.log(`  fetch ${id} <- ${src.url}`);
    execFileSync('curl', ['-sfL', '--retry', '2', '-A', 'pirates-br-audio-build', '-o', file, src.url]);
  }
  return file;
}

function extractMember(archive, member) {
  const out = path.join(CACHE, 'x', path.basename(archive), member);
  if (!fs.existsSync(out)) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, execFileSync('unzip', ['-p', archive, member], { maxBuffer: 1 << 28 }));
  }
  return out;
}

/** Non-silent segments [start, end] of a file (silencedetect at -40 dB, 120 ms). */
function segments(file) {
  const err = ffmpeg(['-i', file, '-af', 'silencedetect=n=-40dB:d=0.12', '-f', 'null', '-']).stderr.toString();
  const total = probeDuration(file);
  const segs = [];
  let cur = 0;
  for (const m of err.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    const t = Math.max(0, Number(m[2]));
    if (m[1] === 'start') { if (t - cur > 0.05) segs.push([cur, t]); }
    else cur = t;
  }
  if (total - cur > 0.05) segs.push([cur, total]);
  return segs;
}

function interleavedFrames(pcm, ch) { return Math.floor(pcm.length / ch); }

/** Seamless loop of `len` s: tail [len, len+xf] crossfaded (equal power) into head [0, xf]. */
function makeLoop(pcm, ch, len, xf) {
  const n = Math.round(len * SR), x = Math.round(xf * SR);
  if (interleavedFrames(pcm, ch) < n + x) throw new Error(`source too short for a ${len}s loop + ${xf}s crossfade`);
  const out = new Float32Array(n * ch);
  out.set(pcm.subarray(0, n * ch));
  for (let i = 0; i < x; i++) {
    const t = i / x, a = Math.sin(t * Math.PI / 2), b = Math.cos(t * Math.PI / 2);
    for (let c = 0; c < ch; c++) out[i * ch + c] = pcm[i * ch + c] * a + pcm[(n + i) * ch + c] * b;
  }
  return out;
}

function fadeOut(pcm, ch, sec) {
  const frames = interleavedFrames(pcm, ch), n = Math.min(frames, Math.round(sec * SR));
  for (let i = 0; i < n; i++) {
    const g = i / n;
    for (let c = 0; c < ch; c++) pcm[(frames - 1 - i) * ch + c] *= g;
  }
}

function applyGain(pcm, db) {
  const g = 10 ** (db / 20), out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] * g;
  return out;
}

/** Look-ahead peak limiter in JS (hard ceiling `ceil`, 2 ms attack ramp, 40 ms release). */
function limit(pcm, ch, ceil = 0.85) {
  const frames = interleavedFrames(pcm, ch), A = Math.round(0.002 * SR);
  const req = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let p = 0;
    for (let c = 0; c < ch; c++) p = Math.max(p, Math.abs(pcm[f * ch + c]));
    req[f] = p > ceil ? ceil / p : 1;
  }
  const g = new Float32Array(frames);
  const rel = 1 - Math.exp(-1 / (0.04 * SR)), att = 1 - Math.exp(-1 / (A / 2));
  let prev = 1;
  for (let f = 0; f < frames; f++) {
    let m = 1;
    for (let j = f; j < Math.min(frames, f + A); j++) if (req[j] < m) m = req[j];
    prev = Math.min(m, prev + (1 - prev) * rel);
    g[f] = prev;
  }
  for (let f = frames - 2; f >= 0; f--) g[f] = Math.min(g[f], g[f + 1] + (1 - g[f + 1]) * att);
  const out = new Float32Array(pcm.length);
  for (let f = 0; f < frames; f++) for (let c = 0; c < ch; c++) out[f * ch + c] = pcm[f * ch + c] * g[f];
  return out;
}

/** Gain to target, limit peaks to about -1.4 dBFS, re-measure, repeat until within 0.5 LU. */
function normalise(pcm, ch, target) {
  let cur = pcm;
  for (let pass = 0; pass < 8; pass++) {
    const { lufs } = measure(cur, ch);
    if (!Number.isFinite(lufs)) throw new Error('silent or unmeasurable clip');
    if (Math.abs(lufs - target) <= 0.5 && pass > 0) return cur;
    cur = applyGain(cur, target - lufs);
    let peak = 0;
    for (let i = 0; i < cur.length; i++) peak = Math.max(peak, Math.abs(cur[i]));
    if (peak > 0.85) cur = limit(cur, ch);
  }
  return cur;
}

/** Encoder lead-in in frames: where the decoded MP3 best matches the PCM we fed it. */
function leadIn(fed, decoded, ch) {
  const win = Math.min(4096, interleavedFrames(fed, ch) - 1), maxLag = 3000;
  let best = 0, bestScore = -Infinity;
  for (let lag = 0; lag < maxLag && lag + win < interleavedFrames(decoded, ch); lag++) {
    let s = 0;
    for (let i = 0; i < win; i += 2) s += fed[i * ch] * decoded[(i + lag) * ch];
    if (s > bestScore) { bestScore = s; best = lag; }
  }
  return best;
}

function encodeMp3(pcm, ch, kbps, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  ffmpeg(['-y', '-f', 'f32le', '-ar', String(SR), '-ac', String(ch), '-i', 'pipe:0',
    '-codec:a', 'libmp3lame', '-b:a', `${kbps}k`, '-map_metadata', '-1', '-id3v2_version', '0',
    '-write_xing', '1', outFile], pcm);
}

function buildVariant(cfg, key, spec, v, idx, sourceFile) {
  const kind = cfg.kinds[spec.kind];
  const ch = spec.channels ?? 1;
  let file = sourceFile;
  if (v.member) file = extractMember(sourceFile, v.member);
  let start = v.start ?? 0, dur = v.dur;
  if (v.split !== undefined) {
    const segs = segments(file);
    const s = segs[v.split];
    if (!s) throw new Error(`${key}: split ${v.split} but only ${segs.length} segments`);
    start = Math.max(0, s[0] - 0.02);
    dur = Math.min(dur ?? Infinity, s[1] - start + 0.08);
  }
  const af = [];
  if (start > 0 || dur !== undefined) af.push(`atrim=start=${start}${dur !== undefined ? `:duration=${dur + (spec.kind === 'bed' ? 0 : 0)}` : ''}`, 'asetpts=PTS-STARTPTS');
  if (v.semitones) {
    const r = 2 ** (v.semitones / 12);
    af.push(`aresample=${SR}`, `asetrate=${Math.round(SR * r)}`);
  }
  let pcm = decodePcm(file, ch, af);
  const isBed = spec.kind === 'bed';
  let loopLen;
  if (isBed) {
    loopLen = spec.loopLen ?? kind.loopLen;
    pcm = makeLoop(pcm, ch, loopLen, spec.xfade ?? kind.xfade);
  } else {
    const maxFrames = Math.round(kind.maxDur * SR);
    if (interleavedFrames(pcm, ch) > maxFrames) {
      pcm = pcm.slice(0, maxFrames * ch);
      fadeOut(pcm, ch, 0.12);
    } else fadeOut(pcm, ch, 0.004);
  }
  pcm = normalise(pcm, ch, kind.lufs);
  const rel = `${spec.tier}/${key}.${idx + 1}.mp3`;
  const outFile = path.join(OUT_DIR, rel);
  const kbps = ch === 2 ? (kind.stereoBitrate ?? kind.bitrate) : kind.bitrate;
  // The encoder's lowpass eats the K-weighted top octave of clicks and hisses, so the loudness
  // that ships can sit 1-3 LU under the PCM we fed it: measure the MP3 and re-encode until it lands.
  // Each pass: gain by the measured miss, then the limiter; an MP3 peak overshoot lowers the
  // limiter ceiling by exactly the overshoot. A variant that will not converge fails the build.
  let shipped, ceil = 0.85, converged = false;
  for (let pass = 0; pass < 12 && !converged; pass++) {
    encodeMp3(pcm, ch, kbps, outFile);
    shipped = measure(outFile);
    const err = kind.lufs - shipped.lufs;
    converged = Math.abs(err) <= 0.75 && shipped.peakDb <= -0.8; // gate allows 1 LU
    if (converged) break;
    if (shipped.peakDb > -0.8) ceil *= 10 ** ((-1.0 - shipped.peakDb) / 20);
    pcm = limit(applyGain(pcm, err), ch, ceil);
  }
  if (!converged) throw new Error(`no convergence: ${shipped.lufs} LUFS (target ${kind.lufs}), peak ${shipped.peakDb} dBFS`);
  const entry = {
    file: rel, source: v.src, ...(v.member ? { member: v.member } : {}),
    ...(v.semitones ? { derived: `pitch ${v.semitones > 0 ? '+' : ''}${v.semitones} st of variant source` } : {}),
    bytes: fs.statSync(outFile).size, duration: +probeDuration(outFile).toFixed(3), channels: ch,
    lufs: +shipped.lufs.toFixed(2), peakDb: +shipped.peakDb.toFixed(2),
  };
  if (isBed) {
    const decoded = decodePcm(outFile, ch);
    const lag = leadIn(pcm, decoded, ch);
    entry.loopStart = +(lag / SR).toFixed(5);
    entry.loopEnd = +((lag + Math.round(loopLen * SR)) / SR).toFixed(5);
  }
  return entry;
}

export function loadSources() { return JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8')); }

function main() {
  const cfg = loadSources();
  const only = process.argv.includes('--key') ? process.argv[process.argv.indexOf('--key') + 1] : null;
  for (const [id, s] of Object.entries(cfg.sources)) {
    if (!cfg.allowedLicenses.includes(s.license) || FORBIDDEN_LICENSE.test(s.license)) {
      throw new Error(`REFUSED source ${id}: licence "${s.license}" is not allowed (D31)`);
    }
    for (const f of ['url', 'page', 'author', 'license']) if (!s[f]) throw new Error(`source ${id} lacks ${f}`);
  }
  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  const prev = only && fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  const keys = prev ? { ...prev.keys } : {};
  if (!only && fs.existsSync(OUT_DIR)) {
    for (const t of ['boot', 'match', 'zones', 'music']) fs.rmSync(path.join(OUT_DIR, t), { recursive: true, force: true });
  }
  const failures = [];
  for (const [key, spec] of Object.entries(cfg.keys)) {
    if (only && key !== only) continue;
    const files = [];
    spec.variants.forEach((v, i) => {
      try {
        const src = cfg.sources[v.src];
        if (!src) throw new Error(`unknown source ${v.src}`);
        files.push(buildVariant(cfg, key, spec, v, i, fetchSource(v.src, src)));
      } catch (e) { failures.push(`${key}#${i + 1}: ${e.message.split('\n')[0]}`); }
    });
    const k = cfg.kinds[spec.kind];
    keys[key] = { tier: spec.tier, kind: spec.kind, loop: spec.kind === 'bed', frequent: !!spec.frequent, targetLufs: k.lufs, files };
    console.log(`  ${key.padEnd(18)} ${files.map((f) => `${(f.bytes / 1024).toFixed(0)}K ${f.duration}s ${f.lufs}LUFS`).join(' | ')}`);
  }
  const tiers = {};
  for (const k of Object.values(keys)) for (const f of k.files) tiers[k.tier] = (tiers[k.tier] ?? 0) + f.bytes;
  const manifest = {
    version: 1, generatedBy: 'scripts/audio/build-audio.mjs from scripts/audio/sources.json',
    format: 'mp3', sampleRate: SR, targetsLufs: Object.fromEntries(Object.entries(cfg.kinds).map(([n, k]) => [n, k.lufs])),
    tierBytes: tiers, keys,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const rows = [];
  for (const [key, k] of Object.entries(keys)) for (const f of k.files) {
    const s = cfg.sources[f.source];
    rows.push(`| ${f.file} | ${key} | ${s.url} | ${s.page} | ${s.author} | ${s.license} |${f.member ? ` ${f.member}` : ''}${f.derived ? ` (${f.derived})` : ''} |`);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'LICENSES.md'), [
    '# Audio licences', '',
    'Generated by `scripts/audio/build-audio.mjs` from `scripts/audio/sources.json`; do not edit by hand.',
    'Every shipped file has one row. CC0 needs no credit; every row still reaches the in-game Credits panel',
    'through `public/credits.json` (scripts/build-credits.mjs), where CC-BY rows are required to appear.', '',
    '| file | key | source | page | author | licence | notes |', '|---|---|---|---|---|---|---|', ...rows, '',
  ].join('\n'));
  // The in-game Credits panel reads public/credits.json, which scripts/build-credits.mjs builds from
  // every LICENSES.md in the repo (test-front-door fails it when stale): rebuild it here so a new
  // sound and its credit land in the same commit.
  fs.rmSync(path.join(OUT_DIR, 'credits.json'), { force: true });
  execFileSync('node', [path.join(ROOT, 'scripts/build-credits.mjs')], { stdio: 'inherit' });
  const mb = (b) => (b / 1e6).toFixed(3);
  console.log(`tiers MB: ${Object.entries(tiers).map(([t, b]) => `${t} ${mb(b)}`).join(', ')}; total ${mb(Object.values(tiers).reduce((a, b) => a + b, 0))}`);
  if (failures.length) {
    console.error(`FAIL ${failures.length} variant(s):\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('OK: audio built');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
