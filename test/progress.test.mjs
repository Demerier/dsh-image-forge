/**
 * The Studio's progress stream: ComfyUI `/ws` → same-origin SSE.
 *
 * Runs against a real socket on both sides — a fake ComfyUI that answers the
 * WebSocket upgrade (and `/system_stats` for discovery), and a host-shaped
 * server dispatching the plugin's SSE route. A mocked `res` would assert our
 * own framing back at us, while the failures worth catching here are the
 * handshake, the frame shapes ComfyUI actually emits, cleanup when a browser
 * navigates away, and the reconnect loop.
 *
 * The frames are the shapes captured from ComfyUI 0.45.3 and pinned as
 * fixtures, so the test needs no GPU and no live renderer:
 *
 * - envelope: `server.py` `send_json` → `{"type": …, "data": …}`;
 * - step count: `main.py` `hijack_progress` → `progress` with
 *   `{value, max, prompt_id, node}`;
 * - aggregate: `comfy_execution/progress.py` → `progress_state` with a node
 *   map (duplicates `progress`, which is why the bridge dedupes);
 * - lifecycle: `execution.py` → `execution_start` / `execution_error` /
 *   `execution_interrupted` / `execution_success`, and `executing` with a
 *   null node as the per-socket "finished" marker.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { registerStudioRoutes } from '../testlib/studio-routes.js'
import { STUDIO_EVENTS_ROUTE } from '../testlib/studio-shared.js'

/** RFC 6455 handshake GUID. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** The socket id the submission path uses; the bridge must register as it. */
const PLUGIN_CLIENT_ID = process.pid + '-dsh-image-forge'

/** Resolve after `ms` milliseconds. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** One unmasked server→client WebSocket frame. */
function wsFrame(opcode, payload) {
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

/** `Sec-WebSocket-Accept` for one client key. */
function wsAccept(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64')
}

/**
 * A fake ComfyUI: `/system_stats` so discovery succeeds, and one `/ws`
 * endpoint whose messages are scripted per connection.
 */
function fakeComfy() {
  const connections = []
  let script = () => {}
  const server = createServer((req, res) => {
    if (req.url === '/system_stats') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ system: { os: 'test' }, devices: [] }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => {})
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + 'Sec-WebSocket-Accept: ' + wsAccept(req.headers['sec-websocket-key']) + '\r\n\r\n',
    )
    const connection = {
      url: req.url,
      send(value) {
        socket.write(wsFrame(0x1, Buffer.from(JSON.stringify(value))))
      },
      sendText(raw) {
        socket.write(wsFrame(0x1, Buffer.from(raw)))
      },
      sendBinary(bytes) {
        socket.write(wsFrame(0x2, Buffer.from(bytes)))
      },
      close() {
        socket.destroy()
      },
    }
    connections.push(connection)
    script(connection, connections.length - 1)
  })
  return {
    connections,
    onConnection(fn) {
      script = fn
    },
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      return 'http://127.0.0.1:' + server.address().port
    },
    async close() {
      for (const connection of connections) connection.close()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** Studio settings the bridge reads; only `comfyEndpoint` matters here. */
function settingsFor(endpoint) {
  return {
    comfyEndpoint: endpoint,
    comfyPorts: [],
    comfyModelsDir: '',
    timeoutMs: 5000,
    defaultSteps: 40,
    comfyuiSteps: undefined,
    comfyModel: 'qwen21-base',
    turboSteps: undefined,
    outputDir: '',
  }
}

/**
 * Mount the Studio routes on a throwaway server, the way the host does, and
 * hand the base URL to `run`.
 */
async function withStudio(endpoint, run) {
  const registered = []
  const fakeCtx = {
    webServer: {
      register(route) {
        registered.push(route)
        return () => {}
      },
    },
    logger: { warn() {} },
  }
  const disposers = registerStudioRoutes(fakeCtx, {
    settings: () => settingsFor(endpoint),
    ctx: fakeCtx,
    // Shrink the backoff: the reconnect test would otherwise sleep through a
    // production-sized delay.
    progress: { reconnectBaseMs: 20, reconnectMaxMs: 80, discoverTimeoutMs: 1000 },
  })
  const route = registered.find((candidate) => candidate.path === STUDIO_EVENTS_ROUTE)
  assert.ok(route, 'the SSE route must be registered')
  const server = createServer((req, res) => {
    void route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  try {
    return await run(base)
  } finally {
    for (const dispose of disposers) dispose()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

/**
 * Open the plugin's stream and decode its `data:` frames as they arrive.
 *
 * Returns the parsed events, the raw text (so a test can assert on the exact
 * `17/50` copy), a `waitFor` that polls until an event matches, and a
 * `close` that aborts the request the way a closing tab would.
 */
async function openStream(base) {
  const controller = new AbortController()
  const response = await fetch(base + STUDIO_EVENTS_ROUTE, {
    headers: { origin: 'http://' + new URL(base).host },
    signal: controller.signal,
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') || '', /^text\/event-stream/)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events = []
  let raw = ''
  let buffer = ''
  const pump = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        raw = buffer
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue
            events.push(JSON.parse(line.slice(5).trimStart()))
          }
        }
      }
    } catch (error) {
      if (error.name !== 'AbortError') throw error
    }
  })()
  return {
    events,
    get text() {
      return raw
    },
    async waitFor(label, predicate, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = events.find(predicate)
        if (found !== undefined) return found
        if (Date.now() > deadline) {
          throw new Error('timed out waiting for ' + label + '; saw ' + JSON.stringify(events))
        }
        await delay(10)
      }
    },
    async close() {
      controller.abort()
      await pump.catch(() => {})
    },
  }
}

// ---------------------------------------------------------------------------
// One run: the shapes the panel actually renders.
// ---------------------------------------------------------------------------

test('a run becomes queue / start / 17-of-50 / done, without duplicate frames', async () => {
  const comfy = fakeComfy()
  const endpoint = await comfy.listen()
  comfy.onConnection((connection) => {
    connection.send({ type: 'status', data: { status: { exec_info: { queue_remaining: 2 } }, sid: PLUGIN_CLIENT_ID } })
    connection.send({ type: 'execution_start', data: { prompt_id: 'prompt-1' } })
    connection.send({ type: 'executing', data: { node: '3', display_node: '3', prompt_id: 'prompt-1' } })
    connection.send({ type: 'progress', data: { value: 17, max: 50, prompt_id: 'prompt-1', node: '3' } })
    // The same step again through ComfyUI's aggregate message: the stream must
    // carry it once, not twice.
    connection.send({
      type: 'progress_state',
      data: { prompt_id: 'prompt-1', nodes: { '3': { value: 17, max: 50, state: 'running', node_id: '3' } } },
    })
    connection.send({ type: 'execution_success', data: { prompt_id: 'prompt-1' } })
    // ComfyUI's per-socket finished marker, right after execution_success.
    connection.send({ type: 'executing', data: { node: null, prompt_id: 'prompt-1' } })
    // Broadcast chatter the contract deliberately drops.
    connection.send({ type: 'cam.monitor', data: { cpu: 0 } })
  })
  try {
    await withStudio(endpoint, async (base) => {
      const stream = await openStream(base)
      try {
        const connected = await stream.waitFor('connected state', (event) => event.type === 'state' && event.state === 'connected')
        assert.equal(connected.endpoint, endpoint)
        assert.equal(comfy.connections[0].url, '/ws?clientId=' + encodeURIComponent(PLUGIN_CLIENT_ID))

        const queue = await stream.waitFor('queue depth', (event) => event.type === 'queue')
        assert.equal(queue.remaining, 2)

        const start = await stream.waitFor('start', (event) => event.type === 'start')
        assert.equal(start.promptId, 'prompt-1')

        const node = await stream.waitFor('node', (event) => event.type === 'node')
        assert.deepEqual(node, { type: 'node', promptId: 'prompt-1', node: '3', displayNode: '3' })

        const progress = await stream.waitFor('progress', (event) => event.type === 'progress')
        assert.deepEqual(progress, {
          type: 'progress',
          promptId: 'prompt-1',
          node: '3',
          value: 17,
          max: 50,
          percent: 34,
          label: '17/50',
        })
        await stream.waitFor('done', (event) => event.type === 'done')
        // A duplicate would have arrived with the batch that ended `done`.
        await delay(120)
        assert.equal(stream.events.filter((event) => event.type === 'progress').length, 1, 'progress_state must not double-report a step')
        assert.equal(stream.events.filter((event) => event.type === 'done').length, 1, 'success + executing:null must collapse to one done')
        assert.equal(stream.events.filter((event) => event.type === 'cam.monitor').length, 0, 'unknown frames are dropped')
        assert.ok(stream.text.includes('"label":"17/50"'), 'the SSE body carries the literal 17/50 step')
        assert.ok(stream.text.includes('"value":17') && stream.text.includes('"max":50'))
      } finally {
        await stream.close()
      }
    })
  } finally {
    await comfy.close()
  }
})

// ---------------------------------------------------------------------------
// Failures: a failed run must be distinguishable from a broken bridge.
// ---------------------------------------------------------------------------

test('execution_error and interrupt reach the panel with the failing node', async () => {
  const comfy = fakeComfy()
  const endpoint = await comfy.listen()
  comfy.onConnection((connection) => {
    connection.send({ type: 'execution_start', data: { prompt_id: 'prompt-2' } })
    connection.send({
      type: 'execution_error',
      data: {
        prompt_id: 'prompt-2',
        node_id: '5',
        node_type: 'KSampler',
        exception_message: 'CUDA out of memory\nTraceback (most recent call last): …',
        traceback: ['file "…"'],
        executed: [],
        current_inputs: {},
        current_outputs: [],
      },
    })
    connection.send({
      type: 'execution_interrupted',
      data: { prompt_id: 'prompt-3', node_id: '6', node_type: 'KSampler', executed: [] },
    })
  })
  try {
    await withStudio(endpoint, async (base) => {
      const stream = await openStream(base)
      try {
        const failure = await stream.waitFor('error', (event) => event.type === 'error')
        assert.deepEqual(failure, {
          type: 'error',
          promptId: 'prompt-2',
          node: '5',
          nodeType: 'KSampler',
          message: 'CUDA out of memory',
        })
        const interrupted = await stream.waitFor('interrupted', (event) => event.type === 'interrupted')
        assert.equal(interrupted.promptId, 'prompt-3')
        // The traceback is deliberately not on the wire: the panel shows the
        // headline and the full text stays in the generation response.
        assert.ok(!stream.text.includes('Traceback'))
      } finally {
        await stream.close()
      }
    })
  } finally {
    await comfy.close()
  }
})

// ---------------------------------------------------------------------------
// Robustness: junk on the socket is not a reason to end the stream.
// ---------------------------------------------------------------------------

test('binary previews, malformed JSON and unknown frames are ignored', async () => {
  const comfy = fakeComfy()
  const endpoint = await comfy.listen()
  comfy.onConnection((connection) => {
    connection.sendText('this is not json')
    connection.sendBinary([0x52, 0x49, 0x46, 0x46])
    connection.send({ type: 'feature_flags', data: { supports_preview_metadata: true } })
    connection.send({ type: 'executed', data: { node: '7', prompt_id: 'prompt-4', output: {} } })
    connection.send({ type: 'progress', data: { value: 1, max: 2, prompt_id: 'prompt-4', node: '7' } })
  })
  try {
    await withStudio(endpoint, async (base) => {
      const stream = await openStream(base)
      try {
        await stream.waitFor('progress after junk', (event) => event.type === 'progress' && event.max === 2)
        const known = new Set(['state', 'queue', 'start', 'cached', 'node', 'progress', 'done', 'error', 'interrupted'])
        for (const event of stream.events) {
          assert.ok(known.has(event.type), 'unexpected event type leaked: ' + event.type)
        }
        assert.equal(stream.events.filter((event) => event.type === 'progress').length, 1)
      } finally {
        await stream.close()
      }
    })
  } finally {
    await comfy.close()
  }
})

// ---------------------------------------------------------------------------
// Reconnect: a restarted ComfyUI must not leave the panel frozen.
// ---------------------------------------------------------------------------

test('a dropped ComfyUI socket reconnects and reports both states', async () => {
  const comfy = fakeComfy()
  const endpoint = await comfy.listen()
  comfy.onConnection((connection, index) => {
    if (index === 0) {
      connection.send({ type: 'status', data: { status: { exec_info: { queue_remaining: 1 } } } })
      setTimeout(() => connection.close(), 30)
      return
    }
    connection.send({ type: 'status', data: { status: { exec_info: { queue_remaining: 0 } } } })
  })
  try {
    await withStudio(endpoint, async (base) => {
      const stream = await openStream(base)
      try {
        await stream.waitFor('first connection', (event) => event.type === 'state' && event.state === 'connected')
        await stream.waitFor('queue before the drop', (event) => event.type === 'queue' && event.remaining === 1)
        const disconnected = await stream.waitFor('disconnect', (event) => event.type === 'state' && event.state === 'disconnected')
        assert.match(disconnected.reason || '', /断开|出错/)
        const reconnected = await stream.waitFor(
          'reconnect',
          (event) => event.type === 'state' && event.state === 'connected',
          3000,
        )
        assert.equal(reconnected.endpoint, endpoint)
        await stream.waitFor('queue after reconnect', (event) => event.type === 'queue' && event.remaining === 0)
        assert.ok(comfy.connections.length >= 2, 'the bridge must dial a second socket')
        assert.equal(comfy.connections[1].url, '/ws?clientId=' + encodeURIComponent(PLUGIN_CLIENT_ID))
      } finally {
        await stream.close()
      }
    })
  } finally {
    await comfy.close()
  }
})

// ---------------------------------------------------------------------------
// No subscriber = no socket. The plugin must not talk to ComfyUI on its own.
// ---------------------------------------------------------------------------

test('an unwatched Studio never connects to ComfyUI', async () => {
  const comfy = fakeComfy()
  const endpoint = await comfy.listen()
  try {
    await withStudio(endpoint, async () => {
      await delay(150)
      assert.equal(comfy.connections.length, 0, 'constructing the routes must not open the socket')
    })
  } finally {
    await comfy.close()
  }
})

// ---------------------------------------------------------------------------
// Guards: the route is GET-only and same-origin-only, like its siblings.
// ---------------------------------------------------------------------------

test('the stream route refuses POST and cross-origin requests', async () => {
  const comfy = fakeComfy()
  const endpoint = await comfy.listen()
  try {
    await withStudio(endpoint, async (base) => {
      const host = new URL(base).host
      const posted = await fetch(base + STUDIO_EVENTS_ROUTE, {
        method: 'POST',
        headers: { origin: 'http://' + host },
      })
      assert.equal(posted.status, 405)
      assert.equal((await posted.json()).error, 'method-not-allowed')

      const cross = await fetch(base + STUDIO_EVENTS_ROUTE, {
        headers: { origin: 'http://evil.example' },
      })
      assert.equal(cross.status, 403)
      assert.equal((await cross.json()).error, 'origin-rejected')
    })
  } finally {
    await comfy.close()
  }
})

// ---------------------------------------------------------------------------
// Acceptance: the browser half carries no direct ComfyUI connection.
// ---------------------------------------------------------------------------

test('the browser bundle has no ComfyUI WebSocket; the host bundle does', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const host = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(client.length > 0)
  assert.ok(host.length > 0)
  assert.ok(!/new WebSocket\(/.test(client), 'client bundle must not open a WebSocket')
  assert.ok(!/ws:\/\//.test(client), 'client bundle must not carry a ws:// URL')
  assert.ok(!client.includes('/ws?clientId='), 'client bundle must not know the ComfyUI socket URL')
  assert.ok(host.includes('/ws?clientId='), 'the host bundle must carry the bridge')
})
