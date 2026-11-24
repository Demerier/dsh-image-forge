/**
 * End-to-end runs against a fake ComfyUI, plus the failure modes that matter.
 *
 * The fake speaks the four endpoints the real server does — `/system_stats`,
 * `/object_info/<node>`, `/prompt`, `/history/<id>`, `/view` — and records every
 * request, so this pins the whole contract: how the port is found, which weight
 * file names reach the wire, what the graph looks like, that polling happens,
 * and that the bytes written to disk are the bytes `/view` served.
 *
 * The `/object_info` bodies below are trimmed copies of what ComfyUI 0.40.0 on
 * this machine actually answered (`_comfyui_ref/object_info.json`), including the
 * prompt-enhancer text encoders that must NOT be chosen as the text encoder.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../lib/index.js'
import { runStudioGeneration } from '../testlib/studio-service.js'
import {
  COMFY_MODEL_IDS,
  LEGACY_COMFY_MODEL_IDS,
  MODEL_PROFILES,
  MOSS_IMAGE_WORKFLOW,
  MOSS_LATENT_MULTIPLE,
  MOSS_NEGATIVE_PROMPT,
  MOSS_SAMPLING_PRESETS,
  QWEN_IMAGE_EDIT_WORKFLOW,
  QWEN_IMAGE_TURBO_EDIT_WORKFLOW,
  QWEN_IMAGE_TURBO_WORKFLOW,
  QWEN_IMAGE_WORKFLOW,
  assertLatentAligned,
  effectiveProfile,
  isComfyModelId,
  resolveProfile,
} from '../testlib/comfyui.js'

/** A real 1×1 PNG — and it carries bytes ≥ 0x80, so a text-decoded body would corrupt it. */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

/**
 * A second, deliberately non-decodable payload: the PNG signature plus bytes
 * that are invalid UTF-8 (`ff fe`, `c3 28`, `ed a0 80`). Byte equality against
 * this fixture fails the moment anything decodes the body as text.
 */
const PNG_BINARY = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0xed, 0xa0, 0x80, 0x80, 0xfe]),
  Buffer.from('second-image'),
])

/** The file names the fake server offers, mirroring a real install. */
const OBJECT_INFO = {
  UNETLoader: {
    input: {
      required: {
        unet_name: [['minimax_music3_dit_fp16.safetensors', 'qwen_image_2.1_int8_convrot.safetensors'], {}],
        weight_dtype: [['default', 'fp8_e4m3fn', 'fp8_e4m3fn_fast', 'fp8_e5m2'], {}],
      },
    },
  },
  CLIPLoader: {
    input: {
      required: {
        clip_name: [
          [
            'dino_v3_vit_h.safetensors',
            'qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors',
            'qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors',
            'qwen3vl_8b_int8_convrot.safetensors',
          ],
          {},
        ],
        type: [['stable_diffusion', 'sd3', 'qwen_image', 'wan'], {}],
      },
    },
  },
  VAELoader: {
    input: { required: { vae_name: [['minimax_music3_dav.safetensors', 'qwen_image_2.1_vae_bf16.safetensors'], {}] } },
  },
}

const PROMPT_ID = 'fake-prompt-id'

/** Split a multipart body into its parts, so an upload's bytes and fields are readable. */
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
        body: section.subarray(headerEnd + 4),
      })
    }
    cursor = next
  }
  return parts
}

/** Start a fake ComfyUI; every option has a working default. */
async function startFakeComfy(options = {}) {
  const seen = []
  const state = { historyCalls: 0, graph: undefined, uploads: [] }
  const images = options.images ?? [
    { filename: 'dsh-image-forge_00001_.png', base64: PNG_1X1 },
    { filename: 'dsh-image-forge_00002_.png', base64: PNG_BINARY.toString('base64') },
  ]
  const objectInfo = options.objectInfo ?? OBJECT_INFO
  const history = options.history ?? [
    {},
    {
      [PROMPT_ID]: {
        outputs: { '8': { images: images.map((image) => ({ filename: image.filename, subfolder: '', type: 'output' })) } },
        status: { status_str: 'success', completed: true, messages: [['execution_success', { prompt_id: PROMPT_ID }]] },
      },
    },
  ]
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks)
      const body = raw.toString('utf8')
      const url = new URL(request.url, 'http://127.0.0.1')
      const send = (status, payload, type = 'application/json') => {
        response.writeHead(status, { 'Content-Type': type })
        response.end(payload)
      }
      // Reference uploads: the edit paths post the bytes here before /prompt.
      if (url.pathname === '/upload/image') {
        const parts = parseMultipart(raw, request.headers['content-type'])
        const file = parts.find((part) => part.name === 'image')
        state.uploads.push({
          filename: file?.filename ?? null,
          fields: Object.fromEntries(parts.filter((part) => part.name !== 'image').map((part) => [part.name, part.body.toString('utf8')])),
          bytes: file?.body ?? Buffer.alloc(0),
        })
        seen.push({ method: request.method, path: url.pathname, uploads: state.uploads.length })
        return send(200, JSON.stringify({ name: file?.filename ?? null, subfolder: '', type: 'input' }))
      }
      seen.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body })
      if (url.pathname === '/system_stats') {
        return send(200, JSON.stringify({ system: { comfyui_version: options.version ?? 'fake-0.0' }, devices: [{ name: 'fake-gpu', vram_free: 1 }] }))
      }
      if (url.pathname.startsWith('/object_info/')) {
        const node = url.pathname.slice('/object_info/'.length)
        return send(200, JSON.stringify(node in objectInfo ? { [node]: objectInfo[node] } : {}))
      }
      if (url.pathname === '/prompt' && request.method === 'POST') {
        state.graph = JSON.parse(body).prompt
        if (options.promptResponse !== undefined) return send(options.promptResponse.status, JSON.stringify(options.promptResponse.body))
        return send(200, JSON.stringify({ prompt_id: PROMPT_ID, number: 1, node_errors: {} }))
      }
      if (url.pathname === `/history/${PROMPT_ID}`) {
        state.historyCalls += 1
        return send(200, JSON.stringify(history[Math.min(state.historyCalls - 1, history.length - 1)]))
      }
      if (url.pathname === '/view') {
        const wanted = url.searchParams.get('filename')
        const image = images.find((candidate) => candidate.filename === wanted) ?? images[0]
        return send(200, Buffer.from(image.base64, 'base64'), 'image/png')
      }
      return send(404, JSON.stringify({}))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    seen,
    state,
    port,
    endpoint: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Reserve a port and release it, so connecting there is refused. */
async function deadPort() {
  const server = createServer(() => undefined)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** Register the plugin against a stub context and hand back the tool map. */
function register(config) {
  const tools = new Map()
  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    skills: { register: () => undefined },
  }
  plugin.apply(ctx, { ...plugin.Config({}), ...config })
  return tools
}

/** Run one tool with a caller signal, the way the registry does. */
function run(tools, name, args) {
  return tools.get(name).execute(args, { signal: new AbortController().signal })
}

/** Run a tool and return the rejection instead of throwing. */
async function failure(tools, name, args) {
  return run(tools, name, args).then(
    () => undefined,
    (caught) => caught,
  )
}

test('a fake ComfyUI: port probe, graph injection, poll, /view, byte-exact write', async () => {
  const comfy = await startFakeComfy()
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-comfy-'))
  const closed = await deadPort()
  try {
    const tools = register({
      comfyEndpoint: '',
      comfyPorts: `${closed},${comfy.port}`,
      comfyModelsDir: 'D:\\Comfy-Desktop\\ComfyUI-Shared\\models',
      outputDir,
      timeoutMs: 30_000,
    })
    const result = await run(tools, 'image_forge_generate', {
      prompt: 'A wide photograph of a harbour at dawn, wooden boats along a stone quay.',
      wh_ratio: '16:9',
      steps: 12,
      seed: 42,
      count: 2,
      preset: 'harbour',
    })

    console.log('probe trail:', JSON.stringify(result.comfyui.probed, null, 1))
    console.log('graph that reached /prompt:')
    for (const [id, node] of Object.entries(comfy.state.graph)) console.log(` #${id} ${node.class_type}`, JSON.stringify(node.inputs))
    console.log('result:', JSON.stringify({ ...result, markdown: result.markdown }, null, 1).slice(0, 1200))
    console.log('requests the fake ComfyUI saw:', comfy.seen.map((entry) => `${entry.method} ${entry.path}`).join(' | '))

    // 1. discovery: the dead port is reported, the live one is used.
    assert.equal(result.comfyui.port, comfy.port)
    assert.equal(result.comfyui.endpoint, comfy.endpoint)
    assert.deepEqual(
      result.comfyui.probed.map((attempt) => attempt.ok),
      [false, true],
    )
    assert.match(result.comfyui.probed[0].note, /ECONNREFUSED|请求失败/)

    // 2. the graph: names taken from /object_info, sizes from wh_ratio + count.
    const graph = comfy.state.graph
    assert.equal(graph['1'].class_type, 'UNETLoader')
    assert.equal(graph['1'].inputs.unet_name, 'qwen_image_2.1_int8_convrot.safetensors')
    assert.equal(graph['1'].inputs.weight_dtype, 'default')
    assert.equal(graph['2'].class_type, 'CLIPLoader')
    assert.equal(graph['2'].inputs.clip_name, 'qwen3vl_8b_int8_convrot.safetensors', 'the PE encoders must not be chosen')
    assert.equal(graph['2'].inputs.type, 'qwen_image')
    assert.equal(graph['3'].inputs.vae_name, 'qwen_image_2.1_vae_bf16.safetensors')
    assert.equal(graph['4'].class_type, 'TextEncodeQwenImage21')
    assert.equal(graph['4'].inputs.prompt, 'A wide photograph of a harbour at dawn, wooden boats along a stone quay.')
    assert.deepEqual(graph['4'].inputs.clip, ['2', 0])
    assert.equal(graph['5'].class_type, 'EmptyLatentImage')
    assert.deepEqual([graph['5'].inputs.width, graph['5'].inputs.height, graph['5'].inputs.batch_size], [1664, 928, 2])
    assert.equal(graph['6'].class_type, 'KSampler')
    assert.deepEqual([graph['6'].inputs.steps, graph['6'].inputs.seed, graph['6'].inputs.denoise], [12, 42, 1])
    assert.deepEqual(graph['6'].inputs.model, ['1', 0])
    assert.deepEqual(graph['7'].inputs.samples, ['6', 0])
    assert.equal(graph['8'].class_type, 'SaveImage')
    assert.equal(graph['8'].inputs.filename_prefix, 'dsh-image-forge')
    for (const node of Object.values(graph)) {
      assert.ok(!JSON.stringify(node.inputs).includes('{{'), 'no placeholder may survive rendering')
    }
    assert.equal(comfy.seen.find((entry) => entry.path === '/prompt').method, 'POST')

    // 3. polling actually happened, and /view was asked for both files.
    assert.ok(comfy.state.historyCalls >= 2, `expected repeated /history polling, saw ${comfy.state.historyCalls}`)
    assert.equal(comfy.seen.filter((entry) => entry.path === '/view').length, 2)
    assert.deepEqual(
      comfy.seen.filter((entry) => entry.path === '/view').map((entry) => entry.query.filename),
      ['dsh-image-forge_00001_.png', 'dsh-image-forge_00002_.png'],
    )

    // 4. the bytes on disk are the bytes served, under the required names.
    assert.equal(result.backend, 'comfyui')
    assert.equal(result.model, 'qwen_image_2.1_int8_convrot.safetensors')
    assert.equal(result.wh_ratio, '16:9')
    assert.deepEqual(result.size, { width: 1664, height: 928 })
    assert.equal(result.images.length, 2)
    const first = join(outputDir, 'harbour_1664x928_1.png')
    const second = join(outputDir, 'harbour_1664x928_2.png')
    assert.equal(result.images[0].path, first)
    assert.equal(result.images[1].path, second)
    assert.ok(existsSync(first) && existsSync(second))
    assert.equal(readFileSync(first).toString('base64'), PNG_1X1)
    assert.ok(readFileSync(second).equals(PNG_BINARY), 'binary bodies must not be decoded as text')
    assert.equal(result.images[0].mime, 'image/png')
    assert.equal(result.images[1].mime, 'image/png')
    assert.match(result.summary, /后端 comfyui/)
    assert.equal(result.markdown.split('\n').length, 2)
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('a ComfyUI without qwen weights is refused before /prompt, naming the file', async () => {
  const comfy = await startFakeComfy({
    objectInfo: {
      ...OBJECT_INFO,
      CLIPLoader: { input: { required: { clip_name: [['dino_v3_vit_h.safetensors'], {}], type: [['stable_diffusion', 'qwen_image'], {}] } } },
    },
  })
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-comfy-missing-'))
  try {
    const tools = register({
      comfyEndpoint: comfy.endpoint,
      comfyModelsDir: 'D:\\Comfy-Desktop\\ComfyUI-Shared\\models',
      outputDir,
    })
    const error = await failure(tools, 'image_forge_generate', { prompt: 'A cat.', wh_ratio: '1:1' })
    assert.ok(error instanceof Error)
    console.log('missing-weight error message:\n' + error.message)
    assert.match(error.message, /缺模型文件/)
    assert.match(error.message, /CLIPLoader\.clip_name/)
    assert.match(error.message, /qwen3vl_8b_int8_convrot\.safetensors/)
    assert.match(error.message, /D:\\Comfy-Desktop\\ComfyUI-Shared\\models\\clip\\/)
    assert.equal(comfy.seen.filter((entry) => entry.path === '/prompt').length, 0, 'nothing may be submitted when a weight is missing')
    assert.equal(comfy.seen.filter((entry) => entry.path === '/view').length, 0)
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('the folder hint joins with the configured path’s own separator style', async () => {
  const comfy = await startFakeComfy({
    objectInfo: {
      ...OBJECT_INFO,
      CLIPLoader: { input: { required: { clip_name: [['dino_v3_vit_h.safetensors'], {}], type: [['stable_diffusion', 'qwen_image'], {}] } } },
    },
  })
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-comfy-hint-'))
  try {
    // A Windows-shaped path keeps backslashes on every host: mixing them with
    // `/` produces `…\models/clip/`, a path consumers cannot paste anywhere.
    const windows = register({
      comfyEndpoint: comfy.endpoint,
      comfyModelsDir: 'D:\\Comfy-Desktop\\ComfyUI-Shared\\models',
      outputDir,
    })
    const windowsError = await failure(windows, 'image_forge_generate', { prompt: 'A cat.', wh_ratio: '1:1' })
    assert.match(windowsError.message, /放到：D:\\Comfy-Desktop\\ComfyUI-Shared\\models\\clip\\/)

    // …and a POSIX path keeps forward slashes, with a trailing separator
    // stripped first. This is the half that used to follow `process.platform`,
    // so a Linux CI run joined the Windows fixture above with `/`.
    const posix = register({
      comfyEndpoint: comfy.endpoint,
      comfyModelsDir: '/opt/ComfyUI/models/',
      outputDir,
    })
    const posixError = await failure(posix, 'image_forge_generate', { prompt: 'A cat.', wh_ratio: '1:1' })
    assert.match(posixError.message, /放到：\/opt\/ComfyUI\/models\/clip\//)
    assert.doesNotMatch(posixError.message, /models\\clip/)
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('with no ComfyUI running the error lists every port probed and how to start it', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-comfy-down-'))
  const first = await deadPort()
  const second = await deadPort()
  try {
    const tools = register({
      comfyEndpoint: '',
      comfyPorts: `${first},${second}`,
      outputDir,
      timeoutMs: 5000,
    })
    const error = await failure(tools, 'image_forge_generate', { prompt: 'A cat.', wh_ratio: '1:1' })
    assert.ok(error instanceof Error)
    console.log('not-running error message:\n' + error.message)
    assert.match(error.message, /没找到在跑的 ComfyUI/)
    assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${first}`))
    assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${second}`))
    assert.match(error.message, /已探测 2 个端口/)
    // The remedy has to name the one-command starter: "go read a 400-line
    // deployment doc" is what made this step feel like manual work.
    assert.match(error.message, /node scripts\/start-comfyui\.mjs/)
    assert.match(error.message, /--doctor/)
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('a non-loopback endpoint is refused before any socket opens', async () => {
  const comfy = await startFakeComfy()
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-comfy-remote-'))
  try {
    const tools = register({
      comfyEndpoint: 'http://192.168.1.5:8188',
      // Present only to prove the refusal happens before probing: an auto probe
      // would have found this live server.
      comfyPorts: String(comfy.port),
      outputDir,
    })
    for (const endpoint of ['http://192.168.1.5:8188', 'http://localhost.evil.example.com:8188', 'http://[::1]:1']) {
      const error = await failure(tools, 'image_forge_generate', { prompt: 'A cat.' })
      console.log(`endpoint ${endpoint} ->`, error instanceof Error ? error.message.split('\n')[0] : String(error))
      if (endpoint === 'http://[::1]:1') continue // loopback: allowed, so it fails later for a different reason
      assert.match(error.message, /只与\*\*本机回环地址\*\*|只与.*回环/)
    }
    assert.deepEqual(comfy.seen, [], 'no request may be sent to a non-loopback endpoint')
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('node_errors from /prompt are quoted verbatim', async () => {
  const comfy = await startFakeComfy({
    promptResponse: {
      status: 400,
      body: {
        error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '' },
        node_errors: {
          '2': {
            class_type: 'CLIPLoader',
            errors: [
              {
                type: 'value_not_in_list',
                message: 'Value not in list',
                details: 'type: qwen_image not in [stable_diffusion]',
                extra_info: { input_name: 'type', input_config: [['stable_diffusion'], {}], received_value: 'qwen_image' },
              },
            ],
          },
        },
      },
    },
  })
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-comfy-nodeerr-'))
  try {
    const tools = register({ comfyEndpoint: comfy.endpoint, outputDir })
    const error = await failure(tools, 'image_forge_generate', { prompt: 'A cat.' })
    assert.ok(error instanceof Error)
    console.log('node_errors message:\n' + error.message)
    assert.match(error.message, /HTTP 400/)
    assert.match(error.message, /prompt_outputs_failed_validation/)
    assert.match(error.message, /node 2 \(CLIPLoader\): value_not_in_list — Value not in list/)
    assert.match(error.message, /received_value="qwen_image"/)
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('an execution error carries the upstream message and traceback', async () => {
  const message = 'hostbuf_file_reader_read failed'
  const comfy = await startFakeComfy({
    history: [
      {},
      {
        [PROMPT_ID]: {
          outputs: {},
          status: {
            status_str: 'error',
            completed: true,
            messages: [
              [
                'execution_error',
                {
                  prompt_id: PROMPT_ID,
                  node_id: '6',
                  node_type: 'KSampler',
                  exception_type: 'RuntimeError',
                  exception_message: `${message}\n`,
                  traceback: ['  File "memory_management.py", line 59, in read_tensor_file_slice_into\n', '    boom\n'],
                },
              ],
            ],
          },
        },
      },
    ],
  })
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-comfy-execerr-'))
  try {
    const tools = register({ comfyEndpoint: comfy.endpoint, outputDir })
    const error = await failure(tools, 'image_forge_generate', { prompt: 'A cat.' })
    assert.ok(error instanceof Error)
    console.log('execution-error message:\n' + error.message)
    assert.match(error.message, /出图失败/)
    assert.ok(error.message.includes(message), 'the upstream exception message must survive verbatim')
    assert.match(error.message, /node 6 \(KSampler\) RuntimeError/)
    assert.match(error.message, /traceback:/)
    assert.match(error.message, /memory_management\.py/)
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('generation always runs on ComfyUI, and the failure names the remedy', async () => {
  const comfy = await startFakeComfy()
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-comfy-only-'))
  try {
    const tools = register({ comfyEndpoint: comfy.endpoint, outputDir })
    const result = await run(tools, 'image_forge_generate', { prompt: 'A cat.', wh_ratio: '1:1' })
    console.log('generate ->', result.backend, result.comfyui.endpoint)
    assert.equal(result.backend, 'comfyui')
    assert.ok(comfy.seen.some((entry) => entry.path === '/prompt'), 'the generation must reach ComfyUI')

    const dead = await deadPort()
    const down = register({ comfyEndpoint: '', comfyPorts: String(dead), timeoutMs: 5000, outputDir })
    const error = await failure(down, 'image_forge_generate', { prompt: 'A cat.' })
    console.log('generate with ComfyUI down:\n' + error.message)
    assert.match(error.message, /comfyui backend: 没找到在跑的 ComfyUI/)
    // There is no second backend to fall back to, so the message has to point
    // at the deployment document instead of naming remedies that do not exist.
    assert.match(error.message, /docs\/comfyui-deployment\.md/)
    assert.ok(!/backend "api"|no backend is available/.test(error.message), 'the removed cloud backend is still offered')
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('image_forge_status reports ComfyUI reachability and the weights it can see', async () => {
  const comfy = await startFakeComfy()
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-comfy-status-'))
  try {
    const tools = register({ comfyEndpoint: comfy.endpoint, comfyModelsDir: 'D:\\models', apiKey: '', outputDir })
    const status = await run(tools, 'image_forge_status', { timeoutMs: 5000 })
    console.log('status.comfyui:', JSON.stringify(status.comfyui, null, 1))
    assert.equal(status.comfyui.reachable, true)
    assert.equal(status.comfyui.port, comfy.port)
    assert.deepEqual(status.comfyui.models, {
      unet: 'qwen_image_2.1_int8_convrot.safetensors',
      clip: 'qwen3vl_8b_int8_convrot.safetensors',
      vae: 'qwen_image_2.1_vae_bf16.safetensors',
      clipType: 'qwen_image',
      ok: true,
      // The default fake server has no QwenImage21Cache node, so the status report
      // says the shim will be skipped.
      cache: false,
    })

    // Hardware facts come from ComfyUI's own `/system_stats`, not from a process
    // this plugin spawns: the card that matters is the one it loaded weights onto.
    assert.equal(status.comfyui.version, 'fake-0.0')
    assert.equal(status.comfyui.qwen_cache.min_version, '0.37.0')
    assert.equal(status.comfyui.qwen_cache.version_satisfied, null, 'fake-0.0 cannot be ordered')
    assert.match(status.comfyui.qwen_cache.note, /0\.37\.0/)
    assert.deepEqual(status.comfyui.devices, [{ name: 'fake-gpu', type: null, vram_total_MiB: null, vram_free_MiB: 0 }])
    assert.equal(status.comfyui.stats_note, null)

    // A second call must not turn the server into something else: the report is
    // passive and reads the same endpoint.
    const again = await run(tools, 'image_forge_status', { timeoutMs: 3000 })
    assert.equal(again.comfyui.reachable, true)
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('image_forge_status on a machine with nothing running still answers', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-comfy-status-down-'))
  const dead = await deadPort()
  try {
    const tools = register({ comfyEndpoint: '', comfyPorts: String(dead), apiKey: '', outputDir })
    const status = await run(tools, 'image_forge_status', { timeoutMs: 3000 })
    console.log('status.comfyui (nothing running):', JSON.stringify(status.comfyui, null, 1))
    assert.equal(status.comfyui.reachable, false)
    assert.deepEqual(status.comfyui.candidatePorts, [dead])
    assert.match(status.comfyui.note, /没找到在跑的 ComfyUI/)
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// QwenImage21Cache: the official prefix-cache shim, and the graceful degrade.
// ---------------------------------------------------------------------------

/** The `/object_info` entry a ComfyUI >= 0.37.0 answers for the cache node. */
const QWEN_CACHE_OBJECT_INFO = {
  input: {
    required: {
      model: ['MODEL', {}],
      device: [['auto', 'gpu', 'cpu', 'off'], {}],
      dtype: [['default', 'int8', 'int4'], {}],
    },
  },
  output: ['MODEL'],
}

test('all four Qwen workflow graphs chain QwenImage21Cache after the UNETLoader', () => {
  for (const graph of [QWEN_IMAGE_WORKFLOW, QWEN_IMAGE_EDIT_WORKFLOW, QWEN_IMAGE_TURBO_WORKFLOW, QWEN_IMAGE_TURBO_EDIT_WORKFLOW]) {
    const cache = Object.entries(graph).filter(([, node]) => node.class_type === 'QwenImage21Cache')
    assert.equal(cache.length, 1, 'each Qwen graph carries exactly one cache shim')
    const [cacheId, cacheNode] = cache[0]
    assert.deepEqual(cacheNode.inputs.model, ['1', 0])
    assert.equal(cacheNode.inputs.device, 'auto', 'the gpu device has known corruption bugs')
    assert.equal(cacheNode.inputs.dtype, 'default', 'the lossless dtype')
    const sampler = Object.values(graph).find((node) => node.class_type === 'KSampler' || node.class_type === 'CFGGuider')
    assert.ok(sampler !== undefined)
    assert.deepEqual(sampler.inputs.model, [cacheId, 0], 'the sampler must consume the cache output')
  }
  // The shim is a Qwen built-in: the MOSS graph must never carry it.
  assert.equal(Object.values(MOSS_IMAGE_WORKFLOW).some((node) => node.class_type === 'QwenImage21Cache'), false)
})

test('QwenImage21Cache is on for a new server and stripped for an old one', async () => {
  const withCache = structuredClone(OBJECT_INFO)
  withCache.QwenImage21Cache = QWEN_CACHE_OBJECT_INFO
  withCache.UNETLoader.input.required.unet_name[0].push('qwen_image_2.1_turbo_int8_convrot.safetensors')
  const modern = await startFakeComfy({ objectInfo: withCache })
  const legacy = await startFakeComfy() // no QwenImage21Cache node
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-qwen-cache-'))
  try {
    const args = { prompt: 'A cat.', wh_ratio: '1:1', seed: 5 }
    const cacheNodeOf = (graph) => Object.entries(graph).find(([, node]) => node.class_type === 'QwenImage21Cache')

    // 1. New server: base t2i keeps the shim, and the KSampler consumes it.
    const baseTools = register({ comfyEndpoint: modern.endpoint, outputDir, timeoutMs: 30_000 })
    const base = await run(baseTools, 'image_forge_generate', args)
    const baseCache = cacheNodeOf(modern.state.graph)
    assert.ok(baseCache !== undefined, 'the modern server must receive QwenImage21Cache')
    assert.deepEqual(modern.state.graph['6'].inputs.model, [baseCache[0], 0])
    assert.equal(base.comfyui.cache, 'on')

    // 2. New server: turbo t2i keeps it too, and the CFGGuider consumes it.
    const turboTools = register({ comfyEndpoint: modern.endpoint, comfyModel: 'qwen21-turbo', outputDir, timeoutMs: 30_000 })
    const turbo = await run(turboTools, 'image_forge_generate', args)
    const turboCache = cacheNodeOf(modern.state.graph)
    assert.ok(turboCache !== undefined)
    assert.deepEqual(modern.state.graph['7'].inputs.model, [turboCache[0], 0])
    assert.equal(turbo.comfyui.cache, 'on')
    assert.equal(turbo.model, 'qwen_image_2.1_turbo_int8_convrot.safetensors')

    // 3. Old server: the shim is stripped instead of submitting an unknown node.
    const legacyTools = register({ comfyEndpoint: legacy.endpoint, outputDir, timeoutMs: 30_000 })
    const degraded = await run(legacyTools, 'image_forge_generate', args)
    assert.equal(cacheNodeOf(legacy.state.graph), undefined, 'the old server must not receive the node')
    assert.deepEqual(legacy.state.graph['6'].inputs.model, ['1', 0])
    assert.equal(degraded.comfyui.cache, 'skipped')
    assert.match(String(degraded.comfyui.cache_note), /QwenImage21Cache/)
    assert.match(String(degraded.comfyui.cache_note), /0\.37\.0/)
  } finally {
    await modern.close()
    await legacy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('image_forge_status compares the ComfyUI version against the cache requirement', async () => {
  const modern = await startFakeComfy({ version: '0.45.3' })
  const old = await startFakeComfy({ version: '0.30.2' })
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-cache-version-'))
  try {
    const modernStatus = await run(register({ comfyEndpoint: modern.endpoint, outputDir }), 'image_forge_status', { timeoutMs: 5000 })
    assert.equal(modernStatus.comfyui.version, '0.45.3')
    assert.equal(modernStatus.comfyui.qwen_cache.version_satisfied, true)
    assert.match(modernStatus.comfyui.qwen_cache.note, /0\.37\.0/)

    const oldStatus = await run(register({ comfyEndpoint: old.endpoint, outputDir }), 'image_forge_status', { timeoutMs: 5000 })
    assert.equal(oldStatus.comfyui.qwen_cache.version_satisfied, false)
    assert.match(oldStatus.comfyui.qwen_cache.note, /低于 0\.37\.0|自动跳过/)
  } finally {
    await modern.close()
    await old.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The advanced sampler tier: optional, ComfyUI-native, Qwen base only.
// ---------------------------------------------------------------------------

test('the sampler tier is opt-in and native-only; turbo/MOSS refuse it', async () => {
  const comfy = await startFakeComfy()
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-sampler-tier-'))
  try {
    const base = (overrides) => register({ comfyEndpoint: comfy.endpoint, outputDir, timeoutMs: 30_000, ...overrides })
    const args = { prompt: 'A cat.', wh_ratio: '1:1', seed: 4 }
    const sampler = () => comfy.state.graph['6'].inputs

    // 1. Default path stays euler/simple.
    const plain = await run(base({}), 'image_forge_generate', args)
    assert.deepEqual([sampler().sampler_name, sampler().scheduler], ['euler', 'simple'])
    assert.equal(plain.sampling, undefined)

    // 2. An explicit pair reaches KSampler and is reported with its evidence level.
    const custom = await run(base({}), 'image_forge_generate', { ...args, sampler: 'res_multistep', scheduler: 'beta' })
    assert.deepEqual([sampler().sampler_name, sampler().scheduler], ['res_multistep', 'beta'])
    assert.equal(custom.sampling.sampler, 'res_multistep')
    assert.equal(custom.sampling.scheduler, 'beta')
    assert.match(custom.sampling.note, /孤证/)

    // 3. One half alone keeps the profile's other half.
    await run(base({}), 'image_forge_generate', { ...args, sampler: 'er_sde' })
    assert.deepEqual([sampler().sampler_name, sampler().scheduler], ['er_sde', 'simple'])
    await run(base({}), 'image_forge_generate', { ...args, scheduler: 'karras' })
    assert.deepEqual([sampler().sampler_name, sampler().scheduler], ['euler', 'karras'])

    // 4. Third-party samplers are refused before any backend call.
    const before = comfy.seen.filter((entry) => entry.path === '/prompt').length
    const thirdParty = await failure(base({}), 'image_forge_generate', { ...args, sampler: 'abnorsett_3m' })
    // The tool schema rejects anything outside the native enum before execute runs.
    assert.match(thirdParty.message, /invalid arguments/)
    assert.match(thirdParty.message, /sampler.*must be one of/)
    assert.ok(!thirdParty.message.includes('abnorsett_3m"'))

    // 5. turbo and MOSS refuse the tier (their sampling is not a free KSampler).
    const turbo = await failure(base({ comfyModel: 'qwen21-turbo' }), 'image_forge_generate', { ...args, sampler: 'res_multistep' })
    assert.match(turbo.message, /只对 Qwen base 生效/)
    const moss = await failure(base({ comfyModel: 'moss-sft' }), 'image_forge_generate', { ...args, scheduler: 'beta' })
    assert.match(moss.message, /只对 Qwen base 生效/)
    assert.equal(comfy.seen.filter((entry) => entry.path === '/prompt').length, before, 'refusals must not submit')
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('the Qwen text encoder prefers w4a8 over int8 over bf16', async () => {
  /** The fake server with a chosen CLIPLoader option list. */
  const qwenWithClips = (clipNames) => {
    const info = structuredClone(OBJECT_INFO)
    info.CLIPLoader.input.required.clip_name[0] = clipNames
    return info
  }
  const all = await startFakeComfy({
    objectInfo: qwenWithClips([
      'qwen3vl_8b_bf16.safetensors',
      'qwen3vl_8b_int8_convrot.safetensors',
      'qwen3vl_8b_w4a8.safetensors',
      'qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors',
    ]),
  })
  const int8Only = await startFakeComfy({
    objectInfo: qwenWithClips(['qwen3vl_8b_bf16.safetensors', 'qwen3vl_8b_int8_convrot.safetensors']),
  })
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-te-tier-'))
  try {
    const args = { prompt: 'A cat.', wh_ratio: '1:1', seed: 3 }
    const w4a8 = await run(register({ comfyEndpoint: all.endpoint, outputDir, timeoutMs: 30_000 }), 'image_forge_generate', args)
    console.log('TE with all tiers:', w4a8.comfyui.models.clip)
    // The 8 GB-friendly encoder must outrank int8_convrot even though the server
    // lists int8 first; the quantisation marker is the tie-breaker.
    assert.equal(w4a8.comfyui.models.clip, 'qwen3vl_8b_w4a8.safetensors')
    // The DiT's own preference is untouched: int8_convrot still beats bf16.
    assert.equal(w4a8.comfyui.models.unet, 'qwen_image_2.1_int8_convrot.safetensors')
    // The prompt-enhancer encoders never win, even though they match /qwen/i.
    assert.notEqual(w4a8.comfyui.models.clip, 'qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors')

    const int8 = await run(
      register({ comfyEndpoint: int8Only.endpoint, outputDir, timeoutMs: 30_000 }),
      'image_forge_generate',
      args,
    )
    console.log('TE without w4a8:', int8.comfyui.models.clip)
    assert.equal(int8.comfyui.models.clip, 'qwen3vl_8b_int8_convrot.safetensors', 'no w4a8 file -> int8 remains')
  } finally {
    await all.close()
    await int8Only.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('comfyModel: turbo runs the turbo DiT even when the base checkpoint is installed too', async () => {
  // The documented deployment ships BOTH checkpoints. Name scoring ties on
  // "image" + "2.1" + "int8", and a tie keeps the server's order — which lists
  // base first — so without an explicit promotion `comfyModel: 'turbo'` fell
  // through to base on every call and the turbo graph was unreachable.
  const both = structuredClone(OBJECT_INFO)
  both.UNETLoader.input.required.unet_name[0].push('qwen_image_2.1_turbo_int8_convrot.safetensors')
  const turboComfy = await startFakeComfy({ objectInfo: both })
  const baseComfy = await startFakeComfy({ objectInfo: both })
  const fallbackComfy = await startFakeComfy() // base only
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-comfy-turbo-'))
  const args = { prompt: 'A plain ceramic mug on a wooden desk, soft window light.', wh_ratio: '1:1', seed: 7 }
  try {
    const turboTools = register({ comfyEndpoint: turboComfy.endpoint, comfyModel: 'turbo', outputDir, timeoutMs: 30_000 })
    const turbo = await run(turboTools, 'image_forge_generate', args)
    assert.equal(turbo.model, 'qwen_image_2.1_turbo_int8_convrot.safetensors')
    assert.equal(turbo.comfyui.comfyModel, 'turbo')
    // The legacy config value normalises to the canonical profile id, which is
    // what the report names.
    assert.equal(turbo.comfyui.profile, 'qwen21-turbo')
    assert.equal(turbo.steps_used, 8)
    assert.equal(turbo.comfyui.turbo_fallback, undefined)
    assert.equal(turboComfy.state.graph['1'].inputs.unet_name, 'qwen_image_2.1_turbo_int8_convrot.safetensors')

    const baseTools = register({ comfyEndpoint: baseComfy.endpoint, comfyModel: 'base', outputDir, timeoutMs: 30_000 })
    const base = await run(baseTools, 'image_forge_generate', args)
    assert.equal(base.model, 'qwen_image_2.1_int8_convrot.safetensors')
    assert.equal(base.comfyui.comfyModel, 'base')
    assert.equal(base.comfyui.profile, 'qwen21-base')
    assert.equal(base.steps_used, 40)

    // Asking for turbo on a base-only install still produces an image, and says why.
    const fallbackTools = register({ comfyEndpoint: fallbackComfy.endpoint, comfyModel: 'turbo', outputDir, timeoutMs: 30_000 })
    const fallback = await run(fallbackTools, 'image_forge_generate', args)
    assert.equal(fallback.model, 'qwen_image_2.1_int8_convrot.safetensors')
    assert.equal(fallback.comfyui.comfyModel, 'base')
    assert.match(String(fallback.comfyui.turbo_fallback), /没有 turbo 权重/)
  } finally {
    await turboComfy.close()
    await baseComfy.close()
    await fallbackComfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The quality tier: cfg / negative_prompt, Qwen base only.
//
// Official 2.1 contract: cfg stays 1 unless a negative prompt is really wanted —
// at cfg 1 ComfyUI skips the negative conditioning pass. The tier therefore has
// two obligations this pins down: an omitted pair must leave the graph untouched,
// and an asked-for pair must move the values *and* the reported cost.
// ---------------------------------------------------------------------------

test('an omitted quality tier renders the byte-identical Qwen base graph', async () => {
  const comfy = await startFakeComfy()
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-quality-default-'))
  try {
    const tools = register({ comfyEndpoint: comfy.endpoint, outputDir, timeoutMs: 30_000 })
    const result = await run(tools, 'image_forge_generate', { prompt: 'A cat.', wh_ratio: '1:1', seed: 5 })
    // cfg 1 / empty negative prompt are the official path: nothing may move when
    // the tier is not asked for.
    assert.equal(comfy.state.graph['6'].inputs.cfg, 1)
    assert.equal(comfy.state.graph['4'].inputs.negative_prompt, '')
    assert.deepEqual(comfy.state.graph['6'].inputs.negative, ['4', 1])
    assert.equal(result.quality, undefined, 'no quality block on the default path')
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('the quality tier raises cfg, wires the negative prompt, and reports the cost', async () => {
  const { QUALITY_NEGATIVE_PROMPT } = await import('../testlib/tools.js')
  const comfy = await startFakeComfy()
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-quality-tier-'))
  try {
    const tools = register({ comfyEndpoint: comfy.endpoint, outputDir, timeoutMs: 30_000 })
    const explicit = await run(tools, 'image_forge_generate', {
      prompt: 'A cat.',
      wh_ratio: '1:1',
      seed: 5,
      cfg: 2.5,
      negative_prompt: 'overly warm color temperature',
    })
    assert.equal(comfy.state.graph['6'].inputs.cfg, 2.5)
    assert.equal(comfy.state.graph['4'].inputs.negative_prompt, 'overly warm color temperature')
    // The negative conditioning is the encode node's second output, so cfg>1 really
    // runs a negative pass instead of only relabelling cfg.
    assert.deepEqual(comfy.state.graph['6'].inputs.negative, ['4', 1])
    assert.equal(explicit.quality.cfg, 2.5)
    assert.equal(explicit.quality.negative_prompt_source, 'caller')
    assert.match(explicit.quality.note, /翻倍/)

    const auto = await run(tools, 'image_forge_generate', { prompt: 'A cat.', wh_ratio: '1:1', seed: 5, cfg: 3 })
    assert.equal(comfy.state.graph['6'].inputs.cfg, 3)
    assert.equal(comfy.state.graph['4'].inputs.negative_prompt, QUALITY_NEGATIVE_PROMPT)
    assert.equal(auto.quality.negative_prompt_source, 'auto')
    assert.match(auto.quality.note, /暂定/)
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('the quality tier is refused where CFG is not a free KSampler input', async () => {
  const comfy = await startFakeComfy()
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-quality-refuse-'))
  try {
    const base = (overrides) => register({ comfyEndpoint: comfy.endpoint, outputDir, timeoutMs: 30_000, ...overrides })

    // turbo: fixed ManualSigmas graph, no free cfg.
    const turbo = await failure(base({ comfyModel: 'qwen21-turbo' }), 'image_forge_generate', { prompt: 'A cat.', wh_ratio: '1:1', cfg: 2.5 })
    assert.match(turbo.message, /只对 Qwen base 生效/)
    assert.match(turbo.message, /turbo/)

    // MOSS: CFG belongs to the sampling register.
    const moss = await failure(base({ comfyModel: 'moss-sft' }), 'image_forge_generate', { prompt: 'A cat.', wh_ratio: '1:1', cfg: 2.5 })
    assert.match(moss.message, /只对 Qwen base 生效/)
    assert.match(moss.message, /mossSampling/)

    const outOfRange = await failure(base({}), 'image_forge_generate', { prompt: 'A cat.', wh_ratio: '1:1', cfg: 7 })
    assert.match(outOfRange.message, /between 1 and 5/)

    // A negative prompt at cfg 1 would be silently ignored, so it is refused.
    const inert = await failure(base({}), 'image_forge_generate', { prompt: 'A cat.', wh_ratio: '1:1', negative_prompt: 'blurry' })
    assert.match(inert.message, /cfg > 1/)

    // Multi-reference edit + elevated cfg is the documented artifact case.
    const refs = [join(outputDir, 'a.png'), join(outputDir, 'b.png')]
    for (const file of refs) writeFileSync(file, Buffer.from(PNG_1X1, 'base64'))
    const multi = await failure(base({}), 'image_forge_edit', { prompt: '换掉标题', images: refs, cfg: 2 })
    assert.match(multi.message, /多参考/)
    assert.match(multi.message, /cfg=1/)

    // None of those refusals may reach a backend.
    assert.equal(comfy.seen.filter((entry) => entry.path === '/prompt').length, 0)
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Model profiles: a second family without a second adapter.
// ---------------------------------------------------------------------------

/** The weights as `/object_info` lists them on a machine with BOTH families installed. */
const BOTH_FAMILIES_OBJECT_INFO = {
  UNETLoader: {
    input: {
      required: {
        unet_name: [
          [
            'qwen_image_2.1_int8_convrot.safetensors',
            'qwen_image_2.1_turbo_int8_convrot.safetensors',
            'moss_image_sft_int8_convrot.safetensors',
            'moss_image_sft_bf16.safetensors',
          ],
          {},
        ],
        weight_dtype: [['default', 'fp8_e4m3fn'], {}],
      },
    },
  },
  CLIPLoader: {
    input: {
      required: {
        clip_name: [
          [
            'qwen3vl_8b_int8_convrot.safetensors',
            'qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors',
            'qwen3.5_9b_w4a8_gptq.safetensors',
          ],
          {},
        ],
        type: [['stable_diffusion', 'qwen_image', 'moss_image'], {}],
      },
    },
  },
  VAELoader: {
    input: {
      required: {
        vae_name: [['qwen_image_2.1_vae_bf16.safetensors', 'flux2-vae_small.safetensors'], {}],
      },
    },
  },
}

test('the profile registry is total: three ids, the two legacy spellings, one default', () => {
  assert.deepEqual([...COMFY_MODEL_IDS], ['qwen21-base', 'qwen21-turbo', 'moss-sft'])
  assert.deepEqual([...LEGACY_COMFY_MODEL_IDS], ['base', 'turbo'])

  // The compatibility contract: an old config value keeps meaning what it meant.
  assert.equal(resolveProfile('base').id, 'qwen21-base')
  assert.equal(resolveProfile('turbo').id, 'qwen21-turbo')
  assert.equal(resolveProfile('qwen21-base').id, 'qwen21-base')
  assert.equal(resolveProfile('qwen21-turbo').id, 'qwen21-turbo')
  assert.equal(resolveProfile('moss-sft').id, 'moss-sft')
  // A typo or a missing field resolves to the default instead of throwing: a bad
  // config must not make the plugin unusable.
  assert.equal(resolveProfile(undefined).id, 'qwen21-base')
  assert.equal(resolveProfile('qwne21-base').id, 'qwen21-base')
  assert.equal(resolveProfile('').id, 'qwen21-base')

  assert.equal(isComfyModelId('moss-sft'), true)
  assert.equal(isComfyModelId('base'), false, 'a legacy id is not a canonical profile id')
  assert.equal(isComfyModelId(undefined), false)

  for (const profile of Object.values(MODEL_PROFILES)) {
    console.log('profile:', profile.id, '->', profile.weights.unet.required, profile.weights.vae.required)
    assert.equal(profile.id, profile.id.trim())
    assert.ok(profile.label.length > 0)
    assert.ok(profile.sampler.cfg > 0)
    assert.ok(profile.steps.default >= 1)
    assert.ok(Object.keys(profile.textToImage).length > 0, `${profile.id} needs a text-to-image graph`)
    // A legacy id can map to exactly one canonical profile.
    assert.ok(profile.legacyIds.every((id) => resolveProfile(id).id === profile.id))
  }
  // MOSS's matchers must not carry the old hard gate: its DiT and VAE file names
  // contain no "qwen" at all.
  const moss = MODEL_PROFILES['moss-sft']
  assert.equal(moss.weights.unet.required.test('moss_image_sft_int8_convrot.safetensors'), true)
  assert.equal(moss.weights.vae.required.test('flux2-vae_small.safetensors'), true)
  assert.ok(!/qwen/i.test('moss_image_sft_int8_convrot.safetensors'))
  assert.ok(!/qwen/i.test('flux2-vae_small.safetensors'))
  // ...and the Qwen matchers must not claim MOSS's files.
  assert.equal(MODEL_PROFILES['qwen21-base'].weights.unet.required.test('moss_image_sft_int8_convrot.safetensors'), false)
});

test('the latent alignment each profile declares is the one its sizes satisfy', () => {
  // MOSS's EmptyFlux2LatentImage wants 16-pixel multiples; `ratio.ts` produces
  // 32-aligned canvases, which is the reason the pixel policy did not have to
  // fork between families.
  assert.equal(MOSS_LATENT_MULTIPLE, 16)
  assert.equal(MODEL_PROFILES['moss-sft'].latent.classType, 'EmptyFlux2LatentImage')
  assert.equal(MODEL_PROFILES['qwen21-base'].latent.classType, 'EmptyLatentImage')
  assertLatentAligned(MODEL_PROFILES['moss-sft'], 1024, 1024)
  assertLatentAligned(MODEL_PROFILES['moss-sft'], 1664, 928)
  assert.throws(() => assertLatentAligned(MODEL_PROFILES['moss-sft'], 1030, 1024), /16/)
  assert.throws(() => assertLatentAligned(MODEL_PROFILES['qwen21-base'], 1040, 1024), /32/)
});

test('a turbo request on a base-only install runs the base graph, never the sigma schedule', () => {
  const baseOnly = { unet: 'qwen_image_2.1_int8_convrot.safetensors', clip: 'q', vae: 'v', clipType: 'qwen_image' }
  assert.equal(effectiveProfile('qwen21-turbo', baseOnly).id, 'qwen21-base')
  assert.equal(effectiveProfile('turbo', baseOnly).id, 'qwen21-base')
  const withTurbo = { ...baseOnly, unet: 'qwen_image_2.1_turbo_int8_convrot.safetensors' }
  assert.equal(effectiveProfile('qwen21-turbo', withTurbo).id, 'qwen21-turbo')
  // MOSS is a different family: it is never silently swapped for Qwen.
  const moss = { unet: 'moss_image_sft_int8_convrot.safetensors', clip: 'q', vae: 'flux2-vae_small.safetensors', clipType: 'moss_image' }
  assert.equal(effectiveProfile('moss-sft', moss).id, 'moss-sft')
});

test('MOSS weights are selected by their own names, not by a "qwen" gate', async () => {
  const comfy = await startFakeComfy({ objectInfo: BOTH_FAMILIES_OBJECT_INFO })
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-moss-select-'))
  try {
    const tools = register({ comfyEndpoint: comfy.endpoint, comfyModelsDir: 'D:\\models', comfyModel: 'moss-sft', outputDir, timeoutMs: 30_000 })
    const result = await run(tools, 'image_forge_generate', { prompt: 'A brass compass on slate.', wh_ratio: '1:1' })
    console.log('MOSS models:', JSON.stringify(result.comfyui.models))
    assert.equal(result.model, 'moss_image_sft_int8_convrot.safetensors')
    assert.equal(result.comfyui.models.unet, 'moss_image_sft_int8_convrot.safetensors')
    assert.equal(result.comfyui.models.clip, 'qwen3.5_9b_w4a8_gptq.safetensors')
    assert.equal(result.comfyui.models.vae, 'flux2-vae_small.safetensors')
    assert.equal(result.comfyui.models.clipType, 'moss_image')
    assert.equal(result.comfyui.comfyModel, 'moss')
    assert.equal(result.comfyui.profile, 'moss-sft')
    // The key point: neither file name mentions "qwen", so the old hard gate
    // could never have selected them.
    assert.ok(!/qwen/i.test(result.comfyui.models.unet))
    assert.ok(!/qwen/i.test(result.comfyui.models.vae))
    assert.equal(comfy.seen.filter((entry) => entry.path === '/prompt').length, 1)

    // Switching back to a Qwen profile over the SAME server picks the Qwen files
    // again: two profiles, one selector.
    const qwenTools = register({ comfyEndpoint: comfy.endpoint, comfyModelsDir: 'D:\\models', comfyModel: 'qwen21-base', outputDir, timeoutMs: 30_000 })
    const qwen = await run(qwenTools, 'image_forge_generate', { prompt: 'A brass compass on slate.', wh_ratio: '1:1' })
    assert.equal(qwen.comfyui.models.unet, 'qwen_image_2.1_int8_convrot.safetensors', 'base must not claim the MOSS DiT')
    assert.equal(qwen.comfyui.models.vae, 'qwen_image_2.1_vae_bf16.safetensors')
    assert.equal(qwen.comfyui.models.clipType, 'qwen_image')
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
});

test('the MOSS graph on the wire is the official MOSS template, not the Qwen one', async () => {
  const comfy = await startFakeComfy({ objectInfo: BOTH_FAMILIES_OBJECT_INFO })
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-moss-graph-'))
  try {
    const tools = register({ comfyEndpoint: comfy.endpoint, comfyModelsDir: 'D:\\models', comfyModel: 'moss-sft', outputDir, timeoutMs: 30_000 })
    const args = { prompt: 'A night street with a MOSS marquee.', wh_ratio: '16:9', seed: 42, steps: 12, count: 1 }
    const result = await run(tools, 'image_forge_generate', args)
    const graph = comfy.state.graph
    console.log('MOSS graph node classes:', JSON.stringify(Object.entries(graph).map(([id, node]) => [id, node.class_type])))
    assert.deepEqual(Object.keys(graph).sort((a, b) => Number(a) - Number(b)), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])

    const classes = Object.values(graph).map((node) => node.class_type)
    for (const absent of ['TextEncodeQwenImage21', 'EmptyLatentImage', 'SamplerCustomAdvanced']) {
      assert.ok(!classes.includes(absent), `the MOSS graph must not carry ${absent}`)
    }
    for (const present of ['CLIPTextEncode', 'EmptyFlux2LatentImage', 'SkipLayerGuidanceDiTSimple', 'KSampler']) {
      assert.ok(classes.includes(present), `the MOSS graph must carry ${present}`)
    }

    assert.equal(graph['1'].class_type, 'UNETLoader')
    assert.equal(graph['1'].inputs.unet_name, 'moss_image_sft_int8_convrot.safetensors')
    assert.equal(graph['1'].inputs.weight_dtype, 'default')
    assert.equal(graph['2'].class_type, 'CLIPLoader')
    assert.equal(graph['2'].inputs.clip_name, 'qwen3.5_9b_w4a8_gptq.safetensors')
    assert.equal(graph['2'].inputs.type, 'moss_image')
    assert.equal(graph['3'].inputs.vae_name, 'flux2-vae_small.safetensors')
    // Two separate encodes, unlike Qwen's single dual-output node.
    assert.equal(graph['4'].class_type, 'CLIPTextEncode')
    assert.equal(graph['4'].inputs.text, 'A night street with a MOSS marquee.')
    assert.deepEqual(graph['4'].inputs.clip, ['2', 0])
    assert.equal(graph['5'].class_type, 'CLIPTextEncode')
    assert.equal(graph['5'].inputs.text, MOSS_NEGATIVE_PROMPT)
    assert.deepEqual(graph['5'].inputs.clip, ['2', 0])
    // 1664x928 from the 16:9 tier: 32-aligned, so also a legal 16-multiple canvas.
    assert.equal(graph['6'].class_type, 'EmptyFlux2LatentImage')
    assert.deepEqual([graph['6'].inputs.width, graph['6'].inputs.height, graph['6'].inputs.batch_size], [1664, 928, 1])
    assert.equal(graph['6'].inputs.width % 16, 0)
    assert.equal(graph['6'].inputs.height % 16, 0)
    // Skip-layer guidance sits between the DiT and the sampler, layer 22.
    assert.equal(graph['7'].class_type, 'SkipLayerGuidanceDiTSimple')
    assert.deepEqual(graph['7'].inputs.model, ['1', 0])
    assert.equal(graph['7'].inputs.double_layers, '')
    assert.equal(graph['7'].inputs.single_layers, '22')
    assert.equal(graph['7'].inputs.start_percent, 0)
    assert.equal(graph['7'].inputs.end_percent, 0.5)
    // Sampler: the profile's numbers, and the explicit step count still wins.
    assert.equal(graph['8'].class_type, 'KSampler')
    assert.deepEqual(graph['8'].inputs.model, ['7', 0])
    assert.deepEqual(graph['8'].inputs.positive, ['4', 0])
    assert.deepEqual(graph['8'].inputs.negative, ['5', 0])
    assert.deepEqual(graph['8'].inputs.latent_image, ['6', 0])
    assert.equal(graph['8'].inputs.steps, 12)
    assert.equal(graph['8'].inputs.cfg, 2.5)
    assert.equal(graph['8'].inputs.sampler_name, 'er_sde')
    assert.equal(graph['8'].inputs.scheduler, 'simple')
    assert.equal(graph['8'].inputs.denoise, 1)
    assert.equal(graph['8'].inputs.seed, 42)
    assert.deepEqual(graph['9'].inputs.samples, ['8', 0])
    assert.deepEqual(graph['9'].inputs.vae, ['3', 0])
    assert.equal(graph['10'].class_type, 'SaveImage')
    assert.equal(graph['10'].inputs.filename_prefix, 'dsh-image-forge-moss')
    assert.equal(result.steps_used, 12)
    assert.equal(result.size.width, 1664)
    assert.equal(result.size.height, 928)
    // The default step count for MOSS is the template's 25, not a Qwen-derived 8.
    assert.equal(MODEL_PROFILES['moss-sft'].steps.default, 25)
    assert.equal(Object.values(MOSS_IMAGE_WORKFLOW).some((node) => node.class_type === 'ManualSigmas'), false)
    assert.equal(Object.values(QWEN_IMAGE_WORKFLOW).some((node) => node.class_type === 'EmptyFlux2LatentImage'), false)
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
});

// ---------------------------------------------------------------------------
// The Agent tool path carries the same register.
//
// `mossSampling` used to reach the Studio only, so a tool call could not select
// MOSS's second register at all: the sampler numbers moved, but the step count
// stayed at the shared 25 that a 50-step register never agrees with. Both these
// tests observe the graph the fake server received, not a helper's return value.
// ---------------------------------------------------------------------------

test('MOSS sampling: the Agent tool puts the selected register on the wire too', async () => {
  const comfy = await startFakeComfy({ objectInfo: BOTH_FAMILIES_OBJECT_INFO })
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-moss-agent-register-'))
  try {
    // A fixed `seed` on every call, so the graphs stay comparable field for field.
    const args = { prompt: 'A night street with a MOSS marquee.', wh_ratio: '1:1', seed: 42, count: 1 }
    const mossTools = (overrides) =>
      register({ comfyEndpoint: comfy.endpoint, comfyModelsDir: 'D:\\models', comfyModel: 'moss-sft', outputDir, timeoutMs: 30_000, ...overrides })
    const sampler = () => comfy.state.graph['8'].inputs

    // 1. The default register is the ComfyUI template's: 25 / 2.5 / er_sde / simple.
    const shipped = await run(mossTools({}), 'image_forge_generate', args)
    console.log('Agent MOSS comfy register:', JSON.stringify(sampler()))
    assert.equal(shipped.steps_used, 25)
    assert.equal(shipped.steps_source, 'default')
    assert.equal(comfy.state.graph['8'].class_type, 'KSampler')
    assert.equal(sampler().steps, 25)
    assert.equal(sampler().cfg, 2.5)
    assert.equal(sampler().sampler_name, 'er_sde')
    assert.equal(sampler().scheduler, 'simple')

    // 2. The official register is OpenMOSS's own card: 50 / 3 / euler / simple.
    const official = await run(mossTools({ mossSampling: 'official' }), 'image_forge_generate', args)
    console.log('Agent MOSS official register:', JSON.stringify(sampler()))
    assert.equal(official.steps_used, 50)
    assert.equal(official.steps_source, 'default')
    assert.equal(sampler().steps, 50)
    assert.equal(sampler().cfg, 3)
    assert.equal(sampler().sampler_name, 'euler')
    assert.equal(sampler().scheduler, 'simple')

    // 3. An explicit `steps` still wins over the register — the count only: the
    // register keeps owning the sampler numbers.
    const explicit = await run(mossTools({ mossSampling: 'official' }), 'image_forge_generate', { ...args, steps: 12 })
    assert.equal(explicit.steps_used, 12)
    assert.equal(explicit.steps_source, 'explicit')
    assert.equal(sampler().steps, 12)
    assert.equal(sampler().cfg, 3)
    assert.equal(sampler().sampler_name, 'euler')

    // 4. ...and so does the shared ComfyUI override, which outranks the register.
    const backend = await run(mossTools({ mossSampling: 'official', comfyuiSteps: 30 }), 'image_forge_generate', args)
    assert.equal(backend.steps_used, 30)
    assert.equal(backend.steps_source, 'backend')
    assert.equal(sampler().steps, 30)
    assert.equal(sampler().cfg, 3)
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
});

test('a MOSS register selected while a Qwen profile runs changes nothing on the Agent tool path', async () => {
  const comfy = await startFakeComfy()
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-qwen-agent-register-'))
  try {
    const args = { prompt: 'A cat.', wh_ratio: '1:1', seed: 42, count: 1 }
    const qwenTools = (overrides) =>
      register({ comfyEndpoint: comfy.endpoint, comfyModelsDir: 'D:\\models', comfyModel: 'qwen21-base', outputDir, timeoutMs: 30_000, ...overrides })

    const before = await run(qwenTools({}), 'image_forge_generate', args)
    const baseline = structuredClone(comfy.state.graph)
    const after = await run(qwenTools({ mossSampling: 'official' }), 'image_forge_generate', args)
    const withRegister = structuredClone(comfy.state.graph)

    // Byte-identical graph: the setting only reaches families that publish
    // registers, so a Qwen run cannot drift by a single sampler value here either.
    assert.deepEqual(withRegister, baseline)
    assert.equal(withRegister['6'].inputs.cfg, 1)
    assert.equal(withRegister['6'].inputs.sampler_name, 'euler')
    assert.equal(withRegister['6'].inputs.steps, 40, 'the shared default, not the register 50')
    assert.equal(before.steps_used, 40)
    assert.equal(after.steps_used, 40)
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
});

test('a MOSS edit reaches /prompt with the LoRA, the native encode nodes and the reference', async () => {
  const comfy = await startFakeComfy({ objectInfo: BOTH_FAMILIES_OBJECT_INFO })
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-moss-edit-'))
  try {
    const tools = register({ comfyEndpoint: comfy.endpoint, comfyModelsDir: 'D:\\models', comfyModel: 'moss-sft', outputDir, timeoutMs: 30_000 })
    const reference = join(outputDir, 'ref.png')
    writeFileSync(reference, Buffer.from(PNG_1X1, 'base64'))
    const result = await run(tools, 'image_forge_edit', { prompt: '只把标题换成「夏日特惠」。', images: [reference], seed: 42 })
    const graph = comfy.state.graph
    console.log('MOSS edit node classes:', JSON.stringify(Object.entries(graph).map(([id, node]) => [id, node.class_type])))

    // 1. What used to be an explicit refusal (T19's predecessor) now runs end to
    //    end through the Agent tool, on the MOSS profile.
    assert.equal(result.backend, 'comfyui')
    assert.equal(result.comfyui.profile, 'moss-sft')
    assert.equal(result.comfyui.comfyModel, 'moss')
    assert.equal(result.steps_used, 25, 'the mossSampling register owns the edit step count')
    assert.equal(comfy.seen.filter((entry) => entry.path === '/prompt').length, 1)

    // 2. The reference went down the same upload path as the Qwen edit graphs.
    assert.equal(comfy.state.uploads.length, 1)
    assert.equal(comfy.state.uploads[0].fields.type, 'input')
    assert.equal(comfy.state.uploads[0].filename, comfy.state.uploads[0].filename.trim())

    // 3. The graph is the sample's edit graph: the LoRA sits right behind the
    //    UNETLoader and both polarity encoders are the native MOSS node.
    const classes = Object.values(graph).map((node) => node.class_type)
    assert.ok(classes.includes('LoraLoaderModelOnly'))
    assert.equal(classes.filter((type) => type === 'TextEncodeMOSSImageEdit').length, 2)
    assert.equal(graph['2'].inputs.lora_name, 'moss_image_edit_lora_rank_64_bf16.safetensors')
    assert.deepEqual(graph['2'].inputs.model, ['1', 0])
    assert.equal(graph['7'].inputs.edit_format, 'Moss-Image-Edit')
    assert.deepEqual(graph['7'].inputs['images.image_0'], ['121', 0])
    assert.equal(graph['101'].inputs.image, comfy.state.uploads[0].filename)

    // 4. It is the MOSS edit graph, not the Qwen edit graph wearing a new name.
    assert.ok(!classes.includes('TextEncodeQwenImage21'))
    assert.ok(!classes.includes('CLIPTextEncode'))
    assert.equal(graph['11'].inputs.filename_prefix, 'dsh-image-forge-moss-edit')
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
});

test('a MOSS profile over Qwen-only weights says exactly which files it needs', async () => {
  const comfy = await startFakeComfy()
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-moss-missing-'))
  try {
    const tools = register({ comfyEndpoint: comfy.endpoint, comfyModelsDir: 'D:\\models', comfyModel: 'moss-sft', outputDir })
    const error = await failure(tools, 'image_forge_generate', { prompt: 'A cat.', wh_ratio: '1:1' })
    console.log('missing MOSS weights:\n' + error.message)
    assert.match(error.message, /缺模型文件/)
    assert.match(error.message, /moss-sft/)
    for (const wanted of [
      'moss_image_sft_int8_convrot.safetensors',
      'qwen3.5_9b_w4a8_gptq.safetensors',
      'flux2-vae_small.safetensors',
      'diffusion_models',
      'text_encoders',
    ]) {
      assert.ok(error.message.includes(wanted), `the error must name ${wanted}`)
    }
    // The candidates it did see have to be quoted, or the user cannot tell
    // whether the file is missing or merely unrecognised.
    assert.match(error.message, /qwen_image_2\.1_int8_convrot\.safetensors/)
    assert.match(error.message, /当前能看到/)
    assert.equal(comfy.seen.filter((entry) => entry.path === '/prompt').length, 0)
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
});

// ---------------------------------------------------------------------------
// The Studio's generation response, through the same fake ComfyUI.
//
// `runStudioGeneration` owns no HTTP, so the only way to see what it reports is
// to let it run a real one against the fake. That is what makes these assertions
// worth having: the register and the degrade note are *response* fields, and a
// pure-helper test would only re-state the expression it was given.
// ---------------------------------------------------------------------------

/** The fields `studio-settings-of` maps, with a fake server's endpoint. */
function studioSettingsFor(comfy, outputDir, overrides = {}) {
  return {
    comfyEndpoint: comfy.endpoint,
    comfyPorts: String(comfy.port),
    comfyModelsDir: 'D:\\models',
    timeoutMs: 30_000,
    outputDir,
    defaultSteps: 25,
    comfyuiSteps: undefined,
    comfyModel: 'moss-sft',
    mossSampling: 'comfy',
    turboSteps: undefined,
    ...overrides,
  }
}

/** Run one Studio draw against `comfy` and hand back its response. */
function drawInStudio(comfy, outputDir, overrides, body) {
  return runStudioGeneration(
    studioSettingsFor(comfy, outputDir, overrides),
    { prompt: 'A night street with a MOSS marquee.', ratio: '1:1', seed: 42, count: 1, ...body },
    new AbortController().signal,
  )
}

test('MOSS sampling: the Studio puts the selected register on the wire', async () => {
  const comfy = await startFakeComfy({ objectInfo: BOTH_FAMILIES_OBJECT_INFO })
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-moss-register-'))
  try {
    // 1. The default register is the ComfyUI template's: 25 / 2.5 / er_sde / simple.
    const shipped = await drawInStudio(comfy, outputDir, {}, {})
    console.log('MOSS comfy register:', JSON.stringify(comfy.state.graph['8'].inputs))
    assert.equal(shipped.steps, 25)
    assert.equal(comfy.state.graph['8'].class_type, 'KSampler')
    assert.equal(comfy.state.graph['8'].inputs.steps, 25)
    assert.equal(comfy.state.graph['8'].inputs.cfg, 2.5)
    assert.equal(comfy.state.graph['8'].inputs.sampler_name, 'er_sde')
    assert.equal(comfy.state.graph['8'].inputs.scheduler, 'simple')

    // 2. The official register is OpenMOSS's card: 50 / 3 / euler / simple.
    const official = await drawInStudio(comfy, outputDir, { mossSampling: 'official' }, {})
    console.log('MOSS official register:', JSON.stringify(comfy.state.graph['8'].inputs))
    assert.equal(official.steps, 50)
    assert.equal(comfy.state.graph['8'].inputs.steps, 50)
    assert.equal(comfy.state.graph['8'].inputs.cfg, 3)
    assert.equal(comfy.state.graph['8'].inputs.sampler_name, 'euler')
    assert.equal(comfy.state.graph['8'].inputs.scheduler, 'simple')

    // 3. `comfyuiSteps` still overrides the step count in the official mode...
    const overridden = await drawInStudio(comfy, outputDir, { mossSampling: 'official', comfyuiSteps: 30 }, {})
    assert.equal(overridden.steps, 30)
    assert.equal(comfy.state.graph['8'].inputs.steps, 30)
    // ...while the register still owns the sampler numbers.
    assert.equal(comfy.state.graph['8'].inputs.cfg, 3)
    assert.equal(comfy.state.graph['8'].inputs.sampler_name, 'euler')
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
});

test('a MOSS register selected while a Qwen profile runs changes nothing on the wire', async () => {
  const comfy = await startFakeComfy()
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-qwen-register-'))
  try {
    const base = { comfyModel: 'qwen21-base' }
    const before = await drawInStudio(comfy, outputDir, base, { prompt: 'A cat.' })
    const baseline = structuredClone(comfy.state.graph)
    const after = await drawInStudio(comfy, outputDir, { ...base, mossSampling: 'official' }, { prompt: 'A cat.' })
    const withRegister = structuredClone(comfy.state.graph)

    // Byte-identical graph: the setting only reaches families that publish
    // registers, so a Qwen run cannot drift by a single sampler value.
    assert.deepEqual(withRegister, baseline)
    assert.equal(withRegister['6'].inputs.cfg, 1)
    assert.equal(withRegister['6'].inputs.sampler_name, 'euler')
    assert.equal(withRegister['6'].inputs.steps, 25, 'the shared default, not the register 50')
    assert.equal(before.steps, 25)
    assert.equal(after.steps, 25)
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
});

test('the Studio reports a turbo request that ran on the base weights', async () => {
  const withTurbo = structuredClone(OBJECT_INFO)
  withTurbo.UNETLoader.input.required.unet_name[0].push('qwen_image_2.1_turbo_int8_convrot.safetensors')
  const turboComfy = await startFakeComfy({ objectInfo: withTurbo })
  const baseOnlyComfy = await startFakeComfy()
  const mossComfy = await startFakeComfy({ objectInfo: BOTH_FAMILIES_OBJECT_INFO })
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-studio-turbo-'))
  try {
    // Turbo installed and asked for: the turbo graph runs, nothing degraded.
    const turbo = await drawInStudio(turboComfy, outputDir, { comfyModel: 'qwen21-turbo' }, { prompt: 'A ceramic mug.' })
    assert.equal(turbo.turboFallback, false)
    assert.equal(turbo.steps, 8)

    // Installed but base was asked for: that is not a fallback, it is the request.
    const base = await drawInStudio(turboComfy, outputDir, { comfyModel: 'qwen21-base' }, { prompt: 'A ceramic mug.' })
    assert.equal(base.turboFallback, false)
    assert.equal(base.steps, 25)

    // Turbo asked for on a base-only install: the run degrades, and says so.
    const degraded = await drawInStudio(baseOnlyComfy, outputDir, { comfyModel: 'qwen21-turbo' }, { prompt: 'A ceramic mug.' })
    console.log('degraded response:', JSON.stringify({ steps: degraded.steps, turboFallback: degraded.turboFallback }))
    assert.equal(degraded.turboFallback, true)
    assert.equal(degraded.steps, 25, 'the base graph runs at the base default')

    // A MOSS request is a third family, never a turbo in disguise.
    const moss = await drawInStudio(mossComfy, outputDir, { comfyModel: 'moss-sft' }, {})
    assert.equal(moss.turboFallback, false)
  } finally {
    await turboComfy.close()
    await baseOnlyComfy.close()
    await mossComfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
});