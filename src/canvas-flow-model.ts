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
