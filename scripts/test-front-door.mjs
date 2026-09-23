#!/usr/bin/env node
/**
 * FRONT DOOR GATE (b1.5b: online-09, online-16, vm:online:5, vm:audio:6).
 *
 * The launch spreads by a friend pasting a link. What that link shows, and
 * what happens when it is tapped, is graded here under plain node (no stack,
 * no browser, ~0.3 s):
 *   1. index.html carries a description, OpenGraph and a twitter
 *      summary_large_image card whose URLs are ABSOLUTE and share ONE origin,
 *      and that origin is fly.toml's PIRATES_BR_PUBLIC_URL (a renamed app
 *      that forgets index.html fails here, not in a Discord preview).
 *   2. public/og-card.jpg is a real JPEG, 1200x630 (read from the SOF
 *      header, not the file name), under 300 KB.
 *   3. manifest.webmanifest parses and every icon exists at its declared size.
 *   4. public/credits.json is exactly what scripts/build-credits.mjs builds
 *      from every LICENSES.md in the repo (a stale file fails), the parser is
 *      proven on a fixture (so zero LICENSES files cannot pass vacuously),
 *      and a CC-BY row without an author or any NC/personal-use row fails.
 *   5. The menu shows a Privacy line and a Credits panel.
 *   6. The invite round trip: buildInviteUrl -> normalisePartyCode gives the
 *      code back for 4- and 6-character codes (also pasted URLs with other
 *      params), the share-vs-copy choice, the auto 'Pirate####' name, and the
 *      honest copy label (no 'Copied!' before the clipboard promise resolves).
 *
 * Usage: node --import tsx scripts/test-front-door.mjs
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const read = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : '');

// ── 1. Meta tags ─────────────────────────────────────────────────────────
console.log('\nA pasted link has a title, a pitch and a picture');
const html = read('index.html');
const head = html.split(/<\/head>/i)[0] ?? '';
function meta(attr, key) {
  const re = new RegExp(`<meta\\s+[^>]*${attr}="${key.replace(/[:.]/g, '\\$&')}"[^>]*>`, 'i');
  const tag = head.match(re)?.[0];
  return tag ? (tag.match(/content="([^"]*)"/i)?.[1] ?? '') : null;
}
const toml = read('fly.toml');
const publicUrl = toml.match(/PIRATES_BR_PUBLIC_URL\s*=\s*"([^"]+)"/)?.[1] ?? '';
expect('fly.toml declares PIRATES_BR_PUBLIC_URL (https)', /^https:\/\/[^/]+$/.test(publicUrl), `got ${JSON.stringify(publicUrl)}`);
const origin = publicUrl.replace(/\/$/, '');

const desc = meta('name', 'description');
expect('meta description present, 50-155 chars', desc !== null && desc.length >= 50 && desc.length <= 155,
  `got ${desc === null ? 'none' : `${desc.length} chars`}`);
for (const key of ['og:title', 'og:description', 'og:image:alt', 'og:site_name']) {
  const v = meta('property', key);
  expect(`${key} present and non-empty`, !!v, `got ${JSON.stringify(v)}`);
}
expect('og:type = website', meta('property', 'og:type') === 'website');
expect('og:image:width = 1200', meta('property', 'og:image:width') === '1200');
expect('og:image:height = 630', meta('property', 'og:image:height') === '630');
expect('og:image:type = image/jpeg', meta('property', 'og:image:type') === 'image/jpeg');
expect('twitter:card = summary_large_image', meta('name', 'twitter:card') === 'summary_large_image');
for (const key of ['twitter:title', 'twitter:description', 'twitter:image:alt']) {
  expect(`${key} present and non-empty`, !!meta('name', key));
}
const absolute = [
  ['og:url', meta('property', 'og:url'), '/'],
  ['og:image', meta('property', 'og:image'), '/og-card.jpg'],
  ['twitter:image', meta('name', 'twitter:image'), '/og-card.jpg'],
  ['link rel=canonical', head.match(/<link\s+rel="canonical"\s+href="([^"]*)"/i)?.[1] ?? null, '/'],
];
for (const [name, value, path] of absolute) {
  expect(`${name} is absolute on PIRATES_BR_PUBLIC_URL (${origin}${path})`,
    !!origin && value === `${origin}${path}`, `got ${JSON.stringify(value)}`);
}

// ── 2. The card image ────────────────────────────────────────────────────
console.log('\nThe card image is a real 1200x630 JPEG under 300 KB');
function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}
const ogPath = join(ROOT, 'public/og-card.jpg');
if (existsSync(ogPath)) {
  const buf = readFileSync(ogPath);
  const dim = jpegSize(buf);
  expect('og-card.jpg is a JPEG with a SOF header', !!dim);
  expect('og-card.jpg is 1200x630', dim?.w === 1200 && dim?.h === 630, `got ${dim ? `${dim.w}x${dim.h}` : 'none'}`);
  const kb = statSync(ogPath).size / 1024;
  expect('og-card.jpg < 300 KB', kb < 300, `got ${kb.toFixed(1)} KB`);
  expect('og-card.jpg is not a placeholder (> 40 KB of picture)', kb > 40, `got ${kb.toFixed(1)} KB`);
} else {
  expect('public/og-card.jpg exists', false);
}

// ── 3. Manifest ──────────────────────────────────────────────────────────
console.log('\nThe web app manifest parses and its icons are real');
let manifest = null;
try { manifest = JSON.parse(read('public/manifest.webmanifest')); } catch { /* reported below */ }
expect('manifest.webmanifest parses', !!manifest);
expect('index.html links the manifest', /<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"/.test(head));
function pngSize(buf) {
  return buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG' ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : null;
}
for (const icon of manifest?.icons ?? []) {
  const p = join(ROOT, 'public', icon.src);
  const dim = existsSync(p) ? pngSize(readFileSync(p)) : null;
  expect(`icon ${icon.src} is ${icon.sizes}`, !!dim && `${dim.w}x${dim.h}` === icon.sizes, `got ${dim ? `${dim.w}x${dim.h}` : 'missing'}`);
}
expect('manifest declares at least one maskable icon', (manifest?.icons ?? []).some((i) => /maskable/.test(i.purpose ?? '')));

// ── 4. Credits ───────────────────────────────────────────────────────────
console.log('\nCredits list every LICENSES.md row, and nothing unlicensable ships');
let credits = null;
try { credits = await import('./build-credits.mjs'); } catch (err) {
  console.error(`  (build-credits.mjs did not import: ${String(err.message).split('\n')[0]})`);
}
expect('scripts/build-credits.mjs exports parseLicensesMd, buildCredits, licenseProblems',
  !!credits && ['parseLicensesMd', 'buildCredits', 'licenseProblems'].every((k) => typeof credits[k] === 'function'));
if (credits?.parseLicensesMd) {
  const fixture = [
    '# Audio licences', '', 'Some prose that is not a table.', '',
    '| File | Source | Author | License |', '|---|---|---|:--|',
    '| cannon_01.mp3 | https://freesound.org/s/1/ | Alice | CC0 1.0 |',
    '| surf_loop.m4a | https://freesound.org/s/2/ | Bob Smith | CC BY 4.0 |', '',
    '| Font | Source | Author | License |', '|---|---|---|---|',
    '| Pirata One | https://fonts.google.com | Rodrigo Fuenzalida | OFL 1.1 |',
  ].join('\n');
  const rows = credits.parseLicensesMd(fixture, 'fixture/LICENSES.md');
  expect('parser reads every table row of a fixture (3 rows, 2 tables)', rows.length === 3, `got ${rows.length}`);
  expect('parser maps columns by header name', rows[1]?.file === 'surf_loop.m4a' && rows[1]?.author === 'Bob Smith'
    && rows[1]?.license === 'CC BY 4.0' && rows[2]?.file === 'Pirata One', JSON.stringify(rows[1] ?? null));
  const bad = credits.licenseProblems([
    { file: 'a.mp3', license: 'CC BY 4.0', author: '', source: 'x' },
    { file: 'b.mp3', license: 'CC BY-NC 4.0', author: 'Z', source: 'x' },
    { file: 'c.mp3', license: 'Personal use only', author: 'Z', source: 'x' },
    { file: 'd.mp3', license: 'CC0', author: '', source: 'x' },
  ]);
  expect('licenseProblems flags CC-BY without author, NC, personal-use (3 of 4)', bad.length === 3, JSON.stringify(bad));
}
if (credits?.buildCredits) {
  const built = credits.buildCredits(ROOT);
  let onDisk = null;
  try { onDisk = JSON.parse(read('public/credits.json')); } catch { /* reported below */ }
  expect('public/credits.json exists and parses', !!onDisk);
  expect('public/credits.json is fresh (== node scripts/build-credits.mjs)',
    !!onDisk && JSON.stringify(onDisk) === JSON.stringify(built), 'rerun: node scripts/build-credits.mjs');
  let expectedRows = 0;
  for (const src of built.sources) expectedRows += credits.parseLicensesMd(read(src), src).length;
  expect(`credits.json lists every LICENSES row (${built.sources.length} files, ${expectedRows} rows)`,
    (onDisk?.rows?.length ?? -1) === expectedRows && built.rows.length === expectedRows);
  const problems = credits.licenseProblems(built.rows);
  expect('no shipped row is NC, personal-use, or CC-BY without an author', problems.length === 0, JSON.stringify(problems));
}

// ── 5. Privacy + Credits in the menu ─────────────────────────────────────
console.log('\nThe menu says what is sent and who made what');
const privacy = html.match(/<[^>]+id="menu-privacy"[^>]*>([\s\S]*?)<\/(p|div)>/)?.[1] ?? '';
expect('#menu-privacy line exists on the main panel', privacy.length > 40);
expect('privacy line names what is sent and what is not (name, IP)', /name/i.test(privacy) && /\bIP\b/.test(privacy));
expect('Credits button on the main panel', /id="menu-credits-btn"/.test(html));
expect('Credits panel is a .menu-panel (scrolls with a finger via mobile.css)', /class="menu-panel"\s+id="menu-panel-credits"/.test(html));
expect('Credits panel has a list and a Back button', /id="credits-list"/.test(html) && /id="credits-back-btn"/.test(html));

// ── 6. Invite flow ───────────────────────────────────────────────────────
console.log('\nAn invite link survives the round trip and joins in one tap');
let menu = null;
try { menu = await import('../src/client/menu/MenuController.ts'); } catch (err) {
  console.error(`  (MenuController did not import: ${String(err.message).split('\n')[0]})`);
}
const fn = (k) => !!menu && typeof menu[k] === 'function';
expect('buildInviteUrl is exported (pure: href + code)', fn('buildInviteUrl'));
if (fn('buildInviteUrl') && fn('normalisePartyCode') && fn('isPartyCode')) {
  const cases = [
    ['https://pirates-br.fly.dev/', 'K7M2QX'],
    ['https://pirates-br.fly.dev/', 'AB3D'],
    ['https://pirates-br.fly.dev/?quality=low&party=ZZZZZZ#hud', 'Q9W8E7'],
    ['http://127.0.0.1:3101/?debug', 'H4J5'],
  ];
  for (const [href, code] of cases) {
    const url = menu.buildInviteUrl(href, code);
    const back = menu.normalisePartyCode(url);
    expect(`${code.length}-char ${code} from ${href} round-trips (${url})`, back === code && menu.isPartyCode(back), `got ${JSON.stringify(back)}`);
    expect(`invite for ${code} has no hash and one party param`, !url.includes('#') && (url.match(/party=/g) ?? []).length === 1);
  }
  expect('a typed code with a dash still normalises', menu.normalisePartyCode(' k7-m2 qx ') === 'K7M2QX');
}
expect('chooseInviteAction is exported', fn('chooseInviteAction'));
if (fn('chooseInviteAction')) {
  const c = menu.chooseInviteAction;
  expect('phone with a share sheet -> share', c({ share: true, coarse: true, clipboard: true }) === 'share');
  expect('desktop (fine pointer) -> copy even if navigator.share exists', c({ share: true, coarse: false, clipboard: true }) === 'copy');
  expect('no clipboard, no share -> show the code', c({ share: false, coarse: false, clipboard: false }) === 'show');
}
expect('autoPirateName is exported', fn('autoPirateName'));
if (fn('autoPirateName')) {
  const names = [0, 0.5, 0.99999].map((r) => menu.autoPirateName(() => r));
  expect(`auto names are Pirate#### (${names.join(', ')})`, names.every((n) => /^Pirate\d{4}$/.test(n)));
}
const src = read('src/client/menu/MenuController.ts');
expect('invite uses navigator.share', /navigator\.share\(/.test(src));
expect('"Copied!" only after writeText resolves (no unconditional label)',
  !/writeText\([^)]*\)\.catch\(\(\) => \{\}\);\s*\n\s*this\.lobbyCopyBtn\.textContent = 'Copied!'/.test(src)
  && /writeText\([^)]*\)\s*\.then\(/.test(src));
expect('?party with no stored name joins without typing (auto name on welcome)',
  /pendingPartyJoin[\s\S]{0,400}autoPirateName\(\)/.test(src));

console.log(failures === 0 ? '\ntest-front-door: all checks pass' : `\ntest-front-door: ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
