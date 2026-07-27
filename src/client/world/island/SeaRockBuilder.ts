/**
 * Sea-stack rocks: the shared enriched pillar material and the rock groups
 * themselves. Sea stacks are their own world objects — they sit offshore, not on
 * an island — so they build outside the island pipeline.
 */
import * as THREE from 'three';
import type { SeaRock } from '../../../shared/types/index.js';
import { assets, type AssetName } from '../../assets/AssetLibrary.js';
import type { IslandBuilderCtx } from './context.js';

let seaRockMaterialCache: THREE.MeshStandardMaterial | null = null;
/** Shared enriched sea-stack material: the Blender GLB gives the eroded pillar
 *  geometry, this paints it with sedimentary strata bands, a wet dark base at
 *  the waterline, a sun-bleached crown and position mottling so stacks read as
 *  real weathered rock — not flat pale monoliths. Keyed on local/world pos so a
 *  single shared material still varies per rock. */
function getSeaRockMaterial(): THREE.MeshStandardMaterial {
  if (seaRockMaterialCache) return seaRockMaterialCache;
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.97, flatShading: true });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRockWorld;\nvarying float vRockLocalY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRockLocalY = position.y;\nvRockWorld = (modelMatrix * vec4(position, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRockWorld;\nvarying float vRockLocalY;')
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n'
        + 'float _band = sin(vRockLocalY * 1.35 + 0.6) * 0.5 + 0.5;\n'
        + '_band = pow(_band, 1.4);\n'                                    // crisper band edges
        + 'vec3 _rockA = vec3(0.20, 0.185, 0.16);\n'                      // dark weathered stone
        + 'vec3 _rockB = vec3(0.40, 0.36, 0.30);\n'                       // warm lit band
        + 'vec3 _col = mix(_rockA, _rockB, _band);\n'
        + '_col *= 0.88 + 0.12 * sin(vRockLocalY * 5.0 + 1.3);\n'
        + 'float _m = fract(sin(dot(floor(vRockWorld.xz * 0.55), vec2(12.9898, 78.233))) * 43758.5453);\n'
        + '_col *= 0.86 + 0.2 * _m;\n'
        + 'float _wet = 1.0 - smoothstep(-1.0, 5.5, vRockWorld.y);\n'
        + '_col = mix(_col, vec3(0.11, 0.13, 0.14), _wet * 0.75);\n'      // dark salt-wet base
        + 'float _crown = smoothstep(7.0, 12.5, vRockLocalY);\n'
        + '_col = mix(_col, vec3(0.55, 0.53, 0.47), _crown * 0.55);\n'    // sun-bleached / guano crown
        + '_col += vec3(0.03, 0.045, 0.02) * (1.0 - _band) * (1.0 - _wet);\n' // faint lichen in shaded bands

        + 'diffuseColor.rgb = _col;',
      );
  };
  mat.customProgramCacheKey = () => 'pirates-searock';
  seaRockMaterialCache = mat;
  return mat;
}

/**
 * The part of a sea stack the sea is standing on.
 *
 * Both the GLB spires and the procedural fallback ended AT y=0: swimming past
 * one you watched the rock stop dead in the water with open sea visible under
 * it, and a storm trough (~2.5 m below the still line) exposed the whole flat
 * cut as a slab hovering over the swell. A stack is a drowned mountain — give
 * it the 4 m of drowned mountain the waterline hides, flaring outward like a
 * real wave-cut base. It takes the shared material's submerged colour band
 * (`_wet` keys on world Y) for free, and stays inside the collider radius so
 * nothing new can be bumped into.
 */
function addSubmergedSkirt(group: THREE.Group, radius: number, lowDetail: boolean) {
  // Top NARROWER than the spire's own base and barely above the still line, so
  // the taper reads as the rock continuing under the swell — a wide collar at
  // the surface just swaps one artefact (a rock cut off at y=0) for another (a
  // slab floating on the water).
  const top = 0.3;
  const bottom = -4.0;
  const height = top - bottom;
  const skirt = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.6, radius * 0.98, height, lowDetail ? 6 : 10, 1, true),
    getSeaRockMaterial(),
  );
  skirt.position.y = (top + bottom) * 0.5;
  skirt.castShadow = false;
  skirt.receiveShadow = false;
  skirt.name = 'sea-rock-skirt';
  group.add(skirt);
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(radius * 0.98, lowDetail ? 6 : 10),
    getSeaRockMaterial(),
  );
  floor.rotation.x = Math.PI * 0.5;   // faces down — the open cylinder's cap
  floor.position.y = bottom;
  floor.name = 'sea-rock-skirt-cap';
  group.add(floor);
}

export function buildSeaRockMesh(rock: SeaRock, host: IslandBuilderCtx) {
  const group = new THREE.Group();
  group.name = `sea-rock-${rock.id}`;
  group.position.set(rock.position.x, rock.position.y, rock.position.z);
  group.rotation.y = rock.rotation;
  const lowDetail = host.renderer.getQuality() === 'low';

  // GLB sea spires by size tier, fitted inside the server collider envelope
  // (main collider cylinder) so visuals never exceed the collision size.
  const tier: AssetName = rock.height > 26 ? 'searock_b' : rock.height > 13 ? 'searock_a' : 'searock_c';
  const rockClone = assets.clone(tier);
  const rockBounds = assets.bounds(tier);
  if (rockClone && rockBounds) {
    const assetHoriz = Math.max(-rockBounds.min.x, rockBounds.max.x, -rockBounds.min.z, rockBounds.max.z, 0.001);
    const mainColliderRadius = rock.variant === 1 ? rock.radius * 0.72 : rock.radius * (0.62 + rock.variant * 0.035);
    const mainColliderTop = rock.height * (rock.variant === 1 ? 0.84 : 0.94) - 1.3;
    const sxz = mainColliderRadius / assetHoriz;
    const sy = Math.max(0.4, mainColliderTop / Math.max(rockBounds.max.y, 0.001));
    rockClone.scale.set(sxz, sy, sxz);
    const seaRockMat = getSeaRockMaterial();
    rockClone.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.material = seaRockMat;          // enriched strata/wet/mottle look
        o.castShadow = !lowDetail;
        o.receiveShadow = !lowDetail;
      }
    });
    group.add(rockClone);
    addSubmergedSkirt(group, mainColliderRadius, lowDetail);

    const foam = new THREE.Mesh(
      new THREE.RingGeometry(rock.radius * 0.8, rock.radius * 1.12, lowDetail ? 12 : 24),
      new THREE.MeshBasicMaterial({ color: 0xdcede8, transparent: true, opacity: 0.26, side: THREE.DoubleSide, depthWrite: false }),
    );
    foam.rotation.x = -Math.PI * 0.5;
    foam.position.y = 0.04;
    group.add(foam);
    return group;
  }

  const darkMat = new THREE.MeshStandardMaterial({ color: 0x292d2b, roughness: 1, flatShading: true });
  const wetMat = new THREE.MeshStandardMaterial({ color: 0x3c403a, roughness: 0.92, flatShading: true });
  const topMat = new THREE.MeshStandardMaterial({ color: 0x595548, roughness: 0.98, flatShading: true });
  const mainGeo = rock.variant === 1
    ? new THREE.ConeGeometry(rock.radius * 0.72, rock.height, 6, 1)
    : new THREE.DodecahedronGeometry(rock.radius * 0.62, 1);
  const main = new THREE.Mesh(mainGeo, rock.variant === 2 ? wetMat : darkMat);
  main.scale.set(1.05, rock.variant === 1 ? 1 : rock.height / Math.max(1, rock.radius), 0.82 + rock.variant * 0.08);
  main.position.y = rock.height * 0.34 - 1.8;
  main.rotation.set(-0.16 + rock.variant * 0.11, 0, 0.09);
  main.castShadow = !lowDetail;
  main.receiveShadow = !lowDetail;
  group.add(main);

  const shardCount = lowDetail ? 1 + Math.min(1, rock.variant) : 4 + rock.variant;
  for (let i = 0; i < shardCount; i++) {
    const angle = (i / shardCount) * Math.PI * 2 + rock.rotation * 0.17;
    const radius = rock.radius * (0.28 + (i % 2) * 0.16);
    const shardH = rock.height * (0.34 + (i % 3) * 0.08);
    const shard = new THREE.Mesh(
      new THREE.ConeGeometry(rock.radius * (0.16 + (i % 2) * 0.04), shardH, 5, 1),
      i % 2 === 0 ? wetMat : topMat,
    );
    shard.position.set(Math.cos(angle) * radius, shardH * 0.28 - 1.2, Math.sin(angle) * radius);
    shard.rotation.set((i % 2 ? 0.24 : -0.18), angle, (i % 3 - 1) * 0.18);
    shard.castShadow = !lowDetail;
    shard.receiveShadow = !lowDetail;
    group.add(shard);
  }

  addSubmergedSkirt(group, rock.radius * 0.7, lowDetail);

  const foam = new THREE.Mesh(
    new THREE.RingGeometry(rock.radius * 0.8, rock.radius * 1.12, lowDetail ? 12 : 24),
    new THREE.MeshBasicMaterial({ color: 0xdcede8, transparent: true, opacity: 0.26, side: THREE.DoubleSide, depthWrite: false }),
  );
  foam.rotation.x = -Math.PI * 0.5;
  foam.position.y = 0.04;
  group.add(foam);

  return group;
}
