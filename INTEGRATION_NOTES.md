# INTEGRATION_NOTES — OceanRenderer storm sea + true shoreline (agent 1)

OceanRenderer.ts now (a) displaces wave GEOMETRY with the shared storm sea-state
(exact GLSL replica of `getStormWaveIntensity` + `STORM_WAVE_PARAMS`), (b) uses
elliptical island footprints for the shoreline SDF, and (c) adds storm foam /
spray / color drama. All existing call sites still compile (back-compat kept),
but the following wiring belongs to the orchestrator / other agents:

## 1. Drive the storm sea-state (REQUIRED for the new geometry to activate)

New API (defaults = no storm, so nothing changes until wired):

```ts
ocean.setStormState(centerX, centerZ, safeRadius, phase01)  // phase01 = clamp((phase - 1) / 6, 0, 1)
ocean.clearStormState()                                     // back to calm
```

In `src/client/core/Game.ts`, in `frame()` right next to the existing
`this.ocean.setStormIntensity(this.stormWeatherIntensity)` call (currently
Game.ts:6283 — KEEP that call, it drives the local-weather color tint only):

```ts
if (this.state) {
  const storm = this.state.storm;
  this.ocean.setStormState(
    storm.centerX,
    storm.centerZ,
    storm.safeRadius,
    THREE.MathUtils.clamp((storm.phase - 1) / 6, 0, 1),
  );
} else {
  this.ocean.clearStormState();
}
```

The phase01 formula MUST stay `clamp((phase - 1) / 6, 0, 1)` — it is inlined in
the shader to mirror `getStormWaveIntensity` in src/shared/utils/index.ts:269.

## 2. Feed elliptical footprints to setIslands (fixes foam-at-wrong-radius)

`setIslands` now accepts `{x, z, rx, rz}` (preferred) and still accepts the
legacy `{x, z, r}` (treated as rx = rz = r), so the current call compiles
unchanged. To land foam/shallows/damping at the REAL waterline, change
src/client/core/Game.ts:2780 from:

```ts
this.ocean.setIslands(state.islands.map((i) => ({ x: i.position.x, z: i.position.z, r: i.radius })));
```

to:

```ts
this.ocean.setIslands(state.islands.map((i) => ({
  x: i.position.x,
  z: i.position.z,
  rx: i.radius * i.profile.footprintX,
  rz: i.radius * i.profile.footprintZ,
})));
```

(Per-angle bulge/inlets would need a baked coast DataTexture — audit ocean
finding 1 "proper fix"; the ellipse already lands the band within the bulge
noise of the true waterline instead of 10s of meters inside it.)

## 3. Gameplay must sample gerstnerHeight WITH storm or entities won't ride the drawn swell

The rendered surface is now `gerstnerHeight(x, z, t, WAVE_PARAMS, storm)` with
`storm = getStormWaveIntensity(stormState, x, z)`. Every CPU sampler that feeds
a visual or physical position should pass the same storm arg (all in files
owned by other agents / orchestrator):

- server: PhysicsSystem.ts buoyancy target (~391), attitude sampling (~1438),
  swimmer surfaces (541/697/772), projectile water kill (972); Match.ts splash
  raymarch (~2838)
- client: ShipRenderer.ts computeWaveMotion fallback (~2999), wake ribbon
  (~2952), bow spray (~2969); Game.ts swimmer snap (~6455) and camera
  underwater depth (7505: `gerstnerHeight(camera.x, camera.z, t, WAVE_PARAMS)`
  → add `, getStormWaveIntensity(this.state?.storm ? { center: { x: storm.centerX, y: storm.centerZ }, safeRadius: storm.safeRadius, phase: storm.phase } : null, camera.x, camera.z)`).

Until those pass storm, ships/swimmers will sit ~±2.6 m off the drawn surface
inside the storm ring at phase ≥ 1 (they already diverge for the tint-only
storm today; this makes it visible). No compile break either way.

## 4. Shore damping divergence (audit ocean finding 4) — narrowed, not closed

The render-only shore damping floor was raised 0.6 → 0.85
(OceanRenderer.ts vertex shader: `v_shoreDamp = mix(0.85, 1.0, smoothstep(-8.0, 34.0, shoreDist(wp.xz)))`),
so max render-vs-physics divergence near beaches is now ~15% of wave height
(~0.15 m typical). To close it fully, shared physics should eventually apply
the SAME damping: export from src/shared/utils/index.ts something like

```ts
export function shoreWaveDamp(x: number, z: number, islands: Island[]): number {
  let d = Infinity;
  for (const isl of islands) {
    const rx = isl.radius * isl.profile.footprintX;
    const rz = isl.radius * isl.profile.footprintZ;
    const q = Math.hypot((x - isl.position.x) / rx, (z - isl.position.z) / rz);
    d = Math.min(d, (q - 1) * Math.min(rx, rz));
  }
  return lerp(0.85, 1, smoothstep(-8, 34, d));
}
```

and multiply it into gerstnerHeight when an optional islands arg is provided
(then the GLSL and the TS use identical shapes — keep constants in sync).

## 5. FYI (self-contained, no action)

- The dark crack-hiding underlayer moved from y=-1.6 to y=-6.5 so storm
  troughs (down to ~-5.6 m at storm=1) never expose it.
- Fragment `calm` remap updated to the new getOceanRoughness range
  [0.55, 1.6] (was keyed to the old [0.25, 1.55]).
- u_islands uniform changed vec3[16] → vec4[16]; storm uniforms added
  (u_stormCenter vec2, u_stormSafeRadius float = -1 when no storm,
  u_stormPhase01 float). GLSL parity with shared gerstnerHeight verified to
  <1e-12 m and shaders compile+link in a real WebGL2 context.

---

# INTEGRATION_NOTES — ShipRenderer naval-combat visual layer (ship agent)

All ShipRenderer changes are backward compatible (new params optional / default
0). Two orchestrator-side wirings are wanted in Game.ts:

## A. Pass the storm sea-state into shipRenderer.update() (REQUIRED for hulls to ride storm swell)

`update()` gained a final optional param:

```ts
export type ShipStormSource =
  | number                                                  // precomputed 0..1 intensity
  | { center: Vec2; safeRadius: number; phase: number }     // replicated storm ring
  | null | undefined;                                       // default 0 = calm

shipRenderer.update(ships, players, t, dt, snapshotAge, camPos, localId, storm)
```

At the existing call site (Game.ts ~6330, updateScene), append the storm arg.
Either form works; passing the ring lets the renderer evaluate the shared
`getStormWaveIntensity()` PER SHIP POSITION (better for ships straddling the
wall). Suggested:

```ts
const s = this.state.storm;
this.shipRenderer.update(
  this.state.ships, this.state.players, this.ocean.getTime(), dt, snapshotAge,
  this.renderer.camera.position, this.localPlayerId ?? undefined,
  s ? { center: { x: s.centerX, y: s.centerZ }, safeRadius: s.safeRadius, phase: s.phase } : 0,
);
```

Until wired, ships sample the calm Gerstner field (exactly today's behavior —
no visual regression outside storms; inside a storm hull attitude/wake/spray
will sit on the calm surface while the drawn ocean towers ±2.6 m).

## B. Hang below-waterline gush FX on the hole anchors (CombatFx / Game)

```ts
shipRenderer.getHoleAnchors(shipId): Array<{
  section: 'bow' | 'stern' | 'port' | 'starboard';
  anchor: THREE.Object3D;      // child of the rendered ship — worldPos/quat follow heave/pitch/roll/list
  belowWaterline: boolean;     // true for port/starboard (waterline-band holes)
  active: boolean;             // section holed below FLOODING.HOLE_THRESHOLD → should gush NOW
}>
```

Each anchor is named `hole-gush-anchor`, sits 0.12 m proud of the hull surface
and its +Z axis points along the outward surface normal — spawn spray cones
along `anchor.getWorldDirection()`. Recommended beat (Game.updateScene, next to
the existing emitHullLeaks throttle): for every ship, for every
`getHoleAnchors()` entry with `active && belowWaterline`, emit a water-jet
burst every ~0.25 s scaled by `ship.waterLevel`; skip when `!ship.alive ||
ship.sinking`. Existing `emitHullLeaks` droplets can then be retired or kept
for the above-waterline (bow/stern) sections only.

## C. FYI (self-contained, no action)

- Hole decals now sit ON the lofted hull surface (position + outward normal
  from the station table) — dark punched core, splinter-ring shards, mirrored
  bow-cheek pair, transom-cap stern decal. polygonOffset kills z-fighting.
- Interior flood water: one plane per ship fitted to the loft's waterline
  half-widths (stays inside the silhouette), rises floor→deck-underside with
  `ship.waterLevel`, visible only past 0.02 and never interpenetrates the deck.
- Flood attitude is client-blended: settle to ~45% of freeboard at full flood
  (on top of the server FREEBOARD_DROP) and list up to ~7° toward the
  most-damaged below-waterline side (from ship.hull port/starboard + bow/stern),
  smoothed by the existing attitude exp-lerp. Server pitch/roll still win while
  snapshots are fresh; past ~180 ms the renderer blends to the deterministic
  client Gerstner attitude so rocking never freezes.
- `update()`'s 5th param `snapshotAge` is SECONDS (Game already passes it).
