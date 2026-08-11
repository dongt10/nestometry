import { expect, test, type Locator, type Page } from '@playwright/test';

const TRIPLE_ID = 'unit-3-standard-triple';
const DOUBLE_ID = 'unit-3-standard-double';

type Point = { x: number; y: number };

function watchBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  const isAllowedWarning = (text: string) =>
    // Upstream @react-three/fiber still constructs THREE.Clock internally in
    // the pinned compatible release; it is non-fatal and not app-authored.
    text === 'THREE.Clock: This module has been deprecated. Please use THREE.Timer instead.' ||
    // Playwright screenshots read the software-rendered WebGL framebuffer.
    // Chromium reports that harness-induced synchronization as a perf warning.
    (text.includes('GL Driver Message') && text.includes('GPU stall due to ReadPixels'));

  page.on('pageerror', (error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console.error: ${message.text()}`);
    } else if (message.type() === 'warning' && !isAllowedWarning(message.text())) {
      errors.push(`console.warning: ${message.text()}`);
    }
  });

  return errors;
}

async function expectUrlState(
  page: Page,
  expected: { room: string; mode: '3d' | '2d'; dims?: boolean }
) {
  await expect
    .poll(() => {
      const url = new URL(page.url());
      return {
        hall: url.searchParams.get('hall'),
        room: url.searchParams.get('room'),
        mode: url.searchParams.get('mode'),
        dims: url.searchParams.get('dims')
      };
    })
    .toEqual({
      hall: 'Unit 3',
      room: expected.room,
      mode: expected.mode,
      dims: expected.dims ? '1' : null
    });
}

async function waitForModelResponse(page: Page, roomId: string) {
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith(`/models/berkeley/${roomId}.glb`) &&
      response.status() === 200
  );
}

async function openDefaultRoom(page: Page) {
  const modelResponse = waitForModelResponse(page, TRIPLE_ID);
  await page.goto('/');
  await modelResponse;
  await expect(page.locator('.topbar-title')).toHaveText('Unit 3 Standard Triple — Representative');
  await expect(page.locator('.stage-scene canvas')).toBeVisible();
  await expect(page.getByText('Loading room model…')).toHaveCount(0);
  await expectUrlState(page, { room: TRIPLE_ID, mode: '3d' });
}

/**
 * Arrange mode exposes a grab cursor only when its raycaster is over a movable
 * furniture instance. Scan a bounded portion of the fixed canvas instead of
 * depending on a brittle pixel captured from one GPU/rendering environment.
 */
async function findMovablePoint(canvas: Locator): Promise<Point> {
  const preferredFractions: Point[] = [
    { x: 0.5, y: 0.52 },
    { x: 0.45, y: 0.58 },
    { x: 0.55, y: 0.58 },
    { x: 0.4, y: 0.64 },
    { x: 0.6, y: 0.64 }
  ];
  const gridFractions: Point[] = [];
  for (let y = 0.2; y <= 0.82; y += 0.04) {
    for (let x = 0.22; x <= 0.78; x += 0.04) {
      gridFractions.push({ x, y });
    }
  }

  const point = await canvas.evaluate((element, fractions) => {
    const roomCanvas = element as HTMLCanvasElement;
    const box = roomCanvas.getBoundingClientRect();
    for (const fraction of fractions) {
      const candidate = {
        x: box.x + box.width * fraction.x,
        y: box.y + box.height * fraction.y
      };
      roomCanvas.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerId: 1,
          pointerType: 'mouse',
          clientX: candidate.x,
          clientY: candidate.y,
          buttons: 0
        })
      );
      if (roomCanvas.style.cursor === 'grab') return candidate;
    }
    return null;
  }, [...preferredFractions, ...gridFractions]);

  if (point) return point;

  throw new Error('No movable furniture was found in the bounded canvas scan.');
}

async function beginFurnitureDrag(canvas: Locator, point: Point, pointerId: number) {
  await canvas.dispatchEvent('pointerdown', {
    pointerId,
    pointerType: 'mouse',
    clientX: point.x,
    clientY: point.y,
    button: 0,
    buttons: 1
  });
}

async function moveFurniture(canvas: Locator, point: Point, pointerId: number) {
  const offsets: Point[] = [
    { x: 64, y: 0 },
    { x: -64, y: 0 },
    { x: 0, y: 64 },
    { x: 0, y: -64 },
    { x: 48, y: 48 }
  ];

  for (const offset of offsets) {
    await canvas.dispatchEvent('pointermove', {
      pointerId,
      pointerType: 'mouse',
      clientX: point.x + offset.x,
      clientY: point.y + offset.y,
      buttons: 1
    });
    if (await canvas.page().getByRole('status').filter({ hasText: 'Custom arrangement' }).count()) {
      return;
    }
  }

  throw new Error('The selected movable furniture did not move in any bounded drag direction.');
}

async function endFurnitureDrag(canvas: Locator, point: Point, pointerId: number) {
  await canvas.dispatchEvent('pointerup', {
    pointerId,
    pointerType: 'mouse',
    clientX: point.x,
    clientY: point.y,
    button: 0,
    buttons: 0
  });
}

test('loads both rooms, synchronizes view state to the URL, and has no browser errors', async ({ page }) => {
  const browserErrors = watchBrowserErrors(page);
  const rootResponse = await page.request.get('/');
  expect(rootResponse.headers()['x-powered-by']).toBeUndefined();
  expect(rootResponse.headers()['x-content-type-options']).toBe('nosniff');
  expect(rootResponse.headers()['x-frame-options']).toBe('DENY');
  expect(rootResponse.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  await openDefaultRoom(page);

  const roomSelect = page.getByLabel('Room');
  const doubleResponse = waitForModelResponse(page, DOUBLE_ID);
  await roomSelect.selectOption(DOUBLE_ID);
  await doubleResponse;
  await expect(page.locator('.topbar-title')).toHaveText('Unit 3 Standard Double — Representative');
  await expect(page.getByText('Loading room model…')).toHaveCount(0);
  await expectUrlState(page, { room: DOUBLE_ID, mode: '3d' });

  await page.getByRole('button', { name: '2D', exact: true }).click();
  await expect(page.getByRole('button', { name: '2D', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/^Top-down view\./)).toBeVisible();
  await expectUrlState(page, { room: DOUBLE_ID, mode: '2d' });

  await page.getByRole('button', { name: '3D', exact: true }).click();
  await expect(page.getByRole('button', { name: '3D', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/^Representative model\./)).toBeVisible();
  await expectUrlState(page, { room: DOUBLE_ID, mode: '3d' });

  expect(browserErrors).toEqual([]);
});

test('keeps arrange feedback synchronized through drag, reset, and room changes', async ({ page }) => {
  const browserErrors = watchBrowserErrors(page);
  await openDefaultRoom(page);

  await page.getByRole('button', { name: 'Dimensions', exact: true }).click();
  await expectUrlState(page, { room: TRIPLE_ID, mode: '3d', dims: true });
  const dimensionBadges = page.locator('.dim3d-badge');
  await expect.poll(() => dimensionBadges.count()).toBeGreaterThan(0);

  const arrangeButton = page.getByRole('button', { name: 'Arrange', exact: true });
  await expect(arrangeButton).toBeVisible();
  await arrangeButton.click();
  await expect(arrangeButton).toHaveAttribute('aria-pressed', 'true');

  const canvas = page.locator('.stage-scene canvas');
  const point = await findMovablePoint(canvas);
  await beginFurnitureDrag(canvas, point, 11);
  await expect(dimensionBadges).toHaveCount(0);
  await moveFurniture(canvas, point, 11);
  const customNote = page.getByRole('status').filter({ hasText: 'Custom arrangement' });
  await expect(customNote).toBeVisible();
  await endFurnitureDrag(canvas, point, 11);
  await expect.poll(() => dimensionBadges.count()).toBeGreaterThan(0);
  const resetButton = page.getByRole('button', { name: 'Reset layout', exact: true });
  await expect(resetButton).toBeVisible();
  await expect(resetButton).toBeEnabled();

  // Software-rendered WebGL can keep Playwright's scroll-into-view action
  // waiting even though this top-bar control is already visible.
  await resetButton.dispatchEvent('click');
  await expect(customNote).toHaveCount(0);
  await expect(resetButton).toHaveCount(0);
  await expect.poll(() => dimensionBadges.count()).toBeGreaterThan(0);

  // Dirty the restored layout again, then prove a room change drops all
  // session-only arrangement state instead of leaking cached GLB transforms.
  await canvas.dispatchEvent('pointermove', {
    pointerId: 12,
    pointerType: 'mouse',
    clientX: point.x,
    clientY: point.y,
    buttons: 0
  });
  await beginFurnitureDrag(canvas, point, 12);
  await moveFurniture(canvas, point, 12);
  await endFurnitureDrag(canvas, point, 12);
  await expect(customNote).toBeVisible();

  const doubleResponse = waitForModelResponse(page, DOUBLE_ID);
  await page.getByLabel('Room').selectOption(DOUBLE_ID);
  await doubleResponse;
  await expect(page.locator('.topbar-title')).toHaveText('Unit 3 Standard Double — Representative');
  await expect(customNote).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reset layout', exact: true })).toHaveCount(0);
  await expectUrlState(page, { room: DOUBLE_ID, mode: '3d', dims: true });

  expect(browserErrors).toEqual([]);
});
