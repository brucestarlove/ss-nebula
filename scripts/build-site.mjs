#!/usr/bin/env node
// Build the deployable Nebula site: the local-first app itself, served at /.
// vercel.json sends the old /app URLs to the same paths at the root, and
// `pnpm run dev:site` previews the result with the same routing.
// `pnpm build` stays the standalone app build used for local validation.

import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
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
        appMount: '/',
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  )
}

rmSync(SITE_DIR, { recursive: true, force: true })

// Vite copies public/ (icons, manifest, social image) into the output itself.
// The chunk report (which modules each chunk holds) goes beside the site, not
// into it: e2e/app-budget.spec.ts reads it, and it isn't deployed.
execFileSync('pnpm', ['exec', 'vite', 'build', '--base=/', '--outDir', SITE_DIR, '--emptyOutDir'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, NEBULA_CHUNK_REPORT: join(ROOT, 'dist', 'site-chunks.json') },
})

writeSiteVersion()

console.log(`✓ site → ${SITE_DIR}`)
console.log('  /   the Nebula app (old /app links redirect here; see vercel.json)')
