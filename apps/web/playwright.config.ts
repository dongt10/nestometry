import { defineConfig } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${port}`;
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  // Each page owns a WebGL scene. Serialize the two smoke stories so local and
  // CI software renderers are never asked to sustain two rooms concurrently.
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: 1,
  reporter: isCI ? 'line' : 'list',
  timeout: 120_000,
  expect: {
    timeout: 10_000
  },
  use: {
    baseURL,
    browserName: 'chromium',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
    colorScheme: 'light',
    screenshot: 'only-on-failure',
    // Preserve DOM snapshots and sources without recording a framebuffer
    // screenshot after every action; repeated WebGL readbacks can starve
    // Chromium's software renderer in CI. The failure-only screenshot below
    // still captures the final rendered state.
    trace: {
      mode: 'retain-on-failure',
      screenshots: false,
      snapshots: true,
      sources: true,
      attachments: true
    },
    // Recording a full-speed WebGL canvas is expensive under software
    // rendering and adds no assertion value to these deterministic smokes.
    video: 'off'
  },
  webServer: {
    command: isCI
      ? `corepack pnpm exec next start --hostname 127.0.0.1 --port ${port}`
      : `corepack pnpm exec next dev --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: !isCI,
    timeout: 120_000
  }
});
