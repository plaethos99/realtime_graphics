import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// The overlay reuses the shared renderer straight from ../renderer/src (its deps live in renderer/node_modules).
export default defineConfig({
  clearScreen: false,
  resolve: { alias: { '@rtg': resolve(__dirname, '../renderer/src/index.ts') } },
  server: {
    port: 1420,
    strictPort: true,
    fs: { allow: [resolve(__dirname, '..')] },
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        overlay: resolve(__dirname, 'index.html'),
        settings: resolve(__dirname, 'settings.html'),
        library: resolve(__dirname, 'library.html'),
      },
    },
  },
});
