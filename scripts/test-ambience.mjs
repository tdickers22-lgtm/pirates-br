#!/usr/bin/env node
// test-ambience (b2.4h; audio-07, audio-11): zone ambience laws + the audio settings round trip.
//
//   pure     geyserVoice non-decreasing in geyserEruptionLevel at every distance, 0 past 170 m;
//            caldera / lava / waterfall fall with distance and reach exactly 0; jungle birds by
//            day inland on a lush island, insects + frogs at night, nothing out at sea, a storm
//            hushes them; the planner fires ONE steam burst per geyser onset, birds by day,
//            frogs by night, lava bubbles near the crater, nothing at sea; a throwing provider
//            yields [] (never throws into the frame loop).
//   settings parse(serialize(s)) === s for random settings; garbage / poison -> clamped defaults;
//            the legacy {volume, muted} object still loads; applyAudioSettings drives every bus.
//   static   VolcanicFx installs the provider with the shared geyserEruptionLevel; SoundEngine
//            plans zones inside setAmbience, waterfall is sample-first, focus mute exists;
//            MenuController builds the 4 bus sliders + focus mute + mix toggle and applies them.
//
// Run: node --import tsx scripts/test-ambience.mjs
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..') + '/';
let fails = 0;
let passes = 0;
function check(name, ok, detail = '') {
  if (ok) passes += 1; else fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const A = await import('../src/client/audio/Ambience.ts');
const S = await import('../src/client/audio/audioSettings.ts');

// ── pure laws ──────────────────────────────────────────────────────────────
{
  let worst = '';
  for (const d of [0, 5, 20, 60, 120, 160]) {
    let prev = null;
    for (let i = 0; i <= 100; i++) {
      const v = A.geyserVoice(i / 100, d);
      if (prev && (v.hiss < prev.hiss - 1e-12 || v.roar < prev.roar - 1e-12 || v.cutoffHz < prev.cutoffHz - 1e-9)) worst = `d=${d} level ${i / 100}`;
      prev = v;
    }
  }
  const at0 = A.geyserVoice(0, 10);
  const at1 = A.geyserVoice(1, 10);
  check('geyserVoice non-decreasing in eruption level (hiss, roar, cutoff) at 6 distances', worst === '' && at1.hiss > at0.hiss * 4 && at1.roar > 0.3, worst || `10 m: idle hiss ${at0.hiss.toFixed(3)} full ${at1.hiss.toFixed(3)} roar ${at1.roar.toFixed(3)}`);
  const far = A.geyserVoice(1, 171);
  check('geyserVoice silent past 170 m and for non-finite input', far.hiss === 0 && far.roar === 0 && A.geyserVoice(NaN, NaN).hiss === 0, `171 m hiss ${far.hiss}`);
  const mono = (f, ds) => ds.every((d, i) => i === 0 || f(d) <= f(ds[i - 1]) + 1e-12);
  const ds = [0, 10, 30, 31, 60, 100, 180, 250, 259, 261, 400];
  check('calderaRumble 1 within 30 m, falling, 0 past 260 m', A.calderaRumble(20) === 1 && mono(A.calderaRumble, ds) && A.calderaRumble(261) === 0, `100 m ${A.calderaRumble(100).toFixed(3)}`);
  check('lavaBubble falls to 0 past 70 m, faster bubbling up close', mono((d) => A.lavaBubble(d).level, ds) && A.lavaBubble(71).level === 0 && A.lavaBubble(5).perSec > A.lavaBubble(40).perSec, `5 m ${A.lavaBubble(5).perSec.toFixed(2)}/s`);
  check('waterfallLevel falls with distance, 0 at 130 m / null, bigger fall louder', mono((d) => A.waterfallLevel(d, 1), ds) && A.waterfallLevel(130, 1) === 0 && A.waterfallLevel(null) === 0 && A.waterfallLevel(20, 1.4) > A.waterfallLevel(20, 0.6), `20 m ${A.waterfallLevel(20, 1).toFixed(3)}`);
  const j = (o) => A.jungleLevels({ biome: 'lush', distToCentreM: 20, radiusM: 100, night01: 0, storm01: 0, ...o });
  check('jungle: lush day inland = birds, no insects; night = insects + frogs, no birds',
    j({}).dayBirds > 0.8 && j({}).insects === 0 && j({ night01: 1 }).dayBirds === 0 && j({ night01: 1 }).insects > 0.8 && j({ night01: 1 }).frogs > 0.8,
    `day birds ${j({}).dayBirds.toFixed(2)}, night insects ${j({ night01: 1 }).insects.toFixed(2)}`);
  check('jungle: 0 from 1.15 radii out (at sea), storm hushes, bone island nearly silent',
    j({ distToCentreM: 116 }).dayBirds === 0 && j({ storm01: 1 }).dayBirds < j({}).dayBirds * 0.2 && j({ biome: 'bone' }).dayBirds < 0.1,
    `storm ${j({ storm01: 1 }).dayBirds.toFixed(3)}`);
}

// ── planner ────────────────────────────────────────────────────────────────
{
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const geyser = { x: 50, y: 4, z: 0, level: 0 };
  const zone = { islandId: 'v1', biome: 'volcanic', x: 0, z: 0, radius: 120, caldera: { x: 0, y: 60, z: 0 }, geysers: [geyser] };
  const amb = new A.Ambience(rand);
  const ear = { x: 40, y: 3, z: 0 };
  let steam = 0;
  let firstRoar = 0;
  for (let i = 0; i < 400; i++) {
    const t = i * 0.05;
    geyser.level = Math.max(0, Math.sin(t * 0.8)); // two eruptions in 20 s
    const f = amb.update(t, ear, 0, 0, [zone]);
    steam += f.calls.filter((c) => c.key === 'steam.hiss').length;
    if (geyser.level > 0.95) firstRoar = Math.max(firstRoar, f.geyser.roar);
  }
  check('planner: one steam burst per geyser onset, voice follows the level', steam === 3 && firstRoar > 0.2, `${steam} bursts over 3 onsets, roar at peak ${firstRoar.toFixed(3)}`);
  const lush = { islandId: 'l1', biome: 'lush', x: 0, z: 0, radius: 100, caldera: null, geysers: [] };
  const count = (night, e, zones = [lush]) => {
    const p = new A.Ambience(rand);
    const keys = {};
    for (let i = 0; i < 1200; i++) for (const c of p.update(i * 0.05, e, night, 0, zones).calls) keys[c.key || 'bubble'] = (keys[c.key || 'bubble'] ?? 0) + 1;
    return keys;
  };
  const day = count(0, { x: 10, y: 2, z: 5 });
  const night = count(1, { x: 10, y: 2, z: 5 });
  const sea = count(0, { x: 400, y: 2, z: 0 });
  check('planner: lush island by day = bird calls (5-40 per min), by night = frogs, none at sea',
    (day['bird.day'] ?? 0) >= 5 && (day['bird.day'] ?? 0) <= 40 && !day['creature.frog'] && (night['creature.frog'] ?? 0) >= 5 && !night['bird.day'] && Object.keys(sea).length === 0,
    `day ${JSON.stringify(day)}, night ${JSON.stringify(night)}, sea ${JSON.stringify(sea)}`);
  const crater = count(0, { x: 0, y: 58, z: 3 }, [{ ...zone, geysers: [] }]);
  const plan = new A.Ambience(rand).update(0, { x: 0, y: 58, z: 3 }, 0, 0, [zone]);
  check('planner: at the crater rim the caldera rumbles and lava bubbles', plan.caldera === 1 && plan.lava > 0.5 && (crater.bubble ?? 0) > 60, `lava ${plan.lava.toFixed(2)}, ${crater.bubble ?? 0} bubbles/min`);
  A.setZoneSourceProvider(() => { throw new Error('boom'); });
  const z1 = A.zoneSources();
  A.setZoneSourceProvider(() => [zone]);
  const z2 = A.zoneSources();
  A.setZoneSourceProvider(null);
  check('zoneSources: a throwing provider yields [] and never throws; installed provider is read', Array.isArray(z1) && z1.length === 0 && z2.length === 1 && A.zoneSources().length === 0);
}

// ── settings round trip ────────────────────────────────────────────────────
{
  let ok = true;
  let seed = 3;
  const r = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 200; i++) {
    const s = { volume: r(), muted: r() > 0.5, music: r(), effects: r(), ambience: r(), ui: r(), muteUnfocused: r() > 0.5, mixWithOthers: r() > 0.5 };
    const back = S.parseAudioSettings(S.serializeAudioSettings(s));
    if (JSON.stringify(back) !== JSON.stringify(s)) { ok = false; break; }
  }
  check('settings: parse(serialize(s)) === s for 200 random settings', ok);
  const poison = S.parseAudioSettings({ volume: NaN, music: 7, effects: -2, ambience: 'x', ui: Infinity, muteUnfocused: 'yes', mixWithOthers: 1 });
  const legacy = S.parseAudioSettings('{"volume":0.3,"muted":true}');
  check('settings: poison clamps / falls back, garbage string and null -> defaults, legacy {volume,muted} loads',
    poison.volume === 0.55 && poison.music === 1 && poison.effects === 0 && poison.ambience === 1 && poison.ui === 0.8 && poison.muteUnfocused === true && poison.mixWithOthers === false
      && JSON.stringify(S.parseAudioSettings('{nope')) === JSON.stringify(S.AUDIO_SETTINGS_DEFAULTS) && JSON.stringify(S.parseAudioSettings(null)) === JSON.stringify(S.AUDIO_SETTINGS_DEFAULTS)
      && legacy.volume === 0.3 && legacy.muted === true && legacy.music === 0.8,
    JSON.stringify(poison));
  const log = [];
  const sink = {
    setVolume: (v) => log.push(['vol', v]), setMuted: (m) => log.push(['mute', m]), setBusVolume: (b, v) => log.push([b, v]),
    setMuteWhenUnfocused: (o) => log.push(['focus', o]), setMixWithOthers: (m) => log.push(['mix', m]),
  };
  S.applyAudioSettings(sink, { ...S.AUDIO_SETTINGS_DEFAULTS, music: 0.2, effects: 0.4, ambience: 0.6, ui: 0.1, mixWithOthers: true });
  const got = Object.fromEntries(log.map(([k, v]) => [k, v]));
  check('settings: apply drives master, mute, music/sfx/ambience/ui buses, focus mute, mix', got.music === 0.2 && got.sfx === 0.4 && got.ambience === 0.6 && got.ui === 0.1 && got.vol === 0.55 && got.mute === false && got.focus === true && got.mix === true, JSON.stringify(got));
}

// ── static wiring ──────────────────────────────────────────────────────────
{
  const vfx = readFileSync(`${ROOT}src/client/world/island/VolcanicFx.ts`, 'utf8');
  const eng = readFileSync(`${ROOT}src/client/audio/SoundEngine.ts`, 'utf8');
  const menu = readFileSync(`${ROOT}src/client/menu/MenuController.ts`, 'utf8');
  check('static: VolcanicFx installs the zone provider, levels from the shared geyserEruptionLevel',
    /setZoneSourceProvider\(/.test(vfx) && /registerSoundZone|soundZones/.test(vfx) && (vfx.match(/geyserEruptionLevel\(/g) ?? []).length >= 2);
  const amb = eng.slice(eng.indexOf('  setAmbience('), eng.indexOf('  private tickSchedulers('));
  check('static: SoundEngine plans zones inside setAmbience, waterfall bed sample-first, focus mute + zones preload',
    /zoneSources\(\)/.test(amb) && /'bed\.waterfall'/.test(eng) && /setMuteWhenUnfocused\(/.test(eng) && /setWindowFocused\(/.test(eng) && /preloadTier\('zones'\)/.test(eng));
  check('static: MenuController has Music/Effects/Ambience/UI sliders, focus mute, mix toggle, applyAudioSettings',
    /applyAudioSettings\(/.test(menu) && /parseAudioSettings\(/.test(menu) && /setBusVolume\(/.test(menu) && /setWindowFocused\(/.test(menu)
      && /settings-vol-\$\{key\}/.test(menu) && ['Music', 'Effects', 'Ambience', 'Interface'].every((k) => menu.includes(`'${k}'`)) && /mixWithOthers/.test(menu) && /muteUnfocused/.test(menu));
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: ${passes} passed, ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
