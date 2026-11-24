/** Shared browser-side store for the ComfyUI environment controls. */
import { useEffect, useState } from 'react'
import {
  STUDIO_ENVIRONMENT_ROUTE,
  type StudioEnvironmentResponse,
  type StudioEnvironmentSnapshot,
} from './studio-shared.ts'

export type EnvironmentBusyAction = 'status' | 'start' | 'stop'

export interface EnvironmentClientSnapshot {
  readonly environment?: StudioEnvironmentSnapshot
  readonly busy?: EnvironmentBusyAction
  readonly error?: string
  readonly note?: string
  readonly revision: number
}

let snapshot: EnvironmentClientSnapshot = { revision: 0 }
const listeners = new Set<() => void>()

function publish(patch: Omit<Partial<EnvironmentClientSnapshot>, 'revision'>): void {
  snapshot = { ...snapshot, ...patch, revision: snapshot.revision + 1 }
  for (const listener of listeners) listener()
}

export function environmentClientSnapshot(): EnvironmentClientSnapshot {
  return snapshot
}

export function subscribeEnvironmentClient(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    // A new pane always re-reads status on mount. Dropping the last subscriber's
    // snapshot avoids stale data leaking into a later, unrelated workbench seat.
    if (listeners.size === 0) snapshot = { revision: snapshot.revision + 1 }
  }
}

/** React binding used by the workbench and the log page. */
export function useEnvironmentClient(): EnvironmentClientSnapshot {
  const [value, setValue] = useState(snapshot)
  useEffect(() => subscribeEnvironmentClient(() => setValue(snapshot)), [])
  return value
}

function lastJsonLine(text: string): StudioEnvironmentResponse | undefined {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0)
  const last = lines[lines.length - 1]
  if (last === undefined) return undefined
  try {
    const value: unknown = JSON.parse(last)
    return typeof value === 'object' && value !== null ? value as StudioEnvironmentResponse : undefined
  } catch {
    return undefined
  }
}

async function request(action: EnvironmentBusyAction): Promise<{ response?: StudioEnvironmentResponse; error?: string }> {
  try {
    const answer = await fetch(STUDIO_ENVIRONMENT_ROUTE, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    let payload: StudioEnvironmentResponse | undefined
    if (typeof (answer as unknown as { text?: () => Promise<string> }).text === 'function') {
      payload = lastJsonLine(await answer.text())
    } else if (typeof (answer as unknown as { json?: () => Promise<unknown> }).json === 'function') {
      const value = await answer.json()
      payload = typeof value === 'object' && value !== null ? value as StudioEnvironmentResponse : undefined
    }
    if (!answer.ok) return { error: payload?.error ?? `环境操作失败（HTTP ${String(answer.status)}）` }
    if (payload === undefined) return { error: '环境操作没有返回可识别的内容。' }
    if (typeof payload.error === 'string' && payload.error.length > 0) return { response: payload, error: payload.error }
    return { response: payload }
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/** Re-read the process state without starting or stopping anything. */
export async function refreshStudioEnvironment(): Promise<StudioEnvironmentResponse | undefined> {
  if (snapshot.busy === 'start' || snapshot.busy === 'stop') return undefined
  publish({ busy: 'status', error: undefined })
  const result = await request('status')
  publish({
    ...(result.response?.environment === undefined ? {} : { environment: result.response.environment }),
    ...(result.error === undefined ? {} : { error: result.error }),
    busy: undefined,
  })
  return result.response
}

/** One explicit start/stop, followed by a fresh status read even on failure. */
export async function runStudioEnvironmentAction(action: 'start' | 'stop'): Promise<void> {
  if (snapshot.busy !== undefined) return
  publish({ busy: action, error: undefined, note: undefined })
  const result = await request(action)
  const stopFailed = result.response?.stop?.stopped === false
  const actionEnvironment = result.response?.environment
  const actionNote = result.response?.stop?.note
    ?? (actionEnvironment !== undefined && actionEnvironment.state !== 'ready'
      ? actionEnvironment.note
      : undefined)
  const actionError = result.error ?? (stopFailed ? (actionNote ?? 'ComfyUI 停止失败。') : undefined)
  const refreshed = await request('status')
  const refreshedEnvironment = refreshed.response?.environment
  const mergedLogPath = refreshedEnvironment?.logPath ?? actionEnvironment?.logPath
  const mergedPid = refreshedEnvironment?.pid ?? actionEnvironment?.pid
  const environment = actionEnvironment === undefined && refreshedEnvironment === undefined
    ? undefined
    : {
        ...(actionEnvironment ?? {}),
        ...(refreshedEnvironment ?? {}),
        ...(mergedLogPath === undefined ? {} : { logPath: mergedLogPath }),
        ...(mergedPid === undefined ? {} : { pid: mergedPid }),
      } as StudioEnvironmentSnapshot
  const fullNote = actionNote === undefined
    ? undefined
    : actionEnvironment?.logPath !== undefined && !actionNote.includes(actionEnvironment.logPath)
      ? `${actionNote} 日志：${actionEnvironment.logPath}`
      : actionNote
  publish({
    ...(environment === undefined ? {} : { environment }),
    ...(actionError === undefined ? {} : { error: actionError }),
    ...(refreshed.error !== undefined && actionError === undefined ? { error: refreshed.error } : {}),
    ...(fullNote === undefined ? {} : { note: fullNote }),
    busy: undefined,
  })
}

/** Test seam: clear the module-level store between cases. */
export function resetEnvironmentClient(): void {
  snapshot = { revision: 0 }
  for (const listener of listeners) listener()
}

/** Surface a non-action environment error, such as a failed weight pass. */
export function setEnvironmentClientError(error: string | undefined): void {
  publish({ error })
}