/**
 * SUNKEN CARGO — the visible half of "the leader's hold spills when she sinks".
 *
 * When a laden crew founders, half their cargo gold breaks out of the hold and
 * settles a few metres down over the wreck as divable pieces (server: Match's
 * spillCargoOnFounder, entity: GoldSpoil). This draws them: a bound coin-chest
 * on the seabed with a lantern-warm glow you can pick out from the surface, so
 * a wreck mark is a place you swim TO rather than an event in a feed.
 *
 * Budget discipline: one shared geometry and one shared material across every
 * piece, an InstancedMesh-free but capped set of light objects, and no lights
 * at all — the glow is emissive plus a sprite halo, which costs nothing in the
 * light budget the night-lantern pass is already fighting over.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GoldSpoil } from '../../shared/types/index.js';

interface SpoilMesh {
  root: THREE.Group;
  bob: number;
}

export class SpoilsRenderer {
  private scene: THREE.Scene | null = null;
  private readonly meshes = new Map<string, SpoilMesh>();
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.MeshStandardMaterial | null = null;
  private haloMaterial: THREE.SpriteMaterial | null = null;

  init(scene: THREE.Scene): void {
    this.scene = scene;
  }

  /** Reconcile the drawn pieces against the snapshot, then bob + spin them. */
  update(spoils: readonly GoldSpoil[] | undefined, t: number): void {
    const scene = this.scene;
    if (!scene) return;
    const live = new Set<string>();

    for (const spoil of spoils ?? []) {
      live.add(spoil.id);
      let entry = this.meshes.get(spoil.id);
      if (!entry) {
        entry = { root: this.buildSpoil(spoil), bob: Math.random() * Math.PI * 2 };
        scene.add(entry.root);
        this.meshes.set(spoil.id, entry);
      }
      // Sunken cargo does not ride the swell — it is BELOW it, resting in the
      // green. A slow lift and a slower turn is what a bound chest does down
      // there, and it is also what makes it catch the eye from the surface.
      entry.root.position.set(
        spoil.position.x,
        spoil.position.y + Math.sin(t * 0.7 + entry.bob) * 0.16,
        spoil.position.z,
      );
      entry.root.rotation.y = t * 0.22 + entry.bob;
    }

    for (const id of this.meshes.keys()) {
      if (live.has(id)) continue;
      scene.remove(this.meshes.get(id)!.root);
      this.meshes.delete(id);
    }
  }

  /** Drop every drawn piece (match teardown). Shared assets are kept. */
  reset(): void {
    if (this.scene) {
      for (const entry of this.meshes.values()) this.scene.remove(entry.root);
    }
    this.meshes.clear();
  }

  dispose(): void {
    this.reset();
    this.geometry?.dispose();
    this.material?.dispose();
    this.haloMaterial?.map?.dispose();
    this.haloMaterial?.dispose();
    this.geometry = null;
    this.material = null;
    this.haloMaterial = null;
  }

  private buildSpoil(spoil: GoldSpoil): THREE.Group {
    const group = new THREE.Group();
    group.name = `spoil_${spoil.id}`;
    const mesh = new THREE.Mesh(this.getGeometry(), this.getMaterial());
    // Fatter purses are visibly fatter piles — the dive is worth reading.
    const scale = 0.8 + Math.min(1, spoil.value / 900) * 0.7;
    mesh.scale.setScalar(scale);
    group.add(mesh);

    const halo = new THREE.Sprite(this.getHaloMaterial());
    halo.scale.setScalar(3.4 * scale);
    halo.position.y = 0.3;
    group.add(halo);
    return group;
  }

  private getGeometry(): THREE.BufferGeometry {
    if (this.geometry) return this.geometry;
    // A burst strongbox: the box, its iron straps, and coin spilling out of the
    // split lid. Merged once and shared by every piece in the world.
    const parts: THREE.BufferGeometry[] = [];
    const box = new THREE.BoxGeometry(0.86, 0.5, 0.6);
    box.translate(0, 0.25, 0);
    parts.push(box);
    for (const sx of [-0.3, 0.3]) {
      const strap = new THREE.BoxGeometry(0.07, 0.54, 0.64);
      strap.translate(sx, 0.26, 0);
      parts.push(strap);
    }
    const lid = new THREE.BoxGeometry(0.86, 0.16, 0.62);
    lid.rotateX(-0.55);
    lid.translate(0, 0.6, -0.16);
    parts.push(lid);
    for (let i = 0; i < 9; i += 1) {
      const a = (i / 9) * Math.PI * 2;
      const coin = new THREE.CylinderGeometry(0.11, 0.12, 0.05, 7);
      coin.rotateZ(((i % 3) - 1) * 0.5);
      coin.translate(Math.cos(a) * 0.42, 0.06 + (i % 2) * 0.05, Math.sin(a) * 0.34);
      parts.push(coin);
    }
    this.geometry = mergeGeometries(parts, false) ?? box;
    for (const part of parts) if (part !== this.geometry) part.dispose();
    return this.geometry;
  }

  private getMaterial(): THREE.MeshStandardMaterial {
    if (this.material) return this.material;
    this.material = new THREE.MeshStandardMaterial({
      color: 0xE8BE55,
      emissive: 0x8a5f14,
      emissiveIntensity: 0.85,
      roughness: 0.3,
      metalness: 0.75,
    });
    return this.material;
  }

  private getHaloMaterial(): THREE.SpriteMaterial {
    if (this.haloMaterial) return this.haloMaterial;
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, 'rgba(255, 214, 128, 0.85)');
      grad.addColorStop(0.45, 'rgba(255, 180, 70, 0.28)');
      grad.addColorStop(1, 'rgba(255, 170, 60, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
    }
    const texture = new THREE.CanvasTexture(canvas);
    this.haloMaterial = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return this.haloMaterial;
  }
}
