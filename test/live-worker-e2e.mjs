/**
 * Live end-to-end check against the **real** worker and the real weights.
 *
 * Not part of `npm test`: it needs an NVIDIA GPU, the plugin-owned venv, and the
 * 10.63 GiB nf4 checkpoint on disk. Run it by hand:
 *
 *   FORGE_LIVE_WORKER=1 \
 *   FORGE_LIVE_PYTHON=D:\...\venv\Scripts\python.exe \
 *   FORGE_LIVE_MODELS=D:\...\models\qwen-image-2.1-bnb4bit \
 *   node test/live-worker-e2e.mjs
 *
 * What it proves, in order:
 *   1. `qwen_image_env status` on this machine (free VRAM, advisories, venv/weights/worker).
 *   2. A cold `qwen_image_generate` with **no worker running** starts the worker,
 *      generates, and writes a PNG whose IHDR is reported.
 *   3. Killing the worker behind the plugin's back, then generating again: the
 *      plugin rebuilds it and produces a second PNG.
 *   4. `POST /unload` and the VRAM actually handed back (`nvidia-smi` before/after).
 *
 * Every step prints what it measured. Nothing here is asserted on faith.
 */
import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import * as plugin from '../lib/index.js'

if (process.env.FORGE_LIVE_WORKER !== '1') {
  console.log('skipped: set FORGE_LIVE_WORKER=1 to run the live worker check (needs a GPU and the nf4 weights)')
  process.exit(0)
}

const PYTHON = process.env.FORGE_LIVE_PYTHON ?? join(tmpdir(), 'forge-live-venv', 'Scripts', 'python.exe')
const MODELS = process.env.FORGE_LIVE_MODELS ?? join(tmpdir(), 'forge-live-models')
const PORT = Number(process.env.FORGE_LIVE_PORT ?? '8399')
const ENDPOINT = `http://127.0.0.1:${PORT}`

/** Run a command through a file descriptor (this host's sandbox denies pipes). */
function runFile(file, args) {
  const logPath = join(tmpdir(), `forge-live-${file.replace(/\W/g, '')}.log`)
  const fd = openSync(logPath, 'w')
  try {
    const result = spawnSync(file, args, { stdio: ['ignore', fd, fd], windowsHide: true })
    return { code: result.status, output: readFileSync(logPath, 'utf8') }
  } finally {
    closeSync(fd)
  }
}

/** Used/total VRAM in MiB, straight from the driver. */
function vram() {
  const result = runFile('nvidia-smi', ['--query-gpu=memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'])
  const [total, used, free] = result.output.trim().split(',').map((part) => Number(part.trim()))
  return { total, used, free }
}

/** Read the IHDR chunk of a PNG: size, bit depth and colour type, from the bytes. */
function ihdr(path) {
  const buffer = readFileSync(path)
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG', 'the file must be a PNG')
  assert.equal(buffer.subarray(12, 16).toString('ascii'), 'IHDR', 'the first chunk must be IHDR')
  return {
    bytes: buffer.length,
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
  }
}

/** Is something answering the worker's /state there? */
async function probe() {
  try {
    const response = await fetch(`${ENDPOINT}/state`, { signal: AbortSignal.timeout(1500) })
    return { reachable: true, status: response.status, body: await response.json().catch(() => null) }
  } catch (error) {
    return { reachable: false, note: error instanceof Error ? error.message : String(error) }
  }
}

const runtimeDir = mkdtempSync(join(tmpdir(), 'forge-live-runtime-'))
const outputDir = mkdtempSync(join(tmpdir(), 'forge-live-out-'))
const tools = new Map()
const disposers = []
plugin.apply(
  {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    skills: { register: () => undefined },
    // Cordis calls this when the plugin unloads; step 7 uses it to prove the
    // plugin really owns the process lifecycle.
    on: (event, handler) => {
      if (event === 'dispose') disposers.push(handler)
    },
  },
  {
    ...plugin.Config({}),
    backend: 'local',
    apiKey: '',
    outputDir,
    runtimeDir,
    modelsDir: MODELS,
    pythonPath: PYTHON,
    localEndpoint: ENDPOINT,
    workerPorts: `${PORT}-${PORT + 2}`,
    workerStartTimeoutMs: 600_000,
    idleUnloadMs: 0,
    manageWorker: true,
  },
)
const call = (name, args) => tools.get(name).execute(args, { signal: new AbortController().signal })

/** Run the dispose handlers the way cordis does when the plugin unloads. */
function dispose() {
  for (const handler of disposers) handler()
}

const pids = []
let exitCode = 0
try {
  console.log('='.repeat(78))
  console.log(`python      : ${PYTHON} (exists: ${statSync(PYTHON, { throwIfNoEntry: false }) !== undefined})`)
  console.log(`models dir  : ${MODELS}`)
  console.log(`endpoint    : ${ENDPOINT}`)
  console.log(`runtime dir : ${runtimeDir}`)
  console.log(`vram before : ${JSON.stringify(vram())}`)
  const before = await probe()
  console.log(`worker before the call: ${JSON.stringify(before)}`)

  console.log('\n--- 1. qwen_image_env status ---')
  const status = await call('qwen_image_env', { action: 'status' })
  console.log(
    JSON.stringify(
      {
        gpu: status.gpu,
        host: { memoryTotalMiB: status.host.data.memoryTotalMiB, memoryFreeMiB: status.host.data.memoryFreeMiB },
        disk: status.disk,
        vram_advisory: status.vram_advisory,
        advisories: status.advisories,
        local_runtime: {
          worker: status.local_runtime.worker,
          venv: { ...status.local_runtime.venv, packages: undefined },
          weights: status.local_runtime.weights,
          advisories: status.local_runtime.advisories,
          ready_to_generate: status.local_runtime.ready_to_generate,
        },
        backends: status.backends,
      },
      null,
      2,
    ),
  )

  console.log('\n--- 2. cold start through qwen_image_generate ---')
  const startedAt = Date.now()
  const first = await call('qwen_image_generate', {
    prompt: 'A single red apple on a white ceramic plate, soft daylight, product photo.',
    wh_ratio: '1:1',
    steps: 8,
    seed: 42,
    preset: 'live',
  })
  pids.push(first.local_worker.pid)
  const firstIhdr = ihdr(first.images[0].path)
  console.log(`elapsed_ms: ${Date.now() - startedAt}`)
  console.log('local_worker:', JSON.stringify(first.local_worker, null, 2))
  console.log(`png: ${first.images[0].path}`)
  console.log(`IHDR: ${JSON.stringify(firstIhdr)}`)
  assert.equal(first.local_worker.started_by_plugin, true, 'the plugin must have started the worker')
  assert.ok(firstIhdr.width === 992 && firstIhdr.height === 992, 'the wh_ratio size must be the real canvas')

  console.log('\n--- 2b. status while the worker is holding VRAM (the warning branch) ---')
  const held = await call('qwen_image_env', { action: 'status' })
  console.log(
    JSON.stringify(
      {
        gpu: held.gpu.data.gpus[0],
        vram_advisory: held.vram_advisory,
        advisories: held.advisories,
        worker_state: held.local_runtime.worker.state,
        worker_vram_allocated_MiB: held.local_runtime.worker.vram_allocated_MiB,
      },
      null,
      2,
    ),
  )
  assert.equal(held.vram_advisory.warn, true, 'a loaded worker on an 8 GiB card must trip the free-VRAM warning')
  assert.ok(held.vram_advisory.suggestions.length > 0, 'a warning must come with a next step')
  assert.equal(held.local_runtime.worker.state, 'ready')

  console.log('\n--- 3. kill the worker, then generate again ---')
  process.kill(first.local_worker.pid)
  const gone = await (async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (!(await probe()).reachable) return true
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return false
  })()
  console.log(`killed pid ${first.local_worker.pid}; port now dead: ${gone}`)
  assert.ok(gone, 'the killed worker must stop answering')
  const second = await call('qwen_image_generate', {
    prompt: 'A single green pear on a dark slate board, moody light, product photo.',
    wh_ratio: '1:1',
    steps: 8,
    seed: 43,
    preset: 'live',
  })
  pids.push(second.local_worker.pid)
  console.log('local_worker:', JSON.stringify(second.local_worker, null, 2))
  console.log(`png: ${second.images[0].path}`)
  console.log(`IHDR: ${JSON.stringify(ihdr(second.images[0].path))}`)
  assert.notEqual(second.local_worker.pid, first.local_worker.pid, 'a new process must have been started')
  assert.equal(second.local_worker.started_by_plugin, true)

  console.log('\n--- 4. POST /unload and the VRAM it hands back ---')
  const beforeUnload = vram()
  const unloaded = await call('qwen_image_env', { action: 'unload' })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const afterUnload = vram()
  console.log(`nvidia-smi before /unload: ${JSON.stringify(beforeUnload)}`)
  console.log(`nvidia-smi after  /unload: ${JSON.stringify(afterUnload)}`)
  console.log('unload result:', JSON.stringify(unloaded, null, 2))
  const afterHealth = await probe()
  console.log(`worker still up (503 = alive but unloaded): ${JSON.stringify(afterHealth)}`)
  assert.ok(afterUnload.free > beforeUnload.free, 'freeing the model must return VRAM to the driver')
  assert.equal(afterHealth.reachable, true, 'the process survives /unload so the next call can reload it')

  console.log('\n--- 5. one more generation after the unload (reload path) ---')
  const third = await call('qwen_image_generate', {
    prompt: 'A single yellow lemon on a wooden table, warm light, product photo.',
    wh_ratio: '1:1',
    steps: 8,
    seed: 44,
    preset: 'live',
  })
  pids.push(third.local_worker.pid)
  console.log(`png: ${third.images[0].path}`)
  console.log(`IHDR: ${JSON.stringify(ihdr(third.images[0].path))}`)
  console.log(`images on disk: ${first.images.length + second.images.length + third.images.length}`)

  console.log('\n--- 6. fetch-weights dry run against the real mirror (nothing is downloaded) ---')
  const plan = await call('qwen_image_env', { action: 'fetch-weights', dryRun: true })
  console.log(
    JSON.stringify(
      {
        listing_source: plan.listing_source,
        api_note: plan.api_note,
        planned_MiB: plan.planned_MiB,
        disk: plan.disk,
        statuses: [...new Set(plan.files.map((file) => file.status))],
        files: plan.files.length,
        weights_ready: plan.inspection.ready,
        quantization_flag: plan.inspection.quantization_flag,
      },
      null,
      2,
    ),
  )
  assert.equal(plan.listing_source, 'api', 'the mirror tree API must answer (huggingface.co would time out here)')
  assert.equal(plan.planned_MiB, 0, 'complete weights mean there is nothing to download')
  assert.ok(plan.files.every((file) => file.status === 'reused'), 'every file must be recognised as already present')
  assert.equal(plan.inspection.ready, true)

  console.log('\n--- 7. plugin dispose stops the worker and gives the VRAM back ---')
  const beforeDispose = vram()
  dispose()
  await new Promise((resolve) => setTimeout(resolve, 3000))
  const afterDispose = vram()
  console.log(`nvidia-smi before dispose: ${JSON.stringify(beforeDispose)}`)
  console.log(`nvidia-smi after  dispose: ${JSON.stringify(afterDispose)}`)
  const afterStop = await probe()
  console.log(`worker after dispose: ${JSON.stringify(afterStop)}`)
  assert.equal(afterStop.reachable, false, 'the worker must be gone after the plugin is disposed')
  assert.ok(afterDispose.used <= 200, `the VRAM must be back (used=${afterDispose.used} MiB)`)
  console.log('\nALL LIVE STEPS PASSED')
} catch (error) {
  exitCode = 1
  console.error('\nLIVE CHECK FAILED:', error instanceof Error ? error.stack : String(error))
} finally {
  for (const pid of pids) {
    try {
      process.kill(pid)
    } catch {
      /* already gone */
    }
  }
  console.log(`\nvram after cleanup: ${JSON.stringify(vram())}`)
  console.log(`artifacts kept for inspection: ${outputDir}`)
  console.log(`worker log kept for inspection: ${join(runtimeDir, 'logs')}`)
}
process.exit(exitCode)
