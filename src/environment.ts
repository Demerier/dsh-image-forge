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
 * This file does **not** install ComfyUI and does **not** download weights. The
 * structured `not-installed` state is the hand-off point P1b (T14) consumes.
 */

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
  launchComfyPlan,
  stopComfyPlan,
  waitForComfyStats,
} from '../scripts/comfyui-discovery.mjs'
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
}

/** The config fields `environmentOptionsOf` reads. */
export interface EnvironmentSettings {
  /** `comfyEndpoint` as the settings resolver produced it. */
  readonly comfyEndpoint: string
  /** `comfyPorts` as configured (comma separated). */
  readonly comfyPorts: string
  /** The plugin's per-call budget; kept for parity with the other front doors. */
  readonly timeoutMs: number
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
    ports: parseComfyPorts(settings.comfyPorts),
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
  /** `fetch`-shaped hook for `/system_stats` probes. */
  readonly fetchImpl?: typeof fetch
  /** Clock, for deterministic waits. */
  readonly now?: () => number
  /** Sleep, for deterministic waits. */
  readonly sleep?: (ms: number) => Promise<void>
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
 */
function discoverInstall(deps: EnvironmentDeps): any {
  try {
    return discoverComfyPlan({
      env: deps.env ?? process.env,
      platform: deps.platform ?? process.platform,
      appData: deps.appData,
      scanRoots: deps.scanRoots,
    })
  } catch {
    return null
  }
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
  },
): Promise<EnvironmentStatus> {
  const stats = await comfySystemStats(target.endpoint, 5000)
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
    note: `ComfyUI 在跑：${sourceLabel}。`,
    hint: null,
    logPath: extras.logPath,
    waitedMs: extras.waitedMs,
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
      '把 action 改成 "start" 用本工具后台拉起（按 Comfy Desktop 记录的启动参数，不自行发明 flag），' +
      '或直接跑 node scripts/start-comfyui.mjs。',
    logPath: null,
    waitedMs: null,
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

  const plan = discoverInstall(deps)
  if (!plan) return inspected
  const endpoint = plan.port ? `http://127.0.0.1:${plan.port}` : options.endpoint

  let launch: any
  try {
    launch = launchComfyPlan(plan, { spawn: deps.spawn, endpoint })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      state: 'launch-failed',
      endpoint: null,
      port: Number(plan.port),
      source: null,
      install: installSummaryOf(plan),
      probed: [],
      stats: null,
      note: `后台拉起失败：${reason}`,
      hint: '先用 node scripts/start-comfyui.mjs --print 看完整 argv 与 Python 路径，再确认 Desktop 记录的安装还能用。',
      logPath: null,
      waitedMs: null,
      elapsedMs: nowOf(deps)() - startedAt,
    }
  }

  const wait = await waitForComfyStats(endpoint, {
    child: launch.child,
    timeoutMs: options.installTimeoutMs,
    intervalMs: options.waitIntervalMs,
    fetchImpl: deps.fetchImpl ?? fetch,
    now: deps.now,
    sleep: deps.sleep,
  })
  if (wait.ok) {
    const ready = await readyStatus(
      { endpoint, port: Number(plan.port), probed: [{ endpoint, ok: true, note: null }] },
      'launched',
      { install: installSummaryOf(plan), logPath: launch.logPath, waitedMs: wait.waitedMs ?? null, startedAt, deps },
    )
    return { ...ready, note: `已后台拉起 ComfyUI：${endpoint}（pid ${launch.pid}）。`, logPath: launch.logPath }
  }

  const waitedMs = wait.waitedMs ?? null
  const failed = wait.reason === 'exited'
  return {
    state: failed ? 'launch-failed' : 'timeout',
    endpoint: null,
    port: Number(plan.port),
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
export function stopEnvironment(deps: EnvironmentDeps = {}): {
  readonly stopped: boolean
  readonly pid: number | null
  readonly note: string
} {
  const plan = discoverInstall(deps)
  if (!plan) return { stopped: false, pid: null, note: '没找到 ComfyUI 安装，没有可停的实例（只停由插件/脚本拉起的实例）。' }
  return stopComfyPlan(plan, {
    platform: deps.platform ?? process.platform,
    spawnSync: deps.spawnSync,
    kill: deps.kill,
  }) as { stopped: boolean; pid: number | null; note: string }
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
        '环境层（P1a）：探测本机 ComfyUI——先按配置的端点/端口表探活，再读 Comfy Desktop 注册表判断装没装；' +
        '没在跑时 `action="start"` 会按 Desktop 记录的 Python 与启动参数**后台拉起**并等 `/system_stats` 就绪，' +
        '`action="stop"` 只停由插件/脚本拉起的那个实例（Windows 走 taskkill /F /T 清进程树）。' +
        '**不安装 ComfyUI、不下载权重**、不产生图片；未安装时返回结构化的 not-installed 状态供后续安装引导使用。',
      parameters: {
        action: {
          type: 'string',
          enum: ['status', 'start', 'stop'],
          description:
            'status（默认）=只看现状、不启动任何东西；start=没在跑就后台拉起并等就绪；stop=停掉本插件/脚本拉起过的实例。',
        },
        timeoutMs: {
          type: 'integer',
          description: 'start 时等 `/system_stats` 就绪的预算（毫秒，5 秒–15 分钟），默认 180000。',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      timeoutMs: 900_000,
      isConcurrencySafe: () => false,
      async execute(args: any, exec: any) {
        const action = args?.action === 'start' || args?.action === 'stop' ? args.action : 'status'
        const config = getConfig()
        let options = environmentOptionsOf(config)
        const requested = args?.timeoutMs
        if (action === 'start' && typeof requested === 'number' && Number.isFinite(requested)) {
          options = { ...options, installTimeoutMs: Math.min(900_000, Math.max(5_000, Math.round(requested))) }
        }
        const startedAt = Date.now()
        if (action === 'stop') {
          const stop = stopEnvironment()
          return jsonSafe({ action, environment: null, stop, summary: stop.note, elapsed_ms: Date.now() - startedAt })
        }
        const environment = action === 'start' ? await ensureEnvironment(options) : await inspectEnvironment(options)
        return jsonSafe({
          action,
          environment,
          summary: summarize(environment),
          elapsed_ms: Date.now() - startedAt,
        })
      },
    }),
  )
}
