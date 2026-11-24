/**
 * Full-page ComfyUI connection and log view for the workbench shell.
 *
 * The page is intentionally a real paged reader, not a fixed tail. Every line
 * carries its original line number, a parsed timestamp when the source emitted
 * one, and an inferred severity. Older pages load toward the top; follow mode
 * appends only lines the reader has not seen yet.
 *
 * @module workbench-log
 */
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  STUDIO_ENVIRONMENT_ROUTE,
  type StudioEnvironmentResponse,
  type StudioEnvironmentSnapshot,
  type StudioLogLine,
  type StudioLogPage,
} from './studio-shared.ts'
import { refreshStudioEnvironment, runStudioEnvironmentAction, useEnvironmentClient } from './environment-client.ts'
import { logFileName, readStudioLogPage } from './studio-log-client.ts'
/** Heading the workbench strip uses for this page. */
export const WORKBENCH_LOG_LABEL = '日志'

/** Heading inside the page. */
export const WORKBENCH_LOG_TITLE = 'ComfyUI 日志'

/** How often a followed log is re-read. */
export const WORKBENCH_LOG_REFRESH_MS = 2000

/** Keep live follow bounded; older pages remain available from disk. */
const LOG_BUFFER_MAX_LINES = 1200

/** What kind of log the current snapshot points at. */
export function logSourceLabel(environment: StudioEnvironmentSnapshot | undefined): string {
  if (environment === undefined) return '正在读取连接状态'
  if (environment.logPath === undefined) {
    return environment.state === 'ready'
      ? 'ComfyUI 在运行，但没有找到可读取的日志'
      : '当前没有可读取的日志'
  }
  const file = logFileName(environment.logPath) ?? '日志'
  return environment.owned ? `插件启动 · ${file}` : `ComfyUI Desktop · ${file}`
}

/** One line describing the connection, before the log itself is read. */
export function environmentLine(environment: StudioEnvironmentSnapshot | undefined): string {
  if (environment === undefined) return '正在读取 ComfyUI 连接状态…'
  if (environment.state === 'ready') return `ComfyUI 已连接 · ${environment.endpoint ?? '未知端点'}`
  if (environment.state === 'not-running') return 'ComfyUI 未运行'
  if (environment.state === 'not-installed') return '尚未找到可启动的 ComfyUI'
  if (environment.state === 'launch-failed') return '上次启动失败'
  return '连接检测超时'
}

/** Why the log area has no text yet. */
export function logEmptyText(
  environment: StudioEnvironmentSnapshot | undefined,
  statusError: string | undefined,
  logError: string | undefined,
): string {
  if (statusError !== undefined) return `连接状态：${statusError}`
  if (logError !== undefined) return logError
  if (environment === undefined) return '正在读取连接状态和日志…'
  if (environment.logPath === undefined) {
    return environment.state === 'ready'
      ? 'ComfyUI 正在运行，但当前没有可读取的日志文件。'
      : '当前没有可读取的 ComfyUI 日志。先启动 ComfyUI，或确认自行启动的实例留下了 logs/comfyui.log。'
  }
  return '日志文件暂时为空，或还没有新的输出。'
}

function mergeNewest(previous: readonly StudioLogLine[], page: StudioLogPage): StudioLogLine[] {
  if (previous.length === 0) return [...page.lines]
  const last = previous[previous.length - 1]?.number ?? 0
  const appended = page.lines.filter((line) => line.number > last)
  const merged = appended.length === 0 ? [...previous] : [...previous, ...appended]
  return merged.length <= LOG_BUFFER_MAX_LINES ? merged : merged.slice(-LOG_BUFFER_MAX_LINES)
}

function mergeOlder(previous: readonly StudioLogLine[], page: StudioLogPage): StudioLogLine[] {
  const first = previous[0]?.number ?? Number.POSITIVE_INFINITY
  const prepended = page.lines.filter((line) => line.number < first)
  return [...prepended, ...previous]
}

function lineClass(line: StudioLogLine): string {
  return `dsh-forge-log-line is-${line.level}`
}

/**
 * The dedicated ComfyUI log page.
 */
export function WorkbenchLogPane(): ReturnType<typeof createElement> {
  const environmentClient = useEnvironmentClient()
  const environment = environmentClient.environment
  const statusError = environmentClient.error
  const environmentNote = environmentClient.note
  const statusBusy = environmentClient.busy !== undefined
  const [page, setPage] = useState<StudioLogPage | undefined>(undefined)
  const [lines, setLines] = useState<readonly StudioLogLine[]>([])
  const [logError, setLogError] = useState<string | undefined>(undefined)
  const [logBusy, setLogBusy] = useState(false)
  const [follow, setFollow] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<string | undefined>(undefined)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const newestCursorRef = useRef(0)
  const logPath = environment?.logPath

  const refreshStatus = useCallback(async () => {
    await refreshStudioEnvironment()
  }, [])

  const startEnvironment = useCallback(async () => {
    await runStudioEnvironmentAction('start')
  }, [])

  const stopEnvironment = useCallback(async () => {
    await runStudioEnvironmentAction('stop')
  }, [])

  const loadLatest = useCallback(async (path: string) => {
    setLogBusy(true)
    const result = await readStudioLogPage(path)
    if (result.page === undefined) {
      setLogError(result.error ?? '日志读取失败')
    } else {
      setLogError(undefined)
      setPage(result.page)
      setLines(result.page.lines)
      newestCursorRef.current = result.page.toLine
      setFollow(true)
      setLastUpdated(new Date().toLocaleTimeString())
    }
    setLogBusy(false)
  }, [])

  const followLatest = useCallback(async (path: string) => {
    const after = newestCursorRef.current
    if (after <= 0) return
    const result = await readStudioLogPage(path, { after })
    if (result.page === undefined) {
      setLogError(result.error ?? '日志读取失败')
      return
    }
    setLogError(undefined)
    if (result.page.lines.length > 0) setPage(result.page)
    newestCursorRef.current = result.page.totalLines
    setLines((current) => mergeNewest(current, result.page as StudioLogPage))
    setLastUpdated(new Date().toLocaleTimeString())
  }, [])

  const loadOlder = useCallback(async () => {
    if (logPath === undefined || lines.length === 0) return
    const oldest = lines[0]?.number
    if (oldest === undefined || oldest <= 1) return
    setLogBusy(true)
    const result = await readStudioLogPage(logPath, { before: oldest })
    if (result.page === undefined) {
      setLogError(result.error ?? '更早日志读取失败')
    } else {
      setLogError(undefined)
      setFollow(false)
      const body = bodyRef.current
      const heightBefore = body?.scrollHeight ?? 0
      const scrollBefore = body?.scrollTop ?? 0
      setLines((current) => mergeOlder(current, result.page as StudioLogPage))
      setLastUpdated(new Date().toLocaleTimeString())
      // Older lines are prepended: keep the reader's current line under the
      // pointer by adding exactly the height the scroll area grew above it.
      requestAnimationFrame(() => {
        if (body !== null) body.scrollTop = scrollBefore + (body.scrollHeight - heightBefore)
      })
    }
    setLogBusy(false)
  }, [lines, logPath])

  useEffect(() => {
    void refreshStatus()
    if (logPath === undefined) return
    void loadLatest(logPath)
  }, [logPath, loadLatest, refreshStatus])

  useEffect(() => {
    if (!follow || logPath === undefined || page === undefined) return undefined
    const timer = setInterval(() => { void followLatest(logPath) }, WORKBENCH_LOG_REFRESH_MS)
    return () => { clearInterval(timer) }
  }, [follow, followLatest, logPath, page])

  useEffect(() => {
    if (!follow) return
    const body = bodyRef.current
    if (body !== null) body.scrollTop = body.scrollHeight
  }, [follow, lines])

  const copyLog = useCallback(async () => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (clipboard === undefined || lines.length === 0) return
    try { await clipboard.writeText(lines.map((line) => line.text).join('\n')) } catch { /* Clipboard denial is not fatal. */ }
  }, [lines])

  const timestampHint = useMemo(() => {
    if (lines.length === 0) return ''
    const stamped = lines.filter((line) => line.timestamp !== undefined).length
    if (stamped === 0) return '当前缓冲区没有行内时间戳；按行号判断先后。'
    if (stamped < lines.length) return `当前缓冲 ${String(stamped)}/${String(lines.length)} 行带时间戳，其余按行号排序。`
    return '时间戳来自日志行本身。'
  }, [lines])

  const olderDisabled = logBusy || lines.length === 0 || (lines[0]?.number ?? 1) <= 1

  return createElement(
    'section',
    { className: 'dsh-forge-workbench-log', 'data-log-state': environment?.state ?? 'unknown' },
    createElement(
      'div',
      { className: 'dsh-forge-workbench-log-head' },
      createElement(
        'div',
        { className: 'dsh-forge-workbench-log-title-wrap' },
        createElement('h2', { className: 'dsh-forge-workbench-log-title' }, WORKBENCH_LOG_TITLE),
        createElement('span', { className: 'dsh-forge-workbench-log-subtitle' }, '按行号、时间与来源读取，可翻页查看更早输出'),
      ),
      createElement(
        'div',
        { className: 'dsh-forge-workbench-log-actions' },
        environment?.state === 'ready'
          ? null
          : createElement('button', { type: 'button', className: 'dsh-forge-workbench-action is-primary', disabled: statusBusy, onClick: () => { void startEnvironment() } }, statusBusy ? '启动中…' : '启动 ComfyUI'),
        createElement('button', { type: 'button', className: 'dsh-forge-workbench-action', disabled: statusBusy, onClick: () => { void refreshStatus() } }, environmentClient.busy === 'status' ? '检测中…' : '重新检测'),
        createElement('button', { type: 'button', className: 'dsh-forge-workbench-action', disabled: logBusy || logPath === undefined, onClick: () => { if (logPath !== undefined) void loadLatest(logPath) } }, logBusy ? '读取中…' : '刷新最新'),
        createElement('button', { type: 'button', className: follow ? 'dsh-forge-workbench-action is-active' : 'dsh-forge-workbench-action', 'aria-pressed': follow, onClick: () => { setFollow((value) => !value) } }, follow ? '跟随中' : '已暂停'),
        createElement('button', { type: 'button', className: 'dsh-forge-workbench-action', disabled: olderDisabled, onClick: () => { void loadOlder() } }, '加载更早'),
        createElement('button', { type: 'button', className: 'dsh-forge-workbench-action', disabled: lines.length === 0, onClick: () => { void copyLog() } }, '复制'),
      ),
    ),
    createElement(
      'div',
      { className: 'dsh-forge-workbench-log-status' },
      createElement('span', { className: environment?.state === 'ready' ? 'dsh-forge-dot is-ok' : 'dsh-forge-dot is-bad' }),
      createElement('span', {}, environmentLine(environment)),
      environment?.logPath === undefined ? null : createElement('code', { className: 'dsh-forge-workbench-log-path', title: environment.logPath }, environment.logPath),
    ),
    statusError !== undefined && environment !== undefined
      ? createElement('div', { className: 'dsh-forge-workbench-log-error' }, `连接状态：${statusError}`)
      : null,
    logError !== undefined && lines.length > 0
      ? createElement('div', { className: 'dsh-forge-workbench-log-error' }, `日志刷新失败：${logError}`)
      : null,
    createElement(
      'div',
      { className: 'dsh-forge-workbench-log-meta' },
      createElement('span', {}, `来源：${logSourceLabel(environment)}`),
      page === undefined ? null : createElement('span', {}, `共 ${String(page.totalLines)} 行 ·${lines.length === 0 ? ' 当前 0 行' : ` 已载入 ${String(lines[0]?.number)}–${String(lines[lines.length - 1]?.number)}`}`),
      page?.modifiedAt === undefined ? null : createElement('span', {}, `文件修改：${new Date(page.modifiedAt).toLocaleString()}`),
      lastUpdated === undefined ? null : createElement('span', {}, `最后刷新：${lastUpdated}`),
    ),
    createElement(
      'div',
      { ref: bodyRef, className: lines.length === 0 ? 'dsh-forge-workbench-log-output is-empty' : 'dsh-forge-workbench-log-output', 'aria-label': 'ComfyUI 日志内容' },
      lines.length === 0
        ? createElement('div', { className: 'dsh-forge-workbench-log-empty' },
            createElement('span', { className: 'dsh-forge-workbench-log-empty-mark', 'aria-hidden': 'true' }, 'LOG'),
            createElement('span', { className: 'dsh-forge-workbench-log-empty-copy' }, logEmptyText(environment, statusError, logError)),
            createElement('div', { className: 'dsh-forge-workbench-log-empty-actions' },
              environment?.state === 'ready'
                ? null
                : createElement('button', { type: 'button', className: 'dsh-forge-workbench-action is-primary', disabled: statusBusy, onClick: () => { void startEnvironment() } }, statusBusy ? '启动中…' : '启动 ComfyUI'),
              createElement('button', { type: 'button', className: 'dsh-forge-workbench-action', disabled: statusBusy, onClick: () => { void refreshStatus() } }, environmentClient.busy === 'status' ? '检测中…' : '重新检测'),
              createElement('button', { type: 'button', className: 'dsh-forge-workbench-action', disabled: logBusy || logPath === undefined, onClick: () => { if (logPath !== undefined) void loadLatest(logPath) } }, logBusy ? '读取中…' : '刷新日志'),
            ),
          )
        : lines.map((line) => createElement(
            'div',
            { key: line.number, className: lineClass(line), 'data-line-number': line.number },
            createElement('span', { className: 'dsh-forge-log-line-no' }, String(line.number)),
            createElement('span', { className: 'dsh-forge-log-line-time', title: line.timestamp === undefined ? '原始日志此行没有时间戳' : line.timestamp }, line.timestamp ?? '—'),
            createElement('span', { className: 'dsh-forge-log-line-text' }, line.text.length === 0 ? ' ' : line.text),
          )),
    ),
    createElement(
      'div',
      { className: 'dsh-forge-workbench-log-foot' },
      `${timestampHint} 页面每 ${String(WORKBENCH_LOG_REFRESH_MS / 1000)} 秒追一次最新；日志原文不会被修改。`,
    ),
  )
}
