/**
 * The reference-image edit path: what reaches the backends, and what happens when
 * a reference cannot be used.
 *
 * Everything here runs against a fake ComfyUI (which also receives the
 * `/upload/image` multipart POST), so `npm test` stays hermetic. The cloud
 * backend has no edit channel at all, which is why there is exactly one backend
 * to fake here; the live run against the real server is `test:live:edit`.
 *
 * The reference PNGs are built here rather than checked in: the sizing logic
 * depends on the *pixel size* of a reference, so a fixture whose IHDR says
 * 2048x1152 has to be a real PNG, and generating one keeps that honest without
 * adding binary files to the repository.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import * as plugin from '../lib/index.js'

/** The file names the fake ComfyUI offers, mirroring a real install. */
const OBJECT_INFO = {
  UNETLoader: {
    input: {
      required: {
        unet_name: [['minimax_music3_dit_fp16.safetensors', 'qwen_image_2.1_int8_convrot.safetensors'], {}],
        weight_dtype: [['default', 'fp8_e4m3fn'], {}],
      },
    },
  },
  CLIPLoader: {
    input: {
      required: {
        clip_name: [
          ['qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors', 'qwen3vl_8b_int8_convrot.safetensors'],
          {},
        ],
        type: [['stable_diffusion', 'qwen_image', 'wan'], {}],
      },
    },
  },
  VAELoader: {
    input: { required: { vae_name: [['minimax_music3_dav.safetensors', 'qwen_image_2.1_vae_bf16.safetensors'], {}] } },
  },
}

const PROMPT_ID = 'fake-edit-prompt-id'

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
 * @returns the endpoint, the recorded requests, and the captured graph.
 */
async function startFakeComfy(options = {}) {
  const seen = []
  const state = { graph: undefined, uploads: [] }
  const rendered = options.rendered ?? makePng(1664, 928)
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
        const fields = Object.fromEntries(parts.filter((part) => part.name !== 'image').map((part) => [part.name, part.body.toString('utf8')]))
        state.uploads.push({ filename: file?.filename ?? null, contentType: file?.contentType ?? null, fields, bytes: file?.body ?? Buffer.alloc(0) })
        seen.push({ method: request.method, path: url.pathname, uploads: state.uploads.length })
        // ComfyUI answers with the name it stored the file under.
        return send(200, JSON.stringify({ name: file?.filename ?? null, subfolder: '', type: 'input' }))
      }
      seen.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: body.toString('utf8') })
      if (url.pathname === '/system_stats') {
        return send(200, JSON.stringify({ system: { comfyui_version: 'fake-0.0' }, devices: [{ name: 'fake-gpu', vram_free: 1 }] }))
      }
      if (url.pathname.startsWith('/object_info/')) {
        const node = url.pathname.slice('/object_info/'.length)
        return send(200, JSON.stringify(node in OBJECT_INFO ? { [node]: OBJECT_INFO[node] } : {}))
      }
      if (url.pathname === '/prompt' && request.method === 'POST') {
        state.graph = JSON.parse(body.toString('utf8')).prompt
        return send(200, JSON.stringify({ prompt_id: PROMPT_ID, number: 1, node_errors: {} }))
      }
      if (url.pathname === `/history/${PROMPT_ID}`) {
        return send(
          200,
          JSON.stringify({
            [PROMPT_ID]: {
              outputs: { '8': { images: [{ filename: 'dsh-image-forge-edit_00001_.png', subfolder: '', type: 'output' }] } },
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
    port,
    endpoint: `http://127.0.0.1:${port}`,
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
  // A closed port by default: an edit must never reach a real ComfyUI on the
  // machine running the tests unless the test points it at a fake one.
  plugin.apply(ctx, { ...plugin.Config({}), comfyPorts: '1', ...config })
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

/** A temp directory tree: just the reference images and an output directory. */
function fixture(prefix) {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`))
  const outputDir = join(root, 'out')
  const refs = join(root, 'refs')
  for (const dir of [outputDir, refs]) mkdirSync(dir, { recursive: true })
  return {
    root,
    outputDir,
    refs,
    ref: (name, bytes) => {
      const path = join(refs, name)
      writeFileSync(path, bytes)
      return path
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

// ---------------------------------------------------------------------------
// ComfyUI: the whole edit contract on the wire
// ---------------------------------------------------------------------------

test('a fake ComfyUI edit: references uploaded, graph wired, image written', async () => {
  const comfy = await startFakeComfy()
  const fx = fixture('forge-edit-comfy')
  try {
    const wide = makePng(2048, 1152)
    const square = makePng(512, 512)
    const widePath = fx.ref('wide.png', wide)
    const squarePath = fx.ref('square.png', square)
    const tools = register({
      backend: 'comfyui',
      apiKey: '',
      comfyEndpoint: comfy.endpoint,
      outputDir: fx.outputDir,
      timeoutMs: 20_000,
    })

    const result = await run(tools, 'qwen_image_edit', {
      prompt: '把整幅画面改成黄昏色调，其余保持不变。',
      images: [widePath, squarePath],
      ratio_follow: 'image1',
      preset: 'retouch',
      seed: 11,
      steps: 6,
    })

    console.log('tool result:', JSON.stringify({ ...result, markdown: result.markdown }, null, 2))
    console.log('graph submitted to ComfyUI:', JSON.stringify(comfy.state.graph, null, 2))

    // --- the references really went over as multipart bytes ---
    assert.equal(comfy.state.uploads.length, 2, 'one upload per reference image')
    assert.equal(comfy.state.uploads[0].fields.type, 'input', 'uploads land in ComfyUI input/ for LoadImage')
    assert.equal(comfy.state.uploads[0].contentType, 'image/png')
    assert.ok(comfy.state.uploads[0].bytes.equals(wide), 'the uploaded bytes must be the reference bytes, unchanged')
    assert.ok(comfy.state.uploads[1].bytes.equals(square))
    assert.match(comfy.state.uploads[0].filename, /^dsh-forge-ref-[0-9a-f]{16}\.png$/, 'the upload name is content-addressed')

    // --- the graph is the official edit shape ---
    const graph = comfy.state.graph
    assert.equal(graph['1'].class_type, 'UNETLoader')
    assert.equal(graph['1'].inputs.unet_name, 'qwen_image_2.1_int8_convrot.safetensors')
    assert.equal(graph['2'].inputs.type, 'qwen_image')
    assert.equal(graph['11'].class_type, 'LoadImage')
    assert.equal(graph['11'].inputs.image, comfy.state.uploads[0].filename)
    assert.equal(graph['12'].inputs.image, comfy.state.uploads[1].filename)
    assert.equal(graph['4'].class_type, 'TextEncodeQwenImage21')
    assert.deepEqual(graph['4'].inputs.clip, ['2', 0])
    assert.deepEqual(graph['4'].inputs.vae, ['3', 0], 'the edit encoder VAE-encodes the references')
    assert.deepEqual(graph['4'].inputs['images.image_1'], ['11', 0])
    assert.deepEqual(graph['4'].inputs['images.image_2'], ['12', 0])
    assert.equal(Object.keys(graph['4'].inputs).includes('images.image_3'), false, 'only the references given are wired')
    assert.equal(graph['4'].inputs.prompt, '把整幅画面改成黄昏色调，其余保持不变。')
    // 2048x1152 is exactly 16:9, so it resolves to the shipped 16:9 canvas
    // (1664x928, +0.86% off the true 16:9 shape on the 32 grid); the reference
    // budget mirrors that canvas' area.
    assert.equal(graph['5'].inputs.width, 1664)
    assert.equal(graph['5'].inputs.height, 928)
    assert.equal(graph['4'].inputs.resolution, 1248, 'the reference budget follows the canvas area')
    assert.equal(graph['6'].inputs.seed, 11)
    assert.equal(graph['6'].inputs.steps, 6)
    assert.equal(graph['8'].inputs.filename_prefix, 'dsh-image-forge-edit')

    // --- the result says what the canvas followed and what came back ---
    assert.equal(result.ok, true)
    assert.equal(result.backend, 'comfyui')
    assert.equal(result.size_source, 'ratio_follow')
    assert.equal(result.ratio_follow, 'image1')
    assert.equal(result.ratio_follow_defaulted, false)
    assert.deepEqual(result.ratio_follow_image, { index: 1, source: widePath, size: { width: 2048, height: 1152 } })
    assert.deepEqual(result.size, { width: 1664, height: 928 })
    assert.equal(result.ratio_deviation_percent, 0.862)
    assert.equal(result.exact_ratio, false)
    assert.deepEqual(result.references.map((reference) => reference.size), [
      { width: 2048, height: 1152 },
      { width: 512, height: 512 },
    ])
    assert.deepEqual(result.images.map((image) => [image.width, image.height]), [[1664, 928]])
    const path = join(fx.outputDir, 'retouch_1664x928_1.png')
    assert.equal(result.images[0].path, path)
    assert.ok(existsSync(path), 'the edited image must be on disk')
    assert.ok(readFileSync(path).equals(makePng(1664, 928)), 'the bytes on disk must be the bytes /view served')
    assert.equal(result.markdown, `![generated image](${path.replace(/\\/g, '/')})`)
  } finally {
    await comfy.close()
    fx.cleanup()
  }
})

test('with neither ratio nor size the canvas follows the first reference by default', async () => {
  const comfy = await startFakeComfy({ rendered: makePng(1664, 928) })
  const fx = fixture('forge-edit-default')
  try {
    const path = fx.ref('exact.png', makePng(1664, 928))
    const tools = register({ backend: 'comfyui', apiKey: '', comfyEndpoint: comfy.endpoint, outputDir: fx.outputDir })
    const result = await run(tools, 'qwen_image_edit', { prompt: '只把标题换成「夏日特惠」。', images: [path] })
    console.log('defaulted ratio_follow:', JSON.stringify({ ratio_follow: result.ratio_follow, defaulted: result.ratio_follow_defaulted, size: result.size, deviation: result.ratio_deviation_percent }))
    assert.equal(result.ratio_follow, 'image1')
    assert.equal(result.ratio_follow_defaulted, true)
    assert.equal(result.ratio_follow_requested, null)
    // The reference is already the shipped 16:9 canvas, so its shape round-trips
    // exactly: 1664x928 reduces to 52:29, which is that canvas' own shape.
    assert.deepEqual(result.size, { width: 1664, height: 928 })
    assert.equal(result.exact_ratio, true)
    assert.equal(result.ratio_deviation_percent, 0)
    assert.equal(comfy.state.graph['5'].inputs.width, 1664)
    assert.equal(comfy.state.graph['5'].inputs.height, 928)
    assert.equal(comfy.state.graph['11'].inputs.image, comfy.state.uploads[0].filename)
  } finally {
    await comfy.close()
    fx.cleanup()
  }
})

test('ratio_follow also accepts the path (or data URI) that images[] carried', async () => {
  const comfy = await startFakeComfy({ rendered: makePng(992, 992) })
  const fx = fixture('forge-edit-path-follow')
  try {
    const square = fx.ref('square.png', makePng(1200, 1200))
    const wide = fx.ref('wide.png', makePng(2048, 1152))
    const tools = register({ backend: 'comfyui', apiKey: '', comfyEndpoint: comfy.endpoint, outputDir: fx.outputDir })
    const result = await run(tools, 'qwen_image_edit', { prompt: '把第二张图的天空换到第一张图上。', images: [square, wide], ratio_follow: wide.toUpperCase() })
    console.log('ratio_follow by path ->', JSON.stringify({ followed: result.ratio_follow_image, size: result.size }))
    assert.equal(result.ratio_follow, 'image2', 'the path resolves to the reference it matches, not to image1')
    assert.deepEqual(result.ratio_follow_image, { index: 2, source: wide, size: { width: 2048, height: 1152 } })
    assert.deepEqual(result.size, { width: 1664, height: 928 })
    await assert.rejects(
      run(tools, 'qwen_image_edit', { prompt: 'x', images: [square], ratio_follow: 'C:\\nope\\other.png' }),
      /matches none of the 1 reference images/,
    )
    await assert.rejects(
      run(tools, 'qwen_image_edit', { prompt: 'x', images: [square], ratio_follow: 'image3' }),
      /points at reference image 3, but this call carries 1/,
    )
  } finally {
    await comfy.close()
    fx.cleanup()
  }
})

// ---------------------------------------------------------------------------
// The contract's mutual exclusion, and the failures that must name a position
// ---------------------------------------------------------------------------

test('wh_ratio and ratio_follow together are refused before any backend is touched', async () => {
  const comfy = await startFakeComfy()
  const fx = fixture('forge-edit-exclusive')
  try {
    const tools = register({ backend: 'comfyui', apiKey: '', comfyEndpoint: comfy.endpoint, outputDir: fx.outputDir })
    const error = await failure(tools, 'qwen_image_edit', {
      prompt: '把背景换成雪夜。',
      images: [fx.ref('a.png', makePng(256, 256))],
      wh_ratio: '16:9',
      ratio_follow: 'image1',
    })
    console.log('mutual-exclusion error:\n' + error.message)
    assert.ok(error instanceof Error)
    assert.match(error.message, /wh_ratio 与 ratio_follow 不能同时给/)
    assert.match(error.message, /契约/)
    assert.equal(comfy.seen.length, 0, 'no backend may be contacted for a contradicting call')
  } finally {
    await comfy.close()
    fx.cleanup()
  }
})

test('every unusable reference is refused by position, never dropped', async () => {
  const fx = fixture('forge-edit-bad-refs')
  try {
    const tools = register({ backend: 'comfyui', apiKey: '', comfyEndpoint: 'http://127.0.0.1:1', outputDir: fx.outputDir })
    const good = fx.ref('good.png', makePng(256, 256))
    const cases = [
      { name: 'too many', images: Array.from({ length: 11 }, () => good), match: /carries 11 reference images, but at most 10/ },
      { name: 'empty list', images: [], match: /at least one reference image/ },
      { name: 'missing file', images: [good, join(fx.refs, 'nope.png')], match: /images\[1\]: cannot read .*no such file/ },
      { name: 'directory', images: [fx.refs], match: /images\[0\]: .* is a directory, not an image file/ },
      { name: 'relative path', images: ['refs/square.png'], match: /images\[0\]: .* is not an absolute path/ },
      { name: 'empty file', images: [fx.ref('empty.png', Buffer.alloc(0))], match: /images\[0\]: .* is 0 bytes/ },
      { name: 'not an image', images: [fx.ref('text.png', Buffer.from('这不是图片，只是一段 UTF-8 文本'))], match: /images\[0\]: .* is not a recognized image container/ },
      { name: 'non-base64 data URI', images: ['data:image/png,%89PNG%0D'], match: /images\[0\]: only base64 image data URIs are accepted/ },
      { name: 'empty data URI payload', images: ['data:image/png;base64,'], match: /images\[0\]: the data URI carries no base64 payload/ },
      { name: 'base64 that is not an image', images: [`data:image/png;base64,${Buffer.from('nope').toString('base64')}`], match: /images\[0\] \(data URI\) is not a recognized image container/ },
      { name: 'blank entry', images: ['   '], match: /images\[0\] must be a non-empty string/ },
    ]
    for (const scenario of cases) {
      const error = await failure(tools, 'qwen_image_edit', { prompt: 'x', images: scenario.images })
      console.log(`${scenario.name} -> ${error.message.split('\n')[0]}`)
      assert.ok(error instanceof Error, `${scenario.name} must reject`)
      assert.match(error.message, scenario.match, `${scenario.name} message`)
    }
    // A data URI is a first-class reference: it sizes like a file does.
    const inline = makePng(1024, 1024)
    assert.equal(
      (await import('../src/refs.ts')).probeImageSize(new Uint8Array(inline)).width,
      1024,
      'the PNG header parser must read the size it advertised',
    )
  } finally {
    fx.cleanup()
  }
})

test('backend "api" refuses to carry references instead of dropping them', async () => {
  const fx = fixture('forge-edit-api')
  try {
    const tools = register({ backend: 'api', apiKey: 'test-key', apiBaseUrl: 'http://127.0.0.1:1/v1', outputDir: fx.outputDir })
    const error = await failure(tools, 'qwen_image_edit', { prompt: 'x', images: [fx.ref('a.png', makePng(256, 256))] })
    console.log('backend api error://n' + error.message)
    assert.match(error.message, /backend "api" 没有编辑通道/)
    // The one backend that can carry a reference, and the document that installs
    // it. The removed `local` tier must not be offered as a third option.
    assert.match(error.message, /comfyui/)
    assert.match(error.message, /docs\/comfyui-deployment\.md/)
    assert.ok(!/`local`/.test(error.message), 'the removed local backend is still offered')
    // `backend: "auto"` with a key present still edits over ComfyUI, and says why
    // it did not use the key.
    const comfy = await startFakeComfy({ rendered: makePng(992, 992) })
    try {
      const auto = register({
        backend: 'auto',
        apiKey: 'test-key',
        apiBaseUrl: 'http://127.0.0.1:1/v1',
        comfyEndpoint: comfy.endpoint,
        outputDir: fx.outputDir,
      })
      const result = await run(auto, 'qwen_image_edit', { prompt: 'x', images: [fx.ref('b.png', makePng(600, 600))] })
      console.log('auto + key ->', JSON.stringify({ backend: result.backend, api_skipped: result.api_skipped }))
      assert.equal(result.backend, 'comfyui', 'auto must not route an edit to the cloud backend')
      assert.equal(result.api_skipped, 'no edit path on the cloud backend')
    } finally {
      await comfy.close()
    }
  } finally {
    fx.cleanup()
  }
})

// ---------------------------------------------------------------------------
// The canvas the reference implies: ComfyUI scales it itself, so there is no
// plugin-side gate to trip — the check here is that nothing got in the way.
// ---------------------------------------------------------------------------

test('a full-size canvas edits fine over ComfyUI, with no gate in between', async () => {
  const comfy = await startFakeComfy({ rendered: makePng(1248, 1248) })
  const fx = fixture('forge-edit-fullsize')
  try {
    const tools = register({
      backend: 'comfyui',
      apiKey: '',
      comfyEndpoint: comfy.endpoint,
      outputDir: fx.outputDir,
    })
    const result = await run(tools, 'qwen_image_edit', {
      prompt: '把背景换成雪夜。',
      images: [fx.ref('a.png', makePng(256, 256))],
      // 1248×1248 is the 1:1 default canvas — the largest one this plugin asks
      // for. ComfyUI does its own reference conditioning, so nothing here refuses.
      width: 1248,
      height: 1248,
    })
    console.log('full-size edit ->', JSON.stringify({ backend: result.backend, size: result.size }))
    assert.equal(result.backend, 'comfyui')
    assert.deepEqual(result.size, { width: 1248, height: 1248 })
    // The gate's payload is gone, not merely empty: a key that still ships would
    // tell a reader there is a budget to configure.
    assert.equal('local_edit_budget' in result, false, 'the local edit budget must not appear in a result')
    assert.equal('local_worker' in result, false, 'the worker report must not appear in a result')
    assert.equal(comfy.state.graph['5'].inputs.width, 1248)
    assert.equal(comfy.state.graph['5'].inputs.height, 1248)
  } finally {
    await comfy.close()
    fx.cleanup()
  }
})

test('an "auto" edit with no ComfyUI running names the deployment document', async () => {
  const fx = fixture('forge-edit-auto-down')
  try {
    const tools = register({
      backend: 'auto',
      apiKey: '',
      comfyEndpoint: '',
      comfyPorts: '1',
      outputDir: fx.outputDir,
    })
    const error = await failure(tools, 'qwen_image_edit', {
      prompt: 'x',
      images: [fx.ref('a.png', makePng(256, 256))],
    })
    console.log('auto edit with nothing running://n' + error.message)
    // There is no `local` fallback left, so the only useful thing this message can
    // do is name what is missing and where the fix is written down.
    assert.match(error.message, /改图只能在本机 ComfyUI 上跑/)
    assert.match(error.message, /docs\/comfyui-deployment\.md/)
    assert.ok(!/neither local backend/.test(error.message), 'the removed local fallback is still described')
  } finally {
    fx.cleanup()
  }
})

test('every reference is uploaded for an edit, and text-to-image uploads none', async () => {
  const comfy = await startFakeComfy({ rendered: makePng(992, 992) })
  const fx = fixture('forge-edit-upload')
  try {
    const tools = register({ backend: 'comfyui', apiKey: '', comfyEndpoint: comfy.endpoint, outputDir: fx.outputDir })
    const square = makePng(512, 512)
    const wide = makePng(2048, 1152)
    const result = await run(tools, 'qwen_image_edit', {
      prompt: '把参考图里的招牌文字改成「夏日特惠」。',
      images: [fx.ref('wide.png', wide), fx.ref('square.png', square)],
      ratio_follow: 'image2',
      seed: 3,
    })
    console.log('edit result:', JSON.stringify({ backend: result.backend, size: result.size, ratio_follow: result.ratio_follow }))

    assert.equal(result.backend, 'comfyui')
    assert.equal(comfy.state.uploads.length, 2, 'the server must receive one upload per reference')
    assert.ok(comfy.state.uploads[0].bytes.equals(wide), 'the first reference must arrive byte-exact')
    assert.ok(comfy.state.uploads[1].bytes.equals(square), 'the second reference must arrive byte-exact')
    assert.equal(comfy.state.uploads[0].contentType, 'image/png')
    // ratio_follow image2 (512×512) resolves to the 1:1 canvas on the plugin side,
    // before anything is sent.
    assert.deepEqual(result.size, { width: 1248, height: 1248 })
    assert.equal(result.ratio_follow, 'image2')
    assert.equal(result.seed, 3)
    // Both references are wired into the graph as LoadImage nodes.
    const classes = Object.values(comfy.state.graph).map((node) => node.class_type)
    assert.equal(classes.filter((name) => name === 'LoadImage').length, 2)

    // Text-to-image must not grow an upload: the graph has no LoadImage at all.
    const uploadsBefore = comfy.state.uploads.length
    const generated = await run(tools, 'qwen_image_generate', { prompt: 'A brass compass.', wh_ratio: '1:1' })
    assert.equal(generated.backend, 'comfyui')
    assert.equal(comfy.state.uploads.length, uploadsBefore, 'a text-to-image call must not upload anything')
    const generatedClasses = Object.values(comfy.state.graph).map((node) => node.class_type)
    assert.equal(generatedClasses.includes('LoadImage'), false, 'a text-to-image graph must carry no reference node')
  } finally {
    await comfy.close()
    fx.cleanup()
  }
})
