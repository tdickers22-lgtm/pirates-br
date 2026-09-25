#!/usr/bin/env node
// test-audio-manifest — the sampled-audio contract (D31; audio-01, audio-14, audio-03, b2.4a).
//
// Grades what SHIPS, not what the build said: every file under public/assets/audio is re-read
// and re-measured with ffmpeg (EBU R128), so a hand-dropped, hand-edited or re-encoded file fails.
//   - manifest.json exists; every key has >= 1 file, frequent keys >= 3 variants
//   - every file exists, is MP3 (ID3 or MPEG frame sync), matches its manifest byte count
//   - every file has a LICENSES.md row with an allowed licence (CC0/PD, CC-BY only with credit);
//     CC-BY rows appear in public/credits.json (the in-game Credits panel); sources.json itself carries no forbidden licence
//   - tier budgets (MB = 1e6 B): boot <= 1.5, match <= 3.5, zones <= 2.0, music <= 1.0 (reserved
//     for b3.5g), total <= 8.0
//   - no orphans (a file on disk that the manifest does not reference)
//   - loudness within 1 LU of the kind target (-18 one-shot, -26 bed, -24 UI), sample peak
//     <= -0.5 dBFS; one-shots <= 3 s, loops 8-12 s with loop points inside the file
//   - single writer per bed: setWaveBed / setHullCreakIntensity / setWindIntensity have exactly
//     one call site each in src/ (audio-03), and hull creak strain is exactly 0 unless the
//     listener is aboard or within 15 m of a hull
// Run with tsx (it imports SoundEngine.ts for the creak model): node --import tsx scripts/test-audio-manifest.mjs

import fs from 'node:fs';
import path from 'node:path';
import { FORBIDDEN_LICENSE, OUT_DIR, ROOT, loadSources, measure } from './audio/build-audio.mjs';

let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { failed++; console.log(`  ✗ ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

const BUDGET_MB = { boot: 1.5, match: 3.5, zones: 2.0, music: 1.0 };
const TOTAL_MB = 8.0;
const META = new Set(['manifest.json', 'LICENSES.md']);

const cfg = loadSources();
for (const [id, s] of Object.entries(cfg.sources)) {
  if (!cfg.allowedLicenses.includes(s.license) || FORBIDDEN_LICENSE.test(s.license)) bad(`sources.json ${id}: licence "${s.license}" not allowed`);
}
for (const l of cfg.allowedLicenses) if (FORBIDDEN_LICENSE.test(l) || !/^(CC0-1\.0|PD|CC-BY-[34]\.0)$/.test(l)) bad(`allowedLicenses contains "${l}"`);

const manifestPath = path.join(OUT_DIR, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  bad(`no ${path.relative(ROOT, manifestPath)} (run node scripts/audio/build-audio.mjs)`);
} else {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const keys = Object.entries(manifest.keys ?? {});
  check(keys.length >= 20, `manifest has ${keys.length} keys (>= 20)`);
  for (const key of Object.keys(cfg.keys)) if (!manifest.keys[key]) bad(`sources.json key ${key} missing from the manifest`);

  // LICENSES.md rows: | file | key | source file | page | author | licence | notes |
  const licPath = path.join(OUT_DIR, 'LICENSES.md');
  const lic = new Map();
  if (fs.existsSync(licPath)) {
    for (const line of fs.readFileSync(licPath, 'utf8').split('\n')) {
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length >= 8 && /\.mp3$/.test(cells[1])) lic.set(cells[1], { url: cells[3], author: cells[5], license: cells[6] });
    }
  } else bad('no LICENSES.md');
  // In-game credits: public/credits.json, built from every LICENSES.md by scripts/build-credits.mjs.
  const creditsPath = path.join(ROOT, 'public/credits.json');
  const creditsText = fs.existsSync(creditsPath) ? fs.readFileSync(creditsPath, 'utf8') : '';
  check(creditsText.includes('assets/audio/LICENSES.md'), 'public/credits.json is built from public/assets/audio/LICENSES.md');

  const referenced = new Set();
  const tierBytes = {};
  let loudFails = 0, measured = 0, fileFails = 0;
  for (const [key, k] of keys) {
    const files = k.files ?? [];
    if (files.length < 1) { bad(`${key}: no files`); continue; }
    if (k.frequent && files.length < 3) bad(`${key}: frequent event has ${files.length} variants (< 3)`);
    if (!(k.tier in BUDGET_MB)) bad(`${key}: unknown tier ${k.tier}`);
    for (const f of files) {
      referenced.add(f.file);
      const abs = path.join(OUT_DIR, f.file);
      if (!fs.existsSync(abs)) { bad(`${key}: ${f.file} missing on disk`); fileFails++; continue; }
      const buf = fs.readFileSync(abs);
      tierBytes[k.tier] = (tierBytes[k.tier] ?? 0) + buf.length;
      const isMp3 = f.file.endsWith('.mp3') && ((buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0));
      if (!isMp3) { bad(`${f.file}: not an MP3`); fileFails++; }
      if (buf.length !== f.bytes) { bad(`${f.file}: ${buf.length} B on disk, manifest says ${f.bytes}`); fileFails++; }
      const row = lic.get(f.file);
      if (!row) { bad(`${f.file}: no LICENSES.md row`); fileFails++; }
      else {
        if (!cfg.allowedLicenses.includes(row.license) || FORBIDDEN_LICENSE.test(row.license)) { bad(`${f.file}: licence ${row.license} not allowed`); fileFails++; }
        if (!/^https:\/\//.test(row.url) || !row.author) { bad(`${f.file}: LICENSES row lacks url/author`); fileFails++; }
        if (cfg.creditRequired.includes(row.license) && !creditsText.includes(f.file)) { bad(`${f.file}: ${row.license} without a credits.json row`); fileFails++; }
      }
      if (k.loop) {
        if (!(f.duration >= 7.9 && f.duration <= 12.2)) { bad(`${f.file}: loop ${f.duration}s outside 8-12 s`); fileFails++; }
        if (!(f.loopStart >= 0 && f.loopEnd > f.loopStart && f.loopEnd <= f.duration + 1e-3)) { bad(`${f.file}: loop points ${f.loopStart}..${f.loopEnd} not inside ${f.duration}s`); fileFails++; }
      } else if (!(f.duration <= 3.1)) { bad(`${f.file}: one-shot ${f.duration}s > 3 s`); fileFails++; }
      const m = measure(abs);
      measured++;
      if (!(Math.abs(m.lufs - k.targetLufs) <= 1)) { bad(`${f.file}: ${m.lufs} LUFS, target ${k.targetLufs} +-1`); loudFails++; }
      if (!(m.peakDb <= -0.5)) { bad(`${f.file}: sample peak ${m.peakDb} dBFS > -0.5`); loudFails++; }
    }
  }
  check(fileFails === 0, `${referenced.size} files: exist, MP3, byte counts, LICENSES rows, allowed licences, credits, durations`);
  check(measured > 0 && loudFails === 0, `${measured} files re-measured: loudness within 1 LU of target, peak <= -0.5 dBFS`);

  let total = 0;
  for (const [tier, cap] of Object.entries(BUDGET_MB)) {
    const mb = (tierBytes[tier] ?? 0) / 1e6;
    total += mb;
    check(mb <= cap, `tier ${tier}: ${mb.toFixed(3)} MB <= ${cap} MB`);
  }
  check(total <= TOTAL_MB, `total ${total.toFixed(3)} MB <= ${TOTAL_MB} MB`);

  const orphans = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else {
        const rel = path.relative(OUT_DIR, abs).split(path.sep).join('/');
        if (!META.has(rel) && !referenced.has(rel)) orphans.push(rel);
      }
    }
  };
  walk(OUT_DIR);
  check(orphans.length === 0, `no orphan files${orphans.length ? `: ${orphans.slice(0, 5).join(', ')}` : ''}`);
}

// ── audio-03: one writer per bed ────────────────────────────────────────────
const srcFiles = [];
const walkSrc = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkSrc(abs);
    else if (/\.tsx?$/.test(e.name)) srcFiles.push(abs);
  }
};
walkSrc(path.join(ROOT, 'src'));
for (const fn of ['setWaveBed', 'setHullCreakIntensity', 'setWindIntensity']) {
  const sites = [];
  for (const f of srcFiles) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (new RegExp(`\\.${fn}\\(`).test(line) && !/^\s*(\/\/|\*)/.test(line)) sites.push(`${path.relative(ROOT, f)}:${i + 1}`);
    });
  }
  check(sites.length === 1, `${fn} has exactly one call site (${sites.join(', ') || 'none'})`);
}

try {
  const { hullCreakStrain } = await import('../src/client/audio/SoundEngine.ts');
  if (typeof hullCreakStrain !== 'function') bad('SoundEngine exports no hullCreakStrain');
  else {
    const far = hullCreakStrain({ aboard: false, nearHullM: 300, heel01: 1, rough01: 1 });
    const none = hullCreakStrain({ aboard: false, heel01: 0.5, rough01: 0.5 });
    const edge = hullCreakStrain({ aboard: false, nearHullM: 15.01, heel01: 1, rough01: 1 });
    const near = hullCreakStrain({ aboard: false, nearHullM: 8, heel01: 0.3, rough01: 0.3 });
    const onboard = hullCreakStrain({ aboard: true, heel01: 0.3, rough01: 0.3 });
    check(far === 0 && none === 0 && edge === 0, `hull creak exactly 0 ashore / beyond 15 m (300 m ${far}, no ship ${none}, 15.01 m ${edge})`);
    check(onboard > 0 && near > 0 && near < onboard, `hull creak audible aboard (${onboard.toFixed(3)}) and fainter within 15 m (${near.toFixed(3)})`);
  }
} catch (e) {
  bad(`import SoundEngine.ts failed (run with --import tsx): ${e.message.split('\n')[0]}`);
}

console.log(failed ? `FAIL test-audio-manifest: ${failed} check(s) failed` : 'PASS test-audio-manifest');
process.exit(failed ? 1 : 0);
