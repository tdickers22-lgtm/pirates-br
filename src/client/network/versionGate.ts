/**
 * VERSION GATE (b1.1e; online-05). A tab left open across a deploy reconnects to
 * the new server and keeps running the OLD bundle: wire changes desync silently.
 * The server's welcome carries its buildId; when it differs from the bundle's:
 *   - on the menu / in the queue: reload now, once per server build (a
 *     sessionStorage guard stops a reload loop when a CDN still serves the old
 *     bundle);
 *   - in a match: finish the match, reload on the way back to the menu.
 * Either side reporting no build id (or 'dev') means "unknown": never reload.
 */

/** The bundle's own id: VITE_BUILD_ID at build time, else 'dev'. */
export const CLIENT_BUILD_ID: string =
  String((import.meta as unknown as { env?: { VITE_BUILD_ID?: string } }).env?.VITE_BUILD_ID ?? '').trim() || 'dev';

export type VersionPhase = 'menu' | 'in_match';
export type VersionDecision = 'same' | 'unknown' | 'reload' | 'defer' | 'loop_guard';

const RELOADED_KEY = 'piratesBR.reloadedForBuild';

function known(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.length > 0 && id !== 'dev';
}

export function decideVersion(clientBuild: string | null | undefined, serverBuild: string | null | undefined, phase: VersionPhase, reloadedFor: string | null): VersionDecision {
  if (!known(clientBuild) || !known(serverBuild)) return 'unknown';
  if (clientBuild === serverBuild) return 'same';
  if (reloadedFor === serverBuild) return 'loop_guard';
  return phase === 'in_match' ? 'defer' : 'reload';
}

interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void }

export class VersionGate {
  private readonly clientBuild: string;
  private readonly storage: StorageLike | null;
  private readonly reload: () => void;
  /** Server build a reload is owed for once the match is over. */
  private deferredFor: string | null = null;
  last: VersionDecision = 'unknown';

  constructor(opts: { clientBuild?: string; storage?: StorageLike | null; reload?: () => void } = {}) {
    this.clientBuild = opts.clientBuild ?? CLIENT_BUILD_ID;
    this.storage = opts.storage !== undefined ? opts.storage : (() => { try { return globalThis.sessionStorage ?? null; } catch { return null; } })();
    this.reload = opts.reload ?? (() => { try { globalThis.location?.reload(); } catch { /* no page */ } });
  }

  private reloadedFor(): string | null {
    try { return this.storage?.getItem(RELOADED_KEY) ?? null; } catch { return null; }
  }

  private doReload(serverBuild: string): void {
    try { this.storage?.setItem(RELOADED_KEY, serverBuild); } catch { /* private mode: still reload once */ }
    this.deferredFor = null;
    this.reload();
  }

  /** Call on every welcome. Returns the decision taken. */
  onWelcome(serverBuild: string | null | undefined, phase: VersionPhase): VersionDecision {
    const d = decideVersion(this.clientBuild, serverBuild, phase, this.reloadedFor());
    this.last = d;
    if (d === 'reload') this.doReload(serverBuild as string);
    else if (d === 'defer') this.deferredFor = serverBuild as string;
    return d;
  }

  /** Call when the player is back on the menu (match over / left). */
  onMenu(): boolean {
    if (!this.deferredFor) return false;
    this.doReload(this.deferredFor);
    return true;
  }
}
