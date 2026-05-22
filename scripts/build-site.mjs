#!/usr/bin/env node
// Assemble the Vercel-style Nebula site: marketing at / and the local-first
// Vite app mounted at /app/. This mirrors Orbit's deployed-site shape while
// keeping Nebula's normal `pnpm build` target as the standalone app build.

import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const DIST_DIR = join(ROOT, 'dist')
const SITE_DIR = join(DIST_DIR, 'site')
const APP_DIR = join(SITE_DIR, 'app')
const PUBLIC_DIR = join(ROOT, 'public')
const MARKETING_HTML = join(ROOT, 'site', 'index.html')

function copyPublicAssetsToSiteRoot() {
  if (!existsSync(PUBLIC_DIR)) return
  for (const entry of readdirSync(PUBLIC_DIR)) {
    const src = join(PUBLIC_DIR, entry)
    const dest = join(SITE_DIR, entry)
    if (statSync(src).isDirectory()) {
      cpSync(src, dest, { recursive: true })
    } else {
      cpSync(src, dest)
    }
  }
}

function rewriteAppIndexForSubpath() {
  const appIndexPath = join(APP_DIR, 'index.html')
  let html = readFileSync(appIndexPath, 'utf8')

  // Vite intentionally leaves /public references alone. The /app/ build should
  // be self-contained under /app/ for deploy previews and static hosts, while
  // the marketing root also receives a copy of the same public assets.
  html = html.replace(
    /(href|src|content)="\/(ss-nebula-[^"]+|ss-nebula\.png|ss-nebula-og\.png|site\.webmanifest|favicon(?:-[^"]+)?\.png|favicon\.ico|apple-touch-icon\.png|android-chrome-[^"]+\.png|Starscape-[^"]+)"/g,
    '$1="/app/$2"',
  )

  writeFileSync(appIndexPath, html)
}

function writeSiteVersion() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  writeFileSync(
    join(SITE_DIR, 'version.json'),
    `${JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        edition: 'site',
        appMount: '/app/',
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  )
}

if (!existsSync(MARKETING_HTML)) {
  throw new Error(`Missing ${MARKETING_HTML}`)
}

rmSync(SITE_DIR, { recursive: true, force: true })
mkdirSync(SITE_DIR, { recursive: true })

execFileSync(
  'pnpm',
  ['exec', 'vite', 'build', '--base=/app/', '--outDir', APP_DIR, '--emptyOutDir'],
  { cwd: ROOT, stdio: 'inherit' },
)

const marketingHtml = readFileSync(MARKETING_HTML, 'utf8')
writeFileSync(join(SITE_DIR, 'index.html'), marketingHtml)
writeFileSync(join(SITE_DIR, 'install.html'), marketingHtml)
writeFileSync(join(SITE_DIR, 'support.html'), marketingHtml)
copyPublicAssetsToSiteRoot()
rewriteAppIndexForSubpath()
writeSiteVersion()

console.log(`✓ site → ${SITE_DIR}`)
console.log('  /         marketing landing')
console.log('  /app/     local-first Nebula app')
