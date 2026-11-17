/**
 * MOSS-Image layout editor: draw boxes, keep captions, export both formats.
 *
 * ## Why this module exists
 *
 * MOSS-Image takes layout as **structured text inside the prompt**: a draft in
 * abs/xyxy canvas pixels is compiled into a compact abs_centralized/yxyx JSON
 * string, and that string is the text condition. The format is not ours; it is
 * the public contract shipped with the model, and the authority is the reference
 * compiler plus the pairs kept under verify/:
 *
 * - verify/fantasy_dawn_layout_*_draft.json   ->  verify/fantasy_dawn_layout_*.json
 * - verify/chained_titan*_draft.json          ->  verify/chained_titan*_layout.json
 * - verify/layout_prompt.json (compiled-only, with literal-text items)
 *
 * The conversion rules below are a direct port of the reference compiler
 * (refs/MOSS-Image/skills/moss-image-prompt-enhancer/scripts/compile_prompt.py,
 * function centered_box): round each edge to 9 decimals, **floor** left/top,
 * **ceil** right/bottom, then subtract width/2 and height/2, emitting
 * [y1, x1, y2, x2]. A draft whose canvas is not the generation size drifts
 * globally, so width and height are positive multiples of 16 and are omitted
 * from the compiled prompt.
 *
 * ## Caption wording pollutes the whole image
 *
 * The model has one text-conditioning pathway for description *and* layout, so an
 * item caption is not local: its visual vocabulary spreads as a global texture.
 * Field notes pinned this down twice (a distant island whose caption asked for
 * intricate architectural detail came out as a forest of thin pillars that leaked
 * outside its box). CAPTION_HINT carries that rule into the UI.
 *
 * ## Shape of the module
 *
 * Everything except mountLayoutEditor is a pure function over plain data, so
 * test/layout-editor.test.mjs can import this file under Node's type stripping
 * with no DOM and no browser globals. The mount function is the only place that
 * touches document, and only when called. It takes a container element (the
 * Studio panel will own the container) and returns a small handle.
 */

/** Draft bbox coordinate space, as required by the reference compiler. */
export const LAYOUT_DRAFT_BBOX_COORD_SPACE = 'abs' as const

/** Draft bbox ordering, as required by the reference compiler. */
export const LAYOUT_DRAFT_BBOX_FORMAT = 'xyxy' as const

/** Compiled bbox coordinate space: origin at canvas center, pixels, x right / y down. */
export const LAYOUT_COMPILED_BBOX_COORD_SPACE = 'abs_centralized' as const

/** Compiled bbox ordering: [y1, x1, y2, x2] - y first, then x. */
export const LAYOUT_COMPILED_BBOX_FORMAT = 'yxyx' as const

/** Canvas sides must be positive integer multiples of this (the model patch size). */
export const LAYOUT_CANVAS_MULTIPLE = 16

/** Smallest box edge the editor keeps; zero-area boxes cannot be compiled. */
export const LAYOUT_MIN_BOX_SIZE = 1

/** Item labels the contract accepts. */
export const LAYOUT_ITEM_LABELS = ['object', 'character', 'text'] as const

/** summary.canvas values the contract accepts. */
export const LAYOUT_CANVAS_VALUES = ['single', 'multi_panel', 'collage'] as const

/** Default draft canvas used when the caller does not supply generation size. */
export const DEFAULT_LAYOUT_WIDTH = 1536
export const DEFAULT_LAYOUT_HEIGHT = 1024

/** Root class of the mounted editor; the host stylesheet can hang rules off it. */
export const LAYOUT_EDITOR_CLASS = 'dsh-image-forge-layout-editor'

// ---- Layout *node* geometry (C13, §8.1/§8.3) -------------------------------
//
// A layout node on the infinite canvas is the editor plus chrome: the declared
// display width and a height that follows the draft's aspect ratio, exactly as
// §8.3 asks ("resize only changes the width; the height follows the proportion").
// The draft's own pixels never move when the node is resized (§8.2's
// invariant), which is why these helpers read the draft and never write it.

/** Display width a new layout node starts with, in world units (§8.1). */
export const LAYOUT_NODE_DEFAULT_WIDTH = 480

/** Narrowest a layout node may be resized to (§8.3). */
export const LAYOUT_NODE_MIN_WIDTH = 320

/** Widest a layout node may be resized to (§8.3). */
export const LAYOUT_NODE_MAX_WIDTH = 960

/**
 * Title bar + status footnote + editor paddings around the draft canvas, in
 * world units. Chosen so the default 1536×1024 draft reproduces §8.1's 480×420
 * node exactly: 480 × 1024/1536 = 320, plus 100.
 */
export const LAYOUT_NODE_CHROME = 100

/** Default display height of a layout node, in world units (480×420). */
export const LAYOUT_NODE_DEFAULT_HEIGHT = LAYOUT_NODE_CHROME +
  Math.round((LAYOUT_NODE_DEFAULT_WIDTH * DEFAULT_LAYOUT_HEIGHT) / DEFAULT_LAYOUT_WIDTH)

/** Clamp a requested display width into the §8.3 band; invalid means default. */
export function clampLayoutNodeWidth(width: number): number {
  if (!Number.isFinite(width)) return LAYOUT_NODE_DEFAULT_WIDTH
  return Math.min(LAYOUT_NODE_MAX_WIDTH, Math.max(LAYOUT_NODE_MIN_WIDTH, Math.round(width)))
}

/**
 * Display height for a width and a draft: chrome plus the draft scaled to that
 * width, which is what makes a resize **only** a display change.
 */
export function layoutNodeHeight(
  width: number,
  draft: { readonly width: number; readonly height: number },
): number {
  const displayWidth = clampLayoutNodeWidth(width)
  const draftWidth = draft.width
  const draftHeight = draft.height
  if (!Number.isFinite(draftWidth) || draftWidth <= 0 || !Number.isFinite(draftHeight) || draftHeight <= 0) {
    return LAYOUT_NODE_DEFAULT_HEIGHT
  }
  return LAYOUT_NODE_CHROME + Math.round((displayWidth * draftHeight) / draftWidth)
}

/**
 * The caption rule the editor shows next to the caption field.
 *
 * It is a constant (and asserted by the test suite) because this is the one piece
 * of field knowledge that is easy to lose: captions read like local notes, but the
 * model treats them as global visual vocabulary.
 */
export const CAPTION_HINT =
  'caption 措辞会污染生成语义：item caption 里的视觉语汇（例如 slender spires / intricate architectural detail）会被模型当成全局高频纹理，扩散到 bbox 之外；远景小框宁可写纯自然大块面，不要要求复杂建筑。需要压住某类内容时，把同一句否定语同时写进 summary.caption 与相关 item caption，不要只写一次。'

/** One of the three item labels. */
export type LayoutItemLabel = (typeof LAYOUT_ITEM_LABELS)[number]

/** One of the accepted summary.canvas values. */
export type LayoutCanvasValue = (typeof LAYOUT_CANVAS_VALUES)[number]

/** Axis-aligned box in draft canvas pixels: left/top/right/bottom, origin top-left. */
export interface LayoutBox {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** A bbox tuple in draft order: [x1, y1, x2, y2]. */
export type LayoutBbox = readonly [number, number, number, number]

/** A bbox tuple in compiled order: [y1, x1, y2, x2], centered origin. */
export type LayoutCenteredBbox = readonly [number, number, number, number]

/** The shared summary object of both formats (the compiler copies it verbatim). */
export interface LayoutSummary {
  caption: string
  meta?: string[]
  canvas?: LayoutCanvasValue
  palette?: string[]
}

/** One item of an editable draft. */
export interface LayoutDraftItem {
  label: LayoutItemLabel
  caption: string
  bbox: LayoutBbox
  text?: string
  tags?: string[]
  palette?: string[]
}

/** The draft format: what the editor owns and what can be edited again later. */
export interface LayoutDraft {
  width: number
  height: number
  bbox_coord_space: 'abs'
  bbox_format: 'xyxy'
  summary: LayoutSummary
  items: LayoutDraftItem[]
}

/** One item of the compiled prompt (same fields, converted bbox). */
export interface CompiledLayoutItem {
  label: LayoutItemLabel
  caption: string
  bbox: LayoutCenteredBbox
  text?: string
  tags?: string[]
  palette?: string[]
}

/** The compiled prompt shape: JSON-stringified, pasted as the model text condition. */
export interface CompiledLayout {
  summary: LayoutSummary
  items: CompiledLayoutItem[]
  bbox_coord_space: 'abs_centralized'
  bbox_format: 'yxyx'
}

/** A box on the editor canvas, with the editor-only identity the draft omits. */
export interface LayoutEditorItem {
  /** Editor identity; never serialized (the contract forbids unknown fields). */
  id: string
  label: LayoutItemLabel
  caption: string
  bbox: LayoutBox
  text?: string
  tags?: string[]
  palette?: string[]
}

/** Complete editor state: canvas, summary, boxes, selection and id sequence. */
export interface LayoutEditorState {
  width: number
  height: number
  summary: LayoutSummary
  items: LayoutEditorItem[]
  selectedId: string | null
  seq: number
}

/** Which edge or corner a resize gesture holds. */
export type LayoutResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

/** All resize handles, corners first so the UI can render them in order. */
export const LAYOUT_RESIZE_HANDLES = ['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w'] as const

/** A pointer position in display (CSS) pixels relative to the canvas top-left. */
export interface LayoutPoint {
  x: number
  y: number
}

/**
 * How a draft canvas maps onto the space it is displayed in.
 *
 * The editor keeps box coordinates in **layout pixels** and never in CSS pixels;
 * these functions are the only bridge, so a zoomed or narrow panel still produces
 * a draft in the generation canvas' own units.
 */
export interface LayoutViewport {
  /** Displayed width of the canvas element, in CSS pixels. */
  displayWidth: number
  /** Displayed height of the canvas element, in CSS pixels. */
  displayHeight: number
  /** Draft canvas width, in layout pixels. */
  canvasWidth: number
  /** Draft canvas height, in layout pixels. */
  canvasHeight: number
}

/** Validation problems. Empty means the value is a valid value of that format. */
export class LayoutEditorError extends Error {
  /** Every problem found, in the order the validator reported them. */
  issues: string[]

  constructor(issues: string[]) {
    super(issues.length === 1 ? issues[0] : issues.join('; '))
    this.name = 'LayoutEditorError'
    this.issues = issues
  }
}

const DRAFT_ROOT_KEYS = ['width', 'height', 'bbox_coord_space', 'bbox_format', 'summary', 'items']
const COMPILED_ROOT_KEYS = ['summary', 'items', 'bbox_coord_space', 'bbox_format']
const SUMMARY_KEYS = ['caption', 'meta', 'canvas', 'palette']
const ITEM_KEYS = ['label', 'caption', 'bbox', 'text', 'tags', 'palette']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function quotedList(names: string[]): string {
  return '[' + names.slice().sort().join(', ') + ']'
}

function unknownKeys(value: Record<string, unknown>, allowed: string[], location: string): string[] {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  return unexpected.length > 0 ? [location + ': unknown fields ' + quotedList(unexpected)] : []
}

function missingKeys(value: Record<string, unknown>, required: string[], location: string): string[] {
  const absent = required.filter((key) => !(key in value))
  return absent.length > 0 ? [location + ': missing fields ' + quotedList(absent)] : []
}

function validateCanvasSide(size: unknown, name: string): string[] {
  if (!isFiniteNumber(size) || !Number.isInteger(size) || size <= 0) {
    return [name + ' must be a positive integer']
  }
  if (size % LAYOUT_CANVAS_MULTIPLE !== 0) {
    return [name + ' must be a positive integer multiple of ' + String(LAYOUT_CANVAS_MULTIPLE)]
  }
  return []
}

function assertCanvas(width: number, height: number): void {
  const issues = [...validateCanvasSide(width, 'width'), ...validateCanvasSide(height, 'height')]
  if (issues.length > 0) throw new LayoutEditorError(issues)
}

function validateText(value: unknown, location: string): string[] {
  if (typeof value !== 'string' || value.trim() === '') {
    return [location + ' must be nonempty text']
  }
  return []
}

function validateStringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) return [location + ' must be an array']
  const issues: string[] = []
  value.forEach((entry, index) => {
    issues.push(...validateText(entry, location + '[' + String(index) + ']'))
  })
  return issues
}

function validateSummary(value: unknown): string[] {
  if (!isRecord(value)) return ['summary must be an object']
  const issues = [
    ...unknownKeys(value, SUMMARY_KEYS, 'summary'),
    ...missingKeys(value, ['caption'], 'summary'),
    ...validateText(value.caption, 'summary.caption'),
  ]
  if ('canvas' in value && !LAYOUT_CANVAS_VALUES.includes(value.canvas as LayoutCanvasValue)) {
    issues.push('summary.canvas must be single, multi_panel or collage')
  }
  for (const key of ['meta', 'palette']) {
    if (key in value) issues.push(...validateStringArray(value[key], 'summary.' + key))
  }
  return issues
}

function readBoxTuple(value: unknown): LayoutBox | null {
  if (!Array.isArray(value) || value.length !== 4) return null
  if (!value.every((entry) => isFiniteNumber(entry))) return null
  return { x1: value[0] as number, y1: value[1] as number, x2: value[2] as number, y2: value[3] as number }
}

function readCenteredTuple(value: unknown): LayoutCenteredBbox | null {
  if (!Array.isArray(value) || value.length !== 4) return null
  if (!value.every((entry) => isFiniteNumber(entry))) return null
  return [value[0] as number, value[1] as number, value[2] as number, value[3] as number]
}

function validateItemHead(item: Record<string, unknown>, location: string): string[] {
  const issues = [
    ...unknownKeys(item, ITEM_KEYS, location),
    ...missingKeys(item, ['label', 'caption', 'bbox'], location),
  ]
  if ('label' in item && !LAYOUT_ITEM_LABELS.includes(item.label as LayoutItemLabel)) {
    issues.push(location + '.label must be object, character or text')
  }
  if ('caption' in item) issues.push(...validateText(item.caption, location + '.caption'))
  if ('text' in item) issues.push(...validateText(item.text, location + '.text'))
  else if (item.label === 'text') issues.push(location + ': text items require literal text')
  for (const key of ['tags', 'palette']) {
    if (key in item) issues.push(...validateStringArray(item[key], location + '.' + key))
  }
  return issues
}

/** Round to a number of decimals the way the reference compiler does before enclosing. */
function roundTo(value: number, digits: number): number {
  const scale = Math.pow(10, digits)
  return Math.round(value * scale) / scale
}

/**
 * Draft bbox -> compiled bbox.
 *
 * Port of the reference compiler's centered_box: fractional edges are enclosed
 * (floor left/top, ceil right/bottom) so the model never receives a box whose
 * visible content sits half a pixel outside it.
 */
export function toCompiledBox(box: LayoutBox, width: number, height: number): LayoutCenteredBbox {
  assertCanvas(width, height)
  const edges = [box.x1, box.y1, box.x2, box.y2]
  if (!edges.every((edge) => isFiniteNumber(edge))) {
    throw new LayoutEditorError(['bbox must contain four finite numbers'])
  }
  const halfWidth = Math.floor(width / 2)
  const halfHeight = Math.floor(height / 2)
  return [
    Math.floor(roundTo(box.y1, 9)) - halfHeight,
    Math.floor(roundTo(box.x1, 9)) - halfWidth,
    Math.ceil(roundTo(box.y2, 9)) - halfHeight,
    Math.ceil(roundTo(box.x2, 9)) - halfWidth,
  ]
}

/** Compiled bbox -> draft bbox. Exact inverse of toCompiledBox for integer edges. */
export function fromCompiledBox(bbox: LayoutCenteredBbox, width: number, height: number): LayoutBox {
  assertCanvas(width, height)
  const values = [bbox[0], bbox[1], bbox[2], bbox[3]]
  if (!values.every((entry) => isFiniteNumber(entry))) {
    throw new LayoutEditorError(['compiled bbox must contain four finite numbers'])
  }
  const halfWidth = Math.floor(width / 2)
  const halfHeight = Math.floor(height / 2)
  return {
    x1: bbox[1] + halfWidth,
    y1: bbox[0] + halfHeight,
    x2: bbox[3] + halfWidth,
    y2: bbox[2] + halfHeight,
  }
}

function parseJsonValue(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new LayoutEditorError([
      label + ' is not valid JSON: ' + (error instanceof Error ? error.message : String(error)),
    ])
  }
}

/**
 * Every problem that would stop a draft from compiling, in human-readable form.
 *
 * Mirrors the reference compiler field by field: unknown fields are rejected
 * rather than dropped (silently discarding creative intent is worse than a
 * validation message), text items require their literal text, and boxes must sit
 * inside the declared canvas.
 */
export function validateLayoutDraft(value: unknown): string[] {
  if (!isRecord(value)) return ['Layout draft must be a JSON object']
  const issues = [
    ...unknownKeys(value, DRAFT_ROOT_KEYS, 'Layout draft'),
    ...missingKeys(value, DRAFT_ROOT_KEYS, 'Layout draft'),
  ]
  if ('width' in value) issues.push(...validateCanvasSide(value.width, 'width'))
  if ('height' in value) issues.push(...validateCanvasSide(value.height, 'height'))
  if ('bbox_coord_space' in value && value.bbox_coord_space !== LAYOUT_DRAFT_BBOX_COORD_SPACE) {
    issues.push('Draft bbox_coord_space must be ' + LAYOUT_DRAFT_BBOX_COORD_SPACE)
  }
  if ('bbox_format' in value && value.bbox_format !== LAYOUT_DRAFT_BBOX_FORMAT) {
    issues.push('Draft bbox_format must be ' + LAYOUT_DRAFT_BBOX_FORMAT)
  }
  if ('summary' in value) issues.push(...validateSummary(value.summary))
  if (!('items' in value)) return issues
  if (!Array.isArray(value.items) || value.items.length === 0) {
    issues.push('items must be a nonempty flat array')
    return issues
  }
  const width = value.width as number
  const height = value.height as number
  const canvasKnown =
    isFiniteNumber(width) &&
    isFiniteNumber(height) &&
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width % LAYOUT_CANVAS_MULTIPLE === 0 &&
    height % LAYOUT_CANVAS_MULTIPLE === 0 &&
    width > 0 &&
    height > 0
  value.items.forEach((item, index) => {
    const location = 'items[' + String(index) + ']'
    if (!isRecord(item)) {
      issues.push(location + ' must be an object')
      return
    }
    issues.push(...validateItemHead(item, location))
    const box = readBoxTuple(item.bbox)
    if (box === null) {
      issues.push(location + '.bbox must be [x1,y1,x2,y2] with four finite numbers')
      return
    }
    if (!(box.x1 < box.x2)) issues.push(location + '.bbox must have positive width')
    if (!(box.y1 < box.y2)) issues.push(location + '.bbox must have positive height')
    if (!(box.x1 >= 0 && box.y1 >= 0)) issues.push(location + '.bbox must start inside the canvas')
    const inside =
      box.x1 < box.x2 &&
      box.y1 < box.y2 &&
      box.x1 >= 0 &&
      box.y1 >= 0 &&
      box.x2 <= width &&
      box.y2 <= height
    if (canvasKnown && !inside) {
      issues.push(location + '.bbox exceeds the ' + String(width) + 'x' + String(height) + ' canvas')
    }
    if (canvasKnown && inside) {
      const enclosed = toCompiledBox(box, width, height)
      if (!(enclosed[1] < enclosed[3] && enclosed[0] < enclosed[2])) {
        issues.push(location + ' is too small at export precision')
      }
    }
  })
  return issues
}

/**
 * Every problem that stops a compiled layout from being read back into a draft.
 *
 * This is the format the model receives, so it is validated on its own terms:
 * it must not carry width/height (they are inferred from the generation size) and
 * its boxes are [y1, x1, y2, x2] with the same positive-span rule.
 */
export function validateCompiledLayout(value: unknown): string[] {
  if (!isRecord(value)) return ['Compiled layout must be a JSON object']
  const issues = [
    ...unknownKeys(value, COMPILED_ROOT_KEYS, 'Compiled layout'),
    ...missingKeys(value, COMPILED_ROOT_KEYS, 'Compiled layout'),
  ]
  if ('bbox_coord_space' in value && value.bbox_coord_space !== LAYOUT_COMPILED_BBOX_COORD_SPACE) {
    issues.push('Compiled bbox_coord_space must be ' + LAYOUT_COMPILED_BBOX_COORD_SPACE)
  }
  if ('bbox_format' in value && value.bbox_format !== LAYOUT_COMPILED_BBOX_FORMAT) {
    issues.push('Compiled bbox_format must be ' + LAYOUT_COMPILED_BBOX_FORMAT)
  }
  if ('summary' in value) issues.push(...validateSummary(value.summary))
  if (!('items' in value)) return issues
  if (!Array.isArray(value.items) || value.items.length === 0) {
    issues.push('items must be a nonempty flat array')
    return issues
  }
  value.items.forEach((item, index) => {
    const location = 'items[' + String(index) + ']'
    if (!isRecord(item)) {
      issues.push(location + ' must be an object')
      return
    }
    issues.push(...validateItemHead(item, location))
    const box = readCenteredTuple(item.bbox)
    if (box === null) {
      issues.push(location + '.bbox must be [y1,x1,y2,x2] with four finite numbers')
      return
    }
    if (!(box[0] < box[2])) issues.push(location + '.bbox must have positive y span (y1 < y2)')
    if (!(box[1] < box[3])) issues.push(location + '.bbox must have positive x span (x1 < x2)')
  })
  return issues
}

/**
 * Compile a draft into the prompt-ready compact JSON string.
 *
 * Field order is preserved from each draft item (the reference compiler builds
 * its output the same way), so a draft that came from a published sample compiles
 * byte-for-byte to that sample's compiled pair.
 */
export function compileLayout(draft: LayoutDraft): string {
  const issues = validateLayoutDraft(draft)
  if (issues.length > 0) throw new LayoutEditorError(issues)
  const source = draft as unknown as Record<string, unknown>
  const width = draft.width
  const height = draft.height
  const items = source.items as Record<string, unknown>[]
  const compiledItems = items.map((item) => {
    const compiled: Record<string, unknown> = {}
    for (const key of Object.keys(item)) {
      if (key === 'bbox') {
        const box = readBoxTuple(item.bbox)
        compiled.bbox = toCompiledBox(box as LayoutBox, width, height)
      } else {
        compiled[key] = item[key]
      }
    }
    return compiled
  })
  const compiled: Record<string, unknown> = {
    summary: source.summary,
    items: compiledItems,
    bbox_coord_space: LAYOUT_COMPILED_BBOX_COORD_SPACE,
    bbox_format: LAYOUT_COMPILED_BBOX_FORMAT,
  }
  return JSON.stringify(compiled)
}

/** Parse and validate a draft JSON text. */
export function parseDraft(text: string): LayoutDraft {
  const value = parseJsonValue(text, 'Draft')
  const issues = validateLayoutDraft(value)
  if (issues.length > 0) throw new LayoutEditorError(issues)
  return value as LayoutDraft
}

/**
 * Read a compiled layout back into a draft.
 *
 * The compiled format omits width/height, so the caller supplies the generation
 * size the prompt was compiled for; the inverse conversion is exact for the
 * integer edges the editor produces.
 */
export function decompileLayout(value: unknown, width: number, height: number): LayoutDraft {
  assertCanvas(width, height)
  const parsed = typeof value === 'string' ? parseJsonValue(value, 'Compiled layout') : value
  const issues = validateCompiledLayout(parsed)
  if (issues.length > 0) throw new LayoutEditorError(issues)
  const source = parsed as unknown as Record<string, unknown>
  const compiledItems = source.items as Record<string, unknown>[]
  const items = compiledItems.map((item) => {
    const centered = readCenteredTuple(item.bbox) as LayoutCenteredBbox
    const box = fromCompiledBox(centered, width, height)
    const draftItem: Record<string, unknown> = {}
    for (const key of Object.keys(item)) {
      if (key === 'bbox') {
        draftItem.bbox = [box.x1, box.y1, box.x2, box.y2]
      } else {
        draftItem[key] = item[key]
      }
    }
    return draftItem
  })
  const draft = {
    width,
    height,
    bbox_coord_space: LAYOUT_DRAFT_BBOX_COORD_SPACE,
    bbox_format: LAYOUT_DRAFT_BBOX_FORMAT,
    summary: source.summary,
    items,
  }
  const draftIssues = validateLayoutDraft(draft)
  if (draftIssues.length > 0) throw new LayoutEditorError(draftIssues)
  return draft as unknown as LayoutDraft
}

/**
 * Format a draft as 2-space JSON plus a trailing newline.
 *
 * The verify samples inline their short arrays, which is cosmetic: only the
 * fields and values are the contract. The compiled prompt is the one that must
 * be byte-identical, because it is the text the model actually reads.
 */
export function formatDraft(draft: LayoutDraft): string {
  return JSON.stringify(draft, null, 2) + '\n'
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Order the edges so x1 <= x2 and y1 <= y2 without touching canvas bounds. */
export function normalizeBox(box: LayoutBox): LayoutBox {
  return {
    x1: Math.min(box.x1, box.x2),
    y1: Math.min(box.y1, box.y2),
    x2: Math.max(box.x1, box.x2),
    y2: Math.max(box.y1, box.y2),
  }
}

/** Round one coordinate to whole canvas pixels, normalizing negative zero. */
function roundCoordinate(value: number): number {
  const rounded = Math.round(value)
  return rounded === 0 ? 0 : rounded
}

/** Round all four edges to whole canvas pixels. */
export function roundBox(box: LayoutBox): LayoutBox {
  return {
    x1: roundCoordinate(box.x1),
    y1: roundCoordinate(box.y1),
    x2: roundCoordinate(box.x2),
    y2: roundCoordinate(box.y2),
  }
}

/**
 * Fit one axis' span into [0, max]: order, enforce the minimum size, and shift
 * (never squash) a span that is merely offset, shrinking only when the span is
 * larger than the canvas itself.
 */
function clampSpan(a: number, b: number, max: number): [number, number] {
  let start = Math.min(roundCoordinate(a), roundCoordinate(b))
  let end = Math.max(roundCoordinate(a), roundCoordinate(b))
  if (end - start < LAYOUT_MIN_BOX_SIZE) end = start + LAYOUT_MIN_BOX_SIZE
  const span = end - start
  if (span >= max) {
    start = 0
    end = max
  } else if (start < 0) {
    end -= start
    start = 0
  } else if (end > max) {
    start -= end - max
    end = max
  }
  if (start < 0) start = 0
  if (end > max) end = max
  if (end - start < LAYOUT_MIN_BOX_SIZE) {
    start = Math.max(0, Math.min(start, max - LAYOUT_MIN_BOX_SIZE))
    end = start + LAYOUT_MIN_BOX_SIZE
  }
  return [start, end]
}

/** Round and fit a box into the canvas; the returned box is always exportable. */
export function clampBox(box: LayoutBox, width: number, height: number): LayoutBox {
  if (!(isFiniteNumber(width) && width > 0) || !(isFiniteNumber(height) && height > 0)) {
    throw new LayoutEditorError(['canvas width and height must be positive numbers'])
  }
  const [x1, x2] = clampSpan(box.x1, box.x2, width)
  const [y1, y2] = clampSpan(box.y1, box.y2, height)
  return { x1, y1, x2, y2 }
}

/** The box described by dragging from one canvas point to another. */
export function boxFromDrag(start: LayoutPoint, end: LayoutPoint): LayoutBox {
  const normalized = normalizeBox({ x1: start.x, y1: start.y, x2: end.x, y2: end.y })
  const rounded = roundBox(normalized)
  if (rounded.x2 - rounded.x1 < LAYOUT_MIN_BOX_SIZE) rounded.x2 = rounded.x1 + LAYOUT_MIN_BOX_SIZE
  if (rounded.y2 - rounded.y1 < LAYOUT_MIN_BOX_SIZE) rounded.y2 = rounded.y1 + LAYOUT_MIN_BOX_SIZE
  return rounded
}

/** Translate a box and clamp it inside the canvas (size preserved when it fits). */
export function moveLayoutBox(box: LayoutBox, dx: number, dy: number, width: number, height: number): LayoutBox {
  const stepX = Number.isFinite(dx) ? Math.round(dx) : 0
  const stepY = Number.isFinite(dy) ? Math.round(dy) : 0
  return clampBox({ x1: box.x1 + stepX, y1: box.y1 + stepY, x2: box.x2 + stepX, y2: box.y2 + stepY }, width, height)
}

/** Resize a box by dragging one handle; the opposite edges stay put. */
export function resizeLayoutBox(
  box: LayoutBox,
  handle: LayoutResizeHandle,
  dx: number,
  dy: number,
  width: number,
  height: number,
): LayoutBox {
  const stepX = Number.isFinite(dx) ? Math.round(dx) : 0
  const stepY = Number.isFinite(dy) ? Math.round(dy) : 0
  let { x1, y1, x2, y2 } = box
  if (handle === 'w' || handle === 'nw' || handle === 'sw') x1 = box.x1 + stepX
  if (handle === 'e' || handle === 'ne' || handle === 'se') x2 = box.x2 + stepX
  if (handle === 'n' || handle === 'nw' || handle === 'ne') y1 = box.y1 + stepY
  if (handle === 's' || handle === 'sw' || handle === 'se') y2 = box.y2 + stepY
  if (x2 - x1 < LAYOUT_MIN_BOX_SIZE) {
    if (handle === 'w' || handle === 'nw' || handle === 'sw') x1 = x2 - LAYOUT_MIN_BOX_SIZE
    else x2 = x1 + LAYOUT_MIN_BOX_SIZE
  }
  if (y2 - y1 < LAYOUT_MIN_BOX_SIZE) {
    if (handle === 'n' || handle === 'nw' || handle === 'ne') y1 = y2 - LAYOUT_MIN_BOX_SIZE
    else y2 = y1 + LAYOUT_MIN_BOX_SIZE
  }
  x1 = Math.max(0, Math.min(x1, width - LAYOUT_MIN_BOX_SIZE))
  x2 = Math.max(LAYOUT_MIN_BOX_SIZE, Math.min(x2, width))
  if (x2 - x1 < LAYOUT_MIN_BOX_SIZE) {
    if (handle === 'w' || handle === 'nw' || handle === 'sw') x1 = x2 - LAYOUT_MIN_BOX_SIZE
    else x2 = x1 + LAYOUT_MIN_BOX_SIZE
  }
  y1 = Math.max(0, Math.min(y1, height - LAYOUT_MIN_BOX_SIZE))
  y2 = Math.max(LAYOUT_MIN_BOX_SIZE, Math.min(y2, height))
  if (y2 - y1 < LAYOUT_MIN_BOX_SIZE) {
    if (handle === 'n' || handle === 'nw' || handle === 'ne') y1 = y2 - LAYOUT_MIN_BOX_SIZE
    else y2 = y1 + LAYOUT_MIN_BOX_SIZE
  }
  return { x1, y1, x2, y2 }
}

/** Display pixels -> layout pixels. Zero-sized displays map to the canvas origin. */
export function pointToCanvas(point: LayoutPoint, viewport: LayoutViewport): LayoutPoint {
  if (!(viewport.displayWidth > 0) || !(viewport.displayHeight > 0)) return { x: 0, y: 0 }
  return {
    x: (point.x * viewport.canvasWidth) / viewport.displayWidth,
    y: (point.y * viewport.canvasHeight) / viewport.displayHeight,
  }
}

/** Layout pixels -> display pixels. */
export function canvasToDisplay(point: LayoutPoint, viewport: LayoutViewport): LayoutPoint {
  return {
    x: (point.x * viewport.displayWidth) / viewport.canvasWidth,
    y: (point.y * viewport.displayHeight) / viewport.canvasHeight,
  }
}

/**
 * Screen-pixel delta → draft-pixel delta (§8.2's one conversion).
 *
 * Both the pointer delta and the editor's display box are page CSS pixels, so
 * the same scale applies to both axes: `canvasWidth / displayWidth` equals
 * `canvasHeight / displayHeight` whenever the display box preserves the draft's
 * aspect ratio (which the mount enforces). A canvas that zooms the editor by an
 * ancestor transform zooms `display` too, so the returned delta is **invariant
 * under that zoom** — the property the pointerScale concern was about.
 *
 * `pointerScale` is the host hook for page coordinates that are not the
 * element's local coordinates (default 1 = page px are local px). It divides the
 * delta, per the design's "屏幕 delta → draft delta 除以 pointerScale" wording.
 * Invalid scales and degenerate display boxes yield a zero delta instead of
 * NaN/Infinity, which would corrupt a box.
 *
 * @param delta - pointer movement in page CSS pixels.
 * @param display - the editor canvas's measured (rendered) box in page pixels.
 * @param canvas - the draft canvas size in draft pixels.
 * @param pointerScale - host page-px → local-px factor; default 1.
 * @returns the movement in draft pixels.
 */
export function screenDeltaToDraft(
  delta: LayoutPoint,
  display: { readonly width: number; readonly height: number },
  canvas: { readonly width: number; readonly height: number },
  pointerScale = 1,
): LayoutPoint {
  const scale = Number.isFinite(pointerScale) && pointerScale > 0 ? pointerScale : 1
  const displayWidth = display.width / scale
  const displayHeight = display.height / scale
  if (
    !Number.isFinite(displayWidth) || displayWidth <= 0
    || !Number.isFinite(displayHeight) || displayHeight <= 0
    || !Number.isFinite(canvas.width) || canvas.width <= 0
    || !Number.isFinite(canvas.height) || canvas.height <= 0
  ) {
    return { x: 0, y: 0 }
  }
  return {
    x: (delta.x * canvas.width) / displayWidth,
    y: (delta.y * canvas.height) / displayHeight,
  }
}

/** A box as CSS pixel geometry for the display layer (left/top/width/height). */
export function canvasBoxToDisplay(
  box: LayoutBox,
  viewport: LayoutViewport,
): { left: number; top: number; width: number; height: number } {
  const topLeft = canvasToDisplay({ x: box.x1, y: box.y1 }, viewport)
  const bottomRight = canvasToDisplay({ x: box.x2, y: box.y2 }, viewport)
  return {
    left: topLeft.x,
    top: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
  }
}

// ---------------------------------------------------------------------------
// Editor state (pure, immutable)
// ---------------------------------------------------------------------------

/** Options for a fresh editor state. */
export interface CreateLayoutStateOptions {
  width?: number
  height?: number
  summary?: Partial<LayoutSummary>
}

/** A box to add, plus the item fields the editor can set up front. */
export interface LayoutBoxSeed {
  bbox: LayoutBox | LayoutBbox
  label?: LayoutItemLabel
  caption?: string
  text?: string
  tags?: string[]
  palette?: string[]
}

/** A partial item update; omitted fields keep their current value. */
export interface LayoutBoxPatch {
  bbox?: LayoutBox | LayoutBbox
  label?: LayoutItemLabel
  caption?: string
  text?: string
  tags?: string[]
  palette?: string[]
}

/**
 * Copy a summary while preserving key order.
 *
 * Order matters: the published compiled samples are byte compared in the test
 * suite, and the reference compiler emits summary keys in the draft's own order.
 */
function cloneSummary(summary: LayoutSummary): LayoutSummary {
  const source = summary as unknown as Record<string, unknown>
  const copy: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    const value = source[key]
    copy[key] = Array.isArray(value) ? [...value] : value
  }
  return copy as unknown as LayoutSummary
}

function summaryWithDefaults(partial?: Partial<LayoutSummary>): LayoutSummary {
  const summary: LayoutSummary = { caption: '' }
  if (partial === undefined) return summary
  if (partial.caption !== undefined) summary.caption = partial.caption
  if (partial.meta !== undefined) summary.meta = [...partial.meta]
  if (partial.canvas !== undefined) summary.canvas = partial.canvas
  if (partial.palette !== undefined) summary.palette = [...partial.palette]
  return summary
}

function readBboxValue(value: LayoutBox | LayoutBbox): LayoutBox {
  if (Array.isArray(value)) {
    return { x1: value[0], y1: value[1], x2: value[2], y2: value[3] }
  }
  const box = value as LayoutBox
  return { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 }
}

function assertLabel(label: LayoutItemLabel): void {
  if (!LAYOUT_ITEM_LABELS.includes(label)) {
    throw new LayoutEditorError(['label must be object, character or text'])
  }
}

/** Start an empty editor state. The default summary caption is empty until edited. */
export function createLayoutState(options: CreateLayoutStateOptions = {}): LayoutEditorState {
  const width = options.width === undefined ? DEFAULT_LAYOUT_WIDTH : options.width
  const height = options.height === undefined ? DEFAULT_LAYOUT_HEIGHT : options.height
  assertCanvas(width, height)
  return {
    width,
    height,
    summary: summaryWithDefaults(options.summary),
    items: [],
    selectedId: null,
    seq: 1,
  }
}

/**
 * Load a draft into the editor, assigning editor-only ids in array order.
 *
 * Strict on purpose: this validates a draft that came from a file, where an
 * empty `items` list means the file is broken. A layout **node** starts life
 * with no boxes at all, so the mount path uses {@link draftToEditorState}.
 */
export function draftToState(draft: unknown): LayoutEditorState {
  return draftToEditorStateWith(draft, false)
}

/**
 * Load a draft into the editor, tolerating a draft with **no boxes yet**.
 *
 * A freshly created layout node has an empty draft (the first thing the user
 * does is draw a box), and undoing the first box takes it back to empty. Both
 * must mount, not blank the panel: the strict rule exists to reject malformed
 * *files*, not to make an empty canvas un-openable. Every other validation rule
 * is still enforced.
 *
 * @param draft - a draft from a board entry or the editor itself.
 * @returns editable state, with zero items allowed.
 * @throws When the draft is malformed for any reason other than being empty.
 */
export function draftToEditorState(draft: unknown): LayoutEditorState {
  return draftToEditorStateWith(draft, true)
}

/**
 * Draft issues that only matter when a layout is **submitted**, not while it is
 * being edited. A new node has no boxes and no caption yet — those two become
 * requirements at compile/export time, not at mount time.
 */
const EDITOR_TOLERANT_ISSUES = new Set([
  'items must be a nonempty flat array',
  'summary.caption must be nonempty text',
])

function draftToEditorStateWith(draft: unknown, tolerateDrafting: boolean): LayoutEditorState {
  const issues = tolerateDrafting
    ? validateLayoutDraft(draft).filter((issue) => !EDITOR_TOLERANT_ISSUES.has(issue))
    : validateLayoutDraft(draft)
  if (issues.length > 0) throw new LayoutEditorError(issues)
  const source = draft as LayoutDraft
  const items: LayoutEditorItem[] = source.items.map((item, index) => {
    const editable: LayoutEditorItem = {
      id: 'box-' + String(index + 1),
      label: item.label,
      caption: item.caption,
      bbox: readBboxValue(item.bbox),
    }
    if (item.text !== undefined) editable.text = item.text
    if (item.tags !== undefined) editable.tags = [...item.tags]
    if (item.palette !== undefined) editable.palette = [...item.palette]
    return editable
  })
  return {
    width: source.width,
    height: source.height,
    summary: cloneSummary(source.summary),
    items,
    selectedId: null,
    seq: items.length + 1,
  }
}

/** Serialize editor state as a draft. Editor ids never leave the module. */
export function stateToDraft(state: LayoutEditorState): LayoutDraft {
  const items: LayoutDraftItem[] = state.items.map((item) => {
    const draftItem: LayoutDraftItem = {
      label: item.label,
      caption: item.caption,
      bbox: [item.bbox.x1, item.bbox.y1, item.bbox.x2, item.bbox.y2],
    }
    if (item.text !== undefined) draftItem.text = item.text
    if (item.tags !== undefined) draftItem.tags = [...item.tags]
    if (item.palette !== undefined) draftItem.palette = [...item.palette]
    return draftItem
  })
  return {
    width: state.width,
    height: state.height,
    bbox_coord_space: LAYOUT_DRAFT_BBOX_COORD_SPACE,
    bbox_format: LAYOUT_DRAFT_BBOX_FORMAT,
    summary: cloneSummary(state.summary),
    items,
  }
}

/** Draft export: the pretty JSON the editor can load again later. */
export function exportDraft(state: LayoutEditorState): string {
  return formatDraft(stateToDraft(state))
}

/**
 * Compiled export: the compact JSON string that goes into the prompt.
 *
 * Returned without a trailing newline (the reference compiler does the same and
 * its CLI adds the newline when writing a file); paste it as-is.
 */
export function exportCompiled(state: LayoutEditorState): string {
  return compileLayout(stateToDraft(state))
}

/** Find an item by editor id. */
export function getLayoutItem(state: LayoutEditorState, id: string | null): LayoutEditorItem | undefined {
  if (id === null) return undefined
  return state.items.find((item) => item.id === id)
}

/** The currently selected item, if any. */
export function selectedLayoutItem(state: LayoutEditorState): LayoutEditorItem | undefined {
  return getLayoutItem(state, state.selectedId)
}

/** Add a box; the new box becomes selected and ids never repeat within a state. */
export function addBox(state: LayoutEditorState, seed: LayoutBoxSeed): LayoutEditorState {
  const label = seed.label === undefined ? 'object' : seed.label
  assertLabel(label)
  const item: LayoutEditorItem = {
    id: 'box-' + String(state.seq),
    label,
    caption: seed.caption === undefined ? '' : seed.caption,
    bbox: clampBox(readBboxValue(seed.bbox), state.width, state.height),
  }
  if (seed.text !== undefined) item.text = seed.text
  if (seed.tags !== undefined) item.tags = [...seed.tags]
  if (seed.palette !== undefined) item.palette = [...seed.palette]
  return { ...state, items: [...state.items, item], selectedId: item.id, seq: state.seq + 1 }
}

/** Apply a partial update to one box. Unknown ids are a no-op. */
export function updateBox(state: LayoutEditorState, id: string, patch: LayoutBoxPatch): LayoutEditorState {
  const index = state.items.findIndex((item) => item.id === id)
  if (index < 0) return state
  const next: LayoutEditorItem = { ...state.items[index] }
  if (patch.label !== undefined) {
    assertLabel(patch.label)
    next.label = patch.label
  }
  if (patch.caption !== undefined) next.caption = patch.caption
  if (patch.text !== undefined) next.text = patch.text
  if (patch.tags !== undefined) next.tags = [...patch.tags]
  if (patch.palette !== undefined) next.palette = [...patch.palette]
  if (patch.bbox !== undefined) next.bbox = clampBox(readBboxValue(patch.bbox), state.width, state.height)
  const items = state.items.slice()
  items[index] = next
  return { ...state, items }
}

/** Set an item's caption; the wording rule travels through {@link CAPTION_HINT}. */
export function setBoxCaption(state: LayoutEditorState, id: string, caption: string): LayoutEditorState {
  return updateBox(state, id, { caption })
}

/** Set an item's label (object / character / text). */
export function setBoxLabel(state: LayoutEditorState, id: string, label: LayoutItemLabel): LayoutEditorState {
  return updateBox(state, id, { label })
}

/** Move a box by a delta in canvas pixels; the box stops at the canvas edge. */
export function moveBox(state: LayoutEditorState, id: string, dx: number, dy: number): LayoutEditorState {
  const item = getLayoutItem(state, id)
  if (item === undefined) return state
  return updateBox(state, id, { bbox: moveLayoutBox(item.bbox, dx, dy, state.width, state.height) })
}

/** Resize a box by dragging one handle. */
export function resizeBox(
  state: LayoutEditorState,
  id: string,
  handle: LayoutResizeHandle,
  dx: number,
  dy: number,
): LayoutEditorState {
  const item = getLayoutItem(state, id)
  if (item === undefined) return state
  return updateBox(state, id, {
    bbox: resizeLayoutBox(item.bbox, handle, dx, dy, state.width, state.height),
  })
}

/** Remove a box; deleting the selected box clears the selection. */
export function deleteBox(state: LayoutEditorState, id: string): LayoutEditorState {
  const exists = state.items.some((item) => item.id === id)
  if (!exists) return state
  return {
    ...state,
    items: state.items.filter((item) => item.id !== id),
    selectedId: state.selectedId === id ? null : state.selectedId,
  }
}

/** Select a box by id; an unknown id clears the selection. */
export function selectBox(state: LayoutEditorState, id: string | null): LayoutEditorState {
  if (id !== null && !state.items.some((item) => item.id === id)) {
    return state.selectedId === null ? state : { ...state, selectedId: null }
  }
  if (state.selectedId === id) return state
  return { ...state, selectedId: id }
}

/** Patch the shared summary; caption is the only required field. */
export function setSummary(state: LayoutEditorState, patch: Partial<LayoutSummary>): LayoutEditorState {
  return { ...state, summary: cloneSummary({ ...state.summary, ...patch }) }
}

// ---------------------------------------------------------------------------
// Optional DOM mount
// ---------------------------------------------------------------------------

/** Initial state or draft for the mounted editor, plus host callbacks. */
export interface LayoutEditorOptions {
  width?: number
  height?: number
  summary?: Partial<LayoutSummary>
  /** Full editor state to start from (wins over draft). */
  state?: LayoutEditorState
  /** Draft to load into the editor. */
  draft?: LayoutDraft
  /** Called after every committed edit. */
  onChange?: (state: LayoutEditorState) => void
  /** Called when an export button is pressed. */
  onExport?: (kind: 'draft' | 'compiled', text: string) => void
  /**
   * Extra host scale between page pixels and the editor's local CSS pixels
   * (§8.2's `pointerScale` hook). Default 1, which is the independent-editor
   * behaviour and the only correct value when the editor's box is measured with
   * `getBoundingClientRect` inside a CSS-transformed canvas layer: that
   * measurement already contains the zoom, so passing the zoom here as well
   * would **double-apply** it. The hook exists for hosts whose page coordinates
   * differ from the element's local coordinates (e.g. a `zoom` on an ancestor);
   * the canvas integration leaves it at the default.
   */
  pointerScale?: () => number
}

/** The host-facing editor handle; the host owns the container and its removal. */
export interface LayoutEditorHandle {
  /** Root element appended to the container. */
  readonly element: HTMLElement
  getState(): LayoutEditorState
  setState(state: LayoutEditorState): void
  getDraft(): LayoutDraft
  getCompiled(): string
  addBox(box: LayoutBox): void
  deleteSelected(): void
  destroy(): void
}

interface LayoutDragState {
  mode: 'move' | 'resize' | 'create'
  id?: string
  handle?: LayoutResizeHandle
  /** Pointer-down position in draft pixels (already through `eventPoint`). */
  start: LayoutPoint
  /** Pointer-down position in page pixels, for the §8.2 delta conversion. */
  startClient: LayoutPoint
  origin?: LayoutBox
}

function resolveInitialState(options: LayoutEditorOptions): LayoutEditorState {
  if (options.state !== undefined) return options.state
  // A layout node's draft is empty until the first box; mount must still work.
  if (options.draft !== undefined) return draftToEditorState(options.draft)
  return createLayoutState({ width: options.width, height: options.height, summary: options.summary })
}

const HANDLE_CURSORS: Record<LayoutResizeHandle, string> = {
  nw: 'nwse-resize',
  ne: 'nesw-resize',
  se: 'nwse-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  e: 'ew-resize',
  s: 'ns-resize',
  w: 'ew-resize',
}

const HANDLE_STYLES: Record<LayoutResizeHandle, string> = {
  nw: 'left:0;top:0;transform:translate(-50%,-50%);',
  n: 'left:50%;top:0;transform:translate(-50%,-50%);',
  ne: 'right:0;top:0;transform:translate(50%,-50%);',
  e: 'right:0;top:50%;transform:translate(50%,-50%);',
  se: 'right:0;bottom:0;transform:translate(50%,50%);',
  s: 'left:50%;bottom:0;transform:translate(-50%,50%);',
  sw: 'left:0;bottom:0;transform:translate(-50%,50%);',
  w: 'left:0;top:50%;transform:translate(-50%,-50%);',
}

/**
 * Mount the editor UI into a container element.
 *
 * The core above is DOM-free; this is the one browser-only entry. It draws boxes
 * on a scaled canvas, supports drawing by dragging empty space, moving, resizing
 * through eight handles, deleting, editing the caption/label/literal text, and
 * exporting both formats. Styling is inline so no stylesheet is required; the
 * host can still target the root class.
 */
export function mountLayoutEditor(container: HTMLElement, options: LayoutEditorOptions = {}): LayoutEditorHandle {
  if (container === null || container === undefined || typeof container.appendChild !== 'function') {
    throw new LayoutEditorError(['mountLayoutEditor requires a container element'])
  }
  const ownerDocument = container.ownerDocument
  const doc: Document = ownerDocument === null || ownerDocument === undefined ? document : ownerDocument
  let state = resolveInitialState(options)
  let drag: LayoutDragState | null = null

  const wrapper = doc.createElement('div')
  wrapper.className = LAYOUT_EDITOR_CLASS
  wrapper.tabIndex = 0
  wrapper.setAttribute('style', 'display:flex;flex-direction:column;gap:8px;font:12px/1.5 system-ui,sans-serif;color:inherit;')

  const buttonStyle = 'padding:2px 8px;border:1px solid #8a8a8a;border-radius:4px;background:transparent;color:inherit;font:inherit;cursor:pointer;'
  const fieldStyle = 'padding:2px 6px;border:1px solid #8a8a8a;border-radius:4px;background:transparent;color:inherit;font:inherit;'

  function makeButton(label: string): HTMLButtonElement {
    const element = doc.createElement('button')
    element.type = 'button'
    element.textContent = label
    element.setAttribute('style', buttonStyle)
    return element
  }

  const toolbar = doc.createElement('div')
  toolbar.setAttribute('style', 'display:flex;flex-wrap:wrap;align-items:center;gap:6px;')
  const addButton = makeButton('+ 框')
  const deleteButton = makeButton('删除')
  const labelSelect = doc.createElement('select')
  labelSelect.setAttribute('style', fieldStyle)
  for (const label of LAYOUT_ITEM_LABELS) {
    const option = doc.createElement('option')
    option.value = label
    option.textContent = label
    labelSelect.appendChild(option)
  }
  toolbar.appendChild(addButton)
  toolbar.appendChild(deleteButton)
  toolbar.appendChild(labelSelect)

  const canvas = doc.createElement('div')
  canvas.setAttribute('style', 'position:relative;width:100%;background:#12161c;overflow:hidden;touch-action:none;cursor:crosshair;box-sizing:border-box;border:1px solid #3a3a3a;')
  const boxLayer = doc.createElement('div')
  boxLayer.setAttribute('style', 'position:absolute;left:0;top:0;right:0;bottom:0;')
  const preview = doc.createElement('div')
  preview.setAttribute('style', 'display:none;position:absolute;border:1px dashed #4da3ff;background:rgba(77,163,255,.18);box-sizing:border-box;pointer-events:none;')
  canvas.appendChild(boxLayer)
  canvas.appendChild(preview)

  const itemRow = doc.createElement('div')
  itemRow.setAttribute('style', 'display:flex;gap:6px;flex-wrap:wrap;')
  const captionInput = doc.createElement('input')
  captionInput.type = 'text'
  captionInput.placeholder = 'caption（必填；措辞会污染全图）'
  captionInput.setAttribute('style', 'flex:1 1 220px;' + fieldStyle)
  const textInput = doc.createElement('input')
  textInput.type = 'text'
  textInput.placeholder = 'text（label=text 时必填）'
  textInput.setAttribute('style', 'flex:1 1 160px;' + fieldStyle)
  itemRow.appendChild(captionInput)
  itemRow.appendChild(textInput)

  const summaryInput = doc.createElement('textarea')
  summaryInput.rows = 2
  summaryInput.placeholder = 'summary.caption（全局描述，必填）'
  summaryInput.setAttribute('style', 'width:100%;box-sizing:border-box;resize:vertical;' + fieldStyle)

  const hint = doc.createElement('p')
  hint.textContent = CAPTION_HINT
  hint.setAttribute('style', 'margin:0;opacity:.75;font-size:11px;')

  const exportRow = doc.createElement('div')
  exportRow.setAttribute('style', 'display:flex;gap:6px;flex-wrap:wrap;')
  const draftButton = makeButton('导出 draft')
  const compiledButton = makeButton('导出 compiled')
  exportRow.appendChild(draftButton)
  exportRow.appendChild(compiledButton)

  const output = doc.createElement('textarea')
  output.readOnly = true
  output.rows = 6
  output.placeholder = '导出结果（draft 可再导入，compiled 直接贴进 prompt）'
  output.setAttribute('style', 'width:100%;box-sizing:border-box;resize:vertical;font-family:ui-monospace,monospace;' + fieldStyle)

  wrapper.appendChild(toolbar)
  wrapper.appendChild(canvas)
  wrapper.appendChild(itemRow)
  wrapper.appendChild(summaryInput)
  wrapper.appendChild(hint)
  wrapper.appendChild(exportRow)
  wrapper.appendChild(output)

  function percentOf(value: number, total: number): string {
    return String((value / total) * 100) + '%'
  }

  function viewport(): LayoutViewport {
    const rect = canvas.getBoundingClientRect()
    return {
      displayWidth: rect.width,
      displayHeight: rect.height,
      canvasWidth: state.width,
      canvasHeight: state.height,
    }
  }

  /** The host's page-px → local-px factor, validated (§8.2 hook). */
  function pointerScale(): number {
    if (options.pointerScale === undefined) return 1
    const raw = options.pointerScale()
    return Number.isFinite(raw) && raw > 0 ? raw : 1
  }

  function eventPoint(event: PointerEvent): LayoutPoint {
    const rect = canvas.getBoundingClientRect()
    return pointToCanvas(
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      {
        displayWidth: rect.width,
        displayHeight: rect.height,
        canvasWidth: state.width,
        canvasHeight: state.height,
      },
    )
  }

  function showPreview(start: LayoutPoint, end: LayoutPoint): void {
    const box = clampBox(boxFromDrag(start, end), state.width, state.height)
    preview.style.display = 'block'
    preview.style.left = percentOf(box.x1, state.width)
    preview.style.top = percentOf(box.y1, state.height)
    preview.style.width = percentOf(box.x2 - box.x1, state.width)
    preview.style.height = percentOf(box.y2 - box.y1, state.height)
  }

  function renderBox(item: LayoutEditorItem, index: number, selected: boolean): HTMLElement {
    const element = doc.createElement('div')
    element.setAttribute('data-box-id', item.id)
    element.setAttribute(
      'style',
      'position:absolute;box-sizing:border-box;cursor:move;user-select:none;' +
        'left:' + percentOf(item.bbox.x1, state.width) + ';' +
        'top:' + percentOf(item.bbox.y1, state.height) + ';' +
        'width:' + percentOf(item.bbox.x2 - item.bbox.x1, state.width) + ';' +
        'height:' + percentOf(item.bbox.y2 - item.bbox.y1, state.height) + ';' +
        'border:1px solid ' + (selected ? '#4da3ff' : 'rgba(255,255,255,.55)') + ';' +
        'background:rgba(77,163,255,' + (selected ? '.22' : '.12') + ');',
    )
    const chip = doc.createElement('span')
    chip.setAttribute('style', 'position:absolute;left:-1px;top:-17px;padding:0 4px;border-radius:3px;background:rgba(0,0,0,.72);color:#fff;font-size:11px;line-height:15px;white-space:nowrap;pointer-events:none;')
    chip.textContent = item.label + ' ' + String(index + 1)
    element.appendChild(chip)
    if (selected) {
      for (const handle of LAYOUT_RESIZE_HANDLES) {
        const grip = doc.createElement('div')
        grip.setAttribute('data-handle', handle)
        grip.setAttribute('data-box-id', item.id)
        grip.setAttribute(
          'style',
          'position:absolute;width:8px;height:8px;margin:0;background:#4da3ff;border:1px solid #0b1220;' +
            HANDLE_STYLES[handle] + 'cursor:' + HANDLE_CURSORS[handle] + ';',
        )
        element.appendChild(grip)
      }
    }
    return element
  }

  function render(): void {
    canvas.style.aspectRatio = String(state.width) + ' / ' + String(state.height)
    const selected = selectedLayoutItem(state)
    deleteButton.disabled = state.selectedId === null
    labelSelect.value = selected === undefined ? 'object' : selected.label
    labelSelect.disabled = selected === undefined
    captionInput.disabled = selected === undefined
    if (doc.activeElement !== captionInput) {
      captionInput.value = selected === undefined ? '' : selected.caption
    }
    const showText = selected !== undefined && selected.label === 'text'
    textInput.style.display = showText ? '' : 'none'
    textInput.disabled = !showText
    if (doc.activeElement !== textInput) {
      textInput.value = selected === undefined || selected.text === undefined ? '' : selected.text
    }
    if (doc.activeElement !== summaryInput) summaryInput.value = state.summary.caption
    boxLayer.replaceChildren()
    state.items.forEach((item, index) => {
      boxLayer.appendChild(renderBox(item, index, item.id === state.selectedId))
    })
  }

  function commit(next: LayoutEditorState): void {
    state = next
    render()
    if (options.onChange !== undefined) options.onChange(state)
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 && event.pointerType === 'mouse') return
    const target = event.target as Element | null
    const handleElement = target !== null && typeof target.closest === 'function' ? target.closest('[data-handle]') : null
    const boxElement = target !== null && typeof target.closest === 'function' ? target.closest('[data-box-id]') : null
    const point = eventPoint(event)
    if (handleElement !== null) {
      const id = handleElement.getAttribute('data-box-id')
      const handle = handleElement.getAttribute('data-handle')
      if (id !== null && handle !== null) {
        commit(selectBox(state, id))
        const item = getLayoutItem(state, id)
        if (item !== undefined) {
          drag = {
            mode: 'resize',
            id,
            handle: handle as LayoutResizeHandle,
            start: point,
            startClient: { x: event.clientX, y: event.clientY },
            origin: item.bbox,
          }
        }
      }
    } else if (boxElement !== null) {
      const id = boxElement.getAttribute('data-box-id')
      if (id !== null) {
        const item = getLayoutItem(state, id)
        if (item !== undefined) {
          commit(selectBox(state, id))
          drag = {
            mode: 'move',
            id,
            start: point,
            startClient: { x: event.clientX, y: event.clientY },
            origin: item.bbox,
          }
        }
      }
    } else {
      commit(selectBox(state, null))
      drag = { mode: 'create', start: point, startClient: { x: event.clientX, y: event.clientY } }
      showPreview(point, point)
    }
    if (drag !== null) {
      canvas.setPointerCapture(event.pointerId)
      event.preventDefault()
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (drag === null) return
    if (drag.mode === 'create') {
      showPreview(drag.start, eventPoint(event))
      return
    }
    if (drag.id === undefined || drag.origin === undefined) return
    // §8.2: one conversion — page-pixel delta through the measured box (and the
    // host hook). Positions are not re-derived here, so the two sides of a drag
    // cannot be measured against different boxes.
    const rect = canvas.getBoundingClientRect()
    const moved = screenDeltaToDraft(
      { x: event.clientX - drag.startClient.x, y: event.clientY - drag.startClient.y },
      { width: rect.width, height: rect.height },
      { width: state.width, height: state.height },
      pointerScale(),
    )
    const dx = moved.x
    const dy = moved.y
    const box =
      drag.mode === 'move'
        ? moveLayoutBox(drag.origin, dx, dy, state.width, state.height)
        : resizeLayoutBox(drag.origin, drag.handle === undefined ? 'se' : drag.handle, dx, dy, state.width, state.height)
    commit(updateBox(state, drag.id, { bbox: box }))
  }

  function onPointerUp(event: PointerEvent): void {
    if (drag === null) return
    const finished = drag
    drag = null
    if (typeof canvas.hasPointerCapture === 'function' && canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId)
    }
    if (finished.mode === 'create') {
      preview.style.display = 'none'
      const box = clampBox(boxFromDrag(finished.start, eventPoint(event)), state.width, state.height)
      if (box.x2 - box.x1 >= 2 && box.y2 - box.y1 >= 2) {
        commit(addBox(state, { bbox: box, label: labelSelect.value as LayoutItemLabel }))
      } else {
        render()
      }
    }
  }

  function doExport(kind: 'draft' | 'compiled'): void {
    try {
      const text = kind === 'draft' ? exportDraft(state) : exportCompiled(state)
      output.value = text
      if (options.onExport !== undefined) options.onExport(kind, text)
    } catch (error) {
      output.value = error instanceof Error ? error.message : String(error)
    }
  }

  addButton.addEventListener('click', () => {
    const boxWidth = Math.max(LAYOUT_MIN_BOX_SIZE, Math.round(state.width * 0.3))
    const boxHeight = Math.max(LAYOUT_MIN_BOX_SIZE, Math.round(state.height * 0.3))
    const x1 = Math.round((state.width - boxWidth) / 2)
    const y1 = Math.round((state.height - boxHeight) / 2)
    commit(
      addBox(state, {
        bbox: { x1, y1, x2: x1 + boxWidth, y2: y1 + boxHeight },
        label: labelSelect.value as LayoutItemLabel,
      }),
    )
  })
  deleteButton.addEventListener('click', () => {
    if (state.selectedId !== null) commit(deleteBox(state, state.selectedId))
  })
  labelSelect.addEventListener('change', () => {
    if (state.selectedId !== null) commit(setBoxLabel(state, state.selectedId, labelSelect.value as LayoutItemLabel))
  })
  captionInput.addEventListener('input', () => {
    if (state.selectedId !== null) commit(setBoxCaption(state, state.selectedId, captionInput.value))
  })
  textInput.addEventListener('input', () => {
    if (state.selectedId !== null) commit(updateBox(state, state.selectedId, { text: textInput.value }))
  })
  summaryInput.addEventListener('input', () => {
    commit(setSummary(state, { caption: summaryInput.value }))
  })
  draftButton.addEventListener('click', () => doExport('draft'))
  compiledButton.addEventListener('click', () => doExport('compiled'))
  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerUp)
  wrapper.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null
    if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return
    if ((event.key === 'Delete' || event.key === 'Backspace') && state.selectedId !== null) {
      event.preventDefault()
      commit(deleteBox(state, state.selectedId))
    }
  })

  const handle: LayoutEditorHandle = {
    element: wrapper,
    getState: () => state,
    setState: (next: LayoutEditorState) => {
      state = next
      render()
    },
    getDraft: () => stateToDraft(state),
    getCompiled: () => compileLayout(stateToDraft(state)),
    addBox: (box: LayoutBox) => {
      commit(addBox(state, { bbox: box, label: labelSelect.value as LayoutItemLabel }))
    },
    deleteSelected: () => {
      if (state.selectedId !== null) commit(deleteBox(state, state.selectedId))
    },
    destroy: () => {
      wrapper.remove()
    },
  }

  container.appendChild(wrapper)
  render()
  return handle
}
