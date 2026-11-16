import AxeBuilder from '@axe-core/playwright';
import type { BrowserContext, Page } from '@playwright/test';
import { closeIntro, expect, failOpfs, openApp, openFromTree, runFixme, seedLocalStorage, test } from './app-fixtures';

// axe on the production build's main states, night and day, desktop and
// phone: no serious or critical violations.

async function seriousViolations(page: Page, exclude: string[] = []) {
  let builder = new AxeBuilder({ page });
  for (const selector of exclude) builder = builder.exclude(selector);
  const results = await builder.analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.slice(0, 6).map((node) => `${node.target.join(' ')}: ${node.failureSummary?.split('\n').slice(1, 2).join(' ').trim()}`),
    }));
}

type State = {
  name: string;
  storage?: Record<string, string>;
  phone?: boolean;
  /** Leave the welcome open. */
  welcome?: boolean;
  open?: (page: Page, context: BrowserContext) => Promise<void>;
  exclude?: string[];
  /** A violation in another part of the code, known and tracked. */
  fixme?: string;
};



const NIGHT = { 'nebula:theme': 'dark' };
const DAY = { 'nebula:theme': 'light' };

const states: State[] = [
  { name: 'the welcome, night', storage: NIGHT, welcome: true },
  { name: 'the observing plan, night', storage: NIGHT },
  {
    name: 'the observing plan, day, pane, Newsreader',
    storage: { ...DAY, 'nebula:style': 'pane', 'nebula:body': 'serif' },
  },
  {
    name: 'the canvas tab, night',
    storage: NIGHT,
    open: async (page) => {
      await page.getByRole('tab', { name: 'Winter hexagon', exact: true }).click();
      await expect(page.locator('.ws-canvas .excalidraw')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.ws-status')).toContainText(/\d+ elements/);
    },
  },
  {
    name: 'the canvas tab, day',
    storage: DAY,
    open: async (page) => {
      await page.getByRole('tab', { name: 'Winter hexagon', exact: true }).click();
      await expect(page.locator('.ws-canvas .excalidraw')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.ws-status')).toContainText(/\d+ elements/);
    },
  },
  {
    name: 'an image and the PDF, night',
    storage: NIGHT,
    open: async (page) => {
      await openFromTree(page, 'Photos/Winter hexagon.png');
      await openFromTree(page, 'Charts/Star chart — October.pdf');
    },
  },
  {
    name: 'Settings, appearance, night',
    storage: NIGHT,
    open: async (page) => {
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('tab', { name: 'Appearance' }).click();
    },
  },
  {
    name: 'Settings, project, day',
    storage: DAY,
    open: async (page) => {
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('tab', { name: 'Project' }).click();
    },
  },
  { name: 'the project menu, night', storage: NIGHT, open: (page) => page.locator('.ws-switcher').click() },
  { name: 'the project’s right-click menu, day', storage: DAY, open: (page) => page.locator('.ws-switcher').click({ button: 'right' }) },
  {
    name: 'New project, night',
    storage: NIGHT,
    open: async (page) => {
      await page.locator('.ws-switcher').click();
      await page.getByRole('menuitem', { name: 'New project' }).click();
    },
  },
  {
    name: 'quick open, day',
    storage: DAY,
    open: async (page) => {
      await page.keyboard.press('ControlOrMeta+k');
      await page.getByRole('combobox').fill('or');
    },
  },
  {
    name: 'note in edit mode, night',
    storage: NIGHT,
    open: async (page) => {
      await page.locator('.ws-stage').getByRole('button', { name: 'Edit' }).click();
      await expect(page.locator('.ws-page .cm-content')).toBeVisible({ timeout: 20_000 });
    },
  },
  { name: 'phone, the note, day', storage: DAY, phone: true },
  { name: 'phone, the files sheet, night', storage: NIGHT, phone: true, open: (page) => page.getByRole('navigation', { name: 'Phone' }).getByRole('button', { name: 'Files' }).click() },
  {
    name: 'a browser that keeps nothing, night',
    storage: NIGHT,
    open: async (page, context) => {
      void context;
      await expect(page.locator('.ws-ephemeral[role="note"]')).toBeVisible();
    },
  },
];

for (const state of states) {
  test(`axe: ${state.name}`, async ({ page, context }) => {
    test.fixme(Boolean(state.fixme) && !runFixme, state.fixme);
    if (state.phone) await page.setViewportSize({ width: 390, height: 844 });
    if (state.storage) await seedLocalStorage(context, state.storage);
    if (state.name.includes('keeps nothing')) await failOpfs(context);
    await openApp(page);
    if (!state.welcome) await closeIntro(page);
    await state.open?.(page, context);
    await page.waitForTimeout(400);
    expect(await seriousViolations(page, state.exclude)).toEqual([]);
  });
}
