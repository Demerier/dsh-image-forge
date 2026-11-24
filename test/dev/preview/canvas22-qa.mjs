/** Browser QA for the Canvas 2.2 interaction surfaces. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const OUT = resolve(ROOT, 'verify', 'qa-20261124')
mkdirSync(OUT, { recursive: true })
const PAGE_URL = (process.env.PREVIEW_URL ?? 'http://127.0.0.1:8390/').replace(/\/?$/, '/')
const PORT = Number(process.env.PREVIEW_CDP_PORT ?? 9345)
const VIEWPORT = { width: 1500, height: 1000 }
const BROWSERS = [
  process.env.PREVIEW_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter((path) => typeof path === 'string' && existsSync(path))
if (BROWSERS.length === 0) throw new Error('no Chrome/Edge executable found; set PREVIEW_CHROME')

const profile = mkdtempSync(join(tmpdir(), 'forge-canvas22-'))
const browser = spawn(BROWSERS[0], [
  '--headless=new',
  `--remote-debugging-port=${String(PORT)}`,
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
      const rows = await (await fetch(`http://127.0.0.1:${String(PORT)}/json/list`)).json()
      const page = rows.find((row) => row.type === 'page' && row.webSocketDebuggerUrl)
      if (page !== undefined) return page.webSocketDebuggerUrl
    } catch { /* browser is still starting */ }
    await sleep(350)
  }
  throw new Error('browser did not expose a debuggable page')
}

const ws = new WebSocket(await connect())
await new Promise((done, fail) => {
  ws.addEventListener('open', done, { once: true })
  ws.addEventListener('error', fail, { once: true })
})
let nextId = 1
const pending = new Map()
const consoleErrors = []
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
    consoleErrors.push(`${message.params.type}: ${message.params.args.map((arg) => typeof arg.value === 'string' ? arg.value : arg.description ?? arg.type).join(' ')}`)
  }
  if (message.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(`exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`)
  }
  if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) {
    failedRequests.push(`HTTP ${String(message.params.response.status)} ${message.params.response.url}`)
  }
})
function send(method, params = {}) {
  const id = nextId++
  return new Promise((done, fail) => {
    pending.set(id, { resolve: done, reject: fail })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function ev(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result?.value
}
async function until(expression, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await ev(expression)) return
    await sleep(180)
  }
  throw new Error(`timeout: ${label}`)
}
async function shot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height, scale: 1 } })
  const path = join(OUT, `${name}.png`)
  writeFileSync(path, Buffer.from(result.data, 'base64'))
  return path
}
async function clickPoint(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}

const report = { url: PAGE_URL, viewport: VIEWPORT, deviceScaleFactor: 1 }
try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: PAGE_URL })
  await until('window.__pv && window.__pv.mounted === true', 40_000, 'workbench')
  await ev('window.__pv.activateCanvas()')
  await until("document.querySelectorAll('[data-node-id]').length >= 8", 30_000, 'canvas nodes')
  await sleep(700)

  const dock = await ev("document.querySelector('.dsh-forge-canvas-tool-dock')?.getBoundingClientRect().toJSON()")
  report.toolDock = {
    collapsedWidth: dock?.width ?? 0,
    collapsedLabelOpacity: await ev("getComputedStyle(document.querySelector('.dsh-forge-canvas-tool-label')).opacity"),
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dock.left + dock.width / 2, y: dock.top + 20 })
  await sleep(260)
  report.toolDock.expandedWidth = await ev("document.querySelector('.dsh-forge-canvas-tool-dock')?.getBoundingClientRect().width")
  report.toolDock.expandedLabelOpacity = await ev("getComputedStyle(document.querySelector('.dsh-forge-canvas-tool-label')).opacity")
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dock.left + 120, y: dock.top + 20 })
  await sleep(220)
  report.toolDock.widthInsideExpanded = await ev("document.querySelector('.dsh-forge-canvas-tool-dock')?.getBoundingClientRect().width")
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dock.left + 176, y: dock.top + 20 })
  await sleep(40)
  report.toolDock.closingPointerEvents = await ev("getComputedStyle(document.querySelector('.dsh-forge-canvas-tool-dock')).pointerEvents")
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dock.left + 120, y: dock.top + 20 })
  await sleep(240)
  report.toolDock.reenteredDuringCloseWidth = await ev("document.querySelector('.dsh-forge-canvas-tool-dock')?.getBoundingClientRect().width")
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 500 })
  await sleep(30)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dock.left + 20, y: dock.top + 20 })
  await sleep(260)
  report.toolDock.reopenedWidth = await ev("document.querySelector('.dsh-forge-canvas-tool-dock')?.getBoundingClientRect().width")
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 500 })
  await sleep(430)
  report.toolDock.closedWidth = await ev("document.querySelector('.dsh-forge-canvas-tool-dock')?.getBoundingClientRect().width")
  report.nodeCursors = await ev(`(() => {
    const wrapper = document.querySelector('.react-flow__node.draggable')
    const inner = wrapper?.querySelector('.dsh-forge-flow-node')
    return { wrapper: wrapper ? getComputedStyle(wrapper).cursor : null, inner: inner ? getComputedStyle(inner).cursor : null }
  })()`)

  report.header = await ev(`(() => ({
    modes: [...document.querySelectorAll('.dsh-forge-workspace-mode-bar .dsh-forge-view-item')].map((node) => node.textContent),
    modeBarTop: document.querySelector('.dsh-forge-workspace-mode-bar')?.getBoundingClientRect().top,
    environment: document.querySelector('.dsh-forge-environment-trigger')?.textContent,
  }))()`)
  report.canvasShot = await shot('canvas22-canvas')

  const beforeNodes = await ev("document.querySelectorAll('[data-node-id]').length")
  for (let count = 0; count < 2; count += 1) {
    await ev("document.querySelector('button[aria-label=\"新建生成节点\"]')?.click()")
    await until(`document.querySelectorAll('[data-node-id]').length === ${beforeNodes + count + 1}`, 10_000, `new node ${count + 1}`)
  }
  await until("document.querySelector('.dsh-forge-flow-node.is-created-focus') !== null", 2_000, 'creation highlight').catch(() => {})
  report.createNode = await ev(`(() => ({
    count: document.querySelectorAll('[data-node-id]').length,
    selected: document.querySelectorAll('.dsh-forge-flow-node.is-selected').length,
    historyLabel: document.querySelector('.dsh-forge-history-trigger')?.textContent,
  }))()`)

  await ev("document.querySelector('.dsh-forge-history-trigger')?.click()")
  await until("document.querySelector('.dsh-forge-history-popover') !== null", 8_000, 'history popover')
  report.history = await ev(`(() => ({
    head: document.querySelector('.dsh-forge-history-head')?.textContent,
    entries: [...document.querySelectorAll('.dsh-forge-history-item')].map((node) => ({ text: node.textContent, current: node.classList.contains('is-current') })),
    latest: document.querySelector('.dsh-forge-history-latest')?.textContent ?? null,
  }))()`)
  const afterCreate = await ev("document.querySelectorAll('[data-node-id]').length")
  await ev("document.querySelector('.dsh-forge-history-item.is-applied:not(.is-current)')?.click()")
  await until(`document.querySelectorAll('[data-node-id]').length === ${afterCreate - 1}`, 8_000, 'history step jump')
  report.history.jumpedCount = await ev("document.querySelectorAll('[data-node-id]').length")
  await ev("document.querySelector('.dsh-forge-history-latest')?.click()")
  await until(`document.querySelectorAll('[data-node-id]').length === ${afterCreate}`, 8_000, 'history latest jump')
  report.history.latestCount = await ev("document.querySelectorAll('[data-node-id]').length")
  await shot('canvas22-history')
  await ev("document.querySelector('.dsh-forge-history-trigger')?.click()")

  await ev("document.querySelector('.dsh-forge-environment-trigger')?.click()")
  await until("document.querySelector('.dsh-forge-environment-popover') !== null", 8_000, 'environment popover')
  report.environment = await ev(`(() => ({
    text: document.querySelector('.dsh-forge-environment-popover')?.textContent,
    hasDialog: document.querySelector('.dsh-forge-environment-popover')?.getAttribute('role') === 'dialog',
    actions: [...document.querySelectorAll('.dsh-forge-environment-actions button')].map((node) => node.textContent),
  }))()`)
  await shot('canvas22-environment')
  await ev("document.querySelector('.dsh-forge-environment-trigger')?.click()")

  await ev(`(() => {
    const node = document.querySelector('[data-node-id="node-wide"]')
    node?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 700, clientY: 300 }))
    node?.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 700, clientY: 300 }))
  })()`)
  await until("document.querySelector('.dsh-forge-context-panel') !== null", 10_000, 'context panel')
  report.contextPanel = await ev(`(() => ({
    width: document.querySelector('.dsh-forge-context-panel')?.getBoundingClientRect().width,
    bodyScroll: document.querySelector('.dsh-forge-context-panel .dsh-forge-inspector-body')?.scrollHeight,
    bodyClient: document.querySelector('.dsh-forge-context-panel .dsh-forge-inspector-body')?.clientHeight,
  }))()`)

  await ev(`(() => {
    const button = [...document.querySelectorAll('.dsh-forge-view-item')].find((node) => node.textContent.trim() === '画廊')
    button?.click()
  })()`)
  await until("document.querySelector('.dsh-forge-studio-body.is-gallery') !== null", 10_000, 'gallery')
  report.gallery = await ev(`(() => ({
    form: document.querySelector('.dsh-forge-studio-form') !== null,
    scope: [...document.querySelectorAll('.dsh-forge-gallery-scope-item')].map((node) => node.textContent),
    modeBarTop: document.querySelector('.dsh-forge-workspace-mode-bar')?.getBoundingClientRect().top,
  }))()`)
  report.modeBarStable = report.gallery.modeBarTop === report.header.modeBarTop
  await shot('canvas22-gallery')

  await ev(`(() => {
    const button = [...document.querySelectorAll('.dsh-forge-view-item')].find((node) => node.textContent.trim() === '画布')
    button?.click()
  })()`)
  await until("document.querySelector('[data-node-id=\"node-layout\"]') !== null", 15_000, 'layout node')
  await ev(`(() => {
    const node = document.querySelector('[data-node-id="node-layout"]')
    node?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 900, clientY: 720 }))
    node?.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 900, clientY: 720 }))
  })()`)
  await until("document.querySelector('.dsh-forge-context-panel') !== null", 10_000, 'layout summary')
  await ev("([...document.querySelectorAll('.dsh-forge-context-panel button')].find((node) => node.textContent.trim() === '打开详情'))?.click()")
  await until("document.querySelector('.dsh-forge-detail.is-layout .dsh-forge-layout-workspace') !== null", 20_000, 'layout detail')
  await sleep(800)
  report.layoutDetail = await ev(`(() => {
    const frame = document.querySelector('.dsh-image-forge-layout-frame');
    return {
      frameWidth: frame?.getBoundingClientRect().width,
      frameHeight: frame?.getBoundingClientRect().height,
      badge: document.querySelector('.dsh-image-forge-layout-frame-badge')?.textContent,
      boxRows: document.querySelectorAll('.dsh-forge-layout-box-row').length,
      boxSection: [...document.querySelectorAll('.dsh-forge-layout-rail-title')].map((node) => node.textContent).find((text) => text.includes('布局框')),
      visibleSchemaDump: document.body.textContent.includes('summary.caption'),
      canvasOnly: document.querySelector('.dsh-forge-layout-editor .dsh-forge-layout-item-row') === null,
    }
  })()`)
  report.layoutShot = await shot('canvas22-layout-detail')

  await ev(`(() => {
    const box = document.querySelector('.dsh-image-forge-layout-canvas [data-box-id]:not([data-handle])')
    const rect = box?.getBoundingClientRect()
    box?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: (rect?.left ?? 0) + 20, clientY: (rect?.top ?? 0) + 20 }))
  })()`)
  await until("document.querySelector('.dsh-forge-box-float') !== null", 10_000, 'box property float')
  report.boxFloat = await ev(`(() => ({
    fields: [...document.querySelectorAll('.dsh-forge-box-float .dsh-forge-label')].map((node) => node.textContent),
    hasCanvas: document.querySelector('.dsh-forge-box-float .dsh-image-forge-layout-canvas') !== null,
    left: document.querySelector('.dsh-forge-box-float')?.getBoundingClientRect().left,
    top: document.querySelector('.dsh-forge-box-float')?.getBoundingClientRect().top,
  }))()`)
  report.boxFloatShot = await shot('canvas22-box-float')

  report.ok = report.toolDock.collapsedWidth < 60
    && report.toolDock.expandedWidth > 100
    && report.toolDock.widthInsideExpanded === 158
    && report.toolDock.closingPointerEvents === 'none'
    && report.toolDock.reenteredDuringCloseWidth === 52
    && report.toolDock.reopenedWidth === 158
    && report.toolDock.closedWidth === 52
    && report.nodeCursors.wrapper === 'grab'
    && report.nodeCursors.inner === 'grab'
    && Number(report.toolDock.collapsedLabelOpacity) < 0.2
    && Number(report.toolDock.expandedLabelOpacity) > 0.8
    && report.history.jumpedCount === afterCreate - 1
    && report.history.latestCount === afterCreate
    && report.modeBarStable === true
    && report.layoutDetail.frameWidth > 100
    && report.layoutDetail.frameHeight > 100
    && report.layoutDetail.boxSection === '布局框（共 2 个）'
    && report.layoutDetail.visibleSchemaDump === false
    && report.contextPanel.bodyScroll === report.contextPanel.bodyClient
} catch (error) {
  report.ok = false
  report.failure = error instanceof Error ? error.message : String(error)
  console.error('FAILED', report.failure)
} finally {
  report.consoleErrors = consoleErrors
  report.failedRequests = failedRequests
  writeFileSync(join(OUT, 'canvas22-report.json'), JSON.stringify(report, null, 2))
  console.log('report', join(OUT, 'canvas22-report.json'))
  try { ws.close() } catch { /* already closed */ }
  browser.kill()
  if (report.ok !== true) process.exitCode = 1
}


