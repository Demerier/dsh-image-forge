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
  CANVAS_NODE_HEIGHT,
  CANVAS_NODE_WIDTH,
  MAX_NODE_WIDTH,
  MIN_NODE_WIDTH,
} from '../src/studio-canvas.ts'
import {
  LAYOUT_NODE_DEFAULT_WIDTH,
  LAYOUT_NODE_MAX_WIDTH,
  LAYOUT_NODE_MIN_WIDTH,
  layoutNodeHeight,
} from '../src/layout-editor.ts'
import {
  FLOW_EDGE_TYPE_LINEAGE,
  FLOW_NODE_TYPE_DRAFT,
  FLOW_NODE_TYPE_IMAGE,
  FLOW_NODE_TYPE_LAYOUT,
  FLOW_NODE_TYPE_TASK,
  FLOW_SOURCE_HANDLE,
  FLOW_TARGET_HANDLE,
  FLOW_TASK_BADGES,
  flowModelFingerprint,
  imageMeta,
  imageTitle,
  nodeSizeOf,
  nodeTypeOf,
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
