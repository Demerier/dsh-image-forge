/**
 * 评分页的端到端演练：把 score.html 里的 <script> 抠出来，在 node 里配一层
 * 极简 DOM 跑一遍「逐题选 → 计数递增 → 全选解锁 → 生成提示词 → 重选清空」。
 *
 * 它挡的是模板字符串里最容易翻车的一类错：转义写错（'\n' 而不是 '\\n'）、
 * 拼出 `${...}` 字面量、甲/乙错配。这些在浏览器里表现为「按钮点了没反应」，
 * 光看 HTML 源码很难发现。
 *
 * 用法：node test/blind-score-check.mjs [目录]
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const candidates = process.argv[2]
  ? [process.argv[2]]
  : [join(here, '..', '.blindtest'), join(here, '.blindtest'), join(process.cwd(), '.blindtest')].filter(
      (candidate, index, all) => all.indexOf(candidate) === index,
    )
const dir = candidates.find((candidate) => existsSync(join(candidate, 'score.html')))

if (!dir) {
  console.error('找不到 score.html，先跑 node test/blind-regen.mjs')
  process.exit(1)
}

const html = readFileSync(join(dir, 'score.html'), 'utf8')
const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8'))
const problems = []

// 1. 模板未展开、资源路径存在
if (/\$\{/.test(html)) problems.push('页面里残留了未展开的 ${...} 字面量')
const srcs = [...html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1])
if (srcs.length !== key.key.length) problems.push(`图片数 ${srcs.length} ≠ key 里 ${key.key.length} 张`)
for (const src of srcs) if (!existsSync(join(dir, src))) problems.push(`图片不存在：${src}`)

// 2. 甲/乙 与 key 对账：页面顺序不是判据，但文件名必须与 key 一致
for (const entry of key.key) {
  if (!srcs.includes(entry.shown)) problems.push(`${entry.q} 的 ${entry.shown} 没被页面引用`)
}

// 3. 跑脚本
const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1]
if (!script) {
  console.error('score.html 里没有 <script>')
  process.exit(1)
}

const els = {}
const radios = {}
const makeEl = (id) => ({
  id,
  textContent: '',
  disabled: false,
  value: '',
  handlers: {},
  classList: {
    set: new Set(),
    add(c) { this.set.add(c) },
    remove(c) { this.set.delete(c) },
    toggle(c, on) { on ? this.set.add(c) : this.set.delete(c) },
    contains(c) { return this.set.has(c) },
  },
  addEventListener(event, fn) { this.handlers[event] = fn },
  focus() {},
  select() {},
})
for (const id of ['count', 'gen', 'again', 'out']) els[id] = makeEl(id)

const document = {
  getElementById: (id) => els[id] ?? makeEl(id),
  // 选择器是 input[name="Q1"]:checked —— name 与 :checked 之间还有别的字符，
  // 不能用锚定的正则去抠；用非贪婪匹配取第一个 name 即可。
  querySelector: (selector) => {
    if (!selector.includes(':checked')) return null
    const name = selector.match(/name="(.+?)"/)?.[1]
    return name ? radios[name] ?? null : null
  },
  querySelectorAll: (selector) => (selector.includes('radio') ? Object.values(radios) : []),
  addEventListener() {},
}

let api
try {
  // 等价于浏览器里的 <script>：语法错在这一步就炸，正好被抓到
  api = new Function('document', 'window', script + '; return { picks, buildPrompt, refresh }')(
    document,
    { open() {} },
  )
} catch (error) {
  console.error('评分页脚本无法执行：', error.message)
  process.exit(1)
}

const ids = key.tiles.map((tile) => tile.q.id)
api.refresh()
if (els.gen.disabled !== true) problems.push('一题未选时「生成提示词」应当禁用')

const answers = { 甲: '甲', 乙: '乙', 平: '平' }
ids.forEach((id, index) => {
  const choice = ['甲', '乙', '平'][index % 3]
  radios[id] = { value: answers[choice] }
  api.refresh()
  if (els.count.textContent !== `已选 ${index + 1} / ${ids.length}`) {
    problems.push(`选到第 ${index + 1} 题时计数不对：${els.count.textContent}`)
  }
})
if (els.gen.disabled !== false) problems.push('全选后「生成提示词」仍然禁用')

els.gen.handlers.click()
const text = els.out.value
if (!text) problems.push('点了「生成提示词」但文本框是空的')
if (!els.out.classList.contains('show')) problems.push('文本框没有显示出来')
for (const id of ids) if (!text.includes(id)) problems.push(`提示词里缺 ${id}`)
if(/\bundefined\b/.test(text)) problems.push('提示词里出现了 undefined')
if (!text.includes('key.json')) problems.push('提示词里没交代答案 key 的位置')
if (text.split('\n').length < ids.length + 3) problems.push('提示词换行没展开（\\n 转义写错了？）')

els.again.handlers.click()
for (const id of ids) delete radios[id]
api.refresh()
if (els.count.textContent !== `已选 0 / ${ids.length}`) problems.push('重选后计数没归零')
if (els.out.value !== '') problems.push('重选后文本框没清空')
if (els.gen.disabled !== true) problems.push('重选后按钮没重新禁用')

if (problems.length > 0) {
  console.error('评分页自检失败：')
  for (const problem of problems) console.error('  ✗', problem)
  process.exit(1)
}
console.log(`评分页自检通过（${ids.length} 题 / ${srcs.length} 张图 / 提示词 ${text.length} 字）`)
if (process.argv.includes('--print')) console.log('\n' + text)
