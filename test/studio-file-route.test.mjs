/**
 * The `/studio/file` route: the one place a local image path becomes bytes a
 * browser can show. Asserts the security posture (method, origin, absolute
 * path, extension whitelist, existence) and the happy path's bytes.
 *
 * Runs against a real socket: a fake `res` would assert nothing about the
 * `pipeline` teardown that actually breaks images.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerStudioRoutes } from '../testlib/studio-routes.js'
import { STUDIO_FILE_ROUTE } from '../testlib/studio-shared.js'

/** Mount the routes on a throwaway server and return its base URL. */
async function withServer(run) {
  const registered = []
  const fakeWebServer = { register: (route) => { registered.push(route); return () => {} } }
  const fakeCtx = { webServer: fakeWebServer, logger: { warn() {} } }
  registerStudioRoutes(fakeCtx, { settings: () => ({ outputDir: tmpdir() }), ctx: fakeCtx })
  const handler = registered.find((route) => route.path === STUDIO_FILE_ROUTE)
  assert.ok(handler, 'file route must be registered')
  const server = createServer((req, res) => { void handler.handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await run(base)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** GET with a browser-like Origin header so the same-origin guard is exercised. */
function get(base, url, { method = 'GET', origin = `http://${new URL(base).host}` } = {}) {
  return fetch(base + url, {
    method,
    ...(origin === null ? {} : { headers: { origin } }),
  })
}

test('serves a png file with the right content type and bytes', async () => {
  await withServer(async (base) => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-forge-file-'))
    try {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad])
      const file = join(dir, 'qwen_1248x1248_1.png')
      await writeFile(file, png)
      const res = await get(base, `${STUDIO_FILE_ROUTE}?path=${encodeURIComponent(file)}`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'image/png')
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), png)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

test('rejects the bad shapes: missing/relative path, wrong type, missing file, POST', async () => {
  await withServer(async (base) => {
    const cases = [
      [`${STUDIO_FILE_ROUTE}`, 400, 'missing path'],
      [`${STUDIO_FILE_ROUTE}?path=${encodeURIComponent('relative/dir.png')}`, 400, 'relative path'],
      [`${STUDIO_FILE_ROUTE}?path=${encodeURIComponent(join(tmpdir(), 'notes.txt'))}`, 415, 'txt is refused'],
      [`${STUDIO_FILE_ROUTE}?path=${encodeURIComponent(join(tmpdir(), 'nope', 'gone.png'))}`, 404, 'absent file'],
    ]
    for (const [url, status, label] of cases) {
      const res = await get(base, url)
      assert.equal(res.status, status, label)
      assert.equal((await res.json()).error.length > 0, true, `${label} carries a message`)
    }
    const posted = await get(base, STUDIO_FILE_ROUTE, { method: 'POST' })
    assert.equal(posted.status, 405, 'POST is refused')
  })
})

test('a cross-origin request is refused', async () => {
  await withServer(async (base) => {
    const res = await get(base, `${STUDIO_FILE_ROUTE}?path=x`, { origin: 'http://evil.example' })
    assert.equal(res.status, 403)
  })
})
