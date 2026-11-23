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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activeBoardId,
  boardsRoot,
  copyItem,
  createBoard,
  defaultBoardName,
  duplicateBoard,
  duplicateBoardName,
  moveItem,
  deleteBoard,
  listAssets,
  listBoards,
  nameFromPrompt,
  readBoard,
  recordItems,
  removeBoard,
  removeItem,
  renameBoard,
  saveLayout,
  saveLayoutItem,
  saveTaskItem,
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
    // Pitch X is 516 = MAX_NODE_WIDTH(480) + 36 (DD16): a node is as wide as its
    // picture's aspect ratio allows, so the grid has to clear the widest one.
    // Pitch Y (276) and the origin (40) are unchanged; so is the 3-column rule.
    assert.deepEqual(created.items.map((entry) => [entry.x, entry.y]), [
      [40, 40],
      [556, 40],
      [1072, 40],
      [40, 316],
    ])
    const xs = created.items.slice(0, 3).map((entry) => entry.x)
    assert.ok(xs[1] - xs[0] >= 480 + 36, 'the pitch must clear the widest node, not just the default box')
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

/* -------------------------------------------------------------------------- */
/* U07 — 复制项目 / 项目体积 / 删除的两口径                                    */
/* -------------------------------------------------------------------------- */

test('U07: duplicating a board copies entries, coords and lineage, never the files', async () => {
  const dir = makeDir()
  try {
    const created = await recordItems(dir, undefined, [item(dir, 'a'), item(dir, 'b')], { prompt: '原项目' })
    const [first, second] = created.items
    await saveLayout(dir, created.board.id, {
      items: [
        { id: first.id, x: 120, y: 240 },
        { id: second.id, x: 700, y: 260, parents: [first.id] },
      ],
      camera: { x: 12, y: 34, zoom: 1.5 },
    })
    // A third entry whose parent is not on this board at all (a cross-board id).
    await recordItems(dir, created.board.id, [item(dir, 'c', { parents: ['ifromanotherboard'] })])
    const before = (await readBoard(dir, created.board.id)).items
    // Nothing but the metadata may be written: the picture list is the control.
    const picturesBefore = readdirSync(dir).filter((name) => name.endsWith('.png'))

    const copy = await duplicateBoard(dir, created.board.id)
    assert.equal(copy.board.name, '原项目 副本', 'the default name says 副本')
    assert.notEqual(copy.board.id, created.board.id, 'a copy is a new board')
    assert.equal(copy.items.length, 3, '条目数一致')
    assert.equal(copy.board.itemCount, 3)
    assert.equal(copy.board.imageCount, 3, 'photos only — a task/layout node would not count')
    assert.equal(copy.board.bytes, 3 * 1024, 'the size is the sum of the item bytes')

    // Same files, by path: the pictures are shared, not copied (§5.3).
    assert.deepEqual(
      copy.items.map((entry) => entry.path).sort(),
      before.map((entry) => entry.path).sort(),
      '条目共用同一 path',
    )
    // Coordinates and provenance travel with the item; only identity is fresh.
    const copiedA = copy.items.find((entry) => entry.path.endsWith('a.png'))
    const copiedB = copy.items.find((entry) => entry.path.endsWith('b.png'))
    const copiedC = copy.items.find((entry) => entry.path.endsWith('c.png'))
    assert.deepEqual({ x: copiedA.x, y: copiedA.y }, { x: 120, y: 240 }, '坐标照抄')
    assert.deepEqual({ x: copiedB.x, y: copiedB.y }, { x: 700, y: 260 })
    assert.equal(copiedA.prompt, first.prompt)
    assert.equal(copiedA.createdAt, first.createdAt)
    // Lineage points at the copy's own ids, not the original board's.
    assert.deepEqual(copiedB.parents, [copiedA.id], '板内父 id 重映射到新板的条目 id')
    assert.notEqual(copiedA.id, first.id)
    assert.equal(new Set(copy.items.map((entry) => entry.id)).size, 3, 'every copied id is distinct')
    // A parent from another board cannot be resolved here, so it is dropped and counted.
    assert.deepEqual(copiedC.parents, [])
    assert.equal(copy.droppedParents, 1, '跨板父 id 被丢弃并计数')

    // The camera came along, and the original board is untouched.
    const detail = await readBoard(dir, copy.board.id)
    assert.deepEqual(detail.camera, { x: 12, y: 34, zoom: 1.5 })
    const untouched = (await readBoard(dir, created.board.id)).items
    assert.deepEqual(untouched.map((entry) => entry.id), before.map((entry) => entry.id), '原板不变')
    assert.deepEqual(
      untouched.find((entry) => entry.id === second.id).parents,
      [first.id],
      'the original lineage still points at the original ids',
    )
    // And no PNG was written: the copy shares the originals' files.
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith('.png')),
      picturesBefore,
      '复制不复制图片字节',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('U07: a copy can be named, and its default name always fits the cap', async () => {
  const dir = makeDir()
  try {
    const created = await recordItems(dir, undefined, [item(dir, 'n1')], { prompt: '命名' })
    const named = await duplicateBoard(dir, created.board.id, '  我的副本  ')
    assert.equal(named.board.name, '我的副本')
    assert.equal(await duplicateBoard(dir, 'bnosuchboard'), undefined, 'a missing source is not a copy')

    assert.equal(duplicateBoardName('海报'), '海报 副本')
    assert.equal(duplicateBoardName('   '), '画板 副本')
    // The suffix counts against the 40-char cap, so a name AT the cap loses
    // characters from the front rather than its 副本.
    const label = duplicateBoardName('字'.repeat(40))
    assert.equal([...label].length, 40)
    assert.ok(label.endsWith(' 副本'), 'the suffix survives the cap')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('U07: deleting a project keeps its pictures unless the second mode is chosen', async () => {
  const dir = makeDir()
  try {
    writeFileSync(join(dir, 'one.png'), 'png')
    writeFileSync(join(dir, 'two.png'), 'png')
    const created = await recordItems(dir, undefined, [
      item(dir, 'one', { path: join(dir, 'one.png'), markdownPath: join(dir, 'one.png') }),
      item(dir, 'two', { path: join(dir, 'two.png'), markdownPath: join(dir, 'two.png') }),
    ], { prompt: '要删的项目' })
    assert.deepEqual(
      { bytes: created.board.bytes, imageCount: created.board.imageCount },
      { bytes: 2048, imageCount: 2 },
      'the card and the confirmation read the same two numbers',
    )

    // 口径一：只删项目。目录里的 PNG 一律不动（既有行为不回归）。
    const kept = await removeBoard(dir, created.board.id)
    assert.deepEqual(kept, { removed: true, filesDeleted: 0, filesKept: 0 })
    assert.equal(await readBoard(dir, created.board.id), undefined)
    assert.ok(existsSync(join(dir, 'one.png')), '只删项目时文件仍在')
    assert.ok(existsSync(join(dir, 'two.png')))

    // 口径二：连图片一起删。同一个板重新录一遍，然后整板删掉文件。
    const again = await recordItems(dir, '要删的项目', [
      item(dir, 'one', { path: join(dir, 'one.png'), markdownPath: join(dir, 'one.png') }),
      item(dir, 'two', { path: join(dir, 'two.png'), markdownPath: join(dir, 'two.png') }),
    ])
    const swept = await removeBoard(dir, again.board.id, { deleteFiles: true })
    assert.deepEqual(swept, { removed: true, filesDeleted: 2, filesKept: 0 })
    assert.equal(existsSync(join(dir, 'one.png')), false)
    assert.equal(existsSync(join(dir, 'two.png')), false)
    // A board that is gone stays gone; a second sweep reports nothing done.
    assert.deepEqual(await removeBoard(dir, again.board.id, { deleteFiles: true }), {
      removed: false,
      filesDeleted: 0,
      filesKept: 0,
    })
    // The boolean convenience still answers the old question.
    assert.equal(await deleteBoard(dir, '../../escaped'), false, 'a crafted id is refused, not followed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('U07: a picture another project still uses survives a delete-with-files', async () => {
  const dir = makeDir()
  try {
    const sharedPath = join(dir, 'shared.png')
    writeFileSync(sharedPath, 'png')
    const source = await recordItems(dir, undefined, [
      item(dir, 'shared', { path: sharedPath, markdownPath: sharedPath }),
    ], { prompt: '原件' })
    const copy = await duplicateBoard(dir, source.board.id)

    const swept = await removeBoard(dir, source.board.id, { deleteFiles: true })
    assert.deepEqual(
      swept,
      { removed: true, filesDeleted: 0, filesKept: 1 },
      'the shared-reference guard keeps the file and says so',
    )
    assert.ok(existsSync(sharedPath), 'the copy would otherwise lose its picture')

    // The last board referencing it may take it with it.
    assert.deepEqual(
      await removeBoard(dir, copy.board.id, { deleteFiles: true }),
      { removed: true, filesDeleted: 1, filesKept: 0 },
    )
    assert.equal(existsSync(sharedPath), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('U07: a delete-with-files never touches a path outside the output directory', async () => {
  const dir = makeDir()
  const outside = makeDir()
  try {
    const outsidePath = join(outside, 'secret.png')
    writeFileSync(outsidePath, 'png')
    const created = await recordItems(dir, undefined, [
      item(dir, 'outside', { path: outsidePath, markdownPath: outsidePath }),
    ])
    const result = await removeBoard(dir, created.board.id, { deleteFiles: true })
    assert.deepEqual(result, { removed: true, filesDeleted: 0, filesKept: 0 })
    assert.ok(existsSync(outsidePath), 'a crafted board file must not delete outside outputDir')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
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

test('copying an item to another board shares the file but not the id', async () => {
  const dir = makeDir()
  try {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'shared.png')
    writeFileSync(path, 'png')
    const source = await recordItems(dir, undefined, [
      item(dir, 'shared', { path, markdownPath: path, parents: ['i-parent'] }),
    ])
    const target = await createBoard(dir, '目标板')
    const copied = await copyItem(dir, source.board.id, source.items[0].id, target.id)
    assert.ok(copied !== undefined)
    assert.notEqual(copied.item.id, source.items[0].id, 'the copy gets a board-scoped id of its own')
    assert.equal(copied.item.path, path, 'the two boards share the one PNG')
    assert.deepEqual(copied.item.parents, ['i-parent'], 'lineage travels with the picture')

    const sourceAfter = await readBoard(dir, source.board.id)
    assert.equal(sourceAfter.items.length, 1, 'the source board is untouched')
    const targetAfter = await readBoard(dir, target.id)
    assert.deepEqual(targetAfter.items.map((entry) => entry.path), [path])

    // A destination placement is respected; an omitted one uses the target grid.
    const placed = await copyItem(dir, source.board.id, source.items[0].id, target.id, { x: 500, y: 12 })
    assert.equal(placed.item.x, 500)
    assert.equal(placed.item.y, 12)
    // Unknown source/item/target are refusals, not partial writes.
    assert.equal(await copyItem(dir, source.board.id, 'imissing', target.id), undefined)
    assert.equal(await copyItem(dir, 'bmissing', source.items[0].id, target.id), undefined)
    assert.equal(await copyItem(dir, source.board.id, source.items[0].id, 'bmissing'), undefined)

    // A copy inside one board duplicates the item next to it, new id included.
    const duplicate = await copyItem(dir, source.board.id, source.items[0].id, source.board.id)
    assert.notEqual(duplicate.item.id, source.items[0].id)
    assert.equal((await readBoard(dir, source.board.id)).items.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('moving an item keeps its id and leaves the source board', async () => {
  const dir = makeDir()
  try {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'moving.png')
    writeFileSync(path, 'png')
    const source = await recordItems(dir, undefined, [item(dir, 'moving', { path, markdownPath: path })])
    const target = await createBoard(dir, '目标板')
    const itemId = source.items[0].id

    const moved = await moveItem(dir, source.board.id, itemId, target.id, { x: 77, y: 88 })
    assert.ok(moved !== undefined)
    assert.equal(moved.item.id, itemId, 'ids are board-scoped, so the id survives the move')
    assert.equal(moved.item.x, 77)
    assert.equal(moved.item.y, 88)
    assert.deepEqual((await readBoard(dir, source.board.id)).items, [], 'the source board no longer has it')
    assert.deepEqual((await readBoard(dir, target.id)).items.map((entry) => entry.id), [itemId])
    assert.ok(existsSync(path), 'moving metadata never moves the PNG')

    // Unknown source/item/target are refusals, not partial writes.
    assert.equal(await moveItem(dir, source.board.id, 'imissing', target.id), undefined)
    assert.equal(await moveItem(dir, 'bmissing', itemId, target.id), undefined)
    assert.equal(await moveItem(dir, target.id, itemId, 'bmissing'), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deleting a file another board shares is refused, and the item still leaves', async () => {
  const dir = makeDir()
  try {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'keep.png')
    writeFileSync(path, 'png')
    const source = await recordItems(dir, undefined, [item(dir, 'keep', { path, markdownPath: path })])
    const target = await createBoard(dir, '目标板')
    await copyItem(dir, source.board.id, source.items[0].id, target.id)

    const removed = await removeItem(dir, source.board.id, source.items[0].id, { deleteFile: true })
    assert.equal(removed.fileDeleted, false, 'a shared PNG must not be deleted')
    assert.deepEqual(removed.sharedWith, [target.id], 'the refusal names the board that still points at it')
    assert.ok(existsSync(path), 'the file is still on disk for the other board')
    assert.deepEqual((await readBoard(dir, source.board.id)).items, [], 'the item still leaves the board')

    // Once the last sharer is dropped, the opt-in delete goes through.
    const targetItems = (await readBoard(dir, target.id)).items
    const last = await removeItem(dir, target.id, targetItems[0].id, { deleteFile: true })
    assert.equal(last.fileDeleted, true)
    assert.deepEqual(last.sharedWith, [])
    assert.equal(existsSync(path), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a terminal task node is stored as a v2 entry and updated in place', async () => {
  const dir = makeDir()
  try {
    const first = await recordItems(dir, undefined, [item(dir, 'keep')], { prompt: '画板' })
    const params = { prompt: '一只橘猫', ratio: '3:2', steps: 25, count: 1, layout: '{"summary":{"caption":"x"}}' }
    const failed = { status: 'failed', error: 'CUDA out of memory\nTraceback (most recent call last): ...', params }
    const written = await saveTaskItem(dir, first.board.id, { id: 'ctask1', x: 120, y: 40, parents: [], task: failed })
    assert.equal(written.item.id, 'ctask1', 'the canvas id is honoured on the first write')
    assert.equal(written.item.kind, 'task')
    assert.equal(written.item.task.status, 'failed')
    assert.equal(written.item.path, '', 'a task node has no file behind it')

    const reread = await readBoard(dir, first.board.id)
    const stored = reread.items.find((entry) => entry.id === 'ctask1')
    assert.deepEqual(stored.task.params, params, 'the retry snapshot survives the round trip')

    // Re-saving the same id updates one entry and keeps its creation time.
    const again = await saveTaskItem(dir, first.board.id, {
      id: 'ctask1',
      x: 200,
      y: 8,
      parents: ['ilayout1'],
      task: { ...failed, status: 'interrupted' },
    })
    assert.equal(again.item.id, 'ctask1')
    assert.equal(again.item.createdAt, stored.createdAt)
    assert.equal(again.item.task.status, 'interrupted')
    assert.deepEqual(again.item.parents, ['ilayout1'])
    assert.equal((await readBoard(dir, first.board.id)).items.filter((entry) => entry.id === 'ctask1').length, 1)

    // Running states are refused: only a terminal task may be bookkeeping (DD6).
    await assert.rejects(
      () => saveTaskItem(dir, first.board.id, { task: { status: 'running', params } }),
      /failed 或 interrupted/,
    )
    // A blank ref means "the canvas had no board yet": create one rather than lose the retry.
    const fresh = await saveTaskItem(dir, undefined, { task: failed })
    assert.equal(fresh.board.itemCount, 1)
    assert.equal(fresh.created ?? true, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a layout node stores its draft and display box, and resizing keeps the draft', async () => {
  const dir = makeDir()
  try {
    const draft = {
      width: 1536,
      height: 1024,
      bbox_coord_space: 'abs',
      bbox_format: 'xyxy',
      summary: { caption: '黄昏的山谷' },
      items: [{ label: 'object', caption: '山', bbox: [0, 0, 100, 100] }],
    }
    const written = await saveLayoutItem(dir, undefined, { id: 'ilayout1', x: 30, y: 60, parents: [], draft, w: 480, h: 420 })
    assert.equal(written.item.kind, 'layout')
    assert.equal(written.item.id, 'ilayout1')
    assert.deepEqual(written.item.draft, draft, 'the draft is stored verbatim')
    assert.equal(written.item.w, 480)

    // §8.2: a resize changes the display box only; the draft — what later
    // compiles — is byte-identical.
    const resized = await saveLayoutItem(dir, written.board.id, { id: 'ilayout1', draft, w: 900, h: 700 })
    assert.equal(resized.item.w, 900)
    assert.equal(resized.item.h, 700)
    assert.deepEqual(resized.item.draft, draft)

    await assert.rejects(() => saveLayoutItem(dir, written.board.id, { draft, w: 0, h: 10 }), /正数/)
    await assert.rejects(
      () => saveLayoutItem(dir, written.board.id, { draft: { ...draft, items: 'nope' }, w: 480, h: 420 }),
      /items/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('non-picture nodes never become the board cover or an asset card', async () => {
  const dir = makeDir()
  try {
    const picture = await recordItems(dir, undefined, [item(dir, 'cover')])
    const draft = {
      width: 1536,
      height: 1024,
      bbox_coord_space: 'abs',
      bbox_format: 'xyxy',
      summary: { caption: '黄昏' },
      items: [],
    }
    await saveTaskItem(dir, picture.board.id, { task: { status: 'failed', params: { prompt: '失败的那次' } } })
    await saveLayoutItem(dir, picture.board.id, { draft, w: 480, h: 420 })

    const boards = await listBoards(dir)
    assert.equal(boards[0].cover, picture.items[0].markdownPath, 'the cover stays the newest picture')
    const assets = await listAssets(dir, {})
    assert.deepEqual(assets.assets.map((entry) => entry.id), [picture.items[0].id], 'only pictures are assets')

    // A file-less node removed with deleteFile: true must be an unplace, not a crash.
    const board = await readBoard(dir, picture.board.id)
    const taskItem = board.items.find((entry) => entry.kind === 'task')
    const removed = await removeItem(dir, picture.board.id, taskItem.id, { deleteFile: true })
    assert.equal(removed.fileDeleted, false)
    assert.deepEqual(removed.sharedWith, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a stored layout node keeps its box names and its references', async () => {
  // Two fields were lost on restart: an editor box name was stripped from the
  // draft, and the pictures wired into a layout were never stored at all. Both
  // now ride in the board entry — the name in the draft, the references as item
  // ids, because a reference is a pointer to a picture that already exists.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-forge-layout-persist-'))
  try {
    const draft = {
      width: 1024, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy',
      summary: { caption: 'poster' },
      items: [{ label: 'object', caption: 'cup', name: '杯子', bbox: [0, 0, 400, 400] }],
    }
    const written = await saveLayoutItem(dir, undefined, {
      draft, w: 480, h: 420, x: 0, y: 0, references: ['img-1'],
    })
    assert.ok(written !== undefined)
    const item = written.item
    assert.equal(item.draft.items[0].name, '杯子', 'the box name survives the store')
    assert.deepEqual(item.references, ['img-1'], 'the reference ids survive the store')
    // The read side hands the same values back after a reload.
    const board = await readBoard(dir, written.board.id)
    const reloaded = board.items.find((entry) => entry.id === item.id)
    assert.equal(reloaded.draft.items[0].name, '杯子')
    assert.deepEqual(reloaded.references, ['img-1'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})