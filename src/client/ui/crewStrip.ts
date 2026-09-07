import type { Player } from '../../shared/types/index.js';

/**
 * WHO ELSE IS ON THIS SHIP (CREWHUD-01 / hud-21, netcode-13, liveplay-16).
 *
 * The menu, the lobby and the end board all speak of CREWS. The HUD never
 * mentioned one. A player in Duos or Squads had no way to answer "where is my
 * mate, is she alive, is she at the wheel" other than turning around and
 * looking — and half the time the mate was below deck, or bailing in the hold,
 * or downed on the far side of the quarterdeck with a timer running out.
 *
 * The strip is four facts per crewmate and nothing else: name, health, what
 * they are doing, and how far away. It is deliberately not a scoreboard.
 *
 * Pure on purpose — `scripts/test-crew-ui.mjs` drives this without a browser.
 */

export type CrewStation = 'helm' | 'gun' | 'swim' | 'downed' | 'out' | 'deck' | 'ashore';

export interface CrewStripRow {
  id: string;
  name: string;
  /** 0–1 of maximum. */
  health: number;
  station: CrewStation;
  /** Glyph for the station, so the strip reads at a glance. */
  glyph: string;
  /** Metres, rounded — null when the crewmate has no position worth quoting. */
  distance: number;
  /** Compass bearing to them from the local camera, degrees 0–360. */
  bearing: number;
  /** 0-1 of a revive in progress on this crewmate (the wire carries no
   *  bleed-out clock, only `reviveProgress`, so the strip shows the help
   *  arriving rather than inventing a countdown). */
  reviving: number;
}

const GLYPHS: Record<CrewStation, string> = {
  helm: '☸', gun: '⌖', swim: '≈', downed: '✚', out: '☠', deck: '⚓', ashore: '⛰',
};

/** What this hand is doing, in the order that matters to the crew: a downed
 *  mate outranks a mate at the wheel. */
export function crewStation(p: Player): CrewStation {
  if (p.state === 'eliminated' || p.state === 'respawning') return 'out';
  if (p.state === 'downed') return 'downed';
  if (p.atHelm) return 'helm';
  if (p.atCannon) return 'gun';
  if (p.state === 'swimming') return 'swim';
  return p.onShipId ? 'deck' : 'ashore';
}

/**
 * A crewmate is someone on YOUR crew, which is the server's `crewId` when it
 * has one and the hull you are both berthed to when it does not (a solo match
 * has crews of one, and the strip is then empty rather than listing the fleet).
 * The local pirate is never in their own strip.
 */
export function isCrewmate(local: Player, other: Player): boolean {
  if (other.id === local.id) return false;
  if (local.crewId && other.crewId) return local.crewId === other.crewId;
  // No crew record on the wire yet: the shared hull is the crew. `null`
  // shipId on BOTH sides would otherwise make every shipwrecked pirate in the
  // match a crewmate, so an absent hull matches nobody.
  return !!local.shipId && local.shipId === other.shipId;
}

export interface CrewStripOptions {
  /** Where the camera is, for distance and bearing. */
  camera: { x: number; z: number };
  /** Max health, so the bar is a fraction rather than a raw number. */
  maxHealth: number;
}

export function crewStripRows(
  players: readonly Player[],
  local: Player,
  opts: CrewStripOptions,
): CrewStripRow[] {
  const rows: CrewStripRow[] = [];
  for (const p of players) {
    if (!isCrewmate(local, p)) continue;
    const station = crewStation(p);
    const dx = p.position.x - opts.camera.x;
    const dz = p.position.z - opts.camera.z;
    rows.push({
      id: p.id,
      name: p.name,
      health: Math.max(0, Math.min(1, p.health / Math.max(1, opts.maxHealth))),
      station,
      glyph: GLYPHS[station],
      distance: Math.round(Math.hypot(dx, dz)),
      bearing: (Math.atan2(dx, dz) * 180 / Math.PI + 360) % 360,
      reviving: station === 'downed' ? Math.max(0, Math.min(1, p.reviveProgress ?? 0)) : 0,
    });
  }
  // A mate who needs help first, then the nearest — the order the strip is
  // actually read in. Stable by id so a tie does not make the strip flicker at
  // 2 Hz (two crewmates standing on the same deck are exactly tied).
  const rank: Record<CrewStation, number> = {
    downed: 0, out: 5, helm: 2, gun: 2, swim: 1, deck: 3, ashore: 3,
  };
  rows.sort((a, b) => rank[a.station] - rank[b.station]
    || a.distance - b.distance
    || (a.id < b.id ? -1 : 1));
  return rows;
}
