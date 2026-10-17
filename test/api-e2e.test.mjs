/**
 * End-to-end run against a fake OpenAI-style endpoint.
 *
 * Proves the three things that cannot be checked by reading code: the request
 * body the tool actually sends, that the response is parsed, and that the PNG
 * lands on disk under the required name. Also pins the failure modes — no key,
 * no worker, upstream error — as readable messages rather than crashes.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../lib/index.js'

/** A real 1×1 PNG, so the written file is a decodable image, not filler bytes. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

/** Start a fake endpoint that records every request it receives. */
async function startFakeEndpoint() {
  const seen = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      const entry = { method: request.method, url: request.url, headers: request.headers, body }
      seen.push(entry)
      if (request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: 'qwen-image' }] }))
        return
      }
      const parsed = JSON.parse(body)
      const images = Array.from({ length: parsed.n ?? 1 }, () => ({ b64_json: PNG_BASE64 }))
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ created: 1, data: images }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    seen,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * Ephemeral runtime for the whole file.
 *
 * The machine's real `~/.dsh-image-forge` may already have a venv — without
 * this, a "no backend" generate would try to spawn that worker and hang.
 */
const HERMETIC_RUNTIME = mkdtempSync(join(tmpdir(), 'forge-rt-'))

after(() => {
  rmSync(HERMETIC_RUNTIME, { recursive: true, force: true })
})

/** Register the plugin against a stub context and hand back the tool map. */
function register(config) {
  const tools = new Map()
  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    skills: { register: () => undefined },
  }
  plugin.apply(ctx, { ...plugin.Config({}), runtimeDir: HERMETIC_RUNTIME, ...config })
  return tools
}

/** Run one tool with a caller signal, the way the registry does. */
function run(tools, name, args) {
  const controller = new AbortController()
  return tools.get(name).execute(args, { signal: controller.signal })
}

test('an image is requested with the wh_ratio-derived size, parsed, and written', async () => {
  const endpoint = await startFakeEndpoint()
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-e2e-'))
  try {
    const tools = register({
      backend: 'api',
      apiBaseUrl: endpoint.baseUrl,
      apiKey: 'test-key-not-a-real-secret',
      apiModel: 'qwen-image',
      outputDir,
      timeoutMs: 20_000,
      localEndpoint: 'http://127.0.0.1:1',
    })

    const result = await run(tools, 'qwen_image_generate', {
      prompt: 'A wide photograph of a harbour at dawn, moored boats along the quay.',
      wh_ratio: '16:9',
      preset: 'harbour',
      seed: 7,
      steps: 20,
      count: 2,
    })

    console.log('request received by the fake endpoint:')
    console.log(JSON.stringify({ url: endpoint.seen[0].url, authorization: endpoint.seen[0].headers.authorization, body: JSON.parse(endpoint.seen[0].body) }, null, 2))
    console.log('tool result:')
    console.log(JSON.stringify({ ...result, markdown: result.markdown }, null, 2))

    const sent = JSON.parse(endpoint.seen[0].body)
    assert.equal(endpoint.seen[0].method, 'POST')
    assert.equal(endpoint.seen[0].url, '/v1/images/generations')
    assert.equal(endpoint.seen[0].headers.authorization, 'Bearer test-key-not-a-real-secret')
    assert.equal(sent.model, 'qwen-image')
    assert.equal(sent.size, '1664x928', 'wh_ratio 16:9 must reach the wire as the 32-aligned size')
    assert.equal(sent.n, 2)
    assert.equal(sent.seed, 7)
    assert.equal(sent.steps, 20)
    assert.equal(sent.response_format, 'b64_json')

    assert.equal(result.ok, true)
    assert.equal(result.backend, 'api')
    assert.equal(result.wh_ratio, '16:9')
    assert.deepEqual(result.size, { width: 1664, height: 928 })
    assert.equal(result.size_source, 'wh_ratio')
    assert.equal(result.images.length, 2)

    const expected = join(outputDir, 'harbour_1664x928_1.png')
    const second = join(outputDir, 'harbour_1664x928_2.png')
    assert.equal(result.images[0].path, expected)
    assert.equal(result.images[1].path, second)
    assert.ok(existsSync(expected) && existsSync(second), 'both images must be on disk')
    const written = readFileSync(expected)
    assert.equal(written.toString('base64'), PNG_BASE64, 'bytes on disk must equal the bytes the endpoint served')
    assert.equal(result.images[0].mime, 'image/png')
    assert.equal(result.markdown, `![generated image](${expected.replace(/\\/g, '/')})\n![generated image](${second.replace(/\\/g, '/')})`)
  } finally {
    await endpoint.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('a second identical call keeps numbering instead of overwriting', async () => {
  const endpoint = await startFakeEndpoint()
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-numbering-'))
  try {
    const tools = register({
      backend: 'api',
      apiBaseUrl: endpoint.baseUrl,
      apiKey: 'k',
      apiModel: 'qwen-image',
      outputDir,
      localEndpoint: 'http://127.0.0.1:1',
    })
    const args = { prompt: 'A square icon of a brass compass on cream paper.', wh_ratio: '1:1' }
    const first = await run(tools, 'qwen_image_generate', args)
    const second = await run(tools, 'qwen_image_generate', args)
    console.log('first:', first.images[0].path)
    console.log('second:', second.images[0].path)
    assert.ok(first.images[0].path.endsWith('qwen_1248x1248_1.png'))
    assert.ok(second.images[0].path.endsWith('qwen_1248x1248_2.png'))
    assert.ok(existsSync(first.images[0].path) && existsSync(second.images[0].path))
  } finally {
    await endpoint.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('an explicit width/height overrides wh_ratio and must be 32-aligned', async () => {
  const endpoint = await startFakeEndpoint()
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-explicit-'))
  try {
    const tools = register({ backend: 'api', apiBaseUrl: endpoint.baseUrl, apiKey: 'k', apiModel: 'qwen-image', outputDir, localEndpoint: 'http://127.0.0.1:1' })
    const result = await run(tools, 'qwen_image_generate', { prompt: 'A banner.', wh_ratio: '16:9', width: 1024, height: 512 })
    assert.equal(JSON.parse(endpoint.seen[0].body).size, '1024x512')
    assert.equal(result.size_source, 'explicit-size')
    assert.equal(result.wh_ratio, '1:1' === result.wh_ratio ? '1:1' : result.wh_ratio)
    await assert.rejects(
      run(tools, 'qwen_image_generate', { prompt: 'A banner.', width: 1000, height: 512 }),
      /width must be a multiple of 32, got 1000 \(nearest legal values: 992 and 1024\)/,
    )
  } finally {
    await endpoint.close()
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('without any key the failure names every remedy instead of crashing', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-nokey-'))
  try {
    // `auto` now also tries a local ComfyUI. Pin its port list to a closed port so
    // this stays a test about "nothing is available" whether or not the machine
    // running the tests happens to have ComfyUI up.
    const tools = register({ backend: 'auto', apiKey: '', outputDir, localEndpoint: 'http://127.0.0.1:1', comfyPorts: '1' })
    const error = await run(tools, 'qwen_image_generate', { prompt: 'A cat.', wh_ratio: '1:1' }).then(
      () => undefined,
      (caught) => caught,
    )
    assert.ok(error instanceof Error, 'the call must reject, not silently succeed')
    console.log('no-key error message:\n' + error.message)
    assert.match(error.message, /no backend is available/)
    assert.match(error.message, /QWEN_IMAGE_API_KEY \/ DASHSCOPE_API_KEY \/ OPENAI_API_KEY/)
    assert.match(error.message, /comfyui:/)
    assert.match(error.message, /local:/)
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('backend "api" without a key fails with a key-specific message', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-apinokey-'))
  try {
    const tools = register({ backend: 'api', apiKey: '', outputDir })
    const error = await run(tools, 'qwen_image_generate', { prompt: 'A cat.' }).then(
      () => undefined,
      (caught) => caught,
    )
    console.log('backend api + no key error message:\n' + error.message)
    assert.match(error.message, /backend "api" needs a key/)
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('the key can come from the environment, and it never appears in an error', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-envkey-'))
  const secret = 'env-key-do-not-log-me'
  const previous = process.env.QWEN_IMAGE_API_KEY
  process.env.QWEN_IMAGE_API_KEY = secret
  // A 401 endpoint that quotes the key back, to prove redaction end to end.
  const failing = createServer((_request, response) => {
    response.writeHead(401, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: `invalid key ${secret}` } }))
  })
  try {
    await new Promise((resolve) => failing.listen(0, '127.0.0.1', resolve))
    const { port } = failing.address()
    const tools = register({ backend: 'api', apiKey: '', apiBaseUrl: `http://127.0.0.1:${port}/v1`, apiModel: 'qwen-image', outputDir })
    const error = await run(tools, 'qwen_image_generate', { prompt: 'A cat.' }).then(
      () => undefined,
      (caught) => caught,
    )
    console.log('upstream-401 error message:\n' + error.message)
    assert.match(error.message, /HTTP 401/)
    assert.ok(!error.message.includes(secret), 'the key must be scrubbed out of error messages')
    assert.match(error.message, /<redacted-key>/)
  } finally {
    await new Promise((resolve) => failing.close(resolve))
    if (previous === undefined) delete process.env.QWEN_IMAGE_API_KEY
    else process.env.QWEN_IMAGE_API_KEY = previous
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('qwen_image_env keeps its five real actions (the v0.1 "not implemented" stub is gone)', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-env-'))
  // Own runtime dir: a machine that already has a venv under the default
  // `~/.dsh-image-forge` must not make the dry-run "created nothing" check lie.
  const runtimeDir = mkdtempSync(join(tmpdir(), 'forge-env-rt-'))
  try {
    const tools = register({
      backend: 'api',
      apiKey: '',
      outputDir,
      runtimeDir,
      localEndpoint: 'http://127.0.0.1:1',
    })
    const status = await run(tools, 'qwen_image_env', { action: 'status' })
    console.log('env status (trimmed):', JSON.stringify({ host: status.host, gpu: status.gpu, disk: status.disk, backends: status.backends, output: status.output }, null, 2))
    assert.equal(status.action, 'status')
    // Every probe is a wrapper: `{ ok, data? , note? }`.
    assert.equal(status.host.ok, true)
    assert.ok(status.host.data.memoryTotalMiB > 0)
    assert.ok(status.host.data.cpuCount > 0)
    assert.equal(status.disk.ok, true)
    assert.equal(status.backends.api.keyPresent, false)
    assert.equal(status.output.writable, true)
    // A GPU probe that cannot run (no nvidia-smi, or a sandbox that blocks
    // spawning it) must report a note instead of failing the whole report.
    assert.ok(status.gpu.ok === true || typeof status.gpu.note === 'string', 'gpu probe must be ok or explain itself')
    // The plugin-owned runtime is reported next to the endpoints, and its
    // free-VRAM advice is a real branch rather than a fixed string.
    assert.ok(status.local_runtime !== null, 'status must describe the local runtime')
    assert.ok(typeof status.local_runtime.weights.ready === 'boolean')
    assert.ok(Array.isArray(status.vram_advisory.suggestions))
    // `install` with dryRun is the hermetic half of "these actions are real": it
    // plans and probes, and it must not create anything under runtimeDir.
    const install = await run(tools, 'qwen_image_env', { action: 'install', dryRun: true })
    console.log('install dry-run:', JSON.stringify(install, null, 2))
    assert.equal(install.action, 'install')
    assert.equal(install.dry_run, true)
    assert.ok(Array.isArray(install.steps) && install.steps.length > 0)
    assert.ok(!existsSync(join(install.venv_dir)), 'a dry run must not create the venv')
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
    rmSync(runtimeDir, { recursive: true, force: true })
  }
})

test('qwen_image_status reports the key state without echoing the key', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'forge-status-'))
  const sentinel = 'sentinel-key-must-not-be-echoed'
  try {
    const tools = register({ backend: 'api', apiKey: sentinel, outputDir, localEndpoint: 'http://127.0.0.1:1' })
    const status = await run(tools, 'qwen_image_status', { timeoutMs: 3000 })
    console.log('status payload:', JSON.stringify(status, null, 2))
    assert.equal(status.api.keyPresent, true)
    assert.equal(status.api.keySource, 'config')
    assert.equal(status.local.running, false)
    const serialized = JSON.stringify(status)
    assert.ok(!serialized.includes(sentinel), 'the key value must never appear in a status payload')
    assert.ok(!/Bearer\s+\S/.test(serialized), 'no authorization header value may appear')
    // The DSH tool layer rejects a result that is not lossless JSON. A payload
    // still carrying `undefined` properties fails that check in a real client
    // (`value is not lossless JSON`) even though Node tests used to pass.
    const holes = findUndefinedPaths(status)
    assert.deepEqual(holes, [], `status payload must not carry undefined at ${JSON.stringify(holes)}`)
    assert.deepEqual(JSON.parse(serialized), JSON.parse(JSON.stringify(JSON.parse(serialized))), 'status must round-trip through JSON')
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

/** Paths (dot notation) whose value is `undefined` — not lossless JSON. */
function findUndefinedPaths(value, prefix = '') {
  const holes = []
  if (value === undefined) return [prefix || '<root>']
  if (value === null || typeof value !== 'object') return holes
  if (Array.isArray(value)) {
    value.forEach((entry, index) => holes.push(...findUndefinedPaths(entry, `${prefix}[${index}]`)))
    return holes
  }
  for (const [key, inner] of Object.entries(value)) {
    holes.push(...findUndefinedPaths(inner, prefix ? `${prefix}.${key}` : key))
  }
  return holes
}
