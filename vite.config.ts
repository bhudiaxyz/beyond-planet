import { defineConfig } from 'vite';

export default defineConfig({
  base: '/beyond-planet/',
  server: {
    port: 5173,
    open: false,
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks: (id) => id.includes('three') ? 'three' : undefined,
      },
    },
  },
});
