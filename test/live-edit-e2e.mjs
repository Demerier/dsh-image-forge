/**
 * Live acceptance for the reference-image edit path: the real ComfyUI and the real
 * managed worker, driven through `qwen_image_edit` exactly as a session would.
 *
 * This is **not** part of `npm test`: it needs this machine's ComfyUI (with the
 * Qwen-Image weights), the plugin's venv + nf4 weights, and an 8 GiB GPU with
 * room for one ~1 MP edit. Everything hermetic lives in `edit-e2e.test.mjs`.
 *
 *   node test/live-edit-e2e.mjs [comfyui|local|both]
 *
 * Overridable, with this box's values as defaults:
 *   FORGE_LIVE_COMFY     http://127.0.0.1:8188
 *   FORGE_LIVE_PYTHON    D:\file\qwen生图插件\_m0\venv\Scripts\python.exe
 *   FORGE_LIVE_MODELS    D:\file\qwen生图插件\_m0\models\qwen-image-2.1-bnb4bit
 *   FORGE_LIVE_REF_16X9  _comfyui_ref\e2e\comfy_1312x736_1.png   (1312x736)
 *   FORGE_LIVE_REF_WIDE  _integration\out\qwen_2048x1152_1.png  (2048x1152)
 *   FORGE_LIVE_OUT       output directory (default: a temp dir)
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../lib/index.js'
import { probeImageSize } from '../src/refs.ts'

const WORKSPACE = 'D:\\file\\qwen生图插件'
const COMFY = process.env.FORGE_LIVE_COMFY ?? 'http://127.0.0.1:8188'
const PYTHON = process.env.FORGE_LIVE_PYTHON ?? join(WORKSPACE, '_m0', 'venv', 'Scripts', 'python.exe')
const MODELS = process.env.FORGE_LIVE_MODELS ?? join(WORKSPACE, '_m0', 'models', 'qwen-image-2.1-bnb4bit')
const REF_16X9 = process.env.FORGE_LIVE_REF_16X9 ?? join(WORKSPACE, '_comfyui_ref', 'e2e', 'comfy_1312x736_1.png')
const REF_WIDE = process.env.FORGE_LIVE_REF_WIDE ?? join(WORKSPACE, '_integration', 'out', 'qwen_2048x1152_1.png')
const OUTPUT_DIR = process.env.FORGE_LIVE_OUT ?? mkdtempSync(join(tmpdir(), 'forge-live-edit-'))
/**
 * The plugin-owned runtime directory (worker log, breadcrumb, venv). It defaults
 * to `~/.dsh-image-forge`, which a sandboxed session may not be allowed to
 * create — the worker then cannot write its breadcrumb — so the live run keeps
 * it in the temp directory instead.
 */
const RUNTIME_DIR = process.env.FORGE_LIVE_RUNTIME ?? join(tmpdir(), 'forge-live-edit-runtime')

/** The edit instruction, in Chinese, so the language path is exercised too. */
const PROMPT = '把画面里的天空改成黄昏色调，其余内容保持不变。'

/** Read a written PNG's IHDR fields — the acceptance evidence for "what size came out". */
function ihdr(path) {
  const bytes = readFileSync(path)
  return {
    path,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
    interlace: bytes[28],
    bytes: bytes.length,
  }
}

/** Report what the plugin thinks a reference file is. */
function describeReference(path) {
  const size = probeImageSize(new Uint8Array(readFileSync(path)))
  return `${path} -> ${size === undefined ? 'unreadable' : `${size.width}x${size.height} ${size.mime}`}`
}

/**
 * Register the plugin and hand back the tools plus a disposer that stops the
 * worker the plugin started (the same path a session's teardown takes).
 */
function register(config) {
  const tools = new Map()
  const disposers = []
  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    skills: { register: () => undefined },
    on: (event, handler) => {
      if (event === 'dispose') disposers.push(handler)
    },
  }
  plugin.apply(ctx, { ...plugin.Config({}), ...config })
  return {
    tools,
    run: (name, args) => tools.get(name).execute(args, { signal: new AbortController().signal }),
    dispose: async () => {
      for (const handler of disposers) await handler()
    },
  }
}

/** The graph ComfyUI itself recorded for this process's last submission. */
async function recordedGraph() {
  const clientId = `${process.pid}-dsh-image-forge`
  const response = await fetch(`${COMFY}/history`, { headers: { Accept: 'application/json' } })
  const history = await response.json()
  const entries = Object.entries(history).filter(([, entry]) => {
    const extra = entry?.prompt?.[3]?.client_id ?? entry?.extra_data?.client_id
    return extra === clientId
  })
  if (entries.length === 0) return null
  const [, entry] = entries[entries.length - 1]
  const graph = entry.prompt?.[2] ?? {}
  return Object.entries(graph).map(([id, node]) => `${id}: ${node.class_type}`)
}

/** Run one edit and print the evidence a reviewer needs. */
async function editAndReport(label, forge, args) {
  console.log(`\n===== ${label} =====`)
  console.log('args:', JSON.stringify({ ...args, prompt: `${PROMPT.slice(0, 24)}…` }))
  const started = Date.now()
  const result = await forge.run('qwen_image_edit', { ...args, prompt: PROMPT })
  const elapsed = Date.now() - started
  console.log(
    'result:',
    JSON.stringify(
      {
        ok: result.ok,
        backend: result.backend,
        model: result.model,
        size: result.size,
        size_source: result.size_source,
        wh_ratio: result.wh_ratio,
        ratio_follow: result.ratio_follow,
        ratio_follow_defaulted: result.ratio_follow_defaulted,
        ratio_follow_image: result.ratio_follow_image,
        ratio_deviation_percent: result.ratio_deviation_percent,
        references: result.references.map((reference) => ({ index: reference.index, size: reference.size, mime: reference.mime, bytes: reference.bytes })),
        images: result.images.map((image) => ({ path: image.path, width: image.width, height: image.height, mime: image.mime })),
        transparent: result.transparent,
        comfyui: result.comfyui === null ? null : { endpoint: result.comfyui.endpoint, models: result.comfyui.models, references_uploaded: result.comfyui.references_uploaded, elapsed_ms: result.comfyui.elapsed_ms },
        local_worker: result.local_worker,
        notes: result.api_skipped,
      },
      null,
      2,
    ),
  )
  console.log(`elapsed: ${elapsed} ms`)
  const files = result.images.map((image) => ihdr(image.path))
  console.log('IHDR:', JSON.stringify(files, null, 2))
  const graph = await recordedGraph()
  if (graph !== null) console.log('ComfyUI-recorded graph nodes:\n  ' + graph.join('\n  '))
  return { result, files }
}

const which = (process.argv[2] ?? 'both').toLowerCase()
console.log(`live edit acceptance | backends: ${which} | output: ${OUTPUT_DIR} | runtime: ${RUNTIME_DIR}`)
console.log('reference A (16:9):', describeReference(REF_16X9))
console.log('reference B (wide):', describeReference(REF_WIDE))

if (which === 'comfyui' || which === 'both') {
  const forge = register({
    backend: 'comfyui',
    apiKey: '',
    comfyEndpoint: COMFY,
    outputDir: OUTPUT_DIR,
    runtimeDir: RUNTIME_DIR,
    timeoutMs: 900_000,
    localEndpoint: 'http://127.0.0.1:1',
  })
  // Both calls take a non-square reference and must come out at that reference's
  // aspect ratio, not at the 1:1 default a text-to-image call would use.
  await editAndReport('ComfyUI · default follows image1 (1312x736)', forge, {
    images: [REF_16X9],
    steps: 8,
    seed: 7,
    preset: 'live-comfy-16x9',
  })
  await editAndReport('ComfyUI · ratio_follow image1 of a 2048x1152 reference', forge, {
    images: [REF_WIDE],
    ratio_follow: 'image1',
    steps: 8,
    seed: 7,
    preset: 'live-comfy-wide',
  })
}

if (which === 'local' || which === 'both') {
  const forge = register({
    backend: 'local',
    apiKey: '',
    localEndpoint: 'http://127.0.0.1:8399',
    workerPorts: '8399-8403',
    pythonPath: PYTHON,
    modelsDir: MODELS,
    runtimeDir: RUNTIME_DIR,
    outputDir: OUTPUT_DIR,
    timeoutMs: 900_000,
    workerStartTimeoutMs: 600_000,
    minFreeVramMiB: 0,
    // This script exists to drive the local edit path end to end, and the
    // 1312×736 reference resolves to a default canvas whose conditioning budget is
    // above the local edit size gate (see test/local-edit-budget.test.mjs). The
    // gate is the thing being opted out of here, on purpose: the run is a
    // measurement, and it reports `local_edit_budget.warning` back.
    allowLocalEditOverBudget: true,
  })
  try {
    await editAndReport('local worker · reference 1312x736, default follows image1', forge, {
      images: [REF_16X9],
      steps: 6,
      seed: 3,
      preset: 'live-local-16x9',
    })
    const unload = await forge.run('qwen_image_env', { action: 'unload' })
    console.log('\nunload:', JSON.stringify({ ok: unload.ok, vram_before_MiB: unload.vram_before_MiB, vram_after_MiB: unload.vram_after_MiB, note: unload.note }, null, 2))
  } finally {
    const stopped = await forge.dispose()
    console.log('worker stopped (plugin dispose):', JSON.stringify(stopped ?? null))
  }
}
