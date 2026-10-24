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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../lib/index.js'

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

/** Start a fake ComfyUI; every option has a working default. */
async function startFakeComfy(options = {}) {
  const seen = []
  const state = { historyCalls: 0, graph: undefined }
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
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      const url = new URL(request.url, 'http://127.0.0.1')
      seen.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body })
      const send = (status, payload, type = 'application/json') => {
        response.writeHead(status, { 'Content-Type': type })
        response.end(payload)
      }
      if (url.pathname === '/system_stats') {
        return send(200, JSON.stringify({ system: { comfyui_version: 'fake-0.0' }, devices: [{ name: 'fake-gpu', vram_free: 1 }] }))
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
    const result = await run(tools, 'qwen_image_generate', {
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
    const error = await failure(tools, 'qwen_image_generate', { prompt: 'A cat.', wh_ratio: '1:1' })
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
    const error = await failure(tools, 'qwen_image_generate', { prompt: 'A cat.', wh_ratio: '1:1' })
    assert.ok(error instanceof Error)
    console.log('not-running error message:\n' + error.message)
    assert.match(error.message, /没找到在跑的 ComfyUI/)
    assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${first}`))
    assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${second}`))
    assert.match(error.message, /已探测 2 个端口/)
    assert.match(error.message, /启动 ComfyUI/)
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
      const error = await failure(tools, 'qwen_image_generate', { prompt: 'A cat.' })
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
    const error = await failure(tools, 'qwen_image_generate', { prompt: 'A cat.' })
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
    const error = await failure(tools, 'qwen_image_generate', { prompt: 'A cat.' })
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
    const result = await run(tools, 'qwen_image_generate', { prompt: 'A cat.', wh_ratio: '1:1' })
    console.log('generate ->', result.backend, result.comfyui.endpoint)
    assert.equal(result.backend, 'comfyui')
    assert.ok(comfy.seen.some((entry) => entry.path === '/prompt'), 'the generation must reach ComfyUI')

    const dead = await deadPort()
    const down = register({ comfyEndpoint: '', comfyPorts: String(dead), timeoutMs: 5000, outputDir })
    const error = await failure(down, 'qwen_image_generate', { prompt: 'A cat.' })
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

test('qwen_image_status reports ComfyUI reachability and the weights it can see', async () => {
  const comfy = await startFakeComfy()
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-comfy-status-'))
  try {
    const tools = register({ comfyEndpoint: comfy.endpoint, comfyModelsDir: 'D:\\models', apiKey: '', outputDir })
    const status = await run(tools, 'qwen_image_status', { timeoutMs: 5000 })
    console.log('status.comfyui:', JSON.stringify(status.comfyui, null, 1))
    assert.equal(status.comfyui.reachable, true)
    assert.equal(status.comfyui.port, comfy.port)
    assert.deepEqual(status.comfyui.models, {
      unet: 'qwen_image_2.1_int8_convrot.safetensors',
      clip: 'qwen3vl_8b_int8_convrot.safetensors',
      vae: 'qwen_image_2.1_vae_bf16.safetensors',
      clipType: 'qwen_image',
      ok: true,
    })

    // Hardware facts come from ComfyUI's own `/system_stats`, not from a process
    // this plugin spawns: the card that matters is the one it loaded weights onto.
    assert.equal(status.comfyui.version, 'fake-0.0')
    assert.deepEqual(status.comfyui.devices, [{ name: 'fake-gpu', type: null, vram_total_MiB: null, vram_free_MiB: 0 }])
    assert.equal(status.comfyui.stats_note, null)

    // A second call must not turn the server into something else: the report is
    // passive and reads the same endpoint.
    const again = await run(tools, 'qwen_image_status', { timeoutMs: 3000 })
    assert.equal(again.comfyui.reachable, true)
  } finally {
    await comfy.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('qwen_image_status on a machine with nothing running still answers', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-comfy-status-down-'))
  const dead = await deadPort()
  try {
    const tools = register({ comfyEndpoint: '', comfyPorts: String(dead), apiKey: '', outputDir })
    const status = await run(tools, 'qwen_image_status', { timeoutMs: 3000 })
    console.log('status.comfyui (nothing running):', JSON.stringify(status.comfyui, null, 1))
    assert.equal(status.comfyui.reachable, false)
    assert.deepEqual(status.comfyui.candidatePorts, [dead])
    assert.match(status.comfyui.note, /没找到在跑的 ComfyUI/)
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})
