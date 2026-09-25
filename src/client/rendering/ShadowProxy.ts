/**
 * SHADOW PROXY POLICY (b3.1h, performance-11) — casters render one LOD coarser
 * than the mesh they shadow.
 *
 * Without this, whatever LOD a mesh displays is also rasterised into the sun's
 * depth map, so every LOD0 triangle is paid twice on the tiers that have a
 * shadow map (high 2048, balanced 1536), and the rebuild's several-times-denser
 * hero LOD0s would land in the depth pass at full cost. The depth map is a
 * 1.5-2k texel square stretched over a few hundred metres: a palm's shadow
 * needs its silhouette, not its bark.
 *
 * THE POLICY
 *  - A caster drawing its NEAR (LOD0) geometry casts its FAR sibling.
 *  - A caster drawing FAR casts NOTHING: there is no coarser level, and a far
 *    mesh is by definition far enough that its shadow is a few texels of a map
 *    whose frustum is centred on the player. Impostors and far proxies never
 *    register a caster, so they never cast either (their castShadow is false).
 *  - The hull you stand on keeps LOD0 casting: ship hulls are not registered
 *    here, so the deck shadows under your feet stay crisp. (A future ship LOD
 *    that registers must skip the local ship; see `ShadowCaster.begin`.)
 *
 * WHY A SWAP AROUND THE PASS AND NOT A LAYER. three r160's WebGLShadowMap tests
 * `object.layers` against the MAIN camera's layers (WebGLShadowMap.js
 * renderObject), not the shadow camera's, so a "shadow-only" layer that the
 * main camera does not see would vanish from the shadow pass too. The one
 * place both passes are separable is the Renderer's own gated
 * `shadowMap.render` wrapper (installShadowPassGate): it runs BEFORE the main
 * pass inside the same renderer.render call. So each registered caster swaps
 * its geometry/material (or drops castShadow) in `begin`, the depth pass runs,
 * and `end` puts the display state back before a single main-pass draw.
 * Nothing here allocates per pass; a caster is two closures and a flag.
 *
 * A pass the gate skips pays nothing here either: the swap runs only around a
 * depth pass that actually happens.
 */

/** 'policy' = the rule above; 'off' = every caster renders the LOD it displays
 *  (the pre-policy cost); 'lod0' = every caster renders its LOD0 even while it
 *  displays far (the gate's mutation: LOD0 casting everywhere). */
export type ShadowProxyMode = 'policy' | 'off' | 'lod0';

export type ShadowCaster = {
  /** Swap to the shadow state for `mode`. Returns true if it changed anything,
   *  so `end` can be skipped for the untouched majority. */
  begin(mode: ShadowProxyMode): boolean;
  /** Restore the display state. Only called after a `begin` that returned true. */
  end(): void;
  /** True once the caster's node has left the scene for good; it is dropped. */
  gone(): boolean;
};

const casters: ShadowCaster[] = [];
const touched: ShadowCaster[] = [];
let mode: ShadowProxyMode = 'policy';
let lastSwapped = 0;
let lastSilenced = 0;
let passes = 0;

/** Counters the last pass's `begin` calls report through. */
export const shadowPassTally = {
  swapped(): void { lastSwapped += 1; },
  silenced(): void { lastSilenced += 1; },
};

export function registerShadowCaster(caster: ShadowCaster): void {
  casters.push(caster);
}

/**
 * Run one depth pass with every registered caster in its shadow state.
 * Called by the Renderer's shadow-pass gate around three's own render, and
 * nowhere else: the swap must be undone before the main pass draws.
 */
export function withShadowProxies(pass: () => void): void {
  if (mode === 'off' || casters.length === 0) {
    pass();
    return;
  }
  lastSwapped = 0;
  lastSilenced = 0;
  passes += 1;
  touched.length = 0;
  // Compact in place while beginning: a caster whose island was torn down is
  // dropped here, so a long session never walks dead batches.
  let w = 0;
  for (let i = 0; i < casters.length; i++) {
    const c = casters[i];
    if (c.gone()) continue;
    casters[w++] = c;
    if (c.begin(mode)) touched.push(c);
  }
  casters.length = w;
  try {
    pass();
  } finally {
    for (let i = touched.length - 1; i >= 0; i--) touched[i].end();
    touched.length = 0;
  }
}

/** Debug/gate surface (window.__piratesBR.renderer.shadowProxy). */
export const shadowProxyPolicy = {
  /** The gate's mutation turns the policy off: every caster renders the LOD it
   *  displays, which is exactly the pre-policy cost. */
  setEnabled(on: boolean): void { mode = on ? 'policy' : 'off'; },
  isEnabled(): boolean { return mode !== 'off'; },
  setMode(next: ShadowProxyMode): void { mode = next; },
  getMode(): ShadowProxyMode { return mode; },
  stats(): { casters: number; swapped: number; silenced: number; passes: number } {
    return { casters: casters.length, swapped: lastSwapped, silenced: lastSilenced, passes };
  },
};
