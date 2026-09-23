/**
 * CONNECT POLICY (b1.1e; correctness-04, online-10). Pure: the retry schedule and
 * the words a player sees while the first connect is in flight. No DOM here
 * except `waitForRetry`, which only runs when called.
 *
 * The first connect used to be one 6 s race that ended on
 * "Cannot reach game server at wss://… Make sure 'npm run dev' is running". A Fly
 * cold start, a slow 4G handshake or a rolling deploy all take longer than that.
 * Now it retries for the server's whole 60 s seat budget with player copy, then
 * offers a Retry button. The dev hint appears only on a localhost page of a dev
 * build.
 */

/** Same number as the server's seat grace (RECONNECT_GRACE_MS). */
export const CONNECT_BUDGET_MS = 60_000;
/** Backoff steps; the last one repeats. */
export const CONNECT_STEPS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;
/** Jitter so a server restart does not bring every client back in the same ms. */
export const CONNECT_JITTER = 0.2;

/** Nominal waits between attempts (no jitter), trimmed so they sum to the budget. */
export function connectSchedule(budgetMs = CONNECT_BUDGET_MS): number[] {
  const out: number[] = [];
  let total = 0;
  for (let i = 0; total < budgetMs; i += 1) {
    const step = CONNECT_STEPS_MS[Math.min(i, CONNECT_STEPS_MS.length - 1)];
    const wait = Math.min(step, budgetMs - total);
    out.push(wait);
    total += wait;
  }
  return out;
}

/**
 * The wait before the next attempt, or null when the budget is spent.
 * `attempt` is 1-based (the attempt that just failed), `elapsedMs` counts from
 * the start of this supervision. The wait is jittered and clamped to the time
 * left, so the supervisor gives up at the budget, not a step past it.
 */
export function nextWaitMs(attempt: number, elapsedMs: number, rand: () => number = Math.random, budgetMs = CONNECT_BUDGET_MS): number | null {
  const left = budgetMs - elapsedMs;
  if (!(left > 0)) return null;
  const step = CONNECT_STEPS_MS[Math.min(Math.max(1, attempt), CONNECT_STEPS_MS.length) - 1];
  const jittered = Math.round(step * (1 - CONNECT_JITTER + rand() * 2 * CONNECT_JITTER));
  // Do not start an attempt in the last 250 ms: it cannot finish inside the budget.
  if (left < 250) return null;
  return Math.max(0, Math.min(jittered, left - 250));
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(String(hostname).toLowerCase());
}

/** True in a Vite dev build; false in a production bundle (and under node). */
export const DEV_BUILD: boolean = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;

export type ConnectPhase = 'connecting' | 'retrying' | 'offline' | 'gave_up';
export interface ConnectProgress { phase: ConnectPhase; attempt: number; nextInMs: number }
export interface ConnectCopy { text: string; retry: boolean }

/**
 * What the loading screen says. Never a URL, never a port, never a shell
 * command on a public host.
 */
export function connectCopy(phase: ConnectPhase, ctx: { host: string; attempt?: number; port?: number | string; devBuild?: boolean }): ConnectCopy {
  const attempt = Math.max(0, Math.floor(ctx.attempt ?? 0));
  switch (phase) {
    case 'connecting':
      return { text: 'Finding the Reach...', retry: false };
    case 'retrying':
      return { text: `Waking the harbour... (attempt ${attempt + 1})`, retry: false };
    case 'offline':
      return { text: 'You are offline. We will set sail as soon as your connection is back.', retry: true };
    case 'gave_up': {
      const devBuild = ctx.devBuild ?? DEV_BUILD;
      if (devBuild && isLocalHost(ctx.host)) {
        return { text: `No game server on :${ctx.port ?? '?'}. Start it with npm run dev, then press Retry.`, retry: true };
      }
      return { text: 'The servers are not answering. Check your connection and press Retry.', retry: true };
    }
  }
}

/**
 * Show a Retry button under `anchor` and resolve when it is pressed (or when the
 * browser reports it is back online). The button removes itself.
 */
export function waitForRetry(anchor: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const button = document.createElement('button');
    button.id = 'connect-retry';
    button.type = 'button';
    button.textContent = 'Retry';
    button.style.cssText = 'display:block;margin:14px auto 0;padding:10px 28px;font:inherit;font-size:16px;color:#f3e7c8;background:rgba(40,30,18,0.85);border:1px solid #c9a860;border-radius:6px;cursor:pointer;min-height:44px;';
    const done = (): void => {
      button.remove();
      window.removeEventListener('online', done);
      resolve();
    };
    button.addEventListener('click', done, { once: true });
    window.addEventListener('online', done);
    anchor.after(button);
  });
}
