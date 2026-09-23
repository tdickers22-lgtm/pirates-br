/**
 * THE HUD MODEL (b1.5f; mechanicshud-06/07/14, liveplay-06/13).
 *
 * Two pure functions own every "what is on screen, and what does it say"
 * decision that used to be scattered across a dozen independent writers:
 *
 *   hudVisibility(context) -> the set of HUD element ids that are shown
 *   hudMessagePlan(state)  -> { tier, objective, alarm, banner }
 *
 * The writers in HudController only paint what these return. Nothing here
 * touches the DOM, so scripts/test-hud-visibility.mjs grades the whole spec
 * table (PLAN section 3, mechanics+HUD C) without a browser.
 *
 * Spec rules encoded here:
 *  - Always on (max 12 desktop, max 8 phone): compass, storm line, objective,
 *    gold chip, ships afloat, crew strip (parties), minimap, feed, health,
 *    weapon card, crosshair, prompt slot.
 *  - Ammo lives ONCE, on the weapon card. The big ammo readout only appears at
 *    a cannon, where it is the shot stock and the weapon card is not in hand.
 *  - Stores only in the supply wheel or at a station that spends them (cannon,
 *    a repair prompt, the helm is NOT one).
 *  - ONE alarm slot. One message plan with a strict priority:
 *    dead > sinking > flooding > outside ring > carrying loot > default.
 *    The island banner is suppressed while an alarm at flooding or worse is up.
 *  - Crosshair: a dot at rest; the blunderbuss spread ring only while aiming.
 *  - Death: the card collapses to a bottom bar once spectating, so the match
 *    behind it is visible.
 */

export type HudElementId =
  | 'compass'
  | 'stormLine'
  | 'objective'
  | 'gold'
  | 'shipsAfloat'
  | 'crewStrip'
  | 'minimap'
  | 'feed'
  | 'health'
  | 'weaponCard'
  | 'crosshair'
  | 'prompt'
  | 'partyChip'
  | 'shipCard'
  | 'alarm'
  | 'stores'
  | 'ammoDisplay'
  | 'islandBanner'
  | 'supplyWheel'
  | 'map'
  | 'downedCard'
  | 'respawnCard'
  | 'spectateBanner'
  | 'deathBar'
  | 'serverNotice';

/** The always-on set: what a living pirate at rest sees, and nothing else. */
export const ALWAYS_ON: readonly HudElementId[] = [
  'compass', 'stormLine', 'objective', 'gold', 'shipsAfloat', 'crewStrip',
  'minimap', 'feed', 'health', 'weaponCard', 'crosshair', 'prompt',
];

/** Phone landscape keeps the eight a thumb-held screen can carry. */
export const PHONE_ALWAYS_ON: readonly HudElementId[] = [
  'compass', 'objective', 'gold', 'shipsAfloat', 'minimap', 'health', 'weaponCard', 'crosshair',
];

export type HudPlayerState = 'alive' | 'swimming' | 'downed' | 'respawning' | 'eliminated';

export interface HudContext {
  playerState: HudPlayerState;
  device: 'desktop' | 'tablet' | 'phone';
  /** In a party (duos/squads or a private party): crew strip + party chip. */
  inParty: boolean;
  /** Standing on the own hull, or within 30 m of it. */
  nearOwnShip: boolean;
  atCannon: boolean;
  atHelm: boolean;
  /** A repair/bail prompt is live (a hole in reach, bucket at the water). */
  atRepairPrompt: boolean;
  wheelHeld: boolean;
  mapOpen: boolean;
  aiming: boolean;
  /** What is in the hands. 'tool' = bucket/shovel/spyglass/compass/hammer. */
  holding: 'firearm' | 'blunderbuss' | 'melee' | 'tool' | 'none';
  scopeShowing: boolean;
  /** The message plan put something in the alarm slot. */
  alarmUp: boolean;
  /** The message plan let an island banner through this frame. */
  bannerUp: boolean;
  serverNotice: boolean;
}

export type CrosshairMode = 'none' | 'dot' | 'ring' | 'cannon';

/** Dot at rest; the blunderbuss spread ring only while aiming (mechanicshud-14). */
export function crosshairMode(ctx: Pick<HudContext, 'playerState' | 'atCannon' | 'aiming' | 'holding' | 'scopeShowing' | 'atHelm'>): CrosshairMode {
  if (ctx.playerState === 'eliminated' || ctx.playerState === 'respawning' || ctx.playerState === 'downed') return 'none';
  if (ctx.scopeShowing) return 'none';
  if (ctx.atCannon) return 'cannon';
  if (ctx.atHelm) return 'none';
  if (ctx.holding === 'tool') return 'none';
  if (ctx.holding === 'blunderbuss' && ctx.aiming) return 'ring';
  return 'dot';
}

export function hudVisibility(ctx: HudContext): Set<HudElementId> {
  const out = new Set<HudElementId>();
  const phone = ctx.device === 'phone';
  if (ctx.serverNotice) out.add('serverNotice');

  if (ctx.playerState === 'eliminated') {
    // The match behind is the content now: the spectate caption, the bottom
    // death bar (Return to port / Next target), the minimap and the feed.
    out.add('spectateBanner');
    out.add('deathBar');
    out.add('minimap');
    out.add('shipsAfloat');
    if (!phone) out.add('feed');
    return out;
  }

  for (const id of phone ? PHONE_ALWAYS_ON : ALWAYS_ON) out.add(id);
  if (!ctx.inParty) out.delete('crewStrip');
  // The party code is a label in the minimap head, not a box of its own, and
  // a phone shares the code through the share sheet instead (b1.5b).
  if (ctx.inParty && !phone) out.add('partyChip');

  if (ctx.playerState === 'respawning') {
    out.add('respawnCard');
    out.delete('crosshair');
    out.delete('weaponCard');
  } else if (ctx.playerState === 'downed') {
    out.add('downedCard');
    out.delete('crosshair');
  }
  if (crosshairMode(ctx) === 'none') out.delete('crosshair');

  if (ctx.alarmUp) out.add('alarm');
  if (ctx.bannerUp && !ctx.alarmUp) out.add('islandBanner');

  const alive = ctx.playerState === 'alive' || ctx.playerState === 'swimming';
  if (alive && ctx.nearOwnShip && ctx.playerState !== 'swimming') out.add('shipCard');
  // Stores are information only where they are spent (the wheel, a cannon, a
  // repair prompt). The permanent five-chip bar is gone.
  if (alive && (ctx.wheelHeld || ctx.atCannon || ctx.atRepairPrompt)) out.add('stores');
  if (ctx.wheelHeld) out.add('supplyWheel');
  // Ammo ONCE: on the weapon card. The big readout is the cannon's shot stock.
  if (ctx.atCannon) {
    out.add('ammoDisplay');
    out.delete('weaponCard');
  }
  if (ctx.atHelm) out.delete('weaponCard');
  if (ctx.mapOpen) {
    out.add('map');
    out.delete('crosshair');
  }
  return out;
}

/** How many of the visible elements count toward the always-on budget. */
export function alwaysOnCount(set: Set<HudElementId>): number {
  let n = 0;
  for (const id of set) if (ALWAYS_ON.includes(id)) n++;
  return n;
}

// ── The message plan ────────────────────────────────────────────────────────

export type HudTier = 'dead' | 'sinking' | 'flooding' | 'outside' | 'loot' | 'default';

/** Severity of each tier, highest first. Banners die at flooding or worse. */
export const TIER_SEVERITY: Record<HudTier, number> = {
  dead: 5, sinking: 4, flooding: 3, outside: 2, loot: 1, default: 0,
};

export interface HudMessageState {
  playerState: HudPlayerState;
  /** 'sunk' when the own hull is gone (no respawn), else the respawn count. */
  deadReason?: 'eliminated' | 'respawning';
  respawnSeconds?: number;
  shipSinking: boolean;
  /** Open holes on the own hull. */
  shipLeaks: number;
  /** 0..1 bilge fill of the own hull. */
  shipWater: number;
  shipOnFire: boolean;
  outsideRing: boolean;
  /** Metres to the ring wall while outside, else null. */
  metresOutside: number | null;
  eyeCollapse: boolean;
  /** Chests in the hold or in the arms, and where they sell. */
  lootCarried: number;
  lootSellAt: string | null;
  /** The objective the old chain would have chosen with no emergency up. */
  defaultObjective: string;
  /** A sail alarm (reef/blown out) when standing on the own deck. */
  sailAlarm: string | null;
  /** An island banner that wants to show this frame. */
  bannerRequested: string | null;
  /** Wheel glyph for the bucket hint (glyph('supplyWheel') etc.). */
  wheelGlyph?: string;
}

export interface HudMessagePlan {
  tier: HudTier;
  objective: string;
  /** The ONE alarm slot; null = nothing to alarm about. */
  alarm: string | null;
  severity: number;
  banner: string | null;
}

/** A hull taking water is FLOODING from the first open hole or a visible bilge. */
export function isFlooding(s: Pick<HudMessageState, 'shipLeaks' | 'shipWater'>): boolean {
  return s.shipLeaks > 0 || s.shipWater >= 0.08;
}

export function hudMessagePlan(s: HudMessageState): HudMessagePlan {
  const wheel = s.wheelGlyph ?? '[1]';
  let tier: HudTier;
  let objective: string;
  let alarm: string | null = null;

  if (s.playerState === 'eliminated') {
    tier = 'dead';
    objective = 'Out of the voyage: watch the crews still afloat';
  } else if (s.playerState === 'respawning') {
    tier = 'dead';
    const t = Math.max(0, Math.ceil(s.respawnSeconds ?? 0));
    objective = t > 0 ? `Back aboard in ${t} s` : 'Back aboard any moment';
  } else if (s.shipSinking) {
    tier = 'sinking';
    alarm = 'SHIP IS SINKING';
    objective = s.shipLeaks > 0
      ? `Objective: patch the ${s.shipLeaks} leak${s.shipLeaks === 1 ? '' : 's'} and bail, or abandon ship`
      : 'Objective: bail her out, or abandon ship';
  } else if (isFlooding(s)) {
    tier = 'flooding';
    const pct = Math.round(Math.max(0, Math.min(1, s.shipWater)) * 100);
    alarm = s.shipLeaks > 0
      ? `TAKING WATER · ${s.shipLeaks} LEAK${s.shipLeaks === 1 ? '' : 'S'} · ${pct}%`
      : `WATER IN THE HOLD · ${pct}%`;
    objective = s.shipLeaks > 0
      ? `Objective: patch the leaks with planks, then bail. Hold ${wheel} wheel, pick Bucket (3)`
      : `Objective: bail the hold. Hold ${wheel} wheel, pick Bucket (3)`;
  } else if (s.outsideRing || s.eyeCollapse) {
    tier = 'outside';
    alarm = s.eyeCollapse
      ? 'THE EYE CLOSES'
      : `OUTSIDE THE RING${s.metresOutside !== null ? ` · ${Math.round(s.metresOutside)} m` : ''}`;
    objective = s.eyeCollapse
      ? 'Objective: hold on and outlast them'
      : 'Objective: steer for the ring chevron on the compass';
  } else if (s.lootCarried > 0) {
    tier = 'loot';
    objective = s.lootSellAt
      ? `Objective: deliver ${s.lootCarried} chest${s.lootCarried === 1 ? '' : 's'} to ${s.lootSellAt}`
      : `Objective: keep ${s.lootCarried} chest${s.lootCarried === 1 ? '' : 's'} safe and find a buyer`;
  } else {
    tier = 'default';
    objective = s.defaultObjective;
  }
  // On fire and the rig share the one slot, below the hull emergencies.
  if (alarm === null && tier !== 'dead') {
    if (s.shipOnFire) alarm = 'FIRE ABOARD - DOUSE IT';
    else if (s.sailAlarm) alarm = s.sailAlarm;
  }
  const severity = TIER_SEVERITY[tier];
  const banner = s.bannerRequested && severity < TIER_SEVERITY.flooding && tier !== 'dead' ? s.bannerRequested : null;
  return { tier, objective, alarm, severity, banner };
}

/** The ship card's motion word: "Adrift" replaces "Under way · dead in the water". */
export function shipMotionWord(anchored: boolean, aground: boolean, knots: number): string {
  if (anchored) return 'Anchored';
  if (aground) return `Aground · ${knots.toFixed(1)} kn`;
  if (knots < 0.15) return 'Adrift';
  return `Under way · ${knots.toFixed(1)} kn`;
}
