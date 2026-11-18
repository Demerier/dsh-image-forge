/**
 * The drag-a-wire state machine (`src/canvas-connections.ts`).
 *
 * The gesture itself — pointer capture, a preview path repainting under the
 * pointer — has no automation in this project (§14.5), so what the gesture
 * *decides* is pinned down here: when a press becomes a drag, which node a
 * release lands on, what each of the three landing spots means, and what a
 * cancelled gesture must not do.
 *
 * The module is imported straight from `src/`; the import succeeding is the
 * zero-DOM assertion, because Node strips the types and would throw on anything
 * that reached for `document`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONNECT_THRESHOLD,
  CONNECT_TARGETS,
  HANDLE_SCREEN_HIT,
  HANDLE_SCREEN_SIZE,
  beginConnection,
  connectMenuItems,
  connectionAnchor,
  handleHitRadius,
  handleWorldSize,
  linkParents,
  nodeUnderPoint,
  previewPath,
  reaches,
  resolveDrop,
  screenToWorldLength,
  updateConnection,
} from '../src/canvas-connections.ts'

/** A node rect; picture nodes are 200×240 and sit where the board put them. */
const rect = (id, x, y, width = 200, height = 240) => ({ id, x, y, width, height })

/** A connection node carrying lineage, for the cycle tests. */
const linked = (id, x, y, parents = []) => ({ ...rect(id, x, y), parents })

/** The three-node row the wiring harness uses: 0–200, 600–800, 1200–1400. */
const ROW = [rect('iaaa1', 0, 0), rect('ibbb2', 600, 0), rect('iccc3', 1200, 0)]

/** Press the source's handle at the given world/screen point. */
function press(source, point = { x: 200, y: 120 }, screen = { x: 200, y: 120 }) {
  return beginConnection({ source, point, screen })
}

test('the output handle is the right edge midpoint, in world units', () => {
  // The wire has to start where the dot is painted, and the dot is positioned by
  // the same rectangle the render uses — so this is geometry, not a magic number.
  assert.deepEqual(connectionAnchor(rect('a', 40, 100, 200, 240)), { x: 240, y: 220 })
  assert.deepEqual(connectionAnchor(rect('a', 0, 0, 96, 240)), { x: 96, y: 120 })
})

test('a press arms the gesture and draws nothing until the pointer really moves', () => {
  const state = press(ROW[0])
  assert.equal(state.phase, 'armed')
  assert.equal(state.sourceId, 'iaaa1')
  assert.deepEqual(state.anchor, { x: 200, y: 120 })
  assert.equal(state.targetId, undefined)
  // No preview line while armed: a plain click on a handle must stay quiet.
  assert.equal(previewPath(state, ROW), undefined)
})

test('a twitch below the threshold is still armed, and cancels on release', () => {
  const state = press(ROW[0])
  const nearly = updateConnection(state, {
    point: { x: 202, y: 120 },
    screen: { x: 202, y: 120 },
    nodes: ROW,
  })
  assert.equal(nearly.phase, 'armed', 'two screen pixels is not a drag')
  assert.deepEqual(resolveDrop(nearly, ROW), { kind: 'cancel' }, 'a click on a handle creates nothing')
})

test('the threshold is screen pixels, so the same twitch behaves the same at any zoom', () => {
  // At zoom 0.5 one screen pixel is two world units: a world-distance threshold
  // would need twice the travel here and the gesture would feel different at
  // every zoom. Four screen pixels is four screen pixels.
  const state = press(ROW[0])
  const half = updateConnection(state, {
    point: { x: 204, y: 120 },
    screen: { x: 204, y: 120 },
    nodes: ROW,
  })
  assert.equal(half.phase, 'blank', `a ${String(CONNECT_THRESHOLD)}-px move off the source is a drag`)
  assert.equal(previewPath(half, ROW).startsWith('M 200 120'), true, 'and from then on a wire is drawn')
  const short = updateConnection(press(ROW[0]), {
    point: { x: 203, y: 120 },
    screen: { x: 203, y: 120 },
    nodes: ROW,
  })
  assert.equal(short.phase, 'armed')
})

test('dragging over a node hovers it and dragging off it is blank', () => {
  const dragging = updateConnection(press(ROW[0]), {
    point: { x: 610, y: 120 },
    screen: { x: 610, y: 120 },
    nodes: ROW,
  })
  assert.equal(dragging.phase, 'hoverTarget')
  assert.equal(dragging.targetId, 'ibbb2')

  const blank = updateConnection(dragging, {
    point: { x: 400, y: 120 },
    screen: { x: 400, y: 120 },
    nodes: ROW,
  })
  assert.equal(blank.phase, 'blank')
  assert.equal(blank.targetId, undefined, 'the previous hover must not stick')
})

test('the source is never its own target, and a gap between nodes is blank', () => {
  // Dragging back over the node the wire came from is `dragging`, not `blank`:
  // it cancels on release instead of offering to build a child on top of its own
  // parent. That is the difference between "put it back" and "build here".
  const back = updateConnection(press(ROW[0]), {
    point: { x: 100, y: 120 },
    screen: { x: 100, y: 120 },
    nodes: ROW,
  })
  assert.equal(back.phase, 'dragging')
  assert.deepEqual(resolveDrop(back, ROW.map((node) => ({ ...node, parents: [] }))), { kind: 'cancel' })
  // A point between two nodes touches neither (the marquee's positive-area rule).
  assert.equal(nodeUnderPoint(ROW, { x: 300, y: 120 }), undefined)
  // Exactly on the left edge of a node is inside it.
  assert.equal(nodeUnderPoint(ROW, { x: 600, y: 0 })?.id, 'ibbb2')
})

test('the topmost node wins when two overlap, because it paints last', () => {
  const overlapping = [rect('under', 0, 0), rect('over', 50, 50)]
  assert.equal(nodeUnderPoint(overlapping, { x: 100, y: 100 })?.id, 'over')
  // Input order is not consulted beyond that: reversing it reverses the answer.
  assert.equal(nodeUnderPoint([...overlapping].reverse(), { x: 100, y: 100 })?.id, 'under')
})

test('the preview is the edge cubic, and it plugs into the target input', () => {
  const state = press(ROW[0])
  // Over blank canvas the wire ends at the pointer.
  const dragging = updateConnection(state, {
    point: { x: 400, y: 200 },
    screen: { x: 400, y: 200 },
    nodes: ROW,
  })
  assert.equal(previewPath(dragging, ROW), 'M 200 120 C 290 120, 310 200, 400 200')
  // Over a node it snaps to that node's left edge midpoint — the anchor a
  // committed edge uses, so release does not make the wire jump.
  const hovering = updateConnection(state, {
    point: { x: 610, y: 160 },
    screen: { x: 610, y: 160 },
    nodes: ROW,
  })
  assert.equal(previewPath(hovering, ROW), 'M 200 120 C 380 120, 420 120, 600 120')
})

test('a release over a node commits an edge, and never anything else', () => {
  const hovering = updateConnection(press(ROW[0]), {
    point: { x: 700, y: 100 },
    screen: { x: 700, y: 100 },
    nodes: ROW,
  })
  assert.deepEqual(resolveDrop(hovering, [linked('iaaa1', 0, 0), linked('ibbb2', 600, 0), linked('iccc3', 1200, 0)]), {
    kind: 'edge',
    toId: 'ibbb2',
  })
})

test('a release on blank canvas asks what to create, at the release point', () => {
  const dragging = updateConnection(press(ROW[0]), {
    point: { x: 400, y: 300 },
    screen: { x: 400, y: 300 },
    nodes: ROW,
  })
  assert.deepEqual(resolveDrop(dragging, ROW.map((node) => ({ ...node, parents: [] }))), {
    kind: 'menu',
    worldPoint: { x: 400, y: 300 },
  })
})

test('a drop that would close a lineage cycle is refused', () => {
  // iaaa1 came from ibbb2; drawing iaaa1 → ibbb2 would make both its own
  // ancestor, which no reader of the board can interpret.
  const nodes = [linked('iaaa1', 0, 0, ['ibbb2']), linked('ibbb2', 600, 0)]
  const hovering = updateConnection(press(nodes[0], { x: 200, y: 120 }), {
    point: { x: 700, y: 100 },
    screen: { x: 700, y: 100 },
    nodes,
  })
  assert.deepEqual(resolveDrop(hovering, nodes), { kind: 'cancel' })
  // The other direction is fine: the child has no child of its own.
  const forward = updateConnection(press(nodes[1], { x: 800, y: 120 }), {
    point: { x: 100, y: 100 },
    screen: { x: 100, y: 100 },
    nodes,
  })
  assert.deepEqual(resolveDrop(forward, nodes), { kind: 'edge', toId: 'iaaa1' })
})

test('reaches walks the parents chain, tolerates off-board ids and stops on loops', () => {
  const nodes = [
    linked('a', 0, 0, []),
    linked('b', 0, 0, ['a']),
    linked('c', 0, 0, ['b', 'elsewhere']),
  ]
  assert.equal(reaches(nodes, 'c', 'a'), true, 'a grandparent is an ancestor')
  assert.equal(reaches(nodes, 'a', 'c'), false)
  assert.equal(reaches(nodes, 'a', 'a'), true, 'identity counts, so self-links are refused')
  assert.equal(reaches(nodes, 'c', 'nowhere'), false)
  // A pre-existing loop in stored data must not hang the gesture.
  assert.equal(reaches([linked('x', 0, 0, ['y']), linked('y', 0, 0, ['x'])], 'x', 'z'), false)
})

test('a second drop of the same wire is a no-op the view can detect', () => {
  const parents = ['iaaa1']
  // Same array back: identity is the "nothing changed" signal, so a re-drop
  // does not push a dead step onto the undo stack.
  assert.equal(linkParents(parents, 'iaaa1'), parents)
  assert.deepEqual(linkParents([], 'iaaa1'), ['iaaa1'])
  const extended = linkParents(parents, 'ibbb2')
  assert.deepEqual(extended, ['iaaa1', 'ibbb2'])
  assert.deepEqual(parents, ['iaaa1'], 'the argument is never mutated')
  // A blank parent id is not an edge.
  const empty = []
  assert.equal(linkParents(empty, ''), empty)
})

test('the drop menu offers the three node kinds, with 放入素材 still greyed out', () => {
  const items = connectMenuItems()
  assert.deepEqual(items.map((item) => item.id), [...CONNECT_TARGETS])
  assert.deepEqual(items.map((item) => item.label), ['图片生成', '布局', '放入素材'])
  assert.deepEqual(items.filter((item) => item.disabled !== true).map((item) => item.id), ['image', 'layout'])
  // The disabled one says why, instead of vanishing between releases.
  assert.ok(items[2].hint.includes('尚未接线'))
})

test('an idle gesture is inert: no preview, no drop, no state change', () => {
  const idle = { phase: 'idle', sourceId: 'a', anchor: { x: 0, y: 0 }, originScreen: { x: 0, y: 0 }, point: { x: 0, y: 0 } }
  assert.equal(previewPath(idle, ROW), undefined)
  assert.deepEqual(resolveDrop(idle, ROW), { kind: 'cancel' })
  assert.equal(updateConnection(idle, { point: { x: 9, y: 9 }, screen: { x: 9, y: 9 }, nodes: ROW }), idle)
})

test('every transition returns a fresh state and leaves the old one intact', () => {
  const armed = press(ROW[0])
  const dragging = updateConnection(armed, { point: { x: 700, y: 100 }, screen: { x: 700, y: 100 }, nodes: ROW })
  assert.notEqual(dragging, armed)
  assert.equal(armed.phase, 'armed', 'the armed state is frozen, so a replayed move is exact')
  assert.equal(armed.targetId, undefined)
  const blank = updateConnection(dragging, { point: { x: 400, y: 100 }, screen: { x: 400, y: 100 }, nodes: ROW })
  assert.notEqual(blank, dragging)
  assert.equal(dragging.targetId, 'ibbb2')
})

// ---------------------------------------------------------------------------
// G27: the handle is a *screen* size, not a board size.
//
// The dot is painted inside the layer the camera scales. Sizing it in board
// units made it 1.1 px at the 10 % floor — the affordance existed and could not
// be hit. The rule that fixes it is one division, and this is the half of it
// that has no DOM: the stylesheet performs the same division with `calc()` and
// interpolates the same two constants, so what is asserted here is what ships.
// ---------------------------------------------------------------------------

test('the dot keeps one screen size, so its board size grows as the zoom shrinks', () => {
  // The three zooms that matter: the 10 % floor, the 1:1 default, and the 800 %
  // ceiling. The screen size never moves; the board size moves tenfold and then
  // the other way, which is exactly what the layer then scales back.
  assert.equal(handleWorldSize(0.1), 110)
  assert.equal(handleWorldSize(1), 11)
  assert.equal(handleWorldSize(8), 1.375)
  for (const zoom of [0.1, 1, 8]) {
    assert.ok(
      Math.abs(handleWorldSize(zoom) * zoom - HANDLE_SCREEN_SIZE) < 1e-9,
      `a ${String(HANDLE_SCREEN_SIZE)}-px dot must paint as ${String(HANDLE_SCREEN_SIZE)} px at ${String(zoom)}x`,
    )
  }
  // Three zooms, three different board sizes: a conversion that ignored the zoom
  // would pass the loop above only by being wrong three times identically.
  assert.equal(new Set([handleWorldSize(0.1), handleWorldSize(1), handleWorldSize(8)]).size, 3)
})

test('the click radius is converted the same way, and is wider than the dot', () => {
  // 8 screen px of tolerance is 80 board units at the floor and 1 at the ceiling.
  // A tolerance written in board units would be wrong at every zoom but one.
  assert.equal(handleHitRadius(0.1), 80)
  assert.equal(handleHitRadius(1), 8)
  assert.equal(handleHitRadius(8), 1)
  assert.equal(handleHitRadius(1) * 2, HANDLE_SCREEN_HIT)
  assert.ok(handleHitRadius(1) > HANDLE_SCREEN_SIZE / 2, 'the target is bigger than the dot')
})

test('both painted lengths sit in the 10–12 px band the design asks for', () => {
  // The dot is what the user aims at, so it has to be readable; the target is
  // what the browser hit-tests, so it is allowed to be invisible and generous.
  assert.ok(HANDLE_SCREEN_SIZE >= 10 && HANDLE_SCREEN_SIZE <= 12, 'the dot reads as a dot, not as a speck')
  assert.ok(HANDLE_SCREEN_HIT >= HANDLE_SCREEN_SIZE, 'the target is never smaller than the paint')
  assert.ok(HANDLE_SCREEN_HIT <= 16, 'and never so large that it swallows the node it sits on')
})

test('a missing or impossible zoom falls back to the camera floor, not to Infinity', () => {
  // The CSS variable falls back to 1 and the camera clamps to [10 %, 800 %]; a
  // caller that hands this function 0 / NaN / an out-of-range zoom must still get
  // a finite length, because an infinite target would swallow the whole canvas.
  const floor = screenToWorldLength(HANDLE_SCREEN_SIZE, 0.1)
  assert.equal(screenToWorldLength(HANDLE_SCREEN_SIZE, 0), floor)
  assert.equal(screenToWorldLength(HANDLE_SCREEN_SIZE, Number.NaN), floor)
  assert.equal(screenToWorldLength(HANDLE_SCREEN_SIZE, 0.01), floor, 'below the floor is the floor')
  assert.equal(screenToWorldLength(HANDLE_SCREEN_SIZE, -2), floor)
  assert.equal(handleWorldSize(99), 11 / 8, 'above the ceiling is the ceiling')
  assert.ok(Number.isFinite(handleHitRadius(0)))
})

