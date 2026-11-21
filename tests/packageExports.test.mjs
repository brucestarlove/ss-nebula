// @vitest-environment node
// Every `exports` subpath of the package resolves from a packed tarball with no dependencies and no
// peers. The Suite imports Nebula by these names, so the test packs the package as npm would
// (`npm pack --ignore-scripts`), unpacks it into a scratch `node_modules/@starlove/nebula` beside
// nothing else, and imports each subpath there. A new file under cli/ that one of them imports must
// be in the tarball (package.json's `files` lists `cli`), or the import fails here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
let scratch = ''
let installed = ''
let tarballFiles = []

/** What each subpath must give a host: a name or two it imports. */
const EXPECTED = {
  './app': ['createNebulaApp'],
  './files': ['createFilesApi', 'signedOut', 'API', 'serverPerson'],
  './backend': ['BackendError', 'META_PATH', 'ID_PATTERN'],
  './backends/database': ['createDatabaseBackend', 'SCHEMA_VERSION'],
  './bytes/store': ['newObjectId', 'OBJECT_ID', 'MissingObjectError'],
  './bytes/folder': ['createFolderByteStore'],
  './conformance/bytes': ['register', 'byteStoreCases'],
  './conformance/backend': ['register', 'backendCases'],
}

function filesUnder(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name), base) : [relative(base, join(dir, entry.name))]))
}

beforeAll(() => {
  scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'nebula-pack-'))
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], { cwd: root, encoding: 'utf8', timeout: 120_000 }))
  const tarball = join(scratch, packed[0].filename)
  tarballFiles = packed[0].files.map((file) => file.path)
  installed = join(scratch, 'node_modules', '@starlove', 'nebula')
  mkdirSync(installed, { recursive: true })
  execFileSync('tar', ['-xzf', tarball, '-C', installed, '--strip-components=1'])
}, 180_000)

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** Imports a specifier by the package's name from a consumer beside nothing else. */
function importFromConsumer(specifier) {
  const consumer = join(scratch, 'consumer.mjs')
  writeFileSync(consumer, `const module = await import(${JSON.stringify(`@starlove/nebula${specifier.slice(1)}`)}, ${specifier === './package.json' ? "{ with: { type: 'json' } }" : '{}'})\nconsole.log(JSON.stringify(Object.keys(module)))\n`)
  const run = spawnSync(process.execPath, [consumer], { cwd: scratch, encoding: 'utf8' })
  return { status: run.status, stderr: run.stderr, names: run.status === 0 ? JSON.parse(run.stdout.trim().split('\n').at(-1)) : [] }
}

describe('the packed package', () => {
  it('has no dependencies and no peers, so the Suite brings nothing with it', () => {
    const packed = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
    for (const key of ['dependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies']) expect(packed[key], key).toBeUndefined()
    expect(Object.keys(packed.exports).sort()).toEqual(Object.keys(pkg.exports).sort())
    // The consumer's node_modules holds this package and nothing else.
    expect(readdirSync(join(scratch, 'node_modules'))).toEqual(['@starlove'])
    expect(readdirSync(join(scratch, 'node_modules', '@starlove'))).toEqual(['nebula'])
  })

  it('carries every file of cli/ the repo has: a file one export imports can’t be left out', () => {
    const inRepo = filesUnder(join(root, 'cli'), root).sort()
    const shipped = tarballFiles.filter((file) => file.startsWith('cli/')).sort()
    expect(shipped).toEqual(inRepo)
    expect(tarballFiles).toContain('bin/nebula.mjs')
  })

  for (const [subpath, names] of Object.entries(EXPECTED)) {
    it(`imports ${subpath} from the tarball by the package's name`, () => {
      const result = importFromConsumer(subpath)
      expect(result.status, result.stderr).toBe(0)
      for (const name of names) expect(result.names, name).toContain(name)
    })
  }

  it('imports ./package.json, and every subpath package.json lists is one of these', () => {
    const result = importFromConsumer('./package.json')
    expect(result.status, result.stderr).toBe(0)
    expect(Object.keys(pkg.exports).sort()).toEqual([...Object.keys(EXPECTED), './package.json'].sort())
  })

  it('refuses a path package.json doesn’t export (a file outside the list is not a way in)', () => {
    const result = importFromConsumer('./cli/backends/folder.mjs')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('ERR_PACKAGE_PATH_NOT_EXPORTED')
  })
})
