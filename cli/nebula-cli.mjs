import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  return `Nebula CLI — local-first whiteboard launcher

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

Nebula stores canvases in browser localStorage by default. There is no board engine,
database, MCP server, or Orbit-style project daemon in this CLI path.
`
}

function parseRunOptions(args) {
  const options = {
    host: process.env.HOST || DEFAULT_HOST,
    port: Number(process.env.PORT || DEFAULT_PORT),
    root: findDefaultStaticRoot(),
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--host') {
      options.host = args[++index]
    } else if (arg === '--port' || arg === '-p') {
      options.port = Number(args[++index])
    } else if (arg === '--root') {
      options.root = args[++index]
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

async function startNebulaStaticServer({ host = DEFAULT_HOST, port = DEFAULT_PORT, root = findDefaultStaticRoot(), silent = false } = {}) {
  const staticRoot = normalizeRoot(root)
  const indexPath = join(staticRoot, 'index.html')

  if (!existsSync(indexPath)) {
    throw new Error(`Missing ${indexPath}. Run "pnpm run build:cli-app" or "pnpm run build" first.`)
  }

  const server = createServer((req, res) => {
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

  if (!silent) {
    console.log(`Nebula local app: ${url}`)
    console.log(`Serving ${staticRoot}`)
    console.log('Storage: browser localStorage only')
  }

  return { server, url, root: staticRoot, port: actualPort }
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
      io.stdout.write('No Nebula config is required yet. Nebula uses browser localStorage for the self-hosted local app flow.\n')
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
