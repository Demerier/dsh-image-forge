/**
 * Worker-lifecycle tests: the plugin starts, reaps and rebuilds its own worker.
 *
 * Everything here runs against `test/fixtures/fake-worker.mjs` — a node program
 * with the same command line and HTTP surface as the shipped `worker.py` — so
 * the failure paths that matter (worker will not start, never becomes ready,
 * dies mid-request, answers with an error, port already taken) are covered
 * without a GPU, a venv or 10.6 GiB of weights. The real worker is exercised
 * separately by `test/live-worker-e2e.mjs`.
 *
 * The weight tests run against a fake mirror on 127.0.0.1, which is what makes
 * resume, sha256 verification and the `lm_head` strip testable without
 * downloading 10.6 GiB.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as plugin from '../lib/index.js'

const FAKE_WORKER = fileURLToPath(new URL('./fixtures/fake-worker.mjs', import.meta.url))

/** Ask the OS for a free port, then hand it back for the test to race for. */
async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

/**
 * Ephemeral runtime for the whole file: a machine that already has
 * ~/.dsh-image-forge/venv must not make tests spawn that worker.
 */
const HERMETIC_RUNTIME = mkdtempSync(join(tmpdir(), 'forge-rt-'))

after(() => {
  rmSync(HERMETIC_RUNTIME, { recursive: true, force: true })
})

/** Register the plugin against a stub context and hand back the tool map. */
function register(config) {
  const tools = new Map()
  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    skills: { register: () => undefined },
  }
  plugin.apply(ctx, { ...plugin.Config({}), runtimeDir: HERMETIC_RUNTIME, ...config })
  return tools
}

/** Run one tool with a caller signal, the way the registry does. */
function run(tools, name, args) {
  const controller = new AbortController()
  return tools.get(name).execute(args, { signal: controller.signal })
}

/** Read the fake worker's event log for a runtime directory. */
function events(runtimeDir) {
  const path = join(runtimeDir, 'fake-worker-events.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

/** Poll until the predicate holds. */
async function waitFor(predicate, timeoutMs = 5000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  return false
}

/** Kill a process if it is still there; never fail the test over it. */
function kill(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid)) return
  try {
    process.kill(pid)
  } catch {
    /* already gone */
  }
}

/** Kill every fake worker that touched this runtime directory. */
function killAll(runtimeDir) {
  for (const pid of new Set(events(runtimeDir).map((entry) => entry.pid))) kill(pid)
}

/** A temp fixture set: runtime dir, output dir, and a weights directory. */
function fixture(prefix, { withWeights = true } = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), `${prefix}-runtime-`))
  const outputDir = mkdtempSync(join(tmpdir(), `${prefix}-out-`))
  const modelsDir = mkdtempSync(join(tmpdir(), `${prefix}-models-`))
  if (withWeights) {
    for (const relative of ['model_index.json', 'transformer/config.json', 'text_encoder/config.json', 'vae/config.json']) {
      const path = join(modelsDir, ...relative.split('/'))
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, '{}\n')
    }
  }
  return {
    runtimeDir,
    outputDir,
    modelsDir,
    cleanup: () => {
      killAll(runtimeDir)
      for (const dir of [runtimeDir, outputDir, modelsDir]) rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** The config every lifecycle test starts from. */
async function workerConfig(overrides = {}) {
  const port = await freePort()
  return {
    port,
    config: {
      backend: 'local',
      apiKey: '',
      pythonPath: process.execPath,
      workerScript: FAKE_WORKER,
      localEndpoint: `http://127.0.0.1:${port}`,
      workerPorts: `${port}-${port + 4}`,
      workerStartTimeoutMs: 15_000,
      idleUnloadMs: 0,
      manageWorker: true,
      minFreeVramMiB: 0,
      ...overrides,
    },
  }
}

/** Run one tool expecting a rejection; returns the error. */
async function fails(promise) {
  return promise.then(
    () => undefined,
    (caught) => caught,
  )
}

/** Run a test body with `FAKE_WORKER_MODE` set for its duration. */
async function withMode(mode, body) {
  const previous = process.env.FAKE_WORKER_MODE
  process.env.FAKE_WORKER_MODE = mode
  try {
    return await body()
  } finally {
    if (previous === undefined) delete process.env.FAKE_WORKER_MODE
    else process.env.FAKE_WORKER_MODE = previous
  }
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

test('the plugin starts the worker itself and the image lands on disk', async () => {
  const { port, config } = await workerConfig()
  const fx = fixture('forge-wl-start')
  try {
    const tools = register({ ...config, outputDir: fx.outputDir, runtimeDir: fx.runtimeDir, modelsDir: fx.modelsDir })
    const result = await run(tools, 'qwen_image_generate', { prompt: 'A brass compass.', wh_ratio: '1:1', seed: 5, steps: 8, count: 2 })
    console.log('worker report:', JSON.stringify(result.local_worker, null, 2))
    assert.equal(result.ok, true)
    assert.equal(result.backend, 'local')
    assert.equal(result.images.length, 2)
    assert.ok(existsSync(result.images[0].path), 'the PNG must be on disk')
    assert.equal(result.local_worker.started_by_plugin, true, 'the plugin must have started it')
    assert.equal(result.local_worker.port, port)
    assert.ok(result.local_worker.pid > 0)
    assert.equal(result.local_worker.ready, true)
    const sent = events(fx.runtimeDir).find((entry) => entry.event === 'generate')
    assert.ok(sent !== undefined, 'the worker must have received a /generate request')
    const body = JSON.parse(sent.body)
    assert.equal(body.width, 1248, 'the wh_ratio size must reach the worker')
    assert.equal(body.height, 1248)
    assert.equal(body.count, 2)
    assert.equal(body.steps, 8)
    assert.equal(body.seed, 5)
    assert.ok(existsSync(join(fx.runtimeDir, 'logs', `worker-${port}.log`)), 'the worker log must exist')
  } finally {
    fx.cleanup()
  }
})

test('a worker killed behind the plugin back is restarted on the next call', async () => {
  const { port, config } = await workerConfig()
  const fx = fixture('forge-wl-restart')
  try {
    const tools = register({ ...config, outputDir: fx.outputDir, runtimeDir: fx.runtimeDir, modelsDir: fx.modelsDir })
    const first = await run(tools, 'qwen_image_generate', { prompt: 'First.', wh_ratio: '1:1' })
    const firstPid = first.local_worker.pid
    console.log('first worker pid:', firstPid)
    process.kill(firstPid)
    const gone = await waitFor(async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/state`, { signal: AbortSignal.timeout(400) })
        return false
      } catch {
        return true
      }
    })
    assert.ok(gone, 'the killed worker must stop answering')
    const second = await run(tools, 'qwen_image_generate', { prompt: 'Second.', wh_ratio: '1:1' })
    console.log('second worker report:', JSON.stringify(second.local_worker, null, 2))
    assert.equal(second.ok, true)
    // A worker that is already dead when the call starts is detected up front, so
    // it is a plain start rather than a mid-request retry; either way the plugin
    // (not the user) rebuilt it.
    assert.equal(second.local_worker.started_by_plugin, true, 'the plugin must rebuild the worker')
    assert.notEqual(second.local_worker.pid, firstPid)
    assert.ok(second.local_worker.pid > 0)
    assert.equal(second.local_worker.endpoint, `http://127.0.0.1:${port}`)
  } finally {
    fx.cleanup()
  }
})

test('a worker that dies at startup reports its exit code and stderr', async () => {
  const { config } = await workerConfig()
  const fx = fixture('forge-wl-crash')
  try {
    await withMode('crash', async () => {
      const tools = register({ ...config, outputDir: fx.outputDir, runtimeDir: fx.runtimeDir, modelsDir: fx.modelsDir })
      const error = await fails(run(tools, 'qwen_image_generate', { prompt: 'x', wh_ratio: '1:1' }))
      console.log('startup-crash error:\n' + error.message)
      assert.ok(error instanceof Error)
      assert.match(error.message, /died while starting/)
      assert.match(error.message, /exit code 3/)
      assert.match(error.message, /CUDA driver version is insufficient/)
    })
  } finally {
    fx.cleanup()
  }
})

test('a worker that never becomes ready fails with the log tail instead of hanging', async () => {
  const { config } = await workerConfig({ workerStartTimeoutMs: 2500 })
  const fx = fixture('forge-wl-timeout')
  try {
    await withMode('never-ready', async () => {
      const tools = register({ ...config, outputDir: fx.outputDir, runtimeDir: fx.runtimeDir, modelsDir: fx.modelsDir })
      const startedAt = Date.now()
      const error = await fails(run(tools, 'qwen_image_generate', { prompt: 'x', wh_ratio: '1:1' }))
      const elapsed = Date.now() - startedAt
      console.log(`never-ready error after ${elapsed} ms:\n` + error.message)
      assert.ok(error instanceof Error)
      assert.match(error.message, /did not become ready within 3s/)
      assert.match(error.message, /listening on \d+ mode=never-ready/, 'the log tail must be quoted back')
      assert.ok(elapsed < 10_000, `the wait must be bounded by the config, took ${elapsed} ms`)
    })
  } finally {
    fx.cleanup()
  }
})

test('a foreign service on the preferred port is stepped over, not mistaken for a worker', async () => {
  const { port, config } = await workerConfig()
  const fx = fixture('forge-wl-port')
  const foreign = createServer((_request, response) => {
    response.writeHead(404, { 'Content-Type': 'application/json' })
    response.end('{"error":"not a worker"}')
  })
  try {
    await new Promise((resolve) => foreign.listen(port, '127.0.0.1', resolve))
    const tools = register({ ...config, outputDir: fx.outputDir, runtimeDir: fx.runtimeDir, modelsDir: fx.modelsDir })
    const result = await run(tools, 'qwen_image_generate', { prompt: 'x', wh_ratio: '1:1' })
    console.log('port fallback report:', JSON.stringify(result.local_worker, null, 2))
    assert.equal(result.ok, true)
    assert.notEqual(result.local_worker.port, port, 'the taken port must be skipped')
    assert.ok(result.local_worker.port > port)
  } finally {
    await new Promise((resolve) => foreign.close(resolve))
    fx.cleanup()
  }
})

test('POST /unload is issued and the freed VRAM is reported back', async () => {
  const { config } = await workerConfig()
  const fx = fixture('forge-wl-unload')
  try {
    const tools = register({ ...config, outputDir: fx.outputDir, runtimeDir: fx.runtimeDir, modelsDir: fx.modelsDir })
    await run(tools, 'qwen_image_generate', { prompt: 'x', wh_ratio: '1:1' })
    const unloaded = await run(tools, 'qwen_image_env', { action: 'unload' })
    console.log('unload result:', JSON.stringify(unloaded, null, 2))
    assert.equal(unloaded.ok, true)
    assert.equal(unloaded.vram_before_MiB, 4472)
    assert.equal(unloaded.vram_after_MiB, 0)
    assert.ok(events(fx.runtimeDir).some((entry) => entry.event === 'unload'), 'the worker must have received POST /unload')
  } finally {
    fx.cleanup()
  }
})

test('idle reclaim unloads the worker, and the next call reuses the same process', async () => {
  const { config } = await workerConfig({ idleUnloadMs: 600 })
  const fx = fixture('forge-wl-idle')
  try {
    const tools = register({ ...config, outputDir: fx.outputDir, runtimeDir: fx.runtimeDir, modelsDir: fx.modelsDir })
    const first = await run(tools, 'qwen_image_generate', { prompt: 'x', wh_ratio: '1:1' })
    const reclaimed = await waitFor(() => Promise.resolve(events(fx.runtimeDir).some((entry) => entry.event === 'unload')), 6000)
    console.log('idle unload events:', JSON.stringify(events(fx.runtimeDir).map((entry) => entry.event)))
    assert.ok(reclaimed, 'the idle timer must have issued POST /unload')
    const second = await run(tools, 'qwen_image_generate', { prompt: 'y', wh_ratio: '1:1' })
    assert.equal(second.ok, true)
    assert.equal(second.local_worker.pid, first.local_worker.pid, 'the same process is reused after an unload')
  } finally {
    fx.cleanup()
  }
})

test('with management disabled the plugin refuses to start anything', async () => {
  const { config } = await workerConfig({ manageWorker: false })
  const fx = fixture('forge-wl-managed-off')
  try {
    const tools = register({ ...config, outputDir: fx.outputDir, runtimeDir: fx.runtimeDir, modelsDir: fx.modelsDir })
    const error = await fails(run(tools, 'qwen_image_generate', { prompt: 'x', wh_ratio: '1:1' }))
    console.log('management-off error:\n' + error.message)
    assert.match(error.message, /worker management is off/)
    assert.equal(events(fx.runtimeDir).length, 0, 'nothing may be spawned when management is off')
  } finally {
    fx.cleanup()
  }
})

test('an error body from /generate is surfaced with the worker text', async () => {
  const { config } = await workerConfig()
  const fx = fixture('forge-wl-generr')
  try {
    await withMode('generate-error', async () => {
      const tools = register({ ...config, outputDir: fx.outputDir, runtimeDir: fx.runtimeDir, modelsDir: fx.modelsDir })
      const error = await fails(run(tools, 'qwen_image_generate', { prompt: 'x', wh_ratio: '1:1' }))
      console.log('worker /generate error:\n' + error.message)
      assert.ok(error instanceof Error)
      assert.match(error.message, /answered HTTP 500/)
      assert.match(error.message, /CUDA out of memory/)
    })
  } finally {
    fx.cleanup()
  }
})

test('a worker that dies mid-request is rebuilt, and a second death is reported not retried forever', async () => {
  const { config } = await workerConfig()
  const fx = fixture('forge-wl-diegens')
  try {
    await withMode('die-on-generate', async () => {
      const tools = register({ ...config, outputDir: fx.outputDir, runtimeDir: fx.runtimeDir, modelsDir: fx.modelsDir })
      const error = await fails(run(tools, 'qwen_image_generate', { prompt: 'x', wh_ratio: '1:1' }))
      console.log('die-on-generate error:\n' + error.message)
      assert.ok(error instanceof Error)
      // Two workers were started: the original and the rebuild after the transport failure.
      const started = new Set(events(fx.runtimeDir).filter((entry) => entry.event === 'listening').map((entry) => entry.pid))
      console.log('workers started during the call:', [...started])
      assert.ok(started.size >= 2, 'the plugin must have rebuilt the worker after it died')
    })
  } finally {
    fx.cleanup()
  }
})

test('env status tells never-started, ready and not-responding apart', async () => {
  const { config } = await workerConfig()
  const fx = fixture('forge-wl-states')
  try {
    const tools = register({ ...config, outputDir: fx.outputDir, runtimeDir: fx.runtimeDir, modelsDir: fx.modelsDir })
    const cold = await run(tools, 'qwen_image_env', { action: 'status' })
    console.log('never-started:', JSON.stringify({ state: cold.local_runtime.worker.state, explanation: cold.local_runtime.worker.explanation, ready: cold.local_runtime.ready_to_generate }, null, 2))
    assert.equal(cold.local_runtime.worker.state, 'never-started')
    assert.match(cold.local_runtime.worker.explanation, /自动拉起|从未启动/)

    await run(tools, 'qwen_image_generate', { prompt: 'x', wh_ratio: '1:1' })
    const live = await run(tools, 'qwen_image_env', { action: 'status' })
    console.log('ready:', JSON.stringify({ state: live.local_runtime.worker.state, pid: live.local_runtime.worker.pid, generations: live.local_runtime.worker.generations }, null, 2))
    assert.equal(live.local_runtime.worker.state, 'ready')
    assert.equal(live.local_runtime.worker.reachable, true)

    process.kill(live.local_runtime.worker.pid)
    let after = null
    await waitFor(async () => {
      after = await run(tools, 'qwen_image_env', { action: 'status' })
      return after.local_runtime.worker.state === 'not-responding'
    }, 8000)
    console.log('not-responding:', JSON.stringify({ state: after.local_runtime.worker.state, explanation: after.local_runtime.worker.explanation, events: after.local_runtime.worker.lifecycle_events }, null, 2))
    assert.equal(after.local_runtime.worker.state, 'not-responding', 'an externally killed worker must be reported as not-responding, not as a config error')
    assert.match(after.local_runtime.worker.explanation, /不是配置问题|自动重拉/)
    assert.ok(after.local_runtime.worker.lifecycle_events.some((event) => event.event === 'exit'), 'the plugin must have seen the child exit')
  } finally {
    fx.cleanup()
  }
})

test('a failed start is reported again instead of spawning on every call (backoff)', async () => {
  const { config } = await workerConfig()
  const fx = fixture('forge-wl-backoff')
  try {
    await withMode('crash', async () => {
      const tools = register({ ...config, outputDir: fx.outputDir, runtimeDir: fx.runtimeDir, modelsDir: fx.modelsDir })
      const first = await fails(run(tools, 'qwen_image_generate', { prompt: 'x', wh_ratio: '1:1' }))
      assert.match(first.message, /died while starting/)
      const second = await fails(run(tools, 'qwen_image_generate', { prompt: 'x', wh_ratio: '1:1' }))
      console.log('second attempt during cooldown:\n' + second.message)
      assert.match(second.message, /last start attempt failed|Not retrying/)
      const spawned = events(fx.runtimeDir).length
      assert.equal(spawned, 0, 'a crashed worker never reaches the event log')
    })
  } finally {
    fx.cleanup()
  }
})

test('a worker without /unload is reported, not silently declared reclaimed', async () => {
  const { config } = await workerConfig()
  const fx = fixture('forge-wl-unload404')
  try {
    await withMode('unload-404', async () => {
      const tools = register({ ...config, outputDir: fx.outputDir, runtimeDir: fx.runtimeDir, modelsDir: fx.modelsDir })
      await run(tools, 'qwen_image_generate', { prompt: 'x', wh_ratio: '1:1' })
      const unloaded = await run(tools, 'qwen_image_env', { action: 'unload' })
      console.log('unload-404 result:', JSON.stringify({ ok: unloaded.ok, http_status: unloaded.http_status, note: unloaded.note }, null, 2))
      assert.equal(unloaded.ok, false)
      assert.equal(unloaded.http_status, 404)
      assert.match(unloaded.note, /没有 \/unload/)
    })
  } finally {
    fx.cleanup()
  }
})

test('repair stops a worker this session owns but that no longer answers, and says so', async () => {
  const { config } = await workerConfig()
  const fx = fixture('forge-wl-hung')
  try {
    await withMode('hang-after-generate', async () => {
      // This test is about the *worker* check, so keep `repair`'s environment branch
      // degenerate: with the install path working, `repair` would otherwise run a real
      // venv + CUDA torch install (gigabytes) inside the fixture. A basePython that
      // cannot exist makes `runInstall` fail fast and deterministically.
      const tools = register({ ...config, outputDir: fx.outputDir, runtimeDir: fx.runtimeDir, modelsDir: fx.modelsDir, basePython: 'no-such-python-for-tests' })
      const first = await run(tools, 'qwen_image_generate', { prompt: 'x', wh_ratio: '1:1' })
      const pid = first.local_worker.pid
      // The worker closes its socket but stays alive: HTTP refuses, the process does not exit.
      const dead = await waitFor(async () => {
        try {
          await fetch(`http://127.0.0.1:${first.local_worker.port}/state`, { signal: AbortSignal.timeout(500) })
          return false
        } catch {
          return true
        }
      }, 8000)
      assert.ok(dead, 'the hung worker must stop answering')
      const report = await run(tools, 'qwen_image_env', { action: 'repair' })
      const workerCheck = report.checks.find((check) => check.name === 'worker')
      console.log('repair on a hung worker:', JSON.stringify({ checks: report.checks.map((check) => `${check.name}=${check.status}`), worker: workerCheck }, null, 2))
      assert.equal(workerCheck.status, 'fixed')
      assert.match(workerCheck.detail, /stopped the unresponsive worker/)
      // `fixed` now means the child's exit event was observed, which is the only
      // liveness proof available here (`process.kill(pid, 0)` and even `SIGTERM`
      // both throw ESRCH on Windows under this sandbox). Confirm end to end as
      // well: the next generation must come up cleanly with a new pid.
      const next = await run(tools, 'qwen_image_generate', { prompt: 'after repair', wh_ratio: '1:1' })
      console.log('after the repair:', JSON.stringify(next.local_worker, null, 2))
      assert.equal(next.ok, true)
      assert.notEqual(next.local_worker.pid, pid)
      assert.equal(next.local_worker.started_by_plugin, true)
    })
  } finally {
    fx.cleanup()
  }
})

test('repair reports a pid it does not own instead of killing it', async () => {
  const { config } = await workerConfig()
  const fx = fixture('forge-wl-foreign-pid')
  try {
    // The "stranger" is this very test process: it is definitely alive, and if
    // the plugin ever killed a pid it does not own, this test would not finish.
    writeFileSync(
      join(fx.runtimeDir, 'worker-state.json'),
      JSON.stringify({ service: 'dsh-image-forge-worker', pid: process.pid, port: config.localEndpoint.split(':').pop(), ready: true }),
    )
    const tools = register({
      backend: 'local',
      apiKey: '',
      outputDir: fx.outputDir,
      runtimeDir: fx.runtimeDir,
      modelsDir: fx.modelsDir,
      pythonPath: process.execPath,
      workerScript: FAKE_WORKER,
      localEndpoint: config.localEndpoint,
      // Same reason as the hung-worker case above: keep the environment branch out of
      // this worker-state test so it never starts a real multi-gigabyte install.
      basePython: 'no-such-python-for-tests',
    })
    const report = await run(tools, 'qwen_image_env', { action: 'repair' })
    const workerCheck = report.checks.find((check) => check.name === 'worker')
    console.log('repair with a foreign pid:', JSON.stringify(workerCheck, null, 2))
    assert.equal(workerCheck.status, 'unfixable')
    assert.match(workerCheck.detail, /will not kill a pid it does not own/)
    assert.match(workerCheck.remedy, /taskkill/)
    assert.match(workerCheck.remedy, new RegExp(`PID ${process.pid}`))
  } finally {
    fx.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Weights, install and repair — against a fake mirror and fake files
// ---------------------------------------------------------------------------

/** Build a `.safetensors` buffer from raw tensor payloads. */
function buildSafetensors(entries) {
  const header = {}
  const parts = []
  let offset = 0
  for (const entry of entries) {
    header[entry.name] = { dtype: entry.dtype, shape: entry.shape, data_offsets: [offset, offset + entry.data.length] }
    offset += entry.data.length
    parts.push(entry.data)
  }
  const raw = Buffer.from(JSON.stringify(header), 'utf8')
  const padded = Buffer.alloc(Math.ceil(raw.length / 8) * 8, 0x20)
  raw.copy(padded)
  const length = Buffer.alloc(8)
  length.writeBigUInt64LE(BigInt(padded.length))
  return Buffer.concat([length, padded, ...parts])
}

/** Read a `.safetensors` buffer's header. */
function readSafetensorsHeader(buffer) {
  const length = Number(buffer.readBigUInt64LE(0))
  return JSON.parse(buffer.subarray(8, 8 + length).toString('utf8'))
}

/**
 * A mirror that serves a repo tree plus resumable file downloads.
 *
 * @param files - repo-relative path → bytes.
 * @returns the mirror's origin, the tree URL it expects, and a request log.
 */
async function startFakeMirror(files) {
  const requests = []
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    requests.push({ method: request.method, path: url.pathname, range: request.headers.range ?? null })
    if (url.pathname.includes('/api/models/') && url.pathname.endsWith('/tree/main')) {
      const tree = Object.entries(files).map(([path, buffer]) => ({
        type: 'file',
        path,
        size: buffer.length,
        lfs: { oid: createHash('sha256').update(buffer).digest('hex'), size: buffer.length },
      }))
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(tree))
      return
    }
    const marker = '/resolve/main/'
    const index = url.pathname.indexOf(marker)
    if (index >= 0) {
      const relative = url.pathname.slice(index + marker.length)
      const buffer = files[relative]
      if (buffer === undefined) {
        response.writeHead(404)
        response.end('missing')
        return
      }
      const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? '')
      if (range !== null) {
        const start = Number(range[1])
        const slice = buffer.subarray(start)
        response.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': slice.length,
          'Content-Range': `bytes ${start}-${buffer.length - 1}/${buffer.length}`,
        })
        response.end(slice)
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buffer.length })
      response.end(buffer)
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    origin: `http://127.0.0.1:${port}`,
    repo: 'test/tiny-repo',
    files,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** The tiny repo every weights test uses. */
function tinyRepo() {
  const big = Buffer.alloc(64 * 1024, 7)
  return {
    'model_index.json': Buffer.from('{"_class_name":"QwenImage21Pipeline"}\n'),
    'transformer/config.json': Buffer.from('{"quantization_config":{"load_in_4bit":true}}\n'),
    'text_encoder/config.json': Buffer.from('{"quantization_config":{"load_in_4bit":true}}\n'),
    'vae/config.json': Buffer.from('{}\n'),
    'vae/diffusion_pytorch_model.safetensors': big,
  }
}

test('fetch-weights plans from the mirror without touching the disk', async () => {
  const mirror = await startFakeMirror(tinyRepo())
  const target = mkdtempSync(join(tmpdir(), 'forge-wl-dry-'))
  try {
    const tools = register({
      backend: 'local',
      apiKey: '',
      outputDir: target,
      runtimeDir: target,
      modelsDir: join(target, 'models'),
      modelsDirOverride: undefined,
      hfMirror: mirror.origin,
      modelRepo: mirror.repo,
      pythonPath: process.execPath,
    })
    const plan = await run(tools, 'qwen_image_env', { action: 'fetch-weights', dryRun: true })
    console.log('dry-run plan:', JSON.stringify({ listing_source: plan.listing_source, planned_MiB: plan.planned_MiB, disk: plan.disk, files: plan.files.length }, null, 2))
    assert.equal(plan.dry_run, true)
    assert.equal(plan.listing_source, 'api')
    assert.equal(plan.files.length, Object.keys(mirror.files).length)
    // A plan must not read as "done": these files are all *missing*, so they are
    // `would-download`, and `next` must not claim the weights are ready.
    assert.ok(plan.files.every((file) => file.status === 'would-download'))
    assert.equal(plan.dry_run_skipped, 'nothing was downloaded; this is a plan')
    assert.doesNotMatch(plan.next, /Weights ready/)
    assert.ok(plan.disk.neededMiB > 0)
    assert.ok(!existsSync(join(target, 'models', 'model_index.json')), 'a dry run must not download anything')
  } finally {
    await mirror.close()
    rmSync(target, { recursive: true, force: true })
  }
})

test('fetch-weights dry-run says nothing is left to download when every file is already there', async () => {
  const mirror = await startFakeMirror(tinyRepo())
  const target = mkdtempSync(join(tmpdir(), 'forge-wl-dry-ready-'))
  const modelsDir = join(target, 'models')
  try {
    // Place every file at exactly the size the mirror reports, as a finished fetch leaves them.
    for (const [relative, buffer] of Object.entries(mirror.files)) {
      const path = join(modelsDir, ...relative.split('/'))
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, buffer)
    }
    const tools = register({
      backend: 'local',
      apiKey: '',
      outputDir: target,
      runtimeDir: target,
      modelsDir,
      hfMirror: mirror.origin,
      modelRepo: mirror.repo,
      pythonPath: process.execPath,
    })
    const plan = await run(tools, 'qwen_image_env', { action: 'fetch-weights', dryRun: true })
    console.log('dry-run plan (all present):', JSON.stringify({ planned_MiB: plan.planned_MiB, files: plan.files.map((file) => `${file.path}=${file.status}`), next: plan.next }, null, 2))
    assert.ok(plan.files.every((file) => file.status === 'reused'))
    assert.equal(plan.disk.neededMiB, 0)
    // The mirror must not even be asked for a byte range, and the wording must not promise
    // a download that is not needed.
    assert.equal(
      mirror.requests.filter((request) => request.path.includes('/resolve/')).length,
      0,
      'a plan over complete files must not request any file body',
    )
    assert.match(plan.next, /already on disk and complete/)
    assert.doesNotMatch(plan.next, /file\(s\) are missing/)
  } finally {
    await mirror.close()
    rmSync(target, { recursive: true, force: true })
  }
})

test('fetch-weights resumes a partial file, verifies sha256, and applies the bnb split flag', async () => {
  const mirror = await startFakeMirror(tinyRepo())
  const target = mkdtempSync(join(tmpdir(), 'forge-wl-fetch-'))
  const modelsDir = join(target, 'models')
  try {
    // Leave a half-written file behind, exactly as an interrupted download would.
    const rel = 'vae/diffusion_pytorch_model.safetensors'
    mkdirSync(join(modelsDir, 'vae'), { recursive: true })
    const full = mirror.files[rel]
    writeFileSync(join(modelsDir, 'vae', 'diffusion_pytorch_model.safetensors'), full.subarray(0, 32 * 1024))
    const tools = register({
      backend: 'local',
      apiKey: '',
      outputDir: target,
      runtimeDir: target,
      modelsDir,
      hfMirror: mirror.origin,
      modelRepo: mirror.repo,
      pythonPath: process.execPath,
    })
    const report = await run(tools, 'qwen_image_env', { action: 'fetch-weights' })
    console.log('fetch report:', JSON.stringify({ ok: report.ok, files: report.files, quantization: report.quantization }, null, 2))
    assert.equal(report.ok, true)
    const resumed = report.files.find((file) => file.path === rel)
    assert.equal(resumed.status, 'resumed', 'a partial file must be continued, not restarted')
    assert.equal(resumed.sha256_verified, true, 'the LFS sha256 must be checked while streaming')
    assert.deepEqual(readFileSync(join(modelsDir, 'vae', 'diffusion_pytorch_model.safetensors')), full)
    const ranged = mirror.requests.filter((request) => request.range !== null)
    assert.equal(ranged.length, 1, 'exactly one file should have needed a Range request')
    assert.equal(report.quantization['transformer/config.json'], 'patched')
    assert.equal(report.quantization['text_encoder/config.json'], 'patched')
    const patched = JSON.parse(readFileSync(join(modelsDir, 'transformer', 'config.json'), 'utf8'))
    assert.equal(patched.quantization_config.llm_int8_enable_fp32_cpu_offload, true)
  } finally {
    await mirror.close()
    rmSync(target, { recursive: true, force: true })
  }
})

test('fetch-weights can drop lm_head.weight from the text encoder and keeps the file valid', async () => {
  const encoder = buildSafetensors([
    { name: 'model.embed_tokens.weight', dtype: 'F32', shape: [2], data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]) },
    { name: 'lm_head.weight', dtype: 'F32', shape: [2], data: Buffer.alloc(16, 9) },
    { name: 'model.norm.weight', dtype: 'F32', shape: [2], data: Buffer.from([10, 11, 12, 13, 14, 15, 16, 17]) },
  ])
  const mirror = await startFakeMirror({ ...tinyRepo(), 'text_encoder/model.safetensors': encoder })
  const target = mkdtempSync(join(tmpdir(), 'forge-wl-lmhead-'))
  const modelsDir = join(target, 'models')
  try {
    const tools = register({
      backend: 'local',
      apiKey: '',
      outputDir: target,
      runtimeDir: target,
      modelsDir,
      hfMirror: mirror.origin,
      modelRepo: mirror.repo,
      pythonPath: process.execPath,
    })
    const report = await run(tools, 'qwen_image_env', { action: 'fetch-weights', skipLmHead: true })
    console.log('lm_head strip:', JSON.stringify(report.lm_head, null, 2))
    assert.equal(report.lm_head.removed, true)
    assert.equal(report.lm_head.savedMiB, 0, 'the synthetic tensor is 16 bytes, i.e. 0 MiB')
    assert.equal(report.lm_head.savedBytes, 16)
    const stripped = readFileSync(join(modelsDir, 'text_encoder', 'model.safetensors'))
    const header = readSafetensorsHeader(stripped)
    assert.ok(!('lm_head.weight' in header), 'lm_head.weight must be gone')
    assert.deepEqual(header['model.embed_tokens.weight'].data_offsets, [0, 8])
    assert.deepEqual(header['model.norm.weight'].data_offsets, [8, 16], 'later offsets must shift down')
    // The file shrinks by the tensor *and* by the shorter header entry.
    const paddedHeaderLength = Number(stripped.readBigUInt64LE(0))
    assert.equal(stripped.length, 8 + paddedHeaderLength + 16)
    assert.ok(stripped.length < encoder.length, 'the rewritten file must be smaller')
    assert.deepEqual(
      stripped.subarray(-8),
      Buffer.from([10, 11, 12, 13, 14, 15, 16, 17]),
      'the surviving tensor bytes must be copied verbatim',
    )
  } finally {
    await mirror.close()
    rmSync(target, { recursive: true, force: true })
  }
})

test('install dry run reports a plan and creates nothing', async () => {
  const target = mkdtempSync(join(tmpdir(), 'forge-wl-install-'))
  try {
    const tools = register({
      backend: 'local',
      apiKey: '',
      outputDir: target,
      runtimeDir: join(target, 'runtime'),
      modelsDir: join(target, 'runtime', 'models'),
      basePython: process.env.FORGE_TEST_PYTHON ?? 'python',
    })
    const plan = await run(tools, 'qwen_image_env', { action: 'install', dryRun: true })
    console.log('install plan:', JSON.stringify({ ok: plan.ok, base: plan.base_python, steps: plan.steps }, null, 2))
    assert.equal(plan.dry_run, true)
    if (plan.base_python === null || plan.base_python.ok !== true) {
      // No python on PATH: the honest answer is the failure, not a fake plan.
      console.log('no usable base interpreter on PATH; asserting the reported failure instead')
      assert.equal(plan.ok, false)
      assert.equal(plan.steps[0].status, 'failed')
    } else {
      assert.equal(plan.ok, true)
      assert.ok(plan.steps.some((step) => step.name === 'torch' && step.status === 'planned'))
      assert.ok(plan.steps.some((step) => step.name === 'packages' && step.status === 'planned'))
    }
    assert.ok(!existsSync(join(target, 'runtime', 'venv')), 'a dry run must not create a venv')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('repair calls a missing weight set unfixable instead of pretending', async () => {
  const fx = fixture('forge-wl-repair', { withWeights: false })
  try {
    const tools = register({
      backend: 'local',
      apiKey: '',
      outputDir: fx.outputDir,
      runtimeDir: fx.runtimeDir,
      modelsDir: fx.modelsDir,
      pythonPath: process.execPath,
      workerScript: FAKE_WORKER,
    })
    const report = await run(tools, 'qwen_image_env', { action: 'repair', dryRun: true })
    console.log('repair report:', JSON.stringify(report, null, 2))
    assert.equal(report.action, 'repair')
    assert.equal(report.ok, false)
    const weights = report.checks.find((check) => check.name === 'weights')
    assert.equal(weights.status, 'unfixable')
    assert.match(weights.remedy, /fetch-weights/)
    assert.equal(report.weights.ready, false)
    assert.ok(!existsSync(join(fx.runtimeDir, 'venv')), 'a dry run must not create a venv')
  } finally {
    fx.cleanup()
  }
})
