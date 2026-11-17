/**
 * Wire contract shared by the Studio host routes and the browser panel.
 *
 * The Studio is a **ComfyUI-only** workbench for Qwen-Image 2.1. That single
 * backend is why this contract is much smaller than a multi-provider one: there
 * is no provider matrix, no per-channel credential, and no quality tier
 * negotiation — just a prompt, a canvas, a step count, an optional seed, and
 * zero or more reference images.
 *
 * The prompt-optimisation channel is deliberately *separate* from generation:
 * it borrows the conversation model (through the host's `llm` service) to
 * rewrite the user's phrasing, and never touches ComfyUI. Keeping the two apart
 * is what makes "optimise, edit, regenerate" a cheap loop instead of a
 * generation-and-hope cycle.
 *
 * @module studio-shared
 */

/** Same-origin route the Studio panel reads its capability snapshot from. */
export const STUDIO_CONFIG_ROUTE = '/plugins/dsh-image-forge/studio/config'
/** Same-origin route the Studio panel posts one generation request to. */
export const STUDIO_GENERATE_ROUTE = '/plugins/dsh-image-forge/studio/generate'
/** Same-origin route the Studio panel asks the conversation model to rewrite a prompt. */
export const STUDIO_OPTIMIZE_ROUTE = '/plugins/dsh-image-forge/studio/optimize'
/** Same-origin route the board list is read from. */
export const STUDIO_BOARDS_ROUTE = '/plugins/dsh-image-forge/studio/boards'
/** Same-origin route one board is read or mutated through. */
export const STUDIO_BOARD_ROUTE = '/plugins/dsh-image-forge/studio/board'
/** Same-origin route the cross-board asset list is read from. */
export const STUDIO_ASSETS_ROUTE = '/plugins/dsh-image-forge/studio/assets'
/**
 * Same-origin route one generated PNG/JPEG/WebP is served from, as
 * `STUDIO_FILE_ROUTE?path=<encoded absolute path>`.
 *
 * The reason this route exists is that **a local path is not a URL**. The
 * Studio panel and the tool cards both want to show images the tools wrote to
 * disk (`C:\Users\…\qwen_1248x1248_1.png`), but an `<img src>` carrying a bare
 * Windows path resolves as a *relative* URL against the page origin, and a
 * `file://` rewrite is blocked outright inside an http-served page. Neither
 * half can display the file without the host serving it, so the plugin serves
 * it itself: the panel and the cards read `studioFileUrl(path)` and hit this
 * route, which streams the bytes back same-origin.
 */
export const STUDIO_FILE_ROUTE = '/plugins/dsh-image-forge/studio/file'
/**
 * Same-origin SSE stream that carries one run's live ComfyUI progress.
 *
 * The page never opens ComfyUI's own WebSocket: this plugin subscribes to
 * `/ws` in Node and re-publishes normalized events here (decision 4 in
 * `docs/DIRECTION-ALIGNMENT.md`). Each SSE message is one
 * {@link StudioProgressEvent} as JSON in its `data:` field. `state` events say
 * whether the bridge is connected, so a stopped ComfyUI is visible instead of
 * leaving a stale step counter on screen.
 */
export const STUDIO_EVENTS_ROUTE = '/plugins/dsh-image-forge/studio/events'

/**
 * Build the URL that serves one image through {@link STUDIO_FILE_ROUTE}.
 *
 * @param path - the absolute on-disk path a tool result or board item carries.
 * @returns a same-origin URL safe to put into `<img src>` and `href`.
 */
export function studioFileUrl(path: string): string {
  return `${STUDIO_FILE_ROUTE}?path=${encodeURIComponent(path)}`
}

/** File extensions the file route will serve, and the content types for them. */
export const STUDIO_FILE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

/** Canvas ratios the Studio offers; mirrors `WH_RATIOS` in `ratio.ts`. */
export const STUDIO_RATIOS = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'] as const
/** One canvas ratio, `W:H`. */
export type StudioRatio = (typeof STUDIO_RATIOS)[number]

/** Most reference images one Studio edit accepts. */
export const STUDIO_MAX_REFERENCES = 10
/** Most images one Studio generation may ask for. */
export const STUDIO_MAX_COUNT = 4
/** Longest prompt the Studio forwards, in characters. */
export const STUDIO_MAX_PROMPT_CHARS = 4000
/** Upper bound on one request body, before base64 inflation. */
export const STUDIO_MAX_BODY_BYTES = 48 * 1024 * 1024

/**
 * What the panel needs to render before the first request: which ComfyUI it
 * would talk to, whether that server answered, and which Qwen-Image weights it
 * found. Never carries a credential — the ComfyUI backend has none.
 */
export interface StudioConfigResponse {
  /** True when a ComfyUI answered and all three weight files were resolved. */
  ready: boolean
  /** Endpoint that answered, e.g. `http://127.0.0.1:8188`; absent when none did. */
  endpoint?: string
  /** Resolved weight file names, for the panel's status line. */
  models?: { unet: string; clip: string; vae: string }
  /** Why the Studio cannot generate right now, in the user's language. */
  reason?: string
  /** Default step count the host will apply when the request omits one. */
  defaultSteps: number
  /** Where generated PNGs are written. */
  outputDir: string
  /** Corners each ratio resolves to at the ~1.5 MP budget, for the picker labels. */
  sizes: Array<{ ratio: StudioRatio; width: number; height: number }>
  /** Whether the conversation model is reachable for prompt optimisation. */
  optimizeAvailable: boolean
  /** Model the optimiser would use, e.g. `deepseek-chat`; absent when unavailable. */
  optimizeModel?: string
  /**
   * Why the optimiser is unavailable, as `[stage] detail`.
   *
   * Present instead of {@link optimizeModel} when resolution failed. The panel
   * shows it on the greyed-out button, because "优化不可用" without the stage is
   * the sentence that used to cost an hour of guessing.
   */
  optimizeNote?: string
  /** Every board under the output directory, newest first. */
  boards: BoardSummary[]
  /** Board the panel should open first; `null` when the library is empty. */
  activeBoard: string | null
  /** Why the board library could not be read, when it could not. */
  boardsNote?: string
}

/** One chat turn handed to the prompt optimiser for context. */
export interface StudioOptimizeTurn {
  role: 'user' | 'assistant'
  text: string
}

/**
 * Which rewriting convention the optimiser follows.
 *
 * `prose` is this repo's house style: one long observational paragraph, with
 * quality words banned. `formula` is the published Alibaba formula — a
 * comma-separated stack of 主体 + 场景 + 风格 + 镜头 + 氛围 + 细节修饰, where
 * words like `4K` and `高分辨率` are legitimate detail modifiers. They are
 * different schools, not different lengths, so the panel lets the user pick.
 */
export const STUDIO_PROMPT_STYLES = ['prose', 'formula'] as const
/** One rewriting convention; see {@link STUDIO_PROMPT_STYLES}. */
export type StudioPromptStyle = (typeof STUDIO_PROMPT_STYLES)[number]

/** What the panel sends to have a prompt rewritten. */
export interface StudioOptimizeRequest {
  /** The raw text the user typed; may be terse, colloquial, or half-specified. */
  prompt: string
  /** Recent conversation turns, oldest first; the optimiser continues that thread. */
  context?: StudioOptimizeTurn[]
  /** Canvas the prompt is being written for, so the wording can match it. */
  ratio?: string
  /** True when the prompt accompanies reference images (an edit, not a fresh draw). */
  editing: boolean
  /** Rewriting convention; absent means `prose`. */
  style?: StudioPromptStyle
}

/** The optimiser's answer. */
export interface StudioOptimizeResponse {
  /** The rewritten prompt, ready to send verbatim. */
  prompt: string
  /** One-line note about what changed, shown under the field. */
  note?: string
  /** Model that produced it, for the provenance line. */
  model: string
}

/** One reference image on the wire: base64 without a data-URL prefix. */
export interface StudioReferencePayload {
  /** Canonical base64 of the original bytes; absent when `path` is used. */
  data?: string
  /**
   * Absolute path to an image this host already wrote, used instead of `data`.
   *
   * The canvas reuses finished images as references, and the browser never had
   * their bytes — they live on disk and were only ever displayed. Sending a path
   * avoids re-reading a multi-megabyte PNG through the page just to send it
   * back. The host validates the extension and refuses anything that is not an
   * image it could have produced.
   */
  path?: string
  /** Sniffed container, e.g. `image/png`. */
  mediaType: string
  /** Original file name, used for the label and the ComfyUI upload name. */
  name?: string
}

/** One Studio generation request. */
export interface StudioGenerateRequest {
  /** Finished prompt text, forwarded verbatim to ComfyUI. */
  prompt: string
  /** Canvas ratio; the host resolves it to 32-aligned pixels. */
  ratio: string
  /** Sampler steps, clamped by the host to a sane range. */
  steps?: number
  /** Deterministic seed; omitted means random and is reported back. */
  seed?: number
  /** How many images to ask for, 1–{@link STUDIO_MAX_COUNT}. */
  count?: number
  /** Reference images; non-empty means an edit run. */
  references?: StudioReferencePayload[]
  /**
   * Board to record into, by id or name. Absent means the active board, and a
   * brand-new board when there is no active one.
   */
  board?: string
  /**
   * Canvas task this run belongs to: `c` + base36, at most 32 characters.
   *
   * Optional and additive (DD7): a request without it behaves exactly like
   * before. The panel sends it so the host can echo it on every SSE event of
   * this run, which is how a task node knows an event is its own.
   */
  clientId?: string
}

/** Longest accepted `clientId`, including its `c` prefix. */
export const STUDIO_CLIENT_ID_MAX_CHARS = 32

/**
 * Canonical canvas task id: `c` + 1–31 lowercase base36 characters.
 *
 * Mirrors `makeItemId` in `boards.ts` (a `c`-prefixed random base36 string) and
 * is validated on the host because it is a single-value field: a malformed one
 * is refused outright, unlike the per-entry coordinate lists the board route
 * drops one by one (CANVAS-DESIGN §14.3).
 */
export const STUDIO_CLIENT_ID_PATTERN = /^c[0-9a-z]{1,31}$/

/**
 * True when a value is a canonical canvas task id.
 *
 * @param value - untrusted wire value.
 * @returns whether it can be echoed back to the panel as a task id.
 */
export function isStudioClientId(value: unknown): value is string {
  return typeof value === 'string' && STUDIO_CLIENT_ID_PATTERN.test(value)
}

/** One produced image. */
export interface StudioImage {
  /** Board item id; the canvas keys a node by it so the layout can be saved. */
  id: string
  /** Absolute path on disk. */
  path: string
  /** Same path with forward slashes, for Markdown. */
  markdownPath: string
  width: number
  height: number
  /** Byte length of the file that was written. */
  bytes: number
  /** Container the bytes were sniffed as. */
  mediaType: string
}

/** What one generation produced, plus the provenance the panel displays. */
export interface StudioGenerateResponse {
  images: StudioImage[]
  /** Prompt actually used (after optimisation, if the panel applied one). */
  prompt: string
  /** Ratio string as requested. */
  ratio: string
  width: number
  height: number
  /** Steps actually used. */
  steps: number
  /** Seed actually used, so a result can be reproduced. */
  seed: number
  /** Wall-clock milliseconds from request acceptance to last byte on disk. */
  elapsedMs: number
  /** Endpoint that ran it. */
  endpoint: string
  /** `generate` for a fresh draw, `edit` when references were supplied. */
  mode: 'generate' | 'edit'
  /**
   * True when the run asked for the **turbo** variant but the base weights ran
   * instead, because no distilled checkpoint is installed.
   *
   * The Agent tools report the same fact as `comfyui.turbo_fallback`; this is the
   * Studio's field for it, so a degrade is visible in the panel instead of
   * silently producing base pictures under a "turbo" setting. A request that
   * never asked for turbo (base, MOSS) reports false — it is not a fallback.
   */
  turboFallback: boolean
  /** Board the images were recorded on, when recording succeeded. */
  board?: BoardSummary
  /** Why recording failed, when it did — the images are on disk either way. */
  boardNote?: string
}

// ---------------------------------------------------------------------------
// Boards: the storage and display unit above a single image file.
// ---------------------------------------------------------------------------

/** One board: a named project holding finished images and their arrangement. */
export interface BoardSummary {
  id: string
  name: string
  /** Number of images recorded on it. */
  itemCount: number
  /** `markdownPath` of the newest image, for a cover thumbnail. */
  cover: string | null
  createdAt: string
  updatedAt: string
  /** Conversation that created it, when one did. */
  sessionId: string | null
}

/**
 * Which node a board item is (v2).
 *
 * `image` is a finished picture (a v1 item, and what a v1 file migrates to);
 * `task` is a generation that ended without producing one (kept so the canvas
 * can offer a retry); `layout` is a MOSS layout draft with no picture yet.
 * Absent on a v2 item means `image` — that keeps hand-written and future files
 * readable without inventing a default at every call site.
 */
export type BoardItemKind = 'image' | 'task' | 'layout'

/**
 * One box of a layout draft, structurally equal to `LayoutDraftItem`
 * in `layout-editor.ts`.
 *
 * Restated here instead of imported: `layout-editor.ts` is a **client** module,
 * and pulling it into `studio-shared.ts` (which the host half also bundles)
 * would drag the editor's DOM mount into the server entry. The shapes are kept
 * identical on purpose — a draft written here compiles there without a cast.
 */
export interface BoardLayoutItem {
  /** `object` / `character` / `text`, the labels the compiler accepts. */
  label: 'object' | 'character' | 'text'
  caption: string
  /** Draft pixels, `[x1, y1, x2, y2]`, origin top-left. */
  bbox: readonly [number, number, number, number]
  text?: string
  tags?: string[]
  palette?: string[]
}

/**
 * A layout draft as a board stores it, structurally equal to `LayoutDraft`.
 *
 * Same reason as {@link BoardLayoutItem} for restating it: shared code cannot
 * import the client editor module. Pixel coordinates are independent of the
 * node's display size ({@link BoardItem.w}), which is the point of keeping the
 * draft verbatim rather than a rendered image.
 */
export interface BoardLayoutDraft {
  /** Canvas width in draft pixels (a positive multiple of 16). */
  width: number
  /** Canvas height in draft pixels (a positive multiple of 16). */
  height: number
  bbox_coord_space: 'abs'
  bbox_format: 'xyxy'
  summary: {
    caption: string
    meta?: string[]
    canvas?: 'single' | 'multi_panel' | 'collage'
    palette?: string[]
  }
  items: BoardLayoutItem[]
}

/**
 * The generation request a task node was started from, so a failure can be
 * retried (or the form reopened) without asking the user to retype it.
 *
 * A snapshot, not a live request: references are reduced to what the retry
 * needs (a path or a name plus its media type), never image bytes.
 */
export interface BoardTaskParams {
  prompt: string
  ratio?: string
  steps?: number
  count?: number
  seed?: number
  references?: Array<{ path?: string; name?: string; mediaType?: string }>
}

/** A task node that reached a terminal state; only terminal states are stored. */
export interface BoardTaskInfo {
  status: 'failed' | 'interrupted'
  params: BoardTaskParams
  /** First line of whatever went wrong, for the node's caption. */
  error?: string
}

/** One image as a board stores it: the file, its provenance and its position. */
export interface BoardItem {
  id: string
  path: string
  markdownPath: string
  width: number
  height: number
  bytes: number
  mediaType: string
  /** Prompt that produced it; empty for an imported file. */
  prompt: string
  /** Ratio as requested, when the run had one. */
  ratio: string | null
  steps: number | null
  seed: number | null
  mode: 'generate' | 'edit'
  /** `comfyui` / `api` / `studio`, when known. */
  backend: string | null
  /** Board item ids this image was edited from, for the canvas edges. */
  parents: string[]
  createdAt: string
  /** Conversation the image came from, when it came from one. */
  sessionId: string | null
  /** Groups the images of one run, so the list view can rebuild a batch. */
  batchId: string
  /** Canvas position in world units; `null` for an item never placed. */
  x: number | null
  y: number | null

  // ---- v2 additions; absent means `'image'` (the v1 shape) -------------------
  /** What this node is. Absent means `'image'`, which is what v1 files migrate to. */
  kind?: BoardItemKind
  /** `kind:'layout'` only: the editable draft. Missing means the item is unreadable. */
  draft?: BoardLayoutDraft
  /** `kind:'layout'` only: display size in world units (`draft` has its own pixels). */
  w?: number
  h?: number
  /** `kind:'task'` only: the terminal state and the request to retry. */
  task?: BoardTaskInfo
}

/** One board with its items and camera. */
export interface BoardDetail extends BoardSummary {
  items: BoardItem[]
  camera: { x: number; y: number; zoom: number } | null
}

/** Answer of the board-list route. */
export interface StudioBoardsResponse {
  boards: BoardSummary[]
  active: string | null
}

/** One action on a board, discriminated by `action`. */
export interface StudioBoardRequest {
  action: 'create' | 'rename' | 'layout' | 'remove-item' | 'delete' | 'active'
  /** Target board; absent means the active board. */
  board?: string
  /** New name, for `create` and `rename`. */
  name?: string
  /** Positions to persist, for `layout`. */
  items?: Array<{ id: string; x: number; y: number }>
  /** Camera to persist, for `layout`. */
  camera?: { x: number; y: number; zoom: number }
  /** Item to drop, for `remove-item`. */
  item?: string
  /** Also delete the PNG, for `remove-item`; the default only unplaces it. */
  deleteFile?: boolean
}

/** One asset in the cross-board list: an item plus the board it belongs to. */
export interface StudioAsset extends BoardItem {
  boardId: string
  boardName: string
}

/** Answer of the asset route. */
export interface StudioAssetsResponse {
  assets: StudioAsset[]
  boards: BoardSummary[]
  total: number
}

/** Error body every Studio route answers with when it refuses. */
export interface StudioErrorBody {
  error: string
}

/**
 * First line of a failure, for any payload that must stay small.
 *
 * Shared by the route guards, the Studio pipeline and the tool layer: adapter
 * messages are deliberately multi-line (they quote upstream tracebacks), but
 * the wire copies carry only the headline. `fallback` replaces an empty first
 * line — a tool's board note keeps the original text, an HTTP body says
 * 未知错误.
 *
 * @param error - the thrown value.
 * @param fallback - what to return when the first line is empty.
 * @returns the first line, or the fallback.
 */
export function firstLine(error: unknown, fallback = '未知错误'): string {
  const text = error instanceof Error ? error.message : String(error)
  const line = text.split(/\r?\n/, 1)[0] ?? text
  return line.length > 0 ? line : fallback
}

/**
 * DD7 canvas association carried by every event that names a prompt.
 *
 * Additive and optional: runs started by the Agent tools are never registered,
 * so their events keep the exact pre-DD7 shape, and a front end that does not
 * know these fields simply ignores them.
 */
export interface StudioRunLink {
  /** Canvas task node that initiated the run. */
  clientId?: string
  /** Board the result will be recorded on. */
  boardId?: string
}

/**
 * One message on {@link STUDIO_EVENTS_ROUTE}'s stream.
 *
 * This union is the whole contract between the backend bridge
 * (`src/progress.ts`) and the panel: ComfyUI's raw `/ws` envelope never reaches
 * the page, so the front end cannot accidentally grow a dependency on a
 * renderer event name. `state` is emitted on subscribe and on every connection
 * change; the rest follow one run — `queue` for ComfyUI's broadcast queue
 * depth (the single-user local renderer this is sized for), then
 * `start`/`node`/`progress` while it executes, then exactly one of
 * `done`/`error`/`interrupted`.
 */
export type StudioProgressEvent =
  /** The bridge's own connection, not ComfyUI's run. */
  | { type: 'state'; state: 'connecting' | 'connected' | 'disconnected'; endpoint?: string; reason?: string }
  /** Tasks ComfyUI still has queued, pushed on every queue change. */
  | { type: 'queue'; remaining: number }
  /**
   * A canvas task's run was registered on the host (DD7).
   *
   * Emitted at submission, before ComfyUI executes anything, so the task node
   * can leave `idle` for `queued` and keep a local clientId↔promptId mapping
   * that survives a stream reconnect. Not part of ComfyUI's vocabulary; a panel
   * that does not know the type drops it through its reducer's default branch.
   */
  | { type: 'run'; promptId: string; clientId: string; boardId?: string }
  /** A prompt began executing (ComfyUI `execution_start`). */
  | ({ type: 'start'; promptId: string } & StudioRunLink)
  /** Nodes reused from ComfyUI's cache (ComfyUI `execution_cached`). */
  | { type: 'cached'; promptId: string; nodes: string[] }
  /** A node started executing; the id the panel can name. */
  | ({ type: 'node'; promptId: string; node: string; displayNode?: string } & StudioRunLink)
  /**
   * One sampler step: `value` of `max`, with `label` already in the
   * "17/50" form the panel prints verbatim.
   */
  | ({ type: 'progress'; promptId: string; node?: string; value: number; max: number; percent: number; label: string } & StudioRunLink)
  /** The run finished successfully, once per prompt. */
  | ({ type: 'done'; promptId: string } & StudioRunLink)
  /** ComfyUI `execution_error`, with the exception headline only. */
  | ({ type: 'error'; promptId?: string; node?: string; nodeType?: string; message: string } & StudioRunLink)
  /** ComfyUI's interrupt fired (ComfyUI `execution_interrupted`). */
  | ({ type: 'interrupted'; promptId: string } & StudioRunLink)
