import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveSiteHeaders, resolveSiteRequest, startSiteServer } from '../serve-site.mjs'

// The deployed site: the landing page at / and the app at /app. These tests read the real routes.json through the
// same resolver `pnpm run dev:site` and the tailnet copy serve with, so the
// local preview and the config can't drift apart.
const root = resolve(import.meta.dirname, '..')
const config = JSON.parse(readFileSync(join(root, 'routes.json'), 'utf8'))

const files = new Set(['/index.html', '/app.html', '/ss-nebula-og.png', '/site.webmanifest', '/assets/index-abc123.js'])
const exists = (pathname) => files.has(pathname)

function follow(url, maxHops = 5) {
  const hops = []
  let current = url
  for (let i = 0; i <= maxHops; i += 1) {
    const result = resolveSiteRequest(config, current, exists)
    if (result.type !== 'redirect') return { ...result, url: current, hops }
    hops.push(result.status)
    current = result.location
    if (/^https?:\/\//.test(current)) return { type: 'external', url: current, hops }
  }
  throw new Error(`more than ${maxHops} redirects from ${url}`)
}

describe('nebula.starscape.app routing', () => {
  it('serves the landing page at the root', () => {
    expect(follow('/')).toMatchObject({ type: 'file', file: '/index.html', hops: [] })
  })

  it('serves the app at /app, and /app/ there too', () => {
    expect(follow('/app')).toMatchObject({ type: 'file', file: '/app.html', hops: [] })
    expect(follow('/app/')).toMatchObject({ type: 'file', file: '/app.html', url: '/app' })
  })

  it('keeps the query string on the way into the app', () => {
    expect(follow('/app/?board=demo&canvas=sketch')).toMatchObject({ type: 'file', file: '/app.html', url: '/app?board=demo&canvas=sketch' })
  })

  it('serves file and folder links (/app/p/<project>/<path>) from the app', () => {
    for (const url of ['/app/p/k3v9x2m1qa', '/app/p/k3v9x2m1qa/Guides/Observing%20plan.md', '/app/p/k3v9x2m1qa/Charts/Star%20chart%20%E2%80%94%20October.pdf', '/app/p/k3v9x2m1qa/Concept%20art']) {
      expect(follow(url)).toMatchObject({ type: 'file', file: '/app.html', hops: [] })
    }
  })

  it('sends 2.0’s links (/p/…) into the app and 1.x’s (/b/…) to its front door, with temporary redirects', () => {
    // Temporary: 2.0 sent /app permanently to /, and a browser that cached that
    // must not be taught another permanent move.
    expect(follow('/p/k3v9x2m1qa/README.md')).toMatchObject({ type: 'file', file: '/app.html', url: '/app/p/k3v9x2m1qa/README.md', hops: [307] })
    expect(follow('/p/k3v9x2m1qa')).toMatchObject({ type: 'file', file: '/app.html', url: '/app/p/k3v9x2m1qa', hops: [307] })
    expect(follow('/b/demo/c/sketch')).toMatchObject({ type: 'file', file: '/app.html', url: '/app', hops: [307] })
    expect(follow('/app/b/demo/c/sketch')).toMatchObject({ type: 'not-found' })
  })

  it('keeps 1.x’s social image address working', () => {
    expect(follow('/app/ss-nebula-og.png')).toMatchObject({ type: 'file', file: '/ss-nebula-og.png', hops: [307] })
  })

  it('sends /install to the landing and /support to Starscape’s feedback form, with temporary redirects', () => {
    expect(follow('/install')).toMatchObject({ type: 'file', file: '/index.html', url: '/', hops: [307] })
    expect(follow('/support')).toEqual({
      type: 'external',
      url: 'https://starscape.app/#feedback',
      hops: [307],
    })
  })

  it('never redirects permanently, except a trailing slash', () => {
    for (const rule of config.redirects) expect(rule.permanent, rule.source).toBe(false)
  })

  it('answers unknown paths with a 404 rather than the app', () => {
    expect(follow('/no-such-page')).toMatchObject({ type: 'not-found' })
  })

  it('caches only the hashed build assets as immutable', () => {
    const immutable = (config.headers ?? []).filter((rule) =>
      rule.headers.some((header) => /immutable/.test(header.value)),
    )
    expect(immutable.map((rule) => rule.source)).toEqual(['/assets/(.*)'])
  })
})

/** The policy as a map of directive → sources. */
function parsePolicy(header) {
  return Object.fromEntries(
    header
      .split(';')
      .map((directive) => directive.trim())
      .filter(Boolean)
      .map((directive) => {
        const [name, ...sources] = directive.split(/\s+/)
        return [name, sources]
      }),
  )
}

const policy = () => parsePolicy(resolveSiteHeaders(config, '/')['content-security-policy'] ?? '')

/** sha256 sources for the inline <script> or <style> elements of index.html. */
function inlineHashes(tag) {
  const html = readFileSync(join(root, 'index.html'), 'utf8')
  return [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map(
    (match) => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`,
  )
}

describe('nebula.starscape.app headers', () => {
  it('says the licences file is UTF-8, so its quotes and names read right', () => {
    // Cloudflare sends .txt as text/plain with no charset (seen 2026-10-25), and the file has “ ” and accents.
    expect(resolveSiteHeaders(config, '/third-party-licenses.txt')['content-type']).toBe('text/plain; charset=utf-8')
  })

  it('sends the same security headers with pages, links and files', () => {
    for (const url of ['/', '/app', '/app/p/k3v9x2m1qa/Guides/Observing%20plan.md', '/app/b/demo/c/sketch', '/assets/index-abc123.js', '/fonts/Excalifont/Excalifont-Regular.woff2']) {
      const headers = resolveSiteHeaders(config, url)
      expect(headers['content-security-policy'], url).toMatch(/^default-src 'self'/)
      expect(headers['x-content-type-options'], url).toBe('nosniff')
      expect(headers['referrer-policy'], url).toBe('strict-origin-when-cross-origin')
      // Vercel added HSTS by itself; Cloudflare only sends what it's told (2026-10-25).
      expect(headers['strict-transport-security'], url).toBe('max-age=63072000')
    }
  })

  it('marks only the hashed build assets immutable', () => {
    expect(resolveSiteHeaders(config, '/assets/index-abc123.js')['cache-control']).toBe('public, max-age=31536000, immutable')
    for (const url of ['/', '/index.html', '/fonts/Virgil/Virgil-Regular.woff2', '/sample/star-chart.pdf']) {
      expect(resolveSiteHeaders(config, url)['cache-control'], url).toBeUndefined()
    }
  })
})

describe('the content security policy', () => {
  it('allows this site only, unless a directive says otherwise', () => {
    expect(policy()['default-src']).toEqual(["'self'"])
    expect(policy()['base-uri']).toEqual(["'self'"])
    expect(policy()['form-action']).toEqual(["'self'"])
    expect(policy()['frame-ancestors']).toEqual(["'self'"])
    expect(policy()['object-src']).toEqual(["'none'"])
  })

  it('runs only this site’s scripts, plus index.html’s inline ones by hash; no eval', () => {
    const scripts = policy()['script-src']
    expect(inlineHashes('script').length).toBeGreaterThan(0)
    expect(scripts).toEqual(["'self'", ...inlineHashes('script'), "'wasm-unsafe-eval'"])
  })

  it('loads fonts from this site only: Excalidraw’s are served from /fonts/', () => {
    expect(policy()['font-src']).toEqual(["'self'"])
  })

  it('allows inline styles, which Excalidraw’s Mermaid import needs', () => {
    // Mermaid lays the diagram out with <style> elements and style attributes:
    // with them blocked (102 of them) the boxes and labels it hands
    // Excalidraw come out the wrong size. A hash here would switch
    // 'unsafe-inline' off, so the splash's <style> needs none.
    expect(policy()['style-src']).toEqual(["'self'", "'unsafe-inline'"])
  })

  it('connects to this site and the two Excalidraw library hosts the canvas accepts', () => {
    expect(policy()['connect-src']).toEqual(["'self'", 'https://libraries.excalidraw.com', 'https://raw.githubusercontent.com'])
  })

  it('takes images, media, frames and workers from this site or from the page itself (data: and blob:)', () => {
    // https: images too, which the note view asks for only when its reader
    // clicks Load images.
    expect(policy()['img-src']).toEqual(["'self'", 'data:', 'blob:', 'https:'])
    expect(policy()['media-src']).toEqual(["'self'", 'blob:'])
    expect(policy()['frame-src']).toEqual(['blob:'])
    expect(policy()['worker-src']).toEqual(["'self'", 'blob:'])
  })
})

describe('serve-site.mjs', () => {
  const cleanup = []
  afterEach(async () => {
    for (const step of cleanup.splice(0)) await step()
  })

  it('sends routes.json’s headers with every file it serves', async () => {
    const siteRoot = mkdtempSync(join(tmpdir(), 'nebula-site-'))
    cleanup.push(() => rmSync(siteRoot, { recursive: true, force: true }))
    mkdirSync(join(siteRoot, 'assets'))
    writeFileSync(join(siteRoot, 'index.html'), '<!doctype html><title>Nebula</title>')
    writeFileSync(join(siteRoot, 'app.html'), '<!doctype html><title>Nebula app</title>')
    writeFileSync(join(siteRoot, 'assets', 'index-abc123.js'), 'export {}')
    const server = await startSiteServer({ port: 0, root: siteRoot })
    cleanup.push(() => new Promise((done) => server.close(done)))
    const base = `http://127.0.0.1:${server.address().port}`

    const page = await fetch(`${base}/app/p/k3v9x2m1qa/README.md`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Nebula app')
    expect(page.headers.get('content-security-policy')).toBe(resolveSiteHeaders(config, '/')['content-security-policy'])
    expect(page.headers.get('x-content-type-options')).toBe('nosniff')
    expect(page.headers.get('cache-control')).toBeNull()

    const asset = await fetch(`${base}/assets/index-abc123.js`)
    expect(asset.headers.get('content-security-policy')).toBe(resolveSiteHeaders(config, '/')['content-security-policy'])
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
  })
})
