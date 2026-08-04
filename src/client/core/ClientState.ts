/**
 * The authoritative client-side copy of the server world: the last full
 * snapshot plus the id indexes every render path looks entities up through.
 * Pure data — it never touches the scene or the DOM.
 */
import type { GameState, HotSnapshotPayload, Player, Ship, ShipKeg } from '../../shared/types/index.js';
import { RemoteInterpolator } from '../network/RemoteInterpolation.js';

export class ClientState {
  state: GameState | null = null;
  /**
   * SERVER-TIME HISTORY for every body somebody else controls. Fed from both
   * snapshot paths below; read by the renderer through Game. See
   * src/client/network/RemoteInterpolation.ts for why a drawn position must not
   * be a function of when its packet landed.
   */
  readonly remote = new RemoteInterpolator();
  playersById = new Map<string, Player>();
  shipsById = new Map<string, Ship>();
  livePlayerIds = new Set<string>();
  liveProjectileIds = new Set<string>();
  liveKegIds = new Set<string>();
  /** EMA-smoothed offset mapping performance.now()/1000 onto server sim seconds. */
  serverTimeOffset: number | null = null;
  lastSnapshotAt = performance.now();
  /**
   * Highest `seq` applied so far, across BOTH full and hot snapshots (the
   * server bumps one shared counter for each — see Match.snapshotSeq). The
   * wire is unordered enough that a hot can overtake the full it was built
   * from; applying the older one afterwards rewinds every transform for a
   * frame. Reset to -1 per match, because the server's counter restarts too.
   */
  lastAppliedSeq = -1;

  /**
   * Gate for an incoming snapshot: false means it was overtaken and must be
   * dropped. Payloads without a `seq` (older servers) always pass.
   */
  acceptSeq(seq: number | undefined): boolean {
    if (seq === undefined) return true;
    if (seq < this.lastAppliedSeq) return false;
    this.lastAppliedSeq = seq;
    return true;
  }

  /** Merge a 31Hz 'state_hot' transform update into the last full snapshot.
   *  Hot payloads carry only moving-entity transforms (plus storm), so ships,
   *  players and projectiles glide at full rate while the heavyweight world
   *  state arrives at ~10Hz — this is what fixed the ~1s snapshot starvation. */
  applyHotSnapshot(hot: HotSnapshotPayload) {
    const state = this.state;
    if (!state) return; // need one full snapshot first
    if (!this.acceptSeq(hot.seq)) return; // overtaken by a newer full/hot
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
    this.recordRemoteHistory(hot.serverTime);
  }

  /**
   * Stamp every remote body's current transform into its history at the SERVER
   * time this snapshot describes.
   *
   * Called from BOTH snapshot paths — a hot merges into `state` before it gets
   * here, so one implementation covers the 31Hz transform stream and the 10Hz
   * full alike, and neither can drift from the other.
   *
   * A PIRATE ABOARD A SHIP IS RECORDED IN THE SHIP'S FRAME, not the world's.
   * Interpolating his world position and then drawing him against the hull that
   * is on the screen would slide him along the planking by the hull's own travel
   * over the delay — half a metre on a ship under sail. What has to be continuous
   * is where he is standing, so that is what is buffered; Game composes it back
   * against the drawn hull, which is the same composition the deck weld already
   * relies on. The frame id travels with the sample so the buffer refuses to
   * interpolate across a boarding.
   */
  private recordRemoteHistory(serverTime: number) {
    const state = this.state;
    if (!state || !Number.isFinite(serverTime)) return;
    const now = performance.now();
    this.remote.timeline.noteSnapshot(serverTime, now);
    for (const player of state.players) {
      if (player.state === 'eliminated' || player.state === 'respawning') continue;
      const ship = player.onShipId ? this.shipsById.get(player.onShipId) ?? null : null;
      let x = player.position.x;
      let y = player.position.y;
      let z = player.position.z;
      if (ship) {
        const dx = player.position.x - ship.position.x;
        const dz = player.position.z - ship.position.z;
        const cos = Math.cos(ship.rotation);
        const sin = Math.sin(ship.rotation);
        x = dx * cos - dz * sin;
        z = dx * sin + dz * cos;
        y = player.position.y - ship.position.y;
      }
      this.remote.track(`P:${player.id}`)
        // `rotation.x` is the yaw (see Game.syncPlayers' targetYaw) — `.y` is pitch.
        .push(serverTime, x, y, z, player.rotation.x, ship ? ship.id : '', now);
    }
    for (const ship of state.ships) {
      if (!ship.alive) continue;
      this.remote.track(`S:${ship.id}`)
        .push(serverTime, ship.position.x, ship.position.y, ship.position.z, ship.rotation, '', now);
    }
    for (const shark of state.sharks ?? []) {
      if (shark.health <= 0) continue;
      this.remote.track(`K:${shark.id}`)
        .push(serverTime, shark.position.x, shark.position.y, shark.position.z, shark.rotation, '', now);
    }
    // Sweeping the whole map 31 times a second to find the two tracks a death
    // left behind is thirty sweeps too many, and the iterator it allocates is
    // charged to whatever frame the snapshot landed in.
    if (now - this.lastRetireAt > 2000) {
      this.lastRetireAt = now;
      this.remote.retire(now);
    }
  }

  private lastRetireAt = 0;

  /** Public entry for the full-snapshot path (Game.applySnapshot). */
  recordRemoteHistoryFromFull(serverTime: number) {
    this.recordRemoteHistory(serverTime);
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
