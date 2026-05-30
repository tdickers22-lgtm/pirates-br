import * as THREE from 'three';
import type { Projectile, ProjectileType, Vec3, WeaponId } from '../../shared/types/index.js';

type Burst = {
  mesh: THREE.Mesh;
  light: THREE.PointLight | null;
  ttl: number;
  age: number;
  startScale: number;
  endScale: number;
  startOpacity: number;
  endOpacity: number;
};

export class CombatFx {
  private readonly root = new THREE.Group();
  private readonly bursts: Burst[] = [];
  private audioContext: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  init(scene: THREE.Scene) {
    scene.add(this.root);
  }

  unlockAudio() {
    if (!this.audioContext) {
      const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      this.audioContext = new AudioCtx();
      this.masterGain = this.audioContext.createGain();
      this.masterGain.gain.value = 0.22;
      this.masterGain.connect(this.audioContext.destination);
      this.noiseBuffer = this.createNoiseBuffer(this.audioContext);
    }

    if (this.audioContext.state === 'suspended') {
      void this.audioContext.resume();
    }
  }

  update(dt: number) {
    for (let index = this.bursts.length - 1; index >= 0; index--) {
      const burst = this.bursts[index];
      burst.age += dt;
      const progress = Math.min(1, burst.age / burst.ttl);
      const eased = 1 - Math.pow(1 - progress, 2);
      const scale = THREE.MathUtils.lerp(burst.startScale, burst.endScale, eased);
      const opacity = THREE.MathUtils.lerp(burst.startOpacity, burst.endOpacity, eased);
      burst.mesh.scale.setScalar(scale);
      const material = burst.mesh.material as THREE.MeshBasicMaterial;
      material.opacity = Math.max(0, opacity);
      if (burst.light) {
        burst.light.intensity = Math.max(0, (1 - progress) * 2.2);
      }

      if (progress >= 1) {
        burst.mesh.removeFromParent();
        burst.light?.removeFromParent();
        burst.mesh.geometry.dispose();
        material.dispose();
        this.bursts.splice(index, 1);
      }
    }
  }

  emitLaunch(projectile: Projectile, cameraPos: THREE.Vector3, isLocalSource: boolean) {
    const palette = this.getPalette(projectile.type);
    const size = projectile.type === 'bullet' ? 0.45 : projectile.type === 'tsunami' ? 3.4 : projectile.type === 'cannonball' ? 1.1 : 0.85;
    this.spawnBurst(
      projectile.position,
      size,
      size * (projectile.type === 'bullet' ? 2.2 : projectile.type === 'tsunami' ? 4.4 : 2.9),
      0.12,
      palette.flash,
      0.9,
      0,
      projectile.type === 'bullet' ? 1.2 : projectile.type === 'tsunami' ? 3.4 : 2.3,
    );
    this.playShotSound(projectile.type, projectile.position, cameraPos, isLocalSource, projectile.weaponId);
  }

  emitImpact(type: ProjectileType, position: Vec3, cameraPos: THREE.Vector3) {
    const palette = this.getPalette(type);
    const size = type === 'bullet' ? 0.8 : type === 'cannonball' ? 2.2 : 1.7;
    this.spawnBurst(position, size * 0.35, size, type === 'bullet' ? 0.18 : 0.26, palette.impact, 0.7, 0, type === 'bullet' ? 0.8 : 1.7);
    this.playImpactSound(type, position, cameraPos);
  }

  emitShipHitConfirm(position: Vec3, cameraPos: THREE.Vector3) {
    this.playShipHitConfirmSound(position, cameraPos);
  }

  emitRespawn(position: Vec3, cameraPos: THREE.Vector3) {
    this.spawnBurst(position, 0.8, 3.6, 0.55, 0x9bddff, 0.75, 0, 2.2);
    this.playRespawnSound(position, cameraPos);
  }

  /** Shark killed — blood bloom on the water surface */
  emitSharkDeathBloom(position: Vec3, cameraPos: THREE.Vector3) {
    const surface = { x: position.x, y: Math.max(0.22, position.y - 0.05), z: position.z };
    this.spawnBurst(surface, 0.55, 5.2, 0.85, 0x8a1a24, 0.82, 0.12, 1.8);
    this.spawnBurst({ x: surface.x + 0.35, y: surface.y, z: surface.z - 0.2 }, 0.4, 3.8, 0.72, 0x4a060c, 0.7, 0.08, 1.2);
    this.spawnBurst({ x: surface.x - 0.28, y: surface.y + 0.05, z: surface.z + 0.3 }, 0.35, 4.4, 0.78, 0xc42832, 0.65, 0.1, 1.4);
    this.spawnBurst({ x: surface.x, y: surface.y - 0.08, z: surface.z }, 0.9, 7.5, 1.1, 0x2a0508, 0.45, 0, 0);
    this.playSharkDeathSound(surface, cameraPos);
  }

  private playSharkDeathSound(position: Vec3, cameraPos: THREE.Vector3) {
    const volume = this.getSpatialVolume(position, cameraPos, 1, 200);
    if (volume <= 0.01) return;
    this.unlockAudio();
    const ctx = this.audioContext;
    if (!ctx) return;
    const now = ctx.currentTime;
    this.playNoise(now, 0.35, 420, 0.55, volume * 0.55, 'lowpass');
    this.playTone(now + 0.02, 95, 220, 0.4, volume * 0.35, 'sawtooth');
  }

  emitKegExplosion(position: Vec3, cameraPos: THREE.Vector3) {
    this.spawnBurst(position, 1.4, 6.8, 0.16, 0xffefbd, 0.98, 0, 5.2);
    this.spawnBurst({ x: position.x, y: position.y + 0.25, z: position.z }, 2, 9.4, 0.26, 0xff8c3a, 0.72, 0, 4.1);
    this.spawnBurst({ x: position.x, y: position.y + 0.65, z: position.z }, 1.4, 6.2, 0.46, 0x3d342d, 0.26, 0, 0);

    for (let index = 0; index < 6; index++) {
      const angle = (index / 6) * Math.PI * 2;
      const radius = 0.5 + (index % 2) * 0.28;
      this.spawnBurst(
        {
          x: position.x + Math.cos(angle) * radius,
          y: position.y + 0.18 + (index % 3) * 0.1,
          z: position.z + Math.sin(angle) * radius,
        },
        0.45,
        2.1,
        0.22,
        index % 2 === 0 ? 0xffc86a : 0xff6f2d,
        0.78,
        0,
        1.2,
      );
    }

    this.playKegExplosionSound(position, cameraPos);
  }

  private spawnBurst(
    position: Vec3,
    startScale: number,
    endScale: number,
    ttl: number,
    color: number,
    startOpacity: number,
    endOpacity: number,
    lightIntensity: number,
  ) {
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: startOpacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 10), material);
    mesh.position.set(position.x, position.y, position.z);
    mesh.scale.setScalar(startScale);
    this.root.add(mesh);

    let light: THREE.PointLight | null = null;
    if (lightIntensity > 0) {
      light = new THREE.PointLight(color, lightIntensity, endScale * 14);
      light.position.copy(mesh.position);
      this.root.add(light);
    }

    this.bursts.push({
      mesh,
      light,
      ttl,
      age: 0,
      startScale,
      endScale,
      startOpacity,
      endOpacity,
    });
  }

  private getPalette(type: ProjectileType) {
    switch (type) {
      case 'cannonball':
        return { flash: 0xffd8a0, impact: 0xffbb73 };
      case 'firebomb':
        return { flash: 0xff8642, impact: 0xff5b2d };
      case 'chainshot':
        return { flash: 0xb8d9ff, impact: 0x7fb4ee };
      case 'tsunami':
        return { flash: 0x8fefff, impact: 0x60cfff };
      case 'bullet':
      default:
        return { flash: 0xfff2c2, impact: 0xece8ff };
    }
  }

  private playShotSound(type: ProjectileType, position: Vec3, cameraPos: THREE.Vector3, isLocalSource: boolean, weaponId?: WeaponId) {
    const bulletRange = weaponId === 'eye_of_reach' ? 320 : weaponId === 'blunderbuss' ? 150 : 130;
    const volume = this.getSpatialVolume(position, cameraPos, isLocalSource ? 1.4 : 1, type === 'tsunami' ? 420 : type === 'cannonball' ? 240 : bulletRange);
    if (volume <= 0.01) return;
    this.unlockAudio();
    const ctx = this.audioContext;
    const master = this.masterGain;
    if (!ctx || !master) return;

    const now = ctx.currentTime;
    if (type === 'cannonball') {
      this.playNoise(now, 0.38, 180, 0.7, volume * 1.15, 'lowpass');
      this.playTone(now, 82, 38, 0.34, volume * 0.9, 'triangle');
      this.playTone(now + 0.02, 180, 110, 0.12, volume * 0.25, 'square');
    } else if (type === 'firebomb') {
      this.playNoise(now, 0.2, 1200, 1.2, volume * 0.8, 'bandpass');
      this.playTone(now, 180, 90, 0.18, volume * 0.45, 'sawtooth');
    } else if (type === 'chainshot') {
      this.playNoise(now, 0.16, 900, 0.9, volume * 0.6, 'bandpass');
      this.playTone(now, 210, 120, 0.16, volume * 0.38, 'square');
    } else if (type === 'tsunami') {
      this.playNoise(now, 0.55, 240, 0.95, volume * 0.9, 'lowpass');
      this.playTone(now, 70, 46, 0.46, volume * 0.58, 'sawtooth');
    } else if (weaponId === 'eye_of_reach') {
      // Long rifle crack: bright muzzle snap, wood/steel body, and a low echo tail.
      this.playNoise(now, 0.06, 5200, 1.4, volume * 0.95, 'highpass');
      this.playTone(now, 1160, 620, 0.09, volume * 0.34, 'square');
      this.playTone(now + 0.012, 92, 56, 0.34, volume * 0.42, 'triangle');
      this.playNoise(now + 0.08, 0.42, 310, 0.72, volume * 0.34, 'lowpass');
      this.playTone(now + 0.16, 260, 150, 0.22, volume * 0.12, 'sine');
    } else if (weaponId === 'blunderbuss') {
      this.playNoise(now, 0.11, 2800, 1.1, volume * 0.72, 'bandpass');
      this.playNoise(now + 0.025, 0.22, 430, 0.7, volume * 0.55, 'lowpass');
      this.playTone(now, 180, 88, 0.18, volume * 0.34, 'triangle');
    } else if (weaponId === 'flintknock') {
      this.playNoise(now, 0.08, 3600, 1.1, volume * 0.68, 'bandpass');
      this.playTone(now, 340, 120, 0.13, volume * 0.3, 'square');
      this.playNoise(now + 0.06, 0.18, 260, 0.75, volume * 0.28, 'lowpass');
    } else {
      this.playNoise(now, 0.12, 1500, 0.8, volume * 0.55, 'bandpass');
      this.playTone(now, 280, 120, 0.1, volume * 0.25, 'triangle');
    }
  }

  private playImpactSound(type: ProjectileType, position: Vec3, cameraPos: THREE.Vector3) {
    const volume = this.getSpatialVolume(position, cameraPos, 1, type === 'cannonball' ? 220 : 120);
    if (volume <= 0.01) return;
    this.unlockAudio();
    const ctx = this.audioContext;
    if (!ctx) return;

    const now = ctx.currentTime;
    if (type === 'cannonball') {
      this.playNoise(now, 0.22, 240, 1.1, volume * 0.72, 'lowpass');
      this.playTone(now, 70, 42, 0.22, volume * 0.42, 'triangle');
    } else if (type === 'firebomb') {
      this.playNoise(now, 0.2, 950, 1.2, volume * 0.6, 'bandpass');
      this.playTone(now, 150, 70, 0.18, volume * 0.28, 'sawtooth');
    } else {
      this.playNoise(now, 0.1, 850, 0.85, volume * 0.28, 'bandpass');
    }
  }

  private playRespawnSound(position: Vec3, cameraPos: THREE.Vector3) {
    const volume = this.getSpatialVolume(position, cameraPos, 1.2, 220);
    if (volume <= 0.01) return;
    this.unlockAudio();
    const ctx = this.audioContext;
    if (!ctx) return;

    const now = ctx.currentTime;
    this.playTone(now, 240, 360, 0.18, volume * 0.22, 'sine');
    this.playTone(now + 0.06, 360, 520, 0.24, volume * 0.18, 'sine');
    this.playNoise(now, 0.16, 1400, 1.1, volume * 0.12, 'bandpass');
  }

  private playKegExplosionSound(position: Vec3, cameraPos: THREE.Vector3) {
    const volume = this.getSpatialVolume(position, cameraPos, 1.4, 260);
    if (volume <= 0.01) return;
    this.unlockAudio();
    const ctx = this.audioContext;
    if (!ctx) return;

    const now = ctx.currentTime;
    this.playNoise(now, 0.36, 180, 0.68, volume * 1.25, 'lowpass');
    this.playNoise(now + 0.03, 0.22, 980, 1.15, volume * 0.5, 'bandpass');
    this.playTone(now, 62, 34, 0.28, volume * 0.52, 'triangle');
    this.playTone(now + 0.02, 180, 92, 0.18, volume * 0.18, 'sawtooth');
  }

  private playShipHitConfirmSound(position: Vec3, cameraPos: THREE.Vector3) {
    const spatial = this.getSpatialVolume(position, cameraPos, 1.1, 260);
    const volume = Math.max(0.18, spatial * 0.95);
    this.unlockAudio();
    const ctx = this.audioContext;
    if (!ctx) return;

    const now = ctx.currentTime;
    this.playNoise(now, 0.09, 720, 1.1, volume * 0.12, 'bandpass');
    this.playTone(now, 246, 294, 0.11, volume * 0.16, 'sine');
    this.playTone(now + 0.035, 369, 440, 0.16, volume * 0.2, 'triangle');
    this.playTone(now + 0.075, 440, 392, 0.12, volume * 0.12, 'triangle');
  }

  private playTone(
    when: number,
    fromFreq: number,
    toFreq: number,
    duration: number,
    volume: number,
    type: OscillatorType,
  ) {
    const ctx = this.audioContext;
    const master = this.masterGain;
    if (!ctx || !master) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(fromFreq, when);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, toFreq), when + duration);
    gain.gain.setValueAtTime(Math.max(0.0001, volume), when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    osc.connect(gain);
    gain.connect(master);
    osc.start(when);
    osc.stop(when + duration);
  }

  private playNoise(
    when: number,
    duration: number,
    frequency: number,
    q: number,
    volume: number,
    filterType: BiquadFilterType,
  ) {
    const ctx = this.audioContext;
    const master = this.masterGain;
    const noiseBuffer = this.noiseBuffer;
    if (!ctx || !master || !noiseBuffer) return;
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(frequency, when);
    filter.Q.value = q;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(Math.max(0.0001, volume), when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(when);
    source.stop(when + duration);
  }

  private getSpatialVolume(position: Vec3, cameraPos: THREE.Vector3, boost: number, maxDistance: number) {
    const dx = position.x - cameraPos.x;
    const dy = position.y - cameraPos.y;
    const dz = position.z - cameraPos.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const normalized = 1 - THREE.MathUtils.clamp(distance / maxDistance, 0, 1);
    return normalized * normalized * boost;
  }

  private createNoiseBuffer(ctx: AudioContext) {
    const length = Math.floor(ctx.sampleRate * 0.8);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < length; index++) {
      data[index] = (Math.random() * 2 - 1) * (1 - index / length * 0.1);
    }
    return buffer;
  }
}
