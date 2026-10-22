import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const binPath = join(root, 'bin', 'nebula.mjs')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tempDirs = []
const servers = []

function runCli(args) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: root,
    encoding: 'utf8',
  })
}

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()
    await new Promise((resolveClose) => server.close(resolveClose))
  }

  while (tempDirs.length) {
    rmSync(tempDirs.pop(), { recursive: true, force: true })
  }
})

describe('Nebula CLI', () => {
  it('exposes a nebula bin command in the npm package', () => {
    expect(pkg.bin).toEqual({ nebula: './bin/nebula.mjs' })
  })

  it('prints help through --help and help without starting a server', () => {
    for (const args of [['--help'], ['help']]) {
      const result = runCli(args)

      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain('Usage: nebula <command>')
      expect(result.stdout).toContain('Hosted Nebula: open the hosted URL; no install or npm required.')
      expect(result.stdout).toContain('nebula run')
      expect(result.stdout).toContain('nebula serve')
      expect(result.stdout).toContain('alias for run')
      expect(result.stdout).toContain('nebula init')
    }
  })

  it('prints the package version through -v and --version', () => {
    for (const args of [['-v'], ['--version']]) {
      const result = runCli(args)

      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout.trim()).toBe(pkg.version)
    }
  })

  it('keeps init as a no-config validation path until Nebula needs real config', () => {
    const result = runCli(['init'])

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('No Nebula config is required yet.')
    expect(result.stdout).toContain('(OPFS)')
  })

  it('says where 2.0 keeps projects: in the browser, apart for each address, not in localStorage', () => {
    const help = runCli(['help']).stdout

    expect(help).toContain('origin private file system (OPFS)')
    expect(help).toContain('http://127.0.0.1:4321')
    expect(help).not.toContain('localStorage')
    expect(runCli(['init']).stdout).not.toContain('localStorage')
  })

  it('builds the packaged app for the root of the server that serves it, so a file’s address reloads', () => {
    expect(pkg.scripts['build:cli-app']).toContain('--base=/ ')
  })

  it('serves the app for a file’s address whatever its extension, as the site does', async () => {
    const { startNebulaStaticServer } = await import('../cli/nebula-cli.mjs')
    const staticRoot = mkdtempSync(join(tmpdir(), 'nebula-cli-routes-'))
    tempDirs.push(staticRoot)
    writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>Nebula Local</title><main>Nebula smoke</main>')
    mkdirSync(join(staticRoot, 'sample'))
    writeFileSync(join(staticRoot, 'sample', 'star-chart.pdf'), '%PDF-1.7')

    const server = await startNebulaStaticServer({ host: '127.0.0.1', port: 0, root: staticRoot, silent: true })
    servers.push(server.server)

    for (const path of ['/p/night-sky/Guides/Observing%20plan.md', '/p/night-sky/Sketches/Winter%20hexagon.excalidraw.md', '/b/ss-nebula/c/main']) {
      const response = await fetch(`${server.url}${path.slice(1)}`)
      expect(response.status, path).toBe(200)
      expect(await response.text(), path).toContain('Nebula smoke')
    }

    const pdf = await fetch(`${server.url}sample/star-chart.pdf`)
    expect(pdf.status).toBe(200)
    expect(pdf.headers.get('content-type')).toBe('application/pdf')

    // A missing file outside those addresses is still missing, not the app.
    expect((await fetch(`${server.url}assets/missing.js`)).status).toBe(404)
  })

  it('serves a local-first static app and falls back app routes to index.html', async () => {
    const { startNebulaStaticServer } = await import('../cli/nebula-cli.mjs')
    const staticRoot = mkdtempSync(join(tmpdir(), 'nebula-cli-smoke-'))
    tempDirs.push(staticRoot)
    writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>Nebula Local</title><main>Nebula smoke</main>')

    const server = await startNebulaStaticServer({ host: '127.0.0.1', port: 0, root: staticRoot, silent: true })
    servers.push(server.server)

    const rootResponse = await fetch(server.url)
    expect(rootResponse.status).toBe(200)
    expect(await rootResponse.text()).toContain('Nebula smoke')

    const appResponse = await fetch(`${server.url}/app/`)
    expect(appResponse.status).toBe(200)
    expect(await appResponse.text()).toContain('Nebula smoke')
  })
})
