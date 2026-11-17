/**
 * Free-canvas geometry for the Studio.
 *
 * The Studio's results used to be a vertical list: every batch appended below
 * the last, and comparing two results meant scrolling. A canvas is the shape
 * people actually use for image work — place a result where you want it, drag
 * it next to the one it should match, zoom out to see the whole session.
 *
 * Everything here is pure and unit-tested, because camera maths is the kind of
 * code that looks obviously right and is off by a factor of `zoom` everywhere.
 * The React component keeps only the state; the arithmetic lives here.
 *
 * Coordinate systems, stated once:
 * - **world** — where nodes live; unbounded, origin arbitrary.
 * - **screen** — pixels inside the canvas viewport (client coordinates, offset by
 *   the viewport's own bounding box).
 * - **camera** — `x`/`y` are the world point shown at the viewport's top-left
 *   corner, `zoom` is world→screen scale.
 *
 * @module studio-canvas
 */

/**
 * Fallback width of one node, in world units.
 *
 * Image nodes are as wide as their picture's aspect ratio wants (see
 * {@link nodeDisplaySize}); this constant is the default for the cases that have
 * no picture to measure — task nodes and board entries with unknown dimensions.
 */
export const CANVAS_NODE_WIDTH = 208
/** Rendered height of one node, in world units (image + caption + actions). */
export const CANVAS_NODE_HEIGHT = 240

/** Height of the picture area inside a node, in world units; never scales. */
export const IMAGE_AREA_HEIGHT = 200
/** Narrowest an image node may render; extreme portrait assets clamp here. */
export const MIN_NODE_WIDTH = 96
/** Widest an image node may render; extreme landscape assets clamp here. */
export const MAX_NODE_WIDTH = 480

/**
 * Smallest zoom the canvas allows.
 *
 * Stepping back to see the whole session *is* the point of a generation canvas:
 * a 500-node board is roughly 15000×8000 world units, which the old 0.3 floor
 * could not frame — `fitCamera` clamped and left the far columns off-screen.
 * At 0.1 a node is still a legible colour block.
 */
export const CANVAS_MIN_ZOOM = 0.1
/**
 * Largest zoom the canvas allows.
 *
 * Imported assets are worth inspecting pixel by pixel, so a node's 200-world-unit
 * picture area may be blown up to 800 screen pixels.
 */
export const CANVAS_MAX_ZOOM = 4

/** Camera as stored in component state. */
export interface Camera {
  /** World x shown at the viewport's left edge. */
  x: number
  /** World y shown at the viewport's top edge. */
  y: number
  /** World→screen scale. */
  zoom: number
}

/** A point in world space. */
export interface Point {
  x: number
  y: number
}

/** Axis-aligned rectangle in world space. */
export interface Rect extends Point {
  width: number
  height: number
}

/**
 * The on-canvas size of a node holding a `width`×`height` picture.
 *
 * The picture area is a fixed {@link IMAGE_AREA_HEIGHT} tall and as wide as the
 * aspect ratio asks for, clamped to [{@link MIN_NODE_WIDTH}, {@link MAX_NODE_WIDTH}]
 * so an imported panorama cannot squeeze its neighbours and a long strip cannot
 * stretch the row into unusable width. Height never changes: caption and action
 * rows sit below the picture and are sized by their own content.
 *
 * Unknown or invalid dimensions fall back to the plain node box rather than
 * throwing — a board entry with a corrupt size should still render.
 */
export function nodeDisplaySize(width: number, height: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT }
  }
  const ideal = Math.round((IMAGE_AREA_HEIGHT * width) / height)
  return {
    width: Math.min(MAX_NODE_WIDTH, Math.max(MIN_NODE_WIDTH, ideal)),
    height: CANVAS_NODE_HEIGHT,
  }
}

/** Clamp a zoom factor into the supported range. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(CANVAS_MAX_ZOOM, Math.max(CANVAS_MIN_ZOOM, zoom))
}

/** Convert a viewport-relative screen point to world space. */
export function screenToWorld(camera: Camera, screen: Point): Point {
  return {
    x: screen.x / camera.zoom + camera.x,
    y: screen.y / camera.zoom + camera.y,
  }
}

/** Convert a world point to viewport-relative screen space. */
export function worldToScreen(camera: Camera, world: Point): Point {
  return {
    x: (world.x - camera.x) * camera.zoom,
    y: (world.y - camera.y) * camera.zoom,
  }
}

/**
 * Zoom while keeping the world point under `anchor` pinned to `anchor`.
 *
 * Without the anchor correction a wheel zoom drifts toward the viewport corner,
 * which feels like the canvas is fighting the pointer. `anchor` is in
 * viewport-relative screen pixels.
 */
export function zoomAt(camera: Camera, factor: number, anchor: Point): Camera {
  const zoom = clampZoom(camera.zoom * factor)
  if (zoom === camera.zoom) return camera
  const before = screenToWorld(camera, anchor)
  return {
    zoom,
    x: before.x - anchor.x / zoom,
    y: before.y - anchor.y / zoom,
  }
}

/** Pan by a screen-space delta. */
export function panBy(camera: Camera, delta: Point): Camera {
  return {
    zoom: camera.zoom,
    x: camera.x - delta.x / camera.zoom,
    y: camera.y - delta.y / camera.zoom,
  }
}

/**
 * A camera that frames every node with `padding` world units of margin.
 *
 * Returns the unchanged camera when there is nothing to frame — an empty
 * canvas should not teleport the view.
 */
export function fitCamera(rects: readonly Rect[], viewport: { width: number; height: number }, padding = 48): Camera {
  if (rects.length === 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { x: 0, y: 0, zoom: 1 }
  }
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const rect of rects) {
    left = Math.min(left, rect.x)
    top = Math.min(top, rect.y)
    right = Math.max(right, rect.x + rect.width)
    bottom = Math.max(bottom, rect.y + rect.height)
  }
  const width = Math.max(1, right - left + padding * 2)
  const height = Math.max(1, bottom - top + padding * 2)
  const zoom = clampZoom(Math.min(viewport.width / width, viewport.height / height))
  return {
    zoom,
    // Centre the content: put its midpoint at the viewport's midpoint.
    x: (left + right) / 2 - viewport.width / (2 * zoom),
    y: (top + bottom) / 2 - viewport.height / (2 * zoom),
  }
}

/**
 * A camera that puts one world point at the viewport's centre.
 *
 * §7.4's "定位" is not satisfied by switching boards and selecting an item: the
 * item can be anywhere on an unbounded canvas, and the user is left hunting for
 * the highlight. This moves the camera to it while **keeping the zoom**, so the
 * scale the user chose survives the jump.
 *
 * A non-positive or non-finite zoom falls back to 1 rather than dividing by zero
 * — the same defensive stance the rest of the camera arithmetic takes.
 */
export function centerOn(
  target: Point,
  viewport: { width: number; height: number },
  zoom: number,
): Camera {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  return {
    zoom: safeZoom,
    x: target.x - viewport.width / (2 * safeZoom),
    y: target.y - viewport.height / (2 * safeZoom),
  }
}

/**
 * Where to drop a new node: just right of the right-most node, keeping its top
 * edge aligned with the top-most one.
 *
 * The point is that a fresh result is always visible without the user hunting
 * for it, and two results never land on top of each other.
 */
export function nextNodeSpot(rects: readonly Rect[]): Point {
  if (rects.length === 0) return { x: 0, y: 0 }
  let right = Number.NEGATIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  for (const rect of rects) {
    right = Math.max(right, rect.x + rect.width)
    top = Math.min(top, rect.y)
  }
  return { x: right + 40, y: top }
}

/**
 * The four numbers `edgePath` draws with, shared with {@link edgeBounds}.
 *
 * One definition, two readers: the path string and the bounding box must agree
 * or a long edge that visibly crosses the viewport would be culled for being
 * "outside" it.
 */
function edgeAnchors(from: Rect, to: Rect): { x1: number; y1: number; x2: number; y2: number; reach: number } {
  const x1 = from.x + from.width
  const y1 = from.y + from.height / 2
  const x2 = to.x
  const y2 = to.y + to.height / 2
  return { x1, y1, x2, y2, reach: Math.max(40, Math.abs(x2 - x1) * 0.45) }
}

/**
 * `<path d>` for an edge from the right edge of `from` to the left edge of `to`.
 *
 * A cubic with horizontal control points reads as a wire rather than a slash
 * whenever the two nodes are on the same row, which is the common case.
 */
export function edgePath(from: Rect, to: Rect): string {
  const { x1, y1, x2, y2, reach } = edgeAnchors(from, to)
  return `M ${round(x1)} ${round(y1)} C ${round(x1 + reach)} ${round(y1)}, ${round(x2 - reach)} ${round(y2)}, ${round(x2)} ${round(y2)}`
}

/** Zoom as a percentage label, e.g. `120%`. */
export function zoomLabel(zoom: number): string {
  return `${String(Math.round(zoom * 100))}%`
}

/* -------------------------------------------------------------------------- */
/* Viewport culling (§5.2) and the edge index (§3.5)                            */
/* -------------------------------------------------------------------------- */

/**
 * Pre-render margin around the viewport, in world units.
 *
 * Culling to exactly the visible rectangle would pop a node in at the very edge
 * of a pan, half of it already on screen. 256 world units is a bit more than one
 * default node — enough that a node is fully mounted before any part of it can
 * be seen, at every zoom down to 0.1 (where it is 25 screen pixels). It also
 * keeps `loading: 'lazy'` meaningful: an image inside the margin is still not
 * fetched until it is really on screen.
 */
export const VIEWPORT_CULL_MARGIN = 256

/**
 * Half-thickness, in world units, of an edge's culling box.
 *
 * A wire drawn between two nodes at the same height has a zero-height bounding
 * box, and a zero-area rectangle never intersects anything under the strict
 * rule — so a long level edge crossing the viewport would be culled while
 * clearly visible. This gives it a body; the stroke is 2 screen pixels, so 2
 * world units is generous without reaching a neighbour's edge.
 */
const EDGE_BOUNDS_PAD = 2

/** Viewport size in screen pixels, as measured from the canvas element. */
export interface Viewport {
  width: number
  height: number
}

/** A node rect carrying what the render layer needs to place an edge. */
export interface EdgeNode extends Rect {
  readonly id: string
  readonly parents: readonly string[]
}

/** One resolved parent link, with both endpoints' rectangles already attached. */
export interface CanvasEdge {
  readonly child: string
  readonly parent: string
  readonly from: Rect
  readonly to: Rect
}

/**
 * Do two rectangles overlap by a positive area?
 *
 * Touching edges do **not** count — the same rule a marquee uses, so the node
 * set a selection would catch and the node set culling renders agree at the
 * boundary. Containment counts.
 *
 * Lives here because it is geometry; `canvas-interactions.ts` re-exports it so
 * the C08 import path keeps working (that module's header explains the handover).
 */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return overlapX > 0 && overlapY > 0
}

/**
 * The world rectangle the viewport shows, padded by `margin` on every side.
 *
 * `camera.x`/`camera.y` is the world point at the viewport's top-left corner, so
 * the visible world size is the viewport in screen pixels divided by the zoom.
 *
 * An unmeasured viewport (width or height ≤ 0, or a zoom that is not a positive
 * number) returns an effectively unbounded rectangle: until the browser has
 * measured the element, "render everything" is the only safe answer — culling
 * against a zero viewport would blank the canvas for the first frame, and
 * culling is never allowed to change what is on screen. The sentinel is a finite
 * ±2⁵³ span rather than `±Infinity`, because an infinite extent makes the
 * intersection arithmetic produce `NaN` and cull everything.
 */
export function visibleWorldRect(camera: Camera, viewport: Viewport, margin = VIEWPORT_CULL_MARGIN): Rect {
  const pad = Number.isFinite(margin) ? Math.max(0, margin) : 0
  const width = viewport.width
  const height = viewport.height
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)
    || !(Number.isFinite(camera.zoom) && camera.zoom > 0)
    || !Number.isFinite(camera.x) || !Number.isFinite(camera.y)) {
    const span = Number.MAX_SAFE_INTEGER
    return { x: -span, y: -span, width: span * 2, height: span * 2 }
  }
  return {
    x: camera.x - pad,
    y: camera.y - pad,
    width: width / camera.zoom + pad * 2,
    height: height / camera.zoom + pad * 2,
  }
}

/**
 * The subset of `rects` whose node would be on screen.
 *
 * Order is preserved (the caller's `nodes` order is what stacks siblings) and
 * the input items come back unchanged, so the caller can pass render items —
 * node plus rect plus id — and get the same objects back. O(n) rectangle tests,
 * which is cheaper than the DOM diff it saves even on a small board, so this
 * runs unconditionally with no switch.
 */
export function visibleNodes<T extends Rect>(
  rects: readonly T[],
  camera: Camera,
  viewport: Viewport,
  margin = VIEWPORT_CULL_MARGIN,
): T[] {
  const world = visibleWorldRect(camera, viewport, margin)
  return rects.filter((rect) => rectsIntersect(rect, world))
}

/**
 * `Map<id, node>` for the whole board, built once per `nodes` change.
 *
 * This is what retires the old per-edge `nodes.find` (O(n) inside O(n×parents)):
 * every parent lookup is now a hash hit. A duplicated id keeps its first
 * occurrence, matching what `Array.prototype.find` used to return.
 */
export function nodeIndex<T extends { readonly id: string }>(nodes: readonly T[]): Map<string, T> {
  const index = new Map<string, T>()
  for (const node of nodes) {
    if (!index.has(node.id)) index.set(node.id, node)
  }
  return index
}

/**
 * Resolve every `parents` link into an edge with both endpoints' rectangles.
 *
 * `index` is the board's {@link nodeIndex}: the child comes from `nodes`, the
 * parent from one hash lookup, so a board's edges cost O(parent links) map hits
 * rather than O(n) scans. A parent that is not on the board (a cross-board
 * reference, or an item the store dropped) is skipped instead of throwing —
 * `boards.resolveParents` already tolerates it, and a broken lineage must not
 * cost the user their canvas.
 *
 * A self-link is kept: it renders as the degenerate curl it always did, and
 * culling later decides whether to draw it.
 */
export function buildEdges<T extends EdgeNode>(nodes: readonly T[], index: ReadonlyMap<string, T>): CanvasEdge[] {
  const edges: CanvasEdge[] = []
  for (const node of nodes) {
    const to = rectOf(node)
    for (const parentId of node.parents) {
      const parent = index.get(parentId)
      if (parent === undefined) continue
      edges.push({ child: node.id, parent: parentId, from: rectOf(parent), to })
    }
  }
  return edges
}

/**
 * World-space bounding box of the cubic {@link edgePath} draws.
 *
 * A cubic never leaves the convex hull of its four control points, so the hull
 * of the two anchors and the two horizontal control points is a sufficient — and
 * cheap — box. `EDGE_BOUNDS_PAD` gives a horizontal wire a thickness: a
 * perfectly level long edge has a zero-height box, and a zero-area rectangle
 * never intersects anything under the strict rule.
 */
export function edgeBounds(from: Rect, to: Rect): Rect {
  const { x1, y1, x2, y2, reach } = edgeAnchors(from, to)
  const left = Math.min(x1, x2, x1 + reach, x2 - reach) - EDGE_BOUNDS_PAD
  const right = Math.max(x1, x2, x1 + reach, x2 - reach) + EDGE_BOUNDS_PAD
  const top = Math.min(y1, y2) - EDGE_BOUNDS_PAD
  const bottom = Math.max(y1, y2) + EDGE_BOUNDS_PAD
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * The edges this frame should draw.
 *
 * An edge counts as visible when either endpoint is (its node intersects the
 * padded viewport — exactly the membership test in {@link visibleNodes}), or
 * when its own bounding box crosses the viewport. The second rule is what keeps
 * a long blood-line edge passing behind the viewport while both of its nodes are
 * off-screen; without it the wire would vanish in the middle of a pan.
 */
export function visibleEdges(edges: readonly CanvasEdge[], worldRect: Rect): CanvasEdge[] {
  return edges.filter((edge) => (
    rectsIntersect(edge.from, worldRect)
    || rectsIntersect(edge.to, worldRect)
    || rectsIntersect(edgeBounds(edge.from, edge.to), worldRect)
  ))
}

/** Copy the four geometry fields, so an edge keeps the rects it was built from. */
function rectOf(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
