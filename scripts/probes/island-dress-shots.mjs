// PROBE, not a gate: Shot sheet for the island DRESSING fixes: the pirate camp's prop materials, the summit cloud collar, and grass at your feet.
// Moved to scripts/probes/ (2026-09-02): an instrument that is read, never graded. Run from the repo root.
// Shot sheet for the island DRESSING fixes: the pirate camp's prop materials,
// the summit cloud collar, and grass at your feet.
//
// These three were all photographed by the graphics re-audit and all three are
// judged on pixels, not on a data assertion — a black cookpot, a cloud sliced by
// the mountain and a hard X through every grass tuft are things you can only see.
//
// CAPTURE NOTE: this boot's Metal path is wedged post-panic (compositor grabs come
// back as one flat colour), so the renderer is selectable and defaults to
// SwiftShader. Software WebGL renders real pixels at single-digit fps, hence the
// small viewport, the generous settle waits and the long screenshot timeouts.
// ONE browser, closed in a finally — this is a fanless machine that has already
// kernel-panicked under concurrent GPU browsers today.
import { chromium } from 'playwright';
import { mkdirSync, statSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/island-dress';
const GL = process.argv[3] ?? 'swiftshader';
mkdirSync(OUT, { recursive: true });

const ARGS = GL === 'metal'
  ? ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
  : ['--use-angle=swiftshader'];
// A crashed headless Chromium must never raise a macOS crash dialog: someone is
// sitting at this machine.
ARGS.push('--disable-breakpad', '--noerrdialogs', '--disable-crash-reporter');

const browser = await chromium.launch({ args: ARGS });
const shots = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const wait = (ms) => page.waitForTimeout(ms);

  async function freeLook(pos, target) {
    await page.evaluate(([p, t]) => {
      const g = window.__piratesBR;
      const dx = t[0] - p[0], dy = t[1] - p[1], dz = t[2] - p[2];
      const len = Math.hypot(dx, dy, dz) || 1;
      g.enableFreeCam(p[0], p[1], p[2], Math.atan2(dx / len, dz / len), Math.asin(dy / len));
    }, [pos, target]);
  }
  async function shoot(name) {
    await wait(900);
    const path = `${OUT}/${name}.png`;
    await page.screenshot({ path, timeout: 120_000 });
    // A flat single-colour grab (the wedged-Metal failure) compresses to almost
    // nothing. Real geometry does not. Cheap, and it catches the exact failure
    // mode this boot has already produced twice.
    const bytes = statSync(path).size;
    shots.push({ name, bytes, flat: bytes < 30_000 });
    console.log(`  ${name.padEnd(28)} ${(bytes / 1024).toFixed(0).padStart(5)} KB${bytes < 30_000 ? '   <-- SUSPECT FLAT' : ''}`);
  }

  await page.goto('http://127.0.0.1:3000/?debug&quality=high', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  // GOTCHA: waitForFunction's options are the THIRD argument.
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 300_000 });
  await wait(4000);
  await page.evaluate(() => {
    const e = document.createElement('style');
    e.textContent = '#onboarding-card,#oc-card,[class*="onboard"]{display:none!important;}'
      + '#hud{visibility:hidden!important;}'
      + '#disconnect-overlay,.server-overloaded,#server-overloaded,[class*="overload"]{visibility:hidden!important;}';
    document.head.appendChild(e);
    document.getElementById('oc-skip')?.click();
  });
  await page.evaluate(() => window.__piratesBR.drainIslandBuildQueue?.(40));
  await page.waitForFunction(
    () => window.__piratesBR.islandMeshes.size >= (window.__piratesBR.state?.islands?.length ?? 99),
    null, { timeout: 300_000 },
  ).catch(() => {});
  await wait(2000);

  // ── what the island builders actually produced, in world space ──────────
  // NOTE ON COORDINATES: island dressing does NOT hang off the island group
  // directly — every builder adds into `island-detail-root` (the proxy LOD is the
  // sibling). And the island subtree is frozen out of three's matrix walk
  // (freezeStaticSubtree), so getWorldPosition() reads a stale matrixWorld. Both
  // together mean: traverse to find the object, then take world space as the
  // island GROUP's offset plus the object's own local position — the detail root
  // sits at the group origin, and island groups are unrotated (asserted below).
  // THREE is not on window either, hence the raw instanceMatrix arithmetic.
  const found = await page.evaluate(() => {
    const g = window.__piratesBR;
    const out = { camps: [], grass: [], summits: [], mist: [], rotated: [] };
    for (const [id, grp] of g.islandMeshes.entries()) {
      const isl = (g.state.islands ?? []).find((i) => i.id === id) ?? null;
      const gx = grp.position.x, gy = grp.position.y, gz = grp.position.z;
      if (Math.abs(grp.rotation.y) > 1e-6) out.rotated.push({ id, ry: grp.rotation.y });
      grp.traverse((o) => {
        if (o.name === 'decor-camp') {
          out.camps.push({ id, name: isl?.name, x: gx + o.position.x, y: gy + o.position.y, z: gz + o.position.z, kids: o.children.length });
        }
        if (o.name === 'island-grass' && o.count > 0) {
          const a = o.instanceMatrix.array;
          const off = Math.floor(o.count / 2) * 16;
          out.grass.push({
            id, name: isl?.name, count: o.count,
            x: gx + a[off + 12], y: gy + a[off + 13], z: gz + a[off + 14],
          });
        }
        if (o.isSprite) {
          out.mist.push({ id, name: isl?.name, x: gx + o.position.x, y: gy + o.position.y, z: gz + o.position.z, sx: o.scale.x, lr: Math.hypot(o.position.x, o.position.z) });
        }
      });
      if (isl && (isl.profile?.terrainStyle === 'mountain')) {
        out.summits.push({ id, name: isl.name, x: gx, z: gz, r: isl.radius });
      }
    }
    return out;
  });
  if (found.rotated.length) console.log('WARNING: rotated island groups', JSON.stringify(found.rotated));
  console.log('CAMPS', JSON.stringify(found.camps.slice(0, 4)));
  console.log('GRASS', JSON.stringify(found.grass.slice(0, 4)));
  console.log('MIST SPRITES', found.mist.length, JSON.stringify(found.mist.slice(0, 6)));

  await page.evaluate(() => window.__piratesBR.setDayNightOverride(854)); // noon
  await wait(800);

  // ── 1. THE COOKPOT. The prop the audit photographed as "pure black with no
  //     shading". Close, at noon, from the side the sun is on and the side it
  //     is not — a lit dark iron has a gradient across its belly; a crushed
  //     albedo has none from any angle.
  const camp = found.camps[0];
  if (camp) {
    console.log(`camp on ${camp.name} at ${camp.x.toFixed(1)},${camp.y.toFixed(1)},${camp.z.toFixed(1)}`);
    await freeLook([camp.x + 5.5, camp.y + 2.6, camp.z + 5.5], [camp.x, camp.y + 0.5, camp.z]);
    await shoot('camp-noon-wide');
    await freeLook([camp.x + 2.6, camp.y + 1.3, camp.z + 2.2], [camp.x + 1.2, camp.y + 0.35, camp.z + 0.4]);
    await shoot('camp-noon-pot-close');
    await freeLook([camp.x - 2.4, camp.y + 1.2, camp.z - 1.8], [camp.x + 1.2, camp.y + 0.35, camp.z + 0.4]);
    await shoot('camp-noon-pot-shadeside');
    await page.evaluate(() => window.__piratesBR.setDayNightOverride(374)); // night
    await wait(900);
    await shoot('camp-night-pot');
    await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
    await wait(800);
  }

  // ── 2. THE SUMMIT COLLAR. Sprites that used to be laid out inside the rock.
  //     Shot from outside at summit height, where a sliced cloud shows its
  //     dead-straight edge most plainly.
  const summit = found.summits[0];
  if (summit) {
    const mistHere = found.mist.filter((m) => m.id === summit.id);
    console.log(`summit ${summit.name} r=${summit.r} mist sprites=${mistHere.length}`);
    const my = mistHere.length ? mistHere.reduce((a, m) => a + m.y, 0) / mistHere.length : 40;
    await freeLook([summit.x + summit.r * 1.5, my + 12, summit.z + summit.r * 1.5], [summit.x, my, summit.z]);
    await shoot('summit-collar-far');
    await freeLook([summit.x + summit.r * 0.75, my + 4, summit.z + summit.r * 0.75], [summit.x, my, summit.z]);
    await shoot('summit-collar-near');
  }

  // ── 3. GRASS AT YOUR FEET. Eye height, looking down the way you stand in it:
  //     the range at which a flat square-topped card and a hard X read.
  const spot = found.grass[0];
  if (spot) {
    console.log(`grass on ${spot.name}: ${spot.count} blades, sample at ${spot.x.toFixed(1)},${spot.y.toFixed(1)},${spot.z.toFixed(1)}`);
    await freeLook([spot.x + 1.1, spot.y + 1.55, spot.z + 1.1], [spot.x, spot.y + 0.15, spot.z]);
    await shoot('grass-feet-eye');
    await freeLook([spot.x + 0.45, spot.y + 0.5, spot.z + 0.45], [spot.x, spot.y + 0.12, spot.z]);
    await shoot('grass-feet-macro');
  }

  // ── 4. CAVE MOUTH sanity — nothing in this pass touched the cutout, and this
  //     is the shot that would show it if something had.
  const mouth = await page.evaluate(() => {
    const g = window.__piratesBR;
    for (const isl of (g.state.islands ?? [])) {
      const c = (isl.caves ?? []).find((c) => c.hasMouth);
      if (c) return { x: c.position.x, y: c.floorY, z: c.position.z, rot: c.rotation, len: c.length, name: isl.name };
    }
    return null;
  });
  if (mouth) {
    console.log(`cave mouth on ${mouth.name}`);
    const ox = Math.sin(mouth.rot), oz = Math.cos(mouth.rot);
    await freeLook([mouth.x + ox * 30, mouth.y + 5, mouth.z + oz * 30], [mouth.x, mouth.y + 2.4, mouth.z]);
    await shoot('cave-outside-30m');
    await freeLook([mouth.x + ox * 5, mouth.y + 1.7, mouth.z + oz * 5], [mouth.x, mouth.y + 1.7, mouth.z]);
    await shoot('cave-outside-5m');
    await freeLook(
      [mouth.x - ox * (mouth.len * 0.5), mouth.y + 1.6, mouth.z - oz * (mouth.len * 0.5)],
      [mouth.x + ox * 6, mouth.y + 2.2, mouth.z + oz * 6],
    );
    await shoot('cave-inside-looking-out');
  }
} finally {
  await browser.close();
}
const flat = shots.filter((s) => s.flat);
console.log(`\n${shots.length} shots, ${flat.length} suspect-flat`);
if (flat.length) console.log('SUSPECT:', flat.map((s) => s.name).join(', '));
console.log('island dress shots done ->', OUT);
