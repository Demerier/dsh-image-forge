/**
 * Worker lifecycle: the plugin starts, watches, restarts and reaps its own
 * inference worker.
 *
 * The plugin previously assumed somebody else kept a worker alive. That is not
 * a safe assumption on this host: a worker started as a child job of a session
 * is taken away with that session, and the next call sees a refused connection.
 * So the plugin owns the process — it picks a port, spawns the shipped
 * `resources/worker.py` with the venv's interpreter, waits for readiness,
 * adopts a worker that is already up, and rebuilds one that died.
 *
 * Deliberate transport choice: the child's stdout/stderr are handed to a log
 * file descriptor, never a pipe. This host's sandbox denies pipe-backed spawns
 * (`EPERM`) and a pipe would in any case lose the log the moment the parent
 * dies. The log file is the error channel: when the worker fails to come up,
 * its last lines are read back and put into the error the user sees.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, readFileSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import {
  analyseVram,
  comfyFreeCommand,
  freeComfyMemory,
  probeGpu,
  probeGpuProcesses,
  resolveListenerPid,
  vramSuspicionWarning,
  type FreeComfyResult,
  type GpuProcess,
  type VramAdvisory,
} from './env.ts'
import { executableMissing, openLogFile } from './procx.ts'

/** The pre-start VRAM gate. */
export interface VramGateSettings {
  /** Free VRAM (MiB) required before the worker may be started; 0 disables the gate. */
  readonly requiredMiB: number
  /** Port ComfyUI answers on: fallback for the remedy line and the opt-in `/free`. */
  readonly comfyPort: number
  /**
   * Ports to look for ComfyUI on, in order. The live one wins over `comfyPort`, which
   * matters because the configured list's *first* entry need not be where ComfyUI
   * listens: a remedy line naming a dead port sends the user chasing nothing.
   */
  readonly comfyPorts?: readonly number[]
  /** Explicit opt-in (default false): ask ComfyUI to unload before starting the worker. */
  readonly freeComfyFirst: boolean
  /** Where the throwaway `nvidia-smi` logs go. */
  readonly scratchDir?: string
  /** Budget for the GPU probes. */
  readonly probeTimeoutMs?: number
}

/** The GPU facts the gate works from, separated so tests can drive exact numbers. */
export interface VramProbe {
  /** Free VRAM on GPU 0, or null when it could not be read. */
  readonly freeMiB: number | null
  /** Total VRAM on GPU 0, or null. */
  readonly totalMiB: number | null
  /** Processes holding VRAM. */
  readonly processes: readonly GpuProcess[]
  /** Something is listening on the ComfyUI port. */
  readonly comfyReachable: boolean
  /** Pid listening on the ComfyUI port, when it could be resolved. */
  readonly comfyPid?: number
  /** The port ComfyUI actually answered on, when one of the candidates did. */
  readonly comfyPort?: number
}

/** How the runtime reads the GPU. Swapped out in tests; defaults to `nvidia-smi`. */
export type VramProbeFn = (gate: VramGateSettings) => Promise<VramProbe>

/** What the gate saw and what it did, for the tool result to report honestly. */
export interface VramGateReport {
  /** True when a start was allowed (including "gate disabled"). */
  readonly allowed: boolean
  /** False when the gate did not run at all (`requiredMiB: 0`). */
  readonly ran: boolean
  /** Free VRAM the gate read, or null. */
  readonly freeMiB: number | null
  /** Total VRAM the gate read, or null. */
  readonly totalMiB: number | null
  /** The floor that was compared against. */
  readonly requiredMiB: number
  /** MiB that still has to be released; null when the start was allowed. */
  readonly shortfallMiB: number | null
  /** Processes holding VRAM when the gate looked. */
  readonly holders: readonly (GpuProcess & { readonly comfyui: boolean })[]
  /** ComfyUI's port, when the gate knows it. */
  readonly comfyPort: number | null
  /**
   * The opt-in `POST /free` was actually issued, and this is what came back.
   * Null on the default path, which never touches another program.
   */
  readonly freedComfy: FreeComfyResult | null
  /**
   * The start was allowed **but the card was not empty**: who was holding VRAM and
   * what to do about it (see {@link vramSuspicionWarning}). Null when the start was
   * refused — the refusal itself carries the remedy — or when nothing was holding.
   */
  readonly warning: string | null
}

/** Window NTSTATUS values that reach Node as a process exit code. */
const WINDOWS_EXIT_STATUS: Record<number, { readonly hex: string; readonly cause: string }> = {
  3221225477: { hex: '0xC0000005', cause: 'ACCESS_VIOLATION（访问违例）' },
  3221225725: { hex: '0xC00000FD', cause: 'STACK_OVERFLOW（栈溢出）' },
  3221226505: { hex: '0xC0000409', cause: 'STACK_BUFFER_OVERRUN（fail-fast）' },
  3221225620: { hex: '0xC0000094', cause: 'INTEGER_DIVIDE_BY_ZERO（整数除零）' },
  3221226356: { hex: '0xC0000374', cause: 'HEAP_CORRUPTION（堆损坏）' },
}

/** What a worker's exit status means, and what to try next. */
export interface WorkerExitExplanation {
  /** One line naming the exit status in both decimal and hex form. */
  readonly headline: string
  /** Most likely cause first, as actionable lines. */
  readonly hints: string[]
}

/**
 * Turn a worker's exit status plus its log tail into a cause and a next step.
 *
 * This exists because `0xC0000005` is what the user actually sees when the card
 * is full: CUDA and the driver abort the process instead of raising a Python
 * `OutOfMemoryError`, so the exit code is the only evidence and it explains
 * nothing on its own. The caller appends the live VRAM numbers, which this
 * function deliberately cannot read.
 *
 * @param code - exit code Node reported, or null when the process was signalled.
 * @param signal - signal that ended it, when there was one.
 * @param tail - last lines of the worker log.
 * @returns the headline plus ordered hints.
 */
export function explainWorkerExit(code: number | null, signal: string | null, tail: string): WorkerExitExplanation {
  const status = code === null ? undefined : WINDOWS_EXIT_STATUS[code]
  const headline =
    status === undefined
      ? `exit code ${code ?? 'null'}${signal === null ? '' : ` signal ${signal}`}`
      : `exit code ${code} = ${status.hex} ${status.cause}`
  const cudaInLog = /CUDA out of memory|OutOfMemoryError|CUDA error|no CUDA-capable device|out of memory/i.test(tail)
  const crashLike = status !== undefined && (status.hex === '0xC0000005' || status.hex === '0xC0000374')
  const hints: string[] = []
  if (crashLike || cudaInLog) {
    hints.push(
      '最可能的原因：加载阶段的显存不够。模型加载要一次性分配约 4.5 GiB 给 transformer；显存被别人占着时，' +
        'CUDA/驱动常常直接让进程以访问违例结束，而不是抛一条可读的 Python OOM —— 所以这个退出码要当成「显存不足」来读。',
    )
    hints.push('按下面这段实时显存数据判断是谁占着；ComfyUI 的模型卸载命令就在里面。')
  } else if (/CUDA/i.test(tail)) {
    hints.push('日志里提到了 CUDA —— 上面 Last output 里那一行就是根因；显存不足也常以 CUDA 报错的形式出现。')
  } else if (/Traceback \(most recent call last\)/.test(tail)) {
    hints.push('worker 自己报的 Python 异常就在上面的 Last output 里 —— 那一行才是根因。')
  } else if (code === 0) {
    hints.push('worker 以 0 退出：它是被要求结束的（`POST /shutdown`），不是崩溃。')
  } else {
    hints.push('日志里没有 CUDA 或 Python 异常的痕迹；先按上面的退出码查，再看 Log 里最后几行。')
  }
  return { headline, hints }
}

/** Signature the shipped worker reports on `/state`, used to recognise our own. */
const SERVICE = 'dsh-image-forge-worker'

/**
 * How long a failed start is remembered before another spawn is allowed.
 *
 * Short enough that a user who fixes the problem (frees VRAM, finishes an
 * install) is not blocked, long enough that a caller looping on the tool does
 * not spawn a process per call.
 */
const RESTART_COOLDOWN_MS = 5000

/** Body of `GET /state`, as far as this module reads it. */
export interface WorkerStateBody {
  readonly status?: string
  readonly service?: string
  readonly version?: string
  readonly pid?: number
  readonly port?: number
  readonly ready?: boolean
  readonly loading?: boolean
  readonly load_error?: string | null
  readonly load_seconds?: number | null
  readonly generations?: number
  readonly models_dir?: string
  readonly uptime_s?: number
  readonly rss_MiB?: number | null
  readonly vram_allocated_MiB?: number | null
  readonly vram_reserved_MiB?: number | null
}

/** What a passive probe found. */
export interface WorkerProbe {
  /** Endpoint that was probed. */
  readonly endpoint: string
  /** The port answered `/state` (or `/health`). */
  readonly reachable: boolean
  /** The worker reports a loaded model. */
  readonly ready: boolean
  /** The worker is our shipped script (vs. an unknown service on that port). */
  readonly ours: boolean
  /** `/state` body when it parsed. */
  readonly state?: WorkerStateBody
  /** HTTP status of `/health` when it answered. */
  readonly healthStatus?: number
  /** Why the probe has no data. */
  readonly note?: string
}

/** The runtime view of the worker, returned by `ensure()`. */
export interface WorkerHandle {
  /** Endpoint that answering requests must use (may differ from the configured one). */
  readonly endpoint: string
  /** Port in use. */
  readonly port: number
  /** Process id, when the worker reports one. */
  readonly pid: number | null
  /** This call started the process. */
  readonly started: boolean
  /** An already-running worker was adopted rather than started. */
  readonly adopted: boolean
  /** The plugin owns the process (it may be killed and restarted). */
  readonly managed: boolean
  /** The worker is our shipped script. */
  readonly ours: boolean
  /** Milliseconds spent starting it (0 when adopted). */
  readonly startMs: number
  /** `/state` at the moment the handle was produced. */
  readonly state: WorkerStateBody | null
}

/** Everything the runtime needs, resolved from the plugin config. */
export interface WorkerRuntimeSettings {
  /** Configured `localEndpoint`, e.g. `http://127.0.0.1:8399`. */
  readonly endpoint: string
  /** Interpreter that runs the worker (the venv's python). */
  readonly interpreter: string
  /** Absolute path to the shipped `resources/worker.py`. */
  readonly script: string
  /** Directory holding the nf4 weights. */
  readonly modelsDir: string
  /** Directory for logs and breadcrumbs. */
  readonly dataDir: string
  /** Candidate ports, preferred one first. */
  readonly ports: readonly number[]
  /** How long a cold start may take before `ensure()` gives up. */
  readonly startTimeoutMs: number
  /** Idle time after which VRAM is handed back. 0 disables idle unload. */
  readonly idleUnloadMs: number
  /** When false, `ensure()` never starts a process — it only adopts one. */
  readonly manage: boolean
  /** Pre-start VRAM gate; omitted means the gate is off. */
  readonly vramGate?: VramGateSettings
  /** How to read the GPU; defaults to `nvidia-smi`. Tests replace it. */
  readonly probeVram?: VramProbeFn
}

/** One line of the lifecycle story, for `status` and for error messages. */
export interface LifecycleEvent {
  readonly at: string
  readonly event: string
  readonly detail?: string
}

/** Read the tail of a log file without loading the whole thing. */
function readLogTail(path: string, maxBytes = 65_536, maxLines = 25): string {
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - maxBytes)
    const raw = readFileSync(path).subarray(start).toString('utf8')
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0)
    return lines.slice(-maxLines).join('\n')
  } catch {
    return ''
  }
}

/** Sleep, honouring caller cancellation. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Does something accept TCP connections on this loopback port? */
export function isPortBusy(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const done = (busy: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(busy)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** Narrow an unknown JSON value into a record. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** GET a JSON endpoint with a budget, reporting rather than throwing. */
async function getJson(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null; note?: string }> {
  const controller = new AbortController()
  const signals = signal === undefined ? [controller.signal] : [controller.signal, signal]
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  try {
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.any(signals) })
    let body: Record<string, unknown> | null = null
    try {
      body = asRecord(await response.json())
    } catch {
      body = null
    }
    return { ok: response.ok, status: response.status, body }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, status: 0, body: null, note: reason }
  } finally {
    clearTimeout(timer)
  }
}

/** Parse `http://host:port` into a port number, or undefined. */
export function portOf(endpoint: string): number | undefined {
  try {
    const url = new URL(endpoint)
    const port = Number(url.port)
    return Number.isInteger(port) && port > 0 ? port : undefined
  } catch {
    return undefined
  }
}

/** Read the GPU the way the real host requires: `nvidia-smi`, never a shell. */
async function defaultVramProbe(gate: VramGateSettings): Promise<VramProbe> {
  const timeoutMs = gate.probeTimeoutMs ?? 5000
  // The configured list is a *search* list, not a claim about where ComfyUI lives: ask
  // every candidate which one has a listener, so the remedy line and the opt-in `/free`
  // both name the port that is really there (`comfyPorts` defaults to the single
  // configured `comfyPort`, which keeps the old behaviour for callers that pass one).
  const candidates = gate.comfyPorts !== undefined && gate.comfyPorts.length > 0 ? [...gate.comfyPorts] : [gate.comfyPort]
  const [gpu, processes, listeners] = await Promise.all([
    probeGpu(timeoutMs, gate.scratchDir),
    probeGpuProcesses(timeoutMs, gate.scratchDir),
    Promise.all(candidates.map((port) => resolveListenerPid(port, timeoutMs, gate.scratchDir))),
  ])
  const live = listeners.findIndex((pid) => pid !== undefined)
  const gpus = (gpu.data?.gpus ?? []) as { vramFreeMiB?: number; vramTotalMiB?: number }[]
  return {
    freeMiB: typeof gpus[0]?.vramFreeMiB === 'number' ? gpus[0].vramFreeMiB : null,
    totalMiB: typeof gpus[0]?.vramTotalMiB === 'number' ? gpus[0].vramTotalMiB : null,
    processes: (processes.data?.processes ?? []) as GpuProcess[],
    comfyReachable: live >= 0,
    comfyPid: live >= 0 ? listeners[live] : null,
    comfyPort: live >= 0 ? candidates[live] : null,
  }
}

/** Fold observed GPU facts into the shared verdict (`env.ts` owns the wording). */
function adviseFrom(facts: VramProbe, gate: VramGateSettings): VramAdvisory {
  return analyseVram(
    {
      ok: facts.freeMiB !== null,
      data: { gpus: [{ vramFreeMiB: facts.freeMiB, vramTotalMiB: facts.totalMiB }] },
    },
    { ok: true, data: { processes: [...facts.processes] } },
    { reachable: facts.comfyReachable, port: facts.comfyPort ?? gate.comfyPort },
    gate.requiredMiB,
    facts.comfyPid,
  )
}

/**
 * The gate's refusal, written so it can be acted on without reading any code:
 * who holds the memory, exactly how much is missing, and the command that fixes it.
 *
 * The two shapes get different wording on purpose, because they need different
 * actions: a **named holder** (ComfyUI, or this plugin's own worker) is freed with
 * one request, while **no visible holder** is the `cudaMallocAsync` allocator-cache
 * form (§34) — where "nobody is holding it" reads as a dead end and the user never
 * learns that `POST /free` is still the fix and that a second attempt a few seconds
 * later clears the Windows `OSError 1455` spawn failure.
 *
 * @param report - what the gate just observed.
 * @returns the multi-line error text.
 */
function vramGateMessage(report: VramGateReport): string {
  const port = report.comfyPort ?? 8188
  const lines: string[] = [
    'local backend: 显存余量不足，拒绝拉起 worker（启动前门禁）。硬起会以 0xC0000005 崩在加载阶段，这道检查就是为了不让你看到那个退出码。',
    `  空闲 ${report.freeMiB ?? '?'} MiB / ${report.totalMiB ?? '?'} MiB，需要至少 ${report.requiredMiB} MiB；还差 ${report.shortfallMiB ?? '?'} MiB。`,
  ]
  const comfyHolds = report.holders.some((holder) => holder.comfyui)
  if (report.holders.length > 0) {
    lines.push('  占着显存的进程（nvidia-smi 报出来的）：')
    for (const holder of report.holders) {
      lines.push(
        `    • pid ${holder.pid} ${holder.name || 'unknown'}` +
          `${holder.usedMiB === null ? '' : `，约 ${holder.usedMiB} MiB`}` +
          `${holder.comfyui ? `（ComfyUI，监听 127.0.0.1:${port}）` : ''}`,
      )
    }
    lines.push(
      comfyHolds
        ? `  占用者里有 ComfyUI：先执行下面那条 /free 命令让它把模型交出来，这是本次最直接的补救。`
        : '  这些占用者不是 ComfyUI：先看它们是谁（本插件自己的 worker 常驻约 4.5 GiB，用 `qwen_image_env` 的 action:"unload" 回收）。',
    )
  } else {
    // §34: the free number is right, the holder list is empty, and the start still dies.
    lines.push(
      '  nvidia-smi 没有报出任何占用者（`--query-compute-apps` 一个计算进程都没有）——**这不等于没人占着**：' +
        'ComfyUI 跑完会把约 3.6 GiB 的 `cudaMallocAsync` 分配器缓存留在自己的进程里，而这一列看不到它，' +
        '于是出现「看起来没有占用者，但显存就是不够」，本地 worker 加载即死。',
    )
    lines.push('  这种情况下的补救顺序：')
    lines.push(`    ① 仍然先发 POST /free（ComfyUI 还在的话它就是把缓存交出来的那条路）：${comfyFreeCommand(port)}`)
    lines.push('    ② 然后**隔十几秒再重试**：背靠背启动 python 会撞 Windows `OSError 1455 页面文件太小`（host commit 压力），那是进程创建失败，与你的配置和权重都无关。')
    lines.push('    ③ 8 GB 卡上把 `freeComfyBeforeLocalStart` 设为 true 一般是**必需项**而不是可选优化——它就是替你走第①步。')
  }
  if (report.freedComfy !== null) {
    lines.push(
      report.freedComfy.ok
        ? `  已按 freeComfyBeforeLocalStart 请求 ComfyUI 释放：POST ${report.freedComfy.url} → HTTP ${report.freedComfy.httpStatus}；释放后仍不足，所以这次没有启动。`
        : `  已按 freeComfyBeforeLocalStart 尝试请求 ComfyUI 释放，但没成功：${report.freedComfy.note ?? `HTTP ${report.freedComfy.httpStatus}`}。`,
    )
  }
  if (report.holders.length > 0) {
    lines.push('  补救（ComfyUI 官方卸载端点，执行后立刻生效）：')
    lines.push(`    ${comfyFreeCommand(port)}`)
  }
  lines.push(
    '  执行完重试本次调用。若占用者其实是本插件自己的 worker（常驻约 4.5 GiB），改用 `qwen_image_env` 的 action:"unload" 回收。',
  )
  lines.push(
    '  想让插件每次启动 worker 前自己执行上面那条命令：配置 `freeComfyBeforeLocalStart: true`（默认 false，插件默认不动别人的模型）。关掉这道门禁：`minFreeVramMiB: 0`。',
  )
  lines.push('  为什么拦：worker 加载先要一次性拿约 4.5 GiB 给 transformer；拿不到时 CUDA 会让进程以访问违例退出，而不是给一条 OOM。')
  return lines.join('\n')
}

/** The lifecycle owner for one plugin instance. */
export class WorkerRuntime {
  private readonly settings: WorkerRuntimeSettings
  private child: ChildProcess | null = null
  private childPid: number | null = null
  private exit: { code: number | null; signal: string | null } | null = null
  private activePort: number
  private activeEndpoint: string
  private activeOurs = false
  private activeManaged = false
  private logPath: string | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private lastActivity = Date.now()
  private unloaded = false
  private starting: Promise<WorkerHandle> | null = null
  /** Last failed start, so a retry storm (two calls in a row) does not spawn twice. */
  private lastStartFailure: { at: number; message: string } | null = null
  /** Newest first; `status` reports it and tests assert on it. */
  readonly events: LifecycleEvent[] = []
  /** What the last pre-start gate saw, so the tool result can report it truthfully. */
  private lastVramGate: VramGateReport | null = null

  constructor(settings: WorkerRuntimeSettings) {
    this.settings = settings
    this.activePort = portOf(settings.endpoint) ?? settings.ports[0] ?? 8399
    this.activeEndpoint = `http://127.0.0.1:${this.activePort}`
  }

  /** Endpoint callers must use right now. */
  get endpoint(): string {
    return this.activeEndpoint
  }

  /** Port the runtime believes the worker is on. */
  get port(): number {
    return this.activePort
  }

  /** Pid of the process this instance spawned, when it still runs. */
  get pid(): number | null {
    return this.child !== null && this.exit === null ? this.childPid : null
  }

  /** True when this instance owns (and may kill) the worker process. */
  get ownsProcess(): boolean {
    return this.activeManaged
  }

  /** Last failed start attempt, for `status` to explain "why is it not up". */
  get lastStartFailureAt(): { at: number; message: string } | null {
    return this.lastStartFailure
  }

  /** The last pre-start VRAM gate outcome, or null when the gate never ran. */
  get vramGate(): VramGateReport | null {
    return this.lastVramGate
  }

  /** True when this runtime watched a worker exit (external kill or crash). */
  get sawWorkerExit(): boolean {
    return this.events.some((event) => event.event === 'exit' || event.event === 'died' || event.event === 'invalidate')
  }

  private record(event: string, detail?: string): void {
    this.events.unshift({ at: new Date().toISOString(), event, detail })
    if (this.events.length > 30) this.events.pop()
  }

  /**
   * Probe an endpoint without changing anything.
   *
   * `/state` is tried first because it answers while the model is still loading;
   * `/health` is the frozen contract and is used both as a fallback for workers
   * that predate `/state` and to learn whether the model is actually ready.
   */
  async inspect(endpoint = this.activeEndpoint, timeoutMs = 1500, signal?: AbortSignal): Promise<WorkerProbe> {
    const state = await getJson(`${endpoint}/state`, timeoutMs, signal)
    const stateBody = (state.body ?? {}) as WorkerStateBody
    if (state.ok && (typeof stateBody.pid === 'number' || stateBody.service !== undefined)) {
      const health = await getJson(`${endpoint}/health`, timeoutMs, signal)
      return {
        endpoint,
        reachable: true,
        ready: health.ok || stateBody.ready === true,
        ours: stateBody.service === SERVICE,
        state: stateBody,
        healthStatus: health.status,
      }
    }
    const health = await getJson(`${endpoint}/health`, timeoutMs, signal)
    if (health.ok) {
      return {
        endpoint,
        reachable: true,
        ready: true,
        ours: false,
        healthStatus: health.status,
        note: 'endpoint answers the frozen /health contract but reports no service signature; adopting it as a foreign worker',
      }
    }
    return {
      endpoint,
      reachable: false,
      ready: false,
      ours: false,
      healthStatus: health.status,
      note:
        health.status > 0
          ? `${endpoint} answers HTTP ${health.status} on /health, which is not a worker (the contract wants 2xx); treating the port as taken`
          : (state.note ?? health.note ?? 'connection refused'),
    }
  }

  /** Last lines of the worker log, for error messages and `status`. */
  logTail(maxLines = 25): string {
    return this.logPath === null ? '' : readLogTail(this.logPath, 65_536, maxLines)
  }

  /** Where the worker's stdout/stderr go. */
  get logFile(): string | null {
    return this.logPath
  }

  /** Note that the worker just did real work, so idle unload restarts its clock. */
  noteActivity(): void {
    this.lastActivity = Date.now()
    this.unloaded = false
  }

  /**
   * Arm the idle-unload timer.
   *
   * The timer is unref'd: a plugin that is otherwise done must not be kept alive
   * by a housekeeping timer.
   */
  armIdleUnload(): void {
    if (this.settings.idleUnloadMs <= 0) return
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      void this.unloadIfIdle()
    }, this.settings.idleUnloadMs)
    this.idleTimer.unref?.()
  }

  /** Unload only if nothing has happened for the whole idle window. */
  async unloadIfIdle(): Promise<boolean> {
    if (Date.now() - this.lastActivity < this.settings.idleUnloadMs) {
      this.armIdleUnload()
      return false
    }
    const result = await this.unload()
    return result.ok === true
  }

  /**
   * Refuse to start the worker when the card has no room for it.
   *
   * A worker that cannot allocate its transformer does not raise a clean OOM on
   * this host: it exits as `0xC0000005`, which tells the user nothing. Reading the
   * GPU *before* the spawn is what turns that into "ComfyUI holds 7.4 GiB, run
   * this command".
   *
   * @param signal - caller cancellation.
   * @returns what the gate saw; throws with the remedy when it refuses.
   */
  private async gateVram(signal?: AbortSignal): Promise<VramGateReport> {
    const gate = this.settings.vramGate
    if (gate === undefined || gate.requiredMiB <= 0) {
      this.lastVramGate = {
        allowed: true,
        ran: false,
        freeMiB: null,
        totalMiB: null,
        requiredMiB: gate?.requiredMiB ?? 0,
        shortfallMiB: null,
        holders: [],
        comfyPort: null,
        freedComfy: null,
        warning: null,
      }
      return this.lastVramGate
    }
    const probe = this.settings.probeVram ?? defaultVramProbe
    let facts = await probe(gate)
    let advisory = adviseFrom(facts, gate)
    let freedComfy: FreeComfyResult | null = null
    if (!advisory.start_gate.allowed && gate.freeComfyFirst) {
      // Explicit opt-in only. Unloading another program's models is a side effect
      // this plugin does not take on its own. Aim at the port that actually answered —
      // otherwise the opt-in would silently post `/free` into a closed port.
      freedComfy = await freeComfyMemory(facts.comfyPort ?? gate.comfyPort)
      this.record('comfy-free', `${freedComfy.url} HTTP ${freedComfy.httpStatus}`)
      // The models unload at once, but the driver is not obliged to have the
      // bytes back in the same millisecond; read again after a short beat.
      await delay(2000, signal).catch(() => undefined)
      facts = await probe(gate)
      advisory = adviseFrom(facts, gate)
    }
    const report: VramGateReport = {
      allowed: advisory.start_gate.allowed,
      ran: true,
      freeMiB: advisory.freeMiB,
      totalMiB: advisory.totalMiB,
      requiredMiB: advisory.requiredMiB,
      shortfallMiB: advisory.start_gate.shortfallMiB,
      holders: advisory.holders,
      comfyPort: facts.comfyPort ?? gate.comfyPort,
      freedComfy,
      // A holder is worth reporting even when the floor was met: the floor only
      // covers the load-time allocation, and the load is where a resident ComfyUI
      // takes the worker down.
      warning: vramSuspicionWarning(advisory, facts.comfyPort ?? gate.comfyPort),
    }
    this.lastVramGate = report
    this.record('vram-gate', `free=${report.freeMiB ?? '?'} need=${report.requiredMiB} allowed=${report.allowed}`)
    if (!report.allowed) throw new Error(vramGateMessage(report))
    return report
  }

  /**
   * The live VRAM facts as error-message lines, never throwing.
   *
   * The crash path needs numbers *now*, and a probe that cannot run has to degrade
   * to a one-line note instead of replacing the real error with its own.
   *
   * @returns lines to append to the error, or an empty array when the gate is off
   *   and there is nothing useful to say.
   */
  private async describeVram(): Promise<string[]> {
    const gate = this.settings.vramGate
    const probe = this.settings.probeVram ?? defaultVramProbe
    const settings: VramGateSettings = gate ?? {
      requiredMiB: 0,
      comfyPort: 8188,
      freeComfyFirst: false,
      scratchDir: join(this.settings.dataDir, 'logs'),
    }
    try {
      const facts = await probe(settings)
      const lines = [
        `当前显存：空闲 ${facts.freeMiB ?? '?'} MiB / ${facts.totalMiB ?? '?'} MiB` +
          (gate !== undefined && gate.requiredMiB > 0 ? `（启动前门禁的阈值是 ${gate.requiredMiB} MiB）` : ''),
      ]
      lines.push(
        facts.processes.length > 0
          ? `占用者：${facts.processes
              .map(
                (holder) =>
                  `pid ${holder.pid} ${holder.name || 'unknown'}${holder.usedMiB === null ? '' : ` ${holder.usedMiB} MiB`}`,
              )
              .join('、')}`
          : '占用者：nvidia-smi 没有报出计算进程（这不等于没人占着：ComfyUI 留下的约 3.6 GiB ' +
            '`cudaMallocAsync` 分配器缓存就不在这一列里）。',
      )
      lines.push(`补救（若占用者是 ComfyUI）：${comfyFreeCommand(facts.comfyPort ?? settings.comfyPort)}`)
      if (this.lastVramGate?.ran === true) {
        lines.push(
          `启动前门禁当时看到空闲 ${this.lastVramGate.freeMiB ?? '?'} MiB 并放行；加载期间显存又被别人拿走，或峰值超出了当时的余量。`,
        )
      }
      return lines
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return [`显存探测失败（${reason}），无法点名占用者；先手工跑一次 \`nvidia-smi\` 看是谁占着。`]
    }
  }

  /**
   * Make sure a worker is up and ready, starting one if needed.
   *
   * @param signal - caller cancellation; also bounds the readiness wait.
   * @returns the handle the generate path must use.
   */
  async ensure(signal?: AbortSignal): Promise<WorkerHandle> {
    if (this.starting !== null) return this.starting
    // The gate report belongs to one ensure() call: an adopted worker never runs
    // the gate, and a result must not carry the previous call's refusal.
    this.lastVramGate = null
    this.starting = this.ensureInner(signal)
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  private async ensureInner(signal?: AbortSignal): Promise<WorkerHandle> {
    // 1. A worker we already own, still alive and answering.
    if (this.child !== null && this.exit === null) {
      const probe = await this.inspect(this.activeEndpoint, 1500, signal)
      if (probe.reachable) return this.handle(probe, { started: false, adopted: false })
    }
    // 2. Any worker on the endpoint, ours or somebody else's, gets adopted.
    const existing = await this.inspect(this.activeEndpoint, 1500, signal)
    if (existing.reachable) {
      this.activeManaged = this.child !== null && this.exit === null
      this.activeOurs = existing.ours
      this.record('adopted', `${existing.endpoint} ready=${existing.ready}`)
      return this.handle(existing, { started: false, adopted: true })
    }
    if (!this.settings.manage) {
      throw new Error(
        `local backend: no worker at ${this.activeEndpoint} and worker management is off (config \`manageWorker: false\`). ` +
          'Start the worker yourself, or set `manageWorker: true` to let the plugin own it.',
      )
    }
    // Back off after a failed start instead of spawning on every call: the user
    // sees the previous failure (already actionable) rather than a process storm.
    if (this.lastStartFailure !== null && Date.now() - this.lastStartFailure.at < RESTART_COOLDOWN_MS) {
      const waitMs = RESTART_COOLDOWN_MS - (Date.now() - this.lastStartFailure.at)
      throw new Error(
        `local backend: the worker is not running, and its last start attempt failed ${Math.round((Date.now() - this.lastStartFailure.at) / 1000)}s ago:\n` +
          `  ${this.lastStartFailure.message}\n` +
          `  Not retrying for another ${(waitMs / 1000).toFixed(1)}s; the details above are from the attempt that just happened.`,
      )
    }
    // 3. Start one, on a port nothing else has taken.
    if (executableMissing(this.settings.interpreter)) {
      throw new Error(
        `local backend: no worker at ${this.activeEndpoint}, and the plugin cannot start one — the interpreter does not exist:\n` +
          `  ${this.settings.interpreter}\n` +
          '  Run `qwen_image_env` with `action:"install"` (add `dryRun:true` to see the plan first) to create the venv and install torch.',
      )
    }
    if (executableMissing(this.settings.script)) {
      throw new Error(`local backend: the shipped worker script is missing: ${this.settings.script}`)
    }
    // Before anything is spawned: is there room on the card? A worker that cannot
    // allocate its transformer dies as 0xC0000005, so refusing here is the only
    // place this can be explained. Throws with the remedy when the answer is no.
    await this.gateVram(signal)
    const port = await this.pickPort(signal)
    return this.startOnPort(port, signal)
  }

  /**
   * Start the worker, walking the candidate ports when one cannot be bound.
   *
   * A port that answers a probe can still refuse the bind a moment later (the
   * OS may hand it to somebody else, or exclude it), and the child then dies
   * immediately with `EADDRINUSE`/`EACCES`. That is a port problem, not a worker
   * problem: move to the next candidate instead of failing the tool call.
   */
  private async startOnPort(preferred: number, signal?: AbortSignal): Promise<WorkerHandle> {
    const candidates = [preferred, ...this.settings.ports].filter((port, index, all) => all.indexOf(port) === index)
    const failures: string[] = []
    for (const port of candidates) {
      if (port !== preferred && (await isPortBusy(port))) continue
      this.activePort = port
      this.activeEndpoint = `http://127.0.0.1:${port}`
      try {
        return await this.spawnWorker(port, signal)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/EADDRINUSE|EACCES|address already in use|only one usage of each socket address/i.test(message)) throw error
        failures.push(`${port}: could not be bound`)
        this.record('bind-failed', `port ${port}`)
        await this.invalidate(`port ${port} could not be bound`)
      }
    }
    throw new Error(
      `local backend: no candidate port could be bound (${failures.join('; ') || candidates.join(', ')}). ` +
        'Free one of them, or widen `workerPorts` in the plugin config.',
    )
  }

  /** Choose a port: the preferred one when free, else the first free candidate. */
  private async pickPort(signal?: AbortSignal): Promise<number> {
    const candidates = [this.activePort, ...this.settings.ports].filter(
      (port, index, all) => all.indexOf(port) === index,
    )
    for (const port of candidates) {
      if (!(await isPortBusy(port))) return port
      const probe = await this.inspect(`http://127.0.0.1:${port}`, 800, signal)
      if (probe.reachable) return port
    }
    throw new Error(
      `local backend: every candidate worker port is taken (${candidates.join(', ')}). ` +
        'Free one of them, or widen `workerPorts` in the plugin config.',
    )
  }

  /** Spawn the worker and wait for it to report ready. */
  private async spawnWorker(port: number, signal?: AbortSignal): Promise<WorkerHandle> {
    const startedAt = Date.now()
    const logsDir = join(this.settings.dataDir, 'logs')
    // The log is the error channel, so a failure to open it is fatal *and* named.
    let log: { fd: number; path: string; note?: string }
    try {
      log = await openLogFile(logsDir, `worker-${port}.log`)
    } catch (error) {
      throw new Error(
        `local backend: cannot write the worker log (${error instanceof Error ? error.message : String(error)}). ` +
          `Point \`runtimeDir\` at a writable directory.`,
      )
    }
    this.logPath = log.path
    const args = [
      this.settings.script,
      '--port',
      String(port),
      '--models-dir',
      this.settings.modelsDir,
      '--data-dir',
      this.settings.dataDir,
    ]
    let child: ChildProcess
    const fd = log.fd
    try {
      child = spawn(this.settings.interpreter, args, {
        // fd, not 'pipe': pipes are denied by this host's sandbox and would die
        // with the parent, losing exactly the log we need for diagnosis.
        stdio: ['ignore', fd, fd],
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8',
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
        },
      })
    } catch (error) {
      closeSync(fd)
      throw new Error(
        `local backend: could not start the worker process (${error instanceof Error ? error.message : String(error)}). ` +
          `Interpreter: ${this.settings.interpreter}`,
      )
    }
    closeSync(fd)
    if (log.note !== undefined) this.record('log-fallback', log.note)
    this.child = child
    this.childPid = child.pid ?? null
    this.exit = null
    this.activeManaged = true
    this.activeOurs = true
    this.record('spawn', `pid=${child.pid ?? '?'} port=${port} log=${this.logPath}`)
    // Child state is per-child: an `exit` from a *previous* worker must never be
    // mistaken for this one's death (it arrives late, after the new child is
    // already up, and a shared flag would declare a healthy worker dead).
    let exited: { code: number | null; signal: string | null } | null = null
    let spawnFailure: Error | null = null
    child.once('error', (error: NodeJS.ErrnoException) => {
      spawnFailure = new Error(
        `local backend: the worker process could not be started (${error.code ?? ''} ${error.message}).\n` +
          `  Interpreter: ${this.settings.interpreter}\n  Script: ${this.settings.script}`,
      )
    })
    child.once('exit', (code, signalName) => {
      exited = { code, signal: signalName }
      if (this.child !== child) return
      this.exit = { code, signal: signalName }
      this.record('exit', `code=${code ?? 'null'} signal=${signalName ?? 'null'}`)
    })

    const deadline = Date.now() + this.settings.startTimeoutMs
    let lastProbe: WorkerProbe | null = null
    while (Date.now() < deadline) {
      if (spawnFailure !== null) throw spawnFailure
      if (exited !== null) break
      // A loading python holds the GIL, so /state can answer slowly during a cold
      // start; a 1.5 s budget here would abort the request and make the worker log
      // a broken-pipe banner instead of a useful line.
      const probe = await this.inspect(this.activeEndpoint, 10_000, signal)
      lastProbe = probe
      if (probe.reachable && probe.ready) {
        this.noteActivity()
        this.lastStartFailure = null
        const handle = this.handle(probe, { started: true, adopted: false })
        this.record('ready', `pid=${handle.pid ?? '?'} in ${Date.now() - startedAt} ms`)
        this.armIdleUnload()
        return { ...handle, startMs: Date.now() - startedAt }
      }
      await delay(400, signal)
    }
    const tail = this.logTail()
    if (exited !== null) {
      const explanation = explainWorkerExit(exited.code, exited.signal, tail)
      const detail = `exit code ${exited.code ?? 'null'}${exited.signal === null ? '' : ` signal ${exited.signal}`}`
      this.record('died', detail)
      const bindFailure = /EADDRINUSE|EACCES|address already in use|only one usage of each socket address/i.test(tail)
      // A bare exit code is the whole complaint the user would otherwise get, so the
      // message carries a cause and the live VRAM numbers it is based on.
      const vram = await this.describeVram()
      this.rememberStartFailure(`${this.activeEndpoint}: ${explanation.headline}`)
      throw new Error(
        `local backend: the worker process died while starting (${explanation.headline}${bindFailure ? ', port not bindable' : ''}).\n` +
          explanation.hints.map((hint) => `  ${hint}`).join('\n') +
          (vram.length === 0 ? '' : `\n${vram.map((line) => `  ${line}`).join('\n')}`) +
          `\n  Log: ${this.logPath}\n` +
          (tail.length > 0 ? `  Last output:\n${tail.split('\n').map((line) => `    ${line}`).join('\n')}` : '  (no output)'),
      )
    }
    if (lastProbe !== null && lastProbe.reachable && lastProbe.state?.load_error) {
      const error = lastProbe.state.load_error
      this.record('load-failed', error)
      this.rememberStartFailure(`model load failed: ${error}`)
      throw new Error(
        `local backend: the worker is up but the model failed to load: ${error}\n` +
          `  Log: ${this.logPath}\n` +
          (tail.length > 0 ? `  Last output:\n${tail.split('\n').map((line) => `    ${line}`).join('\n')}` : '  (no output)'),
      )
    }
    this.record('timeout', `${this.settings.startTimeoutMs} ms`)
    this.rememberStartFailure(`not ready within ${this.settings.startTimeoutMs} ms`)
    throw new Error(
      `local backend: the worker did not become ready within ${Math.round(this.settings.startTimeoutMs / 1000)}s.\n` +
        `  Endpoint: ${this.activeEndpoint}\n  Log: ${this.logPath}\n` +
        (tail.length > 0 ? `  Last output:\n${tail.split('\n').map((line) => `    ${line}`).join('\n')}` : '  (no output)'),
    )
  }

  /** Remember that a start attempt failed, so `ensure()` can back off. */
  private rememberStartFailure(message: string): void {
    this.lastStartFailure = { at: Date.now(), message }
  }

  /** Shape one probe into a handle. */
  private handle(probe: WorkerProbe, extra: { started: boolean; adopted: boolean }): WorkerHandle {
    return {
      endpoint: probe.endpoint,
      port: portOf(probe.endpoint) ?? this.activePort,
      pid: typeof probe.state?.pid === 'number' ? probe.state.pid : this.pid,
      started: extra.started,
      adopted: extra.adopted,
      managed: this.activeManaged,
      ours: probe.ours,
      startMs: 0,
      state: probe.state ?? null,
    }
  }

  /**
   * Forget a worker that stopped answering, killing it when we own it.
   *
   * This is the "it died on us" path: the next `ensure()` starts a fresh one.
   */
  async invalidate(reason: string): Promise<void> {
    this.record('invalidate', reason)
    if (this.child !== null && this.exit === null) await this.kill()
    this.child = null
    this.childPid = null
    this.exit = null
    this.activeManaged = false
    this.activeOurs = false
  }

  /**
   * Ask the worker to exit by itself (`POST /shutdown`).
   *
   * This is the primary stop path, not a nicety: on Windows the venv's
   * `python.exe` is a *redirector*, so the pid the plugin spawned is not the
   * interpreter that holds the model. Killing the redirector would orphan the
   * real process with its ~4.5 GiB of VRAM. Asking the worker to leave removes
   * the guesswork.
   *
   * @returns true when the worker answered the request.
   */
  async requestShutdown(timeoutMs = 10_000): Promise<boolean> {
    const probe = await this.inspect(this.activeEndpoint, 1500)
    if (!probe.reachable || !probe.ours) return false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    try {
      const response = await fetch(`${this.activeEndpoint}/shutdown`, { method: 'POST', signal: controller.signal })
      this.record('shutdown', `HTTP ${response.status}`)
      return response.ok
    } catch (error) {
      this.record('shutdown-failed', error instanceof Error ? error.message : String(error))
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /** Stop the process this runtime started. */
  async stop(timeoutMs = 5000): Promise<Record<string, unknown>> {
    if (this.child === null || this.exit !== null) {
      this.child = null
      return { stopped: false, reason: 'no running worker owned by this plugin instance' }
    }
    const pid = this.childPid
    // Graceful first (it also frees VRAM and stops the *real* interpreter), then
    // the process-tree fallback.
    const graceful = await this.requestShutdown()
    const observedExit = await this.kill(graceful ? timeoutMs : timeoutMs)
    this.child = null
    this.childPid = null
    this.activeManaged = false
    this.record('stopped', `pid=${pid ?? '?'} graceful=${graceful} exit_observed=${observedExit}`)
    return {
      stopped: observedExit,
      pid,
      graceful,
      reason: observedExit ? null : 'the process did not exit within the grace period',
    }
  }

  /**
   * Send SIGTERM, then SIGKILL if the process is still there.
   *
   * @returns true only when the child's `exit` event was actually observed, so a
   *   caller never reports a kill that did not happen.
   */
  private async kill(timeoutMs = 5000): Promise<boolean> {
    const child = this.child
    if (child === null) return true
    if (this.exit !== null) return true
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    try {
      child.kill()
    } catch {
      return false
    }
    const settled = await Promise.race([
      exited.then(() => true),
      delay(timeoutMs).then(() => false).catch(() => true),
    ])
    if (!settled) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      return await Promise.race([exited.then(() => true), delay(2000).then(() => false)]).catch(() => false)
    }
    return true
  }

  /**
   * Ask the worker to release VRAM (`POST /unload`).
   *
   * A worker that is already gone is not an error — the caller asked for the
   * memory back, and it is back.
   */
  async unload(timeoutMs = 60_000): Promise<Record<string, unknown>> {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const endpoint = this.activeEndpoint
    const pid = this.child !== null && this.exit === null ? this.childPid : null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    try {
      const response = await fetch(`${endpoint}/unload`, { method: 'POST', signal: controller.signal })
      const text = await response.text()
      let body: unknown = text
      try {
        body = JSON.parse(text)
      } catch {
        /* keep the raw text */
      }
      this.unloaded = true
      this.record('unload', `HTTP ${response.status}`)
      return { ok: response.ok, endpoint, http_status: response.status, pid, body }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.record('unload-failed', reason)
      const gone = this.child !== null && this.exit !== null
      return {
        ok: false,
        endpoint,
        note: gone
          ? `the worker process had already exited (${reason}); its VRAM is already released`
          : `could not reach ${endpoint}/unload: ${reason}`,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Resolve whether the interpreter and weights look usable, without starting anything. */
  async preflight(): Promise<{ interpreter: boolean; script: boolean; modelsDir: boolean; portBusy: boolean }> {
    const [interpreter, script, models] = await Promise.all([
      stat(this.settings.interpreter).then(
        () => true,
        () => false,
      ),
      stat(this.settings.script).then(
        () => true,
        () => false,
      ),
      stat(join(this.settings.modelsDir, 'model_index.json')).then(
        () => true,
        () => false,
      ),
    ])
    return { interpreter, script, modelsDir: models, portBusy: await isPortBusy(this.activePort) }
  }
}
