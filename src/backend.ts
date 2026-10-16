/**
 * Cloud image backend (bring-your-own key).
 *
 * Primary wire format is the OpenAI images API — `POST {baseUrl}/images/generations`
 * — which also covers Alibaba DashScope's OpenAI-compatible endpoint
 * (`https://dashscope.aliyuncs.com/compatible-mode/v1`). The native DashScope
 * async task API is declared as `apiStyle: 'dashscope'` but not implemented in
 * v0.1: it is a different request/poll shape, and a declared-but-unimplemented
 * path that says so is better than one that half-works.
 *
 * The API key lives in memory only. It is read from the plugin config or the
 * environment, is sent as an `Authorization` header, and is scrubbed out of
 * every error message this module produces — it never reaches disk or a log.
 */

/** Wire format of the configured endpoint. */
export type ApiStyle = 'openai' | 'dashscope'

/** Resolved cloud-API settings for one call. */
export interface ApiSettings {
  /** Origin + path prefix without a trailing slash, e.g. `https://api.openai.com/v1`. */
  readonly baseUrl: string
  /** Bearer token, already resolved from config or environment. */
  readonly apiKey: string
  /** Model id sent in the request body. */
  readonly model: string
  /** Wire format selector. */
  readonly style: ApiStyle
}

/** Where the effective API key came from — reported, never the key itself. */
export interface ApiKeySource {
  /** Environment variable names consulted, in order, after the config value. */
  readonly envVars: readonly string[]
  /** The key, when one was found. */
  readonly key?: string
  /** `config`, an environment variable name, or undefined when nothing was found. */
  readonly source?: string
}

/** Environment variables consulted for a key, in priority order. */
export const API_KEY_ENV_VARS = ['QWEN_IMAGE_API_KEY', 'DASHSCOPE_API_KEY', 'OPENAI_API_KEY'] as const

/** One decoded image returned by a backend. */
export interface GeneratedImage {
  /** Raw image bytes. */
  readonly bytes: Uint8Array
  /** Upstream content type when the backend reported one. */
  readonly mime: string
}

/** One reference image as a backend receives it (edit paths only). */
export interface ReferenceImagePayload {
  /** Raw image bytes, exactly as the caller supplied them. */
  readonly bytes: Uint8Array
  /** Sniffed container, e.g. `image/png`. */
  readonly mime: string
  /** Short name used in error text, e.g. a file's basename. */
  readonly label: string
}

/** Everything a backend call needs besides the settings. */
export interface GenerateRequest {
  /** Finished prompt text, forwarded verbatim. */
  readonly prompt: string
  /** Aligned width in pixels. */
  readonly width: number
  /** Aligned height in pixels. */
  readonly height: number
  /** How many images to request. */
  readonly count: number
  /** Sampler steps, omitted when the caller did not ask. */
  readonly steps?: number
  /** Deterministic seed, omitted when the caller did not ask. */
  readonly seed?: number
  /** Ask for an alpha channel. */
  readonly transparent: boolean
  /**
   * Reference images for an edit call, in prompt order. Omitted (or empty) means
   * text-to-image, which is what every backend does by default. A backend that
   * cannot consume them must say so rather than dropping them: dropping one
   * shifts every `<imageN>` label the caller wrote in the prompt.
   */
  readonly images?: readonly ReferenceImagePayload[]
  /**
   * Explicit reference-conditioning budget (pixels per side) for a backend that
   * conditions on references. Omitted means "derive it yourself from the canvas",
   * which is what every backend did before this field existed; only the local
   * worker reads it, and it never changes the output size.
   */
  readonly referenceBudget?: number
}

/**
 * Resolve the effective API key without ever returning it to a log.
 *
 * @param configKey - value from the plugin config, which wins when non-blank.
 * @param env - environment lookup, injectable for tests.
 * @returns the key and which source supplied it; `key` is undefined when none.
 */
export function resolveApiKey(
  configKey: string | undefined,
  env: Record<string, string | undefined> = process.env,
): ApiKeySource {
  const trimmed = configKey?.trim()
  if (trimmed !== undefined && trimmed.length > 0) return { envVars: API_KEY_ENV_VARS, key: trimmed, source: 'config' }
  for (const name of API_KEY_ENV_VARS) {
    const value = env[name]?.trim()
    if (value !== undefined && value.length > 0) return { envVars: API_KEY_ENV_VARS, key: value, source: name }
  }
  return { envVars: API_KEY_ENV_VARS }
}

/** Replace every occurrence of the key (and obvious key shapes) with a marker. */
function redact(text: string, apiKey: string): string {
  let out = text
  if (apiKey.length > 0) out = out.split(apiKey).join('<redacted-key>')
  return out
    .replace(/(sk-|Bearer\s+)[A-Za-z0-9_\-.]{6,}/g, '$1<redacted-key>')
    .replace(/"(api_?key|apiKey|authorization)"\s*:\s*"[^"]*"/gi, '"$1":"<redacted-key>"')
}

/** One-line, bounded, key-scrubbed rendering of a response body. */
function summarizeBody(text: string, apiKey: string): string {
  const flat = redact(text, apiKey).replace(/\s+/g, ' ').trim()
  return flat.length > 400 ? `${flat.slice(0, 400)}…` : flat
}

/** Sniff the image container from its magic bytes. */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return undefined
}

/** Decode a base64 or `data:` payload into raw bytes. */
export function decodeImagePayload(payload: string): Uint8Array {
  const comma = payload.startsWith('data:') ? payload.indexOf(',') : -1
  const base64 = comma === -1 ? payload : payload.slice(comma + 1)
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length === 0) throw new Error('backend returned an empty image payload')
  return new Uint8Array(buffer)
}

/**
 * Normalize one entry of a backend's image array.
 *
 * Accepts, in order of preference: an object with `b64_json`/`b64`/`data`, or a
 * bare string that is either base64 or a `data:` URI. A remote URL entry is
 * fetched with the caller's abort signal.
 */
async function readImageEntry(entry: unknown, addressee: string, signal: AbortSignal): Promise<GeneratedImage> {
  if (typeof entry === 'string') return { bytes: decodeImagePayload(entry), mime: 'image/png' }
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`${addressee}: image entry is neither base64 nor an object (got ${typeof entry})`)
  }
  const record = entry as Record<string, unknown>
  for (const field of ['b64_json', 'b64', 'data', 'image'] as const) {
    const value = record[field]
    if (typeof value === 'string' && value.length > 0) {
      return { bytes: decodeImagePayload(value), mime: typeof record.mime_type === 'string' ? record.mime_type : 'image/png' }
    }
  }
  const url = record.url
  if (typeof url === 'string' && url.length > 0) {
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(`${addressee}: fetching returned image failed with HTTP ${response.status}`)
    return { bytes: new Uint8Array(await response.arrayBuffer()), mime: response.headers.get('content-type') ?? 'image/png' }
  }
  throw new Error(`${addressee}: image entry carries none of b64_json/b64/data/url`)
}

/** Pull the image array out of any of the envelope shapes seen in the wild. */
function readImageArray(payload: unknown): unknown[] | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  if (Array.isArray(record.data)) return record.data
  if (Array.isArray(record.images)) return record.images
  if (Array.isArray(record.output)) return record.output.map((item) => (typeof item === 'object' && item !== null ? (item as Record<string, unknown>).image ?? item : item))
  return undefined
}

/**
 * Render a backend's error envelope as a readable message.
 *
 * @param payload - parsed response body, when it parsed.
 * @param status - HTTP status code.
 * @returns a one-line explanation that mentions the status and the upstream
 *   message, which is what makes a 400 actionable instead of mysterious.
 */
export function describeApiError(payload: unknown, status: number): string {
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>
    const error = record.error
    if (typeof error === 'string') return `HTTP ${status}: ${error}`
    if (typeof error === 'object' && error !== null) {
      const message = (error as Record<string, unknown>).message
      if (typeof message === 'string') return `HTTP ${status}: ${message}`
    }
    const message = record.message
    if (typeof message === 'string') return `HTTP ${status}: ${message}`
  }
  return `HTTP ${status}`
}

/**
 * Decode every image in any supported envelope shape.
 *
 * Shared with the local worker client so both backends accept the same
 * `data[]` / `images[]` / `output[].image` layouts and the same
 * base64-or-`data:`-URI-or-`url` entries.
 *
 * @param payload - parsed backend body.
 * @param addressee - label used in error messages, e.g. `qwen-image api`.
 * @param signal - caller cancellation, used when an entry is a remote URL.
 * @returns the decoded images in upstream order.
 * @throws When the envelope carries no recognized image array.
 */
export async function extractImages(payload: unknown, addressee: string, signal: AbortSignal): Promise<GeneratedImage[]> {
  const entries = readImageArray(payload)
  if (entries === undefined) {
    const keys = typeof payload === 'object' && payload !== null ? Object.keys(payload as object).join(', ') : typeof payload
    throw new Error(`${addressee}: response carries no data[] or images[] array — got keys [${keys}]`)
  }
  if (entries.length === 0) throw new Error(`${addressee}: response image array is empty`)
  const images: GeneratedImage[] = []
  for (const entry of entries) images.push(await readImageEntry(entry, addressee, signal))
  return images
}

/**
 * Generate images through the configured cloud endpoint.
 *
 * @param settings - resolved endpoint, key, model, and wire style.
 * @param request - prompt plus the already-aligned canvas size.
 * @param signal - aborts the in-flight request on tool cancellation.
 * @returns one entry per returned image, in upstream order.
 * @throws When the style is unimplemented, the endpoint rejects the call, the
 *   body is not JSON, or no image is present. Messages never contain the key.
 */
export async function generateViaApi(
  settings: ApiSettings,
  request: GenerateRequest,
  signal: AbortSignal,
): Promise<GeneratedImage[]> {
  if (settings.style === 'dashscope') {
    throw new Error(
      "apiStyle 'dashscope' (native async task API) is declared but not implemented in v0.1; " +
        "use apiStyle 'openai' with the DashScope OpenAI-compatible base URL " +
        '(https://dashscope.aliyuncs.com/compatible-mode/v1) instead',
    )
  }
  if (request.images !== undefined && request.images.length > 0) {
    throw new Error(
      `qwen-image api: this backend has no edit path, so it cannot carry ${request.images.length} reference image(s). ` +
        'Editing over the OpenAI-compatible wire format is a different request shape (multipart POST /images/edits ' +
        'with the images as file parts, which this client does not implement), and the reference images are never ' +
        "dropped silently. Use backend 'comfyui' (the local ComfyUI with the official Qwen-Image 2.1 edit graph) or " +
        "'local' (the managed worker, whose /generate accepts an images[] field).",
    )
  }
  const body: Record<string, unknown> = {
    model: settings.model,
    prompt: request.prompt,
    n: request.count,
    size: `${request.width}x${request.height}`,
    response_format: 'b64_json',
  }
  if (request.steps !== undefined) body.steps = request.steps
  if (request.seed !== undefined) body.seed = request.seed
  if (request.transparent) body.transparent = true

  const response = await fetch(`${settings.baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    let raw = ''
    try {
      raw = await response.text()
    } catch {
      raw = ''
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    const reason = parsed === undefined ? `HTTP ${response.status}` : describeApiError(parsed, response.status)
    const safe = summarizeBody(raw, settings.apiKey)
    // Redact the composed message too: an upstream error can quote the key back
    // (e.g. `invalid key sk-…`), and the parsed branch above never sees `redact`.
    throw new Error(redact(`qwen-image api: ${reason}${safe === '' ? '' : ` — ${safe}`}`, settings.apiKey))
  }

  let payload: unknown
  const text = await response.text()
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`qwen-image api: response was not JSON: ${redact(text, settings.apiKey).slice(0, 200)}`)
  }

  return await extractImages(payload, 'qwen-image api', signal)
}

/**
 * Probe the configured endpoint for reachability and key validity.
 *
 * A `GET {baseUrl}/models` is the cheapest authenticated endpoint shared by both
 * supported providers. No key means no probe: the report says the key is missing
 * rather than pretending the endpoint is down.
 *
 * @param settings - resolved endpoint settings; `apiKey` may be empty.
 * @param timeoutMs - per-request budget.
 * @param signal - caller cancellation, composed with the timeout.
 * @returns a structured probe result for `qwen_image_status`.
 */
export async function probeApi(
  settings: ApiSettings,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const url = `${settings.baseUrl}/images/generations`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  const onAbort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    if (settings.apiKey.length === 0) {
      return { endpoint: url, keyPresent: false, reachable: undefined, note: 'no API key configured — set apiKey or a key environment variable to probe the endpoint' }
    }
    const response = await fetch(`${settings.baseUrl}/models`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${settings.apiKey}` },
      signal: controller.signal,
    })
    const authenticated = response.status !== 401 && response.status !== 403
    return {
      endpoint: url,
      keyPresent: true,
      reachable: true,
      modelsProbeStatus: response.status,
      authenticated,
      note: authenticated ? 'endpoint answered' : 'endpoint answered 401/403 — the key is missing, expired, or wrong',
    }
  } catch (error) {
    const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error)
    return { endpoint: url, keyPresent: settings.apiKey.length > 0, reachable: false, note: `unreachable: ${reason}` }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
