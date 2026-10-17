/**
 * The `qwen_image_*` tool surface.
 *
 * `qwen_image_generate` is the only entry point that produces an image, and its
 * first-class `wh_ratio` parameter is the product's reason to exist: the Qwen
 * prompt contract already answers in `wh_ratio` terms, so the caller hands that
 * value straight to the tool instead of translating it into pixels by hand.
 * `width`/`height` remain available as an explicit override.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  API_KEY_ENV_VARS,
  generateViaApi,
  probeApi,
  resolveApiKey,
  sniffImageMime,
  type ApiSettings,
  type GeneratedImage,
} from './backend.ts'
import {
  DEFAULT_COMFY_PORTS,
  discoverComfyUi,
  generateViaComfyUi,
  generateViaComfyUiEdit,
  loadComfyModels,
  probeComfyUi,
  type ComfyModels,
  type ComfyOptions,
} from './comfyui.ts'
import { collectEnvStatus, vramSuspicionWarning, type VramAdvisory } from './env.ts'
import { collectLocalRuntime, runRepair } from './maintenance.ts'
import { LocalUnreachableError, generateViaLocal, type LocalGeneration } from './local.ts'
import { parsePorts } from './procx.ts'
import { sanitizePrefix, writeImages } from './output.ts'
import { MAX_REFERENCES, loadReferenceImages, probeImageSize, resolveRatioFollow, type ReferenceImage } from './refs.ts'
import {
  LOCAL_EDIT_BUDGET_EDGE,
  LOCAL_EDIT_BUDGET_RELIABLE,
  LOCAL_EDIT_CANVAS_SAFE_BUDGET,
  LOCAL_EDIT_CANVAS_WARN_AREA,
  MAX_SIDE,
  MIN_SIDE,
  SIZE_MULTIPLE,
  WH_RATIOS,
  localEditBudgetTier,
  nearestRatio,
  resolveDefaultSize,
  resolveReferenceBudget,
  validateSize,
  type LocalEditBudgetTier,
} from './ratio.ts'
import { RUNTIME_PACKAGES, TORCH_WHEEL_MATRIX, runInstall, venvPaths } from './venv.ts'
import { inspectWeights, runFetchWeights } from './weights.ts'
import { WorkerRuntime, type WorkerHandle } from './worker.ts'
import type { Config } from './index.ts'

/**
 * Resolve a file shipped beside the built entry (`lib/index.js` → `<pkg>/…`).
 *
 * @param relative - package-relative path, e.g. `resources/worker.py`.
 * @returns the absolute path, whether or not the file exists.
 */
export function resourcePath(relative: string): string {
  return fileURLToPath(new URL(`../${relative}`, import.meta.url))
}

/** Ports tried when the config does not say otherwise. */
const DEFAULT_WORKER_PORTS = ['8399-8410'] as const

/** Actions `qwen_image_env` understands. */
const ENV_ACTIONS = ['status', 'install', 'fetch-weights', 'repair', 'unload'] as const

/** Backends a caller may force; `auto` picks by key availability. */
const BACKENDS = ['auto', 'api', 'local', 'comfyui'] as const

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
      '采样步数；省略则按配置解析：后端专属（`comfyuiSteps` / `localSteps`）→ 默认 `defaultSteps`（默认 25）。' +
      '结果里的 `steps_used` 与 `steps_source` 会说明实际用了多少、以及它来自哪一层。仅当你明确知道该模型/后端的建议值时再传。',
  },
  seed: {
    type: 'integer',
    description: '随机种子；同一 seed + 同一 prompt + 同一尺寸可复现同一张图（后端支持时）。省略即随机。',
  },
  count: {
    type: 'integer',
    description: '出图张数，1–4，默认 1。多张按后端返回顺序编号落盘。',
  },
  transparent: {
    type: 'boolean',
    description: '要求带透明通道的输出（后端与模型支持时生效；不支持时后端可能忽略）。',
  },
  backend: {
    type: 'string',
    enum: BACKENDS,
    description:
      '强制后端：auto（默认，有 API key 走 api，否则先试本机 ComfyUI，再退到本地 worker）/ ' +
      'api（云 API，需要 key）/ comfyui（复用本机已装好的 ComfyUI + Qwen-Image 权重，零下载、零转换）/ ' +
      'local（本机 worker 的 HTTP 契约）。',
  },
  preset: {
    type: 'string',
    description: '落盘文件名前缀标签，例如 "poster"；只影响命名（<outputDir>/<前缀>_<W>x<H>_<n>.png），不影响生成参数。省略时为 "qwen"。',
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
      `注意：这七档换算出来的画布在 **local** 后端上全部超过编辑尺寸门（见 width 与工具说明）——` +
      '本机实测 4:3 / 3:4 档就已经崩，要用 local 就得显式给更小的 width/height，' +
      '或把配置 `localReferenceBudget` 调低（画布不动，降的是参考图条件化分辨率；1.5MP 画布上只有 512 实测跑得完）。',
  },
  width: {
    type: 'integer',
    description: `显式覆盖宽度（像素）。必须与 height 成对给出，且为 ${SIZE_MULTIPLE} 的倍数、位于 ${MIN_SIDE}–${MAX_SIDE}；给了就以 width/height 为准（此时 ratio_follow / wh_ratio 被覆盖）。` +
      `**local 后端有硬尺寸门**：插件按本机实测的 _reference_budget 分档——≤ ${LOCAL_EDIT_BUDGET_RELIABLE} 可靠放行、` +
      `${LOCAL_EDIT_BUDGET_RELIABLE}–${LOCAL_EDIT_BUDGET_EDGE} 放行但返回警告、> ${LOCAL_EDIT_BUDGET_EDGE} 默认直接拒绝（要跑得显式开配置 allowLocalEditOverBudget）。` +
      `档位判的是**生效的**预算：配置了 \`localReferenceBudget\` 就按它判（所以 512 + 1248×1248 画布是放行的），` +
      '没配置才按画布推导——它只降参考图条件化分辨率（换速度与可跑性；保真度：同画布 896 vs 512 目视看不出差别，n=1、1 位评判者），不改出图尺寸。' +
      `⚠️ 生效预算 > ${LOCAL_EDIT_CANVAS_SAFE_BUDGET} **且**画布面积 > 1.0 MP 时另有一条**画布侧警告**（放行、只给建议）：` +
      `1.5MP 画布上 896 实测 67 s/步（≈28 min / 25 步，不报错但等于不可用），只有 ${LOCAL_EDIT_CANVAS_SAFE_BUDGET} 跑得完。` +
      '所以「编辑在 local 上跑不动」时先看是不是画布太大，而不是先怀疑显存。',
  },
  height: {
    type: 'integer',
    description: '显式覆盖高度（像素）。规则同 width，必须与 width 成对给出。',
  },
  steps: {
    type: 'integer',
    description:
      '采样步数；省略则按配置解析：后端专属（`comfyuiSteps` / `localSteps`）→ 默认 `defaultSteps`（默认 25）。' +
      '结果里的 `steps_used` 与 `steps_source` 会说明实际用了多少、以及它来自哪一层。仅当你明确知道该模型/后端的建议值时再传。',
  },
  seed: {
    type: 'integer',
    description: '随机种子；同一 seed + 同一 prompt + 同一参考图 + 同一尺寸可复现同一张图（后端支持时）。省略即随机。',
  },
  count: {
    type: 'integer',
    description: '出图张数，1–4，默认 1。多张共用同一组参考图，按后端返回顺序编号落盘。',
  },
  transparent: {
    type: 'boolean',
    description: '要求带透明通道的输出（后端与模型支持时生效；ComfyUI 的改图工作流不带 alpha 处理，会忽略它）。',
  },
  backend: {
    type: 'string',
    enum: BACKENDS,
    description:
      '强制后端：auto（默认。**编辑场景跳过 api**——云后端没有编辑通道，先试本机 ComfyUI，再退到本地 worker）/ ' +
      "api（编辑不支持，会明确报错而不是丢掉参考图）/ comfyui（复用本机 ComfyUI + 官方 Qwen-Image 2.1 改图工作流）/ " +
      'local（本机 worker 的 HTTP 契约，请求体多一个 images 字段）。' +
      '**comfyui 不受编辑尺寸门约束**，所以它是超出尺寸门时最省事的出路；尺寸门只在请求真要落到 local 时才生效。',
  },
  preset: {
    type: 'string',
    description: '落盘文件名前缀标签，例如 "retouch"；只影响命名（<outputDir>/<前缀>_<W>x<H>_<n>.png）。省略时为 "edit"。',
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

/** Build the Markdown block the model can paste into its reply verbatim. */
export function renderMarkdown(images: readonly { markdownPath: string }[]): string {
  return images.map((image) => `![generated image](${image.markdownPath})`).join('\n')
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

/** Settings the tool body needs, resolved once from the plugin config. */
export interface ForgeSettings {
  readonly backend: (typeof BACKENDS)[number]
  readonly apiBaseUrl: string
  readonly apiKey: string
  readonly apiModel: string
  readonly apiStyle: 'openai' | 'dashscope'
  readonly apiKeySource: string | undefined
  readonly localEndpoint: string
  readonly comfyEndpoint: string
  readonly comfyPorts: readonly number[]
  readonly comfyModelsDir: string
  readonly outputDir: string
  readonly timeoutMs: number
  /** Plugin-owned data directory: venv, weights, logs, breadcrumbs. */
  readonly runtimeDir: string
  /** Where the nf4 weights live. */
  readonly modelsDir: string
  /** Mirror repo the weights come from. */
  readonly modelRepo: string
  /** Mirror host (never huggingface.co: its `/api/` times out on this box). */
  readonly hfMirror: string
  /** Candidate worker ports; the `localEndpoint` port is always tried first. */
  readonly workerPorts: readonly number[]
  /** How long a cold worker start may take. */
  readonly workerStartTimeoutMs: number
  /** Idle time after which the worker hands its VRAM back (0 = never). */
  readonly idleUnloadMs: number
  /** Whether the plugin may start the worker itself. */
  readonly manageWorker: boolean
  /** Interpreter that runs the worker (the venv's python unless overridden). */
  readonly pythonPath: string
  /** Candidates tried by `action:"install"` when creating the venv. */
  readonly basePythonCandidates: readonly string[]
  /** CUDA wheel tags tried in order by `action:"install"`. */
  readonly torchWheels: readonly string[]
  /** Index URL for the non-torch packages (a mirror, when configured). */
  readonly pipIndexUrl: string
  /** Reuse a CUDA torch found in the base interpreter. */
  readonly reuseBaseTorch: boolean
  /** Free-VRAM floor that turns `status` into a warning, and gates the worker start. */
  readonly minFreeVramMiB: number
  /**
   * Explicit opt-in: let the pre-start gate ask ComfyUI to unload first.
   * Default false — the plugin does not unload another program's models on its own.
   */
  readonly freeComfyBeforeLocalStart: boolean
  /**
   * Explicit opt-in: run a local edit whose conditioning budget is above the
   * measured ceiling instead of refusing it. Default false.
   */
  readonly allowLocalEditOverBudget: boolean
  /**
   * Explicit reference-conditioning budget for the local edit path, in pixels per
   * side. `0` (the default) derives it from the canvas in both places that care:
   * the worker and the size gate.
   */
  readonly localReferenceBudget: number
  /** Default for `fetch-weights`: drop the unused `lm_head.weight`. */
  readonly skipLmHead: boolean
  /** Sampler steps used when neither the caller nor a backend override picks one. */
  readonly defaultSteps: number
  /** ComfyUI step override; undefined falls through to `defaultSteps`. */
  readonly comfyuiSteps: number | undefined
  /** Local worker step override; undefined falls through to `defaultSteps`. */
  readonly localSteps: number | undefined
  /** Shipped `resources/pipwrap.py` (the sandbox's 0o700 pip workaround). */
  readonly pipwrapPath: string
  /** Shipped `resources/worker.py`. */
  readonly workerScript: string
  /** Throwaway logs for one-off commands. */
  readonly scratchDir: string
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

/** Resolve everything the tool bodies need from the plugin config. */
export function resolveSettings(config: Config): ForgeSettings {
  const key = resolveApiKey(config.apiKey)
  const runtimeDir = config.runtimeDir
  const venv = venvPaths(runtimeDir)
  const basePythonCandidates =
    config.basePython.trim().length > 0
      ? [config.basePython.trim()]
      : process.platform === 'win32'
        ? ['python', 'python3', 'py']
        : ['python3', 'python']
  const torchWheels = config.torchWheels
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  return {
    backend: config.backend,
    apiBaseUrl: config.apiBaseUrl.replace(/\/+$/, ''),
    apiKey: key.key ?? '',
    apiKeySource: key.source,
    apiModel: config.apiModel,
    apiStyle: config.apiStyle,
    localEndpoint: config.localEndpoint.replace(/\/+$/, ''),
    comfyEndpoint: config.comfyEndpoint.replace(/\/+$/, ''),
    comfyPorts: parseComfyPorts(config.comfyPorts),
    comfyModelsDir: config.comfyModelsDir,
    outputDir: config.outputDir,
    timeoutMs: config.timeoutMs,
    runtimeDir,
    modelsDir: config.modelsDir.trim().length > 0 ? config.modelsDir : join(runtimeDir, 'models', 'qwen-image-2.1-bnb4bit'),
    modelRepo: config.modelRepo,
    hfMirror: config.hfMirror.replace(/\/+$/, ''),
    workerPorts: parsePorts(config.workerPorts.length > 0 ? config.workerPorts : DEFAULT_WORKER_PORTS.join(','), [8399, 8400, 8401, 8402]),
    workerStartTimeoutMs: config.workerStartTimeoutMs,
    idleUnloadMs: config.idleUnloadMs,
    manageWorker: config.manageWorker,
    pythonPath: config.pythonPath.trim().length > 0 ? config.pythonPath : venv.python,
    basePythonCandidates,
    torchWheels: torchWheels.length > 0 ? torchWheels : [...TORCH_WHEEL_MATRIX],
    pipIndexUrl: config.pipIndexUrl.trim(),
    reuseBaseTorch: config.reuseBaseTorch,
    minFreeVramMiB: config.minFreeVramMiB,
    freeComfyBeforeLocalStart: config.freeComfyBeforeLocalStart,
    allowLocalEditOverBudget: config.allowLocalEditOverBudget,
    localReferenceBudget: config.localReferenceBudget,
    skipLmHead: config.skipLmHead,
    defaultSteps: config.defaultSteps,
    comfyuiSteps: config.comfyuiSteps,
    localSteps: config.localSteps,
    pipwrapPath: resourcePath('resources/pipwrap.py'),
    workerScript: config.workerScript.trim().length > 0 ? config.workerScript : resourcePath('resources/worker.py'),
    scratchDir: join(runtimeDir, 'logs'),
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
 * Resolve the sampler steps one call should use against one backend.
 *
 * Priority: the caller's explicit `steps` > the backend's own override
 * (`comfyuiSteps` / `localSteps`) > `defaultSteps`. The two backends historically
 * disagreed — ComfyUI ran the official template's 25 while the worker fell back
 * to 8 — so under `backend:"auto"` a fallback silently changed the picture.
 *
 * Resolving **per backend, at the point of dispatch** is the load-bearing part:
 * when ComfyUI is not running and the call falls through to the worker, the
 * worker's own override applies, rather than ComfyUI's count being carried over.
 *
 * @param explicit - the caller's `steps`, when it supplied one.
 * @param backend - the backend about to run.
 * @param settings - the resolved plugin settings.
 * @returns the count and where it came from.
 */
export function resolveSteps(
  explicit: number | undefined,
  backend: 'api' | 'comfyui' | 'local',
  settings: ForgeSettings,
): StepsResolution {
  if (explicit !== undefined) return { steps: explicit, source: 'explicit' }
  const override = backend === 'comfyui' ? settings.comfyuiSteps : backend === 'local' ? settings.localSteps : undefined
  if (typeof override === 'number' && Number.isFinite(override) && override >= 1) {
    return { steps: Math.round(override), source: 'backend' }
  }
  return { steps: settings.defaultSteps, source: 'default' }
}

/** Build the worker-lifecycle manager for one plugin instance. */
function createRuntime(settings: ForgeSettings): WorkerRuntime {
  return new WorkerRuntime({
    endpoint: settings.localEndpoint,
    interpreter: settings.pythonPath,
    script: settings.workerScript,
    modelsDir: settings.modelsDir,
    dataDir: settings.runtimeDir,
    ports: settings.workerPorts,
    startTimeoutMs: settings.workerStartTimeoutMs,
    idleUnloadMs: settings.idleUnloadMs,
    manage: settings.manageWorker,
    // The gate refuses to spawn a worker the card cannot hold. It reuses
    // `minFreeVramMiB` (0 disables it) so there is one "how much do I need free"
    // knob, and it only ever asks ComfyUI to let go when the user opted in.
    vramGate: {
      requiredMiB: settings.minFreeVramMiB,
      // The whole list is handed over, not just its first entry: the gate finds the port
      // that actually has a listener, so its `curl …/free` remedy line and the opt-in
      // `POST /free` cannot end up aimed at a closed port the user never used.
      comfyPort: settings.comfyPorts[0] ?? 8188,
      comfyPorts: settings.comfyPorts,
      freeComfyFirst: settings.freeComfyBeforeLocalStart,
      scratchDir: settings.scratchDir,
    },
  })
}

/**
 * Worker facts as they belong in a generation result.
 *
 * @param handle - how the worker was obtained.
 * @param restarted - the request was retried against a rebuilt worker.
 * @param stages - the worker's own stage timings, when it reported any.
 * @returns the report embedded as `local_worker`.
 */
function describeWorkerRun(handle: WorkerHandle, restarted: boolean, stages: Record<string, number> = {}): Record<string, unknown> {
  return {
    endpoint: handle.endpoint,
    port: handle.port,
    pid: handle.pid,
    started_by_plugin: handle.started,
    adopted: handle.adopted,
    managed: handle.managed,
    ours: handle.ours,
    start_ms: handle.startMs,
    restarted_after_disconnect: restarted,
    ready: handle.state?.ready ?? null,
    load_seconds: handle.state?.load_seconds ?? null,
    // Where the wall clock went, in the worker's own measurement. Only the shipped
    // worker reports this; a foreign one leaves it null rather than guessing.
    stages_s: Object.keys(stages).length === 0 ? null : stages,
  }
}

/**
 * The pre-start VRAM gate's own account of what it saw and did.
 *
 * Reported rather than logged because one branch of it has a side effect: with
 * `freeComfyBeforeLocalStart` on, the plugin asks ComfyUI to unload, and the user
 * is entitled to see that it happened and what came back.
 *
 * @param runtime - the lifecycle manager the call went through.
 * @returns the gate report, or null when the gate never ran.
 */
function describeVramGate(runtime: WorkerRuntime): Record<string, unknown> | null {
  const report = runtime.vramGate
  if (report === null || !report.ran) return null
  return {
    free_MiB: report.freeMiB,
    total_MiB: report.totalMiB,
    required_MiB: report.requiredMiB,
    shortfall_MiB: report.shortfallMiB,
    allowed: report.allowed,
    holders: report.holders.map((holder) => ({
      pid: holder.pid,
      name: holder.name,
      used_MiB: holder.usedMiB,
      comfyui: holder.comfyui,
    })),
    freed_comfy: report.freedComfy === null ? null : {
      requested: true,
      url: report.freedComfy.url,
      http_status: report.freedComfy.httpStatus,
      ok: report.freedComfy.ok,
      body: report.freedComfy.body,
      note: report.freedComfy.note ?? null,
    },
    // "Allowed" is not "the card was empty": a resident ComfyUI leaves the floor
    // met and still kills the load. The gate says so rather than staying silent.
    warning: report.warning,
    note:
      report.freedComfy === null
        ? '插件没有动任何别的程序；`freeComfyBeforeLocalStart` 为 false（默认）时它只会报错并给出命令。'
        : `已按 freeComfyBeforeLocalStart 请求 ComfyUI 释放显存（POST ${report.freedComfy.url} → HTTP ${report.freedComfy.httpStatus}）。`,
  }
}

/**
 * Generate through the plugin-owned worker.
 *
 * A transport failure means the worker vanished (it was a child job of a session
 * that ended, or it crashed): the runtime rebuilds it and the request is retried
 * once. Anything else — a load failure, an HTTP error body — is surfaced as is,
 * because retrying would only repeat it.
 *
 * @param runtime - the lifecycle manager.
 * @param request - prompt plus the aligned canvas.
 * @param signal - caller cancellation.
 * @returns the images, the worker's stage timings, and how the worker was obtained.
 */
async function generateWithWorker(
  runtime: WorkerRuntime,
  request: Parameters<typeof generateViaLocal>[1],
  signal: AbortSignal,
): Promise<{ images: GeneratedImage[]; stages: Record<string, number>; handle: WorkerHandle; restarted: boolean }> {
  const handle = await runtime.ensure(signal)
  const finish = (generation: LocalGeneration, used: WorkerHandle, restarted: boolean) => {
    runtime.noteActivity()
    runtime.armIdleUnload()
    return { images: generation.images, stages: generation.stages, handle: used, restarted }
  }
  try {
    return finish(await generateViaLocal(handle.endpoint, request, signal), handle, false)
  } catch (error) {
    if (!(error instanceof LocalUnreachableError) || signal.aborted) throw error
    await runtime.invalidate(`unreachable during /generate: ${error.message.slice(0, 160)}`)
    const retry = await runtime.ensure(signal)
    return finish(await generateViaLocal(retry.endpoint, request, signal), retry, true)
  }
}

/** The "no key, no ComfyUI, no worker" error, naming every remedy in order. */
function noBackendError(localReason: string, comfyReason?: string): Error {
  return new Error(
    'qwen_image_generate: no backend is available.\n' +
      '  • cloud: no API key found — set `apiKey` in the plugin config, or one of ' +
      `${API_KEY_ENV_VARS.join(' / ')}. The key is read at call time and never written to disk.\n` +
      (comfyReason === undefined ? '' : `  • comfyui: ${comfyReason}\n`) +
      `  • local: ${localReason}`,
  )
}

/**
 * The edit path's "neither local backend is available" error.
 *
 * Editing has no cloud fallback, so this must not tell the caller to go set an
 * API key: with a key configured the message says outright that the key is not
 * the problem.
 *
 * @param comfyReason - why ComfyUI could not serve the edit.
 * @param localReason - why the managed worker could not serve the edit.
 * @param keyPresent - whether a cloud key is configured (to rule it out).
 * @returns the error to throw.
 */
function noEditBackendError(comfyReason: string, localReason: string, keyPresent: boolean): Error {
  return new Error(
    'qwen_image_edit: neither local backend could run the edit.\n' +
      `  • comfyui: ${comfyReason}\n` +
      `  • local: ${localReason}\n` +
      (keyPresent
        ? '  • cloud: an API key is configured, but the cloud backend has no edit path — it cannot take reference images at all.\n'
        : '') +
      '  改图是本机功能：起好本机 ComfyUI（带 Qwen-Image 权重）或让插件的本地 worker 能跑起来（`qwen_image_env` 的 status 看缺什么）。',
  )
}

/** The size gate's verdict for one local edit request. */
export interface LocalEditBudgetGate {
  /** The **effective** budget: the configured one, or the canvas-derived one. */
  readonly budget: number
  /** Where {@link budget} came from — an explicit `localReferenceBudget`, or the canvas. */
  readonly budgetSource: 'config' | 'canvas'
  /** What the canvas alone derives; reported even when the config overrode it. */
  readonly canvasBudget: number
  /** Which measured band that budget falls into. */
  readonly tier: LocalEditBudgetTier
  /** False only when the budget is over the edge line and the override is off. */
  readonly allowed: boolean
  /** True when the override is what let an over-budget call through. */
  readonly overridden: boolean
  /** What the caller must be told, or null in the reliable band. */
  readonly warning: string | null
}

/**
 * The **canvas-side** half of the gate's advice: a warning, never a refusal.
 *
 * The bands band the conditioning budget alone, because that is what the failure
 * boundary tracks. The *speed* boundary does not: `docs/evidence/r5-budget-canvas-matrix.md` measured budget
 * 896 at 1.9 s/step on a 0.82 MP canvas and at **67 s/step** on a 1.55 MP one —
 * the same budget, ≈28 min for 25 steps instead of ≈1. All of it without an
 * error, so nothing else in the stack would have told the caller.
 *
 * So a canvas over {@link LOCAL_EDIT_CANVAS_WARN_AREA} whose *effective* budget is
 * over the one budget ever measured to finish there
 * ({@link LOCAL_EDIT_CANVAS_SAFE_BUDGET}) gets a warning naming both endpoints.
 *
 * Only the bands that **let the request through** compose this text: its last
 * move is "this is advice, not a refusal", which cannot be said inside a refusal.
 *
 * @param width - requested canvas width, in pixels.
 * @param height - requested canvas height, in pixels.
 * @param budget - the effective (post-override) conditioning budget.
 * @returns the warning text, or `null` when either threshold is not crossed.
 */
function canvasSideWarning(width: number, height: number, budget: number): string | null {
  const area = width * height
  if (budget <= LOCAL_EDIT_CANVAS_SAFE_BUDGET || area <= LOCAL_EDIT_CANVAS_WARN_AREA) return null
  const megapixels = (area / 1_000_000).toFixed(2)
  return (
    `本地编辑尺寸门·画布侧警告：这张画布 ${width}×${height}（${megapixels} MP）大于 1.0 MP，` +
    `而生效预算 ${budget} 大于 ${LOCAL_EDIT_CANVAS_SAFE_BUDGET}——两者同时成立时实测**慢到不可用**（不是拒绝，本档仍然放行）。\n` +
    `  本机实测：0.82 MP（1216×672）+ 预算 896 → 1.9 s/步；1.55 MP（1248×1248）+ 同一条 896 → **67 s/步**、` +
    `25 步外推 ≈28 min（不报错，被运行器墙钟杀掉）；1.55 MP + ${LOCAL_EDIT_CANVAS_SAFE_BUDGET} → wall 109.5 s、峰值 reserved 6488 MiB、worker 存活。\n` +
    `  1.0 MP 这条线落在两个实测端点之间，是**插值**（未测）；1.5MP 画布上量过的只有 ${LOCAL_EDIT_CANVAS_SAFE_BUDGET}（跑完）与 896（跑不完）两点，` +
    `${LOCAL_EDIT_CANVAS_SAFE_BUDGET + 1}–${LOCAL_EDIT_BUDGET_RELIABLE - 1} 这段没量过。\n` +
    `  建议：把配置 \`localReferenceBudget\` 设成 ${LOCAL_EDIT_CANVAS_SAFE_BUDGET}（出图尺寸不变，只是参考图条件化分辨率变低），` +
    `或改用 backend:"comfyui"。出处：docs/evidence/r5-budget-canvas-matrix.md。`
  )
}

/**
 * Decide whether a **local** edit may run at the canvas it asked for.
 *
 * The three bands come from the conditioning budget, not from the canvas area: the
 * failure boundary tracks `_reference_budget` (§(b) shows two differently shaped
 * canvases with the same budget failing the same way). Every number below is this
 * card class's own measurement, and the refusal is worded so it cannot be mistaken
 * for the pre-start VRAM gate's advice.
 *
 * The budget banded here is the one the worker will really use: an explicit
 * `localReferenceBudget` overrides the canvas derivation on both sides, so a
 * `512` config lets a 1248×1248 canvas through as a 512 edit. Banding the canvas
 * value instead would make the knob unable to do the one thing it exists for.
 *
 * @param width - requested canvas width, in pixels.
 * @param height - requested canvas height, in pixels.
 * @param allowOverBudget - the explicit opt-in (`allowLocalEditOverBudget`).
 * @param configuredBudget - `localReferenceBudget`; `0` means "derive from the canvas".
 * @returns the verdict, plus the text the caller must see whenever it is not the
 *   clean reliable band.
 * @throws When `configuredBudget` is neither `0` nor a 32-aligned budget in range.
 */
export function localEditBudgetGate(
  width: number,
  height: number,
  allowOverBudget: boolean,
  configuredBudget = 0,
): LocalEditBudgetGate {
  const { budget, source, canvasBudget } = resolveReferenceBudget(width, height, configuredBudget)
  const tier = localEditBudgetTier(budget)
  // The canvas half is decided once and appended to whichever band lets the
  // request through, so `warning` is never silently dropped and never split.
  const canvasWarning = canvasSideWarning(width, height, budget)
  const withCanvas = (text: string) => (canvasWarning === null ? text : `${text}\n${canvasWarning}`)
  const where =
    `画布 ${width}×${height} → 参考图条件化预算 _reference_budget = ${budget}` +
    (source === 'config'
      ? `（来自配置 localReferenceBudget；这张画布本身会推出 ${canvasBudget}）`
      : '（按画布推导；可用配置 localReferenceBudget 覆盖）')
  if (tier === 'reliable') {
    // The canvas warning is the only reason this band is not always silent: the
    // budget is fine, the canvas it will be paid on is not.
    return { budget, budgetSource: source, canvasBudget, tier, allowed: true, overridden: false, warning: canvasWarning }
  }
  if (tier === 'edge') {
    return {
      budget,
      budgetSource: source,
      canvasBudget,
      tier,
      allowed: true,
      overridden: false,
      warning: withCanvas(
        `本地编辑尺寸门警告：${where}，落在「贴边通过」档（> 可靠线 ${LOCAL_EDIT_BUDGET_RELIABLE}，≤ ${LOCAL_EDIT_BUDGET_EDGE}）。\n` +
          `  本机实测（RTX 4070 Laptop 8188 MiB）这一档确实通过了，但峰值 reserved 8492 MiB 已经超过显卡总量 8188 MiB，` +
          `靠 WDDM 共享内存撑住，去噪 21.19 s ≈ 928 档的 2 倍——能过，但可能显著变慢，也可能失败。\n` +
          `  要可靠就把 _reference_budget 降到 ≤ ${LOCAL_EDIT_BUDGET_RELIABLE}（例如 1216×672——896 那条线正是在这张 0.82 MP 画布上量的），` +
          `或改用 backend:"comfyui"。出处：docs/evidence/r4b-local-edit-failures.md §(b)。`,
      ),
    }
  }
  const over =
    `本地编辑尺寸门：拒绝这次 local 编辑（${where} > 上限 ${LOCAL_EDIT_BUDGET_EDGE}）。\n` +
    '  为什么拦：本机实测这条路径上的失败**不是**一条干净的「显存不足」——' +
    'budget 992–1024 在 **GPU 去噪段** CUDA OOM（申请 180/182 MiB，而仍有 910–1030 MiB reserved-but-unallocated 的碎片签名）；' +
    'budget ≥ 1216 更发生在 GPU 还没开始干活的 **CPU 文本编码段**，形态是**访问违例 / access violation**，' +
    '有时直接带走 worker 进程（连接被重置，日志停在 `ready:`）。\n' +
    '  所以别照着「空闲显存不足 → 先给 ComfyUI 发 POST /free」那条补救提示折腾：这条线由参考图条件化 token 数决定，与空闲显存无关。\n' +
    '  四条出路：① 改用 comfyui 后端（`backend:"comfyui"`，或 `auto` 且本机 ComfyUI 可用——8 GB 卡上编辑本来就优先走它）；' +
    `② 显式给更小的 width/height（可靠档 _reference_budget ≤ ${LOCAL_EDIT_BUDGET_RELIABLE}，例如 1216×672）；` +
    `③ 把配置 \`localReferenceBudget\` 调到 ${LOCAL_EDIT_CANVAS_SAFE_BUDGET}——但要知道 **896 这条「可靠线」只按预算分档、不含画布本身的代价**：` +
    `它的实测出处是 1216×672（0.82 MP：峰值 reserved 7458 MiB、1.9 s/步），同一预算搬到 1.5MP 画布（1248×1248）上是 ` +
    `**67 s/步**、25 步外推 ≈28 min（不报错，但等于不可用）——那张画布上唯一实测跑得完的是 ${LOCAL_EDIT_CANVAS_SAFE_BUDGET}` +
    `（wall 109.5 s、峰值 reserved 6488 MiB、worker 存活），${LOCAL_EDIT_CANVAS_SAFE_BUDGET + 1}–${LOCAL_EDIT_BUDGET_RELIABLE - 1} 这段没量过；` +
    '降的是参考图条件化分辨率，换速度与可跑性——保真度：同画布（1216×672）896 vs 512 目视看不出差别（n=1、1 位评判者），1.5MP 画布上只测了 512；' +
    '④ 接受风险、显式放行：配置 `allowLocalEditOverBudget: true`（默认 false）。\n' +
    '  出处：docs/evidence/r4b-local-edit-failures.md §(a)/§(b)、docs/evidence/r5-budget-canvas-matrix.md。'
  if (!allowOverBudget) return { budget, budgetSource: source, canvasBudget, tier, allowed: false, overridden: false, warning: over }
  return {
    budget,
    budgetSource: source,
    canvasBudget,
    tier,
    allowed: true,
    overridden: true,
    warning: withCanvas(
      `本地编辑尺寸门：allowLocalEditOverBudget 为 true，按用户显式授权放行（${where}）。\n` +
        '  预期风险（本机实测）：992–1024 在 GPU 去噪段 CUDA OOM；≥1216 在 CPU 文本编码段访问违例，worker 进程可能直接消失。' +
        '出处：docs/evidence/r4b-local-edit-failures.md §(a)。',
    ),
  }
}

/**
 * Run one **local** edit, after the size gate has had its say.
 *
 * The gate lives here rather than at the top of the tool body because `comfyui` is
 * one of the three ways out the refusal names: a request that ComfyUI is going to
 * serve must never be refused by this gate. Only the two paths that really reach the
 * worker pass through here, and they do so **before** `runtime.ensure`, so a refused
 * call never spawns a process.
 *
 * The gate's verdict is also what the request body carries: an explicit
 * `localReferenceBudget` is forwarded as `reference_budget` so the worker
 * conditions at the budget the gate just banded. With no override the field is
 * **absent**, and the worker derives the budget exactly as it always has.
 *
 * @param runtime - the one lifecycle owner.
 * @param body - the resolved local `/generate` body (references included, steps
 *   already decided — the gate never re-derives it).
 * @param size - the canvas the gate budgets against.
 * @param settings - resolved config, for the opt-in flag and the budget override.
 * @param signal - aborts the request on tool cancellation.
 * @returns the worker run plus the gate verdict, for the result payload.
 * @throws When the budget is over the line and the override is off.
 */
async function editWithWorker(
  runtime: WorkerRuntime,
  body: Parameters<typeof generateViaLocal>[1],
  size: { width: number; height: number },
  settings: ForgeSettings,
  signal: AbortSignal,
): Promise<{ run: Awaited<ReturnType<typeof generateWithWorker>>; gate: LocalEditBudgetGate }> {
  const configured = settings.localReferenceBudget
  const gate = localEditBudgetGate(size.width, size.height, settings.allowLocalEditOverBudget, configured)
  if (!gate.allowed) throw new Error(gate.warning ?? `local edit refused: budget ${gate.budget}`)
  const request = gate.budgetSource === 'config' ? { ...body, referenceBudget: gate.budget } : body
  return { run: await generateWithWorker(runtime, request, signal), gate }
}

/**
 * Register the tools on the tool registry.
 *
 * @param ctx - cordis context providing `tools`.
 * @param config - resolved plugin config.
 */
export function registerImageForgeTools(ctx: Context, config: Config): void {
  const settings = resolveSettings(config)
  // One lifecycle owner per plugin instance: it starts the worker on first use,
  // reaps it after idleness, and rebuilds it when it disappears.
  const runtime = createRuntime(settings)
  ctx.on?.('dispose', () => {
    void runtime.stop()
  })

  ctx.tools.register(defineTool({
    name: 'qwen_image_generate',
    description:
      '用 Qwen-Image 出图。`prompt` 收**成品**提示词（本工具不改写），`wh_ratio` 是**一等参数**：' +
      `直接接受官方契约的 7 档画幅比（${WH_RATIOS.join(' / ')}），插件自己换算成 ${SIZE_MULTIPLE} 对齐的像素尺寸——` +
      '所以「契约输出 → 插件入参」不需要人工翻译。省略 wh_ratio 用 1:1，给了 width/height 则以它们为准。' +
      '结果落盘到配置的 outputDir 并把绝对路径写进正文 Markdown，同时回传结构化字段。',
    parameters: GENERATE_PARAMETERS,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const payload = value as { markdown?: string; images?: { path: string }[]; summary?: string }
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
      },
    },
    // `timeoutMs` is the per-generation budget, but a cold worker start has its
    // own (longer) budget: the tool call must not die while the model loads.
    timeoutMs: Math.max(settings.timeoutMs, settings.workerStartTimeoutMs + 60_000),
    // One generation is a heavy, rate-limited call; never overlap siblings.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const prompt = args.prompt.trim()
      if (prompt.length === 0) throw new Error('prompt must not be blank')
      const size = chooseSize(args.wh_ratio, asInteger(args.width, 'width'), asInteger(args.height, 'height'))
      const count = validateCount(args.count)
      const steps = asInteger(args.steps, 'steps')
      if (steps !== undefined && steps < 1) throw new Error(`steps must be >= 1, got ${steps}`)
      const requestedBackend = args.backend ?? settings.backend
      const request = {
        prompt,
        width: size.width,
        height: size.height,
        count,
        steps,
        seed: asInteger(args.seed, 'seed'),
        transparent: args.transparent === true,
      }
      const startedAt = Date.now()

      let usedBackend: 'api' | 'local' | 'comfyui'
      let backendLabel: string
      let comfyUnet: string | null = null
      let comfyRun: Record<string, unknown> | null = null
      let workerRun: Record<string, unknown> | null = null
      let images: GeneratedImage[]
      // Set by whichever branch actually ran, so the result can report the count
      // that was really used and where it came from (a fallback counts as a
      // different backend, and so may resolve a different count).
      let usedSteps: StepsResolution | undefined
      if (requestedBackend === 'api' || (requestedBackend === 'auto' && settings.apiKey.length > 0)) {
        if (settings.apiKey.length === 0) {
          throw new Error(
            'qwen_image_generate: backend "api" needs a key. Set `apiKey` in the plugin config or one of ' +
              `${API_KEY_ENV_VARS.join(' / ')}; it is read at call time and never written to disk.`,
          )
        }
        const apiSettings: ApiSettings = {
          baseUrl: settings.apiBaseUrl,
          apiKey: settings.apiKey,
          model: settings.apiModel,
          style: settings.apiStyle,
        }
        usedSteps = resolveSteps(steps, 'api', settings)
        images = await generateViaApi(apiSettings, { ...request, steps: usedSteps.steps }, exec.signal)
        usedBackend = 'api'
        backendLabel = `后端 api / ${settings.apiModel}`
      } else if (requestedBackend === 'local') {
        usedSteps = resolveSteps(steps, 'local', settings)
        const run = await generateWithWorker(runtime, { ...request, steps: usedSteps.steps }, exec.signal)
        images = run.images
        workerRun = describeWorkerRun(run.handle, run.restarted, run.stages)
        usedBackend = 'local'
        backendLabel = run.handle.started
          ? `后端 local（插件自启 worker pid ${run.handle.pid ?? '?'}，启动 ${run.handle.startMs} ms）`
          : '后端 local'
      } else {
        // `comfyui`, or `auto` without a key: the local ComfyUI first (it is the
        // only backend that needs no key and no worker), the worker second.
        const options = comfyOptions(settings)
        try {
          const target = await discoverComfyUi(options, exec.signal)
          const models: ComfyModels = await loadComfyModels(target, options, exec.signal)
          const comfyStartedAt = Date.now()
          usedSteps = resolveSteps(steps, 'comfyui', settings)
          images = await generateViaComfyUi(target, models, { ...request, steps: usedSteps.steps }, options, exec.signal)
          usedBackend = 'comfyui'
          comfyUnet = models.unet
          backendLabel = `后端 comfyui / ${target.endpoint} / ${models.unet}`
          comfyRun = {
            endpoint: target.endpoint,
            port: target.port,
            probed: target.probed,
            models,
            // The workflow has no alpha handling, so this backend ignores the
            // flag rather than pretending it honoured it.
            transparent_requested: request.transparent,
            elapsed_ms: Date.now() - comfyStartedAt,
          }
        } catch (error) {
          const comfyReason = error instanceof Error ? error.message : String(error)
          if (requestedBackend === 'comfyui') throw error
          try {
            usedSteps = resolveSteps(steps, 'local', settings)
            const run = await generateWithWorker(runtime, { ...request, steps: usedSteps.steps }, exec.signal)
            images = run.images
            workerRun = describeWorkerRun(run.handle, run.restarted, run.stages)
            usedBackend = 'local'
            backendLabel = '后端 local'
          } catch (localError) {
            throw noBackendError(localError instanceof Error ? localError.message : String(localError), comfyReason)
          }
        }
      }

      const prefix = sanitizePrefix(args.preset)
      const written = await writeImages(settings.outputDir, prefix, size.width, size.height, images)
      const markdown = renderMarkdown(written)

      return {
        ok: true,
        backend: usedBackend,
        model: usedBackend === 'api' ? settings.apiModel : comfyUnet,
        wh_ratio: size.whRatio,
        wh_ratio_requested: args.wh_ratio ?? null,
        size: { width: size.width, height: size.height },
        size_source: size.sizeSource,
        ratio_deviation_percent: size.ratioDeviationPercent,
        exact_ratio: size.exactRatio,
        count,
        steps: steps ?? null,
        steps_used: usedSteps?.steps ?? null,
        steps_source: usedSteps?.source ?? null,
        seed: request.seed ?? null,
        transparent: request.transparent,
        prompt_chars: prompt.length,
        output_dir: settings.outputDir,
        images: written.map((image) => ({
          index: image.index,
          path: image.path,
          bytes: image.bytes,
          mime: sniffImageMime(images[image.index - 1]?.bytes ?? new Uint8Array()) ?? image.mime,
        })),
        comfyui: comfyRun,
        local_worker: workerRun,
        vram_gate: describeVramGate(runtime),
        markdown,
        summary:
          `出图完成：${written.length} 张，${size.width}×${size.height}（wh_ratio ${size.whRatio}` +
          `${size.exactRatio ? '' : `，实际 ${size.ratioDeviationPercent > 0 ? '+' : ''}${size.ratioDeviationPercent}%`}），` +
          `${backendLabel}，落盘 ${settings.outputDir}。`,
        elapsed_ms: Date.now() - startedAt,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qwen_image_edit',
    description:
      '用 Qwen-Image 2.1 做**参考图编辑（图生图）**：给 1 张或多张参考图 + 一段**成品修改指令**，出改好的图。' +
      `\`images\` 收 1–${MAX_REFERENCES} 张参考图（绝对路径或 data:image/…;base64,…，按顺序对应提示词里的 \`<image1>\`…\`<imageN>\`），` +
      '`ratio_follow` 让画布**跟随某张参考图的宽高比**（写 `image1`…`image10`，或直接把 `images` 里的那一项再写一遍）；' +
      '它与 `wh_ratio` **互斥**（官方契约里一个非空另一个必须为空），两个都不给时**默认跟随第一张参考图**。' +
      '编辑只在本机后端跑：`comfyui`（官方 Qwen-Image 2.1 改图工作流，参考图先上传进 ComfyUI）或 `local`（受管 worker，/generate 多一个 images 字段）；' +
      '云 API 没有编辑通道，强行指定时会明确报错，绝不静默丢掉参考图。' +
      `**local 有硬尺寸门**：按**生效的**参考图条件化预算 _reference_budget 分档（配置了 \`localReferenceBudget\` 就用它，否则按画布推导）——≤ ${LOCAL_EDIT_BUDGET_RELIABLE} 放行、` +
      `${LOCAL_EDIT_BUDGET_RELIABLE}–${LOCAL_EDIT_BUDGET_EDGE} 放行并在结果里带警告、> ${LOCAL_EDIT_BUDGET_EDGE} 默认拒绝（失败形态是访问违例/进程消失，不是「显存不足」；` +
      '出路是 comfyui、更小的 width/height、把 `localReferenceBudget` 调到 512（**1.5MP 画布上唯一实测跑得完的档**：wall 109.5 s、峰值 reserved 6488 MiB、worker 存活；896 在同一张 1248×1248 上是 67 s/步、25 步外推 ≈28 min——不报错，但等于不可用；896 那条可靠线的实测出处是 1216×672 画布，一档只看预算、不含画布代价。保真度：同画布 896 vs 512 目视看不出差别，n=1、1 位评判者）；' +
      '或配置 `allowLocalEditOverBudget: true`）。`comfyui` 不受这道门约束。' +
      '结果落盘到 outputDir 并把绝对路径写进正文 Markdown。',
    parameters: EDIT_PARAMETERS,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const payload = value as { markdown?: string; images?: { path: string }[]; summary?: string }
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
      },
    },
    // Same reasoning as `qwen_image_generate`: a cold worker start has its own budget.
    timeoutMs: Math.max(settings.timeoutMs, settings.workerStartTimeoutMs + 60_000),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
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
      const requestedBackend = args.backend ?? settings.backend
      const request = {
        prompt,
        width: size.width,
        height: size.height,
        count,
        steps,
        seed: asInteger(args.seed, 'seed'),
        transparent: args.transparent === true,
        images: references,
      }
      const startedAt = Date.now()

      let usedBackend: 'local' | 'comfyui'
      let backendLabel: string
      let comfyUnet: string | null = null
      let comfyRun: Record<string, unknown> | null = null
      let workerRun: Record<string, unknown> | null = null
      let images: GeneratedImage[]
      let usedSteps: StepsResolution | undefined
      // Set only when the worker is the backend that ran: the gate is about the
      // local conditioning budget, so a ComfyUI run has nothing to report here.
      let budgetGate: LocalEditBudgetGate | null = null
      if (requestedBackend === 'api') {
        throw new Error(
          'qwen_image_edit: backend "api" 没有编辑通道，参考图不会被丢给一个用不了它们的后端。' +
            '云 API 的编辑是另一种请求形态（multipart POST /images/edits，或 DashScope 的原生异步任务接口），本插件没有实现它。\n' +
            '  能编辑的两个后端都是本机的，不需要 key：backend "comfyui"（复用本机已装好的 ComfyUI + Qwen-Image 权重）' +
            '或 "local"（插件自己拉起 worker）。',
        )
      } else if (requestedBackend === 'local') {
        usedSteps = resolveSteps(steps, 'local', settings)
        const gated = await editWithWorker(runtime, { ...request, steps: usedSteps.steps }, size, settings, exec.signal)
        budgetGate = gated.gate
        images = gated.run.images
        workerRun = describeWorkerRun(gated.run.handle, gated.run.restarted, gated.run.stages)
        usedBackend = 'local'
        backendLabel = gated.run.handle.started
          ? `后端 local（插件自启 worker pid ${gated.run.handle.pid ?? '?'}，启动 ${gated.run.handle.startMs} ms）`
          : '后端 local'
      } else {
        // `comfyui`, or `auto`: editing is local-only, so `auto` never tries the
        // cloud endpoint even when a key is configured.
        const options = comfyOptions(settings)
        try {
          const target = await discoverComfyUi(options, exec.signal)
          const models: ComfyModels = await loadComfyModels(target, options, exec.signal)
          const comfyStartedAt = Date.now()
          usedSteps = resolveSteps(steps, 'comfyui', settings)
          images = await generateViaComfyUiEdit(target, models, { ...request, steps: usedSteps.steps }, options, exec.signal)
          usedBackend = 'comfyui'
          comfyUnet = models.unet
          backendLabel = `后端 comfyui / ${target.endpoint} / ${models.unet}`
          comfyRun = {
            endpoint: target.endpoint,
            port: target.port,
            probed: target.probed,
            models,
            references_uploaded: references.map((reference) => reference.label),
            transparent_requested: request.transparent,
            elapsed_ms: Date.now() - comfyStartedAt,
          }
        } catch (error) {
          const comfyReason = error instanceof Error ? error.message : String(error)
          if (requestedBackend === 'comfyui') throw error
          try {
            usedSteps = resolveSteps(steps, 'local', settings)
            const gated = await editWithWorker(runtime, { ...request, steps: usedSteps.steps }, size, settings, exec.signal)
            budgetGate = gated.gate
            images = gated.run.images
            workerRun = describeWorkerRun(gated.run.handle, gated.run.restarted, gated.run.stages)
            usedBackend = 'local'
            backendLabel = '后端 local'
          } catch (localError) {
            throw noEditBackendError(
              comfyReason,
              localError instanceof Error ? localError.message : String(localError),
              settings.apiKey.length > 0,
            )
          }
        }
      }

      const prefix = sanitizePrefix(args.preset, 'edit')
      const written = await writeImages(settings.outputDir, prefix, size.width, size.height, images)
      const markdown = renderMarkdown(written)
      const followed = size.followed
      const followLabel = followed === null ? null : `image${followed.index}`

      return {
        ok: true,
        backend: usedBackend,
        model: comfyUnet,
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
        steps_used: usedSteps?.steps ?? null,
        steps_source: usedSteps?.source ?? null,
        seed: request.seed ?? null,
        transparent: request.transparent,
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
        api_skipped: requestedBackend === 'auto' && settings.apiKey.length > 0 ? 'no edit path on the cloud backend' : null,
        comfyui: comfyRun,
        local_worker: workerRun,
        // Only the local backend has a conditioning budget to gate, so a ComfyUI run
        // reports null here rather than a threshold it was never measured against.
        local_edit_budget:
          budgetGate === null
            ? null
            : {
                budget: budgetGate.budget,
                // Which budget the gate banded, and what the canvas alone would have
                // derived: a configured override changes the first and not the second,
                // and only reporting both makes that visible.
                budget_source: budgetGate.budgetSource,
                canvas_budget: budgetGate.canvasBudget,
                configured_budget: settings.localReferenceBudget,
                tier: budgetGate.tier,
                reliable_max: LOCAL_EDIT_BUDGET_RELIABLE,
                edge_max: LOCAL_EDIT_BUDGET_EDGE,
                allowed: budgetGate.allowed,
                overridden: budgetGate.overridden,
                warning: budgetGate.warning,
              },
        vram_gate: describeVramGate(runtime),
        markdown,
        summary:
          `改图完成：${written.length} 张，${size.width}×${size.height}（` +
          (followLabel === null
            ? `wh_ratio ${size.whRatio}`
            : `ratio_follow ${followLabel}${size.followedByDefault ? '（默认跟随第一张参考图）' : ''} ← ${followed?.width}×${followed?.height}`) +
          `${size.exactRatio ? '' : `，实际 ${size.ratioDeviationPercent > 0 ? '+' : ''}${size.ratioDeviationPercent}%`}），` +
          `${references.length} 张参考图，${backendLabel}，落盘 ${settings.outputDir}。` +
          // The warning is the point of the edge band: it has to travel with the
          // result, not only sit in the returned JSON.
          (budgetGate?.warning == null ? '' : `\n${budgetGate.warning}`),
        elapsed_ms: Date.now() - startedAt,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qwen_image_env',
    description:
      '本机环境体检与**本地运行时管理**（这个插件自己拥有 venv / 权重 / worker 的生命周期）。\n' +
      '`status`（默认）：GPU 名与驱动、**显存余量（低于阈值就预警，并指名是谁占着——本机实测 ComfyUI 常驻约 2.9 GiB，' +
      '给出它的 POST /free 命令；一个占用者都报不出来时也会说明那多半是分配器缓存、而不是「没人占着」）**、宿主内存、磁盘、输出目录、云 API 与 worker 端点，以及 venv/权重/worker 是否就绪。\n' +
      '`install`：建 venv + 装 CUDA 版 torch（cu128 → cu126 → cu118 逐级降级；**已经装了 CUDA torch 就复用，不重装**）；' +
      '先跑 `dryRun:true` 可以只看计划。\n' +
      '`fetch-weights`：从 hf-mirror.com 下载 10.63 GiB 的 nf4 权重（**不用 huggingface.co，它的 /api/ 会超时**）：' +
      '下载前查磁盘、断点续传、逐文件 sha256 校验、可选剔除不被管线读取的 lm_head.weight。\n' +
      '`unload`：调 worker 的 POST /unload 把显存还回去（进程留着，下一张图会重新加载）。\n' +
      '`repair`：能修就修（缺包补装、量化开关没开就补写、worker 卡死就杀掉），不能修就**明确报因 + 给下一步**，绝不假装成功。',
    parameters: {
      action: {
        type: 'string',
        enum: ENV_ACTIONS,
        description: '要执行的动作；默认 status。',
      },
      dryRun: {
        type: 'boolean',
        description: '只报告计划、不改机器（install / fetch-weights / repair 都支持）。',
      },
      force: {
        type: 'boolean',
        description: 'fetch-weights：磁盘空间检查不通过时仍然尝试下载。',
      },
      skipLmHead: {
        type: 'boolean',
        description:
          'fetch-weights：下完后从 text_encoder/model.safetensors 里剔除 lm_head.weight（约 1187 MiB，管线取 hidden_states[-1]，从不使用它）。' +
          '默认取插件配置；**未在本机验证过**，剔除前会校验重写结果，校验不过就保留原文件。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    // installs and downloads are long; the internal command budgets are the real limit.
    timeoutMs: 3_600_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const action = args.action ?? 'status'
      const dryRun = args.dryRun === true
      if (action === 'status') {
        const comfyui = await probeComfyUi(comfyOptions(settings, Math.min(settings.timeoutMs, 10_000)), exec.signal)
        const localRuntime = await collectLocalRuntime({
          runtime,
          runtimeDir: settings.runtimeDir,
          python: settings.pythonPath,
          modelsDir: settings.modelsDir,
          dataDir: settings.runtimeDir,
          probeTimeoutMs: Math.min(settings.timeoutMs, 15_000),
          scratchDir: settings.scratchDir,
          signal: exec.signal,
        })
        const status = await collectEnvStatus(
          {
            apiBaseUrl: settings.apiBaseUrl,
            apiKeyPresent: settings.apiKey.length > 0,
            apiKeySource: settings.apiKeySource,
            localEndpoint: settings.localEndpoint,
            comfyui,
            outputDir: settings.outputDir,
            outputDirWritable: await ensureOutputDirWritable(settings.outputDir),
            probeTimeoutMs: Math.min(settings.timeoutMs, 10_000),
            minFreeVramMiB: settings.minFreeVramMiB,
            scratchDir: settings.scratchDir,
            localRuntime,
          },
          exec.signal,
        )
        const advisory = status.vram_advisory as VramAdvisory | undefined
        const advisories = advisory?.suggestions ?? []
        return {
          action,
          generated_at: new Date().toISOString(),
          config: {
            backend: settings.backend,
            apiModel: settings.apiModel,
            apiStyle: settings.apiStyle,
            outputDir: settings.outputDir,
            localEndpoint: settings.localEndpoint,
            comfyEndpoint: settings.comfyEndpoint,
            comfyPorts: settings.comfyPorts,
            timeoutMs: settings.timeoutMs,
            runtimeDir: settings.runtimeDir,
            modelsDir: settings.modelsDir,
            hfMirror: settings.hfMirror,
            workerPorts: settings.workerPorts,
            idleUnloadMs: settings.idleUnloadMs,
            manageWorker: settings.manageWorker,
            minFreeVramMiB: settings.minFreeVramMiB,
            freeComfyBeforeLocalStart: settings.freeComfyBeforeLocalStart,
            allowLocalEditOverBudget: settings.allowLocalEditOverBudget,
            localReferenceBudget: settings.localReferenceBudget,
          },
          // The same verdict the local worker's pre-start gate makes, so `status`
          // answers "would a generate call even be allowed to start the worker?".
          worker_start_gate: advisory === undefined ? null : {
            would_refuse_start: !advisory.start_gate.allowed,
            free_MiB: advisory.freeMiB,
            required_MiB: advisory.requiredMiB,
            shortfall_MiB: advisory.start_gate.shortfallMiB,
            holders: advisory.holders,
            remedy: advisory.start_gate.remedy,
            auto_free_enabled: settings.freeComfyBeforeLocalStart,
            // The same two shapes the pre-start gate distinguishes: a named holder
            // (free it with one request) versus no holder at all but no room either
            // (the allocator-cache form — `/free` still helps, and a retry a few
            // seconds later clears the OSError 1455 spawn failure).
            no_visible_holder: advisory.start_gate.no_visible_holder,
            suspicion: vramSuspicionWarning(advisory, settings.comfyPorts[0] ?? 8188),
            note:
              advisory.start_gate.allowed
                ? `空闲 ${advisory.freeMiB ?? '?'} MiB ≥ 阈值 ${advisory.requiredMiB} MiB：本地 worker 允许启动。` +
                  (advisory.holders.length > 0
                    ? `但当时有 ${advisory.holders.length} 个进程占着显存，见 suspicion（8 GB 卡上这部分余量会在加载时被吃掉）。`
                    : '')
                : `空闲 ${advisory.freeMiB ?? '?'} MiB < 阈值 ${advisory.requiredMiB} MiB：本地 worker 会被拒绝启动` +
                  `（还差 ${advisory.start_gate.shortfallMiB ?? '?'} MiB）。` +
                  (advisory.start_gate.no_visible_holder
                    ? 'nvidia-smi 没报占用者也**不能读成没人占着**：ComfyUI 跑完会把约 3.6 GiB 的 `cudaMallocAsync` ' +
                      '分配器缓存留在自己进程里、而它列不出来' +
                      '（见 `docs/configuration.md`「一个会让人卡住的显存陷阱（8 GB 卡必读）」）。' +
                      '补救是 `POST /free` + 隔十几秒重跑。'
                    : '') +
                  (settings.freeComfyBeforeLocalStart
                    ? '`freeComfyBeforeLocalStart` 已开启，插件会先请求 ComfyUI 释放再启动。'
                    : '默认不会替你去动 ComfyUI；执行 remedy 里那条命令，或把 `freeComfyBeforeLocalStart` 设为 true。'),
          },
          advisories,
          ...status,
        }
      }
      if (action === 'install') {
        const report = await runInstall({
          runtimeDir: settings.runtimeDir,
          pipwrap: settings.pipwrapPath,
          basePythonCandidates: settings.basePythonCandidates,
          torchWheels: settings.torchWheels,
          pipIndexUrl: settings.pipIndexUrl,
          reuseBaseTorch: settings.reuseBaseTorch,
          dryRun,
          commandTimeoutMs: 3_600_000,
          scratchDir: settings.scratchDir,
        })
        return { ...report, packages_expected: RUNTIME_PACKAGES }
      }
      if (action === 'fetch-weights') {
        return await runFetchWeights({
          repo: settings.modelRepo,
          mirror: settings.hfMirror,
          revision: 'main',
          dir: settings.modelsDir,
          skipLmHead: args.skipLmHead ?? settings.skipLmHead,
          dryRun,
          force: args.force === true,
          scratchDir: settings.scratchDir,
          stallTimeoutMs: 120_000,
          signal: exec.signal,
        })
      }
      if (action === 'unload') {
        const before = await runtime.inspect(runtime.endpoint, 1500, exec.signal)
        const outcome = await runtime.unload()
        const after = await runtime.inspect(runtime.endpoint, 1500, exec.signal)
        const status = typeof outcome.http_status === 'number' ? outcome.http_status : null
        return {
          action,
          ...outcome,
          vram_before_MiB: before.state?.vram_allocated_MiB ?? null,
          vram_after_MiB: after.state?.vram_allocated_MiB ?? null,
          note:
            outcome.ok === true
              ? '显存已交回；worker 进程仍在，下一张图会触发重新加载（约 10 s 起）。'
              : status === 404
                ? '这个 worker 实现了冻结契约但没有 /unload 端点（多半是别人起的旧 worker）：本插件只能放弃回收，或者用 `manageWorker:true` 让它换成随包 worker。'
                : status !== null
                  ? `worker 的 /unload 应答了 HTTP ${status}；显存没有交回，原文见 body。`
                  : '没有可回收的 worker（它本来就没在跑，显存已经是空着的）。',
        }
      }
      return await runRepair({
        runtime,
        runtimeDir: settings.runtimeDir,
        python: settings.pythonPath,
        modelsDir: settings.modelsDir,
        dataDir: settings.runtimeDir,
        pipwrap: settings.pipwrapPath,
        basePythonCandidates: settings.basePythonCandidates,
        torchWheels: settings.torchWheels,
        pipIndexUrl: settings.pipIndexUrl,
        reuseBaseTorch: settings.reuseBaseTorch,
        dryRun,
        commandTimeoutMs: 3_600_000,
        scratchDir: settings.scratchDir,
        signal: exec.signal,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qwen_image_status',
    description:
      '后端健康探测：云 API 端点是否可达、key 是否被接受（401/403 会点名）、**本机 ComfyUI 是否在跑**' +
      '（含探测过哪几个端口、三个 Qwen-Image 权重能不能被它的加载器枚举到），以及本地 worker 是否在跑。' +
      '不产生任何图片、不写盘、不改配置；**不会回显 key**。排障时先跑它。',
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
      const budget = Math.min(args.timeoutMs ?? settings.timeoutMs, 30_000)
      const [api, localWritable, comfyui] = await Promise.all([
        probeApi(
          { baseUrl: settings.apiBaseUrl, apiKey: settings.apiKey, model: settings.apiModel, style: settings.apiStyle },
          budget,
          exec.signal,
        ),
        generateViaLocalProbe(settings.localEndpoint, exec.signal),
        probeComfyUi(comfyOptions(settings, budget), exec.signal),
      ])
      // Passive on purpose: a status call must report, never start or stop anything.
      const [worker, weights] = await Promise.all([
        runtime.inspect(runtime.endpoint, Math.min(budget, 3000), exec.signal),
        inspectWeights(settings.modelsDir),
      ])
      const { stat } = await import('node:fs/promises')
      const venvPresent = await stat(settings.pythonPath).then(
        () => true,
        () => false,
      )
      return {
        checked_at: new Date().toISOString(),
        configured_backend: settings.backend,
        api: { baseUrl: settings.apiBaseUrl, model: settings.apiModel, style: settings.apiStyle, keySource: settings.apiKeySource ?? null, ...api },
        comfyui: { modelsDir: settings.comfyModelsDir.length > 0 ? settings.comfyModelsDir : null, ...comfyui },
        local: localWritable,
        worker: {
          endpoint: worker.endpoint,
          port: runtime.port,
          reachable: worker.reachable,
          ready: worker.ready,
          ours: worker.ours,
          pid: worker.state?.pid ?? null,
          load_error: worker.state?.load_error ?? null,
          log_file: runtime.logFile,
          lifecycle_events: runtime.events.slice(0, 5),
          note: worker.reachable
            ? undefined
            : `${worker.note ?? 'unreachable'} — worker 不在跑；下一次 \`qwen_image_generate\` 会自己把它拉起来`,
        },
        venv: { python: settings.pythonPath, exists: venvPresent },
        weights: { dir: settings.modelsDir, ready: weights.ready, missing_files: weights.missing_files, total_MiB: weights.total_MiB },
        output: { dir: settings.outputDir, writable: await ensureOutputDirWritable(settings.outputDir) },
      }
    },
  }))
}

/** Probe the local worker's health endpoint, reporting rather than throwing. */
async function generateViaLocalProbe(endpoint: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), 1500)
  const onAbort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(`${endpoint}/health`, { signal: controller.signal })
    return { endpoint, reachable: true, status: response.status, running: response.ok }
  } catch (error) {
    return {
      endpoint,
      reachable: false,
      running: false,
      note: `${error instanceof Error ? error.message : String(error)} — 本地 worker 不在跑，或 localEndpoint 配错了`,
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
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
