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
import type { BoardDetail, BoardItem, BoardSummary, StudioAsset } from './studio-shared.ts'

/** Directory name under `outputDir` that holds every board artifact. */
export const BOARDS_DIR_NAME = '.dsh-image-forge'

/** Longest board name kept, in characters. */
export const BOARD_NAME_CHARS = 40

/** Most boards one output directory may hold. */
export const MAX_BOARDS = 200

/** Most items one board may hold. */
export const MAX_BOARD_ITEMS = 1000

/** Shape version of one board file; a mismatched file is ignored, not migrated. */
const BOARD_VERSION = 1

/** Columns, pitch and origin of the grid an unplaced item lands on. */
const GRID_COLUMNS = 3
const GRID_PITCH_X = 244
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
  return join(boardsDir(outputDir), `${id}.json`)
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
 */
const queues = new Map<string, Promise<unknown>>()

function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
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
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Partial<BoardFile>
  if (record.version !== BOARD_VERSION) return undefined
  if (typeof record.id !== 'string' || typeof record.name !== 'string') return undefined
  if (!Array.isArray(record.items)) return undefined
  return {
    version: BOARD_VERSION,
    id: record.id,
    name: record.name,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date(0).toISOString(),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : null,
    camera: isCamera(record.camera) ? record.camera : null,
    items: record.items.filter(isBoardItem),
  }
}

function isCamera(value: unknown): value is { x: number; y: number; zoom: number } {
  if (typeof value !== 'object' || value === null) return false
  const camera = value as Record<string, unknown>
  return ['x', 'y', 'zoom'].every((key) => typeof camera[key] === 'number' && Number.isFinite(camera[key] as number))
}

/** Loose validation on read: one bad item must not hide the rest of the board. */
function isBoardItem(value: unknown): value is BoardItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && typeof item.path === 'string' && typeof item.markdownPath === 'string'
}

/** Summary projection, so a list request never carries every prompt. */
function summarize(board: BoardFile): BoardSummary {
  const newest = board.items[board.items.length - 1]
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
        parents: [...(incoming.parents ?? [])],
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
 * @param options - `deleteFile` also removes the PNG from disk.
 * @returns what happened, or `undefined` when the board or item is gone.
 */
export async function removeItem(
  outputDir: string,
  id: string,
  itemId: string,
  options: { deleteFile?: boolean } = {},
): Promise<{ removed: BoardItem; fileDeleted: boolean } | undefined> {
  return serialized(boardsRoot(outputDir), async () => {
    const board = await readBoardFile(outputDir, id)
    if (board === undefined) return undefined
    const index = board.items.findIndex((item) => item.id === itemId)
    if (index < 0) return undefined
    const [removed] = board.items.splice(index, 1)
    board.updatedAt = new Date().toISOString()
    await saveBoard(outputDir, board)
    let fileDeleted = false
    if (options.deleteFile === true && isInside(outputDir, removed.path)) {
      try {
        await unlink(removed.path)
        fileDeleted = true
      } catch {
        fileDeleted = false
      }
    }
    return { removed, fileDeleted }
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
