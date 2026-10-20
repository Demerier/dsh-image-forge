/**
 * 盲测评分页的渲染器，单独成文件以便两处复用：
 * `test/blind-turbo.mjs`（生图后调用）与 `test/blind-regen.mjs`（只重出页面）。
 *
 * 页面不引用 key：甲/乙与 base/turbo 的对应关系只在 key.json 里，
 * 但**甲/乙的文件名必须从 key 反查**——乱序决定了谁在左边，不能假定 base 在左。
 *
 * @param {{
 *   tiles: Array<{ q: { id: string, prompt: string }, files: Record<string, string>, seed: number }>,
 *   key: Array<{ q: string, shown: string, kind: string, seed: number }>,
 * }} data
 * @returns {string} 完整的 HTML 文档
 */
export function renderScorePage({ tiles, key }) {
  const pickFor = (id, side) => key.find((entry) => entry.q === id && entry.shown.endsWith(`${side}.png`))?.shown ?? ''

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>盲测 · base vs turbo</title>
<style>
body{font-family:system-ui,sans-serif;max-width:920px;margin:24px auto;padding:0 16px 96px;color:#1c1e21}
h1{margin-bottom:4px}
.lead{color:#555;font-size:13px;margin-top:0}
.q{border:1px solid #dcdfe3;border-radius:10px;padding:18px;margin:22px 0;transition:border-color .15s,background .15s}
.q.done{border-color:#7fbf8a;background:#f6fbf7}
.q h3{margin:0 0 6px}
.prompt{font-size:13px;color:#555;margin:0 0 12px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.pair figure{margin:0;text-align:center}
.pair img{width:100%;border-radius:8px;border:1px solid #e3e5e8;cursor:zoom-in;display:block}
.pick{margin-top:10px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
.pick label{cursor:pointer;padding:6px 14px;border:1px solid #c9ccd1;border-radius:999px;font-size:13px;user-select:none;position:relative}
.pick label:has(input:checked){background:#1c1e21;color:#fff;border-color:#1c1e21}
.pick input{position:absolute;opacity:0;pointer-events:none}
.meta{color:#999;font-size:11px;margin:8px 0 0;text-align:center}
.bar{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid #dcdfe3;padding:12px max(16px,calc(50% - 460px));display:flex;gap:10px;align-items:center;flex-wrap:wrap;box-shadow:0 -2px 12px rgba(0,0,0,.04)}
.bar .count{font-size:13px;color:#555;margin-right:auto}
button{font:inherit;padding:8px 18px;border-radius:8px;border:1px solid #1c1e21;background:#1c1e21;color:#fff;cursor:pointer}
button:disabled{opacity:.35;cursor:not-allowed}
button.ghost{background:#fff;color:#1c1e21}
#out{width:min(920px,calc(100vw - 32px));min-height:0;margin:10px auto 0;padding:12px;border-radius:8px;border:1px solid #dcdfe3;font:12px/1.6 ui-monospace,Consolas,monospace;background:#fafbfc;display:none;box-sizing:border-box;resize:vertical}
#out.show{display:block}
.hint{font-size:11px;color:#999;width:100%;margin-top:2px}
</style></head><body>
<h1>盲测：哪张更好？</h1>
<p class="lead">共 ${tiles.length} 题，每题两张图（甲 / 乙），同一提示词、同一随机种子。只按「你喜欢哪张」打分，不用管为什么。全部选完后点底部按钮生成提示词。</p>
${tiles.map(({ q, seed }) => {
  const jia = pickFor(q.id, '甲')
  const yi = pickFor(q.id, '乙')
  return `
<div class="q" id="q-${q.id}">
  <h3>${q.id}</h3>
  <p class="prompt">${escapeHtml(q.prompt)}</p>
  <div class="pair">
    <figure><img src="${jia}" alt="${q.id} 甲" data-full="${jia}"><figcaption>甲</figcaption></figure>
    <figure><img src="${yi}" alt="${q.id} 乙" data-full="${yi}"><figcaption>乙</figcaption></figure>
  </div>
  <div class="pick">
    <label><input type="radio" name="${q.id}" value="甲">甲更好</label>
    <label><input type="radio" name="${q.id}" value="乙">乙更好</label>
    <label><input type="radio" name="${q.id}" value="平">看不出差别</label>
  </div>
  <p class="meta">seed ${seed} · 点击图片可看原图</p>
</div>`
}).join('')}
<div class="bar">
  <span class="count" id="count">已选 0 / ${tiles.length}</span>
  <button id="gen" disabled>生成提示词</button>
  <button id="again" class="ghost">重选</button>
  <span class="hint">生成的文本可直接粘回对话继续讨论。</span>
</div>
<textarea id="out" readonly spellcheck="false" aria-label="生成的提示词"></textarea>

<script>
// 每题一个选择：甲/乙/平。全选完才允许出提示词——半份数据算不出结论。
const TOTAL = ${tiles.length}
const QIDS = ${JSON.stringify(tiles.map((t) => t.q.id))}
const PROMPTS = ${JSON.stringify(Object.fromEntries(tiles.map((t) => [t.q.id, t.q.prompt])))}

function picks() {
  const out = {}
  for (const id of QIDS) {
    const checked = document.querySelector('input[name="' + id + '"]:checked')
    if (checked) out[id] = checked.value
  }
  return out
}
function refresh() {
  const p = picks()
  const n = Object.keys(p).length
  document.getElementById('count').textContent = '已选 ' + n + ' / ' + TOTAL
  document.getElementById('gen').disabled = n !== TOTAL
  for (const id of QIDS) {
    document.getElementById('q-' + id).classList.toggle('done', id in p)
  }
}

// 提示词不是一句"加油"，而是一次可复制的追问：把每题的原文与选择带成上下文，
// 让人可以直接粘回对话里继续讨论结论。
function buildPrompt() {
  const p = picks()
  // 甲/乙 指向哪套管线只写在 key.json 里，页面上不知道也不该知道。所以这里只报
  // 「我选了哪一侧」，让对话那边结合 key 去解读——写死 base=甲 就把盲测破了。
  const lines = QIDS.map((id) => '- ' + id + '「' + PROMPTS[id] + '」→ ' + (p[id] === '平' ? '平（看不出差别）' : '我选 ' + p[id]))
  return [
    '我做完了一轮 Qwen-Image 2.1 base(25步) 与 turbo(8步) 的盲测，每题同提示词同种子，只改了采样器与步数。',
    '我的选择：',
    ...lines,
    '',
    '答案 key 在 .blindtest/key.json（每题记了 甲/乙 → base|turbo）。',
    '请据此判断：turbo 在这些题材上是否够用、哪类题材明显吃亏，并给出默认配置建议（跑 base 还是 turbo、turbo 步数要不要偏离 8）。',
  // 转义说明：见文件头的 note，这里只能是双反斜杠-n 形式。
  ].join('\\n')
}

document.addEventListener('change', refresh)
document.getElementById('gen').addEventListener('click', () => {
  const box = document.getElementById('out')
  box.value = buildPrompt()
  box.classList.add('show')
  box.focus()
  box.select()
})
document.getElementById('again').addEventListener('click', () => {
  for (const r of document.querySelectorAll('input[type=radio]')) r.checked = false
  const box = document.getElementById('out')
  box.classList.remove('show')
  box.value = ''
  refresh()
})
for (const img of document.querySelectorAll('.pair img')) {
  img.addEventListener('click', () => window.open(img.dataset.full, '_blank'))
}
refresh()
</script>
</body></html>`
}

/** 最小 HTML 转义，题面里的尖括号不能变成标签。 */
function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
