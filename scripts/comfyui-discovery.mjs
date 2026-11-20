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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
 * The plan a launch would actually run, with the port and any extra flags applied.
 *
 * **One source for the port.** `--port` in argv, `plan.port`, the record and the
 * endpoint the caller waits on must all name the same port; when the caller
 * pinned a port (the panel's `comfyEndpoint`), that port wins over whatever the
 * Desktop record said — otherwise a `comfyEndpoint` of `:8000` launches `:8188`
 * and then waits on `:8188` forever while the panel probes `:8000`.
 *
 * `extraArgs` is the seam later stages use for user-specified launch flags. It
 * defaults to nothing: with no override this function returns the plan it was
 * given, argv included, byte for byte.
 *
 * @param {object} plan - a plan from {@link discoverComfyPlan}.
 * @param {object} [options]
 * @param {number|null} [options.port] - port that must win over the planned one.
 * @param {readonly string[]} [options.extraArgs] - flags appended after the
 *   planned argv; empty/omitted appends nothing.
 * @returns the plan, or a copy with `port`/`argv` adjusted.
 */
export function planForRun(plan, { port = null, extraArgs = [] } = {}) {
  if (!plan) return plan
  const extra = Array.isArray(extraArgs) ? extraArgs.filter((arg) => typeof arg === 'string' && arg.length > 0) : []
  const wanted = Number(port)
  const override = Number.isInteger(wanted) && wanted >= 1 && wanted <= 65535 && wanted !== Number(plan.port)
  if (!override && extra.length === 0) return plan
  const argv = Array.isArray(plan.argv) ? [...plan.argv] : []
  if (override) {
    const at = argv.indexOf('--port')
    if (at >= 0 && at + 1 < argv.length) argv[at + 1] = String(wanted)
    else argv.push('--port', String(wanted))
  }
  for (const arg of extra) argv.push(arg)
  return { ...plan, ...(override ? { port: wanted } : {}), argv }
}

/**
 * The port of a loopback endpoint, or `null` when it is not a local address.
 *
 * This is the rule behind “the configured endpoint wins”: only a loopback URL
 * can be satisfied by a locally launched renderer, so only a loopback URL gets
 * to pin the `--port` a launch uses.
 */
export function loopbackPortOf(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) return null
  try {
    const url = new URL(endpoint)
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return null
    const port = Number(url.port.length > 0 ? url.port : (url.protocol === 'https:' ? 443 : 80))
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
  } catch {
    return null
  }
}

/**
 * The command line of one live process, or `null` when it cannot be read.
 *
 * Windows has no `/proc`, so this asks WMI (and the legacy `wmic` as a second
 * try); POSIX reads `ps -o command=`. `null` is a real answer, not an error: the
 * stop path treats "cannot read it" as "cannot prove ownership" and refuses
 * rather than guessing, which is the only safe direction for a kill.
 *
 * @param {number} pid - process to inspect.
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.platform] - platform to inspect for.
 * @param {Function} [options.spawnSync] - `child_process.spawnSync`-shaped hook.
 * @returns {string|null} the command line, or `null`.
 */
export function processCommandLine(pid, { platform = osPlatform(), spawnSync: sync = spawnSync } = {}) {
  const target = Number(pid)
  if (!Number.isInteger(target) || target <= 0) return null
  const read = (command, args) => {
    try {
      const result = sync(command, args, { encoding: 'utf8', timeout: 5_000, windowsHide: true })
      if (!result || result.status !== 0) return null
      const text = typeof result.stdout === 'string' ? result.stdout.trim() : ''
      return text.length > 0 ? text : null
    } catch {
      return null
    }
  }
  if (platform === 'win32') {
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${target}").CommandLine`
    return (
      read('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]) ??
      read('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script]) ??
      read('wmic', ['process', 'where', `processid=${target}`, 'get', 'commandline', '/value'])
    )
  }
  return read('ps', ['-o', 'command=', '-p', String(target)])
}

/**
 * Is this pid alive right now? Deliberately weaker than {@link processCommandLine}:
 * signal 0 asks the OS whether the process exists, nothing more.
 */
export function isProcessAlive(pid, { kill = process.kill } = {}) {
  const target = Number(pid)
  if (!Number.isInteger(target) || target <= 0) return false
  try {
    kill(target, 0)
    return true
  } catch (error) {
    // EPERM means "exists but not ours" — that is still alive.
    return error && error.code === 'EPERM'
  }
}

/** Forget the launch record of an instance that is gone. */
export function removeLaunchRecord(plan) {
  try {
    rmSync(launchRecordPath(plan), { force: true })
    return true
  } catch {
    return false
  }
}

/** Two paths that name the same file, tolerating quoting and separators. */
function samePathInCommandLine(commandLine, mainPy) {
  if (!commandLine || !mainPy) return false
  const normalise = (value) => String(value).replace(/["']/g, '').replace(/\\/g, '/').toLowerCase()
  return normalise(commandLine).includes(normalise(mainPy))
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
 * Open a **separate, disposable** terminal window that tails a launch log.
 *
 * The ComfyUI child itself is always started detached and hidden — its window
 * would be an empty console that a user can close by accident, taking the GPU
 * process with it. This helper opens a second process that only *reads* the log,
 * so closing it is harmless: ComfyUI keeps running. On Windows PowerShell's
 * `Get-Content -Wait` is a live tail; on POSIX we try a few common terminals
 * and report which one we found. The returned child is unref'd, so the plugin
 * can exit without holding it.
 *
 * @returns {object} { opened, command } — `opened` is false when no terminal
 *   could be found; `command` is what was tried (for the report).
 */
export function openLogTerminal(logPath, { platform = osPlatform(), spawn: spawnImpl = spawn } = {}) {
  let command
  if (platform === 'win32') {
    // `cmd /c start` creates a brand-new console window whose stdout IS that
    // window. A bare spawn(powershell, { stdio: 'ignore' }) throws the tail
    // output away to NUL, which is exactly the empty-window symptom.
    // The quoted first argument is the window title; Node quotes it for us.
    // ComfyUI writes UTF-8 (the launch env sets PYTHONUTF8=1). Windows PowerShell
    // decodes with the system ANSI code page by default, so CJK turns to mojibake
    // in the window. Force UTF-8 both on the console output and on the reader.
    const tail = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); chcp 65001 > $null; Get-Content -LiteralPath '${String(logPath).replace(/'/g, "''")}' -Encoding UTF8 -Wait -Tail 80`
    command = {
      bin: 'cmd.exe',
      args: ['/d', '/c', 'start', 'ComfyUI 实时日志', 'powershell.exe', '-NoProfile', '-Command', tail],
      // Kept for the report and tests: the process that actually tails.
      tailBin: 'powershell.exe',
      tailArgs: [tail],
    }
  } else if (platform === 'darwin') {
    command = { bin: 'open', args: ['-a', 'Terminal', logPath] }
  } else {
    command = { bin: 'x-terminal-emulator', args: ['-e', 'tail', '-f', logPath] }
  }
  try {
    const child = spawnImpl(command.bin, command.args, {
      detached: true,
      windowsHide: false,
      // The launcher's own output is irrelevant: `start` opens a separate
      // console and hands the tail process that console as its stdout.
      stdio: 'ignore',
      shell: false,
    })
    child.unref()
    return { opened: true, command: command.bin }
  } catch {
    return { opened: false, command: command.bin }
  }
}

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
  // Why the record carries more than a pid: `stop` has to prove that the process
  // it is about to kill is the one this plugin started. A pid alone is not proof
  // (the OS recycles pids), while `mainPy`/`argv`/`port` are checkable against
  // the live process's command line. `history` keeps earlier launches visible:
  // a second start overwrites the primary key, and silently forgetting the
  // previous pid is how an orphan keeps holding the GPU.
  const previous = readLaunchRecord(plan)
  const history = Array.isArray(previous?.history) ? previous.history.slice(-4) : []
  if (previous && previous.pid && previous.pid !== child.pid) history.push(previous)
  const record = {
    pid: child.pid,
    endpoint,
    port: Number.isFinite(Number(plan.port)) ? Number(plan.port) : null,
    mainPy: plan.mainPy ?? null,
    python: plan.python ?? null,
    argv: Array.isArray(plan.argv) ? plan.argv : [],
    startedAt: new Date().toISOString(),
    logPath,
    history,
  }
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
 * Stop an instance that {@link launchComfyPlan} started — and only that one.
 *
 * On Windows the whole process tree has to go (`taskkill /F /T`): ComfyUI is a
 * Python parent plus workers, and `process.kill` leaves the children behind.
 * This is the shared interface T15 reuses for its `comfy-mcp` child.
 *
 * Four things here are deliberate:
 *
 * - **Ownership is proved before anything is signalled.** The record names a
 *   `mainPy`; the live process's command line is read back and must contain it.
 *   No command line (WMI blocked, pid already gone) means *no kill* — the answer
 *   is “无法确认该进程归属,未执行停止”, because killing an unrelated `python.exe`
 *   is not a recoverable mistake.
 * - **The exit code is part of the answer.** `spawnSync` used to be called with
 *   `stdio: 'ignore'` and its result discarded, so `stopped: true` only meant
 *   “a signal was sent”. A non-zero `taskkill` now reports `signal-failed`.
 * - **The port is re-checked.** A signal is not a shutdown: after the kill, the
 *   recorded endpoint is probed once more, and `verified` says whether
 *   `/system_stats` really stopped answering.
 * - **The record is deleted on success.** Otherwise the next click would try to
 *   stop a pid that is already gone, forever.
 *
 * @returns `{ stopped, pid, exitCode, reason, verified, note, recordPath }` —
 *   `stopped: false` when there was no record or ownership could not be proved.
 */
export async function stopComfyPlan(
  plan,
  {
    platform = osPlatform(),
    spawnSync: sync = spawnSync,
    kill = process.kill,
    commandLineOf = (pid) => processCommandLine(pid, { platform, spawnSync: sync }),
    fetchImpl = fetch,
    endpoint = null,
    verifyTimeoutMs = 2_500,
  } = {},
) {
  const recordPath = launchRecordPath(plan)
  const record = readLaunchRecord(plan)
  if (!record) return { stopped: false, pid: null, exitCode: null, reason: 'no-record', verified: null, note: `no launch record at ${recordPath}`, recordPath }
  const pid = Number(record.pid)
  if (!Number.isInteger(pid) || pid <= 0) {
    return { stopped: false, pid: null, exitCode: null, reason: 'no-pid', verified: null, note: `${recordPath} has no pid`, recordPath }
  }
  // 1. Identity. A record written before this check existed has no `mainPy`:
  //    it is not proof of ownership, so it is refused with an explanation.
  if (!record.mainPy) {
    return {
      stopped: false,
      pid,
      exitCode: null,
      reason: 'unverified',
      verified: null,
      note: `记录 ${recordPath} 里没有 mainPy，无法确认 pid ${pid} 是不是本插件拉起的进程，未执行停止（先手动确认，或重新用工作台的启动按钮拉起一次）。`,
      recordPath,
    }
  }
  let commandLine = null
  try {
    commandLine = commandLineOf(pid)
  } catch {
    commandLine = null
  }
  if (typeof commandLine !== 'string' || commandLine.length === 0) {
    return {
      stopped: false,
      pid,
      exitCode: null,
      reason: 'unverified',
      verified: null,
      note: `无法确认 pid ${pid} 的进程归属（读不到命令行），未执行停止。`,
      recordPath,
    }
  }
  if (!samePathInCommandLine(commandLine, record.mainPy)) {
    return {
      stopped: false,
      pid,
      exitCode: null,
      reason: 'not-owned',
      verified: null,
      note: `pid ${pid} 的命令行里没有记录的 main.py（${record.mainPy}），不是本插件拉起的进程，未执行停止。`,
      recordPath,
    }
  }

  // 2. Signal, keeping the exit code.
  let exitCode = null
  let reason = null
  let note = ''
  if (platform === 'win32') {
    let result = null
    try {
      result = sync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch (error) {
      note = `taskkill 执行失败：${error && error.message ? error.message : String(error)}`
      reason = 'signal-failed'
    }
    if (result) exitCode = typeof result.status === 'number' ? result.status : null
    if (exitCode !== null && exitCode !== 0) reason = 'signal-failed'
  } else {
    try {
      kill(pid, 'SIGTERM')
    } catch (error) {
      // ESRCH: the process is already gone. That is not a crash — it is the
      // answer "nothing to stop", and the record still gets cleaned up below.
      const code = error && error.code ? String(error.code) : ''
      reason = code === 'ESRCH' ? 'no-process' : 'signal-failed'
      note = code === 'ESRCH'
        ? `pid ${pid} 已经不在（ESRCH），没有发送信号`
        : `发送 SIGTERM 失败：${error && error.message ? error.message : String(error)}`
    }
  }

  // 3. Did the port really go quiet? Unverifiable without a recorded endpoint.
  const target = typeof endpoint === 'string' && endpoint.length > 0 ? endpoint : (typeof record.endpoint === 'string' ? record.endpoint : '')
  let verified = null
  if (target.length > 0) {
    const stats = await systemStats(target, { timeoutMs: Math.min(1_500, Math.max(400, verifyTimeoutMs)), fetchImpl })
    verified = stats === null
  }

  const stopped = reason === null || reason === 'no-process'
  if (!stopped) return { stopped: false, pid, exitCode, reason, verified, note: note.length > 0 ? note : `停止 pid ${pid} 失败（exit code ${String(exitCode)}）`, recordPath }
  if (verified === false) {
    // The signal landed but ComfyUI still answers: keep the record so the next
    // click can try again instead of forgetting the handle.
    return {
      stopped: true,
      pid,
      exitCode,
      reason: 'port-still-up',
      verified,
      note: `已向 pid ${pid} 发送停止信号（exit code ${String(exitCode)}），但 ${target} 仍在应答 /system_stats：进程可能正在退出，稍后再点一次停止。`,
      recordPath,
    }
  }

  removeLaunchRecord(plan)
  return {
    stopped: true,
    pid,
    exitCode,
    reason: null,
    verified,
    note: `已停止本插件拉起的 pid ${pid}${verified === true ? `，${target} 已不再应答` : ''}（记录已删除）。`,
    recordPath,
  }
}

