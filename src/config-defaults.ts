/**
 * The plugin's **default paths**, as the settings page shows them.
 *
 * These exist because an empty text box is not an answer. Eight config fields
 * used to default to `''` and resolve to something concrete only deep inside the
 * tool layer, so the settings page showed a blank where the plugin was in fact
 * using a specific interpreter, a specific weight directory and a specific
 * ComfyUI models root. A user reading the page could not tell what would happen.
 *
 * So the defaults here are the *resolved* values:
 *
 * - **Derived** ones (`pythonPath`, `modelsDir`, `workerScript`) are pure string
 *   arithmetic over the runtime directory and the package location — no I/O, and
 *   identical to what the tool layer derives from an empty field, so baking them
 *   as defaults cannot change behaviour.
 * - **Probed** ones (`basePython`, `comfyModelsDir`) scan a candidate list with
 *   `existsSync` and fall back to `''` when nothing is found, which keeps the
 *   original "let the tool layer figure it out" path intact on an unknown box.
 *
 * Two deliberate limits:
 *
 * - **Nothing here does network I/O.** `comfyEndpoint` stays empty on purpose:
 *   its documented meaning is "probe `comfyPorts` at call time", and opening a
 *   socket while building a config schema would be a side effect in the wrong
 *   place. Its hint states the ports instead.
 * - **Nothing here is imported by the browser half.** `settings-fields.ts` is
 *   bundled for the browser and therefore cannot touch `node:fs`; the page learns
 *   these values from the Host, which serves the schema defaults as the form's
 *   values.
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { venvPaths } from './venv.ts'
import { resourcePath } from './tools.ts'

/** Default output directory: a normal user-visible pictures folder. */
export function defaultOutputDir(): string {
  return join(homedir(), 'Pictures', 'dsh-image-forge')
}

/** Default home for the plugin-owned runtime (venv, weights, logs). */
export function defaultRuntimeDir(): string {
  return join(homedir(), '.dsh-image-forge')
}

/**
 * The weight directory the tool layer derives for a runtime directory.
 *
 * @param runtimeDir - plugin-owned data directory.
 * @returns the absolute weight path.
 */
export function defaultModelsDir(runtimeDir: string): string {
  return join(runtimeDir, 'models', 'qwen-image-2.1-bnb4bit')
}

/**
 * The interpreter inside the venv the plugin builds.
 *
 * @param runtimeDir - plugin-owned data directory.
 * @returns the absolute interpreter path, whether or not it exists yet.
 */
export function defaultPythonPath(runtimeDir: string): string {
  return venvPaths(runtimeDir).python
}

/**
 * The worker script shipped beside this package.
 *
 * @returns the absolute path to `resources/worker.py`.
 */
export function defaultWorkerScript(): string {
  return resourcePath('resources/worker.py')
}

/**
 * Look for one of several executable names across `PATH`, in order.
 *
 * @param names - file names to try, all of them in each directory before moving on.
 * @returns the first existing absolute path, or `''`.
 */
function searchPath(names: readonly string[]): string {
  const raw = process.env.PATH
  if (raw === undefined || raw === '') return ''
  for (const dir of raw.split(delimiter)) {
    if (dir.length === 0) continue
    for (const name of names) {
      const candidate = join(dir, name)
      try {
        if (existsSync(candidate)) return candidate
      } catch {
        // An unreadable PATH entry is not a finding; keep looking.
      }
    }
  }
  return ''
}

/**
 * Look for a CPython install in the platform's usual locations.
 *
 * The installer's default `Python3xx` layout is what this scans for; anything
 * else would need a real registry or launcher query, which is out of proportion
 * for a default value the user can overwrite.
 *
 * @returns the first existing interpreter path, or `''`.
 */
function searchPythonRoots(): string {
  const roots =
    process.platform === 'win32'
      ? [join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python'), join(process.env.ProgramFiles ?? '', 'Python')]
      : ['/usr/local/bin', '/usr/bin']
  for (const root of roots) {
    if (root.length === 0) continue
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const entry of entries.filter((name) => /^Python3/i.test(name)).sort()) {
      const candidate = join(root, entry, 'python.exe')
      try {
        if (existsSync(candidate)) return candidate
      } catch {
        // Same reasoning as above.
      }
    }
  }
  return ''
}

/**
 * Find a base interpreter for `action:"install"` to build the venv from.
 *
 * A real interpreter is preferred over the `py` launcher, and a `PATH` hit over
 * a scanned install root, so the value is the most directly usable one.
 *
 * @returns an absolute interpreter path, or `''` when none is found — which
 *   leaves the tool layer's own `python` / `python3` / `py` fallback in charge.
 */
export function probeBasePython(): string {
  const win = process.platform === 'win32'
  const interpreters = win ? ['python.exe', 'python3.exe'] : ['python3', 'python']
  const launcher = win ? ['py.exe'] : []
  return searchPath(interpreters) || (launcher.length > 0 ? searchPath(launcher) : '') || searchPythonRoots()
}

/**
 * Where a ComfyUI install keeps its `models` directory, most likely first.
 *
 * The two `D:\Comfy-Desktop\…` entries are the layout the ComfyUI Desktop
 * installer produces on this machine and were confirmed present; the rest are
 * the conventional per-user locations. Ordering only decides which one wins when
 * several exist, and the value is shown on the settings page so a wrong pick is
 * visible and correctable.
 *
 * @returns candidate directories, whether or not they exist.
 */
export function comfyModelsCandidates(): readonly string[] {
  const roaming = process.env.APPDATA ?? ''
  const local = process.env.LOCALAPPDATA ?? ''
  return [
    'D:\\Comfy-Desktop\\ComfyUI-Shared\\models',
    'D:\\Comfy-Desktop\\ComfyUI-Installs\\ComfyUI\\ComfyUI\\models',
    ...(roaming === '' ? [] : [join(roaming, 'ComfyUI', 'models')]),
    ...(local === ''
      ? []
      : [
          join(local, 'ComfyUI', 'models'),
          join(local, 'Programs', '@comfyorgcomfyui-electron', 'resources', 'ComfyUI', 'models'),
        ]),
    join(homedir(), 'ComfyUI', 'models'),
    join(homedir(), 'Documents', 'ComfyUI', 'models'),
  ]
}

/**
 * Find the ComfyUI models root, for phrasing "put the file in …" errors.
 *
 * @returns the first candidate that exists, or `''` when none does — which keeps
 *   the error messages generic rather than naming a directory that is not there.
 */
export function probeComfyModelsDir(): string {
  for (const candidate of comfyModelsCandidates()) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // Keep looking.
    }
  }
  return ''
}
