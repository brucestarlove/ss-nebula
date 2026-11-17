#!/usr/bin/env node
// Tiny static server for checking dist/site/ before deploying. It reads the
// real vercel.json and applies its redirects, rewrites, trailing-slash rule
// and headers (the Content-Security-Policy included), so the local preview,
// and the e2e suite on the production build, see what the deployed site sends.
// Supported patterns: literal paths, `:name` (one segment), `/:name*` (zero or
// more segments) and `(.*)` (anything). Anything else throws, so config drift
// shows up in tests rather than as a silently different local preview.

import { createServer } from 'node:http'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The mark a Nebula server puts on every response (cli/nebula-files.mjs SERVER_TIMING).
const SERVER_TIMING = 'nebula-files;desc="1"'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const SITE_ROOT = join(HERE, 'dist', 'site')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.webp': 'image/webp',
}

function escapeRegExp(text) {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

/** Compile a vercel.json `source` into a RegExp plus its parameter names. */
export function compileSource(source) {
  if (/[()[\]]/.test(source.replaceAll('(.*)', ''))) {
    throw new Error(`serve-site: unsupported pattern ${source} (use :name, /:name* or (.*))`)
  }
  const keys = []
  let pattern = ''
  let groups = 0
  const tokens = source.split(/(\/:[A-Za-z0-9_]+\*|:[A-Za-z0-9_]+|\(\.\*\))/).filter(Boolean)
  for (const token of tokens) {
    const many = token.match(/^\/:([A-Za-z0-9_]+)\*$/)
    const one = token.match(/^:([A-Za-z0-9_]+)$/)
    if (many) {
      keys.push({ name: many[1], many: true })
      pattern += '(?:/(.*))?'
    } else if (one) {
      keys.push({ name: one[1], many: false })
      pattern += '([^/]+)'
    } else if (token === '(.*)') {
      // An unnamed group, as path-to-regexp numbers them.
      keys.push({ name: String(groups), many: true })
      groups += 1
      pattern += '(.*)'
    } else {
      pattern += escapeRegExp(token)
    }
  }
  return { regex: new RegExp(`^${pattern}$`), keys }
}

function matchSource(source, pathname) {
  const { regex, keys } = compileSource(source)
  const match = pathname.match(regex)
  if (!match) return null
  const params = {}
  keys.forEach((key, index) => {
    params[key.name] = match[index + 1] ?? ''
  })
  return params
}

function fillDestination(destination, params) {
  let out = destination.replace(/\/:([A-Za-z0-9_]+)\*/g, (_, name) => (params[name] ? `/${params[name]}` : ''))
  out = out.replace(/:([A-Za-z0-9_]+)/g, (whole, name) => (name in params ? params[name] : whole))
  return out === '' ? '/' : out
}

function withSearch(location, search) {
  if (!search || location.includes('?')) return location
  const hash = location.indexOf('#')
  return hash === -1 ? `${location}${search}` : `${location.slice(0, hash)}${search}${location.slice(hash)}`
}

/**
 * Decide what the site does with one request URL: redirect, serve a file, or
 * answer 404. `exists(pathname)` reports whether a built file exists.
 */
export function resolveSiteRequest(config, url, exists) {
  const parsed = new URL(url, 'http://nebula.local')
  const pathname = decodeURIComponent(parsed.pathname)
  const search = parsed.search

  if (config.trailingSlash === false && pathname.length > 1 && pathname.endsWith('/')) {
    return { type: 'redirect', status: 308, location: withSearch(pathname.replace(/\/+$/, ''), search) }
  }

  for (const rule of config.redirects ?? []) {
    const params = matchSource(rule.source, pathname)
    if (!params) continue
    const status = rule.statusCode ?? (rule.permanent === false ? 307 : 308)
    return { type: 'redirect', status, location: withSearch(fillDestination(rule.destination, params), search) }
  }

  const staticFile = (candidate) => {
    if (candidate === '/') return exists('/index.html') ? '/index.html' : null
    if (exists(candidate)) return candidate
    if (config.cleanUrls && exists(`${candidate}.html`)) return `${candidate}.html`
    return null
  }

  // Static files win over rewrites, as on Vercel.
  const direct = staticFile(pathname)
  if (direct) return { type: 'file', file: direct }

  for (const rule of config.rewrites ?? []) {
    const params = matchSource(rule.source, pathname)
    if (!params) continue
    const file = staticFile(fillDestination(rule.destination, params))
    if (file) return { type: 'file', file }
  }

  return { type: 'not-found' }
}

/**
 * The headers vercel.json gives a request, matched on the path as requested
 * (before rewrites), as Vercel does. Every matching rule applies, in order; a
 * later rule's value wins for the same header. Names come back lowercased.
 */
export function resolveSiteHeaders(config, url) {
  const raw = new URL(url, 'http://nebula.local').pathname
  let pathname = raw
  try {
    pathname = decodeURIComponent(raw)
  } catch {
    // A malformed escape: match the path as sent.
  }
  const headers = {}
  for (const rule of config.headers ?? []) {
    if (!matchSource(rule.source, pathname)) continue
    for (const { key, value } of rule.headers) headers[key.toLowerCase()] = value
  }
  return headers
}

/**
 * Serves the built site. With `files` (createFilesApi from cli/nebula-files.mjs), it is a Nebula
 * server too: the file API answers under /nebula-api/, and every response carries the
 * Server-Timing mark the app looks for (src/app/serverTier.ts).
 */
export function startSiteServer({ port = Number(process.env.PORT || 4311), host = '127.0.0.1', root = SITE_ROOT, files = null } = {}) {
  const config = JSON.parse(readFileSync(join(HERE, 'vercel.json'), 'utf8'))
  const exists = (pathname) => {
    const filePath = join(root, pathname)
    return filePath.startsWith(root) && existsSync(filePath) && statSync(filePath).isFile()
  }

  const server = createServer(async (req, res) => {
    if (files) {
      res.setHeader('server-timing', SERVER_TIMING)
      if (await files.handle(req, res)) return
    }
    for (const [name, value] of Object.entries(resolveSiteHeaders(config, req.url ?? '/'))) res.setHeader(name, value)
    let result
    try {
      result = resolveSiteRequest(config, req.url ?? '/', exists)
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('bad request')
      return
    }
    if (result.type === 'redirect') {
      res.writeHead(result.status, { location: result.location })
      res.end()
      return
    }
    if (result.type !== 'file') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    const filePath = join(root, result.file)
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' })
    createReadStream(filePath).pipe(res)
  })

  return new Promise((resolveStart) => {
    server.listen(port, host, () => resolveStart(server))
  })
}

const runDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (runDirectly) {
  if (!existsSync(SITE_ROOT)) {
    console.error(`Missing ${SITE_ROOT}. Run "pnpm run build:site" first.`)
    process.exit(1)
  }
  // NEBULA_FILES_PROJECTS=<folder>: a Nebula server too, every folder inside that one a project
  // (the server tier's browser tests, e2e/app-server.spec.ts).
  let files = null
  if (process.env.NEBULA_FILES_PROJECTS) {
    const { createFilesApi } = await import('./cli/nebula-files.mjs')
    files = createFilesApi({ projectsDirs: [process.env.NEBULA_FILES_PROJECTS], label: process.env.NEBULA_FILES_LABEL || 'this server', log: (line) => console.error(line) })
    await files.ready()
  }
  const server = await startSiteServer({ files })
  const { port } = server.address()
  console.log(`Serving dist/site at http://127.0.0.1:${port} with vercel.json's routing${files ? `, and the folders in ${process.env.NEBULA_FILES_PROJECTS}` : ''}`)
}
