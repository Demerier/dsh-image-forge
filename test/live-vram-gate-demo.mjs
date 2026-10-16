/**
 * The pre-start VRAM gate against a **really** occupied card.
 *
 * `test/vram-gate.test.mjs` constructs the "not enough VRAM" condition by raising
 * the threshold, which is deterministic and needs no GPU — but it never proves the
 * gate reads a contended card correctly. This script is the opposite trade: it runs
 * on the real machine, against whatever is actually holding the GPU (typically
 * ComfyUI with its models loaded), and prints what the plugin does about it.
 *
 * It is deliberately not part of `npm test`: it needs a GPU, a venv, weights, and
 * something else willing to occupy the card. It spawns **no** worker, because the
 * gate is expected to refuse before that point.
 *
 *     node test/live-vram-gate-demo.mjs
 *
 * Defaults match this box; override with FORGE_LIVE_PYTHON / FORGE_LIVE_MODELS /
 * FORGE_LIVE_RUNTIME / FORGE_LIVE_COMFY_PORT.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../lib/index.js'

const PYTHON = process.env.FORGE_LIVE_PYTHON ?? 'D:\\file\\qwen生图插件\\_m0\\venv\\Scripts\\python.exe'
const MODELS = process.env.FORGE_LIVE_MODELS ?? 'D:\\file\\qwen生图插件\\_m0\\models\\qwen-image-2.1-bnb4bit'
const COMFY_PORT = process.env.FORGE_LIVE_COMFY_PORT ?? '8188'
const RUNTIME = process.env.FORGE_LIVE_RUNTIME ?? mkdtempSync(join(tmpdir(), 'forge-live-gate-'))

function register(config) {
  const tools = new Map()
  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    skills: { register: () => undefined },
  }
  plugin.apply(ctx, { ...plugin.Config({}), ...config })
  return tools
}

const tools = register({
  backend: 'local',
  apiKey: '',
  pythonPath: PYTHON,
  modelsDir: MODELS,
  runtimeDir: RUNTIME,
  comfyPorts: COMFY_PORT,
  comfyEndpoint: `http://127.0.0.1:${COMFY_PORT}`,
  idleUnloadMs: 0,
  manageWorker: true,
  // The shipped default; the gate is expected to refuse at this floor.
  minFreeVramMiB: 5500,
})

console.log('runtime dir:', RUNTIME)

// The refusal first: it is the acceptance artifact, and it costs one `nvidia-smi`
// and two `stat` calls. `qwen_image_env status` is deliberately left out of the
// default path because it probes the venv's packages with a 5-minute budget, which
// on a pagefile-starved box takes minutes for reasons that have nothing to do with
// this gate.
console.log('\n=== local generate (expects a refusal) ===')
try {
  const result = await tools
    .get('qwen_image_generate')
    .execute({ prompt: 'A brass compass.', wh_ratio: '1:1', backend: 'local' }, { signal: new AbortController().signal })
  console.log('UNEXPECTED: the gate allowed the start and the call returned:')
  console.log(JSON.stringify({ backend: result.backend, images: result.images?.length }, null, 2))
} catch (error) {
  console.log('refused as expected:\n')
  console.log(error.message)
}

if (process.argv.includes('--with-status')) {
  console.log('\n=== qwen_image_env status (slow: probes the venv packages) ===')
  const status = await tools
    .get('qwen_image_env')
    .execute({ action: 'status' }, { signal: new AbortController().signal })
  console.log('\n--- vram_advisory ---')
  console.log(JSON.stringify(status.vram_advisory, null, 2))
  console.log('\n--- worker_start_gate ---')
  console.log(JSON.stringify(status.worker_start_gate, null, 2))
}
