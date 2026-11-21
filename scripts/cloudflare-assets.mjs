#!/usr/bin/env node
// nebula.starscape.app runs on Cloudflare Workers static assets, which read
// two files from the assets directory: _headers and _redirects. routes.json
// stays the one source of routes and headers (serve-site.mjs reads it for the
// local preview and the tailnet copy), and this writes both files from it. A
// rule it can't translate exactly stops the build rather than going missing.
//
//   node scripts/cloudflare-assets.mjs [dir]     dir defaults to dist/site
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const BANNER = '# Generated from routes.json by scripts/cloudflare-assets.mjs. Edit routes.json instead.'
const SEGMENTS = '((?:/[A-Za-z0-9._~-]+)+)'

function untranslatable(what) {
  return new Error(`cloudflare-assets: can’t translate ${what}`)
}

/** routes.json's header sources as Cloudflare paths: '/(.*)' → '/*', '/assets/(.*)' → '/assets/*'. */
function headerPath(source) {
  if (source === '/(.*)') return '/*'
  const prefix = new RegExp(`^${SEGMENTS}/\\(\\.\\*\\)$`).exec(source)
  if (prefix) return `${prefix[1]}/*`
  if (new RegExp(`^${SEGMENTS}$`).test(source)) return source
  throw untranslatable(`the header source ${source}`)
}

export function cloudflareHeaders(config) {
  const blocks = new Map()
  const seen = new Map()
  for (const rule of config.headers ?? []) {
    const path = headerPath(rule.source)
    const lines = blocks.get(path) ?? []
    for (const { key, value } of rule.headers) {
      if (!value) throw untranslatable(`an empty ${key} on ${rule.source}`)
      // Cloudflare joins a header two matching rules both set; routes.json never relies on that.
      const name = key.toLowerCase()
      if (seen.has(name) && seen.get(name) !== path) throw untranslatable(`${key}, set for both ${seen.get(name)} and ${path}`)
      seen.set(name, path)
      lines.push(`  ${key}: ${value}`)
    }
    blocks.set(path, lines)
  }
  return [BANNER, ...[...blocks].flatMap(([path, lines]) => [path, ...lines])].join('\n') + '\n'
}

function statusOf(rule) {
  return rule.statusCode ?? (rule.permanent === false ? 307 : 308)
}

/** One routes.json source and destination as _redirects lines: a fixed path, or a prefix whose
 * `:name*` (zero or more segments) becomes a bare line plus a `/*` line with `:splat`. */
function lines(rule, code) {
  const fixed = new RegExp(`^${SEGMENTS}$`).exec(rule.source)
  if (fixed) {
    if (/:[A-Za-z]/.test(rule.destination) && !/^https?:\/\//.test(rule.destination)) throw untranslatable(`${rule.source} → ${rule.destination}`)
    return [`${rule.source} ${rule.destination} ${code}`]
  }
  const prefix = new RegExp(`^${SEGMENTS}/:([A-Za-z_]\\w*)\\*$`).exec(rule.source)
  if (!prefix) throw untranslatable(`the source ${rule.source}`)
  const [, base, name] = prefix
  const param = `:${name}*`
  if (!rule.destination.includes(param)) {
    if (/:[A-Za-z]/.test(rule.destination)) throw untranslatable(`${rule.source} → ${rule.destination}`)
    return [`${base} ${rule.destination} ${code}`, `${base}/* ${rule.destination} ${code}`]
  }
  if (!rule.destination.endsWith(`/${param}`)) throw untranslatable(`${rule.source} → ${rule.destination}`)
  const head = rule.destination.slice(0, -(param.length + 1))
  return [`${base} ${head || '/'} ${code}`, `${base}/* ${head}/:splat ${code}`]
}

/** `exists(pathname)` says whether the build has a file there: a built file wins over a
 * rewrite, as it did on Vercel, so a rewrite whose source is a real file is left out. */
export function cloudflareRedirects(config, exists) {
  const out = []
  for (const rule of config.redirects ?? []) out.push(...lines(rule, statusOf(rule)))
  for (const rule of config.rewrites ?? []) {
    if (new RegExp(`^${SEGMENTS}$`).test(rule.source) && exists(rule.source)) continue
    if (!new RegExp(`^${SEGMENTS}$`).test(rule.destination)) throw untranslatable(`the rewrite to ${rule.destination}`)
    // html_handling 'auto-trailing-slash' redirects /index.html to / (and /x.html to /x), so a
    // rewrite to the .html address loops, and Cloudflare drops it: rewrite to the pretty one.
    const destination = rule.destination.replace(/\/index\.html$/, '/').replace(/\.html$/, '')
    out.push(...lines({ ...rule, destination }, 200))
  }
  // Cloudflare: static lines before dynamic ones, and the first match wins.
  const fixed = out.filter((line) => !line.split(' ')[0].includes('*'))
  const dynamic = out.filter((line) => line.split(' ')[0].includes('*'))
  return [BANNER, ...fixed, ...dynamic].join('\n') + '\n'
}

export function writeCloudflareAssets(dir, config) {
  const exists = (pathname) => {
    const file = join(dir, pathname)
    return existsSync(file) && statSync(file).isFile()
  }
  writeFileSync(join(dir, '_headers'), cloudflareHeaders(config))
  writeFileSync(join(dir, '_redirects'), cloudflareRedirects(config, exists))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(import.meta.dirname, '..')
  const dir = resolve(process.argv[2] ?? join(root, 'dist/site'))
  if (!existsSync(join(dir, 'index.html'))) {
    console.error(`cloudflare-assets: no built site at ${dir} (run pnpm run build:site first)`)
    process.exit(1)
  }
  writeCloudflareAssets(dir, JSON.parse(readFileSync(join(root, 'routes.json'), 'utf8')))
  console.log(`cloudflare-assets: wrote _headers and _redirects in ${dir}`)
}
