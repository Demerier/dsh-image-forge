/**
 * The Studio's three same-origin HTTP routes.
 *
 * The panel is a browser surface, so everything it needs crosses a socket: the
 * capability snapshot (GET), one generation (POST), and one prompt rewrite
 * (POST). Each route owns its full response lifecycle, must be safe against a
 * hostile page, and must never let a credential-shaped string reach the client
 * — which is why nothing here echoes a request body back.
 *
 * ## Guard rails, all load-bearing
 *
 * - **Same-origin only.** `origin` is checked against `host` on every request
 *   (absent `origin` is allowed: that is a same-origin navigation, not a
 *   cross-site form post). Without this, any page the user visits could drive
 *   their local ComfyUI through this plugin.
 * - **Bounded bodies.** A reference image arrives base64-inflated; the cap is
 *   enforced while reading, not after, so a 2 GiB body is refused at byte 48 MiB
 *   instead of being buffered first.
 * - **JSON only, POST only** for the two mutating routes: an HTML form cannot
 *   set `content-type: application/json` cross-origin without a preflight.
 * - **Heartbeat.** ComfyUI runs for minutes. Reverse proxies reset their read
 *   timeout on every upstream byte, so a newline every 15 s keeps the connection
 *   alive while the JSON body is still being computed.
 *
 * @module studio-routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, type Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve as resolvePath } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Context } from '@deepseek-ai/cordis'
import {
  STUDIO_ASSETS_ROUTE,
  STUDIO_BOARDS_ROUTE,
  STUDIO_BOARD_ROUTE,
  STUDIO_CONFIG_ROUTE,
  STUDIO_FILE_ROUTE,
  STUDIO_FILE_TYPES,
  STUDIO_GENERATE_ROUTE,
  STUDIO_MAX_BODY_BYTES,
  STUDIO_MAX_PROMPT_CHARS,
  STUDIO_OPTIMIZE_ROUTE,
  STUDIO_RATIOS,
  type StudioBoardRequest,
  type StudioGenerateRequest,
  type StudioOptimizeRequest,
  type StudioOptimizeTurn,
  type StudioReferencePayload,
  firstLine,
} from './studio-shared.ts'
import {
  activeBoardId,
  createBoard,
  deleteBoard,
  listAssets,
  listBoards,
  readBoard,
  removeItem,
  renameBoard,
  saveLayout,
  setActiveBoard,
} from './boards.ts'
import {
  describeStudio,
  runStudioGeneration,
  type StudioSettings,
} from './studio-service.ts'
import { optimizeStudioPrompt } from './studio-prompt.ts'

/** Heartbeat cadence while a long request is in flight; tests shrink it. */
const HEARTBEAT_MS = 15_000

/** Everything the routes need from the host. */
export interface StudioRouteDeps {
  /** Read the current plugin config, so a settings save is picked up live. */
  settings(): StudioSettings
  /** Host context, for the `llm` lookup the optimiser needs. */
  ctx: Context
}

/** Wrap one handler so a thrown error becomes a JSON 500 instead of a dead socket. */
function guard(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      if (res.headersSent || res.writableEnded || res.destroyed) return
      json(res, 500, { error: firstLine(error) })
    }
  }
}

/** Register all three Studio routes on the host web server. */
export function registerStudioRoutes(
  ctx: Context,
  deps: StudioRouteDeps,
): Array<() => void> {
  const server = (ctx as unknown as { webServer?: { register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void } }).webServer
  if (server === undefined || typeof server.register !== 'function') return []

  return [
    server.register({
      kind: 'exact',
      path: STUDIO_CONFIG_ROUTE,
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') return jsonError(res, 405, 'method-not-allowed')
        if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')
        const controller = new AbortController()
        res.once('close', () => { if (!res.writableEnded) controller.abort() })
        const snapshot = await describeStudio(deps.ctx, deps.settings(), controller.signal)
        json(res, 200, snapshot)
      }),
    }),

    server.register({
      kind: 'exact',
      path: STUDIO_GENERATE_ROUTE,
      handler: guard(async (req, res) => {
        if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')
        if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
        if (!isJson(req)) return jsonError(res, 415, 'json-required')

        const controller = new AbortController()
        res.once('close', () => { if (!res.writableEnded) controller.abort(new Error('浏览器关闭了请求')) })

        let input: StudioGenerateRequest
        try {
          input = parseGenerate(JSON.parse(await readBody(req, STUDIO_MAX_BODY_BYTES)))
        } catch (error) {
          return jsonError(res, 400, firstLine(error))
        }

        // Headers first, then a heartbeat: see the module note.
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
        })
        const heartbeat = setInterval(() => {
          if (!res.destroyed && !res.writableEnded) res.write('\n')
        }, HEARTBEAT_MS)
        try {
          const output = await runStudioGeneration(deps.settings(), input, controller.signal)
          if (!res.destroyed && !res.writableEnded) res.end(JSON.stringify(output))
        } catch (error) {
          if (!res.destroyed && !res.writableEnded) res.end(JSON.stringify({ error: firstLine(error) }))
        } finally {
          clearInterval(heartbeat)
        }
      }),
    }),

    server.register({
      kind: 'exact',
      path: STUDIO_OPTIMIZE_ROUTE,
      handler: guard(async (req, res) => {
        if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')
        if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
        if (!isJson(req)) return jsonError(res, 415, 'json-required')

        const controller = new AbortController()
        res.once('close', () => { if (!res.writableEnded) controller.abort(new Error('浏览器关闭了请求')) })

        let input: StudioOptimizeRequest
        try {
          input = parseOptimize(JSON.parse(await readBody(req, 256 * 1024)))
        } catch (error) {
          return jsonError(res, 400, firstLine(error))
        }
        try {
          const output = await optimizeStudioPrompt(deps.ctx, input, controller.signal)
          json(res, 200, output)
        } catch (error) {
          jsonError(res, 502, firstLine(error))
        }
      }),
    }),

    // ---- boards ---------------------------------------------------------
    //
    // Three routes, one purpose: let the panel treat a board as the unit it
    // stores and displays. Reads are plain GETs so the panel can refetch after
    // a conversation call wrote something; the one POST is a discriminated
    // action bag rather than five near-identical routes.

    server.register({
      kind: 'exact',
      path: STUDIO_BOARDS_ROUTE,
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') return jsonError(res, 405, 'method-not-allowed')
        if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')
        const outputDir = deps.settings().outputDir
        const boards = await listBoards(outputDir)
        const remembered = await activeBoardId(outputDir)
        const active = remembered !== null && boards.some((board) => board.id === remembered)
          ? remembered
          : (boards[0]?.id ?? null)
        json(res, 200, { boards, active })
      }),
    }),

    server.register({
      kind: 'exact',
      path: STUDIO_BOARD_ROUTE,
      handler: guard(async (req, res) => {
        if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')
        const outputDir = deps.settings().outputDir
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')

        if (req.method === 'GET') {
          const id = url.searchParams.get('board') ?? ''
          if (id.length === 0) return jsonError(res, 400, '缺少 board 参数')
          const board = await readBoard(outputDir, id)
          if (board === undefined) return jsonError(res, 404, '画板不存在')
          return json(res, 200, board)
        }

        if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
        if (!isJson(req)) return jsonError(res, 415, 'json-required')

        let action: StudioBoardRequest
        try {
          action = parseBoardAction(JSON.parse(await readBody(req, 256 * 1024)))
        } catch (error) {
          return jsonError(res, 400, firstLine(error))
        }

        switch (action.action) {
          case 'create': {
            const board = await createBoard(outputDir, action.name)
            await setActiveBoard(outputDir, board.id)
            return json(res, 200, { ok: true, board })
          }
          case 'rename': {
            const id = await targetBoardId(outputDir, action.board)
            if (id === undefined) return jsonError(res, 404, '画板不存在')
            const board = await renameBoard(outputDir, id, action.name ?? '')
            if (board === undefined) return jsonError(res, 400, '请输入画板名称')
            return json(res, 200, { ok: true, board })
          }
          case 'layout': {
            const id = await targetBoardId(outputDir, action.board)
            if (id === undefined) return jsonError(res, 404, '画板不存在')
            const board = await saveLayout(outputDir, id, {
              items: action.items ?? [],
              ...(action.camera === undefined ? {} : { camera: action.camera }),
            })
            if (board === undefined) return jsonError(res, 404, '画板不存在')
            return json(res, 200, { ok: true, board })
          }
          case 'remove-item': {
            const id = await targetBoardId(outputDir, action.board)
            if (id === undefined) return jsonError(res, 404, '画板不存在')
            if (typeof action.item !== 'string' || action.item.length === 0) return jsonError(res, 400, '缺少 item 参数')
            const result = await removeItem(outputDir, id, action.item, { deleteFile: action.deleteFile === true })
            if (result === undefined) return jsonError(res, 404, '这张图不在画板里')
            return json(res, 200, { ok: true, removed: result.removed, fileDeleted: result.fileDeleted })
          }
          case 'delete': {
            const id = await targetBoardId(outputDir, action.board)
            if (id === undefined) return jsonError(res, 404, '画板不存在')
            const removed = await deleteBoard(outputDir, id)
            if (removed && (await activeBoardId(outputDir)) === id) await setActiveBoard(outputDir, null)
            return json(res, 200, { ok: removed })
          }
          case 'active': {
            const id = await targetBoardId(outputDir, action.board)
            if (id === undefined) return jsonError(res, 404, '画板不存在')
            await setActiveBoard(outputDir, id)
            return json(res, 200, { ok: true })
          }
        }
      }),
    }),

    server.register({
      kind: 'exact',
      path: STUDIO_ASSETS_ROUTE,
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') return jsonError(res, 405, 'method-not-allowed')
        if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const limit = Number(url.searchParams.get('limit') ?? '')
        const page = await listAssets(deps.settings().outputDir, {
          ...(url.searchParams.get('board') === null ? {} : { board: url.searchParams.get('board') ?? '' }),
          ...(url.searchParams.get('q') === null ? {} : { q: url.searchParams.get('q') ?? '' }),
          ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
        })
        json(res, 200, page)
      }),
    }),

    // ---- file serving ----------------------------------------------------
    //
    // A local path is not a URL: the panel and the tool cards both need the
    // host to hand them the bytes. See the note on STUDIO_FILE_ROUTE.
    //
    // Security posture: same-origin, absolute paths only, an extension
    // whitelist, and the stream is bounded by what `stat` reported. The route
    // reads *any* directory the query names, not just `outputDir` — the tool
    // result is what names the file, and restricting to one directory would
    // break board items living elsewhere. The whitelist keeps the answer to
    // `?path=<anything readable>` at worst an image leak of files the user's
    // own session already knows the path of, never an arbitrary-file oracle
    // for scripts or text.
    server.register({
      kind: 'exact',
      path: STUDIO_FILE_ROUTE,
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') return jsonError(res, 405, 'method-not-allowed')
        if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')

        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const requested = url.searchParams.get('path') ?? ''
        if (requested.length === 0) return jsonError(res, 400, '缺少 path 参数')
        if (!isAbsolute(requested)) return jsonError(res, 400, '必须是绝对路径')

        const type = STUDIO_FILE_TYPES[basename(requested).toLowerCase().match(/\.[^.]+$/)?.[0] ?? '']
        if (type === undefined) return jsonError(res, 415, '只支持 PNG / JPEG / WebP')

        // Resolve then re-check the extension: `..\` tricks and trailing dots
        // are handled by `resolve` normalising the path first.
        const target = resolvePath(requested)
        const resolvedType = STUDIO_FILE_TYPES[basename(target).toLowerCase().match(/\.[^.]+$/)?.[0] ?? '']
        if (resolvedType === undefined) return jsonError(res, 415, '只支持 PNG / JPEG / WebP')

        let stats: Stats
        try {
          stats = await stat(target)
        } catch {
          return jsonError(res, 404, '文件不存在')
        }
        if (!stats.isFile()) return jsonError(res, 404, '不是文件')

        res.writeHead(200, {
          'content-type': resolvedType,
          'content-length': String(stats.size),
          // Names carry a self-advancing counter and are never overwritten, so
          // the bytes behind one URL are immutable for the session's lifetime.
          'cache-control': 'private, max-age=86400, immutable',
        })
        await pipeline(createReadStream(target), res)
      }),
    }),
  ]
}

/** Board a mutation targets: the explicit one, else the active board. */
async function targetBoardId(outputDir: string, requested: string | undefined): Promise<string | undefined> {
  const wanted = typeof requested === 'string' ? requested.trim() : ''
  const candidate = wanted.length > 0 ? wanted : await activeBoardId(outputDir)
  if (candidate === null) return undefined
  const board = await readBoard(outputDir, candidate)
  return board?.id
}

/**
 * Validate the generation body; every field is narrowed before it is trusted.
 *
 * Reference images are checked for shape only — the adapter sniffs the real
 * container from the bytes, and a wrong `mediaType` claim must not reach a
 * filename that `LoadImage` then refuses.
 *
 * @param value - parsed JSON of unknown shape.
 * @returns the validated request.
 * @throws With a message meant for the panel.
 */
export function parseGenerate(value: unknown): StudioGenerateRequest {
  const body = record(value)
  if (body === undefined) throw new Error('请求格式无效')
  const prompt = requiredText(body.prompt, '请输入提示词', STUDIO_MAX_PROMPT_CHARS)
  const ratio = requiredText(body.ratio, '请选择画幅比例', 16)
  if (!(STUDIO_RATIOS as readonly string[]).includes(ratio)) throw new Error(`不支持的画幅比例：${ratio}`)
  const steps = optionalInteger(body.steps, '步数')
  const seed = optionalInteger(body.seed, '种子')
  const count = optionalInteger(body.count, '出图张数')
  const references = body.references === undefined ? undefined : parseReferences(body.references)
  const board = typeof body.board === 'string' && body.board.trim().length > 0 ? body.board.trim().slice(0, 80) : undefined
  return {
    prompt,
    ratio,
    ...(steps === undefined ? {} : { steps }),
    ...(seed === undefined ? {} : { seed }),
    ...(count === undefined ? {} : { count }),
    ...(references === undefined || references.length === 0 ? {} : { references }),
    ...(board === undefined ? {} : { board }),
  }
}

/** Actions the board route accepts. */
const BOARD_ACTIONS = ['create', 'rename', 'layout', 'remove-item', 'delete', 'active'] as const

/**
 * Validate one board mutation.
 *
 * The action is a closed set — an unknown one is refused rather than ignored,
 * because a typo in the panel would otherwise look like a successful save.
 * Positions are capped in count and checked for finiteness; the store ignores
 * ids it does not know, so a stale panel cannot break a board.
 *
 * @param value - parsed JSON of unknown shape.
 * @returns the validated action.
 * @throws With a message meant for the panel.
 */
export function parseBoardAction(value: unknown): StudioBoardRequest {
  const body = record(value)
  if (body === undefined) throw new Error('请求格式无效')
  const action = body.action
  if (typeof action !== 'string' || !(BOARD_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`未知的画板操作：${String(action)}`)
  }
  const board = typeof body.board === 'string' && body.board.trim().length > 0 ? body.board.trim().slice(0, 80) : undefined
  const name = typeof body.name === 'string' ? body.name.slice(0, 120) : undefined
  const item = typeof body.item === 'string' && body.item.trim().length > 0 ? body.item.trim().slice(0, 80) : undefined
  const deleteFile = body.deleteFile === true
  const items = Array.isArray(body.items)
    ? body.items.slice(0, 2000).map(parsePosition).filter(isPosition)
    : undefined
  const camera = parseCamera(body.camera)
  return {
    action: action as StudioBoardRequest['action'],
    ...(board === undefined ? {} : { board }),
    ...(name === undefined ? {} : { name }),
    ...(item === undefined ? {} : { item }),
    ...(deleteFile ? { deleteFile } : {}),
    ...(items === undefined ? {} : { items }),
    ...(camera === undefined ? {} : { camera }),
  }
}

function parsePosition(value: unknown): { id: string; x: number; y: number } | undefined {
  const entry = record(value)
  if (entry === undefined) return undefined
  if (typeof entry.id !== 'string' || entry.id.length === 0) return undefined
  if (typeof entry.x !== 'number' || !Number.isFinite(entry.x)) return undefined
  if (typeof entry.y !== 'number' || !Number.isFinite(entry.y)) return undefined
  return { id: entry.id.slice(0, 80), x: entry.x, y: entry.y }
}

function isPosition(value: { id: string; x: number; y: number } | undefined): value is { id: string; x: number; y: number } {
  return value !== undefined
}

function parseCamera(value: unknown): { x: number; y: number; zoom: number } | undefined {
  const camera = record(value)
  if (camera === undefined) return undefined
  const { x, y, zoom } = camera
  if (typeof x !== 'number' || !Number.isFinite(x)) return undefined
  if (typeof y !== 'number' || !Number.isFinite(y)) return undefined
  if (typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom <= 0) return undefined
  return { x, y, zoom }
}

/**
 * Validate the optimiser body.
 *
 * Context is optional and capped: the panel sends at most a handful of turns,
 * and a request that claims thousands is truncated rather than rejected —
 * losing history is a quality problem, not a reason to refuse the rewrite.
 *
 * @param value - parsed JSON of unknown shape.
 * @returns the validated request.
 */
export function parseOptimize(value: unknown): StudioOptimizeRequest {
  const body = record(value)
  if (body === undefined) throw new Error('请求格式无效')
  const prompt = requiredText(body.prompt, '请输入提示词', STUDIO_MAX_PROMPT_CHARS)
  const editing = body.editing === true
  const ratio = typeof body.ratio === 'string' && body.ratio.trim().length > 0 ? body.ratio.trim().slice(0, 16) : undefined
  const context = Array.isArray(body.context) ? body.context.map(parseTurn).filter(isTurn).slice(0, 8) : undefined
  // An unknown style is dropped rather than rejected: the panel's default is
  // `prose`, and a stale tab sending `style: "v2"` should still get a rewrite.
  const style = body.style === 'formula' || body.style === 'prose' ? body.style : undefined
  return {
    prompt,
    editing,
    ...(ratio === undefined ? {} : { ratio }),
    ...(style === undefined ? {} : { style }),
    ...(context === undefined || context.length === 0 ? {} : { context }),
  }
}

/** One history turn, or `undefined` when it carries nothing usable. */
function parseTurn(value: unknown): StudioOptimizeTurn | undefined {
  const turn = record(value)
  if (turn === undefined) return undefined
  if (turn.role !== 'user' && turn.role !== 'assistant') return undefined
  if (typeof turn.text !== 'string') return undefined
  const text = turn.text.trim()
  if (text.length === 0) return undefined
  return { role: turn.role, text }
}

function isTurn(value: StudioOptimizeTurn | undefined): value is StudioOptimizeTurn {
  return value !== undefined
}

/** References: base64 plus a container hint, capped in count. */
function parseReferences(value: unknown): StudioReferencePayload[] {
  if (!Array.isArray(value)) throw new Error('参考图格式无效')
  return value.map((entry, index) => {
    const reference = record(entry)
    if (reference === undefined) throw new Error('参考图格式无效')
    const mediaType = typeof reference.mediaType === 'string' ? reference.mediaType : 'image/png'
    const name = typeof reference.name === 'string' && reference.name.trim().length > 0
      ? reference.name.trim().slice(0, 120)
      : undefined
    // Two sources, never both: uploaded bytes, or the path of an image this
    // host already wrote (the canvas reuses its own results as references).
    if (typeof reference.path === 'string' && reference.path.trim().length > 0) {
      if (typeof reference.data === 'string' && reference.data.length > 0) {
        throw new Error(`第 ${String(index + 1)} 张参考图同时给了 path 和 data`)
      }
      return { path: reference.path.trim(), mediaType, ...(name === undefined ? {} : { name }) }
    }
    if (typeof reference.data !== 'string' || reference.data.length === 0) {
      throw new Error(`第 ${String(index + 1)} 张参考图内容为空`)
    }
    return { data: reference.data, mediaType, ...(name === undefined ? {} : { name }) }
  })
}

function requiredText(value: unknown, message: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(message)
  const text = value.trim()
  if (text.length > maxLength) throw new Error(`${message}（最多 ${String(maxLength)} 个字符）`)
  return text
}

function optionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label}必须是数字`)
  return Math.trunc(value)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function isJson(req: IncomingMessage): boolean {
  return (req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')
}

/** Same-origin check; a missing `origin` is a same-origin navigation. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  return origin === undefined || host === undefined || origin === `http://${host}` || origin === `https://${host}`
}

/** Read a body with the cap enforced during the read, not after. */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    bytes += buffer.byteLength
    if (bytes > maxBytes) throw new Error(`请求体过大（上限 ${String(Math.trunc(maxBytes / 1024 / 1024))} MB）`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return
  json(res, status, { error: message })
}
