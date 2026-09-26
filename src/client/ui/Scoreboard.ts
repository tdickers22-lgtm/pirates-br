/**
 * IN-MATCH SCOREBOARD + CONNECTION PILL (b3.5f; vm:mechanicshud:4, crossdevice-01, D13).
 *
 * Hold Tab (keyboard), hold View (gamepad, a tap still opens the chart) or hold
 * the touch "Crews" button: one board listing every crew with its placement,
 * whether its ship is still afloat, its pirates, their kills, and the input
 * scheme each human plays on. The scheme icon is the aim-assist disclosure of
 * D13: controller and touch players get a weak aim assist, mouse players do
 * not, and public queues are cross-play, so everybody can see who has it.
 *
 * The connection pill answers "is it me or the game?": it shows only when the
 * heartbeat round trip is above 150 ms or snapshots stop arriving (loss), and
 * hides again with hysteresis so a ping hovering at 150 does not flicker.
 *
 * Pure model first (scripts/test-scoreboard.mjs drives it with no DOM), then a
 * small DOM view HudController owns.
 */
import type { Crew, Player, Ship } from '../../shared/types/index.js';
import type { InputSchemeId } from '../../shared/bindings.js';

// ── Input-scheme icons (D13 aim-assist transparency) ────────────────────────

export type SchemeIconId = InputSchemeId | 'bot' | 'unknown';

export interface SchemeIcon {
  /** Short badge text drawn in the row (no emoji: renders the same on every OS). */
  badge: string;
  /** Tooltip / aria label: what the scheme is and whether aim assist applies. */
  label: string;
  /** D13: weak aim assist is on for touch and gamepad only. */
  aimAssist: boolean;
}

export const SCHEME_ICONS: Readonly<Record<SchemeIconId, SchemeIcon>> = {
  mouse: { badge: 'KB', label: 'Mouse and keyboard, no aim assist', aimAssist: false },
  gamepad: { badge: 'PAD', label: 'Controller, weak aim assist', aimAssist: true },
  touch: { badge: 'TCH', label: 'Touch, weak aim assist', aimAssist: true },
  bot: { badge: 'BOT', label: 'Bot', aimAssist: false },
  unknown: { badge: '?', label: 'Input not reported yet', aimAssist: false },
};

/** Which icon a pirate wears. The local player's own live scheme wins over the
 *  echoed one, so switching to a pad flips your own row on the next repaint. */
export function schemeIconFor(p: Pick<Player, 'id' | 'isBot' | 'inputScheme'>, localPlayerId: string | null, localScheme: InputSchemeId | null): SchemeIconId {
  if (p.isBot) return 'bot';
  if (p.id === localPlayerId && localScheme) return localScheme;
  return p.inputScheme ?? 'unknown';
}

// ── Board model ──────────────────────────────────────────────────────────────

export interface ScoreboardMember {
  id: string;
  name: string;
  kills: number;
  /** Still in the fight (not eliminated). Downed and swimming count as in. */
  inPlay: boolean;
  scheme: SchemeIconId;
  isLocal: boolean;
}

export interface ScoreboardRow {
  crewId: string;
  name: string;
  color: number;
  /** Live crews: current standing among the living (1 = leading). Out crews:
   *  their final place (last crew out of 12 = 12th, the next out 11th ...). */
  placement: number;
  inPlay: boolean;
  afloat: boolean;
  kills: number;
  membersInPlay: number;
  members: ScoreboardMember[];
  isLocal: boolean;
}

export interface ScoreboardModel {
  rows: ScoreboardRow[];
  shipsAfloat: number;
  crewsInPlay: number;
  crewsTotal: number;
}

export interface ScoreboardInput {
  crews: readonly Crew[];
  players: readonly Player[];
  ships: readonly Ship[];
  localPlayerId: string | null;
  localScheme: InputSchemeId | null;
  /** Crew ids in the order they were knocked out (first out first). */
  outOrder: readonly string[];
}

export function shipAfloat(ship: Pick<Ship, 'sinking' | 'sinkProgress'> | undefined | null): boolean {
  return !!ship && !ship.sinking && ship.sinkProgress < 1;
}

/**
 * Ordering: crews still in play first, ranked by ship afloat, then pirates
 * still in, then kills, then name (a stable, readable standing). Crews that are
 * out follow, most recently eliminated first, each with its final placement.
 */
export function buildScoreboard(input: ScoreboardInput): ScoreboardModel {
  const playersById = new Map(input.players.map((p) => [p.id, p]));
  const shipsById = new Map(input.ships.map((s) => [s.id, s]));
  const total = input.crews.length;
  const rows: ScoreboardRow[] = input.crews.map((crew) => {
    const members: ScoreboardMember[] = [];
    for (const id of crew.memberIds) {
      const p = playersById.get(id);
      if (!p) continue;
      members.push({
        id: p.id, name: p.name, kills: p.kills,
        inPlay: p.state !== 'eliminated',
        scheme: schemeIconFor(p, input.localPlayerId, input.localScheme),
        isLocal: p.id === input.localPlayerId,
      });
    }
    members.sort((a, b) => b.kills - a.kills || a.name.localeCompare(b.name));
    const membersInPlay = members.filter((m) => m.inPlay).length;
    const afloat = crew.shipId !== null && shipAfloat(shipsById.get(crew.shipId));
    return {
      crewId: crew.id, name: crew.name, color: crew.color, placement: 0,
      inPlay: membersInPlay > 0 && !input.outOrder.includes(crew.id),
      afloat, kills: members.reduce((s, m) => s + m.kills, 0), membersInPlay, members,
      isLocal: members.some((m) => m.isLocal),
    };
  });
  const live = rows.filter((r) => r.inPlay).sort((a, b) =>
    Number(b.afloat) - Number(a.afloat) || b.membersInPlay - a.membersInPlay || b.kills - a.kills || a.name.localeCompare(b.name));
  live.forEach((r, i) => { r.placement = i + 1; });
  // Final place: the first crew out finishes last. A crew already out before
  // the tracker saw it (joined mid-spectate) went out earlier than every
  // recorded one, so it takes the worst places.
  const out = rows.filter((r) => !r.inPlay);
  const unrecorded = out.filter((r) => !input.outOrder.includes(r.crewId)).sort((a, b) => a.kills - b.kills || b.name.localeCompare(a.name));
  unrecorded.forEach((r, i) => { r.placement = total - i; });
  for (const r of out) {
    const i = input.outOrder.indexOf(r.crewId);
    if (i >= 0) r.placement = total - unrecorded.length - i;
  }
  out.sort((a, b) => a.placement - b.placement);
  return {
    rows: [...live, ...out],
    shipsAfloat: input.ships.filter((s) => shipAfloat(s)).length,
    crewsInPlay: live.length,
    crewsTotal: total,
  };
}

/** Records the order crews drop out, so placements survive later snapshots. */
export class CrewOutTracker {
  readonly order: string[] = [];
  observe(crews: readonly Crew[], players: readonly Player[]): readonly string[] {
    const state = new Map(players.map((p) => [p.id, p.state]));
    for (const c of crews) {
      if (this.order.includes(c.id)) continue;
      const known = c.memberIds.filter((id) => state.has(id));
      if (known.length > 0 && known.every((id) => state.get(id) === 'eliminated')) this.order.push(c.id);
    }
    return this.order;
  }
  reset() { this.order.length = 0; }
}

/** Ordinal for the placement column: 1st, 2nd, 3rd, 4th, 11th, 12th, 21st. */
export function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

// ── Hold state (Tab / View hold / touch) ────────────────────────────────────

export type ScoreboardSource = 'key' | 'pad' | 'touch';

/** Long press for the pad's View button, matching GamepadSource.HOLD_MS. */
export const PAD_VIEW_HOLD_MS = 400;
/** Standard Gamepad mapping index of View / Back / Select. */
export const PAD_VIEW_BUTTON = 8;

export class ScoreboardHold {
  private readonly held = new Set<ScoreboardSource>();
  private padDownAt: number | null = null;
  /** Tab and the touch button show at once; the pad shows after a long press
   *  (a short View tap stays the chart toggle). */
  set(source: Exclude<ScoreboardSource, 'pad'>, down: boolean) {
    if (down) this.held.add(source); else this.held.delete(source);
  }
  /** Feed the View button every frame. Returns true on the frame the hold fires. */
  pad(down: boolean, nowMs: number): boolean {
    if (!down) { this.padDownAt = null; this.held.delete('pad'); return false; }
    if (this.padDownAt === null) this.padDownAt = nowMs;
    if (!this.held.has('pad') && nowMs - this.padDownAt >= PAD_VIEW_HOLD_MS) { this.held.add('pad'); return true; }
    return false;
  }
  get visible(): boolean { return this.held.size > 0; }
  clear() { this.held.clear(); this.padDownAt = null; }
}

// ── Connection pill ──────────────────────────────────────────────────────────

/** Show above this heartbeat round trip. */
export const RTT_WARN_MS = 150;
/** Hide again only below this (hysteresis: a ping hovering at 150 must not flicker). */
export const RTT_CLEAR_MS = 130;
/** Above this the pill turns red. */
export const RTT_BAD_MS = 300;
/** No snapshot for this long while playing = packets are being lost. The server
 *  sends ~31 snapshots a second, so 500 ms is ~15 in a row. */
export const LOSS_GAP_MS = 500;
/** A loss keeps the pill up this long after snapshots resume (no flash). */
export const LOSS_HOLD_MS = 2500;

export type PillLevel = 'hidden' | 'warn' | 'bad';
export interface PillView { level: PillLevel; text: string }

export class ConnectionPill {
  private shownForRtt = false;
  private lossUntil = 0;
  /** rttMs: last heartbeat round trip (null before the first). gapMs: time since
   *  the last snapshot arrived (null when not in a live match). */
  update(rttMs: number | null, gapMs: number | null, nowMs: number): PillView {
    const losing = gapMs !== null && gapMs >= LOSS_GAP_MS;
    if (losing) this.lossUntil = nowMs + LOSS_HOLD_MS;
    if (rttMs === null) this.shownForRtt = false;
    else if (rttMs > RTT_WARN_MS) this.shownForRtt = true;
    else if (rttMs < RTT_CLEAR_MS) this.shownForRtt = false;
    const ping = rttMs === null ? '' : `${Math.round(rttMs)} ms`;
    if (losing || nowMs < this.lossUntil) {
      return { level: 'bad', text: ping ? `Connection unstable, ${ping}` : 'Connection unstable' };
    }
    if (!this.shownForRtt || rttMs === null) return { level: 'hidden', text: '' };
    return { level: rttMs > RTT_BAD_MS ? 'bad' : 'warn', text: `High ping ${ping}` };
  }
  reset() { this.shownForRtt = false; this.lossUntil = 0; }
}

// ── DOM view ─────────────────────────────────────────────────────────────────

const CSS = `
#scoreboard{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:60;min-width:min(560px,92vw);max-width:94vw;max-height:84vh;overflow:auto;
 background:rgba(10,16,24,.9);border:1px solid rgba(201,168,76,.55);border-radius:10px;padding:12px 14px;color:#efe6cf;font:calc(13px * var(--hud-text-scale,1)) system-ui,sans-serif;pointer-events:none}
#scoreboard[hidden],#net-pill[hidden]{display:none}
#scoreboard h2{margin:0 0 8px;font-size:1.1em;letter-spacing:.06em;color:#c9a84c;display:flex;justify-content:space-between;gap:12px}
#scoreboard table{border-collapse:collapse;width:100%}
#scoreboard th{font-weight:600;text-align:left;opacity:.7;font-size:.85em;padding:2px 6px}
#scoreboard td{padding:3px 6px;vertical-align:top;border-top:1px solid rgba(255,255,255,.08)}
#scoreboard tr.out{opacity:.5}#scoreboard tr.local td{background:rgba(201,168,76,.14)}
#scoreboard .dye{display:inline-block;width:.8em;height:.8em;border-radius:2px;margin-right:6px;vertical-align:-1px}
#scoreboard .mem{display:flex;gap:6px;align-items:center;white-space:nowrap}#scoreboard .mem.down{text-decoration:line-through;opacity:.6}
#scoreboard .sch{font-size:.72em;border:1px solid currentColor;border-radius:3px;padding:0 3px;opacity:.85}#scoreboard .sch.aa{color:#8fd0ff}
#net-pill{position:fixed;top:calc(8px + env(safe-area-inset-top));right:calc(12px + env(safe-area-inset-right));z-index:61;padding:3px 10px;border-radius:999px;
 font:600 calc(12px * var(--hud-text-scale,1)) system-ui,sans-serif;pointer-events:none;background:rgba(214,160,40,.92);color:#15110a}
#net-pill.bad{background:rgba(200,60,50,.94);color:#fff}
`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function renderScoreboardHtml(m: ScoreboardModel): string {
  const head = `<h2><span>Crews ${m.crewsInPlay}/${m.crewsTotal}</span><span>Ships afloat ${m.shipsAfloat}</span></h2>`;
  const rows = m.rows.map((r) => {
    const mem = r.members.map((p) => {
      const icon = SCHEME_ICONS[p.scheme];
      return `<div class="mem${p.inPlay ? '' : ' down'}"><span class="sch${icon.aimAssist ? ' aa' : ''}" title="${esc(icon.label)}" aria-label="${esc(icon.label)}">${icon.badge}</span>${esc(p.name)}${p.isLocal ? ' (you)' : ''} <span>${p.kills}</span></div>`;
    }).join('');
    const dye = `#${r.color.toString(16).padStart(6, '0')}`;
    return `<tr class="${r.inPlay ? '' : 'out'}${r.isLocal ? ' local' : ''}"><td>${ordinal(r.placement)}</td><td><span class="dye" style="background:${dye}"></span>${esc(r.name)}</td>`
      + `<td>${r.inPlay ? (r.afloat ? 'Afloat' : 'Sunk') : 'Out'}</td><td>${r.kills}</td><td>${mem}</td></tr>`;
  }).join('');
  return `${head}<table><thead><tr><th>Place</th><th>Crew</th><th>Ship</th><th>Kills</th><th>Pirates</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export class ScoreboardView {
  private board: HTMLElement | null = null;
  private pill: HTMLElement | null = null;
  private lastHtml = '';
  private lastPill = '';
  private ensure() {
    if (this.board || typeof document === 'undefined') return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.board = document.createElement('div');
    this.board.id = 'scoreboard';
    this.board.setAttribute('role', 'dialog');
    this.board.setAttribute('aria-label', 'Scoreboard');
    this.board.hidden = true;
    this.pill = document.createElement('div');
    this.pill.id = 'net-pill';
    this.pill.setAttribute('role', 'status');
    this.pill.hidden = true;
    document.body.append(this.board, this.pill);
  }
  showBoard(model: ScoreboardModel | null) {
    this.ensure();
    if (!this.board) return;
    this.board.hidden = model === null;
    if (!model) return;
    const html = renderScoreboardHtml(model);
    if (html !== this.lastHtml) { this.board.innerHTML = html; this.lastHtml = html; }
  }
  showPill(v: PillView) {
    this.ensure();
    if (!this.pill) return;
    const key = `${v.level}|${v.text}`;
    if (key === this.lastPill) return;
    this.lastPill = key;
    this.pill.hidden = v.level === 'hidden';
    this.pill.className = v.level === 'bad' ? 'bad' : '';
    this.pill.textContent = v.text;
  }
}
