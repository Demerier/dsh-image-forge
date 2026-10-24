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
