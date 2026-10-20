/**
 * A real preview host for the browser half — dev only, never shipped.
 *
 * Not part of `pnpm test`. Everything the user can see here is the **real**
 * code: `lib/client.js` is loaded through a `window.__ModuleLoader__` stub and
 * seated through a minimal `slots` + `configForms` implementation, while the
 * three Studio routes come from `lib/index.js` registering itself on a fake
 * `webServer` — the same call path a DSH host uses. Generations go to the real
 * ComfyUI on 127.0.0.1:8188, so a screenshot is a screenshot of the product.
 *
 * What is faked, and only this: the settings shell around the section (nav row,
 * page chrome), the config-form service (an in-memory record behind the same
 * `getSnapshot`/`subscribe`/`set`/`unset` shape), and the host's local-path →
 * URL rewriting for `<img src="D:/…">`, which the real client shell does and a
 * plain browser cannot.
 *
 * Run: `node test/preview-run.mjs` then open the printed URL.
 */
import { createServer } from 'node:http'
import { createReadStream, mkdirSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..')
const LIB = join(ROOT, 'lib')
const OUT = join(ROOT, '.preview', 'out')
mkdirSync(OUT, { recursive: true })

const mod = await import(pathToFileURL(join(LIB, 'index.js')).href)

/** Schema defaults, unwrapped into plain data (the refs are read once). */
const parsed = mod.Config({})
const state = {}
for (const [key, field] of Object.entries(parsed)) {
  state[key] = field !== null && typeof field === 'object' && typeof field.get === 'function' ? field.get() : field
}

// The knobs this preview wants: talk to the ComfyUI that is actually running,
// use the 8-step family so a screenshot does not wait 40 s, and write into the
// repo's own scratch directory so nothing lands in the user's data folder.
Object.assign(state, {
  backend: 'auto',
  comfyEndpoint: 'http://127.0.0.1:8188',
  comfyModel: 'turbo',
  turboSteps: undefined,
  outputDir: OUT,
})

let revision = 1
const formListeners = new Set()

/** The volatile references the plugin reads on every request. */
const fields = Object.fromEntries(Object.keys(state).map((key) => [key, { get: () => state[key] }]))

/** Exact-path routes the plugin registers on the host's web server. */
const routes = new Map()
const webServer = {
  register(route) {
    routes.set(route.path, route.handler)
    return () => routes.delete(route.path)
  },
}

/** Tool definitions, captured rather than registered. */
const tools = new Map()

mod.apply(
  {
    tools: {
      register(tool) {
        if (typeof tool?.name === 'string') tools.set(tool.name, tool)
      },
    },
    skills: { register() {} },
    get: (name) => (name === 'webServer' ? webServer : undefined),
    webServer,
  },
  fields,
)
const routeCount = routes.size

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

function sendJson(res, value, status = 200) {
  send(res, status, JSON.stringify(value))
}

async function readBody(req, cap = 2 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > cap) throw new Error('body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.length === 0 ? {} : JSON.parse(text)
}

/** Newest PNG in the preview output dir, used as the default edit reference. */
async function newestImage() {
  const names = (await readdir(OUT)).filter((name) => extname(name).toLowerCase() === '.png')
  if (names.length === 0) return undefined
  const rows = await Promise.all(
    names.map(async (name) => ({ name, at: (await stat(join(OUT, name))).mtimeMs })),
  )
  rows.sort((a, b) => b.at - a.at)
  return join(OUT, rows[0].name)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  try {
    const route = routes.get(url.pathname)
    if (route !== undefined) {
      await route(req, res)
      return
    }

    if (url.pathname === '/') {
      send(res, 200, page(), MIME['.html'])
      return
    }

    if (url.pathname === '/client.js') {
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' })
      createReadStream(join(LIB, 'client.js')).pipe(res)
      return
    }

    // The host shell turns an absolute local path into a loadable URL; a plain
    // browser has no such mapping, so the preview does it here, and only for
    // files this preview itself produced.
    if (url.pathname === '/fs') {
      const target = resolve(url.searchParams.get('p') ?? '')
      if (!target.startsWith(OUT)) {
        send(res, 403, 'outside the preview output dir', 'text/plain; charset=utf-8')
        return
      }
      res.writeHead(200, {
        'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      })
      createReadStream(target).pipe(res)
      return
    }

    if (url.pathname === '/__state') {
      sendJson(res, { status: 'ready', value: state, revision, writable: true, mode: 'host' })
      return
    }

    if (url.pathname === '/__set' && req.method === 'POST') {
      const body = await readBody(req)
      const key = String(body.key ?? '')
      if (!Object.hasOwn(state, key)) {
        sendJson(res, { ok: false, message: `unknown field ${key}` }, 400)
        return
      }
      if (body.value === undefined) delete state[key]
      else state[key] = body.value
      revision += 1
      for (const listener of [...formListeners]) listener()
      sendJson(res, { ok: true, revision })
      return
    }

    if (url.pathname === '/__run' && req.method === 'POST') {
      const body = await readBody(req)
      const tool = tools.get(String(body.tool ?? ''))
      if (tool === undefined) {
        sendJson(res, { ok: false, message: `unknown tool ${body.tool}` }, 400)
        return
      }
      const args = { ...(body.args ?? {}) }
      if (tool.name === 'qwen_image_edit' && !Array.isArray(args.images)) {
        const reference = await newestImage()
        if (reference === undefined) {
          sendJson(res, { ok: false, message: '先跑一次文生图，改图才有参考图。' }, 400)
          return
        }
        args.images = [reference]
      }
      const startedAt = Date.now()
      const value = await tool.execute(args, { signal: new AbortController().signal })
      const blocks = tool.output.render(args, value)
      sendJson(res, { ok: true, name: tool.name, blocks, elapsedMs: Date.now() - startedAt })
      return
    }

    if (url.pathname === '/__ping') {
      sendJson(res, { routes: [...routes.keys()], tools: [...tools.keys()], outputDir: OUT })
      return
    }

    send(res, 404, 'not found', 'text/plain; charset=utf-8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!res.headersSent) sendJson(res, { ok: false, message }, 500)
    else res.end()
  }
})

const port = Number(process.env.PREVIEW_PORT ?? 8390)
server.listen(port, '127.0.0.1', () => {
  console.log(`preview host  http://127.0.0.1:${port}/`)
  console.log(`  routes      ${[...routes.keys()].join(', ')} (${routeCount})`)
  console.log(`  tools       ${[...tools.keys()].join(', ')}`)
  console.log(`  output      ${OUT}`)
})

/** The page: a thin settings shell around the real section component. */
function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-image-forge · 真实运行预览</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: #1c1e21;
    background: #f5f6f8;
  }
  .pv-bar {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    padding: 10px 18px;
    background: #fff;
    border-bottom: 1px solid #e3e6ea;
    font-size: 12px;
    color: #5b6169;
  }
  .pv-bar b { font-size: 13px; font-weight: 500; color: #1c1e21; }
  .pv-bar code { font-size: 11.5px; background: #f1f3f5; padding: 1px 5px; border-radius: 4px; }
  .pv-actions { margin-left: auto; display: flex; gap: 8px; }
  .pv-actions button {
    font: inherit;
    font-size: 12px;
    padding: 5px 11px;
    border-radius: 7px;
    border: 1px solid #cfd4da;
    background: #fff;
    color: #1c1e21;
    cursor: pointer;
  }
  .pv-actions button:hover { background: #f6f7f9; }
  .pv-actions button:disabled { opacity: .5; cursor: default; }
  .pv-page { display: flex; gap: 0; align-items: stretch; }
  .pv-nav {
    width: 196px;
    flex: none;
    padding: 14px 10px;
    background: #fff;
    border-right: 1px solid #e3e6ea;
    font-size: 13px;
  }
  .pv-nav-item { padding: 7px 10px; border-radius: 7px; color: #5b6169; }
  .pv-nav-item.is-active { background: #eef1f5; color: #1c1e21; font-weight: 500; }
  .pv-pane { flex: 1; min-width: 0; padding: 18px 22px 40px; }
  .pv-pane-inner { width: 1000px; max-width: 100%; }
  .pv-cards { padding: 0 22px 40px 218px; }
  .pv-cards h2 { font-size: 13px; font-weight: 500; color: #5b6169; margin: 6px 0 10px; }
  .pv-cards-inner { width: 760px; max-width: 100%; display: flex; flex-direction: column; gap: 10px; }
  .pv-hint { font-size: 12px; color: #7a8089; margin: 0 0 10px; }
  .pv-log { font-size: 12px; color: #7a8089; margin: 8px 0 0; min-height: 18px; }
</style>
</head>
<body>
<header class="pv-bar">
  <b>预览宿主</b>
  <span>真实 <code>lib/client.js</code> · 真实 studio 路由 · 真机 ComfyUI <code>127.0.0.1:8188</code></span>
  <span class="pv-actions">
    <button id="run-t2i">跑一次文生图</button>
    <button id="run-edit">跑一次改图</button>
    <button id="run-status">跑一次状态</button>
  </span>
</header>
<main class="pv-page">
  <nav class="pv-nav">
    <div class="pv-nav-item is-active">Qwen 出图</div>
    <div class="pv-nav-item">模型与账号</div>
    <div class="pv-nav-item">插件</div>
  </nav>
  <div class="pv-pane">
    <div class="pv-pane-inner" id="section"></div>
  </div>
</main>
<section class="pv-cards">
  <h2>对话里的工具卡片（同一次真实调用渲染出的结果）</h2>
  <p class="pv-hint">按钮跑的是 <code>qwen_image_generate</code> / <code>qwen_image_edit</code> / <code>qwen_image_status</code> 本身，卡片吃的是它自己的 <code>output.render()</code> 产物。</p>
  <div class="pv-cards-inner" id="cards"></div>
  <p class="pv-log" id="log"></p>
</section>
<script src="https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script>
  window.__ModuleLoader__ = {
    load: function (spec) {
      window.__forge = spec.factory(function (name) {
        if (name === 'react') return React
        throw new Error('preview host provides no module: ' + name)
      })
    }
  }
</script>
<script src="/client.js"></script>
<script>
(function () {
  var log = document.getElementById('log')
  function say(text) { log.textContent = text }

  // The host rewrites an absolute local path before the img loads; do the same
  // here so result thumbnails are not broken images in the preview.
  function rewrite(root) {
    root.querySelectorAll('img[src]').forEach(function (img) {
      var raw = img.getAttribute('src') || ''
      if (img.dataset.pvDone || raw.indexOf('://') >= 0 || raw.slice(0, 5) === 'data:') return
      if (!/^[A-Za-z]:[\\\\/]/.test(raw)) return
      img.dataset.pvDone = '1'
      img.src = '/fs?p=' + encodeURIComponent(raw)
    })
  }
  new MutationObserver(function (records) {
    records.forEach(function (record) {
      if (record.type === 'attributes' && record.target.tagName === 'IMG') {
        rewrite(record.target.parentNode || document.body)
        return
      }
      record.addedNodes.forEach(function (node) {
        if (node.nodeType === 1) rewrite(node)
      })
    })
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })

  var seats = []
  var form = {
    getSnapshot: function () { return window.__pvSnapshot || { status: 'loading', writable: false } },
    subscribe: function (listener) { window.__pvSubs.push(listener); return function () {} },
    set: function (key, value) {
      return fetch('/__set', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: key, value: value })
      }).then(function (r) { return r.json() }).then(function (answer) {
        return refresh().then(function () { return answer.ok === true })
      })
    },
    unset: function (key) {
      return fetch('/__set', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: key })
      }).then(function (r) { return r.json() }).then(function (answer) {
        return refresh().then(function () { return answer.ok === true })
      })
    }
  }
  window.__pvSubs = []
  function refresh() {
    return fetch('/__state').then(function (r) { return r.json() }).then(function (snapshot) {
      window.__pvSnapshot = snapshot
      window.__pvSubs.forEach(function (fn) { try { fn() } catch (e) {} })
      return snapshot
    })
  }

  var configForms = {
    describe: function () {
      return {
        getSnapshot: function () { return { view: { namespaces: [{ ns: 'dsh-image-forge' }] } } },
        subscribe: function () { return function () {} }
      }
    },
    get: function () { return form }
  }

  var ctx = {
    slots: {
      inject: function (name, register) { register() },
      register: function (options, component) {
        seats.push({ options: options, component: component })
        return function () {}
      }
    },
    get: function (name) { return name === 'configForms' ? configForms : undefined }
  }

  refresh().then(function () {
    window.__forge.apply(ctx)
    var seat = seats.filter(function (s) { return s.options.name === 'settings.section' })[0]
    if (!seat) { say('没有拿到 settings.section 席位，客户端 apply 失败。'); return }
    ReactDOM.createRoot(document.getElementById('section')).render(
      React.createElement(seat.component, seat.options.inject())
    )
    say('席位：' + seats.map(function (s) { return s.options.name + (s.options.key ? '/' + s.options.key : '') }).join(' · '))
  })

  var cardRoot = ReactDOM.createRoot(document.getElementById('cards'))
  var cards = []
  var busy = { 'run-t2i': false, 'run-edit': false, 'run-status': false }

  function run(toolName, args, button) {
    if (busy[button]) return
    busy[button] = true
    var el = document.getElementById(button)
    el.disabled = true
    say('正在调用 ' + toolName + ' …（真机 ComfyUI，可能需要十几秒）')
    fetch('/__run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: toolName, args: args })
    }).then(function (r) { return r.json() }).then(function (answer) {
      if (!answer.ok) { say('失败：' + answer.message); return }
      var seat = seats.filter(function (s) { return s.options.key === answer.name })[0]
      if (!seat) { say('没有这个工具的卡片席位：' + answer.name); return }
      cards.unshift(React.createElement(seat.component, {
        toolName: answer.name,
        phase: 'result',
        // The host's image loader: an absolute local path becomes a loadable URL.
        loadImage: function (path) { return '/fs?p=' + encodeURIComponent(path) },
        block: { kind: 'tool-result', name: answer.name, content: answer.blocks }
      }))
      cardRoot.render(React.createElement('div', null, cards))
      say(toolName + ' 完成，' + answer.elapsedMs + ' ms')
    }).catch(function (error) {
      say('失败：' + error.message)
    }).then(function () {
      busy[button] = false
      el.disabled = false
    })
  }

  document.getElementById('run-t2i').onclick = function () {
    run('qwen_image_generate', {
      prompt: '一只橘猫坐在朝西的窗台上，午后侧光穿过纱帘，浅景深，暖色木地板，画面安静克制。',
      wh_ratio: '16:9',
      count: 1
    }, 'run-t2i')
  }
  document.getElementById('run-edit').onclick = function () {
    run('qwen_image_edit', {
      prompt: '把窗外的天气换成细雪，室内光线保持暖调，猫的姿势与构图不变。',
      wh_ratio: '16:9'
    }, 'run-edit')
  }
  document.getElementById('run-status').onclick = function () { run('qwen_image_status', {}, 'run-status') }
})()
</script>
</body>
</html>`
}
