/**
 * Boards: the Studio's storage and display unit.
 *
 * A **board** is one project — a subject, a shoot, a batch of retouches. It owns
 * a set of finished images and the arrangement those images were dragged into,
 * so reopening the workbench restores the work rather than an empty canvas. The
 * unit exists because the two front doors (the Agent tools and the panel) write
 * into one flat `outputDir`: without a grouping above the file, "which of these
 * 300 PNGs belong together" has no answer.
 *
 * ## Where it lives
 *
 * Under the configured `outputDir`, in a dot-directory the image writer never
 * touches:
 *
 * ```text
 * <outputDir>/.dsh-image-forge/
 *   state.json          { "active": "b…" }   last board the panel had open
 *   boards/<id>.json    one board, rewritten atomically
 * ```
 *
 * One file per board instead of one growable index: a corrupt board costs that
 * board, not the library, and a write never rewrites everybody's metadata. The
 * list is a directory read — a few dozen small files, which is cheaper than
 * keeping an index honest across two writers.
 *
 * ## Who writes
 *
 * - `tools.ts`, after a conversation call lands its PNGs. No `board` argument
 *   means **a new board** named after the prompt; the id comes back in the tool
 *   payload so the model can keep using it.
 * - `studio-service.ts`, after a panel generation. No board means the active
 *   board, else a new one.
 * - `studio-view.ts`, for layout (node positions, camera) and removals.
 *
 * All three go through this module, so the two halves cannot disagree about
 * what a board is. Writes are serialised per output directory: read-modify-write
 * on one JSON file from two concurrent generations would otherwise lose the
 * first one's items.
 *
 * @module boards
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type {
  BoardDetail,
  BoardItem,
  BoardLayoutDraft,
  BoardSummary,
  BoardTaskInfo,
  StudioAsset,
} from './studio-shared.ts'

/** Directory name under `outputDir` that holds every board artifact. */
export const BOARDS_DIR_NAME = '.dsh-image-forge'

/** Longest board name kept, in characters. */
export const BOARD_NAME_CHARS = 40

/** Most boards one output directory may hold. */
export const MAX_BOARDS = 200

/** Most items one board may hold. */
export const MAX_BOARD_ITEMS = 1000

/**
 * Shape version of one board file.
 *
 * v2 added `kind` to items (`image` / `task` / `layout`); v1 files have no
 * `kind` and are migrated **in memory on read** (see {@link migrateBoardFile}),
 * so an upgrade never makes an existing board disappear from the panel. A file
 * from a **newer** version is still ignored whole: an old plugin must not write
 * a board it cannot understand.
 */
export const BOARD_VERSION = 2

/**
 * The one older shape this module can still read: v1, whose items are all
 * images and carry no `kind`.
 */
const BOARD_VERSION_V1 = 1

/**
 * Columns, pitch and origin of the grid an unplaced item lands on.
 *
 * `GRID_PITCH_X` is `MAX_NODE_WIDTH (480) + 36` (DD16, CANVAS-DESIGN §3.4): the
 * grid is the fallback arrangement for items with no saved position, and a node
 * is now as wide as its picture's aspect ratio allows, so the pitch has to clear
 * the widest node instead of the 208 default box. Density on a first drop is
 * worth less than never overlapping; the user's own arrangement takes over from
 * the moment they drag a node.
 *
 * Mirrored in `src/studio-view.ts` (`fallbackSpot`), which keeps the same grid
 * for a node whose stored position is missing — change both together.
 */
const GRID_COLUMNS = 3
const GRID_PITCH_X = 516
const GRID_PITCH_Y = 276
const GRID_ORIGIN = 40

/** One board file as it sits on disk. */
interface BoardFile {
  version: number
  id: string
  name: string
  createdAt: string
  updatedAt: string
  sessionId: string | null
  camera: { x: number; y: number; zoom: number } | null
  items: BoardItem[]
}

/** An item on its way in: everything the caller knows, no identity yet. */
export interface NewBoardItem {
  /** Pre-assigned id, so the panel can key a node before the write returns. */
  id?: string
  path: string
  markdownPath: string
  width: number
  height: number
  bytes: number
  mediaType: string
  prompt: string
  ratio?: string | null
  steps?: number | null
  seed?: number | null
  mode?: BoardItem['mode']
  backend?: string | null
  parents?: readonly string[]
  /**
   * Paths of the images this one was edited from, resolved against **this
   * board's** items inside the write lock and turned into `parents` ids.
   *
   * The conversation path knows its reference images only as the paths the
   * caller passed; the id of the item those paths belong to is decided here,
   * where the board is already loaded. Paths that match nothing (a reference
   * from another board, an untracked file) are dropped silently — a missing
   * edge must never fail a generation that already succeeded.
   */
  parentPaths?: readonly string[]
  sessionId?: string | null
  batchId?: string
  /** Placement from a caller that already knows where it goes (never the tools). */
  x?: number | null
  y?: number | null
}

/** What a tool or the panel gets back after recording a run. */
export interface BoardWrite {
  board: BoardSummary
  /** True when this call is what created the board. */
  created: boolean
  /** Items written, in input order, with their assigned ids. */
  items: BoardItem[]
}

/** Query for the asset page: one board, all boards, and a free-text filter. */
export interface AssetQuery {
  board?: string
  q?: string
  limit?: number
}

/** Result of one asset query, plus the board vocabulary its filters need. */
export interface AssetPage {
  assets: StudioAsset[]
  boards: BoardSummary[]
  /** Items matching the query before `limit` was applied. */
  total: number
}

/** Absolute path of the plugin's own state directory under `outputDir`. */
export function boardsRoot(outputDir: string): string {
  return join(outputDir, BOARDS_DIR_NAME)
}

/** Directory holding one JSON file per board. */
function boardsDir(outputDir: string): string {
  return join(boardsRoot(outputDir), 'boards')
}

/** State file remembering the board the panel had open. */
function stateFile(outputDir: string): string {
  return join(boardsRoot(outputDir), 'state.json')
}

/** One board's file path. */
function boardFile(outputDir: string, id: string): string {
  assertBoardId(id)
  return join(boardsDir(outputDir), `${id}.json`)
}

/**
 * Refuse any id that did not come from {@link newBoardId}.
 *
 * Board ids are always generated (`b` + base36 clock + base36 entropy), so the
 * allow-list is strict and costs nothing legitimate. It is the single choke
 * point in front of `join(boardsDir, \`${id}.json\`)`: without it, a crafted
 * id like `../victim` read out of a hostile board file — or handed to the
 * board route's `board` parameter — would walk the path out of the boards
 * directory and turn reads and deletes into a filesystem oracle.
 */
function assertBoardId(id: string): void {
  if (!/^[a-z0-9]{1,64}$/.test(id)) {
    throw new Error(`boards: invalid board id "${id.slice(0, 40)}" — ids are generated, never accepted from callers`)
  }
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * Per-directory write queues.
 *
 * Two generations can finish within the same millisecond (a panel run and a
 * conversation run), and both do read-modify-write on one board file. Chaining
 * the writes per directory is enough: the work is small and single-process, and
 * a rejected task must not poison the chain, hence `.catch` on the stored tail.
 *
 * Shared with `output.ts`, which needs the same guarantee for its
 * find-free-index-then-write sequence.
 */
const queues = new Map<string, Promise<unknown>>()

export function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const run = previous.then(task, task)
  queues.set(key, run.catch(() => undefined))
  return run
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** Two-digit, zero-padded, for the fallback name. */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** `画板 10-19 21:30` — the name a board gets when nothing suggests a better one. */
export function defaultBoardName(now: Date = new Date()): string {
  return `画板 ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/**
 * A board name derived from the prompt that produced its first image.
 *
 * First non-empty line, whitespace collapsed, control characters dropped, cut
 * to {@link BOARD_NAME_CHARS} **by code point** — slicing a surrogate pair in
 * half would put a replacement character in every subsequent list render.
 *
 * @param prompt - the prompt the caller sent.
 * @param now - clock override for the fallback name.
 * @returns a non-empty, printable name.
 */
export function nameFromPrompt(prompt: string, now: Date = new Date()): string {
  const firstLine = prompt.split(/[\r\n]+/).map((line) => line.trim()).find((line) => line.length > 0) ?? ''
  const cleaned = firstLine
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const cut = [...cleaned].slice(0, BOARD_NAME_CHARS - 1).join('').trim()
  return cut.length > 0 ? cut : defaultBoardName(now)
}

/**
 * Make an arbitrary string safe to use as a board name.
 *
 * @param raw - the caller's name.
 * @returns the printable name, or `undefined` when nothing usable survived.
 */
export function sanitizeBoardName(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length === 0) return undefined
  return [...cleaned].slice(0, BOARD_NAME_CHARS).join('').trim() || undefined
}

/** New board id: `b` + base36 clock + four random base36 chars. */
function newBoardId(taken: (id: string) => boolean): string {
  for (;;) {
    const id = `b${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 4)}`
    if (!taken(id)) return id
  }
}

/** New item id; the `i` prefix keeps it distinguishable from a board id in logs. */
export function makeItemId(): string {
  return `i${randomUUID().replace(/-/g, '').slice(0, 10)}`
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Bring any board file this plugin understands up to {@link BOARD_VERSION}.
 *
 * **Pure**: no IO, no clock, and `raw` is never mutated — `readBoardFile` hands
 * it the parsed JSON and the caller gets a board it can render. That purity is
 * also what makes the lazy migration safe: reading a v1 board (listing the
 * library, opening the panel) never writes to disk, so a read-only output
 * directory stays usable and merely listing boards cannot rewrite a user's
 * library. The upgraded shape reaches disk with the **next** write the user
 * causes (record / save-layout / remove / rename), because every writer saves
 * the board it just read.
 *
 * v1 → v2 is additive by construction: each item keeps every field it had
 * (`id`, `x`/`y`, `parents`, `batchId`, …) and gains `kind:'image'`; the board
 * keeps its name/camera/timestamps and gains `version:2`. Items that were
 * invalid in v1 are still dropped one by one — a single bad entry must never
 * hide the rest of the board (the loose-validation rule this module has always
 * had).
 *
 * v2 is validated **by kind**: an image needs its three file strings (as
 * before), a task needs a terminal status plus its params, a layout needs its
 * draft. An unknown kind (a node type from a future version) drops that item
 * only — forward compatible without storing data we cannot render.
 *
 * @param raw - parsed JSON of unknown shape.
 * @returns the board at v2, or `undefined` when the file is unusable or written
 *   by a version this module does not know (0, 3, missing — ignored whole, so a
 *   downgrade can never rewrite a newer file with older semantics).
 */
export function migrateBoardFile(raw: unknown): BoardFile | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Partial<BoardFile>
  if (record.version !== BOARD_VERSION_V1 && record.version !== BOARD_VERSION) return undefined
  if (typeof record.id !== 'string' || typeof record.name !== 'string') return undefined
  if (!Array.isArray(record.items)) return undefined
  const items = record.version === BOARD_VERSION_V1
    // v1 had one node type; every surviving entry becomes an image node.
    ? record.items.filter(isBoardItem).map(toImageItem)
    // v2 is already discriminated by kind; keep the valid entries verbatim so a
    // second pass is a no-op (idempotency is what lets the lazy write happen
    // at any later moment without a second shape change).
    : record.items.filter(isBoardItemV2)
  return {
    version: BOARD_VERSION,
    id: record.id,
    name: record.name,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date(0).toISOString(),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : null,
    camera: isCamera(record.camera) ? record.camera : null,
    items,
  }
}

/** v1 item → v2 image node: the one field v1 did not have, everything else kept. */
function toImageItem(item: BoardItem): BoardItem {
  return { ...item, kind: 'image' }
}

/** Parse one board file, returning `undefined` for anything malformed. */
async function readBoardFile(outputDir: string, id: string): Promise<BoardFile | undefined> {
  let raw: string
  try {
    raw = await readFile(boardFile(outputDir, id), 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  // Read-only on purpose: a v1 board is upgraded in memory and only saved by the
  // next write. See migrateBoardFile.
  return migrateBoardFile(parsed)
}

function isCamera(value: unknown): value is { x: number; y: number; zoom: number } {
  if (typeof value !== 'object' || value === null) return false
  const camera = value as Record<string, unknown>
  return ['x', 'y', 'zoom'].every((key) => typeof camera[key] === 'number' && Number.isFinite(camera[key] as number))
}

/**
 * v1 item validation: loose, and only about the fields the store itself needs.
 *
 * Kept verbatim as the v1 rule (id + two path strings): the migration must
 * accept exactly what the previous release accepted, or an upgrade would
 * silently drop entries the user could still see yesterday.
 */
function isBoardItem(value: unknown): value is BoardItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && typeof item.path === 'string' && typeof item.markdownPath === 'string'
}

/**
 * v2 item validation: branch on `kind`.
 *
 * Every kind needs an `id` (it is the node's identity and the layout-save key).
 * `path`/`markdownPath` are required for images only — a task node has no file
 * (the run failed) and a layout node has a draft instead — so the old
 * "three strings" rule would reject both. An absent `kind` counts as `image`,
 * which keeps a hand-edited or tool-written v2 file readable.
 */
function isBoardItemV2(value: unknown): value is BoardItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  if (typeof item.id !== 'string') return false
  const kind = item.kind ?? 'image'
  if (kind === 'image') return typeof item.path === 'string' && typeof item.markdownPath === 'string'
  if (kind === 'task') return isTaskItem(item)
  if (kind === 'layout') return isLayoutItem(item)
  // Unknown kind: a node type from a future version. Drop the entry, keep the board.
  return false
}

/** A task node is storable only once terminal, with the request it came from. */
function isTaskItem(item: Record<string, unknown>): boolean {
  const task = item.task
  if (typeof task !== 'object' || task === null) return false
  const record = task as Record<string, unknown>
  if (record.status !== 'failed' && record.status !== 'interrupted') return false
  return typeof record.params === 'object' && record.params !== null
}

/** A layout node is its draft: without one there is nothing to show or edit. */
function isLayoutItem(item: Record<string, unknown>): boolean {
  const draft = item.draft
  if (typeof draft !== 'object' || draft === null) return false
  const record = draft as Record<string, unknown>
  if (!Number.isFinite(record.width) || !Number.isFinite(record.height)) return false
  return Array.isArray(record.items)
}

/** Summary projection, so a list request never carries every prompt. */
function summarize(board: BoardFile): BoardSummary {
  // C14: task/layout entries carry no file. The cover is the newest **picture**
  // (the last one in write order), not simply the last entry — a stored failure
  // must not blank the board thumbnail.
  const newest = [...board.items].reverse().find((item) => (
    (item.kind ?? 'image') === 'image'
    && typeof item.markdownPath === 'string'
    && item.markdownPath.length > 0
  ))
  return {
    id: board.id,
    name: board.name,
    itemCount: board.items.length,
    cover: newest === undefined ? null : newest.markdownPath,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    sessionId: board.sessionId,
  }
}

/** Detail projection for one board. */
function detail(board: BoardFile): BoardDetail {
  return { ...summarize(board), items: board.items, camera: board.camera }
}

/**
 * Every board under `outputDir`, newest first.
 *
 * Unreadable or version-mismatched files are skipped silently: a board written
 * by a future version must not make the whole library unopenable.
 *
 * @param outputDir - the configured output directory.
 * @returns summaries, newest `updatedAt` first.
 */
export async function listBoards(outputDir: string): Promise<BoardSummary[]> {
  let names: string[]
  try {
    names = await readdir(boardsDir(outputDir))
  } catch {
    return []
  }
  const files = names.filter((name) => name.endsWith('.json'))
  const boards = await Promise.all(files.map((name) => readBoardFile(outputDir, name.slice(0, -'.json'.length))))
  return boards
    .filter((board): board is BoardFile => board !== undefined)
    .map(summarize)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_BOARDS)
}

/**
 * One board in full.
 *
 * @param outputDir - the configured output directory.
 * @param id - board id.
 * @returns the board, or `undefined` when it is gone or unreadable.
 */
export async function readBoard(outputDir: string, id: string): Promise<BoardDetail | undefined> {
  const board = await readBoardFile(outputDir, id)
  return board === undefined ? undefined : detail(board)
}

/** The board the panel last had open, or `null` when none was recorded. */
export async function activeBoardId(outputDir: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(stateFile(outputDir), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const active = (parsed as Record<string, unknown>).active
    return typeof active === 'string' && active.length > 0 ? active : null
  } catch {
    return null
  }
}

/**
 * Remember which board the panel has open.
 *
 * Best-effort: a read-only output directory must not stop the workbench from
 * rendering, so a failed write is swallowed and reported as `false`.
 *
 * @param outputDir - the configured output directory.
 * @param id - board id, or `null` to clear.
 * @returns whether the state file was written.
 */
export async function setActiveBoard(outputDir: string, id: string | null): Promise<boolean> {
  return serialized(boardsRoot(outputDir), async () => {
    try {
      await mkdir(boardsRoot(outputDir), { recursive: true })
      await writeAtomic(stateFile(outputDir), JSON.stringify({ active: id }))
      return true
    } catch {
      return false
    }
  })
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Write through a staging file so a crash never leaves half a JSON document. */
async function writeAtomic(target: string, body: string): Promise<void> {
  const staging = `${target}.partial-${String(process.pid)}-${randomUUID().slice(0, 4)}`
  await writeFile(staging, body, 'utf8')
  try {
    await rename(staging, target)
  } catch (error) {
    await unlink(staging).catch(() => undefined)
    throw error
  }
}

async function saveBoard(outputDir: string, board: BoardFile): Promise<void> {
  await mkdir(boardsDir(outputDir), { recursive: true })
  await writeAtomic(boardFile(outputDir, board.id), JSON.stringify(board))
}

/**
 * Find a board by id or name, creating it when neither matches.
 *
 * Resolution order matters for the conversation path: a model that was handed
 * an id sends the id back; a model that was handed a name sends the name. An
 * unknown value is treated as a **name for a new board** rather than an error,
 * because refusing here would fail a generation the user already paid for.
 *
 * @param outputDir - the configured output directory.
 * @param ref - board id or name; blank means "create one".
 * @param meta - fields for a board that has to be created.
 * @returns the board summary, whether it was created, and its full file.
 */
async function ensureBoardLocked(
  outputDir: string,
  ref: string | undefined,
  meta: { name?: string; prompt?: string; sessionId?: string | null },
): Promise<{ board: BoardFile; created: boolean }> {
  const wanted = typeof ref === 'string' ? ref.trim() : ''
  const existing = await listBoardFiles(outputDir)

  if (wanted.length > 0) {
    const byId = existing.find((board) => board.id === wanted)
    if (byId !== undefined) return { board: byId, created: false }
    const lower = wanted.toLowerCase()
    const byName = existing.find((board) => board.name.toLowerCase() === lower)
    if (byName !== undefined) return { board: byName, created: false }
  }

  if (existing.length >= MAX_BOARDS) {
    // Over the cap, reuse the oldest board instead of refusing to record the
    // images: an unrecorded draw is worse than a shared board.
    const oldest = [...existing].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))[0]
    return { board: oldest, created: false }
  }

  const now = new Date()
  const name = sanitizeBoardName(meta.name)
    ?? sanitizeBoardName(wanted)
    ?? (typeof meta.prompt === 'string' && meta.prompt.trim().length > 0 ? nameFromPrompt(meta.prompt, now) : defaultBoardName(now))
  const id = newBoardId((candidate) => existing.some((board) => board.id === candidate))
  const board: BoardFile = {
    version: BOARD_VERSION,
    id,
    name,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    sessionId: meta.sessionId ?? null,
    camera: null,
    items: [],
  }
  await saveBoard(outputDir, board)
  return { board, created: true }
}

/** Every board file, for id/name matching inside a locked section. */
async function listBoardFiles(outputDir: string): Promise<BoardFile[]> {
  let names: string[]
  try {
    names = await readdir(boardsDir(outputDir))
  } catch {
    return []
  }
  const boards = await Promise.all(
    names.filter((name) => name.endsWith('.json'))
      .map((name) => readBoardFile(outputDir, name.slice(0, -'.json'.length))),
  )
  return boards.filter((board): board is BoardFile => board !== undefined)
}

/**
 * Record one run's images on a board, creating the board when needed.
 *
 * The dedupe key is the **absolute path**, which is unique by construction
 * (`<prefix>_<W>x<H>_<n>.png` with a free index): re-recording the same run
 * updates its metadata instead of growing a second copy, which is what makes
 * the write idempotent for a retried tool call.
 *
 * @param outputDir - the configured output directory.
 * @param ref - board id, board name, or blank to create a new board.
 * @param items - images to record, in output order.
 * @param meta - name/session hints used only when a board is created.
 * @returns the board summary plus the recorded items.
 */
export async function recordItems(
  outputDir: string,
  ref: string | undefined,
  items: readonly NewBoardItem[],
  meta: { name?: string; prompt?: string; sessionId?: string | null } = {},
): Promise<BoardWrite> {
  return serialized(boardsRoot(outputDir), async () => {
    const { board, created } = await ensureBoardLocked(outputDir, ref, meta)
    const written: BoardItem[] = []
    const now = new Date().toISOString()
    const batchId = items[0]?.batchId ?? `g${Date.now().toString(36)}`

    for (const incoming of items) {
      const existingIndex = board.items.findIndex((item) => item.path === incoming.path)
      const next: BoardItem = {
        id: existingIndex >= 0 ? board.items[existingIndex].id : (incoming.id ?? makeItemId()),
        // Recorded images are image nodes by definition; spelling `kind` out (rather
        // than relying on the absent-means-image default) keeps a v2 file
        // self-describing for anything that reads it without this module.
        kind: 'image',
        path: incoming.path,
        markdownPath: incoming.markdownPath,
        width: incoming.width,
        height: incoming.height,
        bytes: incoming.bytes,
        mediaType: incoming.mediaType,
        prompt: incoming.prompt,
        ratio: incoming.ratio ?? null,
        steps: incoming.steps ?? null,
        seed: incoming.seed ?? null,
        mode: incoming.mode ?? 'generate',
        backend: incoming.backend ?? null,
        parents: resolveParents(board.items, incoming),
        createdAt: existingIndex >= 0 ? board.items[existingIndex].createdAt : now,
        sessionId: incoming.sessionId ?? board.sessionId,
        batchId: incoming.batchId ?? batchId,
        x: incoming.x ?? (existingIndex >= 0 ? board.items[existingIndex].x : gridSpot(board.items.length).x),
        y: incoming.y ?? (existingIndex >= 0 ? board.items[existingIndex].y : gridSpot(board.items.length).y),
      }
      if (existingIndex >= 0) board.items[existingIndex] = next
      else board.items.push(next)
      written.push(next)
    }

    // Cap by dropping the oldest *arrangement entries*, never the files: the
    // image is still on disk and reachable from the asset page's path copy.
    if (board.items.length > MAX_BOARD_ITEMS) {
      board.items = board.items.slice(board.items.length - MAX_BOARD_ITEMS)
    }
    board.updatedAt = now
    if (meta.sessionId !== undefined && board.sessionId === null) board.sessionId = meta.sessionId
    await saveBoard(outputDir, board)
    return { board: summarize(board), created, items: written }
  })
}

/** Grid slot for the nth unplaced item. */
function gridSpot(index: number): { x: number; y: number } {
  return {
    x: GRID_ORIGIN + (index % GRID_COLUMNS) * GRID_PITCH_X,
    y: GRID_ORIGIN + Math.floor(index / GRID_COLUMNS) * GRID_PITCH_Y,
  }
}

/**
 * Case- and separator-insensitive path key.
 *
 * Windows reports one file as both `C:\\x\\a.png` and `C:/x/a.png`, and the
 * shared-file guard must treat a copied item's `path` as the same file as its
 * source's. Parent resolution already applied the same rule.
 */
function pathKey(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase()
}

/**
 * Resolve `parentPaths` into item ids of **this board**.
 *
 * Matching is separator- and case-insensitive (Windows reports the same file
 * with either), so the caller can pass the reference path exactly as it was
 * handed to the tool. Explicit `parents` ids win when given; paths that match
 * nothing are dropped without ceremony — see {@link NewBoardItem.parentPaths}.
 */
function resolveParents(existing: readonly BoardItem[], incoming: NewBoardItem): string[] {
  if (incoming.parents !== undefined) return [...incoming.parents]
  const paths = incoming.parentPaths ?? []
  if (paths.length === 0) return []
  const byPath = new Map(existing.map((item) => [pathKey(item.path), item.id]))
  const ids: string[] = []
  for (const path of paths) {
    const id = byPath.get(pathKey(path))
    if (id !== undefined && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * Persist where the user dragged the nodes, and the camera.
 *
 * Unknown ids are ignored: a node can be removed in another tab between the
 * drag and the save, and that must not fail the whole write.
 *
 * @param outputDir - the configured output directory.
 * @param id - board id.
 * @param layout - positions keyed by item id, plus the optional camera.
 * @returns the updated summary, or `undefined` when the board is gone.
 */
export async function saveLayout(
  outputDir: string,
  id: string,
  layout: { items?: readonly { id: string; x: number; y: number }[]; camera?: { x: number; y: number; zoom: number } | null },
): Promise<BoardSummary | undefined> {
  return serialized(boardsRoot(outputDir), async () => {
    const board = await readBoardFile(outputDir, id)
    if (board === undefined) return undefined
    const positions = new Map((layout.items ?? []).map((entry) => [entry.id, entry]))
    for (const item of board.items) {
      const spot = positions.get(item.id)
      if (spot === undefined) continue
      if (!Number.isFinite(spot.x) || !Number.isFinite(spot.y)) continue
      item.x = spot.x
      item.y = spot.y
    }
    if (layout.camera !== undefined) board.camera = isCamera(layout.camera) ? layout.camera : null
    board.updatedAt = new Date().toISOString()
    await saveBoard(outputDir, board)
    return summarize(board)
  })
}

/** Where an item landed after a board write. */
export interface BoardTransfer {
  /** The item as it now lives on the destination board. */
  item: BoardItem
  /** Destination board summary. */
  board: BoardSummary
}

/** A fresh id that no item on `board` uses. */
function unusedItemId(board: BoardFile): string {
  const taken = new Set(board.items.map((item) => item.id))
  let id = makeItemId()
  while (taken.has(id)) id = makeItemId()
  return id
}

/** Cap a destination board the way `recordItems` does, dropping the oldest. */
function capItems(board: BoardFile): void {
  if (board.items.length > MAX_BOARD_ITEMS) board.items = board.items.slice(board.items.length - MAX_BOARD_ITEMS)
}

/**
 * Copy one item onto another board (§7.2).
 *
 * The copy gets a **new id** (ids are board-scoped) but keeps the file path,
 * metadata and `parents` verbatim: the lineage travels with the picture, and a
 * parent id that does not resolve on the destination is simply not drawn — the
 * same "a missing edge never fails the write" rule `resolveParents` uses. The
 * PNG is **not** copied, so both boards now share one file; that is exactly why
 * {@link removeItem}'s `deleteFile` grew the shared-reference guard.
 *
 * @param outputDir - the configured output directory.
 * @param id - source board id.
 * @param itemId - item to copy.
 * @param toBoard - destination board id.
 * @param spot - landing position; omitted means the destination grid.
 * @returns the copied item and the destination summary, or `undefined` when a
 *   board or the item does not exist.
 */
export async function copyItem(
  outputDir: string,
  id: string,
  itemId: string,
  toBoard: string,
  spot?: { x: number; y: number },
): Promise<BoardTransfer | undefined> {
  return serialized(boardsRoot(outputDir), async () => {
    const source = await readBoardFile(outputDir, id)
    if (source === undefined) return undefined
    const original = source.items.find((item) => item.id === itemId)
    if (original === undefined) return undefined
    if (id === toBoard) {
      // Same-board copy: a duplicate next to the original is still useful
      // (branch the same picture twice); the write is one board.
      const clone: BoardItem = {
        ...original,
        id: unusedItemId(source),
        x: spot?.x ?? gridSpot(source.items.length).x,
        y: spot?.y ?? gridSpot(source.items.length).y,
      }
      source.items.push(clone)
      capItems(source)
      source.updatedAt = new Date().toISOString()
      await saveBoard(outputDir, source)
      return { item: clone, board: summarize(source) }
    }
    const target = await readBoardFile(outputDir, toBoard)
    if (target === undefined) return undefined
    const clone: BoardItem = {
      ...original,
      id: unusedItemId(target),
      x: spot?.x ?? gridSpot(target.items.length).x,
      y: spot?.y ?? gridSpot(target.items.length).y,
    }
    target.items.push(clone)
    capItems(target)
    target.updatedAt = new Date().toISOString()
    await saveBoard(outputDir, target)
    return { item: clone, board: summarize(target) }
  })
}

/**
 * Move one item onto another board (§7.2), keeping its id.
 *
 * Cross-board writes cannot be atomic on two JSON files, so the order is
 * chosen for the failure mode: **destination first, source second**. A crash
 * between the two leaves the item on both boards (a copy), never on neither;
 * that is the documented downgrade from §7.2's stop condition.
 *
 * @param outputDir - the configured output directory.
 * @param id - source board id.
 * @param itemId - item to move.
 * @param toBoard - destination board id.
 * @param spot - landing position; omitted means the destination grid.
 * @returns the moved item and the destination summary, or `undefined`.
 */
export async function moveItem(
  outputDir: string,
  id: string,
  itemId: string,
  toBoard: string,
  spot?: { x: number; y: number },
): Promise<BoardTransfer | undefined> {
  return serialized(boardsRoot(outputDir), async () => {
    const source = await readBoardFile(outputDir, id)
    if (source === undefined) return undefined
    const index = source.items.findIndex((item) => item.id === itemId)
    if (index < 0) return undefined
    if (id === toBoard) {
      // Within one board "move" is a reposition; nothing else changes.
      const only = source.items[index]
      if (spot !== undefined) {
        only.x = spot.x
        only.y = spot.y
      }
      source.updatedAt = new Date().toISOString()
      await saveBoard(outputDir, source)
      return { item: only, board: summarize(source) }
    }
    const target = await readBoardFile(outputDir, toBoard)
    if (target === undefined) return undefined
    const [moving] = source.items.splice(index, 1)
    // Ids are unique per board, not globally: keep the original id, but mint a
    // new one if a stale duplicate somehow occupies it on the destination.
    const collision = target.items.some((item) => item.id === moving.id)
    const item: BoardItem = {
      ...moving,
      ...(collision ? { id: unusedItemId(target) } : {}),
      x: spot?.x ?? gridSpot(target.items.length).x,
      y: spot?.y ?? gridSpot(target.items.length).y,
    }
    target.items.push(item)
    capItems(target)
    target.updatedAt = new Date().toISOString()
    await saveBoard(outputDir, target)
    source.updatedAt = new Date().toISOString()
    await saveBoard(outputDir, source)
    return { item, board: summarize(target) }
  })
}

/** One terminal task node on its way onto a board (§4.6). */
export interface TaskItemWrite {
  /** Existing board item to update; absent mints a new id. */
  readonly id?: string
  readonly x?: number | null
  readonly y?: number | null
  /** Canvas parents, as board item ids; explicit ids win, perishable ones drop on render. */
  readonly parents?: readonly string[]
  /** Terminal state plus the request snapshot a retry needs. */
  readonly task: BoardTaskInfo
  readonly sessionId?: string | null
}

/** One layout node on its way onto a board (§8.1). */
export interface LayoutItemWrite {
  readonly id?: string
  readonly x?: number | null
  readonly y?: number | null
  readonly parents?: readonly string[]
  /** The editable draft, in draft pixels; never touched by a node resize. */
  readonly draft: BoardLayoutDraft
  /** Display width/height in world units (§8.3: width-driven, height proportional). */
  readonly w: number
  readonly h: number
  readonly sessionId?: string | null
}

/** Refuse anything the read side would drop anyway, with a message the panel can show. */
function assertTerminalTask(task: BoardTaskInfo): void {
  if (task.status !== 'failed' && task.status !== 'interrupted') {
    throw new Error('task.status 只能是 failed 或 interrupted——运行中的任务不落盘（DD6）')
  }
  if (typeof task.params !== 'object' || task.params === null || typeof task.params.prompt !== 'string') {
    throw new Error('task.params 必须是带 prompt 的请求快照')
  }
  if (task.error !== undefined && typeof task.error !== 'string') throw new Error('task.error 必须是字符串')
}

/** Mirror the read side's layout check so a stored draft is always reopenable. */
function assertLayoutDraft(draft: BoardLayoutDraft, w: number, h: number): void {
  if (typeof draft !== 'object' || draft === null) throw new Error('draft 必须是对象')
  if (!Number.isFinite(draft.width) || draft.width <= 0 || !Number.isFinite(draft.height) || draft.height <= 0) {
    throw new Error('draft.width / draft.height 必须是正数')
  }
  if (!Array.isArray(draft.items)) throw new Error('draft.items 必须是数组')
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) throw new Error('w / h 必须是正数')
}

/**
 * Store one terminal task node (§4.6, C14).
 *
 * Running tasks are deliberately not storable: a reload must never show a node
 * that claims to be generating a run whose result has already been recorded.
 * Only a failure/interrupt is bookkeeping with value — the user can see why
 * yesterday's run failed and retry it from the same canvas position.
 *
 * @param outputDir - the configured output directory.
 * @param ref - board id/name, or blank for a new board (the canvas may not have
 *   one yet when a task fails before its first picture).
 * @param entry - the terminal state, position and request snapshot.
 * @returns the stored item and the board, or `undefined` when the board is gone.
 */
export async function saveTaskItem(
  outputDir: string,
  ref: string | undefined,
  entry: TaskItemWrite,
): Promise<BoardTransfer | undefined> {
  assertTerminalTask(entry.task)
  return serialized(boardsRoot(outputDir), async () => {
    const { board } = await ensureBoardLocked(outputDir, ref, {})
    const now = new Date().toISOString()
    const index = entry.id === undefined ? -1 : board.items.findIndex((item) => item.id === entry.id)
    const existing = index < 0 ? undefined : board.items[index]
    const spot = gridSpot(board.items.length)
    // The canvas already keys its node — and any edge to it — by the id it sent.
    // Honour a free one so the first save does not rename the node; a taken id
    // falls back to a fresh one and the caller adopts the answer.
    const requestedId = typeof entry.id === 'string' && entry.id.length > 0 && !board.items.some((item) => item.id === entry.id)
      ? entry.id
      : undefined
    const item: BoardItem = {
      id: existing?.id ?? requestedId ?? makeItemId(),
      kind: 'task',
      // A task node has no file; the three picture strings stay empty and the
      // read side's kind check ignores them.
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
      parents: [...(entry.parents ?? existing?.parents ?? [])],
      createdAt: existing?.createdAt ?? now,
      sessionId: entry.sessionId ?? board.sessionId,
      batchId: existing?.batchId ?? 't' + Date.now().toString(36),
      x: entry.x ?? existing?.x ?? spot.x,
      y: entry.y ?? existing?.y ?? spot.y,
      task: entry.task,
    }
    if (index >= 0) board.items[index] = item
    else board.items.push(item)
    capItems(board)
    board.updatedAt = now
    await saveBoard(outputDir, board)
    return { item, board: summarize(board) }
  })
}

/**
 * Store one layout node's draft and display box (§8.1, C14).
 *
 * The draft is stored verbatim (pixels are independent of the display size —
 * that is the §8.2 invariant), so resizing a node and reopening the board never
 * changes what a later generation would compile.
 *
 * @param outputDir - the configured output directory.
 * @param ref - board id/name, or blank for a new board.
 * @param entry - draft, display size, position and parents.
 * @returns the stored item and the board, or `undefined` when the board is gone.
 */
export async function saveLayoutItem(
  outputDir: string,
  ref: string | undefined,
  entry: LayoutItemWrite,
): Promise<BoardTransfer | undefined> {
  assertLayoutDraft(entry.draft, entry.w, entry.h)
  return serialized(boardsRoot(outputDir), async () => {
    const { board } = await ensureBoardLocked(outputDir, ref, {})
    const now = new Date().toISOString()
    const index = entry.id === undefined ? -1 : board.items.findIndex((item) => item.id === entry.id)
    const existing = index < 0 ? undefined : board.items[index]
    const spot = gridSpot(board.items.length)
    const requestedId = typeof entry.id === 'string' && entry.id.length > 0 && !board.items.some((item) => item.id === entry.id)
      ? entry.id
      : undefined
    const item: BoardItem = {
      id: existing?.id ?? requestedId ?? makeItemId(),
      kind: 'layout',
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
      parents: [...(entry.parents ?? existing?.parents ?? [])],
      createdAt: existing?.createdAt ?? now,
      sessionId: entry.sessionId ?? board.sessionId,
      batchId: existing?.batchId ?? 'l' + Date.now().toString(36),
      x: entry.x ?? existing?.x ?? spot.x,
      y: entry.y ?? existing?.y ?? spot.y,
      draft: entry.draft,
      w: entry.w,
      h: entry.h,
    }
    if (index >= 0) board.items[index] = item
    else board.items.push(item)
    capItems(board)
    board.updatedAt = now
    await saveBoard(outputDir, board)
    return { item, board: summarize(board) }
  })
}

/** True when `target` is the root itself or lives under it. */
function isInside(root: string, target: string): boolean {
  if (!isAbsolute(target)) return false
  const rel = relative(resolve(root), resolve(target))
  if (rel.length === 0) return true
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Drop one item from a board's arrangement.
 *
 * Deleting the file is opt-in and doubly guarded: the path must be inside
 * `outputDir` (so a crafted board file cannot delete anything else) and the
 * caller must have asked. The default is "remove from the board", which is the
 * reversible action and the one the canvas button offers.
 *
 * @param outputDir - the configured output directory.
 * @param id - board id.
 * @param itemId - item to drop.
 * @param options - `deleteFile` also removes the PNG from disk, but only when
 *   no other board still points at the same file (see below).
 * @returns what happened, or `undefined` when the board or item is gone. When
 *   `deleteFile` was asked but the file is shared, `fileDeleted` is false and
 *   `sharedWith` names the boards that still use it.
 */
export async function removeItem(
  outputDir: string,
  id: string,
  itemId: string,
  options: { deleteFile?: boolean } = {},
): Promise<{ removed: BoardItem; fileDeleted: boolean; sharedWith: string[] } | undefined> {
  return serialized(boardsRoot(outputDir), async () => {
    const board = await readBoardFile(outputDir, id)
    if (board === undefined) return undefined
    const index = board.items.findIndex((item) => item.id === itemId)
    if (index < 0) return undefined
    const [removed] = board.items.splice(index, 1)
    board.updatedAt = new Date().toISOString()
    await saveBoard(outputDir, board)
    let fileDeleted = false
    const sharedWith: string[] = []
    // Task/layout entries have no file to delete; only a picture can opt in.
    if (
      options.deleteFile === true
      && typeof removed.path === 'string'
      && removed.path.length > 0
      && isInside(outputDir, removed.path)
    ) {
      // copy-item makes two boards share one PNG (§7.2). Unlinking it here would
      // blank the picture on every other board, so the shared case only
      // unplaces: refusal must never be silent, hence the board list in the
      // answer.
      const key = pathKey(removed.path)
      for (const other of await listBoardFiles(outputDir)) {
        if (other.id === board.id) continue
        if (other.items.some((entry) => pathKey(entry.path) === key)) sharedWith.push(other.id)
      }
      if (sharedWith.length === 0) {
        try {
          await unlink(removed.path)
          fileDeleted = true
        } catch {
          fileDeleted = false
        }
      }
    }
    return { removed, fileDeleted, sharedWith }
  })
}

/**
 * Delete a board's metadata. The images stay on disk.
 *
 * @param outputDir - the configured output directory.
 * @param id - board id.
 * @returns whether a board file was removed.
 */
export async function deleteBoard(outputDir: string, id: string): Promise<boolean> {
  return serialized(boardsRoot(outputDir), async () => {
    try {
      await unlink(boardFile(outputDir, id))
      return true
    } catch {
      return false
    }
  })
}

/**
 * Create an empty board.
 *
 * @param outputDir - the configured output directory.
 * @param name - the name to use; blank means the date-stamped fallback.
 * @returns the new board's summary.
 */
export async function createBoard(outputDir: string, name?: string): Promise<BoardSummary> {
  return serialized(boardsRoot(outputDir), async () => {
    const { board } = await ensureBoardLocked(outputDir, undefined, { name })
    return summarize(board)
  })
}

/**
 * Rename a board.
 *
 * @param outputDir - the configured output directory.
 * @param id - board id.
 * @param name - the new name; a blank one leaves the board untouched.
 * @returns the updated summary, or `undefined` when the board is gone.
 */
export async function renameBoard(outputDir: string, id: string, name: string): Promise<BoardSummary | undefined> {
  const clean = sanitizeBoardName(name)
  if (clean === undefined) return undefined
  return serialized(boardsRoot(outputDir), async () => {
    const board = await readBoardFile(outputDir, id)
    if (board === undefined) return undefined
    board.name = clean
    board.updatedAt = new Date().toISOString()
    await saveBoard(outputDir, board)
    return summarize(board)
  })
}

/**
 * Flatten every board into one asset list, newest first.
 *
 * The asset page asks one question — "where is that image I made" — and that
 * question spans boards, so filtering happens here rather than in the panel
 * making N requests.
 *
 * @param outputDir - the configured output directory.
 * @param query - optional board filter, free text and limit.
 * @returns matching assets, the board list, and the pre-limit total.
 */
export async function listAssets(outputDir: string, query: AssetQuery = {}): Promise<AssetPage> {
  const boards = await listBoardFiles(outputDir)
  const summaries = boards.map(summarize).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const boardFilter = typeof query.board === 'string' && query.board.trim().length > 0 ? query.board.trim() : undefined
  const needle = typeof query.q === 'string' ? query.q.trim().toLowerCase() : ''
  const limit = Number.isFinite(query.limit) ? Math.min(500, Math.max(1, Math.trunc(query.limit as number))) : 200

  const assets: StudioAsset[] = []
  for (const board of boards) {
    if (boardFilter !== undefined && board.id !== boardFilter) continue
    for (const item of board.items) {
      // The asset page lists pictures: a task/layout node has no file to show
      // and would otherwise appear as an empty card.
      if ((item.kind ?? 'image') !== 'image') continue
      if (needle.length > 0) {
        const haystack = `${item.prompt}\n${item.path}\n${board.name}`.toLowerCase()
        if (!haystack.includes(needle)) continue
      }
      assets.push({ ...item, boardId: board.id, boardName: board.name })
    }
  }
  assets.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  return { assets: assets.slice(0, limit), boards: summaries, total: assets.length }
}
