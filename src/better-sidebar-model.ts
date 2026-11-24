/** Structural Better Sidebar integration shared by UI and Node tests. */
import type { BoardDetail, BoardItem } from './studio-shared.ts'

/** Registered Better Sidebar tab type. */
export const IMAGE_EDITOR_TAB_TYPE = 'dsh-image-forge:image-editor'

/** Human-facing title of that tab. */
export const IMAGE_EDITOR_TAB_TITLE = '画面编辑'

/** Serializable state the result card puts on a Better Sidebar tab. */
export interface ImageEditorTabMeta {
  readonly boardId?: string
  readonly itemId?: string
  readonly imagePath: string
  readonly title: string
  readonly layoutId?: string
  /** Original dimensions when the tool result knew them. */
  readonly width?: number
  readonly height?: number
  /** Optional host theme for the embedded MOSS canvas. */
  readonly theme?: 'auto' | 'light' | 'dark'
}

/** Minimal service surface; no hard import on the Better Sidebar package. */
export interface BetterSidebarServiceLike {
  registerTab(descriptor: BetterSidebarTabLike): () => void
  openTab(seed: {
    readonly type: string
    readonly id?: string
    readonly title?: string
    readonly meta?: unknown
    readonly target?: 'right' | 'side' | 'bottom'
    readonly reveal?: boolean
  }, scope?: unknown): void
}

/** Structural tab descriptor: only the fields this plugin sets. */
export interface BetterSidebarTabLike {
  readonly id: string
  readonly title: string | (() => string)
  readonly description?: string | (() => string)
  readonly icon?: unknown
  readonly order?: number
  readonly single?: boolean
  readonly dedupeKey?: (tab: { readonly meta?: unknown }) => string | undefined
  readonly component: (props: unknown) => unknown
}

/** One sanitized stable id for a board item tab. */
export function imageEditorTabInstanceId(meta: ImageEditorTabMeta): string {
  const identity = meta.boardId === undefined || meta.boardId.length === 0
    ? meta.imagePath
    : `${meta.boardId}:${meta.itemId ?? meta.imagePath}`
  return `${IMAGE_EDITOR_TAB_TYPE}:${identity.replace(/[^A-Za-z0-9_-]+/g, '-').slice(-96)}`
}

/** One stable dedupe key for the item a tab points at. */
export function imageEditorDedupeKey(meta: ImageEditorTabMeta): string {
  if (meta.boardId !== undefined && meta.itemId !== undefined) return `${meta.boardId}:${meta.itemId}`
  return meta.imagePath
}

/** Read a tab's meta defensively; the host persists JSON, not class instances. */
export function readImageEditorTabMeta(value: unknown): ImageEditorTabMeta | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  if (typeof row['imagePath'] !== 'string' || row['imagePath'].length === 0) return undefined
  const result: ImageEditorTabMeta = {
    imagePath: row['imagePath'],
    title: typeof row['title'] === 'string' && row['title'].length > 0 ? row['title'] : '未命名画面',
    ...(typeof row['boardId'] === 'string' && row['boardId'].length > 0 ? { boardId: row['boardId'] } : {}),
    ...(typeof row['itemId'] === 'string' && row['itemId'].length > 0 ? { itemId: row['itemId'] } : {}),
    ...(typeof row['layoutId'] === 'string' && row['layoutId'].length > 0 ? { layoutId: row['layoutId'] } : {}),
    ...(typeof row['width'] === 'number' && Number.isFinite(row['width']) && row['width'] > 0 ? { width: row['width'] } : {}),
    ...(typeof row['height'] === 'number' && Number.isFinite(row['height']) && row['height'] > 0 ? { height: row['height'] } : {}),
    ...(row['theme'] === 'auto' || row['theme'] === 'light' || row['theme'] === 'dark' ? { theme: row['theme'] as 'auto' | 'light' | 'dark' } : {}),
  }
  return result
}

/** Find the layout ancestor that a generated image must reuse. */
export function layoutAncestorOf(board: BoardDetail, itemId: string | undefined): BoardItem | undefined {
  if (itemId === undefined) return undefined
  const item = board.items.find((entry) => entry.id === itemId)
  if (item === undefined) return undefined
  for (const parentId of item.parents) {
    const parent = board.items.find((entry) => entry.id === parentId)
    if (parent !== undefined && (parent.kind ?? 'image') === 'layout') return parent
  }
  return undefined
}

/** Whether the main composer can receive an image draft on this host. */
export function conversationImageHandoffCapability(conversation: unknown): { readonly available: boolean; readonly reason?: string } {
  if (typeof conversation !== 'object' || conversation === null) {
    return { available: false, reason: '当前宿主没有提供 conversation 服务。' }
  }
  const row = conversation as Record<string, unknown>
  if (typeof row['createDrafts'] !== 'function') {
    return { available: false, reason: '当前 DSH 主会话不支持从插件加入图片草稿。' }
  }
  const input = row['input']
  if (typeof input !== 'object' || input === null || typeof (input as Record<string, unknown>)['for'] !== 'function') {
    return { available: false, reason: '当前 DSH 主会话没有可写入的输入机。' }
  }
  return { available: true }
}