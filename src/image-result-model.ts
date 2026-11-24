/** Pure readers for the qwen_image_generate/edit tool result card. */

/** One image entry in the structured tool payload. */
export interface ResultImageEntry {
  readonly index: number
  readonly path: string
  readonly bytes?: number
  readonly mime?: string
  readonly width?: number
  readonly height?: number
}

/** Card facts extracted from the payload without trusting any one field. */
export interface ImageResultFacts {
  readonly images: readonly ResultImageEntry[]
  readonly itemIds: readonly string[]
  readonly boardId?: string
  readonly boardName?: string
  readonly ratio?: string
  readonly size?: { readonly width: number; readonly height: number }
  readonly steps?: number
  readonly seed?: number
  readonly model?: string
  readonly prompt?: string
  readonly count: number
}

/** Tolerant object read. */
export function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** Read the JSON object a tool-result block carries in its text parts. */
export function toolPayloadFrom(
  content: readonly { readonly text?: string }[] | undefined,
  fallback?: unknown,
): Record<string, unknown> | undefined {
  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item.text !== 'string' || item.text.length === 0) continue
      try {
        const parsed: unknown = JSON.parse(item.text)
        const row = recordOf(parsed)
        if (row !== undefined) return row
      } catch {
        // The block may also carry the short summary; keep looking.
      }
    }
  }
  return recordOf(fallback)
}

/** A stable, ordered image list from a tool payload. */
export function resultImages(payload: Record<string, unknown> | undefined): ResultImageEntry[] {
  const raw = payload?.['images']
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry, position) => {
    const row = recordOf(entry)
    const path = row?.['path']
    if (typeof path !== 'string' || path.length === 0) return []
    return [{
      index: typeof row?.['index'] === 'number' && Number.isFinite(row['index']) ? row['index'] : position + 1,
      path,
      ...(typeof row['bytes'] === 'number' && Number.isFinite(row['bytes']) ? { bytes: row['bytes'] } : {}),
      ...(typeof row['mime'] === 'string' ? { mime: row['mime'] } : {}),
      ...(typeof row['width'] === 'number' && Number.isFinite(row['width']) ? { width: row['width'] } : {}),
      ...(typeof row['height'] === 'number' && Number.isFinite(row['height']) ? { height: row['height'] } : {}),
    }]
  })
}

/** The board item id for one image position; no id is invented when absent. */
export function boardItemIdForImage(payload: Record<string, unknown> | undefined, imageIndex: number): string | undefined {
  const board = recordOf(payload?.['board'])
  const ids = board?.['item_ids']
  if (!Array.isArray(ids)) return undefined
  const value = ids[imageIndex]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Read the card's metadata. */
export function imageResultFacts(payload: Record<string, unknown> | undefined): ImageResultFacts {
  const images = resultImages(payload)
  const board = recordOf(payload?.['board'])
  const size = recordOf(payload?.['size'])
  const width = typeof size?.['width'] === 'number' ? size['width'] as number : undefined
  const height = typeof size?.['height'] === 'number' ? size['height'] as number : undefined
  const ids = board?.['item_ids']
  return {
    images,
    count: images.length,
    itemIds: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : [],
    ...(typeof board?.['id'] === 'string' && board['id'].length > 0 ? { boardId: board['id'] } : {}),
    ...(typeof board?.['name'] === 'string' && board['name'].length > 0 ? { boardName: board['name'] } : {}),
    ...(typeof payload?.['wh_ratio'] === 'string' && payload['wh_ratio'].length > 0 ? { ratio: payload['wh_ratio'] } : {}),
    ...(width !== undefined && height !== undefined ? { size: { width, height } } : {}),
    ...(typeof payload?.['steps_used'] === 'number' ? { steps: payload['steps_used'] } : {}),
    ...(typeof payload?.['seed'] === 'number' ? { seed: payload['seed'] } : {}),
    ...(typeof payload?.['model'] === 'string' && payload['model'].length > 0 ? { model: payload['model'] } : {}),
    ...(typeof payload?.['prompt'] === 'string' && payload['prompt'].length > 0 ? { prompt: payload['prompt'] } : {}),
  }
}

/** A short title from a prompt's first line, or a stable fallback. */
export function imageResultTitle(prompt: string | undefined, fallback: string): string {
  const first = (prompt ?? '').split(/\r?\n/, 1)[0]?.trim() ?? ''
  return first.length > 0 ? first : fallback
}

/** Bytes as a short label. */
export function imageBytesLabel(bytes: number | undefined): string | undefined {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return undefined
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}