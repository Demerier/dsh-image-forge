import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  analyzeReviewer,
  auditFixtures,
  buildMossGraph,
  buildQwenGraph,
  buildTextGenerateGraph,
  expectedImageTasks,
  generateAll,
  loadFixtures,
  resolveWeights,
  runCheck,
  ROOT,
  rerenderReviewer,
  scoreAll,
  shuffle,
} from './blind-pe.mjs'
import { renderRankingPage } from './blind-pe-page.mjs'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function fakeComfyFetch() {
  const prompts = new Map()
  let sequence = 0
  return async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/object_info') {
      return jsonResponse({
        UNETLoader: { input: { required: { unet_name: [[
          'qwen_image_2.1_int8_convrot.safetensors',
          'qwen_image_2.1_turbo_int8_convrot.safetensors',
          'moss_image_sft_int8_convrot.safetensors',
        ], {}] } } },
        CLIPLoader: { input: { required: { clip_name: [[
          'qwen3vl_8b_int8_convrot.safetensors',
          'qwen3.5_9b_w4a8_gptq.safetensors',
        ], {}] } } },
        VAELoader: { input: { required: { vae_name: [[
          'qwen_image_2.1_vae_bf16.safetensors',
          'flux2-vae_small.safetensors',
        ], {}] } } },
        QwenImage21Cache: { input: { required: {} } },
      })
    }
    if (url.pathname === '/prompt') {
      const body = JSON.parse(init.body)
      const graph = body.prompt
      sequence += 1
      const promptId = `fake-${sequence}`
      const isText = Object.values(graph).some((node) => node.class_type === 'TextGenerateV2')
      prompts.set(promptId, { graph, isText })
      return jsonResponse({ prompt_id: promptId, number: sequence, node_errors: {} })
    }
    if (url.pathname.startsWith('/history/')) {
      const promptId = url.pathname.slice('/history/'.length)
      const record = prompts.get(promptId)
      if (!record) return jsonResponse({})
      if (record.isText) {
        const brief = record.graph['3'].inputs.value
        return jsonResponse({
          [promptId]: {
            outputs: { '5': { text: [`A detailed frozen caption for the brief: ${brief}`] } },
            status: { status_str: 'success', completed: true, messages: [] },
          },
        })
      }
      const saveId = Object.entries(record.graph).find(([, node]) => node.class_type === 'SaveImage')[0]
      return jsonResponse({
        [promptId]: {
          outputs: { [saveId]: { images: [{ filename: `${promptId}.png`, subfolder: '', type: 'output' }] } },
          status: { status_str: 'success', completed: true, messages: [] },
        },
      })
    }
    if (url.pathname === '/view') return new Response(PNG_1X1, { headers: { 'content-type': 'image/png' } })
    return jsonResponse({ error: url.pathname }, 404)
  }
}

test('fixtures audit passes and IP evidence removal is rejected', () => {
  const fixtures = loadFixtures()
  const result = auditFixtures(fixtures)
  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.deepEqual(result.counts, { main: 24, ip: 18 })
  assert.deepEqual(result.characterCounts, { generated: 3, textOnly: 1 })

  const broken = structuredClone(fixtures)
  broken.ip.characters[0].evidence = []
  broken.ip.characters[0].defaultForm = ''
  const failed = auditFixtures(broken)
  assert.equal(failed.ok, false)
  assert.ok(failed.errors.some((error) => error.includes('官方证据')))
  assert.ok(failed.errors.some((error) => error.includes('defaultForm')))
})

test('Qwen and MOSS graphs pin the accepted sampling and the enhancer stays outside scoring', () => {
  const fixtures = loadFixtures()
  const objectInfo = {
    UNETLoader: { input: { required: { unet_name: [[
      'qwen_image_2.1_int8_convrot.safetensors',
      'qwen_image_2.1_turbo_int8_convrot.safetensors',
      'moss_image_sft_int8_convrot.safetensors',
    ], {}] } } },
    CLIPLoader: { input: { required: { clip_name: [[
      'qwen3vl_8b_int8_convrot.safetensors',
      'qwen3.5_9b_w4a8_gptq.safetensors',
    ], {}] } } },
    VAELoader: { input: { required: { vae_name: [[
      'qwen_image_2.1_vae_bf16.safetensors',
      'flux2-vae_small.safetensors',
    ], {}] } } },
  }
  const weights = resolveWeights(objectInfo, fixtures.config)

  const qwen = buildQwenGraph({ prompt: 'test', seed: 7, models: weights['qwen21-base'], config: fixtures.config, supportsCache: true })
  assert.equal(qwen['6'].inputs.steps, 40)
  assert.equal(qwen['6'].inputs.cfg, 1)
  assert.equal(qwen['6'].inputs.sampler_name, 'euler')
  assert.equal(qwen['6'].inputs.scheduler, 'simple')
  assert.equal(qwen['5'].inputs.width, 1024)
  assert.equal(qwen['9'].class_type, 'QwenImage21Cache')

  const moss = buildMossGraph({ prompt: 'test', seed: 7, models: weights['moss-sft'], config: fixtures.config })
  assert.equal(moss['8'].inputs.steps, 25)
  assert.equal(moss['8'].inputs.cfg, 2.5)
  assert.equal(moss['8'].inputs.sampler_name, 'er_sde')
  assert.equal(moss['8'].inputs.scheduler, 'simple')
  assert.equal(moss['6'].inputs.width, 1024)
  assert.equal(Object.values(moss).some((node) => node.class_type === 'TextGenerateV2'), false)

  const text = buildTextGenerateGraph({ brief: 'brief', models: weights, config: fixtures.config })
  assert.equal(text['4'].class_type, 'TextGenerateV2')
  assert.equal(text['4'].inputs['sampling_mode.seed'], 0)
  assert.equal(text['4'].inputs['sampling_mode.temperature'], 0.7)
  assert.equal(text['5'].class_type, 'PreviewAny')

  const tasks = expectedImageTasks(fixtures, [])
  assert.equal(tasks.filter((task) => task.scope === 'main').length, 24)
  assert.equal(tasks.filter((task) => task.scope === 'ip').length, 18)
})

test('ranking page needs unique ranks in every group and exports only when complete', () => {
  const data = {
    title: '测试排名',
    lead: '候选来源已隐藏',
    exportTitle: '测试导出',
    guidanceTitle: '评选重点',
    guidance: ['候选来源已隐藏'],
    notes: { label: '补充说明（可选）', placeholder: '写明具体疑点' },
    briefs: [{
      id: 'X',
      brief: '测试原始需求',
      groups: [
        { id: 'g1', label: '候选组 A', kind: 'image', items: [{ label: 'A', src: 'a.png' }, { label: 'B', src: 'b.png' }, { label: 'C', src: 'c.png' }] },
        { id: 'g2', label: '候选组 B', kind: 'image', items: [{ label: 'A', src: 'd.png' }, { label: 'B', src: 'e.png' }, { label: 'C', src: 'f.png' }, { label: 'D', src: 'g.png' }, { label: 'E', src: 'h.png' }] },
      ],
    }],
  }
  const html = renderRankingPage(data)
  assert.equal(html.includes('key.json'), false)
  assert.doesNotMatch(html, /\b(?:qwen21-base|moss-sft|official-skill|text-generate-v2|GOLD)\b/i)

  const script = html.match(/<script>([\s\S]*?)<\/script>/i)?.[1]
  assert.ok(script)
  const selects = [
    ...['g1', 'g1', 'g1'].map((group, index) => ({ dataset: { group, item: String.fromCharCode(65 + index) }, value: '', classList: { contains: (name) => name === 'rank-select' } })),
    ...['g2', 'g2', 'g2', 'g2', 'g2'].map((group, index) => ({ dataset: { group, item: String.fromCharCode(65 + index) }, value: '', classList: { contains: (name) => name === 'rank-select' } })),
  ]
  const makeEl = (id) => ({ id, value: '', textContent: '', disabled: false, classList: { add() {} }, addEventListener() {}, focus() {}, select() {} })
  const elements = new Map()
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl(id))
    return elements.get(id)
  }
  const noteBoxes = [
    { dataset: { group: 'g1' }, value: '' },
    { dataset: { group: 'g2' }, value: '' },
  ]
  const document = {
    getElementById: element,
    querySelectorAll: (selector) => (selector === '.rank-select' ? selects : selector === '.group-note' ? noteBoxes : []),
    addEventListener() {},
  }
  const api = new Function('document', 'window', script + '; return { refresh, buildExportText }')(document, { open() {} })
  api.refresh()
  assert.equal(element('export').disabled, true)

  const ranks = [1, 2, 3, 1, 2, 3, 4, 5]
  selects.forEach((select, index) => { select.value = String(ranks[index]) })
  api.refresh()
  assert.equal(element('export').disabled, false)
  noteBoxes[0].value = 'A 更像，但 B 多出错误属性'
  const exported = api.buildExportText()
  assert.match(exported, /候选组 A/)
  assert.match(exported, /1=A/)
  assert.match(exported, /补充说明：A 更像，但 B 多出错误属性/)

  selects[1].value = '1'
  api.refresh()
  assert.equal(element('export').disabled, true)
})

test('fake ComfyUI exercises text capture, 42-image selection, randomized pages and export', async () => {
  const fixtures = loadFixtures()
  const outDir = mkdtempSync(join(tmpdir(), 'blind-pe-test-'))
  try {
    const result = await generateAll({
      fixtures,
      outDir,
      endpoint: 'http://fake-comfy',
      fetchImpl: fakeComfyFetch(),
      log: () => {},
    })
    const frozen = JSON.parse(readFileSync(join(outDir, 'text-generate-v2.json'), 'utf8'))
    assert.equal(frozen.items.length, 7)
    assert.ok(frozen.items.every((item) => item.prompt.startsWith('A detailed frozen caption')))

    assert.equal(result.key.images.length, 42)
    assert.equal(new Set(result.key.images.map((entry) => entry.filename)).size, 42)
    assert.ok(result.key.images.every((entry) => /^img-[0-9a-f]{16}\.png$/.test(entry.filename)))
    assert.equal(result.key.images.filter((entry) => entry.model === 'qwen21-base' && entry.scope === 'main').length, 9)
    assert.equal(result.key.images.filter((entry) => entry.model === 'moss-sft' && entry.scope === 'main').length, 15)
    assert.equal(result.key.images.filter((entry) => entry.model === 'qwen21-base' && entry.scope === 'ip').length, 6)
    assert.equal(result.key.images.filter((entry) => entry.model === 'moss-sft' && entry.scope === 'ip').length, 12)

    const scored = scoreAll({ fixtures, outDir, reviewerId: 'reviewer-1', skipPixels: true })
    assert.deepEqual(scored.pages, ['main-images', 'ip-images'])
    const reviewerKey = JSON.parse(readFileSync(join(outDir, 'reviewers', 'reviewer-1', 'key.json'), 'utf8'))
    assert.equal(Object.keys(reviewerKey.pages).length, 2)
    assert.ok(readFileSync(join(outDir, 'reviewers', 'reviewer-1', 'main-images.html'), 'utf8').includes('class="group-note"'))
    assert.ok(Object.values(reviewerKey.pages).every((page) => page.groups.every((group) => group.shuffled)))

    const firstGroupId = reviewerKey.pages['ip-images'].groups[0].id
    rerenderReviewer({ fixtures, outDir, reviewerId: 'reviewer-1' })
    const ipHtml = readFileSync(join(outDir, 'reviewers', 'reviewer-1', 'ip-images.html'), 'utf8')
    assert.ok(ipHtml.includes('class="group-note"'))
    const rerenderedKey = JSON.parse(readFileSync(join(outDir, 'reviewers', 'reviewer-1', 'key.json'), 'utf8'))
    assert.equal(rerenderedKey.pages['ip-images'].groups[0].id, firstGroupId)
    assert.equal(rerenderedKey.pages['ip-images'].notesExpected, true)
    assert.equal(Object.keys(rerenderedKey.pages).length, 2)

    scoreAll({ fixtures, outDir, reviewerId: 'reviewer-2', skipPixels: true })
    assert.ok(existsSync(join(outDir, 'reviewers', 'reviewer-2', 'main-images.html')))
    const reviewerKey2 = JSON.parse(readFileSync(join(outDir, 'reviewers', 'reviewer-2', 'key.json'), 'utf8'))
    assert.notEqual(reviewerKey2.pages['main-images'].groups[0].id, reviewerKey.pages['main-images'].groups[0].id)

    const structural = runCheck({ fixtures, outDir, skipPixels: true, requireReviewers: true })
    assert.equal(structural.ok, true, structural.errors.join('\n'))
    const dimensions = runCheck({ fixtures, outDir, skipPixels: false, requireReviewers: true })
    assert.equal(dimensions.ok, false)
    assert.ok(dimensions.errors.some((error) => error.includes('尺寸')))
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('shuffle changes a canonical order deterministically under an injected RNG', () => {
  const sequence = [0, 1, 0, 2, 0]
  let index = 0
  const rng = (max) => sequence[(index++) % sequence.length] % max
  const order = shuffle(['raw', 'project', 'gold'], rng)
  assert.notDeepEqual(order, ['raw', 'project', 'gold'])
})

test('v2 fixtures expand six topics into 96 images with two shared seeds each', () => {
  const fixtures = loadFixtures(ROOT, 'v2')
  const audit = auditFixtures(fixtures)
  assert.equal(audit.ok, true, audit.errors.join('\n'))
  assert.deepEqual(audit.counts, { main: 96, ip: 0 })
  assert.equal(fixtures.main.briefs.length, 6)
  assert.equal(fixtures.ip.characters.length, 0)

  const tasks = expectedImageTasks(fixtures, [])
  assert.equal(tasks.length, 96)
  assert.equal(tasks.filter((task) => task.model === 'qwen21-base').length, 36)
  assert.equal(tasks.filter((task) => task.model === 'moss-sft').length, 60)
  const seeds = [...new Set(tasks.map((task) => task.seed))]
  assert.equal(seeds.length, 12)
  for (const brief of fixtures.main.briefs) {
    assert.equal(brief.seeds.length, 2)
    const briefTasks = tasks.filter((task) => task.fixtureId === brief.id)
    for (const seed of brief.seeds) {
      assert.equal(briefTasks.filter((task) => task.seed === seed).length, 8)
    }
  }
})

test('v2 fake ComfyUI generates 96 images and image-only reviewer pages', async () => {
  const fixtures = loadFixtures(ROOT, 'v2')
  const outDir = mkdtempSync(join(tmpdir(), 'blind-pe-v2-test-'))
  try {
    const result = await generateAll({
      fixtures,
      outDir,
      endpoint: 'http://fake-comfy-v2',
      fetchImpl: fakeComfyFetch(),
      log: () => {},
    })
    const frozen = JSON.parse(readFileSync(join(outDir, 'text-generate-v2.json'), 'utf8'))
    assert.equal(frozen.version, 'pe-blind-v2')
    assert.equal(frozen.items.length, 6)
    assert.equal(result.key.version, 'pe-blind-v2')
    assert.equal(result.key.images.length, 96)
    assert.equal(result.key.images.filter((entry) => entry.model === 'qwen21-base').length, 36)
    assert.equal(result.key.images.filter((entry) => entry.model === 'moss-sft').length, 60)

    const scored = scoreAll({ fixtures, outDir, reviewerId: 'reviewer-1', skipPixels: true })
    assert.deepEqual(scored.pages, ['main-images'])
    const reviewerKey = JSON.parse(readFileSync(join(outDir, 'reviewers', 'reviewer-1', 'key.json'), 'utf8'))
    assert.deepEqual(Object.keys(reviewerKey.pages), ['main-images'])
    assert.equal(reviewerKey.pages['main-images'].groups.length, 24)
    const html = readFileSync(join(outDir, 'reviewers', 'reviewer-1', 'main-images.html'), 'utf8')
    assert.equal((html.match(/class=\"group-note\"/g) || []).length, 24)
    for (const seed of [...new Set(result.key.images.map((entry) => entry.seed))]) assert.equal(html.includes(String(seed)), false)
    assert.equal(html.includes('main-text.html'), false)

    scoreAll({ fixtures, outDir, reviewerId: 'reviewer-2', skipPixels: true })
    const reviewerKey2 = JSON.parse(readFileSync(join(outDir, 'reviewers', 'reviewer-2', 'key.json'), 'utf8'))
    assert.notEqual(reviewerKey2.pages['main-images'].groups[0].id, reviewerKey.pages['main-images'].groups[0].id)

    const structural = runCheck({ fixtures, outDir, skipPixels: true, requireReviewers: true })
    assert.equal(structural.ok, true, structural.errors.join('\n'))
    const dimensions = runCheck({ fixtures, outDir, skipPixels: false, requireReviewers: true })
    assert.equal(dimensions.ok, false)

    const groups = reviewerKey.pages['main-images'].groups
    const exportLines = ['PE 盲测 v2 · 通用题目图片排名', '']
    for (const group of groups) {
      const picks = group.items.map((item, index) => `${index + 1}=${item.label}`).join('，')
      exportLines.push(`- ${group.label}：${picks}`)
      exportLines.push('  - 补充说明：自动化测试说明')
    }
    const exportPath = join(outDir, 'reviewers', 'reviewer-1', 'rankings.txt')
    writeFileSync(exportPath, exportLines.join('\n') + '\n', 'utf8')
    const analysis = analyzeReviewer({ fixtures, outDir, reviewerId: 'reviewer-1', inputPath: exportPath })
    assert.ok(existsSync(analysis.markdownPath))
    assert.ok(existsSync(analysis.jsonPath))
    assert.ok(analysis.summary['qwen21-base'].every((item) => Number.isFinite(item.meanSeedSpread)))
    assert.ok(analysis.summary['moss-sft'].every((item) => Number.isFinite(item.meanSeedSpread)))
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})
