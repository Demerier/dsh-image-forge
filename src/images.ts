/**
 * Shared image vocabulary for the ComfyUI backend.
 *
 * Every generated or referenced image crosses this module's types: the adapter
 * in `comfyui.ts` produces {@link GeneratedImage} entries, the edit path carries
 * its references as {@link ReferenceImagePayload}, and `refs.ts` / `tools.ts`
 * sniff containers with {@link sniffImageMime} so a wrong extension claim can
 * never reach a filename that ComfyUI then refuses.
 *
 * This file used to also carry the cloud-API client (an OpenAI-compatible
 * `POST /images/generations` path). That backend is gone: Qwen-Image editing
 * only exists on the local ComfyUI graph, and keeping a text-to-image-only
 * cloud path meant two backends to explain, a key to manage, and an `auto`
 * route that could silently move a generation off the machine. Local-only is
 * the product now; the git history holds the removed client if it is ever
 * needed again.
 */

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

/** Everything a ComfyUI run needs besides the resolved models. */
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
  /**
   * Reference images for an edit call, in prompt order. Omitted (or empty) means
   * text-to-image. A reference that cannot be consumed must be refused before
   * the graph runs: dropping one shifts every `<imageN>` label the caller wrote
   * in the prompt.
   */
  readonly images?: readonly ReferenceImagePayload[]
}

/** Sniff the image container from its magic bytes. */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return undefined
}
