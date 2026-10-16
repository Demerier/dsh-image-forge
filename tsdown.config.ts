import { defineConfig } from 'tsdown'

/**
 * Two builds, on purpose.
 *
 * The **production** build must keep `lib/index.js` and `lib/client.js`
 * self-contained, exactly as they were before the settings section existed. The
 * web client loads the `./client` entry on its own, and a client bundle that
 * reaches out to sibling files is a load-order and resolution risk the reference
 * implementations do not take either — theirs ship a single bundle too. So the
 * shared logic modules are *not* entries here: rolldown inlines them, and
 * `test/settings.test.mjs` asserts that no relative import survives in
 * `lib/client.js`.
 *
 * The **test** build emits those same logic modules as standalone bundles under
 * `testlib/`, because the settings feature's registration shape, form binding
 * and save semantics are worth asserting directly — and `lib/client.js` itself
 * cannot be imported in a test, since it imports `react`, which the web client
 * resolves and this package does not depend on. `testlib/` is a test artifact
 * and is not shipped (`package.json` `files` does not list it).
 */
export default defineConfig([
  {
    entry: ['src/index.ts', 'src/client.ts'],
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    outDir: 'lib',
    clean: true,
    sourcemap: false,
    // Runtime-only plugin loaded through `import('dsh-image-forge')`; the client
    // half is loaded by the web client. No declarations to publish.
    dts: { enabled: false },
    // The client entry renders React nodes, so React stays a bare specifier the
    // client runtime resolves — it is not a dependency of this package.
    deps: { neverBundle: ['react'] },
    // The package declares "type": "module", so plain .js output keeps the entries
    // at the conventional lib/index.js and lib/client.js paths.
    outExtensions() {
      return { js: '.js' }
    },
  },
  {
    entry: [
      'src/config-defaults.ts',
      'src/config-resolve.ts',
      'src/settings-fields.ts',
      'src/settings-section.ts',
      'src/tools.ts',
    ],
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    outDir: 'testlib',
    clean: true,
    sourcemap: false,
    dts: { enabled: false },
    outExtensions() {
      return { js: '.js' }
    },
  },
])
