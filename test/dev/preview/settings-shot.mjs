/** Browser QA for the plugin settings section. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const OUT = resolve(ROOT, 'verify', 'qa-20261124')
mkdirSync(OUT, { recursive: true })
const PAGE_URL = process.env.PREVIEW_SETTINGS_URL ?? 'http://127.0.0.1:8390/settings'
const PORT = Number(process.env.PREVIEW_CDP_PORT ?? 9351)
const VIEWPORT = { width: 1335, height: 980 }
const BROWSERS = [
  process.env.PREVIEW_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter((path) => typeof path === 'string' && existsSync(path))
if (BROWSERS.length === 0) throw new Error('no Chrome/Edge executable found; set PREVIEW_CHROME')

const profile = mkdtempSync(join(tmpdir(), 'forge-settings-'))
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
    } catch { /* browser is starting */ }
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
  if (message.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(message.params.type)) {
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
async function screenshot(name, width = VIEWPORT.width, height = VIEWPORT.height) {
  const result = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  })
  const path = join(OUT, `${name}.png`)
  writeFileSync(path, Buffer.from(result.data, 'base64'))
  return path
}
function setInput(selector, value) {
  return ev(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    if (!input) return false
    const proto = input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
}
function clickButton(text) {
  return ev(`(() => {
    const hit = [...document.querySelectorAll('button')].find((button) => button.textContent.trim().includes(${JSON.stringify(text)}))
    if (!hit || hit.disabled) return false
    hit.click()
    return true
  })()`)
}

const report = { url: PAGE_URL, viewport: VIEWPORT, deviceScaleFactor: 1 }
try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: PAGE_URL })
  try {
    await until("window.__pvSettings && window.__pvSettings.mounted === true", 40_000, 'settings section')
  } catch (error) {
    console.log('console errors:', JSON.stringify(consoleErrors))
    console.log('page text:', await ev('document.body.innerText'))
    console.log('settings state:', await ev('window.__pvSettings && { mounted: window.__pvSettings.mounted, seat: window.__pvSettings.seat }'))
    throw error
  }
  await sleep(900)

  report.initial = await ev(`(() => ({
    tabs: [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent.trim()),
    fields: [...document.querySelectorAll('.dsh-image-forge-setting')].map((field) => field.dataset.field),
    environment: document.querySelector('.dsh-settings-environment')?.dataset.tone,
    process: document.querySelector('.dsh-settings-environment-pills')?.textContent.trim(),
    logLines: document.querySelectorAll('.dsh-settings-log-line').length,
    savebarVisible: document.querySelector('.dsh-settings-savebar') !== null,
    bodyOverflow: document.body.scrollWidth > document.body.clientWidth,
    panelOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    footerBottom: document.querySelector('.dsh-settings-savebar')?.getBoundingClientRect().bottom,
    viewportHeight: innerHeight,
  }))()`)
  report.basicShot = await screenshot('settings22-basic-1335-light')

  report.advancedClicked = await clickButton('高级')
  await until("document.querySelectorAll('.dsh-image-forge-setting').length === 9", 5_000, 'advanced fields')
  report.advanced = await ev(`(() => ({
    fields: [...document.querySelectorAll('.dsh-image-forge-setting')].map((field) => field.dataset.field),
    foldedGroup: document.querySelector('[data-group="backend"]')?.getAttribute('data-advanced'),
  }))()`)
  report.advancedShot = await screenshot('settings22-advanced-1335-light')

  await clickButton('常用')
  await until("document.querySelector('[data-field=\"comfyEndpoint\"]') !== null", 5_000, 'basic fields again')
  await setInput('#dsh-image-forge-field-comfyEndpoint', 'http://127.0.0.1:9000')
  await sleep(120)
  report.dirtyGate = await ev(`(() => ({
    heading: document.querySelector('.dsh-settings-heading-pill')?.textContent.trim(),
    blocked: document.querySelector('.dsh-settings-env-block')?.textContent.trim(),
    stopDisabled: [...document.querySelectorAll('.dsh-settings-actions button')].find((button) => button.textContent.includes('停止'))?.disabled,
    saveDisabled: [...document.querySelectorAll('.dsh-settings-save-actions button')].find((button) => button.textContent.includes('保存'))?.disabled,
  }))()`)

  report.saved = await clickButton('保存更改')
  await until("document.querySelector('.dsh-settings-save-detail')?.textContent.includes('已保存')", 5_000, 'save success')
  report.afterSave = await ev(`(() => ({
    heading: document.querySelector('.dsh-settings-heading-pill')?.textContent.trim(),
    endpoint: window.__pvSettings.values.comfyEndpoint,
    calls: window.__pvSettings.saveCalls.slice(),
  }))()`)

  await ev(`(() => {
    window.__pvSettings.failKey = 'comfyModelsDir'
    window.__pvSettings.failedOnce = false
    window.__pvSettings.saveCalls = []
    return true
  })()`)
  await setInput('#dsh-image-forge-field-comfyEndpoint', 'http://127.0.0.1:9100')
  await setInput('#dsh-image-forge-field-comfyPorts', '9001')
  await setInput('#dsh-image-forge-field-comfyModelsDir', 'Z:/models')
  await sleep(100)
  await clickButton('保存更改')
  await until("document.querySelector('.dsh-settings-save-detail')?.textContent.includes('回滚')", 8_000, 'rollback feedback')
  report.rollback = await ev(`(() => ({
    feedback: document.querySelector('.dsh-settings-save-detail')?.textContent.trim(),
    endpoint: window.__pvSettings.values.comfyEndpoint,
    ports: window.__pvSettings.values.comfyPorts,
    modelsDir: window.__pvSettings.values.comfyModelsDir,
    calls: window.__pvSettings.saveCalls.slice(),
    stillDirty: document.querySelector('.dsh-settings-heading-pill')?.textContent.trim(),
  }))()`)

  await ev('window.__pvSettings.logMode = "empty"')
  await clickButton('刷新')
  await until("document.querySelector('.dsh-settings-log-empty')?.textContent.includes('暂且') || document.querySelector('.dsh-settings-log-empty')?.textContent.includes('暂时')", 5_000, 'empty log')
  report.emptyLog = await ev("document.querySelector('.dsh-settings-log-empty')?.textContent")

  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 980, deviceScaleFactor: 1, mobile: false })
  await sleep(250)
  report.width1200 = await ev(`(() => ({ overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, settingsWidth: document.querySelector('.dsh-image-forge-settings')?.getBoundingClientRect().width }))()`)
  report.shot1200 = await screenshot('settings22-basic-1200-light', 1200, 980)

  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 980, deviceScaleFactor: 1, mobile: false })
  await sleep(200)
  report.shot1500 = await screenshot('settings22-basic-1500-light', 1500, 980)

  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 980, deviceScaleFactor: 1, mobile: false })
  await sleep(200)
  report.width1600 = await ev(`(() => ({ overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, settingsWidth: document.querySelector('.dsh-image-forge-settings')?.getBoundingClientRect().width }))()`)
  report.shot1600 = await screenshot('settings22-basic-1600-light', 1600, 980)

  await ev(`(() => {
    document.body.style.background = '#181716'
    document.body.style.color = '#f4efe6'
    document.documentElement.style.colorScheme = 'dark'
    return true
  })()`)
  await clickButton('高级')
  await sleep(250)
  report.darkShot = await screenshot('settings22-advanced-1600-dark', 1600, 980)

  report.ok = report.initial.tabs.length === 2
    && report.initial.fields.length === 7
    && report.initial.environment === 'is-ok'
    && report.initial.logLines >= 5
    && report.initial.savebarVisible
    && !report.initial.bodyOverflow
    && report.advanced.fields.length === 9
    && report.advanced.foldedGroup === 'true'
    && report.dirtyGate.heading.includes('未保存')
    && report.dirtyGate.stopDisabled === true
    && report.afterSave.endpoint === 'http://127.0.0.1:9000'
    && report.rollback.endpoint === 'http://127.0.0.1:9000'
    && report.rollback.ports === '8000,8188,8189,8190,8191,8192'
    && report.rollback.modelsDir.includes('ComfyUI')
    && report.rollback.calls.some((call) => call.op === 'set' && call.key === 'comfyEndpoint' && call.value === 'http://127.0.0.1:9000')
    && !report.width1200.overflow
    && !report.width1600.overflow
    && consoleErrors.length === 0
    && failedRequests.length === 0
  report.consoleErrors = consoleErrors
  report.failedRequests = failedRequests
  writeFileSync(join(OUT, 'settings-report.json'), JSON.stringify(report, null, 2))
  console.log('report', join(OUT, 'settings-report.json'))
  if (!report.ok) process.exitCode = 1
} finally {
  try { ws.close() } catch { /* already closed */ }
  browser.kill()
}
