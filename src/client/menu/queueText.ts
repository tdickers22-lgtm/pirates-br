import type { QueueUpdatePayload } from '../../shared/types/index.js';

/**
 * b1-ask-02: the words the queue panel shows, pure so a logic suite can read
 * them without a DOM. The server sends position / etaSeconds / atCapacity /
 * lateJoinWindowSec (LobbyServer queue_update); the panel must never sit on a
 * raw "0s" while the host is full.
 */
export interface QueueLines {
  status: string;
  detail: string;
  /** 0..100, the progress bar width. */
  pct: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function about(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 90) return `about ${s}s`;
  return `about ${Math.round(s / 60)} min`;
}

export function queueLines(p: QueueUpdatePayload): QueueLines {
  const needed = Math.max(1, p.needed);
  const pct = Math.min(100, Math.round((p.inQueue / needed) * 100));
  if (p.atCapacity) {
    const place = typeof p.position === 'number' && p.position > 0 ? `you are #${p.position} in line` : 'you are in line';
    const eta = typeof p.etaSeconds === 'number' && p.etaSeconds > 0
      ? about(p.etaSeconds)
      : 'waiting for a free berth';
    const late = typeof p.lateJoinWindowSec === 'number' && p.lateJoinWindowSec > 0
      ? ` · a voyage in progress takes crews for ${Math.round(p.lateJoinWindowSec)}s more`
      : '';
    return {
      status: `Seas are full: ${place}`,
      detail: `${plural(p.inQueue, 'pirate')} waiting · ${eta}${late}`,
      pct,
    };
  }
  const status = p.inQueue >= p.needed
    ? 'Crew complete, setting sail…'
    : 'Searching the Reach for fellow pirates…';
  const secs = typeof p.etaSeconds === 'number' ? p.etaSeconds : p.secondsRemaining;
  const when = secs > 0 ? `sailing in ${Math.ceil(secs)}s` : 'sailing any moment';
  return { status, detail: `${p.inQueue} / ${p.needed} pirates · ${when}`, pct };
}

/** D10: the one line a late joiner gets on match_start. Null for a normal start. */
export function lateJoinNotice(lateJoin: { stormPhase: number; sinceHornSec: number } | null | undefined): string | null {
  if (!lateJoin) return null;
  return `Joined a voyage in progress (storm phase ${lateJoin.stormPhase})`;
}
