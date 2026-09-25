// Vendors the Quaternius CC0 kits the pirate build reads (D25, b3.2a).
//
// The kits are free on itch.io behind a "name your price" page; the "No thanks, just take me to the
// downloads" link needs no account, so a headless Chromium fetches them. Every zip is pinned by sha256
// (the 2026-09-23 Standard releases) and only the subset the build reads is extracted here, with the
// kit's own licence text next to it. Licence: CC0 1.0 for all four (see */License*.txt and
// public/assets/models/LICENSES.md).
//
//   node assets-src/quaternius/fetch.mjs                  # download (headless) + verify + extract
//   node assets-src/quaternius/fetch.mjs --from /tmp/dir  # use zips already on disk (still verified)
//
// Large binaries (PNG textures, animation GLBs) are gitignored and restored by this script; the
// .gltf/.bin geometry and licence texts are committed so the kit contents are reviewable in git.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(new URL(import.meta.url).pathname);
export const KITS = [
  { dir: 'ubc', slug: 'universal-base-characters', zip: 'universal-base-characters.zip',
    sha256: 'fdbf1804c90dfc1ea03e992bff7da2dfd1a79318e13270a660180f9308455f40',
    top: 'Universal Base Characters[Standard]',
    keep: ['License_Standard.txt', 'Base Characters/Godot - UE/', 'Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)/'] },
  { dir: 'mco', slug: 'modular-character-outfits-fantasy', zip: 'modular-character-outfits-fantasy.zip',
    sha256: 'c3468b18871cc8c8f05ab14df7712baf22cb9f389cbd870babf130e595187f70',
    top: 'Modular Character Outfits - Fantasy[Standard]',
    keep: ['License_Standard.txt', 'Readme.txt', 'Exports/glTF (Godot-Unreal)/Outfits/'] },
  { dir: 'ual1', slug: 'universal-animation-library', zip: 'universal-animation-library.zip',
    sha256: 'cc73fc4e495b82958207316596317a3f40b9fa38065bde1027937452da537724',
    top: 'Universal Animation Library[Standard]',
    keep: ['License.txt', 'README.txt', 'Unreal-Godot/'] },
  { dir: 'ual2', slug: 'universal-animation-library-2', zip: 'universal-animation-library-2.zip',
    sha256: '4008ea208a604773a2b2177d965f0f5d3195498b5bf838c3f5785d68e95f2a68',
    top: 'Universal Animation Library 2[Standard]',
    keep: ['License.txt', 'README.txt', 'Unreal-Godot/'] },
];

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

async function download(kit, out) {
  const { chromium } = await import('playwright');
  const b = await chromium.launch({ headless: true, args: ['--mute-audio'] });
  try {
    const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 900, height: 600 } });
    const p = await ctx.newPage();
    await p.goto(`https://quaternius.itch.io/${kit.slug}`, { waitUntil: 'domcontentloaded' });
    await p.click('a.download_btn, .buy_btn, a:has-text("Download Now")', { timeout: 15000 });
    await p.click('a:has-text("No thanks")', { timeout: 15000 });
    await p.waitForSelector('a.download_btn[data-upload_id]', { timeout: 20000 });
    const btns = await p.$$('a.download_btn[data-upload_id]');
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 120000 }), btns[0].click()]);
    await dl.saveAs(out);
  } finally { await b.close(); }
}

function walk(d, base = d, acc = []) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p, base, acc); else acc.push(p.slice(base.length + 1));
  }
  return acc;
}

const argv = process.argv.slice(2);
const from = argv.includes('--from') ? argv[argv.indexOf('--from') + 1] : join(process.env.HOME, '.cache/pirates-br/quaternius');
mkdirSync(from, { recursive: true });
for (const kit of KITS) {
  const zip = join(from, kit.zip);
  if (!existsSync(zip)) { console.log(`fetch ${kit.slug} (headless itch "No thanks")`); await download(kit, zip); }
  const got = sha(zip);
  if (got !== kit.sha256) { console.error(`${kit.zip}: sha256 ${got} != pinned ${kit.sha256}`); process.exit(1); }
  const tmp = join(tmpdir(), `quat-${kit.dir}-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  execFileSync('unzip', ['-q', '-o', zip, '-d', tmp]);
  let n = 0;
  for (const rel of walk(join(tmp, kit.top))) {
    if (!kit.keep.some((k) => rel === k || (k.endsWith('/') && rel.startsWith(k)))) continue;
    if (/_png\.png$/.test(rel)) continue; // duplicate copies the Godot export ships; the build re-points to the real file
    const dst = join(HERE, kit.dir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(join(tmp, kit.top, rel), dst);
    n++;
  }
  rmSync(tmp, { recursive: true, force: true });
  console.log(`${kit.dir}: ${n} files (sha256 ok)`);
}
