import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cloudflareHeaders, cloudflareRedirects } from '../scripts/cloudflare-assets.mjs'
import { resolveSiteHeaders, resolveSiteRequest } from '../serve-site.mjs'

// nebula.starscape.app runs on Cloudflare Workers static assets (2026-10-25).
// vercel.json stays the one source of routes and headers: serve-site.mjs reads
// it (the local preview, the tailnet copy), and scripts/cloudflare-assets.mjs
// turns it into Cloudflare's _headers and _redirects. These tests hold the two
// to the same answers.
const root = resolve(import.meta.dirname, '..')
const config = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'))
const built = new Set(['/index.html', '/app.html', '/favicon.ico', '/ss-nebula-32x32.png', '/ss-nebula-og.png', '/site.webmanifest', '/assets/index-abc123.js', '/fonts/Excalifont/Excalifont-Regular.woff2'])
const exists = (pathname) => built.has(pathname)

/** Cloudflare's _headers, parsed the way its docs describe: an unindented path, then indented `Name: value` lines. */
function parseHeaders(text) {
  const rules = []
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue
    if (!/^\s/.test(line)) rules.push({ path: line.trim(), headers: {} })
    else {
      const at = line.indexOf(':')
      rules.at(-1).headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
    }
  }
  return rules
}

/** Cloudflare's _redirects as its docs describe them: the first matching line wins, before any asset; one splat. */
function parseRedirects(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => {
      const [source, destination, code = '302'] = line.trim().split(/\s+/)
      return { source, destination, code: Number(code) }
    })
}

function cloudflareAnswer(redirects, pathname) {
  for (const rule of redirects) {
    let splat = null
    if (rule.source.endsWith('/*')) {
      const base = rule.source.slice(0, -1)
      if (!pathname.startsWith(base)) continue
      splat = pathname.slice(base.length)
    } else if (rule.source !== pathname) continue
    const target = rule.destination.replace(':splat', splat ?? '')
    if (rule.code === 200) {
      const answer = assetAt(target)
      return answer.type === 'file' ? answer : { type: 'not-found' }
    }
    return { type: 'redirect', status: rule.code, location: target }
  }
  return assetAt(pathname)
}

/** Cloudflare's html_handling 'auto-trailing-slash': a folder's index.html at its slash, a page's
 * .html at its bare name (/app serves app.html), and a 307 to that address from the other one. */
function assetAt(pathname) {
  if (pathname.endsWith('/')) {
    if (exists(`${pathname}index.html`)) return { type: 'file', file: `${pathname}index.html` }
    if (pathname.length > 1 && exists(`${pathname.slice(0, -1)}.html`)) return { type: 'redirect', status: 307, location: pathname.slice(0, -1) }
    return { type: 'not-found' }
  }
  if (exists(pathname)) return { type: 'file', file: pathname }
  if (exists(`${pathname}.html`)) return { type: 'file', file: `${pathname}.html` }
  return { type: 'not-found' }
}

describe('Cloudflare _redirects from vercel.json', () => {
  const text = cloudflareRedirects(config, exists)
  const redirects = parseRedirects(text)

  /** Where a URL ends up, and the redirect codes on the way. */
  function follow(answer, url) {
    const hops = []
    let current = url
    for (let i = 0; i < 5; i += 1) {
      const result = answer(current)
      if (result.type !== 'redirect') return { end: { ...result, url: current }, hops: [...new Set(hops)] }
      hops.push(result.status)
      current = result.location
      if (/^https?:\/\//.test(current)) return { end: { type: 'external', url: current }, hops: [...new Set(hops)] }
    }
    throw new Error(`a redirect loop from ${url}`)
  }

  it('sends every route where the local server does, with the same kind of redirect', () => {
    const urls = ['/', '/app', '/app/p/k3v9x2m1qa/README.md', '/app/p/k3v9x2m1qa/Concept art', '/app/b/demo/c/sketch', '/install', '/support', '/p/k3v9x2m1qa/Guides/Observing plan.md', '/p', '/b/demo/c/sketch', '/b', '/app/ss-nebula-og.png', '/favicon.ico', '/site.webmanifest', '/assets/index-abc123.js', '/no-such-page']
    for (const url of urls) {
      const local = follow((u) => resolveSiteRequest(config, u, exists), url)
      const edge = follow((u) => cloudflareAnswer(redirects, u), url)
      expect(edge, url).toEqual(local)
    }
  })

  it('lands /app/ on the app on both, by each one’s own slash rule', () => {
    // The local server strips the slash with a 308 (Vercel's trailingSlash: false); Cloudflare's
    // auto-trailing-slash answers 307 to the page's bare address. Both end on the app.
    const local = follow((u) => resolveSiteRequest(config, u, exists), '/app/')
    const edge = follow((u) => cloudflareAnswer(redirects, u), '/app/')
    expect(local.end).toEqual({ type: 'file', file: '/app.html', url: '/app' })
    expect(edge.end).toEqual(local.end)
  })

  it('lets a built file win over a rewrite, as Vercel did: the real favicon.ico stays', () => {
    expect(text).not.toMatch(/^\/favicon\.ico /m)
    const without = cloudflareRedirects(config, (pathname) => pathname !== '/favicon.ico' && exists(pathname))
    expect(without).toMatch(/^\/favicon\.ico \/ss-nebula-32x32\.png 200$/m)
  })

  it('rewrites to a page’s pretty address, never to .html, which auto-trailing-slash would loop', () => {
    // wrangler ignores `/p/* /index.html 200` as an infinite loop (seen 2026-10-25): /index.html redirects to /.
    expect(text).not.toMatch(/\.html 200$/m)
    expect(text).toMatch(/^\/app\/p\/\* \/app 200$/m)
  })

  it('keeps to what Cloudflare parses: one splat a line, three fields, codes it knows', () => {
    for (const line of text.split('\n').filter((l) => l.trim() && !l.startsWith('#'))) {
      expect(line.split(/\s+/), line).toHaveLength(3)
      expect((line.split(/\s+/)[0].match(/\*/g) ?? []).length, line).toBeLessThanOrEqual(1)
      expect([200, 301, 302, 303, 307, 308], line).toContain(Number(line.split(/\s+/)[2]))
    }
  })

  it('refuses a vercel.json rule it can’t translate, rather than dropping it', () => {
    expect(() => cloudflareRedirects({ redirects: [{ source: '/a/:x/b', destination: '/', permanent: true }] }, exists)).toThrow(/can’t translate/)
    expect(() => cloudflareRedirects({ rewrites: [{ source: '/(.*)\\.md', destination: '/index.html' }] }, exists)).toThrow(/can’t translate/)
  })
})

describe('Cloudflare _headers from vercel.json', () => {
  const text = cloudflareHeaders(config)
  const rules = parseHeaders(text)

  it('sends every header vercel.json sends, for the same paths', () => {
    const forPath = (pathname) => {
      const out = {}
      for (const rule of rules) {
        const match = rule.path === '/*' || (rule.path.endsWith('/*') && pathname.startsWith(rule.path.slice(0, -1))) || rule.path === pathname
        if (match) Object.assign(out, rule.headers)
      }
      return out
    }
    for (const url of ['/', '/app', '/app/p/k3v9x2m1qa/Guides/Observing%20plan.md', '/assets/index-abc123.js', '/fonts/Excalifont/Excalifont-Regular.woff2', '/site.webmanifest', '/third-party-licenses.txt']) {
      expect(forPath(url), url).toEqual(resolveSiteHeaders(config, url))
    }
  })

  it('keeps to what Cloudflare parses: one block per path, one splat, no empty value', () => {
    const paths = rules.map((rule) => rule.path)
    expect(new Set(paths).size).toBe(paths.length)
    for (const rule of rules) {
      expect((rule.path.match(/\*/g) ?? []).length, rule.path).toBeLessThanOrEqual(1)
      for (const [name, value] of Object.entries(rule.headers)) expect(value, `${rule.path} ${name}`).not.toBe('')
    }
  })

  it('refuses a header source it can’t translate', () => {
    expect(() => cloudflareHeaders({ headers: [{ source: '/(.*)\\.html', headers: [{ key: 'X', value: 'y' }] }] })).toThrow(/can’t translate/)
  })
})
