/**
 * The canvas tab's surface: React Flow draws the board, the studio keeps its
 * form.
 *
 * ## What changed in U04 step 1b
 *
 * The canvas used to be a hand-rolled `div` + `CSS transform` renderer inside
 * `src/studio-view.ts`: it computed every node's box, culled it against the
 * camera, drew edges into an `<svg>`, and owned pointer gestures. Step 1b hands
 * that job to **React Flow 12**, which owns the camera, the node wrappers, the
 * handles, the edges and the pan/zoom. What is left here is the part that is
 * genuinely this plugin's: which painter draws which node kind, what a lineage
 * wire is, and how the board's data becomes the `{ nodes, edges }` pair — the
 * last of which lives in `src/canvas-flow-model.ts` and is unit-tested without a
 * DOM.
 *
 * ## Why {@link CanvasPane} renders `StudioPanel` and not a bare canvas
 *
 * The tab has to own its board (§14.5: "画布页签换成 CanvasPane,传 boardId") *and*
 * keep the generation form, the result list, the asset page and the progress
 * line, which today all live in `src/studio-view.ts` — one component that also
 * hosts the canvas. Splitting that component is U05's job ("节点属性抽屉替代左半
 * 表单", D12), not this step's: doing it now would delete the only surface that
 * can start a generation, and there is no replacement for it yet.
 *
 * So the seam is placed at the canvas itself: `StudioPanel` gained a `canvas`
 * slot, this module supplies {@link FlowCanvas} for it, and `CanvasPane` is the
 * composition the shell mounts — tab-owned `boardId`, studio chrome, React Flow
 * canvas. When U05 lands, `CanvasPane` drops `StudioPanel` and renders
 * {@link FlowCanvas} next to the node inspector; the props below already have
 * that shape.
 *
 * ## Where interactions went
 *
 * Step 1b ships **rendering**: nodes, handles, edges, the background, and React
 * Flow's own pan/zoom/fit. Marquee selection, node dragging, wire dragging and
 * the keyboard table are S2/S3 work — the pure state machines behind them
 * (`src/canvas-interactions.ts`, `src/canvas-connections.ts`) are untouched and
 * still unit-tested, so the behaviour is not being rewritten, only re-attached.
 * Concretely, this file does **not** yet: persist node positions, open a node
 * on double click, or start a connection from a handle (`nodesConnectable` is
 * off, so the handle is a visible affordance instead of a half-wired gesture).
 *
 * @module canvas-pane
 */
import {
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  getBezierPath,
  useStore,
  type EdgeProps,
  type NodeProps,
} from '@xyflow/react'
import {
  FLOW_EDGE_TYPE_LINEAGE,
  FLOW_NODE_TYPE_DRAFT,
  FLOW_NODE_TYPE_IMAGE,
  FLOW_NODE_TYPE_LAYOUT,
  FLOW_NODE_TYPE_TASK,
  FLOW_SOURCE_HANDLE,
  FLOW_TARGET_HANDLE,
  toFlowModel,
  type FlowSourceNode,
} from './canvas-flow-model.ts'
import {
  draftToEditorState,
  mountLayoutEditor,
  stateToDraft,
  type LayoutDraft,
  type LayoutEditorHandle,
  type LayoutEditorState,
} from './layout-editor.ts'
import type { BoardLayoutDraft, BoardSummary } from './studio-shared.ts'
import { StudioPanel } from './studio-view.ts'

/* -------------------------------------------------------------------------- */
/* Composition                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Props of the canvas tab's surface.
 *
 * `boardId` is the tab's, not the host's: §14.5 is what makes a tab show *its*
 * project instead of whichever board the profile last had active. The rest is
 * carried for the U05 shape and stays optional so the shell can pass what it
 * has without inventing callbacks.
 */
export interface CanvasPaneProps {
  /** The board this tab owns; absent means "let the studio pick". */
  readonly boardId?: string
  /** The board library, for anything that names a project (§5). */
  readonly boards?: readonly BoardSummary[]
  /** Open one node's detail pane (U06). Unused until that pane exists. */
  readonly onOpenNode?: (boardId: string, nodeId: string) => void
}

/**
 * The canvas tab: the studio's chrome with the React Flow engine in its canvas.
 *
 * @param props - the tab's board and the shell's callbacks.
 * @returns the tab's tree.
 */
export function CanvasPane(props: CanvasPaneProps): ReactNode {
  return createElement(StudioPanel, { boardId: props.boardId, canvas: FlowCanvas })
}

/* -------------------------------------------------------------------------- */
/* The flow surface                                                           */
/* -------------------------------------------------------------------------- */

/** What the studio hands its canvas slot, and what {@link FlowCanvas} accepts. */
export interface FlowCanvasProps {
  /** The board's nodes, in board order (see `FlowSourceNode`). */
  readonly nodes: readonly FlowSourceNode[]
  /** Ids the caller paints as selected. */
  readonly selection?: ReadonlySet<string>
  /** Called with the ids React Flow reports selected; `[]` when cleared. */
  readonly onSelect?: (ids: readonly string[]) => void
  /** A layout node's draft changed in its embedded editor. */
  readonly onDraft?: (nodeId: string, draft: BoardLayoutDraft) => void
  /** Re-submit a failed task with the parameters it kept (§4.5). */
  readonly onRetry?: (nodeId: string) => void
  /** Interrupt a task in flight. */
  readonly onCancel?: (nodeId: string) => void
  /** Drop a node from the canvas (never deletes a file). */
  readonly onRemove?: (nodeId: string) => void
  /** Open a picture in the lightbox (G22); the studio owns that overlay. */
  readonly onOpen?: (nodeId: string) => void
  /** Compile a layout node's draft and generate from it (§8.1). */
  readonly onGenerateLayout?: (nodeId: string) => void
  /** Ids that may not be dragged yet (a task in flight stays put). */
  readonly locked?: ReadonlySet<string>
}

/**
 * The canvas: one React Flow instance over the board's nodes.
 *
 * The container is **measured** before the flow is mounted, and that is not a
 * detail: React Flow needs a viewport with a size to project the camera into,
 * and mounting it into an unsized element makes it render at 0×0 and then jump
 * when the first resize arrives. The placeholder below is what a user sees for
 * one frame; it is also what a DOM-less renderer sees, because there is nothing
 * to measure there (which is why the pane's own structure is asserted against
 * the model, not against this subtree — see the test note in
 * `test/canvas-flow-model.test.mjs`).
 *
 * @param props - nodes, selection and the callbacks a node may fire.
 * @returns the flow container.
 */
export function FlowCanvas(props: FlowCanvasProps): ReactNode {
  const hostRef = useRef<HTMLElement | null>(null)
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 })

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return undefined
    const measure = (): void => {
      const width = typeof host.clientWidth === 'number' ? host.clientWidth : 0
      const height = typeof host.clientHeight === 'number' ? host.clientHeight : 0
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }))
    }
    measure()
    if (typeof ResizeObserver !== 'function') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => {
      observer.disconnect()
    }
  }, [])

  const selection = props.selection
  const locked = props.locked
  const model = useMemo(
    () => toFlowModel(props.nodes, selection === undefined ? {} : { selected: selection, locked }),
    [props.nodes, selection, locked],
  )

  const actions = {
    onDraft: props.onDraft,
    onRetry: props.onRetry,
    onCancel: props.onCancel,
    onRemove: props.onRemove,
    onOpen: props.onOpen,
    onGenerateLayout: props.onGenerateLayout,
  }

  // The model is pure data; the handlers ride along in `data` because React
  // Flow keeps `data` opaque and a node component is the only reader.
  const flowNodes = useMemo(
    () => model.nodes.map((node) => ({ ...node, data: { ...node.data, actions } })),
    [model, actions],
  )

  const measured = size.width > 0 && size.height > 0

  return createElement(
    'div',
    {
      className: 'dsh-forge-flow',
      ref: hostRef,
      'data-flow-size': `${String(size.width)}x${String(size.height)}`,
    },
    measured
      ? createElement(
          ReactFlow,
          {
            nodes: flowNodes,
            edges: model.edges,
            nodeTypes: FLOW_NODE_TYPES,
            edgeTypes: FLOW_EDGE_TYPES,
            // Step 1b renders; S2/S3 attach the gestures. Nothing may move a
            // node's stored position until the write path exists.
            nodesDraggable: false,
            nodesConnectable: false,
            elementsSelectable: props.onSelect !== undefined,
            panOnDrag: true,
            zoomOnScroll: true,
            zoomOnDoubleClick: false,
            minZoom: 0.1,
            maxZoom: 8,
            fitView: true,
            fitViewOptions: { padding: 0.2, maxZoom: 1 },
            proOptions: { hideAttribution: true },
            ...(props.onSelect === undefined
              ? {}
              : {
                  onSelectionChange: ({ nodes: picked }: { nodes: readonly { id: string }[] }) => {
                    props.onSelect?.(picked.map((node) => node.id))
                  },
                }),
          },
          createElement(CanvasBackground),
          model.nodes.length === 0
            ? createElement(
                'p',
                { className: 'dsh-forge-flow-hint' },
                '这个画板还是空的。生成的第一张图会落在这里；滚轮缩放，拖空白处平移画布。',
              )
            : null,
        )
      : createElement('p', { className: 'dsh-forge-flow-note', role: 'status' }, '画布准备中…'),
  )
}

/* -------------------------------------------------------------------------- */
/* Node painters                                                              */
/* -------------------------------------------------------------------------- */

/** The zoom React Flow is currently applying, for screen-sized affordances. */
function useFlowZoom(): number {
  const zoom = useStore((state) => state.transform[2])
  return typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0 ? zoom : 1
}

/** The handlers a node may fire, as injected by {@link FlowCanvas}. */
interface FlowNodeActions {
  readonly onDraft?: (nodeId: string, draft: BoardLayoutDraft) => void
  readonly onRetry?: (nodeId: string) => void
  readonly onCancel?: (nodeId: string) => void
  readonly onRemove?: (nodeId: string) => void
  readonly onOpen?: (nodeId: string) => void
  readonly onGenerateLayout?: (nodeId: string) => void
}

/** Read `data.actions` without lying about its type. */
function actionsOf(data: Record<string, unknown>): FlowNodeActions {
  const value = data['actions']
  return typeof value === 'object' && value !== null ? (value as FlowNodeActions) : {}
}

/** Class list for one node's frame. */
function nodeClassName(kind: string, selected: boolean): string {
  return ['dsh-forge-flow-node', `is-${kind}`, selected ? 'is-selected' : ''].filter((part) => part.length > 0).join(' ')
}

/**
 * The two handles every node carries: output on the right, input on the left.
 *
 * A handle is drawn inside the zoomed viewport, so its pixel size is divided by
 * the zoom through `--dsh-forge-zoom` — the same trick the previous renderer used
 * (`G27`), kept because a 10-px dot at the 10 % floor is not a target.
 */
function NodeHandles(): ReactNode {
  return [
    createElement(Handle, {
      key: 'in',
      id: FLOW_TARGET_HANDLE,
      type: 'target',
      position: Position.Left,
      className: 'dsh-forge-flow-handle',
    }),
    createElement(Handle, {
      key: 'out',
      id: FLOW_SOURCE_HANDLE,
      type: 'source',
      position: Position.Right,
      className: 'dsh-forge-flow-handle',
    }),
  ]
}

/**
 * A finished picture: 512-px thumbnail, aspect-ratio width, prompt on top.
 *
 * The width comes from the model (`nodeDisplaySize`), so a panorama cannot
 * squeeze its neighbours and a tall strip cannot stretch the row — the same rule
 * the DOM renderer applied, now expressed as the node's own box.
 */
export function ImageFlowNode(props: NodeProps): ReactNode {
  const data = props.data as Record<string, unknown>
  const zoom = useFlowZoom()
  const selected = props.selected === true
  return createElement(
    'div',
    {
      className: nodeClassName('image', selected),
      'data-node-kind': 'image',
      'data-node-id': String(data['nodeId'] ?? props.id),
      style: { '--dsh-forge-zoom': String(zoom) },
      title: String(data['title'] ?? ''),
    },
    createElement('img', {
      className: 'dsh-forge-flow-thumb',
      src: String(data['thumbUrl'] ?? ''),
      alt: String(data['title'] ?? '生成结果'),
      draggable: false,
      loading: 'lazy',
      decoding: 'async',
    }),
    createElement('div', { className: 'dsh-forge-flow-title' }, String(data['title'] ?? '')),
    createElement('div', { className: 'dsh-forge-flow-meta' }, String(data['meta'] ?? '')),
    createElement(NodeHandles),
  )
}

/**
 * A generation task: state, parameters, progress and the two actions its state
 * justifies (§4.2/§4.5 — retry for a failure, cancel for one in flight).
 */
export function TaskFlowNode(props: NodeProps): ReactNode {
  const data = props.data as Record<string, unknown>
  const actions = actionsOf(data)
  const zoom = useFlowZoom()
  const status = String(data['status'] ?? 'idle')
  const percent = typeof data['percent'] === 'number' ? Math.round(data['percent']) : 0
  const failed = status === 'failed' || status === 'interrupted'
  const running = status === 'idle' || status === 'queued' || status === 'running'
  const nodeId = String(data['nodeId'] ?? props.id)
  return createElement(
    'div',
    {
      className: nodeClassName('task', props.selected === true),
      'data-node-kind': 'task',
      'data-node-id': nodeId,
      'data-task-status': status,
      style: { '--dsh-forge-zoom': String(zoom) },
    },
    createElement(
      'div',
      { className: 'dsh-forge-flow-task-head' },
      createElement(
        'span',
        { className: 'dsh-forge-flow-badge', 'data-task-status': status },
        String(data['badge'] ?? ''),
      ),
      createElement('span', { className: 'dsh-forge-flow-ratio' }, String(data['ratio'] ?? '1:1')),
    ),
    createElement(
      'div',
      { className: 'dsh-forge-flow-task-prompt', title: String(data['promptLine'] ?? '') },
      String(data['promptLine'] ?? ''),
    ),
    createElement('div', { className: 'dsh-forge-flow-task-meta' }, String(data['paramsText'] ?? '')),
    createElement(
      'div',
      {
        className: 'dsh-forge-flow-bar',
        role: 'progressbar',
        'aria-valuenow': percent,
        'aria-valuemin': 0,
        'aria-valuemax': 100,
      },
      createElement('i', { className: 'dsh-forge-flow-bar-fill', style: { width: `${String(percent)}%` } }),
    ),
    createElement('div', { className: 'dsh-forge-flow-task-status is-' + status }, String(data['statusText'] ?? '')),
    createElement(
      'div',
      { className: 'dsh-forge-flow-actions nodrag nopan' },
      failed ? createElement('button', { type: 'button', className: 'dsh-forge-flow-btn', onClick: () => { actions.onRetry?.(nodeId) } }, '重试') : null,
      running ? createElement('button', { type: 'button', className: 'dsh-forge-flow-btn', onClick: () => { actions.onCancel?.(nodeId) } }, '取消') : null,
      createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-forge-flow-btn is-danger',
          title: '从画布移除（不会删文件）',
          onClick: () => { actions.onRemove?.(nodeId) },
        },
        '移除',
      ),
    ),
    createElement(NodeHandles),
  )
}

/**
 * The MOSS layout editor, mounted into a node.
 *
 * `mountLayoutEditor` is imperative and DOM-bound, so it gets the same lifecycle
 * treatment the DOM renderer gave it: mount on node id change, destroy on
 * unmount, mirror an externally swapped draft (undo/redo) into the live editor,
 * and keep a throw local instead of unmounting the panel with it.
 *
 * The gestures are contained by the wrapper (`.nodrag .nopan .nowheel`):
 * without it, dragging a box inside the editor would pan the canvas instead.
 */
function LayoutEditorSlot(props: {
  readonly nodeId: string
  readonly draft: BoardLayoutDraft
  readonly onDraft?: (nodeId: string, draft: BoardLayoutDraft) => void
}): ReactNode {
  const hostRef = useRef<HTMLElement | null>(null)
  const editorRef = useRef<LayoutEditorHandle | undefined>(undefined)
  const latestRef = useRef(props)
  latestRef.current = props
  const appliedRef = useRef<BoardLayoutDraft>(props.draft)
  const [mountError, setMountError] = useState<string | undefined>(undefined)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return undefined
    const node = latestRef.current
    appliedRef.current = node.draft
    let editor: LayoutEditorHandle | undefined
    try {
      editor = mountLayoutEditor(host, {
        draft: node.draft as unknown as LayoutDraft,
        onChange: (state: LayoutEditorState) => {
          const draft = stateToDraft(state)
          appliedRef.current = draft
          latestRef.current.onDraft?.(latestRef.current.nodeId, draft)
        },
      })
      editorRef.current = editor
      setMountError(undefined)
    } catch (error) {
      setMountError(error instanceof Error ? error.message : String(error))
      return undefined
    }
    return () => {
      editorRef.current = undefined
      try {
        editor?.destroy()
      } catch {
        // A destroy failure must never run as an unhandled throw during unmount.
      }
    }
  }, [props.nodeId])

  useEffect(() => {
    const editor = editorRef.current
    if (editor === undefined) return
    if (appliedRef.current === props.draft) return
    appliedRef.current = props.draft
    try {
      editor.setState(draftToEditorState(props.draft as unknown as LayoutDraft))
    } catch (error) {
      setMountError(error instanceof Error ? error.message : String(error))
    }
  }, [props.draft])

  if (mountError !== undefined) {
    return createElement('div', { className: 'dsh-forge-flow-layout-error', title: mountError }, `布局编辑器加载失败：${mountError}`)
  }
  return createElement('div', { ref: hostRef, className: 'dsh-forge-flow-layout-host' })
}

/**
 * A layout draft as a node: a title bar that can generate from it, the editor
 * body, and a footnote carrying the draft's own size and box count.
 */
export function LayoutFlowNode(props: NodeProps): ReactNode {
  const data = props.data as Record<string, unknown>
  const actions = actionsOf(data)
  const zoom = useFlowZoom()
  const nodeId = String(data['nodeId'] ?? props.id)
  const draft = data['draft'] as BoardLayoutDraft | undefined
  const boxes = typeof data['boxes'] === 'number' ? data['boxes'] : 0
  const width = typeof data['width'] === 'number' ? data['width'] : 0
  const height = typeof data['height'] === 'number' ? data['height'] : 0
  return createElement(
    'div',
    {
      className: nodeClassName('layout', props.selected === true),
      'data-node-kind': 'layout',
      'data-node-id': nodeId,
      style: { '--dsh-forge-zoom': String(zoom) },
    },
    createElement(
      'div',
      { className: 'dsh-forge-flow-layout-head' },
      createElement('span', { className: 'dsh-forge-flow-layout-title' }, 'MOSS 布局'),
      createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-forge-flow-btn',
          title: '按布局生成：compiled 作为 MOSS 正向编码文本（仅 moss-sft）',
          onClick: () => { actions.onGenerateLayout?.(nodeId) },
        },
        '生成',
      ),
    ),
    createElement(
      'div',
      { className: 'dsh-forge-flow-layout-body nodrag nopan nowheel' },
      draft === undefined
        ? createElement('div', { className: 'dsh-forge-flow-layout-error' }, '草稿缺失')
        : createElement(LayoutEditorSlot, { nodeId, draft, onDraft: actions.onDraft }),
    ),
    createElement(
      'div',
      { className: 'dsh-forge-flow-layout-foot' },
      `${String(boxes)} 框 · ${String(width)}×${String(height)}`,
    ),
    createElement(NodeHandles),
  )
}

/** The placeholder a wire drop creates: it names what it is waiting for. */
export function DraftFlowNode(props: NodeProps): ReactNode {
  const data = props.data as Record<string, unknown>
  const zoom = useFlowZoom()
  return createElement(
    'div',
    {
      className: nodeClassName('draft', props.selected === true),
      'data-node-kind': 'draft',
      'data-node-id': String(data['nodeId'] ?? props.id),
      style: { '--dsh-forge-zoom': String(zoom) },
    },
    createElement('div', { className: 'dsh-forge-flow-draft-title' }, '待生成'),
    createElement('div', { className: 'dsh-forge-flow-draft-body' }, '写下提示词，图会落在这个位置'),
    createElement(NodeHandles),
  )
}

/** The painters React Flow dispatches on (`node.type`). */
export const FLOW_NODE_TYPES = {
  [FLOW_NODE_TYPE_IMAGE]: ImageFlowNode,
  [FLOW_NODE_TYPE_TASK]: TaskFlowNode,
  [FLOW_NODE_TYPE_LAYOUT]: LayoutFlowNode,
  [FLOW_NODE_TYPE_DRAFT]: DraftFlowNode,
}

/* -------------------------------------------------------------------------- */
/* The lineage edge                                                           */
/* -------------------------------------------------------------------------- */

/**
 * One derivation wire: a Bezier from the parent's output to the child's input.
 *
 * It replaces `edgePath` from `src/studio-canvas.ts` — same cubic, same anchors
 * (right edge → left edge) — because React Flow computes the endpoints from the
 * handles, which is what keeps an edge attached while a node moves. The label is
 * only drawn when the model supplied one (`edgeLabels`), and it is rendered
 * through `EdgeLabelRenderer` so it stays screen-sized instead of scaling with
 * the zoom.
 */
export function LineageEdge(props: EdgeProps): ReactNode {
  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition,
    curvature: 0.35,
  })
  const label = typeof props.data?.['label'] === 'string' ? props.data['label'] : ''
  return [
    createElement(BaseEdge, {
      key: 'path',
      id: props.id,
      path,
      className: 'dsh-forge-flow-edge',
      ...(props.markerEnd === undefined ? {} : { markerEnd: props.markerEnd }),
    }),
    label.length === 0
      ? null
      : createElement(
          EdgeLabelRenderer,
          { key: 'label' },
          createElement(
            'div',
            {
              className: 'dsh-forge-flow-edge-label',
              style: { transform: `translate(-50%, -50%) translate(${String(labelX)}px, ${String(labelY)}px)` },
            },
            label,
          ),
        ),
  ]
}

/** The painters React Flow dispatches an edge type on. */
export const FLOW_EDGE_TYPES = {
  [FLOW_EDGE_TYPE_LINEAGE]: LineageEdge,
}

/**
 * The dot background, exported so the pane can be rendered with it in tests and
 * so a future style change does not reach into the JSX above.
 *
 * React Flow draws it in its own SVG layer *below* the nodes, which is what the
 * previous CSS background was doing by hand.
 */
export function CanvasBackground(): ReactNode {
  return createElement(Background, {
    variant: BackgroundVariant.Dots,
    gap: 22,
    size: 1,
    className: 'dsh-forge-flow-background',
  })
}

/** Re-exported so a caller can build a node without importing the model. */
export type { FlowSourceNode }
