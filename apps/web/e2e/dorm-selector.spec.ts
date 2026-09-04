import { expect, test, type Locator, type Page } from '@playwright/test';

const TRIPLE_ID = 'unit-3-standard-triple';
const DOUBLE_ID = 'unit-3-standard-double';
type Point = { x: number; y: number };

function watchBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  const allowed = (text: string) =>
    text === 'THREE.Clock: This module has been deprecated. Please use THREE.Timer instead.' ||
    (text.includes('GL Driver Message') && text.includes('GPU stall due to ReadPixels'));
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
    if (message.type() === 'warning' && !allowed(message.text())) {
      errors.push(`console.warning: ${message.text()}`);
    }
  });
  return errors;
}

async function suppressTips(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('nestometry:tip:v1:rooms', '1');
    localStorage.setItem('nestometry:tip:v1:arrange', '1');
    localStorage.setItem('nestometry:tip:v1:share', '1');
  });
}

async function suppressNextDevTools(page: Page) {
  const portal = page.locator('nextjs-portal');
  if (await portal.count()) {
    await portal.evaluateAll((elements) => {
      for (const element of elements) {
        (element as HTMLElement).style.display = 'none';
      }
    });
  }
}

async function waitForModel(page: Page, roomId: string) {
  return page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith(`/models/berkeley/${roomId}.glb`) &&
    response.status() === 200
  );
}

async function waitForCollider(page: Page, roomId: string) {
  return page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith(`/models/berkeley/${roomId}.colliders.json`) &&
    response.status() === 200
  );
}

async function openRoom(page: Page, roomId = TRIPLE_ID) {
  await suppressTips(page);
  const response = waitForModel(page, roomId);
  const colliderResponse = waitForCollider(page, roomId);
  await page.goto(roomId === TRIPLE_ID ? '/' : `/?room=${roomId}`);
  await Promise.all([response, colliderResponse]);
  await suppressNextDevTools(page);
  await expect(page.locator('.stage-scene canvas')).toBeVisible();
  await expect(page.getByText('loading room model…')).toHaveCount(0);
  await expect(page.locator('.room-trigger')).toContainText(
    roomId === TRIPLE_ID ? 'unit 3 standard triple' : 'unit 3 standard double'
  );
}

async function expectLowercaseVisibleCopy(page: Page) {
  const copy = await page.locator('body').innerText();
  expect(copy).toBe(copy.toLocaleLowerCase('en-US'));
  const attributeViolations = await page.locator('[aria-label], [title], [placeholder], [alt]').evaluateAll((elements) => {
    const attributes = ['aria-label', 'title', 'placeholder', 'alt'];
    return elements.flatMap((element) => {
      const root = element.getRootNode();
      if (
        element.closest('nextjs-portal') ||
        (root instanceof ShadowRoot && root.host.localName === 'nextjs-portal') ||
        element.getAttribute('aria-label') === 'Open Next.js Dev Tools'
      ) return [];
      return attributes.flatMap((attribute) => {
        const value = element.getAttribute(attribute);
        return value && value !== value.toLocaleLowerCase('en-US')
          ? [`${attribute}=${JSON.stringify(value)}`]
          : [];
      });
    });
  });
  expect(attributeViolations).toEqual([]);
}

async function movePlanObjectWithKeyboard(object: Locator, key: 'ArrowLeft' | 'ArrowRight') {
  await object.focus();
  await object.press(key);
  await object.press(key);
}

async function findMovablePoint(canvas: Locator): Promise<Point> {
  const fractions: Point[] = [];
  for (let y = 0.18; y <= 0.82; y += 0.04) {
    for (let x = 0.18; x <= 0.82; x += 0.04) fractions.push({ x, y });
  }
  const point = await canvas.evaluate((element, candidates) => {
    const roomCanvas = element as HTMLCanvasElement;
    const box = roomCanvas.getBoundingClientRect();
    for (const candidate of candidates) {
      const position = {
        x: box.x + box.width * candidate.x,
        y: box.y + box.height * candidate.y
      };
      roomCanvas.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 77,
        pointerType: 'mouse',
        clientX: position.x,
        clientY: position.y,
        buttons: 0
      }));
      if (roomCanvas.style.cursor === 'grab') return position;
    }
    return null;
  }, fractions);
  if (!point) throw new Error('no movable furniture was found in the bounded 3d canvas scan');
  return point;
}

async function dragFurnitureOnce(canvas: Locator, point: Point) {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('3d canvas did not render');
  const delta = {
    x: point.x < box.x + box.width / 2 ? 72 : -72,
    y: point.y < box.y + box.height / 2 ? 24 : -24
  };
  await canvas.dispatchEvent('pointerdown', {
    pointerId: 77,
    pointerType: 'mouse',
    clientX: point.x,
    clientY: point.y,
    button: 0,
    buttons: 1
  });
  await expect(canvas.page().locator('.dim3d-badge')).toHaveCount(0);
  await canvas.dispatchEvent('pointermove', {
    pointerId: 77,
    pointerType: 'mouse',
    clientX: point.x + delta.x,
    clientY: point.y + delta.y,
    buttons: 1
  });
  await expect(canvas.page().getByRole('status').filter({ hasText: 'custom arrangement' })).toBeVisible();
  await canvas.dispatchEvent('pointerup', {
    pointerId: 77,
    pointerType: 'mouse',
    clientX: point.x + delta.x,
    clientY: point.y + delta.y,
    button: 0,
    buttons: 0
  });
}

test('browses rooms, keeps drawers model-stable, and exposes lowercase evidence details', async ({ page }) => {
  const errors = watchBrowserErrors(page);
  const glbRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('.glb')) glbRequests.push(request.url());
  });
  const rootResponse = await page.request.get('/');
  expect(rootResponse.headers()['x-powered-by']).toBeUndefined();
  expect(rootResponse.headers()['x-content-type-options']).toBe('nosniff');
  expect(rootResponse.headers()['x-frame-options']).toBe('DENY');
  expect(rootResponse.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  const iconResponse = await page.request.get('/icon.svg');
  expect(iconResponse.status()).toBe(200);
  expect(iconResponse.headers()['content-type']).toContain('image/svg+xml');

  await openRoom(page);
  await expect(page.getByText('incomplete catalog · contribute ↗')).toBeVisible();
  const tripleRequests = glbRequests.filter((url) => url.includes(TRIPLE_ID)).length;

  await page.getByRole('button', { name: 'details', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'details' });
  await expect(details).toBeVisible();
  await expect(details.getByText('room summary')).toBeVisible();
  await details.getByText('dimensions and confidence').click();
  await expect(details.getByText(/official dimensions are unknown/)).toBeVisible();
  await details.getByRole('button', { name: 'metric' }).click();
  await details.locator('[data-sheet-close="true"]').click();

  await page.getByRole('button', { name: 'layers', exact: true }).click();
  const layers = page.getByRole('dialog', { name: 'layers' });
  await expect(layers.getByText('smart wall fade')).toBeVisible();
  await expect(layers.getByText('confidence markers')).toBeVisible();
  // The acceptance benchmark covers automatic/high rendering separately. Use
  // the low profile for this interaction story so Linux CI does not spend the
  // test timeout software-rendering postprocessing between DOM actions.
  await layers.getByLabel('render quality').selectOption('low');
  await layers.locator('[data-sheet-close="true"]').click();
  expect(glbRequests.filter((url) => url.includes(TRIPLE_ID))).toHaveLength(tripleRequests);

  await page.locator('.room-trigger').click();
  const rooms = page.getByRole('dialog', { name: 'rooms' });
  await rooms.getByPlaceholder('search halls, rooms, or types').fill('double');
  const doubleResponse = waitForModel(page, DOUBLE_ID);
  await rooms.getByRole('button', { name: /standard double/ }).click();
  await doubleResponse;
  await expect(page.locator('.room-trigger')).toContainText('unit 3 standard double');

  const dimensionsButton = page.getByRole('button', { name: 'dimensions', exact: true });
  await expect(dimensionsButton).toBeVisible();
  await dimensionsButton.dispatchEvent('click');
  const dimensionBadges = page.locator('.dim3d-badge');
  await expect.poll(() => dimensionBadges.count()).toBeGreaterThan(0);
  const arrangeButton = page.getByRole('button', { name: 'arrange', exact: true });
  await expect(arrangeButton).toBeVisible();
  // A normal Playwright click may wait indefinitely for scroll stability while
  // SwiftShader is busy. This is an already-visible fixed header control.
  await arrangeButton.dispatchEvent('click');
  const canvas = page.locator('.stage-scene canvas');
  await dragFurnitureOnce(canvas, await findMovablePoint(canvas));
  await expect.poll(() => dimensionBadges.count()).toBeGreaterThan(0);
  await expect(page.locator('.stage-arrange-note')).toContainText('custom arrangement');
  await page.getByRole('button', { name: 'reset', exact: true }).dispatchEvent('click');
  await expect(page.locator('.stage-arrange-note')).toHaveCount(0);
  await expect.poll(() => dimensionBadges.count()).toBeGreaterThan(0);
  await arrangeButton.dispatchEvent('click');

  await page.getByRole('button', { name: '2d', exact: true }).click();
  const plan = page.getByRole('application', { name: /editable floor plan/ });
  await expect(plan).toBeVisible();
  await expect(page.getByRole('button', { name: '2d', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.stage-accuracy-chip')).toContainText('representative plan · dimensions estimated · actual rooms vary');
  await expect(plan.locator('.plan-dimension')).toHaveCount(2);
  await page.getByRole('button', { name: 'dimensions', exact: true }).click();
  await expect(plan.locator('.plan-dimension')).toHaveCount(0);
  await page.getByRole('button', { name: 'dimensions', exact: true }).click();
  await expect(plan.locator('.plan-dimension')).toHaveCount(2);
  await page.getByRole('button', { name: 'layers', exact: true }).click();
  const planLayers = page.getByRole('dialog', { name: 'layers' });
  await expect(planLayers.getByText('desks', { exact: true })).toBeVisible();
  await expect(planLayers.getByText('windows', { exact: true })).toBeVisible();
  await planLayers.locator('[data-sheet-close="true"]').click();
  await page.getByRole('button', { name: '3d', exact: true }).click();
  await expect(page.locator('.stage-scene canvas')).toBeVisible();
  await expectLowercaseVisibleCopy(page);
  expect(errors).toEqual([]);
});

test('edits one shared 2d scene with inventory, custom blocks, undo, local restore, and sharing', async ({ page, context }) => {
  const errors = watchBrowserErrors(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openRoom(page, DOUBLE_ID);
  await page.getByRole('button', { name: '2d', exact: true }).click();
  await page.getByRole('button', { name: 'arrange', exact: true }).click();
  await expect(page.getByRole('toolbar', { name: 'arrange tools' })).toBeVisible();

  const fixedBookshelf = page.locator('[data-plan-id="bookshelf_1"]');
  await fixedBookshelf.focus();
  await fixedBookshelf.press('Enter');
  await expect(page.getByRole('toolbar', { name: 'arrange tools' }).getByRole('button', { name: 'rotate 90°' })).toBeDisabled();
  await expect(page.locator('.selection-bar').getByRole('button', { name: 'rotate 90°' })).toBeDisabled();

  const desk = page.locator('[data-plan-id="desk_1"]');
  const originalX = Number(await desk.locator('rect').getAttribute('x'));
  await movePlanObjectWithKeyboard(desk, 'ArrowLeft');
  await expect(page.getByRole('status').filter({ hasText: 'custom arrangement' })).toBeVisible();
  const movedX = Number(await page.locator('[data-plan-id="desk_1"] rect').getAttribute('x'));
  expect(movedX).toBeLessThan(originalX);

  await page.getByRole('button', { name: 'undo', exact: true }).click();
  const onceUndoneX = Number(await page.locator('[data-plan-id="desk_1"] rect').getAttribute('x'));
  expect(onceUndoneX).toBeGreaterThan(movedX);
  await movePlanObjectWithKeyboard(page.locator('[data-plan-id="desk_1"]'), 'ArrowRight');

  await page.getByRole('button', { name: 'add item', exact: true }).click();
  const addDialog = page.getByRole('dialog', { name: 'add an item' });
  await addDialog.getByLabel('preset').selectOption('table');
  await addDialog.getByRole('button', { name: 'add to plan' }).click();
  await expect(page.locator('[data-plan-id="custom_1"]')).toBeVisible();
  await expect(page.locator('.warning-count')).toHaveText(/\d+ warnings?/);
  await expect(page.locator('.planner-warning-summary')).toContainText('custom 1');
  await page.getByRole('button', { name: 'remove from plan' }).click();
  await expect(page.locator('[data-plan-id="custom_1"]')).toHaveCount(0);

  const bed = page.locator('[data-plan-id="twin_xl_bed_1"]');
  await bed.focus();
  await bed.press('Enter');
  await page.getByRole('button', { name: 'remove from plan' }).click();
  await expect(bed).toHaveCount(0);
  await page.getByRole('button', { name: 'inventory', exact: true }).click();
  const inventory = page.getByRole('dialog', { name: 'removed from plan' });
  await inventory.getByRole('button', { name: 'restore' }).click();
  await inventory.locator('[data-sheet-close="true"]').click();
  await expect(page.locator('[data-plan-id="twin_xl_bed_1"]')).toBeVisible();

  const savedX = Number(await page.locator('[data-plan-id="desk_1"] rect').getAttribute('x'));
  await page.reload();
  await page.getByRole('button', { name: '2d', exact: true }).click();
  await expect.poll(async () => Number(await page.locator('[data-plan-id="desk_1"] rect').getAttribute('x'))).toBe(savedX);
  await expect(page.getByRole('status').filter({ hasText: 'custom arrangement' })).toBeVisible();

  await page.getByRole('button', { name: 'share', exact: true }).click();
  const share = page.getByRole('dialog', { name: 'share this plan' });
  await expect(share).toContainText('anyone with the link can read and edit its layout and custom item labels');
  await share.getByRole('button', { name: 'copy share link' }).click();
  const sharedUrl = await share.getByLabel('share link').inputValue();
  expect(sharedUrl).toContain('#layout=v1.');
  const sharedPage = await context.newPage();
  const sharedErrors = watchBrowserErrors(sharedPage);
  await sharedPage.goto(sharedUrl);
  await expect(sharedPage.locator('.room-trigger')).toContainText('unit 3 standard double');
  await expect(sharedPage.getByRole('application', { name: /editable floor plan/ })).toBeVisible();
  await expect(sharedPage.getByRole('status').filter({ hasText: 'custom arrangement' })).toBeVisible();
  await sharedPage.getByRole('button', { name: 'arrange', exact: true }).click();
  await movePlanObjectWithKeyboard(sharedPage.locator('[data-plan-id="desk_1"]'), 'ArrowRight');
  await expect.poll(() => new URL(sharedPage.url()).hash).toBe('');

  const switchPage = await context.newPage();
  await suppressTips(switchPage);
  const switchErrors = watchBrowserErrors(switchPage);
  await switchPage.goto(sharedUrl);
  await expect(switchPage.locator('.room-trigger')).toContainText('unit 3 standard double');
  await switchPage.locator('.room-trigger').click();
  const rooms = switchPage.getByRole('dialog', { name: 'rooms' });
  const tripleResponse = waitForModel(switchPage, TRIPLE_ID);
  await rooms.getByRole('button', { name: /standard triple/ }).click();
  await tripleResponse;
  await expect.poll(() => new URL(switchPage.url()).hash).toBe('');
  await expect(switchPage.locator('.room-trigger')).toContainText('unit 3 standard triple');
  await switchPage.reload();
  await expect(switchPage.locator('.room-trigger')).toContainText('unit 3 standard triple');
  expect(switchErrors).toEqual([]);
  expect(sharedErrors).toEqual([]);
  expect(errors).toEqual([]);
});

test.describe('mobile planner', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('uses full-screen sheets, 44px controls, touch editing, and two-finger plan navigation', async ({ page, context }) => {
    const errors = watchBrowserErrors(page);
    await openRoom(page);
    const controls = page.locator('.mobile-dock button');
    await expect(controls).toHaveCount(5);
    for (const box of await controls.evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().toJSON()))) {
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }

    await page.getByRole('button', { name: /rooms/ }).click();
    const sheet = page.getByRole('dialog', { name: 'rooms' });
    const sheetBox = await sheet.boundingBox();
    expect(sheetBox?.width).toBe(390);
    expect(sheetBox?.height).toBe(844);
    await sheet.getByPlaceholder('search halls, rooms, or types').fill('double');
    const response = waitForModel(page, DOUBLE_ID);
    await sheet.getByRole('button', { name: /standard double/ }).click();
    await response;

    await page.getByRole('button', { name: /2d/ }).click();
    await page.getByRole('button', { name: /arrange/ }).click();
    const plan = page.getByRole('application', { name: /editable floor plan/ });
    const object = page.locator('[data-plan-id="desk_1"] rect');
    const box = await object.boundingBox();
    if (!box) throw new Error('desk footprint did not render');
    const cdp = await context.newCDPSession(page);
    const objectX = box.x + box.width / 2;
    const objectY = box.y + box.height / 2;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: objectX, y: objectY, id: 21 }]
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: objectX + 28, y: objectY, id: 21 }]
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.getByRole('status').filter({ hasText: 'custom arrangement' })).toBeVisible();

    const initialViewBox = await plan.getAttribute('viewBox');
    const planBox = await plan.boundingBox();
    if (!planBox) throw new Error('floor plan did not render');
    // Begin in the plan's clear top margin so the contacts target the SVG,
    // not furniture footprints whose drag handlers intentionally stop bubbling.
    const centerY = planBox.y + Math.min(24, planBox.height * 0.05);
    const leftStart = planBox.x + planBox.width * 0.35;
    const rightStart = planBox.x + planBox.width * 0.65;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        { x: leftStart, y: centerY, id: 31 },
        { x: rightStart, y: centerY, id: 32 }
      ]
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: planBox.x + planBox.width * 0.26, y: centerY - 18, id: 31 },
        { x: planBox.x + planBox.width * 0.74, y: centerY + 18, id: 32 }
      ]
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => plan.getAttribute('viewBox')).not.toBe(initialViewBox);
    await page.getByRole('button', { name: 'more', exact: true }).click();
    const more = page.getByRole('dialog', { name: 'more planner tools' });
    await more.getByRole('button', { name: 'share this plan' }).click();
    const share = page.getByRole('dialog', { name: 'share this plan' });
    await expect(share).toBeVisible();
    await expectLowercaseVisibleCopy(page);
    await share.locator('[data-sheet-close="true"]').click();
    await page.setViewportSize({ width: 319, height: 700 });
    await expect(page.locator('.room-name-full')).toBeHidden();
    await expect(page.locator('.room-name-compact')).toContainText('unit 3 double');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
});
