/**
 * MOSS-Image layout conditioning (T21): the compiled layout prompt, the graph it
 * conditions, and the parser that refuses to submit a layout MOSS would ignore.
 *
 * Design decision, verified against ComfyUI 0.45.3's own source
 * (`comfy_extras/nodes_moss_image.py`): the native `MOSSImageLayoutPrompt` node's
 * output is exactly this compiled JSON string, and the official bbox template
 * feeds it into the positive `CLIPTextEncode`. The plugin's layout editor already
 * produces the same string, so the layout path swaps the positive encoder's text
 * and nothing else. Its `element` input takes a `CreateBoundingBoxes` array, which
 * cannot be expressed over the API (every list is treated as a linked input, and
 * `CreateBoundingBoxes.editor_state` is a required widget with no producer) — hence
 * local compilation rather than a node chain.
 *
 * Format authority: `test/fixtures/layout/layout_prompt.json`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { renderTextToImage } from '../src/comfyui.ts'
import {
  MODEL_PROFILES,
  MOSS_IMAGE_LAYOUT_EDIT_WORKFLOW,
  MOSS_IMAGE_LAYOUT_WORKFLOW,
  MOSS_IMAGE_WORKFLOW,
  parseMossLayout,
} from '../src/model-profiles.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SAMPLE = readFileSync(join(HERE, 'fixtures', 'layout', 'layout_prompt.json'), 'utf8')

const MOSS_MODELS = {
  unet: 'moss_image_sft_int8_convrot.safetensors',
  clip: 'qwen3.5_9b_w4a8_gptq.safetensors',
  vae: 'flux2-vae_small.safetensors',
  clipType: 'moss_image',
  cache: false,
}
const QWEN_MODELS = {
  unet: 'qwen_image_2.1_int8_convrot.safetensors',
  clip: 'qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors',
  vae: 'qwen_image_2.1_vae_bf16.safetensors',
  clipType: 'qwen_image',
  cache: true,
}
const REQUEST = { prompt: 'A minimalist travel poster.', width: 1248, height: 1248, count: 1, seed: 42 }

const sampleDocument = () => JSON.parse(SAMPLE)

test('only the MOSS profile carries a layout template', () => {
  assert.equal(MODEL_PROFILES['moss-sft'].layoutTemplate, MOSS_IMAGE_LAYOUT_WORKFLOW)
  assert.equal(MODEL_PROFILES['qwen21-base'].layoutTemplate, undefined)
  assert.equal(MODEL_PROFILES['qwen21-turbo'].layoutTemplate, undefined)
  // The no-layout path feeds the sampler straight from the text encoders.
  assert.deepEqual(MOSS_IMAGE_WORKFLOW['8'].inputs.positive, ['4', 0])
  assert.deepEqual(MOSS_IMAGE_WORKFLOW['8'].inputs.negative, ['5', 0])
})

test('the experimental layout edit graph swaps only the positive edit prompt', () => {
  assert.equal(MOSS_IMAGE_LAYOUT_EDIT_WORKFLOW['7'].inputs.prompt, '{{layout_json}}')
  assert.equal(MOSS_IMAGE_LAYOUT_EDIT_WORKFLOW['8'].inputs.prompt, '{{negative_prompt}}')
  assert.equal(MOSS_IMAGE_LAYOUT_EDIT_WORKFLOW['9'].class_type, 'KSampler')
  assert.deepEqual(MOSS_IMAGE_LAYOUT_EDIT_WORKFLOW['9'].inputs.positive, ['7', 0])
  assert.deepEqual(MOSS_IMAGE_LAYOUT_EDIT_WORKFLOW['9'].inputs.negative, ['8', 0])
})

test('the layout graph changes only the positive encoder text', () => {
  const layout = MOSS_IMAGE_LAYOUT_WORKFLOW
  assert.equal(layout['4'].inputs.text, '{{layout_json}}')
  assert.deepEqual(layout['4'].inputs.clip, ['2', 0])
  const classes = Object.values(layout).map((node) => node.class_type)
  assert.equal(classes.includes('CreateBoundingBoxes'), false)
  assert.equal(classes.includes('MOSSImageLayoutPrompt'), false)
  assert.equal(classes.includes('MOSSImageControl'), false)
  // Everything else is the plain graph node for node.
  for (const [id, node] of Object.entries(MOSS_IMAGE_WORKFLOW)) {
    if (id === '4') continue
    assert.deepEqual(layout[id], node, 'node ' + id + ' must be unchanged')
  }
})

test('parseMossLayout accepts the compiled sample and hands the bytes back verbatim', () => {
  const parsed = parseMossLayout(SAMPLE)
  assert.equal(parsed.document.bbox_coord_space, 'abs_centralized')
  assert.equal(parsed.document.bbox_format, 'yxyx')
  assert.equal(parsed.document.items.length, 3)
  assert.equal(parsed.json, SAMPLE)
  assert.equal(parsed.document.items[0].label, 'text')
  assert.equal(parsed.document.items[0].text, 'EXPLORE')
  assert.equal(parsed.document.items[0].bbox.length, 4)
  assert.ok(parsed.document.summary.caption.length > 0)
})

test('the whole-image caption is required', () => {
  const missing = sampleDocument()
  delete missing.summary
  assert.throws(() => parseMossLayout(JSON.stringify(missing)), /summary\.caption 必须是非空字符串/)
  const blank = { ...sampleDocument(), summary: { caption: '   ' } }
  assert.throws(() => parseMossLayout(JSON.stringify(blank)), /summary\.caption 必须是非空字符串/)
})

test('parseMossLayout refuses anything MOSS would ignore', () => {
  const valid = {
    summary: { caption: 'A poster.' },
    bbox_coord_space: 'abs_centralized',
    bbox_format: 'yxyx',
    items: [{ label: 'object', caption: 'a tree', bbox: [0, 0, 10, 10] }],
  }
  assert.throws(() => parseMossLayout('{not json'), /moss layout: 布局不是合法 JSON/)
  assert.throws(() => parseMossLayout('[]'), /moss layout: 布局必须是一个 JSON 对象/)
  assert.throws(
    () => parseMossLayout(JSON.stringify({ ...valid, bbox_coord_space: 'abs' })),
    /bbox_coord_space 必须是 abs_centralized/,
  )
  assert.throws(
    () => parseMossLayout(JSON.stringify({ ...valid, bbox_format: 'xyxy' })),
    /bbox_format 必须是 yxyx/,
  )
  assert.throws(() => parseMossLayout(JSON.stringify({ ...valid, items: [] })), /items 必须是非空数组/)
  assert.throws(
    () => parseMossLayout(JSON.stringify({ ...valid, items: [{ label: 'object', caption: '', bbox: [0, 0, 1, 1] }] })),
    /caption 必须是非空字符串/,
  )
  assert.throws(
    () => parseMossLayout(JSON.stringify({ ...valid, items: [{ label: 'tree', caption: 'x', bbox: [0, 0, 1, 1] }] })),
    /label 只能是 object \/ character \/ text/,
  )
  assert.throws(
    () => parseMossLayout(JSON.stringify({ ...valid, items: [{ label: 'object', caption: 'x', bbox: [0, 0, 1] }] })),
    /bbox 必须是 \[y1, x1, y2, x2\] 四个有限数字/,
  )
})

test('without a layout the renderer returns the plain MOSS graph', () => {
  const graph = renderTextToImage(MODEL_PROFILES['moss-sft'], MOSS_MODELS, REQUEST)
  assert.equal(graph['4'].inputs.text, REQUEST.prompt)
  assert.deepEqual(graph['8'].inputs.positive, ['4', 0])
  assert.deepEqual(graph['8'].inputs.negative, ['5', 0])
  assert.equal(Object.values(graph).some((node) => node.class_type === 'MOSSImageControl'), false)
})

test('with a layout the renderer makes the compiled JSON the positive prompt', () => {
  const graph = renderTextToImage(MODEL_PROFILES['moss-sft'], MOSS_MODELS, { ...REQUEST, layout: SAMPLE })
  // Verbatim: no re-serialisation, so the text MOSS reads is exactly the editor's export.
  assert.equal(graph['4'].inputs.text, SAMPLE)
  assert.equal(graph['5'].inputs.text, 'nsfw, worst quality, bad anatomy, watermark, jpeg artifact')
  assert.deepEqual(graph['8'].inputs.positive, ['4', 0])
  // No extra nodes were injected; the rest of the graph is the plain one.
  assert.deepEqual(
    Object.keys(graph).sort(),
    Object.keys(MOSS_IMAGE_WORKFLOW).sort(),
  )
})

test('a layout on a profile without a layout path is refused, not dropped', () => {
  assert.throws(
    () => renderTextToImage(MODEL_PROFILES['qwen21-base'], QWEN_MODELS, { ...REQUEST, layout: SAMPLE }),
    /布局（layout）只对 MOSS-Image 生效/,
  )
})

test('a malformed layout is refused before rendering', () => {
  assert.throws(
    () => renderTextToImage(MODEL_PROFILES['moss-sft'], MOSS_MODELS, { ...REQUEST, layout: '{"items":[]}' }),
    /bbox_coord_space 必须是 abs_centralized/,
  )
})
