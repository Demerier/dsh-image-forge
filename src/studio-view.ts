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
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  CANVAS_NODE_HEIGHT,
  CANVAS_NODE_WIDTH,
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
  ALIGN_MODES,
  CommandStack,
  DISTRIBUTE_AXES,
  alignNodes,
  contextMenuItems,
  distributeNodes,
  marqueeSelection,
  marqueeWorldRect,
  moveSelection,
  nodesInRect,
  nudgeVector,
  resolveShortcut,
  shortcutContext,
  singleSelection,
  snapshotCommand,
  toggleSelection,
  type AlignMode,
  type Command,
  hasReference,
  type ContextMenuItem,
  type DistributeAxis,
  type NodeRect,
} from './canvas-interactions.ts'
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
  firstLine,
  studioFileUrl,
  type BoardDetail,
  type BoardItem,
  type BoardTaskParams,
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
 * One node on the canvas (§3.3).
 *
 * Nodes are not just results any more: the canvas is where a session is worked
 * on, so a node is either a picture or a generation task. The layout kind is
 * the third arm of §3.3 and arrives with C13; this build produces and persists
 * the first two.
 *
 * `parents` is what makes the board graph-shaped: an edit made from another
 * result draws an edge back to it, so the lineage of a session stays readable.
 * Those edges record derivation, not parameters — this is deliberately not a
 * Comfy-style wiring graph, where an edge would mean "this output feeds that
 * input". A task node's parents are handed to the picture that replaces it
 * (DD5), so the line survives the conversion.
 */
interface CanvasNodeBase {
  /** Board item id for a picture; the clientId for a task node. */
  readonly id: string
  x: number
  y: number
  readonly parents: readonly string[]
}

/** A finished picture: the board item plus where it sits. */
interface ImageCanvasNode extends CanvasNodeBase {
  readonly kind: 'image'
  readonly image: StudioImage
  readonly batchId: string
}

/**
 * §4.2's task states.
 *
 * `done` is deliberately brief: the SSE frame only moves the status, while the
 * POST response is the conversion authority (see `startGeneration`). A failure
 * or an interrupt stays on the canvas until the user retries or removes it.
 */
type TaskStatus = 'idle' | 'queued' | 'running' | 'done' | 'failed' | 'interrupted'

/** A generation in flight, or one that ended without a picture (§4.2, §4.5). */
interface TaskCanvasNode extends CanvasNodeBase {
  readonly kind: 'task'
  /** `c` + base36, what the host echoes on every event of this run. */
  readonly clientId: string
  /** Request snapshot, so a retry needs no retyping (§4.5). */
  readonly params: BoardTaskParams
  status: TaskStatus
  progress?: { readonly label?: string; readonly percent: number }
  /** First line of whatever went wrong, for the node's caption. */
  error?: string
}

type CanvasNode = ImageCanvasNode | TaskCanvasNode

/** Narrowing helper: the render and lineage paths only read pictures' files. */
function isImageNode(node: CanvasNode): node is ImageCanvasNode {
  return node.kind === 'image'
}

/** Narrowing helper for the task reducer and the task node. */
function isTaskNode(node: CanvasNode): node is TaskCanvasNode {
  return node.kind === 'task'
}

/**
 * A pointer gesture in progress; `undefined` when idle.
 *
 * Three kinds now, not two (`docs/CANVAS-DESIGN.md` §6.6). Panning keeps the
 * camera it started from; a node drag keeps the *whole* selection's origins so a
 * multi-node move is one delta applied to a batch, never an accumulation; a
 * marquee keeps the pointer origin in viewport space plus the selection it must
 * union onto, so `Shift` can add to a selection the user already had.
 */
type Gesture =
  | { kind: 'pan'; startX: number; startY: number; camera: Camera }
  | {
    kind: 'node'
    /** Every node the drag moves: the selection at pointer-down (§6.1). */
    readonly ids: readonly string[]
    /** World positions at pointer-down, keyed by id — never re-read per frame. */
    readonly origins: ReadonlyMap<string, Point>
    readonly startX: number
    readonly startY: number
  }
  | {
    kind: 'marquee'
    /** Pointer origin, already converted to viewport-relative pixels. */
    readonly startX: number
    readonly startY: number
    /** Selection at pointer-down: a `Shift` marquee unions onto it. */
    readonly base: ReadonlySet<string>
    readonly additive: boolean
    /** The canvas box's client offset, so a move event converts without a reflow. */
    readonly left: number
    readonly top: number
  }

/** A marquee's on-screen rectangle, in viewport-relative pixels. */
interface MarqueeBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Consecutive arrow-key nudges inside this window merge into one undo step.
 *
 * §6.3 asks for the merge ("合并连续微移为一条命令"); without a window every
 * key press would put a step on the stack and Ctrl+Z would walk back one pixel at
 * a time. 700 ms is longer than a held key's repeat rate and shorter than "I
 * went to look at something else".
 */
const NUDGE_MERGE_MS = 700

/** One coalesced nudge session: the step on the stack, and the map it writes. */
interface NudgeSession {
  /** When the last nudge of this run happened (`Date.now()`). */
  at: number
  /** The exact id set, so nudging a different selection starts a new step. */
  readonly signature: string
  /** Positions before the run started — what undo restores. */
  readonly before: Map<string, Point>
  /** Positions to restore on redo; mutated in place as the run continues. */
  readonly after: Map<string, Point>
  /** The command already on the stack; it reads `after` by reference. */
  readonly command: Command
}

/** The §6.2 toolbar's six buttons, in the order §6.2 lists them. */
const ALIGN_LABELS: Record<AlignMode, string> = {
  left: '左对齐',
  'center-h': '水平居中',
  right: '右对齐',
  top: '顶对齐',
  'center-v': '垂直居中',
  bottom: '底对齐',
}

/** The §6.2 distribute buttons, one per axis. */
const DISTRIBUTE_LABELS: Record<DistributeAxis, string> = { x: '水平等距', y: '垂直等距' }

/**
 * World-space rectangle a node occupies.
 *
 * A picture's width follows its aspect ratio ({@link nodeDisplaySize}), so an
 * edge anchors on the right edge of *this* node rather than a shared constant,
 * and `nextNodeSpot` clears the widest neighbour instead of the default box. The
 * height stays constant: caption and actions live below the picture area.
 *
 * A task node is the fixed default box (208×240, §3.2), which is why the landing
 * grid needs no special case for it: it occupies exactly the space an unmeasured
 * picture would. The layout node's own w/h arrive with C13.
 */
function nodeRect(node: CanvasNode): Rect {
  if (isImageNode(node)) {
    const size = nodeDisplaySize(node.image.width, node.image.height)
    return { x: node.x, y: node.y, width: size.width, height: size.height }
  }
  return { x: node.x, y: node.y, width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT }
}

/**
 * `nodeRect` for every node, carrying the id the interaction layer keys by.
 *
 * `nodeRect` alone drops the id (a node's rectangle is geometry, not identity),
 * while every C08 function — marquee hit-testing, alignment, distribution —
 * returns positions keyed by id. Composing the two here keeps that join in one
 * place instead of at each call site.
 */
function nodeRects(nodes: readonly CanvasNode[]): NodeRect[] {
  return nodes.map((node) => ({ id: node.id, ...nodeRect(node) }))
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

/**
 * Turn stored board items into canvas nodes, keeping the saved arrangement.
 *
 * A task entry is a **terminal** failure/interrupt that was persisted (§4.6), so
 * it comes back as a task node the user can retry; its clientId is gone with the
 * run, and the board item id stands in for it until a retry mints a fresh one
 * (§4.5). Layout entries are C13's kind and are filtered here so a v2 board that
 * already has one stays readable by this build instead of crashing on an item
 * that has no picture.
 */
function nodesFromBoard(items: readonly BoardItem[]): CanvasNode[] {
  const nodes: CanvasNode[] = []
  items.forEach((item, index) => {
    const spot = fallbackSpot(index)
    if (item.kind === 'layout') return
    if (item.kind === 'task') {
      const task = item.task
      // The store's v2 validator drops a task entry without one, so this is
      // belt-and-braces against a hand-edited file.
      if (task === undefined) return
      nodes.push({
        kind: 'task',
        id: item.id,
        clientId: item.id,
        x: item.x ?? spot.x,
        y: item.y ?? spot.y,
        parents: item.parents,
        params: task.params,
        status: task.status,
        ...(task.error === undefined ? {} : { error: task.error }),
      })
      return
    }
    nodes.push({
      kind: 'image',
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
    })
  })
  return nodes
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
  // Only pictures form batches: a task node has no file and would otherwise
  // become a phantom batch with empty dimensions.
  const pictures = items.filter((item) => (item.kind ?? 'image') === 'image')
  const grouped = new Map<string, BoardItem[]>()
  for (const item of pictures) {
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

/* -------------------------------------------------------------------------- */
/* Task nodes (C11): the §4.2 state machine and its request snapshot           */
/* -------------------------------------------------------------------------- */

/** The badge copy each state prints. */
const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  idle: '准备提交',
  queued: '排队中',
  running: '正在生成',
  done: '落图中',
  failed: '生成失败',
  interrupted: '已中断',
}

/**
 * A fresh task id: `c` + base36, the same alphabet and length budget as
 * `makeItemId` in `src/boards.ts`, and validated by `isStudioClientId` on the
 * host. Three random chunks keep a collision as unlikely as a board item's.
 */
function makeClientId(): string {
  const chunk = (): string => Math.random().toString(36).slice(2, 8)
  return 'c' + (chunk() + chunk() + chunk()).slice(0, 18)
}

/** First line of the prompt, for a caption that must stay small. */
function taskPromptLine(params: BoardTaskParams): string {
  return firstLine(params.prompt, '（无提示词）')
}

/** What the request asked for, in one line (§3.2's parameter summary). */
function taskParamsText(params: BoardTaskParams): string {
  const parts: string[] = [params.ratio ?? '1:1']
  if (params.steps !== undefined) parts.push(String(params.steps) + ' 步')
  parts.push(String(params.count ?? 1) + ' 张')
  const references = params.references?.length ?? 0
  if (references > 0) parts.push(String(references) + ' 张参考')
  return parts.join(' · ')
}

/** The state line under the progress bar. */
function taskStatusText(task: TaskCanvasNode): string {
  switch (task.status) {
    case 'idle':
      return '准备提交…'
    case 'queued':
      return '排队中…'
    case 'running':
      return task.progress?.label === undefined ? '正在生成…（等待第一步）' : '正在生成 · 第 ' + task.progress.label + ' 步'
    case 'done':
      return '生成完成，正在落图…'
    case 'failed':
      return '失败：' + (task.error ?? '未知错误')
    case 'interrupted':
      return '已中断'
  }
}

/** Percent the task's bar paints; a finished node sits at 100. */
function taskPercent(task: TaskCanvasNode): number {
  if (task.status === 'done') return 100
  return task.progress?.percent ?? 0
}

/** The clientId an event names, or `undefined` when the frame is not run-scoped. */
function eventClientId(event: StudioProgressEvent): string | undefined {
  switch (event.type) {
    case 'run':
      return event.clientId
    case 'start':
    case 'node':
    case 'progress':
    case 'done':
    case 'error':
    case 'interrupted':
      return event.clientId
    default:
      return undefined
  }
}

/**
 * Fold one SSE event into a task node (§4.2 reducer, beside
 * `reduceProgressEvent`, which stays the global status bar's).
 *
 * Only events carrying **this** node's clientId apply, so a run started by the
 * conversation tools — never registered, no clientId — cannot touch a canvas
 * task. `queue` frames are global and deliberately ignored here: they must
 * never push a started task back into "waiting" (the same rule the progress
 * reducer states for its own phase).
 *
 * `done` moves the status only. **The POST response is the conversion
 * authority** (C11's stop-condition plan): a response can overtake or trail the
 * frame, so keying the replacement on the response means a late `done` cannot
 * resurrect a node already converted, and an early one cannot convert before
 * the image ids are known.
 */
function reduceTaskEvent(task: TaskCanvasNode, event: StudioProgressEvent): TaskCanvasNode {
  if (eventClientId(event) !== task.clientId) return task
  switch (event.type) {
    case 'run':
      return task.status === 'idle' || task.status === 'queued' ? { ...task, status: 'queued' } : task
    case 'start':
      return task.status === 'idle' || task.status === 'queued'
        ? { ...task, status: 'running', progress: { percent: 0 }, error: undefined }
        : task
    case 'progress':
      return task.status === 'idle' || task.status === 'queued' || task.status === 'running'
        ? { ...task, status: 'running', progress: { label: event.label, percent: event.percent }, error: undefined }
        : task
    case 'done':
      // A response that already failed the node, or an interrupt the user
      // asked for, is the truth; a late frame must not overwrite it.
      return task.status === 'failed' || task.status === 'interrupted'
        ? task
        : { ...task, status: 'done', progress: { ...(task.progress ?? {}), percent: 100 } }
    case 'error':
      return { ...task, status: 'failed', error: firstLine(event.message), progress: undefined }
    case 'interrupted':
      return { ...task, status: 'interrupted', error: '已中断', progress: undefined }
    default:
      return task
  }
}

/** `reduceTaskEvent` over the whole board; the array identity is kept when idle. */
function applyTaskEvent(nodes: CanvasNode[], event: StudioProgressEvent): CanvasNode[] {
  let changed = false
  const next = nodes.map((node) => {
    if (!isTaskNode(node)) return node
    const reduced = reduceTaskEvent(node, event)
    if (reduced === node) return node
    changed = true
    return reduced
  })
  return changed ? next : nodes
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
  // The selection is a set now, not one id: §6.1 makes multi-select the model and
  // "single selected node" a special case of it (`singleSelection`). Every
  // component that used to read one id reads the set instead.
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set())
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const gestureRef = useRef<Gesture | undefined>(undefined)
  // Latest pointer position and the one queued frame that will apply it (§10.3).
  const pointerRef = useRef<Point | undefined>(undefined)
  const frameRef = useRef<number | undefined>(undefined)
  // The marquee rectangle is screen-space DOM, not part of the scaled layer
  // (§6.1: its border must not zoom).
  const [marquee, setMarquee] = useState<MarqueeBox | undefined>(undefined)
  // Right-click menu (§6.4): where it is, what it offers, and what it acts on.
  const [menu, setMenu] = useState<{
    readonly x: number
    readonly y: number
    readonly items: readonly ContextMenuItem[]
    /** The node it was opened on; `undefined` for the blank-canvas menu. */
    readonly target?: string
  } | undefined>(undefined)
  // Space is a *held* state, so it lives in a ref the pointer handler can read at
  // pointer-down and in state only for the cursor affordance (§6.3, §6.6).
  const panRef = useRef(false)
  const [panHeld, setPanHeld] = useState(false)
  // The third pan entry (§6.6 keeps three): a toolbar toggle for users who would
  // rather not hold a key at all. It is sticky, unlike Space.
  const [handMode, setHandMode] = useState(false)
  // Undo history (§6.5, DD9): in memory, session-scoped, capped by the stack.
  const historyRef = useRef<CommandStack>(new CommandStack())
  const nudgeRef = useRef<NudgeSession | undefined>(undefined)
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
  // One controller per in-flight task run, keyed by clientId: a retry is a
  // separate run, and cancelling one task must not abort another (§4.2, §6.4).
  const controllersRef = useRef<Map<string, AbortController>>(new Map())
  // §4.5: "编辑参数重发" refills the form and marks the failed node; the next
  // form generation replaces that node in place instead of adding a second one.
  const pendingReplaceRef = useRef<{ readonly id: string } | undefined>(undefined)
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
      setSelection(new Set())
      setMenu(undefined)
      // The undo history is per board (§6.5: "session-scoped" and the stack holds
      // ids this board no longer has once another one is open).
      historyRef.current.clear()
      nudgeRef.current = undefined
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
      setSelection(new Set())
      setMenu(undefined)
      historyRef.current.clear()
      nudgeRef.current = undefined
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
      if (parsed === undefined) return
      // Two reducers on purpose (§4.2): the global status bar follows any run,
      // while a task node only follows its own clientId. `run` frames advance a
      // node from idle to queued and are ignored by the global reducer's default
      // branch, which is the pre-DD7 behaviour kept intact.
      setLive((current) => reduceProgressEvent(current, parsed))
      setNodes((current) => {
        const next = applyTaskEvent(current, parsed)
        if (next !== current) nodesRef.current = next
        return next
      })
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
      // Pictures only: a task node is session state and is deliberately never
      // persisted while it runs (DD6); its terminal state is a different write
      // (deferred by scope to C12's board route work — see the C11 report).
      items: nodesRef.current
        .filter(isImageNode)
        .map((node) => ({ id: node.id, x: node.x, y: node.y })),
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

  /**
   * Write the node list everywhere it is read: React state *and* the refs.
   *
   * Defined ahead of the generation path because a task node is written the
   * moment the request starts (§4.3), before any gesture or undo code runs.
   */
  const writeNodes = useCallback((next: CanvasNode[]) => {
    // The ref is not a cache: gestures, undo and the save path all read it from
    // callbacks that must see the change in the same tick (see `endGesture`).
    nodesRef.current = next
    setNodes(next)
  }, [])

  /* ------------------------------------------------------------------------ */
  /* Generation (C11 §4.1–4.5): request ⇄ task node ⇄ result                   */
  /* ------------------------------------------------------------------------ */

  /** Show a node's rectangle, centring the camera only when it is off-screen. */
  const revealRect = useCallback((x: number, y: number, width: number, height: number) => {
    const element = canvasRef.current
    if (element === null) return
    const box = element.getBoundingClientRect()
    setCamera((current) => {
      const view = {
        left: current.x,
        top: current.y,
        right: current.x + box.width / current.zoom,
        bottom: current.y + box.height / current.zoom,
      }
      const centerX = x + width / 2
      const centerY = y + height / 2
      const inside = centerX > view.left && centerX < view.right && centerY > view.top && centerY < view.bottom
      return inside
        ? current
        : { zoom: current.zoom, x: centerX - box.width / (2 * current.zoom), y: centerY - box.height / (2 * current.zoom) }
    })
  }, [])

  /** The retry-wire references a task snapshot can still send (paths only, §4.6). */
  const requestReferencesOf = useCallback((params: BoardTaskParams): StudioReferencePayload[] => {
    const out: StudioReferencePayload[] = []
    for (const entry of params.references ?? []) {
      if (typeof entry.path !== "string" || entry.path.length === 0) continue
      out.push({
        path: entry.path,
        mediaType: entry.mediaType ?? "image/png",
        ...(entry.name === undefined ? {} : { name: entry.name }),
      })
    }
    return out
  }, [])

  /** Record a run failure on its task node; the node stays for retry (§4.5). */
  const failTask = useCallback((clientId: string, message: string, status: 'failed' | 'interrupted' = 'failed') => {
    let changed = false
    const next = nodesRef.current.map((node) => {
      if (!isTaskNode(node) || node.clientId !== clientId) return node
      // A user-requested interrupt is already the terminal truth; the POST for
      // that run is expected to fail afterwards and must not relabel it.
      if (node.status === 'interrupted' && status === 'failed') return node
      changed = true
      return { ...node, status, error: firstLine(message), progress: undefined }
    })
    if (changed) writeNodes(next)
  }, [writeNodes])

  /**
   * DD5: the response replaces the task node with its pictures.
   *
   * The first image takes the task node's exact position (the user placed the
   * task where the result should appear) and inherits its parents, so the
   * lineage edge crosses the conversion. Extra images fan out to the right, as
   * the old batch placement did. The task node id is a clientId the board never
   * stored, so dropping it here is also the only correct bookkeeping.
   */
  const finishTask = useCallback((clientId: string, result: StudioGenerateResponse) => {
    const taskNode = nodesRef.current.find((node): node is TaskCanvasNode => isTaskNode(node) && node.clientId === clientId)
    if (taskNode === undefined) return
    if (result.images.length === 0) {
      failTask(clientId, '本次生成没有返回图片')
      return
    }
    const batch: Batch = { id: String(result.elapsedMs) + '-' + String(Date.now()), response: result }
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
    const next = nodesRef.current.filter((node) => node.id !== taskNode.id)
    const created: ImageCanvasNode[] = []
    result.images.forEach((image: StudioImage, index: number) => {
      const spot = index === 0 ? { x: taskNode.x, y: taskNode.y } : nextNodeSpot(next.map(nodeRect))
      const node: ImageCanvasNode = {
        kind: 'image',
        // The board item id, not a client-side composite: the arrangement is
        // stored per item, so a node has to carry the identity the host knows.
        id: image.id,
        image,
        batchId: batch.id,
        x: spot.x,
        y: spot.y,
        parents: taskNode.parents,
      }
      created.push(node)
      next.push(node)
    })
    writeNodes(next)
    scheduleLayout()
    if (created[0] !== undefined) setSelection(new Set([created[0].id]))
  }, [failTask, scheduleLayout, writeNodes])

  /**
   * §4.3 steps 1–2: mint the clientId, drop the task node where the result
   * should land, make it visible, then submit the request carrying that id.
   *
   * All three entries converge here (§4.1): the form, a failed node's retry,
   * and — once C13 lands — a layout node, which only needs this signature. A
   * `replaceId` is the retry/edit path: the old node is swapped for the new one
   * at the same position, so a failed intent does not pile nodes up (§4.5).
   */
  const startGeneration = useCallback(async (
    params: BoardTaskParams,
    options: {
      readonly references?: readonly StudioReferencePayload[]
      readonly parents?: readonly string[]
      readonly replaceId?: string
      /** Form-only: report a refusal to the form as well as to the node. */
      readonly report?: (message: string) => void
    } = {},
  ): Promise<void> => {
    const previous = options.replaceId === undefined
      ? undefined
      : nodesRef.current.find((node) => node.id === options.replaceId)
    const clientId = makeClientId()
    const spot = previous === undefined
      ? nextNodeSpot(nodesRef.current.map(nodeRect))
      : { x: previous.x, y: previous.y }
    const taskNode: TaskCanvasNode = {
      kind: 'task',
      id: clientId,
      clientId,
      x: spot.x,
      y: spot.y,
      parents: options.parents ?? previous?.parents ?? [],
      params,
      status: 'idle',
    }
    const placed = previous === undefined
      ? [...nodesRef.current, taskNode]
      : nodesRef.current.map((node) => (node.id === previous.id ? taskNode : node))
    writeNodes(placed)
    setSelection(new Set([clientId]))
    revealRect(taskNode.x, taskNode.y, CANVAS_NODE_WIDTH, CANVAS_NODE_HEIGHT)

    const controller = new AbortController()
    controllersRef.current.set(clientId, controller)
    const fromForm = options.report !== undefined
    if (fromForm) abortRef.current = controller
    try {
      const wireReferences = options.references ?? requestReferencesOf(params)
      const response = await fetch(STUDIO_GENERATE_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: params.prompt,
          ratio: params.ratio ?? '1:1',
          ...(params.steps === undefined ? {} : { steps: params.steps }),
          count: params.count ?? 1,
          ...(wireReferences.length === 0 ? {} : { references: wireReferences }),
          ...(boardIdRef.current === undefined ? {} : { board: boardIdRef.current }),
          clientId,
        }),
      })
      const payload = await readJson(response)
      if (payload === undefined || !Array.isArray(payload.images)) {
        const message = typeof payload?.error === 'string'
          ? payload.error
          : '生成失败（HTTP ' + String(response.status) + '）'
        failTask(clientId, message)
        options.report?.(message)
        return
      }
      finishTask(clientId, payload as unknown as StudioGenerateResponse)
    } catch (cause) {
      if (controller.signal.aborted) {
        failTask(clientId, '已中断', 'interrupted')
        return
      }
      const message = cause instanceof Error ? cause.message : String(cause)
      failTask(clientId, message)
      options.report?.(message)
    } finally {
      controllersRef.current.delete(clientId)
      if (abortRef.current === controller) abortRef.current = undefined
    }
  }, [failTask, finishTask, requestReferencesOf, revealRect, writeNodes])

  /** §4.5 retry: the same snapshot under a fresh clientId, in place. */
  const retryTask = useCallback((id: string) => {
    const node = nodesRef.current.find((entry) => entry.id === id)
    if (node === undefined || !isTaskNode(node)) return
    void startGeneration(node.params, {
      parents: node.parents,
      replaceId: node.id,
      report: (message) => { setError(message) },
    })
  }, [startGeneration])

  /** §4.5 edit-and-resend: refill the form; the next generate replaces this node. */
  const editTaskParams = useCallback((id: string) => {
    const node = nodesRef.current.find((entry) => entry.id === id)
    if (node === undefined || !isTaskNode(node)) return
    setPrompt(node.params.prompt)
    setRatio(node.params.ratio ?? '1:1')
    setSteps(node.params.steps === undefined ? '' : String(node.params.steps))
    setCount(node.params.count ?? 1)
    setReferences((current) => {
      for (const reference of current) URL.revokeObjectURL(reference.previewUrl)
      const restored: HeldReference[] = []
      for (const [index, entry] of (node.params.references ?? []).entries()) {
        if (typeof entry.path !== 'string' || entry.path.length === 0) continue
        if (restored.length >= STUDIO_MAX_REFERENCES) break
        restored.push({
          id: node.id + '-param-' + String(index),
          name: entry.name ?? (entry.path.split('/').pop() ?? '参考图'),
          previewUrl: studioFileUrl(entry.path.replace(/\\/g, '/')),
          payload: {
            path: entry.path,
            ...(entry.mediaType === undefined ? {} : { mediaType: entry.mediaType }),
          },
        })
      }
      return restored
    })
    pendingReplaceRef.current = { id: node.id }
    setNote('参数已回填表单；改完再点「生成」会替换这个失败节点。')
  }, [])

  /** Abort one task node's own run (§4.2 lands it on `interrupted`). */
  const cancelTask = useCallback((id: string) => {
    const node = nodesRef.current.find((entry) => entry.id === id)
    if (node === undefined || !isTaskNode(node)) return
    controllersRef.current.get(node.clientId)?.abort()
  }, [])

  /** Run one generation with the form's current values (§4.1 entry 1). */
  const generate = useCallback(async () => {
    const text = prompt.trim()
    if (text.length === 0) {
      setError('请输入提示词')
      return
    }
    setBusy(true)
    setError(undefined)
    setNote(undefined)
    const parsedSteps = steps.trim().length > 0 ? Number(steps) : undefined
    const requested: NonNullable<BoardTaskParams['references']> = []
    for (const entry of references) {
      const path = entry.payload.path
      if (typeof path !== 'string' || path.length === 0) continue
      requested.push({ path, name: entry.name, mediaType: entry.payload.mediaType })
    }
    const params: BoardTaskParams = {
      prompt: text,
      ratio,
      ...(parsedSteps === undefined || !Number.isFinite(parsedSteps) ? {} : { steps: parsedSteps }),
      count,
      ...(requested.length === 0 ? {} : { references: requested }),
    }
    // Canvas-held references are the edge's source, exactly as before (§4.5):
    // the task node's parents become the picture's parents on conversion.
    const parents = references
      .map((entry) => entry.nodeId)
      .filter((id): id is string => typeof id === 'string')
    const replace = pendingReplaceRef.current
    pendingReplaceRef.current = undefined
    try {
      await startGeneration(params, {
        references: references.map((entry) => entry.payload),
        parents,
        ...(replace === undefined ? {} : { replaceId: replace.id }),
        report: (message) => { setError(message) },
      })
    } finally {
      setBusy(false)
    }
  }, [count, prompt, ratio, references, startGeneration, steps])
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

  /* ------------------------------------------------------------------------ */
  /* Selection, movement and the undo stack (§6.1, §6.2, §6.5)                 */
  /* ------------------------------------------------------------------------ */

  /** Set the coordinates of every node in `positions` in one write. */
  const applyPositions = useCallback((positions: ReadonlyMap<string, Point>) => {
    writeNodes(nodesRef.current.map((node) => {
      const point = positions.get(node.id)
      return point === undefined ? node : { ...node, x: point.x, y: point.y }
    }))
  }, [writeNodes])

  /** Where those ids are right now — the `before` side of an undo step. */
  const positionsOf = useCallback((ids: Iterable<string>): Map<string, Point> => {
    const index = new Map(nodesRef.current.map((node) => [node.id, node]))
    const positions = new Map<string, Point>()
    for (const id of ids) {
      const node = index.get(id)
      if (node !== undefined) positions.set(id, { x: node.x, y: node.y })
    }
    return positions
  }, [])

  /**
   * The selected nodes as world rectangles, from the **full** node list.
   *
   * Not `shown`: §6.1's hit rules run over every node on the board, so a marquee
   * that leaves the viewport, a select-all, and an alignment of a selection that
   * is partly culled must still see everything (the C07 note says the same).
   */
  const selectionRects = useCallback((ids: ReadonlySet<string>): NodeRect[] => (
    nodeRects(nodesRef.current.filter((node) => ids.has(node.id)))
  ), [])

  /**
   * Put an already-applied change on the undo stack.
   *
   * `CommandStack.push` does not apply: by the time a drag ends, the nodes have
   * moved — the command only remembers where they were.
   */
  const pushCommand = useCallback((command: Command) => {
    // Any command closes an open nudge run, so a later arrow key starts a step
    // of its own instead of silently widening the previous one.
    nudgeRef.current = undefined
    historyRef.current.push(command)
  }, [])

  /** One undoable coordinate change, for a batch of nodes. */
  const moveCommand = useCallback((label: string, before: Map<string, Point>, after: Map<string, Point>): Command => (
    snapshotCommand(label, before, after, (positions) => { applyPositions(positions) })
  ), [applyPositions])

  /** Move a batch, record one step, save once. */
  const applyPositionsCommand = useCallback((label: string, after: Map<string, Point>) => {
    const before = positionsOf(after.keys())
    applyPositions(after)
    pushCommand(moveCommand(label, before, after))
    scheduleLayout()
  }, [applyPositions, moveCommand, positionsOf, pushCommand, scheduleLayout])

  /** Align the selection to its own bounding box (§6.2); needs two nodes. */
  const alignSelection = useCallback((mode: AlignMode) => {
    const rects = selectionRects(selection)
    if (rects.length < 2) return
    applyPositionsCommand(`align-${mode}`, alignNodes(rects, mode))
  }, [applyPositionsCommand, selection, selectionRects])

  /** Space the selection's centres evenly (§6.2); needs three nodes. */
  const distributeSelection = useCallback((axis: DistributeAxis) => {
    const rects = selectionRects(selection)
    if (rects.length < 3) return
    applyPositionsCommand(`distribute-${axis}`, distributeNodes(rects, axis))
  }, [applyPositionsCommand, selection, selectionRects])

  /**
   * Arrow-key nudge (§6.3), coalesced into one undo step per run.
   *
   * §6.3 asks for the merge: without it every key press would be its own step and
   * Ctrl+Z would walk back one world unit at a time. The step already on the
   * stack reads its `after` map *by reference*, so extending the run is a matter
   * of rewriting that map — no second push, and the redo tail keeps pointing at
   * the same command.
   */
  const nudge = useCallback((axis: 'left' | 'right' | 'up' | 'down', fast: boolean) => {
    const ids = [...selection]
    if (ids.length === 0) return
    const delta = nudgeVector(axis, fast)
    const from = positionsOf(ids)
    const to = new Map<string, Point>()
    for (const [id, point] of from) to.set(id, { x: point.x + delta.x, y: point.y + delta.y })
    const signature = ids.join('\u0001')
    const now = Date.now()
    const open = nudgeRef.current
    if (open !== undefined && open.signature === signature && now - open.at <= NUDGE_MERGE_MS) {
      open.after.clear()
      for (const [id, point] of to) open.after.set(id, point)
      open.at = now
      applyPositions(open.after)
      scheduleLayout()
      return
    }
    const before = new Map(from)
    const after = new Map(to)
    const command = snapshotCommand('nudge', before, after, (positions) => { applyPositions(positions) })
    nudgeRef.current = { at: now, signature, before, after, command }
    historyRef.current.push(command)
    applyPositions(after)
    scheduleLayout()
  }, [applyPositions, positionsOf, scheduleLayout, selection])

  const undoHistory = useCallback(() => {
    // Undoing ends the nudge run: the next arrow key must not extend a command
    // that has just moved into the redo tail.
    nudgeRef.current = undefined
    if (!historyRef.current.undo()) return
    scheduleLayout()
  }, [scheduleLayout])

  const redoHistory = useCallback(() => {
    nudgeRef.current = undefined
    if (!historyRef.current.redo()) return
    scheduleLayout()
  }, [scheduleLayout])

  /**
   * Remove nodes from the board — unplace, never delete files (§6.3).
   *
   * `deleteFile` is the explicit second action a right-click offers (§6.4), and
   * it keeps the shipped wording of the asset page's confirm.
   *
   * The host write is not part of the undo step: the stack restores the canvas,
   * because DD9 keeps history in memory and the board is written by several
   * actors (§6.5). Reloading after undoing a removal shows the item gone — the
   * honest limit of a session-scoped stack, stated rather than papered over.
   */
  const removeNodes = useCallback((ids: readonly string[], deleteFile = false) => {
    const drop = new Set(ids)
    if (drop.size === 0) return
    const before = nodesRef.current
    const after = before.filter((node) => !drop.has(node.id))
    if (after.length === before.length) return
    writeNodes(after)
    // A reference pointing at a removed node would draw an edge to nothing.
    setReferences((current) => current.filter((entry) => entry.nodeId === undefined || !drop.has(entry.nodeId)))
    setSelection((current) => {
      const next = new Set<string>()
      for (const id of current) if (!drop.has(id)) next.add(id)
      return next
    })
    pushCommand(snapshotCommand('remove', before, after, (list) => { writeNodes([...list]) }))
    const board = boardIdRef.current
    if (board === undefined) return
    // Only pictures are board items: removing a task node is a canvas-only
    // action until its terminal state has a persistence path (C11 report).
    for (const id of before.filter((node) => drop.has(node.id) && isImageNode(node)).map((node) => node.id)) {
      void postBoard({
        action: 'remove-item',
        board,
        item: id,
        ...(deleteFile ? { deleteFile: true } : {}),
      }).then((error) => {
        if (error !== undefined) setBoardError(error)
      })
    }
  }, [pushCommand, writeNodes])

  /** The single-node form the inline node actions still use. */
  const removeNode = useCallback((id: string) => { removeNodes([id]) }, [removeNodes])

  /** Replace the selection with exactly one node (or with none). */
  const selectOnly = useCallback((id: string | undefined) => {
    setSelection(id === undefined ? new Set() : new Set([id]))
  }, [])

  /**
   * Pointer-down on blank canvas: marquee by default, pan on Space / middle.
   *
   * §6.6 changes the old default on purpose — a blank drag used to pan and now
   * boxes a selection, because that is the commoner gesture on a generation
   * canvas. All three pan entries survive: Space+drag, middle-button drag, and
   * the toolbar's hand toggle (`panRef`). The right-click menu is the other
   * blank-canvas gesture and is handled by `onCanvasContextMenu`.
   */
  const onCanvasPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return
    const target = event.target as HTMLElement
    // Any click outside the menu dismisses it (§6.4).
    setMenu(undefined)
    // Nodes start their own drag; anything else reaches this handler.
    if (target.closest('.dsh-forge-node') !== null) return
    // §6.3 makes the canvas container `tabIndex=0`; clicking it is how it gets
    // the keyboard back after the form had it.
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    pointerRef.current = undefined
    if (event.button === 1 || panRef.current || handMode) {
      gestureRef.current = { kind: 'pan', startX: event.clientX, startY: event.clientY, camera }
      return
    }
    const box = event.currentTarget.getBoundingClientRect()
    gestureRef.current = {
      kind: 'marquee',
      startX: event.clientX - box.left,
      startY: event.clientY - box.top,
      base: selection,
      additive: event.shiftKey,
      left: box.left,
      top: box.top,
    }
    // §6.1: a blank click clears the selection. A Shift drag keeps it, because
    // it is adding to what is already there.
    if (!event.shiftKey) setSelection(new Set())
  }, [camera, handMode, selection])

  /**
   * Pointer-down on a node: select (or toggle) it and start the batch drag.
   *
   * Clicking a node that is already part of a multi-selection keeps the whole set
   * — that is the only way to drag several nodes at once (§6.1). Ctrl/Cmd+click
   * toggles membership; toggling a node *out* starts no drag, because the pointer
   * is on something that just left the selection.
   */
  const onNodePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, node: CanvasNode) => {
    if (event.button !== 0) return
    event.stopPropagation()
    setMenu(undefined)
    event.currentTarget.setPointerCapture(event.pointerId)
    const additive = event.ctrlKey || event.metaKey
    let next: ReadonlySet<string>
    if (additive) next = toggleSelection(selection, node.id, true)
    else if (selection.has(node.id)) next = selection
    else next = toggleSelection(selection, node.id, false)
    setSelection(next)
    pointerRef.current = undefined
    if (!next.has(node.id)) {
      gestureRef.current = undefined
      return
    }
    gestureRef.current = {
      kind: 'node',
      ids: [...next],
      origins: positionsOf(next),
      startX: event.clientX,
      startY: event.clientY,
    }
  }, [positionsOf, selection])

  /**
   * Apply the pointer position buffered by the latest move event.
   *
   * Every gesture kind is computed from the *gesture start*, never from the
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
    if (gesture.kind === 'node') {
      // Screen delta → world delta, divided once by the live zoom: the whole
      // selection tracks the pointer at any zoom (§6.1, C08 `moveSelection`).
      const moved = moveSelection(
        gesture.origins,
        { x: pointer.x - gesture.startX, y: pointer.y - gesture.startY },
        cameraRef.current.zoom,
      )
      applyPositions(moved)
      return
    }
    // Marquee: the two corners are viewport-relative, so the world rectangle is
    // exactly what `screenToWorld` says it is (C08 `marqueeWorldRect`). Hits are
    // tested against the full board, and the selection updates live so the
    // highlight follows the box (§6.1).
    const start = { x: gesture.startX, y: gesture.startY }
    const current = { x: pointer.x - gesture.left, y: pointer.y - gesture.top }
    const world = marqueeWorldRect(cameraRef.current, start, current)
    const hits = nodesInRect(nodeRects(nodesRef.current), world)
    setSelection(marqueeSelection(gesture.base, hits, gesture.additive))
    setMarquee({
      x: Math.min(start.x, current.x),
      y: Math.min(start.y, current.y),
      width: Math.abs(current.x - start.x),
      height: Math.abs(current.y - start.y),
    })
  }, [applyPositions])

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

  /**
   * End the gesture: flush the last position, record the step, save once.
   *
   * The release position is read *before* `flushPointer` clears it — the undo
   * step has to record where the nodes actually ended up. The step is built from
   * the gesture's own origins plus the final delta (never from the state that
   * `flushPointer` just wrote), which is what keeps a rubber-banded frame from
   * recording a position the user never saw.
   */
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
    const pointer = pointerRef.current
    flushPointer()
    gestureRef.current = undefined
    setMarquee(undefined)
    if (gesture.kind === 'marquee') {
      // Only the selection changed, and a selection is not a board change: no
      // save, and nothing for the undo stack (§6.5 lists node changes only).
      return
    }
    if (gesture.kind === 'node' && pointer !== undefined) {
      const after = moveSelection(
        gesture.origins,
        { x: pointer.x - gesture.startX, y: pointer.y - gesture.startY },
        cameraRef.current.zoom,
      )
      let moved = false
      for (const [id, point] of after) {
        const origin = gesture.origins.get(id)
        if (origin === undefined || origin.x !== point.x || origin.y !== point.y) {
          moved = true
          break
        }
      }
      // A click that never moved is not an undoable step, and not a save.
      if (!moved) return
      pushCommand(moveCommand('move', new Map(gesture.origins), after))
    }
    // A drag moved node positions, a pan moved the camera — both are worth
    // keeping, and both go through the one debounced save.
    scheduleLayout()
  }, [flushPointer, moveCommand, pushCommand, scheduleLayout])

  /** Hand a canvas result back to the form as an edit reference. */
  const referenceNode = useCallback((node: CanvasNode) => {
    // Only a picture can be a reference; a task node has no file to point at.
    if (!isImageNode(node)) return
    setReferences((current) => {
      if (current.length >= STUDIO_MAX_REFERENCES) return current
      if (hasReference(current, { nodeId: node.id })) return current
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
      if (hasReference(current, { path: asset.path })) return current
      const name = asset.path.split('/').pop() ?? '参考图'
      return [...current, {
        id: `${asset.id}-ref`,
        name,
        previewUrl: studioFileUrl(asset.markdownPath),
        payload: { path: asset.path, mediaType: asset.mediaType, name },
      }]
    })
  }, [])

  /**
   * The §6.3 keyboard, dispatched through the C08 table.
   *
   * The DOM inspection stays here — `tagName`, `contentEditable`, and the layout
   * editor's container — and `shortcutContext` decides whether the canvas still
   * owns the keys. Inside the form or the editor the table answers `none`, so a
   * Delete key edits text and Ctrl+Z edits text, which is the whole point of the
   * yield rule.
   *
   * Copy/paste are in the table but land with C12: the cross-board clipboard is a
   * service-side action (§7.2), so those two actions are deliberately inert here
   * rather than aliased onto something local.
   */
  const onCanvasKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null
    const context = shortcutContext({
      tagName: target?.tagName,
      contentEditable: target?.isContentEditable === true,
      inEditor: target?.closest?.('[data-dsh-layout-editor], .dsh-forge-layout-editor') != null,
    })
    const action = resolveShortcut(
      event.key,
      { ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey },
      context,
    )
    if (action === 'none') return
    // Only keys the canvas actually handles are swallowed; everything else stays
    // with the browser (find, reload, the host's own bindings).
    event.preventDefault()
    switch (action) {
      case 'remove':
        removeNodes([...selection])
        break
      case 'undo':
        undoHistory()
        break
      case 'redo':
        redoHistory()
        break
      case 'select-all':
        // The board's nodes, not the culled subset: "all" means all.
        setSelection(new Set(nodesRef.current.map((node) => node.id)))
        break
      case 'escape':
        // §6.3: Esc clears the selection, closes the menu and exits a marquee.
        // Dropping the gesture is what stops the next move from reopening the box.
        if (gestureRef.current?.kind === 'marquee') {
          gestureRef.current = undefined
          pointerRef.current = undefined
          if (frameRef.current !== undefined) {
            cancelAnimationFrame(frameRef.current)
            frameRef.current = undefined
          }
        }
        setMenu(undefined)
        setMarquee(undefined)
        setSelection(new Set())
        break
      case 'pan-mode':
        panRef.current = true
        setPanHeld(true)
        break
      case 'fit':
        fitView()
        break
      case 'zoom-in':
        zoomBy(1.25)
        break
      case 'zoom-out':
        zoomBy(1 / 1.25)
        break
      case 'nudge-left':
        nudge('left', event.shiftKey)
        break
      case 'nudge-right':
        nudge('right', event.shiftKey)
        break
      case 'nudge-up':
        nudge('up', event.shiftKey)
        break
      case 'nudge-down':
        nudge('down', event.shiftKey)
        break
      default:
        // `copy` / `paste`: C12 (§7.2).
        break
    }
  }, [fitView, nudge, redoHistory, removeNodes, selection, undoHistory, zoomBy])

  /** Space is a held modifier: releasing it hands the pointer back to selection. */
  const onCanvasKeyUp = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== ' ' && event.key !== 'Space' && event.key !== 'Spacebar') return
    panRef.current = false
    setPanHeld(false)
  }, [])

  /** The nodes a context action applies to: the selection, or one node. */
  const menuIds = useCallback((target: string | undefined): string[] => {
    if (target !== undefined && !selection.has(target)) return [target]
    return [...selection]
  }, [selection])

  /**
   * Open the §6.4 menu at the pointer.
   *
   * The item list is generated by the pure `contextMenuItems`, so what the menu
   * offers is unit-testable and the handler below only maps ids to actions. A
   * right-click on a node outside the selection selects it first — a menu acting
   * on something the user cannot see selected is a trap.
   */
  const onCanvasContextMenu = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    // The element comes off the event, not the ref: this handler has to work
    // even before the canvas has been measured (and it keeps the DOM inspection
    // in one shape with the pointer handlers).
    const box = event.currentTarget.getBoundingClientRect()
    const hit = (event.target as HTMLElement).closest('.dsh-forge-node')
    const target = hit === null ? undefined : (hit as HTMLElement).dataset.nodeId
    let size = selection.size
    if (target !== undefined && !selection.has(target)) {
      setSelection(new Set([target]))
      size = 1
    }
    // The menu is generated from the node's own kind and, for a task, its state
    // (§6.4: a running task offers 取消, a failed one offers 重试).
    const hitNode = target === undefined ? undefined : nodesRef.current.find((node) => node.id === target)
    const taskState = hitNode !== undefined && isTaskNode(hitNode)
      ? (hitNode.status === 'idle' ? 'queued' as const : hitNode.status)
      : undefined
    const items = contextMenuItems(target === undefined
      ? { kind: 'blank' }
      : {
        kind: 'node',
        nodeKind: hitNode?.kind ?? 'image',
        selectionSize: size,
        ...(taskState === undefined ? {} : { taskState }),
      })
    setMenu({
      x: event.clientX - box.left,
      y: event.clientY - box.top,
      items,
      target,
    })
  }, [selection])

  /**
   * Run one menu item (§6.4).
   *
   * Items that belong to a node kind this build does not make yet (task, layout)
   * or to a later task (cross-board copy is C12, export is C15) arrive disabled,
   * so their ids never reach this switch. The `default` arm is therefore the
   * "not wired yet" arm, not a silent bug.
   */
  const runContextAction = useCallback((id: string) => {
    const target = menu?.target
    setMenu(undefined)
    switch (id) {
      case 'select-all':
        setSelection(new Set(nodesRef.current.map((node) => node.id)))
        break
      case 'fit':
        fitView()
        break
      case 'remove':
        removeNodes(menuIds(target))
        break
      case 'delete-file':
        if (!window.confirm('同时删除磁盘上的这个 PNG？此操作不可撤销。')) break
        removeNodes(menuIds(target), true)
        break
      case 'reference':
      case 'branch': {
        // "Branch from this image": prefill the form with it as the reference,
        // which is what starting an edit from a result means here (§6.4).
        const node = nodesRef.current.find((entry) => entry.id === target)
        if (node !== undefined) referenceNode(node)
        break
      }
      case 'original': {
        const node = nodesRef.current.find((entry) => entry.id === target)
        if (node !== undefined && isImageNode(node)) window.open(studioFileUrl(node.image.markdownPath), '_blank', 'noreferrer')
        break
      }
      case 'task-retry':
        if (target !== undefined) retryTask(target)
        break
      case 'task-edit':
        if (target !== undefined) editTaskParams(target)
        break
      case 'task-cancel':
        if (target !== undefined) cancelTask(target)
        break
      default:
        break
    }
  }, [cancelTask, editTaskParams, fitView, menu?.target, menuIds, referenceNode, removeNodes, retryTask])

  /** Open the board an asset lives on and select it there. */
  const showOnCanvas = useCallback(async (asset: StudioAsset) => {
    if (boardIdRef.current !== asset.boardId) await selectBoard(asset.boardId)
    setView('canvas')
    selectOnly(asset.id)
  }, [selectBoard, selectOnly])

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
    setSelection((current) => {
      if (!current.has(asset.id)) return current
      const next = new Set(current)
      next.delete(asset.id)
      return next
    })
    setReferences((current) => current.filter((entry) => !(entry.payload.path === asset.path)))
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
          view === 'canvas' && selection.size >= 2
            ? createElement(
              'div',
              { className: 'dsh-forge-align', role: 'group', 'aria-label': '对齐与分布' },
              ...ALIGN_MODES.map((mode) => createElement(
                'button',
                {
                  key: mode,
                  type: 'button',
                  className: 'dsh-forge-align-btn',
                  title: ALIGN_LABELS[mode],
                  onClick: () => { alignSelection(mode) },
                },
                ALIGN_LABELS[mode],
              )),
              // §6.2: distribution needs a middle node to space out.
              ...(selection.size >= 3
                ? DISTRIBUTE_AXES.map((axis) => createElement(
                  'button',
                  {
                    key: `distribute-${axis}`,
                    type: 'button',
                    className: 'dsh-forge-align-btn is-distribute',
                    title: DISTRIBUTE_LABELS[axis],
                    onClick: () => { distributeSelection(axis) },
                  },
                  DISTRIBUTE_LABELS[axis],
                ))
                : []),
            )
            : null,
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
              // §6.6 keeps three pan entries; this is the one that needs no key
              // held and no extra mouse button (Space+drag and middle-drag are
              // the other two). Sticky, unlike Space.
              createElement(
                'button',
                {
                  type: 'button',
                  className: handMode ? 'dsh-forge-btn is-ghost is-active' : 'dsh-forge-btn is-ghost',
                  title: handMode
                    ? '平移模式：拖空白处移动相机（点击回到框选）'
                    : '切到平移模式：拖空白处移动相机',
                  'aria-pressed': handMode,
                  onClick: () => { setHandMode((current) => !current) },
                },
                '平移',
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
              // §6.3: `tabIndex=0` is what makes the canvas container the owner of
              // the keyboard table; the shortcuts deliberately do not bubble from
              // the form, which keeps Delete and Ctrl+Z editing text there.
              className: panHeld || handMode ? 'dsh-forge-canvas is-pan' : 'dsh-forge-canvas',
              tabIndex: 0,
              ref: canvasRef,
              onPointerDown: onCanvasPointerDown,
              onPointerMove: onCanvasPointerMove,
              onPointerUp: endGesture,
              onPointerCancel: endGesture,
              onPointerLeave: endGesture,
              onKeyDown: onCanvasKeyDown,
              onKeyUp: onCanvasKeyUp,
              onContextMenu: onCanvasContextMenu,
              onBlur: () => {
                // Focus left with Space still down: the held state must not stick.
                panRef.current = false
                setPanHeld(false)
              },
            },
            nodes.length === 0 && view === 'canvas'
              ? createElement(
                'p',
                { className: 'dsh-forge-canvas-hint' },
                busy ? '正在生成…' : '这个画板还是空的。生成的第一张图会落在这里；拖空白处框选，Space 或中键平移，滚轮缩放，拖图可改位置。',
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
                // Membership, not equality: two selected nodes both paint (§6.1).
                const selected = selection.has(node.id)
                // The inline action row is single-node by design (§13 C09 step 1:
                // "单选语义 = 选择集大小 1"), so a multi-selection shows none and
                // uses the context menu instead.
                const sole = singleSelection(selection) === node.id
                // The width is inline because it belongs to this node: a picture's
                // width follows its aspect ratio (D8); a task node is the fixed
                // default box. Height stays with the stylesheet in both cases.
                const frame = {
                  key: node.id,
                  className: selected
                    ? (node.kind === 'task' ? 'dsh-forge-node is-selected is-task' : 'dsh-forge-node is-selected')
                    : (node.kind === 'task' ? 'dsh-forge-node is-task' : 'dsh-forge-node'),
                  // What `onCanvasContextMenu` reads back to find the node it
                  // can only identify through `closest`.
                  'data-node-id': node.id,
                  'data-node-kind': node.kind,
                  style: {
                    left: `${String(node.x)}px`,
                    top: `${String(node.y)}px`,
                    width: `${String(item.width)}px`,
                  },
                  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => { onNodePointerDown(event, node) },
                }
                // A picture node: the shipped render, unchanged.
                if (!isTaskNode(node)) {
                  return createElement(
                    'div',
                    frame,
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
                    sole
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
                }
                // §4.2's task node: state, parameter summary, progress, and the
                // retry/edit pair the failure state exists for (§4.5). The id the
                // host validates is the clientId; it never reaches the board until
                // the response replaces this node with pictures (DD5).
                return createElement(
                  'div',
                  { ...frame, 'data-task-status': node.status },
                  createElement(
                    'div',
                    { className: 'dsh-forge-task-head' },
                    createElement(
                      'span',
                      { className: 'dsh-forge-task-badge', 'data-task-status': node.status },
                      TASK_STATUS_LABELS[node.status],
                    ),
                    createElement('span', { className: 'dsh-forge-task-ratio' }, node.params.ratio ?? '1:1'),
                  ),
                  createElement('div', { className: 'dsh-forge-task-prompt', title: node.params.prompt }, taskPromptLine(node.params)),
                  createElement('div', { className: 'dsh-forge-task-meta' }, taskParamsText(node.params)),
                  createElement(
                    'div',
                    {
                      className: 'dsh-forge-task-bar',
                      role: 'progressbar',
                      'aria-valuenow': taskPercent(node),
                      'aria-valuemin': 0,
                      'aria-valuemax': 100,
                    },
                    createElement('i', { className: 'dsh-forge-task-fill', style: { width: `${String(taskPercent(node))}%` } }),
                  ),
                  createElement('div', { className: 'dsh-forge-task-status is-' + node.status }, taskStatusText(node)),
                  sole
                    ? createElement(
                      'div',
                      { className: 'dsh-forge-task-actions' },
                      node.status === 'failed' || node.status === 'interrupted'
                        ? [
                          createElement('button', { key: 'retry', type: 'button', className: 'dsh-forge-node-btn', title: '用相同的参数重新提交', onClick: () => { retryTask(node.id) } }, '重试'),
                          createElement('button', { key: 'edit', type: 'button', className: 'dsh-forge-node-btn', title: '把参数回填表单，改完再生成', onClick: () => { editTaskParams(node.id) } }, '编辑参数'),
                        ]
                        : node.status === 'idle' || node.status === 'queued' || node.status === 'running'
                          ? [createElement('button', { key: 'cancel', type: 'button', className: 'dsh-forge-node-btn', title: '中断这次生成', onClick: () => { cancelTask(node.id) } }, '取消')]
                          : [],
                      createElement('button', { key: 'remove', type: 'button', className: 'dsh-forge-node-btn is-danger', title: '从画布移除（不会删文件）', onClick: () => { removeNode(node.id) } }, '移除'),
                    )
                    : null,
                )
              }),
            ),
            // ---- screen-space overlays -------------------------------------
            //
            // Both live outside `dsh-forge-canvas-layer` on purpose (§6.1, §6.4):
            // a selection rectangle whose border scaled with the zoom would be
            // unreadable at 0.1, and a menu that scaled would be unusable.
            marquee === undefined
              ? null
              : createElement('div', {
                className: 'dsh-forge-marquee',
                style: {
                  left: `${String(marquee.x)}px`,
                  top: `${String(marquee.y)}px`,
                  width: `${String(marquee.width)}px`,
                  height: `${String(marquee.height)}px`,
                },
              }),
            menu === undefined
              ? null
              : createElement(
                'div',
                {
                  className: 'dsh-forge-context',
                  role: 'menu',
                  style: { left: `${String(menu.x)}px`, top: `${String(menu.y)}px` },
                  // The menu is part of the canvas element, so its own clicks must
                  // not be mistaken for a blank-canvas click that dismisses it.
                  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => { event.stopPropagation() },
                  onContextMenu: (event: ReactPointerEvent<HTMLDivElement>) => {
                    event.preventDefault()
                    event.stopPropagation()
                  },
                },
                ...menu.items.map((item) => createElement(
                  'button',
                  {
                    key: item.id,
                    type: 'button',
                    role: 'menuitem',
                    className: item.danger === true ? 'dsh-forge-context-item is-danger' : 'dsh-forge-context-item',
                    disabled: item.disabled === true,
                    title: item.hint ?? item.label,
                    onClick: () => { runContextAction(item.id) },
                  },
                  item.label,
                )),
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
