import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { closeIntro, currentProjectId, expect, openApp, saved, seedLocalStorage, storedText, test } from './app-fixtures';

// The note editor's live preview on the production build (lane EDITOR,
// part 1): the sample's Observing plan, edited. What the page draws is
// decoration; what reaches the file is checked in OPFS, byte for byte.
//
// NEBULA_EDITOR_SHOTS=<folder> also saves screenshots of the edited note
// next to the reading view, day and night, at 1280 and 390 (Chromium).

const PLAN = 'Guides/Observing plan.md';

const SHOWCASE = [
  '## Seeing log',
  '',
  'Transparency was **good**, the seeing _fair_, and ~~clouds~~ none; the `f/5` scope at 40×. See [the forecast](https://example.com/forecast) #october',
  '',
  '1. Polar alignment',
  '2. Focus on Capella',
  '   - with the Bahtinov mask, a long line that wraps on a phone to show how it hangs',
  '',
  '> Seeing is the steadiness of the air; transparency its clearness.',
  '',
  '---',
  '',
  '| Object | Mag | Notes |',
  '|---|---|---|',
  '| M42 | 4.0 | Trapezium split |',
  '',
  '```js',
  'const dark = sunAltitude < -18; // astronomical night',
  '```',
  '',
  '### Next time',
  '',
  'Bring the dew heater.',
].join('\n');
const shots = process.env.NEBULA_EDITOR_SHOTS;

async function openPlan(page: Page) {
  await openApp(page);
  await closeIntro(page);
  await expect(page.locator('.ws-prose')).toContainText('Saturday, after moonset.');
}

async function edit(page: Page) {
  // Read or edit is remembered (2.0.4): a note opened after another was edited opens editing, and
  // pressing Edit then would take it back to reading.
  const button = page.locator('.ws-stage').getByRole('button', { name: 'Edit' });
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  const content = page.locator('.ws-cm-live .cm-content');
  await expect(content).toBeVisible({ timeout: 20_000 });
  return content;
}

/** The editor's line that holds `text`. */
function line(page: Page, text: string) {
  return page.locator('.ws-cm-live .cm-line', { hasText: text });
}

/** Puts the cursor `back` characters before the end of the line holding `text`. */
async function cursorInLine(page: Page, text: string, back: number) {
  const target = line(page, text);
  const box = (await target.boundingBox())!;
  await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
  await page.keyboard.press('End');
  for (let step = 0; step < back; step += 1) await page.keyboard.press('ArrowLeft');
}

test('a heading is drawn as a heading, and shows its ## with the cursor on it', async ({ page }) => {
  await openPlan(page);
  await edit(page);
  const heading = page.locator('.ws-cm-live .cm-line.ws-cm-h2', { hasText: 'Targets' });
  await expect(heading).toHaveText('Targets');
  const sizes = await heading.evaluate((element) => ({
    heading: parseFloat(getComputedStyle(element).fontSize),
    body: parseFloat(getComputedStyle(element.closest('.cm-content')!).fontSize),
  }));
  expect(sizes.heading).toBeGreaterThan(sizes.body * 1.3);
  await heading.click();
  await expect(heading).toHaveText('## Targets');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(heading).toHaveText('Targets');
});

test('a task’s checkbox ticks the task in the file, and nothing else', async ({ page }) => {
  await openPlan(page);
  const projectId = currentProjectId(page);
  const before = (await storedText(page, projectId, PLAN))!;
  expect(before).toContain('- [ ] The Pleiades (M45).');
  await edit(page);
  const box = page.locator('.ws-cm-live').getByRole('checkbox', { name: /The Pleiades/ });
  await expect(box).not.toBeChecked();
  await box.click();
  const after = before.replace('- [ ] The Pleiades (M45).', '- [x] The Pleiades (M45).');
  await expect.poll(() => storedText(page, projectId, PLAN), { timeout: 10_000 }).toBe(after);
  await expect(box).toBeChecked();
  // One change, undone in one step.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => storedText(page, projectId, PLAN), { timeout: 10_000 }).toBe(before);
});

test('typing continues a list, Enter on an empty bullet ends it, and the file is the Markdown typed', async ({ page }) => {
  await openPlan(page);
  const projectId = currentProjectId(page);
  const before = (await storedText(page, projectId, PLAN))!;
  await edit(page);
  // A line of words: the middle of the editor is the plan's drawing now (part 2), and a click there opens it.
  await line(page, 'Saturday, after moonset.').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- Red flashlight');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Thermos');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Clear skies.');
  await expect.poll(() => storedText(page, projectId, PLAN), { timeout: 10_000 }).toBe(`${before}\n- Red flashlight\n- Thermos\n\nClear skies.`);
  await saved(page);
  // The page draws the list it made.
  await expect(line(page, 'Red flashlight').locator('.ws-cm-bullet')).toHaveCount(1);
});

test('the cursor steps over a drawn list marker in one move, and Backspace after it removes the marker, not a hidden space', async ({ page }) => {
  await openPlan(page);
  const projectId = currentProjectId(page);
  const before = (await storedText(page, projectId, PLAN))!;
  const words = 'Andromeda (M31), before it drops into the trees.';
  await edit(page);
  // The cursor at the start of the task's words: its box is drawn.
  await cursorInLine(page, words, words.length);
  await expect(line(page, words).locator('input.ws-check')).toHaveCount(1);
  // One ArrowLeft goes past the box to the line's start, where its Markdown shows.
  await page.keyboard.press('ArrowLeft');
  await expect(line(page, words)).toHaveText(`- [ ] ${words}`);
  await page.keyboard.type('X');
  await expect.poll(() => storedText(page, projectId, PLAN), { timeout: 10_000 }).toBe(before.replace(`- [ ] ${words}`, `X- [ ] ${words}`));
  await page.keyboard.press('Backspace');
  await expect.poll(() => storedText(page, projectId, PLAN), { timeout: 10_000 }).toBe(before);

  // Backspace with the cursor just after the drawn box takes the box away.
  await cursorInLine(page, words, words.length);
  await expect(line(page, words).locator('input.ws-check')).toHaveCount(1);
  await page.keyboard.press('Backspace');
  await expect.poll(() => storedText(page, projectId, PLAN), { timeout: 10_000 }).not.toBe(before);
  const text = (await storedText(page, projectId, PLAN))!;
  expect(text).not.toContain('[ ]Andromeda');
  expect(text).toContain(`      ${words}`);
  await expect(line(page, words).locator('input.ws-check')).toHaveCount(0);
});

test('inline marks are hidden away from the cursor and shown when it touches the span, so Backspace removes what you see', async ({ page }) => {
  await openPlan(page);
  const projectId = currentProjectId(page);
  const before = (await storedText(page, projectId, PLAN))!;
  await edit(page);
  // A line of words: the middle of the editor is the plan's drawing now (part 2), and a click there opens it.
  await line(page, 'Saturday, after moonset.').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('Clouds by **midnight** maybe');
  await page.keyboard.press('ArrowUp');
  await expect(line(page, 'Clouds by')).toHaveText('Clouds by midnight maybe');
  // At the end of the line, then six steps left: the cursor reaches the span's edge, and its marks show.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  for (let step = 0; step < ' maybe'.length; step += 1) await page.keyboard.press('ArrowLeft');
  await expect(line(page, 'Clouds by')).toHaveText('Clouds by **midnight** maybe');
  await page.keyboard.press('Backspace');
  await expect.poll(() => storedText(page, projectId, PLAN), { timeout: 10_000 }).toBe(`${before}Clouds by **midnight* maybe`);
});

test('a web link opens only on a Ctrl/⌘-click, in a new tab that can’t reach back', async ({ page }) => {
  await openPlan(page);
  await page.evaluate(() => {
    const calls: unknown[][] = [];
    (window as unknown as { __opened: unknown[][] }).__opened = calls;
    window.open = (...args: unknown[]) => {
      calls.push(args);
      return null;
    };
  });
  await edit(page);
  // A line of words: the middle of the editor is the plan's drawing now (part 2), and a click there opens it.
  await line(page, 'Saturday, after moonset.').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('See [the chart](https://example.com/chart) tonight.');
  await page.keyboard.press('ArrowUp');
  const link = page.locator('.ws-cm-live .ws-link', { hasText: 'the chart' });
  await expect(line(page, 'See ')).toHaveText('See the chart tonight.');
  // A plain click puts the cursor in the link, which shows its Markdown.
  await link.click();
  await expect(line(page, 'See ')).toHaveText('See [the chart](https://example.com/chart) tonight.');
  expect(await page.evaluate(() => (window as unknown as { __opened: unknown[][] }).__opened)).toEqual([]);
  await page.keyboard.press('ArrowUp');
  await expect(line(page, 'See ')).toHaveText('See the chart tonight.');
  await link.click({ modifiers: ['ControlOrMeta'] });
  expect(await page.evaluate(() => (window as unknown as { __opened: unknown[][] }).__opened)).toEqual([['https://example.com/chart', '_blank', 'noopener,noreferrer']]);
});

test('a note over 200,000 characters opens as its source, with the bar', async ({ page }) => {
  await openPlan(page);
  const projectId = currentProjectId(page);
  // Make the long note through the app: a new note, then its text pasted in.
  await page.locator('.ws-section-actions').getByRole('button', { name: 'New note' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled.md' }).fill('Long log');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { selected: true })).toHaveText('Long log');
  const content = await edit(page);
  await content.click();
  const long = `${'Seeing steady. '.repeat(13_334)}`.slice(0, 200_001);
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    document.querySelector('.ws-cm-live .cm-content')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, long);
  await expect.poll(async () => (await storedText(page, projectId, 'Long log.md'))?.length, { timeout: 15_000 }).toBe(200_001);
  await page.reload();
  await page.locator('#loader').waitFor({ state: 'detached' });
  await expect(page.getByRole('tab', { selected: true })).toHaveText('Long log');
  await expect(page.locator('.ws-long-note')).toContainText('This note is long');
  await expect(page.locator('[data-testid="code-editor"] .cm-content')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.ws-cm-live')).toHaveCount(0);
});

test('reading a note fetches no CodeMirror; Edit fetches the editor’s chunk', async ({ page }) => {
  const report = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'dist', 'site-chunks.json'), 'utf8')) as { chunks: Record<string, { modules: Record<string, number> }> };
  const holding = (pattern: RegExp) => Object.entries(report.chunks).filter(([, chunk]) => Object.keys(chunk.modules).some((id) => pattern.test(id))).map(([file]) => file);
  const editorChunks = holding(/^src\/workspace\/views\/note\/editor\/NoteEditor\.tsx$/);
  const codeMirror = holding(/(^|\/)node_modules\/(@codemirror|codemirror|@lezer)\//);
  expect(editorChunks).toHaveLength(1);
  const fetched: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname.slice(1);
    if (path.endsWith('.js')) fetched.push(path);
  });
  await openPlan(page);
  await page.waitForLoadState('networkidle');
  expect(fetched.filter((file) => codeMirror.includes(file) || editorChunks.includes(file))).toEqual([]);
  await edit(page);
  await page.waitForLoadState('networkidle');
  expect(fetched).toContain(editorChunks[0]);
});

/** Types a phrase and times each key, from keydown to the frame after its text is drawn. */
async function typingTimes(page: Page) {
  await page.evaluate(() => {
    const times: number[] = [];
    (window as unknown as { __latency: number[] }).__latency = times;
    const content = document.querySelector('.ws-cm-live .cm-content')!;
    content.addEventListener(
      'keydown',
      () => {
        const start = performance.now();
        const observer = new MutationObserver(() => {
          observer.disconnect();
          requestAnimationFrame(() => times.push(performance.now() - start));
        });
        observer.observe(content, { childList: true, subtree: true, characterData: true });
      },
      true,
    );
  });
  await page.keyboard.type('Clear and dark until three ', { delay: 60 });
  const times = await page.evaluate(() => (window as unknown as { __latency: number[] }).__latency);
  const sorted = [...times].sort((a, b) => a - b);
  const at = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
  return { keys: times.length, median: at(0.5), p95: at(0.95), max: Math.round(sorted.at(-1) ?? 0) };
}

test('typing in a 150,000-character note is as quick as in a short one', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await openPlan(page);
  await edit(page);
  // A line of words: the middle of the editor is the plan's drawing now (part 2), and a click there opens it.
  await line(page, 'Saturday, after moonset.').click();
  await page.keyboard.press('ControlOrMeta+End');
  const short = await typingTimes(page);

  await page.locator('.ws-section-actions').getByRole('button', { name: 'New note' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled.md' }).fill('Night log');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { selected: true })).toHaveText('Night log');
  const content = await edit(page);
  await content.click();
  const block = [
    '## Session',
    '',
    'Seeing was **steady** after midnight, and _the field_ stayed sharp; see [the chart](https://example.com/chart) and #october.',
    '',
    '- [x] Orion Nebula (M42)',
    '- [ ] The Pleiades (M45)',
    '  - Binoculars first',
    '',
    '> Give your eyes twenty minutes.',
    '',
    '',
  ].join('\n');
  const long = block.repeat(Math.ceil(150_000 / block.length)).slice(0, 150_000);
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    document.querySelector('.ws-cm-live .cm-content')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, long);
  await expect(page.locator('.ws-cm-live')).toBeVisible();
  // Into the middle of the note, then type.
  await page.keyboard.press('ControlOrMeta+Home');
  for (let step = 0; step < 40; step += 1) await page.keyboard.press('PageDown');
  const big = await typingTimes(page);

  const summary = { short, long: big };
  console.log(`typing, ms from keydown to the frame after: ${JSON.stringify(summary)}`);
  await testInfo.attach('latency', { body: JSON.stringify(summary), contentType: 'application/json' });
  expect(big.keys).toBeGreaterThan(20);
  // Typically 16-19 ms for both (one frame is about 16). Drawing the whole note instead of
  // what's on screen made the long note's median 88 ms against 16-19: this catches that,
  // and a busy host slows both alike.
  expect(big.median).toBeLessThan(short.median * 2 + 10);
});

test.describe('at phone width', () => {
  test.use({ appContext: { viewport: { width: 390, height: 844 }, hasTouch: true } });

  test('nothing scrolls sideways, a box takes a tap, and typing keeps the cursor above the keyboard and the bar', async ({ page }) => {
    await openPlan(page);
    const projectId = currentProjectId(page);
    const before = (await storedText(page, projectId, PLAN))!;
    await edit(page);
    const overflow = () =>
      page.evaluate(() =>
        [document.documentElement, ...document.querySelectorAll('.ws-stage, .ws-note, .ws-page, .cm-scroller')]
          .filter((element) => element.scrollWidth > element.clientWidth + 1)
          .map((element) => `${element.className}: ${element.scrollWidth} > ${element.clientWidth}`),
      );
    expect(await overflow()).toEqual([]);

    await page.locator('.ws-cm-live').getByRole('checkbox', { name: /Andromeda/ }).tap();
    await expect.poll(() => storedText(page, projectId, PLAN), { timeout: 10_000 }).toBe(before.replace('- [ ] Andromeda', '- [x] Andromeda'));

    // The on-screen keyboard takes the lower half of the screen.
    await page.setViewportSize({ width: 390, height: 420 });
    await page.locator('.ws-cm-live .cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    for (let n = 1; n <= 12; n += 1) {
      await page.keyboard.press('Enter');
      await page.keyboard.type(`Line ${n} of what the night was like`);
      const cursor = (await page.locator('.ws-cm-live .cm-cursor-primary').boundingBox())!;
      const bar = await page.locator('.ws-phone-bar').boundingBox();
      const limit = bar ? bar.y : 420;
      expect(cursor.y + cursor.height, `line ${n}`).toBeLessThanOrEqual(limit);
      expect(cursor.y, `line ${n}`).toBeGreaterThanOrEqual(0);
    }
    expect(await overflow()).toEqual([]);
  });

  test('a task’s box is a finger-sized target', async ({ page }) => {
    await openPlan(page);
    const projectId = currentProjectId(page);
    const before = (await storedText(page, projectId, PLAN))!;
    await edit(page);
    const box = (await page.locator('.ws-cm-live').getByRole('checkbox', { name: /Pleiades/ }).boundingBox())!;
    // Just off the 17 px box, below and to its right (the page's edge is to its
    // left at this width): still the box. Chromium moves such a tap onto the box
    // by itself; WebKit doesn't, so the box's wrapper is the target.
    await page.touchscreen.tap(box.x + box.width + 3, box.y + box.height + 4);
    await expect.poll(() => storedText(page, projectId, PLAN), { timeout: 10_000 }).toBe(before.replace('- [ ] The Pleiades', '- [x] The Pleiades'));
  });
});

test.describe('with reduced motion', () => {
  test.use({ appContext: { reducedMotion: 'reduce' } });

  test('the cursor doesn’t blink', async ({ page }) => {
    await openPlan(page);
    await edit(page);
    // A line of words: the middle of the editor is the plan's drawing now (part 2), and a click there opens it.
    await line(page, 'Saturday, after moonset.').click();
    const animation = await page.locator('.ws-cm-live .cm-cursorLayer').evaluate((layer) => getComputedStyle(layer).animationName);
    expect(animation).toBe('none');
  });
});

for (const width of [1280, 390]) {
  for (const theme of ['day', 'night'] as const) {
    test.describe(`screenshots, ${width} ${theme}`, () => {
      test.use({ appContext: { viewport: { width, height: width === 390 ? 844 : 900 }, hasTouch: width === 390 } });

      test(`the note read and edited, ${width} ${theme}`, async ({ page, context, browserName }) => {
        test.skip(!shots || browserName !== 'chromium', 'Screenshots: set NEBULA_EDITOR_SHOTS to a folder; Chromium only.');
        mkdirSync(shots!, { recursive: true });
        await seedLocalStorage(context, { 'nebula:theme': theme === 'night' ? 'dark' : 'light' });
        await openPlan(page);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: join(shots!, `read-${width}-${theme}.png`), animations: 'disabled', caret: 'hide' });
        await edit(page);
        // The cursor on the first target, so one line shows its Markdown.
        await cursorInLine(page, 'Orion Nebula', 5);
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(shots!, `edit-${width}-${theme}.png`), animations: 'disabled' });

        // Every block live preview draws, pasted at the end, the cursor after it.
        await page.keyboard.press('ControlOrMeta+End');
        await page.evaluate((text) => {
          const data = new DataTransfer();
          data.setData('text/plain', text);
          document.querySelector('.ws-cm-live .cm-content')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        }, SHOWCASE);
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(shots!, `showcase-${width}-${theme}.png`), animations: 'disabled', fullPage: false });
      });
    });
  }
}
