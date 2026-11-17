/**
 * Canvas export: the pure half of C15's two export paths.
 *
 * DD14 ships two artifacts from the workbench:
 *
 * 1. **Board JSON** — the live `BoardDetail` (v2: kind/draft/task included)
 *    serialized for download. Import is deliberately NOT implemented: restoring
 *    a board involves path remapping and id collisions, so this is an export
 *    escape hatch, not a round trip (CANVAS-DESIGN §9.6).
 * 2. **Contact sheet PNG** — every picture node as a 256 px thumbnail in a grid,
 *    with the prompt's first line under each. The grid arithmetic and the cap
 *    live here so they are unit-testable; the DOM drawing (canvas + images +
 *    `toBlob`) is the thin browser layer in `studio-view.ts`.
 *
 * Nothing in this module touches `document`, `window` or a clock.
 *
 * @module canvas-export
 */
import type { BoardDetail, BoardItem } from './studio-shared.ts'

/** Most pictures one contact sheet may contain (memory ceiling, design §9.6). */
export const CONTACT_SHEET_MAX_ITEMS = 200

/** Edge length of one thumbnail cell, in pixels (design §9.6). */
export const CONTACT_SHEET_THUMB_SIZE = 256

/** Widest a thumbnail may be drawn; the cap above already bounds the sheet. */
export const CONTACT_SHEET_MAX_THUMB_SIZE = 256

/** Gap between cells, in pixels. */
export const CONTACT_SHEET_GAP = 16

/** Height reserved under each thumbnail for the prompt line. */
export const CONTACT_SHEET_LABEL_HEIGHT = 36

/** Outer padding, in pixels. */
export const CONTACT_SHEET_PADDING = 24

/** The picture fields a contact sheet needs (a board item is a superset). */
export interface ContactSheetSource {
  readonly id: string
  /** Absolute path; only used as a `title`/fallback label. */
  readonly path: string
  /** Forward-slash path the file route serves (`studioFileUrl` input). */
  readonly markdownPath: string
  readonly width: number
  readonly height: number
  readonly prompt: string
}

/** One placed thumbnail: where the image goes and where its label baseline is. */
export interface ContactSheetSlot {
  readonly item: ContactSheetSource
  /** Index in the input list (0-based). */
  readonly index: number
  /** Cell rectangle in sheet pixels. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** Drawn image rect inside the cell (aspect-fitted, centred). */
  readonly imageX: number
  readonly imageY: number
  readonly imageWidth: number
  readonly imageHeight: number
  /** Top of the label text, in sheet pixels. */
  readonly labelY: number
}

/** The whole sheet: slots plus the canvas size the browser has to allocate. */
export interface ContactSheetPlan {
  readonly slots: ContactSheetSlot[]
  readonly width: number
  readonly height: number
  readonly cols: number
  readonly rows: number
  readonly thumbSize: number
  /** True when more than {@link CONTACT_SHEET_MAX_ITEMS} pictures were supplied. */
  readonly truncated: boolean
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * Lay out a contact sheet: `cols` columns, fixed 256 px thumbs, prompt labels.
 *
 * Row-major, so the sheet reads like a document. Each image is aspect-fitted
 * into its square cell (the drawn rect is returned; the browser only has to
 * call `drawImage`), and the cap slices the input instead of throwing: an
 * oversized export should still produce a usable sheet and say it was capped.
 *
 * @param items - picture nodes, in canvas/board order.
 * @param cols - requested column count (clamped to 1–10).
 * @param thumbSize - requested cell edge (clamped to 64–256).
 * @returns the plan; an empty input gives a zero-sized sheet.
 */
export function contactSheetLayout(
  items: readonly ContactSheetSource[],
  cols = 4,
  thumbSize = CONTACT_SHEET_THUMB_SIZE,
): ContactSheetPlan {
  const columns = clampInt(cols, 1, 10, 4)
  const cell = clampInt(thumbSize, 64, CONTACT_SHEET_MAX_THUMB_SIZE, CONTACT_SHEET_THUMB_SIZE)
  const taken = items.slice(0, CONTACT_SHEET_MAX_ITEMS)
  if (taken.length === 0) {
    return { slots: [], width: 0, height: 0, cols: columns, rows: 0, thumbSize: cell, truncated: false }
  }
  const rows = Math.ceil(taken.length / columns)
  const width = CONTACT_SHEET_PADDING * 2 + columns * cell + (columns - 1) * CONTACT_SHEET_GAP
  const height = CONTACT_SHEET_PADDING * 2 + rows * (cell + CONTACT_SHEET_LABEL_HEIGHT) + (rows - 1) * CONTACT_SHEET_GAP

  const slots: ContactSheetSlot[] = taken.map((item, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    const x = CONTACT_SHEET_PADDING + column * (cell + CONTACT_SHEET_GAP)
    const y = CONTACT_SHEET_PADDING + row * (cell + CONTACT_SHEET_LABEL_HEIGHT + CONTACT_SHEET_GAP)
    // Aspect-fit inside the square cell; invalid sizes fall back to a full cell
    // (a corrupt entry must still produce a placeholder, not NaN geometry).
    const sourceWidth = Number.isFinite(item.width) && item.width > 0 ? item.width : cell
    const sourceHeight = Number.isFinite(item.height) && item.height > 0 ? item.height : cell
    const scale = Math.min(cell / sourceWidth, cell / sourceHeight)
    const imageWidth = Math.max(1, Math.round(sourceWidth * scale))
    const imageHeight = Math.max(1, Math.round(sourceHeight * scale))
    return {
      item,
      index,
      x,
      y,
      width: cell,
      height: cell,
      imageX: x + Math.floor((cell - imageWidth) / 2),
      imageY: y + Math.floor((cell - imageHeight) / 2),
      imageWidth,
      imageHeight,
      labelY: y + cell + 8,
    }
  })

  return {
    slots,
    width,
    height,
    cols: columns,
    rows,
    thumbSize: cell,
    truncated: items.length > CONTACT_SHEET_MAX_ITEMS,
  }
}

/**
 * The first line of a prompt, for the label under a thumbnail.
 *
 * Exported separately so the browser layer and the tests agree on the exact
 * truncation rule (an empty prompt is a label-less cell, not an empty string
 * drawn at the top-left).
 */
export function contactSheetLabel(prompt: string): string {
  const line = prompt.split(/\r?\n/, 1)[0]?.trim() ?? ''
  return line.length > 0 ? line : '（无提示词）'
}

/** Picture nodes of a board, in stored order: the contact sheet's input. */
export function pictureItems(items: readonly BoardItem[]): BoardItem[] {
  return items.filter((item) => (item.kind ?? 'image') === 'image')
}

/** File name one board downloads as: `<safe name>.board.json`. */
export function boardJsonFileName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/^[-.\s]+|[-.\s]+$/g, '')
    .slice(0, 80)
  return (cleaned.length > 0 ? cleaned : 'board') + '.board.json'
}

/**
 * Serialize a board for download (pretty-printed; v2 kinds/drafts included).
 *
 * `camera` is kept: reopening the JSON in a future import should restore the
 * view as well as the arrangement. No `undefined` keys survive JSON — the store
 * shape already leans on absent-means-default (§9.2).
 */
export function serializeBoardDetail(board: BoardDetail): string {
  return JSON.stringify(board, null, 2)
}