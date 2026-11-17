import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SERVER_TIMING, createFilesApi } from './nebula-files.mjs'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const DEFAULT_PORT = 4321
const DEFAULT_HOST = '127.0.0.1'

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
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
}

function readPackageJson() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
}

function normalizeRoot(root) {
  return resolve(root)
}

function isInsideRoot(root, filePath) {
  return filePath === root || filePath.startsWith(`${root}${sep}`)
}

function findDefaultStaticRoot() {
  const candidates = [
    join(ROOT, 'dist', 'app'),
    join(ROOT, 'dist', 'site', 'app'),
    join(ROOT, 'dist'),
  ]

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate
  }

  return candidates[0]
}

function helpText() {
  return `Nebula CLI — Nebula's workspace, served from your own machine

Usage: nebula <command> [options]

Hosted Nebula: open the hosted URL; no install or npm required.
Self-hosted Nebula CLI: use this command when you want a local/private app flow.

Commands:
  nebula run              Start the local-first web app and print the URL.
  nebula serve            alias for run; serves the same built static app.
  nebula init             Validate that no config is required yet.
  nebula help             Show this help.
  nebula -v, --version    Print the package version.

Options for run/serve:
  --host <host>           Host to bind. Default: ${DEFAULT_HOST}
  -p, --port <port>       Port to bind. Default: ${DEFAULT_PORT}
  --root <path>           Static app root. Default: packaged dist/app when available.

Folders on this machine, as projects (the server tier):
  --project <dir>         Serve this folder as a project. Repeat for more.
  --projects <dir>        Serve every folder inside this one as a project, as they come and go.
  --label <name>          What Nebula calls this machine. Default: its hostname.
  --allow-host <name>     Also answer for this host name (a tailnet name behind a proxy).
                          Loopback names always work; any other name is refused.

Without --project or --projects, projects live in the browser that opens the app, in its
origin private file system (OPFS), apart for each address: the projects at
http://${DEFAULT_HOST}:${DEFAULT_PORT} aren't the ones at nebula.starscape.app. Download a project
as a .zip to move it. With them, the folders' projects show beside the browser's: Nebula reads and
writes their files on this machine, and shows changes other apps and agents make. The server
has no accounts: keep it on loopback, or behind a private network you trust.
`
}

function parseRunOptions(args) {
  const options = {
    host: process.env.HOST || DEFAULT_HOST,
    port: Number(process.env.PORT || DEFAULT_PORT),
    root: findDefaultStaticRoot(),
    projects: [],
    projectsDirs: [],
    allowHosts: [],
    label: undefined,
  }
  const value = (index, name) => {
    const next = args[index]
    if (next === undefined || next.startsWith('--')) throw new Error(`Missing value for ${name}`)
    return next
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--host') {
      options.host = args[++index]
    } else if (arg === '--port' || arg === '-p') {
      options.port = Number(args[++index])
    } else if (arg === '--root') {
      options.root = args[++index]
    } else if (arg === '--project') {
      options.projects.push(resolve(value(++index, arg)))
    } else if (arg === '--projects') {
      options.projectsDirs.push(resolve(value(++index, arg)))
    } else if (arg === '--allow-host') {
      options.allowHosts.push(value(++index, arg))
    } else if (arg === '--label') {
      options.label = value(++index, arg)
    } else {
      throw new Error(`Unknown option for nebula run: ${arg}`)
    }
  }

  if (!options.host) throw new Error('Missing host value')
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error(`Invalid port: ${options.port}`)
  }
  if (!options.root) throw new Error('Missing static root value')

  return options
}

function resolveStaticPath(root, requestUrl) {
  let pathname = decodeURIComponent(new URL(requestUrl ?? '/', 'http://nebula.local').pathname)

  if (pathname === '/app' || pathname === '/app/') pathname = '/index.html'
  // A file's address (/p/<project>/<path>) and an old canvas link (/b/…) are
  // the app's, whatever their extension, as vercel.json rewrites them; so are
  // the same under /app, where the site mounts the app.
  if (/^(?:\/app)?\/[pb]\//.test(pathname)) pathname = '/index.html'
  if (pathname.endsWith('/')) pathname += 'index.html'

  let filePath = resolve(join(root, pathname))

  if (
    (!isInsideRoot(root, filePath) || !existsSync(filePath) || !statSync(filePath).isFile()) &&
    !extname(pathname)
  ) {
    filePath = join(root, 'index.html')
  }

  return filePath
}

async function startNebulaStaticServer({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  root = findDefaultStaticRoot(),
  silent = false,
  projects = [],
  projectsDirs = [],
  allowHosts = [],
  label,
} = {}) {
  const staticRoot = normalizeRoot(root)
  const indexPath = join(staticRoot, 'index.html')

  if (!existsSync(indexPath)) {
    throw new Error(`Missing ${indexPath}. Run "pnpm run build:cli-app" or "pnpm run build" first.`)
  }
  for (const dir of [...projects, ...projectsDirs]) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Not a folder: ${dir}`)
  }
  const serving = projects.length > 0 || projectsDirs.length > 0
  // Folders on an address other machines reach, with no name to answer for.
  if (serving && !['127.0.0.1', 'localhost', '::1'].includes(host) && !allowHosts.length) {
    throw new Error(`Serving folders on ${host} reaches them from other machines: name the host they'll use with --allow-host <name>, or bind 127.0.0.1.`)
  }

  const files = serving
    ? createFilesApi({ roots: projects, projectsDirs, allowHosts, label, loopbackPeer: true, log: (line) => console.error(line) })
    : null
  if (files) await files.ready()

  const server = createServer(async (req, res) => {
    // No other site may frame the app: framed, its own requests would pass every check.
    res.setHeader('content-security-policy', "frame-ancestors 'none'")
    res.setHeader('x-frame-options', 'DENY')
    if (files) {
      res.setHeader('server-timing', SERVER_TIMING)
      if (await files.handle(req, res)) return
    }
    const filePath = resolveStaticPath(staticRoot, req.url)

    if (!isInsideRoot(staticRoot, filePath) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }

    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' })
    createReadStream(filePath).pipe(res)
  })

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })

  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host
  const url = `http://${displayHost}:${actualPort}/`

  server.on('close', () => files?.close())

  if (!silent) {
    console.log(`Nebula local app: ${url}`)
    console.log(`Serving ${staticRoot}`)
    if (files) {
      for (const project of files.projects()) console.log(`Project: ${project.name} (${project.dir})`)
    } else console.log("Storage: the browser's origin private file system (OPFS), for this address")
  }

  return { server, url, root: staticRoot, port: actualPort, files }
}

async function runNebulaCli(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  const [command = 'help', ...rest] = argv

  try {
    if (command === '--help' || command === '-h' || command === 'help') {
      io.stdout.write(helpText())
      return 0
    }

    if (command === '--version' || command === '-v' || command === 'version') {
      io.stdout.write(`${readPackageJson().version}\n`)
      return 0
    }

    if (command === 'init') {
      io.stdout.write('No Nebula config is required yet. Projects live in the browser that opens the app (OPFS).\n')
      return 0
    }

    if (command === 'run' || command === 'serve') {
      const options = parseRunOptions(rest)
      await startNebulaStaticServer(options)
      return 0
    }

    io.stderr.write(`Unknown Nebula command: ${command}\n\n`)
    io.stderr.write(helpText())
    return 1
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

export { findDefaultStaticRoot, helpText, runNebulaCli, startNebulaStaticServer }
