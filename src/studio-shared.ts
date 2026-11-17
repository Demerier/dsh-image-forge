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
 * Same-origin route an external image file is imported through (DD10).
 *
 * The design's drop-an-OS-file story needed a route that did not exist: the
 * asset route is a read-only query, the file route serves bytes and never
 * accepts them, and the board route's body cap (256 KB) cannot carry a picture.
 * So importing is its own contract: one image per request, bounded bytes, and
 * the same identity semantics as a recorded generation.
 */
export const STUDIO_IMPORT_ROUTE = '/plugins/dsh-image-forge/studio/import'

/**
 * Same-origin route the workbench starts, stops and inspects ComfyUI through.
 *
 * Deliberately one POST route with an `action` discriminator rather than three
 * near-identical routes: the three verbs share the same body shape, the same
 * origin check and the same single-flight lock, and a typo in the action is
 * refused at the host instead of 404ing with no explanation.
 *
 * It is a **POST** even for `status`, because the answer depends on mutating
 * state (the launch record) and must never be served from a cache or prefetched
 * by a browser.
 */
export const STUDIO_ENVIRONMENT_ROUTE = '/plugins/dsh-image-forge/studio/environment'

/** Actions {@link STUDIO_ENVIRONMENT_ROUTE} accepts. */
export const STUDIO_ENVIRONMENT_ACTIONS = ['status', 'start', 'stop'] as const
/** One environment action. */
export type StudioEnvironmentAction = (typeof STUDIO_ENVIRONMENT_ACTIONS)[number]


/** Largest single imported file accepted, in bytes (32 MB, DD10). */
export const STUDIO_IMPORT_MAX_ITEM_BYTES = 32 * 1024 * 1024

/**
 * Body cap for the import route, in bytes.
 *
 * Independent of the board route's 256 KB and deliberately above the item cap:
 * base64 inflates by 4/3, so a legal 32 MB file arrives as a ~42.7 MB body.
 */
export const STUDIO_IMPORT_MAX_BODY_BYTES = 48 * 1024 * 1024

/**
 * Build the URL that serves one image through {@link STUDIO_FILE_ROUTE}.
 *
 * @param path - the absolute on-disk path a tool result or board item carries.
 * @returns a same-origin URL safe to put into `<img src>` and `href`.
 */
export function studioFileUrl(path: string, width?: number): string {
  const base = `${STUDIO_FILE_ROUTE}?path=${encodeURIComponent(path)}`
  return width === undefined ? base : `${base}&w=${String(width)}`
}

/**
 * Widths the file route will downscale to (G20).
 *
 * A whitelist, not a free number: each entry is a cache file the route may
 * create, and an unbounded `?w=` is an unbounded cache directory plus an
 * unbounded per-request CPU cost. 256 is the contact-sheet cell, 512 is the
 * canvas node, 1024 is a "large but not original" preview.
 */
export const STUDIO_THUMB_WIDTHS = [256, 512, 1024] as const
/** Width the canvas node's `<img>` asks for. */
export const STUDIO_NODE_THUMB_WIDTH = 512
/** Directory (under `outputDir`) the generated thumbnails are cached in. */
export const STUDIO_THUMB_DIR = '.dsh-image-forge'

/**
 * Validate a `?w=` value against {@link STUDIO_THUMB_WIDTHS}.
 *
 * @param raw - the query string value, or `null` when absent.
 * @returns the width, `undefined` when the parameter was not given at all, or
 *   `null` when it was given but is not an allowed number. The three cases are
 *   distinguishable on purpose: "no width" is the original file, "bad width" is
 *   a 400, and conflating them would silently serve originals to a caller that
 *   asked for something impossible.
 */
export function parseStudioThumbWidth(raw: string | null): number | undefined | null {
  if (raw === null || raw.length === 0) return undefined
  const width = Number(raw)
  return (STUDIO_THUMB_WIDTHS as readonly number[]).includes(width) ? width : null
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
/** Longest compiled layout prompt the Studio forwards, in characters. */
export const STUDIO_MAX_LAYOUT_CHARS = 64 * 1024
/** Most parent item ids one Studio request may carry. */
export const STUDIO_MAX_PARENT_IDS = 32

/** Aspect of every official ratio, kept beside {@link STUDIO_RATIOS}. */
const STUDIO_RATIO_ASPECTS: ReadonlyArray<{ readonly ratio: StudioRatio; readonly aspect: number }> = [
  { ratio: '1:1', aspect: 1 },
  { ratio: '4:3', aspect: 4 / 3 },
  { ratio: '3:4', aspect: 3 / 4 },
  { ratio: '3:2', aspect: 3 / 2 },
  { ratio: '2:3', aspect: 2 / 3 },
  { ratio: '16:9', aspect: 16 / 9 },
  { ratio: '9:16', aspect: 9 / 16 },
]

/** How a draft's aspect maps onto the official canvas-ratio ladder (§8.4). */
export interface StudioRatioFit {
  /** Nearest official ratio. */
  readonly ratio: StudioRatio
  /** Draft aspect (width / height). */
  readonly aspect: number
  /** The official ratio's aspect. */
  readonly target: number
  /** Relative deviation `|aspect - target| / target`; 0 is an exact match. */
  readonly deviation: number
}

/**
 * Nearest official ratio for a draft canvas (§8.4).
 *
 * The layout draft is arbitrary (its sides are multiples of 16), while a
 * generation canvas is one of seven ratios. The mapping is explicit and
 * testable here instead of living in the panel, and a caller must still decide
 * what a large deviation means — §8.4 says "prompt, never stretch silently".
 *
 * @returns the fit, or `undefined` for a degenerate draft size.
 */
export function fitStudioRatio(width: number, height: number): StudioRatioFit | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  const aspect = width / height
  let best = STUDIO_RATIO_ASPECTS[0]
  let deviation = Number.POSITIVE_INFINITY
  for (const entry of STUDIO_RATIO_ASPECTS) {
    const candidate = Math.abs(aspect - entry.aspect) / entry.aspect
    if (candidate < deviation) {
      best = entry
      deviation = candidate
    }
  }
  return { ratio: best.ratio, aspect, target: best.aspect, deviation }
}

/**
 * Largest draft↔official deviation one-click layout generation tolerates.
 *
 * One percent: enough for a 16-aligned draft that rounds to an official ratio,
 * far too little for a deliberately stretched composition (which §8.4 refuses
 * rather than silently letterboxing the drawn boxes).
 */
export const STUDIO_LAYOUT_RATIO_TOLERANCE = 0.01

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

/**
 * The environment as the workbench sees it, after one action.
 *
 * `owned` is the load-bearing field: only an instance **this plugin** started
 * may be stopped from here. A ComfyUI the user launched themselves reports
 * `owned: false` even though `state` is `ready`, and the panel says so instead of
 * offering a button that would have to guess which process to kill.
 */
export interface StudioEnvironmentSnapshot {
  /** One of the environment layer's five states. */
  state: string
  /** Why the state is what it is, safe to print verbatim. */
  note?: string
  /** Endpoint a backend answered on, when one did. */
  endpoint?: string
  /** Port the backend answers on / that a launch used. */
  port?: number
  /** Pid of the instance this plugin started, when it is alive. */
  pid?: number
  /** Log file of the last launch, so a failure has somewhere to be read. */
  logPath?: string
  /** How long the launch wait ran, in milliseconds. */
  waitedMs?: number
  /** True only when the running backend is provably the one this plugin started. */
  owned: boolean
  /** The argv a launch ran — or would run — with (stage 3 preview). */
  argvPreview?: string[]
  /** What to do next, when the state is not `ready`. */
  hint?: string
  /** Why `owned` is false although a pid is known, when that is the case. */
  ownershipNote?: string
}

/** What a `stop` action reports, on top of the refreshed snapshot. */
export interface StudioEnvironmentStop {
  stopped: boolean
  /** Pid the launch record named, when there was one. */
  pid?: number
  /** `taskkill` exit code on Windows; absent on POSIX and on refusal. */
  exitCode?: number
  /** Why nothing was stopped; `null`/absent on success. */
  reason?: string | null
  /** Did `/system_stats` really stop answering? Absent when unverifiable. */
  verified?: boolean | null
  /** The explanation the panel prints. */
  note?: string
}

/**
 * Body of {@link STUDIO_ENVIRONMENT_ROUTE}.
 *
 * `action` is optional and defaults to `status`, so the panel's first read can be
 * a body-less POST and an unknown action is answered as a read rather than as a
 * destructive guess.
 */
export interface StudioEnvironmentRequest {
  action?: StudioEnvironmentAction
}

/** Answer of {@link STUDIO_ENVIRONMENT_ROUTE}. */
export interface StudioEnvironmentResponse {
  environment?: StudioEnvironmentSnapshot
  /** Present only for `stop`. */
  stop?: StudioEnvironmentStop
  /** Present when the action was refused (busy / bad body). */
  error?: string
}

/** One chat turn handed to the prompt optimiser for context. */export interface StudioOptimizeTurn {
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
  /**
   * Compiled MOSS layout prompt (T21's contract: the layout editor's compiled
   * export, `bbox_coord_space:'abs_centralized'`, `bbox_format:'yxyx'`).
   *
   * Only the `moss-sft` profile has a layout path; the host refuses it on any
   * other profile and refuses a malformed layout before touching ComfyUI. Absent
   * means the plain text-to-image request, byte-identical to before T21.
   */
  layout?: string
  /**
   * Canvas parents of the result, as **board item ids** (§8.4).
   *
   * The conversation path knows its references only as paths, but the canvas
   * knows the ids it drew edges from — including a layout node, which has no
   * file path a `parentPaths` lookup could resolve. Explicit ids win over path
   * resolution in the board store; unknown ids are simply not drawn.
   */
  parents?: string[]
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
  /**
   * Compiled MOSS layout prompt the run carried (T21/C14), kept so a retry
   * re-sends the exact same conditioning text.
   */
  layout?: string
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

/**
 * One action on a board, discriminated by `action`.
 *
 * The closed set grew from six to eight in C12 (§7.2: `copy-item` /
 * `move-item`) and to ten in C14, which gives the non-picture node kinds a
 * terminal write: `save-task` stores a failed/interrupted task node (§4.6) and
 * `save-layout-node` stores a layout draft (§8.1), so both survive a reload.
 * Importing an image is **not** a board action — it writes a file before it
 * records an item, so it has its own route ({@link STUDIO_IMPORT_ROUTE}).
 */
export interface StudioBoardRequest {
  action:
    | 'create'
    | 'rename'
    | 'layout'
    | 'remove-item'
    | 'delete'
    | 'active'
    | 'copy-item'
    | 'move-item'
    | 'save-task'
    | 'save-layout-node'
  /** Target board; absent means the active board. */
  board?: string
  /** New name, for `create` and `rename`. */
  name?: string
  /** Positions to persist, for `layout`. */
  items?: Array<{ id: string; x: number; y: number }>
  /** Camera to persist, for `layout`. */
  camera?: { x: number; y: number; zoom: number }
  /** Item to drop (`remove-item`) or to copy/move across boards. */
  item?: string
  /** Also delete the PNG, for `remove-item`; the default only unplaces it. */
  deleteFile?: boolean
  /** Destination board for `copy-item` / `move-item`; id or name. */
  toBoard?: string
  /** Landing position on the destination board, when the caller knows it. */
  x?: number
  /** Vertical landing position; always paired with `x`. */
  y?: number
  /** Canvas parents of a saved task/layout node, as board item ids. */
  parents?: string[]
  /** Terminal state to store, for `save-task` (§4.6: only failed/interrupted). */
  task?: BoardTaskInfo
  /** Draft to store, for `save-layout-node`. */
  draft?: BoardLayoutDraft
  /** Display width in world units, for `save-layout-node` (§8.3). */
  w?: number
  /** Display height in world units, for `save-layout-node`. */
  h?: number
}

/**
 * One external image on its way onto a board (DD10).
 *
 * `data` is canonical base64 without a data-URL prefix; the container is
 * sniffed from the bytes, never trusted from `mediaType`.
 */
export interface StudioImportRequest {
  /** Board to record onto; absent means the active board. */
  board?: string
  /** Original file name, used for the on-disk prefix and the error text. */
  name: string
  /** Client's claim; informational only, the sniffed container wins. */
  mediaType?: string
  /** Base64 of the file's bytes. */
  data: string
  /** Landing position in world units, when the drop point is known. */
  x?: number
  y?: number
}

/** Answer of the import route: the recorded item and the board it landed on. */
export interface StudioImportResponse {
  item: BoardItem
  board: BoardSummary
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


// ---------------------------------------------------------------------------
// T22: the installer stepper
// ---------------------------------------------------------------------------

/** The four steps from "nothing installed" to "first picture" (direction §6.1 P6). */
export type StepperStepId = 'runtime' | 'install' | 'weights' | 'first-run'

/** One step's state; `active` means this is what the user is waiting on now. */
export type StepperStepState = 'done' | 'active' | 'pending' | 'failed'

/** One rendered stepper row. */
export interface StepperStep {
  readonly id: StepperStepId
  readonly label: string
  readonly state: StepperStepState
  /** One line of why/what-next; safe to show verbatim. */
  readonly detail: string
}

/** What the stepper needs to know; all of it already rides the config snapshot or SSE. */
export interface StepperInput {
  /** ComfyUI answered and the three weights resolved. */
  readonly ready: boolean
  /** Why it is not ready, when it is not (the config snapshot's `reason`). */
  readonly reason?: string
  /** Weight files the probe resolved; absent when the probe failed. */
  readonly models?: { readonly unet: string; readonly clip: string; readonly vae: string }
  /** Endpoint that answered, for the runtime step's detail. */
  readonly endpoint?: string
  /** Total pictures already recorded on the visible boards. */
  readonly itemCount: number
  /** The live SSE phase, when the panel has one. */
  readonly livePhase?: 'idle' | 'queued' | 'running' | 'done' | 'error' | 'interrupted'
  /** Step percent from the SSE stream, when running. */
  readonly livePercent?: number
  /** Failure headline from the last run, when the phase is `error`. */
  readonly liveMessage?: string
}

/**
 * Derive the four-step installation/first-picture ladder.
 *
 * Pure on purpose: the states are the contract `test/studio.test.mjs` pins, and
 * the panel only renders them. The real state machine lives in
 * `src/environment.ts`; this is its **presentation projection** — the same
 * facts the environment tool reports, mapped onto the four user-facing steps.
 * Install/download themselves are run by `qwen_image_setup` (the managed entry);
 * the stepper's own action is "重新检测", which re-reads the snapshot.
 */
export function stepperStepsOf(input: StepperInput): StepperStep[] {
  const reason = typeof input.reason === 'string' && input.reason.length > 0 ? firstLine(input.reason) : undefined
  const modelsReady = input.models !== undefined
  const steps: StepperStep[] = []
  steps.push({
    id: 'runtime',
    label: 'ComfyUI 运行',
    state: input.ready ? 'done' : 'failed',
    detail: input.ready
      ? '已连接 ' + (input.endpoint ?? 'ComfyUI')
      : (reason ?? '未检测到 ComfyUI；按 qwen_image_setup action=start 拉起或先安装'),
  })
  steps.push({
    id: 'install',
    label: '安装 / 受管环境',
    state: input.ready ? 'done' : 'pending',
    detail: input.ready
      ? '受管入口 qwen_image_setup 可用'
      : '让 agent 调 qwen_image_setup action=install 看引导，或按 docs/local-install.md 安装',
  })
  steps.push({
    id: 'weights',
    label: '权重就绪',
    state: modelsReady ? 'done' : input.ready ? 'failed' : 'pending',
    detail: modelsReady
      ? [input.models?.unet, input.models?.clip, input.models?.vae].filter((value) => typeof value === 'string').join(' · ')
      : input.ready
        ? '已连上 ComfyUI 但三权重不齐：qwen_image_setup action=download'
        : '等 ComfyUI 就绪后自动检查权重',
  })
  const phase = input.livePhase ?? 'idle'
  const running = phase === 'queued' || phase === 'running'
  const failed = phase === 'error'
  const done = phase === 'done' || input.itemCount > 0
  steps.push({
    id: 'first-run',
    label: '首次出图',
    state: failed ? 'failed' : done ? 'done' : running ? 'active' : 'pending',
    detail: failed
      ? (input.liveMessage === undefined ? '本次生成失败，详见下方进度条' : firstLine(input.liveMessage))
      : done
        ? '画板上已有结果；这一单流程走完'
        : running
          ? (input.livePercent === undefined ? '正在生成…' : '正在生成… ' + String(input.livePercent) + '%')
          : '用下方表单生成第一张图（首次会加载权重，可能比之后慢）',
  })
  return steps
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
