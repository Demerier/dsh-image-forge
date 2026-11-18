/**
 * U04 — the packaging contract for `@xyflow/react`.
 *
 * React Flow is *not* a module the web loader can resolve at runtime: the client
 * half is one CJS bundle evaluated inside a lazy factory, and the only modules it
 * may request are the ones the shell already seeds (React among them). So the
 * library has to be **inlined**, and three specific ways of getting that wrong
 * all produce a bundle that builds, packs, and then fails only in a browser:
 *
 * 1. `alwaysBundle` missing → tsdown's deps plugin externalizes everything in
 *    `dependencies`, and the bundle keeps `require("@xyflow/react")`.
 * 2. `define: { 'process.env.NODE_ENV': … }` missing → zustand/React Flow branch
 *    on it at materialization, where there is no `process` in a browser.
 * 3. `neverBundle` missing bare `react-dom` → React Flow's
 *    `import { createPortal } from 'react-dom'` pulls in a second React DOM,
 *    which then fights the shell's instance over portals and events.
 *
 * Step 1a wired the packaging and shipped only the stylesheet; **step 1b is the
 * real import**: `src/canvas-pane.ts` renders `<ReactFlow>`, so the component
 * code is in the bundle and these assertions bite for real — the bare-require
 * check is no longer satisfied by construction.
 *
 * One more contract belongs here now that the library ships: **it must stay a
 * devDependency.** It is inlined at build time, so a downstream install of this
 * package has no use for it; leaving it in `dependencies` would make every
 * profile that installs the plugin download a ~2 MB copy nothing imports. The
 * build reads it from `node_modules` at build time, which is exactly what a
 * devDependency is for.
 *
 * This file reads files only — it does not evaluate the bundle (that needs a
 * browser-shaped module loader; see `test/harness.mjs`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const fromRoot = (relative) => fileURLToPath(new URL(`../${relative}`, import.meta.url))
const read = (relative) => readFileSync(fromRoot(relative), 'utf8')

/** The built browser half — the artifact every assertion here is about. */
const BUNDLE = read('lib/client.js')
/** The build that produces it; three of the four knobs live here. */
const CLIENT_BUILD = read('tsdown.client.config.ts')
const MANIFEST = JSON.parse(read('package.json'))
const INSTALLED = JSON.parse(read('node_modules/@xyflow/react/package.json'))

/** Non-overlapping occurrence count; `indexOf` so no regex escaping is needed. */
function count(haystack, needle) {
  let seen = 0
  let at = 0
  while ((at = haystack.indexOf(needle, at)) >= 0) {
    seen += 1
    at += needle.length
  }
  return seen
}

/**
 * The string entries of `key: [ … ]` in the client build config.
 *
 * Read as text rather than importing the config: the config is TypeScript, and a
 * build that silently *dropped* one of these entries is exactly the failure this
 * file exists to catch — parsing the literal keeps that visible.
 */
function configList(key) {
  const match = new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`).exec(CLIENT_BUILD)
  assert.ok(match, `${key}: [ … ] is missing from tsdown.client.config.ts`)
  return match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
}

test('React Flow is a build-time dependency, the 12 line, and it is inline', () => {
  const declared = MANIFEST.devDependencies?.['@xyflow/react']
  assert.ok(declared, '@xyflow/react must be a devDependency: the artifact inlines it, so a profile installing this package must not download it')
  assert.equal(MANIFEST.dependencies?.['@xyflow/react'], undefined, 'and it must not reappear in dependencies')
  assert.match(declared, /^\^12\./, `expected a ^12.x range, got ${declared}`)
  assert.equal(INSTALLED.version.split('.')[0], '12', 'the installed copy must be the 12 line')
  // A range that no longer contains the installed copy means the build and the
  // lockfile disagree about what got inlined.
  assert.ok(declared.includes(INSTALLED.version), `${declared} must contain ${INSTALLED.version}`)
})

test('React Flow’s stylesheet is inlined as text and joined into CLIENT_CSS', () => {
  // The upstream file's own first line: proof the build read the *installed*
  // stylesheet rather than shipping a stub or a checked-in copy.
  assert.ok(
    BUNDLE.includes('const XYFLOW_CSS = "/* this gets exported as style.css'),
    'XYFLOW_CSS is not a string literal holding the upstream stylesheet',
  )
  // …and proof it reaches the sheet the factory injects: CLIENT_CSS interpolates
  // the constant, so a user gets the rules with no second request.
  assert.equal(count(BUNDLE, '${XYFLOW_CSS}'), 1, 'CLIENT_CSS must interpolate XYFLOW_CSS')
  // Marker rules — the ones a pane cannot render without.
  assert.ok(BUNDLE.includes('.react-flow__pane'), 'the pane rule is missing from the bundle')
  assert.ok(
    BUNDLE.includes('--xy-edge-stroke-default'),
    'the theme custom properties are missing from the bundle',
  )
})

test('the stylesheet stays inline: no link tag, no .css file, no css import', () => {
  assert.equal(count(BUNDLE, '<link'), 0, 'the bundle must not emit a link element')
  assert.equal(count(BUNDLE, 'rel="stylesheet"'), 0, 'the bundle must not emit a stylesheet link')
  // A css module reference would be a request the loader cannot satisfy: it
  // materializes one file and ships no asset table.
  assert.equal((BUNDLE.match(/require\(["'][^"']*\.css["']\)/g) ?? []).length, 0)
  assert.equal((BUNDLE.match(/import\(["'][^"']*\.css["']\)/g) ?? []).length, 0)
  // And nothing may be emitted beside the bundle either.
  const stylesheets = readdirSync(fromRoot('lib')).filter((name) => name.endsWith('.css'))
  assert.deepEqual(stylesheets, [], 'lib/ must not contain a second, unloadable stylesheet')
})

test('React Flow is bundled, not left as a bare require', () => {
  // The loader only seeds React; anything else has to be inlined.
  assert.equal(count(BUNDLE, 'require("@xyflow/react")'), 0, 'React Flow must not be externalized')
  assert.equal(count(BUNDLE, 'require("@xyflow/system")'), 0, '@xyflow/system must not be externalized')
  assert.equal(count(BUNDLE, "require('@xyflow/react')"), 0)
  const alwaysBundle = configList('alwaysBundle')
  assert.ok(
    alwaysBundle.includes('@xyflow/react'),
    'deps.alwaysBundle must opt @xyflow/react back into the bundle (it is a devDependency, and the deps plugin still tracks it)',
  )
})

test('there is exactly one React DOM: the shell’s', () => {
  // Judgement: React DOM's implementation is identifiable by its internal export
  // names (`__SECRET_INTERNALS_DO_NOT_USE_*` / `__DOM_INTERNALS_DO_NOT_USE_*`),
  // which no externalized reference can produce — a second copy inlined here
  // would introduce them. Conversely the only legitimate shape of a react-dom
  // reference is a bare `require`, served by the host module table.
  assert.equal(count(BUNDLE, '__SECRET_INTERNALS_DO_NOT_USE'), 0, 'a React DOM copy was inlined')
  assert.equal(count(BUNDLE, '__DOM_INTERNALS_DO_NOT_USE'), 0, 'a React DOM copy was inlined')
  const references = [...BUNDLE.matchAll(/require\(["'](react-dom[^"']*)["']\)/g)].map((m) => m[1])
  for (const reference of references) {
    assert.ok(
      reference === 'react-dom' || reference === 'react-dom/client',
      `unexpected react-dom request: ${reference}`,
    )
  }
  const neverBundle = configList('neverBundle')
  // Bare, not just the `/client` subpath: React Flow portals through `react-dom`.
  assert.ok(neverBundle.includes('react-dom'), 'deps.neverBundle must list bare react-dom')
  assert.ok(neverBundle.includes('react-dom/client'))
  assert.ok(neverBundle.includes('react'), 'react itself must stay external too')
})

test('process.env.NODE_ENV is substituted at build time', () => {
  // A browser has no `process`, and the factory body runs at materialization, so
  // an unreplaced read is `ReferenceError: process is not defined` on load.
  // Substitution leaves the token nowhere at all — neither in the `process.env`
  // form nor as a folded comparison.
  assert.equal(count(BUNDLE, 'NODE_ENV'), 0, 'NODE_ENV survived the build unreplaced')
  const define = /define\s*:\s*\{([^}]*)\}/.exec(CLIENT_BUILD)
  assert.ok(define, 'the client build must declare a `define` map')
  assert.match(
    define[1],
    /'process\.env\.NODE_ENV'\s*:\s*'"production"'/,
    "define must map process.env.NODE_ENV to the \"production\" literal",
  )
})

test('the factory requests nothing the shell does not seed', () => {
  // The loader's module table is a closed set (React and its DOM, which the
  // plugin does not bundle). A new bare request — a polyfill, a Node builtin, a
  // subpath — fails at materialization in the browser, long after this build.
  const references = [...new Set([...BUNDLE.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]))].sort()
  assert.deepEqual(references, ['react', 'react-dom', 'react/jsx-runtime'])
})

test('the artifact stays inside the size budget the pane was measured at', (t) => {
  const bytes = Buffer.byteLength(BUNDLE)
  const gzipped = gzipSync(BUNDLE).length
  t.diagnostic(`lib/client.js ${bytes} B, ${gzipped} B gzip`)
  // Measured at U04 step 1b, React Flow 12.12.1 inlined: 833,700 B raw and
  // 218,636 B gzip (the CSS-only step 1a artifact was 409,772 B / 108,342 B).
  // The ceiling is deliberately loose — roughly +32 % raw and +37 % gzip — because
  // what it guards against is a *second* canvas library or a stray d3 copy being
  // pulled into a bundle the client evaluates on every page load, not a byte
  // budget an upstream patch release should be able to trip.
  assert.ok(bytes < 1_100_000, `raw bundle grew past the budget: ${bytes} B`)
  assert.ok(gzipped < 300_000, `gzipped bundle grew past the budget: ${gzipped} B`)
  // The growth is the pane, not filler: its painters, React Flow's own node
  // wrapper (component code, not just the stylesheet) and the edge builder.
  assert.ok(BUNDLE.includes('dsh-forge-flow-node'), 'the pane’s node painters must ship')
  assert.ok(BUNDLE.includes('react-flow__node'), 'React Flow’s node wrapper must ship')
  assert.ok(BUNDLE.includes('getBezierPath'), 'the lineage edge’s path builder must ship')
})
