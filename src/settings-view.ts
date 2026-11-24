/** React surface for the plugin's DSH settings section. */
import { createElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  SETTINGS_FIELDS,
  SETTINGS_TABS,
  advisoryAfterGroup,
  fieldByKey,
  isEnvironmentField,
  tabFields,
  type SettingsAdvisory,
  type SettingsField,
  type SettingsGroup,
  type SettingsTab,
  type SettingsTabId,
} from './settings-fields.ts'
import {
  commitSettingsDraft,
  dirtySettingsKeys,
  draftFromValues,
  normalizeSettingsDraft,
  type SettingsDraft,
  type SettingsDraftEntry,
} from './settings-draft.ts'
import type { ConfigFormLike, ConfigFormSnapshotLike, SettingsSectionProps } from './settings-section.ts'
import { refreshStudioEnvironment, runStudioEnvironmentAction, useEnvironmentClient } from './environment-client.ts'
import {
  STUDIO_CONFIG_ROUTE,
  type StudioConfigResponse,
  type StudioEnvironmentSnapshot,
  type StudioLogLine,
  type StudioLogPage,
} from './studio-shared.ts'
import { logFileName, readStudioLogPage } from './studio-log-client.ts'

interface SaveFeedback { readonly tone: 'ok' | 'error' | 'info'; readonly text: string }
interface SaveProgress { readonly completed: number; readonly total: number; readonly key: string }

async function readCapability(signal?: AbortSignal): Promise<{ config?: StudioConfigResponse; error?: string }> {
  try {
    const response = await fetch(STUDIO_CONFIG_ROUTE, { credentials: 'same-origin', ...(signal === undefined ? {} : { signal }) })
    let payload: Record<string, unknown> | undefined
    try {
      const value = await response.json()
      payload = typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
    } catch {
      payload = undefined
    }
    if (!response.ok || payload === undefined || !('ready' in payload)) {
      return { error: typeof payload?.error === 'string' ? payload.error : `生成能力读取失败（HTTP ${String(response.status)}）` }
    }
    return { config: payload as unknown as StudioConfigResponse }
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') return {}
    return { error: cause instanceof Error ? cause.message : String(cause) }
  }
}

async function copyText(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
    await navigator.clipboard.writeText(text)
    return
  }
  if (typeof document === 'undefined') return
  const area = document.createElement('textarea')
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  const copied = document.execCommand('copy')
  area.remove()
  if (!copied) throw new Error('当前浏览器不允许复制')
}

function environmentProcessLabel(clientBusy: string | undefined, environment: StudioEnvironmentSnapshot | undefined): string {
  if (clientBusy === 'start') return '启动中…'
  if (clientBusy === 'stop') return '停止中…'
  if (clientBusy === 'status') return '检测中…'
  if (environment === undefined) return '正在读取'
  if (environment.state === 'ready') return '已运行'
  if (environment.state === 'launch-failed') return '启动失败'
  if (environment.state === 'timeout') return '检测超时'
  if (environment.state === 'not-installed') return '未找到安装'
  return '未运行'
}

function environmentTone(environment: StudioEnvironmentSnapshot | undefined, ready: boolean | undefined): string {
  if (environment === undefined) return 'is-pending'
  if (environment.state !== 'ready') return 'is-bad'
  return ready === false ? 'is-warn' : 'is-ok'
}

function SettingsSkeleton(): ReactNode {
  return createElement('div', { className: 'dsh-image-forge-settings dsh-settings-skeleton', 'aria-busy': 'true' }, [
    createElement('div', { key: 'head', className: 'dsh-settings-skeleton-head' }),
    createElement('div', { key: 'tabs', className: 'dsh-settings-skeleton-tabs' }),
    createElement('div', { key: 'env', className: 'dsh-settings-skeleton-card is-tall' }),
    createElement('div', { key: 'group-a', className: 'dsh-settings-skeleton-card' }),
    createElement('div', { key: 'group-b', className: 'dsh-settings-skeleton-card' }),
  ])
}

function SettingsUnavailable(props: { reason: string }): ReactNode {
  return createElement('div', { className: 'dsh-image-forge-settings' }, [
    createElement('section', { key: 'notice', className: 'dsh-settings-unavailable' }, [
      createElement('span', { key: 'mark', className: 'dsh-settings-unavailable-mark', 'aria-hidden': 'true' }, '!'),
      createElement('div', { key: 'copy', className: 'dsh-settings-unavailable-copy' }, [
        createElement('h3', { key: 'title' }, '配置表单不可用'),
        createElement('p', { key: 'body' }, props.reason),
      ]),
    ]),
  ])
}

function logSourceLabel(environment: StudioEnvironmentSnapshot | undefined): string {
  if (environment === undefined) return '正在读取连接状态'
  if (environment.logPath === undefined) return environment.state === 'ready' ? '未找到可读取的日志' : '当前没有日志'
  return `${environment.owned ? '插件启动' : 'ComfyUI Desktop'} · ${logFileName(environment.logPath) ?? '日志'}`
}

function mergeLogLines(previous: readonly StudioLogLine[], page: StudioLogPage): StudioLogLine[] {
  if (previous.length === 0) return [...page.lines].slice(-200)
  const last = previous[previous.length - 1]?.number ?? 0
  const appended = page.lines.filter((line) => line.number > last)
  const merged = appended.length === 0 ? [...previous] : [...previous, ...appended]
  return merged.length <= 200 ? merged : merged.slice(-200)
}

function RecentLogs(props: { environment: StudioEnvironmentSnapshot | undefined }): ReactNode {
  const { environment } = props
  const logPath = environment?.logPath
  const [open, setOpen] = useState(true)
  const [follow, setFollow] = useState(true)
  const [visible, setVisible] = useState(typeof document === 'undefined' || document.visibilityState !== 'hidden')
  const [lines, setLines] = useState<readonly StudioLogLine[]>([])
  const [page, setPage] = useState<StudioLogPage | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [unread, setUnread] = useState(0)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const linesRef = useRef<readonly StudioLogLine[]>([])

  useEffect(() => { linesRef.current = lines }, [lines])
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const update = (): void => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  const loadLatest = useCallback(async (): Promise<void> => {
    if (logPath === undefined) return
    setBusy(true)
    const result = await readStudioLogPage(logPath, { limit: 80 })
    if (result.page === undefined) setError(result.error ?? '日志读取失败')
    else {
      setError(undefined)
      setPage(result.page)
      setLines(result.page.lines)
      setUnread(0)
    }
    setBusy(false)
  }, [logPath])

  const loadAfter = useCallback(async (): Promise<void> => {
    if (logPath === undefined) return
    const after = linesRef.current[linesRef.current.length - 1]?.number
    if (after === undefined) return void loadLatest()
    const result = await readStudioLogPage(logPath, { after, limit: 80 })
    if (result.page === undefined) return setError(result.error ?? '日志刷新失败')
    setError(undefined)
    setPage(result.page)
    setLines((previous) => mergeLogLines(previous, result.page as StudioLogPage))
    if (!follow) setUnread((count) => count + result.page!.lines.filter((line) => line.number > after).length)
  }, [follow, loadLatest, logPath])

  useEffect(() => {
    setLines([])
    linesRef.current = []
    setPage(undefined)
    setError(undefined)
    setUnread(0)
    if (open && logPath !== undefined) void loadLatest()
  }, [loadLatest, logPath, open])

  useEffect(() => {
    if (!open || !follow || !visible || logPath === undefined || typeof window === 'undefined') return undefined
    const timer = window.setInterval(() => { void loadAfter() }, 2000)
    return () => window.clearInterval(timer)
  }, [follow, loadAfter, logPath, open, visible])

  useEffect(() => {
    if (follow && open && bodyRef.current !== null) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [follow, lines.length, open])

  const onScroll = (event: { currentTarget: { scrollTop: number; scrollHeight: number; clientHeight: number } }): void => {
    const target = event.currentTarget
    const atBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 28
    setFollow(atBottom)
    if (atBottom) setUnread(0)
  }

  const copy = async (): Promise<void> => {
    try { await copyText(lines.map((line) => line.text).join('\n')) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  const source = logSourceLabel(environment)
  const emptyText = logPath === undefined
    ? (environment?.state === 'ready' ? 'ComfyUI 正在运行，但没有可读取的日志文件。' : '启动 ComfyUI 或重新检测后，这里会显示最近日志。')
    : (error ?? '日志文件暂时为空，或还没有新的输出。')

  return createElement('section', { className: 'dsh-settings-log' }, [
    createElement('div', { key: 'head', className: 'dsh-settings-log-head' }, [
      createElement('button', {
        key: 'toggle', type: 'button', className: 'dsh-settings-log-toggle', 'aria-expanded': open,
        onClick: () => setOpen((value) => !value),
      }, [
        createElement('span', { key: 'chevron', className: 'dsh-settings-log-chevron', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
        createElement('span', { key: 'label' }, '最近日志'),
        createElement('span', { key: 'source', className: 'dsh-settings-log-source', title: logPath }, source),
      ]),
      open ? createElement('div', { key: 'actions', className: 'dsh-settings-log-actions' }, [
        createElement('button', {
          key: 'follow', type: 'button', className: follow ? 'dsh-settings-small is-active' : 'dsh-settings-small',
          'aria-pressed': follow,
          onClick: () => { setFollow((value) => !value); if (!follow) setUnread(0) },
        }, follow ? '跟随中' : unread > 0 ? `继续跟随 · ${String(unread)}` : '继续跟随'),
        createElement('button', {
          key: 'refresh', type: 'button', className: 'dsh-settings-small', disabled: busy || logPath === undefined,
          onClick: () => { void loadLatest() },
        }, busy ? '读取中…' : '刷新'),
        createElement('button', {
          key: 'copy', type: 'button', className: 'dsh-settings-small', disabled: lines.length === 0,
          onClick: () => { void copy() },
        }, '复制'),
      ]) : null,
    ]),
    open ? createElement('div', {
      key: 'body', ref: bodyRef,
      className: lines.length === 0 ? 'dsh-settings-log-output is-empty' : 'dsh-settings-log-output',
      role: 'log', 'aria-label': 'ComfyUI 最近日志', tabIndex: 0, onScroll,
    }, lines.length === 0
      ? [
          createElement('div', { key: 'empty', className: 'dsh-settings-log-empty' }, emptyText),
          createElement('div', { key: 'meta', className: 'dsh-settings-log-empty-meta' }, `来源：${source}`),
        ]
      : lines.map((line) => createElement('div', {
          key: line.number,
          className: `dsh-settings-log-line is-${line.level}`,
          'data-line-number': line.number,
        }, [
          createElement('span', { key: 'no', className: 'dsh-settings-log-no' }, String(line.number)),
          createElement('span', { key: 'time', className: 'dsh-settings-log-time' }, line.timestamp ?? '—'),
          createElement('span', { key: 'text', className: 'dsh-settings-log-text' }, line.text.length === 0 ? ' ' : line.text),
        ]))) : null,
    page === undefined ? null : createElement('div', { key: 'foot', className: 'dsh-settings-log-foot' }, `共 ${String(page.totalLines)} 行 · 展开时每 2 秒跟随最新输出`),
  ])
}

function EnvironmentPanel(props: { blockedReason?: string; refreshToken: number }): ReactNode {
  const client = useEnvironmentClient()
  const environment = client.environment
  const busy = client.busy
  const [capability, setCapability] = useState<StudioConfigResponse | undefined>(undefined)
  const [capabilityError, setCapabilityError] = useState<string | undefined>(undefined)
  const [stopConfirm, setStopConfirm] = useState(false)
  const blocked = props.blockedReason !== undefined
  const actionBusy = busy !== undefined

  const loadCapability = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const result = await readCapability(signal)
    if (result.config === undefined) setCapabilityError(result.error ?? '生成能力读取失败')
    else { setCapability(result.config); setCapabilityError(undefined) }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void refreshStudioEnvironment()
    void loadCapability(controller.signal)
    return () => controller.abort()
  }, [loadCapability, props.refreshToken])

  const runAction = async (action: 'start' | 'stop'): Promise<void> => {
    setStopConfirm(false)
    await runStudioEnvironmentAction(action)
    await loadCapability()
  }

  const owned = environment?.canStop === true || (environment?.canStop === undefined && environment?.owned === true)
  const processLabel = environmentProcessLabel(busy, environment)
  const tone = environmentTone(environment, capability?.ready)
  const stateLine = blocked
    ? '先保存连接配置'
    : busy === 'start'
      ? '正在启动 ComfyUI'
      : busy === 'stop'
        ? '正在停止 ComfyUI'
        : busy === 'status'
          ? '正在检测环境'
          : environment?.state === 'ready'
            ? 'ComfyUI 进程在线'
            : processLabel
  const fact = (label: string, value: string, title?: string): ReactNode => [
    createElement('dt', { key: `dt-${label}` }, label),
    createElement('dd', { key: `dd-${label}`, ...(title === undefined ? {} : { title }) }, value),
  ]

  return createElement('section', { className: 'dsh-settings-environment', 'data-tone': tone }, [
    createElement('div', { key: 'head', className: 'dsh-settings-environment-head' }, [
      createElement('div', { key: 'copy', className: 'dsh-settings-environment-copy' }, [
        createElement('div', { key: 'eyebrow', className: 'dsh-settings-eyebrow' }, '运行环境'),
        createElement('h3', { key: 'title', className: 'dsh-settings-environment-title' }, stateLine),
        createElement('p', { key: 'note', className: 'dsh-settings-environment-note' }, blocked
          ? props.blockedReason ?? ''
          : environment?.note ?? capability?.reason ?? '进程在线后，生成能力会单独检查模型与权重。'),
      ]),
      createElement('div', { key: 'pills', className: 'dsh-settings-environment-pills' }, [
        createElement('span', { key: 'process', className: `dsh-settings-state ${tone}` }, [
          createElement('span', { key: 'dot', className: 'dsh-settings-dot', 'aria-hidden': 'true' }),
          createElement('span', { key: 'label' }, `进程 · ${processLabel}`),
        ]),
        createElement('span', {
          key: 'capability',
          className: capability?.ready === true
            ? 'dsh-settings-state is-ok'
            : capabilityError !== undefined || capability?.ready === false
              ? 'dsh-settings-state is-warn'
              : 'dsh-settings-state is-pending',
        }, [
          createElement('span', { key: 'dot', className: 'dsh-settings-dot', 'aria-hidden': 'true' }),
          createElement('span', { key: 'label' }, `生成能力 · ${capability?.ready === true ? '已就绪' : capability === undefined ? '读取中' : '未就绪'}`),
        ]),
      ]),
    ]),
    createElement('div', { key: 'grid', className: 'dsh-settings-environment-grid' }, [
      createElement('dl', { key: 'facts', className: 'dsh-settings-facts' }, [
        fact('端点', capability?.endpoint ?? environment?.endpoint ?? '—'),
        fact('进程归属', owned && environment?.pid !== undefined ? `插件拉起 · PID ${String(environment.pid)}` : environment?.state === 'ready' ? '由其他程序启动，插件不提供停止' : '无'),
        fact('日志', environment?.logPath ?? '—', environment?.logPath),
        fact('状态说明', capabilityError ?? client.error ?? capability?.reason ?? environment?.hint ?? '—'),
      ]),
      blocked ? createElement('div', { key: 'blocked', className: 'dsh-settings-env-block', role: 'status' }, [
        createElement('strong', { key: 'title' }, '连接配置尚未保存'),
        createElement('span', { key: 'body' }, props.blockedReason ?? ''),
      ]) : null,
      client.error === undefined ? null : createElement('div', { key: 'error', className: 'dsh-settings-inline-error', role: 'alert' }, client.error),
      client.note === undefined ? null : createElement('div', { key: 'note', className: 'dsh-settings-inline-note' }, client.note),
      environment?.stopBlockedReason === undefined ? null : createElement('div', { key: 'stop-block', className: 'dsh-settings-inline-note' }, environment.stopBlockedReason),
      createElement('details', { key: 'diagnostics', className: 'dsh-settings-diagnostics' }, [
        createElement('summary', { key: 'summary' }, '诊断详情'),
        createElement('p', { key: 'reason' }, capability?.reason ?? environment?.hint ?? '没有额外诊断信息。'),
        environment?.argvPreview === undefined || environment.argvPreview.length === 0
          ? null
          : createElement('code', { key: 'argv', className: 'dsh-settings-argv' }, environment.argvPreview.join(' ')),
      ]),
      createElement('div', { key: 'actions', className: 'dsh-settings-actions' }, [
        environment?.state === 'ready'
          ? owned
            ? createElement('button', {
                key: 'stop', type: 'button', className: 'dsh-settings-action is-danger', disabled: actionBusy || blocked,
                onClick: () => setStopConfirm(true),
              }, busy === 'stop' ? '停止中…' : '停止 ComfyUI')
            : createElement('button', {
                key: 'stop-disabled', type: 'button', className: 'dsh-settings-action is-danger', disabled: true,
                title: environment.stopBlockedReason ?? environment.ownershipNote ?? '该实例由其他程序启动',
              }, '停止不可用')
          : environment?.canStop === true
            ? createElement('button', {
                key: 'stop-record', type: 'button', className: 'dsh-settings-action is-danger', disabled: actionBusy || blocked,
                onClick: () => setStopConfirm(true),
              }, busy === 'stop' ? '停止中…' : '停止残留进程')
            : createElement('button', {
                key: 'start', type: 'button', className: 'dsh-settings-action is-primary', disabled: actionBusy || blocked,
                onClick: () => { void runAction('start') },
              }, busy === 'start' ? '启动中…' : '启动 ComfyUI'),
        createElement('button', {
          key: 'recheck', type: 'button', className: 'dsh-settings-action', disabled: actionBusy || blocked,
          onClick: () => { void refreshStudioEnvironment(); void loadCapability() },
        }, busy === 'status' ? '检测中…' : '重新检测'),
      ]),
      stopConfirm ? createElement('div', { key: 'confirm', className: 'dsh-settings-confirm', role: 'alertdialog', 'aria-label': '确认停止 ComfyUI' }, [
        createElement('strong', { key: 'title' }, '停止本次由插件拉起的 ComfyUI？'),
        createElement('span', { key: 'body' }, '正在运行的任务会中断。'),
        createElement('div', { key: 'buttons', className: 'dsh-settings-confirm-actions' }, [
          createElement('button', { key: 'cancel', type: 'button', className: 'dsh-settings-small', onClick: () => setStopConfirm(false) }, '取消'),
          createElement('button', { key: 'confirm-stop', type: 'button', className: 'dsh-settings-action is-danger', onClick: () => { void runAction('stop') } }, '确认停止'),
        ]),
      ]) : null,
    ]),
    createElement(RecentLogs, { key: 'logs', environment }),
  ])
}

function FieldRow(props: {
  field: SettingsField
  entry: SettingsDraftEntry | undefined
  currentValue: unknown
  disabled: boolean
  dirty: boolean
  error: string | undefined
  onChange: (entry: SettingsDraftEntry) => void
  onReset: () => void
}): ReactNode {
  const { field, entry, currentValue, disabled, dirty, error, onChange, onReset } = props
  const id = `dsh-image-forge-field-${field.key}`
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const reset = entry?.kind === 'unset'
  const value = entry?.kind === 'value'
    ? entry.value
    : field.kind === 'boolean'
      ? currentValue === true
      : currentValue === undefined || currentValue === null ? '' : String(currentValue)
  const describedBy = error === undefined ? hintId : `${hintId} ${errorId}`

  let control: ReactNode
  if (field.kind === 'boolean') {
    control = createElement('label', { className: 'dsh-settings-switch' }, [
      createElement('input', {
        key: 'input', id, type: 'checkbox', checked: value === true, disabled,
        'aria-describedby': describedBy, 'aria-invalid': error !== undefined,
        onChange: (event: { target: { checked: boolean } }) => onChange({ kind: 'value', value: event.target.checked }),
      }),
      createElement('span', { key: 'track', className: 'dsh-settings-switch-track', 'aria-hidden': 'true' }, createElement('span', { className: 'dsh-settings-switch-thumb' })),
      createElement('span', { key: 'label', className: 'dsh-settings-switch-label' }, value === true ? '已开启' : '已关闭'),
    ])
  } else if (field.kind === 'enum') {
    control = createElement('select', {
      id, className: 'dsh-settings-control', value: String(value), disabled, 'aria-describedby': describedBy, 'aria-invalid': error !== undefined,
      onChange: (event: { target: { value: string } }) => onChange({ kind: 'value', value: event.target.value }),
    }, (field.choices ?? []).map((choice) => createElement('option', { key: choice.value, value: choice.value }, choice.label)))
  } else {
    control = createElement('div', { className: 'dsh-settings-input-wrap' }, [
      createElement('input', {
        key: 'input', id, className: 'dsh-settings-control',
        type: field.kind === 'number' ? 'number' : 'text',
        value: String(value), disabled,
        placeholder: reset ? '保存后恢复默认' : field.placeholder ?? '',
        min: field.min, max: field.max,
        inputMode: field.kind === 'number' ? 'numeric' : undefined,
        'aria-describedby': describedBy, 'aria-invalid': error !== undefined,
        onChange: (event: { target: { value: string } }) => onChange({ kind: 'value', value: event.target.value }),
      }),
      field.unit === undefined ? null : createElement('span', { key: 'unit', className: 'dsh-settings-unit' }, field.unit),
      reset ? createElement('span', { key: 'reset', className: 'dsh-settings-reset-mark' }, '默认') : null,
    ])
  }

  const status = error !== undefined
    ? createElement('span', { id: errorId, key: 'error', className: 'dsh-settings-field-error', role: 'alert' }, error)
    : reset
      ? createElement('span', { key: 'reset', className: 'dsh-settings-field-reset' }, '保存后恢复默认')
      : dirty ? createElement('span', { key: 'dirty', className: 'dsh-settings-field-dirty' }, '未保存') : null

  return createElement('div', {
    className: ['dsh-image-forge-setting', dirty ? 'is-dirty' : '', reset ? 'is-reset' : '', error === undefined ? '' : 'is-invalid'].filter(Boolean).join(' '),
    'data-field': field.key,
  }, [
    createElement('div', { key: 'head', className: 'dsh-settings-field-head' }, [
      createElement('label', { key: 'label', className: 'dsh-image-forge-setting-label', htmlFor: id, title: field.key }, field.label),
      createElement('button', {
        key: 'reset-button', type: 'button', className: 'dsh-settings-reset-button', disabled: disabled || reset,
        onClick: onReset, title: '把这一项留到保存时恢复默认',
      }, '恢复默认'),
    ]),
    createElement('div', { key: 'control', className: 'dsh-image-forge-setting-control' }, control),
    createElement('p', { key: 'hint', id: hintId, className: 'dsh-image-forge-setting-hint' }, field.hint),
    createElement('div', { key: 'status', className: 'dsh-image-forge-setting-status' }, status),
  ])
}

function GroupCard(props: {
  group: SettingsGroup
  fields: readonly SettingsField[]
  values: Readonly<Record<string, unknown>>
  entries: SettingsDraft
  dirty: ReadonlySet<string>
  errors: Readonly<Record<string, string>>
  disabled: boolean
  onChange: (key: string, entry: SettingsDraftEntry) => void
  onReset: (key: string) => void
}): ReactNode {
  return createElement('section', {
    className: 'dsh-image-forge-settings-group',
    'data-group': props.group.id,
    ...(props.group.advanced === true ? { 'data-advanced': 'true' } : {}),
  }, [
    createElement('div', { key: 'head', className: 'dsh-settings-group-head' }, [
      createElement('h3', { key: 'title', className: 'dsh-image-forge-settings-group-title' }, props.group.label),
      createElement('span', { key: 'count', className: 'dsh-settings-group-count' }, `${String(props.fields.length)} 项`),
    ]),
    createElement('p', { key: 'hint', className: 'dsh-image-forge-settings-group-hint' }, props.group.hint),
    createElement('div', { key: 'fields', className: 'dsh-image-forge-settings-fields' },
      props.fields.map((field) => createElement(FieldRow, {
        key: field.key,
        field,
        entry: props.entries[field.key],
        currentValue: props.values[field.key],
        disabled: props.disabled,
        dirty: props.dirty.has(field.key),
        error: props.errors[field.key],
        onChange: (entry: SettingsDraftEntry) => props.onChange(field.key, entry),
        onReset: () => props.onReset(field.key),
      }))),
  ])
}

function AdvisoryCard(props: { advisory: SettingsAdvisory }): ReactNode {
  return createElement('section', { className: 'dsh-image-forge-advisory', 'data-dsh-part': props.advisory.id }, [
    createElement('h3', { key: 'title', className: 'dsh-image-forge-advisory-title' }, props.advisory.title),
    ...props.advisory.paragraphs.map((text, index) => createElement('p', { key: `p-${index}`, className: 'dsh-image-forge-advisory-p' }, text)),
  ])
}

function dirtyCountForTab(tab: SettingsTab, dirty: readonly string[]): number {
  const keys = new Set(tabFields(tab).flatMap(({ fields }) => fields.map((field) => field.key)))
  return dirty.filter((key) => keys.has(key)).length
}

export function QwenImageSettingsSection(props: SettingsSectionProps<unknown>): ReactNode {
  const form = props.form as ConfigFormLike<unknown> | undefined
  const [tick, setTick] = useState(0)
  const [tabId, setTabId] = useState<SettingsTabId>('basic')
  const [draft, setDraft] = useState<SettingsDraft | null>(null)
  const [draftRevision, setDraftRevision] = useState<number | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [progress, setProgress] = useState<SaveProgress | undefined>(undefined)
  const [feedback, setFeedback] = useState<SaveFeedback | undefined>(undefined)
  const [needReload, setNeedReload] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)

  let snapshot: ConfigFormSnapshotLike<unknown> | undefined
  try { snapshot = form?.getSnapshot() } catch { snapshot = undefined }
  const ready = snapshot !== undefined && snapshot.status === 'ready' && typeof snapshot.value === 'object' && snapshot.value !== null
  const values = ready && snapshot !== undefined ? snapshot.value as Record<string, unknown> : {}
  const baseEntries = draft ?? draftFromValues(SETTINGS_FIELDS, values)
  const validation = normalizeSettingsDraft(SETTINGS_FIELDS, baseEntries, values)
  const errors = Object.fromEntries(validation.errors.map((error) => [error.key, error.message]))
  const dirty = draft === null ? [] : dirtySettingsKeys(SETTINGS_FIELDS, draft, values)
  const dirtySet = new Set(dirty)
  const disabled = snapshot?.writable === false
  const conflict = !saving && !needReload && draft !== null && draftRevision !== undefined && snapshot?.revision !== undefined && snapshot.revision !== draftRevision
  const blockedReason = dirty.some(isEnvironmentField)
    ? '端点、端口、模型目录或模型有未保存修改；保存后才能启动、停止或重新检测。'
    : undefined
  const activeTab = SETTINGS_TABS.find((tab) => tab.id === tabId) ?? SETTINGS_TABS[0]

  useEffect(() => {
    if (form === undefined) return undefined
    let off: (() => void) | undefined
    try { off = form.subscribe(() => setTick((count) => count + 1)) } catch { off = undefined }
    return () => { try { off?.() } catch { /* teardown */ } }
  }, [form])

  useEffect(() => {
    if (dirty.length === 0 || typeof window === 'undefined') return undefined
    const warn = (event: BeforeUnloadEvent): string => { event.preventDefault(); event.returnValue = ''; return '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty.length])

  if (form === undefined) return createElement(SettingsUnavailable, { reason: props.unavailableReason ?? '当前页面没有提供配置表单服务。' })
  if (!ready) return snapshot?.status === 'loading' || snapshot === undefined
    ? createElement(SettingsSkeleton)
    : createElement(SettingsUnavailable, { reason: `配置读取失败：${snapshot.status ?? 'unknown'}` })

  const changeEntry = (key: string, entry: SettingsDraftEntry): void => {
    if (draft === null) {
      setDraftRevision(snapshot?.revision)
      setDraft({ ...draftFromValues(SETTINGS_FIELDS, values), [key]: entry })
    } else setDraft({ ...draft, [key]: entry })
    setFeedback(undefined)
  }
  const resetField = (key: string): void => changeEntry(key, { kind: 'unset' })
  const discard = (): void => {
    setDraft(null); setDraftRevision(undefined); setNeedReload(false)
    setFeedback({ tone: 'info', text: '已放弃未保存的修改。' })
  }
  const reload = (): void => {
    setDraft(null); setDraftRevision(undefined); setNeedReload(false)
    setFeedback({ tone: 'info', text: '已重新读取当前配置。' })
    setRefreshToken((token) => token + 1)
  }
  const focusFirstError = (): void => {
    const first = validation.errors[0]?.key
    if (first === undefined || typeof document === 'undefined') return
    document.getElementById(`dsh-image-forge-field-${first}`)?.focus()
  }
  const saveAll = async (): Promise<void> => {
    if (saving || draft === null || dirty.length === 0) return
    if (conflict || needReload) { setFeedback({ tone: 'error', text: '配置已在别处更新，请先重新载入。' }); return }
    if (validation.errors.length > 0) {
      setFeedback({ tone: 'error', text: `还有 ${String(validation.errors.length)} 项需要修正。` })
      focusFirstError(); return
    }
    setSaving(true)
    setProgress({ completed: 0, total: validation.changes.length, key: '' })
    const result = await commitSettingsDraft(form, SETTINGS_FIELDS, draft, values, draftRevision, (completed, total, key) => setProgress({ completed, total, key }))
    setSaving(false); setProgress(undefined)
    if (result.status === 'saved') {
      setDraft(null); setDraftRevision(undefined); setNeedReload(false)
      setFeedback({ tone: 'ok', text: result.changed.length === 0 ? '没有需要保存的修改。' : `已保存 ${String(result.changed.length)} 项，立即生效。` })
      setRefreshToken((token) => token + 1); return
    }
    if (result.status === 'invalid') {
      setFeedback({ tone: 'error', text: result.message ?? '配置校验失败。' }); focusFirstError(); return
    }
    if (result.revision !== undefined) setDraftRevision(result.revision)
    if (result.status === 'conflict' || result.status === 'rollback-partial') setNeedReload(true)
    setFeedback({
      tone: 'error',
      text: result.status === 'rollback-partial'
        ? `${result.message ?? '保存失败。'} 未回滚：${result.rollbackFailed.map((key) => fieldByKey(key)?.label ?? key).join('、')}。`
        : result.message ?? '保存失败。',
    })
  }
  const tabKeyboard = (event: { key: string; preventDefault(): void }, index: number): void => {
    let next = index
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % SETTINGS_TABS.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = SETTINGS_TABS.length - 1
    else return
    event.preventDefault()
    const nextTab = SETTINGS_TABS[next]
    if (nextTab === undefined) return
    setTabId(nextTab.id)
    if (typeof document !== 'undefined') document.getElementById(`dsh-image-forge-tab-${nextTab.id}`)?.focus()
  }

  const groups = activeTab === undefined ? [] : tabFields(activeTab)
  const saveLabel = saving
    ? `保存中 ${String(progress?.completed ?? 0)}/${String(progress?.total ?? 0)}…`
    : feedback?.tone === 'ok' ? '已保存' : '保存更改'

  return createElement('div', {
    className: 'dsh-image-forge-settings',
    'data-dsh-tick': tick,
    onKeyDown: (event: { key: string; ctrlKey: boolean; metaKey: boolean; preventDefault(): void }) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (!disabled && !conflict && !needReload && dirty.length > 0) void saveAll()
      }
    },
  }, [
    createElement('header', { key: 'head', className: 'dsh-settings-heading' }, [
      createElement('div', { key: 'copy' }, [
        createElement('span', { key: 'eyebrow', className: 'dsh-settings-eyebrow' }, '工作台配置'),
        createElement('h2', { key: 'title', className: 'dsh-settings-title' }, '生图运行与配置'),
        createElement('p', { key: 'subtitle', className: 'dsh-settings-subtitle' }, '连接 ComfyUI，决定默认模型、画幅参数与输出位置；修改会先留在这里，保存后立即生效。'),
      ]),
      createElement('div', { key: 'state', className: 'dsh-settings-heading-state' }, [
        createElement('span', { key: 'dirty', className: dirty.length > 0 ? 'dsh-settings-heading-pill is-dirty' : 'dsh-settings-heading-pill' }, dirty.length > 0 ? `${String(dirty.length)} 项未保存` : '配置已同步'),
        createElement('span', { key: 'mode', className: 'dsh-settings-heading-meta' }, disabled ? '只读配置' : '统一保存'),
      ]),
    ]),
    conflict ? createElement('div', { key: 'conflict', className: 'dsh-settings-banner is-warning', role: 'alert' }, [
      createElement('span', { key: 'copy' }, '配置已在别处更新。当前草稿仍保留，但需要重新载入后才能保存。'),
      createElement('button', { key: 'reload', type: 'button', className: 'dsh-settings-small', onClick: reload }, '重新载入'),
    ]) : null,
    needReload ? createElement('div', { key: 'reload', className: 'dsh-settings-banner is-error', role: 'alert' }, [
      createElement('span', { key: 'copy' }, '保存未完成，部分写入状态需要重新读取后才能继续。'),
      createElement('button', { key: 'reload-button', type: 'button', className: 'dsh-settings-small', onClick: reload }, '重新读取'),
    ]) : null,
    disabled ? createElement('div', { key: 'readonly', className: 'dsh-settings-banner is-warning' }, '当前配置条目为只读，所有控件和保存按钮已禁用。') : null,
    createElement('div', { key: 'tabs', className: 'dsh-image-forge-tabs', role: 'tablist', 'aria-label': '生图配置分区' },
      SETTINGS_TABS.map((tab, index) => {
        const count = dirtyCountForTab(tab, dirty)
        return createElement('button', {
          key: tab.id,
          id: `dsh-image-forge-tab-${tab.id}`,
          type: 'button', role: 'tab',
          className: tab.id === activeTab?.id ? 'dsh-image-forge-tab is-active' : 'dsh-image-forge-tab',
          'aria-selected': tab.id === activeTab?.id,
          'aria-controls': `dsh-image-forge-panel-${tab.id}`,
          tabIndex: tab.id === activeTab?.id ? 0 : -1,
          onClick: () => setTabId(tab.id),
          onKeyDown: (event: { key: string; preventDefault(): void }) => tabKeyboard(event, index),
        }, [
          createElement('span', { key: 'label', className: 'dsh-image-forge-tab-label' }, tab.label),
          count > 0 ? createElement('span', { key: 'count', className: 'dsh-image-forge-tab-count' }, String(count)) : null,
        ])
      })),
    activeTab === undefined ? null : createElement('main', {
      key: 'panel', id: `dsh-image-forge-panel-${activeTab.id}`,
      className: 'dsh-image-forge-settings-panel', role: 'tabpanel',
      'aria-labelledby': `dsh-image-forge-tab-${activeTab.id}`,
    }, [
      createElement('p', { key: 'lead', className: 'dsh-image-forge-settings-lead' }, activeTab.hint),
      activeTab.id === 'basic' ? createElement(EnvironmentPanel, { key: 'environment', blockedReason, refreshToken }) : null,
      ...groups.map(({ group, fields }) => {
        const card = createElement(GroupCard, {
          key: group.id, group, fields, values, entries: baseEntries, dirty: dirtySet, errors, disabled,
          onChange: changeEntry, onReset: resetField,
        })
        const advisory = advisoryAfterGroup(group.id)
        return advisory === undefined ? card : [card, createElement(AdvisoryCard, { key: advisory.id, advisory })]
      }),
    ]),
    createElement('footer', { key: 'savebar', className: 'dsh-settings-savebar' }, [
      createElement('div', { key: 'copy', className: 'dsh-settings-save-copy' }, [
        createElement('strong', { key: 'strong' }, disabled ? '配置文件只读' : dirty.length > 0 ? `${String(dirty.length)} 项等待保存` : '所有配置已保存'),
        createElement('span', {
          key: 'detail',
          className: feedback === undefined ? 'dsh-settings-save-detail' : `dsh-settings-save-detail is-${feedback.tone}`,
          role: feedback?.tone === 'error' ? 'alert' : 'status',
        }, feedback?.text ?? (dirty.length > 0 ? '保存后立即写入，不需要重启插件。' : '修改会先保留在本地草稿中。')),
      ]),
      createElement('div', { key: 'actions', className: 'dsh-settings-save-actions' }, [
        createElement('button', {
          key: 'discard', type: 'button', className: 'dsh-settings-action', disabled: dirty.length === 0 || saving,
          onClick: discard,
        }, '放弃更改'),
        createElement('button', {
          key: 'save', type: 'button', className: 'dsh-settings-action is-primary',
          disabled: disabled || dirty.length === 0 || saving || conflict || needReload,
          onClick: () => { void saveAll() },
        }, saveLabel),
      ]),
    ]),
  ])
}
