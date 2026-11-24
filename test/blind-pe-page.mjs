/**
 * PE 盲测排名页。页面只认识「原始需求 + 随机顺序的候选」：
 * 图片来源、模型、最终提示词和答案映射一律留在独立 key.json。
 *
 * 每个分组都必须完成唯一名次；所有分组完成后才允许导出。
 */

/** 把任意文本安全放进 HTML 文本节点或属性。 */
export function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function letters(count) {
  return Array.from({ length: count }, (_, i) => String.fromCharCode(65 + i))
}

/**
 * 渲染一份 2–5 项一组的强制排名页。
 *
 * @param {{
 *   title: string,
 *   lead: string,
 *   exportTitle: string,
 *   guidanceTitle?: string,
 *   guidance?: string[],
 *   notes?: { label: string, placeholder: string },
 *   briefs: Array<{
 *     id: string,
 *     brief: string,
 *     groups: Array<{
 *       id: string,
 *       label: string,
 *       kind: 'image' | 'text',
 *       items: Array<{ label: string, src?: string, text?: string }>,
 *     }>,
 *   }>,
 * }} data
 * @returns {string}
 */
export function renderRankingPage(data) {
  if (!data || typeof data.title !== 'string' || !Array.isArray(data.briefs)) {
    throw new Error('ranking page: title and briefs are required')
  }
  for (const brief of data.briefs) {
    if (!Array.isArray(brief.groups) || brief.groups.length === 0) throw new Error(`ranking page: ${brief.id} has no groups`)
    for (const group of brief.groups) {
      if (group.kind !== 'image' && group.kind !== 'text') throw new Error(`ranking page: unsupported kind ${group.kind}`)
      if (group.items.length < 2 || group.items.length > 5) throw new Error(`ranking page: ${group.id} must have 2–5 items`)
      if (new Set(group.items.map((item) => item.label)).size !== group.items.length) {
        throw new Error(`ranking page: ${group.id} has duplicate item labels`)
      }
    }
  }

  const pageModel = {
    title: data.title,
    exportTitle: data.exportTitle,
    guidanceTitle: data.guidanceTitle || '评选重点',
    guidance: Array.isArray(data.guidance) ? data.guidance.map(String) : [],
    notes: data.notes ? { label: String(data.notes.label || '补充说明'), placeholder: String(data.notes.placeholder || '') } : null,
    briefs: data.briefs.map((brief) => ({
      id: brief.id,
      brief: brief.brief,
      groups: brief.groups.map((group) => ({ id: group.id, label: group.label, kind: group.kind, size: group.items.length })),
    })),
  }

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(data.title)}</title>
<style>
:root{--ink:#1b1d20;--muted:#666b73;--line:#d9dde2;--paper:#fff;--soft:#f6f7f8;--good:#477a57}
*{box-sizing:border-box}
body{margin:0;background:#eef0f2;color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1120px;margin:0 auto;padding:28px 18px 120px}
header{background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:22px 24px;margin-bottom:18px}
h1{font-size:clamp(24px,3.4vw,38px);line-height:1.14;margin:0 0 8px;letter-spacing:-.02em}
.lead{color:var(--muted);line-height:1.7;margin:0;max-width:820px;font-size:14px}
.brief{background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:20px;margin:18px 0}
.brief h2{margin:0 0 8px;font-size:19px}
.brief p{margin:0;color:#41464d;line-height:1.7;font-size:14px;white-space:pre-wrap}
.group{border-top:1px solid var(--line);margin-top:18px;padding-top:18px}
.group-head{display:flex;gap:12px;align-items:baseline;justify-content:space-between;flex-wrap:wrap;margin-bottom:12px}
.group h3{margin:0;font-size:16px}
.group-status{font-size:12px;color:var(--muted)}
.items{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px}
.item{background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:10px;display:flex;flex-direction:column;gap:10px}
.badge{display:inline-flex;width:28px;height:28px;align-items:center;justify-content:center;border-radius:50%;background:var(--ink);color:#fff;font-weight:700;font-size:13px}
.image-card{position:relative}
.image-card img{width:100%;aspect-ratio:1/1;object-fit:contain;display:block;border-radius:8px;background:#fff;cursor:zoom-in}
.text-card{padding:14px}
.prompt-copy{font-size:12.5px;line-height:1.65;white-space:pre-wrap;margin:10px 0 0;color:#30343a}
.rank-row{display:flex;gap:8px;align-items:center;margin-top:auto;font-size:12px;color:var(--muted)}
select{font:inherit;padding:7px 34px 7px 10px;border:1px solid #c8cdd3;border-radius:8px;background:#fff;color:var(--ink);min-width:72px}
.bar{position:fixed;left:0;right:0;bottom:0;background:rgba(255,255,255,.96);backdrop-filter:blur(8px);border-top:1px solid var(--line);padding:12px max(18px,calc((100vw - 1120px)/2));display:flex;gap:10px;align-items:center;flex-wrap:wrap;z-index:10}
.bar .count{font-size:13px;color:var(--muted);margin-right:auto}
button{font:inherit;padding:9px 18px;border-radius:9px;border:1px solid var(--ink);background:var(--ink);color:#fff;cursor:pointer}
button:disabled{opacity:.35;cursor:not-allowed}
button.ghost{background:#fff;color:var(--ink)}
#out{display:none;width:min(1120px,calc(100vw - 36px));min-height:160px;margin:12px auto 0;padding:14px;box-sizing:border-box;border:1px solid var(--line);border-radius:12px;background:#fbfcfd;font:12.5px/1.65 ui-monospace,Consolas,monospace;resize:vertical}
#out.show{display:block}
.guidance{margin-top:14px;padding:13px 15px;border-radius:12px;background:#f2f6f8;border:1px solid #d8e0e5;color:#3d464d;font-size:13px;line-height:1.65}
.guidance strong{display:block;margin-bottom:4px;color:#263038}
.guidance ul{margin:0;padding-left:20px}
.group-note{width:100%;min-height:72px;margin-top:14px;padding:10px 12px;border-radius:10px;border:1px solid #c8cdd3;background:#fff;font:13px/1.6 ui-sans-serif,system-ui,sans-serif;color:var(--ink);resize:vertical}
.group-note-label{display:block;font-size:12px;color:var(--muted);margin-top:10px}
.hint{font-size:11.5px;color:var(--muted);width:100%}
</style></head><body>
<main>
<header><h1>${escapeHtml(data.title)}</h1><p class="lead">${escapeHtml(data.lead)}</p>${pageModel.guidance.length ? `<div class="guidance"><strong>${escapeHtml(pageModel.guidanceTitle)}</strong><ul>${pageModel.guidance.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}</header>
${data.briefs.map((brief) => `
<section class="brief" id="brief-${escapeHtml(brief.id)}">
  <h2>${escapeHtml(brief.id)}</h2>
  <p>${escapeHtml(brief.brief)}</p>
  ${brief.groups.map((group) => renderGroup(group, pageModel.notes)).join('\n')}
</section>`).join('\n')}
</main>
<div class="bar">
  <span class="count" id="count"></span>
  <button id="export" disabled>导出排名</button>
  <button id="reset" class="ghost">重选</button>
  <span class="hint">每组内的名次必须唯一；所有分组完成后才能导出。</span>
</div>
<textarea id="out" readonly spellcheck="false" aria-label="导出的排名"></textarea>
<script>
const PAGE = ${JSON.stringify(pageModel)}
const GROUP_IDS = PAGE.briefs.flatMap((brief) => brief.groups.map((group) => group.id))
const GROUPS = PAGE.briefs.flatMap((brief) => brief.groups)

function normalize(value) { return String(value || '').trim() }
function selections() {
  const out = {}
  for (const groupId of GROUP_IDS) out[groupId] = []
  for (const select of document.querySelectorAll('.rank-select')) {
    const groupId = select.dataset.group
    if (!out[groupId]) out[groupId] = []
    out[groupId].push({ item: select.dataset.item, value: normalize(select.value) })
  }
  return out
}

function groupOk(groupId, picks) {
  const group = GROUPS.find((candidate) => candidate.id === groupId)
  const items = picks.filter((pick) => pick.value !== '')
  const wanted = group ? group.size : 0
  return items.length === wanted && new Set(items.map((pick) => pick.value)).size === wanted
}

function refresh() {
  const picks = selections()
  let complete = true
  let finished = 0
  for (const groupId of GROUP_IDS) {
    const ok = groupOk(groupId, picks[groupId] || [])
    if (ok) finished += 1
    else complete = false
    const status = document.getElementById('status-' + groupId)
    if (status) {
      const got = (picks[groupId] || []).filter((pick) => pick.value !== '').length
      const group = GROUPS.find((candidate) => candidate.id === groupId)
      status.textContent = ok ? '已完成' : '已选 ' + got + ' / ' + (group?.size || 0)
    }
  }
  document.getElementById('count').textContent = '已完成 ' + finished + ' / ' + GROUP_IDS.length + ' 组'
  document.getElementById('export').disabled = !complete
}

function groupNotes() {
  const notes = {}
  for (const box of document.querySelectorAll('.group-note')) notes[box.dataset.group] = normalize(box.value)
  return notes
}

function buildExportText() {
  const picks = selections()
  const notes = groupNotes()
  const lines = [PAGE.exportTitle]
  for (const brief of PAGE.briefs) {
    lines.push('', brief.id + '「' + brief.brief + '」')
    for (const group of brief.groups) {
      const ranked = (picks[group.id] || [])
        .filter((pick) => pick.value !== '')
        .slice()
        .sort((a, b) => Number(a.value) - Number(b.value))
      lines.push('- ' + group.label + '：' + ranked.map((pick) => pick.value + '=' + pick.item).join('，'))
      if (notes[group.id]) lines.push('  - 补充说明：' + notes[group.id])
    }
  }
  lines.push('', '请由组织者用本次评审目录中的独立答案文件核对名次，不要公开候选来源。')
  return lines.join('\\n')
}

document.addEventListener('change', (event) => {
  const select = event.target
  if (!select || !select.classList || !select.classList.contains('rank-select') || select.value === '') {
    refresh()
    return
  }
  for (const peer of document.querySelectorAll('.rank-select')) {
    if (peer !== select && peer.dataset.group === select.dataset.group && peer.value === select.value) peer.value = ''
  }
  refresh()
})

document.getElementById('export').addEventListener('click', () => {
  const box = document.getElementById('out')
  box.value = buildExportText()
  box.classList.add('show')
  box.focus()
  box.select()
})

document.getElementById('reset').addEventListener('click', () => {
  for (const select of document.querySelectorAll('.rank-select')) select.value = ''
  for (const box of document.querySelectorAll('.group-note')) box.value = ''
  const box = document.getElementById('out')
  box.value = ''
  box.classList.remove('show')
  refresh()
})

for (const image of document.querySelectorAll('.shot')) image.addEventListener('click', () => window.open(image.src, '_blank'))

refresh()
</script>
</body></html>`
}

function renderGroup(group, notes) {
  const labels = letters(group.items.length)
  return `<section class="group" id="group-${escapeHtml(group.id)}">
  <div class="group-head"><h3>${escapeHtml(group.label)}</h3><span class="group-status" id="status-${escapeHtml(group.id)}">未开始</span></div>
  <div class="items">
    ${group.items.map((item, index) => {
      const label = labels[index]
      const body = group.kind === 'image'
        ? `<div class="image-card"><img class="shot" src="${escapeHtml(item.src)}" alt="${escapeHtml(label)}" loading="lazy"><div style="margin-top:10px"><span class="badge">${label}</span></div></div>`
        : `<div class="text-card"><span class="badge">${label}</span><p class="prompt-copy">${escapeHtml(item.text)}</p></div>`
      return `<article class="item">${body}<label class="rank-row">名次 <select class="rank-select" data-group="${escapeHtml(group.id)}" data-item="${label}" aria-label="${escapeHtml(group.label)} ${label} 的名次"><option value="">请选择</option>${Array.from({ length: group.items.length }, (_, rank) => `<option value="${rank + 1}">${rank + 1}</option>`).join('')}</select></label></article>`
    }).join('\n')}
  </div>
  ${notes ? `<label class="group-note-label">${escapeHtml(notes.label)}<textarea class="group-note" data-group="${escapeHtml(group.id)}" placeholder="${escapeHtml(notes.placeholder)}" spellcheck="true"></textarea></label>` : ''}
</section>`
}
