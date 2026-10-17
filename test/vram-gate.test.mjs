/**
 * The pre-start VRAM gate, the opt-in ComfyUI `/free`, and the crash fallback.
 *
 * What is being covered, and why each one needs a test rather than a comment:
 *
 * 1. A worker that cannot allocate its transformer does not report an OOM on this
 *    host — it exits as `0xC0000005`, which tells the user nothing. So the plugin
 *    must refuse to start it, and when it still dies it must say why.
 * 2. Unloading *another program's* models is a side effect the user never asked
 *    for, so the default path must issue no request at all. That is asserted by
 *    counting requests on a fake ComfyUI, not by trusting a comment.
 *
 * The fake worker supplies the process, the fake ComfyUI supplies the `/free`
 * endpoint, and the GPU numbers come from the real `nvidia-smi` — the threshold is
 * simply pushed far above whatever it reports, so no test ever needs to occupy
 * VRAM. When `nvidia-smi` is absent the gate deliberately allows a start (it will
 * not block on a card it cannot read), so the GPU-dependent tests detect that and
 * skip instead of failing.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyseVram, vramSuspicionWarning } from '../src/env.ts'
import { WorkerRuntime } from '../src/worker.ts'

const FAKE_WORKER = fileURLToPath(new URL('./fixtures/fake-worker.mjs', import.meta.url))

/** Above the free VRAM of any card this plugin runs on, so a read card always refuses. */
const HUGE = 10_000_000

/** What a refusal quotes back, so the numbers can be checked for consistency. */
const GATE_NUMBERS = /空闲 (\d+|) MiB \/ (\d+|) MiB，需要至少 (\d+) MiB；还差 (\d+) MiB/

/**
 * Ephemeral runtime: a machine that already has ~/.dsh-image-forge/venv must
 * not make these tests spawn that worker.
 */
const HERMETIC_RUNTIME = mkdtempSync(join(tmpdir(), 'forge-rt-'))

after(() => {
  rmSync(HERMETIC_RUNTIME, { recursive: true, force: true })
})

async function register(config) {
  const plugin = await import('../lib/index.js')
  const tools = new Map()
  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    skills: { register: () => undefined },
  }
  plugin.apply(ctx, { ...plugin.Config({}), runtimeDir: HERMETIC_RUNTIME, ...config })
  return tools
}

function run(tools, name, args) {
  const controller = new AbortController()
  return tools.get(name).execute(args, { signal: controller.signal })
}

async function fails(promise) {
  return promise.then(
    () => undefined,
    (caught) => caught,
  )
}

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

/** Ask the OS for a free port, then hand it back so the caller can race for it. */
async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

/**
 * A ComfyUI that answers only what this test needs: it counts `POST /free` and
 * records the body, which is how "the default path touched nothing" is proven.
 */
async function fakeComfyUi() {
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, body })
      if (request.method === 'POST' && request.url === '/free') {
        const payload = Buffer.from(JSON.stringify({ ok: true, freed_MiB: 7806 }), 'utf8')
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': payload.length })
        return response.end(payload)
      }
      const payload = Buffer.from(JSON.stringify({ system: { comfyui_version: 'fake' }, devices: [] }), 'utf8')
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': payload.length })
      response.end(payload)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    port,
    requests,
    freeCalls: () => requests.filter((entry) => entry.method === 'POST' && entry.url === '/free'),
    cleanup: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** A temp fixture set: runtime dir, output dir, weights dir. */
function fixture(prefix) {
  const runtimeDir = mkdtempSync(join(tmpdir(), `${prefix}-runtime-`))
  const outputDir = mkdtempSync(join(tmpdir(), `${prefix}-out-`))
  const modelsDir = mkdtempSync(join(tmpdir(), `${prefix}-models-`))
  for (const relative of ['model_index.json', 'transformer/config.json', 'text_encoder/config.json', 'vae/config.json']) {
    const path = join(modelsDir, ...relative.split('/'))
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '{}\n')
  }
  /** Worker pids this fixture's fake workers reported, so they can be reaped. */
  const eventsPath = join(runtimeDir, 'fake-worker-events.jsonl')
  const killAll = () => {
    if (!existsSync(eventsPath)) return
    for (const line of readFileSync(eventsPath, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue
      try {
        process.kill(JSON.parse(line).pid)
      } catch {
        /* already gone */
      }
    }
  }
  return {
    runtimeDir,
    outputDir,
    modelsDir,
    /** The worker log the runtime writes before spawning, and only then. */
    logFor: (port) => join(runtimeDir, 'logs', `worker-${port}.log`),
    cleanup: () => {
      killAll()
      for (const dir of [runtimeDir, outputDir, modelsDir]) rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** The config every test here starts from: a fake worker on a private port. */
async function baseConfig(overrides = {}) {
  const port = await freePort()
  const fx = fixture('forge-gate')
  const config = {
    backend: 'local',
    apiKey: '',
    pythonPath: process.execPath,
    workerScript: FAKE_WORKER,
    localEndpoint: `http://127.0.0.1:${port}`,
    workerPorts: `${port}-${port + 3}`,
    workerStartTimeoutMs: 15_000,
    idleUnloadMs: 0,
    manageWorker: true,
    outputDir: fx.outputDir,
    runtimeDir: fx.runtimeDir,
    modelsDir: fx.modelsDir,
    ...overrides,
  }
  return { port, fx, config }
}

// ---------------------------------------------------------------------------
// The gate refuses a start it cannot pay for
// ---------------------------------------------------------------------------

test('the gate refuses to start the worker when free VRAM is below the floor, and hands over the command', async () => {
  const comfy = await fakeComfyUi()
  const { port, fx, config } = await baseConfig({ comfyPorts: String(comfy.port) })
  try {
    // Far above anything this card reports, so the refusal is deterministic.
    const tools = await register({ ...config, minFreeVramMiB: HUGE })
    const error = await fails(run(tools, 'qwen_image_generate', { prompt: 'A brass compass.', wh_ratio: '1:1' }))
    if (error === undefined) {
      console.log('SKIP: nvidia-smi is unavailable, and the gate deliberately allows a start without it')
      return
    }
    console.log('\n--- gate refusal ---\n' + error.message + '\n--- end ---')
    assert.match(error.message, /显存余量不足，拒绝拉起 worker/)
    const numbers = GATE_NUMBERS.exec(error.message)
    assert.ok(numbers !== null, `the refusal must quote what it measured: ${error.message}`)
    assert.equal(Number(numbers[3]), HUGE, 'the refusal must name the floor it compared against')
    assert.equal(Number(numbers[4]), HUGE - Number(numbers[1]), 'the shortfall must be floor minus free')
    assert.match(
      error.message,
      new RegExp(`curl -X POST http://127\\.0\\.0\\.1:${comfy.port}/free`),
      'the refusal must carry the executable remedy, on the configured ComfyUI port',
    )
    assert.match(error.message, /unload_models\\?":true/, 'the /free body must be spelled out')
    assert.match(error.message, /0xC0000005/, 'the refusal must explain what a hard start would look like')
    assert.equal(existsSync(fx.logFor(port)), false, 'nothing may be spawned when the gate refuses')
    assert.equal(comfy.freeCalls().length, 0, 'the default path must not touch ComfyUI')
    assert.match(error.message, /freeComfyBeforeLocalStart/)
  } finally {
    fx.cleanup()
    await comfy.cleanup()
  }
})

test('the remedy names the ComfyUI that answers, not the first port in the configured list', async () => {
  const comfy = await fakeComfyUi()
  const closed = await freePort()
  const { port, fx, config } = await baseConfig({ comfyPorts: `${closed},${comfy.port}` })
  try {
    const tools = await register({ ...config, minFreeVramMiB: HUGE })
    const error = await fails(run(tools, 'qwen_image_generate', { prompt: 'A brass compass.', wh_ratio: '1:1' }))
    if (error === undefined) {
      console.log('SKIP: nvidia-smi is unavailable, and the gate deliberately allows a start without it')
      return
    }
    console.log('\n--- gate refusal, first candidate closed ---\n' + error.message + '\n--- end ---')
    // `comfyPorts` is a search list: printing a command for its first entry hands the user
    // a dead port, and `freeComfyBeforeLocalStart` would post `/free` into nothing.
    assert.match(
      error.message,
      new RegExp(`curl -X POST http://127\\.0\\.0\\.1:${comfy.port}/free`),
      'the remedy must aim at the port something is listening on',
    )
    assert.doesNotMatch(error.message, new RegExp(`:${closed}/free`), 'a closed candidate must never become a command')
    assert.equal(existsSync(fx.logFor(port)), false, 'nothing may be spawned when the gate refuses')
  } finally {
    fx.cleanup()
    await comfy.cleanup()
  }
})

test('status reports the same gate verdict, the shortfall and the remedy', async () => {
  const comfy = await fakeComfyUi()
  const { fx, config } = await baseConfig({ comfyPorts: String(comfy.port), comfyEndpoint: `http://127.0.0.1:${comfy.port}` })
  try {
    const tools = await register({ ...config, minFreeVramMiB: HUGE })
    const status = await run(tools, 'qwen_image_env', { action: 'status' })
    const gate = status.worker_start_gate
    console.log('\n--- status.worker_start_gate ---\n' + JSON.stringify(gate, null, 2) + '\n--- end ---')
    if (gate.would_refuse_start !== true) {
      console.log('SKIP: nvidia-smi is unavailable, so the advisory cannot warn')
      return
    }
    assert.equal(gate.required_MiB, HUGE)
    assert.equal(gate.shortfall_MiB, HUGE - gate.free_MiB)
    assert.equal(gate.auto_free_enabled, false)
    assert.match(gate.remedy, new RegExp(`http://127\\.0\\.0\\.1:${comfy.port}/free`))
    assert.match(gate.note, /本地 worker 会被拒绝启动/)
    assert.ok(status.advisories.length > 0, 'a refusal must still come with a next step')
    assert.equal(status.config.freeComfyBeforeLocalStart, false)
    assert.equal(comfy.freeCalls().length, 0, 'a status probe must never unload anything')
  } finally {
    fx.cleanup()
    await comfy.cleanup()
  }
})

// ---------------------------------------------------------------------------
// The opt-in /free, and the default that must stay inert
// ---------------------------------------------------------------------------

test('freeComfyBeforeLocalStart is off by default: refusing the start issues no request at all', async () => {
  const comfy = await fakeComfyUi()
  const { fx, config } = await baseConfig({ comfyPorts: String(comfy.port) })
  try {
    const tools = await register({ ...config, minFreeVramMiB: HUGE })
    const error = await fails(run(tools, 'qwen_image_generate', { prompt: 'A brass compass.', wh_ratio: '1:1' }))
    console.log('requests seen by the fake ComfyUI with the opt-in off:', JSON.stringify(comfy.requests))
    assert.deepEqual(comfy.requests, [], 'the default path must not send a single request')
    if (error === undefined) console.log('SKIP: nvidia-smi unavailable, so the start was allowed')
  } finally {
    fx.cleanup()
    await comfy.cleanup()
  }
})

test('with freeComfyBeforeLocalStart on the plugin does ask ComfyUI to unload, and says so', async () => {
  const comfy = await fakeComfyUi()
  const { fx, config } = await baseConfig({ comfyPorts: String(comfy.port) })
  try {
    const tools = await register({ ...config, minFreeVramMiB: HUGE, freeComfyBeforeLocalStart: true })
    const error = await fails(run(tools, 'qwen_image_generate', { prompt: 'A brass compass.', wh_ratio: '1:1' }))
    if (error === undefined) {
      console.log('SKIP: nvidia-smi is unavailable, so the gate never needed to free anything')
      return
    }
    const calls = comfy.freeCalls()
    console.log('\n--- opt-in /free call ---\n' + JSON.stringify(comfy.requests, null, 2) + '\n--- refusal ---\n' + error.message + '\n--- end ---')
    assert.equal(calls.length, 1, 'the opt-in must issue exactly one /free')
    assert.deepEqual(JSON.parse(calls[0].body), { unload_models: true, free_memory: true })
    assert.match(error.message, /已按 freeComfyBeforeLocalStart 请求 ComfyUI 释放/)
    assert.match(error.message, /HTTP 200/)
    // The fake replies instantly, so the gate re-reads the real card and is still short:
    // it must refuse rather than pretend the free worked.
    assert.match(error.message, /释放后仍不足/)
  } finally {
    fx.cleanup()
    await comfy.cleanup()
  }
})

test('a gate that is already satisfied never asks ComfyUI for anything, opt-in or not', async () => {
  const comfy = await fakeComfyUi()
  const { fx, config } = await baseConfig({ comfyPorts: String(comfy.port) })
  try {
    // 1 MiB is below whatever this card reports, and the gate allows the start when
    // it cannot read the card at all, so this path is deterministic either way.
    const tools = await register({ ...config, minFreeVramMiB: 1, freeComfyBeforeLocalStart: true })
    const result = await run(tools, 'qwen_image_generate', { prompt: 'A brass compass.', wh_ratio: '1:1', count: 1 })
    console.log('\n--- gate report on a successful start ---\n' + JSON.stringify(result.vram_gate, null, 2) + '\n--- end ---')
    assert.equal(result.ok, true)
    assert.equal(result.vram_gate.allowed, true)
    assert.equal(result.vram_gate.freed_comfy, null, 'no /free may be reported when the gate passed')
    assert.match(result.vram_gate.note, /没有动任何别的程序/)
    assert.deepEqual(comfy.requests, [], 'a satisfied gate must not talk to ComfyUI')
    // The worker's own stage breakdown has to survive the trip to the tool result:
    // it is the only thing that makes a slow edit explainable after the fact.
    assert.deepEqual(result.local_worker.stages_s, {
      encode_prompt_cpu: 0.31,
      denoise: 0.02,
      vae_decode: 0.01,
      prompt_tokens: 19,
    })
  } finally {
    fx.cleanup()
    await comfy.cleanup()
  }
})

test('minFreeVramMiB: 0 keeps the gate out of the way entirely', async () => {
  const comfy = await fakeComfyUi()
  const { fx, config } = await baseConfig({ comfyPorts: String(comfy.port) })
  try {
    const tools = await register({ ...config, minFreeVramMiB: 0, freeComfyBeforeLocalStart: true })
    const result = await run(tools, 'qwen_image_generate', { prompt: 'A brass compass.', wh_ratio: '1:1', count: 1 })
    console.log('vram_gate with the gate disabled:', JSON.stringify(result.vram_gate))
    assert.equal(result.ok, true)
    assert.equal(result.vram_gate, null, 'a disabled gate reports nothing')
    assert.deepEqual(comfy.requests, [], 'a disabled gate must not talk to ComfyUI')
  } finally {
    fx.cleanup()
    await comfy.cleanup()
  }
})

// ---------------------------------------------------------------------------
// The crash fallback: 0xC0000005 must never be the whole story
// ---------------------------------------------------------------------------

test('a worker that dies at load with 0xC0000005 is reported with a cause and a command', async () => {
  const { port, fx, config } = await baseConfig()
  try {
    // The gate is off so the crash path itself is what is under test.
    const tools = await register({ ...config, minFreeVramMiB: 0 })
    const error = await withMode('crash-access-violation', () =>
      fails(run(tools, 'qwen_image_generate', { prompt: 'A brass compass.', wh_ratio: '1:1' })),
    )
    assert.ok(error instanceof Error, 'a load-phase crash must fail the call')
    console.log('\n--- 0xC0000005 crash report ---\n' + error.message + '\n--- end ---')
    assert.match(error.message, /exit code 3221225477/, 'the raw code must still be there')
    assert.match(error.message, /0xC0000005/, 'the code must be translated')
    assert.match(error.message, /ACCESS_VIOLATION/)
    assert.match(error.message, /最可能的原因：加载阶段的显存不够/, 'the likely cause must be stated')
    assert.match(error.message, /当前显存：空闲/, 'the live VRAM reading must be attached')
    assert.match(error.message, /补救（若占用者是 ComfyUI）：curl -X POST http:\/\/127\.0\.0\.1:\d+\/free/, 'the remedy must be attached')
    assert.match(error.message, /unload_models/)
    assert.equal(existsSync(fx.logFor(port)), true, 'the crash path must still point at the log it read')
  } finally {
    fx.cleanup()
  }
})

test('a crash whose log already names CUDA is still read as an out-of-memory, not as a mystery code', async () => {
  const { fx, config } = await baseConfig()
  try {
    const tools = await register({ ...config, minFreeVramMiB: 0 })
    const error = await withMode('crash', () => fails(run(tools, 'qwen_image_generate', { prompt: 'A brass compass.', wh_ratio: '1:1' })))
    console.log('\n--- exit-3 crash report ---\n' + error.message + '\n--- end ---')
    assert.match(error.message, /exit code 3/)
    assert.match(error.message, /CUDA driver version is insufficient/)
    // Exit code 3 is not a Windows status, so the message must fall back to the
    // log rather than inventing a cause.
    assert.doesNotMatch(error.message, /0xC0000005/)
  } finally {
    fx.cleanup()
  }
})

// ---------------------------------------------------------------------------
// The two shapes of "the card is full", and the third one: allowed anyway
//
// These drive the gate with a **synthetic** GPU reading (`probeVram`), so the
// wording is pinned without a card, a driver, or a single MiB of VRAM. The two
// refusals need different remedies and the wrong one sends the user chasing a
// process that is not there (§34: ComfyUI's ~3.6 GiB `cudaMallocAsync` cache is
// invisible to `nvidia-smi --query-compute-apps`) or, worse, tells them nothing is
// wrong when something is.
// ---------------------------------------------------------------------------

/** A synthetic GPU reading: the numbers a full card would report, without a card. */
function probeReading({ freeMiB, processes = [], comfyReachable = false }) {
  return async () => ({
    freeMiB,
    totalMiB: 8188,
    processes,
    comfyReachable,
    comfyPid: processes[0]?.pid,
    comfyPort: comfyReachable ? 8188 : undefined,
  })
}

/** One runtime whose GPU is read from a fixture instead of `nvidia-smi`. */
function gatedRuntime(fx, port, probe) {
  return new WorkerRuntime({
    endpoint: `http://127.0.0.1:${port}`,
    interpreter: process.execPath,
    script: FAKE_WORKER,
    modelsDir: fx.modelsDir,
    dataDir: fx.runtimeDir,
    ports: [port, port + 1],
    startTimeoutMs: 15_000,
    idleUnloadMs: 0,
    manage: true,
    vramGate: {
      requiredMiB: 5500,
      comfyPort: 8188,
      comfyPorts: [8188],
      freeComfyFirst: false,
      scratchDir: join(fx.runtimeDir, 'logs'),
    },
    probeVram: probe,
  })
}

test('a refusal with a named holder hands over the /free command for that holder', async () => {
  const fx = fixture('forge-gate-named-holder')
  const port = await freePort()
  try {
    const runtime = gatedRuntime(
      fx,
      port,
      probeReading({ freeMiB: 900, processes: [{ pid: 4242, name: 'python.exe', usedMiB: 3600 }], comfyReachable: true }),
    )
    const error = await fails(runtime.ensure())
    console.log('\n--- refusal, named holder ---\n' + error.message + '\n--- end ---')
    assert.match(error.message, /显存余量不足，拒绝拉起 worker/)
    assert.match(error.message, /占着显存的进程（nvidia-smi 报出来的）/)
    assert.match(error.message, /pid 4242 python\.exe，约 3600 MiB（ComfyUI，监听 127\.0\.0\.1:8188）/)
    assert.match(error.message, /占用者里有 ComfyUI：先执行下面那条 \/free 命令/)
    assert.match(error.message, /curl -X POST http:\/\/127\.0\.0\.1:8188\/free/)
    // The allocator-cache shape is the *other* case: this one must not be told
    // "nobody is holding it".
    assert.doesNotMatch(error.message, /没有报出任何占用者/)
    assert.equal(existsSync(fx.logFor(port)), false, 'nothing may be spawned when the gate refuses')
  } finally {
    fx.cleanup()
  }
})

test('a refusal with no visible holder names the allocator cache, /free and the 1455 retry', async () => {
  const fx = fixture('forge-gate-no-holder')
  const port = await freePort()
  try {
    const runtime = gatedRuntime(fx, port, probeReading({ freeMiB: 900, processes: [] }))
    const error = await fails(runtime.ensure())
    console.log('\n--- refusal, no visible holder ---\n' + error.message + '\n--- end ---')
    assert.match(error.message, /显存余量不足，拒绝拉起 worker/)
    assert.match(error.message, /nvidia-smi 没有报出任何占用者/)
    assert.match(error.message, /--query-compute-apps/)
    assert.match(error.message, /cudaMallocAsync/)
    assert.match(error.message, /3\.6 GiB/)
    assert.match(error.message, /POST \/free/)
    assert.match(error.message, /curl -X POST http:\/\/127\.0\.0\.1:8188\/free/)
    // §34's second half: a back-to-back python spawn fails as OSError 1455, so the
    // retry advice has to be in the same message as the /free advice.
    assert.match(error.message, /OSError 1455/)
    assert.match(error.message, /隔十几秒再重试/)
    assert.match(error.message, /freeComfyBeforeLocalStart/)
    assert.doesNotMatch(error.message, /占着显存的进程（nvidia-smi 报出来的）/, 'nothing was reported, so nothing may be listed')
    assert.equal(existsSync(fx.logFor(port)), false, 'nothing may be spawned when the gate refuses')
  } finally {
    fx.cleanup()
  }
})

test('a start that is allowed while the card is not empty still says who is holding it', async () => {
  const fx = fixture('forge-gate-suspicious')
  const port = await freePort()
  try {
    const runtime = gatedRuntime(
      fx,
      port,
      probeReading({ freeMiB: 7000, processes: [{ pid: 4242, name: 'python.exe', usedMiB: 2900 }], comfyReachable: true }),
    )
    const handle = await runtime.ensure()
    const report = runtime.vramGate
    console.log('\n--- allowed, but the card was not empty ---\n' + JSON.stringify({ ...report, warning: undefined }, null, 2) + '\n--- warning ---\n' + report.warning + '\n--- end ---')
    assert.equal(handle.pid !== null, true, 'the start must really have happened for this case to mean anything')
    assert.equal(report.allowed, true)
    assert.match(report.warning, /启动门禁\*\*放行\*\*了/)
    assert.match(report.warning, /阈值 5500 MiB/)
    assert.match(report.warning, /pid 4242 python\.exe，约 2900 MiB（ComfyUI，监听 127\.0\.0\.1:8188）/)
    assert.match(report.warning, /127\.0\.0\.1:8188\/free/)
    assert.match(report.warning, /freeComfyBeforeLocalStart/)
    assert.match(report.warning, /OSError 1455/)
    await runtime.stop()
  } finally {
    fx.cleanup()
  }
})

test('an allowed start on an empty card carries no warning at all', async () => {
  const fx = fixture('forge-gate-clean')
  const port = await freePort()
  try {
    const runtime = gatedRuntime(fx, port, probeReading({ freeMiB: 7000, processes: [] }))
    await runtime.ensure()
    console.log('allowed on an empty card ->', JSON.stringify({ allowed: runtime.vramGate.allowed, warning: runtime.vramGate.warning }))
    assert.equal(runtime.vramGate.allowed, true)
    assert.equal(runtime.vramGate.warning, null, 'an empty card is not suspicious; warning about nothing would be noise')
    await runtime.stop()
  } finally {
    fx.cleanup()
  }
})

test('the status advisory separates a named holder from "the list is empty but the number is short"', () => {
  const gpu = (freeMiB) => ({ ok: true, data: { gpus: [{ vramFreeMiB: freeMiB, vramTotalMiB: 8188 }] } })
  const holders = { ok: true, data: { processes: [{ pid: 4242, name: 'python.exe', usedMiB: 3600 }] } }
  const none = { ok: true, data: { processes: [] } }
  const short = 900
  const roomy = 7000

  const withHolder = analyseVram(gpu(short), holders, { reachable: true, port: 8188 }, 5500, 4242)
  const withoutHolder = analyseVram(gpu(short), none, { reachable: false }, 5500)
  const allowedWithHolder = analyseVram(gpu(roomy), holders, { reachable: true, port: 8188 }, 5500, 4242)
  const allowedClean = analyseVram(gpu(roomy), none, { reachable: false }, 5500)
  console.log('with a named holder ->', JSON.stringify(withHolder.start_gate))
  console.log('no holder listed     ->', JSON.stringify(withoutHolder.start_gate))
  console.log('no-holder suggestion ->\n' + withoutHolder.suggestions.join('\n'))

  assert.equal(withHolder.start_gate.no_visible_holder, false)
  assert.equal(withHolder.start_gate.allowed, false)
  assert.match(withHolder.start_gate.remedy, /127\.0\.0\.1:8188\/free/)

  assert.equal(withoutHolder.start_gate.no_visible_holder, true)
  assert.equal(withoutHolder.start_gate.remedy, null, 'nothing was identified as the holder, so there is no targeted remedy')
  const suggestion = withoutHolder.suggestions.join('\n')
  assert.match(suggestion, /别把这读成「没人占着」/)
  assert.match(suggestion, /cudaMallocAsync/)
  assert.match(suggestion, /OSError 1455/)
  assert.match(suggestion, /freeComfyBeforeLocalStart/)

  // Allowed is not empty: the two are different verdicts with different text.
  assert.equal(vramSuspicionWarning(allowedWithHolder, 8188).startsWith('本地 worker 启动门禁**放行**了'), true)
  assert.match(vramSuspicionWarning(allowedWithHolder, 8188), /pid 4242/)
  assert.equal(vramSuspicionWarning(allowedClean, 8188), null)
  assert.equal(vramSuspicionWarning(withHolder, 8188), null, 'a refusal carries the remedy itself; it needs no second warning')
})
