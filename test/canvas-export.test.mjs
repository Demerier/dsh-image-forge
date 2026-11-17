/**
 * C15 canvas exports, pure half.
 *
 * The contact sheet's grid arithmetic, the 200-item cap, the label rule, the
 * board-JSON serialisation and the download filename are asserted here; the
 * canvas drawing and the Blob download are the browser layer (studio-view),
 * which this repository does not automate (CANVAS-DESIGN §14.5).
 *
 * Also guards the server half of DD12: a subset layout save must not move the
 * entries it did not name (the store already behaves that way; this is the
 * explicit assertion §9.4 asks for).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONTACT_SHEET_LABEL_HEIGHT,
  CONTACT_SHEET_MAX_ITEMS,
  CONTACT_SHEET_PADDING,
  boardJsonFileName,
  contactSheetLabel,
  contactSheetLayout,
  pictureItems,
  serializeBoardDetail,
} from '../src/canvas-export.ts'
import { readBoard, recordItems, saveLayout } from '../testlib/boards.js'

/** One picture source for layout tests. */
function source(id, width = 1024, height = 1024, prompt = '一只橘猫') {
  return { id, path: 'C:/out/' + id + '.png', markdownPath: 'C:/out/' + id + '.png', width, height, prompt }
}

/** One board item for the server-side subset test. */
function item(dir, name) {
  const path = join(dir, name + '.png')
  return {
    path,
    markdownPath: path.replace(/\\/g, '/'),
    width: 1024,
    height: 1024,
    bytes: 1024,
    mediaType: 'image/png',
    prompt: '画一只' + name,
    ratio: '1:1',
    steps: 8,
    seed: 1,
    mode: 'generate',
    backend: 'studio',
  }
}

test('a contact sheet is a row-major grid of 256px cells with prompt labels', () => {
  const plan = contactSheetLayout([source('a'), source('b'), source('c'), source('d'), source('e')], 4, 256)
  assert.equal(plan.cols, 4)
  assert.equal(plan.rows, 2)
  assert.equal(plan.slots.length, 5)

  // Row-major placement: cell 0 at the padding origin, cell 1 one pitch right.
  const pitch = 256 + 16
  assert.deepEqual(
    plan.slots.slice(0, 2).map((slot) => ({ x: slot.x, y: slot.y })),
    [{ x: CONTACT_SHEET_PADDING, y: CONTACT_SHEET_PADDING }, { x: CONTACT_SHEET_PADDING + pitch, y: CONTACT_SHEET_PADDING }],
  )
  // The fifth wraps to the second row, and the label sits under its cell.
  assert.equal(plan.slots[4].x, CONTACT_SHEET_PADDING)
  assert.equal(plan.slots[4].y, CONTACT_SHEET_PADDING + 256 + CONTACT_SHEET_LABEL_HEIGHT + 16)
  assert.equal(plan.slots[0].labelY, CONTACT_SHEET_PADDING + 256 + 8)

  // Canvas size covers every cell, label strip, gap and the outer padding.
  assert.equal(plan.width, CONTACT_SHEET_PADDING * 2 + 4 * 256 + 3 * 16)
  assert.equal(plan.height, CONTACT_SHEET_PADDING * 2 + 2 * (256 + CONTACT_SHEET_LABEL_HEIGHT) + 16)
  assert.equal(plan.truncated, false)
})

test('thumbnails are aspect-fitted into their cells, never stretched', () => {
  const plan = contactSheetLayout([
    source('wide', 1024, 512),
    source('tall', 512, 1024),
    source('square', 1024, 1024),
  ], 3, 256)
  const [wide, tall, square] = plan.slots
  assert.deepEqual([wide.imageWidth, wide.imageHeight], [256, 128], '16:9-ish fits the cell width')
  assert.equal(wide.imageY, wide.y + 64, 'and is centred vertically')
  assert.deepEqual([tall.imageWidth, tall.imageHeight], [128, 256])
  assert.equal(tall.imageX, tall.x + 64)
  assert.deepEqual([square.imageWidth, square.imageHeight], [256, 256])

  // A corrupt size still produces a placeholder cell instead of NaN geometry.
  const broken = contactSheetLayout([source('broken', Number.NaN, 0)], 1, 256).slots[0]
  assert.ok(Number.isFinite(broken.imageWidth) && broken.imageWidth > 0)
})

test('the sheet is capped at 200 pictures, and clamps its columns and cell size', () => {
  const many = Array.from({ length: CONTACT_SHEET_MAX_ITEMS + 7 }, (unused, index) => source('i' + String(index)))
  const capped = contactSheetLayout(many, 4, 256)
  assert.equal(capped.slots.length, CONTACT_SHEET_MAX_ITEMS)
  assert.equal(capped.truncated, true)

  const clampedCols = contactSheetLayout([source('a')], 99, 256)
  assert.equal(clampedCols.cols, 10, 'columns clamp to 1–10')
  const clampedCell = contactSheetLayout([source('a')], 1, 4000)
  assert.equal(clampedCell.thumbSize, 256, 'the cell never exceeds the 256 px budget')
  const floorCell = contactSheetLayout([source('a')], 1, 1)
  assert.equal(floorCell.thumbSize, 64, 'and never collapses below 64 px')

  // Empty is a zero-sized plan, not a 1-cell sheet with an undefined slot.
  assert.deepEqual(contactSheetLayout([]), { slots: [], width: 0, height: 0, cols: 4, rows: 0, thumbSize: 256, truncated: false })
})

test('labels are the prompt first line, and file-less nodes never reach a sheet', () => {
  assert.equal(contactSheetLabel('一只橘猫坐在窗台上\n第二行不显示'), '一只橘猫坐在窗台上')
  assert.equal(contactSheetLabel('   '), '（无提示词）')
  assert.equal(contactSheetLabel('第一行\r\n第二行'), '第一行')

  const items = [
    { id: 'i1', kind: 'image', markdownPath: 'a.png', prompt: 'p' },
    { id: 't1', kind: 'task', markdownPath: '', prompt: '' },
    { id: 'l1', kind: 'layout', markdownPath: '', prompt: '' },
    { id: 'i2', markdownPath: 'b.png', prompt: 'q' },
  ]
  assert.deepEqual(pictureItems(items).map((entry) => entry.id), ['i1', 'i2'], 'task/layout nodes have no picture')
})

test('a board downloads as pretty JSON under a filesystem-safe name', () => {
  const detail = {
    id: 'b1',
    name: '海报 / 第一版',
    itemCount: 1,
    cover: null,
    createdAt: '2026-11-17T00:00:00.000Z',
    updatedAt: '2026-11-17T00:00:00.000Z',
    sessionId: null,
    camera: { x: 1, y: 2, zoom: 1 },
    items: [{ id: 'i1', kind: 'layout', draft: { width: 1536, height: 1024, items: [] } }],
  }
  const text = serializeBoardDetail(detail)
  const parsed = JSON.parse(text)
  assert.deepEqual(parsed, detail, 'the export is the live board, v2 fields included')
  assert.ok(text.includes('\n  "items"'), 'pretty-printed for a human to diff')

  assert.equal(boardJsonFileName('海报 / 第一版'), '海报 - 第一版.board.json')
  assert.equal(boardJsonFileName('a:b*c?d'), 'a-b-c-d.board.json')
  assert.equal(boardJsonFileName('   '), 'board.board.json')
})

test('a subset layout save leaves unnamed entries exactly where they were', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-c15-'))
  try {
    const created = await recordItems(dir, undefined, [item(dir, 'a'), item(dir, 'b')])
    const [first, second] = created.items
    // DD12: the panel only sends the dirty ids; the store must merge them.
    await saveLayout(dir, created.board.id, { items: [{ id: first.id, x: 700, y: 900 }] })
    const board = await readBoard(dir, created.board.id)
    const after = new Map(board.items.map((entry) => [entry.id, entry]))
    assert.equal(after.get(first.id).x, 700)
    assert.equal(after.get(first.id).y, 900)
    assert.equal(after.get(second.id).x, second.x, 'the untouched entry kept its coordinates')
    assert.equal(after.get(second.id).y, second.y)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})