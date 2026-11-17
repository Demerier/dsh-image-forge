/**
 * Interaction pure-function tests (C08).
 *
 * Pointer gestures have no DOM automation in this project (`docs/CANVAS-DESIGN.md`
 * §14.5), so this file is where a marquee's hit rule, a batch drag's division by
 * zoom, an alignment's bounding-box reference, the undo depth and the key table
 * are pinned down. The module under test is imported straight from `src/` — the
 * import succeeding at all is the "zero DOM dependency" assertion, since Node
 * strips the types and would fail on anything that reached for `document`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ALIGN_MODES,
  COMMAND_STACK_LIMIT,
  CommandStack,
  DISTRIBUTE_AXES,
  NUDGE_STEP,
  NUDGE_STEP_FAST,
  alignNodes,
  contextMenuItems,
  distributeNodes,
  hasReference,
  marqueeSelection,
  marqueeWorldRect,
  moveSelection,
  nodesInRect,
  nudgeVector,
  rectsIntersect,
  resolveShortcut,
  selectionBounds,
  shortcutContext,
  singleSelection,
  snapshotCommand,
  toggleSelection,
} from '../src/canvas-interactions.ts'

/** A node rect; `id` is what every caller keys its positions by. */
const rect = (id, x, y, width = 100, height = 240) => ({ id, x, y, width, height })

/* -------------------------------------------------------------------------- */
/* Intersection and marquee                                                    */
/* -------------------------------------------------------------------------- */

test('rectsIntersect: positive overlap only, containment counts, touching does not', () => {
  const a = { x: 0, y: 0, width: 100, height: 100 }
  assert.equal(rectsIntersect(a, { x: 50, y: 50, width: 100, height: 100 }), true, 'overlap')
  // A shared edge is not a hit: dragging the marquee to a neighbour's border and
  // stopping must not sweep the neighbour in.
  assert.equal(rectsIntersect(a, { x: 100, y: 0, width: 100, height: 100 }), false, 'touching right edge')
  assert.equal(rectsIntersect(a, { x: 0, y: 100, width: 100, height: 100 }), false, 'touching bottom edge')
  assert.equal(rectsIntersect(a, { x: 100, y: 100, width: 100, height: 100 }), false, 'corner touch')
  // A marquee bigger than the node catches it.
  assert.equal(rectsIntersect(a, { x: -50, y: -50, width: 300, height: 300 }), true, 'containment')
  assert.equal(rectsIntersect(a, { x: 500, y: 500, width: 10, height: 10 }), false, 'disjoint')
  // A click that never moved produces a zero-size box and selects nothing.
  assert.equal(rectsIntersect(a, { x: 20, y: 20, width: 0, height: 0 }), false, 'zero-area')
})

test('marqueeWorldRect converts both corners through the camera, and reverses a backwards drag', () => {
  const camera = { x: 100, y: -40, zoom: 2 }
  const forward = marqueeWorldRect(camera, { x: 0, y: 0 }, { x: 200, y: 100 })
  assert.deepEqual(forward, { x: 100, y: -40, width: 100, height: 50 })
  // Dragging up-left must yield the same rectangle, not a negative size.
  const backward = marqueeWorldRect(camera, { x: 200, y: 100 }, { x: 0, y: 0 })
  assert.deepEqual(backward, forward)
  // A real camera offset matters: forgetting it would put this at the origin.
  const butCameraIgnored = { x: 0, y: 0, width: 200, height: 100 }
  assert.notDeepEqual(forward, butCameraIgnored)
  // Zoom 1 is the plain difference.
  assert.deepEqual(
    marqueeWorldRect({ x: 0, y: 0, zoom: 1 }, { x: 10, y: 20 }, { x: 30, y: 60 }),
    { x: 10, y: 20, width: 20, height: 40 },
  )
})

test('nodesInRect hits by intersection at a non-1 zoom, and keeps input order', () => {
  const camera = { x: 100, y: -40, zoom: 2 }
  const box = marqueeWorldRect(camera, { x: 0, y: 0 }, { x: 200, y: 100 }) // x 100..200, y -40..10
  const nodes = [
    rect('tall', 150, -60), // x 150..250, y -60..180 — overlaps
    rect('left-of-box', 0, -50, 60, 60), // x 0..60 — outside in world, inside in screen
    rect('right-of-box', 300, 0), // x 300..400 — outside
    rect('centred', 130, -20, 40, 40), // fully inside
  ]
  assert.deepEqual(nodesInRect(nodes, box), ['tall', 'centred'])
  assert.deepEqual(nodesInRect([], box), [], 'empty board')
  // An empty marquee (a click) catches nothing even when it lands on a node.
  const click = marqueeWorldRect(camera, { x: 300, y: 40 }, { x: 300, y: 40 })
  assert.deepEqual(nodesInRect(nodes, click), [])
})

test('selectionBounds is the union of the rects and undefined when there are none', () => {
  assert.equal(selectionBounds([]), undefined, 'an empty selection has no box')
  assert.deepEqual(selectionBounds([rect('a', 0, 0, 100, 240)]), { x: 0, y: 0, width: 100, height: 240 })
  // Negative coordinates are ordinary world positions, not errors.
  assert.deepEqual(
    selectionBounds([rect('a', 0, 0), rect('b', 50, 100, 200, 240), rect('c', -30, -50, 80, 200)]),
    { x: -30, y: -50, width: 280, height: 390 },
  )
})

/* -------------------------------------------------------------------------- */
/* Selection model                                                             */
/* -------------------------------------------------------------------------- */

test('toggleSelection replaces without additive and toggles with it', () => {
  const current = new Set(['a', 'b'])
  assert.deepEqual([...toggleSelection(current, 'c', false)], ['c'], 'plain click replaces the selection')
  assert.deepEqual([...toggleSelection(current, 'c', true)], ['a', 'b', 'c'], 'additive adds')
  assert.deepEqual([...toggleSelection(current, 'a', true)], ['b'], 'additive on a member removes it')
  // React state identity: an in-place edit would not re-render.
  assert.deepEqual([...current], ['a', 'b'], 'the argument set is untouched')
  assert.deepEqual([...toggleSelection(new Set(), 'x', true)], ['x'], 'additive from empty')
  assert.deepEqual([...toggleSelection(new Set(), 'x', false)], ['x'])
})

test('singleSelection is the single-node view of a multi-selection', () => {
  assert.equal(singleSelection(new Set()), undefined, 'nothing selected')
  assert.equal(singleSelection(new Set(['a'])), 'a', 'one node keeps the single-node affordances')
  assert.equal(singleSelection(new Set(['a', 'b'])), undefined, 'two nodes have no single subject')
})

/* -------------------------------------------------------------------------- */
/* Multi-node drag                                                             */
/* -------------------------------------------------------------------------- */

test('moveSelection divides the screen delta by zoom and leaves the origins alone', () => {
  const origins = new Map([['a', { x: 10, y: 20 }], ['b', { x: -5, y: 40 }]])
  const at2 = moveSelection(origins, { x: 100, y: -40 }, 2)
  assert.deepEqual([...at2.entries()], [['a', { x: 60, y: 0 }], ['b', { x: 45, y: 20 }]], 'zoom 2 halves the delta')
  const at1 = moveSelection(origins, { x: 100, y: -40 }, 1)
  assert.deepEqual(at1.get('a'), { x: 110, y: -20 }, 'zoom 1 moves by the delta')
  // A corrupt camera must freeze the drag, not teleport nodes to Infinity.
  for (const badZoom of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(moveSelection(new Map([['a', { x: 0, y: 0 }]]), { x: 10, y: 10 }, badZoom).get('a'), { x: 10, y: 10 })
  }
  assert.deepEqual([...moveSelection(new Map(), { x: 1, y: 1 }, 1)], [], 'empty selection')
  assert.deepEqual(origins.get('a'), { x: 10, y: 20 }, 'origins are not mutated')
  assert.notEqual(moveSelection(origins, { x: 0, y: 0 }, 1), origins, 'a fresh map comes back')
})

/* -------------------------------------------------------------------------- */
/* Align and distribute                                                        */
/* -------------------------------------------------------------------------- */

test('alignNodes: six modes, each against the selection bounding box', () => {
  // bounds: x -30, y -50, width 280, height 390 (right 250, bottom 340)
  const nodes = [rect('a', 0, 0, 100, 240), rect('b', 50, 100, 200, 240), rect('c', -30, -50, 80, 200)]
  const x = (mode) => Object.fromEntries([...alignNodes(nodes, mode)].map(([id, point]) => [id, point.x]))
  const y = (mode) => Object.fromEntries([...alignNodes(nodes, mode)].map(([id, point]) => [id, point.y]))
  assert.deepEqual(x('left'), { a: -30, b: -30, c: -30 }, 'left edges share the box left')
  assert.deepEqual(x('center-h'), { a: 60, b: 10, c: 70 }, 'centres sit on the box centre')
  assert.deepEqual(x('right'), { a: 150, b: 50, c: 170 }, 'right edges share the box right')
  assert.deepEqual(y('top'), { a: -50, b: -50, c: -50 }, 'top edges share the box top')
  assert.deepEqual(y('center-v'), { a: 25, b: 25, c: 45 }, 'centres sit on the box centre')
  assert.deepEqual(y('bottom'), { a: 100, b: 100, c: 140 }, 'bottom edges share the box bottom')
  // The untouched axis does not move.
  assert.deepEqual(y('left'), { a: 0, b: 100, c: -50 }, 'horizontal modes keep y')
  assert.deepEqual(x('top'), { a: 0, b: 50, c: -30 }, 'vertical modes keep x')
  assert.deepEqual(ALIGN_MODES.length, 6)
})

test('alignNodes is pure, and an empty or unknown input is a no-op', () => {
  const nodes = [rect('a', 5, 7), rect('b', -20, 90, 60, 200)]
  const snapshot = structuredClone(nodes)
  alignNodes(nodes, 'right')
  assert.deepEqual(nodes, snapshot, 'arguments are untouched')
  assert.deepEqual([...alignNodes([], 'left')], [], 'empty selection')
  // A single node aligns to itself: identity, not a jump to the origin.
  assert.deepEqual([...alignNodes([rect('solo', 12, 34)], 'bottom')], [['solo', { x: 12, y: 34 }]])
  // A stale UI button must not throw.
  assert.deepEqual([...alignNodes(nodes, 'diagonal')], [['a', { x: 5, y: 7 }], ['b', { x: -20, y: 90 }]])
})

test('distributeNodes spaces centres evenly and never moves the extremes', () => {
  const nodes = [rect('a', 0, 0), rect('b', 200, 0), rect('c', 600, 0)] // centres 50 / 250 / 650
  const spread = distributeNodes(nodes, 'x')
  assert.equal(spread.get('a').x, 0, 'first stays')
  assert.equal(spread.get('c').x, 600, 'last stays')
  assert.equal(spread.get('b').x, 300, 'middle centre lands midway: 50 + 300 = 350')
  assert.equal(spread.get('b').x + 50, 350)
  // Order comes from the centres, not from the array: this pass is deliberately
  // shuffled, as a render-order array would be.
  const shuffled = distributeNodes([nodes[2], nodes[0], nodes[1]], 'x')
  assert.equal(shuffled.get('b').x, 300, 'sorted by centre')
  // The other axis is untouched on a horizontal distribution.
  assert.equal(distributeNodes(nodes, 'x').get('b').y, 0)
  assert.equal(nodes[1].x, 200, 'arguments are untouched')
})

test('distributeNodes: vertical axis, too-few nodes, and a degenerate span', () => {
  const vertical = [rect('a', 0, 0, 100, 100), rect('b', 300, 100, 100, 100), rect('c', 0, 500, 100, 100)]
  const spreadY = distributeNodes(vertical, 'y')
  assert.equal(spreadY.get('a').y, 0)
  assert.equal(spreadY.get('c').y, 500)
  assert.equal(spreadY.get('b').y, 250, 'centre 300 → top 250')
  assert.equal(spreadY.get('b').x, 300, 'x is untouched on a vertical distribution')
  assert.deepEqual([...distributeNodes([], 'x')], [], 'empty')
  assert.deepEqual(
    [...distributeNodes([rect('a', 0, 0), rect('b', 400, 0)], 'x')],
    [['a', { x: 0, y: 0 }], ['b', { x: 400, y: 0 }]],
    'two nodes have nothing to space out',
  )
  // All centres equal: the span is zero, so nothing may drift.
  const collapsed = distributeNodes([rect('a', 0, 0), rect('b', 0, 0), rect('c', 0, 0)], 'x')
  assert.deepEqual([...collapsed.values()].map((point) => point.x), [0, 0, 0])
  assert.deepEqual(DISTRIBUTE_AXES, ['x', 'y'])
})

/* -------------------------------------------------------------------------- */
/* Undo stack                                                                  */
/* -------------------------------------------------------------------------- */

/** A command that only records what the stack asked it to do. */
const command = (log, label) => ({
  label,
  apply() {
    log.push(`apply:${label}`)
  },
  revert() {
    log.push(`revert:${label}`)
  },
})

test('CommandStack undoes and redoes in order, and push does not apply', () => {
  const log = []
  const stack = new CommandStack()
  stack.push(command(log, 'move'))
  stack.push(command(log, 'align'))
  assert.deepEqual(log, [], 'the caller already applied the change; push records only')
  assert.equal(stack.canUndo(), true)
  assert.equal(stack.undoSize, 2)
  assert.equal(stack.undo(), true)
  assert.equal(stack.undo(), true)
  assert.equal(stack.undo(), false, 'nothing left to undo')
  assert.deepEqual(log, ['revert:align', 'revert:move'])
  assert.equal(stack.redoSize, 2)
  assert.equal(stack.redo(), true)
  assert.equal(stack.redo(), true)
  assert.equal(stack.redo(), false)
  assert.deepEqual(log.slice(2), ['apply:move', 'apply:align'], 'redo replays oldest first')
  assert.equal(stack.canRedo(), false)
})

test('CommandStack caps at 100 and drops the oldest step', () => {
  assert.equal(COMMAND_STACK_LIMIT, 100)
  const log = []
  const stack = new CommandStack()
  assert.equal(stack.limit, 100)
  for (let index = 0; index < 105; index += 1) stack.push(command(log, String(index)))
  assert.equal(stack.undoSize, 100, 'overflow drops the oldest')
  for (let index = 0; index < 100; index += 1) assert.equal(stack.undo(), true)
  assert.equal(stack.undo(), false)
  assert.deepEqual(log, [...Array.from({ length: 100 }, (_, index) => `revert:${String(104 - index)}`)])
  assert.ok(!log.includes('revert:4'), 'the five oldest steps are gone')

  const small = new CommandStack(3)
  assert.equal(small.limit, 3)
  for (let index = 0; index < 5; index += 1) small.push(command(log, `s${String(index)}`))
  assert.equal(small.undoSize, 3)
  // Invalid limits fall back instead of producing a stack that cannot hold one step.
  for (const bad of [0, -1, Number.NaN]) assert.equal(new CommandStack(bad).limit, 100)
})

test('CommandStack truncates the abandoned branch on a new push, and clear resets both', () => {
  const log = []
  const stack = new CommandStack()
  stack.push(command(log, 'a'))
  stack.push(command(log, 'b'))
  assert.equal(stack.undo(), true)
  assert.equal(stack.redoSize, 1, 'b is in the redo tail')
  stack.push(command(log, 'c'))
  assert.equal(stack.redoSize, 0, 'doing something new abandons the redo tail')
  assert.equal(stack.canRedo(), false)
  assert.equal(stack.redo(), false, 'the abandoned future is unreachable')
  assert.equal(stack.undoSize, 2)
  stack.clear()
  assert.equal(stack.undoSize, 0)
  assert.equal(stack.redoSize, 0)
  assert.equal(stack.canUndo(), false)
  assert.equal(new CommandStack().undo(), false, 'undo on a fresh stack')
})

/* -------------------------------------------------------------------------- */
/* Keyboard                                                                    */
/* -------------------------------------------------------------------------- */

test('resolveShortcut maps the §6.3 table to actions', () => {
  assert.equal(resolveShortcut('Delete'), 'remove')
  assert.equal(resolveShortcut('Backspace'), 'remove')
  assert.equal(resolveShortcut('Escape'), 'escape')
  assert.equal(resolveShortcut(' '), 'pan-mode')
  assert.equal(resolveShortcut('f'), 'fit')
  assert.equal(resolveShortcut('F'), 'fit', 'case-insensitive')
  assert.equal(resolveShortcut('+'), 'zoom-in')
  assert.equal(resolveShortcut('='), 'zoom-in')
  assert.equal(resolveShortcut('Add'), 'zoom-in', 'numpad reports Add')
  assert.equal(resolveShortcut('-'), 'zoom-out')
  assert.equal(resolveShortcut('_'), 'zoom-out')
  assert.equal(resolveShortcut('Subtract'), 'zoom-out')
  assert.equal(resolveShortcut('ArrowLeft'), 'nudge-left')
  assert.equal(resolveShortcut('ArrowRight'), 'nudge-right')
  assert.equal(resolveShortcut('ArrowUp'), 'nudge-up')
  assert.equal(resolveShortcut('ArrowDown'), 'nudge-down')
})

test('resolveShortcut: modifiers, both redo bindings, and Ctrl/Cmd equivalence', () => {
  assert.equal(resolveShortcut('z', { ctrl: true }), 'undo')
  assert.equal(resolveShortcut('z', { meta: true }), 'undo', 'Cmd does what Ctrl does')
  assert.equal(resolveShortcut('Z', { ctrl: true, shift: true }), 'redo')
  assert.equal(resolveShortcut('y', { ctrl: true }), 'redo')
  // Ctrl/Cmd+Shift+Z is the only shifted binding in the table, so Ctrl+Shift+Y
  // stays unbound rather than becoming a third alias for redo.
  assert.equal(resolveShortcut('y', { meta: true, shift: true }), 'none')
  assert.equal(resolveShortcut('a', { ctrl: true }), 'select-all')
  assert.equal(resolveShortcut('c', { ctrl: true }), 'copy')
  assert.equal(resolveShortcut('v', { meta: true }), 'paste')
  assert.equal(resolveShortcut('v', { ctrl: true, shift: true }), 'none', 'Ctrl+Shift+V is not in the table')
  // Shift alone never changes what a nudge means — only how far (NUDGE_STEP_FAST).
  assert.equal(resolveShortcut('ArrowLeft', { shift: true }), 'nudge-left')
  assert.equal(NUDGE_STEP, 1)
  assert.equal(NUDGE_STEP_FAST, 10)
})

test('resolveShortcut yields in a text field or the layout editor (§6.3 让位)', () => {
  const keys = ['Delete', 'Backspace', 'z', 'y', 'a', 'c', 'v', 'Escape', ' ', 'f', '+', '-', 'ArrowLeft']
  for (const key of keys) {
    assert.equal(resolveShortcut(key, { ctrl: true }, 'input'), 'none', `input context must not act on ${key}`)
  }
  for (const key of keys) {
    assert.equal(resolveShortcut(key, {}, 'input'), 'none', `input context, plain ${key}`)
    assert.equal(resolveShortcut(key, {}, 'editor'), 'none', `editor context, plain ${key}`)
  }
  assert.equal(resolveShortcut('z', { ctrl: true }, 'editor'), 'none', 'the editor keeps its own undo')
  // Unbound or malformed keys are inert rather than fatal.
  for (const key of ['x', 'Shift', 'F5', '', 'q', 'Enter']) assert.equal(resolveShortcut(key), 'none')
  assert.equal(resolveShortcut('z', { ctrl: true, shift: true, meta: true }), 'redo')
  assert.equal(resolveShortcut('c', { ctrl: true, shift: true }), 'none', 'unbound combo')
})

test('shortcutContext classifies a flattened DOM target', () => {
  assert.equal(shortcutContext({}), 'canvas')
  assert.equal(shortcutContext({ tagName: 'DIV' }), 'canvas')
  assert.equal(shortcutContext({ tagName: 'INPUT' }), 'input')
  assert.equal(shortcutContext({ tagName: 'input' }), 'input', 'tagName case is ignored')
  assert.equal(shortcutContext({ tagName: 'TEXTAREA' }), 'input')
  assert.equal(shortcutContext({ tagName: 'SELECT' }), 'input')
  assert.equal(shortcutContext({ tagName: 'DIV', contentEditable: true }), 'input', 'rich text edits like an input')
  assert.equal(shortcutContext({ inEditor: true }), 'editor')
  // The editor wraps its own text fields, so it must win that tie.
  assert.equal(shortcutContext({ tagName: 'INPUT', inEditor: true }), 'editor')
})

/* -------------------------------------------------------------------------- */
/* C09 wiring helpers: marquee release, undo snapshots, nudges, the menu      */
/* -------------------------------------------------------------------------- */

test('marqueeSelection replaces without additive and unions with it', () => {
  const current = new Set(['a', 'b'])
  assert.deepEqual([...marqueeSelection(current, ['c', 'd'], false)], ['c', 'd'], 'a plain marquee is a fresh statement')
  assert.deepEqual([...marqueeSelection(current, [], false)], [], 'a box that caught nothing clears the selection')
  assert.deepEqual([...marqueeSelection(current, ['b', 'c'], true)], ['a', 'b', 'c'], 'Shift adds, never drops')
  assert.deepEqual([...marqueeSelection(new Set(), ['x'], true)], ['x'])
  assert.deepEqual([...current], ['a', 'b'], 'the argument set is untouched (React state identity)')
})

test('snapshotCommand writes the before side on undo and the after side on redo', () => {
  const writes = []
  const before = [{ id: 'a', x: 0 }, { id: 'b', x: 10 }]
  const after = [{ id: 'a', x: 5 }]
  const command = snapshotCommand('remove', before, after, (value) => { writes.push(value) })
  assert.deepEqual(writes, [], 'constructing a command writes nothing: the caller already applied it')
  assert.equal(command.label, 'remove')
  command.revert()
  command.apply()
  assert.deepEqual(writes, [before, after], 'revert restores the old set, apply restores the new one')
  // `revert` writes the first snapshot it was given, `apply` the second —
  // regardless of what the caller called them, which is the side that gets
  // mixed up when an undo step is written by hand.
  const reversed = snapshotCommand('reversed', after, before, (value) => { writes.push(value) })
  reversed.revert()
  reversed.apply()
  assert.deepEqual(writes.slice(2), [after, before])
  // The stack drives both sides of the same command.
  const log = []
  const stack = new CommandStack()
  const move = snapshotCommand('move', 'origin', 'target', (value) => { log.push(value) })
  stack.push(move)
  stack.undo()
  stack.redo()
  assert.deepEqual(log, ['origin', 'target'])
})

test('nudgeVector is one world unit per arrow key, ten with Shift', () => {
  assert.deepEqual(nudgeVector('left'), { x: -NUDGE_STEP, y: 0 })
  assert.deepEqual(nudgeVector('right'), { x: NUDGE_STEP, y: 0 })
  assert.deepEqual(nudgeVector('up'), { x: 0, y: -NUDGE_STEP }, 'y grows downward, so up subtracts')
  assert.deepEqual(nudgeVector('down'), { x: 0, y: NUDGE_STEP })
  assert.deepEqual(nudgeVector('left', true), { x: -NUDGE_STEP_FAST, y: 0 })
  assert.deepEqual(nudgeVector('down', true), { x: 0, y: NUDGE_STEP_FAST })
  assert.deepEqual(nudgeVector('diagonal'), { x: 0, y: 0 }, 'an unknown axis is a no-op, not a throw')
})

test('contextMenuItems: the image menu is the full §6.4 list', () => {
  const items = contextMenuItems({ kind: 'node', nodeKind: 'image', selectionSize: 1 })
  const ids = items.map((item) => item.id)
  // G22 inserted `zoom-view` (the in-canvas lightbox) next to `original`, which
  // stays as the open-in-a-new-tab escape hatch.
  assert.deepEqual(ids, ['reference', 'branch', 'zoom-view', 'original', 'copy-item', 'move-item', 'remove', 'delete-file'])
  // Deleting the file is the one irreversible item, and it is marked so.
  assert.equal(items.find((item) => item.id === 'delete-file').danger, true)
  assert.equal(items.find((item) => item.id === 'remove').danger, undefined, 'unplace is not destructive')
  // G25: cross-board copy/move are wired to the C12 routes now, so the menu is
  // fully live for pictures — no disabled placeholder left in this list.
  for (const id of ['copy-item', 'move-item']) {
    const item = items.find((entry) => entry.id === id)
    assert.equal(item.disabled, undefined, `${id} must be clickable`)
    assert.ok(item.hint !== undefined && item.hint.length > 0, `${id} still explains what it does`)
    assert.ok(!item.hint.includes('尚未接线'), `${id} must not present itself as unwired`)
  }
  assert.deepEqual(items.filter((item) => item.disabled === true), [], 'the image menu has no grey entries left')
  // The lightbox entry is only offered where a picture exists, and says which
  // keys it answers (G22).
  const zoom = items.find((item) => item.id === 'zoom-view')
  assert.equal(zoom.label, '放大查看')
  assert.ok(zoom.hint.includes('Esc'))
  assert.ok(!contextMenuItems({ kind: 'node', nodeKind: 'image', selectionSize: 3 }).some((item) => item.id === 'zoom-view'), 'a batch has no single picture to enlarge')
  // No label is empty: a menu of blanks would be unusable.
  for (const item of items) assert.ok(item.label.length > 0)
})

test('contextMenuItems: a multi-selection gets a batch menu, not single-image actions', () => {
  const items = contextMenuItems({ kind: 'node', nodeKind: 'image', selectionSize: 3 })
  const ids = items.map((item) => item.id)
  assert.deepEqual(ids, ['remove', 'copy-item', 'move-item', 'delete-file'])
  assert.ok(!ids.includes('reference'), '"use as reference" is ambiguous for three pictures')
  assert.ok(items[0].label.includes('3 张'), 'the batch size is stated')
  // Batch items name the whole selection.
  assert.ok(items[3].label.includes('3'))
  // An unset size means "one node", the common case.
  assert.deepEqual(
    contextMenuItems({ kind: 'node' }).map((item) => item.id),
    contextMenuItems({ kind: 'node', nodeKind: 'image', selectionSize: 1 }).map((item) => item.id),
    'the default node kind is image',
  )
})

test('contextMenuItems: blank canvas offers every §6.4 action now that its owners landed', () => {
  const items = contextMenuItems({ kind: 'blank' })
  assert.deepEqual(
    items.map((item) => item.id),
    ['new-layout', 'paste', 'select-all', 'fit', 'export-board', 'export-sheet'],
  )
  // C15 activates the blank entries: C13's layout node, C12's paste and the two
  // C15 exports. Nothing in this menu is a placeholder any more.
  const enabled = items.filter((item) => item.disabled !== true).map((item) => item.id)
  assert.deepEqual(enabled, items.map((item) => item.id))
  for (const item of items) assert.ok(item.label.length > 0, `${item.id} needs a label`)

  // §6.4's layout menu: generation is live (C14); the three conveniences say
  // why they are not instead of naming a task that already shipped.
  const layout = contextMenuItems({ kind: 'node', nodeKind: 'layout' })
  assert.deepEqual(
    layout.map((item) => item.id),
    ['layout-generate', 'layout-send-form', 'layout-export-draft', 'layout-export-compiled', 'remove'],
  )
  assert.equal(layout[0].disabled, undefined, 'layout generation is clickable')
  for (const item of layout.filter((entry) => entry.disabled === true)) {
    assert.ok(item.hint.length > 0, `${item.id} must say why it is disabled`)
  }

  // A running task can be cancelled; a failed one retried — both are C11
  // handlers, so both are clickable (C15 activation).
  for (const [state, ids] of [
    ['running', ['task-cancel', 'remove']],
    ['failed', ['task-retry', 'task-edit', 'remove']],
  ]) {
    const task = contextMenuItems({ kind: 'node', nodeKind: 'task', taskState: state })
    assert.deepEqual(task.map((item) => item.id), ids)
    for (const item of task) assert.notEqual(item.disabled, true, state + ' task entries are live')
  }

  // Every menu returns a fresh array, so a caller cannot corrupt the next one.
  assert.notEqual(contextMenuItems({ kind: 'blank' }), contextMenuItems({ kind: 'blank' }))
})
/* -------------------------------------------------------------------------- */
/* Reference de-duplication (C02)                                             */
/* -------------------------------------------------------------------------- */

/** A library-asset reference: path lives in payload, no node id. */
const assetRef = (path) => ({ payload: { path } })
/** A canvas reference: carries both a payload path and a node id. */
const nodeRef = (nodeId, path) => ({ payload: { path }, nodeId })

test('hasReference reads the path from payload.path, not from the entry (the C02 bug)', () => {
  // The old de-dupe compared entry.path, which never exists — so the same
  // asset could be added to the reference row forever. These two assertions
  // are the regression: true on a payload match, false on a different path.
  assert.equal(hasReference([assetRef('/a.png')], { path: '/a.png' }), true)
  assert.equal(hasReference([assetRef('/a.png')], { path: '/b.png' }), false)
})

test('hasReference rejects a canvas node that is already held, by node id', () => {
  assert.equal(hasReference([nodeRef('n1', '/a.png')], { nodeId: 'n1' }), true)
  assert.equal(hasReference([nodeRef('n1', '/a.png')], { nodeId: 'n2' }), false)
})

test('hasReference is empty-safe and never matches across channels', () => {
  assert.equal(hasReference([], { path: '/a.png' }), false)
  // A canvas reference also matches a path query: same file, different entry.
  assert.equal(hasReference([nodeRef('n1', '/a.png')], { path: '/a.png' }), true)
  // An asset reference has no node id, so a node-id query must not match it.
  assert.equal(hasReference([assetRef('/a.png')], { nodeId: 'n1' }), false)
  // A key with neither channel matches nothing.
  assert.equal(hasReference([assetRef('/a.png')], {}), false)
})

