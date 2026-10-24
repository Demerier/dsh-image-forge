import { defineConfig } from 'tsdown'

/**
 * Two builds, on purpose.
 *
 * The **production** build must keep `lib/index.js` self-contained, exactly as
 * it was before the settings section existed. The web client loads the
 * `./client` entry on its own, and a client bundle that reaches out to sibling
 * files is a load-order and resolution risk the reference implementations do not
 * take either — theirs ship a single bundle too. So the shared logic modules are
 * *not* entries here: rolldown inlines them, and `test/settings.test.mjs` asserts
 * that no relative import survives in `lib/index.js` or `lib/client.js`.
 *
 * **Why the host half is its own entry set.** `src/index.ts` and `src/client.ts`
 * both import `studio-shared.ts` (route paths, body limits, wire types). With two
 * entry points in one rolldown pass, that shared module is hoisted into a
 * `lib/studio-shared-*.js` chunk and both entries import it — which breaks the
 * self-contained contract above. Rolldown only honours `codeSplitting: false`
 * for a single entry, so the host half is built in a pass of its own. Cost: the
 * constants are duplicated across the two artifacts. Benefit: each artifact is
 * one file, which is what the client loader and the tests both require.
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
    entry: ['src/index.ts'],
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
    //
    // `@deepseek-ai/dsh-llm` is the host's LLM service face. It must stay a bare
    // specifier too: the Studio borrows the conversation model through it, and it
    // is only ever reached through `ctx.get('llm')`, which is already guarded.
    // Inlining it would make every load depend on a package this plugin declares
    // as optional, turning a missing optimiser into a missing plugin.
    deps: { neverBundle: ['react', '@deepseek-ai/dsh-llm'] },
    // Keep `studio-shared.ts` inline rather than as a sibling chunk. See the
    // header note: rolldown rejects `codeSplitting: false` with multiple entries,
    // which is why this pass has exactly one.
    outputOptions: { codeSplitting: false },
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
      // Studio logic: the route parsers, the step/size resolvers and the
      // optimiser's answer-splitting are all pure, and asserting them through a
      // real socket would test the framing rather than the contract. Same reason
      // as the modules above: reachable as a standalone bundle, not as an entry
      // of the production build.
      'src/studio-routes.ts',
      'src/studio-service.ts',
      'src/studio-prompt.ts',
      // Boards: the store above a single image. Its identity/naming rules, the
      // grid fallback and the layout round-trip are asserted directly — the
      // filesystem is the contract here, so a mock would assert nothing.
      'src/boards.ts',
      // Image persistence: the free-index skip and the directory-serialised
      // write sequence are filesystem contracts, asserted on a real temp dir.
      'src/output.ts',
      // The wire constants themselves: the panel's limits and the host's must be
      // the same numbers, so the test build exposes them rather than restating
      // the values in a test file.
      'src/studio-shared.ts',
      // `studioSize` is asserted against `resolveDefaultSize` so the Studio and
      // the Agent tool cannot disagree about what "16:9" means. The ComfyUI
      // adapter's turbo graphs and sigma schedule are asserted the same way.
      'src/ratio.ts',
      'src/comfyui.ts',
      // Canvas camera maths: pure, and wrong by a factor of `zoom` in the most
      // ordinary way. Asserted directly rather than through a rendered panel.
      'src/studio-canvas.ts',
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
