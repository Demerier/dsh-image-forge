/**
 * Live smoke test for the ComfyUI backend: one 1:1 text-to-image call, through
 * `qwen_image_generate` exactly as a session would.
 *
 * Not part of `npm test` — it needs a running ComfyUI with the Qwen-Image
 * weights. It is the quickest way to answer "is this deployment usable?" after
 * following docs/comfyui-deployment.md.
 *
 *   node test/live-generate-e2e.mjs            # base checkpoint
 *   FORGE_LIVE_MODEL=turbo node test/live-generate-e2e.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../lib/index.js'

const COMFY = process.env.FORGE_LIVE_COMFY ?? 'http://127.0.0.1:8188'
const MODEL = process.env.FORGE_LIVE_MODEL === 'turbo' ? 'turbo' : 'base'
const OUTPUT_DIR = process.env.FORGE_LIVE_OUT ?? mkdtempSync(join(tmpdir(), 'forge-live-t2i-'))

const PROMPT =
  'A plain ceramic mug on a wooden desk beside a closed notebook, soft window light from the left, ' +
  'shallow depth of field, realistic product photograph.'

const tools = new Map()
plugin.apply(
  {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    skills: { register: () => undefined },
  },
  {
    ...plugin.Config({}),
    backend: 'comfyui',
    apiKey: '',
    comfyEndpoint: COMFY,
    comfyModel: MODEL,
    outputDir: OUTPUT_DIR,
    timeoutMs: 900_000,
  },
)

const status = await tools.get('qwen_image_status').execute({}, { signal: new AbortController().signal })
console.log('status:', JSON.stringify({ comfyui: status.comfyui, output: status.output }, null, 2))
if (status.comfyui?.reachable !== true || status.comfyui?.models?.ok !== true) {
  console.error('\nComfyUI is not ready — see docs/comfyui-deployment.md.')
  process.exitCode = 1
} else {
  const started = Date.now()
  const result = await tools.get('qwen_image_generate').execute(
    { prompt: PROMPT, wh_ratio: '1:1', seed: 42, preset: `live-${MODEL}` },
    { signal: new AbortController().signal },
  )
  console.log('\nresult:', JSON.stringify({
    backend: result.backend,
    model: result.model,
    size: result.size,
    steps_used: result.steps_used,
    steps_source: result.steps_source,
    comfyModel: result.comfyui?.comfyModel,
    images: result.images.map((image) => ({ path: image.path, bytes: image.bytes })),
  }, null, 2))
  console.log(`elapsed: ${Date.now() - started} ms`)
}
