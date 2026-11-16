#!/usr/bin/env node
// Build the deployable Nebula site: the landing page at / and the local-first
// app at /app. vercel.json routes them (2.0's
// /p/ and 1.x's /b/ links redirect into /app), and `pnpm run dev:site`
// previews the result with the same routing. `pnpm build` stays the
// standalone app build used for local validation, with the app at /.
//
// The app is built with base '/', as before, and its page renamed app.html:
// its assets, fonts and public files keep their addresses at the root, and
// the landing shares them (one cache for both). The landing is site/, built
// by vite.site.config.ts into the same folder.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const SITE_DIR = join(ROOT, 'dist', 'site')

function writeSiteVersion() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  writeFileSync(
    join(SITE_DIR, 'version.json'),
    `${JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        edition: 'site',
        appMount: '/app',
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  )
}

rmSync(SITE_DIR, { recursive: true, force: true })

// 1. The app. Vite copies public/ (icons, manifest, social image, the sample
// project's files) into the output itself. The chunk report (which modules
// each chunk holds) goes beside the site, not into it: e2e/app-budget.spec.ts
// reads it, and it isn't deployed.
execFileSync('pnpm', ['exec', 'vite', 'build', '--base=/', '--outDir', SITE_DIR, '--emptyOutDir'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, NEBULA_CHUNK_REPORT: join(ROOT, 'dist', 'site-chunks.json') },
})
renameSync(join(SITE_DIR, 'index.html'), join(SITE_DIR, 'app.html'))

// 2. The landing, into the same folder: index.html and assets/landing-*.
execFileSync('pnpm', ['exec', 'vite', 'build', '--config', 'vite.site.config.ts'], { cwd: ROOT, stdio: 'inherit' })
if (!existsSync(join(SITE_DIR, 'index.html'))) throw new Error('build-site: the landing (site/index.html) didn’t build')

writeSiteVersion()

// Help links it; the libraries' licences ask for their notices in every copy.
const licences = join(SITE_DIR, 'third-party-licenses.txt')
if (!existsSync(licences) || !/@excalidraw\/excalidraw/.test(readFileSync(licences, 'utf8'))) {
  throw new Error(`build-site: ${licences} is missing or doesn’t list Excalidraw (vite.config.ts build.license)`)
}

console.log(`✓ site → ${SITE_DIR}`)
console.log('  /      the landing page (site/)')
console.log('  /app   the Nebula app (2.0’s /p/ and 1.x’s /b/ links redirect into it; see vercel.json)')
