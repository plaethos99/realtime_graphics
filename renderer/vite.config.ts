import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const repoRoot = resolve(__dirname, '..');

export default defineConfig(({ mode }) =>
  mode === 'lib'
    ? {
        build: {
          outDir: 'dist/lib',
          emptyOutDir: true,
          lib: { entry: resolve(__dirname, 'src/index.ts'), formats: ['es'], fileName: 'realtime-graphics' },
        },
      }
    : {
        // Test bench: `npm run dev` serves dev/index.html
        root: resolve(__dirname, 'dev'),
        server: { port: 5173, fs: { allow: [repoRoot] } },
        build: { outDir: resolve(__dirname, 'dist/harness'), emptyOutDir: true },
      },
);
