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
  // Step 2 (the gestures) adds the marquee, the drag reducer and the keyboard
  // forwarding on top of that.
  // The ceiling remains loose. The 2026-11 interaction upgrade adds the
  // conversation result card, Better Sidebar tab, annotation editor and
  // node-anchored canvas editor. Settings 2.0 adds the shared environment and
  // recent-log console plus transactional drafts; the ceiling still guards against
  // a second canvas library or a stray d3 copy, not byte-level churn.
  assert.ok(bytes < 1_340_000, `raw bundle grew past the budget: ${bytes} B`)
  assert.ok(gzipped < 342_000, `gzipped bundle grew past the budget: ${gzipped} B`)
  // The growth is the pane, not filler: its painters, React Flow's own node
  // wrapper (component code, not just the stylesheet) and the edge builder.
  assert.ok(BUNDLE.includes('dsh-forge-flow-node'), 'the pane’s node painters must ship')
  assert.ok(BUNDLE.includes('dsh-forge-canvas-tool-dock.is-open'), 'the state-driven hover dock must ship')
  assert.ok(BUNDLE.includes('data-open'), 'the dock must expose its hover-intent state')
  assert.ok(!BUNDLE.includes('dsh-forge-canvas-tool-dock.is-closing'), 'the old pointer-events closing lockout must stay removed')
  assert.ok(BUNDLE.includes('onPointerEnter'), 'the hover dock must use pointer hysteresis, not :hover width flapping')
  assert.ok(BUNDLE.includes('.dsh-forge-flow .react-flow__node.selectable'), 'node wrapper cursor must share the frame cursor')
  assert.ok(BUNDLE.includes('cursor:grab'), 'node frames and their wrapper must agree on the grab cursor')
  assert.ok(BUNDLE.includes('react-flow__node'), 'React Flow’s node wrapper must ship')
  assert.ok(BUNDLE.includes('getBezierPath'), 'the lineage edge’s path builder must ship')
})

/**
 * U04 step 2's regression guard: the library's own key bindings must stay off.
 *
 * These four lines are the difference between "the canvas has one handler per
 * gesture" and "the canvas has two": React Flow binds `Backspace` to a delete,
 * `Shift` to a marquee and `Ctrl/Cmd`-click to a selection toggle **by default**,
 * and this canvas implements all three itself (`resolveShortcut`,
 * `marqueeWorldRect`, `toggleSelection`). The failure mode is silent — a Delete
 * that fires twice, a Shift-marquee that replaces the selection the user asked to
 * extend — so it is asserted on the shipped artifact, in the same style as the
 * packaging contract above.
 */
test('the interaction config ships with the library’s own bindings switched off', () => {
  // Read from the bundle, not from the source: this is what the browser gets.
  // U04 step 3 flipped this line: the wire *is* the library's gesture now, and a
  // handle you can see but cannot drag is the bug this used to prevent.
  assert.ok(
    BUNDLE.includes('nodesConnectable: true'),
    'nodesConnectable must be on: the wire is the gesture S3 shipped',
  )
  assert.ok(
    BUNDLE.includes('connectionDragThreshold: 4'),
    'a click on a handle must not become a wire: the threshold is the state machine’s own 4 px',
  )
  assert.ok(
    BUNDLE.includes('connectOnClick: false'),
    'click-to-connect is off: this canvas plans drags, and a click-built edge would skip the planner',
  )
  assert.ok(BUNDLE.includes('nodesDraggable: true'), 'dragging is the gesture whose positions are written back')
  for (const key of ['deleteKeyCode', 'multiSelectionKeyCode', 'selectionKeyCode']) {
    assert.ok(
      BUNDLE.includes(`${key}: null`),
      `${key} must be null: this canvas implements that gesture itself, and two handlers for one key is the bug`,
    )
  }
  assert.ok(
    BUNDLE.includes('selectionOnDrag: false'),
    'the marquee is marqueeWorldRect’s; React Flow must not draw a second one',
  )
  // Hand mode and middle-drag panning: one expression, so a later edit cannot
  // make the pane pan on left-drag and tear a marquee at the same time.
  assert.ok(BUNDLE.includes('panOnDrag: options.suppressLeftPan === true ? [1] : true'))
  // The keyboard and the drag write-back must be in the shipped bundle.
  assert.ok(BUNDLE.includes('foldDragChanges'), 'the one-commit-per-drag reducer must ship')
  assert.ok(BUNDLE.includes('marqueeWorldRect'), 'the marquee must reuse the tested screen→world conversion')
})

/**
 * U04 step 3: the wire, on the shipped artifact.
 *
 * The gesture cannot be driven here (it needs a measured viewport, pointer
 * capture and the library's own drag — see the manual list at the top of
 * `test/studio.test.mjs`), so what an artifact test *can* prove is that every
 * piece the gesture needs is in the file a browser evaluates: the three-way drop
 * planner, the preview it paints, the two engine callbacks, and the menu data
 * behind the three node kinds. A missing one of these is a dead handle in the
 * browser and nothing in `src/` would say so.
 */
test('the wire ships: planner, preview, engine callbacks and the three menu entries', () => {
  // The decision layer, whole.
  assert.ok(BUNDLE.includes('planConnectionDrop'), 'the drop planner must ship')
  assert.ok(BUNDLE.includes('judgeConnection'), 'the target rule must ship (the preview colours itself from it)')
  assert.ok(BUNDLE.includes('connectionNodesOf'), 'the hit-test takes the board’s own boxes')
  assert.ok(BUNDLE.includes('nodeUnderPoint'), 'dropping on a node is the tested hit test, not a second copy')
  assert.ok(BUNDLE.includes('reaches'), 'cycle refusal is the tested walk, not a second copy')

  // The preview: the pane paints it in container pixels (the engine's own line is
  // switched off in the sheet, because `XYHandle` mixes flow and screen space).
  assert.ok(BUNDLE.includes('dsh-forge-flow-wire'), 'the wire overlay must ship')
  assert.ok(BUNDLE.includes('data-connect-preview'), 'and must say which of the three looks it has')
  assert.ok(BUNDLE.includes('.react-flow__connectionline{display:none}'), 'the engine’s line is off')
  assert.ok(BUNDLE.includes('previewPath'), 'the preview is the committed edge’s own cubic')

  // The wiring: one callback in, one plan out, straight onto the studio's own
  // lineage/menu callbacks.
  assert.ok(BUNDLE.includes('isValidConnection,'), 'the engine must be told the validity rule')
  assert.ok(BUNDLE.includes('onConnectStart: beginEngineConnection'), 'a wire closes the cards behind it')
  assert.ok(BUNDLE.includes('onConnectEnd: endEngineConnection'), 'a release is executed by the studio')
  assert.ok(BUNDLE.includes('connectionIsValid'), 'the boolean the engine asks for ships too')

  // The three things a blank drop can become, in the shipped menu data.
  for (const label of ['图片生成', '布局', '放入素材']) {
    assert.ok(BUNDLE.includes(label), `the node-type menu must still offer ${label}`)
  }
  // And each of the three lands through the route that already exists for it:
  // the lineage/menu commands on the undo stack, the layout node's own writer,
  // and the copy verb the asset picker uses (a copy, never a move).
  for (const command of ['connect-edge', 'add-draft', 'add-layout', 'place-asset']) {
    assert.ok(BUNDLE.includes(command), `the ${command} undo step must ship`)
  }
  assert.ok(BUNDLE.includes('save-layout-node'), 'the layout branch persists through the layout writer')
  assert.ok(BUNDLE.includes('copy-item'), 'and the asset branch through the copy verb')
})
