/**
 * The plugin's **default paths**, as the settings page shows them.
 *
 * There are only two kinds left, both about the machine the plugin runs on:
 *
 * - `outputDir` is a normal user-visible pictures folder.
 * - `comfyModelsDir` is *probed*: it scans a candidate list with `existsSync`
 *   and falls back to `''` when nothing is found, which keeps the "let the tool
 *   layer phrase a generic error" path intact on an unknown box.
 *
 * Everything the plugin used to own itself — a venv, a weight cache, a worker
 * script — is gone. Generation now runs either through a cloud key or through
 * the user's own ComfyUI, and ComfyUI owns its model directory; this file only
 * tries to *name* that directory so the error messages can be specific.
 *
 * Two deliberate limits:
 *
 * - **Nothing here does network I/O.** `comfyEndpoint` stays empty on purpose:
 *   its documented meaning is "probe `comfyPorts` at call time", and opening a
 *   socket while building a config schema would be a side effect in the wrong
 *   place.
 * - **Nothing here is imported by the browser half.** `settings-fields.ts` is
 *   bundled for the browser and therefore cannot touch `node:fs`; the page
 *   learns these values from the Host, which serves the schema defaults as the
 *   form's values.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Default output directory: a normal user-visible pictures folder. */
export function defaultOutputDir(): string {
  return join(homedir(), 'Pictures', 'dsh-image-forge')
}

/**
 * Where a ComfyUI install keeps its `models` directory, most likely first.
 *
 * Conventional per-user locations only — no machine-specific entries: a
 * published plugin must not ship one author's directory layout, and a wrong
 * guess is visible (and correctable) on the settings page anyway. The
 * Linux/macOS clone and `/opt` spots are added where those platforms actually
 * put one. Ordering only decides which one wins when several exist.
 *
 * @returns candidate directories, whether or not they exist.
 */
export function comfyModelsCandidates(): readonly string[] {
  const win = process.platform === 'win32'
  const roaming = process.env.APPDATA ?? ''
  const local = process.env.LOCALAPPDATA ?? ''
  return [
    // `APPDATA` / `LOCALAPPDATA` only exist on Windows; reading them elsewhere
    // would invent a Windows-shaped path on a POSIX box.
    ...(roaming === '' || !win ? [] : [join(roaming, 'ComfyUI', 'models')]),
    ...(local === '' || !win
      ? []
      : [
          join(local, 'ComfyUI', 'models'),
          join(local, 'Programs', '@comfyorgcomfyui-electron', 'resources', 'ComfyUI', 'models'),
        ]),
    join(homedir(), 'ComfyUI', 'models'),
    join(homedir(), 'Documents', 'ComfyUI', 'models'),
    // The two locations a ComfyUI install lands in on Linux/macOS: a clone or the
    // portable build under the home directory, and the system-wide /opt copy.
    ...(win ? [] : [join(homedir(), 'comfy', 'ComfyUI', 'models'), '/opt/ComfyUI/models']),
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
