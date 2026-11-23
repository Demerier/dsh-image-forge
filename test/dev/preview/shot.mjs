/**
 * Screenshot + inspection driver for the workbench preview — dev only.
 *
 * Launches the Chrome already on this machine (headless, no download), drives it
 * over the DevTools protocol with Node's built-in WebSocket, and writes:
 *
 * - `verify/preview/01-projects.png` — the projects tab (the landing view)
 * - `verify/preview/02-canvas.png`   — the already-open canvas tab, React Flow
 * - `verify/preview/03-drawer.png`   — one node selected, property drawer open
 * - `verify/preview/report.json`     — the DOM facts behind those three shots
 *   (tab strip, cards, node boxes vs intrinsic image size, task badge, layout
 *   editor, drawer layout, console errors, failed requests)
 *
 * Run after `node test/dev/preview/run.mjs` is listening:
 *   node test/dev/preview/shot.mjs
 *
 * Env: PREVIEW_URL (default http://127.0.0.1:8390/), PREVIEW_CDP_PORT,
 * PREVIEW_CHROME (explicit browser path), PREVIEW_OUT (default verify/preview).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const OUT = process.env.PREVIEW_OUT ?? join(ROOT, 'verify', 'preview')
mkdirSync(OUT, { recursive: true })

const PAGE_URL = process.env.PREVIEW_URL ?? 'http://127.0.0.1:8390/'
const CDP_PORT = Number(process.env.PREVIEW_CDP_PORT ?? 9335)

/** Candidate browsers, in the order a Windows machine usually has them. */
const CANDIDATES = [
  process.env.PREVIEW_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter((path) => typeof path === 'string' && path.length > 0 && existsSync(path))

if (CANDIDATES.length === 0) {
  console.error('no Chrome/Edge found; set PREVIEW_CHROME to a browser executable')
  process.exit(2)
}

const profile = mkdtempSync(join(tmpdir(), 'forge-preview-'))
const chrome = spawn(
  CANDIDATES[0],
  [
    '--headless=new',
    `--remote-debugging-port=${String(CDP_PORT)}`,
    `--user-data-dir=${profile}`,
    '--window-size=1500,980',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--force-device-scale-factor=1',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Wait for a debuggable page target, then open one WebSocket to it. */
async function connect() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json/list`)).json()
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
await new Promise((done, fail) => {
  ws.addEventListener('open', done, { once: true })
  ws.addEventListener('error', fail, { once: true })
})

let nextId = 1
const pending = new Map()
/** Console errors / exceptions / failed requests, in arrival order. */
const errors = []
const failures = []

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
  if (message.method === 'Runtime.consoleAPICalled') {
    const type = message.params.type
    if (type !== 'error' && type !== 'assert' && type !== 'warning') return
    const text = message.params.args.map((arg) => (typeof arg.value === 'string' ? arg.value : arg.description ?? arg.type)).join(' ')
    errors.push(`${type}: ${text}`)
    return
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails
    errors.push(`exception: ${details.exception?.description ?? details.text}`)
    return
  }
  if (message.method === 'Log.entryAdded') {
    const entry = message.params.entry
    if (entry.level === 'error') errors.push(`log(${entry.source}): ${entry.text}`)
    return
  }
  if (message.method === 'Network.responseReceived') {
    const { response, type } = message.params
    if (response.status >= 400) failures.push(`HTTP ${String(response.status)} ${type} ${response.url.slice(0, 160)}`)
    return
  }
  if (message.method === 'Network.loadingFailed') {
    failures.push(`${message.params.type}: ${message.params.errorText}`)
  }
})

function send(method, params = {}) {
  const id = nextId++
  return new Promise((done, fail) => {
    pending.set(id, { resolve: done, reject: fail })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

/** Evaluate an expression in the page and return its JSON value. */
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

/** Poll an expression until it is truthy, or throw with what it saw last. */
async function until(expression, timeoutMs, label) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(expression)) return
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** One screenshot of the current viewport. */
async function shot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const path = join(OUT, `${name}.png`)
  writeFileSync(path, Buffer.from(result.data, 'base64'))
  console.log('shot', path)
  return path
}

/**
 * One screenshot of a single element, at 1 CSS pixel = 1 image pixel.
 *
 * The viewport shot answers "does the layout hold together"; this one answers
 * "is the picture inside the node cropped, and is the dot grid really drawn".
 */
async function shotOf(name, selector) {
  const rect = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (el === null) return null
    const box = el.getBoundingClientRect()
    return {
      x: Math.round(box.left + window.scrollX),
      y: Math.round(box.top + window.scrollY),
      width: Math.round(box.width),
      height: Math.round(box.height),
    }
  })()`)
  if (rect === null) throw new Error(`no element for ${selector}`)
  const result = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { ...rect, scale: 1 },
  })
  const path = join(OUT, `${name}.png`)
  writeFileSync(path, Buffer.from(result.data, 'base64'))
  console.log('shot', path, `${String(rect.width)}x${String(rect.height)}`)
  return { path, rect }
}

/** Click the centre of an element, the way a mouse would. */
async function clickElement(expression) {
  const point = await evaluate(`(() => {
    const el = ${expression}
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), w: Math.round(rect.width), h: Math.round(rect.height) }
  })()`)
  if (point === null) throw new Error(`element not found: ${expression}`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type,
      x: point.x,
      y: point.y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
    })
    await sleep(40)
  }
  return point
}

/** DOM facts for the projects tab. */
const PROBE_PROJECTS = `(() => {
  const tabs = [...document.querySelectorAll('.dsh-forge-workbench-tab')].map((tab) => ({
    key: tab.getAttribute('data-tab-key'),
    kind: tab.getAttribute('data-tab-kind'),
    label: (tab.querySelector('.dsh-forge-workbench-tab-label') || {}).textContent || '',
    active: tab.classList.contains('dsh-forge-workbench-tab-active'),
    close: tab.querySelector('.dsh-forge-workbench-tab-close') !== null,
  }));
  const cards = [...document.querySelectorAll('.dsh-forge-workbench-card')].map((card) => {
    const img = card.querySelector('.dsh-forge-workbench-cover img, img');
    return {
      title: (card.querySelector('.dsh-forge-workbench-card-title') || {}).textContent || '',
      meta: (card.querySelector('.dsh-forge-workbench-card-meta') || {}).textContent || '',
      time: (card.querySelector('.dsh-forge-workbench-card-time') || {}).textContent || '',
      size: (card.querySelector('.dsh-forge-workbench-card-size') || {}).textContent || '',
      cover: img ? { src: img.getAttribute('src'), naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight } : null,
      rect: (() => { const r = card.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })(),
    };
  });
  const grid = document.querySelector('.dsh-forge-workbench-grid');
  const env = document.querySelector('.dsh-forge-workbench-env-text');
  const toolbar = document.querySelector('.dsh-forge-workbench-toolbar');
  const controls = toolbar === null ? [] : [...toolbar.querySelectorAll('input, button, select')].map((el) => {
    const rect = el.getBoundingClientRect();
    return { tag: el.tagName.toLowerCase(), text: (el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 24), w: Math.round(rect.width), h: Math.round(rect.height) };
  });
  return {
    tabs,
    activeTabKey: (document.querySelector('.dsh-forge-workbench-tab-active') || {}).getAttribute
      ? document.querySelector('.dsh-forge-workbench-tab-active').getAttribute('data-tab-key')
      : null,
    cards,
    gridColumns: grid ? getComputedStyle(grid).gridTemplateColumns : null,
    toolbar: controls,
    env: env ? env.textContent : null,
    bodyOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  };
})()`

/** DOM facts for the canvas tab: nodes, edges, background, picture fit. */
const PROBE_CANVAS = `(() => {
  const root = document.querySelector('.react-flow');
  const shell = document.querySelector('.dsh-forge-canvas-shell');
  const backgroundNode = document.querySelector('.react-flow__background, .dsh-forge-flow-background');
  const panel = document.querySelector('.dsh-forge-workbench-panel');
  const nodes = [...document.querySelectorAll('[data-node-kind]')].map((node) => {
    const frame = node.closest('.react-flow__node') || node;
    const rect = frame.getBoundingClientRect();
    const img = node.querySelector('img.dsh-forge-flow-thumb');
    const bar = node.querySelector('.dsh-forge-flow-bar-fill');
    const badge = node.querySelector('.dsh-forge-flow-badge');
    const layoutHost = node.querySelector('.dsh-forge-flow-layout-host');
    const editor = node.querySelector('.dsh-image-forge-layout-editor');
    const layoutError = node.querySelector('.dsh-forge-flow-layout-error');
    const kind = node.getAttribute('data-node-kind');
    const fact = {
      id: node.getAttribute('data-node-id'),
      kind,
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      text: (node.textContent || '').slice(0, 90),
      frame: {
        w: Math.round(frame.getBoundingClientRect().width),
        h: Math.round(frame.getBoundingClientRect().height),
      },
    };
    if (img) {
      const imgRect = img.getBoundingClientRect();
      const naturalRatio = img.naturalHeight === 0 ? null : img.naturalWidth / img.naturalHeight;
      fact.image = {
        src: img.getAttribute('src'),
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        boxWidth: Math.round(imgRect.width),
        boxHeight: Math.round(imgRect.height),
        objectFit: getComputedStyle(img).objectFit,
        complete: img.complete,
        aspectDelta: naturalRatio === null || imgRect.height === 0
          ? null
          : Math.round(((imgRect.width / imgRect.height) / naturalRatio - 1) * 10000) / 10000,
      };
    }
    if (bar) {
      const barRect = bar.getBoundingClientRect();
      const track = bar.parentElement.getBoundingClientRect();
      fact.progress = {
        badge: badge ? badge.textContent : null,
        barPresent: true,
        fillRatio: track.width === 0 ? null : Math.round((barRect.width / track.width) * 100),
        visible: barRect.height > 0,
      };
    }
    if (layoutHost) {
      fact.layoutEditor = {
        hostChildren: layoutHost.children.length,
        mounted: editor !== null,
        editorClass: editor === null ? null : editor.className,
        boxes: node.querySelectorAll('[data-box]').length,
        handles: node.querySelectorAll('[data-handle]').length,
        selects: node.querySelectorAll('.dsh-forge-flow-layout-host select').length,
        text: (layoutHost.textContent || '').slice(0, 90),
        error: layoutError ? layoutError.textContent : null,
      };
    }
    return fact;
  });
  return {
    flowRoot: root !== null,
    canvasShell: shell === null ? null : (() => {
      const r = shell.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    })(),
    viewportBottom: window.innerHeight,
    canvasBelowFold: shell === null ? null : shell.getBoundingClientRect().bottom > window.innerHeight + 1,
    background: document.querySelectorAll('.react-flow__background, .dsh-forge-flow-background').length,
    backgroundSvg: (() => {
      const svg = document.querySelector('.react-flow__background');
      if (svg === null) return null;
      const pattern = svg.querySelector('pattern');
      const circle = pattern === null ? null : pattern.querySelector('circle, path');
      const rect = svg.getBoundingClientRect();
      return {
        tag: svg.tagName,
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        patterns: svg.querySelectorAll('pattern').length,
        patternSize: pattern === null ? null : pattern.getAttribute('width') + 'x' + pattern.getAttribute('height'),
        dotRadius: circle === null ? null : circle.getAttribute('r'),
        dotFill: circle === null ? null : circle.getAttribute('fill'),
        visible: rect.width > 0 && rect.height > 0 && svg.querySelectorAll('pattern').length > 0,
      };
    })(),
    zoomLabel: (document.querySelector('.dsh-forge-zoom-label') || {}).textContent || null,
    defaultEdges: document.querySelectorAll('.react-flow__edge').length,
    lineageEdges: document.querySelectorAll('.dsh-forge-flow-edge, .dsh-forge-flow-edge-label').length,
    edgeLabels: [...document.querySelectorAll('.dsh-forge-flow-edge-label')].map((label) => label.textContent),
    nodes,
    nodeCount: nodes.length,
    emptyOverlay: document.querySelector('.dsh-forge-studio-empty, .dsh-forge-workbench-deleted') !== null,
    panelScroll: panel === null ? null : { scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight },
    bodyOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    bodyOverflowY: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
  };
})()`

/** DOM facts for the drawer state: geometry, field count, overflow. */
const PROBE_DRAWER = `(() => {
  const side = document.querySelector('.dsh-forge-canvas-side');
  const inspector = document.querySelector('.dsh-forge-inspector');
  const rectOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } };
  const rows = [...document.querySelectorAll('.dsh-forge-inspector-row, .dsh-forge-inspector .dsh-forge-field')].map((row) => ({
    label: (row.querySelector('label.dsh-forge-label, label') || {}).textContent || '',
    value: (row.querySelector('.dsh-forge-inspector-value') || {}).textContent || (row.querySelector('textarea, input, select') ? '[control]' : ''),
    editable: row.classList.contains('dsh-forge-field'),
  }));
  const body = document.querySelector('.dsh-forge-inspector-body');
  const canvasRoot = document.querySelector('.react-flow');
  const canvasRect = canvasRoot === null ? null : canvasRoot.getBoundingClientRect();
  const inspectorRect = inspector === null ? null : inspector.getBoundingClientRect();
  const overlapsCanvas = canvasRect === null || inspectorRect === null
    ? null
    : !(inspectorRect.left >= canvasRect.right - 1 || inspectorRect.right <= canvasRect.left + 1);
  return {
    side: rectOf(side),
    inspector: rectOf(inspector),
    empty: inspector !== null && inspector.classList.contains('is-empty'),
    title: (document.querySelector('.dsh-forge-inspector-title') || {}).textContent || null,
    badge: (document.querySelector('.dsh-forge-inspector-badge') || {}).textContent || null,
    status: (document.querySelector('.dsh-forge-inspector-status') || {}).textContent || null,
    rowCount: rows.length,
    rows,
    bodyOverflow: body === null ? null : { scrollHeight: body.scrollHeight, clientHeight: body.clientHeight, scrollWidth: body.scrollWidth, clientWidth: body.clientWidth },
    buttons: [...document.querySelectorAll('.dsh-forge-inspector-actions button, .dsh-forge-inspector button')].map((button) => button.textContent.trim()).filter((text) => text.length > 0),
    hasPromptField: document.querySelector('.dsh-forge-inspector-body textarea, .dsh-forge-inspector textarea') !== null,
    hasSelect: document.querySelectorAll('.dsh-forge-inspector select').length,
    hasInput: document.querySelectorAll('.dsh-forge-inspector input').length,
    overlapsCanvas,
    selectedNodes: document.querySelectorAll('.dsh-forge-flow-node.is-selected').length,
    canvasVisible: document.querySelector('.react-flow') !== null,
  };
})()`

const report = {
  url: PAGE_URL,
  startedAt: new Date().toISOString(),
  browser: CANDIDATES[0],
  scenes: {},
  consoleErrors: errors,
  failedRequests: failures,
}

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Network.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1500,
    height: 1320,
    deviceScaleFactor: 1,
    mobile: false,
  })

  await send('Page.navigate', { url: PAGE_URL })
  await until('window.__pv !== undefined && window.__pv.mounted === true', 45_000, 'the workbench shell to mount')
  await until("document.querySelectorAll('.dsh-forge-workbench-card').length >= 3", 20_000, 'the project cards')

  /* ---- scene 1: projects tab (the landing view) ------------------------- */
  await sleep(900)
  const projects = await evaluate(PROBE_PROJECTS)
  report.scenes.projects = { probe: projects, shot: await shot('01-projects') }

  /* ---- scene 2: the open canvas tab ------------------------------------ */
  if (!(await evaluate('window.__pv.activateCanvas()'))) throw new Error('canvas tab click was refused')
  await until("document.querySelectorAll('[data-node-kind]').length >= 6", 30_000, 'the canvas nodes')
  // Pictures are lazy-loaded; give the file route a beat before the shot.
  await until("[...document.querySelectorAll('img.dsh-forge-flow-thumb')].every((img) => img.complete && img.naturalWidth > 0)", 20_000, 'node thumbnails')
  await sleep(1200)
  const canvas = await evaluate(PROBE_CANVAS)
  const canvasShot = await shot('02-canvas')
  const canvasCrop = await shotOf('02b-canvas-1to1', '.dsh-forge-canvas-shell')
  report.scenes.canvas = { probe: canvas, shot: canvasShot, crop: canvasCrop }

  /* ---- scene 3: one node selected, drawer open -------------------------- */
  const clicked = await clickElement(`document.querySelector('[data-node-id="node-tall"]')`)
  await until("document.querySelector('.dsh-forge-inspector') !== null && !document.querySelector('.dsh-forge-inspector').classList.contains('is-empty')", 15_000, 'the property drawer')
  await sleep(700)
  const drawer = await evaluate(PROBE_DRAWER)
  report.scenes.drawer = { clicked, probe: drawer, shot: await shot('03-drawer') }

  report.pageErrors = await evaluate('window.__pv.errors')
  report.seat = await evaluate('window.__pv.seat')
  report.viewport = await evaluate('({ width: window.innerWidth, height: window.innerHeight })')
  report.ok = true
} catch (error) {
  report.ok = false
  report.failure = error instanceof Error ? error.message : String(error)
  report.pageErrors = await evaluate('window.__pv.errors').catch(() => [])
  console.error('FAILED:', report.failure)
} finally {
  // Live buffers may still be holding the last few console entries.
  report.consoleErrors = errors
  report.failedRequests = failures
  report.finishedAt = new Date().toISOString()
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  console.log('report', join(OUT, 'report.json'))
  try {
    ws.close()
  } catch {
    // Already closed.
  }
  chrome.kill()
  if (report.ok !== true) process.exitCode = 1
}
