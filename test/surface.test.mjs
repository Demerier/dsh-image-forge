/**
 * Loadable-surface contract: the four exports, the registered tool names, and
 * the `wh_ratio` parameter as it actually reaches the model.
 *
 * Runs against `lib/index.js` — the file DSH loads — so a build regression
 * fails here rather than in a live session.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as plugin from '../lib/index.js'

/** A cordis-shaped stub that records what the plugin registers. */
function captureContext() {
  const tools = new Map()
  const skills = []
  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    skills: { register: (registration) => skills.push(registration) },
  }
  return { ctx, tools, skills }
}

/** Build a config object with the schema defaults applied, then override. */
function configWith(overrides) {
  return { ...plugin.Config({}), ...overrides }
}

test('the built module exports exactly name / inject / Config / apply', () => {
  const keys = Object.keys(plugin).sort()
  console.log('lib/index.js exports:', keys)
  assert.deepEqual(keys, ['Config', 'apply', 'inject', 'name'])
  assert.equal(plugin.name, 'dsh-image-forge')
  assert.deepEqual(plugin.inject, ['tools', 'skills'])
})

test('the config schema resolves every documented field', () => {
  const resolved = plugin.Config({})
  console.log('resolved config:', JSON.stringify({ ...resolved, apiKey: resolved.apiKey === '' ? '<empty>' : '<set>' }))
  for (const field of ['backend', 'apiBaseUrl', 'apiKey', 'apiModel', 'outputDir', 'timeoutMs', 'localEndpoint']) {
    assert.ok(field in resolved, `Config must expose ${field}`)
  }
})

test('apply registers the four qwen_image_* tools and the skill', () => {
  const { ctx, tools, skills } = captureContext()
  plugin.apply(ctx, configWith({ outputDir: mkdtempSync(join(tmpdir(), 'forge-surface-')) }))
  assert.deepEqual([...tools.keys()].sort(), [
    'qwen_image_edit',
    'qwen_image_env',
    'qwen_image_generate',
    'qwen_image_status',
  ])
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, 'qwen-image-forge')
  assert.equal(skills[0].source, 'runtime')
})

test('qwen_image_edit requires images and carries the ratio pair as plain strings', () => {
  const { ctx, tools } = captureContext()
  plugin.apply(ctx, configWith({ outputDir: mkdtempSync(join(tmpdir(), 'forge-edit-schema-')) }))
  const definition = tools.get('qwen_image_edit')
  const parameters = definition.parameters
  const property = (name) => parameters?.properties?.[name] ?? parameters?.[name]
  const images = property('images')
  console.log('qwen_image_edit.images parameter node:', JSON.stringify(images))
  assert.equal(images.type, 'array')
  assert.deepEqual(images.items, { type: 'string' })
  assert.deepEqual(parameters.required ?? [], ['prompt', 'images'])
  // `ratio_follow` takes `imageN` labels *and* paths, so it is a free string;
  // `wh_ratio` keeps the seven official tiers. Their exclusivity is a runtime
  // rule (asserted in edit-e2e.test.mjs), not a schema one.
  assert.equal(property('ratio_follow').type, 'string')
  assert.equal(property('ratio_follow').enum, undefined)
  assert.deepEqual(property('wh_ratio').enum, ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'])
})

test('wh_ratio is a first-class enum carrying the seven official tiers', () => {
  const { ctx, tools } = captureContext()
  plugin.apply(ctx, configWith({ outputDir: mkdtempSync(join(tmpdir(), 'forge-schema-')) }))
  const definition = tools.get('qwen_image_generate')
  const parameters = definition.parameters
  const node = parameters?.properties?.wh_ratio ?? parameters?.wh_ratio
  assert.ok(node !== undefined, `wh_ratio missing from the parameter schema: ${JSON.stringify(Object.keys(parameters ?? {}))}`)
  console.log('wh_ratio parameter node:', JSON.stringify(node, null, 2))
  assert.equal(node.type, 'string')
  assert.deepEqual(node.enum, ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'])
})

/**
 * The seven official tiers as `skill.md` tabulates them: ratio → the
 * 32-aligned pixel pair the tool's own `DEFAULT_SIZES` resolves to.
 */
const CONVERSION_TABLE = {
  '1:1': '1248×1248',
  '4:3': '1408×1056',
  '3:4': '1056×1408',
  '3:2': '1536×1024',
  '2:3': '1024×1536',
  '16:9': '1664×928',
  '9:16': '928×1664',
}

/** Documents a `wh_ratio` description may cite, relative to the package root. */
const CITABLE_DOCS = ['skill.md', 'references/t2i_rules.md', 'references/edit_rules.md']

test('the wh_ratio description cites a document that really prints the conversion table', () => {
  const { ctx, tools } = captureContext()
  plugin.apply(ctx, configWith({ outputDir: mkdtempSync(join(tmpdir(), 'forge-pointer-')) }))
  const parameters = tools.get('qwen_image_generate').parameters
  const description = (parameters?.properties?.wh_ratio ?? parameters?.wh_ratio).description
  console.log('wh_ratio description:', description)

  // `skill.md` is the skill body itself, so a pointer at it reads 「skill … 正文」
  // rather than a file path; the two reference files are cited by path.
  const cited = CITABLE_DOCS.filter(
    (relative) => description.includes(relative) || (relative === 'skill.md' && description.includes('正文')),
  )
  assert.equal(cited.length, 1, `expected exactly one cited document, got ${JSON.stringify(cited)}`)

  // Read the document the description points at, and demand the table there —
  // citing a file that has no table is the defect this test pins down.
  const root = fileURLToPath(new URL('..', import.meta.url))
  const doc = readFileSync(join(root, cited[0]), 'utf8')
  for (const [ratio, pixels] of Object.entries(CONVERSION_TABLE)) {
    assert.match(
      doc,
      new RegExp(`^\\|[^|\\n]*${ratio}[^|\\n]*\\|\\s*${pixels}\\s*\\|`, 'm'),
      `${cited[0]} must print the ${ratio} → ${pixels} row`,
    )
  }
})
test('qwen_image_env declares the five actions and qwen_image_generate the four backends', () => {
  const { ctx, tools } = captureContext()
  plugin.apply(ctx, configWith({ outputDir: mkdtempSync(join(tmpdir(), 'forge-schema2-')) }))
  const envNode = tools.get('qwen_image_env').parameters
  const actionNode = envNode?.properties?.action ?? envNode?.action
  assert.deepEqual(actionNode.enum, ['status', 'install', 'fetch-weights', 'repair', 'unload'])
  const genNode = tools.get('qwen_image_generate').parameters
  const backendNode = genNode?.properties?.backend ?? genNode?.backend
  assert.deepEqual(backendNode.enum, ['auto', 'api', 'local', 'comfyui'])
  const required = genNode?.required ?? []
  console.log('required parameters:', JSON.stringify(required))
  assert.ok(required.includes('prompt'), 'prompt must be required')
})

test('the skill body ships its reference documents with usable absolute paths', () => {
  const { ctx, skills } = captureContext()
  plugin.apply(ctx, configWith({ outputDir: mkdtempSync(join(tmpdir(), 'forge-skill-')) }))
  const content = skills[0].content
  assert.match(content, /t2i_rules\.md/)
  assert.match(content, /edit_rules\.md/)
  const paths = [...content.matchAll(/本机绝对路径：`([^`]+)`/g)].map((match) => match[1])
  console.log('reference paths injected into the skill body:', paths)
  assert.equal(paths.length, 2)
  for (const path of paths) assert.ok(path.endsWith('.md') && path.includes('dsh-image-forge'), path)
})

test('the composed skill body carries the two new knobs the way the model reads them', () => {
  const { ctx, skills } = captureContext()
  plugin.apply(ctx, configWith({ outputDir: mkdtempSync(join(tmpdir(), 'forge-skill-knobs-')) }))
  // `src/skill.ts` reads `skill.md` at **runtime** (`readFileSync(new URL("../skill.md", …
  // import.meta.url))`), so the bundle's own text proves nothing about what the model
  // receives. This is the composed body — the same string the skill registration ships.
  const content = skills[0].content
  const mentions = (needle) => content.split(needle).length - 1
  console.log('composed skill body chars:', content.length, JSON.stringify({
    localReferenceBudget: mentions('localReferenceBudget'),
    cudaMallocAsync: mentions('cudaMallocAsync'),
    'OSError 1455': mentions('OSError 1455'),
    freeComfyBeforeLocalStart: mentions('freeComfyBeforeLocalStart'),
    保真: mentions('保真'),
    未测: mentions('未测'),
  }))

  // P1: the budget knob, its default, and the trade it makes — in the gate section
  // and again in the pitfalls list, so a model that skips one still sees it.
  assert.ok(mentions('localReferenceBudget') >= 2, 'the knob must be named in both the gate section and the pitfalls list')
  assert.match(content, /`0`\s*=\s*默认\s*=\s*按画布推导|0.*按画布推导/)
  assert.match(content, /参考图条件化分辨率/)
  assert.match(content, /只影响 `local` 编辑|只影响 `local`/)
  // The fidelity side is a 1-image, 1-judge comparison (n=1), so the body has to
  // say that rather than either "no side effects" or a blanket "unmeasured" — and
  // the withdrawn blanket claim must not come back.
  assert.match(content, /目视看不出差别/)
  assert.match(content, /n=1/)
  assert.ok(!content.includes('保真代价未测'), 'the withdrawn blanket fidelity claim is back')
  assert.ok(!content.includes('保真度的代价未测'), 'the withdrawn blanket fidelity claim is back')

  // P2: both shapes of a full card, and the retry that clears OSError 1455.
  assert.match(content, /cudaMallocAsync/)
  assert.match(content, /OSError 1455/)
  assert.match(content, /nvidia-smi --query-compute-apps/)
  assert.match(content, /freeComfyBeforeLocalStart/)
  // The skill must not tell the model the old, wrong thing about a backend that is
  // already gated: `comfyui` stays ungated, and that sentence has to survive.
  assert.match(content, /这道门\*\*只拦 `local`\*\*/)
})
