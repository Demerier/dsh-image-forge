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

/** Rendered width of one image node, in world units. */
export const CANVAS_NODE_WIDTH = 208
/** Rendered height of one image node, in world units (image + caption + actions). */
export const CANVAS_NODE_HEIGHT = 240

/** Smallest zoom the canvas allows; below this a node is unreadable anyway. */
export const CANVAS_MIN_ZOOM = 0.3
/** Largest zoom the canvas allows; above this the bitmap gains nothing. */
export const CANVAS_MAX_ZOOM = 2.5

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
 * `<path d>` for an edge from the right edge of `from` to the left edge of `to`.
 *
 * A cubic with horizontal control points reads as a wire rather than a slash
 * whenever the two nodes are on the same row, which is the common case.
 */
export function edgePath(from: Rect, to: Rect): string {
  const x1 = from.x + from.width
  const y1 = from.y + from.height / 2
  const x2 = to.x
  const y2 = to.y + to.height / 2
  const reach = Math.max(40, Math.abs(x2 - x1) * 0.45)
  return `M ${round(x1)} ${round(y1)} C ${round(x1 + reach)} ${round(y1)}, ${round(x2 - reach)} ${round(y2)}, ${round(x2)} ${round(y2)}`
}

/** Zoom as a percentage label, e.g. `120%`. */
export function zoomLabel(zoom: number): string {
  return `${String(Math.round(zoom * 100))}%`
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
