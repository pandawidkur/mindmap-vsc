import * as path from 'path';
import { pathToFileURL } from 'url';
import { expect, Page, test } from '@playwright/test';

const PAGE = pathToFileURL(path.resolve(__dirname, 'index.html')).href;

const DOC = `# Root

Body of root.

## Alpha

Text of alpha.

### Alpha one

## Beta

Text of beta.
`;

/** Rejects everything the page reports as an error, including CSP violations. */
async function openMap(page: Page, doc = DOC): Promise<void> {
  page.on('console', (message) => {
    if (message.type() === 'error') {
      throw new Error(`Console error: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    throw error;
  });
  await page.addInitScript((text) => {
    (window as unknown as { __doc: string }).__doc = text;
  }, doc);
  await page.goto(PAGE);
  await page.waitForSelector('me-tpc');
  await mapSettled(page);
}

/** Waits out the map's zoom transition, which would move nodes from under the mouse. */
async function mapSettled(page: Page): Promise<void> {
  const position = () =>
    page.evaluate(() => {
      const box = document.querySelector('me-tpc')!.getBoundingClientRect();
      return `${box.x},${box.y},${box.width}`;
    });
  let previous = await position();
  let stable = 0;
  while (stable < 3) {
    await page.waitForTimeout(50);
    const current = await position();
    stable = current === previous ? stable + 1 : 0;
    previous = current;
  }
}

function host<T>(page: Page, read: (host: Record<string, any>) => T): Promise<T> {
  return page.evaluate(`(${read.toString()})(window.__host)`) as Promise<T>;
}

const docText = (page: Page) => host(page, (h) => h.text() as string);

const typeInEditor = (page: Page, text: string) =>
  page.evaluate((value) => {
    (window as unknown as { __host: { type(t: string): void } }).__host.type(value);
  }, text);

function node(page: Page, topic: string) {
  return page.locator('me-tpc', { hasText: new RegExp(`^${topic}$`) });
}

/** Waits for the debounced update of a text edit to reach the map. */
const afterTextEdit = (page: Page) => page.waitForTimeout(350);

async function drag(page: Page, from: string, to: string): Promise<void> {
  const start = (await node(page, from).boundingBox())!;
  const end = (await node(page, to).boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(100);
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 15 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(300);
}

async function renameSelected(page: Page, text: string): Promise<void> {
  await page.waitForSelector('#input-box');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
}

const sideOf = (page: Page, topic: string) =>
  node(page, topic).evaluate((element) =>
    element.closest('.lhs') ? 'left' : element.closest('.rhs') ? 'right' : 'none'
  );

const toolbar = (page: Page) => page.locator('.mm-toolbar');
const toolbarButton = (page: Page, label: string) =>
  page.locator('.mm-toolbar-btn', { hasText: label });

test.describe('editing on the map', () => {
  test.beforeEach(({ page }) => openMap(page));

  test('renaming changes only the heading', async ({ page }) => {
    await node(page, 'Beta').dblclick();
    await renameSelected(page, 'Gamma');
    expect(await docText(page)).toBe(DOC.replace('## Beta', '## Gamma'));
  });

  test('Tab adds a child and Enter adds a sibling', async ({ page }) => {
    await node(page, 'Beta').click();
    await page.keyboard.press('Tab');
    await renameSelected(page, 'Beta one');
    await node(page, 'Alpha').click();
    await page.keyboard.press('Enter');
    await renameSelected(page, 'Between');
    const text = await docText(page);
    expect(text).toContain('Text of beta.\n\n### Beta one\n');
    expect(text.indexOf('## Between')).toBeGreaterThan(text.indexOf('### Alpha one'));
    expect(text.indexOf('## Between')).toBeLessThan(text.indexOf('## Beta'));
  });

  test('closing the text box without a change sends nothing', async ({ page }) => {
    await node(page, 'Beta').dblclick();
    await page.waitForSelector('#input-box');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    expect(await docText(page)).toBe(DOC);
  });

  test('deleting asks about text and honours a refusal', async ({ page }) => {
    await page.evaluate(() => {
      (window as unknown as { __host: { confirmRemoval: boolean } }).__host.confirmRemoval = false;
    });
    await node(page, 'Beta').click();
    await toolbarButton(page, 'Delete').click();
    await expect(node(page, 'Beta')).toHaveCount(1);
    expect(await docText(page)).toBe(DOC);
  });

  test('dragging moves a section with its text', async ({ page }) => {
    await drag(page, 'Beta', 'Alpha');
    const text = await docText(page);
    expect(text).toContain('### Beta\n\nText of beta.\n');
    expect(text).toContain('Text of alpha.');
  });

  test('pasting reaches the document at once', async ({ page }) => {
    await node(page, 'Beta').click();
    await page.keyboard.press('ControlOrMeta+c');
    await node(page, 'Alpha one').click();
    await page.keyboard.press('ControlOrMeta+v');
    await page.waitForTimeout(100);
    expect(await docText(page)).toContain('### Alpha one\n\n#### Beta\n');
  });

  test('cut is not available, so it cannot lose section text', async ({ page }) => {
    await node(page, 'Beta').click();
    await page.keyboard.press('ControlOrMeta+x');
    await page.waitForTimeout(100);
    await node(page, 'Alpha').click();
    await page.keyboard.press('ControlOrMeta+v');
    await page.waitForTimeout(100);
    expect(await docText(page)).toBe(DOC);
    await expect(node(page, 'Beta')).toHaveCount(1);
  });

  test('undo and redo are sent to the host in the side panel', async ({ page }) => {
    await node(page, 'Beta').click();
    await page.keyboard.press('ControlOrMeta+z');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await page.waitForTimeout(50);
    expect(await host(page, (h) => h.history)).toEqual(['undo', 'redo']);
  });
});

test.describe('toolbar and menu', () => {
  test.beforeEach(({ page }) => openMap(page));

  test('appears for the selected node only', async ({ page }) => {
    await expect(toolbar(page)).toBeHidden();
    await node(page, 'Beta').hover();
    await expect(toolbar(page)).toBeHidden();
    await node(page, 'Beta').click();
    await expect(toolbar(page)).toBeVisible();
  });

  test('follows the map when it pans', async ({ page }) => {
    await node(page, 'Beta').click();
    const before = (await toolbar(page).boundingBox())!;
    await page.evaluate(() => {
      document.querySelector('.map-container')!.scrollTop += 60;
    });
    await page.waitForTimeout(50);
    const after = (await toolbar(page).boundingBox())!;
    expect(before.y - after.y).toBeCloseTo(60, 0);
  });

  test('hides while a node is being edited', async ({ page }) => {
    await node(page, 'Beta').dblclick();
    await page.waitForSelector('#input-box');
    await expect(toolbar(page)).toBeHidden();
    await page.keyboard.press('Enter');
    await expect(toolbar(page)).toBeVisible();
  });

  test('offers no delete or sibling on the root', async ({ page }) => {
    await node(page, 'Root').click();
    await expect(toolbarButton(page, 'Child')).toBeVisible();
    await expect(toolbarButton(page, 'Delete')).toBeHidden();
    await expect(toolbarButton(page, 'Sibling')).toBeHidden();
  });

  test('the quick-add button adds a child to the selected node', async ({ page }) => {
    await node(page, 'Beta').click();
    await page.locator('.mm-quick-add').click();
    await renameSelected(page, 'Added');
    expect(await docText(page)).toContain('Text of beta.\n\n### Added\n');
  });

  test('the context menu has no action Markdown cannot store', async ({ page }) => {
    await node(page, 'Beta').click({ button: 'right' });
    const items = await page.locator('.menu-list li:visible').evaluateAll((list) =>
      list.map((item) => item.id)
    );
    expect(items.length).toBeGreaterThan(0);
    expect(items.filter((id) => /summary|link|fucus/.test(id))).toEqual([]);
  });
});

test.describe('updates from the text editor', () => {
  test.beforeEach(({ page }) => openMap(page));

  test('appear on the map', async ({ page }) => {
    await typeInEditor(page, DOC.replace('## Beta', '## Typed'));
    await expect(node(page, 'Typed')).toHaveCount(1);
  });

  test('keep the selection, the toolbar and the viewport', async ({ page }) => {
    await node(page, 'Beta').click();
    const scroll = () =>
      page.evaluate(() => {
        const map = document.querySelector('.map-container')!;
        return [map.scrollLeft, map.scrollTop];
      });
    const before = await scroll();
    await typeInEditor(page, DOC.replace('# Root', '# Renamed root'));
    await afterTextEdit(page);
    await expect(page.locator('me-tpc.selected')).toHaveText('Beta');
    await expect(toolbar(page)).toBeVisible();
    expect(await scroll()).toEqual(before);
  });

  test('keep folded branches folded', async ({ page }) => {
    await node(page, 'Alpha').click();
    await page.locator('me-parent:has(me-tpc:has-text("Alpha")) me-epd').first().click();
    await expect(node(page, 'Alpha one')).toHaveCount(0);
    await typeInEditor(page, DOC.replace('# Root', '# Renamed root'));
    await afterTextEdit(page);
    await expect(node(page, 'Renamed root')).toHaveCount(1);
    await expect(node(page, 'Alpha one')).toHaveCount(0);
  });

  test('do not close the text box of a node being edited', async ({ page }) => {
    await node(page, 'Beta').dblclick();
    await page.waitForSelector('#input-box');
    await typeInEditor(page, DOC.replace('# Root', '# Renamed root'));
    await afterTextEdit(page);
    await expect(page.locator('#input-box')).toHaveCount(1);
  });
});

test.describe('layout after a drag (#3)', () => {
  const LAYOUT = `# Launch plan

## Research

Talk to five users first.

## Build

## Release

Write the changelog.
`;

  test.use({ viewport: { width: 696, height: 560 } });

  test.beforeEach(async ({ page }) => {
    await openMap(page, LAYOUT);
    // Zoom to 100%, where the map fills this narrow view.
    await page.mouse.click(680, 20);
    await page.keyboard.press('Control++');
    await mapSettled(page);
  });

  test('branches stay on their sides after a text edit', async ({ page }) => {
    await drag(page, 'Research', 'Release');
    const before = await sideOf(page, 'Build');
    await typeInEditor(page, (await docText(page)).replace('## Release', '## Beta launch'));
    await afterTextEdit(page);
    await expect(node(page, 'Beta launch')).toHaveCount(1);
    expect(await sideOf(page, 'Build')).toBe(before);
    expect(await sideOf(page, 'Beta launch')).toBe('left');
    expect(await sideOf(page, 'Research')).toBe('left');
  });

  test('a new top-level branch still gets a side', async ({ page }) => {
    await typeInEditor(page, `${LAYOUT}\n## Added\n`);
    await afterTextEdit(page);
    await expect(node(page, 'Added')).toHaveCount(1);
    expect(['left', 'right']).toContain(await sideOf(page, 'Added'));
    expect(await sideOf(page, 'Build')).toBe('right');
  });

  test('a dragged node stays fully in view', async ({ page }) => {
    await drag(page, 'Research', 'Release');
    // Scrolling is in whole pixels, so a scaled node can be off by a fraction of one.
    const box = (await node(page, 'Research').boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(697);
    expect(box.y).toBeGreaterThanOrEqual(-1);
    expect(box.y + box.height).toBeLessThanOrEqual(561);
  });
});

test('a refused map edit restores the map', async ({ page }) => {
  const synthetic = '## One\n\n## Two\n';
  await openMap(page, synthetic);
  await node(page, 'notes').dblclick();
  await renameSelected(page, 'Other');
  await expect(node(page, 'notes')).toHaveCount(1);
  expect(await docText(page)).toBe(synthetic);
  expect(await host(page, (h) => h.warnings.length)).toBe(1);
});

test('colors follow a theme change and keep the selection', async ({ page }) => {
  await openMap(page);
  await node(page, 'Beta').click();
  await page.evaluate(() => {
    document.body.style.setProperty('--vscode-editor-background', '#ffffff');
    document.body.style.setProperty('--vscode-editor-foreground', '#333333');
    document.body.className = 'vscode-light';
  });
  await page.waitForTimeout(150);
  await expect(page.locator('me-tpc.selected')).toHaveText('Beta');
  await expect(node(page, 'Beta')).toHaveCSS('color', 'rgb(51, 51, 51)');
  await expect(page.locator('.map-container')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
});
