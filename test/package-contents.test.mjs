/**
 * Publish-content contract: what `npm pack` puts in the tarball.
 *
 * The authoritative check is `npm pack --dry-run --json`; it is too slow to run
 * inside the suite, so this file pins the **input** that decides the outcome —
 * the `files` whitelist — against the paths the shipped surface actually needs.
 *
 * The list of things that must ship used to include two Python helpers under
 * `resources/` (a managed worker and its pip wrapper) plus a rule keeping their
 * `__pycache__` out of the tarball. Those scripts are gone: the plugin runs no
 * local runtime of its own, so there is no Python in the package at all. The
 * assertions below therefore pin the *absence* as well as the presence — a
 * `resources/` entry coming back would mean the old path is being rebuilt.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

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

/** Runtime artefacts the plugin must ship, because the Host loads them by path. */
const SHIPPED = [
  'lib/index.js',
  'lib/client.js',
  'src/index.ts',
  'cordis.yml',
  'README.md',
  'skill.md',
  'references/t2i_rules.md',
  'references/edit_rules.md',
  'docs/comfyui-deployment.md',
  'docs/configuration.md',
  // The banner the README renders; a missing image is a broken first screen on
  // npm and GitHub both, and `docs/*.md` does not reach into a subdirectory.
  'docs/images/repo-banner.png',
]

test('every file the Host or the skill reads by path is in the tarball', () => {
  for (const filePath of SHIPPED) {
    assert.ok(
      entriesPublishing(filePath).length > 0,
      `${filePath} must stay in the tarball; none of ${JSON.stringify(packageJson.files)} selects it`,
    )
    // ...and it has to exist, or the whitelist entry selects nothing.
    assert.ok(existsSync(join(root, filePath)), `${filePath} is whitelisted but missing from the tree`)
  }
  console.log('entries publishing each shipped file:', JSON.stringify(
    Object.fromEntries(SHIPPED.map((filePath) => [filePath, entriesPublishing(filePath)])),
  ))
})

test('the deployment document is reachable through the docs glob, not by a one-off entry', () => {
  // `docs/*.md` is the rule; a new document is then picked up without editing
  // package.json. If someone narrows this to a single file, the citation in the
  // settings tab and the tool errors stops resolving after a pack.
  const entries = entriesPublishing('docs/comfyui-deployment.md')
  assert.deepEqual(entries, ['docs/*.md'])
  // The plans/ directory stays out of the tarball: it is history, not a document.
  assert.deepEqual(entriesPublishing('docs/plans/dsh-image-forge-开发计划.md'), [])
})

test('no Python ships any more: the resources directory is gone', () => {
  console.log('files entries mentioning resources:', JSON.stringify(packageJson.files.filter((entry) => entry.includes('resources'))))
  // `resources/` is not whitelisted at all, so nothing under it can be packed.
  for (const retired of [
    'resources/worker.py',
    'resources/pipwrap.py',
    'resources/__pycache__/worker.cpython-312.pyc',
  ]) {
    assert.deepEqual(entriesPublishing(retired), [], `${retired} must not be published`)
  }
  // `src` is whitelisted wholesale, so the retired modules are pinned by their
  // absence from the tree rather than by the glob — a file that is not there
  // cannot be packed.
  for (const retired of ['src/worker.ts', 'src/venv.ts', 'src/weights.ts', 'src/deploy-server.ts', 'src/local.ts', 'src/env.ts']) {
    assert.ok(!existsSync(join(root, retired)), `${retired} is back on disk`)
  }
})

/**
 * Apache-2.0 §4(a) requires a redistributor to hand every recipient the
 * License of the Work. A `files` whitelist silently drops anything not named,
 * so the vendored notice and the upstream license text must both be selected.
 */
const LICENSE_FILES = ['LICENSE', 'THIRD-PARTY/dsh-image-gen/LICENSE', 'THIRD-PARTY/README.md']

test('the files whitelist ships the project license and every vendored third-party notice', () => {
  for (const filePath of LICENSE_FILES) {
    assert.ok(
      entriesPublishing(filePath).length > 0,
      `${filePath} must stay in the tarball; none of ${JSON.stringify(packageJson.files)} selects it`,
    )
  }
  console.log('entries publishing each license file:', JSON.stringify(
    Object.fromEntries(LICENSE_FILES.map((filePath) => [filePath, entriesPublishing(filePath)])),
  ))
})
