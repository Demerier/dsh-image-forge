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
export type SettingsGroupId = 'steps' | 'comfyui' | 'output'

/**
 * One tab of the settings page.
 *
 * The page is a tabbed form rather than one long scroll: each tab owns a
 * handful of groups so a single view stays dense and scannable instead of
 * stacking every control into a tall column.
 */
export interface SettingsTab {
  /** Stable id; also the tab button's key. */
  readonly id: string
  /** Tab label. */
  readonly label: string
  /** One-line blurb under the tab bar when the tab is active. */
  readonly hint: string
  /** Groups rendered inside this tab, in order. */
  readonly groupIds: readonly SettingsGroupId[]
}

/**
 * Tab strip for the settings page, in order.
 *
 * A group that is not referenced by any tab is simply not rendered.
 */
export const SETTINGS_TABS: readonly SettingsTab[] = [
  {
    id: 'generate',
    label: '出图',
    hint: '画质步数、图落到哪里。',
    groupIds: ['steps', 'output'],
  },
  {
    id: 'comfyui',
    label: 'ComfyUI',
    hint: '复用你自己装好的 ComfyUI（本地推荐部署见 docs/comfyui-deployment.md）。',
    groupIds: ['comfyui'],
  },
]

/** One display group (a titled block of fields). */
export interface SettingsGroup {
  /** Stable id; also the block's DOM key. */
  readonly id: SettingsGroupId
  /** Heading shown above the block. */
  readonly label: string
  /** One line explaining what the whole block is for. */
  readonly hint: string
  /**
   * Visually de-emphasized block (advanced / rarely touched).
   *
   * Presentation only: the page dims the group slightly and flags it so the
   * everyday controls above stay the first thing the eye lands on.
   */
  readonly advanced?: boolean
}

/** How a field is rendered and validated in the page. */
export type FieldKind = 'enum' | 'string' | 'path' | 'number' | 'boolean'

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
  /**
   * Keep the control off the settings page.
   *
   * Nothing uses it today (the page shows every remaining field), but the
   * mechanism is cheap and the alternative is deleting a knob the next
   * advanced setting would need back.
   */
  readonly hidden?: boolean
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
    id: 'steps',
    label: '步数（画质与耗时）',
    hint: 'base 25 步；turbo 蒸馏版 8 步。',
  },
  {
    id: 'comfyui',
    label: 'ComfyUI',
    hint: '地址、端口与权重目录。',
  },
  {
    id: 'output',
    label: '输出与超时',
    hint: '图片落到哪里，等多久。',
  },
]

/** Every configurable field, in page order. */
export const SETTINGS_FIELDS: readonly SettingsField[] = [
  {
    key: 'defaultSteps',
    group: 'steps',
    label: '默认步数',
    hint: 'base 的默认：25，官方模板口径。',
    kind: 'number',
    min: 1,
    max: 200,
    unit: '步',
  },
  {
    key: 'comfyuiSteps',
    group: 'steps',
    label: 'ComfyUI 专用步数',
    hint: '留空 = 用默认步数。',
    kind: 'number',
    min: 1,
    max: 200,
    unit: '步',
    nullable: true,
  },
  {
    key: 'comfyModel',
    group: 'steps',
    label: 'ComfyUI 权重',
    hint: 'turbo：8 步，快 2.7×；没装 turbo 权重自动退回 base。',
    kind: 'enum',
    choices: [
      { value: 'base', label: 'base（25 步，官方全量）' },
      { value: 'turbo', label: 'turbo（8 步，蒸馏版）' },
    ],
  },
  {
    key: 'turboSteps',
    group: 'steps',
    label: 'turbo 专用步数',
    hint: '留空 = 8。蒸馏按 8 步调，加减不一定更好。',
    kind: 'number',
    min: 1,
    max: 50,
    unit: '步',
    nullable: true,
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
    hint: '桌面版在「设置 → 模型路径」里；用来把「放哪里」写进报错。',
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
]

/** Every key the page renders a control for. */
export const SETTINGS_FIELD_KEYS: readonly string[] = SETTINGS_FIELDS.map((field) => field.key)

/** Fields the page deliberately does not show (schema still has them). */
export const HIDDEN_FIELD_KEYS: readonly string[] = SETTINGS_FIELDS.filter((field) => field.hidden === true).map(
  (field) => field.key,
)

/** Fields the settings page actually renders. */
export const VISIBLE_FIELD_KEYS: readonly string[] = SETTINGS_FIELDS.filter((field) => field.hidden !== true).map(
  (field) => field.key,
)

/** Whether a control belongs on the page. */
export function isFieldVisible(key: string): boolean {
  return fieldByKey(key)?.hidden !== true
}

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
 * Bucket the **visible** fields under their groups, keeping page order.
 *
 * Hidden controls are dropped here, and a group left with no visible fields is
 * dropped too, so the page never renders an empty heading.
 *
 * @returns one entry per group that still has visible fields.
 */
export function groupedFields(): { group: SettingsGroup; fields: SettingsField[] }[] {
  return SETTINGS_GROUPS.map((group) => ({
    group,
    fields: SETTINGS_FIELDS.filter((field) => field.group === group.id && field.hidden !== true),
  })).filter((entry) => entry.fields.length > 0)
}

/**
 * Visible groups and fields for one tab, in tab order.
 *
 * @param tab - the tab definition.
 * @returns the same shape as {@link groupedFields}, restricted to the tab.
 */
export function tabFields(tab: SettingsTab): { group: SettingsGroup; fields: SettingsField[] }[] {
  const wanted = new Set(tab.groupIds)
  return groupedFields().filter(({ group }) => wanted.has(group.id))
}

/**
 * The text a control may show for a stored value.
 *
 * @param key - the config key.
 * @param value - the value read from the settings snapshot.
 * @returns the display string, safe to put in the DOM.
 */
export function displayValue(key: string, value: unknown): string {
  if (typeof value === 'boolean') return value ? '开' : '关'
  if (value === undefined || value === null) return ''
  return String(value)
}

// ---------------------------------------------------------------------------
// The backend performance advisory.
// ---------------------------------------------------------------------------

/**
 * The one place the settings page states the backend performance conclusion.
 *
 * Deliberately **two lines**. The page's job is the actionable conclusion; the
 * measurements, the kernel profile and the ruled-out list belong in the shipped
 * prose (`docs/configuration.md`), where they can be as long as the evidence
 * requires. An earlier version carried 2,561 characters of evidence here, and
 * the user's first reaction to the live page was that it "exposes a great deal
 * of explanatory text that does not belong in front of a user" — so the budget
 * is now a test, not a convention.
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
  id: 'turbo-vs-base',
  title: '默认跑 turbo（8 步）：快 2.7×，写实 / 中文文字 / 古典构图这三类切 base',
  paragraphs: [
    '盲测 5 题（同 prompt 同 seed）：base 3 : 2 turbo；单张 27–29 s → turbo 9–11 s。',
    'turbo 赢在高对比氛围（夜市、动物）；输在材质细节、中文小字与印章、古典构图。',
  ],
  placedAfterGroup: 'steps',
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
