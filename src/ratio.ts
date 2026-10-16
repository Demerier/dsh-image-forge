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
 * Those two numbers say nothing about the **local edit** path, which conditions on
 * reference images and is measured separately: on the same card a 1248×1248 edit
 * canvas (this table's `1:1`) does not survive at all, and **every one of the seven
 * default canvases lands above the reliable edit budget**. The i2i numbers — and
 * the gate the tool layer now derives from them — are
 * {@link LOCAL_EDIT_BUDGET_RELIABLE}, {@link LOCAL_EDIT_BUDGET_EDGE} and
 * `_r4b\REPORT.md` §(a)/§(b).
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

/**
 * The reference-conditioning budget a canvas implies for the **local** backend.
 *
 * A side length whose square is the pixel budget the worker resizes every
 * reference image (and the condition latents) to; the worker uses it at
 * `resources/worker.py:244 / :246 / :289`. This mirror exists so the tool layer can
 * predict the load a local edit is about to ask for *before* spawning anything.
 *
 * Kept value-for-value equivalent to the worker's own
 * `min(4096, max(32, int(round(math.sqrt(width * height) / 32) * 32)))`:
 * `test/local-edit-budget.test.mjs` reads that Python source, evaluates the
 * extracted expression, and fails if the two sides ever disagree.
 *
 * This is the **derived** budget, i.e. the default. A user who sets the
 * `localReferenceBudget` config sends an explicit budget instead, and everything
 * that bands "how heavy is this edit" must then use
 * {@link resolveReferenceBudget} rather than this function.
 *
 * Python's `round` is half-to-even while `Math.round` is half-up, so the two can
 * only diverge on an exact `.5` — unreachable for 32-aligned sides, because
 * `w * h` is then a multiple of 1024 while `(32k + 16)² = 1024(k² + k) + 256` is
 * not. The test asserts that no tie exists on the grid rather than assuming it.
 *
 * @param width - canvas width in pixels.
 * @param height - canvas height in pixels.
 * @returns the 32-aligned conditioning side length, in [32, 4096].
 */
export function referenceBudget(width: number, height: number): number {
  return Math.min(4096, Math.max(32, Math.round(Math.sqrt(width * height) / 32) * 32))
}

/**
 * Conditioning budget a local edit is **reliably** expected to survive: **896**.
 *
 * Measured on the card class this plugin targets (RTX 4070 Laptop, 8188 MiB,
 * `_fresh2` venv, 1 step): canvas **1216×672** → budget 896 → condition 896×896 →
 * peak `reserved` **7458 MiB**, 3/3 runs bit-identical. This is *this card's* wall,
 * not a law about editing — `_r4b\REPORT.md` §(b).
 *
 * The line is **budget-only**: it says nothing about the canvas's own cost. The
 * same 896 on a 1.5 MP canvas (1248×1248) measured **67 s/step** — no error, just
 * ~28 min for 25 steps — while 0.82 MP measured 1.9 s/step. `_r5\REPORT.md`.
 */
export const LOCAL_EDIT_BUDGET_RELIABLE = 896

/**
 * Canvas area, in pixels, above which a local edit's budget stops being the whole
 * story: **1.0 MP**.
 *
 * The two measured endpoints are **0.82 MP** at budget 896 → 1.9 s/step
 * (1216×672) and **1.55 MP** at the *same* 896 → 67 s/step (1248×1248); 1.0 MP
 * sits between them, so this line is **interpolation, not a measurement** —
 * nothing has been run at 1.0 MP itself. `_r5\REPORT.md`.
 */
export const LOCAL_EDIT_CANVAS_WARN_AREA = 1_000_000

/**
 * The only conditioning budget measured to **finish** on a 1.5 MP canvas: **512**.
 *
 * 1248×1248 + 512 → HTTP 200, wall 109.5 s, peak `reserved` **6488 MiB**, worker
 * alive; the same canvas at 896 never finished (two runs, 67 s/step, extrapolated
 * ≈28 min, **no error**). `_r5\REPORT.md`.
 */
export const LOCAL_EDIT_CANVAS_SAFE_BUDGET = 512

/**
 * Conditioning budget a local edit may still **just** pass: **960**.
 *
 * Canvas 960×960 → budget 960 passed, but its peak `reserved` was **8492 MiB**,
 * i.e. **above this card's 8188 MiB total** — it only held because the driver fell
 * back to WDDM shared memory, and denoise took 21.19 s (≈ 2× the 928 tier). Above
 * this line the same card fails: 992–1024 in the GPU denoise stage, ≥1216 with a
 * native access violation in the CPU text-encode stage. `_r4b\REPORT.md` §(a)/§(b).
 */
export const LOCAL_EDIT_BUDGET_EDGE = 960

/** Which band a local edit's conditioning budget falls into. */
export type LocalEditBudgetTier = 'reliable' | 'edge' | 'over'

/** Smallest conditioning budget `localReferenceBudget` may be set to. */
export const REFERENCE_BUDGET_MIN = 32

/** Largest conditioning budget `localReferenceBudget` may be set to (the worker's own clamp). */
export const REFERENCE_BUDGET_MAX = 4096

/** The conditioning budget one local edit really runs at, and where it came from. */
export interface EffectiveReferenceBudget {
  /** The budget the worker is told to use, or asked to derive. */
  readonly budget: number
  /** `config` when an explicit budget overrode the canvas, `canvas` when it was derived. */
  readonly source: 'config' | 'canvas'
  /** What {@link referenceBudget} derives from the canvas, whether or not it is used. */
  readonly canvasBudget: number
}

/**
 * Resolve the conditioning budget a local edit will actually condition at.
 *
 * Explicit beats derived, and the whole size gate keys off the result: a user who
 * sets `localReferenceBudget` to 512 is asking for *that* load, so a 1248×1248
 * canvas must be judged as a 512 edit rather than by the 1248 its area implies —
 * otherwise the knob could not make a 1.5 MP canvas runnable, which is what it is
 * for.
 *
 * `0`/`undefined` means "no override": the worker derives the budget from the
 * canvas itself (`resources/worker.py`'s `_reference_budget`), which is the
 * behaviour every release before this knob had.
 *
 * @param width - canvas width in pixels.
 * @param height - canvas height in pixels.
 * @param override - the configured budget; `0` or undefined for "derive".
 * @returns the effective budget, its source, and the canvas-derived one beside it.
 * @throws When the override is not `0` and not a 32-aligned value in
 *   [{@link REFERENCE_BUDGET_MIN}, {@link REFERENCE_BUDGET_MAX}], naming the
 *   accepted shape — a typo here would otherwise be silently honoured.
 */
export function resolveReferenceBudget(width: number, height: number, override?: number): EffectiveReferenceBudget {
  const canvasBudget = referenceBudget(width, height)
  if (override === undefined || override === 0) return { budget: canvasBudget, source: 'canvas', canvasBudget }
  if (
    !Number.isInteger(override) ||
    override < REFERENCE_BUDGET_MIN ||
    override > REFERENCE_BUDGET_MAX ||
    override % SIZE_MULTIPLE !== 0
  ) {
    throw new Error(
      `localReferenceBudget must be 0 (= derive from the canvas) or a multiple of ${SIZE_MULTIPLE} ` +
        `within [${REFERENCE_BUDGET_MIN}, ${REFERENCE_BUDGET_MAX}], got ${override}`,
    )
  }
  return { budget: override, source: 'config', canvasBudget }
}

/**
 * Band a conditioning budget falls into, using the two measured lines.
 *
 * @param budget - {@link referenceBudget} of the requested canvas.
 * @returns `reliable` at or below {@link LOCAL_EDIT_BUDGET_RELIABLE}, `edge` up to
 *   {@link LOCAL_EDIT_BUDGET_EDGE}, `over` above it.
 */
export function localEditBudgetTier(budget: number): LocalEditBudgetTier {
  if (budget <= LOCAL_EDIT_BUDGET_RELIABLE) return 'reliable'
  if (budget <= LOCAL_EDIT_BUDGET_EDGE) return 'edge'
  return 'over'
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
