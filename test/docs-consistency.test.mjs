import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DOCS = join(ROOT, 'docs')
const read = (path) => readFileSync(join(ROOT, path), 'utf8')
const packageJson = JSON.parse(read('package.json'))
const readme = read('README.md')

const docsFiles = readdirSync(DOCS)
  .filter((name) => name.endsWith('.md'))
  .map((name) => `docs/${name}`)
  .sort()

function linkTargets(text) {
  const withoutCode = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
  return [...withoutCode.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1].trim().replace(/^<|>$/g, ''))
    .filter((target) => {
      if (target.length === 0 || target.startsWith('#')) return false
      if (/^(?:https?:|mailto:|data:|file:)/i.test(target)) return false
      if (target.startsWith('//')) return false
      return true
    })
    .map((target) => target.split('#', 1)[0])
    .filter((target) => target.length > 0)
}

function walk(dir, suffix) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${dir}/${entry.name}`
    if (entry.isDirectory()) return walk(relative, suffix)
    return entry.name.endsWith(suffix) ? [relative] : []
  })
}

test('README is the public document index and every public doc is packaged', () => {
  assert.ok(docsFiles.length > 0)
  for (const file of docsFiles) {
    assert.ok(readme.includes(file), `${file} must be referenced by README.md`)
    assert.ok(packageJson.files.includes(file), `${file} must be explicitly listed in package.json.files`)
  }
})

test('the package version has a release note and README link', () => {
  const releaseNote = `docs/release-notes-${packageJson.version}.md`
  assert.ok(existsSync(join(ROOT, releaseNote)), `${releaseNote} must exist for package version ${packageJson.version}`)
  assert.ok(readme.includes(releaseNote), `README must link ${releaseNote}`)
  assert.ok(packageJson.files.includes(releaseNote), `${releaseNote} must be shipped`)
})

test('every Config schema field is documented and counted consistently', () => {
  const source = read('src/index.ts')
  const start = source.indexOf('export const Config = Schema.object({')
  const end = source.indexOf('\n})', start)
  assert.ok(start >= 0 && end > start, 'Config schema block must be locatable')

  const block = source.slice(start, end)
  const keys = [...block.matchAll(/\n  ([A-Za-z_][A-Za-z0-9_]*): Schema\./g)].map((match) => match[1])
  assert.ok(keys.length >= 10, 'Config schema should contain every runtime field')
  assert.equal(new Set(keys).size, keys.length, 'Config keys must be unique')

  const configDoc = read('docs/configuration.md')
  assert.match(readme, new RegExp(`${String(keys.length)} 个配置字段`), `README must report ${String(keys.length)} config fields`)
  assert.match(configDoc, new RegExp(`一共 ${String(keys.length)} 个字段`), `configuration.md must report ${String(keys.length)} fields`)
  for (const key of keys) {
    assert.ok(configDoc.includes('| `' + key + '` |'), `configuration.md table is missing ${key}`)
  }
})

test('README and docs only link to files that exist', () => {
  const markdown = [
    { path: 'README.md', text: readme },
    ...docsFiles.map((path) => ({ path, text: read(path) })),
  ]
  for (const { path, text } of markdown) {
    for (const target of linkTargets(text)) {
      const resolved = resolve(ROOT, dirname(path), target)
      assert.ok(existsSync(resolved), `${path} links to missing ${target}`)
    }
  }
})

test('source comments do not point at removed public docs', () => {
  for (const file of walk('src', '.ts')) {
    const text = read(file)
    for (const match of text.matchAll(/docs\/[A-Za-z0-9._/-]+\.md/g)) {
      const target = match[0]
      assert.ok(existsSync(join(ROOT, target)), `${file} references missing ${target}`)
    }
  }
})
