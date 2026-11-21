// Nebula under any address: its page, its assets and its file API, served under one base path by
// one call. `nebula run` uses it at the root; a host (the Suite) mounts it at `/nebula`, one per
// open workspace. Node built-ins only.
//
//   <base>/                      the app's page, with <base href="<base>/"> so its relative assets resolve
//   <base>/p/<project>/<path>    the same page: the app opens that file
//   <base>/assets/…, <base>/…    the built app's files (dist/app)
//   <base>/nebula-api/v1/…       the file API (cli/nebula-files.mjs), unless `files` names another base
//
// The page's security headers are routes.json's, as the site sends them for the app: the one source
// of headers. A host may name who may frame the page (`frameAncestors`) and nothing else of the
// policy. Every response carries the files API's mark, so the app finds its API without a request.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { API, createFilesApi } from './nebula-files.mjs'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
}

/** A path with no trailing slash, or '' for the root. */
const BASE_PATH = /^(\/[A-Za-z0-9._~-]+)*$/
/** One source a host may let frame the page: a keyword, or an origin (a `*.` host allowed). */
const FRAME_SOURCE = /^('self'|'none'|https?:\/\/(\*\.)?[A-Za-z0-9.-]+(:\d{1,5})?)$/

function escapeRegExp(text) {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

/** A routes.json `source` as a RegExp: literal paths, `:name`, `/:name*` and `(.*)`, as
 * serve-site.mjs reads them; anything else throws, so drift shows at once. */
function sourcePattern(source) {
  if (/[()[\]]/.test(source.replaceAll('(.*)', ''))) throw new Error(`routes.json: unsupported pattern ${source}`)
  let pattern = ''
  for (const token of source.split(/(\/:[A-Za-z0-9_]+\*|:[A-Za-z0-9_]+|\(\.\*\))/).filter(Boolean)) {
    if (/^\/:[A-Za-z0-9_]+\*$/.test(token)) pattern += '(?:/.*)?'
    else if (/^:[A-Za-z0-9_]+$/.test(token)) pattern += '[^/]+'
    else if (token === '(.*)') pattern += '.*'
    else pattern += escapeRegExp(token)
  }
  return new RegExp(`^${pattern}$`)
}

/** routes.json beside the built app (build:cli-app copies it there, so an installed package has
 * it), else the checkout's own. */
function readRoutes(assets) {
  for (const file of [join(assets, 'routes.json'), join(ROOT, 'routes.json')]) {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
  }
  throw new Error(`No routes.json beside ${assets} or in ${ROOT}: it holds the page's security headers`)
}

/** Who may frame the page, as a CSP source list; 'self' unless the host says otherwise. */
function frameSources(value) {
  const sources = (Array.isArray(value) ? value : String(value).split(/\s+/)).filter(Boolean)
  if (!sources.length || sources.some((source) => !FRAME_SOURCE.test(source))) {
    throw new Error(`frameAncestors is 'self', 'none' or origins such as https://suite.starscape.app: ${JSON.stringify(value)}`)
  }
  return sources.join(' ')
}

/**
 * Nebula, served under `basePath`.
 *
 * @param {object} options
 * @param {string} [options.basePath]  '' at the root, or a path such as `/nebula` (no trailing slash)
 * @param {string} options.assets  the built app's folder (dist/app)
 * @param {object | ReturnType<typeof createFilesApi> | null} [options.files]  a createFilesApi
 *   instance, or its options (its `apiBase` then defaults to `<basePath>/nebula-api/v1`); none: the
 *   app keeps its projects in the browser, and the page carries no mark
 * @param {string | string[]} [options.frameAncestors]  who may frame the page: `'self'` by default;
 *   the Suite names its own origin
 */
export function createNebulaApp({ basePath = '', assets, files = null, frameAncestors = "'self'" } = {}) {
  if (!BASE_PATH.test(basePath)) throw new Error(`basePath is '' or a path such as /nebula, with no trailing slash: ${JSON.stringify(basePath)}`)
  if (!assets) throw new Error('assets is the built app’s folder (dist/app)')
  const root = resolve(assets)
  const routes = readRoutes(root)
  const frames = frameSources(frameAncestors)
  const api = files && typeof files.fetch === 'function' ? files : files ? createFilesApi({ apiBase: `${basePath}${API}`, ...files }) : null
  const mark = api?.serverTiming ?? null

  /** routes.json's headers for a path of the site (`/app` for the page), every matching rule in
   * order, a later one winning; the CSP with this host's frame-ancestors. */
  function siteHeaders(sitePath) {
    const headers = {}
    for (const rule of routes.headers ?? []) {
      if (!sourcePattern(rule.source).test(sitePath)) continue
      for (const { key, value } of rule.headers) headers[key.toLowerCase()] = value
    }
    const policy = headers['content-security-policy']
    if (policy !== undefined) {
      const directives = policy.split(';').map((part) => part.trim()).filter((part) => part && !/^frame-ancestors(\s|$)/i.test(part))
      headers['content-security-policy'] = [...directives, `frame-ancestors ${frames}`].join('; ')
    }
    // Browsers that predate frame-ancestors read this instead; it can say only none or self.
    if (frames === "'none'") headers['x-frame-options'] = 'DENY'
    else if (frames === "'self'") headers['x-frame-options'] = 'SAMEORIGIN'
    return headers
  }

  const pageHeaders = siteHeaders('/app')

  /** The page, told where it's mounted: its assets are relative (Vite `base: './'`), so they
   * resolve under `<base href>`, and src/app/routes.ts reads its mount from it. */
  function page() {
    let html = readFileSync(join(root, 'index.html'), 'utf8')
    const tag = `<base href="${basePath}/" />`
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (head) => `${head}\n    ${tag}`)
    else if (/<!doctype[^>]*>/i.test(html)) html = html.replace(/<!doctype[^>]*>/i, (doctype) => `${doctype}${tag}`)
    else html = `${tag}${html}`
    // The manifest names its icons and start page from the root, so a mounted page leaves it out
    // rather than point the browser outside the mount.
    if (basePath) html = html.replace(/[ \t]*<link rel="manifest"[^>]*>\n?/i, '')
    return html
  }

  /** What a path under the base is: the page, a file of the built app, or nothing. */
  function lookup(inside) {
    if (inside === '/' || inside === '/index.html' || inside.startsWith('/p/')) return { type: 'page' }
    let decoded
    try {
      decoded = decodeURIComponent(inside)
    } catch {
      return { type: 'missing' }
    }
    const file = resolve(join(root, decoded))
    if ((file === root || file.startsWith(`${root}${sep}`)) && existsSync(file) && statSync(file).isFile()) return { type: 'file', file, sitePath: decoded }
    // An app route with no extension is the app's, as the site's rewrites serve it.
    return extname(decoded) ? { type: 'missing' } : { type: 'page' }
  }

  /** The answer for a path, or null when it's outside the base. At the root, the site's `/app`
   * addresses go to the same file here, so a link copied from nebula.starscape.app/app opens. */
  function plan(method, pathname, search = '') {
    if (basePath && pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return null
    if (!basePath && (pathname === '/app' || pathname.startsWith('/app/'))) return { status: 307, headers: { location: `${pathname.slice(4) || '/'}${search}` } }
    if (method !== 'GET' && method !== 'HEAD') return { status: 405, headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }, text: 'method not allowed' }
    const found = lookup(pathname.slice(basePath.length) || '/')
    if (found.type === 'page') return { status: 200, headers: { ...pageHeaders, 'content-type': MIME['.html'], 'cache-control': 'no-cache' }, text: page() }
    if (found.type === 'file') return { status: 200, headers: { ...siteHeaders(found.sitePath), 'content-type': MIME[extname(found.file)] ?? 'application/octet-stream', 'content-length': String(statSync(found.file).size) }, file: found.file }
    return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' }, text: 'not found' }
  }

  const withMark = (headers) => (mark ? { ...headers, 'server-timing': mark } : headers)

  /**
   * Answers a request under the base with a Response, or null for any other path (the host's).
   * `info` is what the server saw of the connection, for the file API (`remoteAddress`, `hostCount`).
   * @param {Request} request
   * @param {{ remoteAddress?: string, hostCount?: number }} [info]
   * @returns {Promise<Response | null>}
   */
  async function fetchApp(request, info = {}) {
    if (api) {
      const answer = await api.fetch(request, info)
      if (answer) {
        if (mark) answer.headers.set('server-timing', mark)
        return answer
      }
    }
    const url = new URL(request.url)
    const planned = plan(request.method, url.pathname, url.search)
    if (!planned) return null
    const headers = withMark(planned.headers)
    if (request.method === 'HEAD') return new Response(null, { status: planned.status, headers })
    const body = planned.file ? Readable.toWeb(createReadStream(planned.file)) : (planned.text ?? null)
    return new Response(body, { status: planned.status, headers })
  }

  /** Answers a request under the base and returns true; returns false for any other path. */
  async function handle(req, res) {
    const { pathname, search } = new URL(req.url ?? '/', 'http://nebula.local')
    const inside = !basePath || pathname === basePath || pathname.startsWith(`${basePath}/`)
    if (!inside) return false
    if (mark) res.setHeader('server-timing', mark)
    if (api && (await api.handle(req, res))) return true
    const planned = plan(req.method ?? 'GET', pathname, search)
    res.writeHead(planned.status, planned.headers)
    if (req.method === 'HEAD') res.end()
    else if (planned.file) createReadStream(planned.file).on('error', () => res.destroy()).pipe(res)
    else res.end(planned.text ?? '')
    return true
  }

  return {
    fetch: fetchApp,
    handle,
    /** The file API, when there is one. */
    files: api,
    basePath,
    /** The Server-Timing mark on every response, or null with no file API. */
    serverTiming: mark,
    close: () => api?.close(),
  }
}
