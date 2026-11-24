/**
 * Browser proof for the real conversation result card — dev only.
 *
 * Run after `node test/dev/preview/run.mjs`:
 *   node test/dev/preview/result-card-shot.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const OUT = resolve(ROOT, 'verify', 'qa-20261124')
mkdirSync(OUT, { recursive: true })
const PAGE_URL = (process.env.PREVIEW_URL ?? 'http://127.0.0.1:8390/').replace(/\/?$/, '/result-card')
const CDP_PORT = Number(process.env.PREVIEW_CDP_PORT ?? 9341)
const VIEWPORT = { width: 720, height: 820 }
const BROWSERS = [
  process.env.PREVIEW_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter((candidate) => typeof candidate === 'string' && existsSync(candidate))
if (BROWSERS.length === 0) throw new Error('no Chrome/Edge found')
const profile = mkdtempSync(join(tmpdir(), 'forge-result-'))
const browser = spawn(BROWSERS[0], [
  '--headless=new',
  `--remote-debugging-port=${String(CDP_PORT)}`,
  `--user-data-dir=${profile}`,
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--force-device-scale-factor=1',
  'about:blank',
], { stdio: 'ignore' })
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
async function connect() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const rows = await (await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json/list`)).json()
      const page = rows.find((row) => row.type === 'page' && row.webSocketDebuggerUrl)
      if (page !== undefined) return page.webSocketDebuggerUrl
    } catch { /* starting */ }
    await sleep(350)
  }
  throw new Error('browser did not expose a page')
}
const ws = new WebSocket(await connect())
await new Promise((done, fail) => {
  ws.addEventListener('open', done, { once: true })
  ws.addEventListener('error', fail, { once: true })
})
let nextId = 1
const pending = new Map()
const errors = []
const failedRequests = []
ws.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  if (message.id !== undefined) {
    const waiter = pending.get(message.id)
    if (waiter === undefined) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
    return
  }
  if (message.method === 'Runtime.consoleAPICalled' && ['error', 'assert', 'warning'].includes(message.params.type)) {
    errors.push(`${message.params.type}: ${message.params.args.map((arg) => typeof arg.value === 'string' ? arg.value : arg.description ?? arg.type).join(' ')}`)
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(`exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`)
  if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) failedRequests.push(`HTTP ${String(message.params.response.status)} ${message.params.response.url}`)
})
function send(method, params = {}) {
  const id = nextId++
  return new Promise((done, fail) => {
    pending.set(id, { resolve: done, reject: fail })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result?.value
}
async function until(expression, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(expression)) return
    await sleep(180)
  }
  throw new Error(`timed out waiting for ${label}`)
}
const report = { url: PAGE_URL, viewport: VIEWPORT, deviceScaleFactor: 1, consoleErrors: errors, failedRequests }
try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: PAGE_URL })
  await until('window.__pvResult && window.__pvResult.mounted === true', 30_000, 'the tool result card')
  await until("[...document.querySelectorAll('.dsh-image-forge-result-card img')].every((img) => img.complete && img.naturalWidth > 0)", 20_000, 'result images')
  await sleep(500)
  const initial = await evaluate(`(() => ({
    cards: document.querySelectorAll('.dsh-image-forge-result-card').length,
    imageCount: document.querySelector('.dsh-image-forge-result-card')?.dataset.imageCount,
    thumbs: document.querySelectorAll('.dsh-image-forge-result-thumb').length,
    selected: document.querySelector('.dsh-image-forge-result-thumb.is-active img')?.getAttribute('alt'),
    heroSrc: document.querySelector('.dsh-image-forge-result-open img')?.getAttribute('src'),
    heroAlt: document.querySelector('.dsh-image-forge-result-open img')?.getAttribute('alt'),
    heroHeight: document.querySelector('.dsh-image-forge-result-hero')?.getBoundingClientRect().height,
    hasMarkdownDuplicate: document.querySelector('.dsh-image-forge-result-card').textContent.includes('fixture.png'),
    primary: document.querySelector('.dsh-image-forge-result-primary')?.textContent
  }))()`)
  report.initial = initial
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height, scale: 1 } })
  report.screenshot = join(OUT, 'final-result-card-720-light.png')
  writeFileSync(report.screenshot, Buffer.from(shot.data, 'base64'))

  await evaluate("document.querySelectorAll('.dsh-image-forge-result-thumb')[1].click()")
  await sleep(250)
  report.afterThumb = await evaluate(`(() => ({
    selected: document.querySelector('.dsh-image-forge-result-thumb.is-active img')?.getAttribute('alt'),
    heroSrc: document.querySelector('.dsh-image-forge-result-open img')?.getAttribute('src'),
    badge: document.querySelector('.dsh-image-forge-result-variant')?.textContent,
    heroHeight: document.querySelector('.dsh-image-forge-result-hero')?.getBoundingClientRect().height,
    imageCount: document.querySelector('.dsh-image-forge-result-card')?.dataset.imageCount
  }))()`)
  await evaluate("document.querySelector('.dsh-image-forge-result-open').click()")
  await sleep(100)
  report.opened = await evaluate('window.__pvResult.opened')
  report.consoleErrors = errors
  report.failedRequests = failedRequests
  report.heroStable = report.initial.heroHeight === report.afterThumb.heroHeight
  report.ok = report.initial.cards === 1 && report.initial.imageCount === '2' && report.initial.thumbs === 2 && report.initial.hasMarkdownDuplicate === false && report.heroStable === true && report.opened.length === 1 && report.opened[0].seed.meta.itemId === 'node-tall'
} catch (error) {
  report.ok = false
  report.failure = error instanceof Error ? error.message : String(error)
} finally {
  writeFileSync(join(OUT, 'result-card-report.json'), JSON.stringify(report, null, 2))
  console.log('report', join(OUT, 'result-card-report.json'))
  try { ws.close() } catch { /* already closed */ }
  browser.kill()
  if (report.ok !== true) process.exitCode = 1
}
