/**
 * MCP backend: spawn the pinned `comfy-mcp` stdio server and drive it with the
 * Host-supplied `@modelcontextprotocol/client`.
 *
 * Tool surface is filtered on the client side: comfy-mcp 0.10.0 publishes 39
 * tools and has no allowlist variable of its own (docs/usage-reference.md §8-1),
 * so this module keeps only the five it needs and refuses to call anything else.
 * The 0.10.0 tool list is recorded in [mcp-tools.md](../docs/usage-reference.md).
 *
 * Only five operations are used (docs/usage-reference.md and
 * [mcp-backend.md](../docs/usage-reference.md) carry the exact call sequence):
 *
 * ```text
 * run_workflow(workflow_path, wait=false) -> { prompt_id }
 * job(action="status", prompt_id)         -> poll; timed_out is NOT failure
 * fetch_outputs(prompt_id, out_dir)       -> copies files into out_dir
 * validate_workflow / system_stats        -> allowed, used by verification paths
 * ```
 *
 * @module
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { sniffImageMime, type GeneratedImage } from './images.ts'
import type { BackendRunRequest, ImageBackend } from './backend.ts'

/** The tools this client is allowed to call (0.10.0 names). */
export const MCP_TOOL_ALLOWLIST = [
  'run_workflow',
  'job',
  'fetch_outputs',
  'validate_workflow',
  'system_stats',
] as const

/** Tools that must exist before a run; a missing one is a hard configuration error. */
const REQUIRED_TOOLS = ['run_workflow', 'job', 'fetch_outputs'] as const

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

/** Structural subset of the SDK client used here (kept local: the SDK is a peer). */
export interface McpClientLike {
  listTools: (params?: unknown, options?: unknown) => Promise<{ tools: Array<{ name: string }> }>
  callTool: (params: { name: string; arguments: Record<string, unknown> }, options?: unknown) => Promise<{
    isError?: boolean
    content?: Array<{ type: string; text?: string }>
  }>
  close?: () => Promise<void> | void
}

/** One live stdio session. */
export interface McpConnectionLike {
  client: McpClientLike
  /** Child process id, when the transport exposes it (used for tree kill). */
  pid?: number
  /** Close the session and its child. */
  close?: () => Promise<void> | void
}

/** Creates a connection; injectable so tests do not need the real SDK/toolchain. */
export type McpConnect = (options: {
  command: string
  endpoint: string
  comfyBin: string | undefined
  env: { [key: string]: string | undefined }
}) => Promise<McpConnectionLike>

/** Options accepted by {@link createMcpBackend}. */
export interface McpBackendOptions {
  /** `comfy-mcp` executable, absolute or on PATH. */
  command: string
  /** `comfy` executable handed to the child as `COMFY_BIN`. */
  comfyBin?: string
  /** Environment forwarded to the child (defaults to `process.env`). */
  env?: { [key: string]: string | undefined }
  /** Connection factory override (tests). */
  connect?: McpConnect
  /** Process-tree killer override (tests). */
  killTree?: (pid: number) => void
  /** Parent for per-run temp dirs; defaults to `os.tmpdir()`. */
  scratchRoot?: string
  /**
   * Workspace mirror root (T22): when set, `fetch_outputs` copies into
   * `<mirrorRoot>/<promptId>/` and those files are **kept** so the archived
   * artifacts live inside the workspace board directory. Only the scratch
   * metadata dir is removed.
   */
  mirrorRoot?: string
  /** Sleep override (tests). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Write one stderr line per tool call (`DSH_IMAGE_FORGE_MCP_DEBUG=1`). */
  debug?: boolean
}

function deepFind(value: unknown, key: string, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return undefined
  if (Object.prototype.hasOwnProperty.call(value, key)) return (value as Record<string, unknown>)[key]
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = deepFind(child, key, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? []).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n')
}

function parseEnvelopeOrThrow(result: { isError?: boolean; content?: Array<{ type: string; text?: string }> }, what: string): unknown {
  const text = textOf(result)
  if (result.isError === true) throw new Error(`comfy-mcp: ${what} 失败：${text.slice(0, 2000) || '（无错误文本）'}`)
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    timer.unref?.()
    const abort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    if (signal?.aborted === true) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Kill a child and its descendants; comfy-mcp itself only kills its direct child. */
export function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
}

/** Load the Host-supplied SDK. Returns `undefined` when the Host did not supply it. */
async function loadHostSdk(): Promise<{
  Client: new (info: { name: string; version: string }, options: Record<string, unknown>) => McpClientLike & {
    connect: (transport: unknown) => Promise<void>
    close: () => Promise<void>
    getServerVersion?: () => unknown
    getServerCapabilities?: () => unknown
  }
  StdioClientTransport: new (options: Record<string, unknown>) => { pid?: number; close?: () => Promise<void> }
  getDefaultEnvironment: () => Record<string, string>
} | undefined> {
  try {
    const clientModule = await import('@modelcontextprotocol/client')
    const stdioModule = await import('@modelcontextprotocol/client/stdio')
    return {
      Client: clientModule.Client as never,
      StdioClientTransport: stdioModule.StdioClientTransport as never,
      getDefaultEnvironment: stdioModule.getDefaultEnvironment as never,
    }
  } catch {
    return undefined
  }
}

/**
 * Default connection: load the Host SDK, spawn `comfy-mcp` over stdio, and
 * point it at the resolved ComfyUI endpoint with `COMFY_LOCAL_URL` (never
 * `COMFYUI_URL` — that has remote semantics, docs/usage-reference.md §env).
 */
async function connectHost(options: {
  command: string
  endpoint: string
  comfyBin: string | undefined
  env: { [key: string]: string | undefined }
}): Promise<McpConnectionLike> {
  const sdk = await loadHostSdk()
  if (sdk === undefined) {
    throw new Error(
      'comfy-mcp 后端不可用：宿主没有提供 @modelcontextprotocol/client（应作为 peerDependency 由 DSH profile 运行时解析）。' +
        '如确需降级，保持 DSH_IMAGE_FORGE_BACKEND 未设置即可回落到 HTTP。',
    )
  }
  const childEnv: Record<string, string> = {
    ...sdk.getDefaultEnvironment(),
    COMFY_LOCAL_URL: options.endpoint,
  }
  for (const [key, value] of Object.entries(options.env)) {
    if (typeof value === 'string' && key !== 'COMFYUI_URL') childEnv[key] = value
  }
  delete childEnv.COMFYUI_URL
  if (options.comfyBin !== undefined && options.comfyBin !== '') childEnv.COMFY_BIN = options.comfyBin
  const transport = new sdk.StdioClientTransport({ command: options.command, args: [], env: childEnv, stderr: 'pipe' })
  const client = new sdk.Client(
    { name: 'dsh-image-forge', version: '0.0.4' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } },
  )
  await client.connect(transport)
  return {
    client,
    pid: typeof transport.pid === 'number' ? transport.pid : undefined,
    close: async () => {
      await Promise.resolve(client.close()).catch(() => undefined)
      await Promise.resolve(transport.close?.()).catch(() => undefined)
    },
  }
}

/** MCP-based {@link ImageBackend}. */
export class McpBackend implements ImageBackend {
  readonly name = 'mcp' as const
  private readonly options: McpBackendOptions
  private connection: McpConnectionLike | undefined
  private endpoint: string | undefined
  private allowedTools: string[] | undefined
  private disposed = false

  constructor(options: McpBackendOptions) {
    this.options = options
  }

  private async ensureConnection(endpoint: string): Promise<McpConnectionLike> {
    if (this.connection !== undefined && this.endpoint === endpoint) return this.connection
    await this.dispose()
    this.disposed = false
    this.allowedTools = undefined
    const connect = this.options.connect ?? connectHost
    this.connection = await connect({
      command: this.options.command,
      endpoint,
      comfyBin: this.options.comfyBin,
      env: this.options.env ?? process.env,
    })
    this.endpoint = endpoint
    return this.connection
  }

  /** Filter `tools/list` down to the allowlist and verify the required names exist. */
  async connectAndFilterTools(endpoint: string): Promise<string[]> {
    if (this.connection !== undefined && this.endpoint === endpoint && this.allowedTools !== undefined) {
      return this.allowedTools
    }
    const connection = await this.ensureConnection(endpoint)
    const response = await connection.client.listTools(undefined, { cacheMode: 'refresh' })
    const published = response.tools.map(tool => tool.name)
    const allowed = published.filter(name => (MCP_TOOL_ALLOWLIST as readonly string[]).includes(name))
    for (const required of REQUIRED_TOOLS) {
      if (!allowed.includes(required)) {
        throw new Error(`comfy-mcp 缺少必需工具 ${required}（实测工具数 ${published.length}，可能是版本不是 0.10.0）`)
      }
    }
    this.allowedTools = allowed
    return allowed
  }

  /** Call one allow-listed tool and parse its JSON envelope/text. */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!(MCP_TOOL_ALLOWLIST as readonly string[]).includes(name)) {
      throw new Error(`comfy-mcp: 工具 ${name} 不在客户端白名单内`)
    }
    if (this.allowedTools !== undefined && !this.allowedTools.includes(name)) {
      throw new Error(`comfy-mcp: 工具 ${name} 不在本服务实测的工具清单内`)
    }
    const connection = this.connection
    if (connection === undefined) throw new Error('comfy-mcp: 连接尚未建立')
    const startedAt = Date.now()
    if (this.options.debug === true) process.stderr.write(`[dsh-image-forge mcp] call ${name} ${JSON.stringify(args).slice(0, 300)}\n`)
    const result = await connection.client.callTool({ name, arguments: args })
    if (this.options.debug === true) process.stderr.write(`[dsh-image-forge mcp] done ${name} ${Date.now() - startedAt}ms isError=${String(result.isError)}\n`)
    return parseEnvelopeOrThrow(result, name)
  }

  private async killTree(): Promise<void> {
    const pid = this.connection?.pid
    if (pid !== undefined) (this.options.killTree ?? killProcessTree)(pid)
    await this.closeConnection()
  }

  private async closeConnection(): Promise<void> {
    const connection = this.connection
    this.connection = undefined
    this.endpoint = undefined
    this.allowedTools = undefined
    if (connection !== undefined) await connection.close?.()
  }

  async run(request: BackendRunRequest): Promise<GeneratedImage[]> {
    const interval = Math.max(1, request.pollIntervalMs)
    const scratchRoot = this.options.scratchRoot ?? tmpdir()
    mkdirSync(scratchRoot, { recursive: true })
    const scratch = mkdtempSync(join(scratchRoot, 'dsh-image-forge-mcp-'))
    let promptId: string | undefined
    try {
      await this.connectAndFilterTools(request.endpoint)
      const workflowPath = join(scratch, 'workflow.json')
      writeFileSync(workflowPath, JSON.stringify(request.graph), 'utf8')

      // Submit without waiting: the first generation after a weight load routinely
      // exceeds comfy-mcp's default 110 s, so a timed-out wait would be a lie.
      const submission = await this.callTool('run_workflow', { workflow_path: workflowPath, wait: false })
      const found = deepFind(submission, 'prompt_id')
      if (typeof found !== 'string' && typeof found !== 'number') {
        throw new Error(`comfy-mcp: run_workflow 没有返回 prompt_id（拿到 ${JSON.stringify(submission).slice(0, 300)}）`)
      }
      promptId = String(found)
      request.onPromptId?.(promptId)

      const deadline = Date.now() + request.timeoutMs
      for (;;) {
        const status = await this.callTool('job', { action: 'status', prompt_id: promptId })
        const state = classifyJob(status)
        if (state === 'failed') throw new Error(`comfy-mcp: prompt ${promptId} 执行失败\n${JSON.stringify(status).slice(0, 2000)}`)
        if (state === 'done') break
        if (Date.now() + interval >= deadline) {
          throw new Error(
            `comfy-mcp: 等 prompt ${promptId} 超过 ${request.timeoutMs} ms 仍未完成。ComfyUI 可能还在跑（首次加载权重常超过 110 s），` +
              `结果仍可用 GET ${request.endpoint}/history/${promptId} 查到；把 timeoutMs 调大后重试。`,
          )
        }
        await (this.options.sleep ?? defaultSleep)(interval, request.signal)
      }

      // T22 result mirror: the transport's copies land in the workspace board
      // area so they survive the run, not in the throwaway scratch dir.
      const mirrorRoot = this.options.mirrorRoot
      const outDir = mirrorRoot === undefined
        ? join(scratch, 'outputs')
        : join(mirrorRoot, promptId)
      mkdirSync(outDir, { recursive: true })
      // `fetch_outputs` shells out to `comfy download`, which needs comfy-cli's
      // own job-state file from the submit. Observed once on a just-completed job:
      // the first call exceeded the SDK's per-request budget while the state file
      // was still settling, and an immediate retry succeeds. Retry a couple of
      // times before failing; the budget is the caller's, not the SDK's default.
      let fetched: unknown
      let lastError: unknown
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          fetched = await this.callTool('fetch_outputs', { prompt_id: promptId, out_dir: outDir })
          lastError = undefined
          break
        } catch (error) {
          lastError = error
          if (attempt < 3) await (this.options.sleep ?? defaultSleep)(1_000, request.signal)
        }
      }
      if (lastError !== undefined) throw lastError
      void fetched
      const images = readImages(outDir)
      if (images.length === 0) {
        throw new Error(`comfy-mcp: prompt ${promptId} 完成但 fetch_outputs 没有复制出任何图片（out_dir=${outDir}）`)
      }
      return images
    } catch (error) {
      const aborted = request.signal?.aborted === true
      const timeout = error instanceof Error && error.message.includes('超过')
      if (aborted || timeout) await this.killTree().catch(() => undefined)
      throw error
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.closeConnection()
  }
}

/** Classify a `job(action="status")` payload. `timed_out` is explicitly not failure. */
export function classifyJob(status: unknown): 'pending' | 'done' | 'failed' {
  const completed = deepFind(status, 'completed')
  if (completed === true) return 'done'
  const timedOut = deepFind(status, 'timed_out')
  if (timedOut === true) return 'pending'
  const state = deepFind(status, 'status')
  if (typeof state === 'string') {
    const normalized = state.toLowerCase()
    if (normalized === 'completed' || normalized === 'success' || normalized === 'succeeded') return 'done'
    if (normalized === 'error' || normalized === 'failed' || normalized === 'cancelled') return 'failed'
  }
  const outputs = deepFind(status, 'outputs')
  if (outputs !== undefined && outputs !== null && typeof outputs === 'object' && Object.keys(outputs as object).length > 0) return 'done'
  if (deepFind(status, 'error') !== undefined) return 'failed'
  return 'pending'
}

function readImages(dir: string): GeneratedImage[] {
  const files: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase()) && statSync(path).size > 0) files.push(path)
    }
  }
  walk(dir)
  files.sort()
  return files.map(path => {
    const bytes = new Uint8Array(readFileSync(path))
    return { bytes, mime: sniffImageMime(bytes) ?? 'image/png' }
  })
}

/** Create the MCP backend. */
export function createMcpBackend(options: McpBackendOptions): ImageBackend {
  return new McpBackend(options)
}
