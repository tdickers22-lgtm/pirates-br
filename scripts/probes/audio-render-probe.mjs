#!/usr/bin/env node
// audio-render-probe (b2.4h; vm:audio:4): render the REAL SoundEngine graph through an
// OfflineAudioContext in one headless Chromium and measure the samples that come out.
//
// Pure models (test-audio-models, test-flood-audio, test-ambience) run on a fake graph and cannot
// see clipping, a NaN that poisons the mix, or a sample path that plays silence. This probe can.
//
//   scene    a 6-gun broadside at 8-40 m + return fire hitting the hull, splashes, a hole punched
//            with the flooding gush loop running, a geyser erupting 12 m away and a lava crater,
//            master at 100 %: peak <= -1 dBFS after the limiter, no NaN / Infinity, not silent.
//   keys     every scripted sample key renders on its own through playSample: decoded, returns
//            true, peak above -50 dBFS (no silent sample path).
//   zones    the geyser voice at eruption level 1 is louder than at level 0 (same place, same
//            renderer), and the lava crater + caldera rumble render audible.
//
// Heavy (one headless SwiftShader Chromium + Vite on 3101, both closed in finally). No game server.
// Run: node scripts/probes/audio-render-probe.mjs   (exit 1 on any FAIL; JSON in /tmp/pbr-audio-render.json)
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { browserArgs } from '../lib/browser-args.mjs';
import { ensureDevClient, stopDevClient } from '../lib/dev-client.mjs';

const BASE = process.env.PIRATES_PROBE_URL ?? 'http://localhost:3101/';
const KEYS = ['cannon.fire', 'wood.crack', 'wood.plank', 'hammer.hit', 'splash.cannon', 'splash.small', 'bed.floodGush',
  'bed.ocean', 'bed.waterfall', 'steam.hiss', 'bird.day', 'creature.frog', 'footstep.wood', 'ui.click'];
const PEAK_CEIL_DB = -1;
const AUDIBLE_DB = -50;

let dev = null;
let browser = null;
let failed = 0;
const rows = [];
function check(name, ok, detail) {
  if (!ok) failed += 1;
  rows.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
}

try {
  dev = await ensureDevClient(BASE);
  browser = await chromium.launch({ headless: true, args: browserArgs(['--mute-audio', '--autoplay-policy=no-user-gesture-required']) });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', (e) => console.warn('[page]', e.message));
  // A static file keeps the origin without booting the game (the SPA fallback would).
  await page.goto(`${BASE}assets/audio/manifest.json`);
  const res = await page.evaluate(async (KEYS) => {
    const SE = await import('/src/client/audio/SoundEngine.ts');
    const AMB = await import('/src/client/audio/Ambience.ts');
    const SR = 48000;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const measure = (buf) => {
      let peak = 0; let sum = 0; let bad = 0; let n = 0;
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < d.length; i++) {
          const v = d[i];
          if (!Number.isFinite(v)) { bad += 1; continue; }
          const a = Math.abs(v);
          if (a > peak) peak = a;
          sum += v * v; n += 1;
        }
      }
      const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
      return { peakDb: db(peak), rmsDb: db(Math.sqrt(sum / Math.max(1, n))), nonFinite: bad };
    };
    // One engine per render, built on an OfflineAudioContext handed in through the constructor
    // the engine itself calls (window.AudioContext), so the graph is exactly the shipped one.
    async function engineOn(seconds, keys) {
      const off = new OfflineAudioContext(2, Math.round(SR * seconds), SR);
      const Orig = window.AudioContext;
      window.AudioContext = function OfflineShim() { return off; };
      const eng = new SE.SoundEngine();
      try { eng.unlock(); } finally { window.AudioContext = Orig; }
      eng.setVolume(1);
      eng.setListenerPose({ x: 0, y: 2, z: 0 }, { x: 0, y: 0, z: -1 });
      const bank = eng.bank;
      const t0 = performance.now();
      while (bank && !bank.hasManifest() && performance.now() - t0 < 15000) await sleep(50);
      for (const k of keys) bank?.request(k);
      const missing = new Set(keys);
      while (missing.size && performance.now() - t0 < 30000) {
        for (const k of [...missing]) if (bank?.pick(k)) missing.delete(k);
        if (missing.size) await sleep(100);
      }
      return { off, eng, missing: [...missing] };
    }
    const out = { keys: {}, scene: null, zones: {} };
    for (const key of KEYS) {
      const { off, eng, missing } = await engineOn(2, [key]);
      const played = eng.playSample(key, { bus: key === 'ui.click' ? 'ui' : 'sfx', volume: 1 });
      const m = measure(await off.startRendering());
      out.keys[key] = { ...m, played, decoded: missing.length === 0 };
    }
    {
      const { off, eng, missing } = await engineOn(4, ['cannon.fire', 'wood.crack', 'splash.cannon', 'bed.floodGush', 'steam.hiss']);
      let lv = 1;
      AMB.setZoneSourceProvider(() => [{ islandId: 'probe', biome: 'volcanic', x: 30, z: 0, radius: 80,
        caldera: { x: 6, y: 2, z: 6 }, geysers: [{ x: 12, y: 2, z: 0, level: lv }] }]);
      for (let i = 0; i < 6; i++) eng.playCannonFire(8 + i * 6, { x: -4 + i * 1.6, y: 2, z: -8 - i * 6 });
      eng.playProjectileImpact('hull', 6, { x: 3, y: 1, z: 2 });
      eng.playSplash(1, 14, { x: 10, y: 0, z: -12 });
      eng.playSample('wood.crack', { pos: { x: 2, y: 0.5, z: 1 }, volume: 1.2 });
      eng.playSample('bed.floodGush', { pos: { x: 2, y: 0.2, z: 1 }, volume: 1.2 });
      for (let f = 0; f < 3; f++) eng.setAmbience({ nightFactor: 0, storminess: 0.3, nearShore01: 0.6 });
      const m = measure(await off.startRendering());
      out.scene = { ...m, missing };
      AMB.setZoneSourceProvider(null);
    }
    for (const [name, level] of [['geyser0', 0], ['geyser1', 1]]) {
      const { off, eng } = await engineOn(2.5, ['steam.hiss']);
      AMB.setZoneSourceProvider(() => [{ islandId: 'g', biome: 'bone', x: 400, z: 0, radius: 20,
        caldera: null, geysers: [{ x: 12, y: 2, z: 0, level }] }]);
      for (let f = 0; f < 3; f++) eng.setAmbience({ nightFactor: 0, storminess: 0, nearShore01: 0 });
      out.zones[name] = measure(await off.startRendering());
      AMB.setZoneSourceProvider(null);
    }
    {
      const { off, eng } = await engineOn(2.5, []);
      AMB.setZoneSourceProvider(() => [{ islandId: 'c', biome: 'bone', x: 400, z: 0, radius: 20,
        caldera: { x: 0, y: 2, z: 8 }, geysers: [] }]);
      for (let f = 0; f < 3; f++) eng.setAmbience({ nightFactor: 0, storminess: 0, nearShore01: 0 });
      out.zones.crater = measure(await off.startRendering());
      AMB.setZoneSourceProvider(null);
    }
    return out;
  }, KEYS);

  const s = res.scene;
  check('scene: broadside + hull hit + splash + hole punch + flood gush + geyser/lava at master 100 %: peak <= -1 dBFS, no NaN, not silent',
    s.nonFinite === 0 && s.peakDb <= PEAK_CEIL_DB && s.rmsDb > -40 && s.missing.length === 0,
    `peak ${s.peakDb.toFixed(2)} dBFS, rms ${s.rmsDb.toFixed(1)} dBFS, non-finite ${s.nonFinite}${s.missing.length ? `, undecoded ${s.missing.join(',')}` : ''}`);
  for (const [k, m] of Object.entries(res.keys)) {
    check(`key ${k}: decoded, played, audible, finite, peak <= -1 dBFS`, m.decoded && m.played && m.peakDb > AUDIBLE_DB && m.nonFinite === 0 && m.peakDb <= PEAK_CEIL_DB,
      `peak ${m.peakDb.toFixed(1)} rms ${m.rmsDb.toFixed(1)} dBFS, played ${m.played}, decoded ${m.decoded}`);
  }
  const g0 = res.zones.geyser0; const g1 = res.zones.geyser1; const cr = res.zones.crater;
  check('zones: geyser at eruption level 1 renders >= 10 dB above level 0 at the same spot', g1.rmsDb - g0.rmsDb >= 10 && g1.nonFinite === 0,
    `level 0 rms ${g0.rmsDb.toFixed(1)}, level 1 rms ${g1.rmsDb.toFixed(1)} dBFS`);
  check('zones: caldera rumble + lava crater audible 8 m away, finite', cr.rmsDb > -60 && cr.nonFinite === 0, `rms ${cr.rmsDb.toFixed(1)} peak ${cr.peakDb.toFixed(1)} dBFS`);
  writeFileSync('/tmp/pbr-audio-render.json', JSON.stringify({ rows, res }, null, 1));
} catch (err) {
  failed += 1;
  console.error('FAIL  probe crashed:', err?.stack ?? err);
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  try { stopDevClient(dev); } catch { /* gone */ }
}
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: audio-render-probe, ${rows.length - (failed && rows.length ? rows.filter((r) => !r.ok).length : 0)} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
