/**
 * The authoritative client-side copy of the server world: the last full
 * snapshot plus the id indexes every render path looks entities up through.
 * Pure data — it never touches the scene or the DOM.
 */
import type { GameState, HotSnapshotPayload, Player, Ship, ShipKeg } from '../../shared/types/index.js';

export class ClientState {
  state: GameState | null = null;
  playersById = new Map<string, Player>();
  shipsById = new Map<string, Ship>();
  livePlayerIds = new Set<string>();
  liveProjectileIds = new Set<string>();
  liveKegIds = new Set<string>();
  /** EMA-smoothed offset mapping performance.now()/1000 onto server sim seconds. */
  serverTimeOffset: number | null = null;
  lastSnapshotAt = performance.now();

  /** Merge a 31Hz 'state_hot' transform update into the last full snapshot.
   *  Hot payloads carry only moving-entity transforms (plus storm), so ships,
   *  players and projectiles glide at full rate while the heavyweight world
   *  state arrives at ~10Hz — this is what fixed the ~1s snapshot starvation. */
  applyHotSnapshot(hot: HotSnapshotPayload) {
    const state = this.state;
    if (!state) return; // need one full snapshot first
    if (hot.tick < state.tick) return; // stale hot arriving after a newer full
    state.tick = hot.tick;
    state.serverTime = hot.serverTime;
    state.shipsAlive = hot.shipsAlive;
    state.storm = hot.storm;
    for (const h of hot.ships) {
      const ship = this.shipsById.get(h.id);
      if (!ship) continue;
      ship.position = h.position;
      ship.rotation = h.rotation;
      ship.velocity = h.velocity;
      ship.angularVelocity = h.angularVelocity;
      ship.pitch = h.pitch;
      ship.roll = h.roll;
      ship.heave = h.heave;
      if (h.rudderAngle !== undefined) ship.rudderAngle = h.rudderAngle;
      ship.sailHeight = h.sailHeight;
      ship.sailAngle = h.sailAngle;
      ship.sinking = h.sinking;
      ship.sinkProgress = h.sinkProgress;
      if (h.waterLevel !== undefined) ship.waterLevel = h.waterLevel;
      if (h.floodingRate !== undefined) ship.floodingRate = h.floodingRate;
    }
    for (const h of hot.players) {
      const player = this.playersById.get(h.id);
      if (!player) continue;
      player.position = h.position;
      player.rotation = h.rotation;
      player.velocity = h.velocity;
      player.health = h.health;
      player.armor = h.armor ?? player.armor ?? 0;
      player.crouching = h.crouching ?? player.crouching ?? false;
      player.state = h.state;
      player.mastClimb = h.mastClimb;
      player.onShipId = h.onShipId;
      player.cutlassCharge = h.cutlassCharge;
      player.downedUntil = h.downedUntil;
      player.reviveProgress = h.reviveProgress;
    }
    for (const h of hot.projectiles) {
      for (const projectile of state.projectiles) {
        if (projectile.id === h.id) {
          projectile.position = h.position;
          projectile.velocity = h.velocity;
          break;
        }
      }
    }
    for (const h of hot.kegs) {
      let known = false;
      for (const keg of state.kegs) {
        if (keg.id === h.id) {
          keg.position = h.position;
          keg.timer = h.timer;
          known = true;
          break;
        }
      }
      if (!known) {
        // A keg placed between full snapshots must render NOW — spawn a
        // minimal record; the next full snapshot fills shipId/localPosition.
        state.kegs.push({
          id: h.id,
          shipId: null,
          position: h.position,
          localPosition: null,
          section: 'bow',
          plantedById: '',
          timer: h.timer,
        } as ShipKeg);
        this.liveKegIds.add(h.id);
      }
    }
    for (const h of hot.sharks) {
      for (const shark of state.sharks ?? []) {
        if (shark.id === h.id) {
          shark.position = h.position;
          shark.rotation = h.rotation;
          shark.health = h.health;
          shark.attackState = h.attackState;
          shark.attackTimer = h.attackTimer;
          break;
        }
      }
    }
    this.lastSnapshotAt = performance.now();
    if (Number.isFinite(hot.serverTime)) {
      const offset = hot.serverTime - performance.now() / 1000;
      this.serverTimeOffset = this.serverTimeOffset === null
        ? offset
        : this.serverTimeOffset + (offset - this.serverTimeOffset) * 0.1;
    }
  }


  rebuildStateIndexes(state: GameState) {
    this.playersById.clear();
    for (const player of state.players) this.playersById.set(player.id, player);
    this.shipsById.clear();
    for (const ship of state.ships) this.shipsById.set(ship.id, ship);
    this.livePlayerIds.clear();
    for (const player of state.players) this.livePlayerIds.add(player.id);
    this.liveProjectileIds.clear();
    for (const projectile of state.projectiles) {
      if (projectile.alive) this.liveProjectileIds.add(projectile.id);
    }
    this.liveKegIds.clear();
    for (const keg of state.kegs) {
      if (keg.timer > 0) this.liveKegIds.add(keg.id);
    }
  }
}
