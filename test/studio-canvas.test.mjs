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
  clampZoom,
  edgePath,
  fitCamera,
  nextNodeSpot,
  nodeDisplaySize,
  panBy,
  screenToWorld,
  worldToScreen,
  zoomAt,
  zoomLabel,
} from '../testlib/studio-canvas.js'

test('screen and world conversions are inverse at every zoom', () => {
  for (const zoom of [0.3, 0.75, 1, 1.8, 2.5]) {
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
  assert.equal(clampZoom(99), CANVAS_MAX_ZOOM)
  assert.equal(clampZoom(0), CANVAS_MIN_ZOOM)
  assert.equal(clampZoom(Number.NaN), 1)

  const atMax = { x: 10, y: 10, zoom: CANVAS_MAX_ZOOM }
  assert.deepEqual(zoomAt(atMax, 2, { x: 100, y: 100 }), atMax, 'zooming past the ceiling must not pan')
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

test('a new node lands to the right of the last one, never on top', () => {
  assert.deepEqual(nextNodeSpot([]), { x: 0, y: 0 })
  const first = { x: 0, y: 0, width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT }
  const spot = nextNodeSpot([first])
  assert.equal(spot.y, 0, 'the new node keeps the top edge of the row')
  assert.ok(spot.x >= CANVAS_NODE_WIDTH, 'the new node must clear the previous one')
})

test('an edge runs from the right edge of one node to the left edge of the next', () => {
  const from = { x: 0, y: 0, width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT }
  const to = { x: 400, y: 0, width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT }
  const path = edgePath(from, to)
  assert.match(path, /^M 208 120 C /, 'starts at the right edge, vertically centred')
  assert.match(path, /400 120$/, 'ends at the left edge, vertically centred')
})

test('the zoom label rounds to whole percent', () => {
  assert.equal(zoomLabel(1), '100%')
  assert.equal(zoomLabel(0.333), '33%')
  assert.equal(zoomLabel(2.5), '250%')
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

