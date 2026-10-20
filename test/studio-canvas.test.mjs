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
  clampZoom,
  edgePath,
  fitCamera,
  nextNodeSpot,
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
