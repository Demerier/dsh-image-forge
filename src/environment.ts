/**
 * P1a — the environment layer: find this machine's ComfyUI, start it in the
 * background when it is not running, and probe it until `/system_stats` answers.
 *
 * Three boundaries are deliberate:
 *
 * - **Discovery is shared, not copied.** The Comfy Desktop registry reading, the
 *   Python / `main.py` choice and the child-process mechanics live in
 *   `scripts/comfyui-discovery.mjs`, which `scripts/start-comfyui.mjs` uses too.
 *   A second copy here is how the CLI and a cold start would start disagreeing
 *   about where the install is and which flags it was launched with.
 * - **Probing reuses `comfyui.ts`.** `discoverComfyUi` already owns the endpoint
 *   rules — a configured endpoint is final, otherwise the configured port table,
 *   loopback only — and the environment layer must not invent an easier one.
 * - **Everything that touches the machine is injectable.** Tests pass a fixture
 *   Desktop registry directory, a spawn stub and a fetch stub; no test may start
 *   a real renderer or read the real registry.
 *
 * P1b adds the hand-off the state alone could not carry: install guidance (never
 * an unattended GUI install unless the host grants computer use), weight
 * downloads into the resolved Desktop model tree, and the one success criterion
 * that counts — the loader's /object_info list containing the exact file name.
 */

import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { open, rename } from 'node:fs/promises'
import net from 'node:net'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  comfySystemStats,
  discoverComfyUi,
  parseComfyPorts,
  type ComfySystemStats,
} from './comfyui.ts'
import {
  DEFAULT_INSTALL_TIMEOUT_MS,
  discoverComfyPlan,
  isProcessAlive,
  launchComfyPlan,
  loopbackPortOf,
  planForRun,
  processCommandLine,
  readLaunchRecord,
  stopComfyPlan,
  systemStats,
  waitForComfyStats,
} from '../scripts/comfyui-discovery.mjs'
import { resolveProfile } from './model-profiles.ts'
import type { Config } from './index.ts'

/** One reachability attempt, in the shape the environment report exposes. */
export interface EnvironmentProbeAttempt {
  /** Endpoint that was tried, e.g. `http://127.0.0.1:8188`. */
  readonly endpoint: string
  /** True when this endpoint answered as ComfyUI. */
  readonly ok: boolean
  /** Why it did not answer, when it did not. */
  readonly note: string | null
}

/** The states the environment layer reports. */
export type EnvironmentState =
  | 'ready'
  | 'not-running'
  | 'not-installed'
  | 'launch-failed'
  | 'timeout'

/** Where a ready ComfyUI came from. */
export type EnvironmentSource = 'configured' | 'port-probe' | 'launched'

/** What discovery found, in the shape a report (or T14's guidance) needs. */
export interface ComfyInstallSummary {
  /** Install root, e.g. `D:\\Comfy-Desktop\\ComfyUI-Installs\\ComfyUI`. */
  readonly installPath: string
  /** The `main.py` that gets started. */
  readonly mainPy: string
  /** The Python interpreter that runs it (torch-bearing one whenever possible). */
  readonly python: string
  /** Port the install's own record says it listens on. */
  readonly port: number
  /** Where the plan came from, e.g. `Comfy Desktop (ComfyUI v0.34.0)` or `scan (…)`. */
  readonly source: string
}

/** The whole answer one environment call produces. Every field is JSON-safe. */
export interface EnvironmentStatus {
  /** Which of the five states this call ended in. */
  readonly state: EnvironmentState
  /** Origin of the ComfyUI that answered, or `null` when none did. */
  readonly endpoint: string | null
  /** Port that answered (or that a launch was planned on). */
  readonly port: number | null
  /** How a ready backend was found. */
  readonly source: EnvironmentSource | null
  /** The install discovery found, when it found one. */
  readonly install: ComfyInstallSummary | null
  /** Every endpoint this call really tried, when the probe reported them. */
  readonly probed: readonly EnvironmentProbeAttempt[]
  /** `/system_stats` of a backend that answered. */
  readonly stats: ComfySystemStats | null
  /** One-paragraph explanation, safe to show to the user. */
  readonly note: string
  /** What to do next when the state is not `ready`; `null` when ready. */
  readonly hint: string | null
  /** Log file of a launch this call performed. */
  readonly logPath: string | null
  /** How long the launch wait ran, in milliseconds. */
  readonly waitedMs: number | null
  /**
   * Pid of the instance this plugin started, when one is known to be alive.
   *
   * `null` means “no live launch record”, not “no ComfyUI”: a backend the user
   * started themselves has no pid here on purpose — the workbench is not allowed
   * to claim ownership of a process it did not start.
   */
  readonly pid: number | null
  /**
   * True only when the running backend is provably the one this plugin launched:
   * a launch record exists, its pid is alive, and (when the platform lets us
   * read it) its command line still names the recorded `main.py`.
   */
  readonly owned: boolean
  /**
   * The argv a launch ran — or would run — with.
   *
   * Stage 3 (user-specified launch flags) reads this preview; the panel only
   * shows it as a tooltip, and nothing here accepts user input yet.
   */
  readonly argvPreview: readonly string[] | null
  /**
   * Why {@link owned} is false although a live pid is known, when that is the
   * case: an unreadable command line, a recycled pid, a record without
   * `main.py`. The panel prints it next to the disabled stop button, so a
   * refusal is explained before it is clicked rather than after.
   */
  readonly ownershipNote?: string | null
  /** Wall clock spent in this call. */
  readonly elapsedMs: number
}

/** Everything the environment calls need from the resolved config. */
export interface EnvironmentOptions {
  /** Configured ComfyUI origin; empty means "probe the ports below". */
  readonly endpoint: string
  /** Ports tried on `127.0.0.1` when `endpoint` is empty. */
  readonly ports: readonly number[]
  /** Per-endpoint reachability budget. */
  readonly probeTimeoutMs: number
  /** Budget for `/system_stats` to answer after a launch. */
  readonly installTimeoutMs: number
  /** Gap between `/system_stats` polls during that wait. */
  readonly waitIntervalMs: number
  /**
   * Extra launch flags (stage 3's interface, deliberately not wired to any UI).
   *
   * Omitted or empty means “append nothing”: the planned argv stays byte for
   * byte what Comfy Desktop recorded.
   */
  readonly extraArgs?: readonly string[]
}

/** The config fields `environmentOptionsOf` reads. */
export interface EnvironmentSettings {
  /** `comfyEndpoint` as the settings resolver produced it. */
  readonly comfyEndpoint: string
  /**
   * `comfyPorts`: the raw comma separated string from the config, or the parsed
   * array the Studio's settings carry. Both are accepted so the panel route does
   * not have to re-format a list it already resolved.
   */
  readonly comfyPorts: string | readonly number[]
  /** The plugin's per-call budget; kept for parity with the other front doors. */
  readonly timeoutMs: number
}

/** Ports a settings value names; an unusable list falls back to the default table. */
function portsOf(value: string | readonly number[]): number[] {
  if (typeof value === 'string') return parseComfyPorts(value)
  const usable = value.filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535)
  return usable.length > 0 ? [...new Set(usable)] : parseComfyPorts('')
}

/**
 * Translate the plugin config into environment options.
 *
 * The port list goes through `comfyui.ts`'s own parser, so a typo in
 * `comfyPorts` behaves here exactly as it does in `qwen_image_status`.
 */
export function environmentOptionsOf(settings: EnvironmentSettings): EnvironmentOptions {
  return {
    endpoint: settings.comfyEndpoint.replace(/\/+$/, ''),
    ports: portsOf(settings.comfyPorts),
    probeTimeoutMs: 800,
    installTimeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
    waitIntervalMs: 1000,
  }
}

/** The machine-facing seams, all injectable so tests never touch this machine. */
export interface EnvironmentDeps {
  /** Environment to read `APPDATA` / `COMFYUI_DIR` from; defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>
  /** Parent of the `Comfy Desktop` registry directory; tests point it at a fixture. */
  readonly appData?: string
  /** Platform to plan for; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform
  /** Directories scanned for portable installs; `[]` disables the scan (tests). */
  readonly scanRoots?: readonly string[]
  /** `child_process.spawn`-shaped launch hook. */
  readonly spawn?: (...args: any[]) => any
  /** `child_process.spawnSync`-shaped hook, used by the Windows process-tree stop. */
  readonly spawnSync?: (...args: any[]) => unknown
  /** `process.kill`-shaped hook, used by the POSIX stop. */
  readonly kill?: (pid: number, signal?: NodeJS.Signals | number) => void
  /**
   * Read one live process's command line, for the ownership proof.
   *
   * Defaults to the shared `powershell`/`wmic`/`ps` reader in
   * `scripts/comfyui-discovery.mjs`. Tests inject it so no case ever runs
   * `taskkill`, `wmic` or `ps` against this machine.
   */
  readonly commandLineOf?: (pid: number) => string | null
  /**
   * Is this TCP port already being listened on?
   *
   * Defaults to a real `net.connect` probe. Tests inject it so the “port is
   * occupied” branch is a deterministic boolean instead of a race.
   */
  readonly portProbe?: (port: number) => Promise<boolean>
  /** `fetch`-shaped hook for `/system_stats` probes. */
  readonly fetchImpl?: typeof fetch
  /** Clock, for deterministic waits. */
  readonly now?: () => number
  /** Sleep, for deterministic waits. */
  readonly sleep?: (ms: number) => Promise<void>
  /**
   * Host-granted computer use for the install automation gate (P1b). Production
   * never injects it, so the tool always returns the manual guide; tests inject
   * it to prove an unauthorised gate is never invoked and an authorised one is.
   */
  readonly computerUse?: {
    readonly authorized?: boolean
    readonly run?: () => Promise<{ ok?: boolean; note?: string } | void>
  }
}

/** Coerce a payload into lossless JSON (`undefined` becomes `null` at every depth). */
function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, inner) => (inner === undefined ? null : inner))) as T
}

/** First line of a message, so a structured note stays one line. */
function firstLine(text: string): string {
  return text.split(/\r?\n/)[0] ?? ''
}

/** The clock this call should use. */
function nowOf(deps: EnvironmentDeps): () => number {
  return deps.now ?? Date.now
}

/**
 * Discover the install without ever throwing.
 *
 * A `COMFYUI_DIR` that points nowhere is "no install for this report", not a
 * crash: the environment tool has to be able to say `not-installed` and hand
 * that to the installer instead of dying with a stack trace.
 *
 * `cheap` keeps the bounded drive scan out of the way. Status calls use it: the
 * Desktop registry (two small JSON files) is enough to find the launch record,
 * while scanning `D:\`, `E:\` and `C:\` on every panel refresh is not.
 */
function discoverInstall(deps: EnvironmentDeps, options: { readonly cheap?: boolean } = {}): any {
  try {
    return discoverComfyPlan({
      env: deps.env ?? process.env,
      platform: deps.platform ?? process.platform,
      appData: deps.appData,
      scanRoots: options.cheap === true ? [] : deps.scanRoots,
    })
  } catch {
    return null
  }
}

/** One launch record after the ownership checks, in the shape a report uses. */
interface Ownership {
  /** True when a recorded pid is alive and provably runs the recorded main.py. */
  readonly owned: boolean
  /** The pid the record names, when a record exists at all. */
  readonly pid: number | null
  /** True when the pid exists but the command line could not be read. */
  readonly alive: boolean
  /** argv the recorded launch used, for the preview. */
  readonly argv: readonly string[] | null
  /** Where the record lives (shown in failure notes so it can be looked at). */
  readonly recordPath: string | null
  /** Why ownership is false, when a record exists but could not be confirmed. */
  readonly note: string | null
}

/** No record: nothing this plugin started is reachable from here. */
const NO_OWNERSHIP: Ownership = { owned: false, pid: null, alive: false, argv: null, recordPath: null, note: null }

/**
 * Read the launch record and decide, conservatively, whether it is ours.
 *
 * Order matters: a record whose pid is dead is *not* ownership (the OS may have
 * recycled that pid for anything). Only a live pid whose command line still
 * contains the recorded `main.py` counts as ours; when the command line cannot
 * be read the answer is `owned: false` with a note, never a hopeful `true`.
 */
function ownershipOf(deps: EnvironmentDeps): Ownership {
  const plan = discoverInstall(deps, { cheap: true })
  if (!plan) return NO_OWNERSHIP
  let record: any
  try {
    record = readLaunchRecord(plan)
  } catch {
    return NO_OWNERSHIP
  }
  if (!record || !record.pid) return NO_OWNERSHIP
  const pid = Number(record.pid)
  const argv = Array.isArray(record.argv) && record.argv.length > 0 ? record.argv.map(String) : null
  const recordPath = typeof record.logPath === 'string' ? record.logPath : null
  const alive = isProcessAlive(pid, { kill: deps.kill ?? process.kill })
  if (!alive) {
    return { owned: false, pid, alive: false, argv, recordPath, note: `pid ${pid} 已经不在了（启动记录还在，下次启动会覆盖它）。` }
  }
  const read = deps.commandLineOf ?? ((wanted: number) => processCommandLine(wanted, { platform: deps.platform ?? process.platform, spawnSync: deps.spawnSync ?? undefined }))
  let commandLine: string | null = null
  try {
    commandLine = read(pid)
  } catch {
    commandLine = null
  }
  if (typeof commandLine !== 'string' || commandLine.length === 0) {
    return {
      owned: false,
      pid,
      alive: true,
      argv,
      recordPath,
      note: `pid ${pid} 还活着，但读不到它的命令行，无法确认是不是本插件拉起的实例。`,
    }
  }
  const mainPy = typeof record.mainPy === 'string' ? record.mainPy : ''
  if (mainPy.length === 0) {
    return {
      owned: false,
      pid,
      alive: true,
      argv,
      recordPath,
      note: `启动记录里没有 main.py，无法确认 pid ${pid} 的归属（停止会被拒绝）。`,
    }
  }
  const normalise = (value: string) => value.replace(/["']/g, '').replace(/\\/g, '/').toLowerCase()
  if (!normalise(commandLine).includes(normalise(mainPy))) {
    return {
      owned: false,
      pid,
      alive: true,
      argv,
      recordPath,
      note: `pid ${pid} 跑的不是记录的 main.py，本插件不认为它是自己拉起的实例。`,
    }
  }
  return { owned: true, pid, alive: true, argv, recordPath, note: null }
}

/**
 * Is the port already being listened on? A refused connection means "free".
 *
 * This is the cheap pre-flight that turns "waited the full 180 s and never came
 * up" into "端口被占" before a single byte of Python runs.
 */
function realPortProbe(port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let socket: import('node:net').Socket
    try {
      socket = new net.Socket()
    } catch {
      finish(false)
      return
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.destroy()
      finish(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      finish(false)
    })
    socket.once('error', () => {
      socket.destroy()
      finish(false)
    })
    try {
      socket.connect(port, '127.0.0.1')
    } catch {
      finish(false)
    }
  })
}

/** Trim a discovery plan down to the summary the report exposes. */
function installSummaryOf(plan: any): ComfyInstallSummary {
  return {
    installPath: String(plan.installPath),
    mainPy: String(plan.mainPy),
    python: String(plan.python),
    port: Number(plan.port),
    source: String(plan.source),
  }
}

/** Normalise the probe trail `comfyui.ts` returns. */
function attemptsOf(probed: unknown): EnvironmentProbeAttempt[] {
  if (!Array.isArray(probed)) return []
  return probed.map((attempt: any) => ({
    endpoint: String(attempt?.endpoint ?? ''),
    ok: attempt?.ok === true,
    note: typeof attempt?.note === 'string' ? attempt.note : null,
  }))
}

/** Normalise `/system_stats` into the JSON-safe shape the report stores. */
function statsOf(stats: ComfySystemStats | null): ComfySystemStats | null {
  if (!stats) return null
  return { version: stats.version ?? null, devices: stats.devices ?? [], note: stats.note ?? null }
}

/** One probe outcome: either a ComfyUI that answered, or why none did. */
interface ProbeOutcome {
  readonly ok: boolean
  readonly target: { endpoint: string; port: number; probed: unknown } | null
  readonly note: string
}

/**
 * Probe the configured endpoint / port table, reusing the generation path's own
 * rules (`comfyui.ts:discoverComfyUi`).
 */
async function probeRunning(options: EnvironmentOptions, deps: EnvironmentDeps): Promise<ProbeOutcome> {
  try {
    const target = await discoverComfyUi({
      endpoint: options.endpoint,
      ports: options.ports,
      modelsDir: '',
      timeoutMs: options.installTimeoutMs,
      portProbeTimeoutMs: options.probeTimeoutMs,
    })
    return { ok: true, target, note: '' }
  } catch (error) {
    return { ok: false, target: null, note: error instanceof Error ? error.message : String(error) }
  }
}

/** A ready report, from whatever produced the ComfyUI that answered. */
async function readyStatus(
  target: { endpoint: string; port: number; probed: unknown },
  source: EnvironmentSource,
  extras: {
    readonly install: ComfyInstallSummary | null
    readonly logPath: string | null
    readonly waitedMs: number | null
    readonly startedAt: number
    readonly deps: EnvironmentDeps
    /** Ownership as resolved by the caller; `undefined` asks for a fresh look. */
    readonly ownership?: Ownership
    /** The launch's own pid, when this call started the process. */
    readonly launchedPid?: number | null
    /** argv preview; `undefined` means “whatever the record carries”. */
    readonly argvPreview?: readonly string[] | null
  },
): Promise<EnvironmentStatus> {
  const stats = await comfySystemStats(target.endpoint, 5000)
  const ownership = extras.ownership ?? ownershipOf(extras.deps)
  const sourceLabel =
    source === 'configured'
      ? `配置的端点 ${target.endpoint}`
      : source === 'port-probe'
        ? `端口表探测到 ${target.endpoint}`
        : `本次后台拉起 ${target.endpoint}`
  return {
    state: 'ready',
    endpoint: target.endpoint,
    port: target.port,
    source,
    install: extras.install,
    probed: attemptsOf(target.probed),
    stats: statsOf(stats),
    note: `ComfyUI 在跑：${sourceLabel}。${ownership.owned ? `本次由插件拉起（pid ${String(ownership.pid)}）。` : ''}`,
    hint: null,
    logPath: extras.logPath,
    waitedMs: extras.waitedMs,
    pid: extras.launchedPid ?? ownership.pid,
    owned: ownership.owned,
    ...(ownership.owned || ownership.note === null ? {} : { ownershipNote: ownership.note }),
    argvPreview: extras.argvPreview ?? ownership.argv,
    elapsedMs: nowOf(extras.deps)() - extras.startedAt,
  }
}

/**
 * Report the environment **without starting anything** (the passive half).
 *
 * Order, and why: the configured endpoint / port table is what generation uses,
 * so it is asked first; only when nothing answers is the Desktop registry read,
 * to tell `not-running` (install found, startable) apart from `not-installed`
 * (the state P1b turns into install guidance).
 */
export async function inspectEnvironment(
  options: EnvironmentOptions,
  deps: EnvironmentDeps = {},
): Promise<EnvironmentStatus> {
  const startedAt = nowOf(deps)()
  const probe = await probeRunning(options, deps)
  if (probe.ok && probe.target !== null) {
    return readyStatus(probe.target, options.endpoint.length > 0 ? 'configured' : 'port-probe', {
      install: null,
      logPath: null,
      waitedMs: null,
      startedAt,
      deps,
    })
  }

  const plan = discoverInstall(deps)
  const elapsedMs = nowOf(deps)() - startedAt
  if (!plan) {
    return {
      state: 'not-installed',
      endpoint: null,
      port: null,
      source: null,
      install: null,
      probed: [],
      stats: null,
      note: `没找到在跑的 ComfyUI（${firstLine(probe.note)}），也没有发现 ComfyUI Desktop 或便携版安装。`,
      hint:
        '按 docs/comfyui-deployment.md 安装 ComfyUI Desktop（安装引导与按需权重下载属后续阶段，本工具不安装、不下权重）；' +
        '装好后重跑本工具，或先用 node scripts/start-comfyui.mjs --print 确认能发现安装。',
      logPath: null,
      waitedMs: null,
      pid: null,
      owned: false,
      argvPreview: null,
      elapsedMs,
    }
  }
  return {
    state: 'not-running',
    endpoint: null,
    port: plan.port,
    source: null,
    install: installSummaryOf(plan),
    probed: [],
    stats: null,
    note: `ComfyUI 没在跑（${firstLine(probe.note)}），但找到了安装：${plan.installPath}（来源 ${plan.source}）。`,
    hint:
      '点工作台状态行的「启动」用本工具后台拉起（按 Comfy Desktop 记录的启动参数，不自行发明 flag），' +
      '或直接跑 node scripts/start-comfyui.mjs。',
    logPath: null,
    waitedMs: null,
    pid: null,
    owned: false,
    argvPreview: Array.isArray(plan.argv) ? plan.argv.map(String) : null,
    elapsedMs,
  }
}

/**
 * Make the environment ready: probe first, and when nothing answers discover
 * the install, start it detached, then wait for `/system_stats`.
 *
 * Never retries and never installs: a launch that fails or times out is
 * reported with its log path, because silently retrying a `Python` crash loop
 * is how a tool burns a GPU box.
 */
export async function ensureEnvironment(
  options: EnvironmentOptions,
  deps: EnvironmentDeps = {},
): Promise<EnvironmentStatus> {
  const startedAt = nowOf(deps)()
  const inspected = await inspectEnvironment(options, deps)
  if (inspected.state !== 'not-running') return inspected

  const discovered = discoverInstall(deps)
  if (!discovered) return inspected

  // **One port for everything.** A loopback `comfyEndpoint` pins the launch:
  // argv's `--port`, `plan.port`, the record and the endpoint this function
  // waits on all come from the same value. The old code waited on `plan.port`
  // while the panel probed `comfyEndpoint`, so a configured `:8000` launched
  // `:8188`, waited there, and the panel never turned green.
  const pinned = loopbackPortOf(options.endpoint)
  const port = pinned ?? Number(discovered.port)
  const endpoint = pinned !== null ? options.endpoint : `http://127.0.0.1:${String(port)}`
  const plan = planForRun(discovered, { port: pinned, extraArgs: options.extraArgs ?? [] })
  const argvPreview = Array.isArray(plan.argv) ? plan.argv.map(String) : null

  // A pid this plugin already started must not be started again: the record is
  // the only handle to it, and overwriting that record orphans the process.
  const previous = ownershipOf(deps)
  if (previous.alive) {
    return {
      state: 'launch-failed',
      endpoint: null,
      port,
      source: null,
      install: installSummaryOf(plan),
      probed: [],
      stats: null,
      note: `没有重复拉起：${previous.note ?? `已有一个由本插件拉起的实例（pid ${String(previous.pid)}）`}；${endpoint} 还没应答，可能仍在加载权重。`,
      hint: '等它就绪后点「重新检测」；要重启用状态行的「停止」再「启动」。',
      logPath: previous.recordPath,
      waitedMs: null,
      pid: previous.pid,
      owned: previous.owned,
      argvPreview: previous.argv ?? argvPreview,
      elapsedMs: nowOf(deps)() - startedAt,
    }
  }

  // Port pre-flight. Two different facts, deliberately answered differently:
  // something that *is* ComfyUI means "already running, don't spawn"; a listener
  // that is not ComfyUI means "the port is taken" — either way, refusing now
  // beats waiting the full timeout and then blaming the log.
  const fetchImpl = deps.fetchImpl ?? fetch
  const answering = await systemStats(endpoint, { timeoutMs: 1_500, fetchImpl })
  if (answering) {
    const ready = await readyStatus(
      { endpoint, port, probed: [{ endpoint, ok: true, note: null }] },
      options.endpoint.length > 0 ? 'configured' : 'port-probe',
      {
        install: installSummaryOf(plan),
        logPath: null,
        waitedMs: null,
        startedAt,
        deps,
        ownership: NO_OWNERSHIP,
        argvPreview,
      },
    )
    return { ...ready, note: `端口 ${String(port)} 上已有 ComfyUI 在应答（可能是你自己启动的），没有重复拉起。` }
  }
  const occupied = await (deps.portProbe ?? realPortProbe)(port)
  if (occupied) {
    return {
      state: 'launch-failed',
      endpoint: null,
      port,
      source: null,
      install: installSummaryOf(plan),
      probed: [],
      stats: null,
      note: `端口被占：${String(port)} 上已有进程在监听，但不是 ComfyUI 的应答（可能是你已开的 ComfyUI 正在启动，或别的程序），没有拉起。`,
      hint: '确认占用该端口的程序，或把 comfyEndpoint 改成一个空闲端口——下次启动会按它的端口传 --port，等待与探活也用它。',
      logPath: null,
      waitedMs: null,
      pid: null,
      owned: false,
      argvPreview,
      elapsedMs: nowOf(deps)() - startedAt,
    }
  }

  let launch: any
  try {
    launch = launchComfyPlan(plan, { spawn: deps.spawn, endpoint })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      state: 'launch-failed',
      endpoint: null,
      port,
      source: null,
      install: installSummaryOf(plan),
      probed: [],
      stats: null,
      note: `后台拉起失败：${reason}`,
      hint: '先用 node scripts/start-comfyui.mjs --print 看完整 argv 与 Python 路径，再确认 Desktop 记录的安装还能用。',
      logPath: null,
      waitedMs: null,
      pid: null,
      owned: false,
      argvPreview,
      elapsedMs: nowOf(deps)() - startedAt,
    }
  }

  const wait = await waitForComfyStats(endpoint, {
    child: launch.child,
    timeoutMs: options.installTimeoutMs,
    intervalMs: options.waitIntervalMs,
    fetchImpl,
    now: deps.now,
    sleep: deps.sleep,
  })
  if (wait.ok) {
    const ready = await readyStatus(
      { endpoint, port, probed: [{ endpoint, ok: true, note: null }] },
      'launched',
      {
        install: installSummaryOf(plan),
        logPath: launch.logPath,
        waitedMs: wait.waitedMs ?? null,
        startedAt,
        deps,
        launchedPid: launch.pid ?? null,
        argvPreview,
        ownership: {
          owned: true,
          pid: launch.pid ?? null,
          alive: true,
          argv: argvPreview,
          recordPath: launch.recordPath ?? null,
          note: null,
        },
      },
    )
    return {
      ...ready,
      note: `已后台拉起 ComfyUI：${endpoint}（pid ${String(launch.pid)}，面板关闭后它继续跑）。日志：${launch.logPath}`,
      logPath: launch.logPath,
      pid: launch.pid ?? null,
    }
  }

  const waitedMs = wait.waitedMs ?? null
  const failed = wait.reason === 'exited'
  return {
    state: failed ? 'launch-failed' : 'timeout',
    endpoint: null,
    port,
    source: null,
    install: installSummaryOf(plan),
    probed: [],
    stats: null,
    note: failed
      ? `拉起后 ComfyUI 立即退出（exit code ${wait.exitCode}），日志：${launch.logPath}`
      : `拉起后 /system_stats 在 ${Math.round((waitedMs ?? 0) / 1000)} 秒内没有就绪，日志：${launch.logPath}`,
    hint: '看日志最后 25 行排障（端口被占、Python 环境损坏、首次启动很慢都可能在日志里点名）；本工具不自动重试、不下载权重。',
    logPath: launch.logPath,
    waitedMs,
    // The child is not answering, so it is not "owned and running": the record
    // stays (a retry or a stop can still use it) but the report must not claim a
    // live instance.
    pid: launch.pid ?? null,
    owned: false,
    argvPreview,
    elapsedMs: nowOf(deps)() - startedAt,
  }
}

/**
 * Stop the instance this plugin/CLI started (never somebody else's).
 *
 * The Windows branch kills the whole process tree: ComfyUI is a Python parent
 * plus workers, and leaving the children behind would hold the GPU. This is the
 * same interface P2's `comfy-mcp` child cleanup will reuse.
 */
/** What a stop call reports back. */
export interface EnvironmentStopResult {
  /** True when the recorded instance was signalled and its port went quiet. */
  readonly stopped: boolean
  /** Pid the record named, when there was one. */
  readonly pid: number | null
  /** Exit code of `taskkill` on Windows; `null` on POSIX and on refusal. */
  readonly exitCode: number | null
  /**
   * Why nothing was stopped: `no-install` / `no-record` / `no-pid` /
   * `unverified` / `not-owned` / `signal-failed` / `no-process` /
   * `port-still-up`; `null` on success.
   */
  readonly reason: string | null
  /** Did `/system_stats` really stop answering? `null` when unverifiable. */
  readonly verified: boolean | null
  /** One-paragraph explanation, safe to show to the user. */
  readonly note: string
  /** The launch record this call read (deleted on success). */
  readonly recordPath: string | null
}

/**
 * Stop the instance this plugin/CLI started (never somebody else's).
 *
 * The safety property is the whole point of this function: it stops a process
 * only when the launch record names a `main.py` **and** the live process's
 * command line still contains it. “Cannot read the command line” is answered
 * with `stopped: false, reason: 'unverified'`, not with a hopeful `taskkill` —
 * a wrong kill takes down whatever Python the user was training.
 *
 * Discovery uses the same strategy as a start (explicit dir, Desktop registry,
 * bounded scan), because the record lives inside the install tree: a stop that
 * cannot find the install cannot find the record either.
 *
 * @param deps - machine-facing seams; tests inject every one of them.
 * @returns the stop report; never throws.
 */
export async function stopEnvironment(deps: EnvironmentDeps = {}): Promise<EnvironmentStopResult> {
  const plan = discoverInstall(deps)
  if (!plan) {
    return {
      stopped: false,
      pid: null,
      exitCode: null,
      reason: 'no-install',
      verified: null,
      note: '没找到 ComfyUI 安装，没有可停的实例（只停由插件/脚本拉起的实例）。',
      recordPath: null,
    }
  }
  try {
    return await stopComfyPlan(plan, {
      platform: deps.platform ?? process.platform,
      spawnSync: deps.spawnSync,
      kill: deps.kill,
      commandLineOf: deps.commandLineOf,
      fetchImpl: deps.fetchImpl ?? fetch,
    }) as EnvironmentStopResult
  } catch (error) {
    return {
      stopped: false,
      pid: null,
      exitCode: null,
      reason: 'signal-failed',
      verified: null,
      note: `停止失败：${error instanceof Error ? error.message : String(error)}`,
      recordPath: null,
    }
  }
}

// ---------------------------------------------------------------------------
// P1b (T14): install guidance, model-root resolution and on-demand downloads.
// Rules are T04's (docs/desktop-model-dir.md): resolve the models root (running
// instance argv -> Desktop instance-model-paths yaml -> Desktop settings.json ->
// install tree); download to '<name>.part', verify bytes/sha256, rename atomically;
// and count ONLY 'GET /object_info/<Loader> lists the exact file name' as success.
// The plugin never restarts ComfyUI to make a new file appear.
// ---------------------------------------------------------------------------

/** Where one weight file comes from, and how to verify it. */
export interface WeightSource {
  /** Absolute download URL (hf-mirror; huggingface.co answers 502 on this box). */
  readonly url: string
  /** Exact size in bytes; a partial or concatenated file must fail this check. */
  readonly bytes: number
  /** sha256 when a measured value exists; null means size-only verification. */
  readonly sha256: string | null
  /** Path inside the HF repo, for diagnostics only. */
  readonly repoPath: string
  /** False when the URL was written from the repo layout but never HEAD-tested. */
  readonly urlVerified: boolean
}

/** Downloadable weights, keyed by the exact file name a profile declares. */
export const WEIGHT_SOURCES: Readonly<Record<string, WeightSource>> = {
  'qwen_image_2.1_int8_convrot.safetensors': {
    url: 'https://hf-mirror.com/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors',
    bytes: 7_256_783_064,
    sha256: 'cb74113cb03faecd79611b01fd7fd642f0aa60d6f0b95086abee214d75eaa57d',
    repoPath: 'diffusion_models/qwen_image_2.1_int8_convrot.safetensors',
    urlVerified: true,
  },
  'qwen_image_2.1_turbo_int8_convrot.safetensors': {
    url: 'https://hf-mirror.com/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors',
    bytes: 7_256_787_829,
    sha256: '8144a0182964aa8403ad6dbc011db837304167d235161b9aabaa8532e967314c',
    repoPath: 'diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors',
    urlVerified: true,
  },
  'qwen3vl_8b_int8_convrot.safetensors': {
    url: 'https://hf-mirror.com/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors',
    bytes: 9_350_798_360,
    sha256: '8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f',
    repoPath: 'text_encoders/qwen3vl_8b_int8_convrot.safetensors',
    urlVerified: true,
  },
  'qwen_image_2.1_vae_bf16.safetensors': {
    url: 'https://hf-mirror.com/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors',
    bytes: 675_509_688,
    sha256: 'bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9',
    repoPath: 'vae/qwen_image_2.1_vae_bf16.safetensors',
    urlVerified: true,
  },
  'moss_image_sft_int8_convrot.safetensors': {
    url: 'https://hf-mirror.com/Comfy-Org/MOSS-Image/resolve/main/diffusion_models/moss_image_sft_int8_convrot.safetensors',
    bytes: 5_413_698_958,
    sha256: null,
    repoPath: 'diffusion_models/moss_image_sft_int8_convrot.safetensors',
    urlVerified: true,
  },
  'qwen3.5_9b_w4a8_gptq.safetensors': {
    url: 'https://hf-mirror.com/Comfy-Org/MOSS-Image/resolve/main/text_encoders/qwen3.5_9b_w4a8_gptq.safetensors',
    bytes: 7_343_591_088,
    sha256: null,
    repoPath: 'text_encoders/qwen3.5_9b_w4a8_gptq.safetensors',
    urlVerified: true,
  },
  'flux2-vae_small.safetensors': {
    url: 'https://hf-mirror.com/Comfy-Org/MOSS-Image/resolve/main/vae/flux2-vae_small.safetensors',
    bytes: 249_521_340,
    sha256: 'd8d52ba036475f5fb07c8b435e176d3d97ebfa82f0d1a1c317f9cc1e25bd013b',
    repoPath: 'vae/flux2-vae_small.safetensors',
    urlVerified: true,
  },
}

/** Where the model tree lives, and which rule found it. */
export interface ModelsBaseResolution {
  readonly base: string | null
  readonly source: 'instance-argv' | 'desktop-yaml' | 'desktop-settings' | 'install-tree' | null
  readonly note: string
}

function readJsonSafe(filePath: string): any {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function readTextSafe(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

/** Pull base_path out of a ComfyUI extra-model-paths yaml. Exported for tests. */
export function parseModelsBaseYaml(text: string): string | null {
  const match = /^[ \t]*base_path:[ \t]*(.+)$/m.exec(String(text ?? ''))
  if (!match) return null
  const raw = match[1].trim().replace(/^['"]/, '').replace(/['"]$/, '')
  return raw.length > 0 ? raw : null
}

/** Resolve base_path from one yaml; relative paths resolve against the yaml. */
function yamlBaseFrom(filePath: string): string | null {
  const base = parseModelsBaseYaml(readTextSafe(filePath) ?? '')
  if (!base) return null
  return isAbsolute(base) ? base : resolve(dirname(filePath), base)
}

/** Desktop registry -> instance-model-paths yaml -> base_path. */
function desktopModelsBase(appData: string): { base: string; file: string } | null {
  const desktop = join(appData, 'Comfy Desktop')
  const pathsDir = join(desktop, 'instance-model-paths')
  const installations = readJsonSafe(join(desktop, 'installations.json'))
  const records = Array.isArray(installations) ? installations : []
  for (const install of records) {
    if (install?.status && install.status !== 'installed') continue
    if (!install?.id) continue
    const own = join(pathsDir, String(install.id) + '.yaml')
    const base = yamlBaseFrom(own)
    if (base) return { base, file: own }
  }
  try {
    for (const name of readdirSync(pathsDir)) {
      if (!name.endsWith('.yaml')) continue
      const file = join(pathsDir, name)
      const base = yamlBaseFrom(file)
      if (base) return { base, file }
    }
  } catch {
    // no instance-model-paths directory
  }
  return null
}

/** Resolve the models root (T04 section 4.4, in order). */
export async function resolveModelsBase(
  options: { readonly endpoint?: string | null },
  deps: EnvironmentDeps = {},
): Promise<ModelsBaseResolution> {
  const endpoint = (options.endpoint ?? '').replace(/\/+$/, '')
  if (endpoint) {
    try {
      const fetchImpl = deps.fetchImpl ?? fetch
      const response = await fetchImpl(endpoint + '/system_stats', { signal: AbortSignal.timeout(4000) })
      const payload: any = await response.json()
      const argv = Array.isArray(payload?.system?.argv) ? payload.system.argv.map(String) : []
      const flagAt = argv.indexOf('--extra-model-paths-config')
      if (flagAt >= 0 && argv[flagAt + 1]) {
        const file = argv[flagAt + 1]
        const base = yamlBaseFrom(file)
        if (base) return { base, source: 'instance-argv', note: '来自运行中实例的 --extra-model-paths-config：' + file }
      }
      const baseDirAt = argv.indexOf('--base-directory')
      if (baseDirAt >= 0 && argv[baseDirAt + 1]) {
        const base = resolve(String(argv[baseDirAt + 1]))
        return { base, source: 'instance-argv', note: '来自运行中实例的 --base-directory：' + base }
      }
    } catch {
      // not running / no argv: fall through
    }
  }
  const appData = deps.appData ?? process.env.APPDATA
  if (appData) {
    const desktop = desktopModelsBase(appData)
    if (desktop) return { base: desktop.base, source: 'desktop-yaml', note: '来自 Comfy Desktop 生成的模型路径 yaml：' + desktop.file }
    const settings = readJsonSafe(join(appData, 'Comfy Desktop', 'settings.json'))
    const dirs = Array.isArray(settings?.modelsDirs) ? settings.modelsDirs.filter((dir: any) => typeof dir === 'string' && dir.length > 0) : []
    if (dirs.length > 0) return { base: String(dirs[0]), source: 'desktop-settings', note: '来自 Comfy Desktop settings.json 的 modelsDirs[0]（期望值，可能与运行实例不同）' }
  }
  const plan = discoverInstall(deps)
  if (plan?.mainPy) {
    const base = join(dirname(String(plan.mainPy)), 'models')
    if (existsSync(base)) return { base, source: 'install-tree', note: '兜底：ComfyUI 安装树里的 models（Desktop 下通常是空目录）' }
  }
  return { base: null, source: null, note: '没解析出模型根：ComfyUI 没在跑且没有 Comfy Desktop 安装记录。' }
}

/** One weight of a profile, with its download record and target path. */
export interface WeightPlanItem {
  readonly kind: 'unet' | 'clip' | 'vae'
  readonly filename: string
  readonly loader: string
  readonly field: string
  readonly folder: string
  readonly targetPath: string | null
  readonly source: WeightSource | null
}

/** Build the three-item download plan of one profile against a models root. */
export function weightPlanOf(
  profileId: string,
  base: string | null,
  sources: Readonly<Record<string, WeightSource>> = WEIGHT_SOURCES,
): WeightPlanItem[] {
  const profile = resolveProfile(profileId)
  const kinds: Array<'unet' | 'clip' | 'vae'> = ['unet', 'clip', 'vae']
  return kinds.map((kind) => {
    const rule = profile.weights[kind]
    const filename = rule.example
    return {
      kind,
      filename,
      loader: rule.loader,
      field: rule.field,
      folder: rule.folder,
      targetPath: base === null ? null : join(base, rule.folder, filename),
      source: sources[filename] ?? null,
    }
  })
}

/** What /object_info said about one exact file name. */
export interface ObjectInfoCheck {
  readonly listed: boolean
  readonly options: readonly string[]
  readonly note: string
}

/** Read one loader field out of /object_info and look for the EXACT file name. */
export async function checkObjectInfoFile(input: {
  readonly endpoint: string
  readonly loader: string
  readonly field: string
  readonly filename: string
  readonly fetchImpl?: typeof fetch
}): Promise<ObjectInfoCheck> {
  const fetchImpl = input.fetchImpl ?? fetch
  const url = input.endpoint.replace(/\/+$/, '') + '/object_info/' + encodeURIComponent(input.loader)
  try {
    const response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(5000) })
    const payload: any = JSON.parse(await response.text())
    const node = payload?.[input.loader]?.input
    const field = node?.required?.[input.field] ?? node?.optional?.[input.field]
    const options = Array.isArray(field?.[0]) ? field[0].filter((value: any) => typeof value === 'string') : []
    const listed = options.includes(input.filename)
    return { listed, options, note: listed ? 'object_info 列出了精确文件名' : 'object_info 没有列出该文件（当前 ' + options.length + ' 个候选）' }
  } catch (error) {
    return { listed: false, options: [], note: 'object_info 探测失败：' + (error instanceof Error ? error.message : String(error)) }
  }
}

/** sha256 of one file, streamed. Exported for tests. */
export async function sha256OfFile(filePath: string): Promise<string> {
  return await new Promise<string>((done, fail) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', fail)
    stream.on('end', () => done(hash.digest('hex')))
  })
}

function fileSizeOrNull(filePath: string): number | null {
  try {
    return statSync(filePath).size
  } catch {
    return null
  }
}

/** One weight file's download result. */
export interface WeightDownloadOutcome {
  readonly filename: string
  readonly targetPath: string
  readonly state: 'already-present' | 'downloaded' | 'resumed' | 'failed'
  readonly bytesOnDisk: number
  readonly expectedBytes: number
  readonly sha256Ok: boolean | null
  readonly partBytesAtStart: number
  readonly note: string
}

async function streamIntoFile(
  response: any,
  partPath: string,
  append: boolean,
  onProgress?: (written: number) => void,
): Promise<number> {
  const handle = await open(partPath, append ? 'a' : 'w')
  let written = 0
  try {
    const body = response.body
    if (!body) throw new Error('下载响应没有 body')
    const stream = typeof (body as any).getReader === 'function' ? Readable.fromWeb(body as any) : body
    for await (const chunk of stream as any) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any)
      await handle.write(buffer)
      written += buffer.length
      // Coarse on purpose: one notification per chunk is already enough for a
      // panel that repaints at most once a second, and it keeps the seam free
      // of timers a test would have to fake.
      onProgress?.(written)
    }
  } finally {
    await handle.close()
  }
  return written
}

/**
 * Download one weight file: .part first, then byte/sha256 check, then atomic
 * rename. Resume works against Range-honouring servers (hf-mirror: 206); a 200
 * answer restarts from 0 instead of corrupting the file.
 */
export async function downloadOneWeight(input: {
  readonly url: string
  readonly targetPath: string
  readonly expectedBytes: number
  readonly sha256?: string | null
  readonly fetchImpl?: typeof fetch
  /** Bytes already on disk for this file, reported while it streams. */
  readonly onProgress?: (written: number) => void
  /** Cancels the transfer; the `.part` stays for a later resume. */
  readonly signal?: AbortSignal
}): Promise<WeightDownloadOutcome> {
  const fetchImpl = input.fetchImpl ?? fetch
  const filename = basename(input.targetPath)
  const partPath = input.targetPath + '.part'
  const note = (extra: string) => '目标：' + input.targetPath + '。' + extra
  const presentSize = fileSizeOrNull(input.targetPath)
  if (presentSize === input.expectedBytes) {
    const sha = input.sha256 ?? null
    const shaOk = sha === null ? null : (await sha256OfFile(input.targetPath)) === sha
    if (shaOk !== false) {
      return { filename, targetPath: input.targetPath, state: 'already-present', bytesOnDisk: presentSize, expectedBytes: input.expectedBytes, sha256Ok: shaOk, partBytesAtStart: 0, note: note('文件已在位且大小/哈希匹配，没有重复下载。') }
    }
  }
  mkdirSync(dirname(input.targetPath), { recursive: true })
  let offset = fileSizeOrNull(partPath) ?? 0
  if (offset > input.expectedBytes) {
    rmSync(partPath, { force: true })
    offset = 0
  }
  const partBytesAtStart = offset
  try {
    let resumed = offset > 0
    if (offset !== input.expectedBytes) {
      const headers: Record<string, string> = {}
      if (offset > 0) headers.Range = 'bytes=' + offset + '-'
      const timeout = AbortSignal.timeout(30 * 60 * 1000)
      const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout])
      const response = await fetchImpl(input.url, { method: 'GET', headers, signal })
      if (!response.ok && response.status !== 206) throw new Error('HTTP ' + response.status + ' ' + response.statusText)
      if (offset > 0 && response.status === 200) {
        resumed = false
        offset = 0
      }
      await streamIntoFile(response, partPath, resumed, input.onProgress)
    }
    const size = fileSizeOrNull(partPath)
    if (size !== input.expectedBytes) throw new Error('字节数不对：下载后 ' + String(size) + '，期望 ' + String(input.expectedBytes) + '（.part 保留，可续传）')
    const sha = input.sha256 ?? null
    const shaOk = sha === null ? null : (await sha256OfFile(partPath)) === sha
    if (shaOk === false) throw new Error('sha256 不匹配（.part 保留，请删掉后重下）')
    rmSync(input.targetPath, { force: true })
    await rename(partPath, input.targetPath)
    return { filename, targetPath: input.targetPath, state: resumed ? 'resumed' : 'downloaded', bytesOnDisk: input.expectedBytes, expectedBytes: input.expectedBytes, sha256Ok: shaOk, partBytesAtStart, note: note(resumed ? '从 .part 续传完成并原子改名。' : '下载完成并原子改名。') }
  } catch (error) {
    return { filename, targetPath: input.targetPath, state: 'failed', bytesOnDisk: fileSizeOrNull(partPath) ?? 0, expectedBytes: input.expectedBytes, sha256Ok: null, partBytesAtStart, note: note(error instanceof Error ? error.message : String(error)) }
  }
}

/** Byte progress of one weight transfer, as the panel's drawer prints it. */
export interface WeightProgressEvent {
  readonly filename: string
  readonly kind: 'unet' | 'clip' | 'vae'
  /** Bytes on disk for this file so far (including a resumed prefix). */
  readonly written: number
  /** Expected total, from the download table. */
  readonly total: number
  readonly targetPath: string | null
}

/** One profile weight after the ensure pass. */
export interface ProfileWeightReport {
  readonly kind: 'unet' | 'clip' | 'vae'
  readonly filename: string
  readonly targetPath: string | null
  readonly bytes: number | null
  readonly state: 'present' | 'installed' | 'would-download' | 'no-source' | 'no-base' | 'dry-run' | 'failed' | 'unverified'
  readonly objectInfo: ObjectInfoCheck | null
  readonly note: string
}

/** The whole ensure pass for one profile. */
export interface ProfileWeightsOutcome {
  readonly profile: string
  readonly base: string | null
  readonly dryRun: boolean
  readonly state: 'ready' | 'downloaded' | 'partial' | 'blocked' | 'unverified'
  readonly weights: readonly ProfileWeightReport[]
  readonly note: string
}

/**
 * Make a profile's three weights present inside a resolved models root.
 * Success is per T04: /object_info lists the exact file name. A finished download
 * with no running ComfyUI to verify is 'unverified', never 'ready'.
 */
export async function ensureProfileWeights(input: {
  readonly profileId: string
  readonly base: string | null
  readonly endpoint: string | null
  readonly dryRun?: boolean
  readonly deps?: EnvironmentDeps
  /** Test seam: swap the download table (the shipped one is the default). */
  readonly sources?: Readonly<Record<string, WeightSource>>
  /** Per-file byte progress, forwarded to the panel's download drawer. */
  readonly onProgress?: (progress: WeightProgressEvent) => void
  /** Cancels the current transfer; what already landed stays as `.part`. */
  readonly signal?: AbortSignal
}): Promise<ProfileWeightsOutcome> {
  const profile = resolveProfile(input.profileId)
  const dryRun = input.dryRun === true
  const fetchImpl = input.deps?.fetchImpl ?? fetch
  const plan = weightPlanOf(profile.id, input.base, input.sources ?? WEIGHT_SOURCES)
  if (input.base === null) {
    return {
      profile: profile.id,
      base: null,
      dryRun,
      state: 'blocked',
      weights: plan.map((item) => ({ kind: item.kind, filename: item.filename, targetPath: null, bytes: item.source?.bytes ?? null, state: 'no-base' as const, objectInfo: null, note: '没解析出模型根，先让 ComfyUI 跑起来或确认 Desktop 安装。' })),
      note: '没解析出模型根：下载目标无法确定，未写任何文件。',
    }
  }
  const reports: ProfileWeightReport[] = []
  let sawFailure = false
  let sawUnverified = false
  let changed = false
  for (const item of plan) {
    const source = item.source
    if (source === null) {
      reports.push({ kind: item.kind, filename: item.filename, targetPath: item.targetPath, bytes: null, state: 'no-source', objectInfo: null, note: '下载表里没有这个文件的来源，未下载（按部署文档手工放置）。' })
      sawFailure = true
      continue
    }
    const currentSize = item.targetPath ? fileSizeOrNull(item.targetPath) : null
    const alreadyPresent = currentSize === source.bytes
    if (dryRun) {
      reports.push({ kind: item.kind, filename: item.filename, targetPath: item.targetPath, bytes: source.bytes, state: alreadyPresent ? 'dry-run' : 'would-download', objectInfo: null, note: alreadyPresent ? '已在位（大小匹配）。' : '将下载 ' + source.url + '（' + String(source.bytes) + ' 字节' + (source.urlVerified ? '' : '；URL 未实测') + '）。' })
      continue
    }
    let download: WeightDownloadOutcome | null = null
    if (!alreadyPresent) {
      download = await downloadOneWeight({
        url: source.url,
        targetPath: String(item.targetPath),
        expectedBytes: source.bytes,
        sha256: source.sha256,
        fetchImpl,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.onProgress === undefined
          ? {}
          : {
            onProgress: (written: number) => {
              input.onProgress?.({
                filename: item.filename,
                kind: item.kind,
                written,
                total: source.bytes,
                targetPath: item.targetPath,
              })
            },
          }),
      })
      if (download.state === 'failed') {
        reports.push({ kind: item.kind, filename: item.filename, targetPath: item.targetPath, bytes: source.bytes, state: 'failed', objectInfo: null, note: download.note })
        sawFailure = true
        continue
      }
      changed = true
    }
    if (!input.endpoint) {
      sawUnverified = true
      reports.push({ kind: item.kind, filename: item.filename, targetPath: item.targetPath, bytes: source.bytes, state: 'unverified', objectInfo: null, note: (download ? download.note : '文件已在位') + '，但 ComfyUI 没在跑，无法用 /object_info 判定成功。' })
      continue
    }
    const check = await checkObjectInfoFile({ endpoint: input.endpoint, loader: item.loader, field: item.field, filename: item.filename, fetchImpl })
    if (check.listed) {
      reports.push({ kind: item.kind, filename: item.filename, targetPath: item.targetPath, bytes: source.bytes, state: changed && !alreadyPresent ? 'installed' : 'present', objectInfo: check, note: (download ? download.note : '文件已在位') + ' /object_info 已列出。' })
    } else {
      sawFailure = true
      reports.push({ kind: item.kind, filename: item.filename, targetPath: item.targetPath, bytes: source.bytes, state: 'failed', objectInfo: check, note: '下载/落盘后 /object_info 仍没列出：' + check.note + '（目标 ' + String(item.targetPath) + '；可见列表：' + check.options.join(', ') + '）。按部署文档排障顺序查：目录 -> 文件名 -> 扫描缓存。' })
    }
  }
  const ok = reports.filter((report) => report.state === 'present' || report.state === 'installed').length
  const state = sawFailure ? 'partial' : sawUnverified ? 'unverified' : changed ? 'downloaded' : 'ready'
  return {
    profile: profile.id,
    base: input.base,
    dryRun,
    state,
    weights: reports,
    note: ok + '/' + String(reports.length) + ' 个权重被 /object_info 列出；' + (sawFailure ? '有失败项，见 weights。' : sawUnverified ? '有文件已落盘但当前没有运行中的 ComfyUI 可验证。' : '全部就绪。'),
  }
}

/** One step of the manual install guide. */
export interface InstallStep {
  readonly title: string
  readonly detail: string
}

/** What install guidance says, and whether automation is authorised. */
export interface InstallGuidance {
  readonly state: 'installed' | 'not-installed'
  readonly mode: 'manual' | 'automated'
  readonly authorized: boolean
  readonly downloadPage: string
  readonly options: readonly string[]
  readonly steps: readonly InstallStep[]
  readonly note: string
}

/**
 * Build the install guide. Automation is gated on the host granting computer
 * use: this plugin never drives a GUI installer by itself, and an unauthorised
 * environment must not even attempt it (T14 acceptance).
 */
export function installGuidanceOf(deps: EnvironmentDeps = {}, installed = false): InstallGuidance {
  const authorized = deps.computerUse?.authorized === true
  const shared = {
    state: installed ? ('installed' as const) : ('not-installed' as const),
    authorized,
    downloadPage: 'https://www.comfy.org/download',
    options: ['Windows 安装包（.exe，官方下载页）', '装到有空间的盘（本机 D 盘）', '计算后端选 CUDA（NVIDIA）'],
  }
  if (installed) return { ...shared, mode: 'manual', steps: [], note: 'ComfyUI 已安装，不需要安装引导。' }
  if (authorized) {
    return {
      ...shared,
      mode: 'automated',
      steps: [
        { title: '授权门槛', detail: '宿主已授予 computer use；自动流程由宿主的授权执行器完成，插件本身不模拟点击。' },
        { title: '安装', detail: '下载官方 Windows 安装包 -> 选择安装盘 -> 计算后端 CUDA -> 首次启动建实例。' },
      ],
      note: '已授权自动安装；若宿主没有提供安装执行器，则退回手工步骤。',
    }
  }
  return {
    ...shared,
    mode: 'manual',
    steps: [
      { title: '1. 下载', detail: '打开 https://www.comfy.org/download 下载 Windows 安装包（.exe）。' },
      { title: '2. 选盘安装', detail: '安装时选择空间足够的盘（本机装在 D:\\Comfy-Desktop）；装完目录里有 ComfyUI-Installs 与 ComfyUI-Shared。' },
      { title: '3. 选计算后端', detail: 'NVIDIA 卡选 CUDA；AMD / Apple Silicon 按各自分支安装。' },
      { title: '4. 首次启动', detail: '启动一次让它建实例（会自动拉起 ComfyUI）；实例在 8188/8000 应答即可。' },
      { title: '5. 回来自检', detail: '回到本工具 action=status；就绪后 action=download 按当前 comfyModel 下载三个权重（先不带 confirm 看计划）。' },
    ],
    note: '未获 computer use 授权：只输出图文步骤，不执行任何自动安装。',
  }
}

/** Run authorised install automation, if (and only if) the host granted it. */
export async function runInstallAutomation(deps: EnvironmentDeps = {}): Promise<{ ran: boolean; note: string }> {
  const gate = deps.computerUse
  if (!gate || gate.authorized !== true) return { ran: false, note: '未获 computer use 授权：不执行任何自动安装动作（手动步骤见 install.steps）。' }
  if (typeof gate.run !== 'function') return { ran: false, note: '已授权但宿主没有提供安装执行器：不假装能装，退回手工步骤。' }
  try {
    const result = await gate.run()
    return { ran: true, note: typeof result?.note === 'string' ? result.note : '自动安装执行器已运行。' }
  } catch (error) {
    return { ran: false, note: '自动安装执行器失败：' + (error instanceof Error ? error.message : String(error)) }
  }
}

/** The tool name the environment layer registers. Never `qwen_image_env`. */
export const ENVIRONMENT_TOOL_NAME = 'qwen_image_setup'

/** One-line, user-facing summary of a status report. */
function summarize(status: EnvironmentStatus): string {
  if (status.state === 'ready') {
    const devices = status.stats?.devices ?? []
    const gpu = devices.length > 0 ? `，${devices[0]?.name ?? 'GPU'}` : ''
    return `ComfyUI 就绪：${status.endpoint}（${status.source === 'launched' ? '本次拉起' : status.source === 'configured' ? '配置端点' : '端口探测'}${gpu}）。`
  }
  if (status.state === 'not-running') {
    return `ComfyUI 没在跑，但找到了安装：${status.install?.installPath ?? '?'}。可以用 action="start" 后台拉起。`
  }
  if (status.state === 'not-installed') return '没找到 ComfyUI 安装（未安装状态；本工具不负责安装）。'
  return status.note
}

/**
 * Register the environment tool on the tool registry.
 *
 * @param ctx - cordis context providing `tools`.
 * @param getConfig - reads the activation's config **per call**, so a settings
 *   save (a new port list, a different endpoint) is observed without a restart.
 */
export function registerEnvironmentTools(ctx: Context, getConfig: () => Config): void {
  ctx.tools.register(
    defineTool({
      name: ENVIRONMENT_TOOL_NAME,
      description:
        '环境层（P1a/P1b）：探测本机 ComfyUI——先按配置的端点/端口表探活，再读 Comfy Desktop 注册表判断装没装；' +
        '没在跑时 action="start" 按 Desktop 记录的 Python 与启动参数后台拉起并等 /system_stats 就绪，action="stop" 只停本插件/脚本拉起过的实例。' +
        'P1b：action="install" 输出安装引导（未获 computer use 授权时绝不执行自动安装）；' +
        'action="download" 把当前 comfyModel 的三个权重按实测方案下载到 Desktop 模型根（.part + 字节数/sha256 + 原子改名）。' +
        '下载成功的唯一判据是 /object_info/<Loader> 的候选列表包含精确文件名；本工具不重启 ComfyUI。先不带 confirm 调用可只看计划。',
      parameters: {
        action: {
          type: 'string',
          enum: ['status', 'start', 'stop', 'install', 'download'],
          description:
            'status（默认）=看现状（含安装引导与权重在位情况）；start=没在跑就拉起；stop=停掉本插件拉起的实例；install=安装引导；download=按当前 comfyModel 下载权重（不带 confirm 只出计划）。',
        },
        timeoutMs: {
          type: 'integer',
          description: 'start 时等 /system_stats 就绪的预算（毫秒，5 秒–15 分钟），默认 180000。',
        },
        confirm: {
          type: 'boolean',
          description: '仅 download 使用：缺省 false = dry-run 只返回计划；true 才真的下载并落盘（体积可达 16 GiB 以上，支持断点续传）。',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      timeoutMs: 900_000,
      isConcurrencySafe: () => false,
      async execute(args: any, _exec: any) {
        const actions = ['start', 'stop', 'install', 'download']
        const action = actions.includes(args?.action) ? args.action : 'status'
        const startedAt = Date.now()
        const config = getConfig()
        let options = environmentOptionsOf(config)
        const requested = args?.timeoutMs
        if (action === 'start' && typeof requested === 'number' && Number.isFinite(requested)) {
          options = { ...options, installTimeoutMs: Math.min(900_000, Math.max(5_000, Math.round(requested))) }
        }
        if (action === 'stop') {
          const stop = await stopEnvironment()
          return jsonSafe({ action, environment: null, stop, summary: stop.note, elapsed_ms: Date.now() - startedAt })
        }
        const environment = action === 'start' ? await ensureEnvironment(options) : await inspectEnvironment(options)
        const endpoint = environment.state === 'ready' ? environment.endpoint : null
        if (action === 'install') {
          const install = installGuidanceOf({}, environment.state !== 'not-installed')
          const automation = await runInstallAutomation({})
          return jsonSafe({ action, environment, install, automation, summary: automation.note, elapsed_ms: Date.now() - startedAt })
        }
        if (action === 'download') {
          if (environment.state !== 'ready') {
            const install = installGuidanceOf({}, environment.state !== 'not-installed')
            return jsonSafe({
              action,
              environment,
              install,
              models_base: { base: null, source: null, note: 'ComfyUI 没在跑，下载与 /object_info 校验都无法进行。' },
              weights: null,
              summary: 'ComfyUI 没就绪：先用 action="start" 启动（或装好/启动 ComfyUI），再回来下载。',
              elapsed_ms: Date.now() - startedAt,
            })
          }
          const base = await resolveModelsBase({ endpoint })
          const dryRun = args?.confirm !== true
          const weights = await ensureProfileWeights({ profileId: config.comfyModel, base: base.base, endpoint, dryRun })
          return jsonSafe({
            action,
            environment,
            models_base: base,
            weights,
            dry_run: dryRun,
            summary: dryRun ? 'dry-run：' + weights.note : weights.note,
            elapsed_ms: Date.now() - startedAt,
          })
        }
        const base = environment.state === 'ready' || environment.state === 'not-running'
          ? await resolveModelsBase({ endpoint })
          : { base: null, source: null, note: '未安装：没有可解析的模型根。' }
        const install = installGuidanceOf({}, environment.state !== 'not-installed')
        const weights = environment.state === 'ready' && base.base ? await ensureProfileWeights({ profileId: config.comfyModel, base: base.base, endpoint, dryRun: true }) : null
        return jsonSafe({
          action,
          environment,
          install,
          models_base: base,
          weights,
          summary: summarize(environment),
          elapsed_ms: Date.now() - startedAt,
        })
      },
    }),
  )
}
