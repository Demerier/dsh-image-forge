/**
 * Image persistence: the naming scheme, the free-index skip and the
 * directory-serialised write sequence. Like the boards tests, the contract is
 * the filesystem, so every case runs against a real temporary directory —
 * mocking `fs` here would assert nothing about the rename discipline.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nextFreeIndex, sanitizePrefix, writeImages } from '../testlib/output.js'

/** A fresh output directory per test. */
function makeDir() {
  return mkdtempSync(join(tmpdir(), 'forge-output-'))
}

/** One fake generated image. */
function image(bytes = [137, 80, 78, 71]) {
  return { bytes: new Uint8Array(bytes), mime: 'image/png' }
}

test('sanitizePrefix keeps ASCII names and collapses everything else', () => {
  assert.equal(sanitizePrefix('poster'), 'poster')
  assert.equal(sanitizePrefix('  my poster! '), 'my-poster')
  assert.equal(sanitizePrefix('夏日特惠'), 'qwen', 'multi-byte-only input collapses to the fallback')
  assert.equal(sanitizePrefix(undefined, 'edit'), 'edit')
  assert.equal(sanitizePrefix('x'.repeat(60)), 'x'.repeat(48), 'prefixes are capped at 48 chars')
})

test('the free index skips names already on disk under every known extension', async () => {
  const dir = makeDir()
  try {
    // A same-numbered `.jpg` blocks the index just as well as a `.png`: the
    // point is that a second call never overwrites the first result.
    for (const name of ['qwen_1248x1248_1.png', 'qwen_1248x1248_2.jpg']) {
      writeFileSync(join(dir, name), '')
    }
    assert.equal(await nextFreeIndex(dir, 'qwen', 1248, 1248), 3)
    assert.equal(await nextFreeIndex(dir, 'qwen', 1248, 1248, 2), 3, 'an explicit start still skips taken names')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeImages numbers a batch sequentially and never overwrites an older file', async () => {
  const dir = makeDir()
  try {
    const first = await writeImages(dir, 'edit', 1664, 928, [image(), image()])
    assert.deepEqual(first.map((written) => written.index), [1, 2])
    assert.ok(first.every((written) => written.path.endsWith('.png') && existsSync(written.path)))
    assert.ok(first.every((written) => !written.markdownPath.includes('\\')), 'markdown paths use forward slashes')
    const second = await writeImages(dir, 'edit', 1664, 928, [image()])
    assert.equal(second[0].index, 3, 'the second call continues after the first batch')
    assert.equal(readdirSync(dir).filter((name) => !name.includes('.partial-')).length, 3)
    // A crashed call leaves a `.partial-*` staging file behind, never a
    // half-written PNG under the final name.
    const names = readdirSync(dir)
    assert.ok(names.every((name) => name.endsWith('.png')), `no staging file may survive a completed call: ${names}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
