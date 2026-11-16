import { expect, test } from './app-fixtures';

// The landing page at /: the first slide says
// what Nebula is and how to start, the deck steps through five slides with
// the address following, and the way into the app is one click. It runs on
// the built site or a deploy, under the site's Content-Security-Policy, with
// nothing fetched off the origin (the fixture's guard).

const SOURCE = 'https://github.com/brucestarlove/ss-nebula';

test('the first slide says what Nebula is and how to start, and Open Nebula opens the app', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText(/^Everything your project is made\sof, in one place\.$/);
  const steps = page.getByRole('list', { name: 'How to start' }).getByRole('listitem');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toContainText('Open Nebula.');
  await expect(steps.nth(1)).toContainText('Bring your files.');
  await expect(steps.nth(2)).toContainText('Link to them.');

  const open = page.locator('#what').getByRole('link', { name: 'Open Nebula' });
  await expect(open).toHaveAttribute('href', '/app');
  await open.click();
  await page.locator('.ws-root').waitFor({ timeout: 30_000 });
  expect(new URL(page.url()).pathname).toMatch(/^\/app(\/|$)/);
});

test('the deck steps by key, dot and arrow, and the address follows the slide', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('[data-slide]')).toHaveCount(5);
  const dot = (name: string) => page.locator('.dots').getByRole('button', { name });

  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/#files$/);
  await expect(page.locator('[data-announce]')).toHaveText('Slide 2 of 5: Every kind of file');
  await expect(dot('2 of 5: Every kind of file')).toHaveAttribute('aria-current', 'step');

  await dot('5 of 5: Private, and open source').click();
  await expect(page).toHaveURL(/#yours$/);
  await expect(page.locator('[data-next]')).toBeDisabled();
  await page.locator('[data-prev]').click();
  await expect(page).toHaveURL(/#orbit$/);

  // A link to a slide opens on it.
  await page.goto('about:blank');
  await page.goto('/#sessions');
  await expect(dot('3 of 5: Agent sessions, kept')).toHaveAttribute('aria-current', 'step');
});

test('the source, the licence and the privacy page are linked', async ({ page }) => {
  await page.goto('/#yours');
  await expect(page.locator('#yours').getByRole('link', { name: 'Read the source' })).toHaveAttribute('href', SOURCE);
  const legal = page.locator('.legal');
  await expect(legal.getByRole('link', { name: 'AGPL-3.0' })).toHaveAttribute('href', 'https://www.gnu.org/licenses/agpl-3.0.html');
  await expect(legal.getByRole('link', { name: 'Source' })).toHaveAttribute('href', SOURCE);
  await expect(legal.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', 'https://starscape.biz/privacy/#apps');
});

test('a 1.x board link that lands here goes on to the app', async ({ page }) => {
  await page.goto('/?board=demo&canvas=sketch');
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/app(\/|$)/);
  await page.locator('.ws-root').waitFor({ timeout: 30_000 });
});

test.describe('on a phone', () => {
  test.use({ appContext: { viewport: { width: 390, height: 844 }, hasTouch: true } });

  test('the slides read top to bottom, and nothing is wider than the screen', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#what').getByRole('link', { name: 'Open Nebula' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    const tops = await page.locator('[data-slide]').evaluateAll((slides) => slides.map((slide) => slide.getBoundingClientRect().top));
    expect(tops).toHaveLength(5);
    for (let n = 1; n < tops.length; n += 1) expect(tops[n]).toBeGreaterThan(tops[n - 1]);
  });
});
