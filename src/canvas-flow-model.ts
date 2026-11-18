/**
 * The board's canvas, as React Flow data.
 *
 * ## Why this module exists on its own
 *
 * U04 step 1b replaces the hand-rolled canvas renderer with React Flow. The
 * renderer is the part that cannot be unit-tested here (it needs a real DOM, a
 * measured container and pointer capture), so the *decidable* half is split out
 * and kept free of the library: this file turns "the nodes a board holds" into
 * the `{ nodes, edges }` pair React Flow draws, using nothing but arithmetic and
 * the shared board types. `src/canvas-pane.ts` is then the only module that
 * imports `@xyflow/react`, and the mapping is asserted directly in
 * `test/canvas-flow-model.test.mjs`.
 *
 * ## What "the nodes a board holds" means here
 *
 * Deliberately a **structural** type ({@link FlowSourceNode}), not the studio's
 * private `CanvasNode` union: the same four shapes as `src/studio-view.ts` (a
 * picture, a generation task, a MOSS layout draft, and the placeholder a wire
 * drop creates), narrowed to the fields a node needs to draw itself. A structural
 * parameter keeps the direction of the dependency right — the pane describes what
 * it consumes, the studio satisfies it — and it is what lets the model stay
 * Node-importable while the studio component stays browser-only.
 *
 * ## What the model deliberately does not do
 *
 * No camera, no selection store, no viewport culling: React Flow owns the camera
 * (`fitView`, pan, zoom) and the viewport (`onlyRenderVisibleElements`), and
 * duplicating either would give two answers to the same question. Selection is
 * passed *in* ({@link FlowModelOptions.selected}) so a node's painted state and
 * the caller's notion of what is selected can never disagree.
 *
 * @module canvas-flow-model
 */
import { CANVAS_NODE_HEIGHT, CANVAS_NODE_WIDTH, nodeDisplaySize } from './studio-canvas.ts'
import type { Camera, Point, Rect } from './studio-canvas.ts'
import { CONNECT_THRESHOLD, nodeUnderPoint, reaches } from './canvas-connections.ts'
import type { ConnectNode } from './canvas-connections.ts'
import { clampLayoutNodeWidth, layoutNodeHeight } from './layout-editor.ts'
import {
  STUDIO_NODE_THUMB_WIDTH,
  studioFileUrl,
  type BoardLayoutDraft,
  type BoardTaskParams,
} from './studio-shared.ts'

/* -------------------------------------------------------------------------- */
/* What the pane is given                                                     */
/* -------------------------------------------------------------------------- */

/** §4.2's task states, as the canvas paints them. */
export type FlowTaskStatus = 'idle' | 'queued' | 'running' | 'done' | 'failed' | 'interrupted'

/** A finished picture on the board. */
export interface FlowImageSource {
  readonly kind: 'image'
  readonly id: string
  readonly x: number
  readonly y: number
  readonly parents: readonly string[]
  readonly image: {
    readonly markdownPath: string
    readonly width: number
    readonly height: number
    readonly bytes: number
  }
  /** Prompt that produced it; absent for an imported file. */
  readonly prompt?: string
}

/** A generation in flight, or one that ended without a picture. */
export interface FlowTaskSource {
  readonly kind: 'task'
  readonly id: string
  readonly x: number
  readonly y: number
  readonly parents: readonly string[]
  readonly status: FlowTaskStatus
  readonly params: BoardTaskParams
  readonly progress?: { readonly label?: string; readonly percent: number }
  readonly error?: string
}

/** A MOSS layout draft: the editor plus its display box (§8.1). */
export interface FlowLayoutSource {
  readonly kind: 'layout'
  readonly id: string
  readonly x: number
  readonly y: number
  readonly parents: readonly string[]
  readonly w: number
  readonly h: number
  readonly draft: BoardLayoutDraft
}

/** The placeholder a wire dropped on blank canvas creates (G26). */
export interface FlowDraftSource {
  readonly kind: 'draft'
  readonly id: string
  readonly x: number
  readonly y: number
  readonly parents: readonly string[]
}

/** Anything the pane can draw. */
export type FlowSourceNode = FlowImageSource | FlowTaskSource | FlowLayoutSource | FlowDraftSource

/* -------------------------------------------------------------------------- */
/* Node type names (React Flow dispatches on these)                           */
/* -------------------------------------------------------------------------- */

/** Custom node types, exactly as registered in `nodeTypes` by the pane. */
export const FLOW_NODE_TYPE_IMAGE = 'image'
export const FLOW_NODE_TYPE_TASK = 'task'
export const FLOW_NODE_TYPE_LAYOUT = 'layout'
export const FLOW_NODE_TYPE_DRAFT = 'draft'

/** The custom edge type: one lineage wire. */
export const FLOW_EDGE_TYPE_LINEAGE = 'lineage'

/* -------------------------------------------------------------------------- */
/* Node copy (moved here from the DOM renderer, see the module note)          */
/* -------------------------------------------------------------------------- */

/** How each task state reads on the badge. */
export const FLOW_TASK_BADGES: Readonly<Record<FlowTaskStatus, string>> = {
  idle: '待开始',
  queued: '排队中',
  running: '生成中',
  done: '已完成',
  failed: '失败',
  interrupted: '已中断',
}

/**
 * The one-line status under the progress bar.
 *
 * A running task names the step it is on when the stream said so, and the two
 * terminal states carry their reason, because "what went wrong" is the only
 * question that node exists to answer.
 */
export function taskStatusText(task: FlowTaskSource): string {
  const label = task.progress?.label
  switch (task.status) {
    case 'idle':
      return '等待提交'
    case 'queued':
      return '排队中'
    case 'running':
      return label === undefined || label.length === 0 ? '生成中…' : `生成中… ${label}`
    case 'done':
      return label === undefined || label.length === 0 ? '已完成' : `已完成（${label}）`
    case 'failed':
      return task.error === undefined || task.error.length === 0 ? '生成失败' : `失败：${task.error}`
    case 'interrupted':
      return task.error === undefined || task.error.length === 0 ? '已中断' : `已中断：${task.error}`
    default:
      return ''
  }
}

/**
 * Progress as a 0–100 integer.
 *
 * A finished task is 100 whatever the stream last said: the terminal state is
 * the authority, and a bar stuck at 87 % next to "已完成" reads as a bug.
 */
export function taskPercent(task: FlowTaskSource): number {
  if (task.status === 'done') return 100
  if (task.status === 'idle' || task.status === 'queued') return 0
  const percent = task.progress?.percent
  if (!Number.isFinite(percent)) return 0
  return Math.min(100, Math.max(0, Math.round(percent as number)))
}

/**
 * The buttons a task node's state justifies, in the order the painter draws them.
 *
 * U04 step 4: the set used to be an `if` chain inside the painter, where the only
 * way to check it was to render a node. It is the *same* chain — failed and
 * interrupted get 重试 + 编辑参数, anything still coming 取消, and 移除 always,
 * because "take it off the canvas" is never about the state — but as data it can
 * be asserted for all six states in `test/canvas-flow-model.test.mjs`, and the
 * painter's job becomes mapping four ids onto four handlers.
 *
 * `编辑参数` is the §4.5 edit-and-resend the DOM canvas has always offered: refill
 * the form with the failed task's own snapshot. The engine shipped without it in
 * step 1b, so a failure on the flow canvas had no way back to the prompt.
 */
export function taskNodeActions(status: FlowTaskStatus): readonly FlowTaskAction[] {
  switch (status) {
    case 'failed':
    case 'interrupted':
      return ['retry', 'edit', 'remove']
    case 'idle':
    case 'queued':
    case 'running':
      return ['cancel', 'remove']
    case 'done':
      return ['remove']
    default:
      // An unknown status is not a reason to offer a destructive action only by
      // accident: 移除 stays (the node is not going anywhere) and nothing else.
      return ['remove']
  }
}

/** One button a task node offers; the painter maps these onto its actions. */
export type FlowTaskAction = 'retry' | 'edit' | 'cancel' | 'remove'

/** First line of the prompt, which is the only name an unfinished task has. */
export function taskPromptLine(params: BoardTaskParams): string {
  const line = params.prompt.split('\n')[0]?.trim() ?? ''
  return line.length === 0 ? '（未填写提示词）' : line
}

/** The parameter summary under the prompt: ratio, steps, count, references. */
export function taskParamsText(params: BoardTaskParams): string {
  const parts: string[] = [params.ratio ?? '1:1']
  if (typeof params.steps === 'number' && Number.isFinite(params.steps)) parts.push(`${String(params.steps)} 步`)
  if (typeof params.count === 'number' && params.count > 1) parts.push(`${String(params.count)} 张`)
  if (typeof params.seed === 'number' && Number.isFinite(params.seed)) parts.push(`seed ${String(params.seed)}`)
  if (params.layout !== undefined && params.layout.length > 0) parts.push('布局')
  const references = params.references?.length ?? 0
  if (references > 0) parts.push(`${String(references)} 参考`)
  return parts.join(' · ')
}

/**
 * A picture's caption: its pixel size and file size, which is what a user
 * comparing two results actually looks at.
 */
export function imageMeta(image: FlowImageSource['image']): string {
  const kilobytes = Math.max(1, Math.round(image.bytes / 1024))
  return `${String(image.width)}×${String(image.height)} · ${String(kilobytes)} KB`
}

/** A picture's title: the prompt's first line, or the file name for an import. */
export function imageTitle(image: FlowImageSource['image'], prompt?: string): string {
  const line = prompt === undefined ? '' : (prompt.split(/\r?\n/, 1)[0] ?? '').trim()
  if (line.length > 0) return line
  const name = image.markdownPath.split(/[\\/]/).pop() ?? ''
  return name.length === 0 ? '图片' : name
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

/** Display size of one source node, in world units. */
export function nodeSizeOf(node: FlowSourceNode): { readonly width: number; readonly height: number } {
  if (node.kind === 'image') return nodeDisplaySize(node.image.width, node.image.height)
  if (node.kind === 'layout') {
    const width = clampLayoutNodeWidth(node.w)
    const height = Number.isFinite(node.h) && node.h > 0 ? node.h : layoutNodeHeight(width, node.draft)
    return { width, height }
  }
  return { width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT }
}

/* -------------------------------------------------------------------------- */
/* The model                                                                  */
/* -------------------------------------------------------------------------- */

/** One node as React Flow wants it. */
export interface FlowNodeData {
  readonly [key: string]: unknown
  /** Which painter this node belongs to; mirrors the node's `type`. */
  readonly kind: 'image' | 'task' | 'layout' | 'draft'
  /** Board item id, so a node component can report the thing it drew. */
  readonly nodeId: string
}

/** A React Flow node, structurally (kept local: the pane casts it). */
export interface FlowNodeSpec {
  readonly id: string
  readonly type: string
  readonly position: { readonly x: number; readonly y: number }
  readonly width: number
  readonly height: number
  readonly selected: boolean
  readonly draggable: boolean
  readonly data: FlowNodeData
}

/** A React Flow edge, structurally. */
export interface FlowEdgeSpec {
  readonly id: string
  readonly type: string
  readonly source: string
  readonly target: string
  readonly sourceHandle?: string
  readonly targetHandle?: string
  readonly data: { readonly label?: string }
}

/** The whole canvas, ready to hand to React Flow. */
export interface FlowModel {
  readonly nodes: readonly FlowNodeSpec[]
  readonly edges: readonly FlowEdgeSpec[]
  /** Node counts per kind — the empty-state copy and the tests both read this. */
  readonly counts: Readonly<Record<'image' | 'task' | 'layout' | 'draft', number>>
  /**
   * Parent ids a node names but the board no longer holds, in node order.
   *
   * Dropping the wire is right (an edge to nowhere cannot be drawn), but the
   * fact is reported instead of swallowed so a caller can decide what to say.
   */
  readonly danglingParents: readonly { readonly nodeId: string; readonly parentId: string }[]
}

/** Options the caller may steer. */
export interface FlowModelOptions {
  /** Ids the caller considers selected; painted onto the nodes. */
  readonly selected?: ReadonlySet<string>
  /**
   * Whether each lineage edge carries its kind as a label.
   *
   * Off by default: a board of twenty wires with twenty labels is unreadable at
   * the zoom levels a session is actually viewed at. On is for screenshots,
   * exports and the edge itself when it is selected.
   */
  readonly edgeLabels?: boolean
  /** Ids that may not be dragged (a task in flight stays put, §4.2). */
  readonly locked?: ReadonlySet<string>
}

/** The handle ids a node type exposes; mirrored by the pane's `Handle`s. */
export const FLOW_SOURCE_HANDLE = 'out'
export const FLOW_TARGET_HANDLE = 'in'

/** How an edge's label reads: what the child *is*, in terms of its parent. */
const EDGE_LABELS: Readonly<Record<FlowSourceNode['kind'], string>> = {
  image: '参考',
  task: '生成',
  layout: '布局',
  draft: '待生成',
}

/** The `data` payload of one node — the only thing its component reads. */
function dataOf(node: FlowSourceNode): FlowNodeData {
  if (node.kind === 'image') {
    return {
      kind: 'image',
      nodeId: node.id,
      title: imageTitle(node.image, node.prompt),
      thumbUrl: studioFileUrl(node.image.markdownPath, STUDIO_NODE_THUMB_WIDTH),
      originalUrl: studioFileUrl(node.image.markdownPath),
      meta: imageMeta(node.image),
      width: node.image.width,
      height: node.image.height,
      bytes: node.image.bytes,
    }
  }
  if (node.kind === 'task') {
    return {
      kind: 'task',
      nodeId: node.id,
      status: node.status,
      badge: FLOW_TASK_BADGES[node.status],
      ratio: node.params.ratio ?? '1:1',
      promptLine: taskPromptLine(node.params),
      paramsText: taskParamsText(node.params),
      percent: taskPercent(node),
      statusText: taskStatusText(node),
      ...(node.error === undefined ? {} : { error: node.error }),
    }
  }
  if (node.kind === 'layout') {
    return {
      kind: 'layout',
      nodeId: node.id,
      draft: node.draft,
      boxes: node.draft.items.length,
      width: node.draft.width,
      height: node.draft.height,
    }
  }
  return { kind: 'draft', nodeId: node.id }
}

/** The node type string for a source node. */
export function nodeTypeOf(node: FlowSourceNode): string {
  switch (node.kind) {
    case 'image':
      return FLOW_NODE_TYPE_IMAGE
    case 'task':
      return FLOW_NODE_TYPE_TASK
    case 'layout':
      return FLOW_NODE_TYPE_LAYOUT
    default:
      return FLOW_NODE_TYPE_DRAFT
  }
}

/**
 * Turn the nodes a board holds into the `{ nodes, edges }` pair React Flow draws.
 *
 * Deterministic: same input, same output, no clock and no ids minted here. An
 * edge is keyed `parent->child`, which is what makes two entries naming the same
 * parent collapse into one wire instead of drawing it twice — a board whose
 * `parents` were unioned by a retry (G26) would otherwise stack identical paths.
 *
 * A node keeps its place exactly as the board stored it: the world origin is the
 * pane's, not this function's business, and React Flow's `fitView` decides what
 * the visible window is.
 *
 * @param nodes - the board's nodes, in board order.
 * @param options - selection, labels and drag locking.
 * @returns the model, plus the counts and the parents that no longer resolve.
 */
export function toFlowModel(
  nodes: readonly FlowSourceNode[],
  options: FlowModelOptions = {},
): FlowModel {
  const selected = options.selected ?? new Set<string>()
  const locked = options.locked ?? new Set<string>()
  const known = new Set(nodes.map((node) => node.id))
  const counts = { image: 0, task: 0, layout: 0, draft: 0 }
  const flowNodes: FlowNodeSpec[] = []
  const flowEdges: FlowEdgeSpec[] = []
  const danglingParents: { nodeId: string; parentId: string }[] = []
  const seenEdges = new Set<string>()

  for (const node of nodes) {
    counts[node.kind] += 1
    const size = nodeSizeOf(node)
    flowNodes.push({
      id: node.id,
      type: nodeTypeOf(node),
      position: { x: node.x, y: node.y },
      width: size.width,
      height: size.height,
      selected: selected.has(node.id),
      draggable: !locked.has(node.id),
      data: dataOf(node),
    })
    for (const parentId of node.parents) {
      if (!known.has(parentId)) {
        danglingParents.push({ nodeId: node.id, parentId })
        continue
      }
      // A self-reference cannot be a derivation: drop it and say so.
      if (parentId === node.id) {
        danglingParents.push({ nodeId: node.id, parentId })
        continue
      }
      const edgeId = `${parentId}->${node.id}`
      if (seenEdges.has(edgeId)) continue
      seenEdges.add(edgeId)
      flowEdges.push({
        id: edgeId,
        type: FLOW_EDGE_TYPE_LINEAGE,
        source: parentId,
        target: node.id,
        sourceHandle: FLOW_SOURCE_HANDLE,
        targetHandle: FLOW_TARGET_HANDLE,
        data: options.edgeLabels === true ? { label: EDGE_LABELS[node.kind] } : {},
      })
    }
  }

  return { nodes: flowNodes, edges: flowEdges, counts, danglingParents }
}

/**
 * A stable fingerprint of what a model would draw, for "did anything change".
 *
 * Cheap on purpose (a string, not a diff): the pane recomputes the model on every
 * render, and re-seating React Flow's node array on every render is what makes a
 * canvas stutter. Comparing ids, positions, sizes, selection and the edge set is
 * enough to tell "same picture" from "repaint" without a deep walk.
 */
export function flowModelFingerprint(model: FlowModel): string {
  const parts = model.nodes.map(
    (node) =>
      `${node.id}:${node.type}:${String(node.position.x)},${String(node.position.y)}:${String(node.width)}x${String(node.height)}:${node.selected ? '1' : '0'}:${
        typeof node.data['status'] === 'string' ? node.data['status'] : ''
      }:${typeof node.data['percent'] === 'number' ? String(node.data['percent']) : ''}`,
  )
  parts.push('|')
  for (const edge of model.edges) parts.push(`${edge.id}>${edge.source ?? ''}->${edge.target}`)
  return parts.join(';')
}

/* -------------------------------------------------------------------------- */
/* Interaction glue (U04 step 2)                                              */
/* -------------------------------------------------------------------------- */
//
// Step 1b shipped a *renderer*: React Flow drew the board and nothing could move
// it. Step 2 re-attaches the gestures the hand-rolled canvas had. Everything a
// gesture *decides* is still a pure function — `src/canvas-interactions.ts` owns
// the marquee, the selection algebra and the undo stack — but React Flow speaks
// its own vocabulary (viewport transforms, `NodeChange` streams, interaction
// props), so the translation layer lives here and is asserted without a DOM.
//
// The three translations:
//
// 1. {@link cameraFromFlow} — React Flow's `{x, y, zoom}` transform into the
//    studio's camera convention, so `marqueeWorldRect` (already tested) is what
//    decides which nodes a marquee covers instead of a second copy of that maths.
// 2. {@link foldDragChanges} — a `NodeChange` stream into "where is this drag
//    now, and did it just end". One commit per gesture, not one per frame.
// 3. {@link flowInteractionProps} — the library knobs, in one place, so the keys
//    it would otherwise handle itself are provably off.

/** One node's world rectangle, in the shape the marquee hit-test takes. */
export interface FlowNodeRect extends Rect {
  readonly id: string
}

/**
 * Every node as a world rectangle.
 *
 * Input order is preserved (the model's order is the board's order), and the
 * sizes come from {@link nodeSizeOf} — the *displayed* box, not the picture's
 * pixel size, so a marquee catches what the user sees.
 */
export function flowNodeRects(nodes: readonly FlowSourceNode[]): FlowNodeRect[] {
  return nodes.map((node) => {
    const size = nodeSizeOf(node)
    return { id: node.id, x: node.x, y: node.y, width: size.width, height: size.height }
  })
}

/**
 * React Flow's viewport transform, expressed as the studio's camera.
 *
 * React Flow stores `screen = world * zoom + translate`; `./studio-canvas.ts`
 * stores "the world point at the viewport's top-left corner, plus the zoom"
 * (`world = screen / zoom + camera`). The two are the same camera written from
 * opposite ends, and this is the one place that conversion happens.
 *
 * A non-positive or non-finite zoom falls back to 1 rather than dividing by it:
 * a camera that cannot project should freeze the gesture, not return `Infinity`.
 */
export function cameraFromFlow(viewport: { readonly x: number; readonly y: number; readonly zoom: number }): Camera {
  const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1
  return { x: -viewport.x / zoom, y: -viewport.y / zoom, zoom }
}

/** One entry of React Flow's `NodeChange` stream, narrowed to what a drag says. */
export interface FlowDragChange {
  readonly id: string
  readonly type: string
  readonly position?: Point
  readonly dragging?: boolean
}

/** Where a drag is right now: where it started, where it is, what is moving. */
export interface FlowDragState {
  /** Positions captured when each id's drag was first observed. */
  readonly origins: ReadonlyMap<string, Point>
  /** Latest position per id, mid-gesture. */
  readonly live: ReadonlyMap<string, Point>
  /** Ids a gesture is currently moving. */
  readonly dragging: ReadonlySet<string>
}

/** The state a canvas with no gesture in flight is in. */
export const EMPTY_FLOW_DRAG: FlowDragState = {
  origins: new Map<string, Point>(),
  live: new Map<string, Point>(),
  dragging: new Set<string>(),
}

/** What one batch of `NodeChange`s means for the drag in flight. */
export interface FlowDragStep {
  /** The bookkeeping after this batch; feed it back with the next one. */
  readonly state: FlowDragState
  /** Ids whose drag ended in this batch (React Flow sent `dragging: false`). */
  readonly ended: readonly string[]
  /**
   * Positions to write back for `ended`, **only** for ids that actually moved.
   *
   * This is the 700 ms rule in one sentence: a gesture that ends where it began
   * produces an empty map, so the caller pushes no command and schedules no save.
   */
  readonly moved: Map<string, Point>
}

/**
 * Fold one batch of `NodeChange`s into the drag's bookkeeping.
 *
 * React Flow emits a `position` change **every frame** of a drag, and exactly one
 * of them carries `dragging: false` (the release). Doing anything durable per
 * frame would PUT the board sixty times a second, so this function's whole job is
 * to separate "the drag moved" from "the drag ended": the caller keeps the
 * positions for painting and calls its write path only when `moved` is non-empty.
 *
 * `base` supplies the position a node had before the gesture for ids the reducer
 * has not seen yet — the model's own positions. Nothing is mutated: both the
 * input state and the input changes are left alone, so a gesture can be replayed.
 *
 * Changes that are not position changes (selection, dimensions, remove) are
 * ignored on purpose: selection truth is the studio's, and `remove` is the
 * keyboard table's decision, not the mouse's.
 */
export function foldDragChanges(
  state: FlowDragState,
  base: ReadonlyMap<string, Point>,
  changes: readonly FlowDragChange[],
): FlowDragStep {
  const origins = new Map(state.origins)
  const live = new Map(state.live)
  const dragging = new Set(state.dragging)
  const ended: string[] = []

  for (const change of changes) {
    if (change === null || typeof change !== 'object') continue
    if (change.type !== 'position') continue
    const position = change.position
    if (position === undefined || position === null) continue
    const x = Number(position.x)
    const y = Number(position.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (!origins.has(change.id)) {
      const origin = base.get(change.id)
      origins.set(change.id, origin === undefined ? { x, y } : { x: origin.x, y: origin.y })
    }
    live.set(change.id, { x, y })
    if (change.dragging === true) {
      dragging.add(change.id)
    } else if (change.dragging === false && !ended.includes(change.id)) {
      // React Flow's own stream opens a gesture with `dragging: true` and closes
      // it with `dragging: false`; a gesture that began and ended inside one
      // batch therefore arrives closed, and must still commit.
      dragging.delete(change.id)
      ended.push(change.id)
    }
  }

  const moved = new Map<string, Point>()
  for (const id of ended) {
    const origin = origins.get(id)
    const now = live.get(id)
    if (origin !== undefined && now !== undefined && (origin.x !== now.x || origin.y !== now.y)) {
      moved.set(id, { x: now.x, y: now.y })
    }
    // The gesture is over: its bookkeeping must not leak into the next one.
    origins.delete(id)
    live.delete(id)
    dragging.delete(id)
  }

  return { state: { origins, live, dragging }, ended, moved }
}

/**
 * The node array React Flow should draw right now.
 *
 * The model is rebuilt from the studio's state on every render (a progress tick,
 * a retry, a selection change), so the array handed to the flow has to follow it
 * — except for the nodes a gesture is currently moving: rewriting those from the
 * model mid-drag would snap them back to their stored position every time the
 * server said "step 7 of 40". Only the in-flight positions survive a reseed;
 * everything else (status, badge, selection, size) always comes from the model.
 */
export function reseedFlowNodes(
  model: FlowModel,
  live: ReadonlyMap<string, Point>,
  dragging: ReadonlySet<string>,
): FlowNodeSpec[] {
  if (live.size === 0) return [...model.nodes]
  return model.nodes.map((node) => {
    if (!dragging.has(node.id)) return node
    const position = live.get(node.id)
    return position === undefined ? node : { ...node, position: { x: position.x, y: position.y } }
  })
}

/**
 * The node array React Flow should draw right now, with unchanged nodes reused.
 *
 * A progress tick re-derives the whole model (one task's `percent`/`statusText`
 * changed), and `reseedFlowNodes` faithfully returns *new objects* for every
 * node. React Flow keys its repaint on the node object, so that array means "the
 * whole board changed": every painter re-renders, every `img` re-checks its
 * `src`, and on a large board the canvas visibly stutters once per stream frame.
 *
 * So the reseed is followed by this: a node whose every drawn field is equal to
 * the one on screen keeps its **identity**, and only the node the tick was about
 * is new. `data` is compared key by key because that is what a painter reads —
 * the studio's action bundle is one stable object (see `FlowCanvas`), so a tick
 * that changes nothing about a node changes nothing about its `data` either.
 *
 * Only the array and the node objects are shared; nothing is mutated, so a caller
 * holding the previous array still sees the previous board.
 */
export function reuseFlowNodes(
  previous: readonly FlowNodeSpec[],
  next: readonly FlowNodeSpec[],
): FlowNodeSpec[] {
  if (previous.length === 0) return [...next]
  const known = new Map<string, FlowNodeSpec>()
  for (const node of previous) known.set(node.id, node)
  return next.map((node) => {
    const before = known.get(node.id)
    return before !== undefined && sameFlowNode(before, node) ? before : node
  })
}

/** Whether two node specs would paint the same pixels. */
function sameFlowNode(left: FlowNodeSpec, right: FlowNodeSpec): boolean {
  if (left === right) return true
  if (left.type !== right.type) return false
  if (left.position.x !== right.position.x || left.position.y !== right.position.y) return false
  if (left.width !== right.width || left.height !== right.height) return false
  if (left.selected !== right.selected || left.draggable !== right.draggable) return false
  const leftData = left.data as Record<string, unknown>
  const rightData = right.data as Record<string, unknown>
  if (leftData === rightData) return true
  const keys = Object.keys(leftData)
  if (keys.length !== Object.keys(rightData).length) return false
  for (const key of keys) {
    if (!Object.is(leftData[key], rightData[key])) return false
  }
  return true
}

/**
 * The props React Flow is configured with, as data.
 *
 * Kept here rather than inline in the JSX because these are the knobs whose
 * *absence* is invisible in a browser until it is a bug:
 *
 * - `nodesConnectable` — on since S3, and `connectionDragThreshold` set to the
 *   same {@link CONNECT_THRESHOLD} the pure state machine uses, so a click on a
 *   handle (or a twitch shorter than that) never becomes a wire. The rule lives
 *   in the library's own pointer-down path (`XYHandle`), which starts a
 *   connection only once the pointer has travelled further than this, so the
 *   "a click builds nothing" half of the cancel semantics is the library's.
 * - `deleteKeyCode` / `multiSelectionKeyCode` / `selectionKeyCode`: `null`.
 *   React Flow binds these itself (`Backspace` deletes, `Shift` marquees,
 *   `Ctrl`-click toggles) and this canvas has its own implementation of all
 *   three — in the pane's pointer handlers and in the studio's shortcut table.
 *   Leaving the defaults on would mean two handlers for one gesture: a Delete
 *   that removes a node twice, a Shift-marquee that replaces a selection the
 *   user asked to extend. `panActivationKeyCode` is deliberately *not* nulled:
 *   Space-to-pan has no second implementation, and React Flow's is the one that
 *   pans its own viewport.
 * - `selectionOnDrag: false` — the marquee is ours (§6.1's positive-area rule and
 *   its Shift-union), so the library must not draw a second one.
 * - `panOnDrag` — middle-drag pans, like the hand-rolled canvas, unless the
 *   toolbar's sticky hand mode is on, in which case a left-drag pans too.
 */
export interface FlowInteractionOptions {
  /** Whether a selection callback exists at all; drives `elementsSelectable`. */
  readonly selectable?: boolean
  /** Sticky hand mode (`panHeld`, or the toolbar toggle). */
  readonly panMode?: boolean
  readonly minZoom?: number
  readonly maxZoom?: number
}

/** The interaction subset of React Flow's props, structurally. */
export interface FlowInteractionProps {
  readonly nodesDraggable: boolean
  readonly nodesConnectable: boolean
  /** Screen pixels the pointer must travel before a handle press is a wire. */
  readonly connectionDragThreshold: number
  /**
   * Whether a *click* on a handle starts a wire too.
   *
   * Off: the gesture this canvas ships is a drag ("grab the dot, drag, let go"),
   * and React Flow's click-to-connect would be a second half-wired path — it
   * reports `onConnect` without the `onConnectStart`/`onConnectEnd` pair this
   * canvas plans the drop in, so a click-built edge would slip past the planner.
   */
  readonly connectOnClick: false
  readonly elementsSelectable: boolean
  readonly deleteKeyCode: null
  readonly multiSelectionKeyCode: null
  readonly selectionKeyCode: null
  readonly selectionOnDrag: false
  readonly panOnDrag: true | readonly number[]
  readonly zoomOnDoubleClick: false
  readonly minZoom: number
  readonly maxZoom: number
  readonly fitView: boolean
}

/** The library's default zoom floor and ceiling, mirrored from the DOM canvas. */
export const FLOW_MIN_ZOOM = 0.1
export const FLOW_MAX_ZOOM = 8

/**
 * The interaction props for one configuration.
 *
 * Selection is **off in the library** (`elementsSelectable`) and handled by the
 * pane: §6.1's Ctrl/Cmd toggle, the Shift-union marquee and "a blank click
 * clears" are one state machine (`src/canvas-interactions.ts`) and letting React
 * Flow run a second one would make the two disagree on the same click. Dragging
 * stays on: it is the library's own, and it is the gesture whose positions the
 * pane writes back.
 */
export function flowInteractionProps(options: FlowInteractionOptions = {}): FlowInteractionProps {
  const minZoom = Number.isFinite(options.minZoom) ? (options.minZoom as number) : FLOW_MIN_ZOOM
  const maxZoom = Number.isFinite(options.maxZoom) ? (options.maxZoom as number) : FLOW_MAX_ZOOM
  return {
    nodesDraggable: true,
    nodesConnectable: true,
    connectionDragThreshold: CONNECT_THRESHOLD,
    connectOnClick: false,
    elementsSelectable: options.selectable === true,
    deleteKeyCode: null,
    multiSelectionKeyCode: null,
    selectionKeyCode: null,
    selectionOnDrag: false,
    // `true` also suppresses `selectionOnDrag` inside the library, which is why
    // hand mode cannot accidentally leave a marquee armed.
    panOnDrag: options.panMode === true ? true : [1],
    zoomOnDoubleClick: false,
    minZoom,
    maxZoom,
    fitView: true,
  }
}

/**
 * The zoom a "fit every node" would need, before any clamp.
 *
 * `padding` is React Flow's own fraction-of-the-viewport padding (0.2 = 10 % on
 * each side). An empty board, or one with no size to speak of, returns
 * `Number.POSITIVE_INFINITY` — there is nothing to fit, and the caller's clamp
 * decision must not read "infinity is bigger than minZoom" as "fits".
 */
export function fitZoomFor(
  bounds: Rect | undefined,
  viewport: { readonly width: number; readonly height: number },
  padding = 0.2,
): number {
  if (bounds === undefined) return Number.POSITIVE_INFINITY
  const width = Math.max(1, viewport.width)
  const height = Math.max(1, viewport.height)
  const usable = 1 - 2 * Math.max(0, Math.min(0.45, padding))
  const zoomX = (width * usable) / Math.max(1, bounds.width)
  const zoomY = (height * usable) / Math.max(1, bounds.height)
  const zoom = Math.min(zoomX, zoomY)
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1
}

/**
 * Whether fitting the board would hit the zoom floor and leave nodes off-screen.
 *
 * This is G15's question, asked again for the new engine: React Flow clamps
 * `fitView` at `minZoom` exactly like `fitCamera` did, and the old implementation
 * answered the clamp with a note instead of silence. The pane calls this before
 * it fits, so the same note can be raised for the same reason.
 */
export function fitWouldClamp(
  bounds: Rect | undefined,
  viewport: { readonly width: number; readonly height: number },
  minZoom = FLOW_MIN_ZOOM,
  padding = 0.2,
): boolean {
  if (bounds === undefined) return false
  if (!Number.isFinite(minZoom) || minZoom <= 0) return false
  return fitZoomFor(bounds, viewport, padding) < minZoom
}

/* -------------------------------------------------------------------------- */
/* Where the canvas opens, and where 居中揭示 lands (U04 step 4)               */
/* -------------------------------------------------------------------------- */
//
// Two camera questions the engine owns but cannot answer alone, because both
// start from something only the studio knows:
//
// 1. **What a board opens at.** Step 1b mounted the flow with `fitView`, so a
//    board reopened framed instead of where it was left: the camera was being
//    *saved* on every pan and never read back. The stored camera is the studio's
//    (`board.camera`), so "restore that view, or frame instead" is decided here
//    as data and the pane hands the answer to React Flow's two — mutually
//    exclusive — props. That exclusion is the whole point of the shape: one
//    branch carries `defaultViewport` and the other carries `fitView`, never
//    both, because React Flow applies both on init and the second one wins, which
//    is a board opening twice in two places.
// 2. **Where 居中揭示 lands.** `revealNodeId` moved the studio's camera mirror,
//    and under the engine that mirror moves nothing — React Flow's viewport is
//    the only camera there is. The coordinates are the same arithmetic either
//    way (the centre of the node's box), so which camera to drive is a decision
//    and belongs here; the DOM fallback keeps driving its own.

/** One padding for every fit this canvas performs (10 % on each side). */
export const FLOW_FIT_OPTIONS = { padding: 0.2, maxZoom: 1 } as const

/**
 * A studio camera as React Flow's viewport transform — the inverse of
 * {@link cameraFromFlow}.
 *
 * `undefined` means "this camera cannot project": a non-finite offset, or a zoom
 * that is not positive. The caller must treat that as *no* stored view rather
 * than as a broken one — dividing by it or handing it to React Flow would put
 * every node at infinity. The zoom is clamped into the canvas's own band, so a
 * board stored at 0.02 reopens at the floor that can still be seen.
 */
export function flowViewportOf(
  camera: Camera | undefined | null,
): { readonly x: number; readonly y: number; readonly zoom: number } | undefined {
  if (camera === undefined || camera === null) return undefined
  const { x, y } = camera
  const zoom = camera.zoom
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
  if (!Number.isFinite(zoom) || zoom <= 0) return undefined
  const clamped = Math.min(FLOW_MAX_ZOOM, Math.max(FLOW_MIN_ZOOM, zoom))
  return { x: -x * clamped, y: -y * clamped, zoom: clamped }
}

/** How a board's canvas opens: at the view it was stored with, or framed. */
export type FlowInitialView =
  | { readonly kind: 'viewport'; readonly viewport: { readonly x: number; readonly y: number; readonly zoom: number } }
  | { readonly kind: 'fit' }

/**
 * The opening view for a stored camera.
 *
 * `undefined` (a board that never stored one, or a camera that cannot project)
 * is "frame the board"; anything else is "put the viewport back". The two are
 * exhaustive by construction — there is no third state, and no state in which
 * both happen.
 */
export function initialFlowView(camera: Camera | undefined | null): FlowInitialView {
  const viewport = flowViewportOf(camera)
  return viewport === undefined ? { kind: 'fit' } : { kind: 'viewport', viewport }
}

/**
 * The viewport half of React Flow's props for one opening view.
 *
 * Spread onto `<ReactFlow>`; the keys that are absent are the decision — a
 * restored board has no `fitView`, and a framed one has no `defaultViewport`.
 */
export interface FlowViewportProps {
  readonly fitView?: true
  readonly fitViewOptions?: { readonly padding: number; readonly maxZoom: number }
  readonly defaultViewport?: { readonly x: number; readonly y: number; readonly zoom: number }
}

/** {@link FlowViewportProps} for one opening view (see {@link initialFlowView}). */
export function flowViewportProps(view: FlowInitialView): FlowViewportProps {
  if (view.kind === 'fit') return { fitView: true, fitViewOptions: { ...FLOW_FIT_OPTIONS } }
  return { defaultViewport: { ...view.viewport } }
}

/** Which canvas a reveal request has to move. */
export type FlowRevealCanvas = 'flow' | 'dom' | 'none'

/** What a request to centre the canvas on one node resolves to. */
export type FlowRevealPlan =
  | { readonly kind: 'pending' }
  | { readonly kind: 'flow'; readonly center: Point; readonly zoom: number }
  | { readonly kind: 'dom'; readonly center: Point; readonly zoom: number }

/** What the studio knows when `revealNodeId` runs. */
export interface FlowRevealInput {
  /** The node's world rectangle; absent when the id is not on this board. */
  readonly rect?: Rect | undefined
  /** The mounted canvas: the engine, the DOM fallback, or neither yet. */
  readonly canvas: FlowRevealCanvas
  /** The zoom to keep while centring — the camera's current one. */
  readonly zoom: number
}

/**
 * Decide what "centre on this node" means right now (§7.4).
 *
 * `pending` is the state the studio already handles by remembering the id: the
 * node is not on the board yet, or the canvas has not mounted, and revealing it
 * later must still work. Otherwise the answer names the canvas to drive and the
 * world point to put in the middle, which is the same point for both engines: a
 * non-positive zoom falls back to 1 instead of centring at an unreadable scale.
 */
export function planReveal(input: FlowRevealInput): FlowRevealPlan {
  const rect = input.rect
  if (rect === undefined) return { kind: 'pending' }
  if (input.canvas === 'none') return { kind: 'pending' }
  const zoom = Number.isFinite(input.zoom) && input.zoom > 0 ? input.zoom : 1
  return {
    kind: input.canvas,
    center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    zoom,
  }
}

/* -------------------------------------------------------------------------- */
/* Connection planning (U04 step 3)                                           */
/* -------------------------------------------------------------------------- */
//
// The gesture this section decides is the one the canvas never had on the
// engine: grab the output dot, drag, let go. Where it lands is the whole of the
// rule —
//
//   over a picture          → the picture gains the source as a parent (an edge,
//                            and *nothing else*: no request, no new node)
//   over blank canvas       → ask which node kind to grow there
//   back over the source,   → cancel: nothing is built and nothing is undone
//   itself, or not a picture
//
// and the *decision* stays a pure function for the same reason every other
// gesture here does: React Flow's drag needs a real DOM, so what the drop means
// is extracted and asserted without one (`test/canvas-flow-model.test.mjs`).
// `src/canvas-pane.ts` owns only the coordinates (screen → flow) and the paint.
//
// The target rule is narrower than the DOM canvas's: a wire lands on a
// **picture** only. A lineage edge means "this was made from that picture", and
// a task, a layout draft or the placeholder a previous drop created have no file
// to be that picture — a target that cannot be referenced is a target that
// should not accept the wire.

/**
 * A board node as the connection layer needs it: box, lineage and kind.
 *
 * `parents` is what the cycle check walks and `kind` is what the "pictures only"
 * rule reads; the box is the same one the marquee hit-tests against, so a drop
 * lands on exactly the node the user sees.
 */
export interface FlowConnectNode extends ConnectNode {
  readonly parents: readonly string[]
  readonly kind: FlowSourceNode['kind']
}

/**
 * Every node in the shape a connection gesture needs.
 *
 * Sizes come from {@link nodeSizeOf} — the painted box, not the picture's pixel
 * size — for the same reason {@link flowNodeRects} does: the pointer lands on
 * what is drawn.
 */
export function connectionNodesOf(nodes: readonly FlowSourceNode[]): FlowConnectNode[] {
  return nodes.map((node) => {
    const size = nodeSizeOf(node)
    return {
      id: node.id,
      x: node.x,
      y: node.y,
      width: size.width,
      height: size.height,
      parents: node.parents,
      kind: node.kind,
    }
  })
}

/** The node kinds that can start a wire: a picture, or a layout draft. */
export const CONNECT_SOURCE_KINDS: readonly FlowSourceNode['kind'][] = ['image', 'layout']

/**
 * Whether a node kind may start a wire out of its output handle.
 *
 * A task in flight has no file yet and the placeholder is a promise about a
 * picture that does not exist, so neither can be a *provenance* of anything: the
 * handle is not rendered on them at all (see `NodeHandles` in `canvas-pane.ts`),
 * and this is the same list the tests assert.
 */
export function canStartConnection(kind: FlowSourceNode['kind']): boolean {
  return CONNECT_SOURCE_KINDS.includes(kind)
}

/** The kinds a wire may land on: a picture, and only a picture. */
export function canAcceptConnection(kind: FlowSourceNode['kind']): boolean {
  return kind === 'image'
}

/** Why a connection was refused; `ok` means it may be drawn. */
export type FlowConnectVerdict = 'ok' | 'missing' | 'self' | 'kind' | 'cycle'

/**
 * Whether `sourceId → targetId` is a legal lineage edge, and why not when it is
 * not.
 *
 * The two ids must both be on this board: a board's `parents` may name a node
 * that lives elsewhere (a cross-board reference is legal data), but a *wire* is
 * drawn between two things the user can see, and an id the model no longer holds
 * cannot be one of them. (The cycle walk itself only sees this board's parents,
 * so a cycle that runs through another board's node is out of scope for both the
 * check and the edge — the same limit `reaches` documents.)
 *
 * A cycle is refused rather than drawn: lineage is "this came from that", and a
 * loop makes every picture its own ancestor.
 */
export function judgeConnection(input: {
  readonly sourceId: string
  readonly targetId: string
  readonly nodes: readonly FlowConnectNode[]
}): FlowConnectVerdict {
  const source = input.nodes.find((node) => node.id === input.sourceId)
  const target = input.nodes.find((node) => node.id === input.targetId)
  if (source === undefined || target === undefined) return 'missing'
  if (source.id === target.id) return 'self'
  if (!canStartConnection(source.kind)) return 'kind'
  if (!canAcceptConnection(target.kind)) return 'kind'
  if (reaches(input.nodes, input.sourceId, input.targetId)) return 'cycle'
  return 'ok'
}

/**
 * The `isValidConnection` answer, as a boolean.
 *
 * React Flow asks this while the pointer is over a handle to decide whether the
 * wire looks valid, and it asks again on release before it reports `onConnect`.
 * Keeping one function behind both means the colour of the preview and the
 * legality of the drop cannot disagree.
 */
export function connectionIsValid(input: {
  readonly sourceId: string
  readonly targetId: string
  readonly nodes: readonly FlowConnectNode[]
}): boolean {
  return judgeConnection(input) === 'ok'
}

/** Why a release built nothing. */
export type FlowConnectCancel =
  /** The pointer never travelled {@link CONNECT_THRESHOLD}: a click, not a drag. */
  | 'idle'
  /** Released back over the node the wire came from: the user put it back. */
  | 'returned'
  /** Escape while the wire was in flight. */
  | 'escaped'
  | 'missing'
  | 'self'
  | 'kind'
  | 'cycle'

/** What releasing a wire means, decided without a browser. */
export type FlowConnectPlan =
  /** Draw `sourceId → toId` as lineage. No request is made. */
  | { readonly kind: 'edge'; readonly sourceId: string; readonly toId: string }
  /** Blank canvas: ask which node kind to grow at `worldPoint` (flow units). */
  | { readonly kind: 'menu'; readonly sourceId: string; readonly worldPoint: Point }
  /** Nothing is built, nothing is saved, nothing enters the undo stack. */
  | { readonly kind: 'cancel'; readonly sourceId: string; readonly reason: FlowConnectCancel }

/**
 * Decide what a released wire means.
 *
 * `point` is the release position **in flow units** — the caller converts the
 * browser's client coordinates with the engine's own `screenToFlowPosition`, so
 * this function never needs the camera. `travelled` is the threshold test; the
 * pane passes `true` because React Flow applies the very same threshold
 * (`connectionDragThreshold`) before it reports a connection at all, but the DOM
 * canvas calls this with its own pointer distance and gets the same rule.
 *
 * The order matters and is the cancel semantics:
 *
 * 1. a release that never moved is `idle` — a click on the handle;
 * 2. a release inside the **source's own box** is `returned`, checked before any
 *    hit test because `nodeUnderPoint` deliberately excludes the source and
 *    would otherwise call the same spot blank canvas and open a menu on top of
 *    the node the user just dragged from;
 * 3. no node under the point at all is `menu`;
 * 4. a node that fails {@link judgeConnection} is a cancel with its reason.
 */
export function planConnectionDrop(input: {
  readonly sourceId: string
  readonly point: Point
  readonly travelled: boolean
  readonly nodes: readonly FlowConnectNode[]
}): FlowConnectPlan {
  if (!input.travelled) return { kind: 'cancel', sourceId: input.sourceId, reason: 'idle' }
  const source = input.nodes.find((node) => node.id === input.sourceId)
  if (source === undefined) return { kind: 'cancel', sourceId: input.sourceId, reason: 'missing' }
  if (nodeUnderPoint([source], input.point) !== undefined) {
    return { kind: 'cancel', sourceId: input.sourceId, reason: 'returned' }
  }
  const target = nodeUnderPoint(input.nodes, input.point, input.sourceId)
  if (target === undefined) {
    return { kind: 'menu', sourceId: input.sourceId, worldPoint: { x: input.point.x, y: input.point.y } }
  }
  const verdict = judgeConnection({ sourceId: input.sourceId, targetId: target.id, nodes: input.nodes })
  if (verdict !== 'ok') return { kind: 'cancel', sourceId: input.sourceId, reason: verdict }
  return { kind: 'edge', sourceId: input.sourceId, toId: target.id }
}

/**
 * What the engine reports to the studio when a wire is released.
 *
 * `screen` is the release point **relative to the canvas container** — the same
 * origin the studio positions its cards in (`.dsh-forge-context`), because the
 * menu a blank drop opens has to appear under the pointer and must not scale
 * with the zoom. The plan itself carries flow units for the node it builds.
 */
export interface FlowConnectionEvent {
  readonly plan: FlowConnectPlan
  readonly screen: Point
}
