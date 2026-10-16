/**
 * Local inference backend client.
 *
 * This plugin does **not** implement inference. It speaks HTTP to a local worker
 * that another component owns, so the two sides stay replaceable. The contract
 * below is frozen on this side in v0.1 and is the handoff surface the worker
 * must match:
 *
 * - `GET  {endpoint}/health`   → any 2xx means the worker is up.
 * - `POST {endpoint}/generate` → body `{ prompt, width, height, count, steps?, seed?, transparent?, images?, reference_budget? }`
 *   answering `{ images: [ <base64 | data:URI | {b64_json}> … ] }`, or the same
 *   array under `data[]` / `output[].image`.
 *
 * `images` is the edit extension: an optional array of at most ten base64 (or
 * `data:` URI) reference images, in prompt order. Omitting it is exactly the old
 * text-to-image request, so the field is additive on both sides.
 *
 * `reference_budget` is the edit extension's own optional field: the side length
 * the worker resizes references to, sent only when `localReferenceBudget` is set.
 * Omitted — the default — the worker derives it from the canvas with its own
 * `_reference_budget`, which is the behaviour every earlier release had, and it
 * never changes the output size.
 *
 * Every failure names the endpoint and the transport reason, so a missing worker
 * reads as a missing worker rather than as a broken plugin.
 */
import { extractImages, type GenerateRequest, type GeneratedImage } from './backend.ts'

/**
 * One local generation: the images plus the worker's own stage timings.
 *
 * The timings are the worker's account of where the wall clock went, and they are
 * the difference between "the edit took 260 s" and "179 s of that was the denoise
 * loop, 32 s was the text encoder on the CPU". A worker that does not report them
 * leaves `stages` empty rather than inventing numbers.
 */
export interface LocalGeneration {
  /** One entry per returned image, in worker order. */
  readonly images: GeneratedImage[]
  /** Stage name → seconds, exactly as the worker measured them. */
  readonly stages: Record<string, number>
}

/**
 * Pull a numeric stage map out of a worker response, ignoring anything else.
 *
 * The worker reports one breakdown per generated image, so a batch response is an
 * array; the first entry describes the job that a single-image call would have run
 * and is what this returns.
 *
 * @param payload - the parsed `/generate` body.
 * @returns stage name → seconds; empty when the worker reports none.
 */
export function readStages(payload: unknown): Record<string, number> {
  const body = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
  const reported = body.stages_s ?? body.stage_timings
  const source = Array.isArray(reported) ? reported[0] : reported
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return {}
  const stages: Record<string, number> = {}
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) stages[key] = value
  }
  return stages
}

/**
 * The worker could not be reached at all (as opposed to answering with an error).
 *
 * The lifecycle manager keys its "the worker died on us, rebuild it" decision on
 * exactly this distinction, so it is a type rather than a string match.
 */
export class LocalUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalUnreachableError'
  }
}

/**
 * Generate images through the local worker.
 *
 * @param endpoint - worker origin without a trailing slash, e.g. `http://127.0.0.1:8399`.
 * @param request - prompt plus the already-aligned canvas size.
 * @param signal - aborts the in-flight request on tool cancellation.
 * @returns the images plus the worker's stage timings, in worker order.
 * @throws {LocalUnreachableError} When the worker cannot be reached at all.
 * @throws When the worker answers without images.
 */
export async function generateViaLocal(
  endpoint: string,
  request: GenerateRequest,
  signal: AbortSignal,
): Promise<LocalGeneration> {
  const url = `${endpoint}/generate`
  const body: Record<string, unknown> = {
    prompt: request.prompt,
    width: request.width,
    height: request.height,
    count: request.count,
  }
  if (request.steps !== undefined) body.steps = request.steps
  if (request.seed !== undefined) body.seed = request.seed
  if (request.transparent) body.transparent = true
  if (request.images !== undefined && request.images.length > 0) {
    // The frozen request shape is an array of strings, so each reference goes as
    // plain base64 (the worker also accepts a `data:` URI).
    body.images = request.images.map((image) => Buffer.from(image.bytes).toString('base64'))
    // Sent only when the caller configured one: with the field absent the worker
    // derives the budget from the canvas itself, exactly as it always has.
    if (request.referenceBudget !== undefined) body.reference_budget = request.referenceBudget
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new LocalUnreachableError(
      `local backend: cannot reach ${url} (${reason}). Start the local worker, or use backend "api" with an API key.`,
    )
  }

  if (!response.ok) {
    let raw = ''
    try {
      raw = (await response.text()).replace(/\s+/g, ' ').slice(0, 300)
    } catch {
      raw = ''
    }
    throw new Error(`local backend: ${url} answered HTTP ${response.status}${raw === '' ? '' : ` — ${raw}`}`)
  }

  let payload: unknown
  const text = await response.text()
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`local backend: ${url} did not answer JSON: ${text.slice(0, 200)}`)
  }
  return { images: await extractImages(payload, 'local backend', signal), stages: readStages(payload) }
}
