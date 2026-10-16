/**
 * Image persistence: `<outputDir>/<prefix>_<W>x<H>_<n>.png`.
 *
 * Numbering starts at 1 and skips names already on disk, so a second identical
 * call adds files instead of silently overwriting the first result. Writes are
 * staged through a temporary file and renamed, so an interrupted call never
 * leaves a half-written PNG under the final name.
 */
import { mkdir, rename, unlink, writeFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'

/** Extensions probed when deciding whether a name is already taken. */
const KNOWN_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const

/** A file that was written and verified. */
export interface WrittenImage {
  /** 1-based index within this call, as it appears in the file name. */
  readonly index: number
  /** Absolute native path of the written file. */
  readonly path: string
  /** Same path with forward slashes, safe to paste into Markdown. */
  readonly markdownPath: string
  /** Byte length of the written file. */
  readonly bytes: number
  /** Sniffed or upstream-reported content type. */
  readonly mime: string
}

/**
 * Turn caller text into a filename-safe prefix.
 *
 * @param raw - caller-provided `preset`, or `undefined`.
 * @returns an ASCII-safe prefix; multi-byte-only input collapses to the
 *   fallback rather than producing an untypable name.
 */
export function sanitizePrefix(raw: string | undefined, fallback = 'qwen'): string {
  const cleaned = (raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 48)
  return cleaned.length > 0 ? cleaned : fallback
}

/** True when the path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Find the lowest free index for one size.
 *
 * @param dir - output directory, which must already exist.
 * @param prefix - sanitized filename prefix.
 * @param width - aligned width.
 * @param height - aligned height.
 * @param start - first index to consider.
 * @returns the first index whose name is free under every known extension.
 */
export async function nextFreeIndex(
  dir: string,
  prefix: string,
  width: number,
  height: number,
  start = 1,
): Promise<number> {
  let index = start
  for (;;) {
    const taken = await Promise.all(
      KNOWN_EXTENSIONS.map((extension) => exists(join(dir, `${prefix}_${width}x${height}_${index}${extension}`))),
    )
    if (!taken.some(Boolean)) return index
    index += 1
  }
}

/**
 * Write every generated image under the required naming scheme.
 *
 * @param dir - output directory; created when missing.
 * @param prefix - sanitized filename prefix.
 * @param width - aligned width used in the file name.
 * @param height - aligned height used in the file name.
 * @param images - decoded images in backend order.
 * @returns one record per written file, with Markdown-ready absolute paths.
 */
export async function writeImages(
  dir: string,
  prefix: string,
  width: number,
  height: number,
  images: readonly { bytes: Uint8Array; mime: string }[],
): Promise<WrittenImage[]> {
  await mkdir(dir, { recursive: true })
  const first = await nextFreeIndex(dir, prefix, width, height)
  const written: WrittenImage[] = []
  let index = first
  for (const image of images) {
    const path = join(dir, `${prefix}_${width}x${height}_${index}.png`)
    const staging = `${path}.partial-${process.pid}`
    await writeFile(staging, image.bytes)
    try {
      await rename(staging, path)
    } catch (error) {
      await unlink(staging).catch(() => undefined)
      throw error
    }
    written.push({
      index,
      path,
      markdownPath: path.replace(/\\/g, '/'),
      bytes: image.bytes.byteLength,
      mime: image.mime,
    })
    index += 1
  }
  return written
}
