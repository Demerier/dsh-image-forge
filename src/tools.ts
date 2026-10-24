/**
 * The `qwen_image_*` tool surface.
 *
 * `qwen_image_generate` is the only entry point that produces an image, and its
 * first-class `wh_ratio` parameter is the product's reason to exist: the Qwen
 * prompt contract already answers in `wh_ratio` terms, so the caller hands that
 * value straight to the tool instead of translating it into pixels by hand.
 * `width`/`height` remain available as an explicit override.
 *
 * There is exactly one backend: the user's own local ComfyUI. The cloud-API
 * client was removed with its config fields — Qwen-Image editing only exists on
 * the local graph, and a text-to-image-only cloud path doubled the surface for
 * half the product. Every tool below talks to `comfyui.ts` and nothing else.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_COMFY_PORTS,
  comfySystemStats,
  discoverComfyUi,
  generateViaComfyUi,
  generateViaComfyUiEdit,
  generateViaComfyUiTurbo,
  generateViaComfyUiTurboEdit,
  loadComfyModels,
  probeComfyUi,
  turboUnetOf,
  TURBO_STEPS,
  type ComfyModels,
  type ComfyOptions,
} from './comfyui.ts'
import type { GeneratedImage } from './images.ts'
import { sanitizePrefix, writeImages, type WrittenImage } from './output.ts'
import { makeItemId, recordItems } from './boards.ts'
import { MAX_REFERENCES, loadReferenceImages, probeImageSize, resolveRatioFollow, type ReferenceImage } from './refs.ts'
import {
  MAX_SIDE,
  MIN_SIDE,
  SIZE_MULTIPLE,
  WH_RATIOS,
  nearestRatio,
  resolveDefaultSize,
  validateSize,
} from './ratio.ts'
import type { Config } from './index.ts'

/** Everything `qwen_image_generate` accepts, as one schema reused by validation. */
const GENERATE_PARAMETERS: ParameterSchemaSpec = {
  prompt: {
    type: 'string',
    required: true,
    description:
      '成品提示词（已经按 Qwen 提示词契约改写好的那一段描述性散文）。本工具不做改写——' +
      '把口语需求翻译成契约提示词是 skill `qwen-image-forge` 的职责，改写结果里的 wh_ratio 直接传给本参数旁边的 wh_ratio。',
  },
  wh_ratio: {
    type: 'string',
    enum: WH_RATIOS,
    description:
      '画幅比（一等参数，官方 7 档）：1:1 / 4:3 / 3:4 / 3:2 / 2:3 / 16:9 / 9:16。' +
      '本插件按 ~1.5MP 预算换算成 32 对齐的像素尺寸（换算表见 skill `qwen-image-forge` 正文「画幅比与像素」一节），' +
      '因此契约里的 wh_ratio 不需要人工换算成宽高。省略时用 1:1；给了 width/height 时以 width/height 为准。',
  },
  width: {
    type: 'integer',
    description: `显式覆盖宽度（像素）。必须与 height 成对给出，且为 ${SIZE_MULTIPLE} 的倍数、位于 ${MIN_SIDE}–${MAX_SIDE}；不合法时会报错并给出最近的合法值。`,
  },
  height: {
    type: 'integer',
    description: `显式覆盖高度（像素）。规则同 width，必须与 width 成对给出。`,
  },
  steps: {
    type: 'integer',
    description:
      '采样步数；省略则按配置解析：`comfyuiSteps` → 默认 `defaultSteps`（默认 25）；`comfyModel: "turbo"` 时是 `turboSteps` → 8。' +
      '结果里的 `steps_used` 与 `steps_source` 会说明实际用了多少、以及它来自哪一层。仅当你明确知道该模型的建议值时再传。',
  },
  seed: {
    type: 'integer',
    description: '随机种子；同一 seed + 同一 prompt + 同一尺寸可复现同一张图。省略即随机。',
  },
  count: {
    type: 'integer',
    description: '出图张数，1–4，默认 1。多张按后端返回顺序编号落盘。',
  },
  preset: {
    type: 'string',
    description: '落盘文件名前缀标签，例如 "poster"；只影响命名（<outputDir>/<前缀>_<W>x<H>_<n>.png），不影响生成参数。省略时为 "qwen"。',
  },
  board: {
    type: 'string',
    description:
      '画板 id 或名字——画板是成果的存储与显示单位（一个题材/一个项目一个画板），工作台的画布和素材页都按它组织。' +
      '**省略就新建一个画板**（用提示词首行命名），结果里的 board.id 就是它；同一组图继续出图时把那个 id 传回来，' +
      '成果才会落在同一个画板里，而不是又开一个。',
  },
}

/** Everything `qwen_image_edit` accepts. */
const EDIT_PARAMETERS: ParameterSchemaSpec = {
  prompt: {
    type: 'string',
    required: true,
    description:
      '成品**修改指令**（已经按 Qwen 改图契约改写好的那一段，一整段、不要换行）。本工具不做改写——' +
      '把口语需求翻译成改图契约是 skill `qwen-image-forge` 的职责（见 references/edit_rules.md）：' +
      '只动点名要改的属性、其余按输入锁住，N ≥ 2 张参考图时用 `<image1>`、`<image2>`… 指代。',
  },
  images: {
    type: 'array',
    items: { type: 'string' },
    required: true,
    description:
      `参考图，1–${MAX_REFERENCES} 张，按顺序对应提示词里的 \`<image1>\`…\`<imageN>\`（第 1 张是编辑目标）。` +
      '每一项要么是**绝对路径**（如 D:\\pictures\\ref.png），要么是 `data:image/png;base64,…`。' +
      '缺文件、不可读、不是 PNG/JPEG/WebP、超过上限都会**明确报错并点名第几张**，不会静默丢图——' +
      '丢一张就会让提示词里的 `<imageN>` 全部错位。',
  },
  ratio_follow: {
    type: 'string',
    description:
      '画布跟随某张参考图的宽高比：写官方的 `image1`…`image10`（第 N 张参考图），' +
      '或直接写 `images` 里的那一项（绝对路径 / data URI）。本插件把该图的实际长宽比量出来，' +
      '再挑 32 对齐像素里最接近的一对作为画布（偏差写进返回的 ratio_deviation_percent）。' +
      '**与 wh_ratio 互斥**（官方契约里这两者一个非空另一个必须为空）；' +
      '两个都不给时默认跟随**第一张**参考图（改图场景最符合直觉）。给了 width/height 时以它们为准。',
  },
  wh_ratio: {
    type: 'string',
    enum: WH_RATIOS,
    description:
      `画布固定比例（官方 7 档）：${WH_RATIOS.join(' / ')}。与 ratio_follow **互斥**；` +
      '本插件按 ~1.5MP 预算换算成 32 对齐的像素尺寸。省略且没给 ratio_follow 时，默认跟随第一张参考图（不是 1:1）。' +
      '七档画布在 ComfyUI 改图工作流上都能跑；参考图会先缩放到与画布同量级再进条件化（官方模板的要求）。',
  },
  width: {
    type: 'integer',
    description: `显式覆盖宽度（像素）。必须与 height 成对给出，且为 ${SIZE_MULTIPLE} 的倍数、位于 ${MIN_SIDE}–${MAX_SIDE}；给了就以 width/height 为准（此时 ratio_follow / wh_ratio 被覆盖）。`,
  },
  height: {
    type: 'integer',
    description: '显式覆盖高度（像素）。规则同 width，必须与 width 成对给出。',
  },
  steps: {
    type: 'integer',
    description:
      '采样步数；省略则按配置解析：`comfyuiSteps` → 默认 `defaultSteps`（默认 25）；`comfyModel: "turbo"` 时是 `turboSteps` → 8。' +
      '结果里的 `steps_used` 与 `steps_source` 会说明实际用了多少、以及它来自哪一层。仅当你明确知道该模型的建议值时再传。',
  },
  seed: {
    type: 'integer',
    description: '随机种子；同一 seed + 同一 prompt + 同一参考图 + 同一尺寸可复现同一张图。省略即随机。',
  },
  count: {
    type: 'integer',
    description: '出图张数，1–4，默认 1。多张共用同一组参考图，按后端返回顺序编号落盘。',
  },
  preset: {
    type: 'string',
    description: '落盘文件名前缀标签，例如 "retouch"；只影响命名（<outputDir>/<前缀>_<W>x<H>_<n>.png）。省略时为 "edit"。',
  },
  board: {
    type: 'string',
    description:
      '画板 id 或名字。**省略就新建一个画板**；改图通常应落在参考图所在的那个画板里——' +
      '如果你知道上一次出图返回的 board.id，就把它传进来，新图和它的来源才会在同一块画布上连起来。',
  },
}

/** Coerce a caller value that the schema may hand over as a loose number. */
function asInteger(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer, got ${value}`)
  return value
}

/** Validate `count`, failing loudly instead of silently clamping. */
function validateCount(count: number | undefined): number {
  if (count === undefined) return 1
  if (!Number.isInteger(count) || count < 1 || count > 4) {
    throw new Error(`count must be an integer between 1 and 4, got ${count}`)
  }
  return count
}

/**
 * Coerce a tool payload into **lossless JSON**.
 *
 * The DSH tool layer rejects a result whose value does not round-trip through
 * JSON, and an object that still carries `undefined` properties does not:
 * `JSON.stringify` drops the key, so `parse(stringify(x))` is missing it. A
 * real client run of `qwen_image_status` failed exactly that way once
 * (`value is not lossless JSON`) — this helper is the mechanical guarantee
 * that a tool never hands the layer such a value again. `undefined` becomes
 * `null` at every depth; everything else is left alone.
 *
 * @param value - the payload `execute` wants to return.
 * @returns the same shape with `undefined` replaced by `null`.
 */
function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, inner) => (inner === undefined ? null : inner))) as T
}

/** Build the Markdown block the model can paste into its reply verbatim. */
export function renderMarkdown(images: readonly { markdownPath: string }[]): string {
  return images.map((image) => `![generated image](${image.markdownPath})`).join('\n')
}

/** What a run recorded, in the shape the tool payload exposes. */
interface BoardRecording {
  board: { id: string; name: string; created: boolean; item_ids: string[] } | null
  note: string | null
  ids: string[]
}

/** First line of a failure, so the board note stays a note. */
function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.split(/\r?\n/, 1)[0] ?? text
}

/** Session id the host gave this call, when it gave one. */
function sessionOf(exec: { agent?: { id?: unknown } }): string | undefined {
  const id = exec.agent?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Record one run's images on a board.
 *
 * Deliberately non-fatal: the PNGs are already on disk, and a metadata failure
 * must not turn a successful draw into a tool error. The note travels back in
 * the payload so the failure is visible rather than silent.
 *
 * `requested` absent means **a new board** — the conversation path never
 * guesses at the panel's open board, because the model is the only one who
 * knows whether this draw continues the previous subject or starts a new one.
 *
 * @param outputDir - where the images and the board library live.
 * @param requested - board id/name from the caller, or `undefined`.
 * @param written - files already on disk.
 * @param meta - provenance stored on every item.
 * @returns ids in output order, the board summary, and any failure note.
 */
async function recordRun(
  outputDir: string,
  requested: string | undefined,
  written: readonly WrittenImage[],
  meta: {
    prompt: string
    width: number
    height: number
    ratio: string
    steps: number
    seed: number | undefined
    mode: 'generate' | 'edit'
    sessionId: string | undefined
  },
): Promise<BoardRecording> {
  const ids = written.map(() => makeItemId())
  try {
    const recorded = await recordItems(outputDir, requested, written.map((image, index) => ({
      id: ids[index],
      path: image.path,
      markdownPath: image.markdownPath,
      width: meta.width,
      height: meta.height,
      bytes: image.bytes,
      mediaType: image.mime,
      prompt: meta.prompt,
      ratio: meta.ratio,
      steps: meta.steps,
      seed: meta.seed ?? null,
      mode: meta.mode,
      backend: 'comfyui',
      parents: [],
      sessionId: meta.sessionId ?? null,
    })), { prompt: meta.prompt, sessionId: meta.sessionId ?? null })
    recorded.items.forEach((item, index) => { ids[index] = item.id })
    return {
      board: { id: recorded.board.id, name: recorded.board.name, created: recorded.created, item_ids: ids },
      note: null,
      ids,
    }
  } catch (error) {
    return { board: null, note: reasonOf(error), ids }
  }
}

/** Resolved canvas plus how it was chosen, for the result payload. */
interface ChosenSize {
  readonly width: number
  readonly height: number
  readonly sizeSource: 'wh_ratio' | 'explicit-size'
  readonly whRatio: string
  readonly ratioDeviationPercent: number
  readonly exactRatio: boolean
}

/**
 * Decide the output size from `wh_ratio` and/or an explicit width/height pair.
 *
 * @param whRatio - caller ratio; defaults to `1:1` when nothing was supplied.
 * @param width - explicit width, if any.
 * @param height - explicit height, if any.
 * @returns the aligned size and the provenance of the decision.
 * @throws When only one of width/height is given, or a side is not 32-aligned.
 */
export function chooseSize(whRatio: string | undefined, width: number | undefined, height: number | undefined): ChosenSize {
  if ((width === undefined) !== (height === undefined)) {
    throw new Error('width and height must be given together; pass neither to use wh_ratio')
  }
  if (width !== undefined && height !== undefined) {
    const size = validateSize(width, height)
    const nearest = nearestRatio(size.width, size.height)
    return {
      width: size.width,
      height: size.height,
      sizeSource: 'explicit-size',
      whRatio: nearest.whRatio,
      ratioDeviationPercent: nearest.deviationPercent,
      exactRatio: Math.abs(nearest.deviationPercent) < 0.001,
    }
  }
  const ratio = whRatio ?? '1:1'
  const size = resolveDefaultSize(ratio)
  return {
    width: size.width,
    height: size.height,
    sizeSource: 'wh_ratio',
    whRatio: ratio,
    ratioDeviationPercent: size.ratioDeviationPercent,
    exactRatio: size.exact,
  }
}

/** Canvas decision for an edit call, plus where the ratio came from. */
export interface EditSizeChoice {
  /** Aligned width in pixels. */
  readonly width: number
  /** Aligned height in pixels. */
  readonly height: number
  /** Which input decided the canvas. */
  readonly sizeSource: 'wh_ratio' | 'explicit-size' | 'ratio_follow'
  /** Official tier closest to the chosen canvas, for continuity with `qwen_image_generate`. */
  readonly whRatio: string
  /** Signed deviation of the canvas from the ratio that was asked for, in percent. */
  readonly ratioDeviationPercent: number
  /** True when the canvas reproduces the asked-for ratio exactly. */
  readonly exactRatio: boolean
  /** The reference the canvas followed, when `sizeSource` is `ratio_follow`. */
  readonly followed: ReferenceImage | null
  /** True when the caller asked for neither a ratio nor a size. */
  readonly followedByDefault: boolean
}

/**
 * Decide an edit call's canvas: explicit size, then `wh_ratio`, then `ratio_follow`.
 *
 * `wh_ratio` and `ratio_follow` are mutually exclusive — the prompt contract
 * itself says one must be empty whenever the other is set — so supplying both is
 * an error rather than a silent winner. `width`/`height` stay the plugin-level
 * override they already are for `qwen_image_generate`, which is why they beat
 * both ratio forms.
 *
 * @param whRatio - fixed ratio, if the caller gave one.
 * @param ratioFollow - reference to follow, if the caller gave one.
 * @param width - explicit width, if any.
 * @param height - explicit height, if any.
 * @param references - the loaded reference images, in prompt order.
 * @returns the aligned canvas and the provenance of the decision.
 * @throws When `wh_ratio` and `ratio_follow` are both set, when only one of
 *   width/height is given, when an explicit side is illegal, or when
 *   `ratio_follow` names something the call does not carry.
 */
export function chooseEditSize(
  whRatio: string | undefined,
  ratioFollow: string | undefined,
  width: number | undefined,
  height: number | undefined,
  references: readonly ReferenceImage[],
): EditSizeChoice {
  const ratio = whRatio?.trim()
  const follow = ratioFollow?.trim()
  if (ratio !== undefined && ratio.length > 0 && follow !== undefined && follow.length > 0) {
    throw new Error(
      `wh_ratio 与 ratio_follow 不能同时给（收到 wh_ratio="${ratio}"、ratio_follow="${follow}"）。\n` +
        '  官方提示词契约把这两个字段定义成互斥的一对：ratio_follow 表示「画布跟随某张参考图的长宽比」，' +
        'wh_ratio 表示「画布用这个固定比例」，两者都在指定画布比例，同时给出等于给了两个互相矛盾的口令，' +
        '契约明说「一个非空另一个必须是空字符串」。请只留一个：\n' +
        '    • 跟随参考图 → 去掉 wh_ratio，保留 ratio_follow（或两者都不给，默认跟随第一张参考图）\n' +
        '    • 固定比例   → 去掉 ratio_follow，保留 wh_ratio',
    )
  }
  if (width !== undefined || height !== undefined) {
    const size = chooseSize(undefined, width, height)
    return { ...size, followed: null, followedByDefault: false }
  }
  const defaulted = (follow === undefined || follow.length === 0) && (ratio === undefined || ratio.length === 0)
  if (defaulted || (follow !== undefined && follow.length > 0)) {
    const reference = defaulted ? (references[0] as ReferenceImage) : resolveRatioFollow(follow as string, references)
    if (reference === undefined) throw new Error('ratio_follow needs at least one reference image')
    const size = resolveDefaultSize(`${reference.width}:${reference.height}`)
    return {
      width: size.width,
      height: size.height,
      sizeSource: 'ratio_follow',
      whRatio: nearestRatio(size.width, size.height).whRatio,
      ratioDeviationPercent: size.ratioDeviationPercent,
      exactRatio: size.exact,
      followed: reference,
      followedByDefault: defaulted,
    }
  }
  const size = chooseSize(ratio, undefined, undefined)
  return { ...size, followed: null, followedByDefault: false }
}

/** Settings the tool bodies need, resolved from the plugin config. */
export interface ForgeSettings {
  readonly comfyEndpoint: string
  readonly comfyPorts: readonly number[]
  readonly comfyModelsDir: string
  readonly outputDir: string
  readonly timeoutMs: number
  /** Sampler steps used when neither the caller nor a backend override picks one. */
  readonly defaultSteps: number
  /** ComfyUI step override; undefined falls through to `defaultSteps`. */
  readonly comfyuiSteps: number | undefined
  /** Which checkpoint family to ask for; a turbo unet must be installed to matter. */
  readonly comfyModel: 'base' | 'turbo'
  /** Turbo step override; `undefined` means the distilled default (8). */
  readonly turboSteps: number | undefined
}

/**
 * Parse the comma-separated `comfyPorts` value into candidate ports.
 *
 * Anything that is not a usable port number is ignored rather than rejected: a
 * typo in the config must not stop the plugin from loading, and the default list
 * is the documented behaviour.
 *
 * @param raw - config value, e.g. `8000,8188`.
 * @returns distinct valid ports, or the defaults when none survive.
 */
function parseComfyPorts(raw: string): number[] {
  const ports = new Set<number>()
  for (const part of raw.split(/[,\s]+/)) {
    const port = Number(part.trim())
    if (part.trim().length > 0 && Number.isInteger(port) && port >= 1 && port <= 65535) ports.add(port)
  }
  return ports.size > 0 ? [...ports] : [...DEFAULT_COMFY_PORTS]
}

/** Everything the ComfyUI client needs from the resolved config. */
function comfyOptions(settings: ForgeSettings, timeoutMs = settings.timeoutMs): ComfyOptions {
  return {
    endpoint: settings.comfyEndpoint,
    ports: settings.comfyPorts,
    modelsDir: settings.comfyModelsDir,
    timeoutMs,
  }
}

/**
 * Resolve everything the tool bodies need from the plugin config.
 *
 * @param config - the resolved plugin config.
 * @returns the subset the tools read.
 */
export function resolveSettings(config: Config): ForgeSettings {
  return {
    comfyEndpoint: config.comfyEndpoint.replace(/\/+$/, ''),
    comfyPorts: parseComfyPorts(config.comfyPorts),
    comfyModelsDir: config.comfyModelsDir,
    outputDir: config.outputDir,
    timeoutMs: config.timeoutMs,
    defaultSteps: config.defaultSteps,
    comfyuiSteps: config.comfyuiSteps,
    comfyModel: config.comfyModel,
    turboSteps: config.turboSteps,
  }
}

/** Where a call's sampler-step count came from, for the result payload. */
export type StepsSource = 'explicit' | 'backend' | 'default'

/** The resolved step count for one backend, and its provenance. */
export interface StepsResolution {
  /** The count to send. */
  readonly steps: number
  /** Which of the three inputs supplied it. */
  readonly source: StepsSource
}

/**
 * Resolve the sampler steps one call should use.
 *
 * Priority: the caller's explicit `steps` > the ComfyUI override
 * (`comfyuiSteps`) > `defaultSteps`.
 *
 * @param explicit - the caller's `steps`, when it supplied one.
 * @param settings - the resolved plugin settings.
 * @returns the count and where it came from.
 */
export function resolveSteps(explicit: number | undefined, settings: ForgeSettings): StepsResolution {
  if (explicit !== undefined) return { steps: explicit, source: 'explicit' }
  if (typeof settings.comfyuiSteps === 'number' && Number.isFinite(settings.comfyuiSteps) && settings.comfyuiSteps >= 1) {
    return { steps: Math.round(settings.comfyuiSteps), source: 'backend' }
  }
  return { steps: settings.defaultSteps, source: 'default' }
}

/**
 * Steps for the turbo checkpoint: its own override, else the distilled default.
 *
 * Deliberately does **not** fall through to `defaultSteps` or `comfyuiSteps`:
 * those are tuned for the base checkpoint (25), and handing 25 steps to a
 * checkpoint distilled for 8 makes the picture worse, not better. An explicit
 * `steps` from the caller still wins, because that is how the turbo contract
 * gets checked on a real card.
 *
 * @param explicit - the caller's `steps`, when it supplied one.
 * @param settings - the resolved plugin settings.
 * @returns the count and where it came from.
 */
export function resolveTurboSteps(explicit: number | undefined, settings: ForgeSettings): StepsResolution {
  if (explicit !== undefined) return { steps: explicit, source: 'explicit' }
  if (typeof settings.turboSteps === 'number' && Number.isFinite(settings.turboSteps) && settings.turboSteps >= 1) {
    return { steps: Math.round(settings.turboSteps), source: 'backend' }
  }
  return { steps: TURBO_STEPS, source: 'default' }
}

/** The tool-output blocks shared by generate and edit: summary, markdown, JSON. */
function renderResultBlocks(value: { markdown?: string; summary?: string }): { type: 'text'; text: string }[] {
  const payload = value as { markdown?: string; summary?: string }
  const blocks: { type: 'text'; text: string }[] = []
  if (typeof payload.summary === 'string') blocks.push({ type: 'text', text: payload.summary })
  if (typeof payload.markdown === 'string' && payload.markdown.length > 0) {
    blocks.push({
      type: 'text',
      text: `已在对话里内联显示请**逐字复制**下面这几行到你的回复正文（客户端会把本地绝对路径渲染成图片）：\n${payload.markdown}`,
    })
  }
  blocks.push({ type: 'text', text: JSON.stringify(value, null, 2) })
  return blocks
}

/** The ComfyUI run report shared by both tools. */
interface ComfyRunReport {
  endpoint: string
  port: number
  probed: unknown
  models: ComfyModels
  comfyModel: 'turbo' | 'base'
  turbo_fallback?: string
  references_uploaded?: string[]
  elapsed_ms: number
}

/**
 * Register the tools on the tool registry.
 *
 * @param ctx - cordis context providing `tools`.
 * @param getConfig - reads the activation's config **per call**: a settings
 *   save commits into the volatile references without re-running `apply`, so a
 *   snapshot taken at registration time would ignore every later edit.
 */
export function registerImageForgeTools(ctx: Context, getConfig: () => Config): void {
  ctx.tools.register(defineTool({
    name: 'qwen_image_generate',
    description:
      '用 Qwen-Image 出图（本机 ComfyUI）。`prompt` 收**成品**提示词（本工具不改写），`wh_ratio` 是**一等参数**：' +
      `直接接受官方契约的 7 档画幅比（${WH_RATIOS.join(' / ')}），插件自己换算成 ${SIZE_MULTIPLE} 对齐的像素尺寸——` +
      '所以「契约输出 → 插件入参」不需要人工翻译。省略 wh_ratio 用 1:1，给了 width/height 则以它们为准。' +
      '结果落盘到配置的 outputDir 并把绝对路径写进正文 Markdown，同时回传结构化字段。' +
      '需要本机 ComfyUI 已启动且装好三个 Qwen-Image 权重（部署见 docs/comfyui-deployment.md）。',
    parameters: GENERATE_PARAMETERS,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderResultBlocks(value),
    },
    // The per-generation budget covers ComfyUI's queue and sampling.
    timeoutMs: getConfig().timeoutMs,
    // One generation is a heavy, rate-limited call; never overlap siblings.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const settings = resolveSettings(getConfig())
      const prompt = args.prompt.trim()
      if (prompt.length === 0) throw new Error('prompt must not be blank')
      const size = chooseSize(args.wh_ratio, asInteger(args.width, 'width'), asInteger(args.height, 'height'))
      const count = validateCount(args.count)
      const steps = asInteger(args.steps, 'steps')
      if (steps !== undefined && steps < 1) throw new Error(`steps must be >= 1, got ${steps}`)
      const request = {
        prompt,
        width: size.width,
        height: size.height,
        count,
        steps,
        seed: asInteger(args.seed, 'seed'),
      }
      const startedAt = Date.now()

      // Resolve the step count before touching ComfyUI so no dispatch site can
      // forward a request whose step count was never resolved.
      const options = comfyOptions(settings)
      const target = await discoverComfyUi(options, exec.signal)
      const models: ComfyModels = await loadComfyModels(target, options, exec.signal)
      const comfyStartedAt = Date.now()
      // Which checkpoint family to run. `turbo` is a *request*, not a
      // guarantee: it needs a turbo unet to be installed, and when only the
      // base weights are present the run falls back rather than failing —
      // the alternative is a config typo turning into "no images at all".
      const turbo = settings.comfyModel === 'turbo' && turboUnetOf(models) !== undefined
      const turboSkipped = settings.comfyModel === 'turbo' && !turbo
      const usedSteps = turbo ? resolveTurboSteps(steps, settings) : resolveSteps(steps, settings)
      const images = turbo
        ? await generateViaComfyUiTurbo(target, models, { ...request, steps: usedSteps.steps }, options, exec.signal)
        : await generateViaComfyUi(target, models, { ...request, steps: usedSteps.steps }, options, exec.signal)
      const comfyRun: ComfyRunReport = {
        endpoint: target.endpoint,
        port: target.port,
        probed: target.probed,
        models,
        comfyModel: turbo ? 'turbo' : 'base',
        ...(turboSkipped ? { turbo_fallback: '已选 turbo，但 /object_info 里没有 turbo 权重，本次用 base 跑' } : {}),
        elapsed_ms: Date.now() - comfyStartedAt,
      }
      const backendLabel = `后端 comfyui / ${target.endpoint} / ${models.unet}${turbo ? '（turbo）' : ''}`

      const prefix = sanitizePrefix(args.preset)
      const written = await writeImages(settings.outputDir, prefix, size.width, size.height, images)
      const markdown = renderMarkdown(written)
      const recording = await recordRun(settings.outputDir, args.board, written, {
        prompt,
        width: size.width,
        height: size.height,
        ratio: size.whRatio,
        steps: usedSteps.steps,
        seed: request.seed,
        mode: 'generate',
        sessionId: sessionOf(exec),
      })

      return jsonSafe({
        ok: true,
        backend: 'comfyui',
        model: models.unet,
        wh_ratio: size.whRatio,
        wh_ratio_requested: args.wh_ratio ?? null,
        size: { width: size.width, height: size.height },
        size_source: size.sizeSource,
        ratio_deviation_percent: size.ratioDeviationPercent,
        exact_ratio: size.exactRatio,
        count,
        steps: steps ?? null,
        steps_used: usedSteps.steps,
        steps_source: usedSteps.source,
        seed: request.seed ?? null,
        prompt_chars: prompt.length,
        output_dir: settings.outputDir,
        images: written.map((image) => ({
          index: image.index,
          path: image.path,
          bytes: image.bytes,
          mime: image.mime,
        })),
        comfyui: comfyRun,
        board: recording.board,
        board_note: recording.note,
        markdown,
        summary:
          `出图完成：${written.length} 张，${size.width}×${size.height}（wh_ratio ${size.whRatio}` +
          `${size.exactRatio ? '' : `，实际 ${size.ratioDeviationPercent > 0 ? '+' : ''}${size.ratioDeviationPercent}%`}），` +
          `${backendLabel}，落盘 ${settings.outputDir}。` +
          (recording.board === null
            ? '画板未记录（见 board_note）。'
            : `画板「${recording.board.name}」${recording.board.created ? '（新建）' : ''}，id \`${recording.board.id}\`。`),
        elapsed_ms: Date.now() - startedAt,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qwen_image_edit',
    description:
      '用 Qwen-Image 2.1 做**参考图编辑（图生图）**，在本机 ComfyUI 的官方改图工作流上运行：' +
      '给 1 张或多张参考图 + 一段**成品修改指令**，出改好的图。' +
      `\`images\` 收 1–${MAX_REFERENCES} 张参考图（绝对路径或 data:image/…;base64,…，按顺序对应提示词里的 \`<image1>\`…\`<imageN>\`），` +
      '`ratio_follow` 让画布**跟随某张参考图的宽高比**（写 `image1`…`image10`，或直接把 `images` 里的那一项再写一遍）；' +
      '它与 `wh_ratio` **互斥**（官方契约里一个非空另一个必须为空），两个都不给时**默认跟随第一张参考图**。' +
      '参考图先上传进 ComfyUI 的 input/ 目录。' +
      '部署（ComfyUI 桌面版 + 三个权重）见 docs/comfyui-deployment.md。' +
      '结果落盘到 outputDir 并把绝对路径写进正文 Markdown。',
    parameters: EDIT_PARAMETERS,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderResultBlocks(value),
    },
    // Same reasoning as `qwen_image_generate`.
    timeoutMs: getConfig().timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const settings = resolveSettings(getConfig())
      const prompt = args.prompt.trim()
      if (prompt.length === 0) throw new Error('prompt must not be blank')
      // Loaded before any backend is touched: a bad reference must fail here, where
      // the message can name which one it was, not inside a graph or a request body.
      const references = await loadReferenceImages(args.images)
      const size = chooseEditSize(
        args.wh_ratio,
        args.ratio_follow,
        asInteger(args.width, 'width'),
        asInteger(args.height, 'height'),
        references,
      )
      const count = validateCount(args.count)
      const steps = asInteger(args.steps, 'steps')
      if (steps !== undefined && steps < 1) throw new Error(`steps must be >= 1, got ${steps}`)
      const request = {
        prompt,
        width: size.width,
        height: size.height,
        count,
        steps,
        seed: asInteger(args.seed, 'seed'),
        images: references,
      }
      const startedAt = Date.now()

      const options = comfyOptions(settings)
      const target = await discoverComfyUi(options, exec.signal)
      const models: ComfyModels = await loadComfyModels(target, options, exec.signal)
      const comfyStartedAt = Date.now()
      const turbo = settings.comfyModel === 'turbo' && turboUnetOf(models) !== undefined
      const turboSkipped = settings.comfyModel === 'turbo' && !turbo
      const usedSteps = turbo ? resolveTurboSteps(steps, settings) : resolveSteps(steps, settings)
      const images = turbo
        ? await generateViaComfyUiTurboEdit(target, models, { ...request, steps: usedSteps.steps }, options, exec.signal)
        : await generateViaComfyUiEdit(target, models, { ...request, steps: usedSteps.steps }, options, exec.signal)
      const comfyRun: ComfyRunReport = {
        endpoint: target.endpoint,
        port: target.port,
        probed: target.probed,
        models,
        comfyModel: turbo ? 'turbo' : 'base',
        ...(turboSkipped ? { turbo_fallback: '已选 turbo，但 /object_info 里没有 turbo 权重，本次用 base 跑' } : {}),
        references_uploaded: references.map((reference) => reference.label),
        elapsed_ms: Date.now() - comfyStartedAt,
      }
      const backendLabel = `后端 comfyui / ${target.endpoint} / ${models.unet}${turbo ? '（turbo）' : ''}`

      const prefix = sanitizePrefix(args.preset, 'edit')
      const written = await writeImages(settings.outputDir, prefix, size.width, size.height, images)
      const markdown = renderMarkdown(written)
      const recording = await recordRun(settings.outputDir, args.board, written, {
        prompt,
        width: size.width,
        height: size.height,
        ratio: size.whRatio,
        steps: usedSteps.steps,
        seed: request.seed,
        mode: 'edit',
        sessionId: sessionOf(exec),
      })
      const followed = size.followed
      const followLabel = followed === null ? null : `image${followed.index}`

      return jsonSafe({
        ok: true,
        backend: 'comfyui',
        model: models.unet,
        wh_ratio: size.whRatio,
        wh_ratio_requested: args.wh_ratio ?? null,
        ratio_follow: followLabel,
        ratio_follow_requested: args.ratio_follow ?? null,
        ratio_follow_defaulted: size.followedByDefault,
        ratio_follow_image:
          followed === null
            ? null
            : { index: followed.index, source: followed.source, size: { width: followed.width, height: followed.height } },
        size: { width: size.width, height: size.height },
        size_source: size.sizeSource,
        ratio_deviation_percent: size.ratioDeviationPercent,
        exact_ratio: size.exactRatio,
        references: references.map((reference) => ({
          index: reference.index,
          source: reference.source,
          label: reference.label,
          mime: reference.mime,
          size: { width: reference.width, height: reference.height },
          bytes: reference.bytes.byteLength,
        })),
        count,
        steps: steps ?? null,
        steps_used: usedSteps.steps,
        steps_source: usedSteps.source,
        seed: request.seed ?? null,
        prompt_chars: prompt.length,
        output_dir: settings.outputDir,
        images: written.map((image) => {
          const measured = probeImageSize(images[image.index - 1]?.bytes ?? new Uint8Array())
          return {
            index: image.index,
            path: image.path,
            bytes: image.bytes,
            mime: measured?.mime ?? image.mime,
            width: measured?.width ?? null,
            height: measured?.height ?? null,
          }
        }),
        comfyui: comfyRun,
        board: recording.board,
        board_note: recording.note,
        markdown,
        summary:
          `改图完成：${written.length} 张，${size.width}×${size.height}（` +
          (followLabel === null
            ? `wh_ratio ${size.whRatio}`
            : `ratio_follow ${followLabel}${size.followedByDefault ? '（默认跟随第一张参考图）' : ''} ← ${followed?.width}×${followed?.height}`) +
          `${size.exactRatio ? '' : `，实际 ${size.ratioDeviationPercent > 0 ? '+' : ''}${size.ratioDeviationPercent}%`}），` +
          `${references.length} 张参考图，${backendLabel}，落盘 ${settings.outputDir}。` +
          (recording.board === null
            ? '画板未记录（见 board_note）。'
            : `画板「${recording.board.name}」${recording.board.created ? '（新建）' : ''}，id \`${recording.board.id}\`。`),
        elapsed_ms: Date.now() - startedAt,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qwen_image_status',
    description:
      '后端健康探测：**本机 ComfyUI 是否在跑**（含探测过哪几个端口、三个 Qwen-Image 权重能不能被它的加载器枚举到、' +
      '显卡型号与显存余量），以及输出目录能不能写。不产生任何图片、不写盘、不改配置。排障时先跑它。',
    parameters: {
      timeoutMs: {
        type: 'integer',
        description: '本次探测的超时预算（毫秒），默认取插件配置的 timeoutMs 与 10 秒中的较小值。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const settings = resolveSettings(getConfig())
      const budget = Math.min(args.timeoutMs ?? settings.timeoutMs, 30_000)
      // Passive on purpose: a status call must report, never start anything.
      const comfyui = await probeComfyUi(comfyOptions(settings, budget), exec.signal)
      const endpoint = typeof comfyui.endpoint === 'string' ? comfyui.endpoint : undefined
      // VRAM comes from ComfyUI itself rather than from `nvidia-smi`: the card
      // that matters is the one ComfyUI loaded its weights onto, and it reports
      // that number without this plugin spawning a process.
      const stats = endpoint === undefined
        ? null
        : await comfySystemStats(endpoint, Math.min(budget, 5000), exec.signal)
      const reachable = comfyui.reachable === true
      return jsonSafe({
        checked_at: new Date().toISOString(),
        comfyui: {
          modelsDir: settings.comfyModelsDir.length > 0 ? settings.comfyModelsDir : null,
          ...comfyui,
          version: stats?.version ?? null,
          devices: stats?.devices ?? null,
          stats_note: stats?.note ?? null,
        },
        output: { dir: settings.outputDir, writable: await ensureOutputDirWritable(settings.outputDir) },
        next_steps: reachable
          ? null
          : 'ComfyUI 没在跑。按 docs/comfyui-deployment.md 装桌面版、把三个权重放进它能看到的位置，然后重跑本工具。',
      })
    },
  }))
}

/** Create the output directory if needed and report whether it accepts writes. */
async function ensureOutputDirWritable(dir: string): Promise<boolean> {
  const { mkdir, writeFile, unlink } = await import('node:fs/promises')
  const { join } = await import('node:path')
  try {
    await mkdir(dir, { recursive: true })
    const probe = join(dir, `.dsh-image-forge-write-probe-${process.pid}`)
    await writeFile(probe, '')
    await unlink(probe)
    return true
  } catch {
    return false
  }
}
