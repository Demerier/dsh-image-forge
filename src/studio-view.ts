/**
 * The Studio panel: a ComfyUI-backed Qwen-Image workbench rendered as a
 * first-class **global panel** of the web client.
 *
 * ## Where it is seated
 *
 * The layout shell's root-scoped `main` keyed slot holds the workbench, and a
 * `sidebar.panellist` entry (same id, {@link StudioPanelIcon} glyph, `图像工作台`
 * label) puts it in the left sidebar — both descriptors live in
 * `./settings-section.ts` and are wired up by the client entry. The plugin's
 * settings section is pure configuration now; it no longer carries this panel.
 *
 * The previous seat was the settings section (`settings.section`, a **list**
 * slot), chosen because the right sidebar's pane-tab seat belongs to
 * `@deepseek-ai/dsh-client-ui-sidebar-right`, which a profile does not
 * necessarily install. The global-panel slots are declared by the shell itself,
 * so the workbench is reachable from the sidebar without depending on an
 * optional profile package.
 *
 * ## What the canvas is now, and what it is still not
 *
 * The reference Studio ships a tldraw infinite canvas and a multi-provider
 * comparison grid. The canvas is not a wall of finished pictures any more: it is
 * where the work happens, with images, generation tasks and layout drafts as
 * first-class nodes and persisted lineage edges between them (the direction
 * change is written down as D6 in `docs/CANVAS-DESIGN.md`; the earlier note here
 * said a node was only ever a result, and that is no longer the contract).
 *
 * What is still not ported: tldraw itself. It is a ~1 MB client dependency, and
 * its shape system, drawing tools and collaboration model answer questions this
 * workbench does not ask — the camera arithmetic this file drives is pure,
 * unit-tested and already enough for pan/zoom/fit (§12 of the design). The
 * comparison grid is out too: this Studio intentionally has exactly one backend.
 *
 * Nor is this a Comfy-style parameter graph. Edges mean "this came from that" —
 * derivation, references, layouts — never "output A feeds input B of node C";
 * the generation request stays a form, not a wiring diagram, and the backend
 * (HTTP/MCP) is untouched by this canvas. The loop is still prompt → optimise →
 * ratio/steps/references → generate → inspect → reuse.
 *
 * ## State discipline
 *
 * One `useState` per concern, no derived state stored, and the generated image
 * list is the only thing that survives a re-render of the form. Every request
 * carries an `AbortController` so closing the panel does not leave a GPU busy
 * for a result nobody will see.
 *
 * @module studio-view
 */
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  buildEdges,
  clampZoom,
  edgePath,
  fitCamera,
  nextNodeSpot,
  nodeDisplaySize,
  nodeIndex,
  panBy,
  visibleEdges,
  visibleNodes,
  visibleWorldRect,
  zoomAt,
  zoomLabel,
  type Camera,
  type EdgeNode,
  type Point,
  type Rect,
  type Viewport,
} from './studio-canvas.ts'
import {
  STUDIO_ASSETS_ROUTE,
  STUDIO_BOARD_ROUTE,
  STUDIO_CONFIG_ROUTE,
  STUDIO_EVENTS_ROUTE,
  STUDIO_GENERATE_ROUTE,
  STUDIO_MAX_COUNT,
  STUDIO_MAX_PROMPT_CHARS,
  STUDIO_MAX_REFERENCES,
  STUDIO_OPTIMIZE_ROUTE,
  STUDIO_RATIOS,
  studioFileUrl,
  type BoardDetail,
  type BoardItem,
  type BoardSummary,
  type StudioAsset,
  type StudioAssetsResponse,
  type StudioConfigResponse,
  type StudioGenerateResponse,
  type StudioImage,
  type StudioOptimizeResponse,
  type StudioPromptStyle,
  type StudioProgressEvent,
  type StudioReferencePayload,
} from './studio-shared.ts'

/** One reference image held in the form, with its preview URL and wire payload. */
interface HeldReference {
  readonly id: string
  readonly name: string
  readonly previewUrl: string
  readonly payload: StudioReferencePayload
  /** Set when the reference came from the canvas, so the edge can be drawn. */
  readonly nodeId?: string
}

/**
 * One image on the canvas.
 *
 * Nodes are not just results any more. The canvas is where a session is worked
 * on, so the node kinds are picture, generation task and layout draft — one
 * union in `docs/CANVAS-DESIGN.md` §3.3, of which this build still produces
 * picture nodes; the task and layout kinds arrive with their own commits.
 *
 * `parents` is what makes the board graph-shaped: an edit made from another
 * result draws an edge back to it, so the lineage of a session stays readable.
 * Those edges record derivation, not parameters — this is deliberately not a
 * Comfy-style wiring graph, where an edge would mean "this output feeds that
 * input".
 */
interface CanvasNode {
  readonly id: string
  readonly image: StudioImage
  readonly batchId: string
  x: number
  y: number
  readonly parents: readonly string[]
}

/** A pointer gesture in progress; `null` when idle. */
type Gesture =
  | { kind: 'pan'; startX: number; startY: number; camera: Camera }
  | { kind: 'node'; id: string; startX: number; startY: number; origin: Point }

/**
 * World-space rectangle a node occupies.
 *
 * The width follows the picture's aspect ratio ({@link nodeDisplaySize}), so an
 * edge anchors on the right edge of *this* node rather than a shared constant,
 * and `nextNodeSpot` clears the widest neighbour instead of the default box. The
 * height stays constant: caption and actions live below the picture area.
 */
function nodeRect(node: CanvasNode): Rect {
  const size = nodeDisplaySize(node.image.width, node.image.height)
  return { x: node.x, y: node.y, width: size.width, height: size.height }
}

/**
 * One render item: a node paired with the world rectangle it occupies.
 *
 * Flattening the rectangle into the item keeps the culling and edge-building
 * passes in `studio-canvas.ts` free of any knowledge of `CanvasNode`, and lets
 * the visible set come back as these same objects — so the render never has to
 * look a node up again after filtering it.
 */
interface NodeView extends EdgeNode {
  readonly node: CanvasNode
}

/** A generated batch, kept so a previous result can be compared or reused. */
interface Batch {
  readonly id: string
  readonly response: StudioGenerateResponse
}

/**
 * Grid a board item lands on when it was never placed. Mirrors the host store:
 * `GRID_PITCH_X`/`GRID_PITCH_Y`/`GRID_ORIGIN` in `src/boards.ts`, which is the
 * authority — the numbers are restated here only because the canvas computes the
 * same fallback for an item whose stored position is missing. The X pitch is
 * `MAX_NODE_WIDTH (480) + 36` (DD16): a node is as wide as its picture allows,
 * so the pitch must clear the widest one or unplaced items overlap.
 */
function fallbackSpot(index: number): Point {
  return { x: 40 + (index % 3) * 516, y: 40 + Math.floor(index / 3) * 276 }
}

/** Turn stored board items into canvas nodes, keeping the saved arrangement. */
function nodesFromBoard(items: readonly BoardItem[]): CanvasNode[] {
  return items.map((item, index) => {
    const spot = fallbackSpot(index)
    return {
      id: item.id,
      image: {
        id: item.id,
        path: item.path,
        markdownPath: item.markdownPath,
        width: item.width,
        height: item.height,
        bytes: item.bytes,
        mediaType: item.mediaType,
      },
      batchId: item.batchId,
      x: item.x ?? spot.x,
      y: item.y ?? spot.y,
      parents: item.parents,
    }
  })
}

/**
 * Rebuild the list view from stored items.
 *
 * A board round-trips through JSON, so the list has to be reconstructed from
 * what each item kept: one batch per `batchId`, with the first item's prompt and
 * canvas standing in for the whole run (they are equal by construction — one
 * request writes one size, one step count, one prompt).
 */
function batchesFromBoard(items: readonly BoardItem[]): Batch[] {
  const grouped = new Map<string, BoardItem[]>()
  for (const item of items) {
    const list = grouped.get(item.batchId)
    if (list === undefined) grouped.set(item.batchId, [item])
    else list.push(item)
  }
  return [...grouped.entries()]
    .map(([id, list]) => {
      const first = list[0]
      return {
        id,
        response: {
          images: list.map((item) => ({
            id: item.id,
            path: item.path,
            markdownPath: item.markdownPath,
            width: item.width,
            height: item.height,
            bytes: item.bytes,
            mediaType: item.mediaType,
          })),
          prompt: first?.prompt ?? '',
          ratio: first?.ratio ?? '1:1',
          width: first?.width ?? 0,
          height: first?.height ?? 0,
          steps: first?.steps ?? 0,
          seed: first?.seed ?? 0,
          elapsedMs: 0,
          endpoint: '',
          mode: first?.mode ?? 'generate',
          // A stored item predates this field, and a replayed batch is not a live
          // run: nothing degrades here, so it is never reported as a fallback.
          turboFallback: false,
        },
      }
    })
    .reverse()
}

/** Read a JSON body defensively: a proxy error page is not JSON. */
async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = await response.json()
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Base64 of a file's bytes, without a data-URL prefix. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  // Chunked to stay well under the argument-count ceiling of `apply`.
  const step = 0x8000
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step))
  }
  return btoa(binary)
}

/** Container from a file's MIME type, falling back to its extension. */
function mediaTypeOf(file: File): string {
  if (file.type.startsWith('image/')) return file.type
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  return 'image/png'
}

/** Put a board back into the list after a write, keeping it newest-first. */
function upsertBoard(list: readonly BoardSummary[], board: BoardSummary): BoardSummary[] {
  return [board, ...list.filter((entry) => entry.id !== board.id)]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

/** One board mutation; resolves to the host's refusal message, if any. */
async function postBoard(body: Record<string, unknown>): Promise<string | undefined> {
  try {
    const response = await fetch(STUDIO_BOARD_ROUTE, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = await readJson(response)
    if (response.ok) return undefined
    return typeof payload?.error === 'string' ? payload.error : `画板操作失败（HTTP ${String(response.status)}）`
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
}

/** The props the sidebar slots hand a `sidebar.panellist` entry. */
interface StudioPanelIconProps {
  /** Rendered edge length in px (16 in the wide rail, 18 in the collapsed rail). */
  readonly size?: number
  /** Whether the panel is the selected one; the glyph stays monochrome either way. */
  readonly active?: boolean
}

/**
 * The left-sidebar glyph for the Studio panel.
 *
 * `sidebar.panellist` seats render one icon per global panel; the sidebar calls
 * the entry with `{ size, active }`. The glyph is stroke-based and paints with
 * `currentColor`, so it follows the rail's own hover/active colours instead of
 * carrying a palette of its own.
 *
 * @param props - the sidebar's `{ size, active }` render props.
 * @returns the glyph; a missing or non-finite `size` falls back to 18px.
 */
export function StudioPanelIcon(props?: StudioPanelIconProps): ReturnType<typeof createElement> {
  const size = typeof props?.size === 'number' && Number.isFinite(props.size) ? props.size : 18
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      focusable: 'false',
    },
    [
      createElement('rect', { key: 'frame', x: 1.8, y: 2.4, width: 12.4, height: 11.2, rx: 1.6 }),
      createElement('circle', { key: 'sun', cx: 5.4, cy: 6, r: 1.1 }),
      createElement('path', { key: 'ridge', d: 'M2.6 12.2l3.4-3.6 2.3 2.4 1.9-2.1 3.2 3.3' }),
    ],
  )
}

/** Live progress as the panel renders it: one value per SSE message. */
interface LiveProgress {
  /** What the run is doing, which is the part the user watches. */
  readonly phase: 'idle' | 'queued' | 'running' | 'done' | 'error' | 'interrupted'
  /**
   * The bridge's connection, deliberately separate from the run's phase: a run
   * that is already done keeps saying so after ComfyUI stops.
   */
  readonly bridge: 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
  /** ComfyUI tasks still queued, as of the last `status` frame. */
  readonly queue: number
  /** Step copy from the stream, e.g. `17/50` — printed verbatim. */
  readonly label?: string
  /** 0–100, already computed by the bridge. */
  readonly percent?: number
  /** Endpoint the bridge is connected to, for the status line. */
  readonly endpoint?: string
  /** Why the bridge is down or reconnecting. */
  readonly bridgeNote?: string
  /** Failure headline for `error`; never a traceback. */
  readonly message?: string
}

/** Before the first frame: waiting for the bridge, nothing running. */
const INITIAL_LIVE_PROGRESS: LiveProgress = { phase: 'idle', bridge: 'connecting', queue: 0 }

/**
 * Parse one SSE `data:` payload.
 *
 * The stream comes from this plugin, but a message is still untrusted input:
 * a malformed frame is dropped rather than allowed to throw inside a listener.
 *
 * @param raw - the `MessageEvent.data` value.
 * @returns the event, when the payload is a JSON object with a string `type`.
 */
function parseProgressEvent(raw: unknown): StudioProgressEvent | undefined {
  if (typeof raw !== 'string') return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const type = (value as { type?: unknown }).type
  return typeof type === 'string' ? value as StudioProgressEvent : undefined
}

/**
 * Fold one event from {@link STUDIO_EVENTS_ROUTE} into the panel's live state.
 *
 * Pure on purpose: the SSE listener only calls `setLive` with the result, so
 * the state machine can be read — and reasoned about — without a renderer. A
 * `queue` frame is the only one that can move the phase backwards, and only
 * from `queued`/`idle`: a finished run must not turn back into "waiting"
 * because a later broadcast says the queue is empty.
 *
 * @param current - the state before the event.
 * @param event - one normalized progress event.
 * @returns the next state.
 */
function reduceProgressEvent(current: LiveProgress, event: StudioProgressEvent): LiveProgress {
  switch (event.type) {
    case 'state':
      return {
        ...current,
        bridge: event.state === 'connected' ? 'connected' : event.state === 'connecting' ? 'connecting' : 'disconnected',
        ...(event.endpoint === undefined ? {} : { endpoint: event.endpoint }),
        ...(event.reason === undefined ? {} : { bridgeNote: event.reason }),
      }
    case 'queue': {
      // `queue_remaining` is broadcast for every queue change, including the
      // one after this run ended; only a run that has not started can be
      // "queued".
      const waiting = current.phase === 'idle' || current.phase === 'queued'
      return {
        ...current,
        queue: event.remaining,
        ...(waiting ? { phase: event.remaining > 0 ? 'queued' as const : 'idle' as const } : {}),
      }
    }
    case 'start':
      return { ...current, phase: 'running', label: undefined, percent: 0, message: undefined }
    case 'progress':
      return { ...current, phase: 'running', label: event.label, percent: event.percent, message: undefined }
    case 'done':
      return { ...current, phase: 'done', percent: 100, message: undefined }
    case 'error':
      return { ...current, phase: 'error', message: event.message }
    case 'interrupted':
      return { ...current, phase: 'interrupted', message: '已中断' }
    default:
      // `cached` and any future event type carry nothing the panel renders.
      return current
  }
}

/** The run-status line: what phase and step the panel should print. */
function progressStepText(live: LiveProgress): string {
  if (live.phase === 'running') return live.label === undefined ? '生成中…（等待第一步）' : `第 ${live.label} 步`
  if (live.phase === 'queued') {
    return live.queue > 0 ? `排队中 · 前面还有 ${String(live.queue)} 个任务` : '排队中…'
  }
  if (live.phase === 'done') return live.label === undefined ? '本次生成完成' : `本次生成完成（${live.label}）`
  if (live.phase === 'error') return `生成失败：${live.message ?? '未知错误'}`
  if (live.phase === 'interrupted') return '生成已中断'
  return '等待生成'
}

/**
 * The bridge line: connection state with a reason, never an endless spinner.
 *
 * A stopped ComfyUI is the case this copy is for — the panel must say what is
 * down and that generating over HTTP still works, instead of showing a frozen
 * step counter forever.
 */
function progressBridgeText(live: LiveProgress): string {
  if (live.bridge === 'connected') {
    return live.endpoint === undefined ? '实时进度已连接' : `实时进度已连接 · ${live.endpoint}`
  }
  if (live.bridge === 'reconnecting') return '实时进度连接中断，正在重连…'
  if (live.bridge === 'disconnected') {
    return `实时进度断开：${live.bridgeNote ?? 'ComfyUI 未连接'}（出图仍会走 HTTP，不影响本次生成）`
  }
  return '实时进度连接中…'
}

/**
 * Render the workbench.
 *
 * @returns the panel tree; every fetch is same-origin and cancellable.
 */
export function StudioPanel(): ReturnType<typeof createElement> {
  const [config, setConfig] = useState<StudioConfigResponse | undefined>(undefined)
  const [configError, setConfigError] = useState<string | undefined>(undefined)
  const [prompt, setPrompt] = useState('')
  const [ratio, setRatio] = useState<string>('1:1')
  const [steps, setSteps] = useState<string>('')
  const [count, setCount] = useState(1)
  const [references, setReferences] = useState<HeldReference[]>([])
  const [batches, setBatches] = useState<Batch[]>([])
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [optimizing, setOptimizing] = useState(false)
  const [note, setNote] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [optimizeNote, setOptimizeNote] = useState<string | undefined>(undefined)
  // Live progress from the plugin's same-origin SSE stream. The panel never
  // opens ComfyUI's own socket: Node subscribes to `/ws` and re-publishes
  // normalized events here (decision 4 in `docs/DIRECTION-ALIGNMENT.md`).
  const [live, setLive] = useState<LiveProgress>(INITIAL_LIVE_PROGRESS)
  // Rewriting convention: house prose (default) or the keyword formula. Kept
  // across optimise clicks, because trying both on the same idea is the point.
  const [promptStyle, setPromptStyle] = useState<StudioPromptStyle>('prose')
  // Canvas state: which view, the results placed on it, and the camera.
  const [view, setView] = useState<'canvas' | 'list' | 'assets'>('canvas')
  const [nodes, setNodes] = useState<CanvasNode[]>([])
  const [camera, setCamera] = useState<Camera>({ x: -28, y: -28, zoom: 1 })
  // Measured size of the canvas element. {0,0} until the first measurement,
  // which `visibleWorldRect` treats as "unbounded" — see the culling note below.
  const [viewport, setViewport] = useState<Viewport>({ width: 0, height: 0 })
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const gestureRef = useRef<Gesture | undefined>(undefined)
  // Latest pointer position and the one queued frame that will apply it (§10.3).
  const pointerRef = useRef<Point | undefined>(undefined)
  const frameRef = useRef<number | undefined>(undefined)
  // Board state: the library, the one on screen, and its rename editor.
  const [boards, setBoards] = useState<BoardSummary[]>([])
  const [boardId, setBoardId] = useState<string | undefined>(undefined)
  const [boardName, setBoardName] = useState('')
  const [boardBusy, setBoardBusy] = useState(false)
  const [boardError, setBoardError] = useState<string | undefined>(undefined)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  // Asset page: scope, filter and the flattened result.
  const [assetScope, setAssetScope] = useState<'board' | 'all'>('board')
  const [assetQuery, setAssetQuery] = useState('')
  const [assets, setAssets] = useState<StudioAsset[]>([])
  const [assetsTotal, setAssetsTotal] = useState(0)
  const [assetsBusy, setAssetsBusy] = useState(false)

  const abortRef = useRef<AbortController | undefined>(undefined)
  const referencesRef = useRef<HeldReference[]>([])
  referencesRef.current = references
  const nodesRef = useRef<CanvasNode[]>([])
  nodesRef.current = nodes
  const boardIdRef = useRef<string | undefined>(undefined)
  boardIdRef.current = boardId
  const cameraRef = useRef<Camera>(camera)
  cameraRef.current = camera
  const layoutTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  /** Read one board off the host and make it the canvas. */
  const openBoard = useCallback(async (id: string | undefined, signal?: AbortSignal) => {
    if (id === undefined) {
      setBoardId(undefined)
      setBoardName('')
      setNodes([])
      setBatches([])
      setSelectedId(undefined)
      setSelectedNodeId(undefined)
      return
    }
    setBoardBusy(true)
    try {
      const response = await fetch(`${STUDIO_BOARD_ROUTE}?board=${encodeURIComponent(id)}`, {
        credentials: 'same-origin',
        signal,
      })
      const payload = await readJson(response)
      if (!response.ok || payload === undefined || !Array.isArray(payload.items)) {
        setBoardError(typeof payload?.error === 'string' ? payload.error : '画板读取失败')
        return
      }
      const board = payload as unknown as BoardDetail
      const loaded = nodesFromBoard(board.items)
      setBoardId(board.id)
      setBoardName(board.name)
      setNodes(loaded)
      nodesRef.current = loaded
      const restored = batchesFromBoard(board.items)
      setBatches(restored)
      setSelectedId(restored[0]?.id)
      setSelectedNodeId(undefined)
      setCamera(board.camera ?? { x: -28, y: -28, zoom: 1 })
      setBoardError(undefined)
    } catch (cause) {
      if (signal?.aborted !== true) setBoardError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBoardBusy(false)
    }
  }, [])

  /** Load (or reload) the capability snapshot, and the board library with it. */
  const loadConfig = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(STUDIO_CONFIG_ROUTE, { credentials: 'same-origin', signal })
      const payload = await readJson(response)
      if (!response.ok || payload === undefined || !('ready' in payload)) {
        setConfigError(typeof payload?.error === 'string' ? payload.error : `工作台不可用（HTTP ${String(response.status)}）`)
        return
      }
      const snapshot = payload as unknown as StudioConfigResponse
      setConfig(snapshot)
      setConfigError(undefined)
      setBoards(snapshot.boards ?? [])
      setSteps((current) => (current.length > 0 ? current : String(snapshot.defaultSteps)))
      // The library is the display unit, so a snapshot always opens one: an
      // empty library means an empty canvas, not a stale one.
      await openBoard(snapshot.activeBoard ?? undefined, signal)
    } catch (cause) {
      if (signal?.aborted === true) return
      setConfigError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [openBoard])

  useEffect(() => {
    const controller = new AbortController()
    void loadConfig(controller.signal)
    return () => {
      controller.abort()
      if (layoutTimer.current !== undefined) clearTimeout(layoutTimer.current)
      // Revoke every preview URL the form still owns: a panel unmount must not
      // leak blob memory for images nobody can see any more.
      for (const reference of referencesRef.current) URL.revokeObjectURL(reference.previewUrl)
    }
  }, [loadConfig])

  // Subscribe to the live progress stream. This is an enhancement, never a
  // dependency: a host that cannot serve the stream, or a browser without
  // `EventSource`, still generates — it just cannot show the step counter.
  // The browser reconnects the stream on its own after a transient drop, so
  // the error listener only reports "not live right now"; the server-side
  // `state` events carry the real ComfyUI diagnosis.
  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      setLive((current) => ({ ...current, bridge: 'disconnected', bridgeNote: '当前环境不支持 EventSource' }))
      return undefined
    }
    const source = new EventSource(STUDIO_EVENTS_ROUTE)
    source.addEventListener('message', (event: { data?: unknown }) => {
      const parsed = parseProgressEvent(event.data)
      if (parsed !== undefined) setLive((current) => reduceProgressEvent(current, parsed))
    })
    source.addEventListener('error', () => {
      setLive((current) => ({ ...current, bridge: 'reconnecting' }))
    })
    return () => { source.close() }
  }, [])

  const selectedBatch = useMemo(
    () => batches.find((batch) => batch.id === selectedId) ?? batches[0],
    [batches, selectedId],
  )

  const sizeFor = useMemo(() => {
    const table = config?.sizes ?? []
    return (value: string) => table.find((entry) => entry.ratio === value)
  }, [config])

  /** Write the current arrangement back to the board. Best-effort. */
  const persistLayout = useCallback(async () => {
    const id = boardIdRef.current
    if (id === undefined) return
    const error = await postBoard({
      action: 'layout',
      board: id,
      items: nodesRef.current.map((node) => ({ id: node.id, x: node.x, y: node.y })),
      camera: cameraRef.current,
    })
    if (error !== undefined) setBoardError(error)
  }, [])

  /**
   * Coalesce layout saves.
   *
   * Dragging emits a pointer event per move; writing the board on every one
   * would be a JSON file per frame. 700 ms is short enough that closing the tab
   * right after a drag still lands, long enough that a whole drag is one write.
   */
  const scheduleLayout = useCallback(() => {
    if (layoutTimer.current !== undefined) clearTimeout(layoutTimer.current)
    layoutTimer.current = setTimeout(() => {
      layoutTimer.current = undefined
      void persistLayout()
    }, 700)
  }, [persistLayout])

  // A tab closed mid-drag still keeps the arrangement: flush on unmount.
  useEffect(() => () => {
    if (layoutTimer.current !== undefined) {
      clearTimeout(layoutTimer.current)
      void persistLayout()
    }
  }, [persistLayout])

  /** Switch boards: read it, then remember the choice server-side. */
  const selectBoard = useCallback(async (id: string) => {
    if (id === boardIdRef.current) return
    await openBoard(id)
    void postBoard({ action: 'active', board: id })
  }, [openBoard])

  /** Create an empty board and open it. */
  const createBoard = useCallback(async () => {
    const error = await postBoard({ action: 'create' })
    if (error !== undefined) {
      setBoardError(error)
      return
    }
    const response = await fetch(STUDIO_CONFIG_ROUTE, { credentials: 'same-origin' })
    const payload = await readJson(response)
    if (response.ok && payload !== undefined) {
      const snapshot = payload as unknown as StudioConfigResponse
      setBoards(snapshot.boards ?? [])
      await openBoard(snapshot.activeBoard ?? undefined)
    }
  }, [openBoard])

  /** Commit the rename editor. */
  const commitRename = useCallback(async () => {
    const id = boardIdRef.current
    const name = renameValue.trim()
    if (id === undefined || name.length === 0) {
      setRenaming(false)
      return
    }
    const error = await postBoard({ action: 'rename', board: id, name })
    if (error !== undefined) {
      setBoardError(error)
      return
    }
    setBoardName(name)
    setBoards((current) => current.map((board) => (board.id === id ? { ...board, name } : board)))
    setRenaming(false)
  }, [renameValue])

  /** Read the asset page for the current scope and filter. */
  const loadAssets = useCallback(async (signal: AbortSignal) => {
    setAssetsBusy(true)
    try {
      const params = new URLSearchParams()
      if (assetScope === 'board' && boardIdRef.current !== undefined) params.set('board', boardIdRef.current)
      if (assetQuery.trim().length > 0) params.set('q', assetQuery.trim())
      const response = await fetch(`${STUDIO_ASSETS_ROUTE}?${params.toString()}`, {
        credentials: 'same-origin',
        signal,
      })
      const payload = await readJson(response)
      if (!response.ok || payload === undefined || !Array.isArray(payload.assets)) {
        setBoardError(typeof payload?.error === 'string' ? payload.error : '素材读取失败')
        return
      }
      const page = payload as unknown as StudioAssetsResponse
      setAssets(page.assets)
      setAssetsTotal(page.total)
      setBoards(page.boards)
    } catch (cause) {
      if (!signal.aborted) setBoardError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setAssetsBusy(false)
    }
  }, [assetScope, assetQuery])

  useEffect(() => {
    if (view !== 'assets') return undefined
    const controller = new AbortController()
    // Typing in the filter should not fire one request per keystroke.
    const timer = setTimeout(() => { void loadAssets(controller.signal) }, 220)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [view, boardId, assetScope, assetQuery, loadAssets])

  /** Cancel whatever is in flight; safe to call when nothing is. */
  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = undefined
    setBusy(false)
    setOptimizing(false)
  }, [])

  /** Add picked files to the reference row, honouring the count cap. */
  const addReferences = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const picked = [...(event.target.files ?? [])]
    event.target.value = ''
    if (picked.length === 0) return
    void Promise.all(picked.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer())
      return {
        id: `${file.name}-${String(file.size)}-${String(Date.now())}-${Math.random().toString(36).slice(2, 7)}`,
        name: file.name,
        previewUrl: URL.createObjectURL(file),
        payload: { data: toBase64(bytes), mediaType: mediaTypeOf(file), name: file.name },
      } satisfies HeldReference
    })).then((added) => {
      setReferences((current) => {
        const room = STUDIO_MAX_REFERENCES - current.length
        if (room <= 0) {
          for (const reference of added) URL.revokeObjectURL(reference.previewUrl)
          setError(`最多 ${String(STUDIO_MAX_REFERENCES)} 张参考图`)
          return current
        }
        if (added.length > room) setError(`最多 ${String(STUDIO_MAX_REFERENCES)} 张参考图，多出的已忽略`)
        for (const reference of added.slice(room)) URL.revokeObjectURL(reference.previewUrl)
        return [...current, ...added.slice(0, room)]
      })
    })
  }, [])

  /** Drop one reference and free its preview URL. */
  const removeReference = useCallback((id: string) => {
    setReferences((current) => {
      const target = current.find((entry) => entry.id === id)
      if (target !== undefined) URL.revokeObjectURL(target.previewUrl)
      return current.filter((entry) => entry.id !== id)
    })
  }, [])

  /** Ask the conversation model to rewrite the prompt in place, keeping the original recoverable. */
  const optimize = useCallback(async () => {
    const text = prompt.trim()
    if (text.length === 0) {
      setError('先写一句你想要什么，再点优化。')
      return
    }
    setOptimizing(true)
    setError(undefined)
    setOptimizeNote(undefined)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const response = await fetch(STUDIO_OPTIMIZE_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: text,
          editing: references.length > 0,
          ratio,
          style: promptStyle,
        }),
      })
      const payload = await readJson(response)
      if (!response.ok || payload === undefined) {
        setError(typeof payload?.error === 'string' ? payload.error : '优化失败')
        return
      }
      const result = payload as unknown as StudioOptimizeResponse
      if (typeof result.prompt === 'string' && result.prompt.length > 0) setPrompt(result.prompt)
      const parts = [result.note, result.model === undefined ? undefined : `由 ${result.model} 改写`]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
      setOptimizeNote(parts.length > 0 ? parts.join(' · ') : undefined)
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setOptimizing(false)
      if (abortRef.current === controller) abortRef.current = undefined
    }
  }, [prompt, references.length, ratio, promptStyle])

  /** Run one generation with the form's current values. */
  const generate = useCallback(async () => {
    const text = prompt.trim()
    if (text.length === 0) {
      setError('请输入提示词')
      return
    }
    setBusy(true)
    setError(undefined)
    setNote(undefined)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const parsedSteps = steps.trim().length > 0 ? Number(steps) : undefined
      const response = await fetch(STUDIO_GENERATE_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: text,
          ratio,
          ...(parsedSteps === undefined || !Number.isFinite(parsedSteps) ? {} : { steps: parsedSteps }),
          count,
          ...(references.length > 0 ? { references: references.map((entry) => entry.payload) } : {}),
          ...(boardIdRef.current === undefined ? {} : { board: boardIdRef.current }),
        }),
      })
      const payload = await readJson(response)
      if (payload === undefined) {
        setError('生成失败：响应不是有效的 JSON')
        return
      }
      if (!Array.isArray(payload.images)) {
        setError(typeof payload.error === 'string' ? payload.error : '生成失败')
        return
      }
      const result = payload as unknown as StudioGenerateResponse
      const batch: Batch = { id: `${String(result.elapsedMs)}-${String(Date.now())}`, response: result }
      setBatches((current) => [batch, ...current].slice(0, 12))
      setSelectedId(batch.id)
      // A turbo request that degraded to the base weights is said out loud, in the
      // same one-line note as the size/steps/seed: the pictures look fine either
      // way, so without this the only clue is a slower click-to-image time.
      setNote(
        `${String(result.width)}×${String(result.height)} · ${String(result.steps)} 步 · seed ${String(result.seed)} · ${(result.elapsedMs / 1000).toFixed(1)} 秒` +
          (result.turboFallback === true ? ' · 本次按 base 权重出图，turbo 权重未安装' : ''),
      )

      // A run can create its board (first draw after an empty library), so the
      // header has to follow the host's answer rather than assume the one the
      // form was opened on.
      if (result.board !== undefined) {
        setBoards((current) => upsertBoard(current, result.board as BoardSummary))
        if (boardIdRef.current !== result.board.id) {
          setBoardId(result.board.id)
          setBoardName(result.board.name)
          boardIdRef.current = result.board.id
        }
      }

      // Place the fresh images on the canvas. Lineage is recorded from the
      // references that came from the canvas itself, which is what draws the
      // edge from "the image I edited" to "the image that came out".
      const parents = references
        .map((entry) => entry.nodeId)
        .filter((id): id is string => typeof id === 'string')
      const created: CanvasNode[] = []
      const next = [...nodesRef.current]
      result.images.forEach((image: StudioImage) => {
        const spot = nextNodeSpot(next.map(nodeRect))
        const node: CanvasNode = {
          // The board item id, not a client-side composite: the arrangement is
          // stored per item, so a node has to carry the identity the host knows.
          id: image.id,
          image,
          batchId: batch.id,
          x: spot.x,
          y: spot.y,
          parents,
        }
        created.push(node)
        next.push(node)
      })
      setNodes(next)
      nodesRef.current = next
      scheduleLayout()
      if (created[0] !== undefined) {
        const first = created[0]
        setSelectedNodeId(first.id)
        // Only move the view when the new node would land off-screen: a user
        // who zoomed out to survey the session should not be yanked back in.
        // The margins are the node's own, not a shared constant: a 16:9 result
        // is 356 wide and a 9:16 one 113, so a fixed box under- or over-counts
        // how much of it is already visible.
        const firstRect = nodeRect(first)
        const element = canvasRef.current
        if (element !== null) {
          const box = element.getBoundingClientRect()
          setCamera((current) => {
            const visible = {
              left: current.x,
              top: current.y,
              right: current.x + box.width / current.zoom,
              bottom: current.y + box.height / current.zoom,
            }
            const inside = first.x < visible.right - firstRect.width * 0.4
              && first.y < visible.bottom - firstRect.height * 0.4
              && first.y > visible.top - firstRect.height * 0.6
            return inside ? current : { zoom: current.zoom, x: first.x - 28, y: first.y - 28 }
          })
        }
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
      if (abortRef.current === controller) abortRef.current = undefined
    }
  }, [prompt, ratio, steps, count, references, scheduleLayout])

  /** Put a finished image's prompt and settings back into the form. */
  const reuse = useCallback((batch: Batch) => {
    setPrompt(batch.response.prompt)
    setRatio(batch.response.ratio)
    setSteps(String(batch.response.steps))
    setSelectedId(batch.id)
  }, [])

  // Wheel zoom is registered natively, not through `onWheel`: React attaches
  // wheel listeners passively, so `preventDefault` there is ignored and the
  // whole settings page scrolls while the canvas zooms.
  useEffect(() => {
    const element = canvasRef.current
    if (element === null || view !== 'canvas') return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const box = element.getBoundingClientRect()
      const anchor = { x: event.clientX - box.left, y: event.clientY - box.top }
      setCamera((current) => zoomAt(current, event.deltaY < 0 ? 1.12 : 1 / 1.12, anchor))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => { element.removeEventListener('wheel', onWheel) }
  }, [view])

  // Culling needs the viewport's size, which only the element knows. Measuring
  // it into state is what lets the render pass decide "on screen" before
  // building any DOM; the observer keeps it right across panel resizes.
  // `view` is a dependency because the canvas element only exists in canvas
  // view, and node/image loads do not resize this box.
  useEffect(() => {
    const element = canvasRef.current
    if (element === null || view !== 'canvas') return undefined
    const measure = (): void => {
      const box = element.getBoundingClientRect()
      setViewport((current) => (
        current.width === box.width && current.height === box.height
          ? current
          : { width: box.width, height: box.height }
      ))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => { window.removeEventListener('resize', measure) }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [view])

  /**
   * The board as rectangles, the edges between them, and what this frame shows.
   *
   * Two memos on purpose: `graph` (rects + the id index + the resolved edge
   * list) is rebuilt only when a node moves, while the visible subsets follow
   * the camera. Panning therefore never re-touches `parents` or re-looks-up a
   * parent — it only intersects rectangles.
   */
  const graph = useMemo(() => {
    const views: NodeView[] = nodes.map((node) => ({
      id: node.id,
      parents: node.parents,
      node,
      ...nodeRect(node),
    }))
    const index = nodeIndex(views)
    return { views, edges: buildEdges(views, index) }
  }, [nodes])

  const cullRect = useMemo(() => visibleWorldRect(camera, viewport), [camera, viewport])
  const shown = useMemo(() => visibleNodes(graph.views, camera, viewport), [graph, camera, viewport])
  const shownEdges = useMemo(() => visibleEdges(graph.edges, cullRect), [graph, cullRect])

  /** Frame every node; a no-op on an empty canvas so the view never jumps. */
  const fitView = useCallback(() => {
    const element = canvasRef.current
    if (element === null) return
    const box = element.getBoundingClientRect()
    setCamera(fitCamera(nodes.map(nodeRect), { width: box.width, height: box.height }))
    scheduleLayout()
  }, [nodes, scheduleLayout])

  const onCanvasPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    // Nodes start their own drag; anything else pans the view.
    if (target.closest('.dsh-forge-node') !== null) return
    event.currentTarget.setPointerCapture(event.pointerId)
    pointerRef.current = undefined
    gestureRef.current = { kind: 'pan', startX: event.clientX, startY: event.clientY, camera }
    setSelectedNodeId(undefined)
  }, [camera])

  const onNodePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, node: CanvasNode) => {
    if (event.button !== 0) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    setSelectedNodeId(node.id)
    pointerRef.current = undefined
    gestureRef.current = { kind: 'node', id: node.id, startX: event.clientX, startY: event.clientY, origin: { x: node.x, y: node.y } }
  }, [])

  /**
   * Apply the pointer position buffered by the latest move event.
   *
   * Both gesture kinds are computed from the *gesture start*, never from the
   * previous frame, so applying only the last position is exact: nothing
   * accumulates and the end position is the same whether one frame ran or sixty
   * (§10.3). The pending frame is cancelled here so a manual flush (pointerup)
   * cannot be followed by a second, stale one.
   */
  const flushPointer = useCallback(() => {
    if (frameRef.current !== undefined) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = undefined
    }
    const pointer = pointerRef.current
    pointerRef.current = undefined
    const gesture = gestureRef.current
    if (gesture === undefined || pointer === undefined) return
    if (gesture.kind === 'pan') {
      setCamera(panBy(gesture.camera, { x: pointer.x - gesture.startX, y: pointer.y - gesture.startY }))
      return
    }
    // Screen delta → world delta: the node must track the pointer at any zoom.
    const dx = (pointer.x - gesture.startX) / camera.zoom
    const dy = (pointer.y - gesture.startY) / camera.zoom
    setNodes((current) => current.map((node) => (
      node.id === gesture.id ? { ...node, x: gesture.origin.x + dx, y: gesture.origin.y + dy } : node
    )))
  }, [camera.zoom])

  /**
   * Buffer the pointer and let one animation frame apply it.
   *
   * A high-refresh pointer fires several `pointermove` events per frame; each
   * one used to be a full re-render (`setCamera`/`setNodes`). Coalescing them
   * keeps the work at one render per frame while the visible result is
   * unchanged, because the geometry is derived from the gesture origin.
   */
  const onCanvasPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (gestureRef.current === undefined) return
    pointerRef.current = { x: event.clientX, y: event.clientY }
    if (frameRef.current !== undefined) return
    frameRef.current = requestAnimationFrame(() => { flushPointer() })
  }, [flushPointer])

  const endGesture = useCallback(() => {
    const gesture = gestureRef.current
    if (gesture === undefined) {
      // A stray pointerup still cleans a queued frame from a gesture that was
      // cancelled elsewhere; nothing is left to apply.
      pointerRef.current = undefined
      if (frameRef.current !== undefined) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = undefined
      }
      return
    }
    // Flush before dropping the gesture: the release position is the one the
    // user chose, and a move that was still waiting for a frame must not be
    // lost — the saved arrangement has to match what the drag looked like.
    flushPointer()
    gestureRef.current = undefined
    // Both a drag and a pan moved something worth keeping: node positions in the
    // first case, the camera in both.
    scheduleLayout()
  }, [flushPointer, scheduleLayout])

  /** Hand a canvas result back to the form as an edit reference. */
  const referenceNode = useCallback((node: CanvasNode) => {
    setReferences((current) => {
      if (current.length >= STUDIO_MAX_REFERENCES) return current
      if (current.some((entry) => entry.nodeId === node.id)) return current
      const name = node.image.path.split('/').pop() ?? '参考图'
      return [...current, {
        id: `${node.id}-ref`,
        name,
        previewUrl: studioFileUrl(node.image.markdownPath),
        // `path` instead of base64: the browser never had these bytes, and the
        // host can read its own output without a round trip through the page.
        payload: { path: node.image.path, mediaType: node.image.mediaType, name },
        nodeId: node.id,
      }]
    })
  }, [])

  /** Zoom around the viewport centre, for the toolbar buttons. */
  const zoomBy = useCallback((factor: number) => {
    const element = canvasRef.current
    if (element === null) {
      setCamera((current) => ({ ...current, zoom: clampZoom(current.zoom * factor) }))
      scheduleLayout()
      return
    }
    const box = element.getBoundingClientRect()
    setCamera((current) => zoomAt(current, factor, { x: box.width / 2, y: box.height / 2 }))
    scheduleLayout()
  }, [scheduleLayout])

  /** Put one asset from the library into the reference row. */
  const referenceAsset = useCallback((asset: StudioAsset) => {
    setReferences((current) => {
      if (current.length >= STUDIO_MAX_REFERENCES) return current
      if (current.some((entry) => entry.path === asset.path)) return current
      const name = asset.path.split('/').pop() ?? '参考图'
      return [...current, {
        id: `${asset.id}-ref`,
        name,
        previewUrl: studioFileUrl(asset.markdownPath),
        payload: { path: asset.path, mediaType: asset.mediaType, name },
      }]
    })
  }, [])

  /** Open the board an asset lives on and select it there. */
  const showOnCanvas = useCallback(async (asset: StudioAsset) => {
    if (boardIdRef.current !== asset.boardId) await selectBoard(asset.boardId)
    setView('canvas')
    setSelectedNodeId(asset.id)
  }, [selectBoard])

  /**
   * Drop one asset from its board.
   *
   * The default is "unplace", not "delete": the PNG is the expensive artifact
   * and every removal here is one click away from being irreversible. Deleting
   * the file is a second, explicitly labelled action.
   */
  const removeAsset = useCallback(async (asset: StudioAsset, deleteFile: boolean) => {
    const error = await postBoard({
      action: 'remove-item',
      board: asset.boardId,
      item: asset.id,
      ...(deleteFile ? { deleteFile: true } : {}),
    })
    if (error !== undefined) {
      setBoardError(error)
      return
    }
    setAssets((current) => current.filter((entry) => entry.id !== asset.id))
    setAssetsTotal((total) => Math.max(0, total - 1))
    const dropFromNodes = (current: CanvasNode[]): CanvasNode[] => current.filter((node) => node.id !== asset.id)
    setNodes(dropFromNodes)
    nodesRef.current = dropFromNodes(nodesRef.current)
    setBatches((current) => current
      .map((batch) => ({
        ...batch,
        response: {
          ...batch.response,
          images: batch.response.images.filter((image) => image.id !== asset.id),
        },
      }))
      .filter((batch) => batch.response.images.length > 0))
    setSelectedNodeId((current) => (current === asset.id ? undefined : current))
    setReferences((current) => current.filter((entry) => !(entry.payload.path === asset.path)))
  }, [])

  const removeNode = useCallback((id: string) => {
    setNodes((current) => current.filter((node) => node.id !== id))
    nodesRef.current = nodesRef.current.filter((node) => node.id !== id)
    setReferences((current) => current.filter((entry) => entry.nodeId !== id))
    setSelectedNodeId((current) => (current === id ? undefined : current))
    const board = boardIdRef.current
    if (board === undefined) return
    void postBoard({ action: 'remove-item', board, item: id }).then((error) => {
      if (error !== undefined) setBoardError(error)
    })
  }, [])

  const ready = config?.ready === true
  const canGenerate = ready && !busy && prompt.trim().length > 0

  /**
   * The asset page: one grid over every image the plugin has recorded, with the
   * three actions that matter after the fact — reuse it as a reference, jump to
   * it on its canvas, or take it out of the library.
   */
  const assetsPanel = createElement(
    'div',
    { className: 'dsh-forge-assets' },
    createElement(
      'div',
      { className: 'dsh-forge-assets-bar' },
      createElement(
        'div',
        { className: 'dsh-forge-view-toggle', role: 'group', 'aria-label': '素材范围' },
        ...([
          ['board', '本画板'],
          ['all', '全部画板'],
        ] as const).map(([value, label]) => createElement(
          'button',
          {
            key: value,
            type: 'button',
            className: assetScope === value ? 'dsh-forge-view-item is-active' : 'dsh-forge-view-item',
            'aria-pressed': assetScope === value,
            onClick: () => { setAssetScope(value) },
          },
          label,
        )),
      ),
      createElement('input', {
        className: 'dsh-forge-assets-search',
        value: assetQuery,
        placeholder: '搜提示词、文件名或画板名',
        onChange: (event: ChangeEvent<HTMLInputElement>) => { setAssetQuery(event.target.value) },
      }),
      createElement('span', { className: 'dsh-forge-batch-meta' }, `${String(assetsTotal)} 张`),
      createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-forge-btn is-ghost',
          onClick: () => {
            const controller = new AbortController()
            void loadAssets(controller.signal)
          },
        },
        '刷新',
      ),
    ),
    assets.length === 0
      ? createElement(
        'div',
        { className: 'dsh-forge-studio-empty' },
        assetsBusy
          ? '读取中…'
          : assetQuery.trim().length > 0
            ? '没有匹配的素材'
            : assetScope === 'board'
              ? '这个画板还没有素材。生成后会按画板自动记录。'
              : '还没有素材。对话或工作台出的图都会记进画板。',
      )
      : createElement(
        'div',
        { className: 'dsh-forge-assets-grid' },
        ...assets.map((asset) => createElement(
          'div',
          { key: `${asset.boardId}:${asset.id}`, className: 'dsh-forge-asset' },
          createElement(
            'a',
            {
              className: 'dsh-forge-asset-thumb',
              href: studioFileUrl(asset.markdownPath),
              target: '_blank',
              rel: 'noreferrer',
              title: asset.path,
            },
            createElement('img', { src: studioFileUrl(asset.markdownPath), alt: '素材', loading: 'lazy' }),
          ),
          createElement(
            'div',
            { className: 'dsh-forge-asset-meta' },
            `${String(asset.width)}×${String(asset.height)} · ${String(Math.round(asset.bytes / 1024))} KB · ${asset.mode === 'edit' ? '改图' : '文生图'}`,
          ),
          createElement(
            'div',
            { className: 'dsh-forge-asset-meta', title: `${asset.boardName} · ${asset.createdAt}` },
            `${asset.boardName} · ${asset.createdAt.slice(0, 16).replace('T', ' ')}`,
          ),
          asset.prompt.length === 0
            ? null
            : createElement('div', { className: 'dsh-forge-asset-prompt', title: asset.prompt }, asset.prompt),
          createElement(
            'div',
            { className: 'dsh-forge-asset-actions' },
            createElement(
              'button',
              {
                type: 'button',
                className: 'dsh-forge-asset-btn',
                title: '放进参考图，下一轮按它改',
                onClick: () => { referenceAsset(asset) },
              },
              '用作参考',
            ),
            createElement(
              'button',
              {
                type: 'button',
                className: 'dsh-forge-asset-btn',
                title: '切到它所在的画板并选中',
                onClick: () => { void showOnCanvas(asset) },
              },
              '定位',
            ),
            createElement(
              'button',
              {
                type: 'button',
                className: 'dsh-forge-asset-btn',
                title: '只从画板移除，文件留在磁盘',
                onClick: () => { void removeAsset(asset, false) },
              },
              '移除',
            ),
            createElement(
              'button',
              {
                type: 'button',
                className: 'dsh-forge-asset-btn is-danger',
                title: '从画板移除并删除 PNG 文件',
                onClick: () => {
                  if (!window.confirm('同时删除磁盘上的这个 PNG？此操作不可撤销。')) return
                  void removeAsset(asset, true)
                },
              },
              '删文件',
            ),
          ),
        )),
      ),
  )

  return createElement(
    'div',
    { className: 'dsh-image-forge-studio' },
    createElement(
      'div',
      { className: 'dsh-forge-studio-head' },
      createElement('h2', { className: 'dsh-forge-studio-title' }, '图像工作台'),
      createElement(
        'div',
        { className: 'dsh-forge-studio-status' },
        createElement('span', { className: ready ? 'dsh-forge-dot is-ok' : 'dsh-forge-dot is-bad' }),
        createElement(
          'span',
          { className: 'dsh-forge-studio-endpoint' },
          ready
            ? `ComfyUI ${config?.endpoint ?? ''}`
            : 'ComfyUI 未就绪',
        ),
        createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-forge-btn is-ghost',
            onClick: () => { void loadConfig() },
          },
          '重新检测',
        ),
      ),
    ),

    // ---- live progress ---------------------------------------------------
    //
    // Always visible, so "waiting" and "ComfyUI is down" are distinguishable
    // without clicking anything; `role=status` lets a screen reader announce
    // step changes. The bar is styled inline because the client stylesheet is
    // a different file from this one.
    createElement(
      'div',
      {
        className: 'dsh-forge-progress',
        'data-phase': live.phase,
        'data-bridge': live.bridge,
        role: 'status',
        'aria-live': 'polite',
      },
      [
        createElement('span', { key: 'step', className: 'dsh-forge-progress-step' }, progressStepText(live)),
        live.percent === undefined
          ? null
          : createElement(
            'span',
            {
              key: 'bar',
              className: 'dsh-forge-progress-bar',
              style: { display: 'block', height: '4px', borderRadius: '2px', background: 'rgba(127,127,127,.22)', overflow: 'hidden' },
            },
            createElement('i', {
              className: 'dsh-forge-progress-fill',
              style: {
                display: 'block',
                height: '100%',
                width: `${String(live.percent)}%`,
                background: 'currentColor',
                borderRadius: '2px',
                transition: 'width .2s',
              },
            }),
          ),
        createElement('span', { key: 'bridge', className: 'dsh-forge-progress-bridge' }, progressBridgeText(live)),
      ],
    ),

    // ---- the board this canvas is ----------------------------------------
    createElement(
      'div',
      { className: 'dsh-forge-board-bar' },
      createElement('span', { className: 'dsh-forge-board-label' }, '画板'),
      renaming
        ? [
          createElement('input', {
            key: 'name',
            className: 'dsh-forge-board-input',
            value: renameValue,
            autoFocus: true,
            maxLength: 40,
            onChange: (event: ChangeEvent<HTMLInputElement>) => { setRenameValue(event.target.value) },
            onKeyDown: (event: { key: string }) => {
              if (event.key === 'Enter') void commitRename()
              if (event.key === 'Escape') setRenaming(false)
            },
          }),
          createElement(
            'button',
            { key: 'save', type: 'button', className: 'dsh-forge-btn is-ghost', onClick: () => { void commitRename() } },
            '保存',
          ),
          createElement(
            'button',
            { key: 'cancel', type: 'button', className: 'dsh-forge-btn is-ghost', onClick: () => { setRenaming(false) } },
            '取消',
          ),
        ]
        : [
          createElement(
            'select',
            {
              key: 'select',
              className: 'dsh-forge-board-select',
              value: boardId ?? '',
              disabled: boardBusy,
              onChange: (event: ChangeEvent<HTMLSelectElement>) => { void selectBoard(event.target.value) },
            },
            ...(boards.length === 0
              ? [createElement('option', { key: 'none', value: '' }, '（还没有画板，出图会自动建一个）')]
              : boards.map((board) => createElement(
                'option',
                { key: board.id, value: board.id },
                `${board.name} · ${String(board.itemCount)} 张`,
              ))),
          ),
          createElement(
            'button',
            {
              key: 'rename',
              type: 'button',
              className: 'dsh-forge-btn is-ghost',
              disabled: boardId === undefined,
              onClick: () => {
                setRenameValue(boardName)
                setRenaming(true)
              },
            },
            '重命名',
          ),
          createElement(
            'button',
            { key: 'create', type: 'button', className: 'dsh-forge-btn is-ghost', onClick: () => { void createBoard() } },
            '新建',
          ),
        ],
      createElement(
        'span',
        { className: 'dsh-forge-board-count' },
        boardBusy
          ? '读取中…'
          : boardId === undefined
            ? '出图会新建画板'
            : `${String(nodes.length)} 张 · 自动保存`,
      ),
    ),

    configError === undefined
      ? null
      : createElement('div', { className: 'dsh-forge-studio-alert' }, configError),

    boardError === undefined
      ? null
      : createElement('div', { className: 'dsh-forge-studio-alert' }, boardError),

    ready || config === undefined
      ? null
      : createElement(
        'div',
        { className: 'dsh-forge-studio-alert' },
        '工作台需要本机正在运行的 ComfyUI 与 Qwen-Image 2.1 权重（unet / clip / vae）。',
        config.reason === undefined ? null : createElement('div', { className: 'dsh-forge-studio-hint' }, config.reason),
      ),

    createElement(
      'div',
      { className: 'dsh-forge-studio-body' },

      // ---- form -----------------------------------------------------------
      createElement(
        'div',
        { className: 'dsh-forge-studio-form' },
        createElement(
          'div',
          { className: 'dsh-forge-field' },
          createElement(
            'div',
            { className: 'dsh-forge-field-head' },
            createElement('label', { className: 'dsh-forge-label' }, references.length > 0 ? '改图描述' : '画面描述'),
            createElement(
              'div',
              { className: 'dsh-forge-field-actions' },
              createElement(
                'div',
                { className: 'dsh-forge-mode', role: 'group', 'aria-label': '改写风格' },
                ...([
                  ['prose', '长散文', '一段约 20 句的观察性描写，禁画质空话'],
                  ['formula', '关键词', '官方公式：主体+场景+风格+镜头+氛围+细节'],
                ] as const).map(([value, label, hint]) => createElement(
                  'button',
                  {
                    key: value,
                    type: 'button',
                    className: promptStyle === value ? 'dsh-forge-mode-item is-active' : 'dsh-forge-mode-item',
                    title: hint,
                    'aria-pressed': promptStyle === value,
                    onClick: () => { setPromptStyle(value) },
                  },
                  label,
                )),
              ),
              createElement(
                'button',
                {
                  type: 'button',
                  className: 'dsh-forge-btn is-ghost',
                  disabled: optimizing || prompt.trim().length === 0 || config?.optimizeAvailable !== true,
                  title: config?.optimizeAvailable === true
                    ? `用当前对话模型（${config?.optimizeModel ?? '默认模型'}）改成${promptStyle === 'formula' ? '关键词公式' : '长散文'}`
                    : (config?.optimizeNote ?? '当前会话没有可用的对话模型'),
                  onClick: () => { void optimize() },
                },
                optimizing ? '优化中…' : '优化提示词',
              ),
            ),
          ),
          createElement('textarea', {
            className: 'dsh-forge-textarea',
            value: prompt,
            placeholder: '描述你想要的画面。写完可以点「优化提示词」，让对话模型按 Qwen-Image 的写法改写一遍再生成。',
            maxLength: STUDIO_MAX_PROMPT_CHARS,
            rows: 6,
            onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { setPrompt(event.target.value) },
          }),
          optimizeNote === undefined
            ? null
            : createElement('div', { className: 'dsh-forge-studio-hint' }, optimizeNote),
        ),

        createElement(
          'div',
          { className: 'dsh-forge-field' },
          createElement('label', { className: 'dsh-forge-label' }, '画幅比例'),
          createElement(
            'div',
            { className: 'dsh-forge-ratio-row' },
            ...STUDIO_RATIOS.map((value) => {
              const size = sizeFor(value)
              return createElement(
                'button',
                {
                  key: value,
                  type: 'button',
                  className: value === ratio ? 'dsh-forge-ratio is-active' : 'dsh-forge-ratio',
                  onClick: () => { setRatio(value) },
                },
                createElement('span', { className: 'dsh-forge-ratio-label' }, value),
                createElement('span', { className: 'dsh-forge-ratio-size' }, size === undefined ? '' : `${String(size.width)}×${String(size.height)}`),
              )
            }),
          ),
        ),

        createElement(
          'div',
          { className: 'dsh-forge-field-row' },
          createElement(
            'div',
            { className: 'dsh-forge-field' },
            createElement('label', { className: 'dsh-forge-label' }, '采样步数'),
            createElement('input', {
              className: 'dsh-forge-input',
              type: 'number',
              min: 1,
              max: 200,
              value: steps,
              placeholder: config === undefined ? '' : `默认 ${String(config.defaultSteps)}`,
              onChange: (event: ChangeEvent<HTMLInputElement>) => { setSteps(event.target.value) },
            }),
          ),
          createElement(
            'div',
            { className: 'dsh-forge-field' },
            createElement('label', { className: 'dsh-forge-label' }, '出图张数'),
            createElement('input', {
              className: 'dsh-forge-input',
              type: 'number',
              min: 1,
              max: STUDIO_MAX_COUNT,
              value: String(count),
              onChange: (event: ChangeEvent<HTMLInputElement>) => {
                const next = Number(event.target.value)
                setCount(Number.isFinite(next) ? Math.min(STUDIO_MAX_COUNT, Math.max(1, Math.trunc(next))) : 1)
              },
            }),
          ),
        ),

        createElement(
          'div',
          { className: 'dsh-forge-field' },
          createElement(
            'div',
            { className: 'dsh-forge-field-head' },
            createElement('label', { className: 'dsh-forge-label' }, '参考图'),
            createElement('span', { className: 'dsh-forge-studio-hint' }, '给图就是改图；留空就是文生图'),
          ),
          createElement(
            'div',
            { className: 'dsh-forge-ref-row' },
            ...references.map((reference, index) => createElement(
              'div',
              { key: reference.id, className: 'dsh-forge-ref' },
              createElement('img', { src: reference.previewUrl, alt: reference.name }),
              createElement('span', { className: 'dsh-forge-ref-index' }, String(index + 1)),
              createElement(
                'button',
                {
                  type: 'button',
                  className: 'dsh-forge-ref-remove',
                  onClick: () => { removeReference(reference.id) },
                  title: '移除',
                },
                '×',
              ),
            )),
            createElement(
              'label',
              { className: 'dsh-forge-ref-add' },
              '+',
              createElement('input', {
                type: 'file',
                accept: 'image/png,image/jpeg,image/webp',
                multiple: true,
                onChange: addReferences,
                style: { display: 'none' },
              }),
            ),
          ),
        ),

        error === undefined
          ? null
          : createElement('div', { className: 'dsh-forge-studio-alert' }, error),

        createElement(
          'div',
          { className: 'dsh-forge-studio-actions' },
          createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-forge-btn is-primary',
              disabled: !canGenerate,
              onClick: () => { void generate() },
            },
            busy ? '生成中…' : references.length > 0 ? '生成改图' : '生成',
          ),
          busy || optimizing
            ? createElement('button', { type: 'button', className: 'dsh-forge-btn is-ghost', onClick: cancel }, '取消')
            : null,
          note === undefined ? null : createElement('span', { className: 'dsh-forge-studio-hint' }, note),
        ),
      ),

      // ---- results --------------------------------------------------------
      createElement(
        'div',
        { className: 'dsh-forge-studio-results' },
        createElement(
          'div',
          { className: 'dsh-forge-results-head' },
          createElement(
            'div',
            { className: 'dsh-forge-view-toggle', role: 'group', 'aria-label': '结果视图' },
            ...([
              ['canvas', '画布'],
              ['list', '列表'],
              ['assets', '素材'],
            ] as const).map(([value, label]) => createElement(
              'button',
              {
                key: value,
                type: 'button',
                className: view === value ? 'dsh-forge-view-item is-active' : 'dsh-forge-view-item',
                'aria-pressed': view === value,
                onClick: () => { setView(value) },
              },
              label,
            )),
          ),
          view === 'canvas'
            ? createElement(
              'div',
              { className: 'dsh-forge-zoom' },
              createElement(
                'button',
                { type: 'button', className: 'dsh-forge-btn is-ghost', 'aria-label': '缩小', onClick: () => { zoomBy(1 / 1.25) } },
                '−',
              ),
              createElement('span', { className: 'dsh-forge-zoom-label' }, zoomLabel(camera.zoom)),
              createElement(
                'button',
                { type: 'button', className: 'dsh-forge-btn is-ghost', 'aria-label': '放大', onClick: () => { zoomBy(1.25) } },
                '+',
              ),
              createElement(
                'button',
                { type: 'button', className: 'dsh-forge-btn is-ghost', onClick: fitView },
                '适应',
              ),
            )
            : createElement(
              'span',
              { className: 'dsh-forge-batch-meta' },
              view === 'assets' ? `${String(assetsTotal)} 张素材` : `${String(batches.length)} 批`,
            ),
        ),
        view === 'canvas'
          ? createElement(
            'div',
            {
              className: 'dsh-forge-canvas',
              ref: canvasRef,
              onPointerDown: onCanvasPointerDown,
              onPointerMove: onCanvasPointerMove,
              onPointerUp: endGesture,
              onPointerCancel: endGesture,
              onPointerLeave: endGesture,
            },
            nodes.length === 0 && view === 'canvas'
              ? createElement(
                'p',
                { className: 'dsh-forge-canvas-hint' },
                busy ? '正在生成…' : '这个画板还是空的。生成的第一张图会落在这里；拖动空白处平移，滚轮缩放，拖图可改位置。',
              )
              : null,
            createElement(
              'div',
              {
                className: 'dsh-forge-canvas-layer',
                style: { transform: `translate(${String(-camera.x * camera.zoom)}px, ${String(-camera.y * camera.zoom)}px) scale(${String(camera.zoom)})` },
              },
              createElement(
                'svg',
                { className: 'dsh-forge-canvas-edges', width: 1, height: 1, 'aria-hidden': true },
                // Edges are resolved once per board change (`graph.edges`, via
                // `Map<id, node>` — no per-edge scan) and then culled per frame:
                // an edge draws when an endpoint is on screen or when the wire
                // itself crosses the viewport.
                ...shownEdges.map((edge) => createElement('path', {
                  key: `${edge.parent}->${edge.child}`,
                  d: edgePath(edge.from, edge.to),
                  className: 'dsh-forge-edge',
                })),
              ),
              ...shown.map((item) => {
                const node = item.node
                const selected = node.id === selectedNodeId
                // The width is inline because it belongs to this picture: the
                // stylesheet cannot know the aspect ratio, and a fixed node
                // width is exactly what turned a 16:9 result into a letterboxed
                // thumbnail (D8). Height stays with the stylesheet — picture area
                // plus caption/actions, which grow naturally when they wrap.
                return createElement(
                  'div',
                  {
                    key: node.id,
                    className: selected ? 'dsh-forge-node is-selected' : 'dsh-forge-node',
                    style: {
                      left: `${String(node.x)}px`,
                      top: `${String(node.y)}px`,
                      width: `${String(item.width)}px`,
                    },
                    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => { onNodePointerDown(event, node) },
                  },
                  createElement('img', {
                    src: studioFileUrl(node.image.markdownPath),
                    alt: '生成结果',
                    draggable: false,
                    loading: 'lazy',
                  }),
                  createElement(
                    'div',
                    { className: 'dsh-forge-node-meta' },
                    `${String(node.image.width)}×${String(node.image.height)} · ${String(Math.round(node.image.bytes / 1024))} KB`,
                  ),
                  selected
                    ? createElement(
                      'div',
                      { className: 'dsh-forge-node-actions' },
                      createElement(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-forge-node-btn',
                          title: '把这张图放进参考图，下一轮按它改',
                          onClick: () => { referenceNode(node) },
                        },
                        '用作参考',
                      ),
                      createElement(
                        'a',
                        {
                          className: 'dsh-forge-node-btn',
                          href: studioFileUrl(node.image.markdownPath),
                          target: '_blank',
                          rel: 'noreferrer',
                        },
                        '原图',
                      ),
                      createElement(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-forge-node-btn is-danger',
                          title: '从画布移除（不会删文件）',
                          onClick: () => { removeNode(node.id) },
                        },
                        '移除',
                      ),
                    )
                    : null,
                )
              }),
            ),
            createElement(
              'div',
              { className: 'dsh-forge-canvas-foot' },
              references.length === 0
                ? '选中图片后可「用作参考」，下一轮会从它拉一条线出来。'
                : `已选 ${String(references.length)} 张参考图，下一轮将是改图。`,
            ),
          )
          : view === 'assets'
            ? assetsPanel
            : batches.length === 0
              ? createElement('div', { className: 'dsh-forge-studio-empty' }, busy ? '正在生成…' : '还没有结果')
              : createElement(
              'div',
              { className: 'dsh-forge-list' },
              ...batches.map((batch) => createElement(
                'div',
                {
                  key: batch.id,
                  className: batch.id === selectedBatch?.id ? 'dsh-forge-batch is-active' : 'dsh-forge-batch',
                },
                createElement(
                  'div',
                  { className: 'dsh-forge-batch-head' },
                  createElement(
                    'span',
                    { className: 'dsh-forge-batch-meta' },
                    `${batch.response.ratio} · ${String(batch.response.width)}×${String(batch.response.height)} · ${String(batch.response.steps)} 步`,
                  ),
                  createElement(
                    'button',
                    { type: 'button', className: 'dsh-forge-btn is-ghost', onClick: () => { reuse(batch) } },
                    '复用参数',
                  ),
                ),
                createElement(
                  'div',
                  { className: 'dsh-forge-batch-grid' },
                  ...batch.response.images.map((image: StudioImage, index: number) => createElement(
                    'a',
                    {
                      key: image.path,
                      className: 'dsh-forge-batch-item',
                      href: studioFileUrl(image.markdownPath),
                      target: '_blank',
                      rel: 'noreferrer',
                      title: image.path,
                    },
                    createElement('img', { src: studioFileUrl(image.markdownPath), alt: `结果 ${String(index + 1)}`, loading: 'lazy' }),
                  )),
                ),
                createElement('div', { className: 'dsh-forge-batch-prompt' }, batch.response.prompt),
              )),
            ),
      ),
    ),
  )
}
