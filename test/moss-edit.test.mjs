/**
 * MOSS-Image's reference-image edit path (T19): the community edit LoRA, the
 * native `TextEncodeMOSSImageEdit` encoder and the canvas the plugin picked.
 *
 * Everything runs against a fake ComfyUI that also accepts the `/upload/image`
 * multipart POST, so the assertions are about what reaches the wire: the LoRA
 * sits right behind the UNETLoader, every reference is uploaded and scaled to the
 * canvas, both polarity encode nodes carry the same reference slots, and the
 * sampler numbers come from the `mossSampling` register rather than from a
 * second, silently different working point.
 *
 * The graph shape is `verify/moss_image_edit_api.json` with two deliberate
 * changes documented in `src/model-profiles.ts`: sampler numbers are placeholders
 * filled by the profile, and the canvas (with its reference scalers) is the one
 * `ratio.ts` picked, so the reported size, the filename and the pixels agree.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import * as plugin from '../lib/index.js'
import { MOSS_NEGATIVE_PROMPT } from '../testlib/comfyui.js'
import { runStudioGeneration } from '../testlib/studio-service.js'
import { readBoard } from '../testlib/boards.js'

const LAYOUT_SAMPLE = readFileSync(
  fileURLToPath(new URL('./fixtures/layout/layout_prompt.json', import.meta.url)),
  'utf8',
)

/** The three MOSS weight files, as a real install's `/object_info` lists them. */
const OBJECT_INFO = {
  UNETLoader: {
    input: {
      required: {
        unet_name: [['qwen_image_2.1_int8_convrot.safetensors', 'moss_image_sft_int8_convrot.safetensors'], {}],
        weight_dtype: [['default', 'fp8_e4m3fn'], {}],
      },
    },
  },
  CLIPLoader: {
    input: {
      required: {
        clip_name: [['qwen3vl_8b_int8_convrot.safetensors', 'qwen3.5_9b_w4a8_gptq.safetensors'], {}],
        type: [['stable_diffusion', 'qwen_image', 'moss_image'], {}],
      },
      optional: { device: [['default', 'cpu'], {}] },
    },
  },
  VAELoader: {
    input: { required: { vae_name: [['qwen_image_2.1_vae_bf16.safetensors', 'flux2-vae_small.safetensors'], {}] } },
  },
  LoraLoaderModelOnly: {
    input: { required: { lora_name: [['moss_image_edit_lora_rank_64_bf16.safetensors'], {}] } },
  },
  TextEncodeMOSSImageEdit: { input: { required: {} } },
}

const PROMPT_ID = 'fake-moss-edit-prompt-id'

/**
 * Build a real, decodable PNG of any size (flat colour, so it compresses to nothing).
 *
 * @param width - pixel width.
 * @param height - pixel height.
 * @returns the PNG bytes.
 */
function makePng(width, height) {
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * stride + 1 + x * 3
      raw[at] = 32 + (x % 64)
      raw[at + 1] = 96
      raw[at + 2] = 160 + (y % 32)
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
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Split a multipart body into its parts, so the test can read the uploaded bytes. */
function parseMultipart(body, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '')
  if (boundary === null) return []
  const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`)
  const parts = []
  let cursor = body.indexOf(delimiter)
  while (cursor !== -1) {
    const next = body.indexOf(delimiter, cursor + delimiter.length)
    if (next === -1) break
    let section = body.subarray(cursor + delimiter.length, next)
    if (section.subarray(0, 2).toString() === '\r\n') section = section.subarray(2)
    if (section.subarray(-2).toString() === '\r\n') section = section.subarray(0, -2)
    const headerEnd = section.indexOf('\r\n\r\n')
    if (headerEnd !== -1) {
      const headers = section.subarray(0, headerEnd).toString('utf8')
      parts.push({
        name: /name="([^"]*)"/.exec(headers)?.[1] ?? null,
        filename: /filename="([^"]*)"/.exec(headers)?.[1] ?? null,
        contentType: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1] ?? null,
        body: section.subarray(headerEnd + 4),
      })
    }
    cursor = next
  }
  return parts
}

/**
 * Start a fake ComfyUI that also accepts reference uploads.
 *
 * @param options - `rendered` is the PNG `/view` serves (the "produced" image).
 */
async function startFakeComfy(options = {}) {
  const seen = []
  const state = { graph: undefined, uploads: [] }
  const rendered = options.rendered ?? makePng(1248, 1248)
  const objectInfo = options.objectInfo ?? OBJECT_INFO
  let promptRequests = 0
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      const url = new URL(request.url, 'http://127.0.0.1')
      const send = (status, payload, type = 'application/json') => {
        response.writeHead(status, { 'Content-Type': type })
        response.end(payload)
      }
      if (url.pathname === '/upload/image') {
        const parts = parseMultipart(body, request.headers['content-type'])
        const file = parts.find((part) => part.name === 'image')
        const fields = Object.fromEntries(
          parts.filter((part) => part.name !== 'image').map((part) => [part.name, part.body.toString('utf8')]),
        )
        state.uploads.push({
          filename: file?.filename ?? null,
          contentType: file?.contentType ?? null,
          fields,
          bytes: file?.body ?? Buffer.alloc(0),
        })
        seen.push({ method: request.method, path: url.pathname, uploads: state.uploads.length })
        // ComfyUI answers with the name it stored the file under.
        return send(200, JSON.stringify({ name: file?.filename ?? null, subfolder: '', type: 'input' }))
      }
      seen.push({ method: request.method, path: url.pathname, body: body.toString('utf8') })
      if (url.pathname === '/system_stats') {
        return send(200, JSON.stringify({ system: { comfyui_version: 'fake-0.0' }, devices: [{ name: 'fake-gpu', vram_free: 1 }] }))
      }
      if (url.pathname.startsWith('/object_info/')) {
        const node = url.pathname.slice('/object_info/'.length)
        return send(200, JSON.stringify(node in objectInfo ? { [node]: objectInfo[node] } : {}))
      }
      if (url.pathname === '/prompt' && request.method === 'POST') {
        promptRequests += 1
        if (options.failPrompt === true) return send(500, JSON.stringify({ error: { type: 'prompt_outputs_failed_validation', message: 'layout edit rejected' } }))
        state.graph = JSON.parse(body.toString('utf8')).prompt
        return send(200, JSON.stringify({ prompt_id: PROMPT_ID, number: 1, node_errors: {} }))
      }
      if (url.pathname === `/history/${PROMPT_ID}`) {
        return send(
          200,
          JSON.stringify({
            [PROMPT_ID]: {
              outputs: { '11': { images: [{ filename: 'dsh-image-forge-moss-edit_00001_.png', subfolder: '', type: 'output' }] } },
              status: { status_str: 'success', completed: true, messages: [['execution_success', { prompt_id: PROMPT_ID }]] },
            },
          }),
        )
      }
      if (url.pathname === '/view') return send(200, rendered, 'image/png')
      return send(404, JSON.stringify({}))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    seen,
    state,
    get promptRequests() { return promptRequests },
    port,
    endpoint: `http://127.0.0.1:${port}`,
    rendered,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Register the plugin against a stub context and hand back the tool map. */
function register(config) {
  const tools = new Map()
  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    skills: { register: () => undefined },
  }
  // A closed port by default: an edit must never reach a real ComfyUI unless the
  // test points it at a fake one.
  plugin.apply(ctx, { ...plugin.Config({}), comfyPorts: '1', ...config })
  return tools
}

/** Run one tool with a caller signal, the way the registry does. */
function run(tools, name, args) {
  return tools.get(name).execute(args, { signal: new AbortController().signal })
}

/** Write a reference PNG into the temp dir and hand back its absolute path. */
function referenceFile(outputDir, name, width, height) {
  const path = join(outputDir, name)
  writeFileSync(path, makePng(width, height))
  return path
}

/** The settings `runStudioGeneration` reads, pointed at the fake server. */
function studioSettings(comfy, outputDir) {
  return {
    comfyEndpoint: comfy.endpoint,
    comfyPorts: [],
    comfyModelsDir: 'D:\\models',
    timeoutMs: 30_000,
    outputDir,
    defaultSteps: 25,
    comfyuiSteps: undefined,
    comfyModel: 'moss-sft',
    mossSampling: 'comfy',
    turboSteps: undefined,
  }
}

/** Every node class in a captured graph. */
function classesOf(graph) {
  return Object.values(graph).map((node) => node.class_type)
}

test('a MOSS edit reaches /prompt with the LoRA, the native encode nodes and the canvas', async () => {
  const comfy = await startFakeComfy()
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-moss-edit-wire-'))
  try {
    const tools = register({
      comfyEndpoint: comfy.endpoint,
      comfyModelsDir: 'D:\\Comfy-Desktop\\ComfyUI-Shared\\models',
      comfyModel: 'moss-sft',
      outputDir,
      timeoutMs: 30_000,
    })
    const reference = referenceFile(outputDir, 'ref.png', 1024, 1024)
    const result = await run(tools, 'image_forge_edit', {
      prompt: '只把标题换成「夏日特惠」，其余保持原样。',
      images: [reference],
      seed: 42,
    })
    console.log('MOSS edit result:', JSON.stringify({ profile: result.comfyui.profile, model: result.model, steps_used: result.steps_used, size: result.size }))
    const graph = comfy.state.graph
    console.log('MOSS edit node classes:', JSON.stringify(Object.entries(graph).map(([id, node]) => [id, node.class_type])))

    // 1. The call is no longer refused: it ran through the MOSS profile.
    assert.equal(result.backend, 'comfyui')
    assert.equal(result.comfyui.profile, 'moss-sft')
    assert.equal(result.comfyui.comfyModel, 'moss')
    assert.equal(result.model, 'moss_image_sft_int8_convrot.safetensors')
    assert.equal(result.steps_used, 25, 'the comfy register owns the edit step count')
    assert.equal(result.steps_source, 'default')

    // 2. The reference was uploaded first, byte for byte, into ComfyUI's input/.
    assert.equal(comfy.state.uploads.length, 1)
    assert.equal(comfy.state.uploads[0].fields.type, 'input')
    assert.equal(comfy.state.uploads[0].contentType, 'image/png')
    assert.ok(comfy.state.uploads[0].bytes.equals(readFileSync(reference)), 'the uploaded bytes must be the reference bytes')
    assert.match(comfy.state.uploads[0].filename, /^dsh-forge-ref-[0-9a-f]{16}\.png$/, 'the upload name is content-addressed')
    const uploaded = comfy.state.uploads[0].filename

    // 3. The graph: LoRA right behind the UNETLoader, one native encoder per
    //    polarity, both reading the same reference, and no Qwen nodes.
    const classes = classesOf(graph)
    for (const present of ['UNETLoader', 'LoraLoaderModelOnly', 'CLIPLoader', 'VAELoader', 'LoadImage', 'ImageScale', 'EmptyFlux2LatentImage', 'SkipLayerGuidanceDiTSimple', 'TextEncodeMOSSImageEdit', 'KSampler', 'VAEDecode', 'SaveImage']) {
      assert.ok(classes.includes(present), `MOSS edit graph must carry ${present}`)
    }
    for (const absent of ['TextEncodeQwenImage21', 'CLIPTextEncode', 'EmptyLatentImage', 'SamplerCustomAdvanced']) {
      assert.ok(!classes.includes(absent), `MOSS edit graph must not carry ${absent}`)
    }
    assert.equal(classes.filter((type) => type === 'TextEncodeMOSSImageEdit').length, 2, 'positive and negative encode separately')
    for (const node of Object.values(graph)) {
      assert.ok(!JSON.stringify(node.inputs).includes('{{'), 'no placeholder may survive rendering')
    }

    assert.equal(graph['1'].class_type, 'UNETLoader')
    assert.equal(graph['1'].inputs.unet_name, 'moss_image_sft_int8_convrot.safetensors')
    assert.equal(graph['2'].class_type, 'LoraLoaderModelOnly')
    assert.deepEqual(graph['2'].inputs.model, ['1', 0])
    assert.equal(graph['2'].inputs.lora_name, 'moss_image_edit_lora_rank_64_bf16.safetensors')
    assert.equal(graph['2'].inputs.strength_model, 1)
    assert.equal(graph['3'].inputs.type, 'moss_image')
    assert.equal(graph['3'].inputs.clip_name, 'qwen3.5_9b_w4a8_gptq.safetensors')
    assert.equal(graph['4'].inputs.vae_name, 'flux2-vae_small.safetensors')

    // 4. The reference path: LoadImage -> ImageScale(number-scaled to canvas) ->
    //    images.image_0 on BOTH encode nodes. MOSS's autogrow slots are 0-based.
    assert.equal(graph['101'].class_type, 'LoadImage')
    assert.equal(graph['101'].inputs.image, uploaded)
    assert.equal(graph['121'].class_type, 'ImageScale')
    assert.deepEqual(graph['121'].inputs.image, ['101', 0])
    assert.equal(graph['121'].inputs.upscale_method, 'lanczos')
    assert.equal(graph['121'].inputs.crop, 'center')
    assert.deepEqual(graph['7'].inputs['images.image_0'], ['121', 0])
    assert.deepEqual(graph['8'].inputs['images.image_0'], ['121', 0])
    assert.equal(graph['7'].inputs.edit_format, 'Moss-Image-Edit')
    assert.equal(graph['7'].inputs.image_strength, 1)
    assert.deepEqual(graph['7'].inputs.vae, ['4', 0])
    assert.deepEqual(graph['7'].inputs.clip, ['3', 0])
    assert.equal(graph['7'].inputs.prompt, '只把标题换成「夏日特惠」，其余保持原样。')
    assert.equal(graph['8'].inputs.prompt, MOSS_NEGATIVE_PROMPT)

    // 5. The canvas is the one ratio.ts picked (1:1 -> 1248x1248), and Python's
    //    "reference latents must match the target latent" holds because the
    //    scaler targets the same width/height.
    assert.deepEqual([graph['5'].inputs.width, graph['5'].inputs.height, graph['5'].inputs.batch_size], [1248, 1248, 1])
    assert.deepEqual([graph['121'].inputs.width, graph['121'].inputs.height], [1248, 1248])
    assert.equal(graph['5'].inputs.width % 16, 0, 'EmptyFlux2LatentImage wants a multiple of 16')
    assert.deepEqual([result.size.width, result.size.height], [1248, 1248])

    // 6. Sampler numbers come from the mossSampling register, and the sampler is
    //    fed by the skip-layer guidance over the LoRA.
    assert.deepEqual(graph['6'].inputs.model, ['2', 0])
    assert.equal(graph['6'].inputs.single_layers, '22')
    assert.equal(graph['6'].inputs.end_percent, 1)
    assert.equal(graph['9'].class_type, 'KSampler')
    assert.deepEqual(graph['9'].inputs.model, ['6', 0])
    assert.deepEqual(graph['9'].inputs.positive, ['7', 0])
    assert.deepEqual(graph['9'].inputs.negative, ['8', 0])
    assert.deepEqual(graph['9'].inputs.latent_image, ['5', 0])
    assert.deepEqual(
      [graph['9'].inputs.steps, graph['9'].inputs.cfg, graph['9'].inputs.sampler_name, graph['9'].inputs.scheduler, graph['9'].inputs.denoise],
      [25, 2.5, 'er_sde', 'simple', 1],
    )
    assert.equal(graph['9'].inputs.seed, 42)
    assert.equal(graph['11'].inputs.filename_prefix, 'dsh-image-forge-moss-edit')

    // 7. The result was written under the edit preset, with the canvas in the name.
    const expected = join(outputDir, 'edit_1248x1248_1.png')
    assert.equal(result.images.length, 1)
    assert.equal(result.images[0].path, expected)
    assert.ok(existsSync(expected), 'the PNG must be on disk')
    assert.ok(readFileSync(expected).equals(comfy.rendered), 'the bytes on disk are the bytes /view served')
    assert.equal(comfy.seen.filter((entry) => entry.path === '/prompt').length, 1)
    assert.equal(comfy.seen.filter((entry) => entry.path === '/view').length, 1)
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('a MOSS edit wires every reference: two uploads, two slots, one canvas', async () => {
  const comfy = await startFakeComfy()
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-moss-edit-multi-'))
  try {
    const tools = register({
      comfyEndpoint: comfy.endpoint,
      comfyModelsDir: 'D:\\models',
      comfyModel: 'moss-sft',
      outputDir,
      timeoutMs: 30_000,
    })
    // The first reference decides the canvas (1:1 -> 1248x1248); the second one
    // is conditioning only, and must still be uploaded and scaled to that canvas.
    const first = referenceFile(outputDir, 'one.png', 1024, 1024)
    const second = referenceFile(outputDir, 'two.png', 1024, 768)
    const result = await run(tools, 'image_forge_edit', {
      prompt: '把两张图里的主体合并成一张海报。',
      images: [first, second],
      seed: 7,
    })
    const graph = comfy.state.graph
    console.log('MOSS edit (2 refs) node classes:', JSON.stringify(Object.entries(graph).map(([id, node]) => [id, node.class_type])))

    assert.equal(comfy.state.uploads.length, 2, 'one upload per reference image')
    assert.ok(comfy.state.uploads[0].bytes.equals(readFileSync(first)))
    assert.ok(comfy.state.uploads[1].bytes.equals(readFileSync(second)))
    assert.equal(result.references.length, 2)

    assert.equal(graph['101'].inputs.image, comfy.state.uploads[0].filename)
    assert.equal(graph['102'].inputs.image, comfy.state.uploads[1].filename)
    assert.deepEqual(graph['121'].inputs.image, ['101', 0])
    assert.deepEqual(graph['122'].inputs.image, ['102', 0])
    for (const id of ['7', '8']) {
      assert.deepEqual(graph[id].inputs['images.image_0'], ['121', 0], `node ${id} slot 0`)
      assert.deepEqual(graph[id].inputs['images.image_1'], ['122', 0], `node ${id} slot 1`)
      assert.equal(graph[id].inputs['images.image_2'], undefined, 'no third slot for two references')
    }
    assert.deepEqual([graph['121'].inputs.width, graph['122'].inputs.width], [1248, 1248], 'both scalers target the canvas')
    assert.deepEqual([graph['5'].inputs.width, graph['5'].inputs.height], [1248, 1248])
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('the official MOSS register reaches the edit sampler too', async () => {
  const comfy = await startFakeComfy()
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-moss-edit-official-'))
  try {
    const tools = register({
      comfyEndpoint: comfy.endpoint,
      comfyModelsDir: 'D:\\models',
      comfyModel: 'moss-sft',
      mossSampling: 'official',
      outputDir,
      timeoutMs: 30_000,
    })
    const reference = referenceFile(outputDir, 'ref.png', 1024, 1024)
    const result = await run(tools, 'image_forge_edit', { prompt: '把背景换成黄昏。', images: [reference], seed: 11 })
    const sampler = comfy.state.graph['9'].inputs
    console.log('MOSS edit official sampler:', JSON.stringify(sampler))
    // One profile, one sampling policy: text-to-image and edit run the same
    // register, so the tool's report matches the graph on the wire.
    assert.equal(result.steps_used, 50)
    assert.equal(result.steps_source, 'default')
    assert.deepEqual(
      [sampler.steps, sampler.cfg, sampler.sampler_name, sampler.scheduler],
      [50, 3, 'euler', 'simple'],
    )
    assert.equal(comfy.state.graph['2'].inputs.lora_name, 'moss_image_edit_lora_rank_64_bf16.safetensors')
    assert.equal(comfy.state.graph['7'].inputs.edit_format, 'Moss-Image-Edit')
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('layout generation keeps official Layout pure, then opts into all references explicitly', async () => {
  const comfy = await startFakeComfy()
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-moss-layout-modes-'))
  try {
    const reference = referenceFile(outputDir, 'ref.png', 1024, 768)
    const settings = studioSettings(comfy, outputDir)
    const base = {
      prompt: 'poster',
      ratio: '3:2',
      width: 1536,
      height: 1024,
      count: 1,
      steps: 25,
      seed: 7,
      layout: LAYOUT_SAMPLE,
      references: [{ path: reference, mediaType: 'image/png', name: 'ref.png' }],
    }

    const official = await runStudioGeneration(
      settings,
      { ...base, layoutMode: 'layout' },
      new AbortController().signal,
    )
    assert.equal(comfy.state.uploads.length, 0, 'official Layout never uploads its node references')
    assert.equal(official.mode, 'generate')
    assert.equal(official.layoutMode, 'layout')
    assert.deepEqual([official.width, official.height], [1536, 1024], 'the exact draft canvas is retained')
    assert.deepEqual([comfy.state.graph['6'].inputs.width, comfy.state.graph['6'].inputs.height], [1536, 1024])
    assert.equal(comfy.state.graph['4'].inputs.text, LAYOUT_SAMPLE, 'official Layout uses the text-to-image graph')
    assert.equal(comfy.seen.filter((entry) => entry.path === '/prompt').length, 1)
    const officialBoard = await readBoard(outputDir, official.board.id)
    assert.equal(officialBoard.items[0].layoutMode, 'layout', 'the result keeps its layout provenance')

    const experimental = await runStudioGeneration(
      settings,
      { ...base, layoutMode: 'layout-edit-experimental' },
      new AbortController().signal,
    )
    assert.equal(comfy.state.uploads.length, 1, 'experimental Layout uploads every reference')
    assert.equal(experimental.mode, 'edit')
    assert.equal(experimental.layoutMode, 'layout-edit-experimental')
    assert.deepEqual([experimental.width, experimental.height], [1536, 1024])
    assert.equal(comfy.state.graph['7'].inputs.prompt, LAYOUT_SAMPLE, 'compiled Layout JSON is the edit prompt')
    assert.equal(comfy.state.graph['7'].inputs['images.image_0'][1], 0)
    assert.equal(comfy.state.graph['8'].inputs.prompt, MOSS_NEGATIVE_PROMPT)
    assert.deepEqual([comfy.state.graph['5'].inputs.width, comfy.state.graph['5'].inputs.height], [1536, 1024])
    const experimentalBoard = await readBoard(outputDir, experimental.board.id)
    assert.equal(experimentalBoard.items[0].layoutMode, 'layout-edit-experimental', 'the result keeps the experimental provenance')
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('experimental Layout refuses missing capabilities and never silently retries official Layout', async () => {
  const missingLoraInfo = { ...OBJECT_INFO, LoraLoaderModelOnly: { input: { required: { lora_name: [['other.safetensors'], {}] } } } }
  const missing = await startFakeComfy({ objectInfo: missingLoraInfo })
  const missingDir = mkdtempSync(join(tmpdir(), 'forge-moss-layout-missing-'))
  try {
    const reference = referenceFile(missingDir, 'ref.png', 1024, 768)
    await assert.rejects(
      () => runStudioGeneration(
        studioSettings(missing, missingDir),
        {
          prompt: 'poster', ratio: '3:2', width: 1536, height: 1024, count: 1, steps: 25, seed: 7,
          layout: LAYOUT_SAMPLE, layoutMode: 'layout-edit-experimental',
          references: [{ path: reference, mediaType: 'image/png', name: 'ref.png' }],
        },
        new AbortController().signal,
      ),
      /编辑 LoRA|LoraLoaderModelOnly/,
    )
    assert.equal(missing.promptRequests, 0, 'a missing LoRA fails before /prompt')
    assert.equal(missing.state.uploads.length, 0, 'and before any upload')
  } finally {
    await missing.close()
    rmSync(missingDir, { recursive: true, force: true })
  }

  const failing = await startFakeComfy({ failPrompt: true })
  const failingDir = mkdtempSync(join(tmpdir(), 'forge-moss-layout-fail-'))
  try {
    const reference = referenceFile(failingDir, 'ref.png', 1024, 768)
    await assert.rejects(
      () => runStudioGeneration(
        studioSettings(failing, failingDir),
        {
          prompt: 'poster', ratio: '3:2', width: 1536, height: 1024, count: 1, steps: 25, seed: 7,
          layout: LAYOUT_SAMPLE, layoutMode: 'layout-edit-experimental',
          references: [{ path: reference, mediaType: 'image/png', name: 'ref.png' }],
        },
        new AbortController().signal,
      ),
      /prompt 被拒绝/,
    )
    assert.equal(failing.promptRequests, 1, 'a failed overlay submits exactly once')
  } finally {
    await failing.close()
    rmSync(failingDir, { recursive: true, force: true })
  }
})
