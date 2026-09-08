// THE HOLD'S LANTERNS — the gate for ships-23's lighting half.
//
// THE DEFECT. The hold's only light source was a single 18 cm BOX hanging dead
// amidships. A cube does not read as a lantern from a metre away, and one of
// them in the middle left both ends of a galleon's hold — nearly nine metres of
// it — with a lit floor and nothing visible producing the light.
//
// THE TRAP THIS GATE EXISTS FOR. The obvious fix is a second lantern with a
// second point light, and that is exactly the thing the engine cannot afford:
// the maximum point-light count is compiled INTO every shader program and every
// lit fragment pays for the whole pool (see test-light-budget). One lantern per
// hull across an anchorage is already a crowd. So the contract is TWO lanterns
// and ONE registered emitter, unchanged in position, intensity and range — and
// this gate holds every hull class to it.
//
//   node --import tsx scripts/test-hold-lanterns.mjs [--mutate]
//
// `--mutate` gives the second lantern its own point light, which is the fix a
// reasonable person writes, and the gate must FAIL. RED PROOF is in the report.
import { installCanvasStub } from './lib/canvas-stub.mjs';
installCanvasStub();
const THREE = await import('three');
const { makeShipInterior } = await import('../src/client/rendering/ship/interior.ts');
const { SHIP_STATS } = await import('../src/shared/constants/index.ts');
const { getHullProfile } = await import('../src/shared/hull.ts');
const { budgetLightWanted } = await import('../src/client/rendering/LightBudget.ts');

const MUTATE = process.argv.includes('--mutate');

let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

const woodMat = new THREE.MeshStandardMaterial({ name: 'wood' });
const darkMat = new THREE.MeshStandardMaterial({ name: 'dark' });

function buildHold(type, quality) {
  const stats = SHIP_STATS[type];
  const profile = getHullProfile(type);
  const hole = { cx: 0, cz: stats.length * 0.2, halfX: 0.6, halfZ: 0.8 };
  const g = makeShipInterior(stats, woodMat, darkMat, hole, profile, quality);
  if (MUTATE) {
    // The fix a reasonable person writes: the after lantern gets its own light.
    const lights = [];
    g.traverse((o) => { if (o.isPointLight) lights.push(o); });
    const twin = lights[0].clone();
    twin.position.z = -lights[0].position.z - stats.length * 0.32;
    g.add(twin);
  }
  return { stats, g };
}

function collect(g) {
  const glass = [], iron = [], lights = [];
  g.traverse((o) => {
    if (o.isPointLight) lights.push(o);
    else if (o.isMesh) {
      const n = o.material?.name ?? '';
      if (n === 'hold-lantern-glass') glass.push(o);
      else if (n === 'hold-lantern-iron') iron.push(o);
    }
  });
  return { glass, iron, lights };
}

for (const type of ['sloop', 'brigantine', 'galleon']) {
  console.log(`\n${type.toUpperCase()}`);
  const { stats, g } = buildHold(type, 'balanced');
  const { glass, iron, lights } = collect(g);

  expect(`${type}: two lanterns hang in the hold`,
    glass.length === 2, `${glass.length} glass bodies`);
  expect(`${type}: each lantern has its iron cap and its hook`,
    iron.length === 4, `${iron.length} iron parts, expected 4`);

  // THE CONTRACT.
  expect(`${type}: two lanterns, still exactly ONE point light`,
    lights.length === 1, `${lights.length} point lights below deck — the light budget pays for every one of them on every lit fragment`);
  if (lights.length >= 1) {
    const l = lights[0];
    expect(`${type}: the budget light did not move, brighten or reach further`,
      Math.abs(l.position.x) < 1e-9 && Math.abs(l.position.z) < 1e-9
      && Math.abs(l.intensity - 1.15) < 1e-9 && Math.abs(l.distance - 8.5) < 1e-9,
      `pos (${l.position.x}, ${l.position.z}) intensity ${l.intensity} range ${l.distance}`);
    // Registration is the thing to grade, not `visible`: registerBudgetLight
    // REPLACES `visible` with a getter that reads false until the budget grants
    // the slot, so a light reading `visible === true` is one that went AROUND
    // the budget. The property descriptor is the proof it went through it.
    const desc = Object.getOwnPropertyDescriptor(l, 'visible');
    expect(`${type}: the hold lantern is under the light budget, not around it`,
      l.name === 'hold-lantern' && typeof desc?.get === 'function' && budgetLightWanted(l) === true,
      `name ${JSON.stringify(l.name)}, intercepted ${typeof desc?.get === 'function'}, wanted ${budgetLightWanted(l)}`);

    // Symmetry is what lets one light serve two lanterns: the eye attributes
    // the pool to the pair. An off-centre light beside a lit lantern and a dark
    // one is the thing that would be visible.
    const zs = glass.map((m) => m.position.z).sort((a, b) => a - b);
    expect(`${type}: the lanterns sit symmetrically about the light`,
      glass.length === 2 && Math.abs(zs[0] + zs[1]) < 1e-6 && Math.abs(zs[0]) > 0.3,
      `lantern z ${zs.map((v) => v.toFixed(3)).join(' and ')}, light z ${l.position.z}`);
    // Both must be inside the light's reach, or the far one is visibly a prop.
    let worst = 0;
    for (const m of glass) worst = Math.max(worst, m.position.distanceTo(l.position));
    expect(`${type}: both lanterns stand inside the one light's reach`,
      worst < l.distance * 0.5, `farthest lantern ${worst.toFixed(2)} m from a ${l.distance} m light`);
    // And both must be in the hold, not buried in the planking.
    const holdHalfZ = stats.length * 0.26;
    expect(`${type}: neither lantern hangs outside the hold`,
      glass.every((m) => Math.abs(m.position.z) < holdHalfZ),
      `hold reaches ${holdHalfZ.toFixed(2)} m, lanterns at ${zs.map((v) => v.toFixed(2)).join(' / ')}`);
  }

  // Both lanterns must actually BURN — the whole reason one light suffices.
  expect(`${type}: both lanterns are emissive, so neither reads as unlit`,
    glass.length === 2 && glass.every((m) => m.material.emissiveIntensity >= 1.5
      && m.material.emissive.getHex() !== 0x000000));
  // One material per family across both lanterns, or they cannot merge into the
  // hull's static bake and the pair costs draw calls instead of triangles.
  expect(`${type}: the pair shares two materials, so it merges into the hull bake`,
    new Set([...glass, ...iron].map((m) => m.material)).size === 2);
}

// ── The low tier pays less for the same silhouette ───────────────────
console.log('\nWHAT THE LOW TIER PAYS');
{
  const tris = (q) => {
    const { g } = buildHold('galleon', q);
    const { glass, iron } = collect(g);
    let n = 0;
    for (const m of [...glass, ...iron]) n += m.geometry.index
      ? m.geometry.index.count / 3
      : m.geometry.getAttribute('position').count / 3;
    return n;
  };
  const low = tris('low'), high = tris('high');
  expect('the low tier builds a cheaper lantern than high',
    low < high, `low ${low} tris, high ${high}`);
  expect('and the pair is under a hundred triangles even on high',
    high <= 100, `${high} triangles for two lanterns`);
  console.log(`     two lanterns cost ${low} triangles on low, ${high} on balanced/high`);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks`);
process.exit(failures === 0 ? 0 : 1);
