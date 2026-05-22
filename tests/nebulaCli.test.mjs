import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    expect(result.stdout).toContain('browser localStorage')
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
