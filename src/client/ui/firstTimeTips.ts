/**
 * FIRST-TIME TIPS, NOT A WALL (b1.5g, mechanicshud-11).
 *
 * A first voyage used to open three cards of prose over the horn: keys for
 * sailing, fighting and winning, read (or not) before the player had seen a
 * wheel, a hole or a gun. On a phone the card ran off the glass and taught
 * keys the phone does not have.
 *
 * Now the game teaches a verb at the moment it is needed, in one line with the
 * glyph of the device in the player's hands, at the centre prompt:
 *
 *   first time at the wheel     steer / sails
 *   first hole in reach         plank it
 *   first time at a cannon      fire / shot type
 *   first storm shift           stay inside the ring
 *
 * Each tip shows ONCE PER ACTION PER SCHEME: a player who learned the wheel on
 * a keyboard and then picks up a pad sees the pad version once, because the
 * buttons changed. The win conditions are the one card left (OnboardingCards,
 * during the countdown).
 *
 * The decision (dueTip) and the copy (tipCopy) are pure so the suite can grade
 * them in node; FirstTimeTips owns the DOM box and the persisted record.
 */
import type { InputSchemeId } from '../../shared/bindings.js';
import { currentScheme, glyph, glyphEither, glyphSet, holdGlyph } from './InputGlyphs.js';

export type TipId = 'wheel' | 'hole' | 'cannon' | 'storm';
/** Most urgent first: a storm or a leak outranks a lesson about a station. */
export const TIP_PRIORITY: readonly TipId[] = ['storm', 'hole', 'cannon', 'wheel'];
export const TIPS_STORAGE_KEY = 'piratesBR.tipsSeen';
/** How long a tip stays up if the player does not dismiss it. */
export const TIP_HOLD_MS = 7000;
/** Quiet gap between two tips so they never read as a scrolling ticker. */
export const TIP_GAP_MS = 1500;

export type TipsSeen = Partial<Record<InputSchemeId, TipId[]>>;

export interface TipContext {
  /** Dead, downed, respawning, a modal or wheel open, the countdown: no tips. */
  busy: boolean;
  atHelm: boolean;
  atCannon: boolean;
  /** A repairable hole is in reach (the repair prompt is on offer). */
  holeInReach: boolean;
  /** The ring is moving, or the player is already outside it. */
  stormPressing: boolean;
}

export function hasSeen(seen: TipsSeen, scheme: InputSchemeId, id: TipId): boolean {
  return !!seen[scheme]?.includes(id);
}

export function markSeen(seen: TipsSeen, scheme: InputSchemeId, id: TipId): TipsSeen {
  if (hasSeen(seen, scheme, id)) return seen;
  return { ...seen, [scheme]: [...(seen[scheme] ?? []), id] };
}

function triggered(ctx: TipContext, id: TipId): boolean {
  switch (id) {
    case 'wheel': return ctx.atHelm;
    case 'hole': return ctx.holeInReach;
    case 'cannon': return ctx.atCannon;
    case 'storm': return ctx.stormPressing;
  }
}

/** The tip this frame asks for, or null (busy, nothing triggered, or all seen on this scheme). */
export function dueTip(ctx: TipContext, seen: TipsSeen, scheme: InputSchemeId): TipId | null {
  if (ctx.busy) return null;
  for (const id of TIP_PRIORITY) {
    if (triggered(ctx, id) && !hasSeen(seen, scheme, id)) return id;
  }
  return null;
}

/** One line plus a glyph, spelled for the scheme in the player's hands. */
export function tipCopy(id: TipId, scheme: InputSchemeId = currentScheme()): { icon: string; text: string } {
  switch (id) {
    case 'wheel':
      return { icon: '⛵', text: `${glyphEither('steerLeft', 'steerRight', scheme)} steers. ${glyph('sailsOut', scheme)} lets the sails out, ${glyph('sailsIn', scheme)} takes them in.` };
    case 'hole':
      return { icon: '🔨', text: `${holdGlyph('interact', scheme)} at a hole to plank it before she floods.` };
    case 'cannon':
      return { icon: '💥', text: `Look to aim, ${glyph('fire', scheme)} fires. ${glyphSet(['ammoRound', 'ammoFire', 'ammoChain'], scheme)} picks the shot.` };
    case 'storm':
      return { icon: '🌀', text: `The storm ring is closing. Stay inside the circle on your map ${glyph('map', scheme)}.` };
  }
}

function loadSeen(): TipsSeen {
  try {
    const raw = globalThis.localStorage?.getItem(TIPS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed as TipsSeen : {};
  } catch {
    return {};
  }
}

function saveSeen(seen: TipsSeen): void {
  try { globalThis.localStorage?.setItem(TIPS_STORAGE_KEY, JSON.stringify(seen)); } catch { /* private mode */ }
}

/**
 * The DOM face: #first-tip inside #hud-center-prompt, above the interact
 * prompt, with a dismiss control (#first-tip-dismiss) a finger can reach on
 * touch, where the rest of the centre stack lets touches through.
 */
export class FirstTimeTips {
  private seen: TipsSeen = loadSeen();
  private showing: TipId | null = null;
  private shownAt = 0;
  private hiddenAt = -Infinity;
  private box: HTMLElement | null = null;

  /** The tip on screen now (null when none). */
  get current(): TipId | null { return this.showing; }

  /** Forget every tip (tests, and a future "show tips again" setting). */
  reset(): void {
    this.seen = {};
    saveSeen(this.seen);
    this.hide();
  }

  /** Per frame: expire the tip on screen, or raise the one this context asks for. */
  update(ctx: TipContext, nowMs: number = performance.now()): void {
    if (this.showing) {
      if (ctx.busy || nowMs - this.shownAt >= TIP_HOLD_MS) this.hide(nowMs);
      return;
    }
    if (nowMs - this.hiddenAt < TIP_GAP_MS) return;
    const scheme = currentScheme();
    const id = dueTip(ctx, this.seen, scheme);
    if (id) this.show(id, nowMs);
  }

  /** Put a tip up and record it as seen on this scheme (a reload does not repeat it). */
  show(id: TipId, nowMs: number = performance.now()): void {
    const box = this.ensureBox();
    if (!box) return;
    const scheme = currentScheme();
    const copy = tipCopy(id, scheme);
    (box.querySelector('.ft-icon') as HTMLElement).textContent = copy.icon;
    (box.querySelector('.ft-text') as HTMLElement).textContent = copy.text;
    box.dataset.tip = id;
    box.classList.add('visible');
    this.showing = id;
    this.shownAt = nowMs;
    this.seen = markSeen(this.seen, scheme, id);
    saveSeen(this.seen);
  }

  hide(nowMs: number = performance.now()): void {
    this.box?.classList.remove('visible');
    if (this.showing) this.hiddenAt = nowMs;
    this.showing = null;
  }

  private ensureBox(): HTMLElement | null {
    if (this.box?.isConnected) return this.box;
    const host = document.getElementById('hud-center-prompt');
    if (!host) return null;
    const box = document.createElement('div');
    box.id = 'first-tip';
    box.setAttribute('role', 'status');
    box.innerHTML = '<span class="ft-icon" aria-hidden="true"></span><span class="ft-text"></span>'
      + '<button id="first-tip-dismiss" type="button" aria-label="Dismiss tip">✕</button>';
    box.querySelector('button')?.addEventListener('click', (event) => {
      event.stopPropagation();
      this.hide();
    });
    host.insertBefore(box, host.firstChild);
    this.box = box;
    return box;
  }
}
