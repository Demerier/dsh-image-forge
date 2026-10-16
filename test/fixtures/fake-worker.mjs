/**
 * A stand-in for `resources/worker.py`, used only by the lifecycle tests.
 *
 * It takes the same command line and speaks the same HTTP surface, but in node,
 * so the tests can exercise lazy start, restart-after-death, timeouts, port
 * fallback, `/unload` and idle reclaim without a GPU, a venv, or 10.6 GiB of
 * weights. `FAKE_WORKER_MODE` selects the failure it should act out.
 *
 * Modes
 *   ok               normal worker (default)
 *   crash            exits 3 with a CUDA-looking error on stderr, before binding
 *   crash-access-violation  exits 3221225477 (0xC0000005) before binding: what a
 *                    CUDA allocation failure during load actually looks like
 *   exit-silent      exits 0 before binding
 *   never-ready      binds, answers /state with loading=true forever
 *   generate-error   answers /generate with HTTP 500 and an error body
 *   die-on-generate  exits 9 the moment a /generate request arrives
 *   unload-404       /unload answers 404 (a worker that predates the endpoint)
 *   hang-after-generate  closes its socket after the first /generate but stays
 *                        alive: the "hung worker" case repair has to stop
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback
}

const port = Number(arg('--port', '0'))
const modelsDir = arg('--models-dir', '')
const dataDir = arg('--data-dir', '')
const mode = process.env.FAKE_WORKER_MODE ?? 'ok'
const readyAfterMs = Number(process.env.FAKE_WORKER_READY_MS ?? '0')

const startedAt = Date.now()
const state = { ready: readyAfterMs <= 0, loading: readyAfterMs > 0, generations: 0, unloaded: 0 }

/** Append one line to the event log the tests assert on. */
function record(event, extra = {}) {
  if (dataDir === '') return
  try {
    mkdirSync(dataDir, { recursive: true })
    appendFileSync(
      join(dataDir, 'fake-worker-events.jsonl'),
      `${JSON.stringify({ event, at: Date.now(), pid: process.pid, port, ...extra })}\n`,
    )
  } catch {
    /* the log is best-effort */
  }
}

function writeBreadcrumb() {
  if (dataDir === '') return
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(
      join(dataDir, 'worker-state.json'),
      JSON.stringify({ service: 'dsh-image-forge-worker', pid: process.pid, port, models_dir: modelsDir, started_at: startedAt, ready: state.ready }),
    )
  } catch {
    /* best-effort */
  }
}

if (mode === 'crash') {
  console.error('fake-worker: CUDA driver version is insufficient for CUDA runtime version')
  process.exit(3)
}
// What a CUDA allocation failure during load looks like from the outside on
// Windows: NTSTATUS 0xC0000005, and nothing in the log that names a cause.
if (mode === 'crash-access-violation') {
  console.error('fake-worker: loading pipeline from <models-dir>')
  process.exit(3221225477)
}
if (mode === 'exit-silent') process.exit(0)

// A one-pixel PNG, so a written file is a decodable image.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

const json = (response, code, payload) => {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length })
  response.end(body)
}

const server = createServer((request, response) => {
  const path = (request.url ?? '/').split('?')[0].replace(/\/$/, '') || '/'
  if (request.method === 'GET' && path === '/state') {
    return json(response, 200, {
      status: 'ok',
      service: 'dsh-image-forge-worker',
      version: 'fake-1',
      pid: process.pid,
      port,
      ready: state.ready,
      loading: state.loading,
      load_error: null,
      load_seconds: (Date.now() - startedAt) / 1000,
      generations: state.generations,
      models_dir: modelsDir,
      uptime_s: (Date.now() - startedAt) / 1000,
      rss_MiB: 42,
      vram_allocated_MiB: state.ready ? 4472 : 0,
      vram_reserved_MiB: state.ready ? 4600 : 0,
    })
  }
  if (request.method === 'GET' && path === '/health') {
    if (state.ready) return json(response, 200, { status: 'ok', service: 'dsh-image-forge-worker', model_loaded: true })
    return json(response, 503, { status: 'loading' })
  }
  if (request.method === 'POST' && path === '/shutdown') {
    record('shutdown', { port })
    json(response, 200, { status: 'ok', shutting_down: true, pid: process.pid })
    setTimeout(() => process.exit(0), 20)
    return
  }
  if (request.method === 'POST' && path === '/unload') {
    record('unload', { port })
    if (mode === 'unload-404') return json(response, 404, { error: 'not found' })
    const before = state.ready ? 4472 : 0
    state.ready = false
    state.unloaded += 1
    return json(response, 200, { unloaded: true, before: { vram_allocated_MiB: before }, after: { vram_allocated_MiB: 0 } })
  }
  if (request.method === 'POST' && path === '/generate') {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      record('generate', { port, body })
      if (mode === 'die-on-generate') process.exit(9)
      if (mode === 'generate-error') return json(response, 500, { error: 'CUDA out of memory. Tried to allocate 3.00 GiB' })
      state.generations += 1
      let parsed = {}
      try {
        parsed = JSON.parse(body)
      } catch {
        /* recorded raw above */
      }
      const count = Math.max(1, Number(parsed.count ?? 1))
      json(response, 200, {
        images: Array.from({ length: count }, () => PNG_BASE64),
        timings_s: Array.from({ length: count }, () => 0.01),
        // The shape the shipped worker reports for a real job's stage breakdown.
        stages_s: Array.from({ length: count }, () => ({
          encode_prompt_cpu: 0.31,
          denoise: 0.02,
          vae_decode: 0.01,
          prompt_tokens: 19,
        })),
        peak_vram_reserved_MiB: 4700,
      })
      if (mode === 'hang-after-generate') {
        // Close the listener but keep the process: HTTP refuses, the process lives.
        server.close()
        setInterval(() => {}, 1000)
      }
    })
    return
  }
  json(response, 404, { error: 'not found', path })
})

// `never-ready` binds and then pretends to load forever.
if (mode === 'never-ready') {
  state.ready = false
  state.loading = true
} else if (readyAfterMs > 0) {
  setTimeout(() => {
    state.ready = true
    state.loading = false
    writeBreadcrumb()
  }, readyAfterMs)
}

server.listen(port, '127.0.0.1', () => {
  console.log(`[fake-worker] listening on ${port} mode=${mode} pid=${process.pid}`)
  writeBreadcrumb()
  record('listening', { port, mode })
  if (mode !== 'never-ready' && readyAfterMs <= 0) state.ready = true
})
