/**
 * The harbour: the dock run (GLB modules or procedural planking, pilings, swim
 * ladder, bollard, lanterns), the tavern shell and its interior furniture, and
 * the working clutter — drying nets and crab traps — on the shore beside them.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { assets } from '../../assets/AssetLibrary.js';
import { getIslandSurfaceY } from '../../../shared/utils/index.js';
import type { IslandBuildCtx } from './context.js';
import { ensureMeshGround } from './GroundTruth.js';

export function buildDock(ctx: IslandBuildCtx) {
  const { host, island, group, rng, lowDetail, scaledCount, buildPropInstance } = ctx;
  if (island.dock) {
    const dockW = Math.max(1, Math.min(120, Number(island.dock.width) || 8));
    const dockL = Math.max(1, Math.min(200, Number(island.dock.length) || 14));
    const dock = new THREE.Group();
    // A pier is elevated BY DESIGN — the audit only gets to enforce it once its
    // legs actually reach the seabed, which is what the pilings below are for.
    dock.name = 'decor-dock';
    dock.position.set(
      island.dock.position.x - island.position.x,
      island.dock.position.y,
      island.dock.position.z - island.position.z,
    );
    dock.rotation.y = island.dock.rotation;

    const dockMat = new THREE.MeshStandardMaterial({ color: 0x7b5529, roughness: 0.95 });
    const beamMat = new THREE.MeshStandardMaterial({ color: 0x5e3d1d, roughness: 1 });
    const ropeMat = new THREE.MeshStandardMaterial({ color: 0xc8b27a, roughness: 1 });
    const plankMats = [0x8d6230, 0x83592d, 0x976a35].map((color) => new THREE.MeshStandardMaterial({ color, roughness: 0.96 }));

    // ── Pilings ──────────────────────────────────────────────────────────
    // Every post on this pier — the GLB modules' own and the procedural
    // fallback's — is authored standing ON the module, so it stops at the
    // module's base: ~0.6m ABOVE the still line. From a boat the pier read as
    // a raft of planks with its legs sawn off in mid-air, and in the shallows
    // (where the sand shows straight through the water) there was daylight
    // under the whole run. Each anchor below grows a pile down to the DRAWN
    // seabed — the mesh the player looks through the water at, not the
    // analytic field, which runs above it.
    const meshGround = ensureMeshGround(ctx);
    const pileAnchors: { lx: number; lz: number; topY: number; rx: number; rz: number }[] = [];
    const cosD = Math.cos(island.dock.rotation);
    const sinD = Math.sin(island.dock.rotation);
    const dockLocalX = island.dock.position.x - island.position.x;
    const dockLocalZ = island.dock.position.z - island.position.z;

    // GLB dock modules: walkway runs along the module's local X (6×3 mid,
    // 4×3 end, deck at +1.1); the game dock runs along local Z. Purely a
    // visual swap — server walk/collision math is untouched.
    const dockUsesGlb = assets.has('dock_mid') && assets.has('dock_end');
    if (dockUsesGlb) {
      const MID_LEN = 6;
      const END_LEN = 4;
      const MODULE_W = 3;
      const DECK_H = 1.1;
      const midCount = Math.max(1, Math.round((dockL - END_LEN) / MID_LEN));
      const runLen = midCount * MID_LEN + END_LEN;
      const alongScale = dockL / runLen;
      const widthScale = dockW / MODULE_W;
      // Server walk surface sits at dock.position.y + 0.14; keep the visual deck flush with it.
      const moduleY = 0.18 - DECK_H;
      // The module's own post pairs, in module space: x along its length, the
      // pair straddling ±(MODULE_W/2 − 0.1). rotation.y = +90° maps module x
      // onto dock −z and module z onto dock +x, so a pile lands under a post.
      const postPair = (centerZ: number, len: number) => {
        for (const px of [-len * 0.5 + 0.4, 0, len * 0.5 - 0.4] as const) {
          for (const pz of [-1, 1] as const) {
            pileAnchors.push({
              lx: pz * (MODULE_W * 0.5 - 0.1) * widthScale,
              lz: centerZ - px * alongScale,
              topY: moduleY + 0.45,     // up inside the post's wet section: no seam
              rx: 0.145 * widthScale,
              rz: 0.145 * alongScale,
            });
          }
        }
      };
      let cursor = -dockL * 0.5;
      for (let m = 0; m < midCount; m++) {
        const piece = assets.clone('dock_mid');
        if (!piece) break;
        piece.rotation.y = Math.PI * 0.5;
        piece.scale.set(alongScale, 1, widthScale);
        piece.position.set(0, moduleY, cursor + MID_LEN * alongScale * 0.5);
        dock.add(piece);
        postPair(piece.position.z, MID_LEN);
        cursor += MID_LEN * alongScale;
      }
      const endPiece = assets.clone('dock_end');
      if (endPiece) {
        endPiece.rotation.y = Math.PI * 0.5;
        endPiece.scale.set(alongScale, 1, widthScale);
        endPiece.position.set(0, moduleY, cursor + END_LEN * alongScale * 0.5);
        dock.add(endPiece);
        postPair(endPiece.position.z, END_LEN);
      }
    } else {
      const deck = new THREE.Mesh(
        new THREE.BoxGeometry(dockW, 0.22, dockL),
        dockMat,
      );
      deck.position.y = 0.12;
      deck.castShadow = true;
      deck.receiveShadow = true;
      dock.add(deck);
    }

    const shorePlatform = new THREE.Mesh(
      new THREE.BoxGeometry(dockW * 1.2, 0.24, Math.min(4.6, dockL * 0.3)),
      dockMat,
    );
    shorePlatform.position.set(0, 0.14, -dockL * 0.34);
    shorePlatform.castShadow = true;
    shorePlatform.receiveShadow = true;
    dock.add(shorePlatform);

    // Seaward tip (+z in dock-local space) — matches DOCK_LADDER_LOCAL_Z_FRAC
    // on the server and getIslandDockSwimLadderPoint in shared/utils.
    const ladderZ = dockL * 0.44;
    const railMat = new THREE.MeshStandardMaterial({ color: 0x4a3018, roughness: 0.95 });
    const rungMat = new THREE.MeshStandardMaterial({ color: 0x6a4828, roughness: 0.92 });
    const side = dockW * 0.22;
    for (const sx of [-side, side] as const) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.35, 0.1), railMat);
      rail.position.set(sx, 0.72, ladderZ - 0.12);
      rail.castShadow = true;
      dock.add(rail);
    }
    if (!lowDetail) {
      const rungCount = 8;
      for (let r = 0; r < rungCount; r++) {
        const rung = new THREE.Mesh(new THREE.BoxGeometry(side * 2.1, 0.07, 0.12), rungMat);
        rung.position.set(0, 0.18 + r * 0.14, ladderZ - r * 0.04);
        rung.castShadow = true;
        dock.add(rung);
      }

      if (!dockUsesGlb) {
        const plankCount = scaledCount(Math.round(dockW), 4);
        for (let i = 0; i < plankCount; i++) {
          const plank = new THREE.Mesh(
            new THREE.BoxGeometry(dockW / plankCount * 0.82, 0.04, dockL * 0.96),
              plankMats[i % plankMats.length],
          );
          plank.position.set(
            -dockW * 0.5 + (i + 0.5) * (dockW / plankCount),
            0.25,
            0,
          );
          plank.castShadow = true;
          plank.receiveShadow = true;
          dock.add(plank);
        }

        for (const side of [-1, 1] as const) {
          for (let i = 0; i < 4; i++) {
            const z = -dockL * 0.42 + i * (dockL * 0.28);
            const postHeight = 1.35 + rng(i * 191 + side) * 0.4;
            const post = new THREE.Mesh(
              new THREE.BoxGeometry(0.18, postHeight, 0.18),
              beamMat,
            );
            post.position.set(side * (island.dock.width * 0.45), postHeight * 0.45, z);
            post.castShadow = true;
            dock.add(post);
            pileAnchors.push({
              lx: post.position.x, lz: z,
              topY: postHeight * 0.45 - postHeight * 0.4, rx: 0.1, rz: 0.1,
            });

            if (i < 3) {
              const railLen = Math.max(0.15, dockL * 0.24);
              const rail = new THREE.Mesh(
                new THREE.CylinderGeometry(0.035, 0.035, railLen, 6),
                ropeMat,
              );
              rail.rotation.z = Math.PI * 0.5;
              rail.position.set(side * (dockW * 0.44), 0.88, z + dockL * 0.14);
              dock.add(rail);
            }
          }
        }
      }
    } else if (!dockUsesGlb) {
      for (const postSide of [-1, 1] as const) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.25, 0.18), beamMat);
        post.position.set(postSide * (dockW * 0.44), 0.65, dockL * 0.22);
        dock.add(post);
        pileAnchors.push({ lx: post.position.x, lz: post.position.z, topY: 0.15, rx: 0.1, rz: 0.1 });
      }
    }

    // …and now drive them. One merged mesh, so a pier's whole underside is a
    // single draw call however many posts it stands on.
    if (pileAnchors.length > 0) {
      const pileUnit = new THREE.CylinderGeometry(1, 1.16, 1, 6);
      const pileParts: THREE.BufferGeometry[] = [];
      const pileMat = new THREE.MeshStandardMaterial({ color: 0x3c2814, roughness: 1 });
      const mat4 = new THREE.Matrix4();
      const noRot = new THREE.Quaternion();
      for (const a of pileAnchors) {
        const ix = dockLocalX + a.lx * cosD + a.lz * sinD;
        const iz = dockLocalZ - a.lx * sinD + a.lz * cosD;
        const bed = meshGround?.heightAt(ix, iz)
          ?? getIslandSurfaceY(island, ix + island.position.x, iz + island.position.z);
        // Dock-local, and driven a good half-metre INTO the bed so a wave
        // trough never exposes the cut.
        const bottom = bed - island.dock.position.y - 0.55;
        const len = a.topY - bottom;
        // Where the shore has already risen past the post there is nothing to
        // drive — that end of the pier stands on sand.
        if (len < 0.3) continue;
        const part = pileUnit.clone();
        part.applyMatrix4(mat4.compose(
          new THREE.Vector3(a.lx, (a.topY + bottom) * 0.5, a.lz),
          noRot,
          new THREE.Vector3(a.rx, len, a.rz),
        ));
        pileParts.push(part);
      }
      pileUnit.dispose();
      const merged = pileParts.length > 0 ? mergeGeometries(pileParts, false) : null;
      for (const part of pileParts) part.dispose();
      if (merged) {
        const piles = new THREE.Mesh(merged, pileMat);
        piles.name = 'dock-piling';
        piles.castShadow = !lowDetail;
        piles.receiveShadow = true;
        dock.add(piles);
      }
    }

    const bollard = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.13, 0.55, 8),
      beamMat,
    );
    bollard.position.set(island.dock.moorSide * dockW * 0.28, 0.26, dockL * 0.18);
    bollard.castShadow = true;
    dock.add(bollard);

    if (!lowDetail) {
      // Lanterns at the dock's shore end. Warm light is routed through the
      // night-budget system (registerLanternEmitter) instead of always-on lamps.
      if (assets.has('lantern_post')) {
        const deckY = dockUsesGlb ? 0.18 : 0.26;
        for (const lanternSide of [-1, 1] as const) {
          const post = buildPropInstance(
            'lantern_post',
            new THREE.Vector3(lanternSide * (dockW * 0.46 - 0.12), deckY, -dockL * 0.38),
            // lantern arm points +X in asset space — swing it inward over the walkway
            lanternSide === 1 ? Math.PI : 0,
          );
          if (post) dock.add(post);
          host.registerLanternEmitter(dock, lanternSide * (dockW * 0.46 - 0.12), deckY + 2.1, -dockL * 0.38, 'lantern');
        }
      } else {
        const lanternMat = new THREE.MeshStandardMaterial({
          color: 0x8b6c2a,
          emissive: 0xffcc44,
          emissiveIntensity: 0.5,
          roughness: 0.9,
        });
        for (const lanternSide of [-1, 1] as const) {
          const lanternPost = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.8, 0.16), beamMat);
          lanternPost.position.set(lanternSide * (dockW * 0.46), 0.9, -dockL * 0.38);
          lanternPost.castShadow = true;
          dock.add(lanternPost);

          const lanternBox = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.3, 0.28), lanternMat);
          lanternBox.position.set(lanternSide * (dockW * 0.46), 1.95, -dockL * 0.38);
          dock.add(lanternBox);

          host.registerLanternEmitter(dock, lanternSide * (dockW * 0.46), 1.95, -dockL * 0.38, 'lantern');
        }
      }
    }

    group.add(dock);
  }
}

export function buildTavern(ctx: IslandBuildCtx) {
  const { host, island, group, lowDetail } = ctx;
  if (island.tavern) {
    const t = island.tavern;
    const tavern = new THREE.Group();
    tavern.position.set(t.position.x - island.position.x, t.position.y, t.position.z - island.position.z);
    tavern.rotation.y = t.rotation;

    const beamMat2 = new THREE.MeshStandardMaterial({ color: 0x2f1d10, roughness: 1 });
    const counterMat = new THREE.MeshStandardMaterial({ color: 0x3f2616, roughness: 0.9 });
    const lanternMat2 = new THREE.MeshStandardMaterial({ color: 0x8b6c2a, emissive: 0xff9c44, emissiveIntensity: 0.65, roughness: 0.9 });

    const wallH = 3.0;
    const w = t.width;
    const d = t.depth;

    // Nice half-timbered tavern SHELL from Blender (seated gable roof, timber
    // framing, chimney, hanging sign) — replaces the old floating-roof boxes.
    // The GLB front (door) faces +Z, matching the tavern's dock-facing rotation.
    const shell = assets.clone('tavern');
    if (shell) {
      shell.traverse((o) => { if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; } });
      tavern.add(shell);
      // The GLB keeps the door leaf as its own node with the origin ON the
      // hinge axis — register it so [X] can swing it. The tavern DOES have a
      // server collider (walls plus a 1.7 m doorway gap); only the door LEAF
      // swing is cosmetic and client-only, so it needs no server round-trip.
      const doorNode = shell.getObjectByName('door');
      if (doorNode) {
        host.setTavernDoor(island.id, doorNode);
      }
    }

    if (!lowDetail) {
      // Bar counter inside the tavern, set back from the door
      const counter = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, 1.0, 0.7), counterMat);
      counter.position.set(0, 0.6, -d * 0.18);
      counter.castShadow = true;
      counter.receiveShadow = true;
      tavern.add(counter);
      // Counter top accent
      const counterTop = new THREE.Mesh(new THREE.BoxGeometry(w * 0.74, 0.06, 0.78), beamMat2);
      counterTop.position.set(0, 1.13, -d * 0.18);
      tavern.add(counterTop);

      // Stools at the bar
      for (let s = -1; s <= 1; s++) {
        const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.7, 8), counterMat);
        stool.position.set(s * 1.3, 0.35, -d * 0.18 + 0.85);
        stool.castShadow = true;
        tavern.add(stool);
      }

      // Tables
      for (const tableSide of [-1, 1] as const) {
        const tableGroup = new THREE.Group();
        tableGroup.position.set(tableSide * (w * 0.32), 0, d * 0.12);
        const top = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 1.2), counterMat);
        top.position.y = 0.78;
        top.castShadow = true;
        tableGroup.add(top);
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.78, 6), beamMat2);
        leg.position.y = 0.39;
        tableGroup.add(leg);
        tavern.add(tableGroup);
      }

      // Hanging lanterns under roof (warm light via the night-budget system).
      for (const lx of [-1.4, 1.4, 0] as const) {
        const lantern = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.34, 0.28), lanternMat2);
        lantern.position.set(lx, wallH - 0.3, 0);
        tavern.add(lantern);
        if (lx === 0) {
          host.registerLanternEmitter(tavern, 0, wallH - 0.4, 0, 'lantern');
        }
      }
    }

    // (Sign, chimney and roof now come from the Blender tavern GLB.)
    group.add(tavern);
  }
}

/** Crab traps & fishing nets near the dock. */
export function buildDockClutter(ctx: IslandBuildCtx) {
  const { island, group, rng, lowDetail, surfacePoint, isSolidDecorPoint, islandSeed, SURFACE_ABOVE_WATER } = ctx;
  if (island.dock && !lowDetail) {
    const dock = island.dock;
    const ropeMatN = new THREE.MeshStandardMaterial({ color: 0xc8b27a, roughness: 1 });
    const trapMat = new THREE.MeshStandardMaterial({ color: 0x4a3018, roughness: 1 });
    const netMat = new THREE.MeshStandardMaterial({ color: 0xb39c6a, roughness: 1, side: THREE.DoubleSide, transparent: true, opacity: 0.7 });
    // Hanging fishing net on a frame next to the dock
    const netSideAngle = dock.shoreAngle + dock.moorSide * 0.95;
    const netPos = surfacePoint(0.86, netSideAngle, 0);
    const netGroup = new THREE.Group();
    netGroup.position.copy(netPos);
    // Net frame faces inland so the net spreads toward the dock approach
    netGroup.rotation.y = Math.atan2(-netPos.x, -netPos.z);
    // Frame: two posts + cross bar
    for (const sx of [-1, 1] as const) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 2.2, 5), trapMat);
      post.position.set(sx * 0.9, 1.1, 0);
      post.castShadow = true;
      netGroup.add(post);
    }
    const cross = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.9, 5), trapMat);
    cross.rotation.z = Math.PI * 0.5;
    cross.position.set(0, 2.0, 0);
    netGroup.add(cross);
    // Net plane
    const net = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.6, 4, 4), netMat);
    net.position.set(0, 1.15, 0.04);
    netGroup.add(net);
    // Drying fish hung on the cross bar
    const fishMat = new THREE.MeshStandardMaterial({ color: 0xb6a37a, roughness: 0.9 });
    for (let f = 0; f < 3; f++) {
      const fish = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.36, 6), fishMat);
      fish.rotation.z = Math.PI * 0.5;
      fish.position.set(-0.6 + f * 0.6, 1.78, 0);
      netGroup.add(fish);
    }
    if (isSolidDecorPoint(netPos, SURFACE_ABOVE_WATER, -0.15)) group.add(netGroup);

    // Crab traps: 2-3 stacked baskets near the shore
    const trapAngle = dock.shoreAngle - dock.moorSide * 0.7;
    const trapBase = surfacePoint(0.84, trapAngle, 0);
    for (let t = 0; t < 3; t++) {
      if (!isSolidDecorPoint(trapBase, SURFACE_ABOVE_WATER, -0.15)) continue;
      const offX = (rng(t * 901 + islandSeed) - 0.5) * 1.2;
      const offZ = (rng(t * 907 + islandSeed) - 0.5) * 1.2;
      const trapWX = trapBase.x + island.position.x + offX;
      const trapWZ = trapBase.z + island.position.z + offZ;
      const trapY = getIslandSurfaceY(island, trapWX, trapWZ);
      const trap = new THREE.Group();
      trap.position.set(trapBase.x + offX, trapY, trapBase.z + offZ);
      trap.rotation.y = rng(t * 911 + islandSeed) * Math.PI * 2;
      // Cube-cage of 4 vertical posts and 3 horizontal bands
      for (const sx of [-1, 1] as const) {
        for (const sz of [-1, 1] as const) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.5, 4), trapMat);
          post.position.set(sx * 0.22, 0.25, sz * 0.22);
          trap.add(post);
        }
      }
      for (let band = 0; band < 3; band++) {
        for (const ax of ['x', 'z'] as const) {
          const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.46, 4), ropeMatN);
          bar.rotation.z = ax === 'x' ? 0 : Math.PI * 0.5;
          bar.rotation.x = ax === 'z' ? 0 : Math.PI * 0.5;
          bar.position.set(ax === 'x' ? 0 : 0.22, 0.08 + band * 0.16, ax === 'z' ? 0 : 0.22);
          // Two parallel sides per axis
          const bar2 = bar.clone();
          bar2.position.set(ax === 'x' ? 0 : -0.22, 0.08 + band * 0.16, ax === 'z' ? 0 : -0.22);
          trap.add(bar);
          trap.add(bar2);
        }
      }
      trap.castShadow = true;
      group.add(trap);
    }
  }
}
