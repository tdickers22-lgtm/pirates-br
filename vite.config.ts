import { defineConfig } from 'vite';

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

export default defineConfig({
  root: '.',
  publicDir: 'public',
  define: {
    __GAME_SERVER_PORT__: JSON.stringify(GAME_SERVER_PORT),
  },
  build: {
    outDir: 'dist/client',
    rollupOptions: {
      input: 'index.html',
      output: {
        manualChunks: {
          three: ['three']
        }
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
});
