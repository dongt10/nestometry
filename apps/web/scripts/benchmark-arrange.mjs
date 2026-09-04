import { chromium } from '@playwright/test';

const baseUrl = process.env.PERF_BASE_URL ?? 'http://127.0.0.1:3217';
const roomId = process.env.PERF_ROOM_ID ?? 'unit-3-standard-double';
const sampleDurationMs = Number(process.env.PERF_DURATION_MS ?? 10_000);
const viewport = { width: 1280, height: 720 };
const medianTarget = 55;
const lowFpsThreshold = 45;
const sustainedLowBuckets = 3;

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[index];
}

function summarizeFrames(timestamps, durationMs) {
  const intervals = timestamps.slice(1).map((value, index) => value - timestamps[index]);
  const instantaneousFps = intervals.filter((delta) => delta > 0).map((delta) => 1_000 / delta);
  const bucketCount = Math.floor(durationMs / 1_000);
  const start = timestamps[0] ?? 0;
  const oneSecondFps = Array.from({ length: bucketCount }, (_, index) => {
    const lower = start + index * 1_000;
    const upper = lower + 1_000;
    return timestamps.filter((timestamp) => timestamp > lower && timestamp <= upper).length;
  });

  let currentLowRun = 0;
  let maximumLowRun = 0;
  for (const fps of oneSecondFps) {
    currentLowRun = fps < lowFpsThreshold ? currentLowRun + 1 : 0;
    maximumLowRun = Math.max(maximumLowRun, currentLowRun);
  }

  return {
    sampled_frames: intervals.length,
    duration_ms: Number(((timestamps.at(-1) ?? start) - start).toFixed(1)),
    median_fps: Number(percentile(instantaneousFps, 0.5).toFixed(1)),
    p10_fps: Number(percentile(instantaneousFps, 0.1).toFixed(1)),
    p95_frame_time_ms: Number(percentile(intervals, 0.95).toFixed(2)),
    one_second_fps: oneSecondFps,
    minimum_one_second_fps: Math.min(...oneSecondFps),
    consecutive_buckets_below_45: maximumLowRun
  };
}

async function installCleanPlannerState(page) {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    for (const tip of ['rooms', 'arrange', 'share']) {
      window.localStorage.setItem(`nestometry:tip:v1:${tip}`, '1');
    }
  });
}

async function openPlanner(page, errors) {
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const source = message.location().url;
      errors.push(`console: ${message.text()}${source ? ` @ ${source}` : ''}`);
    }
  });

  const response = await page.goto(`${baseUrl}/?room=${encodeURIComponent(roomId)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000
  });
  if (!response?.ok()) throw new Error(`planner returned ${response?.status() ?? 'no response'}`);

  const canvas = page.locator('.stage-scene canvas');
  await canvas.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => document.body.innerText.trim().length > 0);
  const overlay = page.locator('[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay');
  if (await overlay.count()) throw new Error('framework error overlay is visible');
  await page.waitForFunction(() => {
    const element = document.querySelector('.stage-scene canvas');
    return element instanceof HTMLCanvasElement && element.width > 0 && element.height > 0;
  });
  await page.waitForTimeout(1_000);
}

async function ensureAutomaticQuality(page) {
  await page.getByRole('button', { name: 'layers', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'layers' });
  await sheet.getByLabel('render quality').selectOption('auto');
  await sheet.locator('[data-sheet-close="true"]').click();
}

async function addBenchmarkBlock(page) {
  await page.getByRole('button', { name: 'arrange', exact: true }).click();
  await page.getByRole('button', { name: 'add item', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'add an item' });
  await dialog.getByLabel('preset').selectOption('bookcase');
  await dialog.getByRole('button', { name: 'add to plan' }).click();
  await page.getByRole('button', { name: 'clear selection' }).click();
}

async function beginCustomBlockDrag(page) {
  const canvas = page.locator('.stage-scene canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');

  const candidates = [
    [0.5, 0.5],
    [0.5, 0.46],
    [0.5, 0.54],
    [0.46, 0.5],
    [0.54, 0.5]
  ];
  for (const [xRatio, yRatio] of candidates) {
    const x = box.x + box.width * xRatio;
    const y = box.y + box.height * yRatio;
    await page.mouse.move(x, y);
    await page.mouse.down();
    const selected = await page.locator('.selection-bar strong').textContent({ timeout: 500 }).catch(() => null);
    if (selected?.trim() === 'bookcase') return { x, y };
    await page.mouse.up();
    await page.getByRole('button', { name: 'clear selection' }).click({ timeout: 500 }).catch(() => {});
  }
  throw new Error('could not acquire the centre benchmark block for a real 3d drag');
}

async function drivePointer(page, origin, durationMs, radius = 14) {
  const started = Date.now();
  let index = 0;
  while (Date.now() - started < durationMs) {
    const phase = index / 12;
    await page.mouse.move(
      origin.x + Math.sin(phase) * radius,
      origin.y + Math.cos(phase * 0.73) * radius
    );
    index += 1;
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
  return index;
}

async function sampleActiveDrag(page) {
  const origin = await beginCustomBlockDrag(page);
  await drivePointer(page, origin, 1_500, 10);
  const [timestamps, pointerMoves] = await Promise.all([
    page.evaluate((duration) => new Promise((resolve) => {
      const timestamps = [];
      let started;
      const tick = (timestamp) => {
        if (started === undefined) started = timestamp;
        timestamps.push(timestamp);
        if (timestamp - started >= duration) resolve(timestamps);
        else window.requestAnimationFrame(tick);
      };
      window.requestAnimationFrame(tick);
    }), sampleDurationMs),
    drivePointer(page, origin, sampleDurationMs + 100, 14)
  ]);
  await page.mouse.up();
  await page.getByRole('status').filter({ hasText: 'custom arrangement' }).waitFor();
  return { timestamps, pointerMoves };
}

async function canvasPixelRatio(page) {
  return page.locator('.stage-scene canvas').evaluate((canvas) => {
    const box = canvas.getBoundingClientRect();
    return Number((canvas.width / box.width).toFixed(2));
  });
}

async function runAutoDowngradeProbe(browser) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  await installCleanPlannerState(page);
  await openPlanner(page, errors);
  await ensureAutomaticQuality(page);
  await addBenchmarkBlock(page);

  const initialRatio = await canvasPixelRatio(page);
  const origin = await beginCustomBlockDrag(page);
  const naturalDowngrade = initialRatio <= 1.1;

  if (!naturalDowngrade) {
    await Promise.all([
      page.evaluate(() => new Promise((resolve) => {
        const end = performance.now() + 4_500;
        const loadFrame = () => {
          const busyUntil = performance.now() + 22;
          while (performance.now() < busyUntil) {
            // Deliberately constrain frame headroom so the automatic profile
            // sees the same sustained-low condition as a slower device.
          }
          if (performance.now() < end) requestAnimationFrame(loadFrame);
          else resolve();
        };
        requestAnimationFrame(loadFrame);
      })),
      drivePointer(page, origin, 4_600, 10)
    ]);
  }

  await page.waitForFunction(() => {
    const canvas = document.querySelector('.stage-scene canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    return canvas.width / canvas.getBoundingClientRect().width <= 1.1;
  }, { timeout: 8_000 });
  const downgradedRatio = await canvasPixelRatio(page);
  const observedRatios = [];
  for (let index = 0; index < 8; index += 1) {
    await page.waitForTimeout(500);
    observedRatios.push(await canvasPixelRatio(page));
  }
  await page.mouse.move(origin.x + 18, origin.y + 10);
  await page.mouse.up();
  await page.getByRole('status').filter({ hasText: 'custom arrangement' }).waitFor();

  const result = {
    initial_canvas_pixel_ratio: initialRatio,
    downgrade_trigger: naturalDowngrade ? 'natural sustained low fps' : 'controlled sustained low fps',
    downgraded_canvas_pixel_ratio: downgradedRatio,
    post_downgrade_ratios: observedRatios,
    stayed_downgraded: observedRatios.every((ratio) => ratio <= 1.1),
    planner_remained_interactive: await page.getByRole('button', { name: 'arrange', exact: true }).isVisible(),
    browser_errors: errors
  };
  await context.close();
  return result;
}

async function main() {
  if (!Number.isFinite(sampleDurationMs) || sampleDurationMs < 10_000) {
    throw new Error('PERF_DURATION_MS must be at least 10000');
  }

  // This is a local acceptance benchmark, so use the Mac's real GPU by
  // default. PERF_HEADLESS=1 is useful only for exercising low-profile
  // fallback behavior in automation, where Chromium normally uses SwiftShader.
  const headless = process.env.PERF_HEADLESS === '1';
  const browser = await chromium.launch({ headless });
  try {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    await installCleanPlannerState(page);
    await openPlanner(page, errors);
    await ensureAutomaticQuality(page);
    await addBenchmarkBlock(page);

    const runtime = await page.locator('.stage-scene canvas').evaluate((canvas) => {
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      const debugInfo = gl?.getExtension('WEBGL_debug_renderer_info');
      return {
        user_agent: navigator.userAgent,
        hardware_concurrency: navigator.hardwareConcurrency,
        webgl_vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : 'unavailable',
        webgl_renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : 'unavailable'
      };
    });

    const { timestamps, pointerMoves } = await sampleActiveDrag(page);
    const performance = summarizeFrames(timestamps, sampleDurationMs);
    performance.pointer_moves = pointerMoves;
    performance.median_target_met = performance.median_fps >= medianTarget;
    performance.no_sustained_low_interval =
      performance.consecutive_buckets_below_45 < sustainedLowBuckets;
    await context.close();

    const autoQuality = await runAutoDowngradeProbe(browser);
    const report = {
      benchmark: 'nestometry 3d active-arrange benchmark',
      browser_mode: headless ? 'headless' : 'headed',
      base_url: baseUrl,
      room_id: roomId,
      viewport: { ...viewport, device_scale_factor: 1 },
      thresholds: {
        median_fps_at_least: medianTarget,
        sustained_low_definition: `${sustainedLowBuckets} consecutive one-second buckets below ${lowFpsThreshold} fps`
      },
      runtime,
      performance,
      automatic_quality_probe: {
        viewport: { ...viewport, device_scale_factor: 2 },
        ...autoQuality
      },
      browser_errors: errors
    };
    console.log(JSON.stringify(report, null, 2));

    const passed =
      performance.median_target_met &&
      performance.no_sustained_low_interval &&
      errors.length === 0 &&
      autoQuality.stayed_downgraded &&
      autoQuality.planner_remained_interactive &&
      autoQuality.browser_errors.length === 0;
    if (!passed) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
