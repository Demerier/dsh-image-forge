/**
 * Board schema v2 and the v1 → v2 migration (C04).
 *
 * The bug this pins: `readBoardFile` used to return `undefined` for any
 * `version !== 1`, so the moment this plugin started writing v2 an upgraded
 * user's boards would still be on disk and simply **not show up** — the panel
 * would look empty and the work would look lost. v2 is therefore additive and
 * read-time migrated: `migrateBoardFile` upgrades the parsed JSON in memory,
 * `readBoardFile` never writes, and the v2 shape reaches disk with the next
 * write the user causes (lazy migration, DD11).
 *
 * What is asserted here, on real files in a real temp directory:
 *
 * - a v1 fixture survives field-for-field (id/coords/parents/batchId/camera …);
 * - migration is idempotent, so a board can be re-read any number of times
 *   before the lazy write;
 * - a bad entry is dropped one by one and never hides its board;
 * - an unknown version (0/3/missing) is still ignored whole, so a downgrade
 *   cannot rewrite a newer file;
 * - v2 validates by `kind` (image/task/layout), and a future kind drops only
 *   its own entry;
 * - reading a v1 board leaves the file on disk byte-identical;
 * - the next write (layout save, record, remove) persists v2;
 * - lineage still resolves after migration (`resolveParents` path → id), which
 *   is what keeps canvas edges after an upgrade.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  boardsRoot,
  listBoards,
  migrateBoardFile,
  readBoard,
  recordItems,
  removeItem,
  saveLayout,
} from '../testlib/boards.js'

/** A fresh output directory per test. */
function makeDir() {
  return mkdtempSync(join(tmpdir(), 'forge-migrate-'))
}

/** Directory a board file lives in, created on demand. */
function boardsDir(dir) {
  const path = join(boardsRoot(dir), 'boards')
  mkdirSync(path, { recursive: true })
  return path
}

/** One v1 item: the shape the previous release wrote, `kind` absent on purpose. */
function v1Item(dir, name, extra = {}) {
  const path = join(dir, `${name}.png`)
  return {
    id: `i-${name}`,
    path,
    markdownPath: path.replace(/\\/g, '/'),
    width: 1248,
    height: 1248,
    bytes: 1024,
    mediaType: 'image/png',
    prompt: `画一只${name}`,
    ratio: '1:1',
    steps: 8,
    seed: 42,
    mode: 'generate',
    backend: 'comfyui',
    parents: [],
    createdAt: '2026-11-01T00:00:00.000Z',
    sessionId: 's-old',
    batchId: 'gold',
    x: 120,
    y: 240,
    ...extra,
  }
}

/** A whole v1 board file, as the previous release left it on disk. */
function v1Board(id, items, extra = {}) {
  return {
    version: 1,
    id,
    name: '旧画板',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    sessionId: 's-old',
    camera: { x: 10, y: 20, zoom: 1.5 },
    items,
    ...extra,
  }
}

/** Put a board file on disk verbatim, bypassing this module's writers. */
function writeBoardFile(dir, id, board) {
  writeFileSync(join(boardsDir(dir), `${id}.json`), JSON.stringify(board))
}

/** Read one board file back as raw JSON (what a reload actually parses). */
function readBoardFileJson(dir, id) {
  return JSON.parse(readFileSync(join(boardsDir(dir), `${id}.json`), 'utf8'))
}

test('a v1 board migrates to v2 with every field intact', () => {
  const dir = makeDir()
  try {
    // Two items: a plain image and an edit that carries lineage and a batch id.
    const source = v1Item(dir, 'base')
    const edited = v1Item(dir, 'edit', {
      mode: 'edit',
      parents: [source.id],
      batchId: 'g-edit',
      ratio: '16:9',
      steps: 20,
      seed: 7,
      x: -30.5,
      y: 0,
      prompt: '',
    })
    const board = v1Board('bv1fixture', [source, edited])
    const migrated = migrateBoardFile(structuredClone(board))

    assert.equal(migrated.version, 2, 'the migrated board is v2')
    assert.equal(migrated.id, board.id)
    assert.equal(migrated.name, board.name)
    assert.equal(migrated.createdAt, board.createdAt)
    assert.equal(migrated.updatedAt, board.updatedAt)
    assert.equal(migrated.sessionId, board.sessionId)
    assert.deepEqual(migrated.camera, board.camera, 'the camera survives untouched')

    // Field-for-field: the only difference allowed is the added `kind`.
    assert.deepEqual(migrated.items, board.items.map((item) => ({ ...item, kind: 'image' })))
    assert.deepEqual(migrated.items[0], { ...source, kind: 'image' })
    assert.deepEqual(migrated.items[1].parents, [source.id], 'lineage ids are not rewritten')
    assert.equal(migrated.items[1].batchId, 'g-edit')
    assert.equal(migrated.items[1].x, -30.5, 'coordinates, including fractional ones, are kept')
    assert.equal(migrated.items[0].width, 1248)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('migration is idempotent, and a v2 board comes back unchanged', () => {
  const dir = makeDir()
  try {
    const board = v1Board('bidempotent', [v1Item(dir, 'once'), v1Item(dir, 'twice')])
    const once = migrateBoardFile(structuredClone(board))
    const twice = migrateBoardFile(structuredClone(once))
    assert.deepEqual(twice, once, 'a second pass must be a no-op')
    // A v2 fixture (kind already present on every item) is a verbatim pass-through.
    const v2 = { ...once, items: once.items.map((item) => ({ ...item, w: 999 })) }
    assert.deepEqual(migrateBoardFile(structuredClone(v2)).items, v2.items)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a bad v1 entry is dropped alone and never hides the board', async () => {
  const dir = makeDir()
  try {
    const good = v1Item(dir, 'good')
    const board = v1Board('bdirty', [
      good,
      { path: 'no-id.png', markdownPath: 'no-id.png' },                 // missing id
      { id: 'i-nopath', markdownPath: 'x.png' },                        // missing path
      { id: 'i-nomd', path: join(dir, 'x.png') },                       // missing markdownPath
      'not an object',
      null,
    ])
    const migrated = migrateBoardFile(structuredClone(board))
    assert.equal(migrated.items.length, 1, 'only the valid entry survives')
    assert.deepEqual(migrated.items[0], { ...good, kind: 'image' })

    // And through the real read path, the board is still visible and usable.
    writeBoardFile(dir, board.id, board)
    const detail = await readBoard(dir, board.id)
    assert.equal(detail.items.length, 1)
    assert.equal(detail.items[0].id, good.id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unknown board version is ignored whole, on disk and in the list', async () => {
  const dir = makeDir()
  try {
    const good = v1Board('bgoodv1', [v1Item(dir, 'kept')])
    writeBoardFile(dir, good.id, good)
    // 0, a future version, missing, and a string: none may be migrated.
    writeBoardFile(dir, 'bversion0', v1Board('bversion0', [], { version: 0 }))
    writeBoardFile(dir, 'bversion3', v1Board('bversion3', [], { version: 3 }))
    writeBoardFile(dir, 'bnoversion', v1Board('bnoversion', [], { version: undefined }))
    writeBoardFile(dir, 'bstrversion', v1Board('bstrversion', [], { version: '2' }))

    assert.equal(migrateBoardFile(v1Board('bx', [], { version: 0 })), undefined)
    assert.equal(migrateBoardFile(v1Board('bx', [], { version: 3 })), undefined)
    assert.equal(migrateBoardFile(v1Board('bx', [], { version: undefined })), undefined)
    assert.equal(migrateBoardFile(v1Board('bx', [], { version: '2' })), undefined)
    assert.equal(migrateBoardFile(null), undefined)
    assert.equal(migrateBoardFile('{ not json'), undefined)
    // A newer file must never be rewritten by an older reader.
    assert.equal(migrateBoardFile(v1Board('bx', [], { version: 3 })), undefined)

    const boards = await listBoards(dir)
    assert.deepEqual(boards.map((entry) => entry.id), [good.id], 'only the v1 board is listed')
    // Refused files stay exactly as they were: an older reader must not rewrite them.
    const expectedVersion = { bversion0: 0, bversion3: 3, bstrversion: '2', bnoversion: undefined }
    for (const [id, version] of Object.entries(expectedVersion)) {
      assert.equal(await readBoard(dir, id), undefined)
      assert.equal(readBoardFileJson(dir, id).version, version)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reading a v1 board never writes: the file stays v1 until the next write', async () => {
  const dir = makeDir()
  try {
    const board = v1Board('blazy', [v1Item(dir, 'lazy')])
    writeBoardFile(dir, board.id, board)
    const before = readFileSync(join(boardsDir(dir), `${board.id}.json`), 'utf8')

    const detail = await readBoard(dir, board.id)
    assert.equal(detail.items[0].kind, 'image', 'the caller sees the v2 shape')
    await listBoards(dir)

    assert.equal(
      readFileSync(join(boardsDir(dir), `${board.id}.json`), 'utf8'),
      before,
      'a read must not rewrite the board (read-only outputDir would break)',
    )
    assert.equal(readBoardFileJson(dir, board.id).version, 1)
    assert.equal('kind' in readBoardFileJson(dir, board.id).items[0], false)

    // The first real write is what persists v2.
    await saveLayout(dir, board.id, { items: [{ id: 'i-lazy', x: 700, y: 800 }], camera: { x: 1, y: 2, zoom: 0.5 } })
    const after = readBoardFileJson(dir, board.id)
    assert.equal(after.version, 2, 'the next write lands v2 (lazy migration)')
    assert.equal(after.items[0].kind, 'image')
    assert.equal(after.items[0].x, 700)
    assert.equal(after.items[0].prompt, board.items[0].prompt, 'migrating and rewriting keeps the metadata')
    assert.deepEqual(after.camera, { x: 1, y: 2, zoom: 0.5 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v2 items are validated by kind, and a future kind drops only its entry', () => {
  const dir = makeDir()
  try {
    const image = { ...v1Item(dir, 'img'), kind: 'image' }
    const task = {
      id: 'i-task', kind: 'task', path: '', markdownPath: '', width: 0, height: 0, bytes: 0,
      mediaType: '', prompt: '失败的一次', ratio: null, steps: null, seed: null, mode: 'generate',
      backend: null, parents: [image.id], createdAt: '2026-11-03T00:00:00.000Z', sessionId: null,
      batchId: 'g-task', x: 40, y: 40,
      task: { status: 'failed', params: { prompt: '失败的一次', ratio: '1:1', count: 1 }, error: 'CUDA out of memory' },
    }
    const layout = {
      id: 'i-layout', kind: 'layout', path: '', markdownPath: '', width: 0, height: 0, bytes: 0,
      mediaType: '', prompt: '', ratio: null, steps: null, seed: null, mode: 'generate', backend: null,
      parents: [], createdAt: '', sessionId: null, batchId: 'g-layout', x: 0, y: 0,
      w: 400, h: 300,
      draft: {
        width: 1536, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy',
        summary: { caption: '一份布局' },
        items: [{ label: 'object', caption: '左侧的树', bbox: [10, 20, 300, 400] }],
      },
    }
    const board = {
      version: 2, id: 'bv2kinds', name: 'v2', createdAt: '', updatedAt: '', sessionId: null, camera: null,
      items: [
        image,
        task,
        layout,
        // Non-terminal task (a running node is never stored), and a layout with no draft.
        { ...task, id: 'i-running', task: { status: 'running', params: { prompt: 'x' } } },
        { ...task, id: 'i-noparams', task: { status: 'failed' } },
        { ...layout, id: 'i-nodraft', draft: undefined },
        { ...layout, id: 'i-baddraft', draft: { width: 1536, height: 1024 } },
        // A node type from a future version: drop it, keep the board.
        { id: 'i-text', kind: 'text', text: '一句标注' },
        // An unknown kind without any payload is equally dropped.
        { id: 'i-mystery', kind: 'video' },
      ],
    }
    const migrated = migrateBoardFile(structuredClone(board))
    assert.deepEqual(migrated.items.map((entry) => entry.id), [image.id, task.id, layout.id])
    assert.equal(migrated.items[1].task.status, 'failed')
    assert.deepEqual(migrated.items[2].draft.items[0].bbox, [10, 20, 300, 400], 'the draft is stored verbatim')
    assert.equal(migrated.version, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lineage still resolves after migration: parentPaths map to migrated ids', async () => {
  const dir = makeDir()
  try {
    const source = v1Item(dir, 'src')
    writeBoardFile(dir, 'blineage', v1Board('blineage', [source]))

    // The v1 item is now an image node with the same id and path, so a caller
    // that only knows the path (the conversation path) still resolves the edge.
    const edited = await recordItems(dir, 'blineage', [{
      path: join(dir, 'edited.png'),
      markdownPath: join(dir, 'edited.png').replace(/\\/g, '/'),
      width: 1248, height: 1248, bytes: 10, mediaType: 'image/png',
      prompt: '改图', mode: 'edit', parentPaths: [source.path],
    }])
    assert.deepEqual(edited.items[0].parents, [source.id])

    const board = await readBoard(dir, 'blineage')
    assert.deepEqual(board.items.map((entry) => entry.kind), ['image', 'image'])
    assert.deepEqual(board.items[0].parents, [], 'the migrated item keeps its own edges')
    assert.deepEqual(board.items[1].parents, [source.id])
    // Writing over a migrated v1 board is what lands v2 on disk.
    assert.equal(readBoardFileJson(dir, 'blineage').version, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('concurrent writes over a migrated v1 board keep every item and leave no staging file', async () => {
  const dir = makeDir()
  try {
    const seed = v1Item(dir, 'seed')
    writeBoardFile(dir, 'bconcurrent', v1Board('bconcurrent', [seed]))

    const results = await Promise.all(['p1', 'p2', 'p3'].map((name) => recordItems(dir, 'bconcurrent', [{
      path: join(dir, `${name}.png`),
      markdownPath: join(dir, `${name}.png`).replace(/\\/g, '/'),
      width: 1248, height: 1248, bytes: 10, mediaType: 'image/png', prompt: name,
    }])))
    for (const result of results) assert.equal(result.created, false, 'every write found the migrated board')

    const board = await readBoard(dir, 'bconcurrent')
    assert.equal(board.items.length, 4, 'the v1 item plus three concurrent writes')
    assert.equal(board.items[0].id, seed.id, 'the v1 item keeps its id through the merge')
    assert.equal(readBoardFileJson(dir, 'bconcurrent').version, 2)

    // Atomic write: the staging file is renamed, never left behind.
    const names = readdirSync(boardsDir(dir))
    assert.deepEqual(names.filter((name) => name.includes('.partial-')), [])
    assert.ok(names.includes('bconcurrent.json'))
    assert.ok(!existsSync(join(boardsDir(dir), 'bconcurrent.json.partial')))

    // Removal also persists v2, and drops only the named item.
    const removed = await removeItem(dir, 'bconcurrent', seed.id)
    assert.equal(removed.removed.id, seed.id)
    assert.equal((await readBoard(dir, 'bconcurrent')).items.length, 3)
    assert.equal(readBoardFileJson(dir, 'bconcurrent').version, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
