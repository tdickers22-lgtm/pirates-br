// SHIP WAKE — the gate for SHIPVIS-01 phase B (the Kelvin wedge).
//
// THE DEFECT. A hull's whole wake was one tapered ribbon laid along her own
// track astern of the transom: the turbulent stern wake and nothing else. The
// water either side of a driving bow was untouched, so a ship read as sliding
// over a flat sheet rather than pushing through it, and nothing on screen
// carried the one feature of a real ship wake a player recognises without being
// able to name it — the V.
//
// THE GATE. That V is not artistic licence and it is not a per-ship tuning
// knob: for deep-water gravity waves the Kelvin wedge has half-angle
// arcsin(1/3) = 19.47 degrees for EVERY hull at EVERY speed. So the gate
// measures the drawn arm geometry and requires that exact angle, at more than
// one yaw (an axis-aligned-only check would pass on a bug that ignores the
// heading) and at more than one speed (the wedge must lengthen with speed and
// never widen). It then grades the three things that make it affordable:
// the low tier does not build it at all, it costs no extra draw call, and when
// it fades out it fades to zero AREA rather than switching off.
//
//   node --import tsx scripts/test-ship-wake.mjs [--mutate]
//
// `--mutate` rewrites the arm block the way the renderer behaved before this
// lane — everything collapsed onto the ship's own track, no wedge — and the
// gate must FAIL. RED PROOF is in the lane report.
import { installCanvasStub } from './lib/canvas-stub.mjs';
installCanvasStub();
const {
  buildWakeSurface, writeWakeSurface, setArmsVisible, makeWakeFrame,
  KELVIN_HALF_ANGLE, BOW_SHEET_ANGLE, WAKE_ROWS, WAKE_COLS,
  ARM_VERTEX_OFFSET, SHEET_VERTEX_OFFSET, WAKE_VERTS_WITH_ARMS,
} = await import('../src/client/rendering/ship/wake.ts');
const { gerstnerHeight, WAVE_PARAMS } = await import('../src/shared/utils/index.ts');
const { SHIP_STATS } = await import('../src/shared/constants/index.ts');

const MUTATE = process.argv.includes('--mutate');

let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

const CENTRE_VERTS = WAKE_ROWS * WAKE_COLS;
const ARM_ROWS = 7, SHEET_ROWS = 3;
const ARM_VERTS = ARM_ROWS * 2, SHEET_VERTS = SHEET_ROWS * 2;

/** Fills a frame for a hull of `type` at `yaw`, driving at `speedFrac`. */
function frameFor(type, yaw, speedFrac, waveT = 3.1, storm = 0, armFactor = 1) {
  const stats = SHIP_STATS[type];
  const f = makeWakeFrame();
  const fwdX = Math.sin(yaw), fwdZ = Math.cos(yaw);
  const latX = Math.cos(yaw), latZ = -Math.sin(yaw);
  const px = 41.5, pz = -18.25; // off the origin so an axis bug cannot hide
  f.fwdX = fwdX; f.fwdZ = fwdZ; f.latX = latX; f.latZ = latZ;
  f.sternX = px - fwdX * stats.length * 0.46;
  f.sternZ = pz - fwdZ * stats.length * 0.46;
  f.bowX = px + fwdX * stats.length * 0.5;
  f.bowZ = pz + fwdZ * stats.length * 0.5;
  f.width = stats.width; f.length = stats.length;
  f.speedFrac = speedFrac; f.waveT = waveT; f.storm = storm; f.armFactor = armFactor;
  return f;
}

/** The pre-lane behaviour: no wedge — every arm and sheet vertex lies on the
 *  ship's own track, which is what the single stern ribbon amounted to. */
function collapseOntoTrack(surface, f) {
  const pos = surface.positions;
  for (let v = ARM_VERTEX_OFFSET; v < WAKE_VERTS_WITH_ARMS; v++) {
    const t = (v - ARM_VERTEX_OFFSET) / (WAKE_VERTS_WITH_ARMS - ARM_VERTEX_OFFSET);
    const d = t * f.length;
    const x = f.bowX - f.fwdX * d;
    const z = f.bowZ - f.fwdZ * d;
    pos.setXYZ(v, x, gerstnerHeight(x, z, f.waveT, WAVE_PARAMS, f.storm) + 0.07, z);
  }
}

function drive(surface, f) {
  writeWakeSurface(surface, f);
  if (MUTATE && surface.hasArms && f.armFactor > 0) collapseOntoTrack(surface, f);
}

/** Midpoint of an arm/sheet row, in XZ. */
function rowMid(pos, base, row) {
  const a = base + row * 2, b = a + 1;
  return [(pos.getX(a) + pos.getX(b)) / 2, (pos.getZ(a) + pos.getZ(b)) / 2];
}

// ── 1. What the low tier pays ────────────────────────────────────────
console.log('\nTHE LOW TIER PAYS NOTHING FOR THE WEDGE');
{
  const low = buildWakeSurface('low');
  expect('low tier builds no arms at all', low.hasArms === false);
  expect(`low tier keeps the pre-lane 27 vertices`,
    low.positions.count === CENTRE_VERTS, `got ${low.positions.count}`);
  expect('low tier has no arm indices to skip',
    low.centreIndexCount === low.totalIndexCount && low.totalIndexCount === 96,
    `centre ${low.centreIndexCount} total ${low.totalIndexCount}`);
  // A low-tier wake must survive being asked for arms it does not have.
  setArmsVisible(low, true);
  expect('asking a low-tier wake for arms is a no-op, not a crash',
    low.geometry.drawRange.count === low.centreIndexCount);
  const f = frameFor('sloop', 0.9, 1);
  drive(low, f);
  let bad = 0;
  for (let v = 0; v < low.positions.count; v++) if (!Number.isFinite(low.positions.getX(v))) bad++;
  expect('the low-tier stern ribbon still writes finite positions', bad === 0);
}

// ── 2. What the wedge costs everywhere else ──────────────────────────
console.log('\nWHAT IT COSTS ON BALANCED AND HIGH');
const surface = buildWakeSurface('balanced');
{
  expect('balanced builds the arms', surface.hasArms === true);
  expect('40 vertices added, 67 in total',
    surface.positions.count === WAKE_VERTS_WITH_ARMS && surface.positions.count === 67,
    `got ${surface.positions.count}`);
  const addedTris = (surface.totalIndexCount - surface.centreIndexCount) / 3;
  expect('32 triangles added per hull (384 for a twelve-hull match)',
    addedTris === 32, `added ${addedTris}`);
  // The whole point of the layout: arms and sheets share the stern ribbon's
  // geometry and index buffer, so the wake is still ONE draw.
  expect('the arms live in the stern ribbon\'s own geometry — no second draw',
    surface.geometry.getAttribute('position') === surface.positions
    && surface.geometry.index.count === surface.totalIndexCount);
  // ...and the far-LOD range must be honest about which vertices it reaches.
  const idx = surface.geometry.index.array;
  let leak = 0;
  for (let i = 0; i < surface.centreIndexCount; i++) if (idx[i] >= CENTRE_VERTS) leak++;
  expect('the far-LOD index range touches no arm vertex',
    leak === 0, `${leak} of the first ${surface.centreIndexCount} indices reach past the stern ribbon`);
  let armMiss = 0;
  for (let i = surface.centreIndexCount; i < surface.totalIndexCount; i++) {
    if (idx[i] < CENTRE_VERTS) armMiss++;
  }
  expect('and the arm range touches no stern-ribbon vertex', armMiss === 0);
}

// ── 3. The angle is the water's, not the ship's ──────────────────────
console.log('\nTHE KELVIN HALF-ANGLE IS 19.47 DEGREES, WHATEVER THE HULL IS DOING');
const DEG = 180 / Math.PI;
function armAngles(f) {
  drive(surface, f);
  const pos = surface.positions;
  const out = [];
  for (let s = 0; s < 2; s++) {
    const base = ARM_VERTEX_OFFSET + s * ARM_VERTS;
    for (let row = 0; row < ARM_ROWS - 1; row++) {
      const [x0, z0] = rowMid(pos, base, row);
      const [x1, z1] = rowMid(pos, base, row + 1);
      const dx = x1 - x0, dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) { out.push(NaN); continue; }
      // Angle between this step and dead astern.
      const cos = (dx * -f.fwdX + dz * -f.fwdZ) / len;
      out.push(Math.acos(Math.min(1, Math.max(-1, cos))));
    }
  }
  return out;
}
{
  for (const [type, yaw, speedFrac] of [
    ['sloop', 0, 1], ['sloop', 2.1, 1], ['brigantine', -1.37, 0.72], ['galleon', 4.4, 0.95],
  ]) {
    const f = frameFor(type, yaw, speedFrac);
    const angs = armAngles(f);
    let worst = 0;
    for (const a of angs) worst = Math.max(worst, Math.abs((Number.isNaN(a) ? 9 : a) - KELVIN_HALF_ANGLE));
    expect(`${type} at yaw ${yaw}: every arm step leaves the track at 19.47 deg`,
      worst < 5e-4, `worst ${(worst * DEG).toFixed(3)} deg off; angles ${angs.map((a) => (a * DEG).toFixed(2)).join(', ')}`);
  }
  // Speed lengthens the wedge; it must never widen it.
  const slow = frameFor('sloop', 0.63, 0.3);
  const slowAng = armAngles(slow)[0];
  const slowTip = rowMid(surface.positions, ARM_VERTEX_OFFSET, ARM_ROWS - 1);
  const fast = frameFor('sloop', 0.63, 1);
  const fastAng = armAngles(fast)[0];
  const fastTip = rowMid(surface.positions, ARM_VERTEX_OFFSET, ARM_ROWS - 1);
  // 1e-6 rad = 6e-5 degrees: float noise in the acos, nothing a speed term
  // could hide in.
  expect('the wedge angle is identical at 30% and 100% speed',
    Math.abs(slowAng - fastAng) < 1e-6, `${(slowAng * DEG).toFixed(6)} vs ${(fastAng * DEG).toFixed(6)}`);
  const slowLen = Math.hypot(slowTip[0] - slow.bowX, slowTip[1] - slow.bowZ);
  const fastLen = Math.hypot(fastTip[0] - fast.bowX, fastTip[1] - fast.bowZ);
  expect('but the wedge is longer at speed',
    fastLen > slowLen * 1.3, `${slowLen.toFixed(2)} m -> ${fastLen.toFixed(2)} m`);
}

// ── 4. Symmetry, and the sheets are not the arms ─────────────────────
console.log('\nBOTH ARMS, AND THE BOW SHEETS');
{
  const f = frameFor('brigantine', 0, 0.9); // yaw 0: ship-local == world
  drive(surface, f);
  const pos = surface.positions;
  let worstMirror = 0;
  for (let row = 0; row < ARM_ROWS; row++) {
    const [xp, zp] = rowMid(pos, ARM_VERTEX_OFFSET, row);
    const [xs, zs] = rowMid(pos, ARM_VERTEX_OFFSET + ARM_VERTS, row);
    // At yaw 0 the track is +z and lat is +x, so the two arms mirror in x.
    worstMirror = Math.max(worstMirror, Math.abs((xp - f.bowX) + (xs - f.bowX)), Math.abs(zp - zs));
  }
  expect('port and starboard arms are mirror images',
    worstMirror < 1e-6, `worst ${worstMirror.toFixed(6)} m`);
  // Every arm vertex is ABAFT the bow: a wedge that reached ahead of the stem
  // would be water the ship has not touched yet.
  let ahead = 0;
  for (let v = ARM_VERTEX_OFFSET; v < WAKE_VERTS_WITH_ARMS; v++) {
    if ((pos.getZ(v) - f.bowZ) > 1e-6) ahead++;
  }
  expect('nothing in the wedge reaches ahead of the stem', ahead === 0, `${ahead} vertices forward of the bow`);
  // The sheets peel off wider and die sooner than the arms.
  const armTip = rowMid(pos, ARM_VERTEX_OFFSET, ARM_ROWS - 1);
  const sheetTip = rowMid(pos, SHEET_VERTEX_OFFSET, SHEET_ROWS - 1);
  const armLen = Math.hypot(armTip[0] - f.bowX, armTip[1] - f.bowZ);
  const sheetLen = Math.hypot(sheetTip[0] - f.bowX, sheetTip[1] - f.bowZ);
  expect('the bow sheet is much shorter than the arm',
    sheetLen < armLen * 0.5, `sheet ${sheetLen.toFixed(2)} m vs arm ${armLen.toFixed(2)} m`);
  expect('and it peels off at a wider angle than the wedge',
    BOW_SHEET_ANGLE > KELVIN_HALF_ANGLE * 1.5);
}

// ── 5. Coherence: it all sits ON the sea ─────────────────────────────
console.log('\nEVERY WAKE VERTEX SITS ON THE DRAWN SEA');
{
  for (const [storm, waveT] of [[0, 3.1], [1, 11.7], [0.5, 27.35]]) {
    const f = frameFor('galleon', 2.9, 1, waveT, storm);
    drive(surface, f);
    const pos = surface.positions;
    let worstLow = 9, worstHigh = -9;
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v), z = pos.getZ(v);
      const d = pos.getY(v) - gerstnerHeight(x, z, waveT, WAVE_PARAMS, storm);
      worstLow = Math.min(worstLow, d); worstHigh = Math.max(worstHigh, d);
    }
    expect(`storm ${storm}: no wake vertex sinks under the sea or floats off it`,
      worstLow >= 0.02 && worstHigh <= 0.35,
      `clearance range ${worstLow.toFixed(3)} .. ${worstHigh.toFixed(3)} m above the surface`);
  }
}

// ── 6. The fade costs no fill, and does not pop ──────────────────────
console.log('\nTHE WEDGE FADES TO ZERO AREA, NOT TO A SWITCH');
{
  const f = frameFor('sloop', 1.2, 1, 3.1, 0, 0);
  writeWakeSurface(surface, f); // never mutated: this is the fade, not the wedge
  setArmsVisible(surface, false);
  expect('a faded wedge leaves the draw range at the stern ribbon',
    surface.geometry.drawRange.count === surface.centreIndexCount,
    `count ${surface.geometry.drawRange.count}`);
  // Approach the floor from above: at a hair of factor the arms must already
  // be zero-area, or the frame they leave the draw is a visible pop.
  // The ribbons keep their LENGTH as they fade — only the width collapses — so
  // the honest measure of "already invisible" is the width, not the area.
  f.armFactor = 2e-4; // twice the floor: what the last drawn frame looks like
  writeWakeSurface(surface, f);
  const pos = surface.positions;
  let worstWidth = 0;
  for (let v = ARM_VERTEX_OFFSET; v < WAKE_VERTS_WITH_ARMS; v += 2) {
    worstWidth = Math.max(worstWidth,
      Math.hypot(pos.getX(v + 1) - pos.getX(v), pos.getZ(v + 1) - pos.getZ(v)));
  }
  expect('at the fade floor the wedge is already under a millimetre wide',
    worstWidth < 1e-3, `worst ribbon width ${(worstWidth * 1000).toFixed(3)} mm`);
  setArmsVisible(surface, true);
  expect('and the range comes back when she picks up again',
    surface.geometry.drawRange.count === surface.totalIndexCount);
}

// ── 7. Nothing is allocated per frame ────────────────────────────────
console.log('\nTWELVE WAKES, EVERY FRAME, FOR NOTHING');
{
  const geo0 = surface.geometry;
  const arr0 = surface.positions.array;
  const f = frameFor('brigantine', 0.4, 0.8);
  for (let i = 0; i < 600; i++) {
    f.waveT = 3.1 + i * (1 / 60);
    f.armFactor = 0.2 + 0.8 * Math.abs(Math.sin(i * 0.03));
    setArmsVisible(surface, f.armFactor > 1e-3);
    writeWakeSurface(surface, f);
  }
  expect('600 frames reuse the same geometry and the same position buffer',
    surface.geometry === geo0 && surface.positions.array === arr0,
    'the wake was rebuilt rather than rewritten — that is a per-frame allocation per hull');
  let bad = 0;
  for (let i = 0; i < arr0.length; i++) if (!Number.isFinite(arr0[i])) bad++;
  expect('and not one NaN got into the buffer', bad === 0, `${bad} non-finite floats`);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks`);
process.exit(failures === 0 ? 0 : 1);
