/** Focused regressions for the conversation card, annotations and Better Sidebar handoff. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  annotationPointFromClient,
  annotationHandoffPrompt,
  moveAnnotation,
  renumberAnnotations,
} from '../testlib/image-annotation.js'
import {
  boardItemIdForImage,
  imageResultFacts,
} from '../testlib/image-result-model.js'
import {
  conversationImageHandoffCapability,
  imageEditorDedupeKey,
  imageEditorTabInstanceId,
  layoutAncestorOf,
  readImageEditorTabMeta,
} from '../testlib/better-sidebar-model.js'
import {
  composerHandoffGate,
  watchComposerAccepted,
} from '../testlib/better-sidebar-handoff.js'
import {
  openImageEditorTab,
  registerBetterSidebarTab,
} from '../testlib/better-sidebar.js'

const CLIENT_SOURCE = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
const TOOLS_SOURCE = readFileSync(fileURLToPath(new URL('../testlib/tools.js', import.meta.url)), 'utf8')

test('image result readers map a batch card to board items and facts', () => {
  const payload = {
    images: [
      { index: 1, path: 'C:/out/a.png', bytes: 1024, width: 1024, height: 1024 },
      { index: 2, path: 'C:/out/b.png', bytes: 2048 },
    ],
    board: { id: 'b1', name: '雨夜东京', created: true, item_ids: ['i1', 'i2'] },
    wh_ratio: '1:1', steps_used: 8, seed: 42, model: 'Qwen 2.1 Turbo', prompt: '雨夜人像\n细节',
    size: { width: 1024, height: 1024 },
  }
  const facts = imageResultFacts(payload)
  assert.equal(facts.count, 2)
  assert.deepEqual(facts.images.map((image) => image.path), ['C:/out/a.png', 'C:/out/b.png'])
  assert.equal(boardItemIdForImage(payload, 0), 'i1')
  assert.equal(boardItemIdForImage(payload, 1), 'i2')
  assert.equal(boardItemIdForImage(payload, 2), undefined)
  assert.equal(facts.boardId, 'b1')
  assert.equal(facts.ratio, '1:1')
  assert.equal(facts.steps, 8)
})

test('annotation geometry clamps to the image and renumbers after deletion', () => {
  const point = annotationPointFromClient(75, 50, { left: 0, top: 0, width: 100, height: 100 })
  assert.deepEqual(point, { x: 0.75, y: 0.5 })
  const list = [
    { id: 'a', number: 9, x: 0.2, y: 0.3, text: '改外套' },
    { id: 'b', number: 12, x: 1.4, y: -1, text: '补光' },
  ]
  const moved = moveAnnotation(list, 'b', 0.4, 0.6)
  assert.deepEqual(moved[1], { id: 'b', number: 12, x: 0.4, y: 0.6, text: '补光' })
  assert.deepEqual(renumberAnnotations([moved[0]]).map((entry) => entry.number), [1])
})

test('annotation handoff prompt names the original path and keeps preview out of edits', () => {
  const prompt = annotationHandoffPrompt({
    imagePath: 'C:/out/a.png', boardId: 'b1', itemId: 'i1', imageWidth: 1024, imageHeight: 1024,
    annotations: [
      { id: 'a', number: 1, x: 0.25, y: 0.4, text: '外套改成半透明琥珀色' },
      { id: 'b', number: 2, x: 0.8, y: 0.2, text: '' },
    ],
  })
  assert.match(prompt, /C:\/out\/a.png/)
  assert.match(prompt, /位置 25% \/ 40%：外套改成半透明琥珀色/)
  assert.match(prompt, /不要使用标注预览/)
  assert.match(prompt, /调用 qwen_image_edit/)
  assert.match(prompt, /调用时带上同一个 board id/)
})

test('Better Sidebar metadata dedupes by board item and detects a layout ancestor', () => {
  const meta = readImageEditorTabMeta({
    boardId: 'b1', itemId: 'i1', imagePath: 'C:/out/a.png', title: '第 3 版',
    layoutId: 'l1', width: 1024, height: 1024, theme: 'dark',
  })
  assert.equal(meta.title, '第 3 版')
  assert.equal(meta.theme, 'dark')
  assert.equal(imageEditorDedupeKey(meta), 'b1:i1')
  assert.match(imageEditorTabInstanceId(meta), /dsh-image-forge:image-editor/)
  const board = {
    items: [
      { id: 'l1', kind: 'layout' },
      { id: 'i1', kind: 'image', parents: ['l1'] },
    ],
  }
  assert.equal(layoutAncestorOf(board, 'i1').id, 'l1')
})

test('composer gate refuses nonempty and busy drafts and observes acceptance', async () => {
  assert.equal(composerHandoffGate(undefined).ready, false)
  let draft = 'existing'
  let phase = 'plain'
  const listeners = new Set()
  const input = {
    state: {
      getSnapshot: () => ({ draft, phase }),
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    },
    setDraft: () => {}, addAttachments: () => true, removeAttachment: () => true, submit: () => {},
  }
  assert.equal(composerHandoffGate(input).ready, false)
  draft = ''
  assert.equal(composerHandoffGate(input).ready, true)
  const accepted = watchComposerAccepted(input, 500)
  phase = 'sending'
  draft = 'queued'
  for (const listener of listeners) listener()
  phase = 'plain'
  draft = ''
  for (const listener of listeners) listener()
  assert.equal(await accepted, true)
})

test('Better Sidebar handoff is capability-gated and optional', () => {
  const absent = conversationImageHandoffCapability(undefined)
  assert.equal(absent.available, false)
  assert.match(absent.reason, /conversation/)
  const present = {
    input: { for: () => ({}) },
    createDrafts: () => [],
  }
  assert.equal(conversationImageHandoffCapability(present).available, true)
})

test('Better Sidebar registration is optional, targeted and deduped per board item', () => {
  const registered = []
  const opened = []
  const scope = { sessionId: 's1' }
  const service = {
    registerTab(descriptor) {
      registered.push(descriptor)
      return () => { descriptor.disposed = true }
    },
    openTab(seed, targetScope) {
      opened.push({ seed, targetScope })
    },
  }
  let registeredScope
  const ctx = {
    get: (name) => name === 'betterSidebar' ? service : undefined,
    sessions: { scope: (sessionId) => { registeredScope = sessionId; return scope } },
    effect: (fn) => fn(),
  }
  registerBetterSidebarTab(ctx)
  assert.equal(registered.length, 1)
  const descriptor = registered[0]
  assert.equal(descriptor.id, 'dsh-image-forge:image-editor')
  assert.equal(descriptor.title, '画面编辑')
  assert.equal(typeof descriptor.component, 'function')
  assert.equal(
    descriptor.dedupeKey({ meta: { boardId: 'b1', itemId: 'i1', imagePath: 'C:/out/a.png', title: '第 3 版' } }),
    'b1:i1',
  )
  assert.equal(
    descriptor.dedupeKey({ meta: { imagePath: 'C:/out/a.png', title: '临时画面' } }),
    'C:/out/a.png',
  )

  const meta = { boardId: 'b1', itemId: 'i1', imagePath: 'C:/out/a.png', title: '第 3 版' }
  assert.equal(openImageEditorTab(ctx, 's1', meta), true)
  assert.equal(registeredScope, 's1')
  assert.equal(opened.length, 1)
  assert.equal(opened[0].seed.type, 'dsh-image-forge:image-editor')
  assert.equal(opened[0].seed.target, 'right')
  assert.equal(opened[0].seed.title, '画面编辑 · 第 3 版')
  assert.deepEqual(opened[0].seed.meta, meta)
  assert.deepEqual(opened[0].targetScope, scope)

  assert.doesNotThrow(() => registerBetterSidebarTab({ get: () => undefined }))
  assert.equal(openImageEditorTab({ get: () => undefined }, 's1', meta), false, 'missing Better Sidebar is a safe no-op')
})
test('the browser half ships the result card, node editor and optional sidebar tab', () => {
  assert.match(CLIENT_SOURCE, /dsh-image-forge-result-card/)
  assert.match(CLIENT_SOURCE, /dsh-forge-node-editor/)
  assert.match(CLIENT_SOURCE, /dsh-image-forge:image-editor/)
  assert.match(CLIENT_SOURCE, /根据 \$\{String\(annotations\.length\)\} 条标注继续生成/)
  assert.match(CLIENT_SOURCE, /dsh-forge-canvas-composer/)
  assert.match(CLIENT_SOURCE, /dsh-forge-workbench-hero/)
  assert.match(CLIENT_SOURCE, /dsh-forge-context-panel/)
  assert.match(CLIENT_SOURCE, /dsh-image-forge-sidebar-pin-delete/)
  assert.match(CLIENT_SOURCE, /dsh-image-forge-sidebar-remove/)
  assert.match(CLIENT_SOURCE, /dsh-forge-box-float/)
  assert.match(CLIENT_SOURCE, /dsh-image-forge-sidebar-layout-workbench/)
  assert.match(CLIENT_SOURCE, /dsh-image-forge-sidebar-layout-section/)
  assert.match(CLIENT_SOURCE, /\.dsh-image-forge-result-hero \{ aspect-ratio: 16 \/ 9/)
  assert.ok(!CLIENT_SOURCE.includes('is-enlarged'), 'the annotation zoom mode is gone')
  assert.ok(!CLIENT_SOURCE.includes('点选标注中'), 'annotation has no mode toggle')
  assert.ok(!CLIENT_SOURCE.includes('已在对话里内联显示请**逐字复制**'))
  assert.ok(!TOOLS_SOURCE.includes('已在对话里内联显示请**逐字复制**'))
  assert.match(TOOLS_SOURCE, /不要再次把 markdown 字段中的图片粘贴到回复正文/)
})
