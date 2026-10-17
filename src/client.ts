/**
 * Client half: the `qwen_image_generate` keyed tool view **and** the
 * `dsh-image-forge` first-level settings section.
 *
 * ## The tool view
 *
 * `tool.call.toolview` is a **keyed** slot, and the key must be the tool's wire
 * name (`qwen_image_generate`) for the card to own that call's row — a
 * mismatched key silently registers a view nothing ever dispatches to.
 *
 * Scope note: this entry only adds a row that shows progress and, once the
 * result carries absolute paths, renders the images inline through the
 * session-authorized `loadImage` loader the row receives. The primary display
 * path stays the Markdown `![](absolute path)` lines the Host returns in the
 * tool result — if this card cannot render for any reason it renders nothing
 * and the conversation still shows the images. Everything here is defensive for
 * exactly that reason.
 *
 * ## The settings section
 *
 * `settings.section` is a **list** slot (seated by `id`), and a seat there is a
 * first-level entry in the DSH settings page. The page the section renders is
 * bound to the Host's own shared config form for this plugin's profile entry —
 * see `./settings-section.ts` for the binding and save semantics. All the logic
 * lives there, react-free and service-free, so it can be tested; this file is
 * the React layer on top of it.
 *
 * Nothing here reaches for a service at activation time: `configForms` is looked
 * up optionally, and a page that serves none gets a notice in the section rather
 * than losing the plugin's client half (and with it the tool card).
 */
import { createElement, useEffect, useState, type ReactNode } from 'react'
import {
  SECRET_MASK,
  advisoryAfterGroup,
  displayValue,
  groupedFields,
  isSecretField,
  resolveHint,
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

/** Minimal shape of the host-provided image loader. */
type LoadImage = (path: string) => unknown

/** The row props this view reads; every field is optional by design. */
interface ToolRowProps {
  readonly phase?: string
  readonly toolName?: string
  readonly loadImage?: LoadImage
  readonly result?: {
    readonly value?: unknown
  }
}

/** Pull `images[].path` out of the tool's canonical payload, tolerantly. */
function imagePaths(props: ToolRowProps): string[] {
  const value = props.result?.value
  if (typeof value !== 'object' || value === null) return []
  const images = (value as { images?: unknown }).images
  if (!Array.isArray(images)) return []
  return images
    .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as { path?: unknown }).path : undefined))
    .filter((path): path is string => typeof path === 'string' && path.length > 0)
}

/** One-line status text for the current lifecycle phase. */
function statusText(props: ToolRowProps): string {
  const phase = props.phase ?? 'start'
  if (phase === 'preparing') return '准备出图参数…'
  if (phase === 'result') {
    const count = imagePaths(props).length
    return count > 0 ? `出图完成：${count} 张` : '出图结束（未落盘，请看工具结果）'
  }
  return '正在出图（云端 API 或本地 worker）…'
}

/**
 * The tool row itself.
 *
 * @param props - owner props supplied by ui-tool's dispatch.
 * @returns a small card: a status line plus any images the loader accepts.
 */
function QwenImageGenerateRow(props: ToolRowProps): ReactNode {
  try {
    const children: ReactNode[] = [createElement('span', { key: 'status' }, statusText(props))]
    const paths = imagePaths(props)
    if (paths.length > 0 && typeof props.loadImage === 'function') {
      paths.forEach((path, index) => {
        children.push(createElement('img', { key: `image-${index}`, src: props.loadImage?.(path) as string, alt: path }))
      })
    }
    return createElement('div', { className: 'dsh-image-forge-row' }, children)
  } catch {
    // A presentation failure must never take down the conversation row.
    return null
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

  const control = buildControl(field, value, disabled, draft, setDraft, commit)
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
  // A secret's *stored* value is shown only as a mask, and only as an
  // indication that something is set — never the value the Host sent.
  if (isSecretField(field.key)) {
    status.push(
      createElement(
        'span',
        { key: 'stored', className: 'dsh-image-forge-setting-stored' },
        displayValue(field.key, value) === '' ? '未设置' : `已设置 ${SECRET_MASK}`,
      ),
    )
  }

  return createElement('div', { className: 'dsh-image-forge-setting' }, [
    createElement('label', { key: 'label', className: 'dsh-image-forge-setting-label' }, field.label),
    createElement('div', { key: 'control', className: 'dsh-image-forge-setting-control' }, control),
    // Hints may carry the runtime-directory token, which is substituted with the
    // live value: an empty `modelsDir`/`pythonPath` follows `runtimeDir`, so the
    // page has to show where it currently lands without freezing a path.
    createElement('p', { key: 'hint', className: 'dsh-image-forge-setting-hint' }, resolveHint(field.hint, value)),
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
 * @returns the control element.
 */
function buildControl(
  field: SettingsField,
  value: unknown,
  disabled: boolean,
  draft: string | null,
  setDraft: (next: string | null) => void,
  commit: (next: unknown) => void,
): ReactNode {
  const key = field.key
  if (field.kind === 'boolean') {
    return createElement('input', {
      type: 'checkbox',
      checked: value === true,
      disabled,
      onChange: (event: { target: { checked: boolean } }) => {
        commit(event.target.checked)
      },
    })
  }
  if (field.kind === 'enum') {
    const choices = field.choices ?? []
    const current = typeof value === 'string' ? value : ''
    return createElement(
      'select',
      {
        value: current,
        disabled,
        onChange: (event: { target: { value: string } }) => {
          commit(event.target.value)
        },
      },
      choices.map((choice) => createElement('option', { key: choice.value, value: choice.value }, choice.label)),
    )
  }
  if (field.kind === 'number') {
    // Numbers commit on blur so a half-typed value is never written, and are
    // range-checked against the field's own bounds before anything is sent. On a
    // nullable field an emptied box writes `unset` — a real state that means
    // "fall through to another setting", not the number zero.
    return createElement('input', {
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
    })
  }
  // Text-ish: `string`, `path` and `secret`. A secret is a password input whose
  // value starts empty and is only ever sent, never echoed back.
  const secret = field.kind === 'secret'
  const storedPresent = secret && typeof value === 'string' && value.length > 0
  return createElement('input', {
    type: secret ? 'password' : 'text',
    value: draft ?? (secret ? '' : typeof value === 'string' ? value : ''),
    disabled,
    placeholder: storedPresent ? '已保存（留空表示不修改）' : (field.placeholder ?? ''),
    autoComplete: secret ? 'off' : undefined,
    onChange: (event: { target: { value: string } }) => {
      setDraft(event.target.value)
    },
    onBlur: () => {
      if (draft === null) return
      // An untouched empty secret box means "leave the stored key alone".
      if (secret && draft === '') {
        setDraft(null)
        return
      }
      commit(draft)
      setDraft(null)
    },
  })
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
}): ReactNode {
  const { group, fields, value, disabled, write } = props
  return createElement('section', { className: 'dsh-image-forge-settings-group', key: group.id }, [
    createElement('h3', { key: 'title', className: 'dsh-image-forge-settings-group-title' }, group.label),
    createElement('p', { key: 'hint', className: 'dsh-image-forge-settings-group-hint' }, group.hint),
    createElement(
      'div',
      { key: 'fields', className: 'dsh-image-forge-settings-fields' },
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
  ])
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

  if (form === undefined) {
    return createElement(
      'div',
      { className: 'dsh-image-forge-settings-notice' },
      props.unavailableReason ?? '配置表单不可用。',
    )
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

  return createElement('div', { className: 'dsh-image-forge-settings' }, [
    createElement(
      'p',
      { key: 'lead', className: 'dsh-image-forge-settings-lead' },
      disabled ? '当前配置条目为只读，无法保存修改。' : '改动会立即写入本插件的配置。',
    ),
    ...groupedFields().flatMap(({ group, fields }) => {
      const block = createElement(GroupBlock, { key: group.id, group, fields, value, disabled, write })
      // The backend advisory rides directly under the backend controls, where
      // the choice it talks about is actually made.
      const advisory = advisoryAfterGroup(group.id)
      return advisory === undefined
        ? [block]
        : [block, createElement(AdvisoryBlock, { key: advisory.id, advisory })]
    }),
  ])
}

/**
 * Register the keyed tool view and the first-level settings section.
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
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: 'qwen_image_generate' }, QwenImageGenerateRow),
  )
  registerSettingsSection(ctx, QwenImageSettingsSection)
}
