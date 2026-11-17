/**
 * Execution-backend seam between the ComfyUI graph pipeline and the transports
 * that can run one graph.
 *
 * The graph itself is built once (`src/comfyui.ts`) and is transport-agnostic.
 * Three transports exist, tried in this order:
 *
 * 1. **MCP** — spawn the official `comfy-mcp` stdio server and drive it with the
 *    Host-supplied `@modelcontextprotocol/client`. The plugin declares that
 *    package as a peer dependency; the Host's profile runtime resolution
 *    supplies it (see [mcp-backend.md](../docs/mcp-backend.md)).
 * 2. **comfy CLI** — spawn `comfy run/download` directly, no MCP layer.
 * 3. **HTTP** — the original `/prompt` → `/history` → `/view` path in
 *    `src/comfyui.ts`, kept last so a missing toolchain never loses a feature.
 *
 * Selection is **environment-only on purpose**: every config-schema field needs
 * a settings-page control (`test/settings.test.mjs`), and the support files for
 * that page were not part of T15's write scope. Documented variables (all
 * optional, an empty environment keeps the historical HTTP-only behaviour):
 *
 * - `DSH_IMAGE_FORGE_BACKEND` — `auto` (default) | `mcp` | `cli` | `http`.
 *   `mcp`/`cli` are strict: that backend's failure is the call's failure, no
 *   silent HTTP fallback.
 * - `DSH_IMAGE_FORGE_COMFY_MCP_BIN` — absolute path of `comfy-mcp(.exe)`;
 *   otherwise `comfy-mcp` on `PATH`.
 * - `DSH_IMAGE_FORGE_COMFY_BIN` — absolute path of `comfy(.exe)` handed to the
 *   MCP child as `COMFY_BIN`; otherwise `comfy` on `PATH`.
 * - `DSH_IMAGE_FORGE_BACKEND_TIMEOUT_MS` — optional per-backend budget override.
 *
 * @module
 */
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { GeneratedImage } from './images.ts'

/** Environment variable selecting the backend chain. */
export const ENV_BACKEND = 'DSH_IMAGE_FORGE_BACKEND'
/** Environment variable naming the `comfy-mcp` executable. */
export const ENV_MCP_BIN = 'DSH_IMAGE_FORGE_COMFY_MCP_BIN'
/** Environment variable naming the `comfy` CLI executable. */
export const ENV_COMFY_BIN = 'DSH_IMAGE_FORGE_COMFY_BIN'
/** Environment variable overriding the per-backend budget. */
export const ENV_BACKEND_TIMEOUT_MS = 'DSH_IMAGE_FORGE_BACKEND_TIMEOUT_MS'

/** Backend selection: `auto` tries mcp → cli → http; the others start at one. */
export type BackendMode = 'auto' | 'mcp' | 'cli' | 'http'

/** One backend call: everything a transport needs to run a rendered graph. */
export interface BackendRunRequest {
  /** Resolved ComfyUI origin, e.g. `http://127.0.0.1:8188`. */
  readonly endpoint: string
  /** API-format graph (node id → `{class_type, inputs}`), no placeholders left. */
  readonly graph: Record<string, unknown>
  /** Name of the run used in error text (`出图` / `改图`). */
  readonly what: string
  /** Whole-run budget in milliseconds. */
  readonly timeoutMs: number
  /** Gap between status polls in milliseconds. */
  readonly pollIntervalMs: number
  /** Caller cancellation. */
  readonly signal?: AbortSignal
  /** Called once with the prompt id, before polling (mirrors `ComfyOptions`). */
  readonly onPromptId?: (promptId: string) => void
}

/** A transport that can execute one graph and return its images. */
export interface ImageBackend {
  /** `mcp` or `cli`; HTTP is not an {@link ImageBackend}. */
  readonly name: 'mcp' | 'cli'
  /** Execute one graph. Throws when the backend cannot deliver the images. */
  run(request: BackendRunRequest): Promise<GeneratedImage[]>
  /** Release subprocesses. Idempotent. */
  dispose(): Promise<void>
}

/** What the current environment asks for. */
export interface BackendPlan {
  readonly mode: BackendMode
  readonly mcpCommand: string | undefined
  readonly comfyCommand: string | undefined
  /** Per-backend budget override; `undefined` keeps the caller's `timeoutMs`. */
  readonly timeoutMsOverride: number | undefined
}

/** Injectable constructors, so tests need no real toolchain. */
export interface BackendFactories {
  createMcpBackend?: (plan: BackendPlan) => ImageBackend
  createCliBackend?: (plan: BackendPlan) => ImageBackend
}

/** Result of a successful non-HTTP run. */
export interface BackendRunResult {
  readonly via: 'mcp' | 'cli'
  readonly images: GeneratedImage[]
  /** Non-fatal failures of earlier backends in auto mode (diagnostics). */
  readonly skipped: readonly string[]
}

/** Locate an executable on `PATH` (with Windows `PATHEXT` support). */
export function findExecutable(
  name: string,
  pathEnv: string | undefined = process.env.PATH,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (name === '') return undefined
  const separators = [delimiter, platform === 'win32' ? ';' : ':']
  const dirs = new Set<string>()
  for (const separator of separators) {
    for (const entry of (pathEnv ?? '').split(separator)) if (entry !== '') dirs.add(entry)
  }
  const suffixes = platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, name.endsWith(suffix.toLowerCase()) || name.endsWith(suffix.toUpperCase()) ? name : name + suffix)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/** Read the backend plan from an environment (defaults to `process.env`). */
export function resolveBackendPlan(env: { [key: string]: string | undefined } = process.env): BackendPlan {
  const rawMode = (env[ENV_BACKEND] ?? '').trim().toLowerCase()
  const mode: BackendMode = rawMode === 'mcp' || rawMode === 'cli' || rawMode === 'http' ? rawMode : 'auto'
  if (rawMode !== '' && rawMode !== mode) {
    throw new Error(`${ENV_BACKEND}=${rawMode} 不合法：可选 auto / mcp / cli / http。`)
  }
  const timeout = Number((env[ENV_BACKEND_TIMEOUT_MS] ?? '').trim())
  return {
    mode,
    mcpCommand: (env[ENV_MCP_BIN] ?? '').trim() || findExecutable('comfy-mcp', env.PATH),
    comfyCommand: (env[ENV_COMFY_BIN] ?? '').trim() || findExecutable('comfy', env.PATH),
    timeoutMsOverride: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
  }
}

/**
 * Run one graph through the non-HTTP backends the plan allows.
 *
 * `auto` swallows a backend's failure and tries the next one (the caller then
 * falls back to HTTP); `mcp`/`cli` re-throw that backend's error. Returns
 * `undefined` when no non-HTTP backend is configured/available, which is the
 * no-toolchain path every existing test exercises.
 */
export async function runThroughBackends(
  request: BackendRunRequest,
  plan: BackendPlan,
  factories: BackendFactories = {},
): Promise<BackendRunResult | undefined> {
  if (plan.mode === 'http') return undefined
  const attempts: Array<{ name: 'mcp' | 'cli'; create: (plan: BackendPlan) => ImageBackend }> = []
  if (plan.mode !== 'cli' && plan.mcpCommand !== undefined) {
    attempts.push({
      name: 'mcp',
      create: factories.createMcpBackend ?? (async () => {
        const { createMcpBackend } = await import('./mcp-backend.ts')
        return createMcpBackend({
          command: plan.mcpCommand as string,
          comfyBin: plan.comfyCommand,
          env: process.env,
          debug: (process.env.DSH_IMAGE_FORGE_MCP_DEBUG ?? '') === '1',
          scratchRoot: (process.env.DSH_IMAGE_FORGE_BACKEND_TMPDIR ?? '').trim() || undefined,
        })
      }) as unknown as (plan: BackendPlan) => ImageBackend,
    })
  }
  if (plan.mode !== 'mcp' && plan.comfyCommand !== undefined) {
    attempts.push({
      name: 'cli',
      create: factories.createCliBackend ?? (async () => {
        const { createCliBackend } = await import('./cli-backend.ts')
        return createCliBackend({
          command: plan.comfyCommand as string,
          env: process.env,
          scratchRoot: (process.env.DSH_IMAGE_FORGE_BACKEND_TMPDIR ?? '').trim() || undefined,
        })
      }) as unknown as (plan: BackendPlan) => ImageBackend,
    })
  }
  if (attempts.length === 0) return undefined
  const skipped: string[] = []
  for (const attempt of attempts) {
    let backend: ImageBackend | undefined
    try {
      backend = await attempt.create(plan)
      const budget = plan.timeoutMsOverride === undefined ? request.timeoutMs : Math.min(request.timeoutMs, plan.timeoutMsOverride)
      const images = await backend.run({ ...request, timeoutMs: budget })
      return { via: attempt.name, images, skipped }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (plan.mode === attempt.name) throw error
      skipped.push(`${attempt.name}: ${message}`)
    } finally {
      await backend?.dispose().catch(() => undefined)
    }
  }
  return undefined
}
