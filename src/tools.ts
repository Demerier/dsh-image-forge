/**
 * The `image_forge_*` tool surface.
 *
 * `image_forge_generate` is the only entry point that produces an image, and its
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
  comfyOptionsOf as buildComfyOptions,
  comfySystemStats,
  discoverComfyUi,
  effectiveProfile,
  generateViaComfyUi,
  generateViaComfyUiEdit,
  generateViaComfyUiTurbo,
  generateViaComfyUiTurboEdit,
  loadComfyModels,
  NATIVE_SAMPLERS,
  NATIVE_SCHEDULERS,
  parseComfyPorts,
  probeComfyUi,
  resolveProfile,
  TURBO_STEPS,
  type ComfyModelChoice,
  type ComfyModels,
  type NativeScheduler,
  type NativeSampler,
} from './comfyui.ts'
import { parseMossLayout, presetSteps, type ModelProfile, type MossSamplingPreset } from './model-profiles.ts'
import type { GeneratedImage } from './images.ts'
import { sanitizePrefix, writeImages, type WrittenImage } from './output.ts'
import { makeItemId, recordItems } from './boards.ts'
import { firstLine } from './studio-shared.ts'
import { MAX_REFERENCES, loadReferenceImages, probeImageSize, resolveRatioFollow, type ReferenceImage } from './refs.ts'
import {
  DEFAULT_SIZE_TIER,
  MAX_SIDE,
  MIN_SIDE,
  SIZE_MULTIPLE,
  SIZE_TIERS,
  WH_RATIOS,
  nearestRatio,
  resolveDefaultSize,
  validateSize,
  type SizeTier,
} from './ratio.ts'
import type { Config } from './index.ts'

/**
 * The quality-tier parameters both image tools share.
 *
 * Optional and default-free on purpose: an omitted pair leaves the rendered graph
 * byte-identical to the pre-tier request (`cfg` 1, empty negative prompt). The
 * policy (which profiles accept them, the auto negative set, the range) lives in
 * {@link resolveQualityTier}.
 */
const QUALITY_PARAMETERS: ParameterSchemaSpec = {
  cfg: {
    type: 'number',
    description:
      '质量档 CFG（**只对 Qwen base 生效**；默认 1 = 官方口径，省略时请求与改动前逐字节一致）。' +
      'cfg>1 时负向条件化才真正生效、更贴提示词，代价是每步多一次前向（耗时约翻倍）；2.5–3 是暂定区间（X02 盲测后校准）。' +
      'turbo（ManualSigmas 蒸馏档）与 moss-sft（CFG 由采样档位管理）会拒绝该参数。',
  },
  negative_prompt: {
    type: 'string',
    description:
      '负向提示词（**只对 Qwen base 生效**，且只在 cfg>1 时有效——cfg=1 时 ComfyUI 跳过负向条件化）。' +
      '省略而 cfg>1 时会自动补默认负向词集（含 "overly warm color temperature"，压黄偏移），结果里会标明来源；' +
      'cfg=1 时给负向词会被拒绝（否则会被静默忽略）。默认空 = 官方口径。',
  },
}

/**
 * The optional advanced-sampler knobs both image tools carry.
 *
 * Default-free: an omitted pair keeps the profile's own sampler/scheduler
 * (`euler` / `simple` for Qwen base), so a default call is byte-identical. The
 * values are ComfyUI-native only — see `NATIVE_SAMPLERS` — and the policy (which
 * profiles accept them) lives in {@link resolveSamplerOverrides}.
 */
const SAMPLER_PARAMETERS: ParameterSchemaSpec = {
  sampler: {
    type: 'string',
    enum: NATIVE_SAMPLERS,
    description:
      '采样器（**只对 Qwen base 生效**；默认 euler = 官方模板与社区共识的安全组合，省略时请求与改动前逐字节一致）。' +
      '可选值全部是 ComfyUI **原生**采样器（含 res_multistep、er_sde）；RES4LYF 等第三方节点包的组合**不内置**。' +
      '替代组合的收益都是社区〔孤证/轶闻〕、无严格对照，换之前先用同 seed 对比。' +
      'turbo（ManualSigmas 蒸馏档）与 moss-sft（采样器由 mossSampling 档位管理）会拒绝该参数。',
  },
  scheduler: {
    type: 'string',
    enum: NATIVE_SCHEDULERS,
    description:
      '调度器（**只对 Qwen base 生效**；默认 simple = 官方模板口径）。只收 ComfyUI **原生**调度器 ' +
      '（simple / normal / karras / exponential / sgm_uniform / beta）；er_sde + beta 之类是社区的替代组合〔孤证〕，' +
      '没有严格对照；官方仍推荐 euler/simple。第三方节点包的调度器（RES4LYF 等）**不内置**。' +
      'turbo 与 moss-sft 会拒绝该参数。',
  },
}

/** The optional canvas-budget select both image tools carry. */
const SIZE_TIER_PARAMETER: ParameterSchemaSpec['size_tier'] = {
  type: 'string',
  enum: SIZE_TIERS,
  description:
    '画布像素预算档：`1.5mp`（默认，8GB 卡友好；七档 32 对齐，即本插件一直用的 ~1.5MP 表）或 ' +
    '`2k`（官方模型卡 4.2MP 七档表，1:1 = 2048×2048，16:9 = 2752×1536）。' +
    '**画面里要出现文字时建议用 2k**（小字精度随分辨率提升）；2k 的像素约为默认档 2.8 倍，8GB 卡上显存与耗时风险明显。' +
    '显式 `width`/`height` 优先于本档；4K 不是一个档（官方明确 4K 丢提示词贴合度）。',
}

/** Everything `image_forge_generate` accepts, as one schema reused by validation. */
const GENERATE_PARAMETERS: ParameterSchemaSpec = {
  prompt: {
    type: 'string',
    required: true,
    description:
      '成品提示词（已经按 Qwen 提示词契约改写好的那一段描述性散文）。本工具不做改写——' +
      '把口语需求翻译成契约提示词是 skill `image-forge` 的职责，改写结果里的 wh_ratio 直接传给本参数旁边的 wh_ratio。',
  },
  wh_ratio: {
    type: 'string',
    enum: WH_RATIOS,
    description:
      '画幅比（一等参数，官方 7 档）：1:1 / 4:3 / 3:4 / 3:2 / 2:3 / 16:9 / 9:16。' +
      '本插件按 ~1.5MP 预算换算成 32 对齐的像素尺寸（换算表见 skill `image-forge` 正文「画幅比与像素」一节），' +
      '因此契约里的 wh_ratio 不需要人工换算成宽高（`size_tier: 2k` 时换成官方 4.2MP 表）。' +
      '省略时用 1:1；给了 width/height 时以 width/height 为准。',
  },
  size_tier: SIZE_TIER_PARAMETER,
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
      '采样步数；省略则按配置解析：`comfyuiSteps` → 采样档位自带步数（仅 MOSS：comfy 25 / official 50）→ 默认 `defaultSteps`（默认 40，仅无档位的 Qwen）；' +
      '`comfyModel` 是 turbo 变体（`qwen21-turbo` / 旧值 `turbo`）时是 `turboSteps` → 8。' +
      '结果里的 `steps_used` 与 `steps_source` 会说明实际用了多少、以及它来自哪一层。仅当你明确知道该模型的建议值时再传。',
  },
  layout: {
    type: 'string',
    description:
      '编译后的 MOSS 布局（compiled JSON 字符串，布局编辑器「导出 compiled」原文）：bbox_coord_space=abs_centralized、bbox_format=yxyx，' +
      'items 为画框数组（label / caption / text / bbox），summary.caption 为整图描述（必填）。传了它，MOSS 的正向编码文本就是这段布局 prompt，画框控制构图。' +
      '**仅 comfyModel="moss-sft" 支持**（Qwen 两个 profile 没有布局通路，传了会明确报错）；省略则与之前逐字节一致的普通文生图。' +
      '布局在本地编译并校验，不需要 ComfyUI 额外装节点（原生 MOSSImageLayoutPrompt 产出的就是同一份 JSON）。',
  },
  ...QUALITY_PARAMETERS,
  ...SAMPLER_PARAMETERS,
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

/** Everything `image_forge_edit` accepts. */
const EDIT_PARAMETERS: ParameterSchemaSpec = {
  prompt: {
    type: 'string',
    required: true,
    description:
      '成品**修改指令**（已经按 Qwen 改图契约改写好的那一段，一整段、不要换行）。本工具不做改写——' +
      '把口语需求翻译成改图契约是 skill `image-forge` 的职责（见 references/edit_rules.md）：' +
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
      '七档画布在 ComfyUI 改图工作流上都能跑；参考图会先缩放到与画布同量级再进条件化（官方模板的要求）。' +
      '`size_tier: 2k` 时用官方 4.2MP 表（显存/耗时风险随之上升）。',
  },
  size_tier: SIZE_TIER_PARAMETER,
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
      '采样步数；省略则按配置解析：`comfyuiSteps` → 采样档位自带步数（仅 MOSS：comfy 25 / official 50）→ 默认 `defaultSteps`（默认 40，仅无档位的 Qwen）；' +
      '`comfyModel` 是 turbo 变体（`qwen21-turbo` / 旧值 `turbo`）时是 `turboSteps` → 8。' +
      '结果里的 `steps_used` 与 `steps_source` 会说明实际用了多少、以及它来自哪一层。仅当你明确知道该模型的建议值时再传。',
  },
  ...QUALITY_PARAMETERS,
  ...SAMPLER_PARAMETERS,
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

/** Coerce a caller value the schema typed as `number` (cfg is fractional). */
function asNumber(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number, got ${String(value)}`)
  }
  return value
}

/** Validate the optional `size_tier` select; absent means the shipped 1.5 MP table. */
function asSizeTier(value: string | undefined): SizeTier {
  if (value === undefined) return DEFAULT_SIZE_TIER
  if (!(SIZE_TIERS as readonly string[]).includes(value)) {
    throw new Error(`size_tier must be one of ${SIZE_TIERS.join(' / ')}, got ${String(value)}`)
  }
  return value as SizeTier
}

/** Coerce a caller string, treating a blank one as absent. */
function asText(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
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
 * real client run of `image_forge_status` failed exactly that way once
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
  return firstLine(error, error instanceof Error ? error.message : String(error))
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
    /** Paths this run was edited from; resolved to board item ids on record. */
    parentPaths?: readonly string[]
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
      parentPaths: meta.parentPaths,
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
  /** Canvas-budget tier the decision ran on. */
  readonly sizeTier: SizeTier
  /** False when explicit `width`/`height` overrode the tier. */
  readonly sizeTierApplied: boolean
}

/**
 * Decide the output size from `wh_ratio` and/or an explicit width/height pair.
 *
 * @param whRatio - caller ratio; defaults to `1:1` when nothing was supplied.
 * @param width - explicit width, if any.
 * @param height - explicit height, if any.
 * @param tier - canvas-budget tier for the `wh_ratio` path; explicit sizes win.
 * @returns the aligned size and the provenance of the decision.
 * @throws When only one of width/height is given, or a side is not 32-aligned.
 */
export function chooseSize(
  whRatio: string | undefined,
  width: number | undefined,
  height: number | undefined,
  tier: SizeTier = DEFAULT_SIZE_TIER,
): ChosenSize {
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
      sizeTier: tier,
      sizeTierApplied: false,
    }
  }
  const ratio = whRatio ?? '1:1'
  const size = resolveDefaultSize(ratio, tier)
  return {
    width: size.width,
    height: size.height,
    sizeSource: 'wh_ratio',
    whRatio: ratio,
    ratioDeviationPercent: size.ratioDeviationPercent,
    exactRatio: size.exact,
    sizeTier: tier,
    sizeTierApplied: true,
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
  /** Official tier closest to the chosen canvas, for continuity with `image_forge_generate`. */
  readonly whRatio: string
  /** Signed deviation of the canvas from the ratio that was asked for, in percent. */
  readonly ratioDeviationPercent: number
  /** True when the canvas reproduces the asked-for ratio exactly. */
  readonly exactRatio: boolean
  /** The reference the canvas followed, when `sizeSource` is `ratio_follow`. */
  readonly followed: ReferenceImage | null
  /** True when the caller asked for neither a ratio nor a size. */
  readonly followedByDefault: boolean
  /** Canvas-budget tier the decision ran on. */
  readonly sizeTier: SizeTier
  /** False when explicit `width`/`height` overrode the tier. */
  readonly sizeTierApplied: boolean
}

/**
 * Decide an edit call's canvas: explicit size, then `wh_ratio`, then `ratio_follow`.
 *
 * `wh_ratio` and `ratio_follow` are mutually exclusive — the prompt contract
 * itself says one must be empty whenever the other is set — so supplying both is
 * an error rather than a silent winner. `width`/`height` stay the plugin-level
 * override they already are for `image_forge_generate`, which is why they beat
 * both ratio forms.
 *
 * @param whRatio - fixed ratio, if the caller gave one.
 * @param ratioFollow - reference to follow, if the caller gave one.
 * @param width - explicit width, if any.
 * @param height - explicit height, if any.
 * @param references - the loaded reference images, in prompt order.
 * @param tier - canvas-budget tier for the ratio paths; explicit sizes win.
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
  tier: SizeTier = DEFAULT_SIZE_TIER,
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
    const size = chooseSize(undefined, width, height, tier)
    return { ...size, followed: null, followedByDefault: false }
  }
  const defaulted = (follow === undefined || follow.length === 0) && (ratio === undefined || ratio.length === 0)
  if (defaulted || (follow !== undefined && follow.length > 0)) {
    const reference = defaulted ? (references[0] as ReferenceImage) : resolveRatioFollow(follow as string, references)
    if (reference === undefined) throw new Error('ratio_follow needs at least one reference image')
    const size = resolveDefaultSize(`${reference.width}:${reference.height}`, tier)
    return {
      width: size.width,
      height: size.height,
      sizeSource: 'ratio_follow',
      whRatio: nearestRatio(size.width, size.height).whRatio,
      ratioDeviationPercent: size.ratioDeviationPercent,
      exactRatio: size.exact,
      followed: reference,
      followedByDefault: defaulted,
      sizeTier: tier,
      sizeTierApplied: true,
    }
  }
  const size = chooseSize(ratio, undefined, undefined, tier)
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
  /**
   * Which model profile to ask for (`qwen21-base` / `qwen21-turbo` / `moss-sft`;
   * the pre-profile `base` / `turbo` still resolve).
   */
  readonly comfyModel: ComfyModelChoice
  /**
   * Sampling register for a family that publishes more than one (MOSS-Image).
   *
   * Ignored by both Qwen profiles — they declare no registers — so their sampler
   * numbers cannot move. It takes the same two paths here that it takes in the
   * Studio: `comfyOptionsOf` → `ComfyOptions` decides sampler / CFG / scheduler,
   * and {@link resolveSteps} → `presetSteps` decides the selected register's step
   * count (the default register included: MOSS's counts are model properties).
   * Absent means the family's own default (the verified one).
   */
  readonly mossSampling?: MossSamplingPreset
  /** Turbo step override; `undefined` means the distilled default (8). */
  readonly turboSteps: number | undefined
}

/** Everything the ComfyUI client needs from the resolved config. */
function comfyOptions(settings: ForgeSettings, timeoutMs = settings.timeoutMs) {
  return buildComfyOptions(settings, timeoutMs)
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
    mossSampling: config.mossSampling,
    turboSteps: config.turboSteps,
  }
}

/** Where a call's sampler-step count came from, for the result payload. */
export type StepsSource = 'explicit' | 'backend' | 'default'

/**
 * Hard ceiling on any step count that reaches the sampler.
 *
 * The same clamp the Studio applies: 1 is a legal single-step draft, 200 is
 * well past anything Qwen-Image benefits from, and an unclamped explicit value
 * (a typo, a confused caller) would pin the GPU for hours. Shared by both
 * resolvers below so the two front doors cannot drift.
 */
export const STEPS_LIMIT = 200

function clampSteps(value: number): number {
  return Math.min(STEPS_LIMIT, Math.max(1, Math.round(value)))
}

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
 * Priority, level for level the same chain `resolveStudioSteps` runs: the
 * caller's explicit `steps` > the ComfyUI override (`comfyuiSteps`) > the
 * selected sampling register's own working point ({@link presetSteps}) >
 * `defaultSteps`. The register level is `undefined` for both Qwen profiles (no
 * register table), so the shared fallback still decides those exactly as it did
 * before registers existed; a family that publishes registers (MOSS) always
 * reports its own count — 25 for the default register, 50 for `official` —
 * because those are model properties, not a Qwen-tuned global.
 *
 * The count has to be resolved **here** and not left to the adapter: every
 * dispatch site overwrites `request.steps` with the resolved `usedSteps.steps`,
 * so `request.steps` is always defined by the time `textToImageValues` runs, and
 * its `request.steps ?? sampling.steps.default` can never supply the register's
 * 50. That is exactly why the Studio resolves it in `resolveStudioSteps` too.
 *
 * A register-sourced count reports `source: 'default'`: it is the family's own
 * working point, not a user override (`'explicit'`) and not the shared ComfyUI
 * override (`'backend'`) — the three values `docs/configuration.md` documents.
 */
export function resolveSteps(
  explicit: number | undefined,
  settings: ForgeSettings,
  profile: ModelProfile = resolveProfile(settings.comfyModel),
): StepsResolution {
  if (explicit !== undefined) return { steps: clampSteps(explicit), source: 'explicit' }
  if (typeof settings.comfyuiSteps === 'number' && Number.isFinite(settings.comfyuiSteps) && settings.comfyuiSteps >= 1) {
    return { steps: clampSteps(settings.comfyuiSteps), source: 'backend' }
  }
  const register = presetSteps(profile, settings.mossSampling)
  if (register !== undefined) return { steps: register, source: 'default' }
  return { steps: settings.defaultSteps, source: 'default' }
}

/**
 * Steps for the turbo checkpoint: its own override, else the distilled default.
 *
 * Deliberately does **not** fall through to `defaultSteps` or `comfyuiSteps`:
 * those are tuned for the base checkpoint (25), and handing 25 steps to a
 * checkpoint distilled for 8 makes the picture worse, not better. An explicit
 * `steps` from the caller still wins (clamped), because that is how the turbo
 * contract gets checked on a real card.
 *
 * @param explicit - the caller's `steps`, when it supplied one.
 * @param settings - the resolved plugin settings.
 * @returns the count and where it came from.
 */
export function resolveTurboSteps(explicit: number | undefined, settings: ForgeSettings): StepsResolution {
  if (explicit !== undefined) return { steps: clampSteps(explicit), source: 'explicit' }
  if (typeof settings.turboSteps === 'number' && Number.isFinite(settings.turboSteps) && settings.turboSteps >= 1) {
    return { steps: clampSteps(settings.turboSteps), source: 'backend' }
  }
  return { steps: TURBO_STEPS, source: 'default' }
}

/** Lowest `cfg` the quality tier accepts (1 = the shipped, official-path value). */
export const CFG_MIN = 1

/** Highest `cfg` the quality tier accepts; the official tutorial says 5 degrades badly. */
export const CFG_MAX = 5

/**
 * The negative set the quality tier adds when `cfg > 1` but the caller gave none.
 *
 * The first entry is the community fix for Qwen-Image 2.1's yellow shift at
 * elevated cfg (`../docs/configuration.md` §三-①); the rest are the mild quality
 * guards that advice assumes. Kept short on purpose — a long negative list at
 * cfg>1 fights the positive prompt.
 */
export const QUALITY_NEGATIVE_PROMPT =
  'overly warm color temperature, yellow tint, oversharpened edges, blurry, low quality, jpeg artifacts'

/** One call's resolved quality tier. */
export interface QualityTierResolution {
  /** The `cfg` that reaches `KSampler.cfg`. */
  readonly cfg: number
  /** The negative prompt that reaches the encode node. */
  readonly negativePrompt: string
  /** Where the negative prompt came from. */
  readonly negativeSource: 'caller' | 'auto' | 'profile'
  /** The human-facing note the result payload repeats (time cost, provisional values). */
  readonly note: string
}

/**
 * Resolve the optional quality tier (`cfg` / `negative_prompt`) for one call.
 *
 * Official 2.1 contract: `cfg` stays 1 unless a negative prompt is really wanted —
 * at cfg 1 ComfyUI skips the negative conditioning pass, so a negative prompt
 * without `cfg > 1` would be silently inert. That is why:
 * - only the Qwen **base** profile exposes the tier (turbo's schedule is a fixed
 *   ManualSigmas graph, and MOSS's CFG belongs to its sampling register);
 * - `cfg > 1` with no negative prompt auto-fills {@link QUALITY_NEGATIVE_PROMPT},
 *   and the result says which source was used;
 * - a negative prompt at cfg <= 1 is refused instead of being swallowed;
 * - the caller's own `steps`/`cfg` never change the defaults: an omitted pair
 *   leaves the rendered graph byte-identical.
 *
 * 2.5–3 is the documented provisional range (`docs/configuration.md` §四-3);
 * X02 is the blind test that will calibrate it, so the note says so.
 *
 * @param profile - the profile the caller **asked for** (not a degraded one).
 * @param cfg - explicit `cfg`, when the caller gave one.
 * @param negativePrompt - explicit negative prompt, when the caller gave one.
 * @returns the tier, or null when neither parameter was used (the default path).
 * @throws When the profile does not own a KSampler CFG, the range is invalid, or a
 *   negative prompt was given at cfg <= 1.
 */
export function resolveQualityTier(
  profile: ModelProfile,
  cfg: number | undefined,
  negativePrompt: string | undefined,
): QualityTierResolution | null {
  if (cfg === undefined && negativePrompt === undefined) return null
  if (profile.variant !== 'base' || profile.family !== 'qwen-image-2.1') {
    const why = profile.variant === 'turbo'
      ? 'turbo 走 SamplerCustomAdvanced + ManualSigmas 蒸馏档，CFG 与步数都由 sigma 表固定'
      : 'MOSS 的 CFG 由采样档位 mossSampling 管理（comfy 2.5 / official 3）'
    throw new Error(
      `comfyui backend: 质量档（cfg / negative_prompt）只对 Qwen base 生效，当前请求的 profile 是 ${profile.label}——${why}。\n` +
        '  质量档请在 comfyModel=qwen21-base 下使用；turbo 与 moss-sft 不接受这两个参数。',
    )
  }
  const resolved = cfg ?? profile.sampler.cfg
  if (!Number.isFinite(resolved) || resolved < CFG_MIN || resolved > CFG_MAX) {
    throw new Error(`cfg must be between ${CFG_MIN} and ${CFG_MAX}, got ${String(cfg)}`)
  }
  if (resolved <= 1) {
    if (negativePrompt !== undefined) {
      throw new Error(
        'negative_prompt 只在 cfg > 1 时有效：cfg=1 时 ComfyUI 跳过负向条件化（官方口径），负向词会被静默忽略。\n' +
          '  想用负向词就同时给 cfg（暂定 2.5–3；换来更贴提示词，代价是耗时约翻倍），否则去掉 negative_prompt。',
      )
    }
    return {
      cfg: resolved,
      negativePrompt: profile.negativePrompt,
      negativeSource: 'profile',
      note: 'cfg=1：负向条件化被 ComfyUI 跳过，本次请求与默认路径完全一致。',
    }
  }
  const negativeSource = negativePrompt === undefined ? 'auto' : 'caller'
  return {
    cfg: resolved,
    negativePrompt: negativePrompt ?? QUALITY_NEGATIVE_PROMPT,
    negativeSource,
    note:
      `cfg=${resolved}：每步多跑一次负向条件化前向，耗时约翻倍（官方/社区口径）。` +
      '2.5–3 是暂定区间（X02 盲测后校准）；4 以上容易过锐/过曝。',
  }
}

/** Minimum ComfyUI version that ships the `QwenImage21Cache` built-in node. */
export const QWEN_CACHE_MIN_VERSION = '0.37.0'

/**
 * Compare a ComfyUI version string against a minimum, semver-style.
 *
 * `/system_stats` reports `comfyui_version` like `0.45.3`. A non-numeric string
 * (a dev build, the test fake's `fake-0.0`) cannot be ordered, so the answer is
 * `null` — the status tool says "unknown" rather than guessing. Only the first
 * three numeric components are compared.
 *
 * @param version - the reported version, or null when it could not be read.
 * @param minimum - the required version, e.g. `0.37.0`.
 * @returns true/false when comparable, null otherwise.
 */
export function comfyVersionAtLeast(version: string | null, minimum: string): boolean | null {
  const parse = (raw: string): number[] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(raw.trim())
    return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  const actual = version === null ? undefined : parse(version)
  const wanted = parse(minimum)
  if (actual === undefined || wanted === undefined) return null
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== wanted[index]) return (actual[index] as number) > (wanted[index] as number)
  }
  return true
}

/** The sampler/scheduler one call will run, when the caller overrode them. */
export interface SamplerResolution {
  readonly samplerName: NativeSampler
  readonly scheduler: NativeScheduler
}

/**
 * Resolve the optional advanced-sampler knobs for one call.
 *
 * ComfyUI-native names only: a third-party sampler (RES4LYF's `abnorsett_3m`, …)
 * is not shipped by this plugin, and an unknown name would only be rejected by
 * ComfyUI after a GPU load. The tier is Qwen **base** only — turbo's sampler and
 * schedule are fixed by the distilled `ManualSigmas` graph, and MOSS's sampler
 * numbers belong to its `mossSampling` register. Both halves of the pair are
 * optional; an omitted half keeps the profile's own value, so the default path
 * renders a byte-identical graph.
 *
 * Community reports for these alternatives are single-source/no controlled
 * comparison, so the result note says so rather than claiming a quality win.
 *
 * @param profile - the profile the caller **asked for** (not a degraded one).
 * @param sampler - explicit `sampler`, when the caller gave one.
 * @param scheduler - explicit `scheduler`, when the caller gave one.
 * @returns the override pair, or null when neither parameter was used.
 * @throws When the profile does not run a free `KSampler`, or a name is not
 *   ComfyUI-native.
 */
export function resolveSamplerOverrides(
  profile: ModelProfile,
  sampler: string | undefined,
  scheduler: string | undefined,
): SamplerResolution | null {
  if (sampler === undefined && scheduler === undefined) return null
  if (profile.variant !== 'base' || profile.family !== 'qwen-image-2.1') {
    const why = profile.variant === 'turbo'
      ? 'turbo 走 SamplerCustomAdvanced + ManualSigmas 蒸馏档，采样器与步数都由 sigma 表固定'
      : 'MOSS 的采样器与调度器由采样档位 mossSampling 管理（comfy: er_sde/simple，official: euler/simple）'
    throw new Error(
      `comfyui backend: 高级采样器（sampler / scheduler）只对 Qwen base 生效，当前请求的 profile 是 ${profile.label}——${why}。\n` +
        '  高级采样器请在 comfyModel=qwen21-base 下使用；turbo 与 moss-sft 不接受这两个参数。',
    )
  }
  const resolvedSampler = (sampler ?? profile.sampler.name) as NativeSampler
  const resolvedScheduler = (scheduler ?? profile.sampler.scheduler) as NativeScheduler
  if (!(NATIVE_SAMPLERS as readonly string[]).includes(resolvedSampler)) {
    throw new Error(
      `sampler must be one of ComfyUI's native samplers (${NATIVE_SAMPLERS.join(' / ')}), got "${String(sampler)}".\n` +
        '  RES4LYF 等第三方节点包的采样器不内置：本插件不引入第三方节点包；确实要用请在 ComfyUI 里自己装，本插件不保证可用。',
    )
  }
  if (!(NATIVE_SCHEDULERS as readonly string[]).includes(resolvedScheduler)) {
    throw new Error(
      `scheduler must be one of ComfyUI's native schedulers (${NATIVE_SCHEDULERS.join(' / ')}), got "${String(scheduler)}"`,
    )
  }
  return { samplerName: resolvedSampler, scheduler: resolvedScheduler }
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
  /** `base` / `turbo` / `moss`: the family group that actually ran. */
  comfyModel: 'turbo' | 'base' | 'moss'
  /** The exact profile id that ran, e.g. `qwen21-turbo`. */
  profile: string
  turbo_fallback?: string
  /** QwenImage21Cache shim state: `on`, `skipped` (old ComfyUI) or `n/a` (non-Qwen). */
  cache: 'on' | 'skipped' | 'n/a'
  /** Why the shim was skipped, when this server lacked the node. */
  cache_note?: string
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
    name: 'image_forge_generate',
    description:
      '用 Qwen-Image 2.1 或 MOSS-Image 生图（本机 ComfyUI；底模由 `comfyModel` 选择：`qwen21-base` / `qwen21-turbo` 走 Qwen-Image 2.1，`moss-sft` 走 MOSS-Image）。`prompt` 收**成品**提示词（本工具不改写），`wh_ratio` 是**一等参数**：' +
      `直接接受官方契约的 7 档画幅比（${WH_RATIOS.join(' / ')}），插件自己换算成 ${SIZE_MULTIPLE} 对齐的像素尺寸——` +
      '所以「契约输出 → 插件入参」不需要人工翻译。省略 wh_ratio 用 1:1，给了 width/height 则以它们为准。' +
      '结果落盘到配置的 outputDir 并把绝对路径写进正文 Markdown，同时回传结构化字段。' +
      '需要本机 ComfyUI 已启动，且装好当前 `comfyModel` 那个 profile 的三个权重（默认 Qwen-Image 2.1；`moss-sft` 走 MOSS-Image；部署见 docs/comfyui-deployment.md）。',
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
      const sizeTier = asSizeTier(args.size_tier)
      const size = chooseSize(args.wh_ratio, asInteger(args.width, 'width'), asInteger(args.height, 'height'), sizeTier)
      const count = validateCount(args.count)
      const steps = asInteger(args.steps, 'steps')
      // Resolve the quality tier before any backend is touched: an invalid cfg, or a
      // negative prompt that cfg=1 would silently ignore, must fail here.
      const requestedProfile = resolveProfile(settings.comfyModel)
      const quality = resolveQualityTier(
        requestedProfile,
        asNumber(args.cfg, 'cfg'),
        asText(args.negative_prompt, 'negative_prompt'),
      )
      // Layout conditioning is MOSS-only and must fail before any backend work: a
      // profile without the native layout nodes would otherwise submit a graph that
      // silently ignores the layout, and a malformed layout string would be caught
      // by ComfyUI only after the weights were loaded.
      const layout = asText(args.layout, 'layout')
      if (layout !== undefined) {
        if (requestedProfile.layoutTemplate === undefined) {
          throw new Error(
            'comfyui backend: 布局（layout）只对 MOSS-Image 生效——只有 moss-sft 的布局通路（compiled JSON 作为正向编码文本）存在，' +
              '当前请求的 profile 是 ' + requestedProfile.label + '。把 comfyModel 换成 moss-sft 再传 layout，或去掉该参数。',
          )
        }
        // Parse here as well: fail on the tool boundary with a named field instead of
        // submitting a layout the CreateBoundingBoxes node would refuse.
        parseMossLayout(layout)
      }
      const request = {
        prompt,
        width: size.width,
        height: size.height,
        count,
        steps,
        seed: asInteger(args.seed, 'seed'),
      }
      const samplerOverrides = resolveSamplerOverrides(requestedProfile, args.sampler, args.scheduler)
      const overrides = {
        ...(quality === null ? {} : { cfg: quality.cfg, negativePrompt: quality.negativePrompt }),
        ...(samplerOverrides === null ? {} : samplerOverrides),
        ...(layout === undefined ? {} : { layout }),
      }
      const startedAt = Date.now()

      // Resolve the step count before touching ComfyUI so no dispatch site can
      // forward a request whose step count was never resolved.
      const options = comfyOptions(settings)
      const target = await discoverComfyUi(options, exec.signal)
      const models: ComfyModels = await loadComfyModels(target, options, exec.signal)
      const comfyStartedAt = Date.now()
      // Which graph to run is a profile question, and a turbo request is a
      // *preference*, not a guarantee: it needs a turbo unet to be installed, and
      // when only the base weights are present the run falls back rather than
      // failing — the alternative is a config typo turning into "no images at
      // all". `effectiveProfile` applies the same rule to the weights the
      // adapter really found, so the graph can never disagree with them.
      const profile = effectiveProfile(settings.comfyModel, models)
      const turbo = profile.variant === 'turbo'
      const turboSkipped = requestedProfile.variant === 'turbo' && !turbo
      const usedSteps = turbo ? resolveTurboSteps(steps, settings) : resolveSteps(steps, settings, profile)
      const images = turbo
        ? await generateViaComfyUiTurbo(target, models, { ...request, ...overrides, steps: usedSteps.steps }, options, exec.signal)
        : await generateViaComfyUi(target, models, { ...request, ...overrides, steps: usedSteps.steps }, options, exec.signal)
      const comfyRun: ComfyRunReport = {
        endpoint: target.endpoint,
        port: target.port,
        probed: target.probed,
        models,
        comfyModel: profile.legacyLabel,
        profile: profile.id,
        cache: profile.family === 'qwen-image-2.1' ? (models.cache ? 'on' : 'skipped') : 'n/a',
        ...(profile.family === 'qwen-image-2.1' && !models.cache
          ? {
              cache_note:
                '本机 ComfyUI 的 /object_info 里没有 QwenImage21Cache 节点（需要 ≥ 0.37.0），本次跳过前缀缓存、图照常提交；升级 ComfyUI 后自动启用。',
            }
          : {}),
        ...(turboSkipped ? { turbo_fallback: '已选 turbo，但 /object_info 里没有 turbo 权重，本次用 base 跑' } : {}),
        elapsed_ms: Date.now() - comfyStartedAt,
      }
      const backendLabel =
        `后端 comfyui / ${target.endpoint} / ${models.unet}` +
        (turbo ? '（turbo）' : profile.legacyLabel === 'moss' ? '（MOSS）' : '')

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
        size_tier: size.sizeTier,
        size_tier_applied: size.sizeTierApplied,
        ratio_deviation_percent: size.ratioDeviationPercent,
        exact_ratio: size.exactRatio,
        count,
        steps: steps ?? null,
        steps_used: usedSteps.steps,
        steps_source: usedSteps.source,
        seed: request.seed ?? null,
        ...(quality === null
          ? {}
          : {
              quality: {
                cfg: quality.cfg,
                negative_prompt: quality.negativePrompt,
                negative_prompt_source: quality.negativeSource,
                note: quality.note,
              },
            }),
        ...(samplerOverrides === null
          ? {}
          : {
              sampling: {
                sampler: samplerOverrides.samplerName,
                scheduler: samplerOverrides.scheduler,
                default_pair: 'euler/simple',
                note: '替代采样器/调度器组合是社区〔孤证/轶闻〕级证据、无严格对照；euler/simple 仍是官方+双源的安全默认。换组合请用同 seed 对比。',
              },
            }),
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
    name: 'image_forge_edit',
    description:
      '用 Qwen-Image 2.1 做**参考图编辑（图生图）**，在本机 ComfyUI 的官方改图工作流上运行：' +
      '给 1 张或多张参考图 + 一段**成品修改指令**，出改好的图。' +
      `\`images\` 收 1–${MAX_REFERENCES} 张参考图（绝对路径或 data:image/…;base64,…，按顺序对应提示词里的 \`<image1>\`…\`<imageN>\`），` +
      '`ratio_follow` 让画布**跟随某张参考图的宽高比**（写 `image1`…`image10`，或直接把 `images` 里的那一项再写一遍）；' +
      '它与 `wh_ratio` **互斥**（官方契约里一个非空另一个必须为空），两个都不给时**默认跟随第一张参考图**。' +
      '参考图先上传进 ComfyUI 的 input/ 目录。' +
      '改图在 `moss-sft` 下走 MOSS-Image 自己的 edit LoRA 通路（ComfyUI 的 `models/loras/` 里缺该 LoRA 时会报错点名文件）；' +
      '不会递一张忽略参考图的图上去。' +
      '部署（ComfyUI 桌面版 + 三个权重）见 docs/comfyui-deployment.md。' +
      '结果落盘到 outputDir 并把绝对路径写进正文 Markdown。',
    parameters: EDIT_PARAMETERS,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderResultBlocks(value),
    },
    // Same reasoning as `image_forge_generate`.
    timeoutMs: getConfig().timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const settings = resolveSettings(getConfig())
      const prompt = args.prompt.trim()
      if (prompt.length === 0) throw new Error('prompt must not be blank')
      // Loaded before any backend is touched: a bad reference must fail here, where
      // the message can name which one it was, not inside a graph or a request body.
      const references = await loadReferenceImages(args.images)
      const sizeTier = asSizeTier(args.size_tier)
      const size = chooseEditSize(
        args.wh_ratio,
        args.ratio_follow,
        asInteger(args.width, 'width'),
        asInteger(args.height, 'height'),
        references,
        sizeTier,
      )
      const count = validateCount(args.count)
      const steps = asInteger(args.steps, 'steps')
      // Same early validation as `image_forge_generate`, plus the multi-reference
      // guard: elevated cfg on a multi-reference edit is the documented artifact case.
      const requestedProfile = resolveProfile(settings.comfyModel)
      const quality = resolveQualityTier(
        requestedProfile,
        asNumber(args.cfg, 'cfg'),
        asText(args.negative_prompt, 'negative_prompt'),
      )
      if (quality !== null && quality.cfg > 1 && references.length > 1) {
        throw new Error(
          `多参考图（${references.length} 张）+ cfg>1 会出 artifacts：真实 CFG 下多参考编辑不稳定（官方/社区孤证），已验证的只有单参考。\n` +
            '  多参考保持 cfg=1（默认，与官方模板一致）；想试质量档请只保留 1 张参考图。',
        )
      }
      const request = {
        prompt,
        width: size.width,
        height: size.height,
        count,
        steps,
        seed: asInteger(args.seed, 'seed'),
        images: references,
      }
      const samplerOverrides = resolveSamplerOverrides(requestedProfile, args.sampler, args.scheduler)
      const overrides = {
        ...(quality === null ? {} : { cfg: quality.cfg, negativePrompt: quality.negativePrompt }),
        ...(samplerOverrides === null ? {} : samplerOverrides),
      }
      const startedAt = Date.now()

      const options = comfyOptions(settings)
      const target = await discoverComfyUi(options, exec.signal)
      const models: ComfyModels = await loadComfyModels(target, options, exec.signal)
      const comfyStartedAt = Date.now()
      const profile = effectiveProfile(settings.comfyModel, models)
      const turbo = profile.variant === 'turbo'
      const turboSkipped = requestedProfile.variant === 'turbo' && !turbo
      const usedSteps = turbo ? resolveTurboSteps(steps, settings) : resolveSteps(steps, settings, profile)
      const images = turbo
        ? await generateViaComfyUiTurboEdit(
            target,
            models,
            { ...request, ...overrides, steps: usedSteps.steps },
            options,
            exec.signal,
          )
        : await generateViaComfyUiEdit(
            target,
            models,
            { ...request, ...overrides, steps: usedSteps.steps },
            options,
            exec.signal,
          )
      const comfyRun: ComfyRunReport = {
        endpoint: target.endpoint,
        port: target.port,
        probed: target.probed,
        models,
        comfyModel: profile.legacyLabel,
        profile: profile.id,
        cache: profile.family === 'qwen-image-2.1' ? (models.cache ? 'on' : 'skipped') : 'n/a',
        ...(profile.family === 'qwen-image-2.1' && !models.cache
          ? {
              cache_note:
                '本机 ComfyUI 的 /object_info 里没有 QwenImage21Cache 节点（需要 ≥ 0.37.0），本次跳过前缀缓存、图照常提交；升级 ComfyUI 后自动启用。',
            }
          : {}),
        ...(turboSkipped ? { turbo_fallback: '已选 turbo，但 /object_info 里没有 turbo 权重，本次用 base 跑' } : {}),
        references_uploaded: references.map((reference) => reference.label),
        elapsed_ms: Date.now() - comfyStartedAt,
      }
      const backendLabel =
        `后端 comfyui / ${target.endpoint} / ${models.unet}` +
        (turbo ? '（turbo）' : profile.legacyLabel === 'moss' ? '（MOSS）' : '')

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
        parentPaths: references.map((reference) => reference.source),
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
        size_tier: size.sizeTier,
        size_tier_applied: size.sizeTierApplied,
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
        ...(quality === null
          ? {}
          : {
              quality: {
                cfg: quality.cfg,
                negative_prompt: quality.negativePrompt,
                negative_prompt_source: quality.negativeSource,
                note: quality.note,
              },
            }),
        ...(samplerOverrides === null
          ? {}
          : {
              sampling: {
                sampler: samplerOverrides.samplerName,
                scheduler: samplerOverrides.scheduler,
                default_pair: 'euler/simple',
                note: '替代采样器/调度器组合是社区〔孤证/轶闻〕级证据、无严格对照；euler/simple 仍是官方+双源的安全默认。换组合请用同 seed 对比。',
              },
            }),
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
    name: 'image_forge_status',
    description:
      '后端健康探测：**本机 ComfyUI 是否在跑**（含探测过哪几个端口、当前 `comfyModel` 那个 profile 的三个权重能不能被它的加载器枚举到、' +
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
      // The prefix-cache node is a version-gated built-in: report the comparison,
      // never the node's presence (that is answered by /object_info at run time).
      const version = stats?.version ?? null
      const cacheSupported = comfyVersionAtLeast(version, QWEN_CACHE_MIN_VERSION)
      const cacheNote =
        cacheSupported === null
          ? `读不到可比较的 ComfyUI 版本（${version ?? 'null'}），无法判断 QwenImage21Cache（需要 ≥ ${QWEN_CACHE_MIN_VERSION}）是否支持；出图时按 /object_info 自动降级，不会失败。`
          : cacheSupported
            ? `版本满足 QwenImage21Cache（需要 ≥ ${QWEN_CACHE_MIN_VERSION}）；节点是否真的存在仍以出图时的 /object_info 为准，缺失会自动跳过。`
            : `本机 ComfyUI 低于 ${QWEN_CACHE_MIN_VERSION}，没有 QwenImage21Cache 节点：出图会自动跳过前缀缓存（不会失败），升级 ComfyUI 后启用。`
      return jsonSafe({
        checked_at: new Date().toISOString(),
        comfyui: {
          modelsDir: settings.comfyModelsDir.length > 0 ? settings.comfyModelsDir : null,
          ...comfyui,
          version,
          qwen_cache: {
            min_version: QWEN_CACHE_MIN_VERSION,
            version_satisfied: cacheSupported,
            note: cacheNote,
          },
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
