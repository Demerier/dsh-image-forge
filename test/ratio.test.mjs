/**
 * `wh_ratio` → pixel dimensions, all seven official tiers.
 *
 * The table printed by this test is the one the skill's `references/*.md` and
 * `skill.md` document; if the table changes, that text must change with it.
 *
 * Two layers are pinned here: the shipped table itself (`DEFAULT_SIZES`, reached
 * through `resolveDefaultSize`) and the search fallback for shapes outside the
 * seven tiers. "Explicit `width`/`height` beats both" is a decision the tool layer
 * makes, so it is asserted through `testlib/tools.js` — the same `pnpm build`
 * that produces `lib/`, which `test/settings.test.mjs` already depends on.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MEGAPIXELS,
  DEFAULT_SIZES,
  SIZE_MULTIPLE,
  WH_RATIOS,
  nearestRatio,
  parseRatio,
  resolveDefaultSize,
  resolveSize,
  validateSize,
} from '../src/ratio.ts'
import { chooseSize } from '../testlib/tools.js'

/** The shipped 32-aligned canvas per tier at the ~1.5 MP default budget. */
const EXPECTED = {
  '1:1': [1248, 1248],
  '4:3': [1408, 1056],
  '3:4': [1056, 1408],
  '3:2': [1536, 1024],
  '2:3': [1024, 1536],
  '16:9': [1664, 928],
  '9:16': [928, 1664],
}

test('every official tier resolves to a 32-aligned size near the default budget', () => {
  const rows = []
  for (const whRatio of WH_RATIOS) {
    const size = resolveDefaultSize(whRatio)
    assert.equal(size.width % SIZE_MULTIPLE, 0, `${whRatio} width must be 32-aligned`)
    assert.equal(size.height % SIZE_MULTIPLE, 0, `${whRatio} height must be 32-aligned`)
    const area = (size.width * size.height) / 1_000_000
    assert.ok(
      Math.abs(area - DEFAULT_MEGAPIXELS) < 0.1,
      `${whRatio} area ${area}MP strays too far from the ${DEFAULT_MEGAPIXELS}MP budget`,
    )
    rows.push({
      wh_ratio: whRatio,
      size: `${size.width}x${size.height}`,
      megapixels: Number(area.toFixed(3)),
      ratio_deviation_percent: size.ratioDeviationPercent,
      exact: size.exact,
    })
  }
  console.log('wh_ratio -> size table (shipped default):')
  console.table(rows)
})

test('the resolved sizes are exactly the shipped table', () => {
  for (const [whRatio, [width, height]] of Object.entries(EXPECTED)) {
    const size = resolveDefaultSize(whRatio)
    assert.deepEqual([size.width, size.height], [width, height], `${whRatio} drifted from the shipped table`)
    assert.deepEqual(DEFAULT_SIZES[whRatio], [width, height], `DEFAULT_SIZES.${whRatio} drifted`)
  }
})

test('16:9 is exactly 1664x928 and is honest about the 32-grid residue', () => {
  const size = resolveDefaultSize('16:9')
  assert.deepEqual([size.width, size.height], [1664, 928])
  assert.deepEqual([resolveDefaultSize('9:16').width, resolveDefaultSize('9:16').height], [928, 1664])
  assert.equal(size.exact, false)
  assert.ok(size.ratioDeviationPercent > 0 && size.ratioDeviationPercent < 1, `deviation ${size.ratioDeviationPercent}%`)
  const flipped = resolveDefaultSize('9:16').ratioDeviationPercent
  assert.ok(flipped < 0 && Math.abs(flipped + size.ratioDeviationPercent) < 0.02, `9:16 deviation ${flipped}%`)
})

test('the five exactly-representable tiers come out exact', () => {
  for (const whRatio of ['1:1', '4:3', '3:4', '3:2', '2:3']) {
    const size = resolveDefaultSize(whRatio)
    assert.equal(size.exact, true, `${whRatio} should be reproducible on a 32 grid`)
    assert.equal(size.ratioDeviationPercent, 0)
  }
})

test('a ratio that reduces to an official tier lands on that tier canvas', () => {
  // A 2048×1152 reference is 16:9; it must not resolve to a second, search-derived
  // answer that an explicit `wh_ratio: "16:9"` would not produce.
  assert.deepEqual([resolveDefaultSize('2048:1152').width, resolveDefaultSize('2048:1152').height], [1664, 928])
  assert.deepEqual([resolveDefaultSize('1024:1024').width, resolveDefaultSize('1024:1024').height], [1248, 1248])
})

test('a shape outside the seven tiers falls back to the search at the default budget', () => {
  const ultrawide = resolveDefaultSize('21:9')
  assert.equal(ultrawide.width % SIZE_MULTIPLE, 0)
  assert.equal(ultrawide.height % SIZE_MULTIPLE, 0)
  const area = (ultrawide.width * ultrawide.height) / 1_000_000
  assert.ok(Math.abs(area - DEFAULT_MEGAPIXELS) < 0.1, `21:9 area ${area}MP strays from the budget`)
})

test('an explicit width/height still beats the default table', () => {
  const explicit = chooseSize('16:9', 1024, 512)
  assert.equal(explicit.sizeSource, 'explicit-size')
  assert.deepEqual([explicit.width, explicit.height], [1024, 512])
  const ratio = chooseSize('16:9', undefined, undefined)
  assert.equal(ratio.sizeSource, 'wh_ratio')
  assert.deepEqual([ratio.width, ratio.height], [1664, 928])
  assert.throws(() => chooseSize('16:9', 1000, 512), /must be a multiple of 32/)
})

test('resolution is deterministic', () => {
  const first = WH_RATIOS.map((whRatio) => JSON.stringify(resolveDefaultSize(whRatio)))
  const second = WH_RATIOS.map((whRatio) => JSON.stringify(resolveDefaultSize(whRatio)))
  assert.deepEqual(first, second)
})

test('the megapixel budget scales the search for off-table shapes', () => {
  const one = resolveSize('1:1', 1)
  const two = resolveSize('1:1', 2)
  assert.deepEqual([one.width, one.height], [992, 992])
  assert.ok(two.width > one.width && two.width % SIZE_MULTIPLE === 0)
})

test('explicit sizes must be 32-aligned and the error names the nearest legal values', () => {
  assert.deepEqual(validateSize(1024, 1024), { width: 1024, height: 1024 })
  assert.throws(() => validateSize(1000, 1000), /nearest legal values: 992 and 1024/)
  assert.throws(() => validateSize(128, 512), /between 256 and 4096/)
  assert.throws(() => validateSize(1024.5, 512), /must be an integer/)
})

test('ratio parsing rejects anything that is not a:b', () => {
  assert.deepEqual(parseRatio('16:9'), { a: 16, b: 9 })
  assert.throws(() => parseRatio('16x9'), /must look like/)
  assert.throws(() => parseRatio('0:9'), /must be positive/)
})

test('an explicit size is mapped back to its nearest official tier', () => {
  assert.equal(nearestRatio(1920, 1080).whRatio, '16:9')
  assert.equal(nearestRatio(1080, 1920).whRatio, '9:16')
  assert.equal(nearestRatio(1024, 1024).whRatio, '1:1')
})
