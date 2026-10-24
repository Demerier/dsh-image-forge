/**
 * Image persistence: `<outputDir>/<prefix>_<W>x<H>_<n>.png`.
 *
 * Numbering starts at 1 and skips names already on disk, so a second identical
 * call adds files instead of silently overwriting the first result. The whole
 * find-free-index-then-write sequence runs inside the directory's write queue
 * (the same primitive the board store uses): two concurrent generations — the
 * conversation tool and the Studio panel — would otherwise both probe the same
 * free index and the second `rename` would silently overwrite the first image.
 * Writes are staged through a per-call temporary file and renamed, so an
 * interrupted call never leaves a half-written PNG under the final name.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, rename, unlink, writeFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { serialized } from './boards.ts'

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
 * The queue key is the output directory itself, so any two callers writing
 * images into one directory are serialised against each other regardless of
 * which tool or panel they came from.
 *
 * @param dir - output directory; created when missing.
 * @param prefix - sanitized filename prefix.
 * @param width - aligned width used in the file name.
 * @param height - aligned height used in the file name.
 * @param images - decoded images in backend order.
 * @returns one record per written file, with Markdown-ready absolute paths.
 */
export function writeImages(
  dir: string,
  prefix: string,
  width: number,
  height: number,
  images: readonly { bytes: Uint8Array; mime: string }[],
): Promise<WrittenImage[]> {
  return serialized(dir, async () => {
    await mkdir(dir, { recursive: true })
    const first = await nextFreeIndex(dir, prefix, width, height)
    const written: WrittenImage[] = []
    let index = first
    for (const image of images) {
      const path = join(dir, `${prefix}_${width}x${height}_${index}.png`)
      // The staging name is per call, not per process: two concurrent calls
      // that raced to the same final name would otherwise interleave writes
      // into one shared `.partial-<pid>` file and corrupt both.
      const staging = `${path}.partial-${process.pid}-${randomUUID().slice(0, 8)}`
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
  })
}
