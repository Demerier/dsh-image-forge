/**
 * Publish-content contract: `npm pack` must not put machine-local Python
 * bytecode into the tarball.
 *
 * `resources/__pycache__/*.pyc` is emitted by whichever CPython happened to
 * import the worker (here 38267 B, 12.7% of the packed bytes), so shipping it
 * leaks a build artefact whose ABI matches no one else's interpreter.
 *
 * The authoritative check is `npm pack --dry-run --json`; it is too slow to run
 * inside the suite, so this file pins the two *inputs* that decide the outcome:
 * the `.gitignore` rules that keep the directory out of the tree, and the
 * `files` whitelist `npm pack` actually consults.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const gitignore = readFileSync(join(root, '.gitignore'), 'utf8')

/**
 * Does a `files` entry select `filePath`? npm treats an entry naming a
 * directory as "this whole subtree", and treats `*` inside a glob as not
 * crossing a path separator. That is the subset the contract needs.
 */
function selects(entry, filePath) {
  const cleaned = entry.replace(/^\.\//, '').replace(/\/+$/, '')
  if (!cleaned.includes('*')) return filePath === cleaned || filePath.startsWith(`${cleaned}/`)
  const pattern = cleaned.split('/')
  const segments = filePath.split('/')
  if (pattern.length !== segments.length) return false
  return pattern.every((part, index) => {
    if (part === '*') return segments[index].length > 0
    if (!part.includes('*')) return part === segments[index]
    const body = part.split('*').map((chunk) => chunk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')
    return new RegExp(`^${body}$`).test(segments[index])
  })
}

/** Every `files` entry that would publish the given path. */
const entriesPublishing = (filePath) => packageJson.files.filter((entry) => selects(entry, filePath))

const WORKER_SCRIPTS = ['resources/worker.py', 'resources/pipwrap.py']
const BYTECODE = 'resources/__pycache__/worker.cpython-312.pyc'

test('the files whitelist narrows resources instead of naming the directory', () => {
  // A bare `"resources"` entry publishes the subtree — including __pycache__.
  const bare = packageJson.files.filter((entry) => /^\.?\/?resources\/?$/.test(entry))
  console.log('files entries naming resources wholesale:', JSON.stringify(bare))
  console.log('files entries mentioning resources:', JSON.stringify(packageJson.files.filter((entry) => entry.includes('resources'))))
  assert.deepEqual(bare, [], 'resources must be narrowed to a pattern (e.g. "resources/*.py"), not named as a directory')
})

test('the files whitelist ships both worker scripts and never Python bytecode', () => {
  for (const script of WORKER_SCRIPTS) {
    assert.ok(
      entriesPublishing(script).length > 0,
      `${script} must stay in the tarball; none of ${JSON.stringify(packageJson.files)} selects it`,
    )
  }
  console.log('entries publishing each worker script:', JSON.stringify(
    Object.fromEntries(WORKER_SCRIPTS.map((script) => [script, entriesPublishing(script)])),
  ))
  assert.deepEqual(entriesPublishing(BYTECODE), [], `${BYTECODE} must not be published`)
  // The rule has to be the shape of the pattern, not one hard-coded filename.
  assert.deepEqual(entriesPublishing('resources/__pycache__/worker.cpython-311.pyc'), [])
  assert.deepEqual(entriesPublishing('resources/__pycache__/pipwrap.cpython-313.pyc'), [])
})

test('.gitignore ignores Python bytecode directories and files', () => {
  const rules = gitignore.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'))
  console.log('.gitignore rules:', JSON.stringify(rules))
  // Trailing slash or not is the same ignore semantics for a directory; the
  // contract is the pattern, not the spelling.
  assert.ok(rules.includes('__pycache__/') || rules.includes('__pycache__'), '__pycache__ must be ignored')
  assert.ok(rules.includes('*.pyc'), '*.pyc must be ignored')
})
