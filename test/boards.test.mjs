/**
 * Boards: the unit the Studio stores and displays work in.
 *
 * The contract here is a filesystem one, so every case uses a real temporary
 * directory rather than a mocked `fs`. What matters and is asserted:
 *
 * - a conversation call with no board **creates one**, named from the prompt;
 * - a board is found by id *or* by name, so a model can hand either back;
 * - the same file recorded twice is one item, not two;
 * - layout and camera round-trip, and unknown ids never fail a save;
 * - removing an item is reversible by default; deleting a file is opt-in and
 *   only possible inside the output directory;
 * - two concurrent writes to one board do not lose the first one's items;
 * - a corrupt board file hides that board, not the library.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activeBoardId,
  boardsRoot,
  createBoard,
  defaultBoardName,
  deleteBoard,
  listAssets,
  listBoards,
  nameFromPrompt,
  readBoard,
  recordItems,
  removeItem,
  renameBoard,
  saveLayout,
  sanitizeBoardName,
  setActiveBoard,
} from '../testlib/boards.js'
import { writeImages } from '../testlib/output.js'

/** A fresh output directory per test; nothing is shared between them. */
function makeDir() {
  return mkdtempSync(join(tmpdir(), 'forge-boards-'))
}

/** One recorded image, with a path unique per call. */
function item(dir, name, extra = {}) {
  const path = join(dir, `${name}.png`)
  return {
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
    ...extra,
  }
}

test('a board name comes from the prompt, capped by code point', () => {
  assert.equal(nameFromPrompt('  一只橘猫坐在窗台上\n第二行不算  '), '一只橘猫坐在窗台上')
  // Control characters and runs of whitespace collapse instead of reaching the UI.
  assert.equal(nameFromPrompt('a\t b\n\nc'), 'a b')
  // 39 emoji are 78 UTF-16 units; the cap is by code point, so no half pair.
  const capped = nameFromPrompt('🐈'.repeat(80))
  assert.equal([...capped].length, 39)
  assert.ok(!capped.includes('\uFFFD'), 'a surrogate pair must never be split')
  // An empty prompt still yields something a <select> can render.
  assert.match(nameFromPrompt('   '), /^画板 \d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(defaultBoardName(new Date(2026, 9, 19, 9, 5)), '画板 10-19 09:05')
})

test('an unusable board name is refused rather than silently blanked', () => {
  assert.equal(sanitizeBoardName('  海报 A  '), '海报 A')
  assert.equal(sanitizeBoardName('   '), undefined)
  assert.equal(sanitizeBoardName(undefined), undefined)
  assert.equal([...sanitizeBoardName('字'.repeat(60))].length, 40)
})

test('a call with no board creates one, and the next call creates another', async () => {
  const dir = makeDir()
  try {
    const first = await recordItems(dir, undefined, [item(dir, 'a1')], { prompt: '海报 A' })
    assert.equal(first.created, true)
    assert.equal(first.board.name, '海报 A')
    assert.equal(first.board.itemCount, 1)
    assert.equal(first.items.length, 1)
    assert.match(first.items[0].id, /^i/)
    assert.equal(first.items[0].x, 40)

    // Omitted again means "a new subject", which is the documented rule: the
    // conversation path never guesses at the panel's open board.
    const second = await recordItems(dir, undefined, [item(dir, 'b1')], { prompt: '海报 B' })
    assert.equal(second.created, true)
    assert.notEqual(second.board.id, first.board.id)
    assert.equal((await listBoards(dir)).length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a board is found by id or by name, and a stale value becomes a new board', async () => {
  const dir = makeDir()
  try {
    const first = await recordItems(dir, undefined, [item(dir, 'a1')], { prompt: '海报 A' })
    const byId = await recordItems(dir, first.board.id, [item(dir, 'a2')])
    assert.equal(byId.created, false)
    assert.equal(byId.board.id, first.board.id)

    // Names match case-insensitively, which is how a model retypes them.
    const byName = await recordItems(dir, '海报 a', [item(dir, 'a3')])
    assert.equal(byName.board.id, first.board.id)
    assert.equal(byName.board.itemCount, 3)

    // An unknown ref is a name, not an error: refusing would fail a paid draw.
    const fresh = await recordItems(dir, '新题材', [item(dir, 'c1')])
    assert.equal(fresh.created, true)
    assert.equal(fresh.board.name, '新题材')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the same file recorded twice stays one item and keeps its position', async () => {
  const dir = makeDir()
  try {
    const created = await recordItems(dir, undefined, [item(dir, 'same')], { prompt: '同一张' })
    const id = created.items[0].id
    await saveLayout(dir, created.board.id, { items: [{ id, x: 500, y: 260 }] })

    const again = await recordItems(dir, created.board.id, [item(dir, 'same', { prompt: '换了描述' })])
    assert.equal(again.items.length, 1)
    assert.equal(again.items[0].id, id)
    assert.equal(again.items[0].x, 500, 'a re-record must not move the node')
    assert.equal(again.items[0].prompt, '换了描述', 'metadata is refreshed')

    const board = await readBoard(dir, created.board.id)
    assert.equal(board.items.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unplaced items land on a three-column grid, in write order', async () => {
  const dir = makeDir()
  try {
    const created = await recordItems(dir, undefined, [
      item(dir, 'g1'), item(dir, 'g2'), item(dir, 'g3'), item(dir, 'g4'),
    ])
    assert.deepEqual(created.items.map((entry) => [entry.x, entry.y]), [
      [40, 40],
      [284, 40],
      [528, 40],
      [40, 316],
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('layout and camera round-trip, and an unknown id never fails the save', async () => {
  const dir = makeDir()
  try {
    const created = await recordItems(dir, undefined, [item(dir, 'l1')])
    const id = created.items[0].id
    const saved = await saveLayout(dir, created.board.id, {
      items: [{ id, x: -120, y: 47.5 }, { id: 'i-does-not-exist', x: 0, y: 0 }],
      camera: { x: 10, y: 20, zoom: 0.8 },
    })
    assert.equal(saved.id, created.board.id)
    const board = await readBoard(dir, created.board.id)
    assert.equal(board.items[0].x, -120)
    assert.equal(board.items[0].y, 47.5)
    assert.deepEqual(board.camera, { x: 10, y: 20, zoom: 0.8 })
    // A nonsensical camera clears it rather than storing NaN.
    await saveLayout(dir, created.board.id, { camera: { x: Number.NaN, y: 0, zoom: 1 } })
    assert.equal((await readBoard(dir, created.board.id)).camera, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('removing an item is reversible by default, and deleting the file is guarded', async () => {
  const dir = makeDir()
  const outside = mkdtempSync(join(tmpdir(), 'forge-outside-'))
  try {
    mkdirSync(dir, { recursive: true })
    const insidePath = join(dir, 'inside.png')
    const outsidePath = join(outside, 'secret.png')
    writeFileSync(insidePath, 'png')
    writeFileSync(outsidePath, 'png')

    const created = await recordItems(dir, undefined, [
      item(dir, 'inside', { path: insidePath, markdownPath: insidePath }),
      item(dir, 'outside', { path: outsidePath, markdownPath: outsidePath }),
    ])
    const [insideItem, outsideItem] = created.items

    const unplaced = await removeItem(dir, created.board.id, insideItem.id)
    assert.equal(unplaced.fileDeleted, false)
    assert.ok(existsSync(insidePath), 'the default only unplaces')

    // A crafted board file must not be able to delete outside the output dir.
    const guarded = await removeItem(dir, created.board.id, outsideItem.id, { deleteFile: true })
    assert.equal(guarded.fileDeleted, false)
    assert.ok(existsSync(outsidePath))

    // Re-record and delete for real: the path is inside, so the file goes.
    const again = await recordItems(dir, created.board.id, [item(dir, 'inside', { path: insidePath, markdownPath: insidePath })])
    const gone = await removeItem(dir, created.board.id, again.items[0].id, { deleteFile: true })
    assert.equal(gone.fileDeleted, true)
    assert.equal(existsSync(insidePath), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('deleting a board drops its metadata, never its images', async () => {
  const dir = makeDir()
  try {
    const created = await recordItems(dir, undefined, [item(dir, 'keep')])
    writeFileSync(join(dir, 'keep.png'), 'png')
    assert.equal(await deleteBoard(dir, created.board.id), true)
    assert.equal(await readBoard(dir, created.board.id), undefined)
    assert.ok(existsSync(join(dir, 'keep.png')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('renaming refuses an empty name and keeps the id stable', async () => {
  const dir = makeDir()
  try {
    const created = await recordItems(dir, undefined, [item(dir, 'r1')], { prompt: '旧名' })
    assert.equal(await renameBoard(dir, created.board.id, '   '), undefined)
    const renamed = await renameBoard(dir, created.board.id, '  新名字  ')
    assert.equal(renamed.name, '新名字')
    assert.equal(renamed.id, created.board.id)
    assert.equal((await readBoard(dir, created.board.id)).name, '新名字')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the asset page spans boards, filters by board and by free text', async () => {
  const dir = makeDir()
  try {
    const red = await recordItems(dir, undefined, [item(dir, 'red', { prompt: '黄昏的红色屋顶' })], { prompt: '红' })
    const blue = await recordItems(dir, undefined, [item(dir, 'blue', { prompt: '清晨的蓝色海面' })], { prompt: '蓝' })

    const all = await listAssets(dir)
    assert.equal(all.total, 2)
    assert.equal(all.assets.length, 2)
    assert.ok(all.assets.every((asset) => typeof asset.boardId === 'string' && typeof asset.boardName === 'string'))

    const onlyRed = await listAssets(dir, { board: red.board.id })
    assert.equal(onlyRed.total, 1)
    assert.equal(onlyRed.assets[0].boardId, red.board.id)

    const searched = await listAssets(dir, { q: '蓝' })
    assert.equal(searched.total, 1)
    assert.equal(searched.assets[0].boardId, blue.board.id)

    // The filter also matches a file name, which is how people search a folder.
    assert.equal((await listAssets(dir, { q: 'red.png' })).total, 1)
    assert.equal((await listAssets(dir, { q: '没有任何匹配' })).total, 0)
    assert.equal((await listAssets(dir, { limit: 1 })).assets.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('two concurrent writes to one board do not lose items', async () => {
  const dir = makeDir()
  try {
    const created = await recordItems(dir, undefined, [item(dir, 'seed')], { prompt: '并发' })
    const results = await Promise.all([
      recordItems(dir, created.board.id, [item(dir, 'p1')]),
      recordItems(dir, created.board.id, [item(dir, 'p2')]),
      recordItems(dir, created.board.id, [item(dir, 'p3')]),
    ])
    const board = await readBoard(dir, created.board.id)
    assert.equal(board.items.length, 4, 'every write must survive the read-modify-write')
    for (const result of results) {
      assert.equal(result.items[0].path.startsWith(join(dir, 'p')), true)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt board file hides that board, not the library', async () => {
  const dir = makeDir()
  try {
    const created = await recordItems(dir, undefined, [item(dir, 'ok')])
    writeFileSync(join(boardsRoot(dir), 'boards', 'bbroken.json'), '{ not json')
    const boards = await listBoards(dir)
    assert.equal(boards.length, 1)
    assert.equal(boards[0].id, created.board.id)
    assert.equal(await readBoard(dir, 'bbroken'), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the active board is remembered, and a missing state file is just null', async () => {
  const dir = makeDir()
  try {
    assert.equal(await activeBoardId(dir), null)
    const created = await createBoard(dir, '打开我')
    assert.equal(await setActiveBoard(dir, created.id), true)
    assert.equal(await activeBoardId(dir), created.id)
    assert.equal(await setActiveBoard(dir, null), true)
    assert.equal(await activeBoardId(dir), null)
    // The state file is JSON, not a board: it must not show up in the list.
    assert.equal((await listBoards(dir)).length, 1)
    const raw = JSON.parse(readFileSync(join(boardsRoot(dir), 'state.json'), 'utf8'))
    assert.deepEqual(raw, { active: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('creating a board by hand gives it a printable default name', async () => {
  const dir = makeDir()
  try {
    const named = await createBoard(dir, '  手动画板  ')
    assert.equal(named.name, '手动画板')
    assert.equal(named.itemCount, 0)
    assert.equal(named.cover, null)
    const fallback = await createBoard(dir)
    assert.match(fallback.name, /^画板 \d{2}-\d{2} \d{2}:\d{2}$/)
    assert.notEqual(fallback.id, named.id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a crafted board id cannot walk out of the boards directory', async () => {
  const dir = makeDir()
  try {
    // Every read, write and delete funnels through one id check, so a hostile
    // id — from a route parameter or hand-edited board file — is refused at the
    // storage layer instead of resolving to a path outside `boards/`.
    const escape = join(dir, 'escaped.json')
    assert.equal(await readBoard(dir, '../../escaped'), undefined)
    assert.equal(await readBoard(dir, '..%2Fescaped'), undefined)
    assert.equal(await deleteBoard(dir, '../../escaped'), false)
    assert.equal(await renameBoard(dir, '../../escaped', 'x'), undefined)
    assert.equal(await saveLayout(dir, '../../escaped', { items: [] }), undefined)
    assert.equal(await removeItem(dir, '../../escaped', 'i1'), undefined)
    assert.ok(!existsSync(escape), 'no file may appear outside the boards directory')
    // A legitimate generated id still round-trips.
    const created = await recordItems(dir, undefined, [item(dir, 'ok')])
    assert.match(created.board.id, /^[a-z0-9]+$/)
    assert.ok(await readBoard(dir, created.board.id))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parentPaths resolve to board item ids, and unmatched paths drop silently', async () => {
  const dir = makeDir()
  try {
    const source = await recordItems(dir, undefined, [item(dir, 'source')], { prompt: '原图' })
    const sourcePath = source.items[0].path
    // The caller passes the reference path as it had it — separators and case
    // may differ from what the board stored (Windows reports both forms).
    const flipped = sourcePath.split('\\').join('/').toUpperCase()
    const edited = await recordItems(dir, source.board.id, [
      item(dir, 'edit', { mode: 'edit', parentPaths: [flipped, join(dir, '不存在.png')] }),
    ], { prompt: '改图' })
    assert.deepEqual(edited.items[0].parents, [source.items[0].id], 'the matched path becomes the edge')
    // An item that carries explicit ids is left untouched.
    const manual = await recordItems(dir, source.board.id, [
      item(dir, 'manual', { mode: 'edit', parents: ['i-custom'] }),
    ], { prompt: '手动连线' })
    assert.deepEqual(manual.items[0].parents, ['i-custom'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('concurrent writeImages calls never overwrite each other', async () => {
  const dir = makeDir()
  try {
    // Four simultaneous single-image writes with the same prefix and size: the
    // directory queue serialises probe-then-write, so the four results must
    // carry four distinct indices and all four files must exist.
    const runs = await Promise.all(
      Array.from({ length: 4 }, () =>
        writeImages(dir, 'qwen', 1248, 1248, [{ bytes: new Uint8Array([137, 80]), mime: 'image/png' }])),
    )
    const indices = runs.flat().map((written) => written.index).sort((a, b) => a - b)
    assert.deepEqual(indices, [1, 2, 3, 4], 'each concurrent call must claim its own free index')
    for (const written of runs.flat()) assert.ok(existsSync(written.path))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
