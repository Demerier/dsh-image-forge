/**
 * React for the preview page — dev only, never shipped.
 *
 * The panel's bundle is a CJS factory that asks the host's module table for
 * `react`, `react/jsx-runtime`, `react-dom` and `react-dom/client`. A plain
 * browser has no such table, and this machine has no reliable internet for a CDN
 * build, so the preview serves the **installed** React 19 CommonJS files, each
 * wrapped in a tiny `define(name, factory)` shim that mirrors the host's module
 * table. No bundler, no download, and the version under test is the one
 * `node_modules` actually holds.
 *
 * The shim (`window.__define` / `window.__require`, installed by the page before
 * these scripts run) resolves a module name to the first definition and caches
 * its exports — the same single-instance guarantee the host gives, which React
 * DOM needs (two copies of it throw on every portal).
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const require_ = createRequire(import.meta.url)

/** Module name a bundle may ask for → the CJS file that answers it. */
const MODULES = {
  react: 'react/cjs/react.production.js',
  'react/jsx-runtime': 'react/cjs/react-jsx-runtime.production.js',
  'react-dom': 'react-dom/cjs/react-dom.production.js',
  'react-dom/client': 'react-dom/cjs/react-dom-client.production.js',
  scheduler: 'scheduler/cjs/scheduler.production.js',
}

/** Package name behind a module specifier (`react-dom/client` → `react-dom`). */
function packageOf(specifier) {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
}

/** Absolute path of one module's CJS file, resolved through its own manifest. */
function fileOf(specifier) {
  const packageName = packageOf(specifier)
  const relative = MODULES[specifier]
  const manifest = require_.resolve(`${packageName}/package.json`)
  return join(dirname(manifest), relative.slice(packageName.length + 1))
}

/**
 * Body of one `/vendor/<id>.js` response.
 *
 * @param {string} specifier - the module name the bundle asks for.
 * @returns {string} JavaScript that registers that module's factory.
 */
export function vendorScript(specifier) {
  const source = readFileSync(fileOf(specifier), 'utf8')
  // A literal `</script` inside the file would end the inline script early.
  const safe = source.replace(/<\/script/gi, '<\\/script')
  return `window.__define(${JSON.stringify(specifier)}, function (module, exports, require) {\n${safe}\n});\n`
}

/** Every module name this preview can serve, for the page's script tags. */
export const VENDOR_MODULES = Object.keys(MODULES)

/** URL path of one vendor script. */
export function vendorPath(specifier) {
  return `/vendor/${specifier.replace(/[^A-Za-z0-9]+/g, '-')}.js`
}

/** Which specifier a `/vendor/<…>.js` path names, or undefined. */
export function vendorSpecifierOf(pathname) {
  for (const specifier of VENDOR_MODULES) {
    if (vendorPath(specifier) === pathname) return specifier
  }
  return undefined
}
