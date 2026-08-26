// The SECOND test channel: real Chrome driving the WEB build of the renderer.
//
// WHY THIS EXISTS
// ---------------
// Every UI suite in this repo drives Electron (scripts/lib/electron-test-app.mjs).
// Electron's renderer is emitted by electron-vite, which happens to leave it
// UNMINIFIED. `npm run build:mobile` (vite.mobile.config.mjs) is the same
// renderer source through Vite's default `build.minify: 'esbuild'`. Defect D4
// lived exactly in that gap: the kernel identified ProseMirror steps by
// `step.constructor.name`, esbuild renamed `ReplaceStep` to `ki`, and the
// editor was silently READ-ONLY in every minified build while all 100+ Electron
// suites stayed green. A channel that runs the MINIFIED bundle is the only
// thing that can see that class of defect.
//
// This helper mirrors scripts/lib/electron-test-app.mjs's shape and ergonomics
// on purpose: same `{ evaluate, send, dialogs, setDialogResponse }` surface from
// the repo's own `connectCdp`, same CDP-port squatter guard, same
// DevToolsActivePort ownership proof, same "teardown waits for the port to
// actually stop answering" discipline. A suite written against one channel
// reads almost identically against the other.
//
// WHAT IT IS NOT. This channel has no main process: no file watchers, no native
// menus (so no Ctrl/Cmd+S — Save must go through `.hm-save-fab` or the command
// palette), no PDF/HTML/Pandoc export, no process-lifecycle cold reopen, and no
// `--horsemd-legacy-default` bridge (the web shim exposes no `legacyDefault`, so
// the kernel is always default-ON here). See docs/development.md.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile, rm, mkdtemp, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { connectCdp, sleep } from './cdp.mjs'

// ---------------------------------------------------------------------------
// Chrome discovery
// ---------------------------------------------------------------------------
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
]

export function findChrome() {
  const preferred = process.env.CHROME_PATH
  if (preferred) {
    if (!existsSync(preferred)) {
      throw new Error(`CHROME_PATH points at a missing executable: ${preferred}`)
    }
    return preferred
  }
  const found = CHROME_CANDIDATES.find((candidate) => existsSync(candidate))
  if (!found) {
    throw new Error('No Chrome/Chromium found. Install Google Chrome or set CHROME_PATH=/path/to/chrome')
  }
  return found
}

// ---------------------------------------------------------------------------
// Web build (dist-mobile/) — build only when it is missing or stale.
// ---------------------------------------------------------------------------
const SOURCE_ROOTS = ['src/renderer', 'src/shared']
const SOURCE_FILES = ['vite.mobile.config.mjs', 'package.json']
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist-mobile', 'out', 'dist'])

async function newestMtime(path) {
  let newest = 0
  const walk = async (current) => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const child = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(child)
        continue
      }
      try {
        const info = await stat(child)
        if (info.mtimeMs > newest) newest = info.mtimeMs
      } catch {
        /* raced with a write; the next run picks it up */
      }
    }
  }
  await walk(path)
  return newest
}

async function mtimeOf(path) {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return 0
  }
}

// `mode`: 'auto' (default) builds only when dist-mobile/index.html is missing or
// older than the newest renderer source; `true` always builds; `false` never
// does (and throws if the bundle is absent, rather than silently testing air).
export async function ensureWebBuild({ cwd = process.cwd(), distDir = 'dist-mobile', mode = 'auto' } = {}) {
  const outDir = resolve(cwd, distDir)
  const indexHtml = join(outDir, 'index.html')
  let build = mode === true
  if (mode !== true) {
    const builtAt = await mtimeOf(indexHtml)
    if (!builtAt) {
      if (mode === false) {
        throw new Error(`${indexHtml} is missing — run \`npm run build:mobile\` (or pass build: 'auto')`)
      }
      build = true
    } else if (mode === 'auto') {
      let newest = 0
      for (const root of SOURCE_ROOTS) newest = Math.max(newest, await newestMtime(resolve(cwd, root)))
      for (const file of SOURCE_FILES) newest = Math.max(newest, await mtimeOf(resolve(cwd, file)))
      build = newest > builtAt
    }
  }
  if (!build) return { outDir, built: false }

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  await new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(npm, ['run', 'build:mobile'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stdout.on('data', () => {})
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', rejectBuild)
    child.on('exit', (code) => {
      if (code === 0) resolveBuild()
      else rejectBuild(new Error(`npm run build:mobile exited ${code}\n${stderr.slice(-4000)}`))
    })
  })
  if (!existsSync(indexHtml)) {
    throw new Error(`npm run build:mobile succeeded but ${indexHtml} does not exist`)
  }
  return { outDir, built: true }
}

// ---------------------------------------------------------------------------
// Static HTTP server for dist-mobile/
// ---------------------------------------------------------------------------
// `vite.mobile.config.mjs` sets `base: './'`, so every asset resolves relative to
// the served document — a plain static server over http://127.0.0.1 is enough.
// It matters that this is HTTP and not file://: `file://` pages get an opaque
// origin, which would break localStorage (the session) and IndexedDB (the
// Capacitor Filesystem web backend the renderer's platform shim uses).
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
}

export async function serveDirectory(rootDir, { host = '127.0.0.1', port = 0 } = {}) {
  const root = resolve(rootDir)
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${host}`)
      let pathname = decodeURIComponent(url.pathname)
      if (pathname.endsWith('/')) pathname += 'index.html'
      // Normalize first, then require the result to stay inside root: a
      // traversal attempt (or a Windows-style separator) can never read outside
      // the bundle.
      const target = resolve(root, `.${normalize(pathname).replace(/^([/\\])+/, sep)}`)
      const inside = target === root || target.startsWith(root + sep)
      let body = null
      let file = target
      if (inside && existsSync(target) && (await stat(target)).isFile()) {
        body = await readFile(target)
      } else if (inside && !extname(target)) {
        // SPA fallback: an extension-less route is the app's own router, not a
        // missing asset. A missing ASSET must still 404 loudly.
        file = join(root, 'index.html')
        body = await readFile(file)
      }
      if (body == null) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('404')
        return
      }
      response.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
        'content-length': body.length,
        'cache-control': 'no-store'
      })
      response.end(request.method === 'HEAD' ? undefined : body)
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(String(error?.message || error))
    }
  })
  await new Promise((done, fail) => {
    server.once('error', fail)
    server.listen(port, host, done)
  })
  const address = server.address()
  return {
    server,
    host,
    port: typeof address === 'object' && address ? address.port : port,
    origin: `http://${host}:${typeof address === 'object' && address ? address.port : port}`,
    close: () => new Promise((done) => {
      server.closeAllConnections?.()
      server.close(() => done())
    })
  }
}

// ---------------------------------------------------------------------------
// CDP-port hygiene — same reasoning as electron-test-app.mjs (see its header):
// a bound `--remote-debugging-port` does NOT make Chromium fail to start, it
// makes `connectCdp` attach to whoever already owns the port, so the suite
// silently drives a FOREIGN window and still reports a verdict.
// ---------------------------------------------------------------------------
async function probeCdp(port, timeoutMs = 1200) {
  if (!Number.isFinite(port)) return null
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs)
    })
    return await response.json()
  } catch {
    return null
  }
}

// OWNERSHIP PROOF. electron-test-app.mjs reads `<profile>/DevToolsActivePort`,
// but Chrome 151's `--headless=new` never writes that file (verified: the file
// is absent for the whole session while the server answers normally), so the
// same check here would fail every launch. Chrome does something stronger
// instead: the child prints its OWN endpoint to stderr —
//   DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<uuid>
// That uuid is per-browser-process, so matching it against the uuid in
// `/json/version`'s `webSocketDebuggerUrl` proves the server on `port` IS this
// child and not a squatter that slipped in between the pre-launch probe and the
// connect. Fail loudly if the banner never arrives.
const DEVTOOLS_BANNER = /DevTools listening on (ws:\/\/[^\s]+)/

function watchForDevToolsEndpoint(child) {
  let endpoint = null
  const waiters = []
  child.stderr.on('data', (chunk) => {
    if (endpoint) return
    const match = DEVTOOLS_BANNER.exec(String(chunk))
    if (!match) return
    endpoint = match[1]
    for (const done of waiters.splice(0)) done(endpoint)
  })
  return (timeoutMs = 20000) => new Promise((done) => {
    if (endpoint) { done(endpoint); return }
    const timer = setTimeout(() => done(null), timeoutMs)
    waiters.push((value) => { clearTimeout(timer); done(value) })
  })
}

const browserIdOf = (wsUrl) => (typeof wsUrl === 'string' ? wsUrl.split('/').pop() || null : null)

async function assertOwnsPort(waitForEndpoint, port) {
  const endpoint = await waitForEndpoint()
  if (!endpoint) {
    throw new Error(`Chrome never announced a DevTools endpoint for port ${port
      } — it may have failed to bind (a foreign process could be serving that port)`)
  }
  const announcedPort = Number(new URL(endpoint.replace(/^ws/, 'http')).port)
  if (announcedPort !== port) {
    throw new Error(`Chrome bound DevTools to ${announcedPort}, not the requested ${port}`)
  }
  const live = await probeCdp(port)
  const ours = browserIdOf(endpoint)
  const serving = browserIdOf(live?.webSocketDebuggerUrl)
  if (!serving || serving !== ours) {
    throw new Error(`CDP port ${port} is served by browser ${serving || 'unknown'
      }, not the child this helper launched (${ours}): refusing to drive a foreign browser`)
  }
}

async function waitForPortRelease(port, { attempts = 60, intervalMs = 100 } = {}) {
  if (!Number.isFinite(port)) return true
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!await probeCdp(port, 300)) return true
    await sleep(intervalMs)
  }
  return false
}

const CHROME_FLAGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-hang-monitor',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-sync',
  '--disable-dev-shm-usage',
  '--metrics-recording-only',
  '--mute-audio',
  '--password-store=basic',
  '--use-mock-keychain',
  '--hide-scrollbars'
]

// ---------------------------------------------------------------------------
// launchChromeWeb — the entry point a suite calls.
// ---------------------------------------------------------------------------
export async function launchChromeWeb({
  port = Number(process.env.CDP_PORT || 9401),
  httpPort = 0,
  profileDir,
  cwd = process.cwd(),
  distDir = 'dist-mobile',
  build = 'auto',
  executable,
  headless = process.env.HORSEMD_CHROME_HEADED ? false : true,
  windowSize = '1440,960',
  route = '/',
  extraArgs = [],
  navigateTimeoutMs = 30000
} = {}) {
  const chrome = executable || findChrome()
  const { outDir, built } = await ensureWebBuild({ cwd, distDir, mode: build })

  const squatter = await probeCdp(port)
  if (squatter) {
    throw new Error(`CDP port ${port} is already serving ${squatter.Browser || 'an unknown browser'
      }: refusing to launch a second browser that would silently drive the wrong page`)
  }

  const http = await serveDirectory(outDir, { port: httpPort })
  const ownedProfile = !profileDir
  const resolvedProfile = profileDir || await mkdtemp(join(tmpdir(), 'horsemd-chrome-'))
  if (profileDir) await rm(profileDir, { recursive: true, force: true })

  let child = null
  let cdp = null
  const consoleErrors = []
  const consoleMessages = []
  const pageExceptions = []
  const requestFailures = []

  const teardown = async () => {
    try { cdp?.ws?.close() } catch {}
    if (child && child.exitCode == null) {
      child.kill('SIGTERM')
      await Promise.race([
        new Promise((done) => child.once('exit', done)),
        sleep(3000).then(() => { if (child.exitCode == null) child.kill('SIGKILL') })
      ])
    }
    await waitForPortRelease(port)
    await http.close()
    if (ownedProfile) await rm(resolvedProfile, { recursive: true, force: true })
  }

  try {
    child = spawn(chrome, [
      ...(headless ? ['--headless=new'] : []),
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${resolvedProfile}`,
      `--window-size=${windowSize}`,
      ...CHROME_FLAGS,
      ...extraArgs,
      // Launch on about:blank and navigate afterwards, so the single page target
      // connectCdp picks is unambiguously the one this helper drives.
      'about:blank'
    ], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', () => {})
    const waitForEndpoint = watchForDevToolsEndpoint(child)
    child.stderr.on('data', () => {})

    await assertOwnsPort(waitForEndpoint, port)
    cdp = await connectCdp({ port, attempts: 80, intervalMs: 250 })

    // Console + exception capture. connectCdp installs its own `message`
    // listener (dialogs); WebSocket supports many, so this one is additive.
    cdp.ws.addEventListener('message', (event) => {
      let message
      try { message = JSON.parse(event.data) } catch { return }
      if (message.id) return
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params?.exceptionDetails || {}
        pageExceptions.push({
          text: details.exception?.description || details.text || 'unknown exception',
          url: details.url || null,
          line: details.lineNumber ?? null
        })
        return
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        const text = (message.params?.args || [])
          .map((arg) => arg.value ?? arg.description ?? arg.unserializableValue ?? '')
          .join(' ')
        const entry = { type: message.params?.type, text }
        consoleMessages.push(entry)
        if (entry.type === 'error') consoleErrors.push(entry)
        return
      }
      if (message.method === 'Log.entryAdded') {
        const entry = message.params?.entry || {}
        consoleMessages.push({ type: entry.level, text: entry.text, source: entry.source })
        if (entry.level === 'error') consoleErrors.push({ type: 'error', text: entry.text, source: entry.source })
        return
      }
      if (message.method === 'Network.loadingFailed') {
        requestFailures.push(message.params?.errorText || 'unknown')
      }
    })
    await cdp.send('Runtime.enable').catch(() => {})
    await cdp.send('Log.enable').catch(() => {})

    const url = `${http.origin}${route.startsWith('/') ? route : `/${route}`}`

    // Wait for the load event of THIS navigation, not a stale one.
    const waitForLoad = (timeoutMs) => new Promise((done, fail) => {
      const timer = setTimeout(() => {
        cdp.ws.removeEventListener('message', onMessage)
        fail(new Error(`page load timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      function onMessage(event) {
        let message
        try { message = JSON.parse(event.data) } catch { return }
        if (message.method !== 'Page.loadEventFired') return
        clearTimeout(timer)
        cdp.ws.removeEventListener('message', onMessage)
        done()
      }
      cdp.ws.addEventListener('message', onMessage)
    })

    // Runs BEFORE any of the page's own scripts on every subsequent load.
    // This is the only reliable way to seed localStorage (the session) for a
    // reload: writing it from an already-booted page loses the race with the
    // app's own persistence effect, which re-serializes its live (empty) tab
    // list over your value before you get to reload. It is also how a suite
    // installs an interceptor on `window.api` before the platform shim exists.
    const addInitScript = async (source) => {
      const { result } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source })
      return result?.identifier ?? null
    }
    const removeInitScript = (identifier) => (
      identifier ? cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }) : Promise.resolve()
    )

    const navigate = async (target = url, { timeoutMs = navigateTimeoutMs } = {}) => {
      const loaded = waitForLoad(timeoutMs)
      await cdp.send('Page.navigate', { url: target })
      await loaded
    }
    const reload = async ({ timeoutMs = navigateTimeoutMs } = {}) => {
      const loaded = waitForLoad(timeoutMs)
      await cdp.send('Page.reload', { ignoreCache: false })
      await loaded
    }

    await navigate(url)

    const app = {
      ...cdp,
      child,
      chromePath: chrome,
      profileDir: resolvedProfile,
      port,
      httpPort: http.port,
      origin: http.origin,
      url,
      outDir,
      built,
      launched: true,
      consoleErrors,
      consoleMessages,
      pageExceptions,
      requestFailures,
      navigate,
      reload,
      addInitScript,
      removeInitScript,
      stop: teardown
    }
    return app
  } catch (error) {
    await teardown()
    throw error
  }
}

// Mirrors stopBuiltElectron's name/shape so the two channels read alike.
export async function stopChromeWeb(app) {
  if (!app) return
  await app.stop()
}
