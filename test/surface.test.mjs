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
  for (const field of [
    'backend',
    'apiBaseUrl',
    'apiKey',
    'apiModel',
    'apiStyle',
    'comfyEndpoint',
    'comfyPorts',
    'comfyModelsDir',
    'defaultSteps',
    'comfyuiSteps',
    'comfyModel',
    'turboSteps',
    'outputDir',
    'timeoutMs',
  ]) {
    assert.ok(field in resolved, `Config must expose ${field}`)
  }
  // The plugin owns no runtime of its own any more: the venv / weights / worker
  // knobs are gone, and a stray one coming back would mean the old local-worker
  // path is being reintroduced under a different name.
  for (const retired of ['localEndpoint', 'runtimeDir', 'modelsDir', 'pythonPath', 'workerScript', 'minFreeVramMiB', 'manageWorker']) {
    assert.ok(!(retired in resolved), `Config must not expose the retired runtime field ${retired}`)
  }
})

test('apply registers the three qwen_image_* tools and the skill', () => {
  const { ctx, tools, skills } = captureContext()
  plugin.apply(ctx, configWith({ outputDir: mkdtempSync(join(tmpdir(), 'forge-surface-')) }))
  assert.deepEqual([...tools.keys()].sort(), [
    'qwen_image_edit',
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
test('both image tools offer exactly the three backends, and status needs no parameters', () => {
  const { ctx, tools } = captureContext()
  plugin.apply(ctx, configWith({ outputDir: mkdtempSync(join(tmpdir(), 'forge-schema2-')) }))
  for (const tool of ['qwen_image_generate', 'qwen_image_edit']) {
    const genNode = tools.get(tool).parameters
    const backendNode = genNode?.properties?.backend ?? genNode?.backend
    assert.deepEqual(backendNode.enum, ['auto', 'api', 'comfyui'], `${tool}.backend must offer exactly the surviving backends`)
  }
  // `qwen_image_env` is gone; the surviving status tool is read-only and takes
  // only an optional timeout budget.
  assert.equal(tools.get('qwen_image_env'), undefined, 'the local-runtime tool must not come back')
  const statusNode = tools.get('qwen_image_status').parameters
  assert.deepEqual(Object.keys(statusNode?.properties ?? statusNode ?? {}), ['timeoutMs'])
  const genNode = tools.get('qwen_image_generate').parameters
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

test('the composed skill body describes only the two surviving backends', () => {
  const { ctx, skills } = captureContext()
  plugin.apply(ctx, configWith({ outputDir: mkdtempSync(join(tmpdir(), 'forge-skill-knobs-')) }))
  // `src/skill.ts` reads `skill.md` at **runtime** (`readFileSync(new URL("../skill.md", …
  // import.meta.url))`), so the bundle's own text proves nothing about what the model
  // receives. This is the composed body — the same string the skill registration ships.
  const content = skills[0].content
  const mentions = (needle) => content.split(needle).length - 1
  console.log('composed skill body chars:', content.length, JSON.stringify({
    qwen_image_status: mentions('qwen_image_status'),
    qwen_image_env: mentions('qwen_image_env'),
    comfyModel: mentions('comfyModel'),
    deploymentDoc: mentions('docs/comfyui-deployment.md'),
  }))

  // The tool the model is told about must be one that exists, and the retired
  // local-runtime tool must not be described anywhere in the body.
  assert.ok(mentions('qwen_image_status') >= 1, 'the skill must point at the surviving status tool')
  assert.equal(mentions('qwen_image_env'), 0, 'the skill still documents a tool that no longer exists')

  // Two backends, named as such — and the retried `local` tier must not be offered.
  assert.match(content, /可以选择的后端只有|可选后端只有两档/)
  assert.match(content, /云 API \*\*没有编辑通道\*\*|只有文生图通道，没有编辑通道/)
  assert.ok(!/`local`（零下载|backend: "local"` 走/.test(content), 'the skill still offers the removed local backend')

  // Every retired knob is gone from the body: a config field the model would have
  // to ask a user to set, which no longer exists, is worse than no advice at all.
  for (const retired of [
    'localReferenceBudget',
    'allowLocalEditOverBudget',
    'freeComfyBeforeLocalStart',
    'minFreeVramMiB',
    'local_edit_budget',
    'qwen_image_env',
  ]) {
    assert.equal(mentions(retired), 0, `the retired knob ${retired} is still in the skill body`)
  }

  // Turbo / base is a config decision the model has to explain, so both families,
  // the step counts and the fallback disclaimer must be spelled out.
  assert.match(content, /comfyModel/)
  assert.match(content, /turbo/)
  assert.match(content, /8 步/)
  assert.match(content, /turbo_fallback/)
  // Deployment is delegated to the one document that actually holds the steps.
  assert.match(content, /docs\/comfyui-deployment\.md/)
})
