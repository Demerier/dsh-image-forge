/**
 * Screenshot driver for the **board layer** — dev only.
 *
 * The generation driver (`preview-shot.mjs`) proves the draw path; this one is
 * about the unit above it: the board bar, the asset page and a board switch.
 * It generates nothing, so it finishes in seconds and can be rerun while
 * iterating on the panel.
 *
 * Run after `node test/preview-run.mjs` is listening:
 *   node test/preview-boards-shot.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SHOTS = join(HERE, '..', '.preview', 'shots')
mkdirSync(SHOTS, { recursive: true })

const CHROME = process.env.PREVIEW_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PAGE = process.env.PREVIEW_URL ?? 'http://127.0.0.1:8390/'
const PORT = Number(process.env.PREVIEW_CDP_PORT ?? 9334)
const profile = mkdtempSync(join(tmpdir(), 'forge-boards-'))

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1440,1400',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    PAGE,
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function connect() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((row) => row.type === 'page' && row.webSocketDebuggerUrl)
      if (page !== undefined) return page.webSocketDebuggerUrl
    } catch {
      // Still starting.
    }
    await sleep(400)
  }
  throw new Error('Chrome did not expose a debuggable page')
}

const ws = new WebSocket(await connect())
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
ws.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  const waiter = pending.get(message.id)
  if (waiter === undefined) return
  pending.delete(message.id)
  if (message.error) waiter.reject(new Error(message.error.message))
  else waiter.resolve(message.result)
})

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'page threw')
  return result.result?.value
}

async function until(expression, timeoutMs, label) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(expression)) return
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function shot(name) {
  const metrics = await send('Page.getLayoutMetrics')
  const size = metrics.cssContentSize ?? metrics.contentSize
  const width = Math.min(1440, Math.ceil(size.width))
  const height = Math.min(2000, Math.ceil(size.height))
  const result = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  })
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(result.data, 'base64'))
  console.log('shot', name, `${width}x${height}`)
}

function clickByText(label) {
  return evaluate(`(() => {
    const hit = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})
    if (!hit) return false
    hit.click()
    return true
  })()`)
}

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await until("document.querySelector('.dsh-forge-board-bar') !== null", 30_000, 'the board bar')

  const state = await evaluate(`(() => {
    const select = document.querySelector('.dsh-forge-board-select')
    return {
      boards: select ? [...select.options].map((o) => o.textContent) : [],
      current: select ? select.value : null,
      nodes: document.querySelectorAll('.dsh-forge-node').length,
      count: document.querySelector('.dsh-forge-board-count')?.textContent ?? null,
    }
  })()`)
  console.log('board state', JSON.stringify(state))
  await sleep(600)
  await shot('08-board-bar')

  if (!(await clickByText('素材'))) throw new Error('assets tab not found')
  await until("document.querySelector('.dsh-forge-assets-grid, .dsh-forge-studio-empty') !== null", 15_000, 'the asset page')
  await sleep(700)
  await shot('09-assets')

  const switched = await evaluate(`(() => {
    const select = document.querySelector('.dsh-forge-board-select')
    if (!select) return null
    const target = [...select.options].find((o) => o.textContent.includes('画板联调'))
    if (!target) return null
    const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    set.call(select, target.value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return target.value
  })()`)
  if (switched === null) throw new Error('target board not found')
  // Nodes only exist in the canvas view, so switch first, then wait.
  if (!(await clickByText('画布'))) throw new Error('canvas tab not found')
  await until("document.querySelectorAll('.dsh-forge-node').length > 0", 15_000, 'the other board to render')
  await sleep(900)
  await shot('10-board-switch')

  if (!(await clickByText('重命名'))) throw new Error('rename button not found')
  await sleep(400)
  await shot('11-rename')

  const after = await evaluate(`(() => {
    const select = document.querySelector('.dsh-forge-board-select')
    return {
      current: select ? select.value : null,
      nodes: document.querySelectorAll('.dsh-forge-node').length,
      count: document.querySelector('.dsh-forge-board-count')?.textContent ?? null,
      footer: document.querySelector('.dsh-forge-canvas-foot')?.textContent ?? null,
    }
  })()`)
  console.log('after switch', JSON.stringify(after))
} finally {
  try {
    ws.close()
  } catch {
    // Already closed.
  }
  chrome.kill()
}
