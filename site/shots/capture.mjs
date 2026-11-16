#!/usr/bin/env node
// Renders of the app for the landing page (site/index.html), made from the
// demo project in site/demo/. Run it against the dev server, which lets the
// page import Nebula's own modules to fill the project:
//
//   pnpm exec vite --host 127.0.0.1 --port 4344 --strictPort      # one shell
//   node site/shots/capture.mjs [http://127.0.0.1:4344]           # another
//
// It writes PNGs at twice the size they're shown into $NEBULA_SHOTS_RAW (a
// scratch folder by default); site/shots/encode.py makes the .webp files the
// landing uses. Rerun both whenever the app's look changes.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const require = createRequire(join(ROOT, 'package.json'))
const { chromium } = require('@playwright/test')

const BASE = (process.argv[2] ?? 'http://127.0.0.1:4344').replace(/\/$/, '')
const DEMO = join(ROOT, 'site', 'demo')
const OUT = process.env.NEBULA_SHOTS_RAW ?? join(tmpdir(), 'nebula-shots-raw')
mkdirSync(OUT, { recursive: true })

/** The demo project's files: site/demo/ as it is, plus Starscape's own art from public/. */
function demoFiles() {
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else files.push({ path: relative(DEMO, path), source: path })
    }
  }
  walk(DEMO)
  const art = {
    'Concept art/Nebula key art.png': 'public/ss-nebula-bg-wide.png',
    'Concept art/Pole star.png': 'public/Starscape-Star.png',
    'Inspiration/Starscape banner.jpg': 'public/Starscape-Banner.jpg',
    'Inspiration/Winter hexagon.png': 'public/sample/winter-hexagon.png',
    'Inspiration/Star chart.pdf': 'public/sample/star-chart.pdf',
  }
  for (const [path, source] of Object.entries(art)) files.push({ path, source: join(ROOT, source) })
  const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.pdf': 'application/pdf' }
  return files.map(({ path, source }) => {
    const type = types[extname(path).toLowerCase()]
    return type ? { path, type, b64: readFileSync(source).toString('base64') } : { path, text: readFileSync(source, 'utf8') }
  })
}

async function seed(page, files) {
  await page.evaluate(async (files) => {
    const { openBrowserRegistry } = await import('/src/files/opfsRegistry.ts')
    const { registry } = await openBrowserRegistry()
    const project = await registry.create({ name: 'Starscape', color: '#a78bfa', id: 'starscape' })
    const store = await registry.files(project.id)
    for (const file of files) {
      if ('text' in file) await store.write(file.path, file.text)
      else await store.write(file.path, new Blob([Uint8Array.from(atob(file.b64), (c) => c.charCodeAt(0))], { type: file.type }))
    }
  }, files)
}

const row = (page, path) => page.locator(`.ws-filetree [role="treeitem"][data-path="${path}"]`)

async function ready(page) {
  await page.locator('.ws-root').waitFor({ timeout: 30_000 })
  await page.locator('#loader').waitFor({ state: 'detached', timeout: 15_000 })
  await page.evaluate(() => document.fonts.ready)
}

async function open(page, path) {
  await row(page, path).click()
  await page.waitForTimeout(400)
}

async function expand(page, folder) {
  const item = row(page, folder)
  if ((await item.getAttribute('aria-expanded')) !== 'true') await item.click()
}

async function shot(page, name, theme) {
  await page.waitForTimeout(900)
  const file = join(OUT, `${name}-${theme}.png`)
  writeFileSync(file, await page.screenshot({ type: 'png' }))
  console.log(`✓ ${file}`)
}

const profile = mkdtempSync(join(tmpdir(), 'nebula-shots-'))
const context = await chromium.launchPersistentContext(profile, {
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
})
try {
  const page = context.pages()[0] ?? (await context.newPage())
  // Kept, as an installed or often-used site would be: the rail says so in green.
  const cdp = await context.newCDPSession(page)
  await cdp.send('Browser.grantPermissions', { origin: BASE, permissions: ['durableStorage'] })
  // No sample project and no welcome: the demo project is the only one.
  await context.addInitScript(() => {
    if (!localStorage.getItem('nebula:setup')) localStorage.setItem('nebula:setup', new Date().toISOString())
  })
  const boxes = {}
  for (const theme of ['night', 'day']) {
    await page.evaluate((value) => localStorage.setItem('nebula:theme', value), theme === 'night' ? 'dark' : 'light').catch(() => {})
    await page.goto(`${BASE}/`)
    await page.evaluate((value) => localStorage.setItem('nebula:theme', value), theme === 'night' ? 'dark' : 'light')
    if (theme === 'night') {
      await ready(page)
      await seed(page, demoFiles())
    }
    await page.goto(`${BASE}/`)
    await ready(page)

    // The workspace: art open, sessions and designs beside it.
    for (const folder of ['Agent sessions', 'Concept art', 'Designs']) await expand(page, folder)
    await open(page, 'Designs/Star map.excalidraw.md')
    await open(page, 'Agent sessions/2026-10-26 14.05 Landing page plan.md')
    await open(page, 'Concept art/Nebula key art.png')
    await shot(page, 'workspace', theme)

    // An agent session, pasted as a note, open under the menus below.
    await open(page, 'Agent sessions/2026-10-25 16.40 Image conversion.md')

    // Paste as note, from a folder's menu. The menu's box goes to boxes.json,
    // so encode.py can crop to it.
    await row(page, 'Agent sessions').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Paste as note' }).hover()
    boxes[`paste-${theme}`] = await page.getByRole('menu').first().boundingBox()
    await shot(page, 'paste', theme)
    await page.keyboard.press('Escape')

    // Copy link, from a folder's menu.
    await row(page, 'Concept art').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy link' }).hover()
    boxes[`link-${theme}`] = await page.getByRole('menu').first().boundingBox()
    await shot(page, 'link', theme)
    await page.keyboard.press('Escape')

    // A canvas.
    await open(page, 'Designs/Star map.excalidraw.md')
    await page.locator('.excalidraw').first().waitFor({ timeout: 30_000 })
    await shot(page, 'canvas', theme)
  }
  writeFileSync(join(OUT, 'boxes.json'), `${JSON.stringify(boxes, null, 1)}\n`)
} finally {
  await context.close()
  rmSync(profile, { recursive: true, force: true })
}
