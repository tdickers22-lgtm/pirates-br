// A CLIENT SERVER THAT LIVES EXACTLY AS LONG AS THE RUN THAT NEEDS IT.
//
// The cost-model rigs measure for half an hour at a stretch on a machine where
// somebody is also working, and both of the obvious arrangements failed:
// borrowing the developer's Vite means the survey dies when he stops it (it did,
// twice, forty minutes into two runs and after both had already thrown their
// results away), and starting one in the background from a shell means it
// outlives the run and later gets reaped by something that never knew it existed.
//
// So the runner owns it. `ensureDevClient` returns a handle if it had to start
// one — a CHILD of this node process, on the port the run was pointed at, never
// :3000 by default — and `stopDevClient` puts it down in the finally. A Vite the
// developer started himself is left alone: it is reachable, so nothing is
// spawned, and nothing is stopped.
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch { return false; }
}

/** @returns {Promise<{child: import('node:child_process').ChildProcess}|null>} */
export async function ensureDevClient(url, { timeoutMs = 60_000 } = {}) {
  if (await reachable(url)) return null;
  const port = new URL(url).port || '3101';
  const child = spawn('npx', ['vite', '--port', port, '--strictPort'], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, BROWSER: 'none' },
  });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await reachable(url)) return { child, port };
    if (child.exitCode !== null) throw new Error(`vite exited with code ${child.exitCode} while starting on :${port}`);
    await sleep(400);
  }
  stopDevClient({ child });
  throw new Error(`vite did not become ready at ${url} within ${timeoutMs}ms`);
}

export function stopDevClient(handle) {
  const child = handle?.child;
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill('SIGINT');
    else process.kill(-child.pid, 'SIGINT');
  } catch {
    try { child.kill('SIGINT'); } catch { /* already gone */ }
  }
}
