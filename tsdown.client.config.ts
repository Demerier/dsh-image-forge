import { defineConfig } from 'tsdown'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The **browser half** is built separately from the host half, because it is a
 * different kind of artifact.
 *
 * The host loads `lib/index.js` with a plain dynamic `import()`, so that file
 * stays ordinary ESM. The web client does **not** import the browser half as a
 * module: it evaluates it and expects it to *register a lazy factory* with the
 * module loader, keyed by the package name:
 *
 * ```js
 * window.__ModuleLoader__.load({ id: '<package name>', factory: (require) => { … return module.exports } })
 * ```
 *
 * Executing the bundle therefore only registers the factory; every module-body
 * side effect lives inside the factory closure and runs at materialization. The
 * shell seeds a frozen module table (React among the baseline entries), so
 * `react` is requested through the factory's `require` and must stay external —
 * it is not bundled, and it is not listed in `dsh.client.external` either,
 * because it is part of the baseline table already.
 *
 * Plain ESM here is not a style preference, it is a silent failure: a bundle
 * with a top-level `import` registers nothing, and the client reports the entry
 * as failing to import. That is invisible to this repository's Node tests — they
 * never evaluate the browser bundle — which is exactly how it survived until the
 * plugin was first loaded in a real client.
 *
 * Two structural constraints come with the format:
 *
 * - **Single file, no relative `require`.** The loader materializes one bundle;
 *   it cannot synchronously resolve sibling `client*.js` chunks, so everything is
 *   inlined into this one file.
 * - **`id` must equal the package name** (`dsh-image-forge`), so the loader and
 *   the profile row agree on the identity.
 *
 * The output lands in `lib/` next to the host half, so `clean` stays off here —
 * the main config already cleaned that directory, and turning cleaning on would
 * delete `lib/index.js`.
 */
const CLIENT_ID = 'dsh-image-forge'

/**
 * Absolute path of the installed React Flow stylesheet.
 *
 * Resolved through `require.resolve` on the package's own manifest so the plugin
 * follows whatever the package manager actually installed (hoisted, pnpm virtual
 * store, nested) instead of assuming `node_modules/@xyflow/react`.
 */
const XYFLOW_STYLE_PATH = join(
  dirname(createRequire(import.meta.url).resolve('@xyflow/react/package.json')),
  'dist',
  'style.css',
)

/**
 * Absolute path of the module this plugin substitutes.
 *
 * `src/xyflow-styles.ts` reads that stylesheet through `node:fs` so that **Node**
 * can import it — `test/studio.test.mjs` reaches it through `client-styles.ts` via
 * type stripping, where a `virtual:` specifier or a `?raw` import would be
 * unresolvable. The browser build has no `fs`, so this hook answers for the file
 * and ships the text as a literal instead.
 */
const XYFLOW_STYLES_MODULE = join(dirname(fileURLToPath(import.meta.url)), 'src', 'xyflow-styles.ts')

/** Windows paths differ in case; compare them folded, with one separator. */
function samePath(left: string, right: string): boolean {
  return left.replace(/\\/g, '/').toLowerCase() === right.replace(/\\/g, '/').toLowerCase()
}

/**
 * Replace `src/xyflow-styles.ts` with the stylesheet as a string export.
 *
 * The client has no stylesheet hook, so the rules must travel inside the bundle;
 * and the loader materializes exactly one file, so they cannot be a sibling
 * `.js`/`.css` chunk either. Reading the file here — at build time — also means
 * the text is the CSS of the installed version, never a stale checked-in copy.
 *
 * The markup is a plain double-quoted string literal via `JSON.stringify`: the
 * sheet contains quotes, `\` escapes and `url(data:…)` payloads, and a template
 * literal would have to survive `${` sequences in raw CSS.
 *
 * `buildEnd` fails the build when the substitution never happened. Without that
 * check a mis-resolved path would leave `node:fs` in a browser artifact — a
 * broken bundle that still builds, which is the failure mode this whole file
 * exists to prevent.
 */
function inlineXyflowStyles() {
  let substituted = false
  return {
    name: 'dsh-forge:inline-xyflow-styles',
    load(id: string) {
      if (!samePath(id, XYFLOW_STYLES_MODULE)) return null
      substituted = true
      const css = readFileSync(XYFLOW_STYLE_PATH, 'utf8')
      return `export const XYFLOW_CSS = ${JSON.stringify(css)};`
    },
    buildEnd() {
      if (!substituted) {
        throw new Error(
          `inline-xyflow-styles: never saw ${XYFLOW_STYLES_MODULE} — the client bundle would keep node:fs`,
        )
      }
    },
  }
}

/**
 * Opens the factory: the shape the loader expects, byte-for-byte compatible.
 *
 * It stops short of declaring `Symbol.toStringTag` — the CJS emitter adds that
 * itself, and doing it here too would only duplicate the line.
 */
const FACTORY_OPEN = `window.__ModuleLoader__.load({
\tid: "${CLIENT_ID}",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
`

/** Closes the factory, publishing whatever the module body assigned to `exports`. */
const FACTORY_CLOSE = `\t\treturn module.exports;
\t}
});
`

export default defineConfig({
  entry: ['src/client.ts'],
  // CJS is the point: it makes the body request React through the factory's
  // `require` instead of hoisting a top-level ESM import.
  format: ['cjs'],
  // This file is evaluated in a browser, never in Node.
  platform: 'browser',
  target: 'node22',
  outDir: 'lib',
  clean: false,
  sourcemap: false,
  dts: { enabled: false },
  // React comes from the shell's baseline module table. Keep it a bare request.
  //
  // `react-dom` is listed **bare**, not just `react-dom/client`: React Flow
  // reaches for `createPortal` through `import { … } from 'react-dom'`, and a
  // list that only names the `/client` subpath lets that second copy of React DOM
  // be inlined into this bundle — two React DOM instances in one page throw on
  // every portal and every event, and the failure surfaces far from here.
  deps: {
    neverBundle: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
    // `@xyflow/react` sits in `dependencies`, which tsdown's deps plugin
    // externalizes by default; the whole point of this build is that React Flow
    // *is* the artifact's content, so it has to be opted back in explicitly.
    // Without this the bundle ships `require("@xyflow/react")` and the client
    // fails at materialization with a module the loader cannot resolve.
    alwaysBundle: ['@xyflow/react'],
  },
  plugins: [inlineXyflowStyles()],
  // React Flow (and zustand under it) branch on `process.env.NODE_ENV`. There is
  // no `process` in the browser, and the factory body runs at materialization —
  // so an unreplaced oven-ready `process.env.NODE_ENV` is an immediate
  // `ReferenceError: process is not defined` the moment the client loads this
  // module. Substituting a literal also folds the development branches away.
  define: { 'process.env.NODE_ENV': '"production"' },
  // `studio-shared.ts` is imported by both halves. Without this it becomes a
  // sibling chunk, and the loader materializes exactly one bundle — see the
  // structural constraints above. One entry, so rolldown accepts the flag.
  outputOptions: { codeSplitting: false },
  banner: FACTORY_OPEN,
  footer: FACTORY_CLOSE,
  // The package declares "type": "module", so the default CJS extension would be
  // `.cjs`; the `./client` export is `./lib/client.js` and must stay there.
  outExtensions() {
    return { js: '.js' }
  },
})
