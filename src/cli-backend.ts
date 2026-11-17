/**
 * comfy-CLI fallback backend: the same {@link ImageBackend} contract as
 * `src/mcp-backend.ts`, but spawning `comfy` directly instead of going through
 * the MCP server (no `comfy-mcp` install, no stdio layer).
 *
 * Only the verbs verified from `comfy --help` in comfy-cli 1.26.0 are used
 * (`run --wait`, `download`, `system-stats`); the workflow handed to
 * `run --workflow` is the same API-format JSON the MCP path writes, so the
 * caller cannot tell the two apart. comfy-cli accepts both API and exported UI
 * workflow JSON and converts the UI form client-side.
 *
 * The CLI path is a **fallback**: MCP is tried first, HTTP last. It is also
 * untested end-to-end against a real ComfyUI in T15 (declared in the report);
 * its contract is pinned by `test/mcp-backend.test.mjs` with an injected spawn
 * and the verbs above are the 1.26.0 `--help` surface.
 *
 * @module
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { sniffImageMime, type GeneratedImage } from './images.ts'
import type { BackendRunRequest, ImageBackend } from './backend.ts'
import { killProcessTree } from './mcp-backend.ts'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

/** Result of one CLI invocation. */
export interface CliInvocation {
  code: number | null
  stdout: string
  stderr: string
}

/** Injectable spawn seam (tests supply canned envelopes). */
export type CliSpawn = (args: readonly string[], options: {
  env: Record<string, string | undefined>
  timeoutMs: number
  signal?: AbortSignal
}) => Promise<CliInvocation>

/** Options for {@link createCliBackend}. */
export interface CliBackendOptions {
  /** `comfy` executable, absolute or on PATH. */
  command: string
  /** Base environment (defaults to `process.env`). */
  env?: Record<string, string | undefined>
  /** Spawn override (tests). */
  spawnCommand?: CliSpawn
  /** Called with the child pid so a timeout can kill the whole tree. */
  onSpawn?: (pid: number | undefined) => void
  /** Parent for per-run temp dirs; defaults to `os.tmpdir()`. */
  scratchRoot?: string
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

/** Parse the last JSON object on stdout (comfy-cli envelope mode). */
export function parseEnvelope(stdout: string): unknown {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line)
    } catch {
      // Side messages may precede the envelope; keep looking upward.
    }
  }
  return undefined
}

/** Default spawn: run one comfy invocation and collect its streams. */
const defaultSpawn: CliSpawn = (args, options) => new Promise((resolve, reject) => {
  const child = spawn(args[0] ?? '', args.slice(1), {
    env: { ...options.env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  } as never)
  let stdout = ''
  let stderr = ''
  let settled = false
  const finish = (code: number | null): void => {
    if (settled) return
    settled = true
    resolve({ code, stdout, stderr })
  }
  const timer = setTimeout(() => {
    if (child.pid !== undefined) killProcessTree(child.pid)
    settled = true
    reject(new Error(`comfy CLI: 超过 ${options.timeoutMs} ms 未返回`))
  }, Math.max(1, options.timeoutMs))
  timer.unref?.()
  options.signal?.addEventListener('abort', () => {
    if (child.pid !== undefined) killProcessTree(child.pid)
    clearTimeout(timer)
    if (!settled) {
      settled = true
      reject(new Error('comfy CLI: 已取消'))
    }
  }, { once: true })
  child.stdout?.on('data', chunk => { stdout += String(chunk) })
  child.stderr?.on('data', chunk => { stderr += String(chunk) })
  child.on('error', error => {
    clearTimeout(timer)
    if (settled) return
    settled = true
    reject(error)
  })
  child.on('close', code => {
    clearTimeout(timer)
    finish(code)
  })
})

/** CLI-based {@link ImageBackend}. */
export class CliBackend implements ImageBackend {
  readonly name = 'cli' as const
  private readonly options: CliBackendOptions

  constructor(options: CliBackendOptions) {
    this.options = options
  }

  private async invoke(args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const env = { ...(this.options.env ?? process.env) }
    delete env.COMFYUI_URL
    const spawnCommand = this.options.spawnCommand
    const run = spawnCommand === undefined
      ? defaultSpawn
      : spawnCommand
    const invocation = spawnCommand === undefined
      ? await run([this.options.command, ...args], { env, timeoutMs, signal })
      : await run([...args], { env, timeoutMs, signal })
    const envelope = parseEnvelope(invocation.stdout)
    if (envelope === undefined) {
      throw new Error(
        `comfy CLI: 没有 JSON envelope（exit ${String(invocation.code)}）${invocation.stderr.trim().slice(0, 1200)}`,
      )
    }
    if (deepFind(envelope, 'ok') === false) {
      const message = deepFind(envelope, 'message')
      throw new Error(`comfy CLI: ${typeof message === 'string' ? message : JSON.stringify(envelope).slice(0, 1200)}`)
    }
    return envelope
  }

  async run(request: BackendRunRequest): Promise<GeneratedImage[]> {
    const scratchRoot = this.options.scratchRoot ?? tmpdir()
    mkdirSync(scratchRoot, { recursive: true })
    const scratch = mkdtempSync(join(scratchRoot, 'dsh-image-forge-cli-'))
    try {
      const url = new URL(request.endpoint)
      const workflowPath = join(scratch, 'workflow.json')
      writeFileSync(workflowPath, JSON.stringify(request.graph), 'utf8')
      const host = url.hostname
      const port = url.port === '' ? '80' : url.port
      const seconds = Math.max(1, Math.ceil(request.timeoutMs / 1000))
      const base = ['--json', '--where', 'local', '--skip-prompt']
      const submission = await this.invoke([
        ...base,
        'run',
        '--workflow', workflowPath,
        '--wait',
        '--host', host,
        '--port', port,
        '--timeout', String(seconds),
      ], request.timeoutMs, request.signal)
      const promptId = deepFind(submission, 'prompt_id')
      if (typeof promptId !== 'string' && typeof promptId !== 'number') {
        throw new Error(`comfy CLI: run 没有返回 prompt_id（拿到 ${JSON.stringify(submission).slice(0, 300)}）`)
      }
      request.onPromptId?.(String(promptId))

      const outDir = join(scratch, 'outputs')
      mkdirSync(outDir, { recursive: true })
      await this.invoke([
        ...base,
        'download', String(promptId),
        '--out-dir', outDir,
      ], request.timeoutMs, request.signal)
      const images = readImages(outDir)
      if (images.length === 0) throw new Error(`comfy CLI: download 没有写出任何图片（out_dir=${outDir}）`)
      return images
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  async dispose(): Promise<void> {
    // Nothing long-lived: every invocation is bounded by its own budget.
  }
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

/** Create the comfy-CLI fallback backend. */
export function createCliBackend(options: CliBackendOptions): ImageBackend {
  return new CliBackend(options)
}
