import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defaultOutputDir, probeComfyModelsDir } from './config-defaults.ts'
import {
  resolveConfigFields,
  schemaDefaults,
  type ConfigField,
  type ConfigRecord,
} from './config-resolve.ts'
import { registerImageForgeSkill } from './skill.ts'
import { registerStudioRoutes } from './studio-routes.ts'
import { studioSettingsOf } from './studio-service.ts'
import { registerImageForgeTools } from './tools.ts'

/** Registration name inside the cordis context. */
export const name = 'dsh-image-forge'

/** Services this plugin needs before `apply` runs. */
export const inject = ['tools', 'skills']

/** Plugin configuration as written in the DSH profile. */
export interface Config {
  /** Directory generated PNGs are written to. */
  outputDir: string
  /** Cooperative per-call budget for one generation, in milliseconds. */
  timeoutMs: number
  /**
   * ComfyUI origin, e.g. `http://127.0.0.1:8188`. Empty means "probe
   * `comfyPorts` on 127.0.0.1"; a non-loopback value is refused at call time,
   * because this backend only ever talks to this machine.
   */
  comfyEndpoint: string
  /** Candidate ComfyUI ports tried when `comfyEndpoint` is empty. */
  comfyPorts: string
  /**
   * Where ComfyUI keeps its models. Probed at activation so the "put the file
   * in …" errors can name a real directory; a wrong guess is visible and
   * correctable on the settings page.
   */
  comfyModelsDir: string
  /**
   * Sampler steps used when neither the caller nor a backend-specific override
   * picks one. Default **25**, the official ComfyUI 2.1 template's count.
   *
   * Measured: 25 → 50 does **not** add detail (lapvar 1019 → 970, hf_frac
   * 0.0317 → 0.0279), so more steps is not the lever for sharpness — canvas size
   * is. The knob stays configurable; only the default and the docs follow this.
   */
  defaultSteps: number
  /**
   * ComfyUI steps; `undefined` (the default) means "use `defaultSteps`".
   *
   * Kept separate from `defaultSteps` because the two checkpoint families have
   * different working points: base wants 25, and this is where a user who
   * disagrees with that can say so without touching the family default.
   */
  comfyuiSteps: number | undefined
  /**
   * Which checkpoint family the ComfyUI path asks for.
   *
   * `base` (the default) is the 25-step Qwen-Image 2.1 checkpoint. `turbo` is
   * the distilled one: 8 steps on its own fixed sigma schedule, which is the
   * whole reason it exists — a local card that cannot do 25 steps comfortably
   * can do 8. It is only usable when a turbo unet is actually installed;
   * otherwise the pipeline falls back to `base` and says so in its result.
   */
  comfyModel: 'base' | 'turbo'
  /**
   * Steps for the turbo checkpoint; `undefined` means {@link TURBO_STEPS} (8).
   *
   * Exposed because the turbo contract is "8 steps **with this schedule**", and
   * the only honest way to check that claim on a given card is to run a couple
   * of neighbouring values and look at the pictures.
   */
  turboSteps: number | undefined
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
 * downstream sees it. The cloud-API fields (`backend`, `apiBaseUrl`, `apiKey`,
 * `apiModel`, `apiStyle`) were removed with that backend; a profile patch that
 * still carries them has the extra keys ignored, not rejected.
 */
export const Config = Schema.object({
  outputDir: Schema.string().default(defaultOutputDir()).volatile(),
  timeoutMs: Schema.number().default(180_000).volatile(),
  comfyEndpoint: Schema.string().default('').volatile(),
  comfyPorts: Schema.string().default('8000,8188,8189,8190,8191,8192').volatile(),
  comfyModelsDir: Schema.string().default(probeComfyModelsDir()).volatile(),
  // The step counts. `defaultSteps` is the shared fallback; `comfyuiSteps` and
  // `turboSteps` are deliberately optional (no `.default()`), so an unset
  // override resolves to `undefined` and the resolver falls back to the family
  // default. They are still declared keys: `schemaDefaults` keeps every key, so
  // the settings page's field-coverage guard sees them.
  defaultSteps: Schema.number().default(25).volatile(),
  comfyuiSteps: Schema.number().volatile(),
  comfyModel: Schema.union(['base', 'turbo']).default('base').volatile(),
  turboSteps: Schema.number().volatile(),
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
 * Register the image tools, the routing skill, and — when the host serves one —
 * the Studio's HTTP routes.
 *
 * The Studio routes mount through a dedicated inner plugin ({@link
 * registerStudioRoutesIfMounted}) so a host without a web server still gets the
 * Agent tools, and a host whose server mounts late gets the routes at all.
 *
 * The tools do **not** get a resolved snapshot: they get the same
 * {@link resolveConfig} closure the routes re-read per request, because a
 * settings save commits into the field's volatile reference without re-running
 * `apply` — a snapshot taken here would freeze `comfyEndpoint`, `comfyModel`
 * and the step overrides at activation time and quietly ignore every later
 * settings edit.
 *
 * @param ctx - cordis context; `tools` and `skills` are injected above.
 * @param config - the activation's config, volatile references included.
 */
export function apply(ctx: Context, config?: ConfigFields): void {
  registerImageForgeTools(ctx, () => resolveConfig(config))
  registerImageForgeSkill(ctx)
  registerStudioRoutesIfMounted(ctx, config)
}

/**
 * Wire the Studio routes onto the host's web server, reading the config fresh
 * per request so a settings save takes effect without a restart.
 *
 * The routes live in a **dedicated inner plugin** that declares `webServer` as
 * its own injected service, rather than in the plugin body. The reason is
 * activation order: a plugin only starts once *every* service in its `inject`
 * list exists, so putting `webServer` on the outer plugin would park the tools
 * and the skill on any host that never starts a web server, while reading
 * `ctx.get('webServer')` once from the body loses the race the other way — on
 * Desktop the server mounts after plugin activation, the getter returns
 * `undefined`, and the Studio panel then reports HTTP 404 against a server
 * that is in fact running. The inner plugin gets both halves right: the outer
 * body starts immediately (tools work everywhere), and cordis (re)activates
 * the inner one exactly when the web server appears.
 *
 * @param ctx - host context.
 * @param config - the activation's config, or undefined for the schema defaults.
 */
function registerStudioRoutesIfMounted(ctx: Context, config?: ConfigFields): void {
  // A minimal or mocked context (the unit-test harness, a stripped embedder) may
  // not implement nested plugins. Skipping the Studio there loses only the HTTP
  // routes — never the tools — so it must not throw out of `apply`.
  const nest = (ctx as unknown as { plugin?: unknown }).plugin
  if (typeof nest !== 'function') return

  ctx.plugin({
    name: 'dsh-image-forge:studio',
    inject: ['webServer'],
    apply: (svcCtx) => {
      const disposers = registerStudioRoutes(svcCtx, {
        settings: () => studioSettingsOf(resolveConfig(config)),
        ctx: svcCtx,
      })
      if (!disposers.length) {
        svcCtx.logger.warn('webServer 已挂载但 register() 不可用，工作台路由未注册')
        return
      }
      return () => disposers.forEach((dispose) => dispose())
    },
  })
}
