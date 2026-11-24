/**
 * PE 盲测工具：v1 三题 + IP，或 v2 六道通用题 × 双 seed。
 *
 * 用法：
 *   node test/blind-pe.mjs audit [--round v1|v2]
 *   node test/blind-pe.mjs generate [--round v2] [--refresh-text] [--endpoint http://127.0.0.1:8188]
 *   node test/blind-pe.mjs score [--round v2] [--reviewer reviewer-1] [--rerender]
 *   node test/blind-pe.mjs check [--round v2]
 *
 * 这是一个开发工具，直接调用 ComfyUI，不经过插件工具和画板。生成图片和答案
 * 落在对应版本的 .blindtest/pe-v1/ 或 .blindtest/pe-v2/，不会进入 Git 或 npm 包。
 */
import { createHash, randomBytes, randomInt } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderRankingPage } from './blind-pe-page.mjs'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const FIXTURE_DIR = join(ROOT, 'test', 'fixtures', 'blind-pe')
const FIXTURE_FILES = ['config.json', 'main.json', 'ip.json']
const IMAGE_NAME = /^img-[0-9a-f]{16}\.png$/
const DAY_MS = 24 * 60 * 60 * 1000

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const hashText = (text) => createHash('sha256').update(text).digest('hex')
const hashJson = (value) => hashText(JSON.stringify(value))
const nowIso = () => new Date().toISOString()
const flatGroups = (briefs) => briefs.flatMap((brief) => brief.groups)

function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

function mkdirp(dir) {
  mkdirSync(dir, { recursive: true })
}

function asDate(value, label, errors) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    errors.push(`${label} 必须是 YYYY-MM-DD`)
    return null
  }
  const date = new Date(value + 'T00:00:00Z')
  if (Number.isNaN(date.getTime())) {
    errors.push(`${label} 不是有效日期`)
    return null
  }
  return date
}

function daysBetween(a, b) {
  return Math.round(Math.abs(a.getTime() - b.getTime()) / DAY_MS)
}

function assertNonEmptyString(value, label, errors) {
  if (typeof value !== 'string' || value.trim().length === 0) errors.push(`${label} 不能为空`)
}

function assertHttpUrl(value, label, errors) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('not http')
  } catch {
    errors.push(`${label} 必须是可解析的 http(s) 链接`)
  }
}

/** 读取指定版本的公开夹具；v1 默认不变，v2 不要求存在 ip.json。 */
export function loadFixtures(root = ROOT, round = 'v1') {
  if (round !== 'v1' && round !== 'v2') throw new Error(`未知盲测版本 ${round}`)
  const dir = join(root, 'test', 'fixtures', round === 'v2' ? 'blind-pe-v2' : 'blind-pe')
  const config = readJson(join(dir, 'config.json'))
  const main = readJson(join(dir, 'main.json'))
  const ipPath = join(dir, 'ip.json')
  const ip = existsSync(ipPath) ? readJson(ipPath) : { characters: [] }
  const outDir = resolve(root, config.outputDir)
  return { config, main, ip, root, dir, outDir, round, expectedVersion: round === 'v2' ? 'pe-blind-v2' : 'pe-blind-v1' }
}

/** 每题可以是 v1 的单 seed，也可以是 v2 的固定 seeds 数组。 */
export function briefSeeds(item) {
  if (Array.isArray(item?.seeds)) return item.seeds
  return Number.isInteger(item?.seed) ? [item.seed] : []
}

/** 统计主测与 IP 的理论图片数量，自动把每题 seeds 数计入。 */
export function expectedCounts(fixtures) {
  const matrixTotal = (matrix) => Object.values(matrix || {}).reduce((sum, sources) => sum + sources.length, 0)
  const main = (fixtures.main.briefs || []).reduce((sum, brief) => sum + briefSeeds(brief).length * matrixTotal(fixtures.config.sourceMatrix), 0)
  const ip = (fixtures.ip?.characters || [])
    .filter((character) => character.generateImages)
    .reduce((sum, character) => sum + briefSeeds(character).length * matrixTotal(fixtures.config.ipSourceMatrix), 0)
  return { main, ip }
}

/** 夹具必须能在任何 GPU 请求之前被完整解释；错误以数组返回，便于测试断言。 */
export function auditFixtures(fixtures) {
  const errors = []
  const config = fixtures.config
  const main = fixtures.main
  const ip = fixtures.ip || { characters: [] }
  const round = fixtures.round || 'v1'
  const characters = ip.characters || []

  if (config.version !== fixtures.expectedVersion) errors.push(`config.version 必须是 ${fixtures.expectedVersion}`)
  if (!config.models || !config.models['qwen21-base'] || !config.models['moss-sft']) errors.push('config.models 必须包含两个底模')
  if (!config.sourceMatrix) errors.push('config 缺少主测来源矩阵')
  if (characters.length > 0 && !config.ipSourceMatrix) errors.push('存在 IP 角色时 config 必须提供 ipSourceMatrix')
  if (!config.textGenerateV2 || !config.textGenerateV2.systemPrompt) errors.push('config 缺少 TextGenerateV2 系统提示')

  const expectedTextParams = {
    max_length: 4096,
    sampling_mode: 'on',
    'sampling_mode.temperature': 0.7,
    'sampling_mode.top_k': 64,
    'sampling_mode.top_p': 0.95,
    'sampling_mode.min_p': 0.05,
    'sampling_mode.repetition_penalty': 1,
    'sampling_mode.seed': 0,
    'sampling_mode.presence_penalty': 0,
    thinking: false,
    use_default_template: true,
    mtp: 'auto',
  }
  for (const [key, expected] of Object.entries(expectedTextParams)) {
    if (config.textGenerateV2?.params?.[key] !== expected) errors.push(`TextGenerateV2 参数 ${key} 必须固定为 ${JSON.stringify(expected)}`)
  }
  if (config.textGenerateV2?.classType !== 'TextGenerateV2') errors.push('TextGenerateV2.classType 必须是 TextGenerateV2')
  if (!config.officialSkill?.repository || !config.officialSkill?.skillPath || !config.officialSkill?.commit) {
    errors.push('config.officialSkill 缺少仓库、路径或 commit')
  }
  if (!config.goldFrozenAt) errors.push('config.goldFrozenAt 缺失')
  if (!config.goldPolicy || !config.goldPolicy.includes('冻结')) errors.push('config.goldPolicy 必须说明 GOLD 冻结规则')

  const testDate = asDate(config.testDate, 'config.testDate', errors)
  const releaseDates = {}
  for (const [key, value] of Object.entries(config.releaseAnchors || {})) {
    releaseDates[key] = asDate(value, `config.releaseAnchors.${key}`, errors)
  }

  const knownVariants = new Set(['raw', 'project', 'official-skill', 'gold', 'text-generate-v2'])
  for (const matrix of [config.sourceMatrix, config.ipSourceMatrix].filter(Boolean)) {
    for (const [model, sources] of Object.entries(matrix)) {
      if (!Array.isArray(sources) || sources.length === 0) errors.push(`来源矩阵 ${model} 为空`)
      for (const source of sources || []) if (!knownVariants.has(source)) errors.push(`未知来源 ${source}`)
    }
  }

  const expectedSeedsPerBrief = config.seedsPerBrief ?? 1
  const mainIds = new Set()
  for (const brief of main.briefs || []) {
    if (!brief.id || mainIds.has(brief.id)) errors.push(`主测题材 id 无效或重复：${brief.id}`)
    mainIds.add(brief.id)
    const seeds = briefSeeds(brief)
    if (seeds.length !== expectedSeedsPerBrief) errors.push(`${brief.id} 必须正好有 ${expectedSeedsPerBrief} 个 seed，实际 ${seeds.length}`)
    for (const seed of seeds) {
      if (!Number.isInteger(seed) || seed < 0 || seed > 0x7fffffff) errors.push(`${brief.id}.seeds 含非法值 ${seed}`)
    }
    if (new Set(seeds).size !== seeds.length) errors.push(`${brief.id}.seeds 不能重复`)
    assertNonEmptyString(brief.brief, `${brief.id}.brief`, errors)
    for (const source of ['raw', 'project', 'official-skill', 'gold']) {
      assertNonEmptyString(brief.promptVariants?.[source], `${brief.id}.promptVariants.${source}`, errors)
    }
    if (brief.promptVariants?.['text-generate-v2'] !== null) {
      errors.push(`${brief.id}.promptVariants.text-generate-v2 必须在运行时生成，夹具里应为 null`)
    }
    if (round === 'v2') {
      if (!brief.promptFreeze?.goldAt) errors.push(`${brief.id}.promptFreeze.goldAt 缺失`)
      if (brief.promptFreeze?.goldSha256 !== hashText(brief.promptVariants?.gold || '')) errors.push(`${brief.id} GOLD 哈希不一致`)
    }
    if (brief.id === 'PE-TEXT') {
      for (const source of ['raw', 'project', 'gold', 'official-skill']) {
        const prompt = brief.promptVariants?.[source]
        if (typeof prompt === 'string' && (!prompt.includes('归零之后') || !prompt.includes('最后一次跃迁'))) {
          errors.push(`${brief.id}.${source} 必须包含两条精确中文文字`)
        }
      }
    }
  }

  if (characters.length > 0) {
    for (const field of ['pose', 'background', 'style', 'frame']) {
      assertNonEmptyString(ip.compositionRules?.[field], `ip.compositionRules.${field}`, errors)
    }
  }

  const ipIds = new Set()
  const characterCounts = { generated: 0, textOnly: 0 }
  for (const character of characters) {
    if (!character.id || ipIds.has(character.id)) errors.push(`IP 角色 id 无效或重复：${character.id}`)
    ipIds.add(character.id)
    assertNonEmptyString(character.names?.zh, `${character.id}.names.zh`, errors)
    assertNonEmptyString(character.names?.en, `${character.id}.names.en`, errors)
    assertNonEmptyString(character.defaultForm, `${character.id}.defaultForm`, errors)
    if (!Number.isInteger(character.rarity)) errors.push(`${character.id}.rarity 必须是整数`)
    const seeds = briefSeeds(character)
    if (seeds.length !== 1 || !Number.isInteger(seeds[0]) || seeds[0] < 0 || seeds[0] > 0x7fffffff) errors.push(`${character.id}.seed 非法`)
    assertNonEmptyString(character.element, `${character.id}.element`, errors)
    assertNonEmptyString(character.weapon, `${character.id}.weapon`, errors)
    assertNonEmptyString(character.region, `${character.id}.region`, errors)

    const revealed = asDate(character.firstRevealedAt, `${character.id}.firstRevealedAt`, errors)
    if (!Array.isArray(character.evidence) || character.evidence.length === 0) {
      errors.push(`${character.id} 缺少官方证据链接`)
    } else {
      for (const [index, evidence] of character.evidence.entries()) {
        assertHttpUrl(evidence.url, `${character.id}.evidence[${index}].url`, errors)
        asDate(evidence.checkedAt, `${character.id}.evidence[${index}].checkedAt`, errors)
        if (!Array.isArray(evidence.supports) || evidence.supports.length === 0) errors.push(`${character.id}.evidence[${index}] 缺少 supports`)
      }
      if (!character.evidence.some((evidence) => String(evidence.kind).includes('official'))) errors.push(`${character.id} 必须至少有一条官方证据`)
    }
    if (!Array.isArray(character.attributes) || character.attributes.length < 5 || character.attributes.length > 10) {
      errors.push(`${character.id}.attributes 必须为 5–10 项可验证属性`)
    }
    if (!Array.isArray(character.forbiddenAdditions) || character.forbiddenAdditions.length < 2) errors.push(`${character.id}.forbiddenAdditions 至少要有 2 项`)
    if (typeof character.generateImages !== 'boolean') errors.push(`${character.id}.generateImages 必须是布尔值`)
    if (character.generateImages) characterCounts.generated += 1
    else characterCounts.textOnly += 1
    if (character.promptVariants?.gold) errors.push(`${character.id} 是 IP 题，不得设置 GOLD 图提示词`)
    for (const source of ['raw', 'project', 'official-skill']) assertNonEmptyString(character.promptVariants?.[source], `${character.id}.promptVariants.${source}`, errors)
    if (character.promptVariants?.['text-generate-v2'] !== null) errors.push(`${character.id}.promptVariants.text-generate-v2 必须在运行时生成，夹具里应为 null`)

    if (character.selectionRole === 'near-qwen-release' || character.selectionRole === 'near-moss-release') {
      const anchorKey = character.releaseAnchor
      if (!releaseDates[anchorKey]) errors.push(`${character.id}.releaseAnchor 未知：${anchorKey}`)
      if (revealed && releaseDates[anchorKey]) {
        const diff = daysBetween(revealed, releaseDates[anchorKey])
        const limit = config.releaseAnchorWindowDays
        const fallback = config.releaseAnchorFallbackWindowDays
        if (diff > limit && !(character.anchorFallbackReason && diff <= fallback)) {
          errors.push(`${character.id} 首曝距 ${anchorKey} 发布 ${diff} 天，超过 ±${limit} 天且没有记录扩展理由`)
        }
      }
    }
    if (character.selectionRole === 'latest-text-audit' && revealed && testDate) {
      const diff = daysBetween(revealed, testDate)
      if (diff > config.freshnessWindowDays) errors.push(`${character.id} 首曝距测试日 ${diff} 天，超过 ${config.freshnessWindowDays} 天`)
    }
  }

  if (round === 'v1') {
    if (main.briefs?.length !== 3) errors.push(`v1 主测题材必须是 3 个，实际 ${main.briefs?.length || 0}`)
    if (characterCounts.generated !== 3 || characterCounts.textOnly !== 1) {
      errors.push(`v1 IP 角色必须为 3 个出图 + 1 个纯文本审计，实际 ${characterCounts.generated}+${characterCounts.textOnly}`)
    }
  }
  if (round === 'v2') {
    if (main.briefs?.length !== 6) errors.push(`v2 主测题材必须是 6 个，实际 ${main.briefs?.length || 0}`)
    if (characters.length !== 0) errors.push(`v2 不得包含 IP 角色，实际 ${characters.length}`)
    if (expectedSeedsPerBrief !== 2) errors.push('v2 每题必须正好 2 个 seed')
  }

  const counts = expectedCounts(fixtures)
  const declared = config.expectedCounts || (round === 'v1' ? { main: 24, ip: 18 } : null)
  if (declared) {
    if (counts.main !== declared.main) errors.push(`主测图片应为 ${declared.main} 张，实际矩阵为 ${counts.main}`)
    if (counts.ip !== declared.ip) errors.push(`IP 图片应为 ${declared.ip} 张，实际矩阵为 ${counts.ip}`)
  }

  return { ok: errors.length === 0, errors, counts, characterCounts }
}

/** 把来源矩阵展开成具体图片任务；同一题的两个 seed 复用同一份来源 prompt。 */
function taskIdentity(task) {
  return `${task.scope}:${task.fixtureId}:${task.seed}:${task.model}:${task.source}`
}

export function expectedImageTasks(fixtures, frozenText = []) {
  const textByFixture = new Map(frozenText.map((item) => [item.fixtureId, item.prompt]))
  const tasks = []
  for (const brief of fixtures.main.briefs) {
    for (const [seedIndex, seed] of briefSeeds(brief).entries()) {
      for (const [model, sources] of Object.entries(fixtures.config.sourceMatrix)) {
        for (const source of sources) {
          tasks.push({
            scope: 'main', fixtureId: brief.id, brief: brief.brief, sampleIndex: seedIndex, seed, model, source,
            prompt: source === 'text-generate-v2' ? textByFixture.get(brief.id) : brief.promptVariants[source],
          })
        }
      }
    }
  }
  for (const character of (fixtures.ip?.characters || []).filter((item) => item.generateImages)) {
    for (const [seedIndex, seed] of briefSeeds(character).entries()) {
      for (const [model, sources] of Object.entries(fixtures.config.ipSourceMatrix || {})) {
        for (const source of sources) {
          tasks.push({
            scope: 'ip', fixtureId: character.id, brief: character.promptVariants.raw, sampleIndex: seedIndex, seed, model, source,
            prompt: source === 'text-generate-v2' ? textByFixture.get(character.id) : character.promptVariants[source],
          })
        }
      }
    }
  }
  return tasks
}

function optionsForNode(info, node, field) {
  const list = info?.[node]?.input?.required?.[field]?.[0] ?? info?.[node]?.input?.optional?.[field]?.[0]
  return Array.isArray(list) ? list : []
}

function pickWeight(info, rule, label) {
  const match = optionsForNode(info, label.loader, label.field).find((name) => new RegExp(rule, 'i').test(name))
  if (!match) throw new Error(`缺权重：${label.what}（/${rule}/ 没有匹配到 /object_info/${label.loader}.${label.field}）`)
  return match
}

/** 从 /object_info 选出 Qwen 与 MOSS 的三件套，文件名也保留进答案文件。 */
export function resolveWeights(objectInfo, config) {
  const qwen = config.models['qwen21-base']
  const moss = config.models['moss-sft']
  const result = {
    'qwen21-base': {
      unetName: pickWeight(objectInfo, qwen.weights.unet, { loader: 'UNETLoader', field: 'unet_name', what: 'Qwen DiT' }),
      clipName: pickWeight(objectInfo, qwen.weights.clip, { loader: 'CLIPLoader', field: 'clip_name', what: 'Qwen 文本编码器' }),
      vaeName: pickWeight(objectInfo, qwen.weights.vae, { loader: 'VAELoader', field: 'vae_name', what: 'Qwen VAE' }),
    },
    'moss-sft': {
      unetName: pickWeight(objectInfo, moss.weights.unet, { loader: 'UNETLoader', field: 'unet_name', what: 'MOSS DiT' }),
      clipName: pickWeight(objectInfo, moss.weights.clip, { loader: 'CLIPLoader', field: 'clip_name', what: 'MOSS 文本编码器' }),
      vaeName: pickWeight(objectInfo, moss.weights.vae, { loader: 'VAELoader', field: 'vae_name', what: 'MOSS VAE' }),
    },
  }
  return result
}

/** Qwen 评分图；仅在服务端列出 QwenImage21Cache 时启用同一个前缀缓存节点。 */
export function buildQwenGraph({ prompt, seed, models, config, supportsCache = false }) {
  const settings = config.models['qwen21-base'].settings
  const modelNode = supportsCache ? '9' : '1'
  const graph = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: models.unetName, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: models.clipName, type: config.models['qwen21-base'].clipType } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: models.vaeName } },
    '4': { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['2', 0], prompt, negative_prompt: '', resolution: 1024 } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: settings.width, height: settings.height, batch_size: 1 } },
    '6': { class_type: 'KSampler', inputs: { model: [modelNode, 0], positive: ['4', 0], negative: ['4', 1], latent_image: ['5', 0], seed, steps: settings.steps, cfg: settings.cfg, sampler_name: settings.sampler, scheduler: settings.scheduler, denoise: 1 } },
    '7': { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['3', 0] } },
    '8': { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: config.models['qwen21-base'].filenamePrefix } },
  }
  if (supportsCache) graph['9'] = { class_type: 'QwenImage21Cache', inputs: { model: ['1', 0], device: 'auto', dtype: 'default' } }
  return graph
}

/** MOSS 评分图：只接收已经冻结的 prompt，不包含 TextGenerateV2。 */
export function buildMossGraph({ prompt, seed, models, config }) {
  const settings = config.models['moss-sft'].settings
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: models.unetName, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: models.clipName, type: config.models['moss-sft'].clipType } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: models.vaeName } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: config.models['moss-sft'].negativePrompt, clip: ['2', 0] } },
    '6': { class_type: 'EmptyFlux2LatentImage', inputs: { width: settings.width, height: settings.height, batch_size: 1 } },
    '7': { class_type: 'SkipLayerGuidanceDiTSimple', inputs: { model: ['1', 0], double_layers: '', single_layers: '22', start_percent: 0, end_percent: 0.5 } },
    '8': { class_type: 'KSampler', inputs: { model: ['7', 0], seed, steps: settings.steps, cfg: settings.cfg, sampler_name: settings.sampler, scheduler: settings.scheduler, denoise: 1, positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0] } },
    '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    '10': { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: config.models['moss-sft'].filenamePrefix } },
  }
}

/** 官方 benchmark 的提示词增强分支，最小化为 CLIPLoader → TextGenerateV2 → PreviewAny。 */
export function buildTextGenerateGraph({ brief, models, config }) {
  const tg = config.textGenerateV2
  return {
    '1': { class_type: 'CLIPLoader', inputs: { clip_name: models['moss-sft'].clipName, type: tg.clipType, device: tg.clipDevice } },
    '2': { class_type: 'PrimitiveStringMultiline', inputs: { value: tg.systemPrompt } },
    '3': { class_type: 'PrimitiveStringMultiline', inputs: { value: brief } },
    '4': { class_type: tg.classType, inputs: { clip: ['1', 0], prompt: ['3', 0], system_prompt: ['2', 0], ...tg.params } },
    '5': { class_type: tg.previewClassType, inputs: { source: ['4', 0] } },
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function extractPreviewText(output) {
  if (!output) return undefined
  for (const key of ['text', 'string', 'value', 'result', 'preview']) {
    const value = output[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (Array.isArray(value)) {
      const joined = value.filter((item) => typeof item === 'string').join('\n').trim()
      if (joined) return joined
    }
    if (value && typeof value === 'object') {
      const nested = extractPreviewText(value)
      if (nested) return nested
    }
  }
  return undefined
}

function pngSize(bytes) {
  if (bytes.byteLength < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('输出不是 PNG')
  }
  const chunk = bytes.subarray(12, 16).toString('ascii')
  if (chunk !== 'IHDR') throw new Error('PNG 缺少 IHDR')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/** 一个只了解 ComfyUI 四个 HTTP 端点的客户端，便于测试注入 fetch。 */
export function createComfyClient({ endpoint = 'http://127.0.0.1:8188', fetchImpl = fetch, timeoutMs = 420000, pollMs = 1000 } = {}) {
  const getHistory = async (promptId, remaining) => {
    const response = await fetchImpl(`${endpoint}/history/${promptId}`, { signal: AbortSignal.timeout(remaining) })
    if (!response.ok) throw new Error(`/history/${promptId} → HTTP ${response.status}`)
    return await response.json()
  }

  return {
    endpoint,
    async objectInfo() {
      const response = await fetchImpl(`${endpoint}/object_info`, { signal: AbortSignal.timeout(30000) })
      if (!response.ok) throw new Error(`/object_info → HTTP ${response.status}`)
      return await response.json()
    },
    async run(graph, { label, textNodeId } = {}) {
      const deadline = Date.now() + timeoutMs
      const remaining = () => Math.max(1, deadline - Date.now())
      const response = await fetchImpl(`${endpoint}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: graph, client_id: 'blind-pe-v1' }),
        signal: AbortSignal.timeout(remaining()),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(`${label}: /prompt 被拒绝 ${JSON.stringify(body).slice(0, 500)}`)
      if (body.node_errors && Object.keys(body.node_errors).length > 0) {
        throw new Error(`${label}: 节点校验失败 ${JSON.stringify(body.node_errors).slice(0, 800)}`)
      }
      const promptId = body.prompt_id
      if (typeof promptId !== 'string' || promptId.length === 0) throw new Error(`${label}: /prompt 没有 prompt_id`)
      for (;;) {
        const history = await getHistory(promptId, remaining())
        const entry = history[promptId]
        if (entry !== undefined) {
          const status = entry.status?.status_str
          if (status === 'error' || entry.status?.completed === false) {
            throw new Error(`${label}: ComfyUI 执行失败 ${JSON.stringify(entry.status).slice(0, 800)}`)
          }
          if (textNodeId !== undefined) {
            const text = extractPreviewText(entry.outputs?.[textNodeId])
            if (text) return { text, promptId, entry }
          }
          const refs = Object.values(entry.outputs || {}).flatMap((output) => output.images || [])
          if (refs.length > 0) {
            const ref = refs[0]
            const query = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type })
            const image = await fetchImpl(`${endpoint}/view?${query}`, { signal: AbortSignal.timeout(remaining()) })
            if (!image.ok) throw new Error(`${label}: /view → HTTP ${image.status}`)
            const bytes = Buffer.from(await image.arrayBuffer())
            return { bytes, promptId, entry }
          }
          if (entry.status?.completed === true) throw new Error(`${label}: 已完成但没有可下载输出`)
        }
        if (Date.now() + pollMs >= deadline) throw new Error(`${label}: 超时 ${timeoutMs}ms`)
        await sleep(pollMs)
      }
    },
  }
}

const TEXT_OUTPUT = 'text-generate-v2.json'

function loadTextFreeze(outDir) {
  const file = join(outDir, TEXT_OUTPUT)
  if (!existsSync(file)) return { version: 'pe-blind-v1', items: [] }
  return readJson(file)
}

function freezeTasks(fixtures) {
  const tasks = fixtures.main.briefs.map((brief) => ({
    scope: 'main',
    fixtureId: brief.id,
    brief: brief.brief,
  }))
  tasks.push(...fixtures.ip.characters.map((character) => ({
    scope: 'ip',
    fixtureId: character.id,
    brief: character.promptVariants.raw,
  })))
  return tasks
}

function textFreezeNeedsRefresh(fixtures, existing, config, refreshText) {
  if (refreshText) return true
  for (const task of freezeTasks(fixtures)) {
    const item = existing.items?.find((candidate) => candidate.fixtureId === task.fixtureId)
    if (!item || item.briefSha256 !== hashText(task.brief) || !item.prompt) return true
  }
  return existing.systemPromptSha256 !== hashText(config.textGenerateV2.systemPrompt)
}

/**
 * 先把 TextGenerateV2 的结果一次性冻结到 text-generate-v2.json，再允许任何评分图开跑。
 * 返回冻结后的条目数组；已存在且 brief / system prompt 未变的条目会复用。
 */
export async function ensureTextFreeze({ fixtures, outDir, client, weights, refreshText = false, log = console.log }) {
  const config = fixtures.config
  mkdirp(outDir)
  const existing = loadTextFreeze(outDir)
  const tasks = freezeTasks(fixtures)
  const allowedIds = new Set(tasks.map((task) => task.fixtureId))
  const items = (existing.items || []).filter((item) => allowedIds.has(item.fixtureId))
  const changed = textFreezeNeedsRefresh(fixtures, existing, config, refreshText)

  for (const task of tasks) {
    const index = items.findIndex((item) => item.fixtureId === task.fixtureId)
    const briefSha = hashText(task.brief)
    if (!changed && index >= 0 && items[index].briefSha256 === briefSha && items[index].prompt) continue

    const graph = buildTextGenerateGraph({ brief: task.brief, models: weights, config })
    log(`[TEXT] ${task.fixtureId} 生成并冻结最终提示词…`)
    const result = await client.run(graph, { label: `TextGenerateV2 ${task.fixtureId}`, textNodeId: '5' })
    const prompt = String(result.text || '').trim()
    if (!prompt) throw new Error(`TextGenerateV2 ${task.fixtureId} 返回空文本`)
    const item = {
      scope: task.scope,
      fixtureId: task.fixtureId,
      brief: task.brief,
      briefSha256: briefSha,
      prompt,
      promptSha256: hashText(prompt),
      graphSha256: hashJson(graph),
      generatedAt: nowIso(),
      nodeIds: { loader: '1', system: '2', user: '3', generate: '4', preview: '5' },
    }
    if (index >= 0) items[index] = item
    else items.push(item)
    writeJson(join(outDir, TEXT_OUTPUT), {
      version: config.version,
      frozenAt: nowIso(),
      systemPromptSha256: hashText(config.textGenerateV2.systemPrompt),
      params: config.textGenerateV2.params,
      items,
    })
  }

  const frozen = {
    version: config.version,
    frozenAt: nowIso(),
    systemPromptSha256: hashText(config.textGenerateV2.systemPrompt),
    params: config.textGenerateV2.params,
    items,
  }
  writeJson(join(outDir, TEXT_OUTPUT), frozen)
  return items
}

function freshKeys(version) {
  return {
    version,
    createdAt: nowIso(),
    images: [],
    reviewers: [],
  }
}

/**
 * 生成或续跑当前版本的全部评分图；任务数由题目、seeds 和来源矩阵计算。
 * 每张图先提交独立工作流，再以随机文件名落盘；模型/来源映射只写 key.json。
 */
export async function generateAll({ fixtures = loadFixtures(), outDir = fixtures.outDir, endpoint = 'http://127.0.0.1:8188', fetchImpl = fetch, refreshText = false, log = console.log } = {}) {
  const audit = auditFixtures(fixtures)
  if (!audit.ok) throw new Error('夹具审计失败：\n' + audit.errors.join('\n'))
  const config = fixtures.config
  mkdirp(join(outDir, 'images'))
  mkdirp(join(outDir, 'reviewers'))
  const client = createComfyClient({ endpoint, fetchImpl })
  const objectInfo = await client.objectInfo()
  const weights = resolveWeights(objectInfo, config)
  const supportsQwenCache = Object.prototype.hasOwnProperty.call(objectInfo, 'QwenImage21Cache')
  const frozen = await ensureTextFreeze({ fixtures, outDir, client, weights, refreshText, log })
  const tasks = expectedImageTasks(fixtures, frozen)
  const missingPrompt = tasks.find((task) => typeof task.prompt !== 'string' || task.prompt.trim() === '')
  if (missingPrompt) throw new Error(`任务 ${missingPrompt.fixtureId}/${missingPrompt.model}/${missingPrompt.source} 没有冻结 prompt`)

  const keyPath = join(outDir, 'key.json')
  const key = existsSync(keyPath) ? readJson(keyPath) : freshKeys(config.version)
  key.version = config.version
  key.updatedAt = nowIso()
  key.weights = weights
  key.supportsQwenCache = supportsQwenCache
  key.models = Object.fromEntries(Object.entries(config.models).map(([id, model]) => [id, {
    family: model.family,
    settings: model.settings,
    clipType: model.clipType,
  }]))
  key.images ||= []

  const byTask = new Map(key.images.map((entry) => [taskIdentity(entry), entry]))
  for (const [index, task] of tasks.entries()) {
    const graph = task.model === 'qwen21-base'
      ? buildQwenGraph({ prompt: task.prompt, seed: task.seed, models: weights[task.model], config, supportsCache: supportsQwenCache })
      : buildMossGraph({ prompt: task.prompt, seed: task.seed, models: weights[task.model], config })
    const graphSha = hashJson(graph)
    const taskKey = taskIdentity(task)
    const previous = byTask.get(taskKey)
    if (previous && previous.graphSha256 === graphSha && existsSync(join(outDir, 'images', previous.filename))) {
      log(`[${index + 1}/${tasks.length}] 跳过已有 ${task.fixtureId}/${task.model}/${task.source}`)
      continue
    }

    log(`[${index + 1}/${tasks.length}] ${task.fixtureId} · ${task.model} · ${task.source} · seed ${task.seed} 生成中…`)
    const result = await client.run(graph, { label: `${task.fixtureId}/${task.model}/${task.source}` })
    if (!result.bytes || result.bytes.byteLength === 0) throw new Error(`${taskKey}: 没有返回图片字节`)
    const filename = `img-${randomBytes(8).toString('hex')}.png`
    writeFileSync(join(outDir, 'images', filename), result.bytes)
    const entry = {
      scope: task.scope,
      fixtureId: task.fixtureId,
      model: task.model,
      source: task.source,
      seed: task.seed,
      prompt: task.prompt,
      promptSha256: hashText(task.prompt),
      graphSha256: graphSha,
      filename,
      imageSha256: hashText(result.bytes),
      width: config.models[task.model].settings.width,
      height: config.models[task.model].settings.height,
      generatedAt: nowIso(),
      promptId: result.promptId,
    }
    if (previous) {
      const oldIndex = key.images.findIndex((candidate) => candidate.filename === previous.filename)
      if (oldIndex >= 0) key.images[oldIndex] = entry
      else key.images.push(entry)
    } else {
      key.images.push(entry)
    }
    byTask.set(taskKey, entry)
    key.updatedAt = nowIso()
    writeJson(keyPath, key)
  }

  // 只保留本计划当前任务；旧任务条目仍可能在磁盘上，但不进入答案文件。
  const expectedKeys = new Set(tasks.map((task) => taskIdentity(task)))
  key.images = key.images.filter((entry) => expectedKeys.has(taskIdentity(entry)))
  key.updatedAt = nowIso()
  writeJson(keyPath, key)
  log(`完成：${key.images.length} 张图，答案在 ${keyPath}`)
  return { key, tasks, weights }
}

/** 可注入随机源的 Fisher–Yates；测试用固定序列，生产用 crypto.randomInt。 */
export function shuffle(items, rng = (max) => randomInt(max)) {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rng(i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function ensureNotCanonical(order, canonical, compare) {
  if (order.length < 2) return order
  const same = order.every((item, index) => compare(item, canonical[index]))
  if (!same) return order
  const rotated = [...order]
  ;[rotated[0], rotated[1]] = [rotated[1], rotated[0]]
  return rotated
}

function groupId(prefix, reviewerId, nonce) {
  return `${prefix}-${hashText(`${reviewerId}:${nonce}`).slice(0, 10)}`
}

function promptLookup(fixtures, key, frozenText) {
  const text = new Map(frozenText.map((item) => [item.fixtureId, item.prompt]))
  return (scope, fixtureId, source) => {
    const entry = key.images.find((candidate) => candidate.scope === scope && candidate.fixtureId === fixtureId && candidate.source === source)
    if (entry) return entry.prompt
    if (source === 'text-generate-v2') return text.get(fixtureId)
    const fixture = scope === 'main'
      ? fixtures.main.briefs.find((brief) => brief.id === fixtureId)
      : fixtures.ip.characters.find((character) => character.id === fixtureId)
    return fixture?.promptVariants?.[source]
  }
}

function scopeFixtures(fixtures, scope) {
  return scope === 'main' ? fixtures.main.briefs : (fixtures.ip?.characters || [])
}

function scopeUnits(fixtures, scope, { imagesOnly = false } = {}) {
  const units = []
  for (const fixture of scopeFixtures(fixtures, scope)) {
    if (imagesOnly && scope === 'ip' && !fixture.generateImages) continue
    for (const [sampleIndex, seed] of briefSeeds(fixture).entries()) {
      units.push({ fixture, fixtureId: fixture.id, sampleIndex, seed })
    }
  }
  return units
}

function buildPageBriefs({ fixtures, key, frozenText, scope, kind, pageName, reviewerId, rng }) {
  const sourceMatrix = scope === 'main' ? fixtures.config.sourceMatrix : fixtures.config.ipSourceMatrix
  const getPrompt = promptLookup(fixtures, key, frozenText)
  const briefs = []

  for (const unit of scopeUnits(fixtures, scope, { imagesOnly: kind === 'image' })) {
    const { fixture, fixtureId, sampleIndex, seed } = unit
    const seedCount = briefSeeds(fixture).length
    const displayId = seedCount > 1 ? `${fixtureId} · 样次 ${sampleIndex + 1}` : fixtureId
    const canonicalGroups = Object.entries(sourceMatrix).map(([model, sources]) => {
      const canonicalItems = sources.map((source) => ({
        source,
        model,
        filename: key.images.find((entry) => entry.scope === scope && entry.fixtureId === fixtureId && entry.seed === seed && entry.model === model && entry.source === source)?.filename,
        prompt: getPrompt(scope, fixtureId, source),
      }))
      const shuffled = ensureNotCanonical(shuffle(canonicalItems, rng), canonicalItems, (a, b) => a.source === b.source)
      const id = groupId(`${pageName}-${fixtureId}-s${sampleIndex + 1}`, reviewerId, `${model}:${Math.floor(rng(1_000_000_000))}`)
      const labelItems = shuffled.map((item, index) => ({ label: String.fromCharCode(65 + index), ...item }))
      return { id, canonicalGroup: model, canonicalOrder: sources, shuffled: true, items: labelItems }
    })

    const shuffledGroups = ensureNotCanonical(shuffle(canonicalGroups, rng), canonicalGroups, (a, b) => a.canonicalGroup === b.canonicalGroup)
    const pageGroups = shuffledGroups.map((group, index) => ({ ...group, label: `候选组 ${String.fromCharCode(65 + index)}` }))

    briefs.push({
      id: displayId,
      fixtureId,
      sampleIndex,
      seed,
      brief: scope === 'main' ? fixture.brief : fixture.promptVariants.raw,
      groups: pageGroups,
    })
  }

  return briefs
}

function pageFromBriefs({ title, lead, exportTitle, briefs, kind, guidanceTitle, guidance, notes }) {
  return {
    title,
    lead,
    exportTitle,
    guidanceTitle,
    guidance,
    notes,
    briefs: briefs.map((brief) => ({
      id: brief.id,
      brief: brief.brief,
      groups: brief.groups.map((group) => ({
        id: group.id,
        label: group.label,
        kind,
        items: group.items.map((item) => ({
          label: item.label,
          ...(kind === 'image' ? { src: `../../images/${item.filename}` } : { text: item.prompt }),
        })),
      })),
    })),
  }
}

function reviewerKeyPage(briefs, fileName, kind, { notesExpected = false } = {}) {
  return {
    file: fileName,
    kind,
    notesExpected,
    groups: briefs.flatMap((brief) => brief.groups.map((group) => ({
      id: group.id,
      label: group.label,
      briefId: brief.fixtureId ?? brief.id,
      sampleIndex: brief.sampleIndex ?? 0,
      seed: brief.seed,
      kind,
      canonicalGroup: group.canonicalGroup,
      canonicalOrder: group.canonicalOrder,
      shuffled: group.shuffled,
      items: group.items.map((item) => ({
        label: item.label,
        filename: item.filename,
        source: item.source,
        model: item.model,
        promptSha256: item.prompt ? hashText(item.prompt) : undefined,
      })),
    }))),
  }
}

/**
 * 为一位评审人生成四份页面和一份独立 key。
 * 页面与页面之间、评审人与评审人之间都使用新的随机顺序。
 */
const GROUP_NOTES = {
  label: '意见描述（可选）',
  placeholder: '写明影响名次的具体理由，例如文字错误、手部异常、人数或位置不符、材质与光影问题。',
}
const MAIN_GUIDANCE = [
  '评审只依据页面上方原始需求与图片，不查看最终提示词、候选来源或模型。',
  '先检查硬性要求，再看整体美感。具体问题请写入每组下方的意见描述。',
  '同一候选组内名次必须唯一，全部组完成后才能导出。',
]
const IP_GUIDANCE = [
  'IP 仅作附加尝试，不要求深入穷举；角色身份和默认形态错误时可直接降名次。',
  '先判断角色身份是否可辨认，再核对默认服装、默认形态和官方属性；画面美观放在事实准确之后。',
  '无法确定时，请在意见描述中写明具体疑点；主结论仍以通用题目为准。',
]

export function scoreAll({ fixtures = loadFixtures(), outDir = fixtures.outDir, reviewerId = 'reviewer-1', rng = (max) => randomInt(max), skipPixels = false } = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(reviewerId)) throw new Error('reviewer 只能用字母、数字、点、下划线或短横线')
  const keyPath = join(outDir, 'key.json')
  if (!existsSync(keyPath)) throw new Error('还没有生成答案 key，先运行 generate')
  const key = readJson(keyPath)
  const audit = auditFixtures(fixtures)
  if (!audit.ok) throw new Error('夹具审计失败：\n' + audit.errors.join('\n'))
  if (key.images?.length !== audit.counts.main + audit.counts.ip) {
    throw new Error(`生成图不完整：${key.images?.length || 0}/${audit.counts.main + audit.counts.ip}`)
  }
  const frozenText = loadTextFreeze(outDir).items || []
  if (frozenText.length !== freezeTasks(fixtures).length) throw new Error('TextGenerateV2 冻结提示词不完整，先重新运行 generate')
  const preflight = runCheck({ fixtures, outDir, requireReviewers: false, skipPixels })
  if (!preflight.ok) throw new Error('生成图检查失败：\n' + preflight.errors.join('\n'))

  const reviewerDir = join(outDir, 'reviewers', reviewerId)
  mkdirp(reviewerDir)
  const nonce = `${reviewerId}:${randomBytes(6).toString('hex')}`

  const roundLabel = fixtures.config.version === 'pe-blind-v2' ? 'v2' : 'v1'
  const hasIp = (fixtures.ip?.characters || []).some((character) => character.generateImages)
  const imageGuidance = roundLabel === 'v2' ? [
    '评审只依据页面上方原始需求与图片，不查看最终提示词、候选来源、模型或 seed。',
    '同一道题会以两个独立样次出现；请分别排名，不要跨样次或跨组混排。',
    '先检查硬性要求，再看整体美感。具体问题请写入每组下方的意见描述。',
  ] : MAIN_GUIDANCE

  const mainImages = buildPageBriefs({ fixtures, key, frozenText, scope: 'main', kind: 'image', pageName: 'main-images', reviewerId: nonce, rng })
  const pages = {
    'main-images': {
      html: renderRankingPage(pageFromBriefs({
        title: `PE 盲测 ${roundLabel} · 通用题目图片排名`,
        lead: roundLabel === 'v2'
          ? '每题包含两个种子样次和两个候选组。请只依据原始需求和图片，在每个样次、每个候选组内完成唯一排名。'
          : '每题包含两个候选组。请只依据原始需求和图片，在同一组内完成唯一排名；候选来源、模型和最终提示词均隐藏。',
        exportTitle: `PE 盲测 ${roundLabel} · 通用题目图片排名`,
        briefs: mainImages,
        kind: 'image',
        guidanceTitle: '人类评审说明',
        guidance: imageGuidance,
        notes: GROUP_NOTES,
      })),
      key: reviewerKeyPage(mainImages, 'main-images.html', 'image', { notesExpected: true }),
    },
  }

  if (hasIp) {
    const ipImages = buildPageBriefs({ fixtures, key, frozenText, scope: 'ip', kind: 'image', pageName: 'ip-images', reviewerId: nonce, rng })
    pages['ip-images'] = {
      html: renderRankingPage(pageFromBriefs({
        title: `PE 盲测 ${roundLabel} · 原神 IP 图片排名（附加）`,
        lead: 'IP 为附加尝试，不要求深入穷举。请只依据原始需求和图片，在组内完成唯一排名；主结论仍以通用题目为准。',
        exportTitle: `PE 盲测 ${roundLabel} · 原神 IP 图片排名（附加）`,
        briefs: ipImages,
        kind: 'image',
        guidanceTitle: 'IP 附加题说明',
        guidance: IP_GUIDANCE,
        notes: GROUP_NOTES,
      })),
      key: reviewerKeyPage(ipImages, 'ip-images.html', 'image', { notesExpected: true }),
    }
  }

  for (const [name, page] of Object.entries(pages)) writeFileSync(join(reviewerDir, `${name}.html`), page.html, 'utf8')
  const reviewerKey = {
    version: 'pe-blind-reviewer-v1',
    reviewer: reviewerId,
    createdAt: nowIso(),
    pages: Object.fromEntries(Object.entries(pages).map(([name, page]) => [name, page.key])),
  }
  writeJson(join(reviewerDir, 'key.json'), reviewerKey)
  const links = [
    '<li><a href="main-images.html">通用题目图片排名（主评审）</a></li>',
    hasIp ? '<li><a href="ip-images.html">原神 IP 图片排名（附加尝试）</a></li>' : '',
  ].join('')
  writeFileSync(join(reviewerDir, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>PE 盲测评审入口</title><body style="font:16px system-ui;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.7"><h1>PE 盲测 ${roundLabel} 评审入口</h1><p>${roundLabel === 'v2' ? '请按样次完成通用题目图片排名；页面只显示原始需求、图片和意见描述框。' : '请先完成通用题目图片排名。IP 为附加尝试；页面只显示原始需求、图片和意见描述框。'}</p><ol>${links}</ol></body></html>`, 'utf8')
  return { reviewerDir, pages: Object.keys(pages), key: reviewerKey }
}

function reviewPageMeta(name, fixtures) {
  const roundLabel = fixtures.config.version === 'pe-blind-v2' ? 'v2' : 'v1'
  const guidance = roundLabel === 'v2' ? [
    '评审只依据页面上方原始需求与图片，不查看最终提示词、候选来源、模型或 seed。',
    '同一道题会以两个独立样次出现；请分别排名，不要跨样次或跨组混排。',
    '先检查硬性要求，再看整体美感。具体问题请写入每组下方的意见描述。',
  ] : MAIN_GUIDANCE
  if (name === 'main-images') return {
    title: `PE 盲测 ${roundLabel} · 通用题目图片排名`,
    lead: roundLabel === 'v2'
      ? '每题包含两个种子样次和两个候选组。请只依据原始需求和图片，在每个样次、每个候选组内完成唯一排名。'
      : '每题包含两个候选组。请只依据原始需求和图片，在同一组内完成唯一排名；候选来源、模型和最终提示词均隐藏。',
    exportTitle: `PE 盲测 ${roundLabel} · 通用题目图片排名`,
    kind: 'image',
    guidanceTitle: '人类评审说明',
    guidance,
    notes: GROUP_NOTES,
  }
  if (name === 'ip-images') return {
    title: `PE 盲测 ${roundLabel} · 原神 IP 图片排名（附加）`,
    lead: 'IP 为附加尝试，不要求深入穷举。请只依据原始需求和图片，在组内完成唯一排名；主结论仍以通用题目为准。',
    exportTitle: `PE 盲测 ${roundLabel} · 原神 IP 图片排名（附加）`,
    kind: 'image',
    guidanceTitle: 'IP 附加题说明',
    guidance: IP_GUIDANCE,
    notes: GROUP_NOTES,
  }
  throw new Error(`未知图片评审页 ${name}`)
}

/**
 * 使用已有评审 key 重新渲染页面，保持候选顺序、组标签和来源映射不变。
 * 用于修改页面文案或补充输入框时不打断已完成的盲测。
 */
export function rerenderReviewer({ fixtures = loadFixtures(), outDir = fixtures.outDir, reviewerId = 'reviewer-1' } = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(reviewerId)) throw new Error('reviewer 只能用字母、数字、点、下划线或短横线')
  const reviewerDir = join(outDir, 'reviewers', reviewerId)
  const reviewerKeyPath = join(reviewerDir, 'key.json')
  const keyPath = join(outDir, 'key.json')
  if (!existsSync(reviewerKeyPath) || !existsSync(keyPath)) throw new Error('缺少已有评审 key，先运行 score')
  const reviewerKey = readJson(reviewerKeyPath)
  const key = readJson(keyPath)
  const frozenText = loadTextFreeze(outDir).items || []
  const getPrompt = promptLookup(fixtures, key, frozenText)
  const imagePageNames = Object.keys(reviewerKey.pages || {}).filter((name) => name === 'main-images' || name === 'ip-images')
  if (imagePageNames.length === 0) throw new Error('已有评审 key 中没有图片评审页')

  for (const name of imagePageNames) {
    const pageKey = reviewerKey.pages[name]
    const meta = reviewPageMeta(name, fixtures)
    const scope = name.startsWith('main') ? 'main' : 'ip'
    const briefById = new Map()
    for (const group of pageKey.groups || []) {
      const sampleIndex = group.sampleIndex ?? 0
      const unitKey = `${group.briefId}:${sampleIndex}`
      if (!briefById.has(unitKey)) {
        const fixture = scope === 'main'
          ? fixtures.main.briefs.find((brief) => brief.id === group.briefId)
          : (fixtures.ip?.characters || []).find((character) => character.id === group.briefId)
        if (!fixture) throw new Error(`${name}/${group.briefId}: 找不到题材`)
        const seedCount = briefSeeds(fixture).length
        briefById.set(unitKey, {
          id: seedCount > 1 ? `${group.briefId} · 样次 ${sampleIndex + 1}` : group.briefId,
          fixtureId: group.briefId,
          sampleIndex,
          seed: group.seed,
          brief: scope === 'main' ? fixture.brief : fixture.promptVariants.raw,
          groups: [],
        })
      }
      briefById.get(unitKey).groups.push({
        id: group.id,
        label: group.label,
        canonicalGroup: group.canonicalGroup,
        canonicalOrder: group.canonicalOrder,
        shuffled: group.shuffled,
        items: group.items.map((item) => ({
          label: item.label,
          filename: item.filename,
          source: item.source,
          model: item.model,
          prompt: getPrompt(scope, group.briefId, item.source),
        })),
      })
    }
    const briefs = [...briefById.values()]
    writeFileSync(join(reviewerDir, `${name}.html`), renderRankingPage(pageFromBriefs({ ...meta, briefs })), 'utf8')
    pageKey.notesExpected = Boolean(meta.notes)
  }
  reviewerKey.pages = Object.fromEntries(imagePageNames.map((name) => [name, reviewerKey.pages[name]]))
  writeJson(reviewerKeyPath, reviewerKey)
  const links = [
    '<li><a href="main-images.html">通用题目图片排名（主评审）</a></li>',
    imagePageNames.includes('ip-images') ? '<li><a href="ip-images.html">原神 IP 图片排名（附加尝试）</a></li>' : '',
  ].join('')
  writeFileSync(join(reviewerDir, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>PE 盲测评审入口</title><body style="font:16px system-ui;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.7"><h1>PE 盲测 v1 评审入口</h1><p>请先完成通用题目图片排名。IP 为附加尝试；页面只显示原始需求、图片和意见描述框。</p><ol>${links}</ol></body></html>`, 'utf8')
  return { reviewerDir, pages: imagePageNames }
}

function expectedReviewerShape(fixtures) {
  const shape = {
    'main-images': { scope: 'main', units: scopeUnits(fixtures, 'main'), matrix: fixtures.config.sourceMatrix },
  }
  if ((fixtures.ip?.characters || []).some((character) => character.generateImages)) {
    shape['ip-images'] = { scope: 'ip', units: scopeUnits(fixtures, 'ip', { imagesOnly: true }), matrix: fixtures.config.ipSourceMatrix }
  }
  return shape
}

function verifyReviewerPage({ reviewerDir, name, spec, pageKey, key, fixtures }) {
  const errors = []
  const html = readFileSync(join(reviewerDir, `${name}.html`), 'utf8')
  if (html.includes('key.json')) errors.push(`${name}.html 引用了答案文件`)
  const sourceLeak = html.match(/\b(?:qwen21-base|moss-sft|official-skill|text-generate-v2)\b/i) ?? html.match(/\b(?:RAW|GOLD)\b/) ?? html.match(/(?:项目 Skill|官方 Skill)/)
  if (sourceLeak) errors.push(`${name}.html 泄露来源或模型名：${sourceLeak[0]}`)
  if (/\b(?:Qwen|MOSS)\b/.test(html)) errors.push(`${name}.html 泄露底模名称`)
  for (const seed of new Set(spec.units.flatMap((unit) => briefSeeds(unit.fixture)))) {
    if (html.includes(String(seed))) errors.push(`${name}.html 泄露 seed ${seed}`)
  }
  if (!pageKey || !Array.isArray(pageKey.groups)) errors.push(`${name} 的评审 key 缺少 groups`)
  if (pageKey?.notesExpected && !html.includes('class="group-note"')) errors.push(`${name}.html 缺少意见描述输入框`)
  if (name === 'main-images' && !html.includes('人类评审说明')) errors.push(`${name}.html 缺少人类评审说明`)
  if (name === 'ip-images' && !html.includes('IP 附加题说明')) errors.push(`${name}.html 缺少 IP 附加题说明`)
  const expectedGroupCount = spec.units.length * Object.keys(spec.matrix).length
  if ((pageKey?.groups?.length || 0) !== expectedGroupCount) errors.push(`${name} 组数不对：${pageKey?.groups?.length || 0}/${expectedGroupCount}`)

  for (const unit of spec.units) {
    const groups = (pageKey?.groups || []).filter((group) => group.briefId === unit.fixtureId && (group.sampleIndex ?? 0) === unit.sampleIndex)
    if (groups.length !== Object.keys(spec.matrix).length) errors.push(`${name}/${unit.fixtureId}/样次${unit.sampleIndex + 1} 组数不对`)
    for (const [model, sources] of Object.entries(spec.matrix)) {
      const group = groups.find((candidate) => candidate.canonicalGroup === model)
      if (!group) {
        errors.push(`${name}/${unit.fixtureId}/样次${unit.sampleIndex + 1} 缺 ${model} 组`)
        continue
      }
      if (group.seed !== unit.seed) errors.push(`${name}/${unit.fixtureId}/样次${unit.sampleIndex + 1} seed 映射不一致`)
      const labels = group.items.map((item) => item.label)
      if (new Set(labels).size !== labels.length) errors.push(`${name}/${unit.fixtureId}/${model} 候选字母重复`)
      const actualSources = group.items.map((item) => item.source)
      if (actualSources.length !== sources.length || new Set(actualSources).size !== sources.length || !sources.every((source) => actualSources.includes(source))) {
        errors.push(`${name}/${unit.fixtureId}/${model} 的来源集合不完整`)
      }
      if (group.items.slice().sort((a, b) => a.label.localeCompare(b.label)).map((item) => item.source).every((source, index) => source === sources[index])) {
        errors.push(`${name}/${unit.fixtureId}/${model} 完全按来源声明顺序展示，不是随机顺序`)
      }
      if (group.kind === 'image') {
        for (const item of group.items) {
          const generated = key.images.find((entry) => entry.scope === spec.scope && entry.fixtureId === unit.fixtureId && entry.seed === unit.seed && entry.model === model && entry.source === item.source)
          if (!generated || generated.filename !== item.filename) errors.push(`${name}/${unit.fixtureId}/${model}/${item.source} 图片映射不一致`)
          if (!html.includes(`../../images/${item.filename}`)) errors.push(`${name}.html 没有引用 ${item.filename}`)
        }
      }
    }
  }

  if (name.endsWith('-images')) {
    const prompts = key.images
      .filter((entry) => entry.scope === spec.scope && entry.source !== 'raw')
      .map((entry) => entry.prompt)
    for (const prompt of prompts) if (html.includes(prompt)) errors.push(`${name}.html 泄露了最终 prompt`)
  }
  return errors
}

/** 验证生成文件、PNG 尺寸、参数、来源矩阵、随机文件名与评审页面隔离。 */
export function runCheck({ fixtures = loadFixtures(), outDir = fixtures.outDir, skipPixels = false, requireReviewers = true } = {}) {
  const errors = []
  const config = fixtures.config
  const audit = auditFixtures(fixtures)
  errors.push(...audit.errors)
  const expectedTotal = audit.counts.main + audit.counts.ip
  const keyPath = join(outDir, 'key.json')
  if (!existsSync(keyPath)) return { ok: false, errors: [...errors, '缺少 key.json，先运行 generate'], counts: audit.counts }
  const key = readJson(keyPath)
  if (key.version !== config.version) errors.push(`key.version ${key.version} ≠ ${config.version}`)
  const frozen = loadTextFreeze(outDir)
  if (frozen.version !== config.version) errors.push(`TextGenerateV2 冻结版本 ${frozen.version} ≠ ${config.version}`)
  const frozenTasks = freezeTasks(fixtures)
  if (frozen.systemPromptSha256 !== hashText(config.textGenerateV2.systemPrompt)) errors.push('TextGenerateV2 系统提示摘要不一致')
  if (JSON.stringify(frozen.params) !== JSON.stringify(config.textGenerateV2.params)) errors.push('TextGenerateV2 冻结参数与夹具不一致')
  if ((frozen.items?.length || 0) !== frozenTasks.length) errors.push(`TextGenerateV2 冻结条目不完整：${frozen.items?.length || 0}/${frozenTasks.length}`)
  for (const task of frozenTasks) {
    const item = frozen.items?.find((candidate) => candidate.fixtureId === task.fixtureId)
    if (!item?.prompt) errors.push(`缺少 ${task.fixtureId} 的 TextGenerateV2 prompt`)
    else if (item.briefSha256 !== hashText(task.brief)) errors.push(`${task.fixtureId} 的 TextGenerateV2 冻结 prompt 与当前夹具不一致`)
  }

  const tasks = expectedImageTasks(fixtures, frozen.items || [])
  if (key.images?.length !== expectedTotal) errors.push(`图片总数不对：${key.images?.length || 0}/${expectedTotal}`)
  const filenameSet = new Set()
  const taskSet = new Set(tasks.map((task) => taskIdentity(task)))
  const imageTaskSet = new Set()

  for (const entry of key.images || []) {
    const taskKey = taskIdentity(entry)
    if (!taskSet.has(taskKey)) errors.push(`key.json 有意外任务 ${taskKey}`)
    if (imageTaskSet.has(taskKey)) errors.push(`key.json 重复任务 ${taskKey}`)
    imageTaskSet.add(taskKey)
    if (!IMAGE_NAME.test(entry.filename)) errors.push(`${taskKey} 文件名不是随机格式：${entry.filename}`)
    if (filenameSet.has(entry.filename)) errors.push(`图片文件名重复：${entry.filename}`)
    filenameSet.add(entry.filename)
    const imagePath = join(outDir, 'images', entry.filename)
    if (!existsSync(imagePath)) {
      errors.push(`缺图片 ${entry.filename}`)
      continue
    }
    const modelConfig = config.models[entry.model]
    if (!modelConfig) {
      errors.push(`${taskKey} 使用了未知模型 ${entry.model}`)
      continue
    }
    const bytes = readFileSync(imagePath)
    if (hashText(bytes) !== entry.imageSha256) errors.push(`${entry.filename} 内容摘要不一致`)
    if (!skipPixels) {
      try {
        const size = pngSize(bytes)
        if (size.width !== entry.width || size.height !== entry.height || size.width !== modelConfig.settings.width || size.height !== modelConfig.settings.height) {
          errors.push(`${entry.filename} 尺寸 ${size.width}x${size.height} 与配置不符`)
        }
      } catch (error) {
        errors.push(`${entry.filename} 不是有效 PNG：${error.message}`)
      }
    }
    const fixture = entry.scope === 'main'
      ? fixtures.main.briefs.find((brief) => brief.id === entry.fixtureId)
      : fixtures.ip.characters.find((character) => character.id === entry.fixtureId)
    if (!fixture) errors.push(`${taskKey} 找不到题材`)
    else {
      if (!briefSeeds(fixture).includes(entry.seed)) errors.push(`${taskKey} seed ${entry.seed} 不在夹具 seeds 中`)
    }
    const task = tasks.find((candidate) => taskIdentity(candidate) === taskKey)
    if (!task || entry.prompt !== task.prompt || entry.promptSha256 !== hashText(task.prompt)) errors.push(`${taskKey} prompt 与冻结来源不一致`)
    const weights = key.weights?.[entry.model]
    if (!weights) {
      errors.push(`${taskKey} 缺少权重记录`)
    } else if (entry.model === 'qwen21-base') {
      if (hashJson(buildQwenGraph({ prompt: entry.prompt, seed: entry.seed, models: weights, config, supportsCache: Boolean(key.supportsQwenCache) })) !== entry.graphSha256) errors.push(`${taskKey} Qwen 工作流摘要不一致`)
    } else {
      if (hashJson(buildMossGraph({ prompt: entry.prompt, seed: entry.seed, models: weights, config })) !== entry.graphSha256) errors.push(`${taskKey} MOSS 工作流摘要不一致`)
    }
  }
  for (const taskKey of taskSet) if (!imageTaskSet.has(taskKey)) errors.push(`缺任务 ${taskKey}`)

  if (requireReviewers) {
    const reviewersDir = join(outDir, 'reviewers')
    const reviewerDirs = existsSync(reviewersDir)
      ? readdirSync(reviewersDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      : []
    if (reviewerDirs.length === 0) errors.push('没有评审页面，先运行 score')
    for (const reviewer of reviewerDirs) {
      const reviewerDir = join(reviewersDir, reviewer)
      const reviewerKeyPath = join(reviewerDir, 'key.json')
      if (!existsSync(reviewerKeyPath)) {
        errors.push(`评审 ${reviewer} 缺少 key.json`)
        continue
      }
      const reviewerKey = readJson(reviewerKeyPath)
      if (reviewerKey.reviewer !== reviewer) errors.push(`评审 ${reviewer} 的名称与目录不一致`)
      for (const [name, spec] of Object.entries(expectedReviewerShape(fixtures))) {
        errors.push(...verifyReviewerPage({ reviewerDir, name, spec, pageKey: reviewerKey.pages?.[name], key, fixtures }))
      }
    }
  }

  return { ok: errors.length === 0, errors, counts: audit.counts }
}

/** 解析评分页“导出排名”文本；顺序与评审 key 中的组顺序一致。 */
export function parseRankingExport(text) {
  const lines = String(text).split(/\r?\n/)
  const groups = []
  let current = null
  for (const line of lines) {
    if (/^[A-Za-z0-9-]+ · 样次 \d+「/.test(line) || /^[A-Za-z0-9-]+「/.test(line)) continue
    const groupMatch = line.match(/^-\s*(候选组\s+[A-Z])：(.+)$/)
    if (groupMatch) {
      current = { label: groupMatch[1].replace(/\s+/, ' '), picks: [], note: '' }
      for (const match of groupMatch[2].matchAll(/(\d+)=([A-Z])/g)) current.picks.push({ rank: Number(match[1]), label: match[2] })
      groups.push(current)
      continue
    }
    const noteMatch = line.match(/^\s*-\s*补充说明：(.+)$/)
    if (noteMatch && current) current.note = noteMatch[1].trim()
  }
  return groups
}

/** 读取评审导出文本，生成逐组结果和来源统计。 */
export function analyzeReviewer({ fixtures = loadFixtures(), outDir = fixtures.outDir, reviewerId = 'reviewer-1', inputPath } = {}) {
  const reviewerDir = join(outDir, 'reviewers', reviewerId)
  const keyPath = join(outDir, 'key.json')
  const reviewerKeyPath = join(reviewerDir, 'key.json')
  if (!existsSync(keyPath) || !existsSync(reviewerKeyPath)) throw new Error('缺少生成 key 或评审 key')
  const input = inputPath || join(reviewerDir, 'rankings.txt')
  if (!existsSync(input)) throw new Error(`找不到评审导出文本：${input}`)
  const key = readJson(keyPath)
  const reviewerKey = readJson(reviewerKeyPath)
  const page = reviewerKey.pages?.['main-images']
  if (!page) throw new Error('评审 key 中没有 main-images')
  const parsed = parseRankingExport(readFileSync(input, 'utf8'))
  if (parsed.length !== page.groups.length) {
    throw new Error(`导出文本有 ${parsed.length} 组，评审 key 有 ${page.groups.length} 组；请使用最新页面重新导出`)
  }

  const rows = []
  for (const [index, submitted] of parsed.entries()) {
    const group = page.groups[index]
    if (submitted.label !== group.label) throw new Error(`第 ${index + 1} 组标签不匹配：${submitted.label} ≠ ${group.label}`)
    if (submitted.picks.length !== group.items.length) throw new Error(`${group.briefId}/样次${group.sampleIndex + 1}/${group.label} 名次不完整`)
    for (const pick of submitted.picks) {
      const item = group.items.find((candidate) => candidate.label === pick.label)
      if (!item) throw new Error(`${group.label} 出现未知候选 ${pick.label}`)
      rows.push({
        fixtureId: group.briefId,
        sampleIndex: group.sampleIndex,
        seed: group.seed,
        model: group.canonicalGroup,
        source: item.source,
        groupSize: group.items.length,
        rank: pick.rank,
        normalized: (pick.rank - 1) / (group.items.length - 1),
        note: submitted.note,
        filename: item.filename,
      })
    }
  }

  const summary = {}
  for (const model of Object.keys(fixtures.config.sourceMatrix)) {
    const modelRows = rows.filter((row) => row.model === model)
    summary[model] = [...new Set(modelRows.map((row) => row.source))].map((source) => {
      const picked = modelRows.filter((row) => row.source === source)
      const byFixture = new Map()
      for (const row of picked) {
        if (!byFixture.has(row.fixtureId)) byFixture.set(row.fixtureId, [])
        byFixture.get(row.fixtureId).push(row)
      }
      const spreads = [...byFixture.values()]
        .filter((items) => items.length === 2)
        .map((items) => Math.abs(items[0].rank - items[1].rank))
      return {
        source,
        ranks: picked.map((row) => row.rank),
        meanRank: picked.reduce((sum, row) => sum + row.rank, 0) / picked.length,
        meanNormalized: picked.reduce((sum, row) => sum + row.normalized, 0) / picked.length,
        firstPlaces: picked.filter((row) => row.rank === 1).length,
        meanSeedSpread: spreads.length ? spreads.reduce((sum, value) => sum + value, 0) / spreads.length : 0,
      }
    }).sort((a, b) => a.meanNormalized - b.meanNormalized || a.meanRank - b.meanRank)
  }

  const md = []
  md.push(`# PE 盲测 ${fixtures.config.version} · ${reviewerId} 通用题图片分析\n`)
  md.push('> 名次为组内相对排名；跨模型比较看归一化平均名次与组内第一率，不直接比较原始名次。\n')
  md.push('## 来源汇总\n')
  md.push('| 底模 | 来源 | 各单元名次 | 平均名次 | 归一化平均 | 组内第一 | seed 平均波动 |')
  md.push('|---|---|---|---:|---:|---:|---:|')
  for (const [model, sources] of Object.entries(summary)) {
    for (const item of sources) md.push(`| ${model} | ${item.source} | ${item.ranks.join(' / ')} | ${item.meanRank.toFixed(2)} | ${item.meanNormalized.toFixed(3)} | ${item.firstPlaces} | ${item.meanSeedSpread.toFixed(2)} |`)
  }
  md.push('\n## 逐组排名\n')
  for (const [index, group] of page.groups.entries()) {
    const submitted = parsed[index]
    const ranked = [...submitted.picks].sort((a, b) => a.rank - b.rank)
    const mapped = ranked.map((pick) => {
      const item = group.items.find((candidate) => candidate.label === pick.label)
      return `${pick.rank}=${pick.label}(${item.source})`
    })
    md.push(`### ${group.briefId} · 样次 ${group.sampleIndex + 1} · ${group.canonicalGroup}\n`)
    md.push(`- ${group.label}：${mapped.join('，')}`)
    if (submitted.note) md.push(`- 补充说明：${submitted.note}`)
    md.push('')
  }
  const analysisDir = join(outDir, 'analysis')
  mkdirp(analysisDir)
  const base = join(analysisDir, reviewerId)
  writeFileSync(base + '.md', md.join('\n') + '\n', 'utf8')
  writeJson(base + '.json', { version: fixtures.config.version, reviewer: reviewerId, rows, summary, notes: parsed.map((group) => group.note) })
  return { markdownPath: base + '.md', jsonPath: base + '.json', summary, rows }
}

function option(args, name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'audit'
  const round = option(argv, '--round', 'v1')
  const fixtures = loadFixtures(ROOT, round)
  const outDir = resolve(ROOT, option(argv, '--out', fixtures.config.outputDir))
  if (command === 'audit') {
    const audit = auditFixtures(fixtures)
    if (!audit.ok) {
      console.error('PE 盲测夹具审计失败：')
      for (const error of audit.errors) console.error('  ✗', error)
      process.exitCode = 1
      return
    }
    console.log(`夹具 ${round} 通过：主测 ${audit.counts.main} 张，IP ${audit.counts.ip} 张；IP 为 ${audit.characterCounts.generated} 个出图 + ${audit.characterCounts.textOnly} 个纯文本审计。`)
    return
  }
  if (command === 'generate') {
    if (argv.includes('--dry-run')) {
      const audit = auditFixtures(fixtures)
      if (!audit.ok) throw new Error(audit.errors.join('\n'))
      console.log(`dry-run ${round}：将生成 ${audit.counts.main} 张主测图与 ${audit.counts.ip} 张 IP 图；TextGenerateV2 会在首张评分图前冻结。`)
      return
    }
    await generateAll({
      fixtures,
      outDir,
      endpoint: option(argv, '--endpoint', 'http://127.0.0.1:8188'),
      refreshText: argv.includes('--refresh-text'),
    })
    return
  }
  if (command === 'score') {
    const reviewerId = option(argv, '--reviewer', 'reviewer-1')
    const result = argv.includes('--rerender')
      ? rerenderReviewer({ fixtures, outDir, reviewerId })
      : scoreAll({ fixtures, outDir, reviewerId })
    console.log(`评审页面已生成：${result.reviewerDir}`)
    console.log(`页面：${result.pages.join(', ')}`)
    return
  }
  if (command === 'analyze') {
    const reviewerId = option(argv, '--reviewer', 'reviewer-1')
    const result = analyzeReviewer({ fixtures, outDir, reviewerId, inputPath: option(argv, '--input', undefined) })
    console.log(`分析报告：${result.markdownPath}`)
    console.log(`结构化结果：${result.jsonPath}`)
    return
  }
  if (command === 'check') {
    const result = runCheck({ fixtures, outDir })
    if (!result.ok) {
      console.error('PE 盲测检查失败：')
      for (const error of result.errors) console.error('  ✗', error)
      process.exitCode = 1
      return
    }
    console.log(`检查通过：${result.counts.main} 张主测图、${result.counts.ip} 张 IP 图、冻结提示词、随机文件名、PNG 参数与评审页隔离均一致。`)
    return
  }
  throw new Error(`未知命令 ${command}；可用 audit | generate | score | check`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
