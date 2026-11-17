/**
 * Canvas geometry tests.
 *
 * The panel's camera is the one piece of the Studio that fails *quietly*: a
 * wrong divide by `zoom` still draws something, just not under the pointer, and
 * nobody writes a bug report for "the node lagged a bit". So the arithmetic is
 * asserted here rather than eyeballed in a browser.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
  CANVAS_NODE_HEIGHT,
  CANVAS_NODE_WIDTH,
  IMAGE_AREA_HEIGHT,
  MAX_NODE_WIDTH,
  MIN_NODE_WIDTH,
  VIEWPORT_CULL_MARGIN,
  buildEdges,
  centerOn,
  clampZoom,
  edgeBounds,
  edgePath,
  fitCamera,
  nextNodeSpot,
  nodeDisplaySize,
  nodeIndex,
  panBy,
  rectsIntersect,
  screenToWorld,
  visibleEdges,
  visibleNodes,
  visibleWorldRect,
  worldToScreen,
  zoomAt,
  zoomLabel,
} from '../testlib/studio-canvas.js'

test('screen and world conversions are inverse at every zoom', () => {
  // The extremes are the clamped bounds themselves (DD8: 0.1–4), so a silent
  // change to either constant shows up here as a conversion that no longer maps
  // back rather than as a zoom that merely feels wrong in the browser.
  for (const zoom of [0.1, 0.75, 1, 1.8, 4]) {
    const camera = { x: -120, y: 48, zoom }
    for (const point of [{ x: 0, y: 0 }, { x: 37, y: -19 }, { x: 512.5, y: 300 }]) {
      const round = worldToScreen(camera, screenToWorld(camera, point))
      assert.ok(Math.abs(round.x - point.x) < 1e-9, `x at zoom ${String(zoom)}`)
      assert.ok(Math.abs(round.y - point.y) < 1e-9, `y at zoom ${String(zoom)}`)
    }
  }
})

test('zooming keeps the world point under the cursor pinned', () => {
  const camera = { x: -80, y: 30, zoom: 0.9 }
  const anchor = { x: 240, y: 160 }
  const before = screenToWorld(camera, anchor)
  const zoomed = zoomAt(camera, 1.4, anchor)
  const after = screenToWorld(zoomed, anchor)
  assert.ok(Math.abs(after.x - before.x) < 1e-6, 'the anchor must not slide horizontally')
  assert.ok(Math.abs(after.y - before.y) < 1e-6, 'the anchor must not slide vertically')
  assert.equal(zoomed.zoom, 0.9 * 1.4)
})

test('zoom is clamped, and a clamped zoom is a no-op rather than a jump', () => {
  // DD8: the supported range is 0.1–4, spelled out as literals so this test fails
  // on the constant itself, not only on the code that uses it.
  assert.equal(CANVAS_MIN_ZOOM, 0.1, 'zoom floor')
  assert.equal(CANVAS_MAX_ZOOM, 4, 'zoom ceiling')
  assert.equal(clampZoom(0.05), 0.1, 'below the floor clamps to the floor')
  assert.equal(clampZoom(99), CANVAS_MAX_ZOOM)
  assert.equal(clampZoom(0), CANVAS_MIN_ZOOM)
  assert.equal(clampZoom(Number.NaN), 1)

  const atMax = { x: 10, y: 10, zoom: CANVAS_MAX_ZOOM }
  assert.deepEqual(zoomAt(atMax, 2, { x: 100, y: 100 }), atMax, 'zooming past the ceiling must not pan')

  const atMin = { x: 10, y: 10, zoom: CANVAS_MIN_ZOOM }
  assert.deepEqual(zoomAt(atMin, 0.5, { x: 100, y: 100 }), atMin, 'zooming past the floor must not pan either')
})

test('panning converts a screen delta through the zoom', () => {
  const camera = { x: 0, y: 0, zoom: 2 }
  // Dragging 40 screen px right at 2× moves the camera 20 world units left.
  assert.deepEqual(panBy(camera, { x: 40, y: -10 }), { x: -20, y: 5, zoom: 2 })
})

test('fit frames every node and centres it', () => {
  const rects = [
    { x: 0, y: 0, width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT },
    { x: 400, y: 100, width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT },
  ]
  const viewport = { width: 800, height: 400 }
  const camera = fitCamera(rects, viewport, 40)

  // Content spans x 0…608, y 0…340; with padding the box is 688×420, so the
  // height is the binding constraint.
  assert.ok(camera.zoom <= 400 / 420 + 1e-9)
  const left = worldToScreen(camera, { x: 0, y: 0 })
  const right = worldToScreen(camera, { x: 608, y: 340 })
  assert.ok(left.x >= -1, 'content must not start off-screen')
  assert.ok(right.x <= viewport.width + 1, 'content must not end off-screen')
  // Centred: margins on both sides are equal within a pixel.
  const leftMargin = left.x
  const rightMargin = viewport.width - right.x
  assert.ok(Math.abs(leftMargin - rightMargin) < 1.5)
})

test('fit on an empty canvas does not move the view', () => {
  assert.deepEqual(fitCamera([], { width: 800, height: 400 }), { x: 0, y: 0, zoom: 1 })
})

test('a large board fits below the old 0.3 floor instead of being cut off', () => {
  // The reason the floor moved (DD8). This board spans 3480×2240 world units; in
  // an 800×400 viewport it needs ≈0.17, which the old clamp truncated to 0.3 —
  // the far column and the bottom row then sat outside the viewport with no way
  // to frame them.
  const far = { x: 3000, y: 2000, width: MAX_NODE_WIDTH, height: CANVAS_NODE_HEIGHT }
  const viewport = { width: 800, height: 400 }
  const camera = fitCamera([{ x: 0, y: 0, width: MAX_NODE_WIDTH, height: CANVAS_NODE_HEIGHT }, far], viewport)

  assert.ok(camera.zoom < 0.3, 'the new floor lets the whole board fit')
  assert.ok(camera.zoom >= CANVAS_MIN_ZOOM, 'and never dips below the floor')
  const right = worldToScreen(camera, { x: far.x + far.width, y: 0 })
  const bottom = worldToScreen(camera, { x: 0, y: far.y + far.height })
  assert.ok(right.x <= viewport.width + 1, 'the far edge is on screen, not clipped away')
  assert.ok(bottom.y <= viewport.height + 1, 'the bottom row is on screen')
})

test('a new node lands to the right of the last one, never on top', () => {
  assert.deepEqual(nextNodeSpot([]), { x: 0, y: 0 })
  const first = { x: 0, y: 0, width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT }
  const spot = nextNodeSpot([first])
  assert.equal(spot.y, 0, 'the new node keeps the top edge of the row')
  assert.ok(spot.x >= CANVAS_NODE_WIDTH, 'the new node must clear the previous one')
})

test('an edge runs from the right edge of one node to the left edge of the next', () => {
  // D8: the right edge is wherever that picture's ratio puts it. A 1:1 result is
  // 200 world units wide and no longer lands on the old fixed 208 anchor; a 16:9
  // one starts its outgoing edge 356 out, and a 9:16 target keeps its own left
  // edge. `edgePath` itself only ever sees the rectangle.
  const square = nodeDisplaySize(1024, 1024)
  const portrait = nodeDisplaySize(1080, 1920)
  const from = { x: 0, y: 0, width: square.width, height: square.height }
  const to = { x: 400, y: 0, width: portrait.width, height: portrait.height }
  assert.equal(square.width, 200, 'a 1:1 node is 200 wide, not the default 208')

  const path = edgePath(from, to)
  assert.match(path, /^M 200 120 C /, 'starts at the right edge of the square node, vertically centred')
  assert.match(path, /400 120$/, 'ends at the left edge of the target, vertically centred')

  const wide = nodeDisplaySize(2560, 1440)
  assert.match(
    edgePath({ x: 0, y: 0, width: wide.width, height: wide.height }, to),
    /^M 356 120 C /,
    'a 16:9 node anchors its edge at its real width',
  )
})

test('the zoom label rounds to whole percent', () => {
  assert.equal(zoomLabel(1), '100%')
  assert.equal(zoomLabel(0.333), '33%')
  assert.equal(zoomLabel(2.5), '250%')
  // The ends of the new range (DD8), so the toolbar never shows "10.000000000000002%".
  assert.equal(zoomLabel(CANVAS_MIN_ZOOM), '10%')
  assert.equal(zoomLabel(CANVAS_MAX_ZOOM), '400%')
})

// --- Node geometry (D8): an image node is as wide as its picture wants. ------

test('every official aspect ratio gets its documented node width', () => {
  // [image width, image height, expected node width] — the seven ratios the
  // request path can actually produce (CANVAS-DESIGN §3.4).
  const ratios = [
    [1024, 1024, 200], // 1:1
    [1248, 936, 267], // 4:3
    [768, 1024, 150], // 3:4
    [1536, 1024, 300], // 3:2
    [832, 1248, 133], // 2:3
    [2560, 1440, 356], // 16:9
    [1080, 1920, 113], // 9:16
  ]
  for (const [width, height, expected] of ratios) {
    const size = nodeDisplaySize(width, height)
    assert.equal(size.width, expected, `${String(width)}×${String(height)} node width`)
    assert.equal(size.height, CANVAS_NODE_HEIGHT, 'height is the same for every ratio')
  }
})

test('a wide picture widens the node, a tall one narrows it, never both', () => {
  const wide = nodeDisplaySize(1600, 800)
  const tall = nodeDisplaySize(800, 1600)
  assert.ok(wide.width > CANVAS_NODE_WIDTH, 'landscape must be wider than the default box')
  assert.ok(tall.width < CANVAS_NODE_WIDTH, 'portrait must be narrower than the default box')
  assert.equal(wide.width, 400, '200 × 2')
  assert.equal(tall.width, 100, '200 × 0.5')
  assert.equal(wide.height, tall.height, 'only the width follows the ratio')
})

test('extreme ratios clamp to the width band instead of stretching the board', () => {
  // A long strip: 200 × (100 / 10000) rounds to 2, far below legibility.
  const strip = nodeDisplaySize(100, 10000)
  assert.equal(strip.width, MIN_NODE_WIDTH, 'a tall strip clamps to the minimum width')
  // A panorama: 200 × (10000 / 100) is 20000, wide enough to break the row.
  const panorama = nodeDisplaySize(10000, 100)
  assert.equal(panorama.width, MAX_NODE_WIDTH, 'a panorama clamps to the maximum width')
  assert.equal(strip.height, CANVAS_NODE_HEIGHT, 'clamping width must not change height')
  assert.equal(panorama.height, CANVAS_NODE_HEIGHT, 'clamping width must not change height')
  // Negative "width" for assets whose height unit is absurdly small still clamps.
  assert.equal(nodeDisplaySize(1, 100000).width, MIN_NODE_WIDTH)
  assert.equal(nodeDisplaySize(100000, 1).width, MAX_NODE_WIDTH)
})

test('an entry with an unknown size falls back to the plain node box', () => {
  const fallback = { width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT }
  for (const [width, height] of [
    [0, 100],
    [100, 0],
    [0, 0],
    [-10, 100],
    [100, -10],
    [Number.NaN, 100],
    [100, Number.NaN],
    [Number.POSITIVE_INFINITY, 100],
  ]) {
    assert.deepEqual(nodeDisplaySize(width, height), fallback, `${String(width)}×${String(height)} must not throw`)
  }
})

test('a task node is the plain default box, so the landing grid needs no special case', () => {
  // C11 §3.2: a task node is fixed 208×240 — deliberately the same box that
  // `nodeDisplaySize` falls back to for an unmeasured picture. That is why
  // `nextNodeSpot` and the edge anchors clear it without knowing its kind.
  assert.equal(CANVAS_NODE_WIDTH, 208)
  assert.equal(CANVAS_NODE_HEIGHT, 240)
  assert.deepEqual(nodeDisplaySize(0, 0), { width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT })
})

test('the picture area plus the caption chrome is the node height', () => {
  assert.equal(IMAGE_AREA_HEIGHT, 200, 'the picture keeps the height it has always had')
  assert.equal(CANVAS_NODE_HEIGHT - IMAGE_AREA_HEIGHT, 40, 'meta + actions row')
  assert.equal(nodeDisplaySize(1, 1).height, IMAGE_AREA_HEIGHT + 40)
})

test('widened nodes still land side by side without overlapping', () => {
  const panorama = nodeDisplaySize(10000, 100) // the widest a node can get
  const square = nodeDisplaySize(1024, 1024)
  const rects = [
    { x: 0, y: 0, width: square.width, height: square.height },
    { x: 300, y: 0, width: panorama.width, height: panorama.height },
  ]
  const spot = nextNodeSpot(rects)
  assert.equal(spot.y, 0, 'the new node keeps the top edge of the row')
  assert.equal(spot.x, 300 + panorama.width + 40, 'placement clears the widest node, not the default one')
  for (const rect of rects) {
    assert.ok(spot.x >= rect.x + rect.width, 'a new node must never land on top of an existing one')
  }
  assert.ok(spot.x >= MAX_NODE_WIDTH + 40, 'placement accounts for the clamped maximum width')
})


/* -------------------------------------------------------------------------- */
/* C07: viewport culling, the edge index, and the pure half of the throttle    */
/* -------------------------------------------------------------------------- */

/** A render-layer node rect, the shape `visibleNodes`/`buildEdges` take. */
function node(id, x, y, parents = []) {
  return { id, parents, x, y, width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT }
}

test('the visible world rect is the viewport divided by zoom, grown by the margin', () => {
  assert.equal(VIEWPORT_CULL_MARGIN, 256, 'the pre-render margin is the documented 256 world units')
  const camera = { x: 100, y: 200, zoom: 1 }
  const viewport = { width: 900, height: 600 }
  assert.deepEqual(visibleWorldRect(camera, viewport), {
    x: 100 - 256,
    y: 200 - 256,
    width: 900 + 512,
    height: 600 + 512,
  })
  // Zoom scales how much world one pixel covers; the camera origin does not move.
  const out = visibleWorldRect({ ...camera, zoom: 0.1 }, viewport)
  assert.equal(out.width, 9000 + 512)
  assert.equal(out.height, 6000 + 512)
  const inn = visibleWorldRect({ ...camera, zoom: 4 }, viewport)
  assert.equal(inn.width, 225 + 512)
  assert.equal(inn.height, 150 + 512)
  // A zero margin is legal: culling to exactly the viewport, no pre-render.
  assert.equal(visibleWorldRect(camera, viewport, 0).width, 900)
})

test('a node inside the margin renders, one that only touches the boundary does not', () => {
  const camera = { x: 0, y: 0, zoom: 1 }
  const viewport = { width: 800, height: 600 }
  const world = visibleWorldRect(camera, viewport)
  const left = world.x
  const right = world.x + world.width
  // Touching is not overlapping — the same rule the marquee uses, so a node on
  // the cull boundary and a node on the marquee boundary behave alike.
  assert.equal(visibleNodes([node('touch-l', left - CANVAS_NODE_WIDTH, 0)], camera, viewport).length, 0)
  assert.equal(visibleNodes([node('inside-l', left - CANVAS_NODE_WIDTH + 1, 0)], camera, viewport).length, 1)
  assert.equal(visibleNodes([node('touch-r', right, 0)], camera, viewport).length, 0)
  assert.equal(visibleNodes([node('inside-r', right - 1, 0)], camera, viewport).length, 1)
})

test('an empty board and an unmeasured viewport both fall through to "render"', () => {
  const camera = { x: 0, y: 0, zoom: 1 }
  assert.deepEqual(visibleNodes([], camera, { width: 800, height: 600 }), [])
  // Before the browser has measured the element there is no honest viewport to
  // cull against: culling must never blank the canvas for the first frame.
  const all = [node('a', 0, 0), node('b', 9000, 9000)]
  assert.equal(visibleNodes(all, camera, { width: 0, height: 0 }).length, 2)
  const unbounded = visibleWorldRect(camera, { width: 0, height: 0 })
  assert.equal(rectsIntersect(all[1], unbounded), true, 'an unmeasured viewport is unbounded')
})

test('the visible set follows the zoom extremes, not just the middle of the range', () => {
  const viewport = { width: 1000, height: 600 }
  const nodes = [node('near', 0, 0), node('far', 5000, 0)]
  assert.deepEqual(visibleNodes(nodes, { x: 0, y: 0, zoom: 1 }, viewport).map((entry) => entry.id), ['near'])
  // At the 0.1 floor the same screen shows 10000 world units of board.
  assert.deepEqual(visibleNodes(nodes, { x: 0, y: 0, zoom: 0.1 }, viewport).map((entry) => entry.id), ['near', 'far'])
  // At the 4x ceiling the world window is 250 + 2×256 = 762 wide.
  assert.deepEqual(visibleNodes(nodes, { x: 0, y: 0, zoom: 4 }, viewport).map((entry) => entry.id), ['near'])
  assert.deepEqual(visibleNodes([node('past', 520, 0)], { x: 0, y: 0, zoom: 4 }, viewport).map((entry) => entry.id), [])
})

test('the edge index resolves each parent with one lookup instead of a board scan', () => {
  const nodes = [node('a', 0, 0), node('b', 300, 0, ['a']), node('c', 600, 0, ['a', 'b'])]
  let lookups = 0
  class CountingMap extends Map {
    get(key) {
      lookups += 1
      return super.get(key)
    }
  }
  const index = new CountingMap(nodes.map((entry) => [entry.id, entry]))
  const edges = buildEdges(nodes, index)
  assert.deepEqual(edges.map((edge) => `${edge.parent}->${edge.child}`), ['a->b', 'a->c', 'b->c'])
  // Three parent links, three hash hits. The old inner `nodes.find` was n
  // comparisons *per link*, which is the O(n×parents) this task removes.
  assert.equal(lookups, 3)
})

test('an edge whose parent is not on the board is dropped, not thrown', () => {
  const nodes = [node('orphan', 0, 0, ['gone-from-another-board'])]
  assert.deepEqual(buildEdges(nodes, nodeIndex(nodes)), [])
  assert.deepEqual(buildEdges([], new Map()), [])
})

test('the node index keeps the first of a duplicated id, like find did', () => {
  const index = nodeIndex([node('a', 0, 0), node('a', 500, 100)])
  assert.equal(index.size, 1)
  assert.equal(index.get('a').x, 0)
})

test('an edge draws when an endpoint is visible or when the wire crosses the viewport', () => {
  const world = visibleWorldRect({ x: 0, y: 0, zoom: 1 }, { width: 800, height: 600 })
  const near = { x: 0, y: 0, width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT }
  const far = { x: 9000, y: 0, width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT }
  const farLeft = { x: -9000, y: 400, width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT }
  const edge = (from, to) => ({ child: 'c', parent: 'p', from, to })
  // One endpoint on screen.
  assert.equal(visibleEdges([edge(near, far)], world).length, 1)
  // Both endpoints off-screen but the wire runs through the viewport — this is
  // what keeps a long blood-line from blinking out in the middle of a pan.
  assert.equal(visibleEdges([edge(farLeft, far)], world).length, 1)
  // Both endpoints off-screen and the wire nowhere near it.
  const highLeft = { x: -9000, y: -9000, width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT }
  const highRight = { x: 9000, y: -9000, width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT }
  assert.equal(visibleEdges([edge(highLeft, highRight)], world).length, 0)
  assert.deepEqual(visibleEdges([], world), [])
})

test('a level wire keeps a body to be culled by, or it vanishes edge-on', () => {
  // Two nodes at the same height give a mathematically zero-height curve; a
  // zero-area rectangle never intersects, so the box is padded into a wire.
  const from = { x: -9000, y: 400, width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT }
  const to = { x: 9000, y: 400, width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT }
  const box = edgeBounds(from, to)
  assert.ok(box.height > 0, 'a level wire needs a thickness to intersect with')
  assert.ok(box.width > 17000, 'the box spans both endpoints')
  const world = visibleWorldRect({ x: 0, y: 0, zoom: 1 }, { width: 800, height: 600 })
  assert.equal(visibleEdges([{ child: 'c', parent: 'p', from, to }], world).length, 1)
})

test('the edge box contains the curve even when the wire runs backwards', () => {
  const from = { x: 600, y: 0, width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT }
  const to = { x: 0, y: 500, width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT }
  const box = edgeBounds(from, to)
  // Anchors: (from right edge, mid-height) = (808, 120) and (to left edge) = (0, 620).
  assert.ok(box.x <= 0, 'the box reaches past the left anchor')
  assert.ok(box.y <= 120, 'and above the higher anchor')
  assert.ok(box.x + box.width >= 808, 'and past the right anchor')
  assert.ok(box.y + box.height >= 620, 'and below the lower one')
})

test('a 1000-node board culls to the visible count and indexes every parent once', () => {
  const nodes = []
  for (let i = 0; i < 1000; i += 1) {
    nodes.push(node(`n${String(i)}`, (i % 20) * 300, Math.floor(i / 20) * 300, i === 0 ? [] : [`n${String(i - 1)}`]))
  }
  let lookups = 0
  class CountingMap extends Map {
    get(key) {
      lookups += 1
      return super.get(key)
    }
  }
  const index = new CountingMap(nodes.map((entry) => [entry.id, entry]))
  const edges = buildEdges(nodes, index)
  assert.equal(edges.length, 999, 'a chain of 1000 nodes has 999 edges')
  assert.equal(lookups, 999, 'one hash hit per parent link, never a board scan')

  // 20 columns × 50 rows at a 300 pitch, 1200×800 viewport at zoom 1 with the
  // 256 margin: world x ∈ [-256, 1456] (columns 0-4), y ∈ [-256, 1056] (rows 0-3).
  const shown = visibleNodes(nodes, { x: 0, y: 0, zoom: 1 }, { width: 1200, height: 800 })
  assert.equal(shown.length, 20)
  assert.ok(shown.length < nodes.length / 10, 'the render layer must not see the whole board')

  // Panning moves the window instead of growing it: x is [1244, 2956] (columns
  // 4-9) and y is [1244, 2556] (rows 4-8), so 6 x 5 = 30 nodes.
  const panned = visibleNodes(nodes, { x: 1500, y: 1500, zoom: 1 }, { width: 1200, height: 800 })
  assert.equal(panned.length, 30)
  assert.notDeepEqual(panned.map((entry) => entry.id), shown.map((entry) => entry.id))
})

test('centerOn puts a world point at the viewport centre and keeps the zoom', () => {
  const viewport = { width: 800, height: 600 }
  // C12 §7.4: "定位" must travel to the node, not only select it.
  const camera = centerOn({ x: 100, y: 50 }, viewport, 2)
  assert.deepEqual(camera, { x: 100 - 200, y: 50 - 150, zoom: 2 })
  // The point maps back to exactly the viewport centre under that camera —
  // the inverse is what makes the jump land where it claims to.
  assert.deepEqual(worldToScreen(camera, { x: 100, y: 50 }), { x: 400, y: 300 })

  // The user's scale survives the jump...
  assert.equal(centerOn({ x: 0, y: 0 }, viewport, 0.5).zoom, 0.5)
  // ...and an unusable zoom falls back to 1 instead of dividing by zero.
  assert.deepEqual(centerOn({ x: 0, y: 0 }, viewport, 0), { x: -400, y: -300, zoom: 1 })
  assert.deepEqual(centerOn({ x: 0, y: 0 }, viewport, Number.NaN), { x: -400, y: -300, zoom: 1 })
})
