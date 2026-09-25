import { execSync } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';

/**
 * WHICH GAME SERVER THIS CLIENT TALKS TO.
 *
 * One variable, two consumers: the /ws dev proxy below, and the port the client
 * bundle dials directly when it is served off a dev port (Game.ts
 * GAME_SERVER_PORT, via `define`). They used to be two hard-coded 8090s in two
 * files, which meant a graded suite run — PIRATES_BR_URL pointed at a Vite the
 * runner owns — still opened its socket against the developer's live :8090.
 * Default is unchanged, so a plain `npm run dev` and `npm run build` behave
 * exactly as before.
 */
const GAME_SERVER_PORT = process.env.PIRATES_BR_SERVER_PORT ?? '8090';

/**
 * WHICH BUILD THIS BUNDLE IS (b1.2e, online-05).
 *
 * One id per `vite build`, baked into the bundle as `import.meta.env.VITE_BUILD_ID`
 * (and `__BUILD_ID__`) for client/network/versionGate.ts, and into index.html as
 * `<meta name="pirates-build-id">` so scripts/postbuild-compress.mjs can copy the
 * SAME value to dist/build-id.txt for the server's welcome. Source, in order:
 * BUILD_ID env (CI / Docker build-arg), the git sha (+ "-dirty" for a tree with
 * uncommitted tracked changes), else a timestamp id (the Docker build context
 * has no .git). The dev server is always 'dev' ("unknown": the gate never
 * reloads a tab against a hand-run server).
 */
function resolveBuildId(): string {
  const fromEnv = String(process.env.BUILD_ID ?? '').trim();
  if (fromEnv) return fromEnv.replace(/[^\w.-]/g, '').slice(0, 40) || 'dev';
  try {
    const git = (cmd: string) => execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const sha = git('git rev-parse --short=12 HEAD');
    if (/^[0-9a-f]{7,40}$/.test(sha)) {
      return git('git status --porcelain --untracked-files=no') ? `${sha}-dirty` : sha;
    }
  } catch { /* no git (Docker context) */ }
  return `t${Date.now().toString(36)}`;
}

function buildIdMeta(buildId: string): Plugin {
  return {
      name: 'pirates-build-id',
      transformIndexHtml() {
        return [{ tag: 'meta', attrs: { name: 'pirates-build-id', content: buildId }, injectTo: 'head' }];
      },
    };
  }

/**
 * MODULEPRELOAD FOR THE GAME CHUNK (b3.1f, performance-10).
 *
 * src/client/main.ts is a shell that dynamic-imports core/Game.ts on its first
 * line. Vite only preloads a dynamic import's deps when the import() RUNS, one
 * round trip after the entry arrives; on a 70 ms-RTT 4G phone that is a
 * visible delay before Play. This puts <link rel="modulepreload"> for the game
 * chunk and every chunk it statically imports into index.html, so the browser
 * starts all of them at HTML parse, the same moment the old single entry did.
 * scripts/test-bundle-budget.mjs fails a build whose index.html lacks it.
 */
function preloadGameChunk(): Plugin {
  return {
    name: 'pirates-preload-game',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const bundle = ctx.bundle;
        const entry = ctx.chunk;
        if (!bundle || !entry) return [];
        const chunkOf = (file: string) => {
          const c = bundle[file];
          return c && c.type === 'chunk' ? c : null;
        };
        const isGame = (file: string) => Object.keys(chunkOf(file)?.modules ?? {})
          .some((id) => /[\\/]src[\\/]client[\\/]core[\\/]Game\.ts$/.test(id));
        const staticOfEntry = new Set<string>();
        const walkStatic = (file: string, into: Set<string>) => {
          if (into.has(file)) return;
          into.add(file);
          for (const dep of chunkOf(file)?.imports ?? []) walkStatic(dep, into);
        };
        walkStatic(entry.fileName, staticOfEntry);
        const wanted = new Set<string>();
        for (const file of staticOfEntry) {
          for (const dyn of chunkOf(file)?.dynamicImports ?? []) if (isGame(dyn)) walkStatic(dyn, wanted);
        }
        return [...wanted].filter((f) => !staticOfEntry.has(f)).map((f) => ({
          tag: 'link',
          attrs: { rel: 'modulepreload', crossorigin: true, href: `/${f}` },
          injectTo: 'head' as const,
        }));
      },
    },
  };
}

/**
 * CHUNKS (b3.1f). Only ACYCLIC groups: three; three's addons (loaders,
 * decoders: they import three and nothing of ours); src/shared (pure, imports
 * only itself); the audio engine (imports shared and itself). A group that
 * imports back into the game chunk (world/, rendering/, ui/) would make a
 * circular chunk graph, whose init order rollup cannot promise.
 */
function chunkFor(id: string): string | undefined {
  const p = id.split('\\').join('/');
  if (p.includes('/node_modules/three/build/')) return 'three';
  if (p.includes('/node_modules/three/examples/')) return 'three-addons';
  if (p.includes('/src/shared/')) return 'shared';
  if (p.includes('/src/client/audio/')) return 'audio';
  return undefined;
}

  export default defineConfig(({ command }) => {
    const BUILD_ID = command === 'build' ? resolveBuildId() : 'dev';
    return {
    root: '.',
    publicDir: 'public',
    plugins: [buildIdMeta(BUILD_ID), preloadGameChunk()],
    define: {
      __GAME_SERVER_PORT__: JSON.stringify(GAME_SERVER_PORT),
      __BUILD_ID__: JSON.stringify(BUILD_ID),
      'import.meta.env.VITE_BUILD_ID': JSON.stringify(BUILD_ID),
    },
    build: {
      outDir: 'dist/client',
      rollupOptions: {
        input: 'index.html',
        output: {
          manualChunks: chunkFor
        }
      }
    },
    server: {
      // Use IPv4 explicitly: on some systems "localhost" → ::1 while Node listens on IPv4,
      // which breaks the /ws proxy to the game server on 8090.
      host: '127.0.0.1',
      port: 3000,
      strictPort: false,
      open: false,
      proxy: {
        '/ws': {
          target: `ws://127.0.0.1:${GAME_SERVER_PORT}`,
          ws: true,
        },
      },
    },
  };
});
