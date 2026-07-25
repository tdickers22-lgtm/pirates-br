import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
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
    open: true,
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:8090',
        ws: true,
      },
    },
  },
});
