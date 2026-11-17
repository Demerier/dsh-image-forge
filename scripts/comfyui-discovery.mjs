/**
 * This machine's ComfyUI facts and process mechanics, in one implementation
 * shared by the plugin's environment layer (`src/environment.ts`) and the
 * human CLI (`scripts/start-comfyui.mjs`) — so the two cannot drift about
 * where an install is, how it was launched, or whether it answered.
 *
 * Where the facts come from, in order:
 *   1. an explicit install directory (`--dir` / `COMFYUI_DIR`) — explicit wins;
 *   2. Comfy Desktop's own registry (`%APPDATA%/Comfy Desktop/installations.json`):
 *      install path, `launchArgs`, `envVars`, port, plus `settings.json` for the
 *      shared input/output dirs and `instance-model-paths/<id>.yaml` for the
 *      model roots. **The flags are read, never invented or edited** — whatever
 *      Comfy Desktop would pass, this passes;
 *   3. a bounded scan for `<root>/**\/ComfyUI/main.py` with a sibling Python
 *      (`standalone-env/python.exe`, `python_embeded/python.exe`,
 *      `.venv/Scripts/python.exe`) for portable / plain installs.
 *
 * Plain ESM + Node stdlib only. Two reasons: the CLI must run in a fresh clone
 * **before** `npm run build`, and the plugin imports this file so rolldown inlines
 * it — the published `lib/index.js` stays self-contained.
 */

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, platform as osPlatform } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** How long a launch waits for `/system_stats` unless the caller says otherwise. */
export const DEFAULT_INSTALL_TIMEOUT_MS = 180_000

/** Split a Desktop `launchArgs` string the way a shell would for the simple cases it uses. */
export function splitArgs(s) {
  if (!s) return []
  const out = []
  let cur = ''
  let quote = null
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
    } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/** Parse JSON, or return `null` when the file is absent / unreadable / not JSON. */
export function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Windows' roaming AppData root, where Comfy Desktop keeps its registry. */
export function appDataRoot(env = process.env) {
  return env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
}

/** The directories a portable / plain install is most likely under. */
export function defaultScanRoots(platform = osPlatform(), home = homedir()) {
  return platform === 'win32'
    ? ['D:\\', 'E:\\', 'C:\\', join(home, 'Documents'), join(home, 'Desktop')]
    : [home, '/opt', '/usr/local']
}

/** Does this env root actually have the package that matters (`torch`) installed? */
export function hasTorch(envRoot) {
  const direct = join(envRoot, 'Lib', 'site-packages', 'torch')
  if (existsSync(direct)) return true
  const lib = join(envRoot, 'lib')
  if (!existsSync(lib)) return false
  try {
    return readdirSync(lib).some((d) => d.startsWith('python') && existsSync(join(lib, d, 'site-packages', 'torch')))
  } catch {
    return false
  }
}

/**
 * The Python interpreter that belongs to an install.
 *
 * Comfy Desktop 0.34 puts the CUDA env in `<install>/ComfyUI/.venv` and ships a
 * bare `standalone-env` next to it — that one has **no torch**, so picking it
 * because it sorts first lands on `ModuleNotFoundError: No module named 'torch'`.
 * Any candidate that can prove it has torch wins; the rest are fallbacks.
 */
export function findPython(installPath, mainPy, platform = osPlatform()) {
  const roots =
    platform === 'win32'
      ? [
          join(dirname(mainPy ?? ''), '.venv'), // Desktop per-instance uv env
          join(installPath, 'ComfyUI', '.venv'),
          join(installPath, '.venv'),
          join(installPath, 'venv'),
          join(installPath, 'python_embeded'),
          join(dirname(mainPy ?? ''), 'python_embeded'),
          join(installPath, 'standalone-env'),
        ]
      : [join(dirname(mainPy ?? ''), '.venv'), join(installPath, '.venv'), join(installPath, 'venv')]
  const exe = platform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python')
  const candidates = roots.map((r) =>
    r.endsWith('python_embeded') || r.endsWith('standalone-env') ? join(r, 'python.exe') : join(r, exe),
  )
  const existing = candidates.filter((p) => existsSync(p))
  const withTorch = existing.filter((p) => hasTorch(dirname(dirname(p))))
  return withTorch[0] ?? existing[0] ?? null
}

/** `<install>/ComfyUI/main.py` for the Desktop layout, `main.py` for a plain checkout. */
export function findMainPy(installPath) {
  const candidates = [join(installPath, 'ComfyUI', 'main.py'), join(installPath, 'main.py')]
  return candidates.find((p) => existsSync(p)) ?? null
}

/**
 * Build a plan from one Comfy Desktop installation record.
 *
 * @returns the plan, or `null` when this record does not point at a usable
 *   install (cloud-only records have no `installPath` at all).
 */
export function planFromDesktop(install, desktopRoot, platform = osPlatform()) {
  const installPath = install?.installPath
  if (!installPath || !existsSync(installPath)) return null
  const mainPy = findMainPy(installPath)
  const python = findPython(installPath, mainPy, platform)
  if (!mainPy || !python) return null

  const settings = readJsonFile(join(desktopRoot, 'settings.json')) ?? {}
  const modelPathsDir = join(desktopRoot, 'instance-model-paths')
  let modelPathsConfig = null
  if (existsSync(modelPathsDir)) {
    const own = join(modelPathsDir, `${install.id}.yaml`)
    modelPathsConfig = existsSync(own)
      ? own
      : (readdirSync(modelPathsDir)
          .filter((f) => f.endsWith('.yaml'))
          .map((f) => join(modelPathsDir, f))[0] ?? null)
  }

  const argv = []
  if (platform === 'win32') argv.push('-s')
  argv.push(mainPy)
  argv.push('--listen', '127.0.0.1', '--port', String(install.port ?? 8188))
  if (modelPathsConfig) argv.push('--extra-model-paths-config', modelPathsConfig)
  if (settings.outputDir) argv.push('--output-directory', settings.outputDir)
  if (settings.inputDir) argv.push('--input-directory', settings.inputDir)
  for (const extra of splitArgs(install.launchArgs)) argv.push(extra)

  return {
    source: `Comfy Desktop (${install.name ?? install.id}${install.version ? ` ${install.version}` : ''})`,
    installPath,
    mainPy,
    python,
    cwd: dirname(mainPy),
    port: Number(install.port ?? 8188),
    argv,
    env: { ...install.envVars, PYTHONUTF8: '1' },
    logDir: join(installPath, 'logs'),
  }
}

/** Bounded scan for portable / plain installs, for machines without Comfy Desktop. */
export function planFromScan(root, platform = osPlatform(), depth = 2) {
  if (!root || !existsSync(root)) return null
  const skip = new Set([
    'node_modules',
    '.git',
    'Windows',
    'Program Files',
    'Program Files (x86)',
    '$Recycle.Bin',
    'System Volume Information',
  ])
  const walk = (dir, left) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const e of entries) {
      if (!e.isDirectory() || skip.has(e.name)) continue
      const child = join(dir, e.name)
      if (e.name.toLowerCase() === 'comfyui') {
        const mainPy = join(child, 'main.py')
        const python = findPython(dir, mainPy, platform)
        if (existsSync(mainPy) && python) {
          return {
            source: `scan (${child})`,
            installPath: dir,
            mainPy,
            python,
            cwd: child,
            port: 8188,
            argv: [...(platform === 'win32' ? ['-s'] : []), mainPy, '--listen', '127.0.0.1', '--port', '8188'],
            env: { PYTHONUTF8: '1' },
            logDir: join(child, 'user'),
          }
        }
      }
      if (left > 0) {
        const hit = walk(child, left - 1)
        if (hit) return hit
      }
    }
    return null
  }
  return walk(root, depth)
}

/**
 * Comfy Desktop's registry, as data.
 *
 * `installations` is `null` when the machine has never run Desktop (no file) or
 * the file is not the array the script expects — the two cases the caller has
 * to phrase differently when it reports “not installed”.
 */
export function desktopRegistry({ appData = appDataRoot(), env = process.env } = {}) {
  const root = join(appData ?? appDataRoot(env), 'Comfy Desktop')
  const installations = readJsonFile(join(root, 'installations.json'))
  return { root, installations: Array.isArray(installations) ? installations : null }
}

/**
 * Find out how this machine would run ComfyUI — starting nothing, writing nothing.
 *
 * @param {object} [options]
 * @param {string} [options.dir] - explicit install directory; wins over everything.
 * @param {Record<string, string | undefined>} [options.env] - environment to read.
 * @param {NodeJS.Platform} [options.platform] - platform to plan for.
 * @param {string} [options.appData] - APPDATA root to read the Desktop registry from.
 * @param {string} [options.home] - home directory for the default scan roots.
 * @param {readonly string[]} [options.scanRoots] - scan roots; `[]` disables the scan.
 * @returns the plan, or `null` when nothing was found.
 * @throws when an explicitly named directory is not a usable install.
 */
export function discoverComfyPlan({
  dir,
  env = process.env,
  platform = osPlatform(),
  appData,
  home = homedir(),
  scanRoots,
} = {}) {
  if (dir) {
    const installPath = resolve(dir)
    const mainPy = findMainPy(installPath)
    const python = findPython(installPath, mainPy, platform)
    if (!mainPy || !python) throw new Error(`--dir ${installPath}: no main.py or no Python found inside`)
    return {
      source: `--dir (${installPath})`,
      installPath,
      mainPy,
      python,
      cwd: dirname(mainPy),
      port: 8188,
      argv: [...(platform === 'win32' ? ['-s'] : []), mainPy, '--listen', '127.0.0.1', '--port', '8188'],
      env: { PYTHONUTF8: '1' },
      logDir: join(installPath, 'logs'),
    }
  }

  if (env.COMFYUI_DIR) {
    return discoverComfyPlan({ env, platform, appData, home, scanRoots, dir: env.COMFYUI_DIR })
  }

  const registry = desktopRegistry({ appData: appData ?? appDataRoot(env), env })
  if (registry.installations) {
    for (const install of registry.installations) {
      if (install.status && install.status !== 'installed') continue
      const plan = planFromDesktop(install, registry.root, platform)
      if (plan) return plan
    }
  }

  const roots = scanRoots ?? defaultScanRoots(platform, home)
  for (const root of roots) {
    const plan = planFromScan(root, platform)
    if (plan) return plan
  }

  return null
}

/** Where a launch record written by {@link launchComfyPlan} lives. */
export function launchRecordPath(plan) {
  return join(plan.logDir ?? plan.installPath, 'dsh-image-forge-launch.json')
}

/** The launch record of a previous start, or `null` when there is none. */
export function readLaunchRecord(plan) {
  return readJsonFile(launchRecordPath(plan))
}

/**
 * Ask one endpoint whether it is ComfyUI, via `/system_stats`.
 *
 * Deliberately shallow: callers that need the full contract (a 2xx whose body is
 * actually ComfyUI's) use the plugin's `discoverComfyUi`; this one is for the
 * launch wait and the CLI, where a JSON answer is enough to say “up”.
 *
 * @returns the parsed stats payload, or `null` when nothing answered.
 */
export async function systemStats(endpoint, { timeoutMs = 2500, fetchImpl = fetch } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${endpoint}/system_stats`, { signal: ctrl.signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Default sleep used by {@link waitForComfyStats}; injected by tests. */
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Start a planned install **detached**, with its output in a log file and the pid
 * recorded next to it, and return immediately.
 *
 * The child is unref'd: the plugin/CLI must be able to exit without taking the
 * renderer down, which is what “started in the background” means here.
 *
 * @returns `{ pid, logPath, recordPath, child }`.
 */
export function launchComfyPlan(plan, { spawn: spawnImpl = spawn, endpoint = null } = {}) {
  if (!existsSync(plan.logDir)) mkdirSync(plan.logDir, { recursive: true })
  const logPath = join(plan.logDir, `dsh-image-forge-launch-${Date.now()}.log`)
  const fd = openSync(logPath, 'a')
  let child
  try {
    child = spawnImpl(plan.python, plan.argv, {
      cwd: plan.cwd,
      env: { ...process.env, ...plan.env },
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    })
  } finally {
    closeSync(fd)
  }
  child.unref()
  const recordPath = launchRecordPath(plan)
  const record = { pid: child.pid, endpoint, startedAt: new Date().toISOString(), logPath }
  try {
    mkdirSync(dirname(recordPath), { recursive: true })
  } catch {
    // The log dir exists in every normal layout; a missing parent must not turn
    // a started renderer into a failed launch.
  }
  try {
    writeFileSync(recordPath, JSON.stringify(record, null, 2))
  } catch {
    // Same reason: the process is up either way.
  }
  return { pid: child.pid, logPath, recordPath, child }
}

/**
 * Poll `/system_stats` until ComfyUI answers, the child exits, or the budget runs out.
 *
 * @returns `{ ok: true, stats, waitedMs }` or
 *   `{ ok: false, reason: 'exited' | 'timeout', waitedMs, exitCode }`.
 */
export async function waitForComfyStats(
  endpoint,
  { child = null, timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS, intervalMs = 1000, fetchImpl = fetch, now = Date.now, sleep = defaultSleep, onWait } = {},
) {
  const startedAt = now()
  const deadline = startedAt + timeoutMs
  while (now() < deadline) {
    const stats = await systemStats(endpoint, { timeoutMs: Math.min(2000, Math.max(250, deadline - now())), fetchImpl })
    if (stats) return { ok: true, stats, waitedMs: now() - startedAt }
    if (child && child.exitCode !== null && child.exitCode !== undefined) {
      return { ok: false, reason: 'exited', exitCode: child.exitCode, waitedMs: now() - startedAt }
    }
    onWait?.()
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())))
  }
  return { ok: false, reason: 'timeout', waitedMs: now() - startedAt }
}

/**
 * Stop an instance that {@link launchComfyPlan} started.
 *
 * On Windows the whole process tree has to go (`taskkill /F /T`): ComfyUI is a
 * Python parent plus workers, and `process.kill` leaves the children behind.
 * This is the shared interface T15 reuses for its `comfy-mcp` child.
 *
 * @returns `{ stopped, pid, note }` — `stopped: false` when there was no record.
 */
export function stopComfyPlan(plan, { platform = osPlatform(), spawnSync: sync = spawnSync, kill = process.kill } = {}) {
  const record = readLaunchRecord(plan)
  if (!record) return { stopped: false, pid: null, note: `no launch record at ${launchRecordPath(plan)}` }
  if (!record.pid) return { stopped: false, pid: null, note: `${launchRecordPath(plan)} has no pid` }
  if (platform === 'win32') {
    sync('taskkill', ['/PID', String(record.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    kill(record.pid, 'SIGTERM')
  }
  return { stopped: true, pid: record.pid, note: `signalled pid ${record.pid}` }
}
