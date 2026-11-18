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
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
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
  applyNodeChanges,
  getBezierPath,
  useStore,
  type EdgeProps,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import {
  EMPTY_FLOW_DRAG,
  FLOW_EDGE_TYPE_LINEAGE,
  FLOW_MAX_ZOOM,
  FLOW_MIN_ZOOM,
  FLOW_NODE_TYPE_DRAFT,
  FLOW_NODE_TYPE_IMAGE,
  FLOW_NODE_TYPE_LAYOUT,
  FLOW_NODE_TYPE_TASK,
  FLOW_SOURCE_HANDLE,
  FLOW_TARGET_HANDLE,
  cameraFromFlow,
  fitWouldClamp,
  flowInteractionProps,
  flowNodeRects,
  foldDragChanges,
  reseedFlowNodes,
  toFlowModel,
  type FlowDragState,
  type FlowNodeSpec,
  type FlowSourceNode,
} from './canvas-flow-model.ts'
import {
  marqueeSelection,
  marqueeWorldRect,
  nodesInRect,
  selectionBounds,
  toggleSelection,
} from './canvas-interactions.ts'
import { clampZoom } from './studio-canvas.ts'
import type { Camera, Point } from './studio-canvas.ts'
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

/** What a right-click landed on, in the pane's own screen coordinates. */
export interface FlowContextRequest {
  /** Pixels from the canvas container's left edge. */
  readonly x: number
  /** Pixels from the canvas container's top edge. */
  readonly y: number
  /** The node under the pointer, or absent for the blank canvas. */
  readonly nodeId?: string
}

/**
 * What the studio can ask the canvas to do imperatively.
 *
 * The toolbar's 适应 / + / − buttons and the `F` shortcut used to drive the
 * studio's own camera state. React Flow owns the camera now, so those three
 * calls have exactly one implementation — here — and the studio reaches it
 * through this handle instead of mutating `camera` state nothing reads.
 */
export interface FlowCanvasApi {
  /** Frame every node; reports whether the zoom floor clipped the fit (G15). */
  readonly fitView: () => { readonly clamped: boolean }
  /** Multiply the zoom around the viewport centre. */
  readonly zoomBy: (factor: number) => void
  /** The camera React Flow is currently using, in the studio's convention. */
  readonly camera: () => Camera
  /** A viewport-relative point in world space. */
  readonly screenToWorld: (point: Point) => Point
}

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

  /* ---- U04 step 2: the gestures the hand-rolled canvas had --------------- */

  /**
   * Called **once per finished drag** with where the moved nodes ended up.
   *
   * Never per frame: React Flow emits a `position` change on every pointer move,
   * and the studio's write path is debounced at 700 ms for a reason. An empty map
   * means the gesture ended where it started, and nothing is written at all.
   */
  readonly onMoveNodes?: (positions: ReadonlyMap<string, Point>) => void
  /** Called on a right-click, with the node hit (if any) and where it happened. */
  readonly onContextMenu?: (request: FlowContextRequest) => void
  /**
   * The keyboard belongs to the studio's shortcut table (§6.3).
   *
   * Forwarded rather than reimplemented: `resolveShortcut` + the input/editor
   * yielding rule already live there, and a second copy in the pane is exactly
   * the double-handling this stage is meant to remove.
   */
  readonly onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  /** Space is a *held* modifier; releasing it hands the pointer back. */
  readonly onKeyUp?: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  /** Screen-space overlays (menu, board picker, lightbox) the studio owns. */
  readonly overlay?: ReactNode
  /** Sticky hand mode: a left-drag pans instead of drawing a marquee. */
  readonly panMode?: boolean
  /**
   * An OS file or a library card dragged over the canvas (§7.1/§7.3).
   *
   * Forwarded for the same reason the keyboard is: the studio owns the import
   * route and the board it lands on, so the pane only has to keep offering the
   * canvas as a drop target now that it is the thing covering it.
   */
  readonly onDragOver?: (event: ReactDragEvent<HTMLDivElement>) => void
  /** The drop that ends that drag. */
  readonly onDrop?: (event: ReactDragEvent<HTMLDivElement>) => void
  /**
   * The camera React Flow is now showing, after a pan or a zoom.
   *
   * The studio keeps the camera in its own state — the toolbar's zoom label and
   * the board's stored `camera` both read it — so the engine reports it rather
   * than leaving a second camera in the studio that nothing updates.
   */
  readonly onCameraChange?: (camera: Camera) => void
  /** Handed the imperative handle once React Flow is live, `undefined` on unmount. */
  readonly onApi?: (api: FlowCanvasApi | undefined) => void
}

/* -------------------------------------------------------------------------- */
/* Gesture plumbing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * How far the pointer must travel before a press becomes a marquee.
 *
 * A click that moves one pixel is still a click (and a click on blank canvas
 * means "clear the selection"), so the box only arms past a few pixels.
 */
export const MARQUEE_CLICK_SLOP = 3

/** The box a marquee paints, in screen pixels relative to the container. */
export interface MarqueeBox {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** Whether a pointer target is somewhere a keystroke should type, not act. */
function isTypingTarget(target: Element | null | undefined): boolean {
  if (target === null || target === undefined) return false
  if (typeof (target as Element).closest !== 'function') return false
  return target.closest('input, textarea, select, [contenteditable="true"], [data-dsh-layout-editor], .dsh-forge-flow-layout-host') !== null
}

/**
 * The board node id under a pointer target, if any.
 *
 * Two channels on purpose: the painters stamp `data-node-id` on the node's inner
 * element (the model's own id), and React Flow stamps `data-id` on the wrapper it
 * owns. The inner one is preferred because it is the id the studio knows; the
 * wrapper is the fallback for a click that landed on React Flow's chrome.
 */
function nodeIdUnder(target: EventTarget | null): string | undefined {
  if (target === null || target === undefined) return undefined
  const element = target as Element
  if (typeof element.closest !== 'function') return undefined
  const inner = element.closest('[data-node-id]') as HTMLElement | null
  if (inner !== null && typeof inner.dataset?.['nodeId'] === 'string' && inner.dataset['nodeId'].length > 0) {
    return inner.dataset['nodeId']
  }
  const wrapper = element.closest('.react-flow__node') as HTMLElement | null
  const id = wrapper === null ? undefined : wrapper.getAttribute('data-id')
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** The React Flow pane element, when the pointer went down on blank canvas. */
function paneElementOf(target: EventTarget | null): Element | undefined {
  if (target === null || target === undefined) return undefined
  const element = target as Element
  if (typeof element.closest !== 'function') return undefined
  const pane = element.closest('.react-flow__pane')
  // Only the pane itself is blank: a node, a handle or a control lives inside it.
  return pane !== null && pane === element ? pane : undefined
}

/**
 * The canvas: one React Flow instance over the board's nodes.
 *
 * The container is **measured** before the flow is mounted, and that is not a
 * detail: React Flow needs a viewport with a size to project the camera into, and
 * mounting it into an unsized element makes it render at 0×0 and then jump when
 * the first resize arrives. The placeholder below is what a user sees for one
 * frame; it is also what a DOM-less renderer sees, because there is nothing to
 * measure there (which is why the pane's own structure is asserted against the
 * model, and the *handlers* against this container — see
 * `test/canvas-flow-model.test.mjs`).
 *
 * ## Controlled, and who owns what
 *
 * The board's positions are the studio's: a drag paints from a local override
 * ({@link FlowCanvasProps.onMoveNodes} fires once, when the gesture ends) and the
 * studio writes them back after its own 700 ms debounce. Selection is the
 * studio's too: this component reports which ids a gesture picked
 * ({@link FlowCanvasProps.onSelect}) and paints whatever comes back, so the two
 * can never disagree about what is selected.
 *
 * The gestures themselves are in three places, and none of them is React Flow's:
 *
 * - **dragging** is the library's (`nodesDraggable`), because it is the one
 *   gesture whose feel is the library's whole point; the positions it produces
 *   are folded by {@link foldDragChanges} and committed once per gesture.
 * - **selection** (click, Ctrl/Cmd toggle, blank click, marquee, Shift-union) is
 *   this file's, using `src/canvas-interactions.ts` — the same state machine the
 *   DOM canvas used, not a second implementation.
 * - **the keyboard** is forwarded to the studio ({@link FlowCanvasProps.onKeyDown}),
 *   which owns `resolveShortcut` and the "yield inside a text field" rule.
 *
 * @param props - nodes, selection, the callbacks a gesture fires.
 * @returns the flow container.
 */
export function FlowCanvas(props: FlowCanvasProps): ReactNode {
  const hostRef = useRef<HTMLElement | null>(null)
  const flowRef = useRef<ReactFlowInstance | undefined>(undefined)
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 })
  // Positions of nodes a gesture is currently moving. Local on purpose: the
  // studio must not see a board write per frame (see the props' `onMoveNodes`).
  const [live, setLive] = useState<ReadonlyMap<string, Point>>(() => new Map<string, Point>())
  const [marqueeBox, setMarqueeBox] = useState<MarqueeBox | undefined>(undefined)
  const dragRef = useRef<FlowDragState>(EMPTY_FLOW_DRAG)
  const marqueeRef = useRef<{ readonly start: Point; readonly left: number; readonly top: number } | undefined>(undefined)
  // A marquee ends with the browser's own `click`; without this the pane's click
  // handler would immediately clear the selection the marquee just made.
  const suppressClickRef = useRef(false)
  // Latest props for the handlers React Flow keeps across renders.
  const latest = useRef(props)
  latest.current = props

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

  // The imperative handle dies with the flow: a studio that keeps calling it
  // after unmount must be a no-op, not a throw.
  useEffect(() => () => {
    flowRef.current = undefined
    latest.current.onApi?.(undefined)
  }, [])

  const selection = props.selection
  const locked = props.locked
  const model = useMemo(
    () => toFlowModel(props.nodes, selection === undefined ? {} : { selected: selection, locked }),
    [props.nodes, selection, locked],
  )

  const interaction = useMemo(
    () => flowInteractionProps({
      selectable: props.onSelect !== undefined,
      panMode: props.panMode === true,
      minZoom: FLOW_MIN_ZOOM,
      maxZoom: FLOW_MAX_ZOOM,
    }),
    [props.onSelect, props.panMode],
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
    () => reseedFlowNodes(model, live, dragRef.current.dragging)
      .map((node) => ({ ...node, data: { ...node.data, actions } })),
    [model, live, actions],
  )

  /**
   * One batch of React Flow's change stream.
   *
   * Per frame this only moves pixels: the positions are folded through the
   * library's own `applyNodeChanges` and kept in local state. The **commit** is
   * decided by {@link foldDragChanges}: it fires `onMoveNodes` exactly once, on
   * the change that carries `dragging: false`, and only if something moved. That
   * separation is the whole of the "no write per frame" rule.
   */
  const onNodesChange = (changes: NodeChange[]): void => {
    const touched = new Set<string>()
    for (const change of changes) {
      if (change.type === 'position' && change.position !== undefined) touched.add(change.id)
    }
    const base = new Map<string, Point>()
    for (const node of model.nodes) base.set(node.id, { x: node.position.x, y: node.position.y })
    const step = foldDragChanges(dragRef.current, base, changes as never)
    dragRef.current = step.state

    if (touched.size > 0) {
      // The library's fold, then only the positions are kept: the array it
      // returns is the node shape React Flow expects, and its positions are what
      // is painted until the studio's write comes back.
      const applied = applyNodeChanges(changes, flowNodes as never) as unknown as readonly FlowNodeSpec[]
      const index = new Map(applied.map((node) => [node.id, node.position]))
      const next = new Map<string, Point>()
      for (const [id, point] of step.state.live) {
        const position = index.get(id)
        next.set(id, position === undefined ? point : { x: position.x, y: position.y })
      }
      setLive(next)
    }

    if (step.moved.size > 0) latest.current.onMoveNodes?.(step.moved)
  }

  const onInit = (instance: ReactFlowInstance): void => {
    flowRef.current = instance
    const api: FlowCanvasApi = {
      fitView: () => {
        const bounds = selectionBounds(flowNodeRects(latest.current.nodes))
        const host = hostRef.current
        const viewport = {
          width: host === null ? 0 : (typeof host.clientWidth === 'number' ? host.clientWidth : 0),
          height: host === null ? 0 : (typeof host.clientHeight === 'number' ? host.clientHeight : 0),
        }
        // G15 re-asked for the new engine: React Flow clamps at `minZoom` too,
        // and "framed at 10 % with the far nodes still off-screen" must still be
        // reported rather than silently accepted.
        const clamped = fitWouldClamp(bounds, viewport, FLOW_MIN_ZOOM)
        void instance.fitView({ padding: 0.2, maxZoom: 1, duration: 0 })
        latest.current.onCameraChange?.(cameraFromFlow(instance.getViewport()))
        return { clamped }
      },
      zoomBy: (factor: number) => {
        const current = instance.getZoom()
        const target = clampZoom((Number.isFinite(current) && current > 0 ? current : 1) * factor)
        void instance.zoomTo(target, { duration: 0 })
        latest.current.onCameraChange?.(cameraFromFlow(instance.getViewport()))
      },
      camera: () => cameraFromFlow(instance.getViewport()),
      screenToWorld: (point: Point) => instance.screenToFlowPosition({ x: point.x, y: point.y }),
    }
    latest.current.onApi?.(api)
  }

  /* ---- pointer: marquee, focus and the click that follows it --------------- */

  const onContainerPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const host = hostRef.current
    const target = event.target as Element | null
    if (host !== null && !isTypingTarget(target)) {
      // The keyboard belongs to this container (§6.3's `tabIndex=0`); a click on
      // a node or on the blank canvas must hand it over, not leave focus on
      // whatever had it.
      try {
        host.focus({ preventScroll: true })
      } catch {
        // A focus failure must never swallow the gesture below.
      }
    }
    if (event.button !== 0) return
    // Hand mode pans instead (React Flow's own gesture), so no marquee.
    if (latest.current.panMode === true) return
    const pane = paneElementOf(event.target)
    if (pane === undefined) return
    if (typeof pane.getBoundingClientRect !== 'function') return
    const box = pane.getBoundingClientRect()
    const left = event.clientX - box.left
    const top = event.clientY - box.top
    marqueeRef.current = { start: { x: left, y: top }, left: box.left, top: box.top }
    suppressClickRef.current = false
    setMarqueeBox({ left, top, width: 0, height: 0 })
    const capture = (event.currentTarget as HTMLElement).setPointerCapture
    if (typeof capture === 'function') {
      try {
        capture.call(event.currentTarget, event.pointerId)
      } catch {
        // Capture is an optimisation; the container keeps receiving moves anyway.
      }
    }
  }

  const onContainerPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const gesture = marqueeRef.current
    if (gesture === undefined) return
    const x = event.clientX - gesture.left
    const y = event.clientY - gesture.top
    setMarqueeBox({
      left: Math.min(gesture.start.x, x),
      top: Math.min(gesture.start.y, y),
      width: Math.abs(x - gesture.start.x),
      height: Math.abs(y - gesture.start.y),
    })
  }

  /**
   * Release: turn the box into a selection, or hand the click back.
   *
   * The rectangle goes through `marqueeWorldRect` (the tested screen→world
   * conversion) and the hits through `nodesInRect`, so the marquee catches what
   * the *board* says is there, not what the culled render happened to paint.
   * A `Shift` release unions onto the selection the drag started with (§6.1).
   */
  const onContainerPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const gesture = marqueeRef.current
    if (gesture === undefined) return
    marqueeRef.current = undefined
    setMarqueeBox(undefined)
    const release = (event.currentTarget as HTMLElement).releasePointerCapture
    if (typeof release === 'function') {
      try {
        release.call(event.currentTarget, event.pointerId)
      } catch {
        // Not captured (a cancelled gesture): nothing to release.
      }
    }
    const x = event.clientX - gesture.left
    const y = event.clientY - gesture.top
    const moved = Math.abs(x - gesture.start.x) >= MARQUEE_CLICK_SLOP
      || Math.abs(y - gesture.start.y) >= MARQUEE_CLICK_SLOP
    if (!moved) return
    suppressClickRef.current = true
    const camera = flowRef.current === undefined ? undefined : cameraFromFlow(flowRef.current.getViewport())
    if (camera === undefined) return
    const world = marqueeWorldRect(camera, gesture.start, { x, y })
    // The whole board, not the culled subset: a marquee that sweeps past the
    // edge of the viewport must still catch what is there (§6.1).
    const hits = nodesInRect(flowNodeRects(latest.current.nodes), world)
    const current = latest.current.selection ?? new Set<string>()
    latest.current.onSelect?.([...marqueeSelection(current, hits, event.shiftKey === true)])
  }

  /* ---- selection: click, toggle, clear ------------------------------------ */

  const onPaneClick = (): void => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    latest.current.onSelect?.([])
  }

  const onNodeClick = (event: { readonly ctrlKey?: boolean; readonly metaKey?: boolean }, node: { readonly id: string }): void => {
    const current = latest.current.selection ?? new Set<string>()
    const additive = event.ctrlKey === true || event.metaKey === true
    latest.current.onSelect?.([...toggleSelection(current, node.id, additive)])
  }

  const onNodeDoubleClick = (_event: unknown, node: { readonly id: string; readonly data?: Record<string, unknown> }): void => {
    // G22: only a picture has something to look at.
    if (node.data?.['kind'] !== 'image') return
    latest.current.onOpen?.(node.id)
  }

  /* ---- right-click -------------------------------------------------------- */

  const openContextMenu = (event: { readonly clientX: number; readonly clientY: number; preventDefault?: () => void }, nodeId?: string): void => {
    event.preventDefault?.()
    const host = hostRef.current
    const box = host !== null && typeof host.getBoundingClientRect === 'function' ? host.getBoundingClientRect() : undefined
    latest.current.onContextMenu?.({
      x: event.clientX - (box === undefined ? 0 : box.left),
      y: event.clientY - (box === undefined ? 0 : box.top),
      ...(nodeId === undefined ? {} : { nodeId }),
    })
  }

  const measured = size.width > 0 && size.height > 0

  return createElement(
    'div',
    {
      className: 'dsh-forge-flow',
      ref: hostRef,
      // §6.3: the container owns the keyboard table, and the studio's handler is
      // forwarded rather than reimplemented.
      tabIndex: 0,
      'data-flow-size': `${String(size.width)}x${String(size.height)}`,
      ...(props.onKeyDown === undefined ? {} : { onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => { latest.current.onKeyDown?.(event) } }),
      ...(props.onKeyUp === undefined ? {} : { onKeyUp: (event: ReactKeyboardEvent<HTMLDivElement>) => { latest.current.onKeyUp?.(event) } }),
      onPointerDown: onContainerPointerDown,
      onPointerMove: onContainerPointerMove,
      onPointerUp: onContainerPointerUp,
      onPointerCancel: onContainerPointerUp,
      ...(props.onDragOver === undefined ? {} : { onDragOver: (event: ReactDragEvent<HTMLDivElement>) => { latest.current.onDragOver?.(event) } }),
      ...(props.onDrop === undefined ? {} : { onDrop: (event: ReactDragEvent<HTMLDivElement>) => { latest.current.onDrop?.(event) } }),
    },
    measured
      ? createElement(
          ReactFlow,
          {
            nodes: flowNodes,
            edges: model.edges,
            nodeTypes: FLOW_NODE_TYPES,
            edgeTypes: FLOW_EDGE_TYPES,
            ...interaction,
            onInit,
            onNodesChange,
            onNodeClick,
            onNodeDoubleClick,
            onPaneClick,
            onPaneContextMenu: (event: { readonly clientX: number; readonly clientY: number; preventDefault?: () => void }) => { openContextMenu(event) },
            onNodeContextMenu: (event: { readonly clientX: number; readonly clientY: number; preventDefault?: () => void }, node: { readonly id: string }) => { openContextMenu(event, node.id) },
            onMoveEnd: (_event: unknown, viewport: { readonly x: number; readonly y: number; readonly zoom: number }) => {
              latest.current.onCameraChange?.(cameraFromFlow(viewport))
            },
            zoomOnScroll: true,
            fitViewOptions: { padding: 0.2, maxZoom: 1 },
            proOptions: { hideAttribution: true },
          },
          createElement(CanvasBackground),
          model.nodes.length === 0
            ? createElement(
                'p',
                { className: 'dsh-forge-flow-hint' },
                '这个画板还是空的。生成的第一张图会落在这里；拖空白处框选，空格或中键平移，滚轮缩放。',
              )
            : null,
        )
      : createElement('p', { className: 'dsh-forge-flow-note', role: 'status' }, '画布准备中…'),
    marqueeBox === undefined
      ? null
      : createElement('div', {
          className: 'dsh-forge-marquee',
          'data-flow-marquee': 'on',
          style: {
            left: `${String(marqueeBox.left)}px`,
            top: `${String(marqueeBox.top)}px`,
            width: `${String(marqueeBox.width)}px`,
            height: `${String(marqueeBox.height)}px`,
          },
        }),
    // The studio's screen-space overlays (menu, board picker, lightbox) live in
    // here so they inherit the canvas's own coordinate system: the studio hands
    // them as one node, and both render paths use the same markup.
    props.overlay ?? null,
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
  const actions = actionsOf(data)
  const zoom = useFlowZoom()
  const selected = props.selected === true
  const nodeId = String(data['nodeId'] ?? props.id)
  return createElement(
    'div',
    {
      className: nodeClassName('image', selected),
      'data-node-kind': 'image',
      'data-node-id': nodeId,
      style: { '--dsh-forge-zoom': String(zoom) },
      title: String(data['title'] ?? ''),
      // G22: the lightbox opens on the picture itself. Both this and React
      // Flow's own `onNodeDoubleClick` lead to the same idempotent studio
      // callback, so a platform where one of the two does not fire still opens.
      onDoubleClick: () => { actions.onOpen?.(nodeId) },
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
