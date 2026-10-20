/**
 * `wh_ratio` → pixel dimensions.
 *
 * The Qwen prompt contract emits an aspect ratio (`wh_ratio`), while every
 * diffusion backend wants pixel width/height. This module is the single place
 * where that translation happens, so the tool layer never has to re-implement
 * it and the test suite can pin the result of all seven official tiers.
 */

/** The seven `wh_ratio` tiers of the Qwen-Image prompt contract, in order. */
export const WH_RATIOS = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'] as const

/** One of the seven official aspect-ratio tiers. */
export type WhRatio = (typeof WH_RATIOS)[number]

/** Diffusion backends require both sides to be a multiple of this. */
export const SIZE_MULTIPLE = 32

/** Smallest accepted side length. */
export const MIN_SIDE = 256

/** Largest accepted side length. */
export const MAX_SIDE = 4096

/**
 * Pixel budget the default tier table targets — **~1.5 MP**.
 *
 * Also the budget {@link resolveSize} searches around for shapes outside the seven
 * tiers.
 *
 * Measured on the card class this plugin targets (RTX 4070 Laptop, 8188 MiB, nf4
 * worker, 25 steps) — **text-to-image only**: 1248×1248 and 1664×928 peak at
 * **5680–6016 MiB reserved / 5349–5358 MiB allocated**, so ~1.5 MP keeps at least
 * 2.1 GiB of headroom and is the default for **every** backend, not only ComfyUI.
 *
 * The **edit** path is measured separately and has no table of its own: ComfyUI
 * scales the references to the canvas' own budget, so the same 1.5 MP ceiling
 * applies and the seven defaults below are what both tools ask for.
 */
export const DEFAULT_MEGAPIXELS = 1.5

/**
 * The canvas each official tier ships by default, at {@link DEFAULT_MEGAPIXELS}.
 *
 * Pinned rather than searched: the search trades shape fidelity against the pixel
 * budget, and at 1.5 MP that trade picks 1632×928 for `16:9` — a slightly lower
 * score, but a shape nobody documented. Every pair here is 32-aligned (the test
 * suite asserts it); `16:9` and `9:16` stay inexact on a 32 grid and report it.
 */
export const DEFAULT_SIZES: Readonly<Record<WhRatio, readonly [number, number]>> = {
  '1:1': [1248, 1248],
  '4:3': [1408, 1056],
  '3:4': [1056, 1408],
  '3:2': [1536, 1024],
  '2:3': [1024, 1536],
  '16:9': [1664, 928],
  '9:16': [928, 1664],
}

/** A resolved, backend-ready canvas size. */
export interface ResolvedSize {
  /** Aligned width in pixels. */
  width: number
  /** Aligned height in pixels. */
  height: number
  /** Signed deviation between `width / height` and the requested tier ratio, in percent. */
  ratioDeviationPercent: number
  /** True when the aligned size reproduces the requested ratio exactly. */
  exact: boolean
}

/** Round down to the nearest allowed multiple. */
function alignDown(value: number, multiple: number): number {
  return Math.max(multiple, Math.floor(value / multiple) * multiple)
}

/** Parse `"16:9"` into its two positive integers; throws on anything else. */
export function parseRatio(whRatio: string): { a: number; b: number } {
  const match = /^(\d+):(\d+)$/.exec(whRatio.trim())
  if (match === null) throw new Error(`wh_ratio must look like "16:9", got "${whRatio}"`)
  const a = Number(match[1])
  const b = Number(match[2])
  if (a <= 0 || b <= 0) throw new Error(`wh_ratio sides must be positive, got "${whRatio}"`)
  return { a, b }
}

/** Greatest common divisor, used to reduce `a:b` before the table lookup. */
function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

/**
 * Resolve a `wh_ratio` to the canvas the plugin ships by default.
 *
 * The ratio is reduced first, so a reference image that measures `2048:1152` —
 * exactly `16:9` — lands on the documented canvas instead of on a second,
 * search-derived answer for the same shape. Any other shape (`21:9`) falls through
 * to {@link resolveSize} at the default budget. Explicit `width`/`height` never
 * reach this function; the tool layer validates and honours them first.
 *
 * @param whRatio - any `a:b`, tier or not.
 * @returns the aligned size plus its deviation from the *requested* ratio.
 */
export function resolveDefaultSize(whRatio: string): ResolvedSize {
  const { a, b } = parseRatio(whRatio)
  const divisor = gcd(a, b)
  const pair = (DEFAULT_SIZES as Record<string, readonly [number, number] | undefined>)[`${a / divisor}:${b / divisor}`]
  if (pair === undefined) return resolveSize(whRatio, DEFAULT_MEGAPIXELS)
  const [width, height] = pair
  const ratioDeviationPercent = ((width / height) / (a / b) - 1) * 100
  return {
    width,
    height,
    ratioDeviationPercent: Number(ratioDeviationPercent.toFixed(3)),
    exact: Math.abs(ratioDeviationPercent) < 0.001,
  }
}

/**
 * Resolve an aspect ratio to the closest backend-ready size by searching the grid.
 *
 * This is the fallback for shapes outside {@link DEFAULT_SIZES}; the seven official
 * tiers come from that table instead.
 *
 * Both sides move in steps of {@link SIZE_MULTIPLE}, so most ratios cannot be
 * reproduced exactly. Instead of aligning each side independently (which drifts
 * badly: 1500×750 snaps to 1472×736, i.e. 2:1), every candidate pair in the
 * legal window is scored on ratio fidelity plus how close the pixel budget
 * stays to `megapixels`, and the best pair wins. Ties prefer the larger canvas,
 * then the wider one, so the result is deterministic across platforms.
 *
 * @param whRatio - one of {@link WH_RATIOS} (any `a:b` is accepted).
 * @param megapixels - target pixel budget in millions of pixels.
 * @returns the aligned size plus how far its true ratio sits from the request.
 */
export function resolveSize(whRatio: string, megapixels: number = DEFAULT_MEGAPIXELS): ResolvedSize {
  const { a, b } = parseRatio(whRatio)
  const target = megapixels * 1_000_000
  const wanted = a / b
  const idealScale = Math.sqrt(target / (a * b))

  // Search a window around the ideal size; generous enough that the optimum is
  // always interior, small enough to stay a few thousand candidates.
  const low = SIZE_MULTIPLE
  const high = Math.min(MAX_SIDE, Math.max(alignDown(Math.round(a * idealScale) * 2, SIZE_MULTIPLE), MIN_SIDE * 2))

  let best: { width: number; height: number; score: number } | undefined
  for (let width = low; width <= high; width += SIZE_MULTIPLE) {
    for (let height = low; height <= high; height += SIZE_MULTIPLE) {
      const ratioError = Math.abs(width / height - wanted) / wanted
      const areaError = Math.abs(width * height - target) / target
      const score = ratioError + areaError * 0.5
      if (
        best === undefined ||
        score < best.score - 1e-12 ||
        (Math.abs(score - best.score) <= 1e-12 && width * height > best.width * best.height) ||
        (Math.abs(score - best.score) <= 1e-12 && width * height === best.width * best.height && width > best.width)
      ) {
        best = { width, height, score }
      }
    }
  }
  if (best === undefined) throw new Error(`no 32-aligned size found for wh_ratio "${whRatio}"`)

  const ratioDeviationPercent = (best.width / best.height / wanted - 1) * 100
  return {
    width: best.width,
    height: best.height,
    ratioDeviationPercent: Number(ratioDeviationPercent.toFixed(3)),
    exact: Math.abs(ratioDeviationPercent) < 0.001,
  }
}

/**
 * Validate an explicit caller-supplied size.
 *
 * @param width - requested width in pixels.
 * @param height - requested height in pixels.
 * @returns the validated size.
 * @throws When a side is out of range or not a multiple of 32, naming the
 *   nearest legal values so the caller can fix the call without guessing.
 */
export function validateSize(width: number, height: number): { width: number; height: number } {
  for (const [label, value] of [
    ['width', width],
    ['height', height],
  ] as const) {
    if (!Number.isInteger(value)) throw new Error(`${label} must be an integer, got ${value}`)
    if (value < MIN_SIDE || value > MAX_SIDE) {
      throw new Error(`${label} must be between ${MIN_SIDE} and ${MAX_SIDE}, got ${value}`)
    }
    if (value % SIZE_MULTIPLE !== 0) {
      const down = alignDown(value, SIZE_MULTIPLE)
      throw new Error(
        `${label} must be a multiple of ${SIZE_MULTIPLE}, got ${value} (nearest legal values: ${down} and ${down + SIZE_MULTIPLE})`,
      )
    }
  }
  return { width, height }
}

/**
 * Pick the ratio whose ideal shape is closest to an explicit size. Used to keep
 * the reported `wh_ratio` honest when the caller overrides width/height.
 */
export function nearestRatio(width: number, height: number): { whRatio: WhRatio; deviationPercent: number } {
  const actual = width / height
  let best: { whRatio: WhRatio; deviationPercent: number } | undefined
  for (const candidate of WH_RATIOS) {
    const { a, b } = parseRatio(candidate)
    const deviationPercent = (actual / (a / b) - 1) * 100
    if (best === undefined || Math.abs(deviationPercent) < Math.abs(best.deviationPercent)) {
      best = { whRatio: candidate, deviationPercent: Number(deviationPercent.toFixed(3)) }
    }
  }
  if (best === undefined) throw new Error('WH_RATIOS is empty')
  return best
}
