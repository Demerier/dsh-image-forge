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
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  CANVAS_NODE_HEIGHT,
  CANVAS_NODE_WIDTH,
  buildEdges,
  centerOn,
  clampZoom,
  edgePath,
  fitCamera,
  fitNeedsClamp,
  nextNodeSpot,
  nodeDisplaySize,
  nodeIndex,
  panBy,
  panByScroll,
  screenToWorld,
  visibleEdges,
  visibleNodes,
  visibleWorldRect,
  wheelIntent,
  worldToScreen,
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
  beginConnection,
  connectMenuItems,
  linkParents,
  previewPath,
  resolveDrop,
  updateConnection,
  type ConnectTarget,
  type ConnectNode,
  type ConnectionState,
} from './canvas-connections.ts'
import type { FlowConnectionEvent } from './canvas-flow-model.ts'
import {
  DEFAULT_LAYOUT_HEIGHT,
  DEFAULT_LAYOUT_WIDTH,
  LAYOUT_EDITOR_CLASS,
  compileLayout,
  LAYOUT_NODE_DEFAULT_WIDTH,
  clampLayoutNodeWidth,
  draftToEditorState,
  layoutNodeHeight,
  mountLayoutEditor,
  stateToDraft,
  type LayoutDraft,
  type LayoutEditorHandle,
  type LayoutEditorState,
} from './layout-editor.ts'
import {
  CONTACT_SHEET_THUMB_SIZE,
  boardJsonFileName,
  contactSheetLabel,
  contactSheetLayout,
  pictureItems,
  serializeBoardDetail,
} from './canvas-export.ts'
import {
  STUDIO_ASSETS_ROUTE,
  STUDIO_BOARD_ROUTE,
  STUDIO_CONFIG_ROUTE,
  STUDIO_ENVIRONMENT_ROUTE,
  STUDIO_EVENTS_ROUTE,
  STUDIO_GENERATE_ROUTE,
  STUDIO_IMPORT_MAX_ITEM_BYTES,
  STUDIO_IMPORT_ROUTE,
  STUDIO_NODE_THUMB_WIDTH,
  STUDIO_LAYOUT_RATIO_TOLERANCE,
  STUDIO_MAX_COUNT,
  STUDIO_MAX_LAYOUT_CHARS,
  STUDIO_MAX_PROMPT_CHARS,
  STUDIO_MAX_REFERENCES,
  STUDIO_OPTIMIZE_ROUTE,
  STUDIO_RATIOS,
  firstLine,
  fitStudioRatio,
  stepperStepsOf,
  studioFileUrl,
  type BoardDetail,
  type BoardItem,
  type BoardLayoutDraft,
  type BoardTaskParams,
  type BoardSummary,
  type StudioAsset,
  type StudioAssetsResponse,
  type StudioConfigResponse,
  type StudioEnvironmentResponse,
  type StudioEnvironmentSnapshot,
  type StudioGenerateResponse,
  type StudioImage,
  type StudioImportResponse,
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

/**
 * A MOSS layout draft as a node (§8.1): the editor plus its display size.
 *
 * `draft` is in the draft's own pixels; `w`/`h` are world units on the canvas.
 * Resizing only moves `w`/`h` — the draft is never rewritten (§8.2), which is
 * what keeps the compiled text byte-identical across a resize (C14 sends it).
 */
interface LayoutCanvasNode extends CanvasNodeBase {
  readonly kind: 'layout'
  readonly w: number
  readonly h: number
  readonly draft: BoardLayoutDraft
}

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

/**
 * A node that exists on the canvas but has no picture yet (G26).
 *
 * This is what a wire dropped on blank canvas creates when the choice is 「图片
 * 生成」: a place on the board, holding the lineage the wire expressed, waiting
 * for a prompt. It is deliberately **not** a board entry — nothing is written
 * until the user really generates, so dropping a wire can never leave a phantom
 * item behind. Selecting it and pressing 生成 replaces it in place with the
 * picture, and the picture inherits `parents`, which is the whole point.
 */
interface DraftCanvasNode extends CanvasNodeBase {
  readonly kind: 'draft'
}

type CanvasNode = ImageCanvasNode | TaskCanvasNode | LayoutCanvasNode | DraftCanvasNode

/** Narrowing helper: the render and lineage paths only read pictures' files. */
function isImageNode(node: CanvasNode): node is ImageCanvasNode {
  return node.kind === 'image'
}

/** Narrowing helper for the task reducer and the task node. */
function isTaskNode(node: CanvasNode): node is TaskCanvasNode {
  return node.kind === 'task'
}

/** Narrowing helper for the layout node and its editor mount. */
function isLayoutNode(node: CanvasNode): node is LayoutCanvasNode {
  return node.kind === 'layout'
}

/** Narrowing helper for the placeholder a wire creates before there is a picture. */
function isDraftNode(node: CanvasNode): node is DraftCanvasNode {
  return node.kind === 'draft'
}

/**
 * A node named in one line, for captions that have to say where something came
 * from (G26's draft node, and any future edge tooltip).
 *
 * A task node has no file, so its prompt is the only name it has; a layout node
 * is named by what it is.
 */
function describeNode(node: CanvasNode): string {
  if (isImageNode(node)) return node.image.path.split(/[\\/]/).pop() ?? '图片'
  if (isLayoutNode(node)) return 'MOSS 布局'
  if (isTaskNode(node)) {
    const first = node.params.prompt.split('\n')[0]?.trim() ?? ''
    return first.length === 0 ? '生成任务' : first.slice(0, 24)
  }
  return '待生成'
}

/**
 * One library asset named in one line.
 *
 * The asset page's cards show the prompt under the thumbnail because that is
 * what a generated picture is *about*; an imported file has no prompt, so the
 * file name is the only name it has. The wire menu's picker (G28) reuses the
 * same rule, which is why it is a function rather than two inline expressions.
 */
function describeAsset(asset: StudioAsset): string {
  const first = asset.prompt.split(/\r?\n/)[0]?.trim() ?? ''
  if (first.length > 0) return first
  return asset.path.split(/[\\/]/).pop() ?? '素材'
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
  | {
    kind: 'layout-resize'
    readonly id: string
    readonly startX: number
    readonly startY: number
    /** Display width at pointer-down, in world units. */
    readonly startW: number
    /** Node list at pointer-down, for the one undo step (§6.5). */
    readonly before: readonly CanvasNode[]
  }
  | {
    kind: 'connect'
    /**
     * The state machine's current step (G26).
     *
     * Mutable on purpose — the gesture object lives in a ref and every pointer
     * move advances this one field, exactly like `NudgeSession.after`. The React
     * mirror in `wire` is replaced wholesale so the preview repaints.
     */
    state: ConnectionState
    /** The canvas box's client offset, so a move converts without a reflow. */
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

/**
 * Consecutive layout-draft edits inside this window merge into one undo step.
 *
 * Typing a caption fires one change per character; without the merge a ten-word
 * caption would push a hundred steps and evict every real edit from the stack.
 * Shorter than the nudge window because the commands are bigger and the user is
 * less likely to be holding a key.
 */
const DRAFT_EDIT_MERGE_MS = 500

/**
 * Debounce for writing a layout node's draft to its board (C14).
 *
 * Dragging a box fires one editor change per pointer move; the board should see
 * one write per editing burst, not one per frame. Long enough to coalesce a
 * drag, short enough that closing the tab mid-thought still keeps the draft
 * (the unmount effect flushes it).
 */
const LAYOUT_PERSIST_DEBOUNCE_MS = 500

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
  // A layout node carries its own display box (§8.3: width-driven, height follows
  // the draft proportion); the task node is the fixed default box.
  if (isLayoutNode(node)) return { x: node.x, y: node.y, width: node.w, height: node.h }
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
    if (item.kind === 'layout') {
      const draft = item.draft
      // The store's v2 validator drops a layout entry without a draft, so this
      // is belt-and-braces against a hand-edited file.
      if (draft === undefined) return
      const width = clampLayoutNodeWidth(item.w ?? LAYOUT_NODE_DEFAULT_WIDTH)
      nodes.push({
        kind: 'layout',
        id: item.id,
        x: item.x ?? spot.x,
        y: item.y ?? spot.y,
        parents: item.parents,
        w: width,
        h: item.h ?? layoutNodeHeight(width, draft),
        draft,
      })
      return
    }
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

/**
 * Custom drag MIME for one asset card (§7.1).
 *
 * A private type keeps the canvas from accepting paragraph text or a dragged
 * link as if it were a library item; the OS-file path uses `dataTransfer.files`
 * instead and never carries this type.
 */
const FORGE_ASSET_MIME = 'application/x-dsh-forge-asset'

/** What an asset drag carries: the board it lives on and the item. */
interface DraggedAsset {
  readonly boardId: string
  readonly itemId: string
}

/** Parse the drag payload, refusing anything that is not exactly both strings. */
function parseDraggedAsset(raw: string): DraggedAsset | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.boardId !== 'string' || record.boardId.length === 0) return undefined
  if (typeof record.itemId !== 'string' || record.itemId.length === 0) return undefined
  return { boardId: record.boardId, itemId: record.itemId }
}

/**
 * Trigger one browser download for a Blob.
 *
 * A same-origin object URL + a synthetic `<a download>` click is the only
 * download mechanism available inside a plugin panel: the host page owns the
 * tab, so `window.open` on a blob URL would be blocked as a popup. The object
 * URL is revoked on the next tick, after the browser has taken it.
 */
function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.rel = 'noreferrer'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => { URL.revokeObjectURL(url) }, 0)
}

/** Decode one image from a same-origin URL; rejects on load/decoding failure. */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => { resolve(image) }
    image.onerror = () => { reject(new Error('图片加载失败')) }
    image.src = url
  })
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

/**
 * One board mutation, keeping the host's JSON body on success.
 *
 * The cross-board verbs (C12) need the written item back — a copy's id, its
 * landing spot — so they can put a node on the canvas without a second read.
 * The older callers only care about the refusal, so {@link postBoard} stays the
 * same one-line API they were written against.
 */
async function postBoardRaw(body: Record<string, unknown>): Promise<{ error?: string; payload?: Record<string, unknown> }> {
  try {
    const response = await fetch(STUDIO_BOARD_ROUTE, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = await readJson(response)
    if (response.ok) return payload === undefined ? {} : { payload }
    return { error: typeof payload?.error === 'string' ? payload.error : `画板操作失败（HTTP ${String(response.status)}）` }
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/** One board mutation; resolves to the host's refusal message, if any. */
async function postBoard(body: Record<string, unknown>): Promise<string | undefined> {
  return (await postBoardRaw(body)).error
}

/**
 * One environment action (`status` / `start` / `stop`).
 *
 * Resolves to the host's refusals as data instead of throwing: the status line
 * has to render "启动失败 + 日志路径" as text, not as an unhandled rejection. The
 * stop report's own note is kept apart from the snapshot's, because after a stop
 * the fresh snapshot describes what is left, while the stop note describes what
 * just happened.
 */
async function postEnvironment(action: 'status' | 'start' | 'stop'): Promise<{
  environment?: StudioEnvironmentSnapshot
  stopNote?: string
  error?: string
}> {
  try {
    const response = await fetch(STUDIO_ENVIRONMENT_ROUTE, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    const payload = (await readJson(response)) as StudioEnvironmentResponse | undefined
    if (!response.ok || payload === undefined) {
      return { error: typeof payload?.error === 'string' ? payload.error : `环境操作失败（HTTP ${String(response.status)}）` }
    }
    if (typeof payload.error === 'string' && payload.error.length > 0) return { error: payload.error }
    return {
      ...(payload.environment === undefined ? {} : { environment: payload.environment }),
      ...(typeof payload.stop?.note === 'string' ? { stopNote: payload.stop.note } : {}),
    }
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) }
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

/**
 * A layout node id.
 *
 * Not a board item id: this build cannot persist layout entries yet (the C13
 * report says why), so the id only has to be unique on this canvas. The alphabet
 * matches the board ids so a later persistence pass can adopt it unchanged.
 */
function makeLayoutNodeId(): string {
  return 'l' + Math.random().toString(36).slice(2, 10)
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
  if (params.layout !== undefined) parts.push('布局')
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

interface LayoutEditorMountProps {
  readonly node: LayoutCanvasNode
  readonly onDraft: (id: string, draft: BoardLayoutDraft) => void
}

/**
 * Mount one editor instance for one layout node (§8.1).
 *
 * The editor is imperative (it owns its DOM), so it lives in an effect and is
 * destroyed when the node unmounts or the board switches — that is the whole
 * lifecycle contract §8.3 asks for. Draft changes flow out through `onDraft`;
 * an undo replaces the node object, and the second effect pushes that draft back
 * into the live editor so undo is visible from the inside too.
 */
function LayoutEditorMount(props: LayoutEditorMountProps): ReturnType<typeof createElement> {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<LayoutEditorHandle | undefined>(undefined)
  const latestRef = useRef(props)
  latestRef.current = props
  const appliedDraftRef = useRef<BoardLayoutDraft>(props.node.draft)
  // An imperative editor that throws inside an effect unmounts the whole panel,
  // which reads as "the plugin page went blank". Keep the failure local: show it
  // on the node and leave every other node (and the panel) alive.
  const [mountError, setMountError] = useState<string | undefined>(undefined)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return undefined
    const node = latestRef.current.node
    appliedDraftRef.current = node.draft
    let editor: LayoutEditorHandle | undefined
    try {
      editor = mountLayoutEditor(host, {
        draft: node.draft as unknown as LayoutDraft,
        onChange: (state: LayoutEditorState) => {
          const draft = stateToDraft(state)
          appliedDraftRef.current = draft
          const current = latestRef.current
          current.onDraft(current.node.id, draft)
        },
      })
      editorRef.current = editor
      setMountError(undefined)
    } catch (error) {
      setMountError(error instanceof Error ? error.message : String(error))
      return undefined
    }
    // Destroy on unmount / node id change. A strict-mode double mount creates,
    // tears down and creates again; the editor's destroy removes its root, so
    // the second mount starts from an empty host. See the C13 report for what
    // was and was not verified about StrictMode in the host shell.
    return () => {
      editorRef.current = undefined
      try {
        editor?.destroy()
      } catch {
        // A destroy failure must not run during unmount as an unhandled throw.
      }
    }
  }, [props.node.id])

  // Undo/redo swaps the node's draft object; mirror it into the live editor.
  useEffect(() => {
    const editor = editorRef.current
    if (editor === undefined) return
    if (appliedDraftRef.current === props.node.draft) return
    appliedDraftRef.current = props.node.draft
    try {
      editor.setState(draftToEditorState(props.node.draft as unknown as LayoutDraft))
    } catch (error) {
      setMountError(error instanceof Error ? error.message : String(error))
    }
  }, [props.node.draft])

  if (mountError !== undefined) {
    return createElement(
      'div',
      { className: 'dsh-forge-layout-error', title: mountError },
      '布局编辑器加载失败：' + mountError,
    )
  }
  return createElement('div', { ref: hostRef, className: 'dsh-forge-layout-host' })
}

/**
 * What a mounted canvas engine can be asked to do imperatively (U04 step 2).
 *
 * Structural on purpose: `./canvas-pane.ts` owns the real type, and this file
 * must not import it (the pane imports *this* module for `StudioPanel`, so a
 * type import would close a cycle the bundler refuses). Only the two calls the
 * studio's own toolbar makes are declared — the rest of the engine's handle is
 * for later phases and stays behind its own module.
 */
export interface CanvasEngine {
  /** Frame every node; `clamped` says the zoom floor left some of them out. */
  fitView(): { readonly clamped: boolean }
  /** Multiply the zoom around the viewport centre. */
  zoomBy(factor: number): void
}

/**
 * What a host may hand the panel (U04 step 1b).
 *
 * Both props exist to let the tabbed shell own a *board* and the *canvas
 * engine* without this file having to import either:
 *
 * - `boardId` is the tab's board (§14.5). Without it the panel falls back to the
 *   profile's `activeBoard`, which is what every pre-U04 mount did.
 * - `canvas` is the component that renders the canvas area. The shell supplies
 *   `FlowCanvas` from `./canvas-pane.ts`; a mount that supplies nothing keeps the
 *   pre-U04 DOM renderer, which is what any host outside the shell (and the
 *   manual canvas checklist) still gets.
 */
export interface StudioPanelProps {
  /** The board this panel should open; absent means "the profile's active one". */
  readonly boardId?: string
  /** The canvas element the panel should render in place of its own. */
  readonly canvas?: unknown
}

/**
 * Render the workbench.
 *
 * @param props - the owning tab's board and canvas engine (see
 *   {@link StudioPanelProps}); both are optional so the component still mounts
 *   standalone.
 * @returns the panel tree; every fetch is same-origin and cancellable.
 */
export function StudioPanel(props?: StudioPanelProps): ReturnType<typeof createElement> {
  // Read once per render: the shell passes a component, and a fresh read keeps
  // the branch below honest without threading it through every helper.
  const canvasSlot = props?.canvas
  const preferredBoardId = props?.boardId
  const [config, setConfig] = useState<StudioConfigResponse | undefined>(undefined)
  const [configError, setConfigError] = useState<string | undefined>(undefined)
  // P2: the environment snapshot (state/pid/owned/logPath) is its own concern,
  // separate from the capability snapshot: the capability probe answers "can this
  // workbench generate", while the environment answers "which process is running
  // and is it mine to stop".
  const [environment, setEnvironment] = useState<StudioEnvironmentSnapshot | undefined>(undefined)
  const [environmentBusy, setEnvironmentBusy] = useState<'start' | 'stop' | undefined>(undefined)
  const [environmentError, setEnvironmentError] = useState<string | undefined>(undefined)
  const [environmentNote, setEnvironmentNote] = useState<string | undefined>(undefined)
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
  // The last place the pointer was over the canvas, **viewport-relative** (G12).
  // A paste lands there instead of at the view centre, which is where the eye is.
  // Unset until the user has pointed at the canvas once, so the paste falls back
  // to the centre rather than inventing a spot.
  const pointerScreenRef = useRef<Point | undefined>(undefined)
  const frameRef = useRef<number | undefined>(undefined)
  // G26: the prompt field. A node created by dropping a wire is a promise that
  // the next thing the user does is describe a picture, so the drop moves the
  // cursor there instead of leaving them to find the form.
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
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
  // G25: "copy/move to board…" asks which board, and the answer is a small list
  // placed where the menu was. It is a mode of the canvas, not a new dialog
  // framework: one panel, one click, dismissed by Escape or a blank click.
  const [transfer, setTransfer] = useState<{
    readonly mode: 'copy' | 'move'
    readonly ids: readonly string[]
    readonly x: number
    readonly y: number
  } | undefined>(undefined)
  // G22: the in-canvas lightbox. Opening a picture used to mean a new browser tab
  // and losing the canvas; this is the node id being looked at, and everything
  // else (the picture, its title, its neighbours) is derived from the board.
  const [lightboxId, setLightboxId] = useState<string | undefined>(undefined)
  // G26: the wire being dragged out of a node's output handle. `undefined` when
  // no wire is in flight; the state machine itself lives in
  // `./canvas-connections.ts` and this is only the render mirror of it.
  const [wire, setWire] = useState<ConnectionState | undefined>(undefined)
  // G26: where a wire dropped on blank canvas landed, and what it may become.
  // Screen-space like the context menu, because a menu that scaled with the zoom
  // would be unreadable at 0.1.
  const [wireMenu, setWireMenu] = useState<{
    readonly x: number
    readonly y: number
    /** Release point in world units: the new node's top-left corner. */
    readonly world: Point
    /** The node the wire came from, which becomes the new node's parent. */
    readonly sourceId: string
  } | undefined>(undefined)
  // G28: the asset picker the wire menu's third entry grows. It lives *inside*
  // that card, so all it has to carry is what the picked node inherits: the
  // release point in world units and the node the wire came from. `undefined`
  // means the picker is closed, and opening it builds nothing by itself.
  const [assetPick, setAssetPick] = useState<{
    /** Release point in world units: the picked node's top-left corner. */
    readonly world: Point
    /** The node the wire came from, which becomes the picked node's parent. */
    readonly sourceId: string
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
  // U04 step 2: the mounted canvas engine's imperative handle, when the shell
  // supplies one. The toolbar's 适应 / + / − go through it, because React Flow
  // owns the camera and this component's `camera` state is only a mirror of it.
  const flowEngineRef = useRef<CanvasEngine | undefined>(undefined)
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
  const pendingReplaceRef = useRef<{ readonly id: string; readonly layout?: string } | undefined>(undefined)
  // C14 persistence: ids the board already stores (pictures always, task/layout
  // nodes once their terminal/draft write landed), and the pending draft saves.
  const persistedIdsRef = useRef<Set<string>>(new Set())
  const layoutPersistTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  // Filled in once the layout persistence callback exists (it is declared after
  // the unmount effect); the cleanup calls it through the ref to flush drafts.
  const layoutFlushRef = useRef<() => void>(() => {})
  // C15/DD12: ids whose coordinates changed since the last successful layout
  // write, plus the camera that write carried. The debounce now sends only this
  // subset — a 1000-node board no longer PUTs its whole arrangement per drag.
  const dirtyIdsRef = useRef<Set<string>>(new Set())
  const lastCameraRef = useRef<Camera | undefined>(undefined)
  // C15/DD14: the board's stored items, so the JSON export keeps prompt/seed
  // metadata that the canvas nodes themselves do not carry; `boardMetaRef` keeps
  // the read board's timestamps/session for the same export.
  const boardItemsRef = useRef<Map<string, BoardItem>>(new Map())
  const boardMetaRef = useRef<BoardDetail | undefined>(undefined)
  // C12: the cross-board clipboard is memory-only (§6.3: never the system
  // clipboard), and a reveal request can wait for the canvas to be mounted.
  const clipboardRef = useRef<{ readonly boardId: string; readonly itemIds: readonly string[] } | undefined>(undefined)
  const pendingRevealRef = useRef<string | undefined>(undefined)
  // §6.5: layout draft edits are undoable, coalesced so typing is one step.
  const draftEditRef = useRef<{ at: number; id: string; after: CanvasNode[]; command: Command } | undefined>(undefined)
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
      setTransfer(undefined)
      persistedIdsRef.current = new Set()
      dirtyIdsRef.current.clear()
      lastCameraRef.current = undefined
      boardItemsRef.current = new Map()
      boardMetaRef.current = undefined
      for (const timer of layoutPersistTimersRef.current.values()) clearTimeout(timer)
      layoutPersistTimersRef.current.clear()
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
      // Everything a board hands back is on disk by definition; a later failure
      // or layout write is what adds to this set during the session.
      persistedIdsRef.current = new Set(loaded.map((node) => node.id))
      boardItemsRef.current = new Map(board.items.map((item) => [item.id, item]))
      boardMetaRef.current = board
      // A fresh read is the baseline for DD12: nothing is dirty and the camera is
      // whatever the board stored (so opening a board never writes it back).
      dirtyIdsRef.current.clear()
      lastCameraRef.current = board.camera ?? { x: -28, y: -28, zoom: 1 }
      for (const timer of layoutPersistTimersRef.current.values()) clearTimeout(timer)
      layoutPersistTimersRef.current.clear()
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

  /**
   * Read the environment snapshot (`status`), silently.
   *
   * A failed status read is deliberately *not* turned into a red banner: the
   * capability snapshot already says "ComfyUI 未就绪", and the environment line
   * simply keeps whatever it had. Only an explicit start/stop failure is shown,
   * because that is the one the user asked for and can act on.
   */
  const loadEnvironment = useCallback(async () => {
    const result = await postEnvironment('status')
    if (result.error !== undefined || result.environment === undefined) return
    setEnvironment(result.environment)
    setEnvironmentError(undefined)
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
      // empty library means an empty canvas, not a stale one. A tab that named
      // its board wins over the profile's "last open" one (§14.5).
      await openBoard(preferredBoardId ?? snapshot.activeBoard ?? undefined, signal)
      // Reading the environment is what tells the status line whether the
      // running backend is *this plugin's* (and therefore stoppable).
      await loadEnvironment()
    } catch (cause) {
      if (signal?.aborted === true) return
      setConfigError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [loadEnvironment, openBoard, preferredBoardId])

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

  /**
   * One start/stop, then both snapshots re-read.
   *
   * Re-reading the capability snapshot is part of the action, not decoration: it
   * decides whether the form is usable, so a finished start that left `ready`
   * false would show every control disabled next to a running renderer.
   */
  const runEnvironmentAction = useCallback(async (action: 'start' | 'stop') => {
    setEnvironmentBusy(action)
    setEnvironmentError(undefined)
    setEnvironmentNote(undefined)
    try {
      const result = await postEnvironment(action)
      if (result.environment !== undefined) setEnvironment(result.environment)
      if (result.error !== undefined) {
        setEnvironmentError(result.error)
        return
      }
      // Compose the message here, from the action's *own* response: the snapshot
      // `loadConfig` fetches next describes what is left afterwards, and its
      // logPath may already be gone. A stop's note explains what it did; a
      // start's note is the snapshot's.
      const note = result.stopNote ?? result.environment?.note
      const logPath = result.environment?.logPath
      setEnvironmentNote(
        note === undefined
          ? undefined
          : (logPath !== undefined && !note.includes(logPath) ? `${note} 日志：${logPath}` : note),
      )
      const controller = new AbortController()
      await loadConfig(controller.signal)
    } finally {
      setEnvironmentBusy(undefined)
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

  // T22 stepper: a projection of the config snapshot + live SSE phase. The
  // install/download actions live in the managed environment tool; this block's
  // own action is "重新检测", which re-reads the snapshot.
  const stepperInput = useMemo(() => ({
    ready: config?.ready === true,
    ...(config?.reason === undefined ? {} : { reason: config.reason }),
    ...(config?.models === undefined ? {} : { models: config.models }),
    ...(config?.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    itemCount: boards.reduce((sum, entry) => sum + entry.itemCount, 0),
    livePhase: live.phase,
    ...(live.percent === undefined ? {} : { livePercent: live.percent }),
    ...(live.message === undefined ? {} : { liveMessage: live.message }),
  }), [boards, config, live])
  const stepperSteps = useMemo(() => stepperStepsOf(stepperInput), [stepperInput])

  const selectedBatch = useMemo(
    () => batches.find((batch) => batch.id === selectedId) ?? batches[0],
    [batches, selectedId],
  )

  const sizeFor = useMemo(() => {
    const table = config?.sizes ?? []
    return (value: string) => table.find((entry) => entry.ratio === value)
  }, [config])

  /** Write the arrangement back to the board — only what changed (DD12). */
  const persistLayout = useCallback(async () => {
    const board = boardIdRef.current
    const dirty = [...dirtyIdsRef.current]
    const camera = cameraRef.current
    const sentCamera = lastCameraRef.current
    const cameraChanged = sentCamera === undefined
      || sentCamera.x !== camera.x
      || sentCamera.y !== camera.y
      || sentCamera.zoom !== camera.zoom
    if (board === undefined) {
      dirtyIdsRef.current.clear()
      lastCameraRef.current = camera
      return
    }
    // A camera-only change is a real save (that is how the view reopens where it
    // was); a no-op flush is not.
    if (dirty.length === 0 && !cameraChanged) return
    const error = await postBoard({
      action: 'layout',
      board,
      // Pictures are board items; a task node is only a board item once its
      // terminal state was stored (DD6: a running task is never persisted), and
      // a layout node once its draft write landed. Everything else is session
      // state that no reload should see.
      items: nodesRef.current
        .filter((node) => dirtyIdsRef.current.has(node.id))
        .filter((node) => isImageNode(node) || persistedIdsRef.current.has(node.id))
        // G26: an edge rides along with the position it was drawn at. `parents`
        // is omitted for a node without lineage, so a board that never used the
        // gesture sends byte-identical requests to the ones it always did.
        .map((node) => ({
          id: node.id,
          x: node.x,
          y: node.y,
          ...(node.parents.length === 0 ? {} : { parents: [...node.parents] }),
        })),
      ...(cameraChanged ? { camera } : {}),
    })
    if (error !== undefined) {
      // Keep the dirty set: the next flush retries these positions rather than
      // losing them to a transient refusal.
      setBoardError(error)
      return
    }
    // Delete only what this request carried: a drag that happened while the
    // request was in flight stays dirty for the next one.
    for (const id of dirty) dirtyIdsRef.current.delete(id)
    lastCameraRef.current = camera
  }, [])

  /** Mark coordinates dirty; the next debounced flush carries them. */
  const markDirty = useCallback((ids: Iterable<string>) => {
    for (const id of ids) dirtyIdsRef.current.add(id)
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
    // Drafts use their own debounce; a close must not lose a box the user drew.
    layoutFlushRef.current()
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
    // G28: the asset page and the wire menu's picker are the same list, so both
    // keep it loaded with the same scope and filter — one reader, two surfaces.
    if (view !== 'assets' && assetPick === undefined) return undefined
    const controller = new AbortController()
    // Typing in the filter should not fire one request per keystroke.
    const timer = setTimeout(() => { void loadAssets(controller.signal) }, 220)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [view, assetPick, boardId, assetScope, assetQuery, loadAssets])

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

  /** Adopt a board the host created or updated while we wrote a node (DD7/C14). */
  const adoptBoard = useCallback((board: BoardSummary | undefined) => {
    if (board === undefined) return
    setBoards((current) => upsertBoard(current, board))
    if (boardIdRef.current !== board.id) {
      setBoardId(board.id)
      setBoardName(board.name)
      boardIdRef.current = board.id
    }
  }, [])

  /**
   * Store a terminal task node (§4.6, DD6).
   *
   * Only failure/interruption is written — a running task is session state, and
   * a reload that restored "generating" would be lying. The write is
   * best-effort: a broken metadata directory must not cost the user the retry
   * button, so the node stays on the canvas either way.
   */
  const persistTerminalTask = useCallback(async (clientId: string) => {
    const node = nodesRef.current.find((entry): entry is TaskCanvasNode => isTaskNode(entry) && entry.clientId === clientId)
    if (node === undefined) return
    if (node.status !== 'failed' && node.status !== 'interrupted') return
    const { error, payload } = await postBoardRaw({
      action: 'save-task',
      ...(boardIdRef.current === undefined ? {} : { board: boardIdRef.current }),
      item: node.id,
      x: node.x,
      y: node.y,
      ...(node.parents.length === 0 ? {} : { parents: [...node.parents] }),
      task: {
        status: node.status,
        params: node.params,
        ...(node.error === undefined ? {} : { error: node.error }),
      },
    })
    if (error !== undefined) {
      setBoardError(error)
      return
    }
    adoptBoard(payload?.board as BoardSummary | undefined)
    const item = payload?.item as BoardItem | undefined
    if (item === undefined) return
    persistedIdsRef.current.add(item.id)
    if (item.id !== node.id) {
      writeNodes(nodesRef.current.map((entry) => (entry.id === node.id ? { ...entry, id: item.id } : entry)))
    }
  }, [adoptBoard, writeNodes])

  /**
   * Write one layout node's draft and display box (§8.1, C14).
   *
   * The draft is what a later generation compiles, so it has to survive a
   * reload; the display box rides along because a resize is a user decision
   * too. The node's own id is sent so the first write does not rename it and
   * the edges drawn to it stay valid.
   */
  const persistLayoutNode = useCallback(async (id: string) => {
    const node = nodesRef.current.find((entry) => entry.id === id)
    if (node === undefined || !isLayoutNode(node)) return
    const { error, payload } = await postBoardRaw({
      action: 'save-layout-node',
      ...(boardIdRef.current === undefined ? {} : { board: boardIdRef.current }),
      item: node.id,
      x: node.x,
      y: node.y,
      draft: node.draft,
      w: node.w,
      h: node.h,
      ...(node.parents.length === 0 ? {} : { parents: [...node.parents] }),
    })
    if (error !== undefined) {
      setBoardError(error)
      return
    }
    adoptBoard(payload?.board as BoardSummary | undefined)
    const item = payload?.item as BoardItem | undefined
    if (item === undefined) return
    persistedIdsRef.current.add(item.id)
    if (item.id !== id) {
      writeNodes(nodesRef.current.map((entry) => (entry.id === id ? { ...entry, id: item.id } : entry)))
    }
  }, [adoptBoard, writeNodes])

  // The unmount flush above runs before this callback is declared in source
  // order, so hand it the implementation here (runs every render, cheap).
  layoutFlushRef.current = () => {
    for (const [id, timer] of layoutPersistTimersRef.current) {
      clearTimeout(timer)
      layoutPersistTimersRef.current.delete(id)
      void persistLayoutNode(id)
    }
  }

  /** Coalesce layout-node writes: a box drag fires one change per frame. */
  const scheduleLayoutPersist = useCallback((id: string) => {
    const timers = layoutPersistTimersRef.current
    const existing = timers.get(id)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      timers.delete(id)
      void persistLayoutNode(id)
    }, LAYOUT_PERSIST_DEBOUNCE_MS)
    timers.set(id, timer)
  }, [persistLayoutNode])

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
    if (changed) {
      writeNodes(next)
      // C14: a terminal failure is the one task state worth persisting (DD6), so
      // tomorrow's board shows why the run failed and can retry it in place.
      void persistTerminalTask(clientId)
    }
  }, [persistTerminalTask, writeNodes])

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
    adoptBoard(result.board)
    const next = nodesRef.current.filter((node) => node.id !== taskNode.id)
    const created: ImageCanvasNode[] = []
    // G15: the extra images of a batch fan out from the task node's own spot —
    // the parent they belong to — instead of appending to the right-most node on
    // the board, which turned a 20-image batch into one 20-node row.
    const origin = nodeRect(taskNode)
    result.images.forEach((image: StudioImage, index: number) => {
      const spot = index === 0
        ? { x: taskNode.x, y: taskNode.y }
        : nextNodeSpot(next.map(nodeRect), origin, nodeDisplaySize(image.width, image.height))
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
    // The host recorded these items before answering, so they are on disk now:
    // a later removal has to go through the board route.
    for (const node of created) {
      persistedIdsRef.current.add(node.id)
      boardItemsRef.current.set(node.id, {
        id: node.id,
        kind: 'image',
        path: node.image.path,
        markdownPath: node.image.markdownPath,
        width: node.image.width,
        height: node.image.height,
        bytes: node.image.bytes,
        mediaType: node.image.mediaType,
        prompt: result.prompt,
        ratio: result.ratio,
        steps: result.steps,
        seed: result.seed,
        mode: result.mode,
        backend: 'studio',
        parents: [...node.parents],
        createdAt: new Date().toISOString(),
        sessionId: null,
        batchId: node.batchId,
        x: node.x,
        y: node.y,
      })
    }
    markDirty(created.map((node) => node.id))
    scheduleLayout()
    if (created[0] !== undefined) setSelection(new Set([created[0].id]))
  }, [adoptBoard, failTask, scheduleLayout, writeNodes])

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
    // C14: a retry replaces the node in place. If the old failure was stored,
    // that board entry has to go now — a running task is never persisted, and
    // leaving yesterday's failure behind would show two nodes after a reload.
    if (previous !== undefined && persistedIdsRef.current.has(previous.id)) {
      persistedIdsRef.current.delete(previous.id)
      const board = boardIdRef.current
      if (board !== undefined) {
        void postBoard({ action: 'remove-item', board, item: previous.id }).then((error) => {
          if (error !== undefined) setBoardError(error)
        })
      }
    }
    const clientId = makeClientId()
    // G15: a run that carries canvas parents is placed relative to the parent it
    // grows from, not at the end of the board's right-most column.
    const parentNode = (options.parents ?? previous?.parents ?? [])
      .map((id) => nodesRef.current.find((node) => node.id === id))
      .find((node): node is CanvasNode => node !== undefined)
    const spot = previous === undefined
      ? nextNodeSpot(
        nodesRef.current.map(nodeRect),
        parentNode === undefined ? undefined : nodeRect(parentNode),
        { width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT },
      )
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
          ...(params.layout === undefined ? {} : { layout: params.layout }),
          // C14: the canvas parents ride along as board item ids so the recorded
          // picture keeps the edge to a layout node (which has no path to resolve).
          ...(taskNode.parents.length === 0 ? {} : { parents: [...taskNode.parents] }),
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
    // The compiled layout is part of the request snapshot; a form edit must not
    // silently drop the conditioning when the user re-sends.
    pendingReplaceRef.current = {
      id: node.id,
      ...(node.params.layout === undefined ? {} : { layout: node.params.layout }),
    }
    setNote('参数已回填表单；改完再点「生成」会替换这个失败节点（布局参数保留）。')
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
    const replace = pendingReplaceRef.current
    pendingReplaceRef.current = undefined
    const params: BoardTaskParams = {
      prompt: text,
      ratio,
      ...(parsedSteps === undefined || !Number.isFinite(parsedSteps) ? {} : { steps: parsedSteps }),
      count,
      ...(requested.length === 0 ? {} : { references: requested }),
      // §4.5 / C14: editing a layout-derived failure must not drop its layout.
      ...(replace?.layout === undefined ? {} : { layout: replace.layout }),
    }
    // Canvas-held references are the edge's source, exactly as before (§4.5):
    // the task node's parents become the picture's parents on conversion.
    const parents = references
      .map((entry) => entry.nodeId)
      .filter((id): id is string => typeof id === 'string')
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
  /**
   * Generate from a layout node (§8.4, C14).
   *
   * The compiled export is the request's `layout` (T21's contract: it becomes
   * MOSS's positive conditioning text verbatim), the draft's whole-image
   * caption is the prompt, and the canvas ratio is the nearest official one —
   * but only when the draft is within 1% of it. A draft composed at an
   * unofficial aspect is refused with the nearest ratio named, because §8.4
   * forbids silently stretching the drawn boxes.
   */
  const generateLayoutNode = useCallback((nodeId: string) => {
    const node = nodesRef.current.find((entry) => entry.id === nodeId)
    if (node === undefined || !isLayoutNode(node)) return
    if (node.draft.items.length === 0) {
      setNote('布局至少需要一个画框：先在内嵌编辑器里拖出一个框，再生成。')
      return
    }
    const caption = typeof node.draft.summary.caption === 'string' ? node.draft.summary.caption.trim() : ''
    if (caption.length === 0) {
      setNote('布局缺少整图描述（summary.caption）；MOSS 把它当布局 prompt 的语义锚点，先写上。')
      return
    }
    let compiled: string
    try {
      compiled = compileLayout(node.draft as unknown as LayoutDraft)
    } catch (error) {
      setNote('布局还不能生成：' + (error instanceof Error ? error.message : String(error)))
      return
    }
    if (compiled.length > STUDIO_MAX_LAYOUT_CHARS) {
      setNote('布局 compiled 超过 ' + String(STUDIO_MAX_LAYOUT_CHARS) + ' 字符上限。')
      return
    }
    const fit = fitStudioRatio(node.draft.width, node.draft.height)
    if (fit === undefined) {
      setNote('布局 draft 尺寸无效，无法映射到官方画幅比例。')
      return
    }
    if (fit.deviation > STUDIO_LAYOUT_RATIO_TOLERANCE) {
      setNote(
        '布局 draft 比例 ' + String(node.draft.width) + '×' + String(node.draft.height) +
          ' 不在官方七档内（最接近 ' + fit.ratio + '，偏差 ' + (fit.deviation * 100).toFixed(1) +
          '%）；请把 draft 尺寸改到七档比例，不静默拉伸。',
      )
      return
    }
    const params: BoardTaskParams = {
      prompt: caption,
      ratio: fit.ratio,
      count: 1,
      layout: compiled,
    }
    setNote('已按布局 ' + fit.ratio + ' 提交 MOSS 生成（compiled 作为正向编码文本）。')
    void startGeneration(params, { parents: [node.id] })
  }, [startGeneration])

  const reuse = useCallback((batch: Batch) => {
    setPrompt(batch.response.prompt)
    setRatio(batch.response.ratio)
    setSteps(String(batch.response.steps))
    setSelectedId(batch.id)
  }, [])

  // Wheel semantics (G01): a bare wheel scrolls the canvas, Ctrl/⌘+wheel zooms.
  // Registered natively, not through `onWheel`: React attaches wheel listeners
  // passively, so `preventDefault` there is ignored and the whole settings page
  // scrolls while the canvas moves.
  useEffect(() => {
    const element = canvasRef.current
    if (element === null || view !== 'canvas') return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const intent = wheelIntent(event)
      if (intent.kind === 'pan') {
        setCamera((current) => panByScroll(current, intent.delta))
        return
      }
      if (intent.factor === 1) return
      const box = element.getBoundingClientRect()
      const anchor = { x: event.clientX - box.left, y: event.clientY - box.top }
      setCamera((current) => zoomAt(current, intent.factor, anchor))
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

  /**
   * Frame every node; a no-op on an empty canvas so the view never jumps.
   *
   * G15: `fitCamera` clamps at {@link CANVAS_MIN_ZOOM}, so a board wide enough to
   * need less than 10% was framed *around* its centre with the far nodes still
   * off-screen — and said nothing. The note below is the missing half of that
   * interaction: it is set only when the clamp actually bit, so a normal fit
   * leaves whatever the panel was already saying alone.
   */
  const fitView = useCallback(() => {
    // U04 step 2: with an engine mounted, *it* owns the camera and the fit; the
    // DOM canvas's camera maths below would otherwise move a camera nothing
    // draws. The clamp note is still this component's business — G15's promise
    // is that a fit which cannot frame the board says so.
    const engine = flowEngineRef.current
    if (engine !== undefined) {
      if (engine.fitView().clamped) {
        setNote('已到最小缩放（10%），还有节点在视口外：用滚轮平移过去，或把这张画布拆成多个画板。')
      }
      return
    }
    const element = canvasRef.current
    if (element === null) return
    const box = element.getBoundingClientRect()
    const rects = nodes.map(nodeRect)
    const viewport = { width: box.width, height: box.height }
    setCamera(fitCamera(rects, viewport))
    if (fitNeedsClamp(rects, viewport)) {
      setNote('已到最小缩放（10%），还有节点在视口外：用滚轮平移过去，或把这张画布拆成多个画板。')
    }
    scheduleLayout()
  }, [nodes, scheduleLayout])

  /* ------------------------------------------------------------------------ */
  /* Selection, movement and the undo stack (§6.1, §6.2, §6.5)                 */
  /* ------------------------------------------------------------------------ */

  /** Set the coordinates of every node in `positions` in one write. */
  const applyPositions = useCallback((positions: ReadonlyMap<string, Point>) => {
    // DD12: only these ids need to reach the board — including an undo, which
    // has to restore the stored position as well as the drawn one.
    markDirty(positions.keys())
    writeNodes(nodesRef.current.map((node) => {
      const point = positions.get(node.id)
      return point === undefined ? node : { ...node, x: point.x, y: point.y }
    }))
  }, [markDirty, writeNodes])

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

  /**
   * A finished drag from the canvas engine, as one undoable step.
   *
   * The engine reports a drag **once**, when the pointer is released, and only
   * the ids that actually moved (see "no write per frame" in
   * `./canvas-pane.ts`): nothing arrives mid-gesture, so this is the same path an
   * alignment takes — one command on the undo stack, one debounced save. An
   * empty map means the gesture ended where it began and nothing is recorded.
   */
  const moveNodesFromGesture = useCallback((positions: ReadonlyMap<string, Point>) => {
    if (positions.size === 0) return
    applyPositionsCommand('drag', new Map(positions))
  }, [applyPositionsCommand])

  /**
   * Mirror the engine's camera into this component's state.
   *
   * Two things read it: the toolbar's zoom label, and the board's stored
   * `camera`. A camera-only flush is a legitimate save (it is how a board
   * reopens where it was left), and it rides the same 700 ms debounce.
   */
  const adoptEngineCamera = useCallback((camera: Camera) => {
    setCamera(camera)
    scheduleLayout()
  }, [scheduleLayout])

  /** Take the engine's imperative handle, or drop it when that engine unmounts. */
  const adoptEngineApi = useCallback((engine: CanvasEngine | undefined) => {
    flowEngineRef.current = engine
  }, [])

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
  /**
   * Remove nodes from the canvas state only — no board write.
   *
   * Split out of {@link removeNodes} for the cross-board move (G25): a move has
   * already taken the entry off the server-side board, so posting `remove-item`
   * afterwards would 404 ("这张图不在画板里"). Everything else the removal used
   * to do locally — the undo step, the reference cleanup, the cancelled layout
   * timers — still has to happen, and it must be the *same* code, not a copy.
   */
  const dropNodesLocally = useCallback((ids: readonly string[]): CanvasNode[] => {
    const drop = new Set(ids)
    if (drop.size === 0) return []
    const before = nodesRef.current
    const removed = before.filter((node) => drop.has(node.id))
    if (removed.length === 0) return []
    const after = before.filter((node) => !drop.has(node.id))
    writeNodes(after)
    // A reference pointing at a removed node would draw an edge to nothing.
    setReferences((current) => current.filter((entry) => entry.nodeId === undefined || !drop.has(entry.nodeId)))
    setSelection((current) => {
      const next = new Set<string>()
      for (const id of current) if (!drop.has(id)) next.add(id)
      return next
    })
    pushCommand(snapshotCommand('remove', before, after, (list) => { writeNodes([...list]) }))
    // A pending layout-draft write must not resurrect a removed node, and a
    // removed id must not ride along in the next layout diff.
    for (const id of drop) {
      dirtyIdsRef.current.delete(id)
      const timer = layoutPersistTimersRef.current.get(id)
      if (timer !== undefined) {
        clearTimeout(timer)
        layoutPersistTimersRef.current.delete(id)
      }
    }
    return removed
  }, [pushCommand, writeNodes])

  const removeNodes = useCallback((ids: readonly string[], deleteFile = false) => {
    const removed = dropNodesLocally(ids)
    if (removed.length === 0) return
    const board = boardIdRef.current
    if (board === undefined) return
    // Pictures are board items by construction; a task/layout node is one only
    // after its own write landed (C14). Anything else is canvas-only and must
    // not produce a 404 "not on the board" alert.
    for (const node of removed) {
      const stored = isImageNode(node) || persistedIdsRef.current.has(node.id)
      if (!stored) continue
      persistedIdsRef.current.delete(node.id)
      void postBoard({
        action: 'remove-item',
        board,
        item: node.id,
        // Only a picture has a file; asking to delete a task/layout entry's PNG
        // would be a no-op the store does not understand.
        ...(deleteFile && isImageNode(node) ? { deleteFile: true } : {}),
      }).then((error) => {
        if (error !== undefined) setBoardError(error)
      })
    }
  }, [dropNodesLocally])

  /** The single-node form the inline node actions still use. */
  const removeNode = useCallback((id: string) => { removeNodes([id]) }, [removeNodes])

  /** Replace the selection with exactly one node (or with none). */
  const selectOnly = useCallback((id: string | undefined) => {
    setSelection(id === undefined ? new Set() : new Set([id]))
  }, [])

  /* ------------------------------------------------------------------------ */
  /* G26: dragging a wire out of a handle                                      */
  /* ------------------------------------------------------------------------ */

  /**
   * Every node as the connection layer needs it: geometry plus lineage.
   *
   * Deliberately the **full** board, not `shown`: a wire may be dropped on a node
   * the culling pass left out (a huge board scrolled away from its parent), and
   * the cycle check has to see the parents of nodes that are not painted.
   */
  const connectNodes = useCallback((): Array<ConnectNode & { readonly parents: readonly string[] }> => (
    nodesRef.current.map((node) => ({ ...nodeRect(node), id: node.id, parents: node.parents }))
  ), [])

  /**
   * Turn a released wire into an edge: `to.parents += from`.
   *
   * No request is made. That is the whole point of the gesture (G26): "this one
   * came from that one" used to be expressible only by generating a picture, so
   * recording lineage cost a GPU run. Persistence rides on the same write the
   * position does — `persistLayout` for pictures, `scheduleLayoutPersist` for a
   * layout node, and the picture a task becomes for a task node — so there is one
   * board write per change, not a second mechanism.
   *
   * A re-drop of the same wire changes nothing, and `linkParents` returning the
   * identical array is how that is detected: no undo step, no save, no note.
   */
  const commitWireEdge = useCallback((fromId: string, toId: string) => {
    const target = nodesRef.current.find((node) => node.id === toId)
    const source = nodesRef.current.find((node) => node.id === fromId)
    if (target === undefined || source === undefined) return
    const parents = linkParents(target.parents, fromId)
    if (parents === target.parents) {
      setNote('这两个节点已经连着了。')
      return
    }
    const before = nodesRef.current
    const after = before.map((node) => (node.id === toId ? { ...node, parents } : node))
    writeNodes(after)
    pushCommand(snapshotCommand('connect-edge', before, after, (list) => { writeNodes([...list]) }))
    // A picture's lineage is part of its board entry, so the same debounced
    // layout write that carries positions carries the edge (G26 + DD12).
    markDirty([toId])
    scheduleLayout()
    // A layout node persists through its own writer, which already sends parents.
    if (isLayoutNode(target)) scheduleLayoutPersist(toId)
    setNote('已连线：' + (isImageNode(source) ? '来源图' : '来源节点') + ' → 这个节点；不会触发生成。')
  }, [markDirty, pushCommand, scheduleLayout, scheduleLayoutPersist, writeNodes])

  /** Release a wire on blank canvas: ask what to build there (G26). */
  const openWireMenu = useCallback((world: Point, sourceId: string, screen: Point) => {
    // The card the drop opens and the right-click menu are alternatives, not
    // neighbours: whichever gesture just ran, only its own card may be open
    // (the DOM canvas clears these at handle-press; the flow canvas reports the
    // press through `beginEngineConnection` instead).
    setMenu(undefined)
    setTransfer(undefined)
    setWireMenu({ x: screen.x, y: screen.y, world, sourceId })
  }, [])

  /**
   * A wire left a handle on the React Flow canvas (U04 step 3).
   *
   * Only the transient cards are cleared: the wire is about to decide where the
   * next node goes, and a menu left open behind it would be one click away from
   * acting on the wrong spot.
   */
  const beginEngineConnection = useCallback(() => {
    setMenu(undefined)
    setTransfer(undefined)
    setWireMenu(undefined)
    setAssetPick(undefined)
  }, [])

  /**
   * Execute what a released wire means (U04 step 3).
   *
   * The engine has already decided *which* of the three things happened
   * (`planConnectionDrop`), so this is a dispatch and nothing else — and it
   * dispatches onto the **same** callbacks the hand-rolled canvas uses, which is
   * what keeps one behaviour behind two renderers:
   *
   * - `edge` → `commitWireEdge`: `parents += source`, one debounced board write,
   *   one undo step. **No request is made** — recording lineage must not cost a
   *   generation (G26's whole point).
   * - `menu` → the same node-type card, at the release point, in container
   *   pixels so it does not scale with the zoom.
   * - `cancel` → nothing built, nothing saved, nothing on the undo stack. The
   *   two refusals a user cannot see the reason for (a cycle, a target that is
   *   not a picture) say why; the rest are silent by design.
   */
  const endEngineConnection = useCallback((event: FlowConnectionEvent) => {
    const plan = event.plan
    if (plan.kind === 'edge') {
      commitWireEdge(plan.sourceId, plan.toId)
      return
    }
    if (plan.kind === 'menu') {
      openWireMenu(plan.worldPoint, plan.sourceId, event.screen)
      return
    }
    if (plan.reason === 'cycle') {
      setNote('这条线会绕回去：血缘只能是单向的派生，不能成环。')
      return
    }
    if (plan.reason === 'kind') {
      setNote('只能连到图片节点：参考关系要有文件可指。')
      return
    }
    // `idle` / `returned` / `escaped` / `missing`: the user withdrew the wire.
  }, [commitWireEdge, openWireMenu])

  /**
   * Pointer-down on a node's output handle (G26 §1).
   *
   * `stopPropagation` is what keeps the node's own drag from starting — the
   * handle sits inside the node frame, so without it grabbing the dot would also
   * grab the picture. Pointer capture goes on the handle: the moves then bubble
   * through the node and the canvas layer to the one `onCanvasPointerMove`, which
   * is where every other gesture is flushed too.
   */
  const onHandlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, node: CanvasNode) => {
    if (event.button !== 0) return
    event.stopPropagation()
    event.preventDefault()
    setMenu(undefined)
    setTransfer(undefined)
    setWireMenu(undefined)
    setAssetPick(undefined)
    event.currentTarget.setPointerCapture(event.pointerId)
    // The canvas box, not the handle's: every coordinate in this gesture is
    // relative to the canvas (the camera is), and the handle is a dot hanging off
    // one node rather than the board itself. Before the canvas has been measured
    // (first frame, and the test harness, which has no DOM) the handle's box is
    // the only one there is.
    const box = canvasRef.current?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect()
    const screen = { x: event.clientX - box.left, y: event.clientY - box.top }
    const state = beginConnection({
      source: { id: node.id, ...nodeRect(node) },
      point: screenToWorld(cameraRef.current, screen),
      screen,
    })
    gestureRef.current = { kind: 'connect', state, left: box.left, top: box.top }
    setWire(state)
  }, [])

  /**
   * The output dot every node wears (G26).
   *
   * One element, three node kinds: the handle is about *lineage*, not about what
   * the node holds, so an image, a task and a layout node all pull a wire the
   * same way. `data-connect="out"` is the stable hook the panel tests address —
   * a class name can change, a data contract should not.
   *
   * G27: the element carries no size of its own. `.dsh-forge-handle` divides the
   * layer's `--dsh-forge-zoom`, so the dot is 11 screen px and the target 16 at
   * 10 % as well as at 800 % — a 10-px dot inside the zoomed layer was 1 px at
   * the floor, i.e. a gesture nobody could perform.
   */
  const connectHandle = useCallback((node: CanvasNode) => createElement('div', {
    className: 'dsh-forge-handle',
    'data-connect': 'out',
    'data-node-id': node.id,
    title: '拖出连线：拖到空白处新建节点，拖到已有节点上只连边（不生成）',
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => { onHandlePointerDown(event, node) },
  }), [onHandlePointerDown])

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
    // Any click outside the menu dismisses it (§6.4), and the same goes for the
    // board picker a copy/move entry opens (G25), the node-type menu a wire drop
    // opens (G26) and the asset picker that menu grows (G28).
    setMenu(undefined)
    setTransfer(undefined)
    setWireMenu(undefined)
    setAssetPick(undefined)
    // G12: remember where the pointer is, in viewport pixels, so a later paste
    // lands under it. Recorded before the node check because a click on a node
    // is just as good a "the user is looking here" signal as a click on blank.
    const wholeBox = event.currentTarget.getBoundingClientRect()
    pointerScreenRef.current = { x: event.clientX - wholeBox.left, y: event.clientY - wholeBox.top }
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
    setTransfer(undefined)
    // G12: the node stopped the event, so the canvas handler never saw it and
    // this is the only place a click on a picture can record the pointer.
    const canvasBox = canvasRef.current?.getBoundingClientRect()
    if (canvasBox !== undefined) {
      pointerScreenRef.current = { x: event.clientX - canvasBox.left, y: event.clientY - canvasBox.top }
    }
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
    if (gesture.kind === 'layout-resize') {
      // §8.3: resize changes the display width (clamped) and the height follows
      // the draft proportion. The draft itself is never touched.
      const width = clampLayoutNodeWidth(gesture.startW + (pointer.x - gesture.startX) / cameraRef.current.zoom)
      writeNodes(nodesRef.current.map((node) => (
        node.id === gesture.id && isLayoutNode(node)
          ? { ...node, w: width, h: layoutNodeHeight(width, node.draft) }
          : node
      )))
      return
    }
    if (gesture.kind === 'connect') {
      // G26: the pointer arrives in client pixels; the state machine wants both
      // spaces — screen for the threshold (so the gesture feels identical at any
      // zoom) and world for the hit test. `updateConnection` is the only place
      // that decides which phase the wire is in.
      const screen = { x: pointer.x - gesture.left, y: pointer.y - gesture.top }
      const next = updateConnection(gesture.state, {
        point: screenToWorld(cameraRef.current, screen),
        screen,
        nodes: connectNodes(),
      })
      gesture.state = next
      setWire(next)
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
  }, [applyPositions, connectNodes, writeNodes])

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
    if (gesture.kind === 'connect') {
      // G26: the release is classified by the same pure function the unit tests
      // pin down. Nothing is created here unless the wire really travelled and
      // really landed somewhere — a click, an Esc and a drag back onto the source
      // all fall out as `cancel`.
      setWire(undefined)
      const result = resolveDrop(gesture.state, connectNodes())
      if (result.kind === 'edge') {
        commitWireEdge(gesture.state.sourceId, result.toId)
        return
      }
      if (result.kind === 'menu') {
        // The menu is screen-space (it must not scale), the new node is
        // world-space (the drop point is where the user pointed).
        openWireMenu(result.worldPoint, gesture.state.sourceId, worldToScreen(cameraRef.current, result.worldPoint))
      }
      // `cancel`: the wire is dropped and nothing else happens.
      return
    }
    if (gesture.kind === 'layout-resize') {
      const resized = nodesRef.current.find((node) => node.id === gesture.id)
      if (resized === undefined || !isLayoutNode(resized) || resized.w === gesture.startW) return
      // One drag, one undo step; the draft (so the compiled text) is untouched,
      // which is the §8.2 invariant.
      pushCommand(snapshotCommand('layout-resize', gesture.before, nodesRef.current, (list) => { writeNodes([...list]) }))
      scheduleLayout()
      // The display box is a stored field (§8.3); write it with the draft save.
      scheduleLayoutPersist(gesture.id)
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
  }, [commitWireEdge, connectNodes, flushPointer, moveCommand, openWireMenu, pushCommand, scheduleLayout, scheduleLayoutPersist])

  /* ------------------------------------------------------------------------ */
  /* Asset flow (C12 §7): cards → canvas, cross-board copy/move, OS drops      */
  /* ------------------------------------------------------------------------ */

  /**
   * Centre the camera on one node (§7.4).
   *
   * If the canvas is not mounted yet (the panel was on the list/asset view),
   * the id is remembered and the effect below reveals it as soon as the canvas
   * exists — "wait for the board data, then compute the coordinates".
   */
  const revealNodeId = useCallback((id: string) => {
    const node = nodesRef.current.find((entry) => entry.id === id)
    const element = canvasRef.current
    if (node === undefined || element === null) {
      pendingRevealRef.current = id
      return
    }
    pendingRevealRef.current = undefined
    const box = element.getBoundingClientRect()
    const rect = nodeRect(node)
    setCamera(centerOn(
      { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      { width: box.width, height: box.height },
      cameraRef.current.zoom,
    ))
  }, [])

  useEffect(() => {
    if (view !== 'canvas') return
    const pending = pendingRevealRef.current
    if (pending === undefined) return
    revealNodeId(pending)
  }, [boardId, revealNodeId, view])

  /**
   * Put one item returned by the host onto the canvas at its stored spot.
   *
   * `parents` overrides the entry's own lineage: a copy carries the *source*
   * item's parents verbatim (§7.2), and the wire-drop gesture wants the node the
   * wire came from instead. Every other caller passes nothing and gets the
   * stored list.
   */
  const appendBoardItem = useCallback((item: BoardItem, board?: BoardSummary, parents?: readonly string[]) => {
    const fallback = nextNodeSpot(nodesRef.current.map(nodeRect))
    const node: ImageCanvasNode = {
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
      x: item.x ?? fallback.x,
      y: item.y ?? fallback.y,
      parents: parents === undefined ? item.parents : [...parents],
    }
    writeNodes([...nodesRef.current, node])
    if (board !== undefined) setBoards((current) => upsertBoard(current, board))
    // An imported/copied picture is recorded on the board before the host answers.
    persistedIdsRef.current.add(node.id)
    boardItemsRef.current.set(node.id, item)
    markDirty([node.id])
    scheduleLayout()
    return node
  }, [scheduleLayout, writeNodes])

  /**
   * Put one library asset on the canvas where the wire was released (G28).
   *
   * Two decisions are worth stating. **Why `copy-item`** even for an asset from
   * this very board: that route is the one verb that is defined as "the file is
   * not moved" (§7.2) — a same-board copy lands as a second node on the same
   * PNG, a cross-board one lands as this board's own entry — so the picked
   * picture keeps living where the user found it, and nothing here depends on
   * which board it came from.
   *
   * **Where the lineage is written**: the copy arrives carrying the *source*
   * item's parents, so the node is built with `[sourceId]` instead, and the
   * debounced layout flush carries that onto the stored entry (`saveLayout`
   * merges `parents` as a union — the entry itself already exists, so this is a
   * position+edge write, never a new file).
   *
   * The undo step is canvas-local, like every snapshot on this stack: it takes
   * the node back off the canvas, and the board entry a copy created is removed
   * with the node's own 移除 entry — the same asymmetry a cross-board paste has.
   */
  const placeAsset = useCallback(async (asset: StudioAsset) => {
    const pick = assetPick
    setAssetPick(undefined)
    if (pick === undefined) return
    const board = boardIdRef.current
    if (board === undefined) {
      setBoardError('先打开一个画板，再把素材放进画布')
      return
    }
    const { error, payload } = await postBoardRaw({
      action: 'copy-item',
      board: asset.boardId,
      item: asset.id,
      toBoard: board,
      x: pick.world.x,
      y: pick.world.y,
    })
    if (error !== undefined) {
      setBoardError(error)
      return
    }
    const item = payload?.item as BoardItem | undefined
    if (item === undefined) {
      setBoardError('素材没能放进画布：画板没有返回条目')
      return
    }
    const before = nodesRef.current
    const node = appendBoardItem(item, payload?.board as BoardSummary | undefined, [pick.sourceId])
    const after = nodesRef.current
    pushCommand(snapshotCommand('place-asset', before, after, (list) => { writeNodes([...list]) }))
    setSelection(new Set([node.id]))
    setWireMenu(undefined)
    setNote('已放入素材「' + describeAsset(asset) + '」，血缘指向来源节点；不会触发生成。')
  }, [appendBoardItem, assetPick, pushCommand, writeNodes])

  /** Begin dragging one asset card (§7.1: a private MIME, not plain text). */
  const startAssetDrag = useCallback((event: ReactDragEvent<HTMLDivElement>, asset: StudioAsset) => {
    const data = event.dataTransfer
    if (data === null || data === undefined) return
    data.setData(FORGE_ASSET_MIME, JSON.stringify({ boardId: asset.boardId, itemId: asset.id } satisfies DraggedAsset))
    data.setData('text/plain', asset.path)
    data.effectAllowed = 'copyMove'
  }, [])

  /**
   * A dropped library asset (§7.1).
   *
   * Same board means the node is already here, so the drop repositions it (one
   * undo step, one debounced save). Cross-board goes through the §7.2 route:
   * copy by default, move while Alt is held, landing at the pointer.
   */
  const dropAsset = useCallback(async (dragged: DraggedAsset, world: Point, move: boolean) => {
    const board = boardIdRef.current
    if (board === undefined) {
      setBoardError('先打开一个画板，再把素材拖进来')
      return
    }
    if (dragged.boardId === board) {
      const node = nodesRef.current.find((entry) => entry.id === dragged.itemId)
      if (node === undefined) return
      if (node.x === world.x && node.y === world.y) return
      const before = new Map([[node.id, { x: node.x, y: node.y }]])
      const after = new Map([[node.id, { x: world.x, y: world.y }]])
      writeNodes(nodesRef.current.map((entry) => (entry.id === node.id ? { ...entry, x: world.x, y: world.y } : entry)))
      markDirty([node.id])
      pushCommand(moveCommand('drag-in', before, after))
      scheduleLayout()
      return
    }
    const action = move ? 'move-item' : 'copy-item'
    const { error, payload } = await postBoardRaw({
      action,
      board: dragged.boardId,
      item: dragged.itemId,
      toBoard: board,
      x: world.x,
      y: world.y,
    })
    if (error !== undefined) {
      setBoardError(error)
      return
    }
    const item = payload?.item as BoardItem | undefined
    if (item === undefined) return
    const node = appendBoardItem(item, payload?.board as BoardSummary | undefined)
    setSelection(new Set([node.id]))
    revealNodeId(node.id)
  }, [appendBoardItem, moveCommand, pushCommand, revealNodeId, scheduleLayout, writeNodes])

  /**
   * Import OS files dropped on the canvas (DD10/§7.3).
   *
   * One request per file, landing rightwards from the drop point. A file that
   * is not a picture is refused up front with a message instead of being
   * uploaded only to be sniffed away.
   */
  const importFiles = useCallback(async (files: readonly File[], world: Point) => {
    const board = boardIdRef.current
    for (const [index, file] of files.entries()) {
      if (!(file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(file.name))) {
        setBoardError(`只支持 PNG / JPEG / WebP，已跳过 ${file.name}`)
        continue
      }
      if (file.size > STUDIO_IMPORT_MAX_ITEM_BYTES) {
        setBoardError(`${file.name} 超过 32 MB 上限，已跳过`)
        continue
      }
      const bytes = new Uint8Array(await file.arrayBuffer())
      try {
        const response = await fetch(STUDIO_IMPORT_ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: file.name,
            mediaType: mediaTypeOf(file),
            data: toBase64(bytes),
            ...(board === undefined ? {} : { board }),
            x: world.x + index * (CANVAS_NODE_WIDTH + 36),
            y: world.y,
          }),
        })
        const payload = await readJson(response)
        const item = payload?.item as BoardItem | undefined
        if (!response.ok || item === undefined) {
          setBoardError(typeof payload?.error === 'string' ? payload.error : `导入失败（HTTP ${String(response.status)}）`)
          continue
        }
        const node = appendBoardItem(item, payload?.board as BoardSummary | undefined)
        setSelection(new Set([node.id]))
      } catch (cause) {
        setBoardError(cause instanceof Error ? cause.message : String(cause))
      }
    }
  }, [appendBoardItem])

  /** Allow a drop only when it carries a library asset or OS files. */
  const onCanvasDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    const types = event.dataTransfer?.types
    if (types === undefined) return
    if ([...types].includes(FORGE_ASSET_MIME) || [...types].includes('Files')) event.preventDefault()
  }, [])

  /** The §7 network: same-board reposition, cross-board copy/move, or import. */
  const onCanvasDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const world = screenToWorld(cameraRef.current, { x: event.clientX - box.left, y: event.clientY - box.top })
    const raw = event.dataTransfer?.getData(FORGE_ASSET_MIME)
    if (typeof raw === 'string' && raw.length > 0) {
      event.preventDefault()
      const dragged = parseDraggedAsset(raw)
      if (dragged !== undefined) void dropAsset(dragged, world, event.altKey)
      return
    }
    const files = [...(event.dataTransfer?.files ?? [])]
    if (files.length === 0) return
    event.preventDefault()
    void importFiles(files, world)
  }, [dropAsset, importFiles])

  /** Ctrl+C (§6.3): remember the selected pictures together with their board. */
  const copySelection = useCallback(() => {
    const board = boardIdRef.current
    if (board === undefined) return
    const itemIds = nodesRef.current
      .filter((node) => isImageNode(node) && selection.has(node.id))
      .map((node) => node.id)
    if (itemIds.length === 0) return
    clipboardRef.current = { boardId: board, itemIds }
    setNote(`已复制 ${String(itemIds.length)} 个节点；切到目标画板后 Ctrl+V 粘贴。`)
  }, [selection])

  /**
   * Ctrl+V (§6.3): copy the clipboard onto the open board.
   *
   * The landing point is the last place the pointer was over the canvas (G12) —
   * pasting at the view centre put the copy somewhere the user was not looking,
   * which on a 100-node board reads as "nothing happened". With no pointer
   * history yet (the panel just mounted, or the keyboard was used only) the old
   * centre rule stands.
   */
  const pasteClipboard = useCallback(async () => {
    const stored = clipboardRef.current
    const board = boardIdRef.current
    if (stored === undefined || board === undefined) return
    const element = canvasRef.current
    const box = element === null ? undefined : element.getBoundingClientRect()
    const pointed = pointerScreenRef.current
    const center = pointed !== undefined
      ? screenToWorld(cameraRef.current, pointed)
      : box === undefined
        ? { x: 0, y: 0 }
        : screenToWorld(cameraRef.current, { x: box.width / 2, y: box.height / 2 })
    const created: string[] = []
    let offset = 0
    for (const itemId of stored.itemIds) {
      const { error, payload } = await postBoardRaw({
        action: 'copy-item',
        board: stored.boardId,
        item: itemId,
        toBoard: board,
        x: center.x + offset,
        y: center.y + offset,
      })
      if (error !== undefined) {
        setBoardError(error)
        continue
      }
      const item = payload?.item as BoardItem | undefined
      if (item === undefined) continue
      const node = appendBoardItem(item, payload?.board as BoardSummary | undefined)
      created.push(node.id)
      offset += 40
    }
    if (created.length > 0) setSelection(new Set(created))
  }, [appendBoardItem])

  /**
   * G25: copy or move the given nodes onto another board through the C12 routes.
   *
   * One request per item — `copy-item`/`move-item` are per-item on the wire, and
   * a batch that fails halfway should leave the successful half done instead of
   * pretending the whole transfer was atomic. A **copy** leaves the source items
   * alone (the two boards share one PNG); a **move** has already taken them off
   * this board server-side, so the canvas forgets them locally with the same
   * bookkeeping a removal uses — minus a second `remove-item` that would 404.
   */
  const transferItems = useCallback(async (mode: 'copy' | 'move', ids: readonly string[], toBoard: string) => {
    const board = boardIdRef.current
    setTransfer(undefined)
    if (board === undefined || toBoard === board || ids.length === 0) return
    const done: string[] = []
    for (const id of ids) {
      const { error, payload } = await postBoardRaw({
        action: mode === 'copy' ? 'copy-item' : 'move-item',
        board,
        item: id,
        toBoard,
      })
      if (error !== undefined) {
        setBoardError(error)
        continue
      }
      done.push(id)
      // The response carries the destination summary: keep its item count honest
      // without a second library read.
      const summary = payload?.board as BoardSummary | undefined
      if (summary !== undefined) setBoards((current) => upsertBoard(current, summary))
    }
    if (done.length === 0) return
    if (mode === 'move') dropNodesLocally(done)
    const name = boards.find((entry) => entry.id === toBoard)?.name ?? '目标画板'
    setNote(`已${mode === 'copy' ? '复制' : '移动'} ${String(done.length)} 张到「${name}」`)
  }, [boards, dropNodesLocally])

  /* ------------------------------------------------------------------------ */
  /* Export (C15 §9.6 / DD14): board JSON + contact-sheet PNG                 */
  /* ------------------------------------------------------------------------ */

  /** The board's items as they would be stored right now (running tasks excluded). */
  const currentBoardItems = useCallback((): BoardItem[] => {
    const now = new Date().toISOString()
    const stored = boardItemsRef.current
    const placeholder = (id: string, kind: BoardItem['kind']): BoardItem => ({
      id,
      kind,
      path: '',
      markdownPath: '',
      width: 0,
      height: 0,
      bytes: 0,
      mediaType: '',
      prompt: '',
      ratio: null,
      steps: null,
      seed: null,
      mode: 'generate',
      backend: 'studio',
      parents: [],
      createdAt: now,
      sessionId: null,
      batchId: 'x' + id,
      x: 0,
      y: 0,
    })
    const items: BoardItem[] = []
    for (const node of nodesRef.current) {
      const base = stored.get(node.id)
      if (isImageNode(node)) {
        items.push({
          ...(base ?? placeholder(node.id, 'image')),
          ...node.image,
          id: node.id,
          kind: 'image',
          parents: [...node.parents],
          x: node.x,
          y: node.y,
          batchId: node.batchId,
        })
        continue
      }
      if (isTaskNode(node)) {
        // Running tasks are session state (DD6); only a terminal failure is a
        // board entry, so an export during a run skips it.
        if (node.status !== 'failed' && node.status !== 'interrupted') continue
        items.push({
          ...(base ?? placeholder(node.id, 'task')),
          id: node.id,
          kind: 'task',
          parents: [...node.parents],
          x: node.x,
          y: node.y,
          task: {
            status: node.status,
            params: node.params,
            ...(node.error === undefined ? {} : { error: node.error }),
          },
        })
        continue
      }
      // G26: a draft has no board entry yet — nothing was written when the wire
      // was dropped, so an export has nothing to export for it.
      if (isDraftNode(node)) continue
      items.push({
        ...(base ?? placeholder(node.id, 'layout')),
        id: node.id,
        kind: 'layout',
        parents: [...node.parents],
        x: node.x,
        y: node.y,
        draft: node.draft,
        w: node.w,
        h: node.h,
      })
    }
    return items
  }, [])

  /** Download the current board as its v2 JSON (DD14; one-way export, no import). */
  const exportBoardJson = useCallback(() => {
    const id = boardIdRef.current
    if (id === undefined) {
      setBoardError('先打开或新建一个画板，再导出')
      return
    }
    const meta = boardMetaRef.current
    const items = currentBoardItems()
    const cameraNow = cameraRef.current
    const detail: BoardDetail = {
      id,
      name: boardName,
      itemCount: items.length,
      cover: [...items].reverse().find((item) => (item.kind ?? 'image') === 'image')?.markdownPath ?? null,
      createdAt: meta?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sessionId: meta?.sessionId ?? null,
      camera: { x: cameraNow.x, y: cameraNow.y, zoom: cameraNow.zoom },
      items,
    }
    const name = boardJsonFileName(detail.name)
    downloadBlob(new Blob([serializeBoardDetail(detail)], { type: 'application/json' }), name)
    setNote('已导出画板 JSON：' + name)
  }, [boardName, currentBoardItems])

  /**
   * Render every picture on the board into one contact-sheet PNG (DD14).
   *
   * Pictures load through the plugin's same-origin file route, so the canvas is
   * not tainted and `toBlob` can export it. A broken file leaves its grey
   * placeholder and label — one failure must not abort a 200-cell sheet. A null
   * or thrown `toBlob` (tainted canvas) is reported, never silently ignored.
   */
  const exportContactSheet = useCallback(async () => {
    const items = pictureItems(currentBoardItems())
    if (items.length === 0) {
      setNote('这个画板还没有可拼版的图片')
      return
    }
    const plan = contactSheetLayout(items, 4, CONTACT_SHEET_THUMB_SIZE)
    const canvas = document.createElement('canvas')
    canvas.width = plan.width
    canvas.height = plan.height
    const context = canvas.getContext('2d')
    if (context === null) {
      setBoardError('导出拼版失败：当前环境没有 canvas 2D')
      return
    }
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, plan.width, plan.height)
    context.font = '13px system-ui, sans-serif'
    for (const slot of plan.slots) {
      context.fillStyle = '#e5e7eb'
      context.fillRect(slot.imageX, slot.imageY, slot.imageWidth, slot.imageHeight)
      try {
        const image = await loadImage(studioFileUrl(slot.item.markdownPath))
        context.drawImage(image, slot.imageX, slot.imageY, slot.imageWidth, slot.imageHeight)
      } catch {
        // The grey block stays; the label still identifies the picture.
      }
      context.fillStyle = '#374151'
      context.fillText(contactSheetLabel(slot.item.prompt).slice(0, 32), slot.x, slot.labelY + 16, slot.width)
    }
    let blob: Blob | undefined
    try {
      blob = await new Promise<Blob | undefined>((resolve) => {
        canvas.toBlob((value) => { resolve(value ?? undefined) }, 'image/png')
      })
    } catch (cause) {
      setBoardError('导出拼版失败：' + (cause instanceof Error ? cause.message : String(cause)) + '（canvas 可能被跨源图片污染）')
      return
    }
    if (blob === undefined) {
      setBoardError('导出拼版失败：canvas 无法导出 PNG（可能被跨源图片污染）')
      return
    }
    const name = boardJsonFileName(boardName).replace(/\.board\.json$/, '') + '.sheet.png'
    downloadBlob(blob, name)
    setNote('已导出拼版 PNG：' + name + '（' + String(plan.slots.length) + ' 张' + (plan.truncated ? '，已截断到 200' : '') + '）')
  }, [boardName, currentBoardItems])

  /* ------------------------------------------------------------------------ */
  /* Layout nodes (C13 §8): one editor per node, width-driven resize           */
  /* ------------------------------------------------------------------------ */

  /**
   * Write an editor change back into the node (§8.1 step 2).
   *
   * The node keeps its display width; the height follows the draft proportion,
   * so editing the draft canvas and resizing the node stay one mechanism. The
   * change is one undo step, coalesced across a typing burst the way arrow-key
   * nudges are.
   *
   * Persistence note: a layout node is a v2 board entry, but writing one needs a
   * board action that does not exist yet (C13 report); this updates the canvas
   * state only, and a reload does not rebuild it.
   */
  const updateLayoutDraft = useCallback((id: string, draft: BoardLayoutDraft) => {
    const current = nodesRef.current
    const node = current.find((entry) => entry.id === id)
    if (node === undefined || !isLayoutNode(node)) return
    const width = clampLayoutNodeWidth(node.w)
    const updated: LayoutCanvasNode = { ...node, draft, w: width, h: layoutNodeHeight(width, draft) }
    const next = current.map((entry) => (entry.id === id ? updated : entry))
    writeNodes(next)
    const now = Date.now()
    const open = draftEditRef.current
    if (open !== undefined && open.id === id && now - open.at <= DRAFT_EDIT_MERGE_MS) {
      open.at = now
      open.after.splice(0, open.after.length, ...next)
    } else {
      const after = [...next]
      const command = snapshotCommand('layout-draft', current, after, (list) => { writeNodes([...list]) })
      draftEditRef.current = { at: now, id, after, command }
      pushCommand(command)
    }
    scheduleLayout()
    // C14: the draft is what a later generation compiles — persist it (§8.1).
    scheduleLayoutPersist(id)
  }, [pushCommand, scheduleLayout, scheduleLayoutPersist, writeNodes])

  /** Create a layout node with the default 1536×1024 draft (C13 step 5). */
  const addLayoutNode = useCallback((options: {
    /** Where it goes; omitted means "append to the board" (the toolbar path). */
    readonly spot?: Point
    /** Lineage the node is born with — a wire drop names its source (G26). */
    readonly parents?: readonly string[]
  } = {}) => {
    const draft: BoardLayoutDraft = {
      width: DEFAULT_LAYOUT_WIDTH,
      height: DEFAULT_LAYOUT_HEIGHT,
      bbox_coord_space: 'abs',
      bbox_format: 'xyxy',
      summary: { caption: '' },
      items: [],
    }
    const spot = options.spot ?? nextNodeSpot(nodesRef.current.map(nodeRect))
    const node: LayoutCanvasNode = {
      kind: 'layout',
      id: makeLayoutNodeId(),
      x: spot.x,
      y: spot.y,
      parents: options.parents === undefined ? [] : [...options.parents],
      w: LAYOUT_NODE_DEFAULT_WIDTH,
      h: layoutNodeHeight(LAYOUT_NODE_DEFAULT_WIDTH, draft),
      draft,
    }
    const before = nodesRef.current
    const after = [...before, node]
    writeNodes(after)
    markDirty([node.id])
    // §6.5 lists "add node" among the undoable commands; creation is cheap to
    // revert (the draft was never persisted), so it goes on the stack.
    pushCommand(snapshotCommand('add-layout', before, after, (list) => { writeNodes([...list]) }))
    setSelection(new Set([node.id]))
    revealNodeId(node.id)
    setNote('已新建布局节点：在里面拖动画框、写 summary.caption，然后点标题栏「生成」。')
    scheduleLayout()
    // A new node is a board entry (§8.1); the debounce coalesces the first
    // burst of drawing into one write.
    scheduleLayoutPersist(node.id)
  }, [pushCommand, revealNodeId, scheduleLayout, scheduleLayoutPersist, writeNodes])

  /**
   * Start dragging a layout node's resize handle (§8.3).
   *
   * The node has no drag handler of its own — the title bar is the drag handle,
   * and the editor owns the rest — so this is the only other way to grab it.
   */
  const startLayoutResize = useCallback((event: ReactPointerEvent<HTMLDivElement>, node: LayoutCanvasNode) => {
    if (event.button !== 0) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    pointerRef.current = undefined
    gestureRef.current = {
      kind: 'layout-resize',
      id: node.id,
      startX: event.clientX,
      startY: event.clientY,
      startW: node.w,
      before: nodesRef.current,
    }
  }, [])

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
    // Same split as `fitView`: with an engine mounted, the engine's camera is the
    // only camera, and the toolbar's + / − drive it.
    const engine = flowEngineRef.current
    if (engine !== undefined) {
      engine.zoomBy(factor)
      return
    }
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
   * Put an uncommitted placeholder on the canvas (G26).
   *
   * The drop says "here, and it came from there"; the picture does not exist yet.
   * So this writes a node and **nothing else** — no board entry, no request, no
   * `persistedIds`. The next form generation replaces it in place through the
   * existing `pendingReplaceRef` path, which already knows how to swap a node for
   * the picture that lands on it (the §4.5 edit-and-resend channel), and the
   * picture takes `parents` with it.
   */
  const addDraftNode = useCallback((spot: Point, sourceId: string) => {
    const node: DraftCanvasNode = {
      kind: 'draft',
      id: makeClientId(),
      x: spot.x,
      y: spot.y,
      parents: [sourceId],
    }
    const before = nodesRef.current
    const after = [...before, node]
    writeNodes(after)
    // §6.5 lists "add node" among the undoable commands, and a draft costs even
    // less to revert than a layout node: nothing was ever written.
    pushCommand(snapshotCommand('add-draft', before, after, (list) => { writeNodes([...list]) }))
    setSelection(new Set([node.id]))
    return node
  }, [pushCommand, writeNodes])

  /**
   * Run one choice of the node-type menu (G26 §1).
   *
   * The first two build at the drop point with the source node as parent — that
   * is what makes this menu different from the blank-canvas right-click menu,
   * which has no origin to grow from. The third (G28) needs one more decision
   * *which* asset — so it grows the picker inside the same card and leaves the
   * menu open: that keeps it clickable as its own off switch, and lets the user
   * change their mind to 布局 without re-dragging the wire.
   */
  const runConnectTarget = useCallback((target: ConnectTarget) => {
    const open = wireMenu
    if (open === undefined) return
    if (target === 'asset') {
      // Toggle: a second click closes the picker and builds nothing.
      setAssetPick((current) => (current === undefined
        ? { world: open.world, sourceId: open.sourceId }
        : undefined))
      return
    }
    setWireMenu(undefined)
    const source = nodesRef.current.find((node) => node.id === open.sourceId)
    if (target === 'image') {
      // Pre-fill the form with the source as a reference: the wire says "make
      // the next thing from this one", and a reference is how this workbench
      // expresses that. A layout node has no file, so it contributes the parent
      // id through the draft node instead (see `startGeneration`).
      if (source !== undefined) referenceNode(source)
      const draft = addDraftNode(open.world, open.sourceId)
      // The very next form generation lands on this node instead of appending.
      pendingReplaceRef.current = { id: draft.id }
      setNote('已在这里放一个待生成的节点（血缘指向来源）。写下提示词再点「生成」，图会落在这个位置。')
      promptRef.current?.focus()
      return
    }
    if (target === 'layout') {
      addLayoutNode({ spot: open.world, parents: [open.sourceId] })
      setNote('已在这里建布局节点，血缘指向来源节点；在里面拖画框、写 summary.caption 再点「生成」。')
      return
    }
  }, [addDraftNode, addLayoutNode, referenceNode, wireMenu])

  /**
   * Focus the prompt for the node the user is about to describe.
   *
   * Kept as a callback so the draft node's own action row can reuse it: the point
   * of a draft is that the next thing the user does is type.
   */
  const focusPrompt = useCallback(() => {
    promptRef.current?.focus()
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

  /* ------------------------------------------------------------------------ */
  /* G22: the in-canvas lightbox                                              */
  /* ------------------------------------------------------------------------ */
  //
  // Declared *before* the key handler that reads them: a `useCallback` runs its
  // dependency array immediately, so a `const` declared further down would be in
  // its temporal dead zone at that moment.

  /** Every picture on the open board, in board order — the ←/→ ring. */
  const boardPictures = useMemo(() => nodes.filter(isImageNode), [nodes])

  /** Open one picture at full size, in place. */
  const openLightbox = useCallback((id: string) => {
    setLightboxId(id)
    setMenu(undefined)
    setTransfer(undefined)
  }, [])

  /**
   * Move to the neighbouring picture.
   *
   * Wraps at both ends: the ring is short (one board) and a dead end at the last
   * picture reads as "the button is broken". A node that has been removed since
   * the lightbox opened resolves to nothing and the overlay simply closes.
   */
  const stepLightbox = useCallback((delta: number) => {
    setLightboxId((current) => {
      if (current === undefined) return undefined
      const index = boardPictures.findIndex((node) => node.id === current)
      if (index < 0 || boardPictures.length === 0) return undefined
      const next = (index + delta + boardPictures.length) % boardPictures.length
      return boardPictures[next]?.id
    })
  }, [boardPictures])

  /** The picture the lightbox is showing, resolved from the current board. */
  const lightboxNode = lightboxId === undefined
    ? undefined
    : boardPictures.find((node) => node.id === lightboxId)
  const lightboxIndex = lightboxNode === undefined ? -1 : boardPictures.indexOf(lightboxNode)
  /** Its stored prompt, which is the only human-readable title a result has. */
  const lightboxItem = lightboxNode === undefined ? undefined : boardItemsRef.current.get(lightboxNode.id)

  const onCanvasKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    // G22: while the lightbox is open it owns the three keys that mean something
    // there. Checked before the shortcut table so ArrowLeft does not nudge a node
    // the user cannot even see behind the overlay.
    if (lightboxId !== undefined) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setLightboxId(undefined)
        return
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        stepLightbox(event.key === 'ArrowLeft' ? -1 : 1)
        return
      }
    }
    const target = event.target as HTMLElement | null
    const context = shortcutContext({
      tagName: target?.tagName,
      contentEditable: target?.isContentEditable === true,
      // The mounted editor's root carries LAYOUT_EDITOR_CLASS; its inputs and
      // its own Delete handler own every key while focus is inside it (§8.3).
      inEditor: target?.closest?.(`[data-dsh-layout-editor], .${LAYOUT_EDITOR_CLASS}`) != null,
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
        if (gestureRef.current?.kind === 'marquee' || gestureRef.current?.kind === 'connect') {
          gestureRef.current = undefined
          pointerRef.current = undefined
          if (frameRef.current !== undefined) {
            cancelAnimationFrame(frameRef.current)
            frameRef.current = undefined
          }
        }
        // G26: Esc mid-drag drops the wire; nothing is created and nothing is
        // saved, which is exactly the cancel the state machine would report.
        setWire(undefined)
        setWireMenu(undefined)
        // G28: and it closes the picker that menu grew, without placing anything.
        setAssetPick(undefined)
        setMenu(undefined)
        setTransfer(undefined)
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
      case 'copy':
        copySelection()
        break
      case 'paste':
        void pasteClipboard()
        break
      default:
        break
    }
  }, [copySelection, fitView, lightboxId, nudge, pasteClipboard, redoHistory, removeNodes, selection, stepLightbox, undoHistory, zoomBy])

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
  /**
   * Open the §6.4 menu at a point, for one target node (or blank canvas).
   *
   * Split out of the DOM adapter below for U04 step 2: the React Flow canvas
   * knows which node was hit and where the pointer was *relative to its own box*,
   * but it knows nothing about `.dsh-forge-node` or `currentTarget`. Both engines
   * therefore call this one function, so the menu a user sees is decided by the
   * same `contextMenuItems` data — and the same selection rule ("right-clicking a
   * node outside the selection selects it first") — whichever engine drew it.
   */
  const openContextMenuAt = useCallback((x: number, y: number, target: string | undefined) => {
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
    setMenu({ x, y, items, target })
  }, [selection])

  /**
   * Open the §6.4 menu at the pointer (the DOM canvas's adapter).
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
    openContextMenuAt(event.clientX - box.left, event.clientY - box.top, target)
  }, [openContextMenuAt])

  /**
   * The engine's adapter: it already did the hit test and the offset.
   *
   * @param request - where the right-click happened, and the node under it.
   */
  const openContextMenuFromEngine = useCallback((request: { readonly x: number; readonly y: number; readonly nodeId?: string }) => {
    openContextMenuAt(request.x, request.y, request.nodeId)
  }, [openContextMenuAt])

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
      case 'zoom-view': {
        // G22: same picture, in the canvas instead of a new tab.
        if (target !== undefined) openLightbox(target)
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
      case 'layout-generate':
        if (target !== undefined) generateLayoutNode(target)
        break
      case 'new-layout':
        addLayoutNode()
        break
      case 'draft-focus':
        // G26: the placeholder's only real action is "go describe the picture".
        focusPrompt()
        break
      case 'copy-item':
      case 'move-item': {
        // G25: the picker, not a dialog. It opens where the menu was and lists
        // the boards the items can go to; `transferItems` does the writes.
        const ids = menuIds(target)
        if (ids.length === 0) break
        setTransfer({
          mode: id === 'copy-item' ? 'copy' : 'move',
          ids,
          x: menu?.x ?? 0,
          y: menu?.y ?? 0,
        })
        break
      }
      case 'paste':
        void pasteClipboard()
        break
      case 'export-board':
        exportBoardJson()
        break
      case 'export-sheet':
        void exportContactSheet()
        break
      default:
        break
    }
  }, [
    addLayoutNode,
    cancelTask,
    editTaskParams,
    exportBoardJson,
    exportContactSheet,
    fitView,
    focusPrompt,
    generateLayoutNode,
    menu?.target,
    menu?.x,
    menu?.y,
    menuIds,
    openLightbox,
    pasteClipboard,
    referenceNode,
    removeNodes,
    retryTask,
  ])

  /**
   * Open the board an asset lives on, select it **and travel to it** (§7.4).
   *
   * Switching boards is not enough: the item can be anywhere on the unbounded
   * canvas, and selecting something off-screen looks like nothing happened.
   * The reveal waits for the board read (and, when the panel was on another
   * view, for the canvas to mount) — see `revealNodeId` and its effect.
   */
  const showOnCanvas = useCallback(async (asset: StudioAsset) => {
    if (boardIdRef.current !== asset.boardId) await selectBoard(asset.boardId)
    setView('canvas')
    selectOnly(asset.id)
    revealNodeId(asset.id)
  }, [revealNodeId, selectBoard, selectOnly])

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

  // ---- P2: the environment line's own state machine ----------------------
  //
  // Four cases, exactly one action each: not running → 启动; running and ours →
  // 停止; running but started by the user → no action, with the reason; busy →
  // the button says what it is doing. `owned` comes from the host's launch
  // record, never from the panel's optimism: a stop button that would have to
  // guess which process to kill is worse than no button.
  const environmentOwned = ready && environment?.owned === true
  const environmentStatusText = ready
    ? `ComfyUI ${config?.endpoint ?? ''}${environmentOwned && environment?.pid !== undefined ? ` · 本次由插件拉起 · pid ${String(environment.pid)}` : ''}`
    : 'ComfyUI 未就绪'
  const environmentArgvTitle = environment?.argvPreview === undefined || environment.argvPreview.length === 0
    ? undefined
    : environment.argvPreview.join(' ')

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
          {
            key: `${asset.boardId}:${asset.id}`,
            className: 'dsh-forge-asset',
            // §7.1: the card itself is the drag handle; the thumbnail is a link,
            // so it must not steal the drag with its own default behaviour.
            draggable: true,
            'data-asset-board': asset.boardId,
            'data-asset-id': asset.id,
            onDragStart: (event: ReactDragEvent<HTMLDivElement>) => { startAssetDrag(event, asset) },
          },
          createElement(
            'a',
            {
              className: 'dsh-forge-asset-thumb',
              href: studioFileUrl(asset.markdownPath),
              target: '_blank',
              rel: 'noreferrer',
              title: asset.path,
              draggable: false,
            },
            // G20: the asset grid is the densest image surface in the panel, so
            // it asks for the smallest thumbnail the route caches.
            createElement('img', {
              src: studioFileUrl(asset.markdownPath, 256),
              alt: '素材',
              loading: 'lazy',
              decoding: 'async',
            }),
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

  // G26: the wire's `<path d>`, computed once per frame instead of twice. It is
  // `undefined` while the gesture is armed — a click on a handle must not paint a
  // zero-length path, which is what an empty `d` attribute would be.
  const wirePath = wire === undefined ? undefined : previewPath(wire, graph.views)

  return createElement(
    'div',
    { className: 'dsh-image-forge-studio' },
    createElement(
      'div',
      { className: 'dsh-forge-studio-head' },
      createElement('h2', { className: 'dsh-forge-studio-title' }, '图像工作台'),
      createElement(
        'div',
        { className: 'dsh-forge-studio-status', 'data-env-state': environment?.state ?? 'unknown', 'data-env-owned': environmentOwned ? 'yes' : 'no' },
        createElement('span', { className: ready ? 'dsh-forge-dot is-ok' : 'dsh-forge-dot is-bad' }),
        createElement(
          'span',
          { className: 'dsh-forge-studio-endpoint' },
          environmentStatusText,
        ),
        // The one action this line owns. A started renderer keeps running after
        // the panel closes (`unref`), so "本次由插件拉起 · pid" above is not
        // decoration: it is the notice that a process outlived its window.
        environmentBusy !== undefined
          ? createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-forge-btn is-ghost dsh-forge-env-btn',
              disabled: true,
              'data-env-action': environmentBusy,
            },
            environmentBusy === 'start' ? '启动中…' : '停止中…',
          )
          : ready
            ? createElement(
              'button',
              {
                type: 'button',
                className: 'dsh-forge-btn is-ghost dsh-forge-env-btn',
                disabled: !environmentOwned,
                'data-env-action': 'stop',
                title: environmentOwned
                  ? (environmentArgvTitle === undefined ? '停止本次由插件拉起的 ComfyUI' : `停止本次由插件拉起的 ComfyUI（argv：${environmentArgvTitle}）`)
                  : (environment?.ownershipNote ?? '这个 ComfyUI 不是本插件拉起的，插件不提供停止'),
                onClick: () => {
                  if (!environmentOwned) return
                  if (!window.confirm('停止本次由插件拉起的 ComfyUI？正在跑的任务会中断。')) return
                  void runEnvironmentAction('stop')
                },
              },
              '停止',
            )
            : createElement(
              'button',
              {
                type: 'button',
                className: 'dsh-forge-btn is-primary dsh-forge-env-btn',
                'data-env-action': 'start',
                title: environmentArgvTitle === undefined
                  ? '按 Comfy Desktop 记录的启动参数后台拉起 ComfyUI'
                  : `按 Comfy Desktop 记录的参数后台拉起 ComfyUI（argv：${environmentArgvTitle}）`,
                onClick: () => { void runEnvironmentAction('start') },
              },
              '启动',
            ),
        ready && !environmentOwned && environment?.ownershipNote === undefined
          ? createElement('span', { className: 'dsh-forge-studio-hint' }, '由你自己启动的实例，插件不提供停止')
          : null,
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

    // A start/stop failure is the one environment message worth a banner: it is
    // what the user just asked for, and its `note` names the log to read.
    environmentError === undefined
      ? null
      : createElement('div', { className: 'dsh-forge-studio-alert dsh-forge-env-error' }, environmentError),

    environmentNote === undefined
      ? null
      : createElement('div', { className: 'dsh-forge-studio-hint dsh-forge-env-note' }, environmentNote),

    // ---- install → first picture stepper (T22) -----------------------------
    //
    // Always visible: the four steps are the shortest honest answer to "why is
    // this not generating yet". States come from the capability snapshot (which
    // the host derives from its environment probe) and the live SSE phase; the
    // own action here is re-checking, because install/download are the managed
    // environment tool's job (qwen_image_setup).
    createElement(
      'section',
      { className: 'dsh-forge-stepper', role: 'list', 'aria-label': '从安装到出图' },
      ...stepperSteps.map((step) => createElement(
        'div',
        {
          key: step.id,
          className: 'dsh-forge-step is-' + step.state,
          role: 'listitem',
          'data-step': step.id,
          'data-step-state': step.state,
        },
        createElement('span', { className: 'dsh-forge-step-dot', 'aria-hidden': true }),
        createElement(
          'div',
          { className: 'dsh-forge-step-body' },
          createElement('span', { className: 'dsh-forge-step-label' }, step.label),
          createElement('span', { className: 'dsh-forge-step-detail', title: step.detail }, step.detail),
        ),
      )),
      createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-forge-btn is-ghost dsh-forge-step-retry',
          title: '重新探测 ComfyUI 与权重（环境安装/下载由 qwen_image_setup 负责）',
          onClick: () => { void loadConfig() },
        },
        '重新检测',
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
            ref: promptRef,
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
              // §8.1's creation entry. The blank right-click menu item that
              // §13 C13 step 5 names lives in the frozen C09 menu table
              // (canvas-interactions.ts, outside C13's write scope), so the
              // toolbar is the shipped entry; reported to the lead.
              createElement(
                'button',
                {
                  type: 'button',
                  className: 'dsh-forge-btn is-ghost',
                  title: '新建 MOSS 布局节点（1536×1024 默认 draft）',
                  onClick: () => { addLayoutNode() },
                },
                '新建布局',
              ),
              // C15/DD14: the two export entries live here as well as in the
              // blank right-click menu (§9.6 asks for both entry points).
              createElement(
                'button',
                {
                  type: 'button',
                  className: 'dsh-forge-btn is-ghost',
                  title: '导出当前画板 JSON（v2，含布局草稿与失败任务）',
                  onClick: () => { exportBoardJson() },
                },
                '导出',
              ),
              createElement(
                'button',
                {
                  type: 'button',
                  className: 'dsh-forge-btn is-ghost',
                  title: '把画板里的图片拼成一张 PNG（≤200 张，256px 缩略图）',
                  onClick: () => { void exportContactSheet() },
                },
                '拼版',
              ),
            )
            : createElement(
              'span',
              { className: 'dsh-forge-batch-meta' },
              view === 'assets' ? `${String(assetsTotal)} 张素材` : `${String(batches.length)} 批`,
            ),
        ),
        view === 'canvas'
          // U04 step 2: **one** canvas container for both engines.
          //
          // The container is what the screen-space overlays below (marquee, menu,
          // board picker, lightbox) are positioned in, and it is what carries the
          // `is-pan` cursor. Keeping it in place means the React Flow pane
          // inherits those overlays instead of growing a second copy of them —
          // which is why the menu a user opens on the flow canvas is the same
          // markup, the same handlers and the same `contextMenuItems` data as the
          // one the DOM canvas opens.
          //
          // The keyboard and the pointer gestures go to whichever engine is
          // mounted: the DOM canvas owns them itself (§6.3's `tabIndex=0` and
          // the gesture refs), the flow canvas owns its own and forwards the keys
          // back here through `onKeyDown` (see `./canvas-pane.ts`).
          ? createElement(
            'div',
            canvasSlot === undefined
              ? {
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
                // §7.1/§7.3: a library card or an OS file can be dropped here.
                onDragOver: onCanvasDragOver,
                onDrop: onCanvasDrop,
                onBlur: () => {
                  // Focus left with Space still down: the held state must not stick.
                  panRef.current = false
                  setPanHeld(false)
                },
              }
              : {
                className: panHeld || handMode ? 'dsh-forge-canvas is-flow is-pan' : 'dsh-forge-canvas is-flow',
              },
            canvasSlot === undefined
              ? (nodes.length === 0 && view === 'canvas'
                ? createElement(
                  'p',
                  { className: 'dsh-forge-canvas-hint' },
                  busy ? '正在生成…' : '这个画板还是空的。生成的第一张图会落在这里；拖空白处框选，Space 或中键平移，滚轮缩放，拖图可改位置。',
                )
                : null)
              // The engine the shell supplies (`FlowCanvas`): it draws the board
              // and owns every gesture; this object is the whole contract.
              : createElement(canvasSlot as (input: unknown) => unknown, {
                boardId,
                nodes,
                selection,
                onSelect: (ids: readonly string[]) => { setSelection(new Set(ids)) },
                onDraft: updateLayoutDraft,
                onRetry: retryTask,
                onCancel: cancelTask,
                onRemove: removeNode,
                onOpen: openLightbox,
                onGenerateLayout: generateLayoutNode,
                // Step 2: the gestures the DOM canvas had. Each one lands on the
                // same studio callback the fallback path uses, so the undo stack,
                // the 700 ms save debounce and the menus cannot diverge.
                onMoveNodes: moveNodesFromGesture,
                onContextMenu: openContextMenuFromEngine,
                onKeyDown: onCanvasKeyDown,
                onKeyUp: onCanvasKeyUp,
                onCameraChange: adoptEngineCamera,
                onApi: adoptEngineApi,
                panMode: panHeld || handMode,
                // §7.1/§7.3: the engine is what covers the canvas now, so it is
                // also what has to accept a dropped file or library card.
                onDragOver: onCanvasDragOver,
                onDrop: onCanvasDrop,
                // U04 step 3: the wire. The drop is classified by the engine's
                // own pure planner and executed by the callbacks above, so both
                // canvases write lineage and open the same card.
                onConnectStart: beginEngineConnection,
                onConnectEnd: endEngineConnection,
              }),
            canvasSlot === undefined
              ? createElement(
              'div',
              {
                className: 'dsh-forge-canvas-layer',
                // G27: the layer is `scale(zoom)`d, so anything inside it that
                // must read as a *screen* size has to divide by this zoom —
                // `.dsh-forge-handle` does (see `screenPx` in `client-styles`).
                // Published as a custom property because the alternative is one
                // inline size per node, recomputed on every camera change.
                style: {
                  transform: `translate(${String(-camera.x * camera.zoom)}px, ${String(-camera.y * camera.zoom)}px) scale(${String(camera.zoom)})`,
                  '--dsh-forge-zoom': String(camera.zoom),
                },
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
                // G26: the wire being dragged. Same cubic as a committed edge
                // (`previewPath`), so release does not make it jump; it is drawn
                // from the full node list because the target may be a node the
                // culling pass left out.
                wirePath === undefined
                  ? null
                  : createElement('path', {
                    key: 'wire-preview',
                    className: 'dsh-forge-edge is-preview',
                    'data-connect-preview': wire?.phase,
                    d: wirePath,
                  }),
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
                  className: [
                    'dsh-forge-node',
                    selected ? 'is-selected' : '',
                    node.kind === 'task' ? 'is-task' : '',
                    node.kind === 'layout' ? 'is-layout' : '',
                    node.kind === 'draft' ? 'is-draft' : '',
                    // G26: the node the wire would land on, so the drop is not a
                    // surprise — the wire snaps to this node's input handle too.
                    wire !== undefined && wire.targetId === node.id ? 'is-connect-target' : '',
                    // G27: the node the wire came from keeps its dot lit while the
                    // gesture is in flight. The pointer has left the node by then,
                    // so `:hover` alone would hide the origin of the wire.
                    wire !== undefined && wire.sourceId === node.id ? 'is-connect-source' : '',
                  ].filter((part) => part.length > 0).join(' '),
                  // What `onCanvasContextMenu` reads back to find the node it
                  // can only identify through `closest`.
                  'data-node-id': node.id,
                  'data-node-kind': node.kind,
                  style: {
                    left: `${String(node.x)}px`,
                    top: `${String(node.y)}px`,
                    width: `${String(item.width)}px`,
                    // A layout node is width-driven but its height follows the
                    // draft ratio (§8.3), so the box is explicit; pictures and
                    // tasks size themselves from their content.
                    ...(node.kind === 'layout' ? { height: `${String(item.height)}px` } : {}),
                  },
                  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => { onNodePointerDown(event, node) },
                }
                // A picture node: the shipped render, plus the two G20/G22
                // affordances — a 512-px thumbnail instead of a full-size PNG per
                // node, and a double-click that opens the lightbox in place.
                if (isImageNode(node)) {
                  return createElement(
                    'div',
                    {
                      ...frame,
                      title: '双击放大查看',
                      onDoubleClick: () => { openLightbox(node.id) },
                    },
                    createElement('img', {
                      src: studioFileUrl(node.image.markdownPath, STUDIO_NODE_THUMB_WIDTH),
                      alt: '生成结果',
                      draggable: false,
                      loading: 'lazy',
                      decoding: 'async',
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
                    // G26: the output handle, on every node kind.
                    connectHandle(node),
                  )
                }
                // §8.1's layout node: the title bar is the drag handle, the
                // editor owns the body, the footnote carries the draft state,
                // and the corner grip resizes the display box.
                if (isLayoutNode(node)) {
                  return createElement(
                    'div',
                    frame,
                    createElement(
                      'div',
                      {
                        className: 'dsh-forge-layout-head',
                        onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => { onNodePointerDown(event, node) },
                      },
                      createElement('span', { className: 'dsh-forge-layout-title' }, 'MOSS 布局'),
                      createElement(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-forge-node-btn',
                          title: '按布局生成：compiled 作为 MOSS 正向编码文本（仅 moss-sft）',
                          onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => { event.stopPropagation() },
                          onClick: () => { generateLayoutNode(node.id) },
                        },
                        '生成',
                      ),
                    ),
                    createElement(LayoutEditorMount, { node, onDraft: updateLayoutDraft }),
                    createElement(
                      'div',
                      { className: 'dsh-forge-layout-foot' },
                      `${String(node.draft.items.length)} 框 · ${String(node.draft.width)}×${String(node.draft.height)}`,
                      sole
                        ? createElement(
                          'button',
                          {
                            type: 'button',
                            className: 'dsh-forge-node-btn is-danger',
                            title: '从画布移除（不会删文件）',
                            onClick: () => { removeNode(node.id) },
                          },
                          '移除',
                        )
                        : null,
                    ),
                    createElement('div', {
                      className: 'dsh-forge-layout-grip',
                      title: '拖动改变显示宽度（高度随 draft 比例）',
                      onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => { startLayoutResize(event, node) },
                    }),
                    connectHandle(node),
                  )
                }
                // G26: the placeholder a wire creates. It says what it is waiting
                // for, and nothing about it is a board entry yet — the caption is
                // a note to the user, not metadata.
                if (isDraftNode(node)) {
                  const source = nodesRef.current.find((entry) => entry.id === node.parents[0])
                  return createElement(
                    'div',
                    { ...frame, title: '待生成：写下提示词，图会落在这个位置' },
                    createElement('div', { className: 'dsh-forge-draft-head' }, '待生成'),
                    createElement(
                      'div',
                      { className: 'dsh-forge-draft-body' },
                      source === undefined ? '来源节点已不在画布上' : '来源：' + describeNode(source),
                    ),
                    createElement(
                      'div',
                      { className: 'dsh-forge-draft-actions' },
                      createElement(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-forge-node-btn',
                          title: '把光标放到提示词输入框',
                          onClick: () => { focusPrompt() },
                        },
                        '写提示词',
                      ),
                      createElement(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-forge-node-btn is-danger',
                          title: '从画布移除（不删文件）',
                          onClick: () => { removeNode(node.id) },
                        },
                        '移除',
                      ),
                    ),
                    connectHandle(node),
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
                  connectHandle(node),
                )
              }),
            )
              : null,
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
            // G26: what a wire dropped on blank canvas can become. The same card
            // family as the right-click menu (§6.4), placed at the release point:
            // the user has already said "here" with the pointer, so a menu that
            // opened anywhere else would ask the question twice.
            wireMenu === undefined
              ? null
              : createElement(
                'div',
                {
                  className: 'dsh-forge-context',
                  role: 'menu',
                  'data-connect-menu': 'open',
                  'aria-label': '在这里新建',
                  style: { left: `${String(wireMenu.x)}px`, top: `${String(wireMenu.y)}px` },
                  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => { event.stopPropagation() },
                  onContextMenu: (event: ReactPointerEvent<HTMLDivElement>) => {
                    event.preventDefault()
                    event.stopPropagation()
                  },
                },
                createElement('div', { className: 'dsh-forge-context-head' }, '在这里新建（血缘指向来源）'),
                ...connectMenuItems().map((item) => createElement(
                  'button',
                  {
                    key: item.id,
                    type: 'button',
                    role: 'menuitem',
                    'data-connect-target': item.id,
                    className: 'dsh-forge-context-item',
                    disabled: item.disabled === true,
                    title: item.hint,
                    onClick: () => { runConnectTarget(item.id) },
                  },
                  item.label,
                )),
                // G28: the asset picker, grown inside the same card. The pointer
                // already said *where*, so the list does not need a card of its
                // own — and keeping it here means the third entry is still there
                // to click again, which is its own cancel.
                assetPick === undefined
                  ? null
                  : createElement(
                    'div',
                    { className: 'dsh-forge-picker', 'data-connect-picker': 'open' },
                    createElement(
                      'div',
                      { className: 'dsh-forge-picker-bar' },
                      createElement('input', {
                        className: 'dsh-forge-assets-search',
                        value: assetQuery,
                        placeholder: '搜提示词、文件名或画板名',
                        onChange: (event: ChangeEvent<HTMLInputElement>) => { setAssetQuery(event.target.value) },
                      }),
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
                    assets.length === 0
                      ? createElement(
                        'div',
                        { className: 'dsh-forge-context-empty' },
                        assetsBusy
                          ? '读取中…'
                          : assetQuery.trim().length > 0
                            ? '没有匹配的素材'
                            : assetScope === 'board'
                              ? '这个画板还没有素材：换到「全部画板」，或先生成一张。'
                              : '还没有素材：对话或工作台出的图都会记进画板。',
                      )
                      : createElement(
                        'div',
                        { className: 'dsh-forge-picker-grid' },
                        ...assets.map((asset) => createElement(
                          'button',
                          {
                            key: `${asset.boardId}:${asset.id}`,
                            type: 'button',
                            className: 'dsh-forge-picker-item',
                            'data-pick-board': asset.boardId,
                            'data-pick-item': asset.id,
                            title: asset.path,
                            onClick: () => { void placeAsset(asset) },
                          },
                          // G20's rule: the densest surface asks for the smallest
                          // thumbnail the route caches.
                          createElement('img', {
                            className: 'dsh-forge-picker-thumb',
                            src: studioFileUrl(asset.markdownPath, 256),
                            alt: '素材',
                            loading: 'lazy',
                            decoding: 'async',
                          }),
                          createElement('span', { className: 'dsh-forge-picker-name', title: asset.path }, describeAsset(asset)),
                          createElement(
                            'span',
                            { className: 'dsh-forge-picker-meta' },
                            `${asset.boardName} · ${String(asset.width)}×${String(asset.height)}`,
                          ),
                        )),
                      ),
                  ),
              ),
            // G25: the board picker a copy/move entry opens. Same panel family
            // as the context menu (one card, one click), not a modal on top of a
            // modal — the user is already in a menu.
            transfer === undefined
              ? null
              : createElement(
                'div',
                {
                  className: 'dsh-forge-transfer',
                  role: 'dialog',
                  'aria-label': transfer.mode === 'copy' ? '复制到画板' : '移动到画板',
                  style: { left: `${String(transfer.x)}px`, top: `${String(transfer.y)}px` },
                  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => { event.stopPropagation() },
                  onContextMenu: (event: ReactPointerEvent<HTMLDivElement>) => {
                    event.preventDefault()
                    event.stopPropagation()
                  },
                },
                createElement(
                  'div',
                  { className: 'dsh-forge-context-head' },
                  transfer.mode === 'copy'
                    ? `复制 ${String(transfer.ids.length)} 张到：`
                    : `移动 ${String(transfer.ids.length)} 张到：`,
                ),
                ...(boards.filter((entry) => entry.id !== boardId).length === 0
                  ? [createElement('div', { key: 'empty', className: 'dsh-forge-context-empty' }, '还没有别的画板：先在上面「新建」一个。')]
                  : boards
                    .filter((entry) => entry.id !== boardId)
                    .map((entry) => createElement(
                      'button',
                      {
                        key: entry.id,
                        type: 'button',
                        className: 'dsh-forge-context-item',
                        title: `${entry.name} · ${String(entry.itemCount)} 张`,
                        onClick: () => { void transferItems(transfer.mode, transfer.ids, entry.id) },
                      },
                      `${entry.name} · ${String(entry.itemCount)} 张`,
                    ))),
                createElement(
                  'button',
                  {
                    key: 'cancel',
                    type: 'button',
                    className: 'dsh-forge-context-item is-cancel',
                    onClick: () => { setTransfer(undefined) },
                  },
                  '取消',
                ),
              ),
            // G22: the lightbox. Screen-space like the menu (it must not scale
            // with the zoom), inside the canvas element so the canvas keeps the
            // keyboard and the wheel keeps working under it.
            lightboxNode === undefined
              ? null
              : createElement(
                'div',
                {
                  className: 'dsh-forge-lightbox',
                  role: 'dialog',
                  'aria-modal': true,
                  'aria-label': '放大查看',
                  // The backdrop is the close target; the card inside stops the
                  // click so that "click the picture" is not "click the backdrop".
                  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
                    event.stopPropagation()
                    if (event.target === event.currentTarget) setLightboxId(undefined)
                  },
                  onContextMenu: (event: ReactPointerEvent<HTMLDivElement>) => {
                    event.preventDefault()
                    event.stopPropagation()
                  },
                },
                createElement(
                  'div',
                  { className: 'dsh-forge-lightbox-card' },
                  createElement(
                    'div',
                    { className: 'dsh-forge-lightbox-head' },
                    createElement(
                      'span',
                      { className: 'dsh-forge-lightbox-title' },
                      // The prompt's first line is the only title a generated
                      // picture has; a layout-derived result has none.
                      (lightboxItem?.prompt ?? '').split('\n')[0] || '未命名结果',
                    ),
                    createElement(
                      'span',
                      { className: 'dsh-forge-lightbox-meta' },
                      `${String(lightboxNode.image.width)}×${String(lightboxNode.image.height)}` +
                        (lightboxItem?.seed == null ? '' : ` · seed ${String(lightboxItem.seed)}`) +
                        (lightboxItem?.steps == null ? '' : ` · ${String(lightboxItem.steps)} 步`) +
                        ` · ${String(lightboxIndex + 1)}/${String(boardPictures.length)}`,
                    ),
                  ),
                  createElement(
                    'div',
                    { className: 'dsh-forge-lightbox-body' },
                    createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-forge-lightbox-nav is-prev',
                        'aria-label': '上一张',
                        title: '上一张（←）',
                        onClick: () => { stepLightbox(-1) },
                      },
                      '‹',
                    ),
                    createElement('img', {
                      className: 'dsh-forge-lightbox-img',
                      src: studioFileUrl(lightboxNode.image.markdownPath),
                      alt: '放大查看',
                      draggable: false,
                    }),
                    createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-forge-lightbox-nav is-next',
                        'aria-label': '下一张',
                        title: '下一张（→）',
                        onClick: () => { stepLightbox(1) },
                      },
                      '›',
                    ),
                  ),
                  createElement(
                    'div',
                    { className: 'dsh-forge-lightbox-foot' },
                    createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-forge-btn is-ghost',
                        onClick: () => { removeNodes([lightboxNode.id]) ; setLightboxId(undefined) },
                      },
                      '从画布移除',
                    ),
                    createElement(
                      'a',
                      {
                        className: 'dsh-forge-btn is-ghost',
                        href: studioFileUrl(lightboxNode.image.markdownPath),
                        target: '_blank',
                        rel: 'noreferrer',
                      },
                      '在新标签打开原图',
                    ),
                    createElement(
                      'button',
                      { type: 'button', className: 'dsh-forge-btn is-ghost', onClick: () => { setLightboxId(undefined) } },
                      '关闭（Esc）',
                    ),
                  ),
                ),
              ),
            createElement(
              'div',
              { className: 'dsh-forge-canvas-foot' },
              references.length === 0
                ? '选中图片后可「用作参考」，下一轮会从它拉一条线出来。'
                : `已选 ${String(references.length)} 张参考图，下一轮将是改图。`,
              // G01: the one-line hint the new wheel split needs. Not a toast and
              // not a modal — the corner of the canvas is where the gesture is.
              createElement('span', { className: 'dsh-forge-canvas-foot-hint' }, '滚轮平移 · Ctrl/⌘+滚轮缩放'),
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
                    createElement('img', {
                      src: studioFileUrl(image.markdownPath, STUDIO_NODE_THUMB_WIDTH),
                      alt: `结果 ${String(index + 1)}`,
                      loading: 'lazy',
                      decoding: 'async',
                    }),
                  )),
                ),
                createElement('div', { className: 'dsh-forge-batch-prompt' }, batch.response.prompt),
              )),
            ),
      ),
    ),
  )
}
