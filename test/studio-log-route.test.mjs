/**
 * `/studio/log`: bounded, line-numbered pagination. The old route returned one
 * opaque text tail; these tests pin the facts the reader now depends on: stable
 * line numbers, parsed timestamps, severity, older/newer cursors and the same
 * path allow-list.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerStudioRoutes } from '../testlib/studio-routes.js'
import { STUDIO_LOG_ROUTE } from '../testlib/studio-shared.js'

async function withLogServer(run) {
  const registered = []
  const fakeWebServer = { register: (route) => { registered.push(route); return () => {} } }
  const fakeCtx = { webServer: fakeWebServer, logger: { warn() {} } }
  registerStudioRoutes(fakeCtx, { settings: () => ({ outputDir: tmpdir() }), ctx: fakeCtx })
  const route = registered.find((entry) => entry.path === STUDIO_LOG_ROUTE)
  assert.ok(route, 'log route must be registered')
  const server = createServer((req, res) => { void route.handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await run(base)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

function get(base, url) {
  return fetch(base + url, { headers: { origin: `http://${new URL(base).host}` } })
}

test('returns a structured newest page with line numbers, time and severity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-forge-log-'))
  const logs = join(dir, 'logs')
  const file = join(logs, 'comfyui.log')
  try {
    await mkdir(logs, { recursive: true })
    const lines = Array.from({ length: 230 }, (_, index) => {
      const number = index + 1
      const token = number === 200 ? 'ERROR' : number === 210 ? 'WARNING' : 'INFO'
      return `[2026-11-23 18:00:${String(number % 60).padStart(2, '0')}] [${token}] line ${String(number)}`
    })
    await writeFile(file, `${lines.join('\n')}\n`)
    await withLogServer(async (base) => {
      const response = await get(base, `${STUDIO_LOG_ROUTE}?path=${encodeURIComponent(file)}`)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
      const page = await response.json()
      assert.equal(page.version, 'studio-log/v1')
      assert.equal(page.totalLines, 230)
      assert.equal(page.fromLine, 31)
      assert.equal(page.toLine, 230)
      assert.equal(page.hasOlder, true)
      assert.equal(page.hasNewer, false)
      assert.equal(page.timestampedLines, 200)
      assert.equal(page.lines[0].number, 31)
      assert.equal(page.lines.at(-1).number, 230)
      assert.equal(page.lines.find((line) => line.number === 200).level, 'error')
      assert.equal(page.lines.find((line) => line.number === 210).level, 'warn')
      assert.match(page.lines[0].text, /line 31$/)
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('before walks older and after walks newer without changing line identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-forge-log-page-'))
  const logs = join(dir, 'logs')
  const file = join(logs, 'dsh-image-forge-launch-fixture.log')
  try {
    await mkdir(logs, { recursive: true })
    await writeFile(file, Array.from({ length: 120 }, (_, index) => `[INFO] line ${String(index + 1)}`).join('\n'))
    await withLogServer(async (base) => {
      const older = await get(base, `${STUDIO_LOG_ROUTE}?path=${encodeURIComponent(file)}&before=100&limit=20`)
      assert.equal(older.status, 200)
      const olderPage = await older.json()
      assert.equal(olderPage.fromLine, 80)
      assert.equal(olderPage.toLine, 99)
      assert.equal(olderPage.source, 'plugin')
      assert.equal(olderPage.hasOlder, true)
      assert.equal(olderPage.hasNewer, true)
      assert.equal(olderPage.timestampedLines, 0)

      const newer = await get(base, `${STUDIO_LOG_ROUTE}?path=${encodeURIComponent(file)}&after=100&limit=10`)
      assert.equal(newer.status, 200)
      const newerPage = await newer.json()
      assert.equal(newerPage.fromLine, 101)
      assert.equal(newerPage.toLine, 110)
      assert.equal(newerPage.hasOlder, true)
      assert.equal(newerPage.hasNewer, true)
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('keeps the path allow-list and refuses cross-origin reads', async () => {
  await withLogServer(async (base) => {
    for (const path of [join(tmpdir(), 'logs', 'notes.txt'), join(tmpdir(), 'comfyui.log')]) {
      const response = await get(base, `${STUDIO_LOG_ROUTE}?path=${encodeURIComponent(path)}`)
      assert.equal(response.status, 400)
    }
    const cross = await fetch(base + `${STUDIO_LOG_ROUTE}?path=${encodeURIComponent(join(tmpdir(), 'logs', 'comfyui.log'))}`, {
      headers: { origin: 'http://evil.example' },
    })
    assert.equal(cross.status, 403)
  })
})
