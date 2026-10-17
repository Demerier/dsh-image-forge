/**
 * Settings-page metadata for `dsh-image-forge`, as pure data.
 *
 * This module is the **single source of truth** for how the plugin's flat
 * schemastery `Config` is grouped, labelled and rendered. It is deliberately
 * free of React, of cordis and of any service lookup so both halves can use it:
 * the browser bundle renders the controls from {@link SETTINGS_FIELDS}, and the
 * test suite asserts that this table still covers every field the schema
 * declares — so a new config field cannot silently ship without a control.
 *
 * The Host does not need this table: under the 0.2.0 settings model the Host
 * derives the settings document from the plugin's own `Config` schema. This
 * table only describes *presentation*.
 */

/** The coarse buckets the settings page shows, in display order. */
export type SettingsGroupId = 'backend' | 'steps' | 'api' | 'local' | 'comfyui' | 'output' | 'python'

/** One display group (a titled block of fields). */
export interface SettingsGroup {
  /** Stable id; also the block's DOM key. */
  readonly id: SettingsGroupId
  /** Heading shown above the block. */
  readonly label: string
  /** One line explaining what the whole block is for. */
  readonly hint: string
}

/** How a field is rendered and validated in the page. */
export type FieldKind = 'enum' | 'string' | 'secret' | 'path' | 'number' | 'boolean'

/** One choice of an {@link FieldKind} `enum` field. */
export interface SettingsFieldOption {
  /** The value written to the config. */
  readonly value: string
  /** The human label shown in the dropdown. */
  readonly label: string
}

/** One configurable field as the settings page presents it. */
export interface SettingsField {
  /** The `Config` schema key this control writes. */
  readonly key: string
  /** Which block it belongs to. */
  readonly group: SettingsGroupId
  /** Control label. */
  readonly label: string
  /** One-line explanation shown under the control. */
  readonly hint: string
  /** How to render it. */
  readonly kind: FieldKind
  /** Choices, for `kind: 'enum'` only. */
  readonly choices?: readonly SettingsFieldOption[]
  /** Inclusive lower bound, for `kind: 'number'` only. */
  readonly min?: number
  /** Inclusive upper bound, for `kind: 'number'` only. */
  readonly max?: number
  /** Unit suffix shown next to a numeric control. */
  readonly unit?: string
  /** Greyed-out example shown while a text control is empty. */
  readonly placeholder?: string
  /**
   * Whether the field may be cleared back to "unset".
   *
   * Only meaningful on a numeric control: an empty box on a nullable field
   * writes `unset`, which is a real state (fall through to another setting)
   * rather than a zero.
   */
  readonly nullable?: boolean
}

/**
 * Placeholder for the runtime directory inside a hint.
 *
 * Two fields (`modelsDir`, `pythonPath`) resolve *relative to* `runtimeDir`, and
 * their values are deliberately left empty so they keep following it. The page
 * still has to show the user where things will land, and it must show the
 * **current** runtime directory rather than a baked one — so the hint carries
 * this token and {@link resolveHint} substitutes the live value at render time.
 *
 * The indirection exists because this module is bundled for the browser: it
 * cannot call `node:os` / `node:path` to compute a home directory, and a frozen
 * absolute path written into the source would go stale the moment the user moves
 * `runtimeDir`.
 */
export const RUNTIME_DIR_TOKEN = '<运行时目录>'

/**
 * Fill a hint's runtime-directory token from the live config.
 *
 * @param hint - the hint as authored, possibly containing {@link RUNTIME_DIR_TOKEN}.
 * @param value - the config values currently shown, read for `runtimeDir`.
 * @returns the hint with the token replaced, or the hint unchanged when the
 *   snapshot carries no usable `runtimeDir` yet — an unresolved token is better
 *   than a wrong path.
 */
export function resolveHint(hint: string, value: Record<string, unknown> | undefined): string {
  if (!hint.includes(RUNTIME_DIR_TOKEN)) return hint
  const runtimeDir = value?.['runtimeDir']
  if (typeof runtimeDir !== 'string' || runtimeDir.length === 0) return hint
  return hint.split(RUNTIME_DIR_TOKEN).join(runtimeDir)
}

/**
 * Whether a hint carries a file path.
 *
 * Paths are information rather than prose, so they get the larger budget in the
 * text-budget test.
 *
 * @param hint - the hint.
 * @returns true when it contains a path separator.
 */
export function hintHasPath(hint: string): boolean {
  return /[/\\]/.test(hint)
}

/** The blocks the page renders, in order. */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: 'backend',
    label: '后端选择',
    hint: '一次出图交给谁执行。',
  },
  {
    id: 'steps',
    label: '步数（画质与耗时）',
    hint: '两个后端的步数口径不同。',
  },
  {
    id: 'api',
    label: '云端 API',
    hint: '云端端点与密钥。',
  },
  {
    id: 'local',
    label: '本地运行时',
    hint: '本机 worker：目录、端口、显存。',
  },
  {
    id: 'comfyui',
    label: 'ComfyUI',
    hint: '已装好的 ComfyUI 也能当后端。',
  },
  {
    id: 'output',
    label: '输出与超时',
    hint: '图片落到哪里，等多久。',
  },
  {
    id: 'python',
    label: 'Python、依赖与权重（高级）',
    hint: '一般不用改；留空 = 自动。',
  },
]

/** Every configurable field, in page order. */
export const SETTINGS_FIELDS: readonly SettingsField[] = [
  {
    key: 'backend',
    group: 'backend',
    label: '后端',
    hint: 'auto：有 key 就云端，否则 ComfyUI、worker。',
    kind: 'enum',
    choices: [
      { value: 'auto', label: 'auto（自动选择）' },
      { value: 'api', label: 'api（云端 API）' },
      { value: 'local', label: 'local（本机 worker）' },
      { value: 'comfyui', label: 'comfyui（本机 ComfyUI）' },
    ],
  },
  {
    key: 'defaultSteps',
    group: 'steps',
    label: '默认步数',
    hint: '两边都没指定时用它。25 = 官方 ComfyUI 模板口径。',
    kind: 'number',
    min: 1,
    max: 200,
    unit: '步',
  },
  {
    key: 'comfyuiSteps',
    group: 'steps',
    label: 'ComfyUI 专用步数',
    hint: '留空 = 用默认步数。官方模板就是 25，一般不用改。',
    kind: 'number',
    min: 1,
    max: 200,
    unit: '步',
    nullable: true,
  },
  {
    key: 'localSteps',
    group: 'steps',
    label: '本机 worker 专用步数',
    hint: '留空 = 用默认步数。8 = 快但不是官方口径；25 约慢 2.7 倍。',
    kind: 'number',
    min: 1,
    max: 200,
    unit: '步',
    nullable: true,
  },
  {
    key: 'apiBaseUrl',
    group: 'api',
    label: 'API 地址',
    hint: '兼容 OpenAI 协议的端点根地址。',
    kind: 'string',
    placeholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  {
    key: 'apiKey',
    group: 'api',
    label: 'API Key',
    hint: '只写不读：已保存的密钥不会回显。本机环境变量优先于这里。',
    kind: 'secret',
    placeholder: '留空表示不修改已保存的密钥',
  },
  {
    key: 'apiModel',
    group: 'api',
    label: '模型 ID',
    hint: '请求体里的 model 字段。',
    kind: 'string',
    placeholder: 'qwen-image',
  },
  {
    key: 'apiStyle',
    group: 'api',
    label: '协议风格',
    hint: 'openai 已实现；dashscope 仅声明、v0.1 未实现。',
    kind: 'enum',
    choices: [
      { value: 'openai', label: 'openai（已实现）' },
      { value: 'dashscope', label: 'dashscope（未实现）' },
    ],
  },
  {
    key: 'runtimeDir',
    group: 'local',
    label: '运行时目录',
    hint: '插件自有数据目录：venv、权重、worker 日志与断点。',
    kind: 'path',
  },
  {
    key: 'modelsDir',
    group: 'local',
    label: '权重目录',
    hint: '留空 = 跟随运行时目录：<运行时目录>\\models\\qwen-image-2.1-bnb4bit。',
    kind: 'path',
  },
  {
    key: 'modelRepo',
    group: 'local',
    label: '权重仓库',
    hint: 'nf4 权重来自哪个 Hugging Face 仓库。',
    kind: 'string',
    placeholder: 'circulus/Qwen-Image-2.1-bnb-4bit',
  },
  {
    key: 'hfMirror',
    group: 'local',
    label: '下载镜像',
    hint: '别填 huggingface.co：它的 /api/ 在本机会超时。',
    kind: 'string',
    placeholder: 'https://hf-mirror.com',
  },
  {
    key: 'localEndpoint',
    group: 'local',
    label: 'worker 地址',
    hint: '本地推理 worker 的根地址。',
    kind: 'string',
    placeholder: 'http://127.0.0.1:8399',
  },
  {
    key: 'workerPorts',
    group: 'local',
    label: 'worker 候选端口',
    hint: '形如 8399-8410 或端口列表；localEndpoint 的端口优先。',
    kind: 'string',
    placeholder: '8399-8410',
  },
  {
    key: 'workerStartTimeoutMs',
    group: 'local',
    label: '冷启动超时',
    hint: 'worker 冷启动要加载约 10.6 GiB 权重，给足时间。',
    kind: 'number',
    min: 1000,
    max: 3_600_000,
    unit: '毫秒',
  },
  {
    key: 'idleUnloadMs',
    group: 'local',
    label: '空闲卸载',
    hint: '空闲超过这么久就把显存还给系统；0 表示不卸载。',
    kind: 'number',
    min: 0,
    max: 86_400_000,
    unit: '毫秒',
  },
  {
    key: 'manageWorker',
    group: 'local',
    label: '由插件管理 worker 进程',
    hint: '关闭后插件只连不管，需要你自己把 worker 起起来。',
    kind: 'boolean',
  },
  {
    key: 'minFreeVramMiB',
    group: 'local',
    label: '显存下限',
    hint: '低于它不再拉起 worker（加载期门禁，不是编辑尺寸门）。',
    kind: 'number',
    min: 0,
    max: 262_144,
    unit: 'MiB',
  },
  {
    key: 'freeComfyBeforeLocalStart',
    group: 'local',
    label: '起本地 worker 前先卸载 ComfyUI 模型',
    hint: '8GB 卡上通常是必需项；开启后先卸载 ComfyUI 模型。',
    kind: 'boolean',
  },
  {
    key: 'allowLocalEditOverBudget',
    group: 'local',
    label: '允许超预算本地编辑',
    hint: '默认拒绝超尺寸门的本地编辑；开启=放行并自负风险。',
    kind: 'boolean',
  },
  {
    key: 'localReferenceBudget',
    group: 'local',
    label: '参考图条件化预算',
    hint: '0=按画布推导；调低=降参考图分辨率；896/512 同画布目视无差（n=1）。',
    kind: 'number',
    min: 0,
    max: 4096,
    unit: '像素/边',
  },
  {
    key: 'comfyEndpoint',
    group: 'comfyui',
    label: 'ComfyUI 地址',
    hint: '留空 = 依次探 8000/8188/8189/8190/8191/8192。',
    kind: 'string',
    placeholder: 'http://127.0.0.1:8188',
  },
  {
    key: 'comfyPorts',
    group: 'comfyui',
    label: 'ComfyUI 候选端口',
    hint: 'comfyEndpoint 留空时按顺序探测这些端口。',
    kind: 'string',
    placeholder: '8000,8188,8189,8190,8191,8192',
  },
  {
    key: 'comfyModelsDir',
    group: 'comfyui',
    label: 'ComfyUI 模型目录',
    hint: '只用来把「把文件放到 …」这类报错写具体；留空则报错保持通用。',
    kind: 'path',
  },
  {
    key: 'outputDir',
    group: 'output',
    label: '出图目录',
    hint: '生成的 PNG 写到哪个目录。',
    kind: 'path',
  },
  {
    key: 'timeoutMs',
    group: 'output',
    label: '单次调用超时',
    hint: '一次出图的协作式预算，超时后放弃等待。',
    kind: 'number',
    min: 1000,
    max: 3_600_000,
    unit: '毫秒',
  },
  {
    key: 'pythonPath',
    group: 'python',
    label: '解释器路径',
    hint: '留空 = 跟随运行时目录：<运行时目录>\\venv\\Scripts\\python.exe。',
    kind: 'path',
  },
  {
    key: 'workerScript',
    group: 'python',
    label: 'worker 脚本',
    hint: '留空使用插件自带的 resources/worker.py。',
    kind: 'path',
  },
  {
    key: 'basePython',
    group: 'python',
    label: '基础解释器',
    hint: '建 venv 用它；留空 = 试 python/python3/py。',
    kind: 'path',
  },
  {
    key: 'torchWheels',
    group: 'python',
    label: 'CUDA wheel 标签',
    hint: '留空 = 依次试 cu128、cu126、cu118。',
    kind: 'string',
    placeholder: 'cu128,cu126,cu118',
  },
  {
    key: 'pipIndexUrl',
    group: 'python',
    label: 'pip 索引地址',
    hint: '留空 = https://pypi.org/simple。',
    kind: 'string',
    placeholder: 'https://pypi.org/simple',
  },
  {
    key: 'reuseBaseTorch',
    group: 'python',
    label: '复用基础解释器里的 CUDA torch',
    hint: '开启后不再下载一份 torch。',
    kind: 'boolean',
  },
  {
    key: 'skipLmHead',
    group: 'python',
    label: 'fetch-weights 跳过 lm_head.weight',
    hint: '默认值：丢掉用不到的那个张量，省下载量。',
    kind: 'boolean',
  },
]

/** Every key the page renders a control for. */
export const SETTINGS_FIELD_KEYS: readonly string[] = SETTINGS_FIELDS.map((field) => field.key)

/** The replacement shown wherever a secret's plaintext would otherwise go. */
export const SECRET_MASK = '••••••••'

/**
 * The keys a schema declares but the page has no control for.
 *
 * @param schemaKeys - keys read off the plugin's own `Config` schema.
 * @returns the missing keys, in schema order; empty when the page is complete.
 */
export function missingFieldKeys(schemaKeys: readonly string[]): string[] {
  const known = new Set(SETTINGS_FIELD_KEYS)
  return schemaKeys.filter((key) => !known.has(key))
}

/**
 * The keys the page renders but the schema does not declare.
 *
 * @param schemaKeys - keys read off the plugin's own `Config` schema.
 * @returns the stale keys, in page order; empty when the page is complete.
 */
export function staleFieldKeys(schemaKeys: readonly string[]): string[] {
  const declared = new Set(schemaKeys)
  return SETTINGS_FIELD_KEYS.filter((key) => !declared.has(key))
}

/**
 * Look one field up.
 *
 * @param key - the config key.
 * @returns the field, or undefined when the page has no control for it.
 */
export function fieldByKey(key: string): SettingsField | undefined {
  return SETTINGS_FIELDS.find((field) => field.key === key)
}

/**
 * Bucket the fields under their groups, keeping page order.
 *
 * @returns one entry per {@link SETTINGS_GROUPS} entry, in order.
 */
export function groupedFields(): { group: SettingsGroup; fields: SettingsField[] }[] {
  return SETTINGS_GROUPS.map((group) => ({
    group,
    fields: SETTINGS_FIELDS.filter((field) => field.group === group.id),
  }))
}

/**
 * Whether one config key is a secret that must never be rendered verbatim.
 *
 * @param key - the config key.
 * @returns true when the field is `kind: 'secret'`.
 */
export function isSecretField(key: string): boolean {
  return fieldByKey(key)?.kind === 'secret'
}

/**
 * The text a control may show for a stored value.
 *
 * A secret is masked unconditionally: the page never renders plaintext, even
 * when the value reaching it happens to be unredacted.
 *
 * @param key - the config key.
 * @param value - the value read from the settings snapshot.
 * @returns the display string, safe to put in the DOM.
 */
export function displayValue(key: string, value: unknown): string {
  if (isSecretField(key)) return value === undefined || value === null || value === '' ? '' : SECRET_MASK
  if (typeof value === 'boolean') return value ? '开' : '关'
  if (value === undefined || value === null) return ''
  return String(value)
}

/**
 * Redact a value for any diagnostic text the page may surface.
 *
 * Used for the messages that travel back to the user on a failed save, so a
 * rejected secret write can be reported without echoing what was typed.
 *
 * @param key - the config key.
 * @param value - the value involved in the write.
 * @returns a display-safe stand-in.
 */
export function redactForLog(key: string, value: unknown): string {
  if (isSecretField(key)) return value === undefined || value === '' ? '（空）' : SECRET_MASK
  return displayValue(key, value)
}

// ---------------------------------------------------------------------------
// The backend performance advisory.
// ---------------------------------------------------------------------------

/**
 * The one place the settings page states the backend performance conclusion.
 *
 * Deliberately **two lines**. The page's job is the actionable conclusion; the
 * measurements, the kernel profile and the ruled-out list belong in the shipped
 * prose (`docs/configuration.md`, `docs/backends.md`), where they can be as long
 * as the evidence requires. An earlier version carried
 * 2,561 characters of evidence here, and the user's first reaction to the live
 * page was that it "exposes a great deal of explanatory text that does not belong
 * in front of a user" — so the budget is now a test, not a convention.
 */
export interface SettingsAdvisory {
  /** Stable id, used as the block's DOM key. */
  readonly id: string
  /** Heading, which carries the recommendation. */
  readonly title: string
  /** At most two lines: the headline numbers, then the one caveat that matters. */
  readonly paragraphs: readonly string[]
  /** Which group this block is rendered directly after. */
  readonly placedAfterGroup: SettingsGroupId
}

/**
 * The backend performance conclusion, as the page states it.
 *
 * Every number is measured on this machine. The tables behind them, the per-step
 * slopes, the kernel profile and the exclusions are in `docs/configuration.md`
 * (the 设置页 section), and test/settings.test.mjs pins both sides: that the page
 * stays within budget, and that the shipped prose (the README plus `docs/*.md`)
 * still carries the evidence.
 */
export const BACKEND_PERF_ADVISORY: SettingsAdvisory = {
  id: 'backend-perf',
  title: '8 GB 显存上做参考图编辑，请优先用 comfyui 后端',
  paragraphs: [
    '实测 1312×736 / 6 步：comfyui ≈ 19–23 s，本机 worker ≈ 219 s（纯管线）。',
    '文生图每步约 2.77×，但两侧量化档不同，不是纯后端差异；依据见 README 与 docs/configuration.md。',
  ],
  placedAfterGroup: 'backend',
}

/**
 * The advisory rendered directly after one group, if any.
 *
 * @param group - the group id.
 * @returns the advisory placed after it, or undefined.
 */
export function advisoryAfterGroup(group: SettingsGroupId): SettingsAdvisory | undefined {
  return BACKEND_PERF_ADVISORY.placedAfterGroup === group ? BACKEND_PERF_ADVISORY : undefined
}

/**
 * Every string this advisory renders, flattened.
 *
 * The text-budget test measures this, so the page cannot quietly grow again.
 *
 * @param advisory - the advisory.
 * @returns all of its user-visible text.
 */
export function advisoryText(advisory: SettingsAdvisory): string {
  return [advisory.title, ...advisory.paragraphs].join(String.fromCharCode(10))
}
