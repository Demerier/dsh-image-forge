/**
 * Client half: keyed tool views for every `qwen_image_*` tool **and** the
 * `dsh-image-forge` first-level settings section.
 *
 * ## Tool views
 *
 * `tool.call.toolview` is a **keyed** slot, and the key must be the tool's wire
 * name for the card to own that call's row — a mismatched key silently
 * registers a view nothing ever dispatches to. All four tools are seated:
 * generate/edit show the landed images, status/env show a compact digest of the
 * JSON the tool already returned in full.
 *
 * Scope note: these cards are supplementary. The primary display path stays the
 * Markdown `![](absolute path)` lines the Host returns in the tool result — if
 * a card cannot render for any reason it renders nothing and the conversation
 * still shows the images. Everything here is defensive for exactly that reason.
 *
 * ## The settings section
 *
 * `settings.section` is a **list** slot (seated by `id`), and a seat there is a
 * first-level entry in the DSH settings page. The page the section renders is
 * bound to the Host's own shared config form for this plugin's profile entry —
 * see `./settings-section.ts` for the binding and save semantics. Field tables
 * live in `./settings-fields.ts`; layout CSS in `./client-styles.ts`. This file
 * is the React layer on top of those.
 *
 * Nothing here reaches for a service at activation time: `configForms` is looked
 * up optionally, and a page that serves none gets a notice in the section rather
 * than losing the plugin's client half (and with it the tool cards).
 */
import { createElement, useEffect, useState, type ReactNode } from 'react'
import { injectClientStyles } from './client-styles.ts'
import { studioFileUrl } from './studio-shared.ts'
import { StudioPanel } from './studio-view.ts'

/**
 * Pseudo tab id for the workbench. It is not a member of `SETTINGS_TABS`
 * because it renders a live surface rather than a form over config fields, so
 * giving it a `groupIds` list would be a lie the tab renderer would act on.
 */
const STUDIO_TAB_ID = 'studio'
import {
  SETTINGS_TABS,
  advisoryAfterGroup,
  displayValue,
  tabFields,
  type SettingsAdvisory,
  type SettingsField,
  type SettingsGroup,
} from './settings-fields.ts'
import {
  registerSettingsSection,
  saveField,
  type ConfigFormLike,
  type SettingsSectionProps,
} from './settings-section.ts'

/**
 * Registration name inside the cordis client context.
 *
 * Deliberately **not exported**: the browser half publishes exactly `apply` and
 * `inject` — the shape the loader reads, and the shape the official template and
 * all ten reference client entries use — while the module identity comes from the
 * factory's `id` in `tsdown.client.config.ts`, not from an export.
 */
const name = 'dsh-image-forge-client'

/**
 * Client services required before `apply` runs.
 *
 * These are **cordis service names**, a different layer from `package.json`'s
 * `dsh.client.inject` (which takes client **module package names**). The two must
 * not be conflated: `slots` is correct here and would be a load failure there.
 *
 * `configForms` is declared because the settings section binds the Host's native
 * form for this entry through it, and every reference plugin that seats a
 * settings section declares it too. It is still read through `ctx.get`, so a page
 * that serves no such service gets the section's "unavailable" notice rather than
 * a crash.
 */
export const inject = ['slots', 'configForms']

/** Every tool this plugin registers, in the order the cards are seated. */
const TOOL_KEYS = [
  'qwen_image_generate',
  'qwen_image_edit',
  'qwen_image_status',
] as const

/** Minimal shape of the host-provided image loader. */
type LoadImage = (path: string) => unknown

/**
 * One item of a tool-result `content` array: the Host renders execute() output
 * as text blocks carrying the JSON payload.
 */
interface ToolContentItem {
  readonly type?: string
  readonly text?: string
}

/**
 * The tool-result block the Host actually hands the view.
 *
 * Discovered on a real client (2026-10-17): the view is **not** given
 * `result.value`. It receives `toolName`, `phase`, `loadImage` and a `block`
 * of kind `tool-result` whose `content[].text` is the JSON that `execute()`
 * returned (after the tool layer validated it). Reading the wrong shape made
 * every card show its empty-state fallbacks in a real client while the Node
 * tests still passed — the live client confirmed it.
 */
interface ToolResultBlock {
  readonly kind?: string
  readonly name?: string
  readonly content?: readonly ToolContentItem[]
  readonly isError?: boolean
}

/** The row props this view reads; every field is optional by design. */
interface ToolRowProps {
  readonly phase?: string
  readonly toolName?: string
  readonly loadImage?: LoadImage
  readonly block?: ToolResultBlock
  /** Legacy/guessed shape kept as a fallback if the Host ever passes it. */
  readonly result?: {
    readonly value?: unknown
  }
}

/** Tolerant read of one nested object field from a tool payload. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/**
 * The tool payload, from the Host's tool-result block (or a `result.value`
 * fallback).
 *
 * @param props - the row props.
 * @returns the parsed JSON object `execute()` returned, if any.
 */
function payloadOf(props: ToolRowProps): Record<string, unknown> | undefined {
  const content = props.block?.content
  if (Array.isArray(content)) {
    for (const item of content) {
      const text = item?.text
      if (typeof text !== 'string' || text.length === 0) continue
      try {
        const parsed: unknown = JSON.parse(text)
        const record = asRecord(parsed)
        if (record !== undefined) return record
      } catch {
        // Not every text block is JSON; keep looking.
      }
    }
  }
  return asRecord(props.result?.value)
}

/** Wire name of the tool this row is rendering. */
function toolNameOf(props: ToolRowProps): string {
  return props.toolName ?? props.block?.name ?? ''
}

/** Pull `images[].path` out of the tool's canonical payload, tolerantly. */
function imagePaths(props: ToolRowProps): string[] {
  const images = payloadOf(props)?.['images']
  if (!Array.isArray(images)) return []
  return images
    .map((entry) => asRecord(entry)?.['path'])
    .filter((path): path is string => typeof path === 'string' && path.length > 0)
}

/** One meta chip; `tone` maps onto the pill modifiers in the stylesheet. */
function pill(key: string, text: string, tone: 'ok' | 'warn' | 'bad' | 'neutral' = 'neutral'): ReactNode {
  const className =
    tone === 'neutral' ? 'dsh-image-forge-pill' : `dsh-image-forge-pill dsh-image-forge-pill-${tone}`
  return createElement('span', { key, className }, text)
}

/** Compact `1664×928` from a result `size` object, or null. */
function sizeChip(value: Record<string, unknown> | undefined): ReactNode {
  const size = asRecord(value?.['size'])
  const width = size?.['width']
  const height = size?.['height']
  if (typeof width !== 'number' || typeof height !== 'number') return null
  return pill('size', `${width}×${height}`)
}

/** Status / running / done line for the current lifecycle phase. */
function phaseLabel(props: ToolRowProps, done: string, running: string): string {
  const phase = props.phase ?? 'start'
  if (phase === 'preparing') return '准备参数…'
  if (phase === 'result') return done
  return running
}

/** Shared card shell: title, status line, optional pills, then children. */
function CardShell(props: {
  title: string
  status: string
  pills: ReactNode[]
  children: ReactNode[]
}): ReactNode {
  return createElement('div', { className: 'dsh-image-forge-row' }, [
    createElement('div', { key: 'head', className: 'dsh-image-forge-row-head' }, [
      createElement('h4', { key: 'title', className: 'dsh-image-forge-row-title' }, props.title),
      createElement('span', { key: 'status', className: 'dsh-image-forge-row-status' }, props.status),
    ]),
    props.pills.length > 0
      ? createElement('div', { key: 'meta', className: 'dsh-image-forge-row-meta' }, props.pills)
      : null,
    ...props.children,
  ])
}

/** The image grid both generate and edit render once paths exist. */
function ImageGrid(props: ToolRowProps): ReactNode {
  const paths = imagePaths(props)
  if (paths.length === 0) return null
  return createElement(
    'div',
    { key: 'images', className: 'dsh-image-forge-images' },
    paths.map((path, index) => {
      // Prefer the host's loader when it exists and answers with a string; a
      // Desktop host whose web server mounts late (or omits `loadImage`)
      // otherwise yields `src: undefined`, which renders as the broken-image
      // alt box. The plugin's own file route serves the same bytes same-origin.
      const loaded = typeof props.loadImage === 'function' ? props.loadImage(path) : undefined
      const src = typeof loaded === 'string' && loaded.length > 0 ? loaded : studioFileUrl(path)
      return createElement('img', {
        key: `image-${index}`,
        src,
        alt: path,
        loading: 'lazy',
      })
    }),
  )
}

/**
 * Generate / edit card: the landed images plus the facts that explain them.
 *
 * @param props - owner props supplied by ui-tool's dispatch.
 * @returns the card, or nothing on a presentation failure.
 */
function ImageResultRow(props: ToolRowProps): ReactNode {
  try {
    const payload = payloadOf(props)
    const isEdit = toolNameOf(props) === 'qwen_image_edit'
    const count = imagePaths(props).length
    const done =
      count > 0
        ? `完成：${count} 张`
        : isEdit
          ? '改图结束（未落盘，请看工具结果）'
          : '出图结束（未落盘，请看工具结果）'
    const status = phaseLabel(props, done, isEdit ? '正在改图…' : '正在出图…')
    const pills: ReactNode[] = []
    const size = sizeChip(payload)
    if (size !== null) pills.push(size)
    const backend = payload?.['backend']
    if (typeof backend === 'string' && backend.length > 0) pills.push(pill('backend', backend))
    const ratio = payload?.['wh_ratio']
    if (typeof ratio === 'string' && ratio.length > 0) pills.push(pill('ratio', `wh_ratio ${ratio}`))
    const follow = payload?.['ratio_follow']
    if (typeof follow === 'string' && follow.length > 0) pills.push(pill('follow', `← ${follow}`))
    const stepsUsed = payload?.['steps_used']
    if (typeof stepsUsed === 'number') pills.push(pill('steps', `${stepsUsed} 步`))
    const refs = payload?.['references']
    if (Array.isArray(refs) && refs.length > 0) pills.push(pill('refs', `${refs.length} 张参考`))

    return createElement(CardShell, {
      title: isEdit ? '参考图编辑' : '文生图',
      status,
      pills,
      children: [createElement(ImageGrid, { key: 'grid', ...props })],
    })
  } catch {
    // A presentation failure must never take down the conversation row.
    return null
  }
}

/** One checklist cell: a short label over a one-line verdict. */
function checkCell(key: string, label: string, text: string, tone: 'ok' | 'warn' | 'bad' | 'neutral'): ReactNode {
  return createElement('div', { key, className: 'dsh-image-forge-check' }, [
    createElement('span', { key: 'label', className: 'dsh-image-forge-check-label' }, label),
    createElement('span', { key: 'value', className: 'dsh-image-forge-check-value' }, text),
    pill('tone', tone === 'neutral' ? '—' : tone === 'ok' ? 'OK' : tone === 'warn' ? '注意' : '不可用', tone),
  ])
}

/**
 * Status card: a three-cell digest of the health probe.
 *
 * The full JSON stays in the tool result; this is the glanceable half.
 *
 * @param props - owner props supplied by ui-tool's dispatch.
 * @returns the card, or nothing on a presentation failure.
 */
function StatusRow(props: ToolRowProps): ReactNode {
  try {
    const payload = payloadOf(props)
    const status = phaseLabel(props, '探测完成', '正在探测后端…')
    const comfy = asRecord(payload?.['comfyui'])

    const comfyOk = comfy?.['reachable'] === true
    const models = asRecord(comfy?.['models'])
    const comfyTone: 'ok' | 'warn' | 'bad' = comfyOk ? (models?.['ok'] === true ? 'ok' : 'warn') : 'bad'
    const comfyText = !comfyOk
      ? '没找到在跑的实例'
      : models?.['ok'] === true
        ? '在跑，三个权重齐'
        : '在跑，但缺 Qwen 权重'

    // One GPU line, straight from ComfyUI's own `/system_stats`: the card that
    // matters is the one it loaded its weights onto.
    const devices = Array.isArray(comfy?.['devices']) ? comfy['devices'] : []
    const device = asRecord(devices[0])
    const vramFree = typeof device?.['vram_free_MiB'] === 'number' ? device['vram_free_MiB'] : null
    const vramTotal = typeof device?.['vram_total_MiB'] === 'number' ? device['vram_total_MiB'] : null
    const gpuText = vramTotal === null
      ? '未报告'
      : `${String(device?.['name'] ?? 'GPU')} · 空闲 ${String(vramFree ?? '?')} / ${String(vramTotal)} MiB`
    const output = asRecord(payload?.['output'])
    const outputWritable = output?.['writable'] === true

    return createElement(CardShell, {
      title: '后端健康',
      status,
      pills: [],
      children: [
        createElement(
          'div',
          { key: 'checks', className: 'dsh-image-forge-checklist' },
          [
            checkCell('comfy', 'ComfyUI', comfyText, comfyTone),
            checkCell('vram', '显卡', gpuText, vramTotal === null ? 'warn' : 'neutral'),
            checkCell('output', '输出目录', outputWritable ? '可写' : '不可写', outputWritable ? 'ok' : 'bad'),
          ],
        ),
      ],
    })
  } catch {
    return null
  }
}

/**
 * Build the tool row bound to one wire name.
 *
 * The Host does not guarantee `toolName` on the props, so the key is closed over
 * at registration time instead of being read back from the call.
 *
 * @param toolName - the tool's wire name.
 * @returns a component that renders that tool's card.
 */
function createToolRow(toolName: string): (props: ToolRowProps) => ReactNode {
  return function QwenImageToolRow(props: ToolRowProps): ReactNode {
    const bound: ToolRowProps = { ...props, toolName: toolNameOf(props) || toolName }
    if (toolName === 'qwen_image_status') return StatusRow(bound)
    return ImageResultRow(bound)
  }
}

// ---------------------------------------------------------------------------
// Settings section.
// ---------------------------------------------------------------------------

/** What a control reports back after an attempted write. */
interface WriteResult {
  /** True when the value landed. */
  readonly ok: boolean
  /** Operator-facing failure text; absent on success. Never contains a value. */
  readonly message?: string
}

/** The write callback the section hands each control. */
type Write = (key: string, value: unknown) => Promise<WriteResult>

/** Shared props every control receives. */
interface ControlProps {
  readonly field: SettingsField
  readonly value: unknown
  readonly disabled: boolean
  readonly write: Write
}

/**
 * Track one control's draft, its save state, and commit through `write`.
 *
 * @param props - the field, its stored value, and the write callback.
 * @returns the control's markup.
 */
function FieldRow(props: ControlProps): ReactNode {
  const { field, value, disabled, write } = props
  const [draft, setDraft] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const controlId = `dsh-image-forge-field-${field.key}`

  const commit = (next: unknown): void => {
    setFailure(undefined)
    let answer: Promise<WriteResult>
    try {
      answer = write(field.key, next)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
      return
    }
    Promise.resolve(answer).then(
      (result) => {
        if (result.ok) {
          setSaved(true)
          setFailure(undefined)
          return
        }
        setSaved(false)
        setFailure(result.message ?? '保存失败')
      },
      (error: unknown) => {
        setSaved(false)
        setFailure(error instanceof Error ? error.message : String(error))
      },
    )
  }

  const control = buildControl(field, value, disabled, draft, setDraft, commit, controlId)
  const status: ReactNode[] = []
  if (failure !== undefined) {
    status.push(
      createElement(
        'span',
        { key: 'failure', className: 'dsh-image-forge-setting-failure', role: 'status' },
        `保存失败：${failure}`,
      ),
    )
  } else if (saved) {
    status.push(
      createElement('span', { key: 'saved', className: 'dsh-image-forge-setting-saved', role: 'status' }, '已保存'),
    )
  }

  return createElement('div', { className: 'dsh-image-forge-setting' }, [
    createElement(
      'label',
      { key: 'label', className: 'dsh-image-forge-setting-label', htmlFor: controlId },
      field.label,
    ),
    createElement('div', { key: 'control', className: 'dsh-image-forge-setting-control' }, control),
    // Hints are plain text and may name a directory (`comfyModelsDir` names the
    // one ComfyUI reads, `outputDir` the one images land in) — they are shown
    // verbatim, with no token substitution to keep in step.
    createElement('p', { key: 'hint', className: 'dsh-image-forge-setting-hint' }, field.hint),
    createElement('div', { key: 'status', className: 'dsh-image-forge-setting-status' }, status),
  ])
}

/**
 * Render the control a field's kind calls for.
 *
 * @param field - the field.
 * @param value - the stored value.
 * @param disabled - whether the entry is writable.
 * @param draft - the local text draft, when the user has typed.
 * @param setDraft - draft setter.
 * @param commit - write callback.
 * @param controlId - the input id the label points at.
 * @returns the control element (and the unit suffix, for numbers).
 */
function buildControl(
  field: SettingsField,
  value: unknown,
  disabled: boolean,
  draft: string | null,
  setDraft: (next: string | null) => void,
  commit: (next: unknown) => void,
  controlId: string,
): ReactNode[] {
  const key = field.key
  const unit =
    field.unit === undefined
      ? []
      : [createElement('span', { key: 'unit', className: 'dsh-image-forge-setting-unit' }, field.unit)]

  if (field.kind === 'boolean') {
    return [
      createElement('input', {
        key: 'input',
        id: controlId,
        type: 'checkbox',
        checked: value === true,
        disabled,
        onChange: (event: { target: { checked: boolean } }) => {
          commit(event.target.checked)
        },
      }),
      ...unit,
    ]
  }
  if (field.kind === 'enum') {
    const choices = field.choices ?? []
    const current = typeof value === 'string' ? value : ''
    return [
      createElement(
        'select',
        {
          key: 'input',
          id: controlId,
          value: current,
          disabled,
          onChange: (event: { target: { value: string } }) => {
            commit(event.target.value)
          },
        },
        choices.map((choice) => createElement('option', { key: choice.value, value: choice.value }, choice.label)),
      ),
      ...unit,
    ]
  }
  if (field.kind === 'number') {
    // Numbers commit on blur so a half-typed value is never written, and are
    // range-checked against the field's own bounds before anything is sent. On a
    // nullable field an emptied box writes `unset` — a real state that means
    // "fall through to another setting", not the number zero.
    return [
      createElement('input', {
        key: 'input',
        id: controlId,
        type: 'number',
        ...(field.min === undefined ? {} : { min: field.min }),
        ...(field.max === undefined ? {} : { max: field.max }),
        value: draft ?? (value === undefined || value === null ? '' : String(value)),
        disabled,
        placeholder: field.nullable === true ? '留空 = 用默认步数' : undefined,
        onChange: (event: { target: { value: string } }) => {
          setDraft(event.target.value)
        },
        onBlur: () => {
          if (draft === null) return
          if (draft.trim() === '') {
            if (field.nullable === true) commit(undefined)
            setDraft(null)
            return
          }
          const parsed = Number(draft)
          if (!Number.isFinite(parsed)) {
            setDraft(null)
            return
          }
          if ((field.min !== undefined && parsed < field.min) || (field.max !== undefined && parsed > field.max)) return
          commit(parsed)
          setDraft(null)
        },
      }),
      ...unit,
    ]
  }
  // Text-ish: `string` and `path`.
  return [
    createElement('input', {
      key: 'input',
      id: controlId,
      type: 'text',
      value: draft ?? (typeof value === 'string' ? value : ''),
      disabled,
      placeholder: field.placeholder ?? '',
      onChange: (event: { target: { value: string } }) => {
        setDraft(event.target.value)
      },
      onBlur: () => {
        if (draft === null) return
        commit(draft)
        setDraft(null)
      },
    }),
    ...unit,
  ]
}

/**
 * One titled block of fields.
 *
 * @param props - the group and its fields.
 * @returns the block.
 */
function GroupBlock(props: {
  group: SettingsGroup
  fields: readonly SettingsField[]
  value: Record<string, unknown>
  disabled: boolean
  write: Write
  beforeFields?: ReactNode
  dense?: boolean
}): ReactNode {
  const { group, fields, value, disabled, write, beforeFields, dense } = props
  return createElement(
    'section',
    {
      className: dense
        ? 'dsh-image-forge-settings-group dsh-image-forge-settings-group-dense'
        : 'dsh-image-forge-settings-group',
      key: group.id,
      'data-group': group.id,
      ...(group.advanced === true ? { 'data-advanced': 'true' } : {}),
    },
    [
      createElement('h3', { key: 'title', className: 'dsh-image-forge-settings-group-title' }, group.label),
      createElement('p', { key: 'hint', className: 'dsh-image-forge-settings-group-hint' }, group.hint),
      beforeFields ?? null,
      createElement(
        'div',
        {
          key: 'fields',
          className: dense
            ? 'dsh-image-forge-settings-fields dsh-image-forge-settings-fields-grid'
            : 'dsh-image-forge-settings-fields',
        },
        fields.map((field) =>
          createElement(FieldRow, {
            key: field.key,
            field,
            value: value[field.key],
            disabled,
            write,
          }),
        ),
      ),
    ],
  )
}

/**
 * The backend performance advisory block.
 *
 * Two lines, on purpose: the page states the actionable conclusion and the one
 * caveat, and the evidence behind them lives in the shipped prose
 * (`docs/configuration.md`, `docs/backends.md`). The strings render as
 * text nodes, so none of them may carry markdown markers (asserted in the tests),
 * and the block's size is held by a text-budget test.
 *
 * @param props - the advisory.
 * @returns the block.
 */
function AdvisoryBlock(props: { advisory: SettingsAdvisory }): ReactNode {
  const { advisory } = props
  return createElement('section', { className: 'dsh-image-forge-advisory', 'data-dsh-part': advisory.id }, [
    createElement('h3', { key: 'title', className: 'dsh-image-forge-advisory-title' }, advisory.title),
    ...advisory.paragraphs.map((text, index) =>
      createElement('p', { key: `p-${index}`, className: 'dsh-image-forge-advisory-p' }, text),
    ),
  ])
}

/**
 * The settings section component.
 *
 * @param props - supplied by the slot's `inject`: the bound form, or the reason
 *   there is none.
 * @returns the section, or a notice explaining why it cannot render.
 */
function QwenImageSettingsSection(props: SettingsSectionProps<unknown>): ReactNode {
  const form = props.form as ConfigFormLike<unknown> | undefined
  const [tick, setTick] = useState(0)
  // The Studio is listed first: it is the surface people open this page for,
  // while the configuration rows below it are a setup task they finish once.
  const [tabId, setTabId] = useState<string>(STUDIO_TAB_ID)

  useEffect(() => {
    if (form === undefined) return undefined
    let off: (() => void) | undefined
    try {
      off = form.subscribe(() => {
        setTick((count) => count + 1)
      })
    } catch {
      off = undefined
    }
    return () => {
      try {
        off?.()
      } catch {
        // The form is already gone during teardown.
      }
    }
  }, [form])

  const studioTab = createElement(
    'button',
    {
      key: STUDIO_TAB_ID,
      type: 'button',
      role: 'tab',
      className: tabId === STUDIO_TAB_ID ? 'dsh-image-forge-tab dsh-image-forge-tab-active' : 'dsh-image-forge-tab',
      'aria-selected': tabId === STUDIO_TAB_ID,
      onClick: () => setTabId(STUDIO_TAB_ID),
    },
    '图像工作台',
  )

  // A host that serves no config form still gets a usable workbench: the Studio
  // route reads the config live on the host side, so nothing here needs the
  // browser's form binding. Only the configuration rows disappear.
  if (form === undefined) {
    return createElement('div', { className: 'dsh-image-forge-settings' }, [
      createElement('div', { key: 'tabs', className: 'dsh-image-forge-tabs', role: 'tablist' }, [studioTab]),
      createElement(
        'div',
        { key: 'panel', className: 'dsh-image-forge-settings-panel', role: 'tabpanel' },
        createElement(StudioPanel),
        createElement(
          'div',
          { key: 'notice', className: 'dsh-image-forge-settings-notice' },
          props.unavailableReason ?? '配置表单不可用：本页只能出图，参数请在 profile 里改。',
        ),
      ),
    ])
  }

  let snapshot: ReturnType<ConfigFormLike<unknown>['getSnapshot']> | undefined
  try {
    snapshot = form.getSnapshot()
  } catch {
    snapshot = undefined
  }
  if (snapshot === undefined || snapshot.status !== 'ready' || typeof snapshot.value !== 'object' || snapshot.value === null) {
    return createElement(
      'div',
      { className: 'dsh-image-forge-settings-notice', 'data-dsh-tick': tick },
      `正在读取本插件配置…（状态：${snapshot?.status ?? 'unknown'}）`,
    )
  }

  const value = snapshot.value as Record<string, unknown>
  const disabled = snapshot.writable === false
  const write: Write = (key, next) =>
    saveField(form, key, next).then(
      (outcome) => (outcome.ok ? { ok: true } : { ok: false, message: outcome.message }),
      (error: unknown) => ({ ok: false, message: error instanceof Error ? error.message : String(error) }),
    )

  const activeTab = tabId === STUDIO_TAB_ID ? undefined : SETTINGS_TABS.find((tab) => tab.id === tabId) ?? SETTINGS_TABS[0]
  const panels = activeTab === undefined ? [] : tabFields(activeTab)
  const studioActive = activeTab === undefined

  return createElement('div', { className: 'dsh-image-forge-settings', 'data-dsh-tick': tick }, [
    createElement(
      'div',
      { key: 'tabs', className: 'dsh-image-forge-tabs', role: 'tablist' },
      [
        studioTab,
        ...SETTINGS_TABS.map((tab) =>
          createElement(
            'button',
            {
              key: tab.id,
              type: 'button',
              role: 'tab',
              className:
                tab.id === activeTab?.id
                  ? 'dsh-image-forge-tab dsh-image-forge-tab-active'
                  : 'dsh-image-forge-tab',
              'aria-selected': tab.id === activeTab?.id,
              onClick: () => setTabId(tab.id),
            },
            tab.label,
          ),
        ),
      ],
    ),
    // Exactly one sibling picks `panel`: the Studio workbench is the only tab
    // that is not a config form, so it renders without the lead line that
    // describes a config write. Both branches must sit in the *same* ternary —
    // two independent ternaries would emit two `key: 'panel'` siblings and make
    // React reconcile the wrong one on every tab switch.
    studioActive
      ? createElement(
        'div',
        { key: 'panel', className: 'dsh-image-forge-settings-panel', role: 'tabpanel' },
        createElement(StudioPanel),
      )
      : createElement('div', { key: 'panel', className: 'dsh-image-forge-settings-panel', role: 'tabpanel' }, [
        createElement(
          'p',
          { key: 'lead', className: 'dsh-image-forge-settings-lead' },
          [
            activeTab?.hint ?? '',
            disabled ? ' 当前配置条目为只读。' : ' 改动会立即写入。',
          ]
            .filter((part) => part.length > 0)
            .join(' '),
        ),
        ...panels.map(({ group, fields }) => {
          const block = createElement(GroupBlock, {
            key: group.id,
            group,
            fields,
            value,
            disabled,
            write,
            dense: true,
          })
          const advisory = advisoryAfterGroup(group.id)
          return advisory === undefined
            ? [block]
            : [block, createElement(AdvisoryBlock, { key: advisory.id, advisory })]
        }),
      ]),
  ])
}

/**
 * Register the keyed tool views and the first-level settings section.
 *
 * @param ctx - cordis client context providing `slots`, and optionally `get`.
 */
export function apply(ctx: {
  slots: {
    inject(name: string, register: () => unknown): void
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  get?(name: string): unknown
}): void {
  injectClientStyles()
  // One inject, four keyed seats: each key is a separate toolview dispatch
  // target, and a single component factory keeps the defensive shell shared.
  ctx.slots.inject('tool.call.toolview', () => {
    const seats = TOOL_KEYS.map((toolName) =>
      ctx.slots.register({ name: 'tool.call.toolview', key: toolName }, createToolRow(toolName)),
    )
    return () => {
      for (const seat of seats) {
        try {
          if (typeof seat === 'function') (seat as () => void)()
        } catch {
          // The slot fiber is already gone during teardown.
        }
      }
    }
  })
  registerSettingsSection(ctx, QwenImageSettingsSection)
}
