/**
 * Screenshot driver for the preview host — dev only.
 *
 * Launches the Chrome already on this machine in headless mode with remote
 * debugging, drives it over the DevTools protocol with Node's built-in
 * WebSocket (no npm dependency, no downloaded browser), and writes PNGs into
 * `.preview/shots`. It exists because the thing worth looking at — a real
 * ComfyUI generation landing in the Studio panel — only happens after a click.
 *
 * Run after `node test/preview-run.mjs` is listening:
 *   node test/preview-shot.mjs
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
const PORT = Number(process.env.PREVIEW_CDP_PORT ?? 9333)
const profile = mkdtempSync(join(tmpdir(), 'forge-preview-'))

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1440,1500',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    PAGE,
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One DevTools protocol connection. */
async function connect() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((row) => row.type === 'page' && row.webSocketDebuggerUrl)
      if (page !== undefined) return { ws: new WebSocket(page.webSocketDebuggerUrl), id: page.id }
    } catch {
      // The daemon is still coming up.
    }
    await sleep(500)
  }
  throw new Error('Chrome did not expose a debuggable page')
}

const { ws } = await connect()
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

/** Evaluate an expression in the page and return its value. */
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'page threw')
  return result.result?.value
}

/** Poll an expression until it is truthy. */
async function until(expression, timeoutMs, label) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(expression)) return
    await sleep(400)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function shot(name) {
  const metrics = await send('Page.getLayoutMetrics')
  const size = metrics.cssContentSize ?? metrics.contentSize
  const width = Math.min(1440, Math.ceil(size.width))
  const height = Math.min(2200, Math.ceil(size.height))
  const result = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  })
  const path = join(SHOTS, `${name}.png`)
  writeFileSync(path, Buffer.from(result.data, 'base64'))
  console.log('shot', name, `${width}x${height}`)
}

/** Click the first button whose text is exactly `label`. */
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
  await until("document.querySelector('.dsh-image-forge-tabs') !== null", 30_000, 'the settings section')
  await sleep(1200)
  await shot('01-studio-empty')

  const status = await evaluate(`(() => {
    const dot = document.querySelector('.dsh-forge-dot')
    const endpoint = document.querySelector('.dsh-forge-studio-endpoint')
    return { dot: dot ? dot.className : null, endpoint: endpoint ? endpoint.textContent : null }
  })()`)
  console.log('studio status', JSON.stringify(status))

  // The button is gated on a non-empty prompt (`canGenerate`), so fill the
  // textarea the way a user's keystrokes would reach React: native value setter
  // plus a bubbling input event.
  await evaluate(`(() => {
    const box = document.querySelector('.dsh-forge-textarea')
    if (!box) return false
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(box, '一只橘猫坐在朝西的窗台上，午后侧光穿过纱帘，浅景深，暖色木地板，画面安静克制。')
    box.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await until("document.querySelector('.dsh-forge-btn.is-primary').disabled === false", 10_000, 'the button to enable')
  if (!(await clickByText('生成'))) throw new Error('generate button not found')
  await until("document.querySelectorAll('.dsh-forge-node img').length > 0", 180_000, 'a generated image')
  await sleep(1500)
  await shot('02-studio-result')

  await clickByText('出图')
  await sleep(500)
  await shot('03-tab-generate')
  await clickByText('ComfyUI')
  await sleep(500)
  await shot('04-tab-comfyui')
  await clickByText('图像工作台')
  await sleep(400)

  await clickByText('跑一次文生图')
  await until("document.querySelectorAll('.dsh-image-forge-row').length > 0", 180_000, 'the generate card')
  await sleep(1200)
  await shot('05-card-generate')

  await clickByText('跑一次状态')
  await until("document.querySelectorAll('.dsh-image-forge-row').length > 1", 120_000, 'the status card')
  await sleep(800)
  await shot('06-card-status')

  await clickByText('跑一次改图')
  await until("document.querySelectorAll('.dsh-image-forge-row').length > 2", 240_000, 'the edit card')
  await sleep(1200)
  await shot('07-card-edit')

  const log = await evaluate("document.getElementById('log').textContent")
  console.log('page log:', log)
} finally {
  try {
    ws.close()
  } catch {
    // Already closed.
  }
  chrome.kill()
}
