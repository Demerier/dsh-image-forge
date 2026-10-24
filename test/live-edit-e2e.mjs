/**
 * Live acceptance for the reference-image edit path: the real ComfyUI, driven
 * through `qwen_image_edit` exactly as a session would.
 *
 * This is **not** part of `npm test`: it needs this machine's ComfyUI with the
 * Qwen-Image weights loaded and a GPU with room for one ~1.5 MP edit. Everything
 * hermetic lives in `edit-e2e.test.mjs`.
 *
 *   node test/live-edit-e2e.mjs
 *
 * Overridable:
 *   FORGE_LIVE_COMFY     http://127.0.0.1:8188
 *   FORGE_LIVE_REF_16X9  a 16:9 reference (default: generated)
 *   FORGE_LIVE_REF_WIDE  a 2048×1152 reference (default: generated)
 *   FORGE_LIVE_OUT       output directory (default: a temp dir)
 *
 * The two references are **generated** rather than read from a scratch
 * directory: a live test that depends on files some earlier session left behind
 * fails for the wrong reason. Point those two variables at your own pictures
 * when you want the run to look like a real edit.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import * as plugin from '../lib/index.js'
import { probeImageSize } from '../src/refs.ts'

const COMFY = process.env.FORGE_LIVE_COMFY ?? 'http://127.0.0.1:8188'
const SCRATCH = mkdtempSync(join(tmpdir(), 'forge-live-refs-'))
const OUTPUT_DIR = process.env.FORGE_LIVE_OUT ?? mkdtempSync(join(tmpdir(), 'forge-live-edit-'))

/**
 * Write a real PNG of the given size, so the plugin's header parser and
 * ComfyUI's decoder both see a genuine image.
 *
 * @param width - pixel width.
 * @param height - pixel height.
 * @returns the path written (inside the scratch directory).
 */
function makeReference(width, height) {
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * stride + 1 + x * 3
      // A gradient with a bright band near the top, so an edit has something
      // visibly different to change.
      raw[at] = 40 + ((x * 7) % 64)
      raw[at + 1] = 60 + ((y * 5) % 96)
      raw[at + 2] = y < height / 4 ? 200 : 120
    }
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  const path = join(SCRATCH, `ref_${width}x${height}.png`)
  writeFileSync(path, png)
  return path
}

const REF_16X9 = process.env.FORGE_LIVE_REF_16X9 ?? makeReference(1312, 736)
const REF_WIDE = process.env.FORGE_LIVE_REF_WIDE ?? makeReference(2048, 1152)

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

/** Register the plugin and hand back the tools plus a no-op disposer. */
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
        comfyui: result.comfyui === null ? null : { endpoint: result.comfyui.endpoint, models: result.comfyui.models, references_uploaded: result.comfyui.references_uploaded, elapsed_ms: result.comfyui.elapsed_ms },
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

console.log(`live edit acceptance | ComfyUI: ${COMFY} | output: ${OUTPUT_DIR}`)
console.log('reference A (16:9):', describeReference(REF_16X9))
console.log('reference B (wide):', describeReference(REF_WIDE))

const forge = register({
  comfyEndpoint: COMFY,
  outputDir: OUTPUT_DIR,
  timeoutMs: 900_000,
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

const status = await forge.run('qwen_image_status', {})
console.log('\nstatus:', JSON.stringify({ comfyui: status.comfyui, output: status.output }, null, 2))
await forge.dispose()
