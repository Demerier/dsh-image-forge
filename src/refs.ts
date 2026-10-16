/**
 * Reference images for the edit path.
 *
 * `qwen_image_edit` accepts, for each entry, either an absolute path or a
 * `data:image/…;base64,…` URI. This module turns that list into bytes plus the
 * pixel size, and it is the only place that decides whether a list is usable —
 * a reference that cannot be read is an error that names its position, never a
 * silently dropped entry, because dropping one shifts every `<imageN>` label the
 * caller wrote in the prompt.
 *
 * The size matters as much as the bytes: `ratio_follow` means "the canvas takes
 * that image's aspect ratio", which cannot be resolved without measuring it, so
 * the header is parsed here (PNG / JPEG / WebP) instead of guessing.
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { sniffImageMime } from './backend.ts'

/** How many reference images one edit call may carry (the official contract's limit). */
export const MAX_REFERENCES = 10

/** Image containers whose pixel size this module can read. */
const SIZED_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const

/** One decoded, measured reference image. */
export interface ReferenceImage {
  /** 0-based position in the caller's array. */
  readonly position: number
  /** 1-based label, matching the prompt contract's `<imageN>` numbering. */
  readonly index: number
  /** Exactly what the caller passed: an absolute path or a `data:` URI. */
  readonly source: string
  /** Short name for messages and error text. */
  readonly label: string
  /** Raw image bytes, exactly as they were read or decoded. */
  readonly bytes: Uint8Array
  /** Sniffed container. */
  readonly mime: string
  /** Pixel width from the container header. */
  readonly width: number
  /** Pixel height from the container header. */
  readonly height: number
}

/** Read a big-endian unsigned integer of `width` bytes. */
function readUintBE(bytes: Uint8Array, at: number, width: number): number {
  let value = 0
  for (let offset = 0; offset < width; offset += 1) value = value * 256 + (bytes[at + offset] ?? 0)
  return value
}

/** `IHDR` immediately follows the PNG signature, so width/height sit at a fixed offset. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24) return undefined
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return undefined
  return { width: readUintBE(bytes, 16, 4), height: readUintBE(bytes, 20, 4) }
}

/** Walk the JPEG marker chain to the first `SOFn`, then read its frame header. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1] ?? 0
    if (marker === 0xff) {
      offset += 1
      continue
    }
    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2
      continue
    }
    const length = readUintBE(bytes, offset + 2, 2)
    if (length < 2) return undefined
    // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc) hold the frame size.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrame) return { width: readUintBE(bytes, offset + 7, 2), height: readUintBE(bytes, offset + 5, 2) }
    offset += 2 + length
  }
  return undefined
}

/** `VP8X` stores 24-bit canvas sides; lossy `VP8 ` and lossless `VP8L` store theirs inline. */
function webpSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 30) return undefined
  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
  if (chunk === 'VP8X') {
    return { width: 1 + readUintBE(bytes, 24, 3), height: 1 + readUintBE(bytes, 27, 3) }
  }
  if (chunk === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined
    return { width: readUintBE(bytes, 26, 2) & 0x3fff, height: readUintBE(bytes, 28, 2) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return undefined
    const bits = readUintBE(bytes, 21, 4)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return undefined
}

/**
 * Read an image's pixel size from its container header.
 *
 * Only the containers {@link SIZED_MIMES} lists are understood; everything else
 * returns undefined so the caller can say which file it could not measure.
 *
 * @param bytes - the whole image (only the header is inspected).
 * @returns the size and the sniffed mime, or undefined for an unknown container.
 */
export function probeImageSize(bytes: Uint8Array): { width: number; height: number; mime: string } | undefined {
  const mime = sniffImageMime(bytes)
  if (mime === undefined) return undefined
  const size = mime === 'image/png' ? pngSize(bytes) : mime === 'image/jpeg' ? jpegSize(bytes) : webpSize(bytes)
  if (size === undefined || size.width <= 0 || size.height <= 0) return undefined
  return { ...size, mime }
}

/** True when the string is a `data:` URI rather than a filesystem path. */
function isDataUri(source: string): boolean {
  return source.startsWith('data:')
}

/** Decode one `data:` URI, or explain exactly why it is not one we accept. */
function decodeDataUri(source: string, position: number): Uint8Array {
  const where = `images[${position}]`
  if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(source)) {
    throw new Error(
      `${where}: only base64 image data URIs are accepted — expected "data:image/png;base64,…", ` +
        `got "${source.slice(0, 40)}${source.length > 40 ? '…' : ''}"`,
    )
  }
  const payload = source.slice(source.indexOf(',') + 1).replace(/\s+/g, '')
  if (payload.length === 0) throw new Error(`${where}: the data URI carries no base64 payload`)
  const bytes = new Uint8Array(Buffer.from(payload, 'base64'))
  if (bytes.byteLength === 0) throw new Error(`${where}: the data URI decoded to 0 bytes`)
  return bytes
}

/** Read one path, phrasing the usual filesystem failures so the caller can act. */
async function readImageFile(path: string, position: number): Promise<Uint8Array> {
  const where = `images[${position}]`
  if (!isAbsolute(path)) {
    throw new Error(
      `${where}: "${path}" is not an absolute path. Reference images are read by this plugin's process, ` +
        'so a relative path would resolve against an unpredictable directory — pass an absolute path ' +
        '(e.g. D:\\pictures\\ref.png), or a data:image/…;base64,… URI.',
    )
  }
  let info
  try {
    info = await stat(path)
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error))
    throw new Error(`${where}: cannot read "${path}" — ${reason === 'ENOENT' ? 'no such file' : reason}`)
  }
  if (info.isDirectory()) throw new Error(`${where}: "${path}" is a directory, not an image file`)
  if (info.size === 0) throw new Error(`${where}: "${path}" is 0 bytes — it is not an image`)
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error))
    throw new Error(
      `${where}: cannot read "${path}" — ${reason}` +
        (reason === 'EACCES' || reason === 'EPERM' ? ' (the file exists but this process is not allowed to open it)' : ''),
    )
  }
  return new Uint8Array(bytes)
}

/**
 * Validate, decode, and measure every reference image.
 *
 * @param sources - caller-supplied paths or `data:` URIs, in prompt order.
 * @returns one entry per input, in the same order, each with bytes and pixel size.
 * @throws When the list is empty or longer than {@link MAX_REFERENCES}, when an
 *   entry is not a string, when a path is relative, missing, unreadable, empty or
 *   a directory, when a data URI is malformed, or when the bytes are not a PNG /
 *   JPEG / WebP. Every message names the failing position.
 */
export async function loadReferenceImages(sources: readonly string[]): Promise<ReferenceImage[]> {
  if (!Array.isArray(sources)) throw new Error('images must be an array of absolute paths or data: URIs')
  if (sources.length === 0) throw new Error('images must contain at least one reference image')
  if (sources.length > MAX_REFERENCES) {
    throw new Error(
      `images carries ${sources.length} reference images, but at most ${MAX_REFERENCES} are supported ` +
        '(the prompt contract numbers them <image1>…<image10>).',
    )
  }
  const out: ReferenceImage[] = []
  for (const [position, source] of sources.entries()) {
    if (typeof source !== 'string' || source.trim().length === 0) {
      throw new Error(`images[${position}] must be a non-empty string (an absolute path or a data: URI), got ${JSON.stringify(source)}`)
    }
    const trimmed = source.trim()
    const bytes = isDataUri(trimmed) ? decodeDataUri(trimmed, position) : await readImageFile(trimmed, position)
    const size = probeImageSize(bytes)
    if (size === undefined) {
      const container = sniffImageMime(bytes)
      const label = isDataUri(trimmed) ? `images[${position}] (data URI)` : `images[${position}]: "${trimmed}"`
      const detail =
        container === undefined
          ? 'is not a recognized image container (not a PNG, JPEG or WebP)'
          : `is ${container}, but its pixel size could not be read from the header`
      throw new Error(
        `${label} ${detail} — this plugin reads the pixel size of ${SIZED_MIMES.join(' / ')} references only, ` +
          'and needs it both for the backend and for ratio_follow. Convert it, or pass wh_ratio / width+height ' +
          'instead of ratio_follow.',
      )
    }
    out.push({
      position,
      index: position + 1,
      source: trimmed,
      label: isDataUri(trimmed) ? `inline image ${position + 1}` : basename(trimmed),
      bytes,
      mime: size.mime,
      width: size.width,
      height: size.height,
    })
  }
  return out
}

/**
 * Resolve `ratio_follow` to one of the loaded references.
 *
 * Accepts the contract's `"image1"…"image10"` labels and, because the tool also
 * takes paths, the same string the caller put in `images` (compared with
 * normalized separators and case, as Windows reports them).
 *
 * @param ratioFollow - caller value: `imageN` or one of the `images` entries.
 * @param references - the loaded references.
 * @returns the reference whose aspect ratio the canvas must follow.
 * @throws When the label is out of range or matches no entry, listing what is
 *   accepted instead of guessing which image was meant.
 */
export function resolveRatioFollow(ratioFollow: string, references: readonly ReferenceImage[]): ReferenceImage {
  const wanted = ratioFollow.trim()
  const label = /^image(\d+)$/i.exec(wanted)
  if (label !== null) {
    const index = Number(label[1])
    if (index < 1 || index > references.length) {
      throw new Error(
        `ratio_follow "${ratioFollow}" points at reference image ${index}, but this call carries ` +
          `${references.length} (${references.map((reference) => `<image${reference.index}>`).join(', ')}). ` +
          'The contract numbers the references <image1>…<imageN> in the order they are passed.',
      )
    }
    return references[index - 1] as ReferenceImage
  }
  const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const byPath = references.find((reference) => normalize(reference.source) === normalize(wanted))
  if (byPath !== undefined) return byPath
  throw new Error(
    `ratio_follow "${ratioFollow}" matches none of the ${references.length} reference images. ` +
      `Pass the contract label (${references.map((reference) => `"image${reference.index}"`).join(', ')}) ` +
      `or exactly the string you passed in images[] (${references.map((reference) => `"${reference.source}"`).join(', ')}).`,
  )
}
