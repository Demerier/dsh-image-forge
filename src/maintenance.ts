/**
 * Local-runtime status and repair: venv, weights, worker, and what to do next.
 *
 * The guiding rule for `repair` is that it must never claim a fix it did not
 * make. Every check lands in exactly one of four states — `ok`, `fixed`,
 * `unfixable` (with the reason *and* the remedy), or `skipped` — and nothing
 * that requires a 10.6 GiB download is ever performed behind the user's back.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { executableMissing, pathExists, runCaptured } from './procx.ts'
import { probeInterpreter, probePackages, runInstall, venvPaths, type InstallReport, type PackageReport } from './venv.ts'
import { applyQuantizationFlag, inspectWeights, type WeightsInspection } from './weights.ts'
import type { WorkerProbe, WorkerRuntime } from './worker.ts'

/** What `qwen_image_env status` needs to describe the local stack. */
export interface LocalRuntimeInput {
  readonly runtime: WorkerRuntime
  readonly runtimeDir: string
  readonly python: string
  readonly modelsDir: string
  readonly dataDir: string
  readonly probeTimeoutMs: number
  readonly scratchDir: string
  /** Skip the python package probe (it costs one interpreter start). */
  readonly skipPackages?: boolean
  readonly signal?: AbortSignal
}

/**
 * Why this module never asks the OS "is that pid alive?".
 *
 * The usual idiom is `process.kill(pid, 0)`, but on Windows libuv does not
 * implement signal 0 at all: it throws `ESRCH` even for a *live* process. The
 * obvious fallback, `tasklist /FI "PID eq N"`, is denied under this host's
 * sandbox (its stderr is an access-denied error). Either way the probe answers
 * "not alive" for a running worker, silently disabling every hung-worker branch.
 *
 * So the plugin reasons from evidence it already owns: the child handle it holds
 * (a live `pid`, a watched `exit` event) and the breadcrumb the worker writes. A
 * pid recorded by an *earlier* session is reported, never killed — killing a
 * number we cannot verify would risk terminating somebody else's process.
 */

/** The breadcrumb a running worker leaves behind. */
export interface WorkerBreadcrumb {
  readonly pid?: number
  readonly port?: number
  readonly ready?: boolean
  readonly started_at?: number
  readonly models_dir?: string
}

/** Read the breadcrumb the worker writes, if one exists. */
export async function readWorkerStateFile(dataDir: string): Promise<WorkerBreadcrumb | null> {
  try {
    return JSON.parse(await readFile(join(dataDir, 'worker-state.json'), 'utf8')) as WorkerBreadcrumb
  } catch {
    return null
  }
}

/**
 * Describe the plugin's own local stack.
 *
 * @param input - runtime handle plus the resolved paths.
 * @returns worker / venv / weights facts and the advisories they imply.
 */
export async function collectLocalRuntime(input: LocalRuntimeInput): Promise<Record<string, unknown>> {
  const paths = venvPaths(input.runtimeDir)
  const [probe, weights] = await Promise.all([
    input.runtime.inspect(input.runtime.endpoint, 1500, input.signal),
    inspectWeights(input.modelsDir),
  ])
  const interpreterExists = pathExists(input.python)
  const interpreter = interpreterExists
    ? await probeInterpreter(input.python, { timeoutMs: 30_000, scratchDir: input.scratchDir })
    : { path: input.python, ok: false as const, note: `not found: ${input.python} — run action "install"` }
  let packages: PackageReport | null = null
  if (interpreterExists && input.skipPackages !== true) {
    packages = await probePackages(input.python, { timeoutMs: 300_000, scratchDir: input.scratchDir })
  }
  const breadcrumb = await readWorkerStateFile(input.dataDir)

  const advisories: string[] = []
  if (!weights.ready) {
    advisories.push(
      `权重未就绪（缺 ${weights.missing_files.length} 个文件，目录 ${input.modelsDir}）：跑 \`qwen_image_env action:"fetch-weights"\`（先加 \`dryRun:true\` 看清单与磁盘需求）。`,
    )
  }
  if (!interpreterExists) {
    advisories.push(`venv 解释器不存在：${input.python} —— 跑 \`qwen_image_env action:"install"\`。`)
  } else if (packages !== null && !packages.ok) {
    advisories.push(`venv 里缺包（${packages.note ?? '未知名'}）：跑 \`qwen_image_env action:"repair"\` 补装。`)
  }
  const workerReport = describeWorker(probe, input.runtime, breadcrumb)
  const lifecycle = workerReport.state as WorkerLifecycle
  advisories.unshift(workerReport.explanation as string)
  if (lifecycle === 'not-responding' || lifecycle === 'load-failed') {
    if (input.runtime.lastStartFailureAt !== null) {
      advisories.push(`上一次启动失败的原因：${input.runtime.lastStartFailureAt.message}`)
    }
  }
  if (lifecycle === 'never-started' && weights.ready && interpreterExists && (packages === null || packages.ok)) {
    advisories.push('环境齐备：直接调 `qwen_image_generate` 即可，插件会自己拉起 worker（冷启动约 15 s，2K 首图约 50 s）。')
  }

  return {
    worker: workerReport,
    venv: {
      dir: paths.venvDir,
      python: input.python,
      exists: interpreterExists,
      version: interpreter.ok ? interpreter.version : null,
      note: interpreter.ok ? undefined : interpreter.note,
      packages: packages?.versions ?? null,
      packages_ok: packages?.ok ?? null,
      packages_note: packages?.note ?? null,
      torch: packages?.torch ?? null,
    },
    weights,
    advisories,
    ready_to_generate:
      weights.ready &&
      interpreterExists &&
      (packages === null || packages.ok) &&
      lifecycle !== 'load-failed' &&
      lifecycle !== 'not-responding',
  }
}

/** The lifecycle state a user has to be told apart, in their own words. */
export type WorkerLifecycle =
  | 'ready'
  | 'starting'
  | 'unloaded'
  | 'load-failed'
  | 'not-responding'
  | 'never-started'

/**
 * Decide which of the six states the worker is in.
 *
 * The states a user confuses, and why they must be separated: "never started"
 * (nothing to fix — the first generation starts it), "not responding" (the
 * plugin watched it die, or a breadcrumb pid is alive but the port refuses —
 * typically an external kill, *not* a misconfiguration), and "load failed"
 * (a real environment problem that retrying will not fix).
 *
 * @param probe - the passive probe result.
 * @param runtime - the lifecycle owner.
 * @param breadcrumb - the worker's last written `worker-state.json`.
 * @returns the state plus one sentence explaining it.
 */
export function classifyWorker(
  probe: WorkerProbe,
  runtime: WorkerRuntime,
  breadcrumb: WorkerBreadcrumb | null,
): { state: WorkerLifecycle; explanation: string } {
  if (probe.reachable) {
    if (probe.state?.load_error !== null && probe.state?.load_error !== undefined) {
      return {
        state: 'load-failed',
        explanation: `worker 在跑，但模型加载失败：${probe.state.load_error}（重试不会修好，先看日志与环境）。`,
      }
    }
    if (probe.ready) {
      return { state: 'ready', explanation: `worker 在 ${probe.endpoint} 上就绪（pid ${probe.state?.pid ?? '?'}）。` }
    }
    if (probe.state?.loading === true) {
      return { state: 'starting', explanation: 'worker 在跑，模型正在加载（/health 还是 503）。' }
    }
    return {
      state: 'unloaded',
      explanation: 'worker 进程在跑但模型已卸载（空闲回收或 POST /unload）；下一张图会自动重新加载。',
    }
  }
  const pid = runtime.pid ?? breadcrumb?.pid
  if (runtime.sawWorkerExit) {
    return {
      state: 'not-responding',
      explanation:
        `worker 已经被结束（插件看到了子进程的 exit 事件${pid === undefined ? '' : `，上次 pid ${pid}`}），` +
        `${probe.endpoint} 现在拒绝连接。**这不是配置问题**：下一次 \`qwen_image_generate\` 会自动重拉一个。`,
    }
  }
  if (breadcrumb !== null) {
    return {
      state: 'not-responding',
      explanation:
        `worker-state.json 记的 pid ${breadcrumb.pid} 还活着，但 ${probe.endpoint} 不应答——多半是卡死；` +
        '跑 `qwen_image_env action:"repair"` 会把它杀掉。',
    }
  }
  return {
    state: 'never-started',
    explanation: `worker 从未启动（${probe.endpoint} 无人应答）；第一次出图时插件会自己拉起它。`,
  }
}

/** Shape one worker probe plus the runtime's own bookkeeping. */
function describeWorker(
  probe: WorkerProbe,
  runtime: WorkerRuntime,
  breadcrumb: WorkerBreadcrumb | null,
): Record<string, unknown> {
  const state = probe.state
  const lifecycle = classifyWorker(probe, runtime, breadcrumb)
  const lastFailure = runtime.lastStartFailureAt
  return {
    state: lifecycle.state,
    explanation: lifecycle.explanation,
    last_start_failure:
      lastFailure === null ? null : { seconds_ago: Math.round((Date.now() - lastFailure.at) / 1000), message: lastFailure.message },
    endpoint: probe.endpoint,
    port: runtime.port,
    reachable: probe.reachable,
    ready: probe.ready,
    ours: probe.ours,
    managed_by_this_session: runtime.ownsProcess,
    pid: typeof state?.pid === 'number' ? state.pid : runtime.pid ?? breadcrumb?.pid ?? null,
    rss_MiB: state?.rss_MiB ?? null,
    vram_allocated_MiB: state?.vram_allocated_MiB ?? null,
    vram_reserved_MiB: state?.vram_reserved_MiB ?? null,
    generations: state?.generations ?? null,
    load_seconds: state?.load_seconds ?? null,
    uptime_s: state?.uptime_s ?? null,
    load_error: state?.load_error ?? null,
    version: state?.version ?? null,
    log_file: runtime.logFile,
    health_status: probe.healthStatus ?? null,
    note: probe.note,
    lifecycle_events: runtime.events.slice(0, 10),
  }
}

/** One repair check and what happened to it. */
export interface RepairCheck {
  readonly name: string
  readonly status: 'ok' | 'fixed' | 'unfixable' | 'skipped'
  readonly detail: string
  /** What the user must do when the check could not be fixed. */
  readonly remedy?: string
}

/** Result of `qwen_env action:"repair"`. */
export interface RepairReport {
  readonly action: 'repair'
  readonly dry_run: boolean
  readonly ok: boolean
  readonly checks: RepairCheck[]
  readonly install: InstallReport | null
  readonly weights: WeightsInspection
  readonly next: string
}

/** Options for `runRepair`. */
export interface RepairOptions {
  readonly runtime: WorkerRuntime
  readonly runtimeDir: string
  readonly python: string
  readonly modelsDir: string
  readonly dataDir: string
  readonly pipwrap: string
  readonly basePythonCandidates: readonly string[]
  readonly torchWheels: readonly string[]
  readonly pipIndexUrl: string
  readonly reuseBaseTorch: boolean
  readonly dryRun: boolean
  readonly commandTimeoutMs: number
  readonly scratchDir: string
  readonly signal?: AbortSignal
}

/**
 * Fix what can be fixed locally, and name what cannot.
 *
 * @param options - resolved config paths plus the runtime handle.
 * @returns per-check outcomes, the install report when one ran, and the next step.
 */
export async function runRepair(options: RepairOptions): Promise<RepairReport> {
  const checks: RepairCheck[] = []
  const weights = await inspectWeights(options.modelsDir)

  // 1. Quantization flags: a two-line JSON fix, and the CPU/GPU split needs it.
  if (weights.ready) {
    if (weights.quantization_flag === true) {
      checks.push({ name: 'weights:quantization flag', status: 'ok', detail: 'llm_int8_enable_fp32_cpu_offload is set in both configs' })
    } else if (options.dryRun) {
      checks.push({
        name: 'weights:quantization flag',
        status: 'skipped',
        detail: 'would set quantization_config.llm_int8_enable_fp32_cpu_offload = true in transformer/config.json and text_encoder/config.json',
      })
    } else {
      const outcome = await applyQuantizationFlag(options.modelsDir)
      const failed = Object.entries(outcome).filter(([, value]) => typeof value === 'string' && value.startsWith('failed'))
      checks.push({
        name: 'weights:quantization flag',
        status: failed.length === 0 ? 'fixed' : 'unfixable',
        detail: JSON.stringify(outcome),
        remedy: failed.length === 0 ? undefined : 'Check the model directory permissions.',
      })
    }
  } else {
    checks.push({
      name: 'weights',
      status: 'unfixable',
      detail: `${weights.missing_files.length} of ${weights.missing_files.length + weights.present_files.length} files are missing in ${options.modelsDir}`,
      remedy: 'Run `qwen_image_env action:"fetch-weights"` — repair never downloads 10.6 GiB on its own.',
    })
  }

  // 2. Environment: the install path is idempotent and skips what is present.
  let install: InstallReport | null = null
  if (executableMissing(options.python)) {
    if (options.dryRun) {
      checks.push({ name: 'venv', status: 'skipped', detail: `would create ${options.python}` })
    }
    install = await runInstall({
      runtimeDir: options.runtimeDir,
      pipwrap: options.pipwrap,
      basePythonCandidates: options.basePythonCandidates,
      torchWheels: options.torchWheels,
      pipIndexUrl: options.pipIndexUrl,
      reuseBaseTorch: options.reuseBaseTorch,
      dryRun: options.dryRun,
      commandTimeoutMs: options.commandTimeoutMs,
      scratchDir: options.scratchDir,
    })
    checks.push({
      name: 'venv:install',
      status: options.dryRun ? 'skipped' : install.ok ? 'fixed' : 'unfixable',
      detail: options.dryRun ? 'dry run: nothing was executed' : (install.steps.map((step) => `${step.name}=${step.status}`).join(', ')),
      remedy: install.ok ? undefined : install.next,
    })
  } else {
    const packages = await probePackages(options.python, { timeoutMs: 300_000, scratchDir: options.scratchDir })
    if (packages.ok) {
      checks.push({ name: 'venv:packages', status: 'ok', detail: `torch ${packages.torch?.version ?? '?'} (cuda ${packages.torch?.cuda ?? 'none'})` })
    } else if (options.dryRun) {
      checks.push({ name: 'venv:packages', status: 'skipped', detail: `would install: ${packages.note ?? 'unknown'}` })
    } else {
      install = await runInstall({
        runtimeDir: options.runtimeDir,
        pipwrap: options.pipwrap,
        basePythonCandidates: options.basePythonCandidates,
        torchWheels: options.torchWheels,
        pipIndexUrl: options.pipIndexUrl,
        reuseBaseTorch: options.reuseBaseTorch,
        dryRun: false,
        commandTimeoutMs: options.commandTimeoutMs,
        scratchDir: options.scratchDir,
      })
      checks.push({
        name: 'venv:packages',
        status: install.ok ? 'fixed' : 'unfixable',
        detail: install.steps.map((step) => `${step.name}=${step.status}`).join(', '),
        remedy: install.ok ? undefined : install.next,
      })
    }
  }

  // 3. Worker: a hung process is worth killing, a missing one is not a fault.
  const probe = await options.runtime.inspect(options.runtime.endpoint, 1500, options.signal)
  const breadcrumb = await readWorkerStateFile(options.dataDir)
  if (probe.reachable) {
    if (probe.state?.load_error) {
      checks.push({
        name: 'worker',
        status: 'unfixable',
        detail: `the worker is up but its model failed to load: ${probe.state.load_error}`,
        remedy: `Read the log tail (${options.runtime.logFile ?? 'worker log'}) — a load failure is a weights/environment problem, not a stuck process.`,
      })
    } else {
      checks.push({ name: 'worker', status: 'ok', detail: `answering on ${probe.endpoint} (ready=${probe.ready})` })
    }
  } else if (options.runtime.pid !== null && options.dryRun) {
    checks.push({
      name: 'worker',
      status: 'skipped',
      detail: `would stop the unresponsive worker pid ${options.runtime.pid} owned by this session`,
    })
  } else if (options.runtime.pid !== null) {
    // The plugin holds this handle, so this is a kill it can verify: the process
    // is the one it started, it is not answering HTTP, and nothing else can be
    // behind that pid.
    const pid = options.runtime.pid
    const stopped = await options.runtime.stop()
    const fixed = stopped.stopped === true
    checks.push({
      name: 'worker',
      status: fixed ? 'fixed' : 'unfixable',
      detail: fixed
        ? `stopped the unresponsive worker pid ${pid}; the next generation starts a fresh one`
        : `the worker pid ${pid} does not answer HTTP and could not be stopped: ${String(stopped.reason ?? 'unknown')}`,
      remedy: fixed ? undefined : `Stop pid ${pid} manually, then call \`qwen_image_generate\` again.`,
    })
  } else if (breadcrumb?.pid !== undefined) {
    // A pid from an earlier session: report it, never kill it. Without a working
    // liveness probe the number may already belong to somebody else.
    checks.push({
      name: 'worker',
      status: 'unfixable',
      detail:
        `worker-state.json records pid ${breadcrumb.pid} from an earlier session, and ${options.runtime.endpoint} does not answer. ` +
        'The plugin will not kill a pid it does not own.',
      remedy:
        `If pid ${breadcrumb.pid} is really still there, stop it yourself (\`taskkill /PID ${breadcrumb.pid} /F\` on Windows). ` +
        'Otherwise nothing is blocked: a worker that does not answer is simply started again on demand.',
    })
  } else {
    checks.push({ name: 'worker', status: 'ok', detail: `no worker on ${options.runtime.endpoint} — it is started on demand` })
  }

  // 4. Port: a foreign service on the preferred port is survivable, because the
  // runtime walks the configured range. Report it instead of failing the repair.
  const portBusy = await options.runtime.preflight()
  checks.push({
    name: 'worker:port',
    status: 'ok',
    detail: portBusy.portBusy
      ? `port ${options.runtime.port} is taken; the plugin will pick the next free port in \`workerPorts\``
      : `port ${options.runtime.port} is free`,
  })

  const unfixable = checks.filter((check) => check.status === 'unfixable')
  const fixed = checks.filter((check) => check.status === 'fixed')
  return {
    action: 'repair',
    dry_run: options.dryRun,
    ok: unfixable.length === 0,
    checks,
    install,
    weights,
    next:
      unfixable.length > 0
        ? unfixable.map((check) => `${check.name}: ${check.remedy ?? check.detail}`).join('\n')
        : fixed.length > 0
          ? `${fixed.length} problem(s) fixed: ${fixed.map((check) => check.name).join(', ')}.`
          : 'Nothing needed fixing.',
  }
}
