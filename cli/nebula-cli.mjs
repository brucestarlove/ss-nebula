import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNebulaApp } from './app.mjs'
import { createFilesApi, serverPerson } from './nebula-files.mjs'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const DEFAULT_PORT = 4321
const DEFAULT_HOST = '127.0.0.1'
/** How often `--database` sweeps: thinning each file's history and removing the bytes nothing keeps. */
const SWEEP_EVERY = 60 * 60 * 1000

function readPackageJson() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
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

Projects on this machine, served to the app (the server tier):
  --project <dir>         Serve this folder as a project. Repeat for more.
  --projects <dir>        Serve every folder inside this one as a project, as they come and go.
  --database <dir>        Keep projects in a database in <dir> instead: the tree and its history
                          in nebula.db, the files' contents in bytes/, made if new. New project
                          in the app makes them there. Earlier versions of each file are kept 14
                          days, thinned hourly to about 40 a file. Node 22.13 or later. Not with
                          --project or --projects: a server keeps its projects one way.
  --label <name>          What Nebula calls this machine. Default: its hostname.
  --allow-host <name>     Also answer for this host name (a tailnet name behind a proxy).
                          Loopback names always work; any other name is refused.

Without --project, --projects or --database, projects live in the browser that opens the app, in
its origin private file system (OPFS), apart for each address: the projects at
http://${DEFAULT_HOST}:${DEFAULT_PORT} aren't the ones at nebula.starscape.app. Download a project
as a .zip to move it. With them, the server's projects show beside the browser's: Nebula reads and
writes their files on this machine, and shows changes other apps and agents make in the folders.
The server has no accounts: keep it on loopback, or behind a private network you trust.
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
    if (arg === '--help' || arg === '-h') {
      // Asked for as a value (--label -h) it is the value; here it's the request. Nothing else is checked.
      return { help: true }
    } else if (arg === '--host') {
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
    } else if (arg === '--database') {
      if (options.database) throw new Error('Give --database once: one server keeps its projects in one database.')
      options.database = resolve(value(++index, arg))
    } else {
      throw new Error(`Unknown option for nebula run: ${arg}`)
    }
  }

  // One backend per server: folders, or a database, never both.
  if (options.database && (options.projects.length || options.projectsDirs.length)) {
    throw new Error('--database keeps projects in a database, and --project and --projects serve folders: a server does one or the other. Run two servers on two ports to have both.')
  }
  if (!options.host) throw new Error('Missing host value')
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error(`Invalid port: ${options.port}`)
  }
  if (!options.root) throw new Error('Missing static root value')

  return options
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
  database,
} = {}) {
  const staticRoot = resolve(root)
  const indexPath = join(staticRoot, 'index.html')

  if (!existsSync(indexPath)) {
    throw new Error(`Missing ${indexPath}. Run "pnpm run build:cli-app" or "pnpm run build" first.`)
  }
  if (database && (projects.length || projectsDirs.length)) {
    throw new Error('A server keeps its projects in a database or serves folders, not both.')
  }
  for (const dir of [...projects, ...projectsDirs]) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Not a folder: ${dir}`)
  }
  // The database's folder is made if it isn't there (its first run), but never over a file, and
  // only inside a folder that exists: a mistyped path then fails here instead of starting a
  // second, empty database somewhere new.
  if (database && existsSync(database) && !statSync(database).isDirectory()) throw new Error(`Not a folder: ${database}`)
  if (database && !existsSync(database)) {
    const parent = dirname(database)
    if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new Error(`No folder ${parent} to make the database in: make it first, or check the path.`)
    console.error(`nebula: making a new database in ${database}`)
  }
  const serving = projects.length > 0 || projectsDirs.length > 0 || Boolean(database)
  // Projects on an address other machines reach, with no name to answer for.
  if (serving && !['127.0.0.1', 'localhost', '::1'].includes(host) && !allowHosts.length) {
    throw new Error(`Serving projects on ${host} reaches them from other machines: name the host they'll use with --allow-host <name>, or bind 127.0.0.1.`)
  }

  const log = (line) => console.error(line)
  let backend
  if (database) {
    // Loaded only for --database: node:sqlite needs Node 22.13, and folders still run on Node 20.
    // A backend made here doesn't get createFilesApi's person, so it's given the same id.
    const { createDatabaseBackend } = await import('./backends/database.mjs')
    backend = createDatabaseBackend({ folder: database, createdBy: serverPerson({ label }).id, log })
  }
  const files = serving
    ? createFilesApi({ roots: projects, projectsDirs, backend, allowHosts, label, loopbackPeer: true, log })
    : null
  if (files) await files.ready()

  // The app at the root, its page under routes.json's headers. No other site may frame it:
  // framed, its own requests would pass every check.
  const app = createNebulaApp({ assets: staticRoot, files, frameAncestors: "'none'" })
  const server = createServer((req, res) => {
    app.handle(req, res).catch((error) => {
      console.error(`nebula: ${req.method} ${req.url}: ${error?.stack ?? error}`)
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end()
    })
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

  // The database's sweep, at start and hourly: thinning keeps about 40 versions a file, and the bytes
  // no version, file or removed project still needs go. Unref'd, so it never keeps the process up;
  // one run at a time; a database a newer Nebula wrote is only read, so it isn't swept.
  if (backend && !backend.readOnly) {
    let sweeping = false
    const sweep = async () => {
      if (sweeping) return
      sweeping = true
      try {
        const { dropped, removed, freed, kept, purged = [] } = await backend.sweep()
        log(`nebula: swept ${database}: ${dropped} version${dropped === 1 ? '' : 's'} thinned, ${removed.length} object${removed.length === 1 ? '' : 's'} removed (${freed} bytes), ${kept} kept, ${purged.length} removed project${purged.length === 1 ? '' : 's'} purged`)
      } catch (error) {
        log(`nebula: the sweep of ${database} failed: ${error?.stack ?? error}`)
      } finally {
        sweeping = false
      }
    }
    const timer = setInterval(sweep, SWEEP_EVERY)
    timer.unref()
    server.on('close', () => clearInterval(timer))
    void sweep()
  }

  if (!silent) {
    console.log(`Nebula local app: ${url}`)
    console.log(`Serving ${staticRoot}`)
    if (database) console.log(`Database: ${database}`)
    if (files) {
      for (const project of files.projects()) console.log(`Project: ${project.name}${project.dir ? ` (${project.dir})` : ''}`)
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
      if (options.help) {
        io.stdout.write(helpText())
        return 0
      }
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
