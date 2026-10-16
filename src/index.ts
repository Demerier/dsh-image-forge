import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  defaultOutputDir,
  defaultRuntimeDir,
  defaultWorkerScript,
  probeBasePython,
  probeComfyModelsDir,
} from './config-defaults.ts'
import {
  resolveConfigFields,
  schemaDefaults,
  type ConfigField,
  type ConfigRecord,
} from './config-resolve.ts'
import { registerImageForgeSkill } from './skill.ts'
import { registerImageForgeTools } from './tools.ts'

/** Registration name inside the cordis context. */
export const name = 'dsh-image-forge'

/** Services this plugin needs before `apply` runs. */
export const inject = ['tools', 'skills']

/** Plugin configuration as written in the DSH profile. */
export interface Config {
  /** Backend policy: `auto` prefers the cloud API when a key exists, else the local ComfyUI, else the worker. */
  backend: 'auto' | 'api' | 'local' | 'comfyui'
  /** Cloud endpoint origin, e.g. `https://dashscope.aliyuncs.com/compatible-mode/v1`. */
  apiBaseUrl: string
  /**
   * Bring-your-own API key. Prefer the environment over this field so the key
   * never lands in the profile file; this plugin never writes it anywhere.
   */
  apiKey: string
  /** Model id sent to the cloud endpoint. */
  apiModel: string
  /** Wire format: `openai` (implemented) or `dashscope` (declared, unimplemented in v0.1). */
  apiStyle: 'openai' | 'dashscope'
  /** Directory generated PNGs are written to. */
  outputDir: string
  /** Cooperative per-call budget for one generation, in milliseconds. */
  timeoutMs: number
  /** Origin of the local inference worker, e.g. `http://127.0.0.1:8399`. */
  localEndpoint: string
  /**
   * ComfyUI origin, e.g. `http://127.0.0.1:8188`. Empty means "probe
   * `comfyPorts` on 127.0.0.1"; a non-loopback value is refused at call time,
   * because this backend only ever talks to this machine.
   */
  comfyEndpoint: string
  /** Candidate ComfyUI ports tried when `comfyEndpoint` is empty. */
  comfyPorts: string
  /**
   * Where ComfyUI keeps its models, used only to phrase "put the file in …"
   * errors. Empty keeps the message generic instead of guessing a path.
   */
  comfyModelsDir: string
  /** Plugin-owned data directory: the venv, the weights, worker logs, breadcrumbs. */
  runtimeDir: string
  /** Weight directory. Empty resolves to `<runtimeDir>/models/qwen-image-2.1-bnb4bit`. */
  modelsDir: string
  /** Hugging Face repo the nf4 weights come from. */
  modelRepo: string
  /**
   * Mirror host for downloads. Never point this at `huggingface.co`: its root
   * answers but `/api/` times out on this box, so the download stalls.
   */
  hfMirror: string
  /** Candidate worker ports: `8399-8410`, or a list. The `localEndpoint` port is tried first. */
  workerPorts: string
  /** How long a cold worker start (loading 10.6 GiB of weights) may take. */
  workerStartTimeoutMs: number
  /** Idle milliseconds after which the worker hands its VRAM back; 0 disables it. */
  idleUnloadMs: number
  /** Let the plugin start/restart the worker process itself. */
  manageWorker: boolean
  /** Interpreter that runs the worker; empty uses `<runtimeDir>/venv`. */
  pythonPath: string
  /** Worker script; empty uses the shipped `resources/worker.py`. */
  workerScript: string
  /** Base interpreter `action:"install"` builds the venv from; empty tries `python`/`python3`/`py`. */
  basePython: string
  /** CUDA wheel tags tried in order by `action:"install"`; empty uses `cu128,cu126,cu118`. */
  torchWheels: string
  /** Index URL for the non-torch packages (an internal mirror, when configured). */
  pipIndexUrl: string
  /** Reuse a CUDA torch already installed in the base interpreter instead of downloading one. */
  reuseBaseTorch: boolean
  /** Free-VRAM floor below which `status` warns that a 2K generation will not fit. */
  minFreeVramMiB: number
  /**
   * Explicit opt-in: ask ComfyUI to unload its models (`POST /free`) when the
   * pre-start VRAM gate finds no room for the local worker.
   *
   * Default **false** — unloading another program's models is a side effect the
   * plugin does not take on its own; the default path reports the command instead.
   */
  freeComfyBeforeLocalStart: boolean
  /**
   * Explicit opt-in: let a **local** edit run with a reference-conditioning budget
   * above the reliable ceiling the size gate enforces.
   *
   * Default **false** — over `960` the local edit path has measured hard failures
   * on the card class this plugin targets (access violation in the CPU text-encode
   * stage, sometimes taking the worker process with it), so the gate refuses by
   * default and this flag is how a caller says "I know". Only the local backend
   * reads it: `comfyui` is never gated and `api` has no edit path at all.
   */
  allowLocalEditOverBudget: boolean
  /**
   * Reference-conditioning budget for the **local** edit path, in pixels per side:
   * the side length the worker resizes every reference image (and the condition
   * latents) to. **`0` — the default — derives it from the canvas**, which is what
   * the worker does on its own and what every earlier release did.
   *
   * A positive value is sent to the worker as `reference_budget` and is what the
   * size gate bands against, so `512` makes a 1248×1248 canvas (derived budget
   * 1248, today refused) run as a 512 edit. The trade is **speed and runnability
   * for reference fidelity**: §19 measured 992 → 512 as encode 37.7 → 16.5 s and
   * 3.4 → 1.67 s per step (≈2×), and **512 is the only budget measured to finish
   * on a 1.5 MP canvas** (1248×1248: 109.5 s, peak reserved 6488 MiB) — the same
   * canvas at 896 measured 67 s/step, ≈28 min for 25 steps, with no error
   * (`docs/evidence/r5-budget-canvas-matrix.md`). The fidelity half is a 1-image, 1-judge comparison: on the
   * same 1216×672 canvas 896 vs 512 was judged indistinguishable (n=1), and only
   * 512 has been run on a 1.5 MP canvas. Only `local` reads it; `comfyui` scales
   * references on its own and `api` has no edit path.
   */
  localReferenceBudget: number
  /** Default for `fetch-weights`: drop the unused `lm_head.weight` tensor. */
  skipLmHead: boolean
  /**
   * Sampler steps used when neither the caller nor a backend-specific override
   * picks one. Default **25**, the official ComfyUI 2.1 template's count — not
   * the 40 of the diffusers pipeline, and not the 8 the worker used to fall back
   * to.
   *
   * Measured: 25 → 50 does **not** add detail (lapvar 1019 → 970, hf_frac
   * 0.0317 → 0.0279), so more steps is not the lever for sharpness — canvas size
   * is. The knob stays configurable; only the default and the docs follow this.
   */
  defaultSteps: number
  /**
   * ComfyUI steps; `undefined` (the default) means "use `defaultSteps`".
   *
   * One of the three resolution inputs, because the two backends historically
   * disagreed — so switching backend silently changed the picture.
   */
  comfyuiSteps: number | undefined
  /**
   * Local worker steps; `undefined` (the default) means "use `defaultSteps`".
   *
   * The worker's own fallback is 25, but the plugin always sends a resolved
   * count explicitly, so this is what actually decides a local render.
   */
  localSteps: number | undefined
}

/**
 * The config as it reaches {@link apply}: every field is a volatile reference
 * on a Host activation, a plain value in a profile patch or a test.
 */
export type ConfigFields = { [K in keyof Config]?: ConfigField<Config[K]> }

/**
 * Plugin config schema — and, under the DSH 0.2.0 settings model, this entry's
 * settings page as well: the Host derives one form per profile entry from this
 * schema and serves it only when at least one field is `volatile()`. The marker
 * is also what admits a write and what keeps the edit on the live path — the
 * Loader commits the new value into the field's reference and announces
 * `loader/volatile-update` on this fiber instead of remounting the row, so the
 * registered tools and skill survive a settings save.
 *
 * Every field is volatile, which is what makes the settings section able to read
 * and write the whole configuration rather than a subset. A volatile field's
 * parsed output is a reference while its accepted input stays the plain value,
 * so the schema is left to inference rather than annotated with `Schema<Config>`
 * — the two sides no longer share one shape and the annotation would reject the
 * schema the Host must be given.
 *
 * The plain shape is recovered by {@link resolveConfig} before anything
 * downstream sees it.
 */
export const Config = Schema.object({
  backend: Schema.union(['auto', 'api', 'local', 'comfyui']).default('auto').volatile(),
  apiBaseUrl: Schema.string().default('https://dashscope.aliyuncs.com/compatible-mode/v1').volatile(),
  apiKey: Schema.string().default('').volatile(),
  apiModel: Schema.string().default('qwen-image').volatile(),
  apiStyle: Schema.union(['openai', 'dashscope']).default('openai').volatile(),
  outputDir: Schema.string().default(defaultOutputDir()).volatile(),
  timeoutMs: Schema.number().default(180_000).volatile(),
  localEndpoint: Schema.string().default('http://127.0.0.1:8399').volatile(),
  comfyEndpoint: Schema.string().default('').volatile(),
  comfyPorts: Schema.string().default('8000,8188,8189,8190,8191,8192').volatile(),
  comfyModelsDir: Schema.string().default(probeComfyModelsDir()).volatile(),
  runtimeDir: Schema.string().default(defaultRuntimeDir()).volatile(),
  // Deliberately empty: both derive from `runtimeDir` at resolve time, so a real
  // default would freeze them to the *default* runtime directory and silently
  // point at the wrong weight dir / venv the moment the user moves `runtimeDir`
  // — which is an operation we actively want (point it at a populated directory
  // and skip a 13 GiB download). Empty means "follow the current runtimeDir"; the
  // page shows the derived path in the hint, substituted with the live value, so
  // it is visible without being able to go stale.
  modelsDir: Schema.string().default('').volatile(),
  modelRepo: Schema.string().default('circulus/Qwen-Image-2.1-bnb-4bit').volatile(),
  hfMirror: Schema.string().default('https://hf-mirror.com').volatile(),
  workerPorts: Schema.string().default('8399-8410').volatile(),
  workerStartTimeoutMs: Schema.number().default(300_000).volatile(),
  idleUnloadMs: Schema.number().default(600_000).volatile(),
  manageWorker: Schema.boolean().default(true).volatile(),
  pythonPath: Schema.string().default('').volatile(),
  workerScript: Schema.string().default(defaultWorkerScript()).volatile(),
  basePython: Schema.string().default(probeBasePython()).volatile(),
  torchWheels: Schema.string().default('').volatile(),
  pipIndexUrl: Schema.string().default('').volatile(),
  reuseBaseTorch: Schema.boolean().default(true).volatile(),
  minFreeVramMiB: Schema.number().default(5500).volatile(),
  freeComfyBeforeLocalStart: Schema.boolean().default(false).volatile(),
  allowLocalEditOverBudget: Schema.boolean().default(false).volatile(),
  localReferenceBudget: Schema.number().default(0).volatile(),
  skipLmHead: Schema.boolean().default(false).volatile(),
  // The step counts. `defaultSteps` is the shared fallback; the two per-backend
  // fields are deliberately optional (no `.default()`), so an unset override
  // resolves to `undefined` and the resolver falls through to `defaultSteps`.
  // They are still declared keys: `schemaDefaults` keeps every key, so the
  // settings page's field-coverage guard sees them.
  defaultSteps: Schema.number().default(25).volatile(),
  comfyuiSteps: Schema.number().volatile(),
  localSteps: Schema.number().volatile(),
})

/**
 * The schema's own defaults, in plain form, key-complete.
 *
 * Read off the schema rather than restated, so a default changed in the schema
 * cannot drift from the one an activation is resolved against. `schemaDefaults`
 * (not `unwrapConfigFields`) is what keeps the two optional step overrides as
 * declared-but-unset keys.
 */
const CONFIG_DEFAULTS: ConfigRecord = schemaDefaults(Config({}) as ConfigRecord)

/**
 * Resolve the effective config of one activation into plain data.
 *
 * Volatile references are read here, so a settings save re-entering this fiber
 * is observed as the value it committed. Deliberately **not** exported: this
 * entry's export list is a published surface, pinned by `test/surface.test.mjs`
 * to exactly name / inject / Config / apply. The unwrapping itself lives in
 * `./config-resolve.ts`, which is also its own build entry and so is directly
 * testable at `lib/config-resolve.js`.
 *
 * @param config - the config the Host passed to the activation.
 * @returns the resolved config, every field present.
 */
function resolveConfig(config?: ConfigFields): Config {
  return resolveConfigFields(CONFIG_DEFAULTS, config as ConfigRecord | undefined) as unknown as Config
}

/**
 * Register the image tools and the routing skill.
 *
 * @param ctx - cordis context; `tools` and `skills` are injected above.
 * @param config - the activation's config, volatile references included.
 */
export function apply(ctx: Context, config?: ConfigFields): void {
  registerImageForgeTools(ctx, resolveConfig(config))
  registerImageForgeSkill(ctx)
}
