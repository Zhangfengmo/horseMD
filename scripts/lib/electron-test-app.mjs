import { readFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import electronPath from 'electron'
import { connectCdp, sleep } from './cdp.mjs'

// A CDP port is a silent single point of failure. When `--remote-debugging-port`
// is already bound, Chromium does NOT fail to start: it logs to stderr (which
// these helpers discard) and keeps running without a DevTools server. The
// subsequent `connectCdp()` then attaches to whichever process ALREADY owns the
// port, so the test drives a foreign window while its own app sits idle in the
// background. Every assertion still runs, so the result is not an error but a
// verdict about the wrong document — the worst possible failure mode for a
// suite that exists to protect byte-level fidelity. Measured on this suite,
// `test-table-scroll-ui.mjs` had been doing exactly that. These probes make the
// condition loud and immediate instead.
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

// Chromium writes the DevTools server's real port into the profile directory
// once the server is listening. A fresh profile that never grows the file (or
// grows it with a different port) is proof that this child is not the process
// answering on `port`.
async function readActiveDevToolsPort(profileDir) {
  try {
    const raw = await readFile(`${profileDir}/DevToolsActivePort`, 'utf8')
    return Number(raw.split('\n')[0])
  } catch {
    return null
  }
}

async function waitForOwnDevToolsPort(profileDir, port, { attempts = 30, intervalMs = 100 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await readActiveDevToolsPort(profileDir) === port) return true
    await sleep(intervalMs)
  }
  return false
}

// Killing the process is not the same as releasing the port. Back-to-back
// launches on one port (`port`, then `port + 1`, then the same port again in the
// next test) must not be able to attach to an instance that is still shutting
// down, so teardown ends only once the port has actually stopped answering.
async function waitForPortRelease(port, { attempts = 60, intervalMs = 100 } = {}) {
  if (!Number.isFinite(port)) return true
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!await probeCdp(port, 300)) return true
    await sleep(intervalMs)
  }
  return false
}

export async function launchBuiltElectron({
  profileDir,
  port,
  cleanProfile = true,
  cwd = process.cwd(),
  appArgs = [],
  executable = electronPath,
  entrypoint = 'out/main/index.cjs',
  background = true,
  env = process.env
}) {
  if (cleanProfile && profileDir) await rm(profileDir, { recursive: true, force: true })
  const squatter = await probeCdp(port)
  if (squatter) {
    throw new Error(`CDP port ${port} is already serving ${squatter.Browser || 'an unknown browser'
      }: refusing to launch a second app that would silently drive the wrong window`)
  }
  const child = spawn(executable, [
    ...(profileDir ? [`--user-data-dir=${profileDir}`] : []),
    `--remote-debugging-port=${port}`,
    ...(entrypoint ? [entrypoint] : []),
    ...(background ? ['--horsemd-test-background'] : []),
    ...appArgs
  ], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  const cdp = await connectCdp({ port, attempts: 80, intervalMs: 250 })
  if (profileDir && !await waitForOwnDevToolsPort(profileDir, port)) {
    try { cdp.ws?.close() } catch {}
    if (child.exitCode == null) child.kill('SIGKILL')
    throw new Error(`the app launched for CDP port ${port} never claimed it (${profileDir
      }/DevToolsActivePort): the attached target belongs to another process`)
  }
  await sleep(800)
  return { ...cdp, child, profileDir, port, launched: true }
}

export async function connectOrLaunchBuiltElectron({
  profileDir,
  port,
  cleanProfile = true,
  cwd = process.cwd()
}) {
  try {
    const cdp = await connectCdp({ port, attempts: 4, intervalMs: 150 })
    return { ...cdp, child: null, profileDir, port, launched: false }
  } catch {
    return launchBuiltElectron({ profileDir, port, cleanProfile, cwd })
  }
}

export async function stopBuiltElectron(app, { removeProfile = false } = {}) {
  try {
    app?.ws?.close()
  } catch {}
  if (app?.child && app.child.exitCode == null) {
    app.child.kill('SIGTERM')
    await Promise.race([
      new Promise((resolve) => app.child.once('exit', resolve)),
      sleep(3000).then(() => {
        if (app.child.exitCode == null) app.child.kill('SIGKILL')
      })
    ])
  }
  // Only an app this helper started owns its port; a borrowed connection
  // (connectOrLaunchBuiltElectron reuse) must not wait for someone else's app.
  if (app?.launched) await waitForPortRelease(app.port)
  if (removeProfile && app?.profileDir) {
    await rm(app.profileDir, { recursive: true, force: true })
  }
}
