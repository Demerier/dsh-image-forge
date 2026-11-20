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
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { deflateSync, inflateSync } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import {
  STUDIO_ASSETS_ROUTE,
  STUDIO_BOARDS_ROUTE,
  STUDIO_BOARD_ROUTE,
  STUDIO_CONFIG_ROUTE,
  STUDIO_ENVIRONMENT_ACTIONS,
  STUDIO_ENVIRONMENT_ROUTE,
  STUDIO_EVENTS_ROUTE,
  STUDIO_FILE_ROUTE,
  STUDIO_FILE_TYPES,
  STUDIO_GENERATE_ROUTE,
  STUDIO_IMPORT_MAX_BODY_BYTES,
  STUDIO_IMPORT_MAX_ITEM_BYTES,
  STUDIO_IMPORT_ROUTE,
  STUDIO_MAX_BODY_BYTES,
  STUDIO_MAX_LAYOUT_CHARS,
  STUDIO_MAX_PARENT_IDS,
  STUDIO_MAX_PROMPT_CHARS,
  STUDIO_OPTIMIZE_ROUTE,
  STUDIO_RATIOS,
  STUDIO_THUMB_DIR,
  STUDIO_THUMB_WIDTHS,
  type BoardLayoutDraft,
  type BoardTaskInfo,
  type StudioBoardRequest,
  type StudioEnvironmentAction,
  type StudioEnvironmentRequest,
  type StudioEnvironmentResponse,
  type StudioEnvironmentSnapshot,
  type StudioEnvironmentStop,
  type StudioGenerateRequest,
  type StudioImportRequest,
  type StudioImportResponse,
  type StudioOptimizeRequest,
  type StudioOptimizeTurn,
  type StudioProgressEvent,
  type StudioReferencePayload,
  firstLine,
  isStudioClientId,
  parseStudioThumbWidth,
} from './studio-shared.ts'
import { createProgressBridge, type ProgressBridgeTiming } from './progress.ts'
import { createRunRegistry, type RunRegistry } from './runs.ts'
import {
  activeBoardId,
  copyItem,
  createBoard,
  duplicateBoard,
  listAssets,
  listBoards,
  moveItem,
  readBoard,
  recordItems,
  removeBoard,
  removeItem,
  renameBoard,
  saveLayout,
  saveLayoutItem,
  saveTaskItem,
  setActiveBoard,
} from './boards.ts'
import { readWorkspaceFile, writeWorkspaceFile } from './boards.ts'
import type { BoardDuplicate } from './boards.ts'
import { parseMossLayout } from './model-profiles.ts'
import { stateFromWorkspace, toWorkspaceJson } from './workbench-tabs.ts'
import { sanitizePrefix, writeImages } from './output.ts'
import { probeImageSize } from './refs.ts'
import {
  describeStudio,
  runStudioGeneration,
  type StudioSettings,
} from './studio-service.ts'
import {
  ensureEnvironment,
  environmentOptionsOf,
  inspectEnvironment,
  stopEnvironment,
  type EnvironmentDeps,
  type EnvironmentOptions,
  type EnvironmentStatus,
  type EnvironmentStopResult,
} from './environment.ts'
import { OptimizeUnavailableError, optimizeStudioPrompt } from './studio-prompt.ts'

/** Heartbeat cadence while a long request is in flight; tests shrink it. */
const HEARTBEAT_MS = 15_000

/** Body cap for the environment route: three short strings, never a picture. */
const ENVIRONMENT_MAX_BODY_BYTES = 8 * 1024

/**
 * Single-flight lock for the environment actions, module level on purpose.
 *
 * `isConcurrencySafe: false` on the Agent tool only serialises *tool* calls; the
 * panel's buttons are HTTP requests and two fast clicks would otherwise spawn two
 * renderers, each convinced it owns the only record. `status` deliberately does
 * not take the lock — a read must not be refused because a start is in flight.
 */
let environmentActionInFlight: StudioEnvironmentAction | null = null

/** Everything the routes need from the host. */
export interface StudioRouteDeps {
  /** Read the current plugin config, so a settings save is picked up live. */
  settings(): StudioSettings
  /** Host context, for the `llm` lookup the optimiser needs. */
  ctx: Context
  /**
   * Timing overrides for the progress bridge.
   *
   * Tests shrink the reconnect delay so a dropped ComfyUI socket can be
   * exercised without waiting a production-sized backoff; production leaves it
   * out and takes the defaults.
   */
  progress?: ProgressBridgeTiming
  /**
   * Session run registry shared by the generate route and the SSE bridge.
   *
   * One is created per registration when omitted; tests pass their own so they
   * can register a run without a live ComfyUI.
   */
  runs?: RunRegistry
  /**
   * Environment control (P2) — start/stop/status from the workbench.
   *
   * `options` resolves the environment options **per request**, so a settings
   * save (a new endpoint, a new port) is observed without a host restart.
   * `deps` carries the machine-facing seams; tests inject them so no case ever
   * spawns Python, runs `taskkill` or probes a real port. Omitted entirely in
   * production, which then resolves both from `settings()` and this machine.
   */
  environment?: {
    options?(): EnvironmentOptions
    deps?: EnvironmentDeps
  }
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

/** Register the Studio's routes (JSON endpoints plus one SSE stream) on the host web server. */
export function registerStudioRoutes(
  ctx: Context,
  deps: StudioRouteDeps,
): Array<() => void> {
  const server = (ctx as unknown as { webServer?: { register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void } }).webServer
  if (server === undefined || typeof server.register !== 'function') return []

  // One bridge per registration: every SSE response shares the same ComfyUI
  // socket, and the bridge stays inert (no socket, no timer, no probe) until
  // the first panel subscribes.
  // One registry per registration: the generation path registers runs into it
  // and the SSE bridge looks events up against it, so both must share it.
  const runs = deps.runs ?? createRunRegistry()
  const progress = createProgressBridge({ settings: deps.settings, runs, ...(deps.progress ?? {}) })

  const disposers = [
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

    // ---- environment: start / stop / status ------------------------------
    //
    // The one route that may touch the machine. Three guards make that safe:
    // same-origin (a hostile page cannot stop the user's renderer), POST+JSON
    // (an HTML form cannot forge it), and the ownership proof inside
    // `stopEnvironment` (only a process whose command line still names the
    // recorded `main.py` is ever signalled). The heartbeat exists because a cold
    // start legitimately waits minutes for `/system_stats`.
    server.register({
      kind: 'exact',
      path: STUDIO_ENVIRONMENT_ROUTE,
      handler: guard(async (req, res) => {
        if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')
        if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
        if (!isJson(req)) return jsonError(res, 415, 'json-required')

        let request: StudioEnvironmentRequest
        let showLogRequested = false
        try {
          request = parseEnvironmentAction(JSON.parse(await readBody(req, ENVIRONMENT_MAX_BODY_BYTES)))
          showLogRequested = request.showLog === true
        } catch (error) {
          return jsonError(res, 400, firstLine(error))
        }
        const action: StudioEnvironmentAction = request.action ?? 'status'
        const options = deps.environment?.options?.() ?? environmentOptionsOf(deps.settings())
        const machine = deps.environment?.deps ?? {}

        if (action === 'status') {
          const status = await inspectEnvironment(options, machine)
          const body: StudioEnvironmentResponse = { environment: environmentSnapshotOf(status) }
          return json(res, 200, body)
        }

        if (environmentActionInFlight !== null) {
          return json(res, 409, {
            error: environmentActionInFlight === 'start'
              ? '正在启动 ComfyUI（一次只拉起一个），请等这次请求返回。'
              : '正在停止 ComfyUI，请等这次请求返回。',
          } satisfies StudioEnvironmentResponse)
        }
        environmentActionInFlight = action
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
        })
        const heartbeat = setInterval(() => {
          if (!res.destroyed && !res.writableEnded) res.write('\n')
        }, HEARTBEAT_MS)
        try {
          if (action === 'start') {
            const status = await ensureEnvironment(options, machine, showLogRequested)
            if (!res.destroyed && !res.writableEnded) {
              const body: StudioEnvironmentResponse = { environment: environmentSnapshotOf(status) }
              res.end(JSON.stringify(body))
            }
            return
          }
          const stop = await stopEnvironment(machine)
          const status = await inspectEnvironment(options, machine)
          if (!res.destroyed && !res.writableEnded) {
            const body: StudioEnvironmentResponse = {
              environment: environmentSnapshotOf(status),
              stop: environmentStopOf(stop),
            }
            res.end(JSON.stringify(body))
          }
        } catch (error) {
          if (!res.destroyed && !res.writableEnded) {
            res.end(JSON.stringify({ error: firstLine(error) } satisfies StudioEnvironmentResponse))
          }
        } finally {
          clearInterval(heartbeat)
          environmentActionInFlight = null
        }
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
          const output = await runStudioGeneration(deps.settings(), input, controller.signal, runs)
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
          // The stage is the actionable half of this failure: llm-missing,
          // list-providers-empty, list-models-failed and assembler-missing each
          // need a different fix, and flattening them into one sentence is what
          // made this look like "the optimiser is just broken".
          const stage = error instanceof OptimizeUnavailableError ? error.stage : undefined
          json(res, 502, { error: firstLine(error), ...(stage === undefined ? {} : { stage }) })
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
          case 'workspace-get': {
            // Read-only by contract (§4.3 point 1): a stale or legacy document
            // is normalised in memory and never written back here.
            const raw = await readWorkspaceFile(outputDir)
            if (raw === undefined) return json(res, 200, { ok: true, workspace: null })
            const known = await listBoards(outputDir)
            const state = stateFromWorkspace(raw, { boardIds: known.map((board) => board.id) })
            return json(res, 200, { ok: true, workspace: toWorkspaceJson(state) })
          }
          case 'workspace-set': {
            if (typeof action.workspace !== 'object' || action.workspace === null) {
              return jsonError(res, 400, '缺少 workspace 参数')
            }
            const known = await listBoards(outputDir)
            const state = stateFromWorkspace(action.workspace, { boardIds: known.map((board) => board.id) })
            const normalized = toWorkspaceJson(state)
            if (!(await writeWorkspaceFile(outputDir, normalized))) {
              return jsonError(res, 500, '工作区记录写入失败')
            }
            // §4.4: `state.json` stays a mirror of the active canvas tab.
            const active = normalized.activeTab.kind === 'projects' ? null : normalized.activeTab.boardId ?? null
            await setActiveBoard(outputDir, active)
            return json(res, 200, { ok: true })
          }
          case 'create': {
            const board = await createBoard(outputDir, action.name)
            await setActiveBoard(outputDir, board.id)
            return json(res, 200, { ok: true, board })
          }
          case 'duplicate': {
            // §5.3: a copy is entries + camera, never the pictures. The new id
            // is deliberately **not** made the active board: `state.json` mirrors
            // the open canvas tab (§4.4), and the panel decides whether to open
            // the copy. Making it active here would claim a tab nobody opened.
            const id = await targetBoardId(outputDir, action.board)
            if (id === undefined) return jsonError(res, 404, '画板不存在')
            let copy: BoardDuplicate | undefined
            try {
              copy = await duplicateBoard(outputDir, id, action.name)
            } catch (error) {
              // The one expected refusal: the library is at MAX_BOARDS.
              return jsonError(res, 409, firstLine(error))
            }
            if (copy === undefined) return jsonError(res, 404, '画板不存在')
            return json(res, 200, {
              ok: true,
              board: copy.board,
              droppedParents: copy.droppedParents,
            })
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
          case 'copy-item':
          case 'move-item': {
            const source = await targetBoardId(outputDir, action.board)
            if (source === undefined) return jsonError(res, 404, '画板不存在')
            const target = await targetBoardId(outputDir, action.toBoard)
            if (target === undefined) return jsonError(res, 404, '目标画板不存在')
            if (typeof action.item !== 'string' || action.item.length === 0) return jsonError(res, 400, '缺少 item 参数')
            const spot = action.x === undefined || action.y === undefined
              ? undefined
              : { x: action.x, y: action.y }
            const result = action.action === 'copy-item'
              ? await copyItem(outputDir, source, action.item, target, spot)
              : await moveItem(outputDir, source, action.item, target, spot)
            if (result === undefined) return jsonError(res, 404, '这张图不在画板里')
            return json(res, 200, { ok: true, item: result.item, board: result.board })
          }
          case 'save-task': {
            if (action.task === undefined) return jsonError(res, 400, '缺少 task 参数')
            // `board` may be absent on purpose: a run can fail before its first
            // picture ever created a board, and losing the retryable failure
            // because of that would be worse than creating an empty board.
            const written = await saveTaskItem(outputDir, action.board, {
              ...(action.item === undefined ? {} : { id: action.item }),
              ...(action.x === undefined ? {} : { x: action.x }),
              ...(action.y === undefined ? {} : { y: action.y }),
              ...(action.parents === undefined ? {} : { parents: action.parents }),
              task: action.task,
            })
            if (written === undefined) return jsonError(res, 400, '任务条目写入失败')
            return json(res, 200, { ok: true, item: written.item, board: written.board })
          }
          case 'save-layout-node': {
            if (action.draft === undefined || action.w === undefined || action.h === undefined) {
              return jsonError(res, 400, '缺少布局草稿或显示尺寸')
            }
            const written = await saveLayoutItem(outputDir, action.board, {
              ...(action.item === undefined ? {} : { id: action.item }),
              ...(action.x === undefined ? {} : { x: action.x }),
              ...(action.y === undefined ? {} : { y: action.y }),
              ...(action.parents === undefined ? {} : { parents: action.parents }),
              draft: action.draft,
              w: action.w,
              h: action.h,
            })
            if (written === undefined) return jsonError(res, 400, '布局条目写入失败')
            return json(res, 200, { ok: true, item: written.item, board: written.board })
          }
          case 'delete': {
            const id = await targetBoardId(outputDir, action.board)
            if (id === undefined) return jsonError(res, 404, '画板不存在')
            // §5.4's two modes, one action: without `deleteFiles` the pictures
            // stay (the reversible delete the panel defaults to); with it they go,
            // minus any file another board still shares.
            const result = await removeBoard(outputDir, id, { deleteFiles: action.deleteFiles === true })
            if (result.removed && (await activeBoardId(outputDir)) === id) await setActiveBoard(outputDir, null)
            return json(res, 200, {
              ok: result.removed,
              filesDeleted: result.filesDeleted,
              filesKept: result.filesKept,
            })
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

    // ---- import (DD10) ----------------------------------------------------
    //
    // The one route that accepts image bytes. Its body cap is independent of
    // the board route's 256 KB and enforced during the read; the container is
    // sniffed from the decoded bytes rather than trusted, so a text file
    // renamed `.png` is refused before anything reaches the disk.
    server.register({
      kind: 'exact',
      path: STUDIO_IMPORT_ROUTE,
      handler: guard(async (req, res) => {
        if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')
        if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
        if (!isJson(req)) return jsonError(res, 415, 'json-required')
        let input: StudioImportRequest
        try {
          input = parseImport(JSON.parse(await readBody(req, STUDIO_IMPORT_MAX_BODY_BYTES)))
        } catch (error) {
          return jsonError(res, 400, firstLine(error))
        }
        let decoded: { bytes: Uint8Array; width: number; height: number; mime: string }
        try {
          const bytes = decodeImportData(input.data)
          const size = probeImageSize(bytes)
          if (size === undefined) throw new Error('只支持 PNG / JPEG / WebP 图片')
          decoded = { bytes, ...size }
        } catch (error) {
          return jsonError(res, 400, firstLine(error))
        }
        const outputDir = deps.settings().outputDir
        const prefix = sanitizePrefix(input.name.replace(/\.[^./\\]+$/, ''), 'import')
        const [written] = await writeImages(outputDir, prefix, decoded.width, decoded.height, [
          { bytes: decoded.bytes, mime: decoded.mime },
        ])
        const position = input.x === undefined || input.y === undefined
          ? {}
          : { x: input.x, y: input.y }
        const write = await recordItems(outputDir, input.board, [{
          path: written.path,
          markdownPath: written.markdownPath,
          width: decoded.width,
          height: decoded.height,
          bytes: written.bytes,
          mediaType: decoded.mime,
          prompt: '',
          mode: 'generate',
          backend: 'studio',
          parents: [],
          ...position,
        }])
        const item = write.items[0]
        if (item === undefined) return jsonError(res, 500, '导入失败：条目未落盘')
        json(res, 200, { item, board: write.board } satisfies StudioImportResponse)
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
        // G20: `?w=` asks for a cached thumbnail at one of the whitelisted widths.
        // A width outside the list is a 400 rather than a silent original: the
        // canvas would otherwise look like the thumbnail failed to appear.
        const thumbWidth = parseStudioThumbWidth(url.searchParams.get('w'))
        if (thumbWidth === null) {
          return jsonError(res, 400, `w 只接受 ${STUDIO_THUMB_WIDTHS.join(' / ')} 这几档`)
        }

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

        if (thumbWidth !== undefined) {
          const thumb = await thumbFor(deps.settings().outputDir, target, stats, thumbWidth)
          if (thumb !== undefined) {
            if (thumb.kind === 'cached') {
              let thumbStats: Stats
              try {
                thumbStats = await stat(thumb.path)
              } catch {
                // The file vanished between the check and this read (a rebooted
                // cache): fall through to the original, which is always correct.
                thumbStats = stats
                res.writeHead(200, {
                  'content-type': resolvedType,
                  'content-length': String(stats.size),
                  'x-dsh-thumb': 'original',
                  'cache-control': 'private, max-age=86400, immutable',
                })
                await pipeline(createReadStream(target), res)
                return
              }
              res.writeHead(200, {
                'content-type': 'image/png',
                'content-length': String(thumbStats.size),
                'x-dsh-thumb': 'cached',
                'cache-control': 'private, max-age=86400, immutable',
              })
              await pipeline(createReadStream(thumb.path), res)
              return
            }
            res.writeHead(200, {
              'content-type': 'image/png',
              'content-length': String(thumb.bytes.length),
              'x-dsh-thumb': 'generated',
              'cache-control': 'private, max-age=86400, immutable',
            })
            res.end(thumb.bytes)
            return
          }
          // Not a downscalable PNG (JPEG / WebP / 16-bit / already small): the
          // original is the honest answer, and the header says which happened.
        }

        res.writeHead(200, {
          'content-type': resolvedType,
          'content-length': String(stats.size),
          ...(thumbWidth === undefined ? {} : { 'x-dsh-thumb': 'original' }),
          // Names carry a self-advancing counter and are never overwritten, so
          // the bytes behind one URL are immutable for the session's lifetime.
          'cache-control': 'private, max-age=86400, immutable',
        })
        await pipeline(createReadStream(target), res)
      }),
    }),

    // ---- progress stream -------------------------------------------------
    //
    // One long-lived same-origin SSE response per watching panel. The bridge
    // owns the ComfyUI socket; this route only frames its events, so two
    // panels (the workbench and a tool card) share one upstream connection.
    //
    // Deliberately no timeout: the stream lives as long as the page is open.
    // The heartbeat is what keeps a reverse proxy from reaping the idle
    // connection between two runs, exactly like the POST routes' newline.
    server.register({
      kind: 'exact',
      path: STUDIO_EVENTS_ROUTE,
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') return jsonError(res, 405, 'method-not-allowed')
        if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')

        // Headers first: `EventSource` fires `open` only once the response
        // head arrived, and the panel wants its "已连接" state at that point.
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          // A cached event stream is not a stream.
          'cache-control': 'no-store',
          // Same reason as the JSON routes: bytes must reach the browser
          // instead of sitting in a proxy buffer.
          'x-accel-buffering': 'no',
          connection: 'keep-alive',
        })
        res.write(': connected\n\n')
        // A browser that navigates away errors the response on the next write;
        // a stream whose reader is gone has nothing left to report.
        res.on('error', () => {})
        const unsubscribe = progress.subscribe((event) => writeEvent(res, event))
        const heartbeat = setInterval(() => {
          if (res.destroyed || res.writableEnded) return
          try {
            res.write(': keep-alive\n\n')
          } catch {
            // The client went away between the check and the write.
          }
        }, HEARTBEAT_MS)
        try {
          await new Promise<void>((resolve) => {
            res.once('close', () => { resolve() })
            res.once('finish', () => { resolve() })
          })
        } finally {
          clearInterval(heartbeat)
          unsubscribe()
        }
      }),
    }),
  ]
  // The bridge holds the ComfyUI socket; a host unmount must release it.
  disposers.push(() => progress.stop())
  return disposers
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
  const clientId = parseClientId(body.clientId)
  // C14: layout is forwarded verbatim (T21's contract) and validated here with
  // the same parser the tool boundary uses, so a malformed layout is a 400 with
  // a named field instead of a run that fails after the weights load.
  const layout = body.layout === undefined ? undefined : parseLayoutText(body.layout)
  const parents = parseParentIds(body.parents)
  return {
    prompt,
    ratio,
    ...(steps === undefined ? {} : { steps }),
    ...(seed === undefined ? {} : { seed }),
    ...(count === undefined ? {} : { count }),
    ...(references === undefined || references.length === 0 ? {} : { references }),
    ...(board === undefined ? {} : { board }),
    ...(clientId === undefined ? {} : { clientId }),
    ...(layout === undefined ? {} : { layout }),
    ...(parents === undefined ? {} : { parents }),
  }
}

/**
 * Validate one compiled MOSS layout prompt (T21's shape).
 *
 * The length cap comes first so an abusive string is refused before parsing;
 * the shared parser then names the failing field (`bbox_coord_space`,
 * `summary.caption`, …), exactly like the Agent tool does.
 */
function parseLayoutText(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('layout 必须是布局编辑器导出的 compiled JSON 字符串')
  }
  if (value.length > STUDIO_MAX_LAYOUT_CHARS) {
    throw new Error('layout 最多 ' + String(STUDIO_MAX_LAYOUT_CHARS) + ' 个字符')
  }
  parseMossLayout(value)
  return value
}

/** Actions the board route accepts. */
const BOARD_ACTIONS = [
  'create',
  'rename',
  'duplicate',
  'layout',
  'remove-item',
  'delete',
  'active',
  'copy-item',
  'move-item',
  'save-task',
  'save-layout-node',
  'workspace-get',
  'workspace-set',
] as const

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
  // Strictly `true`: a truthy string must not turn a "只删除项目" click into a
  // file purge. The panel sends the flag only for the second option (§5.4).
  const deleteFiles = body.deleteFiles === true
  const items = Array.isArray(body.items)
    ? body.items.slice(0, 2000).map(parsePosition).filter(isPosition)
    : undefined
  const camera = parseCamera(body.camera)
  const toBoard = typeof body.toBoard === 'string' && body.toBoard.trim().length > 0
    ? body.toBoard.trim().slice(0, 80)
    : undefined
  // Copy/move need a destination; a typo there would otherwise look like a
  // successful save (the same reasoning that makes the action set closed).
  if ((action === 'copy-item' || action === 'move-item') && toBoard === undefined) {
    throw new Error('缺少目标画板（toBoard）')
  }
  const x = parseCoordinate(body.x)
  const y = parseCoordinate(body.y)
  const parents = parseParentIds(body.parents)
  const task = body.task === undefined ? undefined : parseBoardTask(body.task)
  const draft = body.draft === undefined ? undefined : parseBoardDraft(body.draft)
  const workspace = body.workspace
  const w = parseCoordinate(body.w)
  const h = parseCoordinate(body.h)
  // C14's two terminal writers: a stored failure must not be a running task
  // (DD6), and a layout node is useless without its draft or display box.
  if (action === 'save-task' && task === undefined) throw new Error('缺少 task（失败/中断状态与参数快照）')
  if (action === 'save-layout-node') {
    if (draft === undefined) throw new Error('缺少 draft（布局草稿）')
    if (w === undefined || h === undefined) throw new Error('缺少布局节点的显示尺寸（w / h）')
  }
  return {
    action: action as StudioBoardRequest['action'],
    ...(action === 'workspace-set' && typeof workspace === 'object' && workspace !== null ? { workspace } : {}),
    ...(board === undefined ? {} : { board }),
    ...(name === undefined ? {} : { name }),
    ...(item === undefined ? {} : { item }),
    ...(deleteFile ? { deleteFile } : {}),
    ...(deleteFiles ? { deleteFiles } : {}),
    ...(items === undefined ? {} : { items }),
    ...(camera === undefined ? {} : { camera }),
    ...(toBoard === undefined ? {} : { toBoard }),
    ...(x === undefined || y === undefined ? {} : { x, y }),
    ...(parents === undefined ? {} : { parents }),
    ...(task === undefined ? {} : { task }),
    ...(draft === undefined ? {} : { draft }),
    ...(w === undefined ? {} : { w }),
    ...(h === undefined ? {} : { h }),
  }
}

/**
 * One layout entry: a position, and — since G26 — optionally the lineage it
 * gained on the canvas.
 *
 * `parents` rides along because adding an edge is not a new board action: the
 * canvas already writes positions through `layout`, and one write per change is
 * what keeps the store from needing a second, conflicting ordering. The field is
 * **optional and additive**: an entry without it produces exactly the object this
 * parser produced before, so every existing caller (and every stored test) is
 * byte-identical.
 *
 * Unlike the top-level `parents` of `save-task`/`save-layout-node`, a bad value
 * here is **dropped, not refused**: a position is still worth saving even if the
 * lineage payload is malformed, and refusing the whole write would lose the
 * drag the user just made.
 */
function parsePosition(value: unknown): { id: string; x: number; y: number; parents?: string[] } | undefined {
  const entry = record(value)
  if (entry === undefined) return undefined
  if (typeof entry.id !== 'string' || entry.id.length === 0) return undefined
  if (typeof entry.x !== 'number' || !Number.isFinite(entry.x)) return undefined
  if (typeof entry.y !== 'number' || !Number.isFinite(entry.y)) return undefined
  const parents = parsePositionParents(entry.parents)
  return {
    id: entry.id.slice(0, 80),
    x: entry.x,
    y: entry.y,
    ...(parents === undefined ? {} : { parents }),
  }
}

/** Parent ids of one layout entry, with anything unrecognisable dropped. */
function parsePositionParents(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids = value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim().slice(0, 80))
    .slice(0, STUDIO_MAX_PARENT_IDS)
  return ids.length === 0 ? undefined : ids
}

function isPosition(value: { id: string; x: number; y: number } | undefined): value is { id: string; x: number; y: number } {
  return value !== undefined
}

/** Canvas parent ids: strings only, capped, unknown ids are harmless downstream. */
function parseParentIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('parents 必须是数组')
  const ids = value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim().slice(0, 80))
    .slice(0, STUDIO_MAX_PARENT_IDS)
  return ids.length === 0 ? undefined : ids
}

/** One terminal task node: only failure/interruption are storable (DD6, §4.6). */
function parseBoardTask(value: unknown): BoardTaskInfo {
  const body = record(value)
  if (body === undefined) throw new Error('task 格式无效')
  const status = body.status
  if (status !== 'failed' && status !== 'interrupted') {
    throw new Error('task.status 只能是 failed 或 interrupted（运行中的任务不落盘）')
  }
  const params = record(body.params)
  if (params === undefined || typeof params.prompt !== 'string' || params.prompt.trim().length === 0) {
    throw new Error('task.params.prompt 必须是非空字符串')
  }
  return {
    status,
    params: params as unknown as BoardTaskInfo['params'],
    ...(typeof body.error === 'string' ? { error: body.error.slice(0, 400) } : {}),
  }
}

/** A layout draft as stored: shape only, deep validation happens at compile time. */
function parseBoardDraft(value: unknown): BoardLayoutDraft {
  const body = record(value)
  if (body === undefined) throw new Error('draft 格式无效')
  const { width, height } = body
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) throw new Error('draft.width 必须是正数')
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) throw new Error('draft.height 必须是正数')
  if (!Array.isArray(body.items)) throw new Error('draft.items 必须是数组')
  return body as unknown as BoardLayoutDraft
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

/** A finite coordinate, or `undefined` when the field is absent or malformed. */
function parseCoordinate(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}

/**
 * Validate one imported image (DD10).
 *
 * Shape only: the bytes are decoded and sniffed by the route, because the
 * container claim in `mediaType` is untrusted input like any other.
 *
 * @param value - parsed JSON of unknown shape.
 * @returns the validated import request.
 * @throws With a message meant for the panel.
 */
export function parseImport(value: unknown): StudioImportRequest {
  const body = record(value)
  if (body === undefined) throw new Error('请求格式无效')
  const name = typeof body.name === 'string' && body.name.trim().length > 0
    ? body.name.trim().slice(0, 120)
    : undefined
  if (name === undefined) throw new Error('缺少文件名')
  if (typeof body.data !== 'string' || body.data.length === 0) throw new Error('缺少图片内容')
  const mediaType = typeof body.mediaType === 'string' ? body.mediaType.slice(0, 80) : undefined
  const board = typeof body.board === 'string' && body.board.trim().length > 0
    ? body.board.trim().slice(0, 80)
    : undefined
  const x = parseCoordinate(body.x)
  const y = parseCoordinate(body.y)
  return {
    name,
    data: body.data,
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(board === undefined ? {} : { board }),
    ...(x === undefined || y === undefined ? {} : { x, y }),
  }
}

/**
 * Decode an import body's base64 into bytes, bounded before allocation.
 *
 * The length check runs on the string first: a body that could not decode to
 * an allowed file is refused without allocating it. Only canonical base64 is
 * accepted — `Buffer.from` tolerates a lot of junk, and "it decoded" is not
 * the same as "it is what the panel sent".
 *
 * @param data - base64 payload from the request.
 * @returns the decoded bytes.
 * @throws When empty, malformed or over the per-file cap.
 */
export function decodeImportData(data: string): Uint8Array {
  const payload = data.replace(/\s+/g, '')
  if (payload.length === 0) throw new Error('缺少图片内容')
  const maxBase64 = Math.ceil(STUDIO_IMPORT_MAX_ITEM_BYTES / 3) * 4
  if (payload.length > maxBase64) {
    throw new Error(`图片超过 ${String(Math.trunc(STUDIO_IMPORT_MAX_ITEM_BYTES / 1024 / 1024))} MB 上限`)
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) throw new Error('图片内容不是合法的 base64')
  const bytes = new Uint8Array(Buffer.from(payload, 'base64'))
  if (bytes.byteLength === 0) throw new Error('图片内容解出来是空文件')
  if (bytes.byteLength > STUDIO_IMPORT_MAX_ITEM_BYTES) {
    throw new Error(`图片超过 ${String(Math.trunc(STUDIO_IMPORT_MAX_ITEM_BYTES / 1024 / 1024))} MB 上限`)
  }
  return bytes
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

/**
 * Validate the environment body.
 *
 * A missing action means `status` — a read, and the safe default for a body that
 * only meant to ask. An *unknown* action is refused rather than coerced: a typo
 * must not silently become a read the panel then reports as a successful start.
 *
 * @param value - parsed JSON of unknown shape.
 * @returns the validated request.
 * @throws With a message meant for the panel.
 */
export function parseEnvironmentAction(value: unknown): StudioEnvironmentRequest {
  const body = record(value)
  if (body === undefined) throw new Error('请求格式无效')
  const action = body.action
  if (action === undefined || action === null) return {}
  if (typeof action !== 'string' || !(STUDIO_ENVIRONMENT_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`未知的环境操作：${String(action)}`)
  }
  const showLog = body.showLog === true
  return { action: action as StudioEnvironmentAction, ...(showLog ? { showLog } : {}) }
}

/** The environment report, narrowed to the fields the panel renders. */
export function environmentSnapshotOf(status: EnvironmentStatus): StudioEnvironmentSnapshot {
  const snapshot: StudioEnvironmentSnapshot = { state: status.state, owned: status.owned === true }
  if (status.note.length > 0) snapshot.note = status.note
  if (status.endpoint !== null) snapshot.endpoint = status.endpoint
  if (status.port !== null) snapshot.port = status.port
  if (status.pid !== null) snapshot.pid = status.pid
  if (status.logPath !== null) snapshot.logPath = status.logPath
  if (status.waitedMs !== null) snapshot.waitedMs = status.waitedMs
  if (status.argvPreview !== null && status.argvPreview.length > 0) snapshot.argvPreview = [...status.argvPreview]
  if (status.hint !== null) snapshot.hint = status.hint
  // The ownership note only exists when a live pid could not be proved ours.
  // It is what lets the panel say "this is not yours" instead of showing a stop
  // button that would have to refuse when clicked.
  if (typeof status.ownershipNote === 'string' && status.ownershipNote.length > 0) snapshot.ownershipNote = status.ownershipNote
  return snapshot
}

/** The stop report, narrowed to the fields the panel renders. */
export function environmentStopOf(stop: EnvironmentStopResult): StudioEnvironmentStop {
  const report: StudioEnvironmentStop = { stopped: stop.stopped === true }
  if (stop.pid !== null) report.pid = stop.pid
  if (stop.exitCode !== null) report.exitCode = stop.exitCode
  report.reason = stop.reason
  if (stop.verified !== null) report.verified = stop.verified
  if (stop.note.length > 0) report.note = stop.note
  return report
}

/** One history turn, or `undefined` when it carries nothing usable. */function parseTurn(value: unknown): StudioOptimizeTurn | undefined {
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

/**
 * Accept the optional canvas task id.
 *
 * Absent means "an old panel / the Agent tools": the field is not added to the
 * parsed body, so the request behaves exactly as before. A malformed value is
 * refused rather than dropped — unlike the board route's per-entry coordinates,
 * a clientId is a single value and a typo would silently disconnect a task node
 * from every event of its own run.
 */
function parseClientId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (!isStudioClientId(value)) throw new Error('clientId 格式无效')
  return value
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

/**
 * Write one SSE message.
 *
 * A vanished client is normal (the panel navigated away), so a failed write is
 * swallowed: the response's `close` handler unsubscribes the stream a tick
 * later, and there is nobody left to report the error to.
 */
function writeEvent(res: ServerResponse, event: StudioProgressEvent): void {
  if (res.destroyed || res.writableEnded) return
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  } catch {
    // See above: the reader is gone.
  }
}

/* -------------------------------------------------------------------------- */
/* Thumbnails (G20) — a dependency-free PNG downscaler                        */
/* -------------------------------------------------------------------------- */
//
// The canvas asks for `?w=512`, the route writes a resized copy once into
// `<outputDir>/.dsh-image-forge/thumbs/` and serves that file forever after. The
// reason this is hand-rolled instead of `sharp`/`jimp`: this plugin ships with no
// runtime dependencies at all (see package.json — `dependencies` is absent), and
// adding a native image library to a Harness plugin for one thumbnail is a
// supply-chain and install-size decision, not an implementation detail.
//
// So: PNG only, 8-bit only, non-interlaced only — that is exactly what ComfyUI's
// `SaveImage` writes and what this plugin's import path accepts. Anything else
// (JPEG, WebP, 16-bit, interlaced, palette) falls through to the original bytes
// with `x-dsh-thumb: original`, which is a correct answer, just a bigger one.
// `node:zlib` does the compression; the filter/Paeth/CRC work is the ~120 lines
// of PNG this module has to know about.

/** One decoded PNG, ready to be resized and re-encoded. */
interface DecodedPng {
  readonly width: number
  readonly height: number
  /** RGBA, four bytes per pixel, row-major. */
  readonly pixels: Uint8Array
}

/** A CRC-32 table, built once (`node:zlib` does not expose one). */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

/** CRC-32 of `bytes`, as PNG chunks require. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Decode a PNG's pixels.
 *
 * @param bytes - the file's bytes.
 * @returns the decoded image, or `undefined` for any PNG this module will not
 *   re-encode (see the section note). A `undefined` is not an error: the caller
 *   serves the original file instead.
 */
export function decodePng(bytes: Uint8Array): DecodedPng | undefined {
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 8 || SIGNATURE.some((byte, index) => bytes[index] !== byte)) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat: Uint8Array[] = []
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!)
    const dataStart = offset + 8
    if (dataStart + length + 4 > bytes.length) return undefined
    if (type === 'IHDR') {
      if (length < 13) return undefined
      width = view.getUint32(dataStart)
      height = view.getUint32(dataStart + 4)
      bitDepth = bytes[dataStart + 8]!
      colorType = bytes[dataStart + 9]!
      const interlace = bytes[dataStart + 12]!
      // Only the shape ComfyUI writes: 8-bit, no interlace, no palette.
      if (bitDepth !== 8 || interlace !== 0) return undefined
      if (colorType !== 0 && colorType !== 2 && colorType !== 4 && colorType !== 6) return undefined
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(dataStart, dataStart + length))
    } else if (type === 'IEND') {
      break
    }
    offset = dataStart + length + 4
  }
  if (width <= 0 || height <= 0 || idat.length === 0) return undefined
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4
  const stride = width * channels
  let raw: Uint8Array
  try {
    raw = inflateSync(Buffer.concat(idat.map((chunk) => Buffer.from(chunk))))
  } catch {
    return undefined
  }
  if (raw.length < (stride + 1) * height) return undefined
  // Unfilter, scanline by scanline: every filter reads the previous *reconstructed*
  // row, so this cannot be vectorised into one pass over the buffer.
  const lines = new Uint8Array(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!
    const from = y * (stride + 1) + 1
    const to = y * stride
    const up = to - stride
    for (let x = 0; x < stride; x += 1) {
      const value = raw[from + x]!
      const left = x >= channels ? lines[to + x - channels]! : 0
      const above = y > 0 ? lines[up + x]! : 0
      const upLeft = y > 0 && x >= channels ? lines[up + x - channels]! : 0
      let reconstructed: number
      switch (filter) {
        case 0:
          reconstructed = value
          break
        case 1:
          reconstructed = value + left
          break
        case 2:
          reconstructed = value + above
          break
        case 3:
          reconstructed = value + ((left + above) >> 1)
          break
        case 4: {
          const estimate = left + above - upLeft
          const toLeft = Math.abs(estimate - left)
          const toAbove = Math.abs(estimate - above)
          const toUpLeft = Math.abs(estimate - upLeft)
          const predictor = toLeft <= toAbove && toLeft <= toUpLeft ? left : toAbove <= toUpLeft ? above : upLeft
          reconstructed = value + predictor
          break
        }
        default:
          return undefined
      }
      lines[to + x] = reconstructed & 0xff
    }
  }
  // Normalise every supported colour type to RGBA; the resampler only ever sees
  // one layout.
  const pixels = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    const source = index * channels
    const target = index * 4
    if (channels === 1) {
      pixels[target] = lines[source]!
      pixels[target + 1] = lines[source]!
      pixels[target + 2] = lines[source]!
      pixels[target + 3] = 255
    } else if (channels === 2) {
      pixels[target] = lines[source]!
      pixels[target + 1] = lines[source]!
      pixels[target + 2] = lines[source]!
      pixels[target + 3] = lines[source + 1]!
    } else if (channels === 3) {
      pixels[target] = lines[source]!
      pixels[target + 1] = lines[source + 1]!
      pixels[target + 2] = lines[source + 2]!
      pixels[target + 3] = 255
    } else {
      pixels[target] = lines[source]!
      pixels[target + 1] = lines[source + 1]!
      pixels[target + 2] = lines[source + 2]!
      pixels[target + 3] = lines[source + 3]!
    }
  }
  return { width, height, pixels }
}

/** One PNG chunk: length, type, data, CRC. */
function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/**
 * Encode RGBA pixels as a PNG.
 *
 * Filter 0 on every scanline: these are already-averaged thumbnail pixels, so an
 * adaptive filter would buy a few percent for a lot more code.
 */
export function encodePng(image: DecodedPng): Uint8Array {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(image.width, 0)
  header.writeUInt32BE(image.height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // truecolour with alpha
  const stride = image.width * 4
  const raw = Buffer.alloc((stride + 1) * image.height)
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (stride + 1)] = 0
    Buffer.from(image.pixels.buffer, image.pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ]))
}

/**
 * Area-average an RGBA image down to `targetWidth`.
 *
 * A box filter, not nearest-neighbour: the point of the thumbnail is that a
 * 2000-px picture still *looks* like itself at 512, and sampling one pixel in
 * sixteen turns thin structures (whiskers, text) into confetti.
 *
 * @param image - decoded RGBA source.
 * @param targetWidth - the requested width; a width >= the source is refused
 *   here so the caller never touches a bigger file than the original.
 * @returns the resized image, or `undefined` when no downscale is needed.
 */
export function downscalePng(image: DecodedPng, targetWidth: number): DecodedPng | undefined {
  if (targetWidth <= 0 || image.width <= targetWidth) return undefined
  const targetHeight = Math.max(1, Math.round((image.height * targetWidth) / image.width))
  const scaleX = image.width / targetWidth
  const scaleY = image.height / targetHeight
  const pixels = new Uint8Array(targetWidth * targetHeight * 4)
  for (let y = 0; y < targetHeight; y += 1) {
    const yFrom = Math.floor(y * scaleY)
    const yTo = Math.max(yFrom + 1, Math.min(image.height, Math.ceil((y + 1) * scaleY)))
    for (let x = 0; x < targetWidth; x += 1) {
      const xFrom = Math.floor(x * scaleX)
      const xTo = Math.max(xFrom + 1, Math.min(image.width, Math.ceil((x + 1) * scaleX)))
      let red = 0
      let green = 0
      let blue = 0
      let alpha = 0
      let count = 0
      for (let sy = yFrom; sy < yTo; sy += 1) {
        for (let sx = xFrom; sx < xTo; sx += 1) {
          const source = (sy * image.width + sx) * 4
          red += image.pixels[source]!
          green += image.pixels[source + 1]!
          blue += image.pixels[source + 2]!
          alpha += image.pixels[source + 3]!
          count += 1
        }
      }
      const target = (y * targetWidth + x) * 4
      pixels[target] = Math.round(red / count)
      pixels[target + 1] = Math.round(green / count)
      pixels[target + 2] = Math.round(blue / count)
      pixels[target + 3] = Math.round(alpha / count)
    }
  }
  return { width: targetWidth, height: targetHeight, pixels }
}

/** Where a given source file's thumbnail of `width` lives. */
function thumbPathOf(outputDir: string, target: string, stats: Stats, width: number): string {
  // The key covers the path *and* the file's identity: a re-drawn PNG under the
  // same name (rare, but `writeImages` never does it) can never be served stale.
  const key = createHash('sha256').update(`${target}|${String(stats.size)}|${String(stats.mtimeMs)}`).digest('hex')
  return join(outputDir, STUDIO_THUMB_DIR, 'thumbs', `${key.slice(0, 32)}-w${String(width)}.png`)
}

/**
 * What {@link thumbFor} hands back: either an already-cached file to stream, or
 * the bytes it just made (which the route serves without a second disk hop).
 */
type ThumbResult =
  | { readonly kind: 'cached'; readonly path: string }
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }

/**
 * Produce (or find) the thumbnail for one file, falling back to the original.
 *
 * The contract the route relies on: **this never throws**. A JPEG, a 16-bit PNG,
 * an unwritable cache directory or a corrupt IDAT all resolve to `undefined`,
 * and the route streams the original file instead. A missing thumbnail is a
 * performance problem; a 500 on an image is a broken canvas.
 */
async function thumbFor(
  outputDir: string,
  target: string,
  stats: Stats,
  width: number,
): Promise<ThumbResult | undefined> {
  const cachePath = thumbPathOf(outputDir, target, stats, width)
  try {
    const cached = await stat(cachePath)
    if (cached.isFile()) return { kind: 'cached', path: cachePath }
  } catch {
    // Not generated yet: fall through.
  }
  let source: Buffer
  try {
    source = await readFile(target)
  } catch {
    return undefined
  }
  const decoded = decodePng(source)
  if (decoded === undefined) return undefined
  const resized = downscalePng(decoded, width)
  if (resized === undefined) return undefined
  const bytes = encodePng(resized)
  try {
    await mkdir(join(outputDir, STUDIO_THUMB_DIR, 'thumbs'), { recursive: true })
    // Write beside the target and rename: a reader that arrives mid-write must
    // see either no file or a complete one.
    const staging = `${cachePath}.${String(process.pid)}.${String(Date.now())}.part`
    await writeFile(staging, bytes)
    await rename(staging, cachePath)
  } catch {
    // An unwritable cache is not a failed request: serve what we just made.
    return { kind: 'bytes', bytes }
  }
  return { kind: 'bytes', bytes }
}
