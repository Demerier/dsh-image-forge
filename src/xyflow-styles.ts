/**
 * React Flow's own stylesheet, carried into the client half as **text**.
 *
 * The web client gives plugins exactly one styling hook — a `<style>` element
 * created from inside the lazy factory (see `injectClientStyles`) — and the
 * loader materializes a single bundle, so a sibling `.css` file, or a link tag
 * the Host would have to resolve, is unreachable at runtime. The rules therefore
 * have to travel *inside* `lib/client.js`, which is what this module provides:
 * {@link XYFLOW_CSS} is the upstream `@xyflow/react/dist/style.css` file verbatim,
 * and `CLIENT_CSS` appends it after the plugin's own sheet.
 *
 * **This module has two readers, and the client build is not one of them.**
 *
 * - To the bundler, `tsdown.client.config.ts` *replaces* this file: its `load`
 *   hook answers with `export const XYFLOW_CSS = "<installed stylesheet>"`, so the
 *   browser artifact contains the text and neither `node:fs` nor a file path.
 *   The substitute is generated at build time, so a `@xyflow/react` bump cannot
 *   leave a stale copy behind.
 * - To Node, the body below runs for real: `test/studio.test.mjs` imports
 *   `STUDIO_CSS` from `client-styles.ts` through type stripping, and that import
 *   chain reaches this file. A `virtual:` specifier or a `.css?raw` import would
 *   be unresolvable there — this is why the read is ordinary Node code instead.
 *
 * The two readers must agree on the text, which the bundle-contract test pins:
 * `.react-flow__pane` has to survive into `lib/client.js`.
 *
 * React Flow's class names are `react-flow__*`; they are global by design, and
 * the sheet only styles the subtree the pane renders, which is why these rules do
 * not take the plugin's `dsh-forge-` prefix. The pane itself is not mounted yet —
 * this step wires the packaging.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * Absolute path of the installed React Flow stylesheet.
 *
 * Resolved through the package's own manifest so it follows whatever the package
 * manager actually installed (hoisted, pnpm virtual store, nested) instead of
 * assuming `node_modules/@xyflow/react`.
 */
const XYFLOW_STYLE_PATH = join(
  dirname(createRequire(import.meta.url).resolve('@xyflow/react/package.json')),
  'dist',
  'style.css',
)

/**
 * Upstream `@xyflow/react/dist/style.css` as text.
 *
 * In the client bundle this is a literal produced by the build (see the module
 * comment); in Node it is the file itself, read once at import time.
 */
export const XYFLOW_CSS: string = readFileSync(XYFLOW_STYLE_PATH, 'utf8')
