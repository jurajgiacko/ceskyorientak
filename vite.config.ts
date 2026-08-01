import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import glsl from 'vite-plugin-glsl';

export default defineConfig({
  plugins: [glsl()],
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  build: {
    target: 'es2022',
    // Budget guard: the shell must stay small so time-to-first-play holds on 4G.
    // Terrain, models and textures stream in after the menu is interactive.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
  server: {
    port: 3000,
    headers: { 'Cache-Control': 'no-store' },
  },
});
