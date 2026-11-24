/**
 * The node property drawer (U05): select one node, edit it on the right.
 *
 * ## Why this module exists
 *
 * The workbench used to open with a form down the left half: prompt, ratio,
 * steps, count, references, generate. That form is a *document* model — it says
 * "here is one thing I am about to make" — and it fought the canvas, where the
 * user makes many things and each one is a node. So the canvas tab now says what
 * the user said: **选中节点 → 抽屉里编辑属性**, and this module is the drawer.
 *
 * ## What is pure here, and why
 *
 * The renderer is deliberately dumb. Everything a drawer *decides* — which fields
 * a node kind has, which of them are editable, which actions it offers, what the
 * request body looks like when the drawer is asked to generate — is a pure
 * function, so `test/node-inspector.test.mjs` can assert it without a DOM and
 * `test/studio.test.mjs` can assert the wiring around it. That split is the same
 * one `canvas-flow-model.ts` uses for the canvas itself.
 *
 * ## The three sources of truth, and why there are three
 *
 * A drawer always edits *one* node, so the values belong to the node, not to the
 * panel:
 *
 * - **draft** — `node.params` / `node.references`. A draft is an in-memory
 *   placeholder (G26) that no board write ever sees, so writing an edit straight
 *   into the node is both the save and the only copy. Selecting another draft
 *   shows *its* parameters, which is the whole point of "属性" over "表单".
 * - **task** — `node.params`. 「编辑参数」 flips the drawer into edit mode and the
 *   inputs write the same snapshot `retryTask` re-sends, so an edited retry needs
 *   no second buffer.
 * - **image / layout** — read-only. A picture's parameters are history; a layout
 *   node's own editor owns its draft.
 *
 * The list and asset views still keep the old form (that is the untouched half of
 * U05's brief), and it keeps its own panel-level state.
 *
 * @module node-inspector
 */
import { createElement, type ReactNode } from 'react'
import {
  FLOW_TASK_BADGES,
  taskNodeActions,
  taskParamsText,
  taskPromptLine,
  type FlowTaskStatus,
} from './canvas-flow-model.ts'
import { singleSelection } from './canvas-interactions.ts'
import {
  STUDIO_LAYOUT_RATIO_TOLERANCE,
  STUDIO_MAX_COUNT,
  STUDIO_MAX_PROMPT_CHARS,
  STUDIO_MAX_REFERENCES,
  STUDIO_RATIOS,
  fitStudioRatio,
  studioFileUrl,
  type BoardTaskParams,
} from './studio-shared.ts'

/* -------------------------------------------------------------------------- */
/* What the drawer is given                                                   */
/* -------------------------------------------------------------------------- */

/** The node kinds the drawer knows, matching the canvas node kinds. */
export type InspectorNodeKind = 'image' | 'task' | 'layout' | 'draft'

/** One picture on the board, as the drawer reads it. */
export interface InspectorImageLike {
  readonly markdownPath: string
  readonly path: string
  readonly width: number
  readonly height: number
  readonly bytes: number
}

/** A MOSS layout draft, as the drawer reads it (a summary, not the boxes). */
export interface InspectorLayoutLike {
  readonly width: number
  readonly height: number
  readonly items: readonly unknown[]
}

/** A reference held for a draft node: preview, name, and enough to send. */
export interface InspectorReference {
  readonly id: string
  readonly name: string
  readonly previewUrl: string
}

/**
 * Anything the drawer can be pointed at.
 *
 * Structural on purpose: `CanvasNode` in `studio-view.ts` satisfies it as-is for
 * pictures, tasks and drafts, so no adapter has to be kept in step with the node
 * union. A layout node's `draft` is the same `BoardLayoutDraft` the editor owns.
 */
export interface InspectorNodeLike {
  readonly kind: string
  readonly id: string
  readonly parents?: readonly string[]
  readonly image?: InspectorImageLike
  readonly params?: BoardTaskParams
  readonly status?: string
  readonly progress?: { readonly label?: string; readonly percent: number }
  readonly error?: string
  readonly draft?: InspectorLayoutLike
  readonly references?: readonly InspectorReference[]
}

/** What a board item remembers about the picture (steps/seed/ratio are history). */
export interface InspectorItemLike {
  readonly prompt?: string
  readonly ratio?: string | null
  readonly steps?: number | null
  readonly seed?: number | null
  readonly mode?: string | null
}

/** Everything the spec needs besides the node itself. */
export interface InspectorOptions {
  /** The board item behind a picture: its steps, seed and ratio are history. */
  readonly item?: InspectorItemLike
  /** The profile's unet name — a "底模" is configuration, not a node property. */
  readonly model?: string
  /** The configured default step count, for the empty input's placeholder. */
  readonly defaultSteps?: number
  /** A task node's parameters may be edited (「编辑参数」 was pressed). */
  readonly editing?: boolean
  /** A run of this drawer's own node is in flight. */
  readonly busy?: boolean
}

/* -------------------------------------------------------------------------- */
/* Fields                                                                     */
/* -------------------------------------------------------------------------- */

/** The five parameters a user can actually change from the canvas (U05's list). */
export type InspectorFieldId = 'prompt' | 'ratio' | 'steps' | 'count' | 'seed'

/** How the renderer should draw an editable field. */
export type InspectorControl = 'textarea' | 'ratio' | 'number'

/** One row of the drawer: a parameter, or a read-only fact about the node. */
export interface InspectorField {
  /** `prompt`/`ratio`/`steps`/`count`/`seed`, or an info row's own id. */
  readonly id: string
  readonly label: string
  readonly value: string
  readonly editable: boolean
  /** Present only on editable fields. */
  readonly control?: InspectorControl
  readonly hint?: string
  readonly placeholder?: string
  /** The `<input>`'s bounds, for the two counters the host validates. */
  readonly min?: number
  readonly max?: number
  /** Engineering detail kept behind the drawer's native 详情 disclosure. */
  readonly advanced?: boolean
}

/** Every drawer action, by id. */
export type InspectorAction =
  | 'generate'
  | 'retry'
  | 'edit'
  | 'cancel'
  | 'remove'
  | 'open'
  | 'continue'
  | 'layout-generate'
  | 'open-detail'

/** One button: the drawer renders these, it never invents them. */
export interface InspectorActionSpec {
  readonly id: InspectorAction
  readonly label: string
  readonly title: string
  readonly primary?: boolean
  readonly danger?: boolean
  readonly disabled?: boolean
}

/** The whole drawer, as data. */
export interface InspectorSpec {
  readonly kind: InspectorNodeKind
  readonly title: string
  /** The one-word state a task node reads by (排/生成中/失败…). */
  readonly badge?: string
  /** The sentence under the badge — a failure's reason, a layout's size. */
  readonly status?: string
  readonly fields: readonly InspectorField[]
  readonly references: readonly InspectorReference[]
  /** Drafts hold their own reference list; everything else is read-only. */
  readonly canEditReferences: boolean
  /** Board ids this node grew from, in the order the edges were drawn. */
  readonly lineage: readonly string[]
  readonly actions: readonly InspectorActionSpec[]
  readonly hint?: string
  /** A picture preview for the image node's inline editor. */
  readonly preview?: {
    readonly src: string
    readonly href: string
    readonly alt: string
  }
}

/** The drawer's title when nothing is selected. */
export const INSPECTOR_TITLE = '节点属性'

/** What the drawer says when nothing is selected (§U05-4). */
export const INSPECTOR_EMPTY_HINT = '选中一个节点查看属性'

/** The five editable parameters' labels, shared by the draft and task editors. */
const FIELD_LABELS: Readonly<Record<InspectorFieldId, string>> = {
  prompt: '画面描述',
  ratio: '画幅比例',
  steps: '采样步数',
  count: '出图张数',
  seed: '种子',
}

/**
 * The upper bound on a step count, matching the form's own `max`.
 *
 * Not a host rule (the host only clamps to ≥ 1): past a couple of hundred steps a
 * draw stops being a preview, so the drawer keeps the same ceiling the left form
 * printed instead of letting the number field invent a larger one.
 */
export const INSPECTOR_MAX_STEPS = 200

/** The largest seed the drawer accepts: the sampler's own 32-bit range. */
export const INSPECTOR_MAX_SEED = 0xffffffff

/* -------------------------------------------------------------------------- */
/* Numbers                                                                    */
/* -------------------------------------------------------------------------- */

/** A whole number inside `[min, max]`, or `undefined` for blank/garbage. */
export function integerWithin(raw: string, min: number, max: number): number | undefined {
  const text = raw.trim()
  if (text.length === 0) return undefined
  const value = Number(text)
  if (!Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** Render a number for an input, or `''` when the run left it out. */
function numberText(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

/** `1248×1248` — the size line both the picture and the layout drawer print. */
function sizeText(width: number, height: number): string {
  return `${String(width)}×${String(height)}`
}

/** The first line of a prompt, which is the only name a result has. */
export function promptLine(prompt: string | undefined): string {
  return (prompt ?? '').split(/\r?\n/)[0]?.trim() ?? ''
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Does the drawer exist for this selection?
 *
 * One node, or none: a multi-selection is what the align toolbar and the batch
 * menu exist for, and painting one node's properties while three are selected
 * would make the drawer lie about its subject.
 */
export function inspectorVisible(selection: ReadonlySet<string>): boolean {
  return singleSelection(selection) !== undefined
}

/** The node the drawer is about, given the canvas selection. */
export function inspectorTargetOf<T extends { readonly id: string }>(
  nodes: readonly T[],
  selection: ReadonlySet<string>,
): T | undefined {
  const id = singleSelection(selection)
  if (id === undefined) return undefined
  return nodes.find((node) => node.id === id)
}

/* -------------------------------------------------------------------------- */
/* Values → parameters → request body                                         */
/* -------------------------------------------------------------------------- */

/** The five inputs as strings: what an `<input>` holds, before validation. */
export interface DraftFieldValues {
  readonly prompt: string
  readonly ratio: string
  readonly steps: string
  readonly count: string
  readonly seed: string
}

/** A blank editor: the state a brand-new draft node starts in. */
export const EMPTY_DRAFT_VALUES: DraftFieldValues = {
  prompt: '',
  ratio: '1:1',
  steps: '',
  count: '1',
  seed: '',
}

/** The inputs' values for a node (a draft's or an edited task's own params). */
export function inspectorValuesOf(node: InspectorNodeLike | undefined): DraftFieldValues {
  const params = node?.params
  if (params === undefined) return EMPTY_DRAFT_VALUES
  return {
    prompt: params.prompt,
    ratio: typeof params.ratio === 'string' && params.ratio.length > 0 ? params.ratio : '1:1',
    steps: numberText(params.steps),
    count: String(params.count ?? 1),
    seed: numberText(params.seed),
  }
}

/** The ratio a request may carry: one of the seven, or 1:1 rather than nothing. */
export function inspectorRatio(value: string): string {
  return (STUDIO_RATIOS as readonly string[]).includes(value) ? value : '1:1'
}

/**
 * Apply one field edit to a parameter snapshot — the drawer's "保存".
 *
 * The mapping is the whole contract of an editable drawer, so it is one function:
 * a blank steps/seed means *absent* (the host falls back to the profile's default
 * and reports the seed it drew with), never `0` and never `NaN`. An unknown field
 * id is a no-op, which keeps a stale render from corrupting the snapshot.
 */
export function patchDraftParams(
  params: BoardTaskParams,
  field: InspectorFieldId,
  value: string,
): BoardTaskParams {
  switch (field) {
    case 'prompt':
      return { ...params, prompt: value.slice(0, STUDIO_MAX_PROMPT_CHARS) }
    case 'ratio':
      return { ...params, ratio: inspectorRatio(value) }
    case 'steps': {
      const steps = integerWithin(value, 1, INSPECTOR_MAX_STEPS)
      if (steps === undefined) {
        const { steps: _dropped, ...rest } = params
        return rest
      }
      return { ...params, steps }
    }
    case 'count': {
      const count = integerWithin(value, 1, STUDIO_MAX_COUNT) ?? 1
      return { ...params, count }
    }
    case 'seed': {
      const seed = integerWithin(value, 0, INSPECTOR_MAX_SEED)
      if (seed === undefined) {
        const { seed: _dropped, ...rest } = params
        return rest
      }
      return { ...params, seed }
    }
    default:
      return params
  }
}

/** Turn the five inputs into the snapshot a run is submitted from. */
export function draftParamsOf(values: DraftFieldValues): BoardTaskParams {
  let params: BoardTaskParams = { prompt: values.prompt.trim(), ratio: inspectorRatio(values.ratio) }
  params = patchDraftParams(params, 'steps', values.steps)
  params = patchDraftParams(params, 'count', values.count)
  params = patchDraftParams(params, 'seed', values.seed)
  return params
}

/** The parameter half of `POST /studio/generate`, exactly as the host parses it. */
export interface GenerateParamsBody {
  readonly prompt: string
  readonly ratio: string
  readonly count: number
  readonly width?: number
  readonly height?: number
  readonly steps?: number
  readonly seed?: number
  readonly layout?: string
  readonly layoutMode?: BoardTaskParams['layoutMode']
}

/**
 * The generate body's parameter subset.
 *
 * One function, used by the wire *and* by the tests: the drawer producing values
 * that reach the host field for field is the whole feature, so the mapping is not
 * allowed to live twice. Omitted keys stay absent rather than becoming `0` — the
 * host reads an absent step count as "use the configured default".
 */
export function generateParamsBody(params: BoardTaskParams): GenerateParamsBody {
  return {
    prompt: params.prompt,
    ratio: params.ratio ?? '1:1',
    count: params.count ?? 1,
    ...(params.width === undefined || params.height === undefined ? {} : { width: params.width, height: params.height }),
    ...(params.steps === undefined ? {} : { steps: params.steps }),
    ...(params.seed === undefined ? {} : { seed: params.seed }),
    ...(params.layout === undefined ? {} : { layout: params.layout }),
    ...(params.layoutMode === undefined ? {} : { layoutMode: params.layoutMode }),
  }
}

/**
 * Is the drawer's own node ready to submit?
 *
 * Empty after trimming is refused here rather than at the host, because the
 * drawer owns the button's disabled state and a click that round-trips to a
 * 400 is a worse answer than a grey button.
 */
export function canGenerateFromDrawer(values: DraftFieldValues, references: number): boolean {
  if (values.prompt.trim().length === 0) return false
  return references <= STUDIO_MAX_REFERENCES
}



/* -------------------------------------------------------------------------- */
/* The spec                                                                   */
/* -------------------------------------------------------------------------- */

/** The editable half of the drawer, for a draft node or an edited task. */
function editableFields(
  values: DraftFieldValues,
  options: InspectorOptions,
): readonly InspectorField[] {
  const placeholder = typeof options.defaultSteps === 'number'
    ? `默认 ${String(options.defaultSteps)}`
    : '默认'
  return [
    {
      id: 'prompt',
      label: FIELD_LABELS.prompt,
      value: values.prompt,
      editable: true,
      control: 'textarea',
      placeholder: '描述你想要的画面；有参考图时写"改什么、其余保持不变"。',
    },
    {
      id: 'ratio',
      label: FIELD_LABELS.ratio,
      value: inspectorRatio(values.ratio),
      editable: true,
      control: 'ratio',
    },
    {
      id: 'steps',
      label: FIELD_LABELS.steps,
      value: values.steps,
      editable: true,
      control: 'number',
      min: 1,
      max: INSPECTOR_MAX_STEPS,
      placeholder,
    },
    {
      id: 'count',
      label: FIELD_LABELS.count,
      value: values.count,
      editable: true,
      control: 'number',
      min: 1,
      max: STUDIO_MAX_COUNT,
    },
    {
      id: 'seed',
      label: FIELD_LABELS.seed,
      value: values.seed,
      editable: true,
      control: 'number',
      min: 0,
      max: INSPECTOR_MAX_SEED,
      placeholder: '随机',
      hint: '留空即随机；填了才能复现同一张图。',
    },
  ]
}

/** The reference cards a node holds, as the renderer addresses them. */
function referencesOf(node: InspectorNodeLike): readonly InspectorReference[] {
  // A draft holds its own list; a task's snapshot only remembers paths, which is
  // enough to preview because the file route can serve any board item's path.
  if (Array.isArray(node.references)) return node.references
  const params = node.params
  const out: InspectorReference[] = []
  for (const [index, entry] of (params?.references ?? []).entries()) {
    const path = entry.path
    if (typeof path !== 'string' || path.length === 0) continue
    out.push({
      id: `${node.id}-ref-${String(index)}`,
      name: entry.name ?? (path.split(/[\\/]/).pop() ?? '参考图'),
      previewUrl: studioFileUrl(path.replace(/\\/g, '/')),
    })
  }
  return out
}

/** The button set for a draft: generate, and cancel while its run is live. */
function draftActions(
  values: DraftFieldValues,
  options: InspectorOptions,
): readonly InspectorActionSpec[] {
  const buttons: InspectorActionSpec[] = [{
    id: 'generate',
    label: options.busy === true ? '生成中…' : '生成',
    title: '用抽屉里的参数提交；图会落在画布上这个位置',
    primary: true,
    // The empty prompt is refused here, not by the host: a grey button answers
    // "what do I do next" and a 400 after a round trip does not.
    disabled: options.busy === true || values.prompt.trim().length === 0,
  }]
  if (options.busy === true) {
    buttons.push({ id: 'cancel', label: '取消', title: '中断这次生成' })
  }
  buttons.push({ id: 'remove', label: '移除', title: '从画布移除这个待生成节点（不删文件）', danger: true })
  return buttons
}

/** Reuse the canvas's own action mapping so a task's buttons cannot diverge. */
const TASK_ACTION_COPY: Readonly<Record<string, { readonly label: string; readonly title: string }>> = {
  retry: { label: '重试', title: '用相同的参数原地重新提交' },
  edit: { label: '编辑参数', title: '在抽屉里改参数，改完再提交会替换这个节点' },
  cancel: { label: '取消', title: '中断这次生成' },
  // U06 §8.2: a task's detail tab is its full parameter sheet plus 重试.
  'open-detail': { label: '打开详情', title: '在详情页签里看这个任务的全部参数并重试' },
  remove: { label: '移除', title: '从画布移除（不删文件）' },
}

function taskActions(node: InspectorNodeLike, options: InspectorOptions): readonly InspectorActionSpec[] {
  const status = (node.status ?? 'idle') as FlowTaskStatus
  const buttons: InspectorActionSpec[] = []
  if (options.editing === true) {
    // Editing a terminal run is the same submit as a retry: the snapshot *is*
    // what the next run sends, so there is no second generation path.
    buttons.push({
      id: 'generate',
      label: options.busy === true ? '生成中…' : '重新生成',
      title: '用抽屉里改过的参数原地替换这个节点',
      primary: true,
      disabled: options.busy === true || (node.params?.prompt ?? '').trim().length === 0,
    })
  }
  for (const id of taskNodeActions(status)) {
    // U06: the detail tab is offered whatever the run's state, and always just
    // before 移除 — "take it off the canvas" stays the last thing in the row.
    if (id === 'remove') buttons.push(openDetailAction())
    const copy = TASK_ACTION_COPY[id]
    if (copy === undefined) continue
    buttons.push({ id, label: copy.label, title: copy.title, danger: id === 'remove' })
  }
  if (!buttons.some((button) => button.id === 'open-detail')) buttons.push(openDetailAction())
  return buttons
}

/** U06's entry, so a picture and a task describe the same tab the same way. */
function openDetailAction(): InspectorActionSpec {
  const copy = TASK_ACTION_COPY['open-detail']
  return {
    id: 'open-detail',
    label: copy?.label ?? '打开详情',
    title: copy?.title ?? '在详情页签里看这个节点',
  }
}

/**
 * The drawer for one node — fields, references, lineage, buttons.
 *
 * `undefined` for no node: the renderer shows {@link INSPECTOR_EMPTY_HINT} and no
 * drawer at all, so "nothing selected" is a state of the panel, not an empty box.
 */
export function inspectorSpecFor(
  node: InspectorNodeLike | undefined,
  options: InspectorOptions = {},
): InspectorSpec | undefined {
  if (node === undefined) return undefined
  const kind = node.kind as InspectorNodeKind
  const lineage = [...(node.parents ?? [])]

  if (kind === 'draft') {
    const values = inspectorValuesOf(node)
    return {
      kind,
      title: '待生成',
      badge: '待生成',
      status: node.params === undefined || node.params.prompt.trim().length === 0
        ? '写下提示词，图会落在这个位置'
        : '参数就绪，点「生成」提交',
      fields: editableFields(values, options),
      references: referencesOf(node),
      canEditReferences: true,
      lineage,
      actions: draftActions(values, options),
    }
  }

  if (kind === 'task') {
    const status = (node.status ?? 'idle') as FlowTaskStatus
    const editing = options.editing === true
    const params = node.params
    const progress = node.progress
    const fields: readonly InspectorField[] = editing
      ? editableFields(inspectorValuesOf(node), options)
      : [
        {
          id: 'prompt',
          label: FIELD_LABELS.prompt,
          value: params === undefined ? '' : taskPromptLine(params),
          editable: false,
        },
        {
          id: 'params',
          label: '参数',
          value: params === undefined ? '' : taskParamsText(params),
          editable: false,
        },
        {
          id: 'progress',
          label: '进度',
          value: progress === undefined ? '' : `${String(progress.percent)}%`,
          editable: false,
        },
        ...(node.error === undefined
          ? []
          : [{ id: 'error', label: '失败原因', value: node.error, editable: false }]),
      ]
    return {
      kind,
      title: '生成任务',
      badge: FLOW_TASK_BADGES[status] ?? status,
      status: editing ? '改完点「重新生成」会原地替换这个任务' : undefined,
      fields,
      references: referencesOf(node),
      canEditReferences: false,
      lineage,
      actions: taskActions(node, options),
      hint: editing ? undefined : '失败的节点可以先「编辑参数」，再提交。',
    }
  }

  if (kind === 'layout') {
    const draft = node.draft
    // The drawer names the *official* tier the draft maps onto (§8.4 forbids
    // stretching, so a draft off the ladder is refused at generation).
    const fit = draft === undefined ? undefined : fitStudioRatio(draft.width, draft.height)
    const mapped = draft === undefined || fit === undefined
      ? '—'
      : fit.deviation > STUDIO_LAYOUT_RATIO_TOLERANCE
        ? `${fit.ratio}（偏差 ${(fit.deviation * 100).toFixed(1)}%，无法生成）`
        : fit.ratio
    return {
      kind,
      title: 'MOSS 布局',
      badge: '布局',
      status: draft === undefined
        ? undefined
        : `${String(draft.items.length)} 个画框 · ${sizeText(draft.width, draft.height)}`,
      fields: [
        { id: 'size', label: '草稿尺寸', value: draft === undefined ? '' : sizeText(draft.width, draft.height), editable: false },
        { id: 'items', label: '画框数量', value: draft === undefined ? '' : String(draft.items.length), editable: false },
        {
          id: 'ratio',
          label: '映射画幅',
          value: mapped,
          editable: false,
          hint: 'MOSS 只接受七档比例；draft 尺寸要落在其中一档上才能生成。',
        },
      ],
      references: [],
      canEditReferences: false,
      lineage,
      actions: [
        {
          id: 'layout-generate',
          label: '生成',
          title: '把 compiled 布局作为 MOSS 的正向编码文本提交',
          primary: true,
        },
        {
          id: 'open-detail',
          // U06: the tab exists now, so the entry is the real one (§8.2). The
          // detail kind is not part of the tab key, so opening it is a callback
          // the canvas supplies, not a state change here.
          label: '打开详情',
          title: '在详情页签里做全尺寸编辑（画框、尺寸、生成都在那里）',
        },
        { id: 'remove', label: '移除', title: '从画布移除（不删文件）', danger: true },
      ],
    }
  }

  // Pictures: everything here is history, so nothing is editable.
  const image = node.image
  const item = options.item
  const prompt = promptLine(item?.prompt) || promptLine(node.params?.prompt)
  return {
    kind: 'image',
    title: '画面',
    badge: item?.mode === 'edit' ? '改图' : '生成',
    status: image === undefined
      ? undefined
      : `${sizeText(image.width, image.height)}${item?.ratio === null || item?.ratio === undefined ? '' : ` · ${item.ratio}`}`,
    fields: [
      {
        id: 'prompt',
        label: '提示词',
        value: prompt.length === 0 ? '（这张图没有记录提示词）' : prompt,
        editable: false,
      },
      { id: 'ratio', label: '画幅比例', value: item?.ratio ?? '—', editable: false },
      {
        id: 'steps',
        label: '采样步数',
        value: typeof item?.steps === 'number' ? String(item.steps) : '—',
        editable: false,
      },
      {
        id: 'seed',
        label: '种子',
        value: typeof item?.seed === 'number' ? String(item.seed) : '—',
        editable: false,
      },
      { id: 'size', label: '像素尺寸', value: image === undefined ? '' : sizeText(image.width, image.height), editable: false },
      {
        id: 'model',
        label: '底模',
        value: options.model === undefined || options.model.length === 0 ? '按当前 profile' : options.model,
        editable: false,
        hint: '底模是 profile 级配置，不在节点上。',
        advanced: true,
      },
      { id: 'file', label: '文件路径', value: image?.path ?? '', editable: false, advanced: true },
      ...(lineage.length === 0 ? [] : [{ id: 'lineage', label: '参考图', value: lineage.join(' → '), editable: false, advanced: true }]),
    ],
    references: [],
    canEditReferences: false,
    lineage,
    actions: [
      { id: 'continue', label: '按这张继续', title: '建一个以这张图为参考的待生成节点', primary: true },
      { id: 'open', label: '查看原图', title: '在新标签页打开原图' },
      // U06 §8.2: every persisted node kind has a detail tab, so the drawer
      // offers the same entry on a picture as on a layout.
      { id: 'open-detail', label: '打开详情', title: '在大图详情页签里看这张图和它的全部参数' },
      { id: 'remove', label: '移除', title: '从画布移除（不删文件）', danger: true },
    ],
    ...(image === undefined ? {} : {
      preview: {
        src: studioFileUrl(image.markdownPath),
        href: studioFileUrl(image.markdownPath),
        alt: prompt.length === 0 ? '生成结果' : prompt,
      },
    }),
    hint: '图片参数是这次生成的记录；要改画面，就用「按这张继续」再做一版。',
  }
}

/** A task node's stored prompt, when the drawer has nothing else to name it by. */

/* -------------------------------------------------------------------------- */
/* The renderer                                                               */
/* -------------------------------------------------------------------------- */

/** A change event, as much of one as the drawer reads. */
export interface InspectorInputEvent {
  readonly target: {
    readonly files?: ArrayLike<{ readonly name: string; readonly size: number }> | null
    readonly value?: string
  }
}

/** Everything the drawer's renderer may call. */
export interface NodeInspectorProps {
  readonly node?: InspectorNodeLike
  readonly options?: InspectorOptions
  readonly busy?: boolean
  readonly note?: string
  readonly error?: string
  /** The prompt textarea, so the studio can put the caret in it (G26). */
  readonly promptRef?: { current: HTMLTextAreaElement | null }
  readonly onField: (field: InspectorFieldId, value: string) => void
  readonly onAddReferences: (event: InspectorInputEvent) => void
  readonly onRemoveReference: (id: string) => void
  readonly onAction: (action: InspectorAction) => void
  readonly onClose: () => void
}

/** The drawer's header: what it is showing, and how to put it away. */
function headOf(spec: InspectorSpec, props: NodeInspectorProps): ReactNode {
  return createElement(
    'div',
    { className: 'dsh-forge-inspector-head' },
    createElement('span', { className: 'dsh-forge-inspector-title' }, spec.title),
    spec.badge === undefined
      ? null
      : createElement('span', { className: 'dsh-forge-inspector-badge' }, spec.badge),
    createElement(
      'button',
      {
        type: 'button',
        className: 'dsh-forge-inspector-close',
        title: '收起（清空选择）',
        'aria-label': '收起属性抽屉',
        onClick: () => { props.onClose() },
      },
      '×',
    ),
  )
}

/** One editable parameter, by the control the spec asked for. */
function editableFieldOf(field: InspectorField, props: NodeInspectorProps): ReactNode {
  const id = field.id as InspectorFieldId
  const change = (value: string): void => { props.onField(id, value) }
  if (field.control === 'textarea') {
    return createElement('textarea', {
      className: 'dsh-forge-textarea is-inspector',
      value: field.value,
      rows: 4,
      maxLength: STUDIO_MAX_PROMPT_CHARS,
      placeholder: field.placeholder,
      'data-inspector-input': id,
      ref: props.promptRef,
      onChange: (event: { target: { value: string } }) => { change(event.target.value) },
    })
  }
  if (field.control === 'ratio') {
    return createElement(
      'div',
      { className: 'dsh-forge-ratio-row is-inspector', role: 'group', 'aria-label': '画幅比例' },
      ...STUDIO_RATIOS.map((ratio) => createElement(
        'button',
        {
          key: ratio,
          type: 'button',
          className: ratio === field.value ? 'dsh-forge-ratio is-active' : 'dsh-forge-ratio',
          'aria-pressed': ratio === field.value,
          'data-inspector-ratio': ratio,
          onClick: () => { change(ratio) },
        },
        createElement('span', { className: 'dsh-forge-ratio-label' }, ratio),
      )),
    )
  }
  return createElement('input', {
    className: 'dsh-forge-input is-inspector',
    type: 'number',
    min: field.min,
    max: field.max,
    value: field.value,
    placeholder: field.placeholder,
    'data-inspector-input': id,
    onChange: (event: { target: { value: string } }) => { change(event.target.value) },
  })
}

/** One row: an editable parameter, or a fact about the node. */
function fieldRowOf(field: InspectorField, props: NodeInspectorProps): ReactNode {
  const body = field.editable
    ? editableFieldOf(field, props)
    : createElement('div', { className: 'dsh-forge-inspector-value', title: field.value }, field.value)
  return createElement(
    'div',
    { className: field.editable ? 'dsh-forge-field' : 'dsh-forge-inspector-row', 'data-inspector-field': field.id },
    createElement('label', { className: 'dsh-forge-label' }, field.label),
    body,
    field.hint === undefined
      ? null
      : createElement('div', { className: 'dsh-forge-studio-hint' }, field.hint),
  )
}

/** The reference row: numbered cards, a remove button each, and one add tile. */
function referencesOfSpec(spec: InspectorSpec, props: NodeInspectorProps): ReactNode {
  const cards = spec.references.map((reference, index) => createElement(
    'div',
    { key: reference.id, className: 'dsh-forge-ref', 'data-inspector-ref': reference.id },
    createElement('img', { src: reference.previewUrl, alt: reference.name }),
    createElement('span', { className: 'dsh-forge-ref-index' }, String(index + 1)),
    spec.canEditReferences
      ? createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-forge-ref-remove',
          title: `移除 ${reference.name}`,
          onClick: () => { props.onRemoveReference(reference.id) },
        },
        '×',
      )
      : null,
  ))
  return createElement(
    'div',
    { className: 'dsh-forge-field', 'data-inspector-field': 'references' },
    createElement(
      'div',
      { className: 'dsh-forge-field-head' },
      createElement('label', { className: 'dsh-forge-label' }, '参考图'),
      createElement(
        'span',
        { className: 'dsh-forge-studio-hint' },
        spec.canEditReferences
          ? `给图就是改图；最多 ${String(STUDIO_MAX_REFERENCES)} 张`
          : '这一轮的参考图（只读）',
      ),
    ),
    createElement(
      'div',
      { className: 'dsh-forge-ref-row is-inspector' },
      ...cards,
      spec.canEditReferences
        ? createElement(
          'label',
          { className: 'dsh-forge-ref-add', title: '添加参考图' },
          '+',
          createElement('input', {
            type: 'file',
            accept: 'image/png,image/jpeg,image/webp',
            multiple: true,
            'data-inspector-ref-add': 'true',
            style: { display: 'none' },
            onChange: (event: InspectorInputEvent) => { props.onAddReferences(event) },
          }),
        )
        : null,
    ),
  )
}

/** The lineage line: what this node grew from, so an edit is not anonymous. */
function lineageOf(spec: InspectorSpec): ReactNode[] {
  if (spec.lineage.length === 0) return []
  return [createElement(
    'div',
    { className: 'dsh-forge-inspector-lineage', 'data-inspector-lineage': String(spec.lineage.length) },
    createElement('span', { className: 'dsh-forge-label' }, '参考图'),
    ...spec.lineage.map((id, index) => createElement(
      'code',
      { key: `${id}-${String(index)}`, className: 'dsh-forge-inspector-parent', title: id },
      id,
    )),
  )]
}

/** The button row, straight from the spec. */
function actionsOf(spec: InspectorSpec, props: NodeInspectorProps): ReactNode {
  return createElement(
    'div',
    { className: 'dsh-forge-inspector-actions' },
    ...spec.actions.map((action) => createElement(
      'button',
      {
        key: action.id,
        type: 'button',
        className: [
          'dsh-forge-btn',
          action.primary === true ? 'is-primary' : 'is-ghost',
          action.danger === true ? 'is-danger' : '',
        ].filter((part) => part.length > 0).join(' '),
        title: action.title,
        disabled: action.disabled === true || (props.busy === true && action.id === 'generate'),
        'data-inspector-action': action.id,
        onClick: () => { props.onAction(action.id) },
      },
      action.label,
    )),
  )
}

/**
 * The drawer itself.
 *
 * Rendered by `StudioPanel` **inside the canvas tab only** — the list and asset
 * views keep the old form, and a drawer there would be a second editor for one
 * thing. No node means no drawer: the panel prints the hint instead, so nothing
 * on the right edge pretends to be editable.
 */
export function NodeInspector(props: NodeInspectorProps): ReactNode {
  const spec = inspectorSpecFor(props.node, {
    ...(props.options ?? {}),
    ...(props.busy === undefined ? {} : { busy: props.busy }),
  })
  if (spec === undefined) return null
  return createElement(
    'section',
    {
      className: 'dsh-forge-inspector',
      'data-inspector-kind': spec.kind,
      'data-inspector-node': props.node?.id ?? '',
      'aria-label': INSPECTOR_TITLE,
    },
    headOf(spec, props),
    spec.status === undefined
      ? null
      : createElement('div', { className: 'dsh-forge-inspector-status' }, spec.status),
    spec.preview === undefined
      ? null
      : createElement(
        'a',
        {
          className: 'dsh-forge-inspector-preview',
          href: spec.preview.href,
          target: '_blank',
          rel: 'noreferrer',
          title: '打开原图',
        },
        createElement('img', { src: spec.preview.src, alt: spec.preview.alt, draggable: false }),
      ),
    createElement(
      'div',
      { className: 'dsh-forge-inspector-body' },
      ...spec.fields.filter((field) => field.advanced !== true).map((field) => fieldRowOf(field, props)),
      spec.canEditReferences || spec.references.length > 0
        ? referencesOfSpec(spec, props)
        : null,
      ...lineageOf(spec),
      (() => {
        const advanced = spec.fields.filter((field) => field.advanced === true)
        return advanced.length === 0
          ? null
          : createElement(
            'details',
            { className: 'dsh-forge-inspector-details' },
            createElement('summary', {}, '详情'),
            ...advanced.map((field) => fieldRowOf(field, props)),
          )
      })(),
      props.error === undefined
        ? null
        : createElement('div', { className: 'dsh-forge-studio-alert' }, props.error),
      props.note === undefined
        ? null
        : createElement('div', { className: 'dsh-forge-studio-hint' }, props.note),
    ),
    actionsOf(spec, props),
  )
}
