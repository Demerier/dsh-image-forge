/**
 * Machine and backend probes for `qwen_image_env status`.
 *
 * Everything here is read-only and reports facts it actually obtained: a probe
 * that cannot run says why (`note`) instead of guessing a number. The local
 * inference worker is this plugin's own component now, so beyond "does the
 * endpoint answer" this module also explains *why* the GPU may not have room —
 * most often a resident ComfyUI, which must be told to let go.
 */
import { statfs } from 'node:fs/promises'
import { totalmem, freemem, cpus, platform, arch, release } from 'node:os'
import { runCaptured } from './procx.ts'

/** A probe outcome that either carries data or explains why it has none. */
export interface ProbeResult {
  /** True when the probe produced usable data. */
  readonly ok: boolean
  /** Why the probe has no data; absent when `ok` is true. */
  readonly note?: string
  /** Probe payload. */
  readonly data?: Record<string, unknown>
}

/**
 * Run one command with a hard timeout, never through a shell.
 *
 * Output is captured through a file descriptor rather than a pipe: this host's
 * sandbox denies pipe-backed spawns, which would silently degrade every GPU
 * probe to "unavailable".
 */
async function run(
  file: string,
  args: string[],
  timeoutMs: number,
  scratchDir?: string,
): Promise<{ ok: boolean; stdout: string; note?: string }> {
  const result = await runCaptured(file, args, { timeoutMs, scratchDir, label: 'probe', maxOutputBytes: 262_144 })
  if (!result.ok) {
    const note =
      result.code === null && result.note !== undefined
        ? result.note.includes('ENOENT')
          ? `${file} not found on PATH`
          : result.note
        : result.output.trim().length > 0
          ? result.output.slice(-300)
          : `${file} exited ${result.code ?? 'null'}`
    return { ok: false, stdout: result.output, note }
  }
  return { ok: true, stdout: result.output }
}

/** One compute process holding VRAM, as `nvidia-smi` reports it. */
export interface GpuProcess {
  readonly pid: number
  readonly usedMiB: number | null
  readonly name: string
}

/**
 * Probe the GPU through `nvidia-smi`.
 *
 * @param timeoutMs - command budget; the tool call should not stall on a hung
 *   driver query.
 * @param scratchDir - where the command's throwaway log goes.
 * @returns per-GPU name, total and used VRAM, or the reason there is none.
 */
export async function probeGpu(timeoutMs = 5000, scratchDir?: string): Promise<ProbeResult> {
  const result = await run(
    'nvidia-smi',
    ['--query-gpu=index,name,memory.total,memory.used,driver_version', '--format=csv,noheader,nounits'],
    timeoutMs,
    scratchDir,
  )
  if (!result.ok) return { ok: false, note: result.note }
  const gpus = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [index, name, totalMiB, usedMiB, driver] = line.split(',').map((part) => part.trim())
      return {
        index: Number(index),
        name,
        vramTotalMiB: Number(totalMiB),
        vramUsedMiB: Number(usedMiB),
        vramFreeMiB: Number(totalMiB) - Number(usedMiB),
        driver,
      }
    })
  if (gpus.length === 0) return { ok: false, note: 'nvidia-smi reported no GPU' }
  return { ok: true, data: { count: gpus.length, gpus } }
}

/**
 * List the processes holding VRAM.
 *
 * @param timeoutMs - command budget.
 * @param scratchDir - where the command's throwaway log goes.
 * @returns pid, used MiB and executable name per compute process.
 */
export async function probeGpuProcesses(timeoutMs = 5000, scratchDir?: string): Promise<ProbeResult> {
  const result = await run(
    'nvidia-smi',
    ['--query-compute-apps=pid,used_memory,process_name', '--format=csv,noheader,nounits'],
    timeoutMs,
    scratchDir,
  )
  if (!result.ok) return { ok: false, note: result.note }
  const processes: GpuProcess[] = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [pid, used, ...rest] = line.split(',').map((part) => part.trim())
      const usedMiB = Number(used)
      return { pid: Number(pid), usedMiB: Number.isFinite(usedMiB) ? usedMiB : null, name: rest.join(',') }
    })
    .filter((entry) => Number.isFinite(entry.pid))
  return { ok: true, data: { count: processes.length, processes } }
}

/**
 * Resolve which process is listening on a loopback port.
 *
 * Windows' `netstat -ano` is the only local way to link a port back to a pid,
 * and that link is what turns "some python holds 2.9 GiB" into "ComfyUI holds
 * 2.9 GiB, tell it to free memory".
 *
 * @param port - port to look up.
 * @param timeoutMs - command budget.
 * @param scratchDir - where the command's throwaway log goes.
 * @returns the pid, or undefined when it cannot be determined.
 */
export async function resolveListenerPid(port: number, timeoutMs = 5000, scratchDir?: string): Promise<number | undefined> {
  const result = await run('netstat', ['-ano', '-p', 'tcp'], timeoutMs, scratchDir)
  if (!result.ok) return undefined
  for (const line of result.stdout.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 5 || fields[0].toUpperCase() !== 'TCP') continue
    if (!fields[1].endsWith(`:${port}`) || !/LISTEN/i.test(fields[3])) continue
    const pid = Number(fields[4])
    if (Number.isInteger(pid) && pid > 0) return pid
  }
  return undefined
}

/**
 * The one command that makes ComfyUI hand its VRAM back.
 *
 * ComfyUI ships this endpoint and it is the only supported way to unload its
 * models from outside. It lives in one place so the `status` advisory, the
 * pre-start gate and the crash diagnosis cannot drift apart.
 *
 * @param port - the port ComfyUI answers on.
 * @returns a copy-pasteable `curl` invocation.
 */
export function comfyFreeCommand(port: number): string {
  return (
    `curl -X POST http://127.0.0.1:${port}/free -H "Content-Type: application/json" ` +
    '-d "{\\"unload_models\\":true,\\"free_memory\\":true}"'
  )
}

/** What ComfyUI answered to `POST /free`. */
export interface FreeComfyResult {
  /** ComfyUI accepted the request (2xx). */
  readonly ok: boolean
  /** Endpoint that was called. */
  readonly url: string
  /** HTTP status, or 0 when the request never completed. */
  readonly httpStatus: number
  /** Response body, truncated. */
  readonly body: string
  /** Transport failure, when there was one. */
  readonly note?: string
}

/**
 * Ask ComfyUI to unload its models and free memory (`POST /free`).
 *
 * This unloads *another program's* models, so it is only ever called after the
 * user opted in (`freeComfyBeforeLocalStart`); the default path reports the
 * command instead of running it.
 *
 * @param port - the port ComfyUI answers on.
 * @param timeoutMs - request budget.
 * @returns what ComfyUI said, or why it could not be asked.
 */
export async function freeComfyMemory(port: number, timeoutMs = 15_000): Promise<FreeComfyResult> {
  const url = `http://127.0.0.1:${port}/free`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: controller.signal,
    })
    let body = ''
    try {
      body = (await response.text()).trim().slice(0, 300)
    } catch {
      body = ''
    }
    return { ok: response.ok, url, httpStatus: response.status, body }
  } catch (error) {
    return { ok: false, url, httpStatus: 0, body: '', note: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** The VRAM verdict that `status` turns into warnings and one next action. */
export interface VramAdvisory {
  /** Free VRAM on the first GPU at probe time, in MiB. */
  readonly freeMiB: number | null
  /** Total VRAM on the first GPU, in MiB. */
  readonly totalMiB: number | null
  /** Below the configured floor, so a 2K generation is expected to OOM. */
  readonly warn: boolean
  /** The floor that was compared against. */
  readonly requiredMiB: number
  /** Processes holding VRAM, with the ComfyUI listener identified when possible. */
  readonly holders: (GpuProcess & { readonly comfyui: boolean })[]
  /** Actions that would actually free memory, in order. */
  readonly suggestions: string[]
  /**
   * What the pre-start gate would decide right now.
   *
   * The worker refuses to start below `requiredMiB` free VRAM: a CUDA allocation
   * failure during model load exits the process as an access violation
   * (`0xC0000005`) instead of a clean OOM, so the failure never explains itself.
   */
  readonly start_gate: {
    /** Free VRAM is at or above the floor, or could not be read at all. */
    readonly allowed: boolean
    /** MiB that still has to be released; null when the gate would allow a start. */
    readonly shortfallMiB: number | null
    /** The command that would release it, when ComfyUI is the one holding on. */
    readonly remedy: string | null
    /**
     * The floor is missed and yet **no process was reported** holding VRAM.
     *
     * That combination is its own failure mode rather than a missing probe: a
     * ComfyUI that has run a job keeps ~3.6 GiB of `cudaMallocAsync` allocator
     * cache inside its own process while `nvidia-smi --query-compute-apps` lists
     * no compute process at all (the 显存陷阱 in `docs/configuration.md`, dev plan
     * §34), so the free number is right, the holder list is empty, and a hard start
     * still dies during load.
     */
    readonly no_visible_holder: boolean
  }
}

/**
 * Turn the GPU facts into a verdict plus one executable suggestion.
 *
 * @param gpu - `probeGpu` result.
 * @param processes - `probeGpuProcesses` result.
 * @param comfyui - ComfyUI probe result (its `port` links the residency to it).
 * @param requiredMiB - free VRAM below which generation is expected to fail.
 * @param comfyPid - pid found listening on the ComfyUI port, when known.
 * @returns the advisory embedded in the status report.
 */
export function analyseVram(
  gpu: ProbeResult,
  processes: ProbeResult,
  comfyui: Record<string, unknown>,
  requiredMiB: number,
  comfyPid?: number,
): VramAdvisory {
  const gpuList = (gpu.data?.gpus ?? []) as { vramFreeMiB?: number; vramTotalMiB?: number }[]
  const freeMiB = typeof gpuList[0]?.vramFreeMiB === 'number' ? gpuList[0].vramFreeMiB : null
  const totalMiB = typeof gpuList[0]?.vramTotalMiB === 'number' ? gpuList[0].vramTotalMiB : null
  const raw = (processes.data?.processes ?? []) as GpuProcess[]
  const comfyPort = typeof comfyui.port === 'number' ? comfyui.port : undefined
  const holders = raw.map((process) => ({
    ...process,
    comfyui: (comfyPid !== undefined && process.pid === comfyPid) || /comfy/i.test(process.name),
  }))
  const warn = freeMiB !== null && freeMiB < requiredMiB
  const shortfallMiB = warn ? requiredMiB - (freeMiB ?? 0) : null
  const comfyPortNumber = comfyPort ?? 8188
  const comfyLooksInvolved = holders.some((holder) => holder.comfyui) || comfyui.reachable === true
  const start_gate = {
    allowed: shortfallMiB === null,
    shortfallMiB,
    remedy: shortfallMiB === null || !comfyLooksInvolved ? null : comfyFreeCommand(comfyPortNumber),
    no_visible_holder: shortfallMiB !== null && holders.length === 0,
  }
  const suggestions: string[] = []
  if (warn) {
    const comfyHolder = holders.find((holder) => holder.comfyui)
    if (comfyHolder !== undefined) {
      const port = comfyPort ?? 8188
      suggestions.push(
        `显存被 ComfyUI（pid ${comfyHolder.pid}${comfyHolder.usedMiB === null ? '' : `，约 ${comfyHolder.usedMiB} MiB`}）占着；` +
          `先让它放手：${comfyFreeCommand(port)}`,
      )
    }
    const others = holders.filter((holder) => !holder.comfyui)
    if (others.length > 0) {
      suggestions.push(
        `另有进程占着显存：${others.map((holder) => `pid ${holder.pid} (${holder.name || 'unknown'})`).join('、')}。` +
          '其中可能就有本插件的 worker（它常驻约 4.5 GiB）：若是，用 `qwen_image_env action:"unload"` 回收；' +
          '若是 ComfyUI，用它自己的 `POST /free`。',
      )
    }
    if (others.length === 0 && comfyHolder === undefined && comfyui.reachable === true) {
      const port = comfyPort ?? 8188
      suggestions.push(
        `ComfyUI 在 127.0.0.1:${port} 上跑着（它加载了模型会常驻约 2.9 GiB 显存），但这次没能把占用归到它头上；` +
          `先试它的 POST /free：${comfyFreeCommand(port)}`,
      )
    }
    if (holders.length === 0) {
      // The §34 shape: the free number is right, the holder list is empty, and the
      // worker still dies at load. Saying "nobody is holding it" here would be a
      // lie the user acts on, so the two remedies that do work are named instead.
      suggestions.push(
        'nvidia-smi 一个计算进程都没报，但显存就是不够——别把这读成「没人占着」：ComfyUI 跑完会在它自己的进程里留下约 3.6 GiB 的 ' +
          '`cudaMallocAsync` 分配器缓存，而 `nvidia-smi --query-compute-apps` 列不出占用进程' +
          '（见 `docs/configuration.md`「一个会让人卡住的显存陷阱（8 GB 卡必读）」一节）。' +
          `先试 ${comfyFreeCommand(comfyPortNumber)}（ComfyUI 还在就有效）；它已经不在了就只剩等那些分配被释放。` +
          '另外隔十几秒再重跑：背靠背启动 python 会撞 Windows `OSError 1455 页面文件太小`（host commit 压力），那与 worker 无关。' +
          '8 GB 卡上 `freeComfyBeforeLocalStart: true` 一般是必需项，不是可选优化。',
      )
    }
    suggestions.push(
      `本次生成需要约 4.5 GiB 空闲显存（2K 峰值实测 17041 MiB 是关掉 VAE tiling 的数字，本 worker 强制开 tiling）；` +
        `当前空闲 ${freeMiB} MiB，低于阈值 ${requiredMiB} MiB。`,
    )
  }
  return { freeMiB, totalMiB, warn, requiredMiB, holders, suggestions, start_gate }
}

/**
 * What to say when the pre-start gate **allowed** a start anyway.
 *
 * "Allowed" is not "the card was empty": the floor only covers the ~4.5 GiB the
 * transformer allocates at load, so a ComfyUI holding ~2.9 GiB of models — plus the
 * ~3.6 GiB allocator cache it keeps after a job — can leave the gate satisfied and
 * still take the worker down mid-load. The gate therefore reports who was there
 * instead of staying silent, and names the two remedies that actually work.
 *
 * @param advisory - the verdict the gate made.
 * @param comfyPort - the port ComfyUI answers on, for the `/free` command.
 * @returns the warning, or null when the start was refused (the refusal says it) or
 *   when nothing was reported holding VRAM.
 */
export function vramSuspicionWarning(advisory: VramAdvisory, comfyPort: number): string | null {
  if (!advisory.start_gate.allowed || advisory.holders.length === 0) return null
  const list = advisory.holders.map(
    (holder) =>
      `pid ${holder.pid} ${holder.name || 'unknown'}` +
      `${holder.usedMiB === null ? '' : `，约 ${holder.usedMiB} MiB`}` +
      `${holder.comfyui ? `（ComfyUI，监听 127.0.0.1:${comfyPort}）` : ''}`,
  )
  return (
    `本地 worker 启动门禁**放行**了（空闲 ${advisory.freeMiB ?? '?'} MiB ≥ 阈值 ${advisory.requiredMiB} MiB），` +
    `但当时有 ${advisory.holders.length} 个进程占着显存：\n` +
    `  • ${list.join('\n  • ')}\n` +
    '  放行不等于安全：worker 加载要一次性拿约 4.5 GiB，上面这些占用会在那一刻吃掉余量；' +
    'ComfyUI 跑完还会在自己进程里留下约 3.6 GiB 的 `cudaMallocAsync` 分配器缓存，而它列不出来。\n' +
    '  建议先让出地方：' +
    (advisory.holders.some((holder) => holder.comfyui) ? `${comfyFreeCommand(comfyPort)}；` : '') +
    '或把 `freeComfyBeforeLocalStart` 设为 true，让插件每次启动前自己发那条请求。\n' +
    '  刚跑完一次生成/试玩也不要立刻重试：隔十几秒再跑（背靠背启动 python 会撞 Windows `OSError 1455 页面文件太小`，那是 host commit 压力）。'
  )
}


/** Report host CPU, RAM, and OS facts. */
export function probeHost(): ProbeResult {
  const cpuList = cpus()
  return {
    ok: true,
    data: {
      platform: platform(),
      arch,
      osRelease: release(),
      node: process.version,
      cpuModel: cpuList[0]?.model ?? 'unknown',
      cpuCount: cpuList.length,
      memoryTotalMiB: Math.round(totalmem() / 1024 / 1024),
      memoryFreeMiB: Math.round(freemem() / 1024 / 1024),
    },
  }
}

/**
 * Report free space on the volume holding a directory.
 *
 * @param dir - directory that must exist; the tool passes the configured
 *   `outputDir`, which it creates first if needed.
 * @returns free/total bytes of the containing volume.
 */
export async function probeDisk(dir: string): Promise<ProbeResult> {
  try {
    const stats = await statfs(dir)
    const free = Number(stats.bavail) * Number(stats.bsize)
    const total = Number(stats.blocks) * Number(stats.bsize)
    return {
      ok: true,
      data: {
        path: dir,
        freeMiB: Math.round(free / 1024 / 1024),
        totalMiB: Math.round(total / 1024 / 1024),
        freePercent: total === 0 ? null : Number(((free / total) * 100).toFixed(1)),
      },
    }
  } catch (error) {
    return { ok: false, note: `cannot stat "${dir}": ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Ask whether an HTTP endpoint answers.
 *
 * @param url - endpoint to GET.
 * @param timeoutMs - request budget.
 * @param signal - caller cancellation.
 * @returns reachability, status code, or the transport error.
 */
export async function probeHttp(url: string, timeoutMs: number, signal?: AbortSignal): Promise<ProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  const onAbort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal })
    return { ok: true, data: { url, reachable: true, status: response.status } }
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.cause instanceof Error
          ? `${error.message} (${error.cause.message})`
          : error.message
        : String(error)
    return { ok: false, note: `${url} unreachable: ${reason}`, data: { url, reachable: false } }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Settings the env probe needs to describe the configured backends. */
export interface EnvProbeInput {
  /** Cloud API origin (`apiBaseUrl`). */
  readonly apiBaseUrl: string
  /** Whether an API key was found, and where it came from. */
  readonly apiKeyPresent: boolean
  /** Which source supplied the key: `config`, an env var name, or undefined. */
  readonly apiKeySource?: string
  /** Local worker origin (`localEndpoint`). */
  readonly localEndpoint: string
  /** Already-probed ComfyUI report; this module only relays it. */
  readonly comfyui: Record<string, unknown>
  /** Directory images are written to. */
  readonly outputDir: string
  /** Output directory exists and is writable. */
  readonly outputDirWritable: boolean
  /** Per-probe budget. */
  readonly probeTimeoutMs: number
  /** Free-VRAM floor below which generation is expected to fail. */
  readonly minFreeVramMiB?: number
  /** Where the throwaway command logs go. */
  readonly scratchDir?: string
  /** Local-runtime report (venv, weights, worker) assembled by the caller. */
  readonly localRuntime?: Record<string, unknown>
}

/**
 * Collect the full status report: GPU, host, disk, and both backend endpoints.
 *
 * Probes run concurrently; a failing probe degrades its own field only.
 *
 * @param input - resolved configuration facts plus the key-presence flag.
 * @param signal - caller cancellation.
 * @returns the report body returned by `qwen_image_env status`.
 */
export async function collectEnvStatus(input: EnvProbeInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const minFreeVramMiB = input.minFreeVramMiB ?? 5500
  const [gpu, processes, disk, api, local] = await Promise.all([
    probeGpu(input.probeTimeoutMs, input.scratchDir),
    probeGpuProcesses(input.probeTimeoutMs, input.scratchDir),
    probeDisk(input.outputDir),
    probeHttp(`${input.apiBaseUrl}/models`, input.probeTimeoutMs, signal),
    probeHttp(`${input.localEndpoint}/health`, 1500, signal),
  ])
  const comfyPort = typeof input.comfyui.port === 'number' ? input.comfyui.port : undefined
  const comfyPid =
    input.comfyui.reachable === true && comfyPort !== undefined
      ? await resolveListenerPid(comfyPort, input.probeTimeoutMs, input.scratchDir)
      : undefined
  const advisory = analyseVram(gpu, processes, input.comfyui, minFreeVramMiB, comfyPid)
  return {
    host: probeHost(),
    gpu: gpu.ok ? { ...gpu, data: { ...gpu.data, advisory } } : gpu,
    gpu_processes: processes,
    vram_advisory: advisory,
    disk,
    backends: {
      api: {
        baseUrl: input.apiBaseUrl,
        keyPresent: input.apiKeyPresent,
        keySource: input.apiKeySource ?? null,
        ...api,
      },
      local: {
        endpoint: input.localEndpoint,
        ...local,
      },
      comfyui: input.comfyui,
    },
    local_runtime: input.localRuntime ?? null,
    output: {
      dir: input.outputDir,
      writable: input.outputDirWritable,
    },
    notes: [
      'gpu.vramFreeMiB is the driver-reported free VRAM at probe time; it is not a promise that a given model fits.',
      'vram_advisory 把「显存不够」翻译成一条可执行的下一步：本机实测 ComfyUI 会驻留约 2.9 GiB，它的 POST /free 能立刻放手。',
      'local.* 只探测本地 worker 的 HTTP 端点是否应答；local_runtime.* 才是本插件自己管理的 venv / 权重 / worker 生命周期。',
      'comfyui.* 只探测本机回环地址上的 ComfyUI（先 /system_stats，再 /object_info 枚举权重文件名）；本插件不下载、不转换任何权重。',
      'API keys are never included in this report — only whether one was found and from where.',
    ],
  }
}
