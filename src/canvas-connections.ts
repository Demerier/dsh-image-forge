/**
 * Dragging a wire out of a node: the state machine behind "drag a line, and
 * get the next node".
 *
 * The canvas has always been able to *show* lineage — `parents` is an adjacency
 * list and `edgePath` draws it — but the only way to *make* an edge was to go
 * through the form: pick a reference, press generate, and let the recorded
 * picture inherit the parent. That means every edge cost a GPU run, and a user
 * who simply wanted "this one came from that one" had no way to say so.
 *
 * The gesture that fixes it is the one every node canvas has: grab the output
 * dot on a node's right edge, drag, let go. Where it is dropped decides what
 * happens, and that decision is the whole of this module:
 *
 * ```
 *   idle ──press handle──▶ armed ──move past threshold──▶ dragging ──┐
 *                  │                 │                               │
 *                  │                 │              ┌────────────────┼────────────────┐
 *                  │                 │              ▼                ▼                ▼
 *                  │                 │        hoverTarget          blank         dragging
 *                  │                 │        (合法节点)           (空白)      (拖回源节点)
 *                  │                 │              │                │                │
 *                  │                 │        commit-edge     open-selector        cancel
 *                  ▼                 ▼
 *               cancel            cancel         (Esc anywhere is cancel too)
 * ```
 *
 * `dragging` is the phase a wire has once it has left the handle but not yet
 * arrived anywhere — including when it comes **back over the node it started
 * from**. That last case is why the phase cannot simply be "blank": dropping
 * there must cancel (the user is putting the wire back), while dropping on real
 * empty canvas must ask what to build. `blank` means "empty canvas", and only
 * that opens the menu.
 *
 * Everything here is pure and Node-importable, for the reason
 * `canvas-interactions.ts` states for the rest of the gestures: pointer capture
 * and paint cannot be automated in this project, so what the gesture *decides*
 * is extracted and asserted directly. No DOM, no mutation of arguments.
 *
 * A note on coordinates: the caller converts the pointer to world space with
 * `screenToWorld` (the camera owns that maths) and passes rectangles from
 * `nodeRect`. This module never sees a `clientX`.
 *
 * @module canvas-connections
 */

import type { Point, Rect } from './studio-canvas.ts'

/* -------------------------------------------------------------------------- */
/* Phases                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Where a connection gesture is.
 *
 * `armed` exists so that a plain click on a handle — or a 2-px twitch — is not
 * a drag: the threshold is crossed in screen pixels, before any world-space
 * decision is made, because "did the pointer really move" is a question about
 * the screen, not about the board.
 */
export type ConnectionPhase = 'idle' | 'armed' | 'dragging' | 'hoverTarget' | 'blank'

/** How far, in screen pixels, the pointer must travel to become a drag. */
export const CONNECT_THRESHOLD = 4

/** A board node as this module needs it: identity plus geometry. */
export interface ConnectNode extends Rect {
  readonly id: string
}

/** One connection gesture, frozen. Every transition returns a new one. */
export interface ConnectionState {
  readonly phase: ConnectionPhase
  /** The node the wire is pulled from. */
  readonly sourceId: string
  /** World point the wire is anchored to — the source's output handle. */
  readonly anchor: Point
  /** Screen point of the pointer-down, kept for the {@link CONNECT_THRESHOLD} test. */
  readonly originScreen: Point
  /** Latest pointer position, in world units. */
  readonly point: Point
  /** Node under the pointer when it is a legal target; absent otherwise. */
  readonly targetId?: string
}

/** What a release means. */
export type DropResult =
  /** Over a legal node: draw the edge `toId.parents += sourceId`. Never generates. */
  | { readonly kind: 'edge'; readonly toId: string }
  /** On blank canvas: ask which node kind to create, at `worldPoint`. */
  | { readonly kind: 'menu'; readonly worldPoint: Point }
  /** Esc, a drag back onto the source, a click that never moved, or a cycle. */
  | { readonly kind: 'cancel' }

/** The output handle's world position: the right edge's midpoint. */
export function connectionAnchor(rect: Rect): Point {
  return { x: rect.x + rect.width, y: rect.y + rect.height / 2 }
}

/**
 * Press the output handle.
 *
 * The state stays `armed` — not `dragging` — until {@link updateConnection} sees
 * the pointer travel {@link CONNECT_THRESHOLD}. This is what makes a click on a
 * handle harmless: a click is not a drag, and a drag that never moved must not
 * conjure a node-type menu on top of the source.
 */
export function beginConnection(input: {
  readonly source: ConnectNode
  readonly point: Point
  readonly screen: Point
}): ConnectionState {
  return {
    phase: 'armed',
    sourceId: input.source.id,
    anchor: connectionAnchor(input.source),
    originScreen: input.screen,
    point: input.point,
  }
}

/**
 * The node a world point lands on, topmost first.
 *
 * Later nodes paint over earlier ones on this canvas (they share a stacking
 * context and only the selected node is lifted), so the *last* match is the one
 * the user can see. The source is excluded: a wire cannot end where it started.
 * Touching an edge does not count — the same positive-area rule the marquee
 * uses, so a pointer one pixel outside a node is blank canvas.
 */
export function nodeUnderPoint(
  nodes: readonly ConnectNode[],
  point: Point,
  excludeId?: string,
): ConnectNode | undefined {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (node.id === excludeId) continue
    if (!(point.x >= node.x && point.x <= node.x + node.width)) continue
    if (!(point.y >= node.y && point.y <= node.y + node.height)) continue
    return node
  }
  return undefined
}

/**
 * Follow the pointer.
 *
 * Three things happen here and nowhere else:
 *
 * - the threshold is applied in **screen** pixels, so the gesture feels the same
 *   at every zoom (a 4-px twitch at 0.1× is 40 world units — using world
 *   distance would have made the threshold zoom-dependent);
 * - the hovered node is resolved as a target, which is what turns the phase into
 *   `hoverTarget` and lets the view paint the snapping preview;
 * - a pointer that is over the source's own rectangle is `dragging`, not
 *   `blank`: the wire has been brought home, which cancels rather than offering
 *   to build something on top of its parent.
 */
export function updateConnection(
  state: ConnectionState,
  input: {
    readonly point: Point
    readonly screen: Point
    readonly nodes: readonly ConnectNode[]
  },
): ConnectionState {
  if (state.phase === 'idle') return state
  const dx = input.screen.x - state.originScreen.x
  const dy = input.screen.y - state.originScreen.y
  const travelled = Math.sqrt(dx * dx + dy * dy)
  // A release that never crossed the threshold is a cancel, and until it does
  // this is still `armed`: no preview line, no target, no menu.
  if (state.phase === 'armed' && !(travelled >= CONNECT_THRESHOLD)) {
    return { ...state, point: input.point }
  }
  const source = input.nodes.find((node) => node.id === state.sourceId)
  if (source !== undefined && containsPoint(source, input.point)) {
    return {
      phase: 'dragging',
      sourceId: state.sourceId,
      anchor: state.anchor,
      originScreen: state.originScreen,
      point: input.point,
    }
  }
  const target = nodeUnderPoint(input.nodes, input.point, state.sourceId)
  return {
    phase: target === undefined ? 'blank' : 'hoverTarget',
    sourceId: state.sourceId,
    anchor: state.anchor,
    originScreen: state.originScreen,
    point: input.point,
    ...(target === undefined ? {} : { targetId: target.id }),
  }
}

/** Whether a world point is inside (or on the boundary of) a rectangle. */
function containsPoint(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width
    && point.y >= rect.y && point.y <= rect.y + rect.height
}

/**
 * Whether `fromId` is an ancestor of `toId` (or the same node).
 *
 * Lineage is a DAG by intent — "this came from that" — and a wire drawn the
 * wrong way round would make it a cycle, which no reader of the board can
 * interpret: every picture would be its own ancestor, and the edge list would
 * no longer be a tree of provenance. Refusing the drop is the honest answer;
 * silently drawing the loop is not.
 *
 * Walks the parents lists breadth-first, tolerating a parent that is not on the
 * board (a cross-board reference) by simply not expanding it.
 */
export function reaches(nodes: readonly { readonly id: string; readonly parents: readonly string[] }[], fromId: string, goalId: string): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const seen = new Set<string>()
  const queue = [fromId]
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (id === goalId) return true
    if (seen.has(id)) continue
    seen.add(id)
    const node = byId.get(id)
    if (node === undefined) continue
    for (const parent of node.parents) queue.push(parent)
  }
  return false
}

/**
 * Decide what a release means (§the header's diagram).
 *
 * The wire points **from** the source **to** the target, so the target gains the
 * source as a parent:
 *
 * - `armed` — the pointer never moved: a click on a handle builds nothing.
 * - `dragging` — released back over the source node: the user is putting the
 *   wire back, so this cancels exactly like Esc.
 * - `blank` — empty canvas: ask which node kind to create there.
 * - `hoverTarget` — another node: draw the edge, unless that would close a
 *   lineage cycle ({@link reaches}) — a cycle exists exactly when the source
 *   already descends from the target, i.e. when walking up from the source
 *   arrives at the target.
 *
 * `state.point` is the release position. The caller refreshes it from the
 * pointerup event when the browser reports one; a release with no coordinates
 * keeps the last move's, which is what a click-then-release sends.
 */
export function resolveDrop(
  state: ConnectionState,
  nodes: readonly (ConnectNode & { readonly parents: readonly string[] })[],
): DropResult {
  if (state.phase === 'idle' || state.phase === 'armed') return { kind: 'cancel' }
  if (state.phase === 'dragging') return { kind: 'cancel' }
  const target = nodeUnderPoint(nodes, state.point, state.sourceId)
  if (target === undefined) return { kind: 'menu', worldPoint: { x: state.point.x, y: state.point.y } }
  if (reaches(nodes, state.sourceId, target.id)) return { kind: 'cancel' }
  return { kind: 'edge', toId: target.id }
}

/**
 * The node's parents with `parentId` appended, or the same array when it is
 * already there.
 *
 * Returning the argument itself is the "nothing changed" signal the view uses to
 * keep a no-op re-drop out of the undo stack; identity comparison is exact, and
 * the array is never mutated.
 */
export function linkParents(parents: readonly string[], parentId: string): readonly string[] {
  if (parentId.length === 0) return parents
  if (parents.includes(parentId)) return parents
  return [...parents, parentId]
}

/* -------------------------------------------------------------------------- */
/* Preview wire                                                                */
/* -------------------------------------------------------------------------- */

/** How far the control points reach out, matching `edgePath`'s own rule. */
function previewReach(dx: number): number {
  return Math.max(40, Math.abs(dx) * 0.45)
}

/** Round to the hundredth, the precision `studio-canvas.edgePath` writes. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * `<path d>` for the wire being dragged.
 *
 * Deliberately the same cubic as a committed edge (`edgePath`): a preview that
 * curved differently from the edge it becomes would jump on release, and the
 * whole point of the preview is "this is the edge you are about to make".
 *
 * The end point snaps to the **input** handle (left edge midpoint) of a hovered
 * target, so the wire visibly plugs in and the drop cannot be a surprise; over
 * blank canvas it ends at the pointer.
 */
export function previewPath(
  state: ConnectionState,
  nodes: readonly ConnectNode[],
): string | undefined {
  // `armed` and `idle` draw nothing: no wire appears until the pointer has
  // really moved, which keeps a plain click visually quiet.
  if (state.phase === 'idle' || state.phase === 'armed') return undefined
  const target = state.targetId === undefined ? undefined : nodes.find((node) => node.id === state.targetId)
  const end = target === undefined
    ? state.point
    : { x: target.x, y: target.y + target.height / 2 }
  const reach = previewReach(end.x - state.anchor.x)
  return 'M ' + String(round(state.anchor.x)) + ' ' + String(round(state.anchor.y)) +
    ' C ' + String(round(state.anchor.x + reach)) + ' ' + String(round(state.anchor.y)) +
    ', ' + String(round(end.x - reach)) + ' ' + String(round(end.y)) +
    ', ' + String(round(end.x)) + ' ' + String(round(end.y))
}

/* -------------------------------------------------------------------------- */
/* What a blank drop offers                                                    */
/* -------------------------------------------------------------------------- */

/** The three things a wire dropped on blank canvas can grow into. */
export const CONNECT_TARGETS = ['image', 'layout', 'asset'] as const
/** One choice of the drop menu. */
export type ConnectTarget = (typeof CONNECT_TARGETS)[number]

/** One entry of the node-type menu, in the shape the view's card renders. */
export interface ConnectTargetItem {
  /** Stable id the view maps to a handler. */
  readonly id: ConnectTarget
  /** Text the user reads. */
  readonly label: string
  /** §the menu's own copy of "what this will do". */
  readonly hint: string
  /** Known action whose owner has not landed. Rendered, not clickable. */
  readonly disabled?: boolean
}

/**
 * The menu a blank drop opens, as data.
 *
 * "放入素材" is present and `disabled` rather than omitted: the library lives in
 * another panel and picking from it mid-gesture would need a second surface, so
 * the honest state is "this is where it goes, it is not wired yet" — the same
 * stance `contextMenuItems` takes for its unfinished entries.
 */
export function connectMenuItems(): ConnectTargetItem[] {
  return [
    { id: 'image', label: '图片生成', hint: '在这里放一个待生成的节点，左侧表单的参考图自动填成来源节点' },
    { id: 'layout', label: '布局', hint: '建一个 MOSS 布局节点，血缘指向来源节点' },
    { id: 'asset', label: '放入素材', disabled: true, hint: '尚未接线：先在素材页选图，再 Ctrl+C / Ctrl+V 放到画布' },
  ]
}
