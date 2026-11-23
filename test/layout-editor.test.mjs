/**
 * MOSS layout editor contract tests.
 *
 * The authority is not this file: it is the reference compiler shipped with the
 * model (refs/MOSS-Image/skills/moss-image-prompt-enhancer/scripts/compile_prompt.py)
 * and the draft/compiled pairs kept under verify/. Two of those pairs (fantasy
 * dawn wide + symmetry) came from real 2048x864 / 1792x1024 generations, and the
 * chained titan series carries a repeated caption sentence that must survive
 * editing item by item. So every assertion here regresses the module against the
 * samples field by field rather than against hand-written expectations.
 *
 * What is pinned:
 *
 * 1. draft sample -> editor state -> draft export is lossless per field;
 * 2. draft -> compiled reproduces each verify compiled sample exactly (per field
 *    and, for the prompt text, byte for byte modulo the file's line ending);
 * 3. the compiled order is yxyx - positional, not sorted. The wide sample proves
 *    it: its first box starts [68, -1024, ...], so y1 > x1 there. Reading [0] as
 *    an x coordinate would silently mirror every box.
 * 4. draft -> compiled -> draft round-trips exactly for the integer boxes the
 *    editor produces (fractional hand-edited edges are enclosed, as documented);
 * 5. empty layouts and malformed drafts are rejected before they reach a prompt;
 * 6. clamping/rounding keep drawn boxes exportable, and the fractional enclosure
 *    matches the reference compiler's own unit-test values;
 * 7. duplicate caption wording is preserved item by item (the samples do not
 *    dedupe, merge or renumber captions).
 *
 * The DOM mount is deliberately not exercised: this repository has no browser
 * test harness, and a fake DOM would mostly assert that the fake DOM works. The
 * mount is covered by type-checking-free import here and by the Studio wiring
 * task; everything it calls is pure and tested above.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  CAPTION_HINT,
  DEFAULT_LAYOUT_HEIGHT,
  DEFAULT_LAYOUT_WIDTH,
  LAYOUT_COMPILED_BBOX_COORD_SPACE,
  LAYOUT_COMPILED_BBOX_FORMAT,
  LAYOUT_DRAFT_BBOX_COORD_SPACE,
  LAYOUT_DRAFT_BBOX_FORMAT,
  LAYOUT_CANVAS_MULTIPLE,
  LAYOUT_CANVAS_PRESETS,
  LAYOUT_NODE_CHROME,
  LAYOUT_NODE_DEFAULT_WIDTH,
  LAYOUT_NODE_MAX_WIDTH,
  LAYOUT_NODE_MIN_WIDTH,
  LAYOUT_TEMPLATES,
  LayoutEditorError,
  addBox,
  boxFromDrag,
  canvasBoxToDisplay,
  canvasToDisplay,
  clampBox,
  clampLayoutNodeWidth,
  compileLayout,
  createLayoutState,
  decompileLayout,
  deleteBox,
  draftToEditorState,
  draftToState,
  exportCompiled,
  exportDraft,
  formatDraft,
  fromCompiledBox,
  getLayoutItem,
  layoutNodeHeight,
  moveBox,
  parseDraft,
  pointToCanvas,
  resizeBox,
  roundBox,
  screenDeltaToDraft,
  selectBox,
  selectMany,
  setBoxCaption,
  setBoxLabel,
  setBoxName,
  setCanvasSize,
  setSelectedCaption,
  setSelectedLabel,
  setSummary,
  toggleSelection,
  stateToDraft,
  toCompiledBox,
  updateBox,
  validateCompiledLayout,
  validateLayoutDraft,
} from '../src/layout-editor.ts'

/** Draft/compiled sample pairs: [compiled, draft]. */
const PAIRS = [
  ['fantasy_dawn_layout_wide', 'fantasy_dawn_layout_wide_draft'],
  ['fantasy_dawn_layout_wide_v2', 'fantasy_dawn_layout_wide_v2_draft'],
  ['fantasy_dawn_layout_symmetry', 'fantasy_dawn_layout_symmetry_draft'],
  ['fantasy_dawn_layout_symmetry_v2', 'fantasy_dawn_layout_symmetry_v2_draft'],
  ['chained_titan_layout', 'chained_titan_draft'],
  ['chained_titan_v2_layout', 'chained_titan_v2_draft'],
  ['chained_titan_v3_layout', 'chained_titan_v3_draft'],
  ['chained_titan_v4_layout', 'chained_titan_v4_draft'],
]

function verifyUrl(name) {
  return new URL('../verify/' + name + '.json', import.meta.url)
}

function readSampleText(name) {
  return readFileSync(verifyUrl(name), 'utf8')
}

function readSample(name) {
  return JSON.parse(readSampleText(name))
}

/** Compare file content as text regardless of the checkout's line endings. */
function withoutFileEol(text) {
  return text.replace(/\r\n/g, '\n').trimEnd()
}

test('every draft sample imports into the editor and exports back field for field', () => {
  for (const [, draftName] of PAIRS) {
    const draft = readSample(draftName)
    assert.deepEqual(validateLayoutDraft(draft), [], draftName + ' must be a valid draft')

    const state = draftToState(draft)
    const exported = stateToDraft(state)

    assert.deepEqual(Object.keys(exported), ['width', 'height', 'bbox_coord_space', 'bbox_format', 'summary', 'items'], draftName + ' root fields')
    assert.equal(exported.width, draft.width, draftName + ' width')
    assert.equal(exported.height, draft.height, draftName + ' height')
    assert.equal(exported.bbox_coord_space, LAYOUT_DRAFT_BBOX_COORD_SPACE)
    assert.equal(exported.bbox_format, LAYOUT_DRAFT_BBOX_FORMAT)
    assert.deepEqual(exported.summary, draft.summary, draftName + ' summary')
    assert.equal(exported.items.length, draft.items.length, draftName + ' item count')
    exported.items.forEach((item, index) => {
      const expected = draft.items[index]
      assert.deepEqual(Object.keys(item), Object.keys(expected), draftName + ' item ' + index + ' fields')
      assert.equal(item.label, expected.label, draftName + ' item ' + index + ' label')
      assert.equal(item.caption, expected.caption, draftName + ' item ' + index + ' caption')
      assert.deepEqual(item.bbox, expected.bbox, draftName + ' item ' + index + ' bbox')
      assert.equal(item.text, expected.text, draftName + ' item ' + index + ' text')
      assert.deepEqual(item.tags, expected.tags, draftName + ' item ' + index + ' tags')
      assert.deepEqual(item.palette, expected.palette, draftName + ' item ' + index + ' palette')
    })
    assert.deepEqual(exported, draft, draftName + ' must round-trip through the editor losslessly')

    // Editor-only ids must never leak into a draft.
    for (const item of state.items) {
      assert.ok(typeof item.id === 'string' && item.id.length > 0)
      assert.equal('id' in exported.items[state.items.indexOf(item)], false)
    }
  }
})

test('compiled export reproduces every verify sample per field and byte for byte', () => {
  for (const [compiledName, draftName] of PAIRS) {
    const draft = readSample(draftName)
    const sample = readSample(compiledName)
    const text = compileLayout(stateToDraft(draftToState(draft)))
    const compiled = JSON.parse(text)

    assert.deepEqual(Object.keys(compiled), ['summary', 'items', 'bbox_coord_space', 'bbox_format'], compiledName + ' root fields')
    assert.equal(compiled.bbox_coord_space, LAYOUT_COMPILED_BBOX_COORD_SPACE)
    assert.equal(compiled.bbox_format, LAYOUT_COMPILED_BBOX_FORMAT)
    // width/height describe the draft canvas and are inferred from the generation
    // size at compile time, so they must not appear in the prompt.
    assert.equal('width' in compiled, false, compiledName + ' must not carry width')
    assert.equal('height' in compiled, false, compiledName + ' must not carry height')

    assert.deepEqual(compiled.summary, sample.summary, compiledName + ' summary')
    compiled.items.forEach((item, index) => {
      const expected = sample.items[index]
      assert.deepEqual(Object.keys(item), Object.keys(expected), compiledName + ' item ' + index + ' fields')
      assert.equal(item.label, expected.label, compiledName + ' item ' + index + ' label')
      assert.equal(item.caption, expected.caption, compiledName + ' item ' + index + ' caption')
      assert.deepEqual(item.bbox, expected.bbox, compiledName + ' item ' + index + ' bbox')
      assert.equal('width' in item, false)
      assert.equal('height' in item, false)
    })
    assert.deepEqual(compiled, sample, compiledName + ' must match every field of the sample')
    assert.equal(text, withoutFileEol(readSampleText(compiledName)), compiledName + ' differs from the sample prompt text')
    assert.equal(text.includes('\n'), false, 'the compiled prompt is one compact JSON line')
  }
})

test('compiled boxes are yxyx with a centered origin - positional, not sorted', () => {
  let yBeforeX = 0
  let xBeforeY = 0
  for (const [compiledName, draftName] of PAIRS) {
    const draft = readSample(draftName)
    const sample = readSample(compiledName)
    const halfWidth = draft.width / 2
    const halfHeight = draft.height / 2
    sample.items.forEach((item, index) => {
      const source = draft.items[index].bbox
      const expected = [
        source[1] - halfHeight,
        source[0] - halfWidth,
        source[3] - halfHeight,
        source[2] - halfWidth,
      ]
      assert.deepEqual(item.bbox, expected, compiledName + ' item ' + index + ' must be [y1,x1,y2,x2]')
      assert.ok(item.bbox[0] < item.bbox[2], 'positive y span')
      assert.ok(item.bbox[1] < item.bbox[3], 'positive x span')
      if (item.bbox[0] < item.bbox[1]) yBeforeX += 1
      if (item.bbox[0] > item.bbox[1]) xBeforeY += 1
    })
  }
  assert.ok(yBeforeX > 0, 'some samples must have y1 < x1')
  // The wide sample's first box starts at [68, -1024, ...]: y1 > x1. Treating
  // bbox[0] as x would pass a sorted-minimum check but mirror every box.
  assert.ok(xBeforeY > 0, 'some samples must have y1 > x1')
  const wide = readSample('fantasy_dawn_layout_wide')
  assert.deepEqual(wide.items[0].bbox, [68, -1024, 432, -464])
  assert.ok(wide.items[0].bbox[0] > wide.items[0].bbox[1])
})

test('draft -> state -> compiled -> draft roundtrips losslessly', () => {
  for (const [compiledName, draftName] of PAIRS) {
    const draft = readSample(draftName)
    const state = draftToState(draft)

    const draftText = exportDraft(state)
    assert.ok(draftText.endsWith('\n'), 'draft export ends with a newline')
    assert.deepEqual(JSON.parse(draftText), draft, draftName + ' draft export')

    const compiledText = exportCompiled(state)
    assert.deepEqual(JSON.parse(compiledText), readSample(compiledName))

    const backFromText = decompileLayout(compiledText, draft.width, draft.height)
    assert.deepEqual(backFromText, draft, draftName + ' must survive compiled -> draft')

    const backFromObject = decompileLayout(JSON.parse(compiledText), draft.width, draft.height)
    assert.deepEqual(backFromObject, draft, draftName + ' must survive compiled object -> draft')

    assert.deepEqual(stateToDraft(draftToState(backFromText)), draft)
    assert.equal(formatDraft(backFromText), formatDraft(draft), draftName + ' export formatting is stable')
  }
})

test('the compiled-only prompt sample validates and keeps literal text items', () => {
  const sample = readSample('layout_prompt')
  assert.deepEqual(validateCompiledLayout(sample), [])
  assert.deepEqual(Object.keys(sample), ['summary', 'items', 'bbox_coord_space', 'bbox_format'])
  assert.equal(sample.bbox_coord_space, LAYOUT_COMPILED_BBOX_COORD_SPACE)
  assert.equal(sample.bbox_format, LAYOUT_COMPILED_BBOX_FORMAT)
  assert.equal('width' in sample, false)
  assert.equal('height' in sample, false)

  const textItems = sample.items.filter((item) => item.label === 'text')
  assert.equal(textItems.length, 2, 'the poster sample carries two literal-text items')
  for (const item of textItems) {
    assert.ok(typeof item.text === 'string' && item.text.length > 0, 'text items carry their literal characters')
  }
  // Headline box first: yxyx order, wide and short.
  assert.deepEqual(sample.items[0].bbox, [-340, -560, -230, 560])
  assert.ok(sample.items[0].bbox[1] < sample.items[0].bbox[3])
  assert.deepEqual(fromCompiledBox(sample.items[0].bbox, 1120, 1120), { x1: 0, y1: 220, x2: 1120, y2: 330 })
})

test('an empty layout is rejected before it can reach a prompt', () => {
  const state = createLayoutState({ width: 512, height: 512, summary: { caption: 'A test scene.' } })
  const empty = stateToDraft(state)
  assert.deepEqual(empty.items, [])
  assert.ok(validateLayoutDraft(empty).some((issue) => issue.includes('nonempty')), 'empty items must be reported')
  assert.throws(
    () => compileLayout(empty),
    (error) => error instanceof LayoutEditorError && error.issues.some((issue) => issue.includes('items must be a nonempty')),
  )
  assert.throws(() => exportCompiled(state), LayoutEditorError)

  const withBox = addBox(state, { bbox: { x1: 10, y1: 10, x2: 100, y2: 100 }, caption: 'A rock.' })
  const removed = deleteBox(withBox, withBox.items[0].id)
  assert.throws(() => exportCompiled(removed), LayoutEditorError)

  const missingItems = readSample('chained_titan_draft')
  delete missingItems.items
  assert.ok(validateLayoutDraft(missingItems).some((issue) => issue.includes('missing fields')))
  assert.throws(() => compileLayout(missingItems), LayoutEditorError)
})
test('a new layout node opens with an empty draft (the C13 blank-panel regression)', () => {
  // A freshly created layout node has no boxes yet; mounting it must work even
  // though exporting it is (correctly) refused.
  const state = createLayoutState({ width: 1536, height: 1024, summary: { caption: '' } })
  const emptyDraft = stateToDraft(state)
  assert.deepEqual(emptyDraft.items, [])
  // Strict loader still rejects an empty draft that came from a file…
  assert.throws(() => draftToState(emptyDraft), LayoutEditorError)
  // …but the editor-mount path accepts it and keeps canvas + summary.
  const loaded = draftToEditorState(emptyDraft)
  assert.equal(loaded.width, 1536)
  assert.equal(loaded.height, 1024)
  assert.deepEqual(loaded.items, [])
  assert.equal(loaded.summary.caption, '')
  assert.deepEqual(stateToDraft(loaded), emptyDraft)
  // Any other malformation is still refused: only the empty-items rule is relaxed.
  assert.throws(() => draftToEditorState({ ...emptyDraft, bbox_format: 'xywh' }), LayoutEditorError)
  assert.throws(() => draftToEditorState({ ...emptyDraft, width: 1537 }), LayoutEditorError)
  assert.throws(() => draftToEditorState(null), LayoutEditorError)
})


test('clamping and rounding keep every drawn box exportable', () => {
  const width = 160
  const height = 96
  // Oversized boxes are shrunk to the canvas; out-of-range boxes are shifted.
  assert.deepEqual(clampBox({ x1: -20, y1: -20, x2: 500, y2: 500 }, width, height), {
    x1: 0,
    y1: 0,
    x2: width,
    y2: height,
  })
  assert.deepEqual(clampBox({ x1: 150, y1: 90, x2: 170, y2: 110 }, width, height), {
    x1: 140,
    y1: 76,
    x2: 160,
    y2: 96,
  })
  // Zero-area boxes get the minimum size instead of reaching the compiler.
  assert.deepEqual(clampBox({ x1: 10, y1: 10, x2: 10, y2: 10 }, width, height), { x1: 10, y1: 10, x2: 11, y2: 11 })
  assert.deepEqual(clampBox({ x1: 160, y1: 96, x2: 160, y2: 96 }, width, height), {
    x1: 159,
    y1: 95,
    x2: 160,
    y2: 96,
  })
  assert.throws(() => clampBox({ x1: 0, y1: 0, x2: 10, y2: 10 }, 0, height), LayoutEditorError)

  // Rounding is half-up to whole pixels and never leaks negative zero into JSON.
  assert.deepEqual(roundBox({ x1: 10.4, y1: 20.5, x2: 100.6, y2: 200.5 }), { x1: 10, y1: 21, x2: 101, y2: 201 })
  const roundedNegative = roundBox({ x1: -0.4, y1: -0.49, x2: -0.5, y2: 0.49 })
  assert.ok(Object.is(roundedNegative.x1, 0) && Object.is(roundedNegative.y1, 0) && Object.is(roundedNegative.x2, 0))
  assert.deepEqual(roundedNegative, { x1: 0, y1: 0, x2: 0, y2: 0 })

  // A reversed drag describes the same box, and a click gets the minimum size.
  assert.deepEqual(boxFromDrag({ x: 100, y: 100 }, { x: 20, y: 30 }), { x1: 20, y1: 30, x2: 100, y2: 100 })
  assert.deepEqual(boxFromDrag({ x: 5, y: 5 }, { x: 5, y: 5 }), { x1: 5, y1: 5, x2: 6, y2: 6 })

  // A box added outside the canvas is clamped and still compiles.
  const state = addBox(createLayoutState({ width, height, summary: { caption: 'Clamp test.' } }), {
    bbox: { x1: -40, y1: -40, x2: 900, y2: 900 },
    caption: 'A full-frame wash.',
  })
  assert.deepEqual(state.items[0].bbox, { x1: 0, y1: 0, x2: width, y2: height })
  assert.deepEqual(validateLayoutDraft(stateToDraft(state)), [])
  const compiled = JSON.parse(exportCompiled(state))
  assert.deepEqual(compiled.items[0].bbox, [-48, -80, 48, 80])
})

test('fractional draft edges are enclosed exactly like the reference compiler', () => {
  // Values from the reference compiler's own unit test (centered_box).
  assert.deepEqual(toCompiledBox({ x1: 10.9, y1: 20.1, x2: 100.01, y2: 200.99 }, 768, 1344), [
    -652,
    -374,
    -471,
    -283,
  ])
  assert.deepEqual(toCompiledBox({ x1: 1.00000000001, y1: 2, x2: 100, y2: 200 }, 768, 1344), [
    -670,
    -383,
    -472,
    -284,
  ])
  assert.deepEqual(toCompiledBox({ x1: 0, y1: 0, x2: 768, y2: 1344 }, 768, 1344), [-672, -384, 672, 384])
  // floor left/top and ceil right/bottom: 3.9 encloses to 3, 20.1 to 21.
  assert.deepEqual(toCompiledBox({ x1: 3.9, y1: 3.9, x2: 20.1, y2: 20.1 }, 16, 16), [-5, -5, 13, 13])

  // The inverse is exact for the integer edges the editor produces.
  const box = { x1: 610, y1: 180, x2: 926, y2: 844 }
  assert.deepEqual(fromCompiledBox(toCompiledBox(box, 1536, 1024), 1536, 1024), box)

  // Fractional drafts are legal and keep their fractional values in the draft;
  // only the compiled prompt encloses them.
  const fractional = {
    width: 16,
    height: 16,
    bbox_coord_space: 'abs',
    bbox_format: 'xyxy',
    summary: { caption: 'Fractional edges.' },
    items: [{ label: 'object', caption: 'A speck.', bbox: [0.5, 0.5, 15.5, 15.5] }],
  }
  assert.deepEqual(validateLayoutDraft(fractional), [])
  const compiled = JSON.parse(compileLayout(fractional))
  assert.deepEqual(compiled.items[0].bbox, [-8, -8, 8, 8])
  assert.deepEqual(decompileLayout(compiled, 16, 16).items[0].bbox, [0, 0, 16, 16])
})

test('duplicate caption wording is preserved item by item, not merged', () => {
  const draft = readSample('chained_titan_v4_draft')
  const sampleCompiled = readSample('chained_titan_v4_layout')
  const sentence = 'Two of these chains miss the creature entirely'

  // v4 appends the same sentence to two different item captions on purpose.
  const repeated = draft.items.filter((item) => item.caption.includes(sentence))
  assert.equal(repeated.length, 2, 'the v4 sample repeats one sentence across two items')
  assert.notEqual(repeated[0].caption, repeated[1].caption, 'the captions themselves stay distinct')

  const state = draftToState(draft)
  const exported = stateToDraft(state)
  assert.equal(exported.items.length, draft.items.length, 'duplicate wording must not collapse items')
  draft.items.forEach((item, index) => {
    assert.equal(exported.items[index].caption, item.caption, 'caption ' + index + ' preserved verbatim')
  })

  const compiledText = exportCompiled(state)
  assert.equal(compiledText.split(sentence).length - 1, 2, 'the repeated sentence survives into the prompt twice')
  assert.deepEqual(JSON.parse(compiledText), sampleCompiled)

  // Exactly equal captions are allowed too: the contract does not dedupe.
  let identical = createLayoutState({ width: 512, height: 512, summary: { caption: 'Two boxes.' } })
  identical = addBox(identical, { bbox: { x1: 10, y1: 10, x2: 100, y2: 100 }, caption: 'A pale sun.' })
  identical = addBox(identical, { bbox: { x1: 200, y1: 200, x2: 300, y2: 300 }, caption: 'A pale sun.' })
  const identicalCompiled = JSON.parse(exportCompiled(identical))
  assert.equal(identicalCompiled.items.length, 2)
  assert.equal(identicalCompiled.items[0].caption, identicalCompiled.items[1].caption)
})

test('the editor draws, moves, resizes, captions and deletes in canvas pixels', () => {
  let state = createLayoutState({ width: 512, height: 512, summary: { caption: 'A studio scene.' } })
  state = addBox(state, { bbox: { x1: 10.2, y1: 20.8, x2: 110.4, y2: 220.6 }, label: 'object', caption: 'A rock.' })
  const id = state.items[0].id
  assert.equal(state.selectedId, id)
  assert.deepEqual(state.items[0].bbox, { x1: 10, y1: 21, x2: 110, y2: 221 })

  // Compiles as soon as the summary caption and the item caption exist.
  const compiled = JSON.parse(exportCompiled(state))
  assert.deepEqual(compiled.items[0].bbox, [-235, -246, -35, -146])

  state = moveBox(state, id, 5, -5)
  assert.deepEqual(state.items[0].bbox, { x1: 15, y1: 16, x2: 115, y2: 216 })
  state = moveBox(state, id, 1000, 0)
  assert.deepEqual(state.items[0].bbox, { x1: 412, y1: 16, x2: 512, y2: 216 }, 'moving stops at the edge without resizing')

  state = resizeBox(state, id, 'se', 40, 300)
  assert.deepEqual(state.items[0].bbox, { x1: 412, y1: 16, x2: 512, y2: 512 })
  state = resizeBox(state, id, 'nw', 1000, 1000)
  assert.deepEqual(state.items[0].bbox, { x1: 511, y1: 511, x2: 512, y2: 512 }, 'resizing collapses to the minimum size')

  assert.equal(selectBox(state, null).selectedId, null)
  assert.equal(selectBox(state, 'missing').selectedId, null)
  assert.equal(getLayoutItem(state, id).id, id)

  state = setBoxCaption(state, id, 'A pale sun.')
  assert.equal(state.items[0].caption, 'A pale sun.')
  state = setBoxLabel(state, id, 'character')
  assert.equal(state.items[0].label, 'character')
  state = updateBox(state, id, { tags: ['light'] })
  assert.deepEqual(state.items[0].tags, ['light'])
  assert.equal(updateBox(state, 'missing', { caption: 'nope' }), state)
  assert.equal(deleteBox(state, 'missing'), state)

  // Ids are stable and never reused after a delete.
  state = addBox(state, { bbox: { x1: 0, y1: 0, x2: 10, y2: 10 }, caption: 'Second.' })
  state = addBox(state, { bbox: { x1: 20, y1: 20, x2: 30, y2: 30 }, caption: 'Third.' })
  const idsAfterAdd = state.items.map((item) => item.id)
  assert.deepEqual(idsAfterAdd, ['box-1', 'box-2', 'box-3'])
  state = deleteBox(state, 'box-2')
  state = addBox(state, { bbox: { x1: 40, y1: 40, x2: 50, y2: 50 }, caption: 'Fourth.' })
  assert.deepEqual(state.items.map((item) => item.id), ['box-1', 'box-3', 'box-4'])

  // Summary patches keep the caption and can add the optional contract fields.
  state = setSummary(state, { caption: 'A studio scene, final.', meta: ['test'] })
  assert.equal(state.summary.caption, 'A studio scene, final.')
  assert.deepEqual(state.summary.meta, ['test'])
  assert.deepEqual(validateLayoutDraft(stateToDraft(state)), [])
})

test('the caption hint carries the semantic-pollution rule', () => {
  assert.equal(typeof CAPTION_HINT, 'string')
  for (const keyword of ['污染', '生成语义', 'bbox', 'summary']) {
    assert.ok(CAPTION_HINT.includes(keyword), 'CAPTION_HINT must mention ' + keyword)
  }
})

test('display and canvas coordinates are inverse across the scaled canvas', () => {
  const viewport = { displayWidth: 800, displayHeight: 500, canvasWidth: 1600, canvasHeight: 1000 }
  assert.deepEqual(pointToCanvas({ x: 400, y: 250 }, viewport), { x: 800, y: 500 })
  assert.deepEqual(canvasToDisplay({ x: 800, y: 500 }, viewport), { x: 400, y: 250 })
  for (const point of [{ x: 0, y: 0 }, { x: 37.5, y: 123.25 }, { x: 799, y: 499 }]) {
    const round = canvasToDisplay(pointToCanvas(point, viewport), viewport)
    assert.ok(Math.abs(round.x - point.x) < 1e-9, 'x inverse at ' + point.x)
    assert.ok(Math.abs(round.y - point.y) < 1e-9, 'y inverse at ' + point.y)
  }
  assert.deepEqual(canvasBoxToDisplay({ x1: 0, y1: 0, x2: 1600, y2: 1000 }, viewport), {
    left: 0,
    top: 0,
    width: 800,
    height: 500,
  })
  assert.deepEqual(canvasBoxToDisplay({ x1: 800, y1: 500, x2: 1600, y2: 1000 }, viewport), {
    left: 400,
    top: 250,
    width: 400,
    height: 250,
  })
  assert.deepEqual(pointToCanvas({ x: 10, y: 10 }, { displayWidth: 0, displayHeight: 0, canvasWidth: 1600, canvasHeight: 1000 }), {
    x: 0,
    y: 0,
  })
})

test('invalid drafts are rejected with the reference compiler rules', () => {
  const valid = readSample('chained_titan_draft')
  const clone = () => JSON.parse(JSON.stringify(valid))
  const cases = []

  let bad = clone()
  bad.width = 1023
  cases.push([bad, 'width must be a multiple of 16'])
  bad = clone()
  bad.height = 0
  cases.push([bad, 'height must be positive'])
  bad = clone()
  bad.bbox_coord_space = 'abs_centralized'
  cases.push([bad, 'draft coordinate space is abs'])
  bad = clone()
  bad.bbox_format = 'yxyx'
  cases.push([bad, 'draft bbox format is xyxy'])
  bad = clone()
  bad.items = []
  cases.push([bad, 'items must not be empty'])
  bad = clone()
  bad.font_size = 12
  cases.push([bad, 'unknown root fields are rejected'])
  bad = clone()
  delete bad.summary.caption
  cases.push([bad, 'summary.caption is required'])
  bad = clone()
  bad.summary.caption = '   '
  cases.push([bad, 'summary.caption must be nonempty'])
  bad = clone()
  bad.items[0].label = 'thing'
  cases.push([bad, 'labels are object/character/text'])
  bad = clone()
  bad.items[0].bbox = [0, 0, 0, 100]
  cases.push([bad, 'zero-width boxes are rejected'])
  bad = clone()
  bad.items[0].bbox = [100, 0, 50, 100]
  cases.push([bad, 'reversed boxes are rejected'])
  bad = clone()
  bad.items[0].bbox = [0, 0, 99999, 100]
  cases.push([bad, 'boxes outside the canvas are rejected'])
  bad = clone()
  bad.items[0].caption = ''
  cases.push([bad, 'item captions must be nonempty'])
  bad = clone()
  bad.items[0].font_size = 12
  cases.push([bad, 'unknown item fields are rejected'])
  bad = clone()
  bad.items[0].bbox = [0, 0, 0.00000000001, 100]
  cases.push([bad, 'boxes too small at export precision are rejected'])
  bad = clone()
  bad.items.push({ label: 'text', caption: 'A title.', bbox: [10, 10, 200, 60] })
  cases.push([bad, 'text items require literal text'])

  for (const [value, why] of cases) {
    assert.ok(validateLayoutDraft(value).length > 0, why)
    assert.throws(() => compileLayout(value), LayoutEditorError, why)
  }

  // The compiled side has its own contract: no width/height, y before x.
  const compiled = readSample('chained_titan_layout')
  assert.deepEqual(validateCompiledLayout(compiled), [])
  const badCompiled = JSON.parse(JSON.stringify(compiled))
  badCompiled.bbox_coord_space = 'abs'
  assert.ok(validateCompiledLayout(badCompiled).length > 0, 'compiled coordinate space is abs_centralized')
  const reversedCompiled = JSON.parse(JSON.stringify(compiled))
  reversedCompiled.items[0].bbox = [100, 0, 50, 100]
  assert.ok(validateCompiledLayout(reversedCompiled).length > 0, 'compiled y span must be positive')
  const sizedCompiled = JSON.parse(JSON.stringify(compiled))
  sizedCompiled.width = 1536
  assert.ok(validateCompiledLayout(sizedCompiled).length > 0, 'compiled layouts must not carry width')

  // Reading a compiled layout into a smaller canvas cannot fit its boxes.
  assert.throws(() => decompileLayout(compiled, 512, 512), LayoutEditorError)
  assert.throws(() => decompileLayout(compiled, 1000, 1000), LayoutEditorError)
  assert.throws(() => parseDraft('{not json'), LayoutEditorError)
  assert.throws(() => parseDraft(JSON.stringify({ width: 1536 })), LayoutEditorError)
})

test('draft and compiled exports match the contract shapes', () => {
  const draft = readSample('fantasy_dawn_layout_wide_draft')
  const state = draftToState(draft)

  const draftText = exportDraft(state)
  assert.ok(draftText.endsWith('\n'))
  assert.ok(draftText.startsWith('{\n  "width":'), 'draft export is 2-space pretty JSON')
  assert.deepEqual(Object.keys(JSON.parse(draftText)), ['width', 'height', 'bbox_coord_space', 'bbox_format', 'summary', 'items'])
  assert.deepEqual(JSON.parse(draftText), draft)

  const compiledText = exportCompiled(state)
  assert.deepEqual(Object.keys(JSON.parse(compiledText)), ['summary', 'items', 'bbox_coord_space', 'bbox_format'])

  // Non-ASCII text is emitted raw (ensure_ascii=False in the reference compiler).
  let unicodeState = createLayoutState({ width: 512, height: 512, summary: { caption: '中文 caption。' } })
  unicodeState = addBox(unicodeState, {
    bbox: { x1: 10, y1: 10, x2: 100, y2: 100 },
    label: 'text',
    caption: '小号中文说明。',
    text: '山海之间\n第二行',
  })
  const unicodeCompiled = exportCompiled(unicodeState)
  const parsed = JSON.parse(unicodeCompiled)
  assert.equal(parsed.summary.caption, '中文 caption。')
  assert.equal(parsed.items[0].text, '山海之间\n第二行')
  assert.ok(unicodeCompiled.includes('山海之间'), 'literal text is not \\u escaped')
  assert.equal(unicodeCompiled.includes('\n'), false, 'literal line breaks are escaped inside the JSON prompt')
  assert.ok(parsed.items[0].text.includes('\n'))
})

// ---------------------------------------------------------------------------
// C13: the canvas node around the editor — the §8.2 delta conversion and the
// §8.3 width-driven display box.
// ---------------------------------------------------------------------------

test('C13: one screen delta converts to the same draft delta at zoom 0.5/1/2', () => {
  const canvas = { width: DEFAULT_LAYOUT_WIDTH, height: DEFAULT_LAYOUT_HEIGHT }
  const display = { width: LAYOUT_NODE_DEFAULT_WIDTH, height: 320 }
  // 10 screen px over a 480-wide box showing a 1536-wide draft = 32 draft px.
  const expected = { x: (10 * canvas.width) / display.width, y: (-4 * canvas.height) / display.height }
  const at = (zoom) => screenDeltaToDraft(
    { x: 10 * zoom, y: -4 * zoom },
    { width: display.width * zoom, height: display.height * zoom },
    canvas,
  )
  assert.deepEqual(at(1), expected, 'zoom 1 is the plain display scale')
  assert.deepEqual(at(0.5), expected, 'the measured box already contains the canvas zoom')
  assert.deepEqual(at(2), expected, 'so the draft delta is invariant across the band')

  // The pointerScale hook exists for hosts whose page pixels are not local
  // pixels; 1 is the independent-editor default and invalid values fall back.
  assert.deepEqual(screenDeltaToDraft({ x: 10, y: 0 }, { width: 480, height: 320 }, canvas, 1), { x: 32, y: 0 })
  assert.deepEqual(screenDeltaToDraft({ x: 10, y: 0 }, { width: 480, height: 320 }, canvas, 2), { x: 64, y: 0 })
  assert.deepEqual(screenDeltaToDraft({ x: 10, y: 0 }, { width: 480, height: 320 }, canvas, 0), { x: 32, y: 0 })
  // A degenerate box yields no movement instead of corrupting a box.
  assert.deepEqual(screenDeltaToDraft({ x: 10, y: 2 }, { width: 0, height: 0 }, canvas), { x: 0, y: 0 })
})

test('C13: the node height follows the draft proportion and resizing leaves the draft untouched', () => {
  const draft = stateToDraft(addBox(createLayoutState({
    width: DEFAULT_LAYOUT_WIDTH,
    height: DEFAULT_LAYOUT_HEIGHT,
    summary: { caption: '黄昏的山谷' },
  }), {
    bbox: { x1: 10, y1: 20, x2: 300, y2: 400 },
    label: 'object',
    caption: '山',
  }))
  // §8.1: the default 1536x1024 draft at the default 480 width is a 480x420 node.
  assert.equal(LAYOUT_NODE_DEFAULT_WIDTH, 480)
  assert.equal(layoutNodeHeight(LAYOUT_NODE_DEFAULT_WIDTH, draft), 420)

  // §8.2/§8.3: resize only changes the display box; the draft — and therefore
  // the compiled text a generation would send — is byte-identical afterwards.
  const compiled = compileLayout(draft)
  const before = JSON.stringify(draft)
  for (const width of [LAYOUT_NODE_MIN_WIDTH, 480, 700, LAYOUT_NODE_MAX_WIDTH]) {
    assert.equal(
      layoutNodeHeight(width, draft),
      LAYOUT_NODE_CHROME + Math.round((width * draft.height) / draft.width),
      'height follows the draft proportion at width ' + String(width),
    )
    assert.equal(compileLayout(draft), compiled, 'a resize must not change the compiled layout')
  }
  assert.equal(JSON.stringify(draft), before, 'geometry never mutates the draft')

  // Widths clamp into the §8.3 band; nonsense falls back to the default.
  assert.equal(clampLayoutNodeWidth(100), LAYOUT_NODE_MIN_WIDTH)
  assert.equal(clampLayoutNodeWidth(10000), LAYOUT_NODE_MAX_WIDTH)
  assert.equal(clampLayoutNodeWidth(Number.NaN), LAYOUT_NODE_DEFAULT_WIDTH)
})

/* -------------------------------------------------------------------------- */
/* B-tier: canvas size, optional schema fields, multi-select, import, undo      */
/* -------------------------------------------------------------------------- */

test('the canvas size is a draft field, and resizing it re-maps every box', () => {
  // The official rule: width/height must be multiples of 16 and are dropped from
  // the compiled prompt, so a draft is authored at the size it is generated at.
  let state = createLayoutState({ width: 1536, height: 1024 })
  state = addBox(state, { bbox: { x1: 0, y1: 0, x2: 768, y2: 512 }, label: 'object', caption: 'a' })
  const resized = setCanvasSize(state, 1024, 1024)
  assert.equal(resized.width, 1024)
  assert.equal(resized.height, 1024)
  // Half the canvas stays half the canvas: proportional, not clamped in place.
  assert.deepEqual(resized.items[0].bbox, { x1: 0, y1: 0, x2: 512, y2: 512 })
  // A size that is not a multiple of 16 is refused, not silently rounded.
  assert.throws(() => setCanvasSize(state, 1000, 1024), /multiple of 16/
  )
  // The presets are all valid canvases, so a picker can never offer a broken one.
  for (const preset of LAYOUT_CANVAS_PRESETS) {
    assert.equal(preset.width % LAYOUT_CANVAS_MULTIPLE, 0)
    assert.equal(preset.height % LAYOUT_CANVAS_MULTIPLE, 0)
  }
})

test('templates are geometry only: every box still needs a caption', () => {
  let state = createLayoutState({ width: 1536, height: 1024 })
  const template = LAYOUT_TEMPLATES.find((entry) => entry.id === 'poster-title-body')
  for (const box of template.boxes) {
    state = addBox(state, {
      label: box.label,
      bbox: {
        x1: box.x1 * state.width, y1: box.y1 * state.height,
        x2: box.x2 * state.width, y2: box.y2 * state.height,
      },
    })
  }
  assert.equal(state.items.length, template.boxes.length)
  assert.ok(state.items.every((item) => item.caption === ''), 'a template must not ship filler copy')
  // Which is exactly why it cannot compile yet — the official rules demand it.
  assert.throws(() => compileLayout(stateToDraft(setSummary(state, { caption: 'x' }))), /caption/)
})

test('multi-select edits every selected box, and keeps the first as primary', () => {
  let state = createLayoutState()
  state = addBox(state, { bbox: { x1: 0, y1: 0, x2: 100, y2: 100 }, caption: 'a' })
  state = addBox(state, { bbox: { x1: 200, y1: 0, x2: 300, y2: 100 }, caption: 'b' })
  const [first, second] = state.items.map((item) => item.id)
  state = selectMany(state, [first, second])
  assert.deepEqual(state.selectedIds, [first, second])
  assert.equal(state.selectedId, first, 'the first id owns the caption field')
  state = setSelectedCaption(state, 'both')
  assert.deepEqual(state.items.map((item) => item.caption), ['both', 'both'])
  state = setSelectedLabel(state, 'text')
  assert.ok(state.items.every((item) => item.label === 'text'))
  // A stale id is dropped, not thrown: a marquee can outlive a deletion.
  assert.deepEqual(selectMany(state, [first, 'gone']).selectedIds, [first])
  // Shift-click toggles, chained: both are selected after the batch edit above,
  // so removing each in turn empties the selection (and with it the primary).
  const one = toggleSelection(state, second)
  assert.equal(one.selectedIds.length, 1)
  const none = toggleSelection(one, first)
  assert.equal(none.selectedIds.length, 0)
  assert.equal(none.selectedId, null, 'no selection means no primary')
  // Toggling an unselected box adds it, and it becomes the primary.
  const again = toggleSelection(none, first)
  assert.deepEqual(again.selectedIds, [first])
  assert.equal(again.selectedId, first)
  assert.equal(selectBox(state, null).selectedId, null)
})

test('optional schema fields survive a roundtrip and compile verbatim', () => {
  // summary.meta / summary.canvas / summary.palette and item tags / palette are
  // official optional fields; they must reach the compiled prompt unchanged.
  let state = createLayoutState({
    width: 1024,
    height: 1024,
    summary: { caption: 'a poster', meta: ['product campaign', 'studio photography'], canvas: 'single', palette: ['ivory', 'dark green'] },
  })
  state = addBox(state, { bbox: { x1: 0, y1: 0, x2: 400, y2: 400 }, label: 'object', caption: 'cup', tags: ['ceramic'], palette: ['ivory'] })
  const compiled = JSON.parse(compileLayout(stateToDraft(state)))
  assert.deepEqual(compiled.summary.meta, ['product campaign', 'studio photography'])
  assert.equal(compiled.summary.canvas, 'single')
  assert.deepEqual(compiled.summary.palette, ['ivory', 'dark green'])
  assert.deepEqual(compiled.items[0].tags, ['ceramic'])
  assert.deepEqual(compiled.items[0].palette, ['ivory'])
  // Clearing one of them removes the key instead of sending an empty array.
  const cleared = stateToDraft(setSummary(state, { meta: undefined }))
  assert.equal('meta' in cleared.summary, false)
})

test('a text item keeps literal line breaks through compile and import', () => {
  // The reference doc: "literal intended line breaks represented as JSON \\n".
  // A flattened poster title is a wrong image, so the break has to survive.
  const draft = {
    width: 1024, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy',
    summary: { caption: 'poster' },
    items: [{ label: 'text', caption: 'title', text: '一杯温暖\n一刻从容', bbox: [0, 0, 400, 200] }],
  }
  const state = draftToEditorState(draft)
  assert.equal(state.items[0].text, '一杯温暖\n一刻从容')
  const compiled = JSON.parse(compileLayout(stateToDraft(state)))
  assert.equal(compiled.items[0].text, '一杯温暖\n一刻从容')
})

test('an official compiled prompt imports back into an editable draft', () => {
  const compiled = readFileSync(fileURLToPath(new URL('../verify/layout_prompt.json', import.meta.url)), 'utf8')
  const draft = decompileLayout(compiled, DEFAULT_LAYOUT_WIDTH, DEFAULT_LAYOUT_HEIGHT)
  const state = draftToEditorState(draft)
  assert.equal(state.items.length, draft.items.length)
  assert.equal(state.width, DEFAULT_LAYOUT_WIDTH)
  // Re-compiling the imported state reproduces the same boxes, box for box.
  const recompiled = JSON.parse(compileLayout(stateToDraft(state)))
  assert.deepEqual(
    recompiled.items.map((item) => item.bbox),
    JSON.parse(compiled).items.map((item) => item.bbox),
  )
})
test('the editor opens a draft whose boxes have no caption yet', () => {
  // A box drawn a second ago has no caption, and a template ships geometry only.
  // Mounting used to fail the whole draft ("items[0].caption must be nonempty"),
  // which blanked the editor over work the user had already drawn. Compiling is
  // still refused — that is where the requirement belongs.
  const drafting = {
    width: 1024, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy',
    summary: { caption: '' },
    items: [
      { label: 'object', caption: '', bbox: [0, 0, 200, 200] },
      { label: 'text', caption: '', text: 'title', bbox: [0, 300, 200, 400] },
    ],
  }
  const state = draftToEditorState(drafting)
  assert.equal(state.items.length, 2)
  assert.ok(state.items.every((item) => item.caption === ''))
  // Compiling is where an unwritten caption is refused.
  assert.throws(() => compileLayout(stateToDraft(drafting)), /caption must be nonempty/)
  // And a malformed item (missing text on a text item) still refuses to mount.
  assert.throws(
    () => draftToEditorState({ ...drafting, items: [{ label: 'text', caption: 'x', bbox: [0, 0, 100, 100] }] }),
    /text items require literal text/,
  )
})
test('a box can be named for the panel, and the name never reaches the prompt', () => {
  // The official schema rejects unknown item fields, so a name is editor-only:
  // it is how a human finds their own boxes, not something the model reads.
  let state = createLayoutState({ width: 1024, height: 1024 })
  state = addBox(state, { bbox: { x1: 0, y1: 0, x2: 200, y2: 200 }, caption: 'cup' })
  const id = state.items[0].id
  state = setBoxName(state, id, '  杯子  ')
  assert.equal(state.items[0].name, '杯子', 'surrounding whitespace is trimmed')
  const draft = stateToDraft(setSummary(state, { caption: 'x' }))
  // The name *is* stored in the draft — otherwise it vanished on every reload —
  // but it is not model input: the compiled prompt drops it, because the
  // official contract rejects unknown item fields.
  assert.equal(draft.items[0].name, '杯子', 'the name survives in the stored draft')
  const compiled = JSON.parse(compileLayout(draft))
  assert.equal(compiled.items[0].name, undefined, 'the compiled prompt never carries the name')
  // And the draft with a name still validates (it is a draft-only key).
  assert.deepEqual(validateLayoutDraft(draft), [])
  // An empty name clears it instead of storing an empty string.
  assert.equal('name' in setBoxName(state, id, '   ').items[0], false)
})