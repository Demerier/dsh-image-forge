/**
 * Loopback HTTP bridge for the settings page's one-click local deploy.
 *
 * The web client's cordis context only injects `slots` and `configForms` — there
 * is no client-side tool runner. A settings button that has to run
 * `install` + `fetch-weights` therefore needs a side channel that lives in the
 * **host** half, which is where those two operations already run. This module
 * starts a `127.0.0.1`-only server next to the plugin activation:
 *
 * - `GET  /status`  — venv / weights readiness, whether a deploy is running
 * - `POST /deploy`  — run venv install, then fetch the nf4 weights
 * - `OPTIONS`       — CORS preflight for the Host's own web origin
 *
 * It is deliberately tiny, binds loopback only, and never exposes config
 * writes: the only verbs are "how ready are we" and "please deploy".
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { stat } from 'node:fs/promises'
import type { ForgeSettings } from './tools.ts'
import { inspectWeights, runFetchWeights } from './weights.ts'
import { runInstall, venvPaths } from './venv.ts'

/** Default loopback port; `8411` sits next to the worker range `8399-8410`. */
export const DEFAULT_DEPLOY_PORT = 8411

/** What `GET /status` reports to the settings button. */
export interface DeployStatus {
  readonly ok: true
  readonly deploying: boolean
  readonly phase: string | null
  readonly venv: { readonly exists: boolean; readonly python: string }
  readonly weights: {
    readonly ready: boolean
    readonly dir: string
    readonly present: number
    readonly missing: number
    readonly total_MiB: number
  }
  readonly last: { readonly ok: boolean; readonly message: string; readonly at: string } | null
}

interface DeployState {
  deploying: boolean
  phase: string | null
  last: { ok: boolean; message: string; at: string } | null
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(text)
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  if (chunks.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function collectStatus(settings: ForgeSettings, state: DeployState): Promise<DeployStatus> {
  const paths = venvPaths(settings.runtimeDir)
  const python = settings.pythonPath.length > 0 ? settings.pythonPath : paths.python
  const venvExists = await stat(python).then(
    () => true,
    () => false,
  )
  const weights = await inspectWeights(settings.modelsDir)
  return {
    ok: true,
    deploying: state.deploying,
    phase: state.phase,
    venv: { exists: venvExists, python },
    weights: {
      ready: weights.ready,
      dir: settings.modelsDir,
      present: weights.present_files.length,
      missing: weights.missing_files.length,
      total_MiB: weights.total_MiB,
    },
    last: state.last,
  }
}

/** Process-wide singleton: tests register the tools many times per process. */
let shared: { server: Server; port: number; dispose: () => void } | null = null

/**
 * Start the deploy bridge. Idempotent: a second call in the same process returns
 * the server that is already listening, so a test that re-registers the tools
 * does not hit `EADDRINUSE`.
 *
 * @param settings - resolved plugin settings (runtime / weights paths).
 * @param port - loopback port to bind.
 * @returns the server, already listening, plus a disposer.
 */
export function startDeployServer(
  settings: ForgeSettings,
  port: number = DEFAULT_DEPLOY_PORT,
): { server: Server; port: number; dispose: () => void } {
  if (shared !== null) return shared
  const state: DeployState = { deploying: false, phase: null, last: null }
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        })
        res.end()
        return
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        json(res, 200, await collectStatus(settings, state))
        return
      }
      if (req.method === 'POST' && url.pathname === '/deploy') {
        if (state.deploying) {
          json(res, 409, { ok: false, error: 'a deploy is already running', phase: state.phase })
          return
        }
        const body = await readBody(req)
        const dryRun = body.dryRun === true
        const withWeights = body.weights !== false
        state.deploying = true
        state.phase = 'install'
        const startedAt = new Date().toISOString()
        try {
          const scratchDir = settings.scratchDir
          const install = await runInstall({
            runtimeDir: settings.runtimeDir,
            pipwrap: settings.pipwrapPath,
            basePythonCandidates: settings.basePythonCandidates,
            torchWheels: settings.torchWheels,
            pipIndexUrl: settings.pipIndexUrl,
            reuseBaseTorch: settings.reuseBaseTorch,
            dryRun,
            commandTimeoutMs: 3_600_000,
            scratchDir,
          })
          let fetchReport: unknown = null
          if (withWeights) {
            state.phase = 'fetch-weights'
            fetchReport = await runFetchWeights({
              repo: settings.modelRepo,
              mirror: settings.hfMirror,
              revision: 'main',
              dir: settings.modelsDir,
              skipLmHead: settings.skipLmHead,
              dryRun,
              force: false,
              scratchDir,
              stallTimeoutMs: 120_000,
            })
          }
          const ok = install.ok && (fetchReport as { ok?: boolean } | null)?.ok !== false
          state.last = {
            ok,
            message: ok
              ? dryRun
                ? 'dry-run 完成，未改动机器'
                : withWeights
                  ? '本地环境部署完成：venv + 权重'
                  : 'venv 安装完成'
              : install.next || '部署未完成，见步骤明细',
            at: startedAt,
          }
          state.deploying = false
          state.phase = null
          json(res, 200, { ok, dry_run: dryRun, install, weights: fetchReport, status: await collectStatus(settings, state) })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          state.last = { ok: false, message, at: startedAt }
          state.deploying = false
          state.phase = null
          json(res, 500, { ok: false, error: message })
        }
        return
      }
      json(res, 404, { ok: false, error: 'not found' })
    })().catch(() => {
      if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' })
    })
  })
  server.on('error', () => {
    // Port taken by a previous activation: the singleton already serves it.
  })
  server.listen(port, '127.0.0.1')
  // Unref so a test process (or a Host that is tearing down) can exit without
  // waiting on this side channel; the Host keeps the process alive on its own.
  server.unref()
  shared = {
    server,
    port,
    dispose: () => {
      try {
        server.close()
      } catch {
        // already gone
      }
      shared = null
    },
  }
  return shared
}
