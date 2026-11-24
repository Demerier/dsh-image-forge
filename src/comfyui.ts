/**
 * ComfyUI backend: reuse a ComfyUI the user already has, plus its already
 * downloaded Qwen-Image weights (zero download, zero conversion).
 *
 * Three rules shape this module:
 *
 * 1. **Loopback only.** Every URL is checked against {@link isLoopbackUrl} before
 *    a socket opens, and every request is sent with `redirect: 'error'`, so a
 *    redirect cannot walk the connection off the loopback interface.
 * 2. **The model file names come from the server, never from this file.** The
 *    three loaders' option lists are read from `/object_info` and matched by
 *    name; a name this module does not find is reported as a missing file with
 *    the directory it belongs in. Nothing is hard-coded as a *requirement* —
 *    the example names in the profile table are only used in error text.
 * 3. **Upstream errors are quoted, not swallowed.** `/prompt` answers with
 *    `node_errors` and `/history` carries an execution traceback; both reach the
 *    caller as readable text instead of a bare 400.
 *
 * ## Which model family runs
 *
 * The weight matching, the `CLIPLoader.type`, the latent node, the sampler, the
 * default step count, the negated prompt and the graphs themselves are **not**
 * decided here: they belong to a {@link ModelProfile} in `model-profiles.ts`, and
 * this module is the one code path that executes any of them. `comfyModel` picks
 * the profile by id (`qwen21-base`, `qwen21-turbo`, `moss-sft`) — the pre-profile
 * values `base` / `turbo` still resolve, see `resolveProfile`.
 *
 * Two rules keep that honest:
 *
 * - **The profile never decides the canvas.** `ratio.ts` does, at 32 alignment,
 *   which every profile accepts (32 is a multiple of MOSS's 16) — so the pixel
 *   policy cannot fork between families.
 * - **The graph follows the weights, not only the config.** A turbo request on a
 *   base-only install degrades to the base graph (and says so); see
 *   {@link effectiveProfile}. Otherwise a config value could pair the turbo
 *   sigma schedule with a checkpoint that was never distilled for it.
 *
 * The Qwen graph is the official Qwen-Image 2.1 text-to-image template that ships
 * with ComfyUI (`comfyui_workflow_templates_json/templates/
 * image_qwen_image_2_1_t2i.json`), reduced to the nodes needed without the
 * optional prompt-enhancer branch: `UNETLoader` → `KSampler.model`,
 * `CLIPLoader(type=qwen_image)` → `TextEncodeQwenImage21` → `KSampler`,
 * `VAELoader` → `VAEDecode`, `EmptyLatentImage` → `KSampler.latent_image`,
 * `VAEDecode` → `SaveImage`. The template's `QwenImage21Cache` is **kept** when
 * the server lists the node (it caches the text/reference KV prefix, which is
 * where most of the edit speedup comes from) and stripped automatically when an
 * older ComfyUI (< 0.37.0) does not — see {@link withoutQwenCache}. The
 * `ResolutionSelector` and prompt-enhancer nodes stay dropped: we size the canvas
 * ourselves in `ratio.ts`, and the enhancer needs weights this plugin does not
 * require. The MOSS graph is the
 * same kind of reduction of ComfyUI's `image_moss_image_t2i.json`, documented in
 * `model-profiles.ts`.
 *
 * The Qwen edit (image-to-image) graph is the same skeleton plus the reference
 * slots, taken from the official `image_qwen_image_2_1_image_edit.json`
 * template: its `TextEncodeQwenImage21` node takes a `vae`, an autogrow
 * `images.image_N` input per reference (up to ten) and a `resolution` pixel
 * budget, and the reference pixels enter ComfyUI through `POST /upload/image` as
 * `LoadImage` inputs. The template's `ComfySwitchNode` (its "custom size" switch)
 * has no counterpart here because the plugin always supplies an explicit canvas,
 * exactly as the text-to-image path does; the template builds its default canvas
 * from the first reference at a 32-aligned ~1.5 MP budget, which is what
 * `ratio_follow` resolves to. MOSS has **no** edit graph yet — its profile
 * carries a `todo` naming the nodes the follow-up needs.
 */
import { createHash } from 'node:crypto'
import { sniffImageMime, type GeneratedImage, type GenerateRequest, type ReferenceImagePayload } from './images.ts'
import { resolveBackendPlan, runThroughBackends } from './backend.ts'
import {
  MODEL_PROFILES,
  MOSS_EDIT_LORA,
  assertLatentAligned,
  mossLayoutEditWorkflow,
  parseMossLayout,
  resolveProfile,
  resolveSampling,
  withoutQwenCache,
  type ApiGraph,
  type ComfyModelChoice,
  type ModelProfile,
  type MossSamplingPreset,
  type WeightRule,
} from './model-profiles.ts'

// The graphs, the sigma schedule and the reference-slot builders live with the
// profiles now. They are re-exported from here because this module is the
// adapter's published face (and the `testlib/comfyui.js` entry the test suite
// reads them from), so moving a constant must not move its import path.
export {
  EDIT_IMAGE_NODE_BASE,
  EDIT_MAX_REFERENCES,
  MOSS_IMAGE_WORKFLOW,
  MOSS_LATENT_MULTIPLE,
  MOSS_NEGATIVE_PROMPT,
  QWEN_IMAGE_EDIT_WORKFLOW,
  QWEN_IMAGE_TURBO_EDIT_WORKFLOW,
  QWEN_IMAGE_TURBO_WORKFLOW,
  QWEN_IMAGE_WORKFLOW,
  QWEN_CACHE_NODE_ID,
  TURBO_CACHE_NODE_ID,
  TURBO_EDIT_IMAGE_NODE_BASE,
  TURBO_SIGMAS,
  TURBO_STEPS,
  editTurboWorkflow,
  editWorkflow,
  mossLayoutEditWorkflow,
  parseMossLayout,
  withoutQwenCache,
} from './model-profiles.ts'
export {
  COMFY_MODEL_IDS,
  DEFAULT_COMFY_MODEL,
  DEFAULT_MOSS_SAMPLING,
  LEGACY_COMFY_MODEL_IDS,
  MODEL_PROFILES,
  MOSS_SAMPLING_PRESETS,
  assertLatentAligned,
  isComfyModelId,
  presetSteps,
  resolveProfile,
  resolveSampling,
  type ComfyModelChoice,
  type ComfyModelId,
  type ModelProfile,
  type MossSamplingPreset,
  type SamplingPreset,
  type WeightRule,
} from './model-profiles.ts'

/** Ports probed when `comfyEndpoint` is empty, in order. */
export const DEFAULT_COMFY_PORTS = [8000, 8188, 8189, 8190, 8191, 8192] as const

/** Everything the ComfyUI backend needs beyond one call's prompt and size. */
export interface ComfyOptions {
  /** Fixed endpoint, e.g. `http://127.0.0.1:8188`; empty means "probe the ports". */
  readonly endpoint: string
  /** Ports tried on `127.0.0.1` when `endpoint` is empty. */
  readonly ports: readonly number[]
  /** Where this machine keeps ComfyUI's models; used in error text only. */
  readonly modelsDir: string
  /**
   * Which model profile the caller asked for.
   *
   * Load-bearing at *selection* time, not just at graph time: when both a base
   * and a distilled checkpoint are installed, the plain name scoring ties and
   * keeps the server's order, so `qwen21-turbo` promotes its `/turbo/i` unet and
   * `qwen21-base` demotes it; `moss-sft` matches an entirely different set of
   * file names. Legacy `base` / `turbo` still resolve (see `resolveProfile`).
   */
  readonly comfyModel?: ComfyModelChoice
  /**
   * Which sampling register a family that publishes more than one should run.
   *
   * Only the profiles that declare `samplingPresets` read it (MOSS-Image today):
   * both Qwen profiles ignore it, so their graphs cannot move. Absent means the
   * family default, which is the verified one.
   */
  readonly mossSampling?: MossSamplingPreset
  /** Budget for one whole generation, from `/prompt` to the last image byte. */
  readonly timeoutMs: number
  /** Per-port reachability budget during discovery. */
  readonly portProbeTimeoutMs?: number
  /** Gap between `/history` polls. */
  readonly pollIntervalMs?: number
  /**
   * Called once with the prompt id `/prompt` accepted, before any polling.
   *
   * The Studio uses it to map the ComfyUI run back to the canvas task that asked
   * for it (DD7, `../docs/usage-reference.md` §4.3). Optional by design: when it is
   * absent the submission body and the request sequence are byte-identical to
   * before, which is what keeps the conversation-tool path untouched.
   */
  readonly onPromptId?: (promptId: string) => void
}

/**
 * The `KSampler.sampler_name` values this plugin offers as an alternative.
 *
 * **ComfyUI-native only**: every name here ships with ComfyUI's own
 * `comfy.samplers`. Third-party sampler packs (RES4LYF's `abnorsett_3m`,
 * `beta_57` schedules, …) are deliberately absent — the plugin does not require
 * or install third-party node packs, and an unknown name would fail only at
 * `/prompt` time. `euler` remains the default; the alternatives are all
 * single-source/community reports without a controlled comparison.
 */
export const NATIVE_SAMPLERS = [
  'euler',
  'euler_ancestral',
  'heun',
  'dpm_2',
  'dpm_2_ancestral',
  'lms',
  'dpmpp_2s_ancestral',
  'dpmpp_2m',
  'dpmpp_2m_sde',
  'dpmpp_sde',
  'dpmpp_3m_sde',
  'res_multistep',
  'er_sde',
  'ddim',
] as const

/** One sampler name the tools accept. */
export type NativeSampler = (typeof NATIVE_SAMPLERS)[number]

/**
 * The `KSampler.scheduler` values this plugin offers.
 *
 * Also ComfyUI-native; `simple` stays the default, and `beta` is the scheduler
 * the community `er_sde + beta` experiments pair with it.
 */
export const NATIVE_SCHEDULERS = ['simple', 'normal', 'karras', 'exponential', 'sgm_uniform', 'beta'] as const

/** One scheduler name the tools accept. */
export type NativeScheduler = (typeof NATIVE_SCHEDULERS)[number]

/** Optional sampler/scheduler overrides for the Qwen base `KSampler` graph. */
export interface SamplerOverrides {
  /** `KSampler.sampler_name` override; absent keeps the profile's own sampler. */
  readonly samplerName?: string
  /** `KSampler.scheduler` override; absent keeps the profile's own scheduler. */
  readonly scheduler?: string
}

/**
 * Optional MOSS layout conditioning for one text-to-image call.
 *
 * The value is the layout editor's **compiled** export (the JSON string whose
 * `bbox_coord_space` is `abs_centralized` and `bbox_format` `yxyx`). Only a
 * profile with `layoutTemplate` accepts it (today: MOSS-Image); `tools.ts` owns
 * the caller-facing validation, and the renderer parses it again so a direct
 * adapter caller cannot submit a layout ComfyUI would silently ignore.
 */
export interface LayoutOverride {
  /** Compiled layout prompt; absent keeps the plain text-to-image graph. */
  readonly layout?: string
}

/** Everything the optional per-call overrides can put on a graph. */
export type WorkflowOverrides = QualityTierOverrides & SamplerOverrides & LayoutOverride

/**
 * Optional quality-tier overrides for the Qwen base `KSampler` graphs.
 *
 * `tools.ts` owns the policy — when `cfg > 1` is allowed, the automatic negative
 * set, and which profiles refuse the tier. This module only knows how to put the
 * values on the graph: an absent field keeps the profile's own value, so a
 * default call renders a byte-identical graph.
 */
export interface QualityTierOverrides {
  /** `KSampler.cfg` override; absent keeps the profile's own CFG. */
  readonly cfg?: number
  /** Negative prompt override; absent keeps the profile's own negative prompt. */
  readonly negativePrompt?: string
}

/** The resolved-config fields both front doors carry into one call's options. */
export interface ComfySettingsFields {
  /** `comfyEndpoint` as the settings resolver produced it. */
  readonly comfyEndpoint: string
  /** `comfyPorts` **already parsed** by {@link parseComfyPorts}. */
  readonly comfyPorts: readonly number[]
  /** `comfyModelsDir` as resolved. */
  readonly comfyModelsDir: string
  /** Model profile the caller configured; legacy `base`/`turbo` still resolve. */
  readonly comfyModel?: ComfyModelChoice
  /** Sampling register for a family that publishes more than one (MOSS only). */
  readonly mossSampling?: MossSamplingPreset
  /** The configured per-call budget. */
  readonly timeoutMs: number
}

/**
 * Parse the comma-separated `comfyPorts` value into candidate ports.
 *
 * Anything that is not a usable port number is ignored rather than rejected: a
 * typo in the config must not stop the plugin from loading, and the default list
 * is the documented behaviour. Shared by the Agent tools and the Studio, so a
 * typo cannot behave differently across the two front doors.
 *
 * @param raw - config value, e.g. `8000,8188`.
 * @returns distinct valid ports, or the defaults when none survive.
 */
export function parseComfyPorts(raw: string): number[] {
  const ports = new Set<number>()
  for (const part of raw.split(/[,\s]+/)) {
    const port = Number(part.trim())
    if (part.trim().length > 0 && Number.isInteger(port) && port >= 1 && port <= 65535) ports.add(port)
  }
  return ports.size > 0 ? [...ports] : [...DEFAULT_COMFY_PORTS]
}

/**
 * Derive one call's {@link ComfyOptions} from the settings both front doors share.
 *
 * The Agent tools' `ForgeSettings` and the Studio's `StudioSettings` both
 * satisfy the structural argument, so the endpoint trimming and the timeout
 * hand-off cannot drift apart between the two readers.
 *
 * @param settings - the resolved settings (ports already parsed).
 * @param timeoutMs - per-call override; defaults to the configured budget.
 * @returns the options the adapter functions take.
 */
export function comfyOptionsOf(settings: ComfySettingsFields, timeoutMs = settings.timeoutMs): ComfyOptions {
  return {
    endpoint: settings.comfyEndpoint.replace(/\/+$/, ''),
    ports: settings.comfyPorts,
    modelsDir: settings.comfyModelsDir,
    comfyModel: settings.comfyModel,
    mossSampling: settings.mossSampling,
    timeoutMs,
  }
}

/** One reachability attempt made while looking for ComfyUI. */
export interface ComfyProbeAttempt {
  /** Endpoint that was tried. */
  readonly endpoint: string
  /** True when this endpoint answered as ComfyUI. */
  readonly ok: boolean
  /** Why it did not answer, or why the answer was not ComfyUI. */
  readonly note?: string
}

/** A ComfyUI that answered, plus the trail that led to it. */
export interface ComfyTarget {
  /** Origin without a trailing slash, e.g. `http://127.0.0.1:8188`. */
  readonly endpoint: string
  /** Port the answer came from. */
  readonly port: number
  /** Every attempt, in order, including the successful one. */
  readonly probed: readonly ComfyProbeAttempt[]
}

/** The three weight files one generation needs, as the server named them. */
export interface ComfyModels {
  /** `UNETLoader.unet_name` — the DiT. */
  readonly unet: string
  /** `CLIPLoader.clip_name` — the text encoder. */
  readonly clip: string
  /** `VAELoader.vae_name` — the VAE. */
  readonly vae: string
  /** `CLIPLoader.type`, resolved from that input's own option list. */
  readonly clipType: string
  /**
   * Whether `/object_info` lists `QwenImage21Cache` (ComfyUI ≥ 0.37.0).
   *
   * The Qwen graphs carry the shim; when this is false the adapter renders them
   * without it so an old server runs the image instead of rejecting an unknown
   * node class. MOSS graphs never carry it.
   */
  readonly cache: boolean
}

/**
 * The loader inputs one profile's weights are read from, in error-text order.
 *
 * Derived from the profile rather than restated here: the folder a file belongs
 * in, the wording that names it and the example it ships under are all profile
 * data, so a new family cannot inherit the old family's error text.
 */
function weightKindsOf(profile: ModelProfile): { kind: 'unet' | 'clip' | 'vae'; rule: WeightRule }[] {
  return [
    { kind: 'unet', rule: profile.weights.unet },
    { kind: 'clip', rule: profile.weights.clip },
    { kind: 'vae', rule: profile.weights.vae },
  ]
}

/** One weight slot of a profile. */
type ModelKind = 'unet' | 'clip' | 'vae'

/**
 * True when a URL points at this machine's loopback interface.
 *
 * Only literal forms are accepted — `127.0.0.0/8`, `localhost`, `::1`. A host
 * name is never resolved, so `localhost.evil.example.com` cannot pass.
 *
 * @param raw - URL to test; anything unparseable is rejected.
 * @returns whether the URL is HTTP(S) on the loopback interface.
 */
export function isLoopbackUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return isLoopbackHost(url.hostname)
}

/** True when a host literal is loopback. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true
  const octets = host.split('.')
  if (octets.length !== 4 || octets[0] !== '127') return false
  return octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
}

/**
 * Refuse any endpoint that is not on this machine.
 *
 * @param raw - endpoint from the plugin config.
 * @returns the same endpoint without a trailing slash.
 * @throws When the URL is malformed or leaves the loopback interface. This is
 *   the network boundary in code, so it fails before any socket is opened
 *   rather than relying on configuration being right.
 */
export function assertLocalEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!isLoopbackUrl(trimmed)) {
    throw new Error(
      `comfyui backend: refusing endpoint "${raw}" — 本后端只与**本机回环地址**上的 ComfyUI 通信` +
        '（127.0.0.1 / localhost / ::1），不接受域名或局域网地址。请把 comfyEndpoint 改成回环 URL，' +
        '或清空它让插件自动探测。',
    )
  }
  return trimmed
}

/** Abort in `ms`, also aborting when the caller aborts. Always disposed. */
function requestSignal(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms} ms`)), ms)
  const onAbort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

/** Flatten a transport error into one line, including the underlying cause. */
function transportReason(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : ''
  return `${error.message}${cause}`
}

/** A response, parsed as JSON when it parses. */
interface ComfyResponse {
  /** HTTP status code. */
  readonly status: number
  /** `response.ok`. */
  readonly ok: boolean
  /** Parsed body, or undefined when the body was not JSON. */
  readonly payload: unknown
  /** Raw body text, for quoting upstream errors verbatim. */
  readonly raw: string
}

/**
 * One JSON request against ComfyUI, with `redirect: 'error'`.
 *
 * @throws When the socket fails or the call times out; HTTP error statuses are
 *   returned rather than thrown so the caller can quote the body.
 */
async function requestJson(
  url: string,
  init: { method: string; body?: string },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ComfyResponse> {
  const composed = requestSignal(signal, timeoutMs)
  try {
    const response = await fetch(url, {
      method: init.method,
      headers: init.body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: init.body,
      redirect: 'error',
      signal: composed.signal,
    })
    const raw = await response.text()
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      payload = undefined
    }
    return { status: response.status, ok: response.ok, payload, raw }
  } catch (error) {
    throw new Error(`comfyui backend: ${url} 请求失败 — ${transportReason(error)}`)
  } finally {
    composed.dispose()
  }
}

/** Read a property from an unknown JSON value without trusting its shape. */
function prop(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return (value as Record<string, unknown>)[key]
}

/** One binary response, for `/view`. */
interface ComfyBytes {
  /** HTTP status code. */
  readonly status: number
  /** `response.ok`. */
  readonly ok: boolean
  /** Body bytes, exactly as served. */
  readonly bytes: Uint8Array
  /** `Content-Type` without parameters, when the server sent one. */
  readonly contentType: string | undefined
  /** Short body excerpt, used only to explain a failure. */
  readonly note: string
}

/**
 * Fetch image bytes.
 *
 * The body is taken as an `ArrayBuffer` and never through `text()`: decoding
 * binary as UTF-8 destroys every non-ASCII byte, which silently corrupts the
 * PNG instead of failing.
 */
async function requestBytes(url: string, timeoutMs: number, signal?: AbortSignal): Promise<ComfyBytes> {
  const composed = requestSignal(signal, timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'image/*' },
      redirect: 'error',
      signal: composed.signal,
    })
    if (!response.ok) {
      let note = ''
      try {
        note = (await response.text()).replace(/\s+/g, ' ').slice(0, 200)
      } catch {
        note = ''
      }
      return { status: response.status, ok: false, bytes: new Uint8Array(), contentType: undefined, note }
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    return {
      status: response.status,
      ok: true,
      bytes,
      contentType: response.headers.get('content-type')?.split(';')[0]?.trim(),
      note: '',
    }
  } catch (error) {
    throw new Error(`comfyui backend: ${url} 请求失败 — ${transportReason(error)}`)
  } finally {
    composed.dispose()
  }
}

/**
 * Answer from one candidate endpoint.
 *
 * `/system_stats` is ComfyUI's cheapest always-present endpoint. A 2xx is not
 * enough on its own: the body must look like ComfyUI's, otherwise another
 * service squatting on the port would be mistaken for the renderer.
 */
async function probeEndpoint(endpoint: string, timeoutMs: number, signal?: AbortSignal): Promise<ComfyProbeAttempt> {
  try {
    const response = await requestJson(`${endpoint}/system_stats`, { method: 'GET' }, timeoutMs, signal)
    if (!response.ok) return { endpoint, ok: false, note: `/system_stats answered HTTP ${response.status}` }
    if (prop(response.payload, 'system') === undefined && prop(response.payload, 'devices') === undefined) {
      return { endpoint, ok: false, note: '/system_stats answered 2xx but the body is not ComfyUI\'s' }
    }
    return { endpoint, ok: true }
  } catch (error) {
    return { endpoint, ok: false, note: transportReason(error) }
  }
}

/**
 * Find the ComfyUI to talk to.
 *
 * A configured endpoint is used as-is (after the loopback check) and a failure
 * there is final — silently falling back to port probing would hide a typo in
 * the config. Without one, every candidate port is tried in order.
 *
 * @param options - endpoint, candidate ports, and probe budget.
 * @param signal - caller cancellation.
 * @returns the endpoint that answered, with the full attempt trail.
 * @throws When the configured endpoint does not answer, or no candidate port
 *   does; the message lists every endpoint tried and how to start ComfyUI.
 */
export async function discoverComfyUi(options: ComfyOptions, signal?: AbortSignal): Promise<ComfyTarget> {
  const timeout = options.portProbeTimeoutMs ?? 800
  if (options.endpoint.trim().length > 0) {
    const endpoint = assertLocalEndpoint(options.endpoint)
    const port = Number(new URL(endpoint).port) || (new URL(endpoint).protocol === 'https:' ? 443 : 80)
    const attempt = await probeEndpoint(endpoint, timeout, signal)
    if (attempt.ok) return { endpoint, port, probed: [attempt] }
    throw new Error(
      `comfyui backend: 配置的端点 ${endpoint} 不是可用的 ComfyUI — ${attempt.note ?? 'no reason reported'}\n` +
        '  请确认 ComfyUI 已经启动，且 comfyEndpoint 的端口与它一致（桌面版常见 8000，便携版 8188），' +
        '或把 comfyEndpoint 留空让插件自动探测。',
    )
  }
  const probed: ComfyProbeAttempt[] = []
  for (const port of options.ports) {
    const endpoint = `http://127.0.0.1:${port}`
    const attempt = await probeEndpoint(endpoint, timeout, signal)
    probed.push(attempt)
    if (attempt.ok) return { endpoint, port, probed }
  }
  const tried = probed.map((attempt) => `  • ${attempt.endpoint} — ${attempt.note ?? 'no reason reported'}`).join('\n')
  throw new Error(
    `comfyui backend: 没找到在跑的 ComfyUI（已探测 ${probed.length} 个端口）：\n${tried}\n` +
      '  一条命令起来：node scripts/start-comfyui.mjs（仓库自带；不加参数就起+等就绪，--doctor 只体检）。\n' +
      '  不敢用脚本就照旧手动启动，它监听在别的端口时把该端口写进 comfyPorts 或直接写 comfyEndpoint。\n' +
      '  部署步骤（下载、放权重、校验）见 docs/comfyui-deployment.md；也可以先跑 image_forge_status 看缺什么。',
  )
}

/**
 * Read one loader's file-name option list out of `/object_info`.
 *
 * Classic nodes answer `{input: {required: {field: [[names…], options]}}}`;
 * a missing node, field, or option list returns undefined so the caller can say
 * exactly which loader it could not read.
 */
function loaderField(payload: unknown, loader: string, field: string): string[] | undefined {
  const node = prop(payload, loader)
  const input = prop(node, 'input')
  const spec = prop(prop(input, 'required'), field) ?? prop(prop(input, 'optional'), field)
  const options = Array.isArray(spec) ? spec[0] : undefined
  if (!Array.isArray(options)) return undefined
  return options.filter((name): name is string => typeof name === 'string')
}

/**
 * Pick the file whose name best matches a profile's weight rule.
 *
 * A candidate must match `required`; each additional pattern it matches adds
 * weight (earlier patterns weigh more). A candidate matching an `avoid` pattern
 * is pushed below every non-matching one, which is how `qwen21-base` refuses to
 * run a turbo checkpoint that happens to be listed first. Ties keep the server's
 * own order, so the choice is deterministic for a given `/object_info`. Matching
 * the whole name rather than the basename means a file in a subfolder still
 * matches. This is what keeps the PE (prompt-enhancer) text encoders from being
 * picked as the Qwen text encoder: they carry neither `vl` nor `8b`.
 *
 * @param options - the file names `/object_info` reported for that loader field.
 * @param rule - the profile's matcher for that weight.
 * @returns the chosen name, or undefined when nothing matched.
 */
function pickModelFile(options: readonly string[], rule: WeightRule): string | undefined {
  let best: { name: string; score: number } | undefined
  for (const name of options) {
    if (!rule.required.test(name)) continue
    let score = 0
    for (const [index, pattern] of rule.bonus.entries()) if (pattern.test(name)) score += rule.bonus.length - index
    for (const pattern of rule.avoid ?? []) if (pattern.test(name)) score -= 1000
    if (best === undefined || score > best.score) best = { name, score }
  }
  return best?.name
}

/**
 * The separator a configured models path is joined with.
 *
 * Taken from the **path's own style**, not from `process.platform`: the two can
 * disagree — a Windows path pasted into a POSIX host (WSL, a shared profile, a
 * synced config) would otherwise be joined with `/` and read as
 * `D:\Comfy-Desktop\ComfyUI-Shared\models/clip/`, i.e. a path no Windows shell
 * would accept and no reader would trust. `test/comfyui-e2e.test.mjs` pins both
 * styles on every host, which is what made the platform-only version fail on
 * Linux CI while passing on Windows.
 *
 * A path that carries no separator at all gives no style to follow, so the
 * platform decides there.
 *
 * @param modelsDir - the configured `comfyModelsDir`, already trimmed.
 * @returns `\\` for a Windows-shaped path, `/` otherwise.
 */
function separatorFor(modelsDir: string): string {
  if (modelsDir.includes('\\') || /^[A-Za-z]:/.test(modelsDir)) return '\\'
  if (modelsDir.includes('/')) return '/'
  return process.platform === 'win32' ? '\\' : '/'
}

/** Where a weight belongs, phrased for the machine that is running this plugin. */
function folderHint(modelsDir: string, folder: string): string {
  const trimmed = modelsDir.trim().replace(/[\\/]+$/, '')
  const separator = trimmed.length > 0 ? separatorFor(trimmed) : process.platform === 'win32' ? '\\' : '/'
  if (trimmed.length > 0) {
    return `${trimmed}${separator}${folder}${separator}`
  }
  return `ComfyUI 的 models${separator}${folder}${separator} 目录（桌面版/便携版的模型路径见 ComfyUI 设置或 extra_model_paths.yaml）`
}

/**
 * Read the weight file names one profile needs off the running server.
 *
 * The profile — not this function — decides which file names count, which
 * `CLIPLoader.type` value the graph needs and what to call each weight in error
 * text. That is what makes a second family possible without a second selector:
 * MOSS's DiT is `moss_image_sft_*` and its VAE is `flux2-vae_small`, neither of
 * which the old hard `/qwen/i` gate could ever accept.
 *
 * @param target - the endpoint that answered.
 * @param options - used for the profile id, the model-directory hint and the timeout.
 * @param signal - caller cancellation.
 * @returns the names ComfyUI itself listed, plus the resolved `CLIPLoader.type`.
 * @throws When a loader, its option list, a matching file, or a usable
 *   `CLIPLoader.type` is missing. The message names the profile, every file it
 *   needs, the field and folder each one goes in, and the candidates the server
 *   currently reports — this is checked before `/prompt`, so a missing weight
 *   never becomes a pile of node errors.
 */
export async function loadComfyModels(target: ComfyTarget, options: ComfyOptions, signal?: AbortSignal): Promise<ComfyModels> {
  const timeout = options.portProbeTimeoutMs ?? 800
  const profile = resolveProfile(options.comfyModel)
  const kinds = weightKindsOf(profile)
  const loaded = new Map<ModelKind, ComfyResponse>()
  const clipInfo = requestJson(`${target.endpoint}/object_info/CLIPLoader`, { method: 'GET' }, timeout, signal)
  // Optional node (ComfyUI >= 0.37.0): probed once, so the Qwen graphs can keep
  // the prefix-cache shim on a new server and drop it on an old one.
  const cacheInfo = requestJson(`${target.endpoint}/object_info/QwenImage21Cache`, { method: 'GET' }, timeout, signal)
  for (const { kind, rule } of kinds.filter(({ kind }) => kind !== 'clip')) {
    loaded.set(kind, await requestJson(`${target.endpoint}/object_info/${rule.loader}`, { method: 'GET' }, timeout, signal))
  }
  loaded.set('clip', await clipInfo)
  const cacheResponse = await cacheInfo

  const chosen = new Map<ModelKind, string>()
  /** One line per weight that could not be resolved, all reported together. */
  const missing: string[] = []
  for (const { kind, rule } of kinds) {
    const response = loaded.get(kind)
    const optionsList = response === undefined ? undefined : loaderField(response.payload, rule.loader, rule.field)
    if (optionsList === undefined) {
      throw new Error(
        `comfyui backend: 读不到 ${rule.loader}.${rule.field} — 这个 ComfyUI 没有该加载器节点，` +
          `或 /object_info 的返回不是预期形状。缺的是「${rule.what}」，` +
          `请在 ComfyUI 里确认 ${rule.loader} 节点可用后重试。`,
      )
    }
    const name = pickModelFile(optionsList, rule)
    if (name === undefined) {
      const seen = optionsList.length === 0 ? '（空）' : optionsList.join(', ')
      missing.push(
        `  • ${rule.loader}.${rule.field} — 没有匹配 ${rule.required} 的文件\n` +
          `    需要：${rule.what}\n` +
          `    例如：${rule.example}\n` +
          `    放到：${folderHint(options.modelsDir, rule.folder)}\n` +
          `    当前能看到 ${optionsList.length} 个：${seen}`,
      )
      continue
    }
    chosen.set(kind, name)
  }
  if (missing.length > 0) {
    throw new Error(
      `comfyui backend: 缺模型文件 — 这个 ComfyUI 里选不出 ${profile.label}（comfyModel=${profile.id}）要的权重。\n` +
        `这个 profile 需要 ${kinds.length} 个文件：\n` +
        kinds
          .map(({ rule }) => `  - ${rule.loader}.${rule.field}：${rule.what}（文件名需匹配 ${rule.required}，例如 ${rule.example}）`)
          .join('\n') +
        `\n缺的这几项：\n${missing.join('\n')}\n` +
        '  （本插件不下载、不转换权重；换目标模型改 comfyModel，或把上面的文件放进对应的 models 子目录。）',
    )
  }

  const clipTypes = loaderField(loaded.get('clip')?.payload, profile.weights.clip.loader, 'type')
  const preferred = profile.clipType.prefer.find((type) => clipTypes?.includes(type) === true)
  const clipType = preferred ?? (profile.clipType.fallback === undefined
    ? undefined
    : clipTypes?.find((type) => profile.clipType.fallback!.test(type)))
  if (clipType === undefined) {
    throw new Error(
      `comfyui backend: CLIPLoader.type 里没有 ${profile.label} 要的选项（${profile.clipType.prefer.join(' / ')}），` +
        `无法确定文本编码器类型（${profile.weights.clip.what}）。\n` +
        `  这个 profile 的 CLIPLoader 需要 type="${profile.clipType.prefer[0]}"，` +
        '老版本 ComfyUI 可能还没有这个选项（升级 ComfyUI 即可）。\n' +
        `  当前可选：${clipTypes === undefined ? '（读不到）' : clipTypes.join(', ')}`,
    )
  }

  return {
    unet: chosen.get('unet') as string,
    clip: chosen.get('clip') as string,
    vae: chosen.get('vae') as string,
    clipType,
    cache: prop(cacheResponse.payload, 'QwenImage21Cache') !== undefined,
  }
}

/** Whether the opt-in MOSS layout + reference graph can run on this ComfyUI. */
export interface MossLayoutEditCapability {
  readonly available: boolean
  readonly reason?: string
}

/**
 * Preflight the non-official MOSS layout + reference graph before any upload.
 *
 * This checks the three facts `loadComfyModels` cannot answer on its own: the
 * profile is MOSS, the community edit LoRA is listed by `LoraLoaderModelOnly`,
 * and ComfyUI exposes `TextEncodeMOSSImageEdit`. The base UNET/CLIP/VAE have
 * already been resolved by the caller. Failures are returned, not thrown, so the
 * panel can disable the switch with a reason instead of showing a blank error.
 */
export async function probeMossLayoutEditCapability(
  target: ComfyTarget,
  models: ComfyModels,
  options: ComfyOptions,
  signal?: AbortSignal,
): Promise<MossLayoutEditCapability> {
  if (resolveProfile(options.comfyModel).family !== 'moss-image') {
    return { available: false, reason: '当前模型不是 moss-sft；实验性 Layout + 参考图仅支持 MOSS-Image。' }
  }
  if (models.unet.trim().length === 0 || models.clip.trim().length === 0 || models.vae.trim().length === 0) {
    return { available: false, reason: 'MOSS 基础模型没有完整解析，无法启用实验叠加。' }
  }
  const timeout = options.portProbeTimeoutMs ?? 800
  try {
    const [lora, encoder] = await Promise.all([
      requestJson(`${target.endpoint}/object_info/LoraLoaderModelOnly`, { method: 'GET' }, timeout, signal),
      requestJson(`${target.endpoint}/object_info/TextEncodeMOSSImageEdit`, { method: 'GET' }, timeout, signal),
    ])
    if (!lora.ok || prop(lora.payload, 'LoraLoaderModelOnly') === undefined) {
      return { available: false, reason: 'ComfyUI 缺少 LoraLoaderModelOnly 节点，无法加载 MOSS 编辑 LoRA。' }
    }
    const loras = loaderField(lora.payload, 'LoraLoaderModelOnly', 'lora_name')
    if (loras === undefined || !loras.includes(MOSS_EDIT_LORA)) {
      return { available: false, reason: `MOSS 编辑 LoRA 未安装：需要 ${MOSS_EDIT_LORA}。` }
    }
    if (!encoder.ok || prop(encoder.payload, 'TextEncodeMOSSImageEdit') === undefined) {
      return { available: false, reason: 'ComfyUI 缺少 TextEncodeMOSSImageEdit 节点，无法运行实验叠加。' }
    }
    return { available: true }
  } catch (error) {
    return { available: false, reason: `实验能力检测失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** A whole-string placeholder. */
const WHOLE_PLACEHOLDER = /^\{\{([a-z_]+)\}\}$/

/**
 * Substitute placeholders into a template.
 *
 * A whole-string placeholder takes the value with its own type (numbers stay
 * numbers), which matters because ComfyUI type-checks every input; an inline one
 * is stringified. A placeholder with no value throws rather than reaching the
 * GPU as a literal `{{…}}`.
 *
 * @param template - the API-format graph, possibly placeholders.
 * @param values - one entry per placeholder name.
 * @returns a fresh graph with no placeholders left.
 */
export function renderWorkflow(template: unknown, values: Record<string, unknown>): unknown {
  if (Array.isArray(template)) return template.map((item) => renderWorkflow(item, values))
  if (typeof template === 'string') {
    const whole = WHOLE_PLACEHOLDER.exec(template)
    if (whole !== null) {
      const value = values[whole[1]]
      if (value === undefined) throw new Error(`comfyui backend: workflow placeholder {{${whole[1]}}} has no value`)
      return value
    }
    return template.replace(/\{\{([a-z_]+)\}\}/g, (match, name: string) => {
      const value = values[name]
      if (value === undefined) throw new Error(`comfyui backend: workflow placeholder ${match} has no value`)
      return String(value)
    })
  }
  if (typeof template === 'object' && template !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(template)) out[key] = renderWorkflow(value, values)
    return out
  }
  return template
}

/**
 * Pick the turbo checkpoint out of whatever `/object_info` reported.
 *
 * Read as a *preference*, never a requirement: the plugin still works with only
 * the base weights installed, it just cannot use the turbo path. A name is
 * turbo when it contains `turbo` — that is how both official files are named
 * (`qwen_image_2.1_turbo_bf16.safetensors`,
 * `qwen_image_2.1_turbo_int8_convrot.safetensors`) — so a user who renamed their
 * copy still matches as long as the rename kept the marker.
 *
 * @param models - the three file names resolved from `/object_info`.
 * @returns the turbo unet name, or `undefined` when only a base checkpoint is present.
 */
export function turboUnetOf(models: ComfyModels): string | undefined {
  return /turbo/i.test(models.unet) ? models.unet : undefined
}

/**
 * Hand one reference image to ComfyUI and return the name its `LoadImage` wants.
 *
 * ComfyUI's `LoadImage` reads from its own `input` folder, so the pixels have to
 * be uploaded first; there is no server-side "load this path" input. The name is
 * derived from the image's sha256, so re-sending the same reference overwrites
 * its own file instead of piling up numbered copies, and the file can never
 * collide with a name the user already has there (the `dsh-forge-ref-` prefix).
 *
 * @param target - the endpoint that answered.
 * @param image - decoded reference bytes plus their sniffed mime.
 * @param timeoutMs - budget for the upload.
 * @param signal - caller cancellation.
 * @returns the `image` value to put in a `LoadImage` node.
 * @throws When the upload fails or the response carries no name.
 */
export async function uploadReferenceImage(
  target: ComfyTarget,
  image: ReferenceImagePayload,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const extension = image.mime === 'image/jpeg' ? '.jpg' : image.mime === 'image/webp' ? '.webp' : '.png'
  const digest = createHash('sha256').update(image.bytes).digest('hex').slice(0, 16)
  const name = `dsh-forge-ref-${digest}${extension}`
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(image.bytes)], { type: image.mime }), name)
  form.append('type', 'input')
  form.append('overwrite', 'true')

  const composed = requestSignal(signal, timeoutMs)
  const url = `${target.endpoint}/upload/image`
  try {
    const response = await fetch(url, { method: 'POST', body: form, redirect: 'error', signal: composed.signal })
    const raw = await response.text()
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      payload = undefined
    }
    if (!response.ok) {
      throw new Error(`comfyui backend: ${url} answered HTTP ${response.status} — ${raw.replace(/\s+/g, ' ').slice(0, 200)}`)
    }
    const returned = prop(payload, 'name')
    if (typeof returned !== 'string' || returned.length === 0) {
      throw new Error(
        `comfyui backend: ${url} answered without a file name (${raw.slice(0, 200)}) — the reference image ` +
          `"${image.label}" did not make it into ComfyUI's input folder.`,
      )
    }
    const subfolder = prop(payload, 'subfolder')
    return typeof subfolder === 'string' && subfolder.length > 0 ? `${subfolder}/${returned}` : returned
  } catch (error) {
    // A transport failure is re-thrown with the same prefix as every other call
    // in this module; an HTTP error already carries it.
    throw error instanceof Error && error.message.startsWith('comfyui backend:')
      ? error
      : new Error(`comfyui backend: ${url} 请求失败 — ${transportReason(error)} (参考图 "${image.label}")`)
  } finally {
    composed.dispose()
  }
}

/**
 * Turn `/prompt`'s node errors and error envelope into readable text.
 *
 * Shape: `{error: {type, message, details}, node_errors: {"7": {class_type,
 * errors: [{type, message, details, extra_info}]}}}`. The upstream strings are
 * quoted as they came; only the envelope's key names are interpreted.
 *
 * @param payload - parsed `/prompt` body.
 * @param status - HTTP status.
 * @returns one line naming the HTTP status and every node error found.
 */
export function describeComfyErrors(payload: unknown, status: number): string {
  const parts: string[] = []
  const error = prop(payload, 'error')
  const message = prop(error, 'message')
  const errorType = prop(error, 'type')
  if (typeof message === 'string') {
    parts.push(`HTTP ${status}: ${typeof errorType === 'string' ? `${errorType} — ` : ''}${message}`)
    const details = prop(error, 'details')
    if (typeof details === 'string' && details.length > 0) parts.push(`  details: ${details}`)
  } else if (typeof error === 'string') {
    parts.push(`HTTP ${status}: ${error}`)
  } else {
    parts.push(`HTTP ${status}`)
  }

  const nodeErrors = prop(payload, 'node_errors')
  if (typeof nodeErrors === 'object' && nodeErrors !== null) {
    for (const [nodeId, entry] of Object.entries(nodeErrors as Record<string, unknown>)) {
      const classType = prop(entry, 'class_type')
      const errors = prop(entry, 'errors')
      const list = Array.isArray(errors) ? errors : [entry]
      for (const item of list) {
        const itemType = prop(item, 'type')
        const itemMessage = prop(item, 'message')
        const details = prop(item, 'details')
        const extra = prop(item, 'extra_info')
        const extraText =
          typeof extra === 'object' && extra !== null
            ? ` [${Object.entries(extra as Record<string, unknown>)
                .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
                .join(' ')}]`
            : ''
        parts.push(
          `  node ${nodeId} (${typeof classType === 'string' ? classType : 'unknown'}): ` +
            `${typeof itemType === 'string' ? itemType : 'error'} — ` +
            `${typeof itemMessage === 'string' ? itemMessage : JSON.stringify(item)}` +
            `${typeof details === 'string' ? ` (${details})` : ''}${extraText}`,
        )
      }
    }
  }
  return parts.join('\n')
}

/**
 * Pull the failure out of a finished `/history` entry.
 *
 * ComfyUI reports a failed run as `status.status_str === 'error'` with the
 * execution error inside `status.messages`, whose traceback is the only place
 * the real Python exception is visible — so it is forwarded.
 *
 * @param entry - one `/history/<id>` entry.
 * @returns the formatted failure, or undefined when the run has not failed.
 */
export function describeHistoryFailure(entry: unknown): string | undefined {
  const status = prop(entry, 'status')
  const statusStr = prop(status, 'status_str')
  const messages = prop(status, 'messages')
  const failures: string[] = []
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!Array.isArray(message) || message[0] !== 'execution_error') continue
      const data = message[1]
      const nodeId = prop(data, 'node_id')
      const nodeType = prop(data, 'node_type')
      const exceptionType = prop(data, 'exception_type')
      const exceptionMessage = prop(data, 'exception_message')
      failures.push(
        `execution_error: node ${String(nodeId)} (${String(nodeType)}) ${String(exceptionType)}: ${String(exceptionMessage)}`,
      )
      const traceback = prop(data, 'traceback')
      if (Array.isArray(traceback) && traceback.length > 0) {
        failures.push(`  traceback:\n${traceback.map((line) => `    ${String(line).replace(/\n$/, '')}`).join('\n')}`)
      }
    }
  }
  if (failures.length > 0) return failures.join('\n')
  if (statusStr === 'error') return 'status_str=error（ComfyUI 没有给出 execution_error 明细）'
  return undefined
}

/**
 * Collect the image references a finished run produced.
 *
 * Saved images live in `outputs[<node>].images[]` as `{filename, subfolder,
 * type}`. Node ids are visited in numeric order so a batch keeps a stable order.
 */
export function collectImageRefs(entry: unknown): { filename: string; subfolder: string; type: string }[] {
  const outputs = prop(entry, 'outputs')
  if (typeof outputs !== 'object' || outputs === null) return []
  const ids = Object.keys(outputs as Record<string, unknown>).sort((a, b) => Number(a) - Number(b))
  const refs: { filename: string; subfolder: string; type: string }[] = []
  for (const id of ids) {
    const images = prop((outputs as Record<string, unknown>)[id], 'images')
    if (!Array.isArray(images)) continue
    for (const image of images) {
      const filename = prop(image, 'filename')
      if (typeof filename !== 'string' || filename.length === 0) continue
      const subfolder = prop(image, 'subfolder')
      const type = prop(image, 'type')
      refs.push({
        filename,
        subfolder: typeof subfolder === 'string' ? subfolder : '',
        type: typeof type === 'string' ? type : 'output',
      })
    }
  }
  return refs
}

/** Sleep, or reject as soon as the caller aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Which profile a run will **actually** use, given the weights that were found.
 *
 * A turbo request is a *preference*: it needs a distilled checkpoint to exist.
 * With only the base file installed the run must degrade to the base graph, or
 * the turbo sigma schedule would be paired with a checkpoint that was never
 * distilled for it — the classic way to get worse pictures while believing the
 * config applied. Every other family is taken at its word (a missing MOSS file is
 * already an error from {@link loadComfyModels}, not a silent fallback to Qwen).
 *
 * @param choice - the configured `comfyModel` value.
 * @param models - the file names `/object_info` yielded.
 * @returns the profile whose graph and sampler settings match those weights.
 */
export function effectiveProfile(choice: ComfyModelChoice | string | undefined, models: ComfyModels): ModelProfile {
  const profile = resolveProfile(choice)
  if (profile.variant === 'turbo' && turboUnetOf(models) === undefined) {
    const base = Object.values(MODEL_PROFILES).find(
      (candidate) => candidate.family === profile.family && candidate.variant === 'base',
    )
    if (base !== undefined) return base
  }
  return profile
}

/**
 * The placeholder values every profile's text-to-image graph reads.
 *
 * A superset on purpose: `renderWorkflow` only touches the placeholders a
 * template actually declares, so one map serves the `KSampler` graphs (steps,
 * CFG, sampler, scheduler), the turbo graph (sigmas, no steps) and any future one.
 * Values the profile owns — CFG, sampler, scheduler, sigmas, the negative prompt,
 * the filename prefix — come from the profile, never from this function.
 *
 * The sampler numbers come through {@link resolveSampling}, so a family that
 * publishes more than one register (MOSS-Image) runs the chosen one; a profile
 * without registers returns its own pair, which is why both Qwen profiles are
 * byte-identical to before the setting existed.
 *
 * @param profile - the effective profile of this call.
 * @param models - the file names the server reported.
 * @param request - prompt, canvas, count, seed, any explicit step count, and the
 *   optional quality-tier overrides (`cfg` / `negativePrompt`).
 * @param preset - the configured sampling register, if any.
 */
function textToImageValues(
  profile: ModelProfile,
  models: ComfyModels,
  request: GenerateRequest & WorkflowOverrides,
  preset?: string,
): Record<string, unknown> {
  assertLatentAligned(profile, request.width, request.height)
  const sampling = resolveSampling(profile, preset)
  return {
    unet_name: models.unet,
    weight_dtype: 'default',
    clip_name: models.clip,
    clip_type: models.clipType,
    vae_name: models.vae,
    prompt: request.prompt,
    negative_prompt: request.negativePrompt ?? profile.negativePrompt,
    width: request.width,
    height: request.height,
    batch_size: request.count,
    seed: request.seed ?? Math.floor(Math.random() * 2 ** 31),
    steps: request.steps ?? sampling.steps.default,
    cfg: request.cfg ?? sampling.sampler.cfg,
    // The optional sampler/scheduler overrides are validated by `tools.ts`; an
    // absent pair keeps the profile's own numbers, so a default call is unchanged.
    sampler_name: request.samplerName ?? sampling.sampler.name,
    scheduler: request.scheduler ?? sampling.sampler.scheduler,
    sigmas: sampling.steps.sigmas,
    filename_prefix: profile.filenamePrefix,
  }
}

/**
 * Render one profile's text-to-image graph for this server.
 *
 * The only server-dependent choice is the `QwenImage21Cache` shim: it is part of
 * the profile's graph, but a ComfyUI older than 0.37.0 does not know the node
 * class and would reject the whole prompt, so the shim is stripped when
 * `/object_info` did not list it ({@link ComfyModels.cache}). MOSS graphs carry no
 * shim, so the branch is inert for them.
 *
 * @param profile - the effective profile of this call.
 * @param models - the file names and capability flags the server reported.
 * @param request - prompt, canvas, count, seed and any overrides.
 * @param preset - the configured sampling register, if any.
 * @returns a rendered graph, ready for `/prompt`.
 */
export function renderTextToImage(
  profile: ModelProfile,
  models: ComfyModels,
  request: GenerateRequest & WorkflowOverrides,
  preset?: string,
): Record<string, unknown> {
  // Layout conditioning swaps in the family's layout graph and adds the two values
  // only that graph reads. Refused loudly rather than dropped: a profile without
  // the native nodes would otherwise submit a plain text-to-image graph and the
  // caller would think the boxes were honoured.
  if (request.layout !== undefined) {
    if (profile.layoutTemplate === undefined) {
      throw new Error(
        `comfyui backend: 布局（layout）只对 MOSS-Image 生效——只有 moss-sft 的布局通路（compiled JSON 当正向编码文本）存在，` +
          `当前 profile 是 ${profile.label}。`,
      )
    }
    const parsed = parseMossLayout(request.layout)
    return renderWorkflow(profile.layoutTemplate, {
      ...textToImageValues(profile, models, request, preset),
      layout_json: parsed.json,
    }) as Record<string, unknown>
  }
  const template =
    profile.family === 'qwen-image-2.1' && !models.cache ? withoutQwenCache(profile.textToImage) : profile.textToImage
  return renderWorkflow(template, textToImageValues(profile, models, request, preset)) as Record<string, unknown>
}

/**
 * Run one text-to-image job on ComfyUI and download the resulting images.
 *
 * The graph, sampler and step default come from the **effective** profile, so
 * this one function serves every family: Qwen base, Qwen turbo (which degrades to
 * base without a turbo checkpoint) and MOSS. `/prompt` → poll `/history/<id>` →
 * `/view` for each saved file; the bytes the caller receives are exactly what
 * `/view` served.
 *
 * @param target - the endpoint that answered.
 * @param models - the three file names read from `/object_info`.
 * @param request - prompt plus the already-aligned canvas size.
 * @param options - profile choice, timeout and poll interval.
 * @param signal - caller cancellation.
 * @returns one entry per produced image, in ComfyUI's order.
 * @throws On submission errors (with `node_errors` quoted), an execution error
 *   (with the traceback quoted), a timeout naming the prompt id, or a run that
 *   completed without producing an image.
 */
export async function generateViaComfyUi(
  target: ComfyTarget,
  models: ComfyModels,
  request: GenerateRequest & WorkflowOverrides,
  options: ComfyOptions,
  signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  const profile = effectiveProfile(options.comfyModel, models)
  const graph = renderTextToImage(profile, models, request, options.mossSampling)
  return await runGraph(target, graph, profile.family === 'moss-image' ? '出图（MOSS）' : '出图', options, signal)
}

/**
 * Run one already-built API-format graph and download the images it saved.
 *
 * `/prompt` → poll `/history/<id>` → `/view` for each saved file. The bytes the
 * caller receives are exactly what `/view` served, so what lands on disk equals
 * what ComfyUI produced.
 *
 * @param target - the endpoint that answered.
 * @param graph - a rendered graph with no placeholders left.
 * @param what - the run's name, used in error text (`出图` / `改图`).
 * @param options - timeout and poll interval.
 * @param signal - caller cancellation.
 * @returns one entry per produced image, in ComfyUI's order.
 * @throws On submission errors (with `node_errors` quoted), an execution error
 *   (with the traceback quoted), a timeout naming the prompt id, or a run that
 *   completed without producing an image.
 */
async function runGraph(
  target: ComfyTarget,
  graph: Record<string, unknown>,
  what: string,
  options: ComfyOptions,
  signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  const interval = options.pollIntervalMs ?? 750
  const deadline = Date.now() + options.timeoutMs
  const remaining = (): number => Math.max(1, deadline - Date.now())

  // Non-HTTP backends run first: MCP (`comfy-mcp` over the Host-supplied SDK)
  // then the comfy CLI, each with the same rendered graph; the `/prompt` path
  // below stays the last resort. Selection is environment-only
  // (`DSH_IMAGE_FORGE_BACKEND` etc.), so an empty environment — every existing
  // test and every user without a toolchain — keeps the historical behaviour
  // byte-for-byte.
  const backendRun = await runThroughBackends(
    {
      endpoint: target.endpoint,
      graph,
      what,
      timeoutMs: options.timeoutMs,
      pollIntervalMs: interval,
      signal,
      onPromptId: options.onPromptId,
    },
    resolveBackendPlan(process.env),
  )
  if (backendRun !== undefined) return backendRun.images

  const submission = await requestJson(
    `${target.endpoint}/prompt`,
    { method: 'POST', body: JSON.stringify({ prompt: graph, client_id: `${process.pid}-dsh-image-forge` }) },
    remaining(),
    signal,
  )
  if (!submission.ok) throw new Error(`comfyui backend: ${what}：/prompt 被拒绝\n${describeComfyErrors(submission.payload, submission.status)}`)
  const nodeErrors = prop(submission.payload, 'node_errors')
  if (typeof nodeErrors === 'object' && nodeErrors !== null && Object.keys(nodeErrors as object).length > 0) {
    throw new Error(`comfyui backend: ${what}：工作流校验未通过\n${describeComfyErrors(submission.payload, submission.status)}`)
  }
  const promptId = prop(submission.payload, 'prompt_id')
  if (typeof promptId !== 'string' || promptId.length === 0) {
    throw new Error(
      `comfyui backend: /prompt 没有返回 prompt_id（拿到 ${submission.raw.slice(0, 200)}）— 无法跟踪这次任务。`,
    )
  }
  // The run exists now: tell the caller before the first `/history` poll, so a
  // canvas task node can attach while ComfyUI is still queueing. `/prompt` here
  // is the adapter's only submission point — every generate variant funnels
  // through `runGraph` — so one callback covers all paths.
  options.onPromptId?.(promptId)

  for (;;) {
    const history = await requestJson(`${target.endpoint}/history/${promptId}`, { method: 'GET' }, remaining(), signal)
    if (!history.ok) {
      throw new Error(`comfyui backend: /history/${promptId} answered HTTP ${history.status} — ${history.raw.slice(0, 200)}`)
    }
    const entry = prop(history.payload, promptId)
    if (entry !== undefined) {
      const failure = describeHistoryFailure(entry)
      if (failure !== undefined) throw new Error(`comfyui backend: ${what}失败（prompt ${promptId}）\n${failure}`)
      const refs = collectImageRefs(entry)
      if (refs.length > 0) {
        const images: GeneratedImage[] = []
        for (const ref of refs) {
          const query = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type })
          const view = await requestBytes(`${target.endpoint}/view?${query}`, remaining(), signal)
          if (!view.ok) {
            throw new Error(
              `comfyui backend: /view?filename=${ref.filename} answered HTTP ${view.status}` +
                `${view.note === '' ? '' : ` — ${view.note}`}`,
            )
          }
          if (view.bytes.byteLength === 0) {
            throw new Error(`comfyui backend: /view?filename=${ref.filename} returned 0 bytes`)
          }
          images.push({ bytes: view.bytes, mime: sniffImageMime(view.bytes) ?? view.contentType ?? 'image/png' })
        }
        return images
      }
      if (prop(prop(entry, 'status'), 'completed') === true) {
        throw new Error(
          `comfyui backend: prompt ${promptId} 完成了但没有产出图片（outputs: ` +
            `${JSON.stringify(prop(entry, 'outputs') ?? {}).slice(0, 300)}）`,
        )
      }
    }
    if (Date.now() + interval >= deadline) {
      throw new Error(
        `comfyui backend: 等 prompt ${promptId} 超过 ${options.timeoutMs} ms 仍未出图。\n` +
          '  ComfyUI 可能还在跑（8GB 显存下 int8 权重会逐层换入换出，比发布值慢很多）：' +
          `去看 ComfyUI 面板的进度，或把插件的 timeoutMs 调大（例如 900000）后重试。` +
          `本次任务不会因此丢图，用 GET ${target.endpoint}/history/${promptId} 仍能查到结果。`,
      )
    }
    await sleep(interval, signal ?? new AbortController().signal)
  }
}

/**
 * The `resolution` budget ComfyUI's edit node takes: it resizes every reference
 * to about `resolution x resolution` pixels, so it mirrors the canvas' own area.
 * With both at the same budget, the reference latents and the canvas the sampler
 * starts from sit at the same scale — the official template warns that any other
 * combination shifts the edit.
 *
 * @param width - canvas width in pixels.
 * @param height - canvas height in pixels.
 * @returns the side whose square is closest to the canvas area, 32-aligned and
 *   inside the node's own 0–4096 bounds.
 */
export function referenceBudget(width: number, height: number): number {
  const aligned = Math.round(Math.sqrt(width * height) / 32) * 32
  return Math.min(4096, Math.max(32, aligned))
}

/**
 * The edit graph a profile offers, or a refusal naming what is missing.
 *
 * MOSS's edit graph is wired (T19: `MODEL_PROFILES['moss-sft'].imageToImage` in
 * `model-profiles.ts`), so every shipped profile carries one and this guard is a
 * latent one. It stays because a profile without `imageToImage` must **fail
 * loudly** rather than fake an edit out of the text-to-image graph — that would
 * submit a graph that silently ignores the references. The refusal quotes the
 * profile's own `todo` so a follow-up has its entry point in the error text
 * rather than only in a comment.
 *
 * @param profile - the effective profile of this call.
 * @returns its edit template and reference-slot builder.
 * @throws When the family has no edit graph.
 */
function requireEditGraph(profile: ModelProfile): { template: ApiGraph; build: (imageNames: readonly string[]) => ApiGraph } {
  if (profile.imageToImage === undefined) {
    throw new Error(
      `comfyui backend: ${profile.label} 的**改图**通路还没接入——本次改动只做它的文生图，` +
        '所以带参考图的请求在这里被拒绝，而不是递一张忽略参考图的图上去。\n' +
        (profile.todo === undefined ? '' : `  后续接入点：${profile.todo}\n`) +
        '  现在就要改图：把 comfyModel 换成 qwen21-base 或 qwen21-turbo（Qwen 的改图通路是通的）。',
    )
  }
  return profile.imageToImage
}

/**
 * Upload the references and wire them into a profile's edit graph.
 *
 * @param target - the endpoint that answered.
 * @param profile - the effective profile of this call.
 * @param models - the three weight file names.
 * @param request - must carry at least one reference.
 * @param options - timeout.
 * @param signal - caller cancellation.
 * @returns the rendered graph, ready for `/prompt`.
 */
async function renderEditGraph(
  target: ComfyTarget,
  profile: ModelProfile,
  models: ComfyModels,
  request: GenerateRequest & WorkflowOverrides,
  options: ComfyOptions,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const references = request.images ?? []
  if (references.length === 0) {
    throw new Error('comfyui backend: the edit path needs reference images, but request.images is empty')
  }
  const layout = request.layout
  if (layout !== undefined) {
    if (profile.family !== 'moss-image') {
      throw new Error('comfyui backend: layout + reference is only available on the MOSS-Image experimental path')
    }
    parseMossLayout(layout)
  }
  const edit = requireEditGraph(profile)
  const deadline = Date.now() + options.timeoutMs
  const names: string[] = []
  for (const reference of references) {
    names.push(await uploadReferenceImage(target, reference, Math.max(1, deadline - Date.now()), signal))
  }
  const built = layout === undefined ? edit.build(names) : mossLayoutEditWorkflow(names)
  // Old ComfyUI: drop the prefix-cache shim rather than submit a graph whose node
  // class the server does not know.
  const template = profile.family === 'qwen-image-2.1' && !models.cache ? withoutQwenCache(built) : built
  return renderWorkflow(template, {
    ...textToImageValues(profile, models, request, options.mossSampling),
    ...(layout === undefined ? {} : { layout_json: layout }),
    resolution: referenceBudget(request.width, request.height),
    filename_prefix: layout === undefined ? `${profile.filenamePrefix}-edit` : `${profile.filenamePrefix}-layout-edit`,
  }) as Record<string, unknown>
}

/**
 * Run one reference-image edit on ComfyUI and download the resulting images.
 *
 * The references are uploaded into ComfyUI's `input` folder first, because
 * `LoadImage` — the only node that feeds image pixels into a graph — reads from
 * there and has no "load this path" input. The graph is then the profile's edit
 * graph (for Qwen: the text-to-image skeleton with the official edit template's
 * encode node). A profile without one is refused, not silently degraded.
 *
 * @param target - the endpoint that answered.
 * @param models - the three file names read from `/object_info`.
 * @param request - edit prompt, canvas, and at least one reference image.
 * @param options - profile choice, timeout and poll interval.
 * @param signal - caller cancellation.
 * @returns one entry per produced image, in ComfyUI's order.
 * @throws When the profile has no edit graph, no reference is present, an upload
 *   fails, or the run fails.
 */
export async function generateViaComfyUiEdit(
  target: ComfyTarget,
  models: ComfyModels,
  request: GenerateRequest & WorkflowOverrides,
  options: ComfyOptions,
  signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  const profile = effectiveProfile(options.comfyModel, models)
  const graph = await renderEditGraph(target, profile, models, request, options, signal)
  return await runGraph(target, graph, '改图', options, signal)
}

/**
 * Run one Turbo text-to-image generation.
 *
 * Same engine as {@link generateViaComfyUi}; this entry point additionally
 * *requires* the effective profile to be the distilled one, because a caller that
 * asked for turbo explicitly (the blind test asks for 4, 8 and 12 steps) must see
 * a failure rather than a silently different checkpoint. The turbo graph defaults
 * its step count to {@link TURBO_STEPS} and drives the manual sigma schedule
 * instead of `KSampler` — both come from the profile.
 *
 * @param target - the endpoint that answered.
 * @param models - the three file names read from `/object_info`.
 * @param request - prompt, canvas, count, seed, optional step override.
 * @param options - profile choice, timeout and poll interval.
 * @param signal - caller cancellation.
 * @returns one entry per produced image, in ComfyUI's order.
 * @throws When no distilled checkpoint is installed, or with the adapter's usual
 *   quoted-upstream text when the run fails.
 */
export async function generateViaComfyUiTurbo(
  target: ComfyTarget,
  models: ComfyModels,
  request: GenerateRequest & WorkflowOverrides,
  options: ComfyOptions,
  signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  const profile = effectiveProfile(options.comfyModel, models)
  if (profile.variant !== 'turbo') {
    throw new Error(
      `comfyui backend: 要跑 turbo 但没有蒸馏版 DiT — /object_info 里只有 ${models.unet}。\n` +
        '  放一份 turbo 权重进 models/unet（或 models/diffusion_models），或把 comfyModel 改回 qwen21-base。',
    )
  }
  const graph = renderWorkflow(profile.textToImage, textToImageValues(profile, models, request, options.mossSampling)) as Record<string, unknown>
  return await runGraph(target, graph, '出图（turbo）', options, signal)
}

/**
 * Run one Turbo reference-image edit.
 *
 * As with the base edit path, references are uploaded first and wired in as
 * `LoadImage` nodes; the turbo-specific values (step default, sigma schedule,
 * `cfg` 1) all come from the profile.
 *
 * @param target - the endpoint that answered.
 * @param models - the three file names read from `/object_info`.
 * @param request - edit prompt, canvas, and at least one reference image.
 * @param options - profile choice, timeout and poll interval.
 * @param signal - caller cancellation.
 * @returns one entry per produced image, in ComfyUI's order.
 * @throws When no distilled checkpoint is installed, the profile has no edit
 *   graph, no reference is present, an upload fails, or the run fails.
 */
export async function generateViaComfyUiTurboEdit(
  target: ComfyTarget,
  models: ComfyModels,
  request: GenerateRequest & WorkflowOverrides,
  options: ComfyOptions,
  signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  const profile = effectiveProfile(options.comfyModel, models)
  if (profile.variant !== 'turbo') {
    throw new Error(
      `comfyui backend: 要跑 turbo 改图但没有蒸馏版 DiT — /object_info 里只有 ${models.unet}。\n` +
        '  放一份 turbo 权重进 models/unet（或 models/diffusion_models），或把 comfyModel 改回 qwen21-base。',
    )
  }
  const graph = await renderEditGraph(target, profile, models, request, options, signal)
  return await runGraph(target, graph, '改图（turbo）', options, signal)
}

/** One GPU as ComfyUI's own `/system_stats` reports it. */
export interface ComfyDevice {
  /** `nvidia-smi`-style product name, e.g. `NVIDIA GeForce RTX 4070 Laptop GPU`. */
  readonly name: string
  /** Device type (`cuda`, `cpu`, …), when the server said. */
  readonly type: string | null
  /** Total VRAM in MiB, when reported. */
  readonly vram_total_MiB: number | null
  /** Free VRAM in MiB at the moment of the call, when reported. */
  readonly vram_free_MiB: number | null
}

/** What `/system_stats` can tell the status tool; never throws. */
export interface ComfySystemStats {
  /** ComfyUI's own version string, e.g. `0.41.3`. */
  readonly version: string | null
  /** One entry per device ComfyUI enumerated. */
  readonly devices: readonly ComfyDevice[]
  /** Why the numbers are missing, when the call did not produce them. */
  readonly note?: string
}

/**
 * Read `/system_stats` from a ComfyUI that already answered.
 *
 * This exists so `image_forge_status` can report the GPU and its remaining VRAM
 * without spawning `nvidia-smi`: the card that matters is the one ComfyUI loaded
 * its weights onto, and ComfyUI is the only party that knows. Every field is
 * optional in practice — an older server, or a CPU-only one, simply yields fewer
 * numbers rather than an error.
 *
 * @param endpoint - origin that already passed {@link discoverComfyUi}.
 * @param timeoutMs - probe budget; a status call must not hang on this.
 * @param signal - caller cancellation.
 * @returns the version, devices, and a note when the endpoint refused to answer.
 */
export async function comfySystemStats(
  endpoint: string,
  timeoutMs = 5000,
  signal?: AbortSignal,
): Promise<ComfySystemStats> {
  try {
    const response = await requestJson(`${endpoint}/system_stats`, { method: 'GET' }, timeoutMs, signal)
    if (!response.ok) return { version: null, devices: [], note: `GET /system_stats → HTTP ${String(response.status)}` }
    const system = prop(response.payload, 'system')
    const devices = prop(response.payload, 'devices')
    return {
      version: typeof prop(system, 'comfyui_version') === 'string' ? prop(system, 'comfyui_version') as string : null,
      devices: Array.isArray(devices)
        ? devices.map((device) => ({
            name: typeof prop(device, 'name') === 'string' ? prop(device, 'name') as string : 'unknown',
            type: typeof prop(device, 'type') === 'string' ? prop(device, 'type') as string : null,
            vram_total_MiB: typeof prop(device, 'vram_total') === 'number' ? Math.round((prop(device, 'vram_total') as number) / 1024 ** 2) : null,
            vram_free_MiB: typeof prop(device, 'vram_free') === 'number' ? Math.round((prop(device, 'vram_free') as number) / 1024 ** 2) : null,
          }))
        : [],
    }
  } catch (error) {
    return { version: null, devices: [], note: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Probe the ComfyUI backend for a status report; never throws.
 *
 * @param options - endpoint, candidate ports, and probe budget.
 * @param signal - caller cancellation.
 * @returns reachability, the endpoint that answered, the attempt trail, and —
 *   when a server answered — whether the configured profile's weights are visible.
 */
export async function probeComfyUi(options: ComfyOptions, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let target: ComfyTarget
  try {
    target = await discoverComfyUi(options, signal)
  } catch (error) {
    return {
      configuredEndpoint: options.endpoint.length > 0 ? options.endpoint : null,
      candidatePorts: [...options.ports],
      reachable: false,
      note: error instanceof Error ? error.message : String(error),
    }
  }
  try {
    const models = await loadComfyModels(target, options, signal)
    const profile = resolveProfile(options.comfyModel)
    return {
      endpoint: target.endpoint,
      port: target.port,
      reachable: true,
      probed: target.probed,
      models: { ...models, ok: true },
      note: `ComfyUI 在跑，且 ${profile.label} 要的三个权重都能被它的加载器枚举到。`,
    }
  } catch (error) {
    return {
      endpoint: target.endpoint,
      port: target.port,
      reachable: true,
      probed: target.probed,
      models: { ok: false },
      note: error instanceof Error ? error.message : String(error),
    }
  }
}
