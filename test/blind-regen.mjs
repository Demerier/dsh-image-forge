/**
 * 只重出评分页，不重新生图。
 *
 * 盲测跑一趟要 3 分钟 GPU（5 题 × base 27s + turbo 10s）。改评分页样式或
 * 提示词拼法时没必要重跑——key.json 已经记下了「甲/乙 → base|turbo」的映射
 * 和题面，渲染是纯函数，直接拿来重画即可。
 *
 * 用法：node test/blind-regen.mjs [目录]
 *  默认读 test/.blindtest/，也接受项目根的 .blindtest/。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderScorePage } from './blind-score-page.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// 产物落在项目根 .blindtest/；早期版本曾落在 test/ 下，一并兜住。
const candidates = process.argv[2]
  ? [process.argv[2]]
  : [join(here, '..', '.blindtest'), join(here, '.blindtest'), join(process.cwd(), '.blindtest')].filter(
      (candidate, index, all) => all.indexOf(candidate) === index,
    )
const dir = candidates.find((candidate) => existsSync(join(candidate, 'key.json')))

if (!dir) {
  console.error('找不到 key.json，先跑一次 node test/blind-turbo.mjs')
  process.exit(1)
}

const { tiles, key } = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8'))
const missing = key.filter((entry) => !existsSync(join(dir, entry.shown)))
if (missing.length > 0) {
  console.error('缺图：', missing.map((entry) => entry.shown).join(', '))
  process.exit(1)
}

writeFileSync(join(dir, 'score.html'), renderScorePage({ tiles, key }))
console.log(`已重出 ${join(dir, 'score.html')}（${tiles.length} 题 / ${key.length} 张图）`)
