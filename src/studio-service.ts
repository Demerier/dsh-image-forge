/**
 * Studio host service: the **ComfyUI-only** generation pipeline behind the
 * panel, plus the capability snapshot the panel renders before its first click.
 *
 * This module owns no HTTP and no UI. It exposes three plain async functions
 * that the routes in `studio-routes.ts` adapt to `IncomingMessage`, which keeps
 * the whole pipeline testable without a socket and keeps the route file to
 * request parsing and response framing.
 *
 * ## Why ComfyUI only
 *
 * The Studio is deliberately not a provider matrix. Qwen-Image 2.1 on the
 * user's own ComfyUI is the one target: it needs no key, it reuses weights
 * already on disk, and its canvas is the one thing the panel's ratio picker can
 * honestly promise. Adding a second backend here would reintroduce exactly the
 * per-provider option matrix this workbench exists to avoid.
 *
 * ## What it reuses
 *
 * Everything below the pipeline already exists and is left untouched:
 * `discoverComfyUi` (port probing, loopback-only), `loadComfyModels` (resolves
 * the three weight file names from `/object_info`), `generateViaComfyUi`, and
 * `generateViaComfyUiEdit` (multi-reference editing). The Studio therefore
 * inherits the same error text and the same "quote upstream, never swallow it"
 * behaviour as the Agent tools — one behaviour, two front doors.
 *
 * @module studio-service
 */
import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  comfyOptionsOf as buildComfyOptions,
  discoverComfyUi,
  generateViaComfyUi,
  generateViaComfyUiEdit,
  generateViaComfyUiTurbo,
  generateViaComfyUiTurboEdit,
  loadComfyModels,
  parseComfyPorts,
  turboUnetOf,
  TURBO_STEPS,
  type ComfyModels,
  type ComfyTarget,
} from './comfyui.ts'
import type { GeneratedImage, ReferenceImagePayload } from './images.ts'
import { activeBoardId, listBoards, makeItemId, recordItems } from './boards.ts'
import { writeImages } from './output.ts'
import { firstLine } from './studio-shared.ts'
import { WH_RATIOS, resolveDefaultSize } from './ratio.ts'
import type { Config } from './index.ts'
import {
  STUDIO_MAX_COUNT,
  STUDIO_MAX_PROMPT_CHARS,
  STUDIO_MAX_REFERENCES,
  type BoardSummary,
  type StudioConfigResponse,
  type StudioGenerateRequest,
  type StudioGenerateResponse,
  type StudioRatio,
  type StudioReferencePayload,
} from './studio-shared.ts'
import { llmOf, optimizerAvailable, resolveOptimizerModel } from './studio-prompt.ts'

/** Everything the pipeline reads off the resolved plugin config. */
export interface StudioSettings {
  readonly comfyEndpoint: string
  readonly comfyPorts: readonly number[]
  readonly comfyModelsDir: string
  readonly timeoutMs: number
  readonly outputDir: string
  /** Steps used when a request omits one. */
  readonly defaultSteps: number
  /** Per-backend override, when configured. */
  readonly comfyuiSteps: number | undefined
  /** Which checkpoint family to ask for; a turbo unet must be installed to matter. */
  readonly comfyModel: 'base' | 'turbo'
  /** Turbo step override; `undefined` means the distilled default (8). */
  readonly turboSteps: number | undefined
}

/** ComfyUI options derived from the settings, in the shape the adapter expects. */
export function comfyOptionsOf(settings: StudioSettings, timeoutMs = settings.timeoutMs) {
  return buildComfyOptions(settings, timeoutMs)
}

/**
 * Map the plugin config onto what the Studio pipeline reads.
 *
 * Derived from the same fields `tools.ts` uses, so a settings change reaches the
 * Agent tools and the Studio in one save rather than needing its own row.
 *
 * @param config - the resolved plugin config.
 * @returns the subset the Studio consumes.
 */
export function studioSettingsOf(config: Config): StudioSettings {
  return {
    comfyEndpoint: config.comfyEndpoint,
    comfyPorts: parseComfyPorts(config.comfyPorts),
    comfyModelsDir: config.comfyModelsDir,
    timeoutMs: config.timeoutMs,
    outputDir: config.outputDir,
    defaultSteps: config.defaultSteps,
    comfyuiSteps: config.comfyuiSteps,
    comfyModel: config.comfyModel,
    turboSteps: config.turboSteps,
  }
}

/**
 * Steps a Studio request resolves to: its own value, else the family's default.
 *
 * The family decides which fallback applies: turbo never borrows the base
 * checkpoint's 25 (handing 25 steps to a checkpoint distilled for 8 makes the
 * picture worse), so an explicit `turboSteps` — else the distilled 8 — is what
 * an omitted step count means when `comfyModel` is `turbo`. The clamp is shared.
 */
export function resolveStudioSteps(settings: StudioSettings, requested: number | undefined): number {
  const turbo = settings.comfyModel === 'turbo'
  const fallback = turbo
    ? (settings.turboSteps ?? TURBO_STEPS)
    : (settings.comfyuiSteps ?? settings.defaultSteps)
  if (requested === undefined) return fallback
  if (!Number.isFinite(requested)) return fallback
  // 1 is legal (a single-step draft); 200 is well past anything Qwen-Image
  // benefits from, and clamping here keeps a typo from pinning a GPU for hours.
  return Math.min(200, Math.max(1, Math.round(requested)))
}

/**
 * Resolve one ratio to an aligned pixel pair.
 *
 * `resolveDefaultSize` is imported rather than `resolveSize` for a reason that
 * matters: the seven official ratios are served from the calibrated
 * `DEFAULT_SIZES` table, while `resolveSize` *searches* a pixel-budget grid and
 * lands somewhere slightly different — 1216² instead of 1248² for a square, for
 * instance. Using the search here would make the panel's picker label and the
 * actual canvas disagree on four of the seven ratios. The Agent tool resolves
 * through the same table, so both surfaces agree on what "16:9" means.
 *
 * @param ratio - a `W:H` string the panel offered.
 * @returns the aligned size, or `undefined` when the ratio is not one of ours.
 */
export function studioSize(ratio: string): { width: number; height: number; ratio: StudioRatio } | undefined {
  const match = (WH_RATIOS as readonly string[]).find((candidate) => candidate === ratio)
  if (match === undefined) return undefined
  const size = resolveDefaultSize(match)
  return { width: size.width, height: size.height, ratio: match as StudioRatio }
}

/** Every ratio with its resolved size, for the panel's picker labels. */
export function studioSizeTable(): Array<{ ratio: StudioRatio; width: number; height: number }> {
  return (WH_RATIOS as readonly StudioRatio[]).map((ratio) => {
    const size = resolveDefaultSize(ratio)
    return { ratio, width: size.width, height: size.height }
  })
}

/**
 * Build the capability snapshot the panel reads on mount.
 *
 * The probe is best-effort and bounded: an unreachable ComfyUI yields
 * `ready: false` plus a reason, never a thrown error, because a panel that can
 * render its controls but not generate is far more useful than one that shows a
 * blank error card. `optimizeAvailable` is resolved independently for the same
 * reason — a missing LLM must not imply a missing ComfyUI.
 *
 * @param ctx - host context (for the `llm` lookup).
 * @param settings - resolved Studio settings.
 * @param signal - abandons the probe when the panel navigates away.
 * @returns the snapshot; every field is present.
 */
export async function describeStudio(
  ctx: Context,
  settings: StudioSettings,
  signal?: AbortSignal,
): Promise<StudioConfigResponse> {
  const sizes = studioSizeTable()
  const optimizer = await resolveOptimizerModel(llmOf(ctx))
  const optimizeAvailable = await optimizerAvailable(ctx)

  let ready = false
  let endpoint: string | undefined
  let models: ComfyModels | undefined
  let reason: string | undefined
  try {
    const target = await discoverComfyUi(comfyOptionsOf(settings, Math.min(settings.timeoutMs, 15_000)), signal)
    const resolved = await loadComfyModels(target, comfyOptionsOf(settings, Math.min(settings.timeoutMs, 20_000)), signal)
    endpoint = target.endpoint
    models = resolved
    ready = true
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error)
  }

  // The board library is read independently of ComfyUI: an unreachable GPU must
  // not hide work the user already made. A broken directory degrades to an empty
  // list plus a note, never to a failed snapshot.
  let boards: BoardSummary[] = []
  let active: string | null = null
  let boardsNote: string | undefined
  try {
    boards = await listBoards(settings.outputDir)
    const remembered = await activeBoardId(settings.outputDir)
    active = remembered !== null && boards.some((board) => board.id === remembered)
      ? remembered
      : (boards[0]?.id ?? null)
  } catch (error) {
    boardsNote = firstLine(error)
  }

  return {
    ready,
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(models === undefined ? {} : { models: { unet: models.unet, clip: models.clip, vae: models.vae } }),
    ...(reason === undefined ? {} : { reason }),
    defaultSteps: resolveStudioSteps(settings, undefined),
    outputDir: settings.outputDir,
    sizes,
    optimizeAvailable,
    ...(optimizer === undefined ? {} : { optimizeModel: optimizer.model }),
    boards,
    activeBoard: active,
    ...(boardsNote === undefined ? {} : { boardsNote }),
  }
}

/** Decode canonical base64, rejecting anything that does not round-trip. */
function decodeBase64(value: string): Uint8Array {
  const bytes = Buffer.from(value, 'base64')
  if (bytes.byteLength === 0) throw new Error('参考图内容为空')
  return new Uint8Array(bytes)
}

/** Containers the canvas may hand back as a reference; anything else is refused. */
const REFERENCE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

/** Largest reference file the host will read off disk. */
const REFERENCE_MAX_BYTES = 32 * 1024 * 1024

/**
 * Read one reference from disk.
 *
 * This exists so the canvas can reuse a finished image without the browser ever
 * holding its bytes. The path comes from the client, so it is checked rather
 * than trusted: an image extension is required (this host only writes images)
 * and the size is capped. It is not a general file-reading primitive.
 */
function readReferenceFile(path: string): Uint8Array {
  const extension = extname(path).toLowerCase()
  if (!REFERENCE_EXTENSIONS.has(extension)) {
    throw new Error(`参考图必须是图片文件：${basename(path)}`)
  }
  const info = statSync(path, { throwIfNoEntry: false })
  if (info === undefined || !info.isFile()) throw new Error(`参考图不存在：${basename(path)}`)
  if (info.size > REFERENCE_MAX_BYTES) throw new Error(`参考图过大：${basename(path)}`)
  const bytes = readFileSync(path)
  if (bytes.byteLength === 0) throw new Error(`参考图内容为空：${basename(path)}`)
  return new Uint8Array(bytes)
}

/** Turn wire references into the adapter's payload shape. */
function referencePayloads(references: readonly StudioReferencePayload[] | undefined): ReferenceImagePayload[] {
  if (references === undefined || references.length === 0) return []
  if (references.length > STUDIO_MAX_REFERENCES) {
    throw new Error(`最多支持 ${String(STUDIO_MAX_REFERENCES)} 张参考图`)
  }
  return references.map((reference, index) => ({
    bytes: typeof reference.path === 'string' && reference.path.length > 0
      ? readReferenceFile(reference.path)
      : decodeBase64(reference.data ?? ''),
    mime: typeof reference.mediaType === 'string' && reference.mediaType.length > 0 ? reference.mediaType : 'image/png',
    label: reference.name ?? (typeof reference.path === 'string' ? basename(reference.path) : undefined) ?? `参考图 ${String(index + 1)}`,
  }))
}

/** Name prefix for the files one run writes; keeps Studio output distinguishable. */
function outputPrefix(referenceCount: number): string {
  return referenceCount > 0 ? 'studio-edit' : 'studio'
}

/**
 * Run one Studio generation end to end.
 *
 * The order matters: canvas and prompt are validated **before** any socket
 * opens, so a malformed request never costs a ComfyUI round trip, and the
 * images are written only after every byte came back, so a partial run leaves no
 * half-written file (the writer already stages through `.partial-*` + rename).
 *
 * @param settings - resolved Studio settings (endpoint, limits, output dir).
 * @param input - the validated request body.
 * @param signal - cancellation; forwarded to every ComfyUI call.
 * @returns the written images plus the exact parameters that produced them.
 * @throws With the user-facing message the panel shows verbatim.
 */
export async function runStudioGeneration(
  settings: StudioSettings,
  input: StudioGenerateRequest,
  signal: AbortSignal,
): Promise<StudioGenerateResponse> {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (prompt.length === 0) throw new Error('请输入提示词')
  if (prompt.length > STUDIO_MAX_PROMPT_CHARS) {
    throw new Error(`提示词最多 ${String(STUDIO_MAX_PROMPT_CHARS)} 个字符`)
  }
  const size = studioSize(input.ratio)
  if (size === undefined) throw new Error(`不支持的画幅比例：${String(input.ratio)}`)
  const steps = resolveStudioSteps(settings, input.steps)
  const count = input.count === undefined ? 1 : Math.trunc(input.count)
  if (!Number.isFinite(count) || count < 1 || count > STUDIO_MAX_COUNT) {
    throw new Error(`出图张数只能是 1 到 ${String(STUDIO_MAX_COUNT)}`)
  }
  const seed = input.seed === undefined || !Number.isFinite(input.seed)
    ? Math.floor(Math.random() * 2 ** 31)
    : Math.trunc(input.seed)
  const references = referencePayloads(input.references)
  const mode: 'generate' | 'edit' = references.length > 0 ? 'edit' : 'generate'

  const startedAt = Date.now()
  const options = comfyOptionsOf(settings)
  let target: ComfyTarget
  let models: ComfyModels
  let images: GeneratedImage[]
  try {
    target = await discoverComfyUi(options, signal)
    models = await loadComfyModels(target, options, signal)
    // `turbo` is a preference: it needs a turbo unet installed, and with only
    // the base weights present the run falls back rather than failing — the
    // same rule the Agent tools apply.
    const turbo = settings.comfyModel === 'turbo' && turboUnetOf(models) !== undefined
    // Built inline at each call site, mirroring `tools.ts`: the resolved `steps`
    // goes on the wire as a literal field, so no dispatch site can forward a
    // request whose step count was never resolved. `test/settings.test.mjs`
    // pins that shape across the whole bundle.
    images = mode === 'edit'
      ? await (turbo ? generateViaComfyUiTurboEdit : generateViaComfyUiEdit)(
        target,
        models,
        {
          prompt,
          width: size.width,
          height: size.height,
          count,
          steps,
          seed,
          images: references,
        },
        options,
        signal,
      )
      : await (turbo ? generateViaComfyUiTurbo : generateViaComfyUi)(
        target,
        models,
        {
          prompt,
          width: size.width,
          height: size.height,
          count,
          steps,
          seed,
        },
        options,
        signal,
      )
  } catch (error) {
    // The adapter's messages are multi-line and already name the fix; keep only
    // the first line on the wire so a long traceback cannot bloat the response.
    throw new Error(firstLine(error))
  }

  const written = await writeImages(settings.outputDir, outputPrefix(references.length), size.width, size.height, images)

  // Record the run on a board. This is deliberately after the bytes are on disk
  // and deliberately non-fatal: a read-only or broken metadata directory must
  // still return the images the GPU just spent a minute producing.
  const itemIds = written.map(() => makeItemId())
  let board: BoardSummary | undefined
  let boardNote: string | undefined
  try {
    const requested = typeof input.board === 'string' && input.board.trim().length > 0 ? input.board.trim() : undefined
    const target = requested ?? (await activeBoardId(settings.outputDir)) ?? undefined
    const recorded = await recordItems(settings.outputDir, target, written.map((image, index) => ({
      id: itemIds[index],
      path: image.path,
      markdownPath: image.markdownPath,
      width: size.width,
      height: size.height,
      bytes: image.bytes,
      mediaType: image.mime,
      prompt,
      ratio: size.ratio,
      steps,
      seed,
      mode,
      backend: 'studio',
      parents: [],
      sessionId: null,
    })), { prompt })
    board = recorded.board
    // An existing file keeps its original item id; adopt it so a node's layout
    // and its asset record can never disagree.
    recorded.items.forEach((item, index) => { itemIds[index] = item.id })
  } catch (error) {
    boardNote = firstLine(error)
  }

  return {
    images: written.map((image, index) => ({
      id: itemIds[index] ?? makeItemId(),
      path: image.path,
      markdownPath: image.markdownPath,
      width: size.width,
      height: size.height,
      bytes: image.bytes,
      // The writer keeps the extension fixed at `.png`; the sniffed container is
      // reported so the panel does not have to guess when ComfyUI answered JPEG.
      mediaType: image.mime,
    })),
    prompt,
    ratio: size.ratio,
    width: size.width,
    height: size.height,
    steps,
    seed,
    elapsedMs: Date.now() - startedAt,
    endpoint: target.endpoint,
    mode,
    ...(board === undefined ? {} : { board }),
    ...(boardNote === undefined ? {} : { boardNote }),
  }
}
