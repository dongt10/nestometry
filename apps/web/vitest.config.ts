import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Next keeps JSX in `preserve` mode for its own compiler. Vitest 4's Vite 8
  // pipeline uses Oxc directly, so transform test JSX before import analysis.
  oxc: {
    jsx: { runtime: 'automatic' }
  },
  resolve: {
    alias: {
      '@nestometry/room-schema': fileURLToPath(
        new URL('../../packages/room-schema/src/index.ts', import.meta.url)
      ),
      '@nestometry/berkeley-data': fileURLToPath(
        new URL('../../packages/berkeley-data', import.meta.url)
      )
    }
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    clearMocks: true,
    restoreMocks: true
  }
});
