/**
 * The `/studio/file` route: the one place a local image path becomes bytes a
 * browser can show. Asserts the security posture (method, origin, absolute
 * path, extension whitelist, existence), the happy path's bytes, and the
 * thumbnail contract (G20: `?w=`, a whitelist, one cached resize per file).
 *
 * Runs against a real socket: a fake `res` would assert nothing about the
 * `pipeline` teardown that actually breaks images.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodePng,
  downscalePng,
  encodePng,
  registerStudioRoutes,
} from '../testlib/studio-routes.js'
import {
  STUDIO_FILE_ROUTE,
  STUDIO_THUMB_DIR,
  STUDIO_THUMB_WIDTHS,
} from '../testlib/studio-shared.js'

/**
 * Mount the routes on a throwaway server and return its base URL.
 *
 * `outputDir` is where the thumbnail cache lands, so a test that asserts the
 * cache owns its own directory instead of writing into the OS temp root.
 */
async function withServer(run, outputDir = tmpdir()) {
  const registered = []
  const fakeWebServer = { register: (route) => { registered.push(route); return () => {} } }
  const fakeCtx = { webServer: fakeWebServer, logger: { warn() {} } }
  registerStudioRoutes(fakeCtx, { settings: () => ({ outputDir }), ctx: fakeCtx })
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

/** A real, encodable RGBA PNG of the given size and flat colour. */
function pngBytes(width, height, colour = [200, 120, 40, 255]) {
  const pixels = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 4] = colour[0]
    pixels[index * 4 + 1] = colour[1]
    pixels[index * 4 + 2] = colour[2]
    pixels[index * 4 + 3] = colour[3]
  }
  return Buffer.from(encodePng({ width, height, pixels }))
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

/* -------------------------------------------------------------------------- */
/* G20: thumbnails                                                            */
/* -------------------------------------------------------------------------- */

test('the PNG codec round-trips, and downscales by area average', () => {
  // The route's resize is hand-rolled (no image dependency is allowed), so the
  // three primitives are asserted directly rather than trusted.
  const source = pngBytes(64, 32, [10, 20, 30, 255])
  const decoded = decodePng(source)
  assert.ok(decoded !== undefined, 'a PNG this module wrote must decode')
  assert.equal(decoded.width, 64)
  assert.equal(decoded.height, 32)
  assert.deepEqual([...decoded.pixels.subarray(0, 4)], [10, 20, 30, 255], 'the colour survives the round trip')

  const half = downscalePng(decoded, 32)
  assert.ok(half !== undefined)
  assert.equal(half.width, 32, 'the requested width is exact')
  assert.equal(half.height, 16, 'the height follows the aspect ratio')
  assert.deepEqual([...half.pixels.subarray(0, 4)], [10, 20, 30, 255], 'a flat colour is preserved exactly')

  // No upscaling, and no work for a width the image already fits.
  assert.equal(downscalePng(decoded, 64), undefined)
  assert.equal(downscalePng(decoded, 512), undefined)
  // Anything that is not a PNG is refused, not thrown on.
  assert.equal(decodePng(Buffer.from('not a png at all')), undefined)
  assert.equal(decodePng(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), undefined)
})

test('?w=512 resizes once, caches it, and serves the cache after', async () => {
  const out = await mkdtemp(join(tmpdir(), 'dsh-forge-thumb-out-'))
  const dir = await mkdtemp(join(tmpdir(), 'dsh-forge-thumb-src-'))
  try {
    await withServer(async (base) => {
      const file = join(dir, 'qwen_1024x768_1.png')
      await writeFile(file, pngBytes(1024, 768))

      const first = await get(base, `${STUDIO_FILE_ROUTE}?path=${encodeURIComponent(file)}&w=512`)
      assert.equal(first.status, 200)
      assert.equal(first.headers.get('content-type'), 'image/png')
      assert.equal(first.headers.get('x-dsh-thumb'), 'generated', 'the first request generates the thumbnail')
      const generated = Buffer.from(await first.arrayBuffer())
      const decoded = decodePng(generated)
      assert.ok(decoded !== undefined, 'the served bytes are a real PNG')
      assert.equal(decoded.width, 512, 'and it really is 512 wide')
      assert.equal(decoded.height, 384, 'height follows the 4:3 source')
      assert.ok(generated.length < (await readFile(file)).length, 'the thumbnail is smaller than the original')

      // One cache file, under <outputDir>/.dsh-image-forge/thumbs.
      const cacheDir = join(out, STUDIO_THUMB_DIR, 'thumbs')
      assert.ok(existsSync(cacheDir), `the cache directory exists at ${cacheDir}`)
      assert.equal((await readdir(cacheDir)).length, 1, 'exactly one cached resize')

      const second = await get(base, `${STUDIO_FILE_ROUTE}?path=${encodeURIComponent(file)}&w=512`)
      assert.equal(second.status, 200)
      assert.equal(second.headers.get('x-dsh-thumb'), 'cached', 'the second request is a cache hit')
      assert.deepEqual(Buffer.from(await second.arrayBuffer()), generated, 'and serves identical bytes')
      assert.equal((await readdir(cacheDir)).length, 1, 'the cache did not grow')

      // A different width is a different cache entry, not a re-resize of the first.
      const narrow = await get(base, `${STUDIO_FILE_ROUTE}?path=${encodeURIComponent(file)}&w=256`)
      assert.equal(narrow.headers.get('x-dsh-thumb'), 'generated')
      assert.equal(decodePng(Buffer.from(await narrow.arrayBuffer())).width, 256)
      assert.equal((await readdir(cacheDir)).length, 2, 'one file per requested width')
    }, out)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  }
})

test('?w= accepts only the whitelisted widths, and never upscales', async () => {
  await withServer(async (base) => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-forge-thumb-bad-'))
    try {
      const big = join(dir, 'big.png')
      await writeFile(big, pngBytes(1024, 512))
      const small = join(dir, 'small.png')
      await writeFile(small, pngBytes(100, 100))

      for (const width of ['300', '0', '-1', '9999', 'abc', '512.5']) {
        const res = await get(base, `${STUDIO_FILE_ROUTE}?path=${encodeURIComponent(big)}&w=${width}`)
        assert.equal(res.status, 400, `w=${width} is refused`)
        assert.ok((await res.json()).error.includes(String(STUDIO_THUMB_WIDTHS[0])))
      }
      // Every advertised width is accepted (the old `4` ceilings are gone).
      for (const width of STUDIO_THUMB_WIDTHS) {
        const res = await get(base, `${STUDIO_FILE_ROUTE}?path=${encodeURIComponent(big)}&w=${String(width)}`)
        assert.equal(res.status, 200, `w=${String(width)} is served`)
      }

      // A source narrower than the requested width is served as-is, and says so.
      const original = await get(base, `${STUDIO_FILE_ROUTE}?path=${encodeURIComponent(small)}&w=512`)
      assert.equal(original.status, 200)
      assert.equal(original.headers.get('x-dsh-thumb'), 'original', 'no fake upscale')
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), await readFile(small))

      // Without `w` the bytes and headers are exactly what they always were.
      const plain = await get(base, `${STUDIO_FILE_ROUTE}?path=${encodeURIComponent(big)}`)
      assert.equal(plain.headers.get('x-dsh-thumb'), null, 'the plain route is untouched')
      assert.deepEqual(Buffer.from(await plain.arrayBuffer()), await readFile(big))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

test('a non-PNG behind ?w= falls back to the original bytes', async () => {
  // JPEG/WebP decoding is out of scope without an image library (see the section
  // note in studio-routes.ts): the honest answer is the original file plus a
  // header that says so, not a 500 and not a half-decoded mess.
  await withServer(async (base) => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-forge-thumb-jpeg-'))
    try {
      const jpeg = join(dir, 'photo.jpg')
      const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00])
      await writeFile(jpeg, bytes)
      const res = await get(base, `${STUDIO_FILE_ROUTE}?path=${encodeURIComponent(jpeg)}&w=512`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'image/jpeg')
      assert.equal(res.headers.get('x-dsh-thumb'), 'original')
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
