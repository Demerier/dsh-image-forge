/**
 * A real preview host for the browser half — dev only, never shipped.
 *
 * Not part of `pnpm test`. Everything the reader sees in the page is the **real**
 * code: `lib/client.js` is loaded through a `window.__ModuleLoader__` stub — the
 * same factory shape the DSH web shell materializes — and seated through a
 * minimal `slots` implementation, while the studio routes come from
 * `lib/index.js` registering itself on a fake `webServer`, exactly the call path
 * a DSH host uses.
 *
 * What is faked, and only this: the settings shell around the panel (the rail and
 * title bar in `test/dev/preview/page.mjs` are labelled as scaffolding), the
 * module table React comes from (the installed CommonJS files, so no CDN and no
 * download), and the **data**. The boards, pictures and workspace in
 * `verify/preview/data` are written by `test/dev/preview/fixtures.mjs`; nothing
 * ever reaches ComfyUI, so a screenshot is a screenshot of the product on
 * fixture data.
 *
 * Run: `node test/dev/preview/run.mjs`, then `node test/dev/preview/shot.mjs`
 * (or open the printed URL in a browser).
 */
import { createReadStream, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { previewPage } from './page.mjs'
import { vendorPath, vendorScript, vendorSpecifierOf, VENDOR_MODULES } from './vendor.mjs'
import { dataDir, MAIN_BOARD, writeFixtures } from './fixtures.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const LIB = join(ROOT, 'lib')
const VERIFY = join(ROOT, 'verify', 'preview')
const MAIN_BOARD_NAME = '雨夜东京 · 竖构图'
mkdirSync(VERIFY, { recursive: true })

const fixtures = writeFixtures(VERIFY)
const OUT = fixtures.outputDir

const mod = await import(pathToFileURL(join(LIB, 'index.js')).href)

/** Schema defaults, unwrapped into plain data (the refs are read once). */
const parsed = mod.Config({})
const state = {}
for (const [key, field] of Object.entries(parsed)) {
  state[key] = field !== null && typeof field === 'object' && typeof field.get === 'function' ? field.get() : field
}

// The knobs this preview wants: fixture boards under `verify/preview/data`, and
// an endpoint that is deliberately not this machine's ComfyUI — the preview must
// never start a real generation, and a clear "not reachable" is the honest state.
Object.assign(state, {
  backend: 'comfyui',
  comfyEndpoint: 'http://127.0.0.1:9',
  comfyModel: 'qwen21-base',
  outputDir: OUT,
})

let revision = 1

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

/** The services this fake host offers, by cordis name. */
const services = { webServer }

/** Quiet logger: a nested-plugin warning is worth seeing, chatter is not. */
const logger = { info() {}, debug() {}, warn: (...args) => console.warn('preview:', ...args), error: (...args) => console.error('preview:', ...args) }

/** Disposers returned by nested plugins, so the host keeps its side of the deal. */
const nestedDisposers = []

/**
 * A context with the one cordis behaviour this plugin actually uses: `plugin()`
 * starts a nested plugin whose `inject` services already exist.
 *
 * `registerStudioRoutesIfMounted` puts the Studio routes on a nested plugin that
 * injects `webServer` — that indirection is why a plain `ctx` registers no routes
 * at all. Emulating it here keeps the preview on the real activation path instead
 * of calling `registerStudioRoutes` directly.
 */
function makeContext(extra = {}) {
  return {
    get: (name) => services[name],
    logger,
    ...extra,
    plugin(plugin) {
      const missing = (plugin.inject ?? []).filter((name) => services[name] === undefined)
      if (missing.length > 0) {
        logger.warn(`nested plugin "${String(plugin.name)}" waits for ${missing.join(', ')}`)
        return
      }
      const nested = { get: (name) => services[name], webServer, logger, ...(extra.tools === undefined ? {} : { tools: extra.tools, skills: extra.skills }) }
      const dispose = plugin.apply(nested)
      if (typeof dispose === 'function') nestedDisposers.push(dispose)
    },
  }
}

mod.apply(
  makeContext({
    tools: {
      register(tool) {
        if (typeof tool?.name === 'string') tools.set(tool.name, tool)
      },
    },
    skills: { register() {} },
  }),
  fields,
)

const MIME = {
  '.png': 'image/png',
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  try {
    // Plugin routes first: they own /plugins/dsh-image-forge/*, and the client
    // reaches them by the same absolute paths a real Host serves.
    const route = routes.get(url.pathname)
    if (route !== undefined) {
      await route(req, res)
      return
    }

    if (url.pathname === '/') {
      const vendorScripts = VENDOR_MODULES.map((specifier) => vendorPath(specifier))
      send(res, 200, previewPage({ vendorScripts, mainBoardName: MAIN_BOARD_NAME }), MIME['.html'])
      return
    }

    const specifier = vendorSpecifierOf(url.pathname)
    if (specifier !== undefined) {
      send(res, 200, vendorScript(specifier), MIME['.js'])
      return
    }

    if (url.pathname === '/client.js') {
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' })
      createReadStream(join(LIB, 'client.js')).pipe(res)
      return
    }

    if (url.pathname === '/__ping') {
      send(
        res,
        200,
        JSON.stringify({
          ok: true,
          routes: [...routes.keys()],
          tools: [...tools.keys()],
          outputDir: OUT,
          boards: fixtures.boards,
          mainBoard: MAIN_BOARD,
          revision,
        }),
      )
      return
    }

    send(res, 404, 'not found', 'text/plain; charset=utf-8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!res.headersSent) send(res, 500, JSON.stringify({ ok: false, message }))
    else res.end()
  }
})

const port = Number(process.env.PREVIEW_PORT ?? 8390)
server.listen(port, '127.0.0.1', () => {
  console.log(`preview host  http://127.0.0.1:${String(port)}/`)
  console.log(`  routes      ${[...routes.keys()].join(', ')}`)
  console.log(`  output      ${OUT}`)
  console.log(`  boards      ${fixtures.boards.join(', ')} (canvas tab opens ${MAIN_BOARD}, ${String(fixtures.nodes)} nodes)`)
  console.log(`  data dir    ${dataDir(VERIFY)}`)
})
