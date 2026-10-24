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
 *    the names in {@link MODEL_KINDS} are only examples used in error text.
 * 3. **Upstream errors are quoted, not swallowed.** `/prompt` answers with
 *    `node_errors` and `/history` carries an execution traceback; both reach the
 *    caller as readable text instead of a bare 400.
 *
 * The graph is the official Qwen-Image 2.1 text-to-image template that ships
 * with ComfyUI (`comfyui_workflow_templates_json/templates/
 * image_qwen_image_2_1_t2i.json`), reduced to the nodes needed without the
 * optional prompt-enhancer branch: `UNETLoader` → `KSampler.model`,
 * `CLIPLoader(type=qwen_image)` → `TextEncodeQwenImage21` → `KSampler`,
 * `VAELoader` → `VAEDecode`, `EmptyLatentImage` → `KSampler.latent_image`,
 * `VAEDecode` → `SaveImage`. The template's `QwenImage21Cache`,
 * `ResolutionSelector` and prompt-enhancer nodes are dropped: the first two only
 * trade speed for VRAM (we size the canvas ourselves in `ratio.ts`), and the
 * enhancer needs weights this plugin does not require.
 *
 * The edit (image-to-image) graph is the same skeleton plus the reference slots,
 * taken from the official `image_qwen_image_2_1_image_edit.json` template: its
 * `TextEncodeQwenImage21` node takes a `vae`, an autogrow `images.image_N` input
 * per reference (up to ten) and a `resolution` pixel budget, and the reference
 * pixels enter ComfyUI through `POST /upload/image` as `LoadImage` inputs. The
 * template's `ComfySwitchNode` (its "custom size" switch) has no counterpart
 * here because the plugin always supplies an explicit canvas, exactly as the
 * text-to-image path does; the template builds its default canvas from the first
 * reference at a 32-aligned ~1.5 MP budget, which is what `ratio_follow` resolves to.
 */
import { createHash } from 'node:crypto'
import { sniffImageMime, type GeneratedImage, type GenerateRequest, type ReferenceImagePayload } from './images.ts'

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
  /** Budget for one whole generation, from `/prompt` to the last image byte. */
  readonly timeoutMs: number
  /** Per-port reachability budget during discovery. */
  readonly portProbeTimeoutMs?: number
  /** Gap between `/history` polls. */
  readonly pollIntervalMs?: number
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

/** The three weight files one Qwen-Image generation needs, as the server named them. */
export interface ComfyModels {
  /** `UNETLoader.unet_name` — the DiT. */
  readonly unet: string
  /** `CLIPLoader.clip_name` — the text encoder. */
  readonly clip: string
  /** `VAELoader.vae_name` — the VAE. */
  readonly vae: string
  /** `CLIPLoader.type`, resolved from that input's own option list. */
  readonly clipType: string
}

/** Loader field, folder, and (error-text only) example file for one weight. */
const MODEL_KINDS = {
  unet: {
    loader: 'UNETLoader',
    field: 'unet_name',
    folder: 'unet',
    what: 'Qwen-Image 2.1 的 DiT（去噪主干）',
    example: 'qwen_image_2.1_int8_convrot.safetensors',
    bonus: [/image/i, /2[._-]?1/, /int8/i],
  },
  clip: {
    loader: 'CLIPLoader',
    field: 'clip_name',
    folder: 'clip',
    what: 'Qwen-Image 2.1 的文本编码器（Qwen3-VL 8B）',
    example: 'qwen3vl_8b_int8_convrot.safetensors',
    bonus: [/vl/i, /8b/i, /int8/i],
  },
  vae: {
    loader: 'VAELoader',
    field: 'vae_name',
    folder: 'vae',
    what: 'Qwen-Image 2.1 的 VAE',
    example: 'qwen_image_2.1_vae_bf16.safetensors',
    bonus: [/vae/i, /2[._-]?1/, /bf16/i],
  },
} as const

/** One weight kind key. */
type ModelKind = keyof typeof MODEL_KINDS

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
      return { status: response.status, ok: false, bytes: new Uint8Array(), contentType: null, note }
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
      '  启动 ComfyUI（桌面版/便携版都可以）后重试；如果它监听在别的端口，把该端口写进 comfyPorts 或直接写 comfyEndpoint。\n' +
      '  部署步骤（下载、放权重、校验）见 docs/comfyui-deployment.md；也可以先跑 qwen_image_status 看缺什么。',
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
 * Pick the file whose name best matches an ordered pattern list.
 *
 * A candidate must match `required`; each additional pattern it matches adds
 * weight (earlier patterns weigh more). Ties keep the server's own order, so the
 * choice is deterministic for a given `/object_info`. Matching the whole name
 * rather than the basename means a file in a subfolder still matches.
 * This is what keeps the PE (prompt-enhancer) text encoders from being picked as
 * the text encoder: they carry neither `vl` nor `8b`.
 */
function pickModelFile(options: readonly string[], required: RegExp, bonuses: readonly RegExp[]): string | undefined {
  let best: { name: string; score: number } | undefined
  for (const name of options) {
    if (!required.test(name)) continue
    let score = 0
    for (const [index, pattern] of bonuses.entries()) if (pattern.test(name)) score += bonuses.length - index
    if (best === undefined || score > best.score) best = { name, score }
  }
  return best?.name
}

/** Where a weight belongs, phrased for the machine that is running this plugin. */
function folderHint(modelsDir: string, folder: string): string {
  return modelsDir.trim().length > 0
    ? `${modelsDir.trim().replace(/[\\/]+$/, '')}\\${folder}\\`
    : `ComfyUI 的 models\\${folder}\\ 目录（桌面版/便携版的模型路径见 ComfyUI 设置或 extra_model_paths.yaml）`
}

/**
 * Read the three Qwen-Image weight file names off the running server.
 *
 * @param target - the endpoint that answered.
 * @param options - used for the model-directory hint and the timeout.
 * @param signal - caller cancellation.
 * @returns the names ComfyUI itself listed, plus the resolved `CLIPLoader.type`.
 * @throws When a loader, its option list, a Qwen-named file, or a usable
 *   `CLIPLoader.type` is missing. The message names the loader, the field, the
 *   file it wants, and the directory to put it in — this is checked before
 *   `/prompt`, so a missing weight never becomes a pile of node errors.
 */
export async function loadComfyModels(target: ComfyTarget, options: ComfyOptions, signal?: AbortSignal): Promise<ComfyModels> {
  const timeout = options.portProbeTimeoutMs ?? 800
  const kinds = Object.keys(MODEL_KINDS) as ModelKind[]
  const loaded = new Map<ModelKind, ComfyResponse>()
  const clipInfo = requestJson(`${target.endpoint}/object_info/CLIPLoader`, { method: 'GET' }, timeout, signal)
  for (const kind of kinds.filter((kind) => kind !== 'clip')) {
    const node = MODEL_KINDS[kind].loader
    loaded.set(kind, await requestJson(`${target.endpoint}/object_info/${node}`, { method: 'GET' }, timeout, signal))
  }
  loaded.set('clip', await clipInfo)

  const chosen = new Map<ModelKind, string>()
  for (const kind of kinds) {
    const spec = MODEL_KINDS[kind]
    const response = loaded.get(kind)
    const optionsList = response === undefined ? undefined : loaderField(response.payload, spec.loader, spec.field)
    if (optionsList === undefined) {
      throw new Error(
        `comfyui backend: 读不到 ${spec.loader}.${spec.field} — 这个 ComfyUI 没有该加载器节点，` +
          `或 /object_info 的返回不是预期形状。缺的是「${spec.what}」，` +
          `请在 ComfyUI 里确认 ${spec.loader} 节点可用后重试。`,
      )
    }
    const name = pickModelFile(optionsList, /qwen/i, spec.bonus)
    if (name === undefined) {
      const seen = optionsList.length === 0 ? '（空）' : optionsList.join(', ')
      throw new Error(
        `comfyui backend: 缺模型文件 — ${spec.loader}.${spec.field} 里没有任何带 "qwen" 的文件。\n` +
          `  需要：${spec.what}\n` +
          `  例如：${spec.example}\n` +
          `  放到：${folderHint(options.modelsDir, spec.folder)}\n` +
          `  ${spec.loader} 当前能看到 ${optionsList.length} 个文件：${seen}\n` +
          '  （文件名里带 qwen 的才会被识别；本插件不下载、不转换权重。）',
      )
    }
    chosen.set(kind, name)
  }

  const clipTypes = loaderField(loaded.get('clip')?.payload, MODEL_KINDS.clip.loader, 'type')
  const clipType = clipTypes?.includes('qwen_image') === true ? 'qwen_image' : clipTypes?.find((type) => /qwen/i.test(type))
  if (clipType === undefined) {
    throw new Error(
      `comfyui backend: CLIPLoader.type 里没有 qwen 相关选项，无法确定文本编码器类型（${MODEL_KINDS.clip.what}）。` +
        `当前可选：${clipTypes === undefined ? '（读不到）' : clipTypes.join(', ')}`,
    )
  }

  return {
    unet: chosen.get('unet') as string,
    clip: chosen.get('clip') as string,
    vae: chosen.get('vae') as string,
    clipType,
  }
}

/**
 * The Qwen-Image 2.1 text-to-image graph, in ComfyUI's API format.
 *
 * `{{name}}` placeholders are filled by {@link renderWorkflow}; the three model
 * file names are placeholders on purpose — they come from `/object_info`.
 */
export const QWEN_IMAGE_WORKFLOW: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
  '1': { class_type: 'UNETLoader', inputs: { unet_name: '{{unet_name}}', weight_dtype: '{{weight_dtype}}' } },
  '2': { class_type: 'CLIPLoader', inputs: { clip_name: '{{clip_name}}', type: '{{clip_type}}' } },
  '3': { class_type: 'VAELoader', inputs: { vae_name: '{{vae_name}}' } },
  '4': {
    class_type: 'TextEncodeQwenImage21',
    inputs: { clip: ['2', 0], prompt: '{{prompt}}', negative_prompt: '{{negative_prompt}}', resolution: 1024 },
  },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: '{{batch_size}}' } },
  '6': {
    class_type: 'KSampler',
    inputs: {
      model: ['1', 0],
      positive: ['4', 0],
      negative: ['4', 1],
      latent_image: ['5', 0],
      seed: '{{seed}}',
      steps: '{{steps}}',
      cfg: '{{cfg}}',
      sampler_name: '{{sampler_name}}',
      scheduler: '{{scheduler}}',
      denoise: 1,
    },
  },
  '7': { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['3', 0] } },
  '8': { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: '{{filename_prefix}}' } },
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

/** How many reference images the edit graph wires up (the contract's `<image1>`…`<image10>`). */
export const EDIT_MAX_REFERENCES = 10

/** First node id used for the edit graph's `LoadImage` nodes (ids 1–8 are the graph itself). */
export const EDIT_IMAGE_NODE_BASE = 11
/**
 * The edit graph, which is the text-to-image graph with a different encode node:
 * `TextEncodeQwenImage21` additionally receives the VAE (it VAE-encodes each
 * reference into the condition) and a `resolution` pixel budget. The reference
 * slots themselves are added per call by {@link editWorkflow}.
 */
export const QWEN_IMAGE_EDIT_WORKFLOW: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
  ...QWEN_IMAGE_WORKFLOW,
  '4': {
    class_type: 'TextEncodeQwenImage21',
    inputs: {
      clip: ['2', 0],
      vae: ['3', 0],
      prompt: '{{prompt}}',
      negative_prompt: '{{negative_prompt}}',
      resolution: '{{resolution}}',
    },
  },
}

/**
 * Wire one `LoadImage` per reference into the edit graph's autogrow inputs.
 *
 * ComfyUI's schema DSL expands the autogrow `images` input into
 * `images.image_1` … `images.image_16`, all optional, and validates by those
 * dotted names — which is also how the official edit template refers to them.
 *
 * @param imageNames - file names inside ComfyUI's `input` folder, in prompt
 *   order, as `/upload/image` reported them.
 * @returns a fresh API-format graph with one loader per reference.
 * @throws When the list is empty or longer than {@link EDIT_MAX_REFERENCES}.
 */
export function editWorkflow(
  imageNames: readonly string[],
): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  if (imageNames.length === 0) throw new Error('comfyui backend: the edit graph needs at least one reference image')
  if (imageNames.length > EDIT_MAX_REFERENCES) {
    throw new Error(
      `comfyui backend: the edit graph wires ${EDIT_MAX_REFERENCES} reference slots, got ${imageNames.length}`,
    )
  }
  const graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> = { ...QWEN_IMAGE_EDIT_WORKFLOW }
  const encode = { class_type: 'TextEncodeQwenImage21', inputs: { ...(QWEN_IMAGE_EDIT_WORKFLOW['4'] as { inputs: Record<string, unknown> }).inputs } }
  graph['4'] = encode
  for (const [position, name] of imageNames.entries()) {
    const id = String(EDIT_IMAGE_NODE_BASE + position)
    graph[id] = { class_type: 'LoadImage', inputs: { image: name } }
    encode.inputs[`images.image_${position + 1}`] = [id, 0]
  }
  return graph
}

// ---------------------------------------------------------------------------
// Turbo: the distilled checkpoint and its fixed 8-step sigma schedule
// ---------------------------------------------------------------------------

/**
 * The sigma schedule the Turbo checkpoint was distilled for.
 *
 * This is copied verbatim from the official `image_qwen_image_2_1_turbo_t2i.json`
 * template's `ManualSigmas` node, and it is what makes 8 steps enough. Raising
 * the step count **without** swapping this schedule in makes the result worse,
 * not better: the template's own note says so, and that is why the turbo path
 * passes the schedule rather than only a smaller `steps`.
 */
export const TURBO_SIGMAS = '1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0'

/** Steps the schedule above describes: one per remaining sigma. */
export const TURBO_STEPS = 8

/**
 * The Turbo text-to-image graph, in ComfyUI's API format.
 *
 * The Turbo templates do **not** use `KSampler`. They drive
 * `SamplerCustomAdvanced`, which takes the noise, guider, sampler and sigmas as
 * separate inputs — that separation is the only way to hand it a `ManualSigmas`
 * node, and the manual schedule is the whole point of the turbo checkpoint. So
 * this graph has a different shape from {@link QWEN_IMAGE_WORKFLOW}, not just
 * different numbers:
 *
 * ```
 * RandomNoise ─┐
 * CFGGuider ───┼→ SamplerCustomAdvanced → VAEDecode → SaveImage
 * KSamplerSelect┤
 * ManualSigmas ─┤
 * EmptyLatentImage ─┘
 * ```
 *
 * Note also what is *absent*: the non-turbo graph's `QwenImage21Cache` is not
 * used here either, matching the official template, which leaves it out for the
 * turbo path.
 */
export const QWEN_IMAGE_TURBO_WORKFLOW: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
  '1': { class_type: 'UNETLoader', inputs: { unet_name: '{{unet_name}}', weight_dtype: '{{weight_dtype}}' } },
  '2': { class_type: 'CLIPLoader', inputs: { clip_name: '{{clip_name}}', type: '{{clip_type}}' } },
  '3': { class_type: 'VAELoader', inputs: { vae_name: '{{vae_name}}' } },
  '4': {
    class_type: 'TextEncodeQwenImage21',
    inputs: { clip: ['2', 0], prompt: '{{prompt}}', negative_prompt: '{{negative_prompt}}', resolution: 1024 },
  },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: '{{batch_size}}' } },
  // The four ingredients SamplerCustomAdvanced consumes, one node each.
  '6': { class_type: 'RandomNoise', inputs: { noise_seed: '{{seed}}' } },
  '7': {
    class_type: 'CFGGuider',
    inputs: {
      model: ['1', 0],
      positive: ['4', 0],
      negative: ['4', 1],
      cfg: '{{cfg}}',
    },
  },
  '8': { class_type: 'KSamplerSelect', inputs: { sampler_name: '{{sampler_name}}' } },
  '9': { class_type: 'ManualSigmas', inputs: { sigmas: '{{sigmas}}' } },
  '10': {
    class_type: 'SamplerCustomAdvanced',
    inputs: {
      noise: ['6', 0],
      guider: ['7', 0],
      sampler: ['8', 0],
      sigmas: ['9', 0],
      latent_image: ['5', 0],
    },
  },
  '11': { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['3', 0] } },
  '12': { class_type: 'SaveImage', inputs: { images: ['11', 0], filename_prefix: '{{filename_prefix}}' } },
}

/**
 * The Turbo edit graph: the turbo skeleton plus the edit encode node plus the
 * reference slots that {@link editTurboWorkflow} wires per call.
 *
 * `cfg` is **1**, the same as the turbo t2i graph. The official turbo edit
 * template's JSON shows a stale `[8]` widget on `CFGGuider`, but that value is
 * dead: the node's cfg is wired to the template's outer input, and the outer
 * default — per docs.comfy.org, the Comfy-Org model card and the Turbo model
 * card — is 1. At cfg 1 ComfyUI skips the negative conditioning pass entirely,
 * so an elevated cfg with an empty negative prompt does not sharpen the edit;
 * it degrades it.
 */
export const QWEN_IMAGE_TURBO_EDIT_WORKFLOW: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
  ...QWEN_IMAGE_TURBO_WORKFLOW,
  '4': {
    class_type: 'TextEncodeQwenImage21',
    inputs: {
      clip: ['2', 0],
      vae: ['3', 0],
      prompt: '{{prompt}}',
      negative_prompt: '{{negative_prompt}}',
      resolution: '{{resolution}}',
    },
  },
}

/** First node id for the turbo edit graph's `LoadImage` nodes (ids 1–12 are the graph). */
export const TURBO_EDIT_IMAGE_NODE_BASE = 13

/**
 * Wire one `LoadImage` per reference into the turbo edit graph.
 *
 * Same autogrow contract as {@link editWorkflow} — the encode node takes
 * `images.image_1` … `images.image_16` — but against the turbo skeleton.
 *
 * @param imageNames - file names inside ComfyUI's `input` folder, in prompt order.
 * @returns a fresh API-format graph with one loader per reference.
 * @throws When the list is empty or longer than {@link EDIT_MAX_REFERENCES}.
 */
export function editTurboWorkflow(
  imageNames: readonly string[],
): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  if (imageNames.length === 0) throw new Error('comfyui backend: the edit graph needs at least one reference image')
  if (imageNames.length > EDIT_MAX_REFERENCES) {
    throw new Error(
      `comfyui backend: the edit graph wires ${EDIT_MAX_REFERENCES} reference slots, got ${imageNames.length}`,
    )
  }
  const graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> = { ...QWEN_IMAGE_TURBO_EDIT_WORKFLOW }
  const encode = {
    class_type: 'TextEncodeQwenImage21',
    inputs: { ...(QWEN_IMAGE_TURBO_EDIT_WORKFLOW['4'] as { inputs: Record<string, unknown> }).inputs },
  }
  graph['4'] = encode
  for (const [position, name] of imageNames.entries()) {
    const id = String(TURBO_EDIT_IMAGE_NODE_BASE + position)
    graph[id] = { class_type: 'LoadImage', inputs: { image: name } }
    encode.inputs[`images.image_${position + 1}`] = [id, 0]
  }
  return graph
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
  form.append('image', new Blob([image.bytes], { type: image.mime }), name)
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
 * Run one text-to-image job on ComfyUI and download the resulting images.
 *
 * `/prompt` → poll `/history/<id>` → `/view` for each saved file. The bytes the
 * caller receives are exactly what `/view` served, so what lands on disk equals
 * what ComfyUI produced.
 *
 * @param target - the endpoint that answered.
 * @param models - the three file names read from `/object_info`.
 * @param request - prompt plus the already-aligned canvas size.
 * @param options - timeout and poll interval.
 * @param signal - caller cancellation.
 * @returns one entry per produced image, in ComfyUI's order.
 * @throws On submission errors (with `node_errors` quoted), an execution error
 *   (with the traceback quoted), a timeout naming the prompt id, or a run that
 *   completed without producing an image.
 */
export async function generateViaComfyUi(
  target: ComfyTarget,
  models: ComfyModels,
  request: GenerateRequest,
  options: ComfyOptions,
  signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  const graph = renderWorkflow(QWEN_IMAGE_WORKFLOW, {
    unet_name: models.unet,
    weight_dtype: 'default',
    clip_name: models.clip,
    clip_type: models.clipType,
    vae_name: models.vae,
    prompt: request.prompt,
    negative_prompt: '',
    width: request.width,
    height: request.height,
    batch_size: request.count,
    seed: request.seed ?? Math.floor(Math.random() * 2 ** 31),
    steps: request.steps ?? 25,
    cfg: 1,
    sampler_name: 'euler',
    scheduler: 'simple',
    filename_prefix: 'dsh-image-forge',
  }) as Record<string, unknown>
  return await runGraph(target, graph, '出图', options, signal)
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
 * Run one reference-image edit on ComfyUI and download the resulting images.
 *
 * The references are uploaded into ComfyUI's `input` folder first, because
 * `LoadImage` — the only node that feeds image pixels into a graph — reads from
 * there and has no "load this path" input. The graph is then the text-to-image
 * graph with the official edit template's encode node.
 *
 * @param target - the endpoint that answered.
 * @param models - the three file names read from `/object_info`.
 * @param request - edit prompt, canvas, and at least one reference image.
 * @param options - timeout and poll interval.
 * @param signal - caller cancellation.
 * @returns one entry per produced image, in ComfyUI's order.
 * @throws When no reference is present, an upload fails, or the run fails.
 */
export async function generateViaComfyUiEdit(
  target: ComfyTarget,
  models: ComfyModels,
  request: GenerateRequest,
  options: ComfyOptions,
  signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  const references = request.images ?? []
  if (references.length === 0) {
    throw new Error('comfyui backend: the edit path needs reference images, but request.images is empty')
  }
  const deadline = Date.now() + options.timeoutMs
  const names: string[] = []
  for (const reference of references) {
    names.push(await uploadReferenceImage(target, reference, Math.max(1, deadline - Date.now()), signal))
  }
  const graph = renderWorkflow(editWorkflow(names), {
    unet_name: models.unet,
    weight_dtype: 'default',
    clip_name: models.clip,
    clip_type: models.clipType,
    vae_name: models.vae,
    prompt: request.prompt,
    negative_prompt: '',
    resolution: referenceBudget(request.width, request.height),
    width: request.width,
    height: request.height,
    batch_size: request.count,
    seed: request.seed ?? Math.floor(Math.random() * 2 ** 31),
    steps: request.steps ?? 25,
    cfg: 1,
    sampler_name: 'euler',
    scheduler: 'simple',
    filename_prefix: 'dsh-image-forge-edit',
  }) as Record<string, unknown>
  return await runGraph(target, graph, '改图', options, signal)
}

/**
 * Run one Turbo text-to-image generation.
 *
 * Differs from {@link generateViaComfyUi} in exactly two ways, both of which the
 * official turbo template prescribes: the step count defaults to
 * {@link TURBO_STEPS} (not 25) and the graph is driven by the manual sigma
 * schedule (not `KSampler`). A caller that passes an explicit `steps` gets it —
 * the override exists so the blind test can ask for 4, 8 and 12 and see what
 * actually happens, rather than trusting the "8 is enough" note.
 *
 * @param target - the endpoint that answered.
 * @param models - the three file names read from `/object_info`.
 * @param request - prompt, canvas, count, seed, optional step override.
 * @param options - timeout and poll interval.
 * @param signal - caller cancellation.
 * @returns one entry per produced image, in ComfyUI's order.
 * @throws With the adapter's usual quoted-upstream text when the run fails.
 */
export async function generateViaComfyUiTurbo(
  target: ComfyTarget,
  models: ComfyModels,
  request: GenerateRequest,
  options: ComfyOptions,
  signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  const graph = renderWorkflow(QWEN_IMAGE_TURBO_WORKFLOW, {
    unet_name: models.unet,
    weight_dtype: 'default',
    clip_name: models.clip,
    clip_type: models.clipType,
    vae_name: models.vae,
    prompt: request.prompt,
    negative_prompt: '',
    width: request.width,
    height: request.height,
    batch_size: request.count,
    seed: request.seed ?? Math.floor(Math.random() * 2 ** 31),
    steps: request.steps ?? TURBO_STEPS,
    cfg: 1,
    sampler_name: 'euler',
    scheduler: 'simple',
    sigmas: TURBO_SIGMAS,
    filename_prefix: 'dsh-image-forge-turbo',
  }) as Record<string, unknown>
  return await runGraph(target, graph, '出图（turbo）', options, signal)
}

/**
 * Run one Turbo reference-image edit.
 *
 * As with the base edit path, references are uploaded first and wired in as
 * `LoadImage` nodes. The turbo-specific values are the step default
 * ({@link TURBO_STEPS}) and the manual sigma schedule; `cfg` stays 1, as in
 * every official Qwen-Image 2.1 template.
 *
 * @param target - the endpoint that answered.
 * @param models - the three file names read from `/object_info`.
 * @param request - edit prompt, canvas, and at least one reference image.
 * @param options - timeout and poll interval.
 * @param signal - caller cancellation.
 * @returns one entry per produced image, in ComfyUI's order.
 * @throws When no reference is present, an upload fails, or the run fails.
 */
export async function generateViaComfyUiTurboEdit(
  target: ComfyTarget,
  models: ComfyModels,
  request: GenerateRequest,
  options: ComfyOptions,
  signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  const references = request.images ?? []
  if (references.length === 0) {
    throw new Error('comfyui backend: the edit path needs reference images, but request.images is empty')
  }
  const deadline = Date.now() + options.timeoutMs
  const names: string[] = []
  for (const reference of references) {
    names.push(await uploadReferenceImage(target, reference, Math.max(1, deadline - Date.now()), signal))
  }
  const graph = renderWorkflow(editTurboWorkflow(names), {
    unet_name: models.unet,
    weight_dtype: 'default',
    clip_name: models.clip,
    clip_type: models.clipType,
    vae_name: models.vae,
    prompt: request.prompt,
    negative_prompt: '',
    resolution: referenceBudget(request.width, request.height),
    width: request.width,
    height: request.height,
    batch_size: request.count,
    seed: request.seed ?? Math.floor(Math.random() * 2 ** 31),
    steps: request.steps ?? TURBO_STEPS,
    cfg: 1,
    sampler_name: 'euler',
    scheduler: 'simple',
    sigmas: TURBO_SIGMAS,
    filename_prefix: 'dsh-image-forge-turbo-edit',
  }) as Record<string, unknown>
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
 * This exists so `qwen_image_status` can report the GPU and its remaining VRAM
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
 *   when a server answered — whether the three Qwen-Image weights are visible.
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
    return {
      endpoint: target.endpoint,
      port: target.port,
      reachable: true,
      probed: target.probed,
      models: { ...models, ok: true },
      note: 'ComfyUI 在跑，且三个 Qwen-Image 权重都能被它的加载器枚举到。',
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
