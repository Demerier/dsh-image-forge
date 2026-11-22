/**
 * The canvas mapping, asserted without a browser.
 *
 * U04 step 1b replaced the DOM canvas with React Flow. The renderer needs a real
 * DOM (measured viewport, `ResizeObserver`, pointer capture), so it cannot run in
 * this repository's Node harness — but the half that *decides* what is drawn can:
 * `src/canvas-flow-model.ts` is pure, and `src/canvas-pane.ts` exports the node
 * and edge registries React Flow dispatches on. This file asserts both, plus the
 * join between them (a model node's `type` must be a registered painter).
 *
 * What this file deliberately does **not** do is mount the flow. `FlowCanvas`
 * measures its container before mounting React Flow, and a container that cannot
 * be measured renders the "画布准备中…" placeholder instead — so a descriptor
 * walk here would assert the placeholder, not the canvas. That is why the
 * capabilities that need pixels (node DOM, edge paths, pointer gestures) are a
 * manual / ego-browser checklist in this phase; see the note at the top of
 * `test/studio.test.mjs` for the list and its reasons.
 *
 * @module test/canvas-flow-model
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
  CANVAS_NODE_HEIGHT,
  CANVAS_NODE_WIDTH,
  MAX_NODE_WIDTH,
  MIN_NODE_WIDTH,
  centerOn,
  screenToWorld,
  worldToScreen,
} from '../src/studio-canvas.ts'
import { CONNECT_THRESHOLD, linkParents } from '../src/canvas-connections.ts'
import {
  CommandStack,
  marqueeSelection,
  marqueeWorldRect,
  nodesInRect,
  snapshotCommand,
} from '../src/canvas-interactions.ts'
import {
  LAYOUT_NODE_DEFAULT_WIDTH,
  LAYOUT_NODE_MAX_WIDTH,
  LAYOUT_NODE_MIN_WIDTH,
  clampLayoutNodeWidth,
  draftToEditorState,
  layoutNodeHeight,
  stateToDraft,
} from '../src/layout-editor.ts'
import {
  EMPTY_FLOW_DRAG,
  FLOW_EDGE_TYPE_LINEAGE,
  FLOW_FIT_OPTIONS,
  FLOW_NODE_TYPE_DRAFT,
  FLOW_NODE_TYPE_IMAGE,
  FLOW_NODE_TYPE_LAYOUT,
  FLOW_NODE_TYPE_TASK,
  FLOW_SOURCE_HANDLE,
  FLOW_TARGET_HANDLE,
  FLOW_TASK_BADGES,
  CONNECT_SOURCE_KINDS,
  canAcceptConnection,
  canStartConnection,
  cameraFromFlow,
  connectionIsValid,
  connectionNodesOf,
  fitWouldClamp,
  fitZoomFor,
  flowInteractionProps,
  hasInboundHandle,
  flowModelFingerprint,
  flowNodeRects,
  flowViewportOf,
  flowViewportProps,
  foldDragChanges,
  imageMeta,
  imageTitle,
  initialFlowView,
  judgeConnection,
  nodeSizeOf,
  nodeTypeOf,
  planConnectionDrop,
  planReveal,
  reseedFlowNodes,
  reuseFlowNodes,
  taskNodeActions,
  taskParamsText,
  taskPercent,
  taskPromptLine,
  taskStatusText,
  toFlowModel,
} from '../src/canvas-flow-model.ts'
import {
  FLOW_EDGE_TYPES,
  FLOW_NODE_TYPES,
  LineageEdge,
  CanvasPane,
  FlowCanvas,
} from '../src/canvas-pane.ts'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** A finished picture, the way `src/studio-view.ts` hands one over. */
function imageNode(id, options = {}) {
  return {
    kind: 'image',
    id,
    x: options.x ?? 10,
    y: options.y ?? 20,
    parents: options.parents ?? [],
    prompt: options.prompt ?? '一只橘猫趴在窗台上\n第二行不该出现在标题里',
    image: {
      markdownPath: options.markdownPath ?? `C:/out/${id}.png`,
      width: options.width ?? 1024,
      height: options.height ?? 1024,
      bytes: options.bytes ?? 512 * 1024,
    },
  }
}

/** A generation task, in whatever state a case needs. */
function taskNode(id, options = {}) {
  return {
    kind: 'task',
    id,
    x: options.x ?? 0,
    y: options.y ?? 0,
    parents: options.parents ?? [],
    status: options.status ?? 'running',
    params: options.params ?? { prompt: '一张海报', ratio: '3:2', steps: 28, count: 2, seed: 42 },
    ...(options.progress === undefined ? {} : { progress: options.progress }),
    ...(options.error === undefined ? {} : { error: options.error }),
  }
}

/** A layout draft node. */
function layoutNode(id, options = {}) {
  const draft = options.draft ?? {
    width: 1536,
    height: 1024,
    bbox_coord_space: 'abs',
    bbox_format: 'xyxy',
    summary: { caption: '一张海报' },
    items: [{ label: 'object', caption: '猫', bbox: [0, 0, 10, 10] }],
  }
  return {
    kind: 'layout',
    id,
    x: options.x ?? 0,
    y: options.y ?? 0,
    parents: options.parents ?? [],
    w: options.w ?? LAYOUT_NODE_DEFAULT_WIDTH,
    h: options.h ?? layoutNodeHeight(options.w ?? LAYOUT_NODE_DEFAULT_WIDTH, draft),
    draft,
  }
}

/** The placeholder a wire drop creates. */
function draftNode(id, parents = []) {
  return { kind: 'draft', id, x: 0, y: 0, parents }
}

/* -------------------------------------------------------------------------- */
/* Kinds and geometry                                                         */
/* -------------------------------------------------------------------------- */

test('each node kind maps to its own React Flow type and default box', () => {
  const model = toFlowModel([imageNode('i1'), taskNode('t1'), layoutNode('l1'), draftNode('d1')])
  assert.deepEqual(
    model.nodes.map((node) => node.type),
    [FLOW_NODE_TYPE_IMAGE, FLOW_NODE_TYPE_TASK, FLOW_NODE_TYPE_LAYOUT, FLOW_NODE_TYPE_DRAFT],
    'the model names the four painters',
  )
  assert.deepEqual(model.counts, { image: 1, task: 1, layout: 1, draft: 1 })
  assert.equal(nodeTypeOf(draftNode('x')), FLOW_NODE_TYPE_DRAFT)

  // A task and a draft have no picture to measure: they are the default box.
  const task = model.nodes[1]
  assert.deepEqual([task.width, task.height], [CANVAS_NODE_WIDTH, CANVAS_NODE_HEIGHT])
  // A 1:1 picture wants a square, clamped to the 96–480 band.
  const image = model.nodes[0]
  assert.deepEqual([image.width, image.height], [200, CANVAS_NODE_HEIGHT])
  // A layout node is width-driven; its height follows the draft's proportion.
  const layout = model.nodes[2]
  assert.equal(layout.width, 480)
  assert.equal(layout.height, layoutNodeHeight(480, layoutNode('x').draft))
})

test('a picture keeps its aspect ratio inside the 96–480 band', () => {
  // 1024×256 is a 4:1 panorama: 200 world units of height want 800 wide.
  assert.deepEqual(nodeSizeOf(imageNode('wide', { width: 1024, height: 256 })), {
    width: MAX_NODE_WIDTH,
    height: CANVAS_NODE_HEIGHT,
  })
  // 256×2048 is a 1:8 strip: the ideal width is 25, below the floor.
  assert.deepEqual(nodeSizeOf(imageNode('tall', { width: 256, height: 2048 })), {
    width: MIN_NODE_WIDTH,
    height: CANVAS_NODE_HEIGHT,
  })
  // Corrupt dimensions fall back to the plain box instead of throwing.
  assert.deepEqual(nodeSizeOf(imageNode('bad', { width: 0, height: 0 })), {
    width: CANVAS_NODE_WIDTH,
    height: CANVAS_NODE_HEIGHT,
  })
})

test('a layout node clamps its width and derives its height from the draft', () => {
  const draft = layoutNode('x').draft
  assert.equal(nodeSizeOf(layoutNode('narrow', { w: 10, draft })).width, LAYOUT_NODE_MIN_WIDTH)
  assert.equal(nodeSizeOf(layoutNode('wide', { w: 5000, draft })).width, LAYOUT_NODE_MAX_WIDTH)
  // A stored height wins, because the board is the authority on where it was left.
  assert.equal(nodeSizeOf(layoutNode('stored', { w: 480, h: 333, draft })).height, 333)
  // An absent one is derived, and the derivation matches the editor's own.
  const derived = nodeSizeOf(layoutNode('derived', { w: 480, draft }))
  assert.equal(derived.height, layoutNodeHeight(480, draft))
  // A draft whose stored width is junk still yields the default band.
  assert.equal(nodeSizeOf(layoutNode('junk', { w: Number.NaN, draft })).width, LAYOUT_NODE_DEFAULT_WIDTH)
})

/* -------------------------------------------------------------------------- */
/* Copy                                                                       */
/* -------------------------------------------------------------------------- */

test('a picture is titled by its prompt and captioned with its size', () => {
  assert.equal(imageTitle(imageNode('a').image, '一只橘猫趴着\n第二行'), '一只橘猫趴着', 'first line only')
  assert.equal(imageTitle(imageNode('a', { markdownPath: 'C:/out/猫.png' }).image, ''), '猫.png', 'an import falls back to its file name')
  assert.equal(imageTitle(imageNode('a', { markdownPath: '' }).image, '   '), '图片', 'and an empty name to a word')
  assert.equal(imageMeta(imageNode('a', { width: 1024, height: 768, bytes: 3 * 1024 * 1024 }).image), '1024×768 · 3072 KB')
  // A sub-kilobyte file must not round to "0 KB": that reads as an empty file.
  assert.match(imageMeta(imageNode('a', { bytes: 10 }).image), /· 1 KB$/u)
})

test('a task node spells out its state, parameters and progress', () => {
  assert.equal(FLOW_TASK_BADGES.failed, '失败')
  assert.equal(taskPromptLine({ prompt: '  一张海报  \n细节' }), '一张海报')
  assert.equal(taskPromptLine({ prompt: '   ' }), '（未填写提示词）')
  assert.equal(
    taskParamsText({ prompt: 'x', ratio: '3:2', steps: 28, count: 2, seed: 42, references: [{ path: 'a' }] }),
    '3:2 · 28 步 · 2 张 · seed 42 · 1 参考',
  )
  assert.equal(taskParamsText({ prompt: 'x' }), '1:1', 'nothing known means the default ratio alone')
  assert.equal(taskParamsText({ prompt: 'x', count: 1 }), '1:1', 'one image is not worth saying')

  // Progress: queued is zero, done is a full bar whatever the stream last said,
  // and a running task reports the clamped percentage it was handed.
  assert.equal(taskPercent(taskNode('q', { status: 'queued' })), 0)
  assert.equal(taskPercent(taskNode('d', { status: 'done', progress: { percent: 87 } })), 100)
  assert.equal(taskPercent(taskNode('r', { status: 'running', progress: { percent: 41.6 } })), 42)
  assert.equal(taskPercent(taskNode('r', { status: 'running', progress: { percent: 900 } })), 100)
  assert.equal(taskPercent(taskNode('r', { status: 'running' })), 0, 'no progress means no bar')

  assert.equal(taskStatusText(taskNode('r', { status: 'running', progress: { percent: 10, label: '3/25' } })), '生成中… 3/25')
  assert.equal(taskStatusText(taskNode('f', { status: 'failed', error: '显存不足' })), '失败：显存不足')
  assert.equal(taskStatusText(taskNode('f', { status: 'failed' })), '生成失败')
  assert.equal(taskStatusText(taskNode('i', { status: 'interrupted', error: '用户取消' })), '已中断：用户取消')
  assert.equal(taskStatusText(taskNode('q', { status: 'queued' })), '排队中')
})

/* -------------------------------------------------------------------------- */
/* Node data payloads                                                         */
/* -------------------------------------------------------------------------- */

test('the image payload carries a 512-px thumbnail and the original separately', () => {
  const [node] = toFlowModel([imageNode('i1', { markdownPath: 'C:/out/猫.png' })]).nodes
  assert.equal(node.data.kind, 'image')
  assert.equal(node.data.nodeId, 'i1')
  assert.match(node.data.thumbUrl, /studio\/file\?path=/u, 'the picture goes through the file route')
  assert.match(node.data.thumbUrl, /w=512$/u, 'a node asks for the node-width thumbnail')
  assert.doesNotMatch(node.data.originalUrl, /w=/u, 'the lightbox asks for the original')
  assert.equal(node.data.meta, '1024×1024 · 512 KB')
})

test('the task payload carries everything its painter prints', () => {
  const [node] = toFlowModel([
    taskNode('t1', { status: 'failed', error: '显存不足', progress: { percent: 0, label: '' } }),
  ]).nodes
  assert.equal(node.data.status, 'failed')
  assert.equal(node.data.badge, '失败')
  assert.equal(node.data.ratio, '3:2')
  assert.equal(node.data.promptLine, '一张海报')
  assert.equal(node.data.paramsText, '3:2 · 28 步 · 2 张 · seed 42')
  assert.equal(node.data.percent, 0)
  assert.equal(node.data.statusText, '失败：显存不足')
  assert.equal(node.data.error, '显存不足')
})

test('a layout payload keeps the draft itself, never a rendered copy', () => {
  const source = layoutNode('l1')
  const [node] = toFlowModel([source]).nodes
  assert.equal(node.data.draft, source.draft, 'the draft is passed through by identity')
  assert.equal(node.data.boxes, 1)
  assert.deepEqual([node.data.width, node.data.height], [1536, 1024], 'the draft pixels, not the display box')
})

/* -------------------------------------------------------------------------- */
/* Lineage                                                                    */
/* -------------------------------------------------------------------------- */

test('a parent link becomes one edge, from the parent output to the child input', () => {
  const model = toFlowModel([imageNode('a'), imageNode('b', { parents: ['a'] })])
  assert.equal(model.edges.length, 1)
  assert.deepEqual(model.edges[0], {
    id: 'a->b',
    type: FLOW_EDGE_TYPE_LINEAGE,
    source: 'a',
    target: 'b',
    sourceHandle: FLOW_SOURCE_HANDLE,
    targetHandle: FLOW_TARGET_HANDLE,
    data: {},
  })
})

test('a duplicated parent collapses into one wire instead of stacking paths', () => {
  const model = toFlowModel([imageNode('a'), imageNode('b', { parents: ['a', 'a'] })])
  assert.deepEqual(model.edges.map((edge) => edge.id), ['a->b'])
})

test('an edge to a node that is gone is dropped and reported', () => {
  const model = toFlowModel([imageNode('b', { parents: ['gone'] }), imageNode('c', { parents: ['c'] })])
  assert.deepEqual(model.edges, [], 'nothing is drawn to nowhere')
  assert.deepEqual(model.danglingParents, [
    { nodeId: 'b', parentId: 'gone' },
    { nodeId: 'c', parentId: 'c' },
  ], 'a dangling parent and a self-reference are both reported')
})

test('edge labels are opt-in, and name what the child is', () => {
  const nodes = [
    imageNode('a'),
    imageNode('b', { parents: ['a'] }),
    layoutNode('l', { parents: ['a'] }),
    taskNode('t', { parents: ['a'] }),
  ]
  assert.equal(toFlowModel(nodes).edges[0].data.label, undefined, 'off by default: twenty wires with twenty labels is noise')
  const labelled = toFlowModel(nodes, { edgeLabels: true })
  assert.deepEqual(
    labelled.edges.map((edge) => edge.data.label),
    ['参考', '布局', '生成'],
  )
})

/* -------------------------------------------------------------------------- */
/* Selection, dragging and identity                                           */
/* -------------------------------------------------------------------------- */

test('selection is painted from the caller’s set, never guessed', () => {
  const model = toFlowModel([imageNode('a'), imageNode('b')], { selected: new Set(['b']) })
  assert.deepEqual(model.nodes.map((node) => node.selected), [false, true])
  const none = toFlowModel([imageNode('a')])
  assert.equal(none.nodes[0].selected, false, 'no set means nothing is selected')
})

test('a locked node is not draggable', () => {
  const model = toFlowModel([taskNode('t'), imageNode('i')], { locked: new Set(['t']) })
  assert.deepEqual(model.nodes.map((node) => node.draggable), [false, true])
})

test('positions are the board’s, untouched', () => {
  const [node] = toFlowModel([imageNode('a', { x: -120, y: 88.5 })]).nodes
  assert.deepEqual(node.position, { x: -120, y: 88.5 })
})

test('the mapping is deterministic: same board, same model', () => {
  const nodes = [imageNode('a'), imageNode('b', { parents: ['a'] }), taskNode('t')]
  assert.deepEqual(toFlowModel(nodes), toFlowModel(nodes))
  assert.equal(flowModelFingerprint(toFlowModel(nodes)), flowModelFingerprint(toFlowModel(nodes)))
})

test('the fingerprint moves when what is drawn moves, and not otherwise', () => {
  const base = toFlowModel([imageNode('a'), imageNode('b', { parents: ['a'] })])
  const moved = toFlowModel([imageNode('a', { x: 99 }), imageNode('b', { parents: ['a'] })])
  assert.notEqual(flowModelFingerprint(base), flowModelFingerprint(moved), 'a moved node repaints')

  const selected = toFlowModel([imageNode('a'), imageNode('b', { parents: ['a'] })], { selected: new Set(['a']) })
  assert.notEqual(flowModelFingerprint(base), flowModelFingerprint(selected), 'so does a selection change')

  const progressed = toFlowModel([
    imageNode('a'),
    taskNode('b', { parents: ['a'], status: 'running', progress: { percent: 10 } }),
  ])
  const advanced = toFlowModel([
    imageNode('a'),
    taskNode('b', { parents: ['a'], status: 'running', progress: { percent: 90 } }),
  ])
  assert.notEqual(flowModelFingerprint(progressed), flowModelFingerprint(advanced), 'progress is part of the picture')

  // Rewrapping an identical board (a fresh array of equal nodes) must not look
  // like a repaint: the studio re-seats its state on every batch.
  const rewrapped = toFlowModel([imageNode('a'), imageNode('b', { parents: ['a'] })])
  assert.equal(flowModelFingerprint(base), flowModelFingerprint(rewrapped))
})

/* -------------------------------------------------------------------------- */
/* The join between the model and the pane                                    */
/* -------------------------------------------------------------------------- */

test('every node type the model emits has a registered painter', () => {
  const model = toFlowModel([imageNode('i'), taskNode('t'), layoutNode('l'), draftNode('d')])
  for (const node of model.nodes) {
    assert.equal(typeof FLOW_NODE_TYPES[node.type], 'function', `${node.type} must be registered in FLOW_NODE_TYPES`)
  }
  assert.deepEqual(Object.keys(FLOW_NODE_TYPES).sort(), ['draft', 'image', 'layout', 'task'])
  assert.equal(FLOW_NODE_TYPES[FLOW_NODE_TYPE_IMAGE].name, 'ImageFlowNode')
  assert.equal(FLOW_NODE_TYPES[FLOW_NODE_TYPE_TASK].name, 'TaskFlowNode')
  assert.equal(FLOW_NODE_TYPES[FLOW_NODE_TYPE_LAYOUT].name, 'LayoutFlowNode')
})

test('every edge the model emits has a registered edge painter', () => {
  const model = toFlowModel([imageNode('a'), imageNode('b', { parents: ['a'] })])
  for (const edge of model.edges) {
    assert.equal(typeof FLOW_EDGE_TYPES[edge.type], 'function', `${edge.type} must be registered in FLOW_EDGE_TYPES`)
  }
  assert.equal(FLOW_EDGE_TYPES[FLOW_EDGE_TYPE_LINEAGE].name, 'LineageEdge')
  assert.equal(FLOW_EDGE_TYPES[FLOW_EDGE_TYPE_LINEAGE], LineageEdge)
})

test('the pane exposes the tab surface and the flow canvas as two components', () => {
  assert.equal(typeof CanvasPane, 'function', 'the tab mounts CanvasPane')
  assert.equal(typeof FlowCanvas, 'function', 'and CanvasPane hands the studio this canvas')
  assert.equal(CanvasPane.name, 'CanvasPane')
  assert.equal(FlowCanvas.name, 'FlowCanvas')
})

test('the board-to-flow mapping survives a round trip through JSON-shaped data', () => {
  // Everything a board stores is plain JSON; a node built from a *re-read* board
  // must map identically, or a reload would move or restyle the canvas.
  const nodes = [imageNode('a'), taskNode('t', { parents: ['a'] }), layoutNode('l', { parents: ['a'] })]
  const reread = JSON.parse(JSON.stringify(nodes))
  assert.deepEqual(toFlowModel(reread), toFlowModel(nodes))
})

/* -------------------------------------------------------------------------- */
/* U04 step 2: the interaction glue                                           */
/* -------------------------------------------------------------------------- */
//
// Step 1b could not move the canvas; step 2 re-attaches the gestures the DOM
// canvas had. React Flow's pointer handling still needs a browser, so what is
// asserted here is the part that *decides*: how its viewport becomes the studio's
// camera, how a per-frame change stream becomes one write, and which of the
// library's own key bindings are provably off.

test('flowNodeRects is the board as world rectangles, in the shape the marquee takes', () => {
  const nodes = [imageNode('wide', { x: 40, y: 12, width: 2048, height: 512 }), taskNode('t', { x: 0, y: 300 })]
  const rects = flowNodeRects(nodes)
  assert.deepEqual(rects.map((rect) => rect.id), ['wide', 't'], 'board order, not sorted')
  // The *displayed* box, so a marquee catches what the eye sees: a 4:1 panorama
  // is clamped to the node width the canvas actually paints.
  assert.equal(rects[0].width, MAX_NODE_WIDTH)
  assert.equal(rects[0].height, CANVAS_NODE_HEIGHT)
  assert.deepEqual({ x: rects[1].x, y: rects[1].y }, { x: 0, y: 300 })
  assert.equal(rects[1].width, CANVAS_NODE_WIDTH)
})

test('cameraFromFlow is the inverse of React Flow’s transform', () => {
  // React Flow stores `screen = world * zoom + translate`; `cameraFromFlow`
  // restates it as "the world point at the viewport's top-left, plus the zoom".
  const viewport = { x: -140, y: -70, zoom: 2 }
  const camera = cameraFromFlow(viewport)
  assert.deepEqual(camera, { x: 70, y: 35, zoom: 2 })
  // …and the studio's own screen→world (the tested one the marquee uses) agrees
  // with React Flow's formula at that viewport.
  const screen = { x: 300, y: 140 }
  assert.deepEqual(screenToWorld(camera, screen), {
    x: (screen.x - viewport.x) / viewport.zoom,
    y: (screen.y - viewport.y) / viewport.zoom,
  })
  // A camera that cannot project must freeze, not divide: zoom 0 falls back to 1.
  assert.deepEqual(cameraFromFlow({ x: 10, y: 10, zoom: 0 }), { x: -10, y: -10, zoom: 1 })
})

test('a marquee drawn on the flow canvas catches what the board says is there', () => {
  // The rectangle comes from the camera the pane reports; the hits come from the
  // same `marqueeWorldRect` + `nodesInRect` the DOM canvas uses (§6.1's
  // positive-area rule), applied to the model's own rectangles.
  const nodes = [imageNode('a', { x: 0, y: 0 }), imageNode('b', { x: 400, y: 0 }), imageNode('c', { x: 0, y: 400 })]
  const camera = cameraFromFlow({ x: 0, y: 0, zoom: 1 })
  const world = marqueeWorldRect(camera, { x: 0, y: 0 }, { x: 300, y: 300 })
  assert.deepEqual(nodesInRect(flowNodeRects(nodes), world), ['a'])
  // At zoom 2 the same screen sweep covers a quarter of the world: the node at
  // 400 world units is still out of reach, and the union rule adds nothing.
  const zoomed = marqueeWorldRect(cameraFromFlow({ x: 0, y: 0, zoom: 2 }), { x: 0, y: 0 }, { x: 600, y: 600 })
  assert.deepEqual(nodesInRect(flowNodeRects(nodes), zoomed), ['a'])
  // A Shift release unions onto what was already selected (§6.1).
  assert.deepEqual([...marqueeSelection(new Set(['c']), ['a'], true)].sort(), ['a', 'c'])
})

test('one frame of a drag commits nothing; the release commits once', () => {
  const model = toFlowModel([imageNode('a', { x: 10, y: 20 }), imageNode('b', { x: 400, y: 20 })])
  const base = new Map(model.nodes.map((node) => [node.id, { x: node.position.x, y: node.position.y }]))
  let state = EMPTY_FLOW_DRAG

  const frame = (changes) => {
    const step = foldDragChanges(state, base, changes)
    state = step.state
    return step
  }

  const first = frame([{ id: 'a', type: 'position', position: { x: 20, y: 20 }, dragging: true }])
  assert.deepEqual(first.moved.size, 0, 'a frame mid-gesture writes nothing')
  assert.deepEqual([...first.state.dragging], ['a'])
  const second = frame([{ id: 'a', type: 'position', position: { x: 90, y: 70 }, dragging: true }])
  assert.equal(second.moved.size, 0, 'and neither does the next one')
  assert.deepEqual(second.state.origins.get('a'), { x: 10, y: 20 }, 'the origin is the *stored* position')

  const release = frame([{ id: 'a', type: 'position', position: { x: 120, y: 80 }, dragging: false }])
  assert.deepEqual([...release.moved.entries()], [['a', { x: 120, y: 80 }]], 'one commit, at the end')
  assert.equal(release.state.dragging.size, 0, 'and the gesture leaves no bookkeeping behind')
  assert.equal(release.state.live.size, 0)
  assert.equal(base.get('b').x, 400, 'the input map is never mutated')
})

test('a drag that ends where it began is not a write', () => {
  const base = new Map([['a', { x: 10, y: 20 }]])
  let state = EMPTY_FLOW_DRAG
  let last
  for (const change of [
    { id: 'a', type: 'position', position: { x: 30, y: 40 }, dragging: true },
    { id: 'a', type: 'position', position: { x: 10, y: 20 }, dragging: false },
  ]) {
    const step = foldDragChanges(state, base, [change])
    state = step.state
    last = step
  }
  assert.equal(last.moved.size, 0, 'nothing moved, so nothing is recorded and no save is scheduled')
  assert.deepEqual(last.ended, ['a'], 'the gesture still ended')
})

test('a multi-node drag commits every node in one batch', () => {
  const model = toFlowModel([imageNode('a', { x: 0, y: 0 }), imageNode('b', { x: 300, y: 0 })])
  const base = new Map(model.nodes.map((node) => [node.id, { x: node.position.x, y: node.position.y }]))
  const step = foldDragChanges(EMPTY_FLOW_DRAG, base, [
    { id: 'a', type: 'position', position: { x: 10, y: 10 }, dragging: false },
    { id: 'b', type: 'position', position: { x: 310, y: 10 }, dragging: false },
  ])
  assert.deepEqual([...step.moved.keys()], ['a', 'b'], 'one batch, both nodes: one command, one save')
})

test('foldDragChanges ignores what is not a position change', () => {
  const base = new Map([['a', { x: 0, y: 0 }]])
  const step = foldDragChanges(EMPTY_FLOW_DRAG, base, [
    { id: 'a', type: 'select', selected: true },
    { id: 'a', type: 'dimensions', dimensions: { width: 100, height: 100 } },
    { id: 'a', type: 'remove' },
    { id: 'a', type: 'position', position: { x: Number.NaN, y: 0 }, dragging: false },
    { id: 'a', type: 'position', dragging: false },
  ])
  assert.equal(step.moved.size, 0)
  assert.equal(step.state.live.size, 0, 'an unparseable position is dropped, not stored as NaN')
})

test('the drag a user made becomes one undo step, and undo puts the node back', () => {
  // This is the bridge the studio relies on: React Flow's stream → one batch →
  // one command on the same stack the DOM canvas fills (§6.5, DD9).
  const nodes = [imageNode('a', { x: 10, y: 20 }), imageNode('b', { x: 200, y: 20 })]
  const model = toFlowModel(nodes)
  const base = new Map(model.nodes.map((node) => [node.id, { x: node.position.x, y: node.position.y }]))
  const board = new Map(base)
  const write = (positions) => {
    for (const [id, point] of positions) board.set(id, { x: point.x, y: point.y })
  }
  const history = new CommandStack()

  let state = EMPTY_FLOW_DRAG
  let commits = 0
  for (const changes of [
    [{ id: 'a', type: 'position', position: { x: 40, y: 20 }, dragging: true }],
    [{ id: 'a', type: 'position', position: { x: 90, y: 60 }, dragging: true }],
    [{ id: 'a', type: 'position', position: { x: 120, y: 80 }, dragging: false }],
  ]) {
    const step = foldDragChanges(state, base, changes)
    state = step.state
    if (step.moved.size === 0) continue
    commits += 1
    // What the studio does: `applyPositions` + `pushCommand` (studio-view.ts).
    const before = new Map([...step.moved.keys()].map((id) => [id, { ...board.get(id) }]))
    write(step.moved)
    history.push(snapshotCommand('drag', before, step.moved, write))
  }

  assert.equal(commits, 1, 'three frames, one command')
  assert.deepEqual(board.get('a'), { x: 120, y: 80 })
  assert.deepEqual(board.get('b'), { x: 200, y: 20 }, 'a single-node drag never moves its neighbour')
  assert.equal(history.undoSize, 1)
  assert.equal(history.undo(), true)
  assert.deepEqual(board.get('a'), { x: 10, y: 20 }, 'undo restores the stored coordinate')
  assert.equal(history.redo(), true)
  assert.deepEqual(board.get('a'), { x: 120, y: 80 })
})

test('a progress tick mid-drag does not snap the dragged node back', () => {
  // The studio rebuilds the model on every SSE frame; the node under the pointer
  // must keep the position the gesture put it at, while everything else it says
  // (status, percent, badge) still comes from the new model.
  const before = toFlowModel([imageNode('a', { x: 10, y: 20 }), taskNode('t', { x: 0, y: 0 })])
  const dragging = new Set(['a'])
  const live = new Map([['a', { x: 300, y: 240 }]])
  const reseeded = reseedFlowNodes(before, live, dragging)
  const byId = new Map(reseeded.map((node) => [node.id, node]))
  assert.deepEqual(byId.get('a').position, { x: 300, y: 240 }, 'the in-flight position survives')

  // The next model (a progress tick) reseeds again, and the drag is still safe.
  const ticked = toFlowModel([
    imageNode('a', { x: 10, y: 20 }),
    taskNode('t', { x: 0, y: 0, status: 'running', progress: { percent: 63 } }),
  ])
  const again = new Map(reseedFlowNodes(ticked, live, dragging).map((node) => [node.id, node]))
  assert.deepEqual(again.get('a').position, { x: 300, y: 240 })
  assert.equal(again.get('t').data.percent, 63, 'the task keeps reporting its progress')

  // With no gesture in flight the model is authoritative, unchanged and cheap.
  const idle = reseedFlowNodes(ticked, new Map(), new Set())
  assert.deepEqual(idle, [...ticked.nodes])
})

test('flowInteractionProps turns off every key the library would handle itself', () => {
  const props = flowInteractionProps({ selectable: true })
  // Dragging is the library's, and it is the gesture whose result is written back.
  assert.equal(props.nodesDraggable, true)
  // A wire *is* the library's now (U04 step 3): the drag lives in `XYHandle`, so
  // the handles must be live or the gesture has nowhere to start.
  assert.equal(props.nodesConnectable, true, 'nodesConnectable opens with the wire (S3)')
  // …and the "a click is not a drag" rule is the same number the pure state
  // machine uses, so a 2-px twitch never opens a menu on top of the node.
  assert.equal(props.connectionDragThreshold, CONNECT_THRESHOLD)
  assert.equal(CONNECT_THRESHOLD, 4, 'the threshold the wire is measured against')
  // One gesture, one path: a click on a handle must not build an edge through
  // the library's own click-to-connect, which never reaches the drop planner.
  assert.equal(props.connectOnClick, false)
  // The three bindings this canvas implements itself (§6.1 selection, §6.3 the
  // shortcut table). Two handlers for one key is the bug this asserts against.
  assert.equal(props.deleteKeyCode, null, 'Delete belongs to resolveShortcut')
  assert.equal(props.multiSelectionKeyCode, null, 'Ctrl/Cmd-click toggling belongs to toggleSelection')
  assert.equal(props.selectionKeyCode, null)
  assert.equal(props.selectionOnDrag, false, 'the marquee is marqueeWorldRect’s, not the library’s')
  assert.equal(props.elementsSelectable, true, 'and with a selection callback the clicks still report')
  assert.equal(props.panOnDrag, true, 'a blank left-drag pans — the natural canvas gesture')
  assert.equal(props.zoomOnDoubleClick, false, 'a double click opens the lightbox, it does not zoom')
  assert.equal(props.minZoom, CANVAS_MIN_ZOOM)
  assert.equal(props.maxZoom, CANVAS_MAX_ZOOM)

  // Shift is the marquee trigger: while held, React Flow must not pan on left.
  assert.deepEqual(flowInteractionProps({ selectable: true, suppressLeftPan: true }).panOnDrag, [1])
  // Hand mode keeps every button panning.
  assert.equal(flowInteractionProps({ selectable: true, panMode: true }).panOnDrag, true)
  // No selection callback, no selectable elements.
  assert.equal(flowInteractionProps().elementsSelectable, false)
})

test('the fit question G15 asked is asked again for the new engine', () => {
  const viewport = { width: 800, height: 600 }
  const normal = { x: 0, y: 0, width: 400, height: 300 }
  assert.ok(fitZoomFor(normal, viewport) > CANVAS_MIN_ZOOM, 'a small board fits comfortably')
  assert.equal(fitWouldClamp(normal, viewport), false)

  // A board wide enough to need less than the 10 % floor: React Flow clamps
  // exactly like `fitCamera` did, and the pane raises the same note for it.
  const huge = { x: 0, y: 0, width: 14000, height: 900 }
  assert.ok(fitZoomFor(huge, viewport) < CANVAS_MIN_ZOOM)
  assert.equal(fitWouldClamp(huge, viewport), true)

  // Nothing to frame is never a clamp: the camera must not jump on an empty board.
  assert.equal(fitWouldClamp(undefined, viewport), false)
  assert.equal(fitZoomFor(undefined, viewport), Number.POSITIVE_INFINITY)
})

/* -------------------------------------------------------------------------- */
/* U04 step 3: the wire — what a drag out of a handle decides                 */
/* -------------------------------------------------------------------------- */
//
// The gesture itself (pointer capture, the engine's own drag) needs a browser.
// What it *decides* does not: a release is classified by `planConnectionDrop`
// from three inputs — the source, the release point and the board — and the
// three answers are the whole feature: an edge, a menu, or nothing at all.
//
//   drop on blank canvas   → the node-type menu (image / layout / asset)
//   drop on a picture      → lineage only: `parents += source`, no request
//   drop back on the source, or on something that cannot be referenced,
//   or a path that would close a cycle, or a click that never moved → cancel

test('which nodes can start and accept a wire is one list, read by every layer', () => {
  // Which kinds carry an output dot, and which can be landed on. The pane
  // renders handles from these two predicates, `isValidConnection` refuses by
  // them and `planConnectionDrop` cancels by them, so an affordance cannot
  // disagree with the rule behind it.
  assert.deepEqual([...CONNECT_SOURCE_KINDS], ['image', 'layout'])
  assert.deepEqual(
    [imageNode('i'), taskNode('t'), layoutNode('l'), draftNode('d')].map((node) => canStartConnection(node.kind)),
    [true, false, true, false],
    'a picture and a layout draft can be a provenance',
  )
  assert.deepEqual(
    [imageNode('i'), taskNode('t'), layoutNode('l'), draftNode('d')].map((node) => canAcceptConnection(node.kind)),
    [true, false, true, false],
    'a picture and a layout have a file a reference can point at',
  )
})

test('the connection layer sees each node’s painted box, lineage and kind', () => {
  const nodes = connectionNodesOf([
    imageNode('a', { x: 10, y: 20, parents: ['z'] }),
    layoutNode('l', { x: 300, y: 0 }),
    taskNode('t', { x: 0, y: 400 }),
    draftNode('d', ['t']),
  ])
  assert.deepEqual(nodes.map((node) => node.id), ['a', 'l', 't', 'd'], 'board order is preserved')
  assert.deepEqual(nodes[0], {
    id: 'a',
    x: 10,
    y: 20,
    // The *painted* size, not the 1024-px file: the pointer lands on what is drawn.
    width: nodeSizeOf(imageNode('a')).width,
    height: nodeSizeOf(imageNode('a')).height,
    parents: ['z'],
    kind: 'image',
  })
  assert.equal(nodes[1].kind, 'layout')
  assert.deepEqual(nodes[3].parents, ['t'])
})

test('a wire lands on a picture and nowhere else', () => {
  const nodes = connectionNodesOf([
    imageNode('a', { x: 0, y: 0 }),
    imageNode('b', { x: 400, y: 0 }),
    layoutNode('l', { x: 800, y: 0 }),
    taskNode('t', { x: 0, y: 400 }),
  ])
  const judge = (sourceId, targetId) => judgeConnection({ sourceId, targetId, nodes })

  assert.equal(judge('a', 'b'), 'ok', 'a picture may reference another picture')
  assert.equal(judge('a', 'a'), 'self', 'and never itself')
  assert.equal(judge('a', 'l'), 'ok', 'a picture wired into a layout is a reference for it')
  assert.equal(judge('a', 't'), 'kind', 'a task in flight has no file either')
  assert.equal(judge('l', 'a'), 'ok', 'a layout draft may be the provenance of a picture')
  assert.equal(judge('t', 'a'), 'kind', 'a task cannot start a wire')
  assert.equal(judge('a', 'nobody'), 'missing', 'an id this board does not hold cannot be joined')
  // The boolean React Flow asks for is the same judgement.
  assert.equal(connectionIsValid({ sourceId: 'a', targetId: 'b', nodes }), true)
  assert.equal(connectionIsValid({ sourceId: 'a', targetId: 'l', nodes }), true, 'the preview colours this wire valid')
})

test('lineage refuses to close a cycle', () => {
  // a → b → c already recorded; wiring c → a would make c its own ancestor.
  const nodes = connectionNodesOf([
    imageNode('a', { x: 0, y: 0 }),
    imageNode('b', { x: 0, y: 200, parents: ['a'] }),
    imageNode('c', { x: 0, y: 400, parents: ['b'] }),
  ])
  assert.equal(judgeConnection({ sourceId: 'c', targetId: 'a', nodes }), 'cycle')
  assert.equal(judgeConnection({ sourceId: 'b', targetId: 'a', nodes }), 'cycle')
  // Downstream is the legal direction: a → c adds a second, already-implied
  // parent to c, which is a DAG (a shortcut edge), not a loop.
  assert.equal(judgeConnection({ sourceId: 'a', targetId: 'c', nodes }), 'ok')
})

test('a release on blank canvas asks what to build, at the point released', () => {
  const nodes = connectionNodesOf([imageNode('a', { x: 0, y: 0 }), imageNode('b', { x: 600, y: 0 })])
  const plan = planConnectionDrop({ sourceId: 'a', point: { x: 400, y: 300 }, travelled: true, nodes })
  assert.deepEqual(plan, {
    kind: 'menu',
    sourceId: 'a',
    worldPoint: { x: 400, y: 300 },
  })
})

test('a release on a picture records lineage and nothing else', () => {
  const nodes = connectionNodesOf([imageNode('a', { x: 0, y: 0 }), imageNode('b', { x: 600, y: 0 })])
  const plan = planConnectionDrop({ sourceId: 'a', point: { x: 620, y: 40 }, travelled: true, nodes })
  assert.deepEqual(plan, { kind: 'edge', sourceId: 'a', toId: 'b' })
})

test('every way of putting the wire back builds nothing', () => {
  const nodes = connectionNodesOf([
    imageNode('a', { x: 0, y: 0 }),
    imageNode('b', { x: 600, y: 0, parents: ['a'] }),
    layoutNode('l', { x: 0, y: 600 }),
    taskNode('t', { x: 600, y: 600 }),
  ])
  const drop = (sourceId, point, travelled = true) =>
    planConnectionDrop({ sourceId, point, travelled, nodes })

  // A click on the handle (React Flow applies the same threshold before it even
  // reports a connection; the DOM canvas passes its own distance here).
  assert.deepEqual(drop('a', { x: 10, y: 10 }, false), { kind: 'cancel', sourceId: 'a', reason: 'idle' })
  // Put back inside the node it came from — checked against the source's own
  // box, not as blank canvas, so no menu opens on top of it.
  assert.deepEqual(drop('a', { x: 100, y: 100 }), { kind: 'cancel', sourceId: 'a', reason: 'returned' })
  // A node that cannot take a reference: a layout now can, so this case aims at
  // the task node instead (kind is still the rule for a task in flight).
  assert.deepEqual(drop('a', { x: 610, y: 620 }), { kind: 'cancel', sourceId: 'a', reason: 'kind' })
  // Dropping on the layout is now a legal edge, not a refusal: a layout takes a
  // picture as an input reference.
  assert.deepEqual(drop('a', { x: 10, y: 620 }), { kind: 'edge', sourceId: 'a', toId: 'l' })
  // A path that would close the loop: b already descends from a.
  assert.deepEqual(drop('b', { x: 20, y: 20 }), { kind: 'cancel', sourceId: 'b', reason: 'cycle' })
  // The source itself is gone (a stale gesture): nothing to join.
  assert.deepEqual(drop('ghost', { x: 700, y: 10 }), { kind: 'cancel', sourceId: 'ghost', reason: 'missing' })
})

test('the edge a drop makes is the edge the model draws, with no request in between', () => {
  // The whole machine-readable path of "drop on a picture": plan → the target's
  // parents → the model's edge list. Nothing here can start a generation — the
  // value that comes out is a *parent id*, and the one write it causes is the
  // board's position+lineage flush.
  const board = [imageNode('a', { x: 0, y: 0 }), imageNode('b', { x: 600, y: 0 })]
  const plan = planConnectionDrop({
    sourceId: 'a',
    point: { x: 620, y: 40 },
    travelled: true,
    nodes: connectionNodesOf(board),
  })
  assert.equal(plan.kind, 'edge')

  const before = toFlowModel(board)
  assert.deepEqual(before.edges, [], 'two unrelated pictures draw no wire')

  const linked = board.map((node) => (
    node.id === plan.toId ? { ...node, parents: linkParents(node.parents, plan.sourceId) } : node
  ))
  const after = toFlowModel(linked)
  assert.deepEqual(after.edges.map((edge) => [edge.source, edge.target]), [['a', 'b']])
  assert.deepEqual(after.danglingParents, [], 'and it resolves, because both ends are on this board')

  // Re-dropping the same wire is a no-op by identity, which is how the studio
  // keeps it out of the undo stack.
  const again = linkParents(linked[1].parents, 'a')
  assert.equal(again, linked[1].parents, 'a duplicate drop must not mint a second command')
})

/* -------------------------------------------------------------------------- */
/* U04 step 4: the opening view, 居中揭示, a task’s buttons (no DOM)           */
/* -------------------------------------------------------------------------- */
//
// Three behaviours this stage had to add, and all three are decided before a
// pixel exists: what viewport a board opens at, which camera a reveal moves, and
// which buttons a task state offers. The engine's half of each (React Flow's
// `defaultViewport` vs `fitView`, `instance.setCenter`, the `<button>` list) needs
// a browser and stays on the manual checklist; what it *decides* is here.

test('a board opens at the camera it was stored with, not at a fresh fit', () => {
  // The studio stores "the world point at the viewport's top-left, plus the
  // zoom"; React Flow wants `screen = world * zoom + translate`. Converting is
  // the inverse of what the pane already reports back (`cameraFromFlow`).
  const stored = { x: -28, y: -28, zoom: 1 }
  assert.deepEqual(flowViewportOf(stored), { x: 28, y: 28, zoom: 1 })
  const zoomed = { x: 120, y: 40, zoom: 2 }
  assert.deepEqual(cameraFromFlow(flowViewportOf(zoomed)), zoomed, 'a stored view survives the round trip')
  assert.deepEqual(cameraFromFlow(flowViewportOf(stored)), stored)

  // A camera that cannot project is *no* stored view, never a viewport at
  // infinity: a board whose zoom was written as 0 opens framed, not blank.
  for (const camera of [
    undefined,
    null,
    { x: 0, y: 0, zoom: 0 },
    { x: 0, y: 0, zoom: Number.NEGATIVE_INFINITY },
    { x: Number.NaN, y: 0, zoom: 1 },
    { x: 0, y: 0, zoom: Number.NaN },
  ]) {
    assert.equal(flowViewportOf(camera), undefined)
    assert.deepEqual(initialFlowView(camera), { kind: 'fit' })
  }

  // A view stored outside the canvas's zoom band reopens at the band's edge —
  // and the *world point* is still the stored one, so x/y scale with the clamped
  // zoom (the two constants are the DOM canvas's own band, restated).
  assert.deepEqual(flowViewportOf({ x: -100, y: -50, zoom: 0.01 }), { x: 10, y: 5, zoom: CANVAS_MIN_ZOOM })
  assert.deepEqual(flowViewportOf({ x: -10, y: -10, zoom: 99 }), { x: 80, y: 80, zoom: CANVAS_MAX_ZOOM })

  // And a board that *did* store a view opens exactly there.
  assert.deepEqual(initialFlowView(stored), { kind: 'viewport', viewport: { x: 28, y: 28, zoom: 1 } })
})

test('restoring the view and framing the board are one decision, never both', () => {
  // React Flow applies `defaultViewport` and `fitView` on init and the later one
  // wins, so a board handed both opens twice — first where it was left, then
  // framed. The props are the exclusion: each branch carries one key and not the
  // other, not even a `false`.
  const restored = flowViewportProps(initialFlowView({ x: -28, y: -28, zoom: 1 }))
  assert.deepEqual(restored, { defaultViewport: { x: 28, y: 28, zoom: 1 } })
  assert.equal('fitView' in restored, false, 'a restored board must not also be framed')
  assert.equal('fitViewOptions' in restored, false)

  const framed = flowViewportProps(initialFlowView(undefined))
  assert.deepEqual(framed, { fitView: true, fitViewOptions: { ...FLOW_FIT_OPTIONS } })
  assert.equal('defaultViewport' in framed, false, 'a framed board must not also be restored')

  // A new board is the same answer as an unreadable one: frame it.
  assert.deepEqual(initialFlowView(undefined), { kind: 'fit' })
})

test('居中揭示 moves the engine’s camera, and the DOM camera only when that is mounted', () => {
  const rect = { x: 100, y: 40, width: 208, height: 240 }
  const center = { x: 204, y: 160 }
  // The engine is what is on screen since step 1b, so the reveal has to be a call
  // on it — moving the studio's camera mirror moved nothing.
  assert.deepEqual(planReveal({ rect, canvas: 'flow', zoom: 0.5 }), { kind: 'flow', center, zoom: 0.5 })
  // The DOM fallback keeps its own path and gets the same point.
  assert.deepEqual(planReveal({ rect, canvas: 'dom', zoom: 2 }), { kind: 'dom', center, zoom: 2 })
  // Nothing mounted, or the node is not on the board yet: remember the id.
  assert.deepEqual(planReveal({ rect, canvas: 'none', zoom: 1 }), { kind: 'pending' })
  assert.deepEqual(planReveal({ canvas: 'flow', zoom: 1 }), { kind: 'pending' })
  // A camera with no usable zoom centres at 1 instead of at `Infinity`.
  assert.deepEqual(planReveal({ rect, canvas: 'flow', zoom: 0 }), { kind: 'flow', center, zoom: 1 })
  assert.deepEqual(planReveal({ rect, canvas: 'flow', zoom: Number.NaN }), { kind: 'flow', center, zoom: 1 })

  // The point really is the node's centre: the DOM path's own `centerOn` turns it
  // into a camera that puts it in the middle of the viewport.
  const viewport = { width: 800, height: 600 }
  const plan = planReveal({ rect, canvas: 'dom', zoom: 1 })
  const camera = centerOn(plan.center, viewport, plan.zoom)
  assert.deepEqual(worldToScreen(camera, plan.center), { x: 400, y: 300 })
})

test('a task node’s buttons are decided by its state, and every state is decided', () => {
  // §4.5: a failure offers a way back (its own snapshot), a run in flight offers
  // an interrupt, and 移除 — the one button about the board rather than the run —
  // is never conditional.
  assert.deepEqual(taskNodeActions('failed'), ['retry', 'edit', 'remove'])
  assert.deepEqual(taskNodeActions('interrupted'), ['retry', 'edit', 'remove'])
  assert.deepEqual(taskNodeActions('idle'), ['cancel', 'remove'])
  assert.deepEqual(taskNodeActions('queued'), ['cancel', 'remove'])
  assert.deepEqual(taskNodeActions('running'), ['cancel', 'remove'])
  assert.deepEqual(taskNodeActions('done'), ['remove'])

  // The mapping is total over the painted states, and no state doubles a button.
  for (const status of Object.keys(FLOW_TASK_BADGES)) {
    const buttons = taskNodeActions(status)
    assert.ok(buttons.length > 0, status + ' must offer something')
    assert.equal(buttons.at(-1), 'remove', status + ' must stay removable')
    assert.equal(new Set(buttons).size, buttons.length, status + ' must not repeat a button')
  }
  // The button the engine lost in step 1b is the one a failure cannot do without.
  assert.ok(taskNodeActions('failed').includes('edit'), 'a failure can refill the form')
  assert.equal(taskNodeActions('done').includes('retry'), false, 'a finished task needs no retry')
})

test('a progress tick repaints the node it is about, and no other', () => {
  // The stream sends a frame per step. Each one re-derives the whole model, so
  // the question this asserts is the one that decides whether a large board
  // stutters once per frame: does the array React Flow receives keep the
  // *identity* of the nodes the tick said nothing about?
  //
  // The board is built once — as the studio does — and a tick replaces only the
  // node it is about, so the layout node's draft (an object the editor holds)
  // keeps its identity the way it does in the panel.
  const board = [
    imageNode('a', { x: 0, y: 0 }),
    taskNode('t', { x: 300, y: 0, status: 'running', progress: { percent: 10 } }),
    layoutNode('l', { x: 0, y: 400 }),
  ]
  const tick = (percent) => board.map((node) => (
    node.id === 't' ? { ...node, progress: { percent } } : node
  ))
  const before = reseedFlowNodes(toFlowModel(tick(10)), new Map(), new Set())
  const after = reseedFlowNodes(toFlowModel(tick(42)), new Map(), new Set())
  assert.notEqual(before[1], after[1], 'the reseed alone hands back new objects for every node')

  const stable = reuseFlowNodes(before, after)
  assert.deepEqual(stable.map((node) => node.id), ['a', 't', 'l'], 'the board is still the board')
  assert.equal(stable[0], before[0], 'an untouched picture keeps its object, so its painter does not run')
  assert.equal(stable[2], before[2], 'and so does an untouched layout node')
  assert.notEqual(stable[1], before[1], 'the ticking task is a new node…')
  assert.equal(stable[1].data.percent, 42, '…carrying the new progress')
  assert.equal(stable[1].data.statusText, '生成中…', 'and the state it implies')

  // A batch that changed nothing reuses the whole array, object for object.
  const same = reuseFlowNodes(before, reseedFlowNodes(toFlowModel(tick(10)), new Map(), new Set()))
  assert.deepEqual(same.map((node, index) => node === before[index]), [true, true, true])

  // What is *not* payload still counts: a selection or a drag is a repaint.
  const selected = reseedFlowNodes(toFlowModel(tick(10), { selected: new Set(['a']) }), new Map(), new Set())
  const withSelection = reuseFlowNodes(before, selected)
  assert.notEqual(withSelection[0], before[0], 'a newly selected node repaints')
  assert.equal(withSelection[1], before[1], 'and its neighbours do not')

  // A node that left the board is simply gone; a dragged one carries its live
  // position forward (the S2 rule `reseedFlowNodes` already owns).
  const moved = reseedFlowNodes(toFlowModel(tick(10)), new Map([['t', { x: 900, y: 50 }]]), new Set(['t']))
  assert.equal(reuseFlowNodes(before, moved)[1].position.x, 900)
  assert.deepEqual(reuseFlowNodes(before, moved.slice(1)).map((node) => node.id), ['t', 'l'])
})

test('a reloaded layout node keeps its draft and the box its editor is mounted in', () => {
  // What `nodesFromBoard` does with a stored v2 layout entry (§8.1, C13): clamp
  // the stored width into the band and keep the stored height when there is one.
  const stored = {
    id: 'l1',
    x: 40,
    y: 80,
    parents: [],
    w: 700,
    h: 512,
    draft: {
      width: 1536,
      height: 1024,
      bbox_coord_space: 'abs',
      bbox_format: 'xyxy',
      summary: { caption: '黄昏的山谷' },
      items: [{ label: 'object', caption: '山', bbox: [10, 20, 300, 400] }],
    },
  }
  const rebuild = (entry) => {
    const width = clampLayoutNodeWidth(entry.w ?? LAYOUT_NODE_DEFAULT_WIDTH)
    return {
      kind: 'layout',
      id: entry.id,
      x: entry.x,
      y: entry.y,
      parents: entry.parents,
      w: width,
      h: entry.h ?? layoutNodeHeight(width, entry.draft),
      draft: entry.draft,
    }
  }

  const node = rebuild(stored)
  assert.equal(nodeSizeOf(node).width, 700)
  assert.equal(nodeSizeOf(node).height, 512, 'a stored height is the box the user left the node in')

  // "刷新后草稿还在" at byte level: the draft round-trips through the embedded
  // editor's own import/export pair, which is what a remount does.
  assert.deepEqual(stateToDraft(draftToEditorState(node.draft)), stored.draft)

  // And the box the canvas paints is the box that editor is mounted in — the same
  // number, from one function. That is why `pointerScale` stays at its default of
  // 1 (see `src/canvas-pane.ts`): the editor measures this box with
  // `getBoundingClientRect` inside the zoomed viewport, so the measurement
  // already contains the zoom and passing it again would apply it twice.
  const [painted] = toFlowModel([node]).nodes
  assert.equal(painted.width, nodeSizeOf(node).width)
  assert.equal(painted.height, nodeSizeOf(node).height)
  assert.equal(painted.width, clampLayoutNodeWidth(node.w))

  // A resize is a width alone: the height follows the draft's proportion and the
  // draft — therefore the compiled layout a generation would send — is untouched.
  const compiled = JSON.stringify(stored.draft)
  for (const width of [LAYOUT_NODE_MIN_WIDTH, LAYOUT_NODE_DEFAULT_WIDTH, LAYOUT_NODE_MAX_WIDTH]) {
    const resized = rebuild({ ...stored, w: width, h: undefined })
    assert.equal(nodeSizeOf(resized).width, width)
    assert.equal(nodeSizeOf(resized).height, layoutNodeHeight(width, stored.draft))
    assert.equal(JSON.stringify(resized.draft), compiled, 'resizing must not touch the draft')
  }
  // A junk stored width lands in the band rather than on a 0-wide node.
  assert.equal(nodeSizeOf(rebuild({ ...stored, w: Number.NaN })).width, LAYOUT_NODE_DEFAULT_WIDTH)
})



test('every lineage target kind renders an inbound handle, but only pictures accept a drop', () => {
  // A wire dropped on blank canvas creates a task/draft with parents=[source].
  // Its edge must be drawable, so the inbound handle is rendered for all kinds —
  // while the drop rule stays strict (pictures only) and is enforced separately.
  for (const kind of ['image', 'task', 'draft', 'layout']) {
    assert.equal(hasInboundHandle(kind), true, kind + ' must render an inbound handle for its lineage edge')
  }
  assert.equal(canAcceptConnection('image'), true)
  assert.equal(canAcceptConnection('task'), false, 'a task still cannot be a manual drop target')
  assert.equal(canAcceptConnection('draft'), false)
  // A layout takes a picture as input: it is the one draft kind that consumes
  // references, so a wire may land on it (U05's "drag it onto the target").
  assert.equal(canAcceptConnection('layout'), true)
})
