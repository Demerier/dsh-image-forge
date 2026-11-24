/**
 * Browser proof for the optional Better Sidebar tab — dev only.
 *
 * The preview host mounts the descriptor that the real `lib/client.js` registers
 * with `betterSidebar.registerTab`. This driver then exercises the tab without
 * touching ComfyUI or a real DSH profile:
 *
 * - adds three normalized annotations by clicking the picture;
 * - edits their copy through React's controlled textareas;
 * - drags one pin and records its before/after position;
 * - gates the handoff while the main composer has a draft;
 * - submits the annotated preview through the fake conversation service and
 *   checks that annotations clear only after acceptance;
 * - switches to the persisted MOSS layout and saves it through the real
 *   `save-layout-node` route.
 *
 * Run after `node test/dev/preview/run.mjs`:
 *   node test/dev/preview/sidebar-shot.mjs
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

const PAGE_URL = (process.env.PREVIEW_URL ?? 'http://127.0.0.1:8390/').replace(/\/?$/, '/sidebar')
const CDP_PORT = Number(process.env.PREVIEW_CDP_PORT ?? 9340)
const VIEWPORT = { width: 420, height: 1024 }
const CANDIDATES = [
  process.env.PREVIEW_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter((candidate) => typeof candidate === 'string' && existsSync(candidate))

if (CANDIDATES.length === 0) {
  console.error('no Chrome/Edge executable found; set PREVIEW_CHROME')
  process.exit(2)
}

const profile = mkdtempSync(join(tmpdir(), 'forge-sidebar-'))
const browser = spawn(CANDIDATES[0], [
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
    const text = message.params.args.map((arg) => typeof arg.value === 'string' ? arg.value : arg.description ?? arg.type).join(' ')
    consoleErrors.push(`${message.params.type}: ${text}`)
  }
  if (message.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(`exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`)
  }
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    consoleErrors.push(`log(${message.params.entry.source}): ${message.params.entry.text}`)
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

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result?.value
}

async function until(expression, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(expression)) return
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function shot(name) {
  const result = await send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height, scale: 1 },
  })
  const path = join(OUT, `${name}.png`)
  writeFileSync(path, Buffer.from(result.data, 'base64'))
  return path
}

async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}

const report = {
  url: PAGE_URL,
  startedAt: new Date().toISOString(),
  viewport: VIEWPORT,
  deviceScaleFactor: 1,
  interactions: {},
  consoleErrors,
  failedRequests,
}

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Network.enable')
  await send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: PAGE_URL })
  await until('window.__pvSidebar && window.__pvSidebar.mounted === true', 35_000, 'the registered Better Sidebar tab')
  await until("(() => { const img = document.querySelector('.dsh-image-forge-sidebar-image img'); return img && img.complete && img.naturalWidth > 0; })()", 20_000, 'the sidebar source image')
  await until("document.querySelector('.dsh-image-forge-sidebar-primary') !== null", 10_000, 'annotation commit action')

  const modal = await evaluate(`(() => {
    const service = window.__pvSidebar;
    return {
      registeredIds: service.tabs.map((tab) => tab.id),
      descriptorTitle: service.descriptor.title,
      meta: service.meta,
      conversationAvailable: service.conversation !== undefined,
      rootClass: document.querySelector('.dsh-image-forge-sidebar-editor')?.className,
      frame: document.querySelector('.dsh-image-forge-sidebar-image')?.getBoundingClientRect().toJSON(),
    };
  })()`)
  report.registration = modal

  const frame = modal.frame
  const points = [
    [frame.left + frame.width * 0.60, frame.top + frame.height * 0.24],
    [frame.left + frame.width * 0.77, frame.top + frame.height * 0.50],
    [frame.left + frame.width * 0.47, frame.top + frame.height * 0.66],
  ]
  for (let index = 0; index < points.length; index += 1) {
    await click(points[index][0], points[index][1])
    await until(`document.querySelectorAll('.dsh-image-forge-sidebar-pin').length === ${String(index + 1)}`, 6_000, `annotation ${String(index + 1)}`)
  }

  const texts = ['外套换成半透明琥珀色，保留褶皱。', '蓝色轮廓光向右后方偏移。', '背景雨丝更细，降低高光。']
  for (let index = 0; index < texts.length; index += 1) {
    await evaluate(`(() => {
      const area = document.querySelectorAll('.dsh-image-forge-sidebar-annotation textarea')[${String(index)}];
      if (!area) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(area, ${JSON.stringify(texts[index])});
      area.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    await sleep(120)
  }

  const beforeDrag = await evaluate(`(() => {
    const pin = document.querySelector('.dsh-image-forge-sidebar-pin');
    const box = pin.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  })()`)
  const startX = beforeDrag.left + beforeDrag.width / 2
  const startY = beforeDrag.top + beforeDrag.height / 2
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: startY, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX + 34, y: startY + 18, button: 'left', buttons: 1 })
  await sleep(150)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: startX + 34, y: startY + 18, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(180)
  const afterDrag = await evaluate(`(() => {
    const pin = document.querySelector('.dsh-image-forge-sidebar-pin');
    const box = pin.getBoundingClientRect();
    return {
      left: box.left,
      top: box.top,
      annotations: document.querySelectorAll('.dsh-image-forge-sidebar-pin').length,
      texts: [...document.querySelectorAll('.dsh-image-forge-sidebar-annotation textarea')].map((area) => area.value),
      primaryText: document.querySelector('.dsh-image-forge-sidebar-primary')?.textContent,
      primaryDisabled: document.querySelector('.dsh-image-forge-sidebar-primary')?.disabled,
    };
  })()`)
  report.interactions.annotations = { beforeDrag, afterDrag, delta: { x: afterDrag.left - beforeDrag.left, y: afterDrag.top - beforeDrag.top } }
  report.annotationLayout = await evaluate(`(() => {
    const remove = document.querySelector('.dsh-image-forge-sidebar-pin-delete');
    const list = document.querySelector('.dsh-image-forge-sidebar-annotation-list');
    const commit = document.querySelector('.dsh-image-forge-sidebar-commit');
    const panel = document.querySelector('.dsh-image-forge-sidebar-panel');
    const removeBox = remove?.getBoundingClientRect();
    return {
      removeWidth: removeBox?.width ?? null,
      removeHeight: removeBox?.height ?? null,
      hasZoomButton: [...document.querySelectorAll('.dsh-image-forge-sidebar-tool')].some((node) => node.textContent.includes('放大')),
      panelOverflow: panel === null ? null : getComputedStyle(panel).overflow,
      listToCommit: list === null || commit === null ? null : commit.getBoundingClientRect().top - list.getBoundingClientRect().bottom,
    };
  })()`)

  await sleep(700)
  report.annotationShot = await shot('final-sidebar-annotation-420-light')

  // The gate must protect a non-empty main draft before the real submit path runs.
  await evaluate("window.__pvSidebar.setDraft('请先处理这段已有草稿')")
  await sleep(250)
  const blocked = await evaluate(`(() => ({
    disabled: document.querySelector('.dsh-image-forge-sidebar-primary')?.disabled,
    gate: document.querySelector('.dsh-image-forge-sidebar-gate')?.textContent ?? null,
    count: document.querySelectorAll('.dsh-image-forge-sidebar-pin').length
  }))()`)
  report.interactions.busyGate = blocked
  await evaluate("window.__pvSidebar.setDraft('')")
  await sleep(250)

  await evaluate("document.querySelector('.dsh-image-forge-sidebar-primary').click()")
  await until("document.querySelectorAll('.dsh-image-forge-sidebar-pin').length === 0", 20_000, 'annotations to clear after accepted handoff')
  const accepted = await evaluate(`(() => ({
    status: document.querySelector('.dsh-image-forge-sidebar-status')?.textContent ?? null,
    error: document.querySelector('.dsh-image-forge-sidebar-error')?.textContent ?? null,
    count: document.querySelectorAll('.dsh-image-forge-sidebar-pin').length
  }))()`)
  report.interactions.handoff = accepted

  await evaluate(`(() => {
    const tab = [...document.querySelectorAll('.dsh-image-forge-sidebar-tab')].find((node) => node.textContent.includes('MOSS 布局'));
    tab?.click();
    return tab !== undefined;
  })()`)
  await until("document.querySelector('.dsh-image-forge-sidebar-layout-canvas .dsh-image-forge-layout-editor') !== null", 20_000, 'the MOSS layout editor')
  await sleep(900)

  const layout = await evaluate(`(() => {
    const editor = document.querySelector('.dsh-image-forge-layout-editor');
    const host = document.querySelector('.dsh-image-forge-sidebar-layout-canvas .dsh-image-forge-layout-host');
    const stage = document.querySelector('.dsh-image-forge-layout-stage');
    const frame = document.querySelector('.dsh-image-forge-layout-frame');
    const canvas = document.querySelector('.dsh-image-forge-layout-canvas');
    return {
      mode: document.querySelector('.dsh-image-forge-sidebar-editor')?.dataset.mode,
      hostRect: host?.getBoundingClientRect().toJSON(),
      stageRect: stage?.getBoundingClientRect().toJSON(),
      frameRect: frame?.getBoundingClientRect().toJSON(),
      canvasRect: canvas?.getBoundingClientRect().toJSON(),
      frameBadge: document.querySelector('.dsh-image-forge-layout-frame-badge')?.textContent ?? null,
      hasBackground: [...document.querySelectorAll('.dsh-image-forge-sidebar-layout-canvas .dsh-image-forge-layout-host img, .dsh-image-forge-sidebar-layout-canvas .dsh-image-forge-layout-host canvas')].map((node) => node.tagName),
      boxes: document.querySelectorAll('.dsh-image-forge-layout-canvas [data-box-id]:not([data-handle])').length,
      railSections: document.querySelectorAll('.dsh-image-forge-sidebar-layout-section').length,
      hints: [...document.querySelectorAll('.dsh-image-forge-sidebar-hint')].map((node) => node.textContent),
      saveDisabled: [...document.querySelectorAll('.dsh-image-forge-sidebar-copy')].find((node) => node.textContent === '保存布局')?.disabled,
      editorClass: editor?.className,
      editorParentClass: editor?.parentElement?.className,
      editorGrandparentClass: editor?.parentElement?.parentElement?.className,
      editorParentRect: editor?.parentElement?.getBoundingClientRect().toJSON(),
      stageComputedHeight: stage === null ? null : getComputedStyle(stage).height,
      stageDisplay: stage === null ? null : getComputedStyle(stage).display,
    };
  })()`)
  report.layout = layout
  report.layoutShot = await shot('final-sidebar-moss-420-light')
  await evaluate(`(() => {
    const box = document.querySelector('.dsh-image-forge-layout-canvas [data-box-id]:not([data-handle])');
    const rect = box?.getBoundingClientRect();
    box?.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: (rect?.left ?? 0) + 20,
      clientY: (rect?.top ?? 0) + 20,
    }));
  })()`)
  await until("document.querySelector('.dsh-image-forge-sidebar-box-float') !== null", 10_000, 'sidebar box property float')
  report.layoutBoxFloat = await evaluate(`(() => ({
    fields: [...document.querySelectorAll('.dsh-image-forge-sidebar-box-float .dsh-forge-label')].map((node) => node.textContent),
    hasCanvas: document.querySelector('.dsh-image-forge-sidebar-box-float .dsh-image-forge-layout-canvas') !== null,
    width: document.querySelector('.dsh-image-forge-sidebar-box-float')?.getBoundingClientRect().width,
  }))()`)
  report.layoutBoxShot = await shot('final-sidebar-moss-box-420-light')
  await evaluate("document.querySelector('.dsh-image-forge-sidebar-box-close')?.click()")

  await evaluate(`(() => {
    const save = [...document.querySelectorAll('.dsh-image-forge-sidebar-copy')].find((node) => node.textContent === '保存布局');
    save?.click();
    return save !== undefined;
  })()`)
  await until("document.querySelector('.dsh-image-forge-sidebar-status')?.textContent.includes('布局已保存')", 20_000, 'layout save confirmation')
  report.interactions.layoutSave = await evaluate("document.querySelector('.dsh-image-forge-sidebar-status')?.textContent")

  report.finalState = await evaluate(`(() => ({
    mode: document.querySelector('.dsh-image-forge-sidebar-editor')?.dataset.mode,
    pageErrors: window.__pv && window.__pv.errors ? window.__pv.errors : [],
    overflow: {
      body: { scrollWidth: document.body.scrollWidth, clientWidth: document.body.clientWidth },
      panel: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }
    }
  }))()`)
  // The same component under the host's dark color scheme. This is a compact
  // two-annotation pass, enough to pin contrast, focus surfaces and the canvas.
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await send('Page.navigate', { url: PAGE_URL })
  await until('window.__pvSidebar && window.__pvSidebar.mounted === true', 35_000, 'dark sidebar tab')
  await until("(() => { const img = document.querySelector('.dsh-image-forge-sidebar-image img'); return img && img.complete && img.naturalWidth > 0; })()", 20_000, 'dark source image')
  const darkFrame = await evaluate("document.querySelector('.dsh-image-forge-sidebar-image')?.getBoundingClientRect().toJSON()")
  const darkPoints = [
    [darkFrame.left + darkFrame.width * 0.62, darkFrame.top + darkFrame.height * 0.34],
    [darkFrame.left + darkFrame.width * 0.79, darkFrame.top + darkFrame.height * 0.57],
  ]
  for (let index = 0; index < darkPoints.length; index += 1) {
    await click(darkPoints[index][0], darkPoints[index][1])
    await until(`document.querySelectorAll('.dsh-image-forge-sidebar-pin').length === ${String(index + 1)}`, 6_000, `dark annotation ${String(index + 1)}`)
  }
  const darkTexts = ['左上轮廓光收紧。', '右下背景压暗，保留雨丝。']
  for (let index = 0; index < darkTexts.length; index += 1) {
    await evaluate(`(() => {
      const area = document.querySelectorAll('.dsh-image-forge-sidebar-annotation textarea')[${String(index)}];
      if (!area) return false;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, ${JSON.stringify(darkTexts[index])});
      area.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    await sleep(100)
  }
  await sleep(400)
  report.darkAnnotationShot = await shot('final-sidebar-annotation-420-dark')
  await evaluate(`(() => {
    const tab = [...document.querySelectorAll('.dsh-image-forge-sidebar-tab')].find((node) => node.textContent.includes('MOSS 布局'));
    tab?.click();
    return tab !== undefined;
  })()`)
  await until("document.querySelector('.dsh-image-forge-sidebar-layout-canvas .dsh-image-forge-layout-editor') !== null", 20_000, 'dark MOSS editor')
  await sleep(700)
  report.darkLayout = await evaluate(`(() => ({
    mode: document.querySelector('.dsh-image-forge-sidebar-editor')?.dataset.mode,
    colorScheme: getComputedStyle(document.querySelector('.dsh-image-forge-sidebar-editor')).colorScheme,
    editorTheme: document.querySelector('.dsh-image-forge-layout-editor')?.dataset.theme ?? 'auto'
  }))()`)
  report.darkLayoutShot = await shot('final-sidebar-moss-420-dark')

  report.ok = report.layoutBoxFloat?.fields?.includes('框类型') === true && report.layoutBoxFloat?.hasCanvas === false && report.annotationLayout?.hasZoomButton === false && (report.annotationLayout?.removeWidth ?? 99) <= 24 && (report.annotationLayout?.removeHeight ?? 99) <= 24 && report.layout?.frameBadge === '1024 × 1024 · 1:1' && (report.layout?.frameRect?.width ?? 0) > 100 && report.layout?.boxes === 2 && report.layout?.railSections === 7
} catch (error) {
  report.ok = false
  report.failure = error instanceof Error ? error.message : String(error)
  console.error('FAILED:', report.failure)
} finally {
  report.consoleErrors = consoleErrors
  report.failedRequests = failedRequests
  report.finishedAt = new Date().toISOString()
  writeFileSync(join(OUT, 'sidebar-report.json'), JSON.stringify(report, null, 2))
  console.log('report', join(OUT, 'sidebar-report.json'))
  try { ws.close() } catch { /* already closed */ }
  browser.kill()
  if (report.ok !== true) process.exitCode = 1
}
