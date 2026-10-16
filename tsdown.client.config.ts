import { defineConfig } from 'tsdown'

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
  deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom/client'] },
  banner: FACTORY_OPEN,
  footer: FACTORY_CLOSE,
  // The package declares "type": "module", so the default CJS extension would be
  // `.cjs`; the `./client` export is `./lib/client.js` and must stay there.
  outExtensions() {
    return { js: '.js' }
  },
})
