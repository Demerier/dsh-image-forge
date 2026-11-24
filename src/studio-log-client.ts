/** Browser-side reader for the Studio's paged ComfyUI logs. */
import {
  STUDIO_LOG_DEFAULT_LIMIT,
  STUDIO_LOG_ROUTE,
  type StudioLogPage,
} from './studio-shared.ts'

/** Query accepted by the log route. */
export interface StudioLogQuery {
  readonly limit?: number
  readonly before?: number
  readonly after?: number
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const value = await response.json()
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Read one page of ComfyUI log output, with a user-facing error on failure. */
export async function readStudioLogPage(
  path: string,
  query: StudioLogQuery = {},
  signal?: AbortSignal,
): Promise<{ page?: StudioLogPage; error?: string }> {
  try {
    const params = new URLSearchParams({ path, limit: String(query.limit ?? STUDIO_LOG_DEFAULT_LIMIT) })
    if (query.before !== undefined) params.set('before', String(query.before))
    if (query.after !== undefined) params.set('after', String(query.after))
    const response = await fetch(`${STUDIO_LOG_ROUTE}?${params.toString()}`, {
      credentials: 'same-origin',
      ...(signal === undefined ? {} : { signal }),
    })
    const payload = await readJson(response)
    if (!response.ok) {
      return { error: typeof payload?.error === 'string' ? payload.error : `日志读取失败（HTTP ${String(response.status)}）` }
    }
    if (payload === undefined || payload.version !== 'studio-log/v1') return { error: '日志页返回了无法识别的数据。' }
    return { page: payload as unknown as StudioLogPage }
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') return {}
    return { error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/** The basename of a Windows or POSIX path, for a compact source label. */
export function logFileName(path: string | undefined): string | undefined {
  if (path === undefined || path.length === 0) return undefined
  const normalized = path.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  return normalized.slice(slash + 1)
}
