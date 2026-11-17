/**
 * The canvas run registry and the adapter's `/prompt` hook (DD7).
 *
 * The registry is pure in-memory state, so it is asserted directly with an
 * injected clock: registration, lookup, the TTL that keeps late SSE frames
 * resolvable, and the fact that blank/unknown ids never invent a record.
 *
 * The second half drives `generateViaComfyUi` against a fake ComfyUI and pins
 * the other half of the contract: adding the hook changes nothing on the wire.
 * The conversation-tool path passes no hook, so its `/prompt` body and request
 * sequence must stay byte-identical — that is the regression this file exists to
 * catch.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRunRegistry, RUN_TTL_MS } from '../src/runs.ts'
import { generateViaComfyUi } from '../testlib/comfyui.js'

// ---------------------------------------------------------------------------
// Registry: one session map from prompt id to the canvas task that asked.
// ---------------------------------------------------------------------------

test('a registered run is looked up by prompt id and carries its canvas link', () => {
  const registry = createRunRegistry({ now: () => 1_000 })
  const record = registry.register('prompt-1', { clientId: 'cabc123', boardId: 'b1' })
  assert.deepEqual(record, {
    promptId: 'prompt-1',
    clientId: 'cabc123',
    boardId: 'b1',
    registeredAt: 1_000,
  })
  assert.deepEqual(registry.lookup('prompt-1'), record)
  assert.equal(registry.size(), 1)

  // A run with no named board keeps the field absent rather than empty.
  const bare = registry.register('prompt-2', { clientId: 'cdef456' })
  assert.ok(!('boardId' in bare), 'an unnamed board must not appear as a key')
  assert.equal(registry.lookup('prompt-2').clientId, 'cdef456')
})

test('an unknown prompt id is no run at all', () => {
  const registry = createRunRegistry()
  assert.equal(registry.lookup('prompt-nope'), undefined)
  assert.equal(registry.release('prompt-nope'), false)
  assert.equal(registry.forget('prompt-nope'), false)
  assert.equal(registry.size(), 0)
})

test('registration broadcasts one run event to observers, and unsubscribe stops it', () => {
  const registry = createRunRegistry({ now: () => 7 })
  const events = []
  const off = registry.subscribe((record) => { events.push(record) })
  registry.register('prompt-1', { clientId: 'cabc123', boardId: 'b1' })
  assert.equal(events.length, 1)
  assert.deepEqual(events[0], { promptId: 'prompt-1', clientId: 'cabc123', boardId: 'b1', registeredAt: 7 })
  off()
  registry.register('prompt-2', { clientId: 'cdef456' })
  assert.equal(events.length, 1, 'a detached observer must not hear registrations')
})

test('a released run survives the TTL for late frames, then lookups and sweeps drop it', () => {
  let now = 5_000
  const registry = createRunRegistry({ now: () => now })
  registry.register('prompt-1', { clientId: 'cabc123' })
  assert.equal(registry.release('prompt-1'), true)

  // Inside the window the `done` frame may still arrive after the HTTP answer.
  now += RUN_TTL_MS - 1
  assert.equal(registry.lookup('prompt-1')?.clientId, 'cabc123')

  // At the TTL the record is stale; a lookup drops it without waiting for sweep.
  now += 1
  assert.equal(registry.lookup('prompt-1'), undefined)
  assert.equal(registry.size(), 0)

  // Explicit cleanup: `forget` is immediate, `sweep` reports what it dropped.
  registry.register('prompt-2', { clientId: 'cdef456' })
  assert.equal(registry.forget('prompt-2'), true)
  assert.equal(registry.lookup('prompt-2'), undefined)

  registry.register('prompt-3', { clientId: 'cabcdef' })
  registry.release('prompt-3')
  now += RUN_TTL_MS
  assert.equal(registry.sweep(), 1)
  assert.equal(registry.size(), 0)
})

test('blank ids never enter the registry', () => {
  const registry = createRunRegistry()
  assert.equal(registry.register('', { clientId: 'cabc123' }), undefined)
  assert.equal(registry.register('prompt-1', { clientId: '' }), undefined)
  assert.equal(registry.size(), 0)
})

test('a released run keeps its registration clock and gains its expiry', () => {
  let now = 10
  const registry = createRunRegistry({ now: () => now, ttlMs: 100 })
  registry.register('prompt-1', { clientId: 'cabc123' })
  now = 40
  assert.equal(registry.release('prompt-1'), true)
  const record = registry.lookup('prompt-1')
  assert.equal(record.registeredAt, 10)
  assert.equal(record.expiresAt, 140)
})

// ---------------------------------------------------------------------------
// Adapter: the hook observes the run, it never changes the wire.
// ---------------------------------------------------------------------------

/** PNG magic plus padding; the adapter sniffs the container from the first bytes. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

/**
 * A fake ComfyUI that records raw `/prompt` bodies and serves one image per run.
 *
 * The bodies are kept as the exact text the adapter wrote, not re-serialised:
 * "byte-identical" is the property under test.
 */
function fakeComfy() {
  const submissions = []
  const requests = []
  let accepted = 0
  const server = createServer((req, res) => {
    requests.push(req.method + ' ' + req.url)
    if (req.method === 'POST' && req.url === '/prompt') {
      let raw = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        submissions.push(raw)
        accepted += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ prompt_id: 'prompt-' + String(accepted) }))
      })
      return
    }
    if (req.url.startsWith('/history/')) {
      const promptId = decodeURIComponent(req.url.slice('/history/'.length))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        [promptId]: {
          status: { completed: true },
          outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
        },
      }))
      return
    }
    if (req.url.startsWith('/view?')) {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG_BYTES)
      return
    }
    res.writeHead(404)
    res.end()
  })
  return {
    submissions,
    requests,
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      return 'http://127.0.0.1:' + String(server.address().port)
    },
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** The three weight names, as `/object_info` would have reported them. */
const MODELS = {
  unet: 'qwen-image-2.1.safetensors',
  clip: 'qwen_2.5_vl_7b.safetensors',
  vae: 'qwen_image_vae.safetensors',
  clipType: 'qwen_image',
  cache: false,
}

/** The adapter options the pipeline would build for a base Qwen run. */
function optionsFor(endpoint) {
  return {
    endpoint,
    ports: [],
    modelsDir: '',
    comfyModel: 'qwen21-base',
    timeoutMs: 5000,
    pollIntervalMs: 5,
  }
}

test('the onPromptId hook observes the run without changing the /prompt body', async () => {
  const comfy = fakeComfy()
  const endpoint = await comfy.listen()
  const target = { endpoint, port: Number(new URL(endpoint).port), probed: [] }
  const request = { prompt: '一只橘猫', width: 512, height: 512, count: 1, steps: 8, seed: 7 }
  try {
    // 1. The pre-DD7 call shape: no hook, exactly what the Agent tools do.
    const plain = await generateViaComfyUi(target, MODELS, request, optionsFor(endpoint))
    assert.equal(plain.length, 1)
    assert.equal(comfy.submissions.length, 1)

    // 2. The canvas call shape: the same request plus the observation hook.
    const seen = []
    const withHook = await generateViaComfyUi(target, MODELS, request, {
      ...optionsFor(endpoint),
      onPromptId: (promptId) => { seen.push(promptId) },
    })
    assert.equal(withHook.length, 1)
    assert.deepEqual(seen, ['prompt-2'], "the hook fires once, with /prompt's answer, before polling")

    // The submission body is the regression: byte-for-byte identical with and
    // without the hook. A hook that leaked into the body would also reach
    // ComfyUI as an unknown field, or worse, as a second JSON layer.
    assert.equal(comfy.submissions[1], comfy.submissions[0], '/prompt body must be byte-identical')
    const body = JSON.parse(comfy.submissions[0])
    assert.deepEqual(Object.keys(body).sort(), ['client_id', 'prompt'])
    assert.equal(body.client_id, process.pid + '-dsh-image-forge')
    assert.ok(!comfy.submissions[0].includes('onPromptId'), 'the hook must never reach the wire')

    // Same request sequence modulo the id ComfyUI assigned, for both runs.
    const shape = comfy.requests.map((line) => line.replace(/prompt-\d+/g, 'prompt-N'))
    assert.deepEqual(shape, [
      'POST /prompt',
      'GET /history/prompt-N',
      'GET /view?filename=out.png&subfolder=&type=output',
      'POST /prompt',
      'GET /history/prompt-N',
      'GET /view?filename=out.png&subfolder=&type=output',
    ])
  } finally {
    await comfy.close()
  }
})
