/**
 * Panel-generation lineage (C01): the board has to remember **who** a run was
 * edited from, or the canvas edge vanishes on the next reload.
 *
 * The bug this pins: the Studio's record path hard-coded `parents: []`, so an
 * edit made in the panel drew its edge from session memory only
 * (`studio-view.ts` reads the references' `nodeId`s) and the edge was gone as
 * soon as the panel reloaded the board from disk. The conversation tool path
 * already persisted lineage (`tools.ts` passes `parentPaths`, `boards.ts`
 * resolves them to item ids inside the write lock); the panel now travels the
 * same way, which is what these tests assert through a **real board file**: run
 * the pipeline against a fake ComfyUI, then re-read the JSON from disk — the
 * exact read a reload performs.
 *
 * The fake speaks the same four endpoints `test/comfyui-e2e.test.mjs` fakes,
 * plus `/upload/image`, which the edit graph needs. Nothing here touches a GPU,
 * a real ComfyUI or the network beyond loopback.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runStudioGeneration } from '../testlib/studio-service.js'
import { boardsRoot, readBoard, recordItems } from '../testlib/boards.js'

/** A real 1×1 PNG: enough for the size/extension checks a reference goes through. */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

/** The weight file names the fake ComfyUI offers, mirroring a real install. */
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

const PROMPT_ID = 'fake-lineage-prompt-id'

/**
 * Start a fake ComfyUI.
 *
 * The upload answer carries a fixed name: the adapter refuses a response with
 * no name, and this test is about the board, not about the upload framing.
 *
 * @returns the endpoint, the request log, and a closer.
 */
async function startFakeComfy() {
  const seen = []
  const state = { graph: undefined, uploads: 0 }
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
        state.uploads += 1
        seen.push({ method: request.method, path: url.pathname })
        return send(200, JSON.stringify({ name: 'dsh-forge-ref.png', subfolder: '', type: 'input' }))
      }
      seen.push({ method: request.method, path: url.pathname })
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
              outputs: { '8': { images: [{ filename: 'dsh-image-forge_00001_.png', subfolder: '', type: 'output' }] } },
              status: { status_str: 'success', completed: true, messages: [['execution_success', { prompt_id: PROMPT_ID }]] },
            },
          }),
        )
      }
      if (url.pathname === '/view') return send(200, Buffer.from(PNG_1X1, 'base64'), 'image/png')
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

/** The settings shape `runStudioGeneration` reads, pointed at the fake server. */
function settingsFor(comfy, outputDir) {
  return {
    comfyEndpoint: comfy.endpoint,
    comfyPorts: String(comfy.port),
    comfyModelsDir: 'D:\\models',
    timeoutMs: 30_000,
    outputDir,
    defaultSteps: 25,
    comfyuiSteps: undefined,
    comfyModel: 'qwen21-base',
    turboSteps: undefined,
  }
}

/** Run one panel generation and hand back its response. */
function draw(comfy, outputDir, body) {
  return runStudioGeneration(
    settingsFor(comfy, outputDir),
    { prompt: 'A night street after rain.', ratio: '1:1', seed: 7, count: 1, ...body },
    new AbortController().signal,
  )
}

/** A temp tree with an output directory and a `seed/` folder for fixture images. */
function fixture(prefix) {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`))
  const outputDir = join(root, 'out')
  const seeds = join(root, 'seed')
  for (const dir of [outputDir, seeds]) mkdirSync(dir, { recursive: true })
  return { root, outputDir, seeds }
}

/** Write a reference PNG to disk and hand back its absolute path. */
function seedImage(seeds, name) {
  const path = join(seeds, name)
  writeFileSync(path, Buffer.from(PNG_1X1, 'base64'))
  return path
}

/**
 * Record one finished image on a **new** board, the way an earlier run would.
 *
 * This is what makes a reference resolvable at all: `resolveParents` only knows
 * the board's own items, so the "reference from before" has to exist as one.
 *
 * @returns the board id and the id of the recorded (parent) item.
 */
async function seedBoard(outputDir, path) {
  const written = await recordItems(outputDir, undefined, [{
    path,
    markdownPath: path.replace(/\\/g, '/'),
    width: 1248,
    height: 1248,
    bytes: Buffer.from(PNG_1X1, 'base64').byteLength,
    mediaType: 'image/png',
    prompt: 'an earlier image',
    mode: 'generate',
    backend: 'studio',
  }], { prompt: 'an earlier image' })
  return { boardId: written.board.id, itemId: written.items[0].id }
}

/**
 * Read a board's JSON straight off disk — the reload path, not the in-memory
 * write result.
 *
 * @param outputDir - the configured output directory.
 * @param boardId - the board to read.
 * @returns the parsed file body.
 */
function boardJson(outputDir, boardId) {
  return JSON.parse(readFileSync(join(boardsRoot(outputDir), 'boards', `${boardId}.json`), 'utf8'))
}

/** The one item in a parsed board file, by id. */
function itemOf(file, id) {
  const item = file.items.find((candidate) => candidate.id === id)
  assert.ok(item !== undefined, `board file has no item ${id}`)
  return item
}

test('a panel edit whose reference is a board item persists the parent edge', async () => {
  const comfy = await startFakeComfy()
  const { root, outputDir, seeds } = fixture('forge-lineage-path')
  try {
    const parentPath = seedImage(seeds, 'parent.png')
    const { boardId, itemId: parentId } = await seedBoard(outputDir, parentPath)

    const result = await draw(comfy, outputDir, {
      board: boardId,
      references: [{ path: parentPath, mediaType: 'image/png', name: 'parent.png' }],
    })
    assert.equal(result.mode, 'edit')
    assert.equal(result.images.length, 1)
    const childId = result.images[0].id
    assert.notEqual(childId, parentId)

    // The file on disk is the contract: a reload parses this, nothing else.
    const file = boardJson(outputDir, boardId)
    console.log('persisted parents:', JSON.stringify(itemOf(file, childId).parents))
    assert.deepEqual(itemOf(file, childId).parents, [parentId])
    // The parent itself is untouched — lineage is recorded on the child only.
    assert.deepEqual(itemOf(file, parentId).parents, [])
  } finally {
    await comfy.close()
    rmSync(root, { recursive: true, force: true })
  }
});

test('the edge survives a reload and chains through the next edit', async () => {
  const comfy = await startFakeComfy()
  const { root, outputDir, seeds } = fixture('forge-lineage-reload')
  try {
    const parentPath = seedImage(seeds, 'parent.png')
    const { boardId, itemId: parentId } = await seedBoard(outputDir, parentPath)
    const first = await draw(comfy, outputDir, {
      board: boardId,
      references: [{ path: parentPath, mediaType: 'image/png', name: 'parent.png' }],
    })
    const firstId = first.images[0].id

    // "Reload": read the board back through the store, the way the panel does.
    const reloaded = await readBoard(outputDir, boardId)
    assert.ok(reloaded !== undefined)
    assert.deepEqual(reloaded.items.find((item) => item.id === firstId)?.parents, [parentId])

    // Editing the result of that edit extends the chain by one, id → id.
    const second = await draw(comfy, outputDir, {
      board: boardId,
      references: [{ path: first.images[0].path, mediaType: 'image/png', name: 'first.png' }],
    })
    const secondId = second.images[0].id
    const file = boardJson(outputDir, boardId)
    assert.deepEqual(itemOf(file, secondId).parents, [firstId])
    assert.deepEqual(itemOf(file, firstId).parents, [parentId])
  } finally {
    await comfy.close()
    rmSync(root, { recursive: true, force: true })
  }
});

test('a base64 reference generates fine but records no edge', async () => {
  const comfy = await startFakeComfy()
  const { root, outputDir } = fixture('forge-lineage-base64')
  try {
    const result = await draw(comfy, outputDir, {
      references: [{ data: PNG_1X1, mediaType: 'image/png', name: 'pasted.png' }],
    })
    // Uploaded bytes are not board items, so there is no id an edge could point
    // at — the run must still complete (same semantics as the conversation tool).
    assert.equal(result.mode, 'edit')
    assert.equal(comfy.state.uploads, 1)
    assert.ok(existsSync(result.images[0].path))
    assert.ok(result.board !== undefined)
    const file = boardJson(outputDir, result.board.id)
    assert.deepEqual(itemOf(file, result.images[0].id).parents, [])
  } finally {
    await comfy.close()
    rmSync(root, { recursive: true, force: true })
  }
});

test('a reference from another board records no edge and does not fail the run', async () => {
  const comfy = await startFakeComfy()
  const { root, outputDir, seeds } = fixture('forge-lineage-cross')
  try {
    const foreignPath = seedImage(seeds, 'foreign.png')
    const other = await seedBoard(outputDir, foreignPath)
    const target = await seedBoard(outputDir, seedImage(seeds, 'local.png'))

    const result = await draw(comfy, outputDir, {
      board: target.boardId,
      references: [{ path: foreignPath, mediaType: 'image/png', name: 'foreign.png' }],
    })
    // `resolveParents` matches against the *writing* board only; a path it cannot
    // place is dropped without ceremony, because a missing edge must never fail a
    // generation that already produced bytes.
    assert.equal(result.mode, 'edit')
    assert.equal(result.boardNote, undefined)
    assert.ok(existsSync(result.images[0].path))
    const file = boardJson(outputDir, target.boardId)
    assert.deepEqual(itemOf(file, result.images[0].id).parents, [])
    assert.equal(itemOf(file, result.images[0].id).mode, 'edit')
    // Nothing leaked into the foreign board either.
    assert.equal(boardJson(outputDir, other.boardId).items.length, 1)
  } finally {
    await comfy.close()
    rmSync(root, { recursive: true, force: true })
  }
});

test('a plain draw records no parents', async () => {
  const comfy = await startFakeComfy()
  const { root, outputDir } = fixture('forge-lineage-plain')
  try {
    const result = await draw(comfy, outputDir, {})
    assert.equal(result.mode, 'generate')
    assert.ok(result.board !== undefined)
    const file = boardJson(outputDir, result.board.id)
    assert.deepEqual(itemOf(file, result.images[0].id).parents, [])
    assert.equal(comfy.state.uploads, 0)
  } finally {
    await comfy.close()
    rmSync(root, { recursive: true, force: true })
  }
});
