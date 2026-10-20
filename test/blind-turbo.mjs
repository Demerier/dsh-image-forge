/**
 * 盲测脚本：base（25 步）vs turbo（8 步），同 prompt 同 seed。
 *
 * 每题生成两张图，落盘到 .blindtest/，然后输出一份乱序的 HTML，
 * 图的来源被彻底隐藏（文件名是乱序后的随机 id），打分表也在同一页。
 *
 * 用法：node test/blind-turbo.mjs [题数]
 *  默认 5 题；每题约 25s（turbo）+ 60s（base），5 题全程 ~8 分钟。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderScorePage } from './blind-score-page.mjs'

const EP = 'http://127.0.0.1:8188'
// `fileURLToPath` decodes the percent-encoding that `URL.pathname` keeps for
// non-ASCII paths — using the pathname directly would create a folder whose
// name contains literal `%E7%94%9F…` escapes.
const OUT = dirname(fileURLToPath(import.meta.url)) + '/.blindtest/'
mkdirSync(OUT, { recursive: true })

const N_QUESTIONS = Number(process.argv[2] ?? 5)
const SIGMAS = '1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0'

const info = await (await fetch(`${EP}/object_info`)).json()
const pick = (list, re) => list.find((n) => re.test(n))
const unetBase = pick(info.UNETLoader.input.required.unet_name[0], /qwen_image_2\.1_int8/)
const unetTurbo = pick(info.UNETLoader.input.required.unet_name[0], /turbo/)
const clip = pick(info.CLIPLoader.input.required.clip_name[0], /qwen3vl.*int8/)
const vae = pick(info.VAELoader.input.required.vae_name[0], /qwen_image_2\.1_vae/)
const clipType = 'qwen_image'
if (!unetBase || !unetTurbo || !clip || !vae) {
  console.error('缺权重', { unetBase, unetTurbo, clip, vae })
  process.exit(1)
}

/** 五道题：不同题材、不同难度（文字、细节、构图、光影、多人）。 */
const QUESTIONS = [
  {
    id: 'Q1',
    prompt: '一杯玻璃杯装的冰美式咖啡放在原木桌面上，杯壁挂着水珠，背景是虚化的书店书架，午后自然光从左侧窗户照进来，浅景深，写实摄影风格。',
  },
  {
    id: 'Q2',
    prompt: '一张极简海报：深蓝色背景，中央一行白色粗体无衬线文字「山海」，文字下方一枚小小的红色圆形印章，海报四边留白均匀，平面设计。',
  },
  {
    id: 'Q3',
    prompt: '一只橘白相间的猫趴在窗台上打盹，窗外是雨天的城市街景，玻璃上挂着雨滴，室内有一盏暖黄色台灯，电影感画面，35mm 胶片质感。',
  },
  {
    id: 'Q4',
    prompt: '赛博朋克风格的夜市街道，湿漉漉的地面反射着霓虹灯牌，一个穿雨衣的人背对镜头走在画面中央，两侧是挂着中文招牌的小吃摊，雾气，蓝紫色调。',
  },
  {
    id: 'Q5',
    prompt: '静物写生：木桌上一个青瓷茶壶、两个茶杯、一枝插在细颈瓶里的梅花，背景是素色亚麻布，柔和的伦勃朗光，荷兰黄金时代油画风格。',
  },
].slice(0, N_QUESTIONS)

/** 画布：全部 1:1 1216×1216，排除画幅变量。 */
const SIZE = { width: 1024, height: 1024 }

function graph(kind, prompt, seed) {
  const unet = kind === 'base' ? unetBase : unetTurbo
  const g = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: clip, type: clipType } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: vae } },
    '4': { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['2', 0], prompt, negative_prompt: '', resolution: 1024 } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: SIZE.width, height: SIZE.height, batch_size: 1 } },
    '11': { class_type: 'VAEDecode', inputs: { vae: ['3', 0] } },
    '12': { class_type: 'SaveImage', inputs: { images: ['11', 0], filename_prefix: `blind-${kind}` } },
  }
  if (kind === 'base') {
    g['6'] = { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['4', 0], negative: ['4', 1], latent_image: ['5', 0], seed, steps: 25, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } }
    g['11'].inputs.samples = ['6', 0]
  } else {
    g['6'] = { class_type: 'RandomNoise', inputs: { noise_seed: seed } }
    g['7'] = { class_type: 'CFGGuider', inputs: { model: ['1', 0], positive: ['4', 0], negative: ['4', 1], cfg: 1 } }
    g['8'] = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } }
    g['9'] = { class_type: 'ManualSigmas', inputs: { sigmas: SIGMAS } }
    g['10'] = { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['6', 0], guider: ['7', 0], sampler: ['8', 0], sigmas: ['9', 0], latent_image: ['5', 0] } }
    g['11'].inputs.samples = ['10', 0]
  }
  return g
}

async function run(graph, label) {
  const t0 = Date.now()
  const res = await fetch(`${EP}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph }) })
  const body = await res.json()
  if (!res.ok) throw new Error(`${label}: ${JSON.stringify(body).slice(0, 400)}`)
  const id = body.prompt_id
  const deadline = Date.now() + 420000
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500))
    const h = await (await fetch(`${EP}/history/${id}`)).json()
    const e = h[id]
    if (e === undefined) {
      if (Date.now() > deadline) throw new Error(`${label}: 超时 420s`)
      continue
    }
    if (e.status?.status_str !== 'success') throw new Error(`${label}: ${JSON.stringify(e.status).slice(0, 400)}`)
    const img = Object.values(e.outputs).flatMap((o) => o.images ?? [])[0]
    if (!img) throw new Error(`${label}: 无输出图`)
    const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type })
    const bytes = new Uint8Array(await (await fetch(`${EP}/view?${q}`)).arrayBuffer())
    return { bytes, ms: Date.now() - t0 }
  }
}

/** 真随机乱序（Fisher-Yates，crypto 随机源）。 */
function shuffle(items) {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Number(crypto.getRandomValues(new Uint32Array(1))[0]) % (i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** 主流程：逐题生成 → 乱序命名 → 出 HTML。 */
const tiles = []
const key = []
for (const q of QUESTIONS) {
  const seed = 1_000_000 + Number(crypto.getRandomValues(new Uint32Array(1))[0] % 9_000_000)
  console.log(`[${q.id}] seed=${seed} 生成中…`)
  const base = await run(graph('base', q.prompt, seed), `${q.id}/base`)
  console.log(`  base 25步: ${(base.ms / 1000).toFixed(1)}s`)
  const turbo = await run(graph('turbo', q.prompt, seed), `${q.id}/turbo`)
  console.log(`  turbo 8步: ${(turbo.ms / 1000).toFixed(1)}s`)

  // 两张图随机分配甲/乙：磁盘上直接以甲/乙命名（评分页按文件名引用），
  // 随机 id 文件名只作为生成时的中间产物，不参与展示——这样「文件名→来源」
  // 的映射只存在于 key.json 一处。
  const order = shuffle(['base', 'turbo'])
  const files = {}
  const written = {}
  for (const [position, kind] of order.entries()) {
    const shown = `${q.id}_${position === 0 ? '甲' : '乙'}.png`
    writeFileSync(join(OUT, shown), kind === 'base' ? base.bytes : turbo.bytes)
    files[kind] = shown
    written[kind] = shown
    key.push({ q: q.id, shown, kind, seed })
  }
  // 评分页只引用甲/乙文件名；记录 base/turbo 顺序供 key 对账。
  tiles.push({ q, files: { base: files.base, turbo: files.turbo }, seed, written })
}

// 评分页交给共享渲染器（renderScorePage）：它从 key 的 shown 反查甲/乙，
// 不会把 base 默认摆到左边——乱序决定了谁在左侧。
const html = renderScorePage({ tiles, key })

// key.json 里的 tiles 记的是 {base, turbo} 文件名；上面的模板已通过 `key` 的
// `shown` 反查甲/乙，所以这里不需要再改写它，只把映射原样留档。
writeFileSync(join(OUT, 'score.html'), html)
// key 单独落盘，评分页不引用它。
writeFileSync(join(OUT, 'key.json'), JSON.stringify({ tiles, key, unetBase, unetTurbo }, null, 2))
console.log('\n完成。评分页：', join(OUT, 'score.html'))
console.log('答案 key（评分后再看）：', join(OUT, 'key.json'))
console.log('答案速览（甲/乙 -> base|turbo）：')
for (const e of key) console.log(`  ${e.q} ${e.shown} <- ${e.kind} (seed ${e.seed})`)
