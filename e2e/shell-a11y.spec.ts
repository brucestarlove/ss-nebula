import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { filesReady, openShell } from './harness/shell-fixtures';

/** Serious and critical axe violations on the page as it stands. */
async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.slice(0, 6).map((node) => `${node.target.join(' ')}: ${node.failureSummary?.split('\n').slice(1, 2).join(' ').trim()}`),
    }));
}

type State = { name: string; query?: string; storage?: Record<string, string>; phone?: boolean; open?: (page: Page) => Promise<void> };

const states: State[] = [
  { name: 'the workspace, night' },
  { name: 'the workspace, day, pane', storage: { 'nebula:theme': 'light', 'nebula:style': 'pane' } },
  { name: 'the project menu with the dock', storage: { 'nebula:dock': 'on' }, open: (page) => page.locator('.ws-switcher').click() },
  { name: 'the project right-click menu', open: (page) => page.locator('.ws-switcher').click({ button: 'right' }) },
  {
    name: 'a file’s right-click menu',
    open: (page) => page.locator('[data-path="Guides/Orion.md"] .page-sidebar-nav-label').click({ button: 'right' }),
  },
  {
    name: 'settings, appearance',
    open: async (page) => {
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('tab', { name: 'Appearance' }).click();
    },
  },
  {
    name: 'settings, project',
    open: async (page) => {
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('tab', { name: 'Project' }).click();
    },
  },
  {
    name: 'new project',
    open: async (page) => {
      await page.locator('.ws-switcher').click();
      await page.getByRole('menuitem', { name: 'New project' }).click();
    },
  },
  {
    name: 'quick open',
    open: async (page) => {
      await page.keyboard.press('Control+k');
      await page.getByRole('combobox').fill('or');
    },
  },
  { name: 'the welcome', query: 'intro=welcome&projects=1' },
  { name: 'the outline and a folded rail', open: async (page) => {
      await page.getByRole('button', { name: 'Outline' }).click();
      await page.keyboard.press('Control+Backslash');
    } },
  { name: 'nothing open, keeps nothing', query: 'persistent=0', open: async (page) => {
      for (let i = 0; i < 3; i += 1) await page.getByRole('tab').first().locator('.ws-tab-close').click();
    } },
  { name: 'phone, files sheet', phone: true, open: (page) => page.getByRole('button', { name: 'Files' }).first().click() },
  { name: 'phone, note, day', phone: true, storage: { 'nebula:theme': 'light' } },
];

for (const state of states) {
  test(`axe: ${state.name}`, async ({ page }) => {
    if (state.phone) await page.setViewportSize({ width: 390, height: 844 });
    await openShell(page, state.query ?? 'view=probe', state.storage ?? {});
    if (!state.query?.includes('intro')) await filesReady(page);
    await state.open?.(page);
    await page.waitForTimeout(400);
    expect(await seriousViolations(page)).toEqual([]);
  });
}
