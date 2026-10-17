/**
 * The **local edit** size gate: where the numbers come from, and what the tool does
 * in each of its three bands.
 *
 * Two layers, on purpose:
 *
 * 1. The gate predicts a load the worker computes for itself, so the prediction is
 *    only worth anything if it is the *same function*. The first test therefore does
 *    not restate the formula — it reads `resources/worker.py`, translates the
 *    extracted expression, evaluates it, and compares it against
 *    `referenceBudget` over the whole 32-aligned grid. Change either side alone and
 *    this test goes red; if the Python text stops looking like the expression this
 *    test knows, the translation assertion fails instead of silently passing.
 * 2. The three bands are asserted through the real tool against the node stand-in
 *    for the worker (`test/fixtures/fake-worker.mjs`), so "refused" means "no
 *    process was ever spawned" rather than "a function returned false".
 *
 * Every threshold is this card class's own measurement, not a general truth: the
 * evidence is `docs/evidence/r4b-local-edit-failures.md` §(a)/§(b), and the numbers are
 * quoted in `src/ratio.ts` next to the constants.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as plugin from '../lib/index.js'
import {
  DEFAULT_SIZES,
  LOCAL_EDIT_BUDGET_EDGE,
  LOCAL_EDIT_BUDGET_RELIABLE,
  LOCAL_EDIT_CANVAS_SAFE_BUDGET,
  LOCAL_EDIT_CANVAS_WARN_AREA,
  WH_RATIOS,
  localEditBudgetTier,
  referenceBudget,
} from '../src/ratio.ts'

/** The node stand-in for `resources/worker.py`. */
const FAKE_WORKER = fileURLToPath(new URL('./fixtures/fake-worker.mjs', import.meta.url))

/** The worker's own source: the authority the TS formula is checked against. */
const WORKER_PY = fileURLToPath(new URL('../resources/worker.py', import.meta.url))

// ---------------------------------------------------------------------------
// One formula, two languages
// ---------------------------------------------------------------------------

/**
 * Rebuild `resources/worker.py`'s `_reference_budget` from its own text.
 *
 * The translation is deliberately mechanical and deliberately incomplete: any
 * Python call this test does not know how to translate is reported as a leftover
 * rather than passed through, so a rewritten worker fails here loudly instead of
 * comparing two functions that are no longer the same shape.
 *
 * @returns the extracted Python expression, its JS translation, and the evaluator.
 */
function workerReferenceBudget() {
  const source = readFileSync(WORKER_PY, 'utf8')
  const found = /def _reference_budget\(width, height\):[\s\S]*?\n    return ([^\n]+)\n/.exec(source)
  assert.ok(found, 'resources/worker.py must still define _reference_budget(width, height) with a one-line return')
  const python = found[1].trim()
  const js = python
    .replaceAll('math.sqrt', 'Math.sqrt')
    .replace(/\bmin\(/g, 'Math.min(')
    .replace(/\bmax\(/g, 'Math.max(')
    .replace(/\bint\(/g, 'Math.trunc(')
    .replace(/\bround\(/g, 'Math.round(')
  const leftovers = [...js.matchAll(/(?<![\w.])([a-z_][a-z0-9_]*)\s*\(/g)].map((match) => match[1])
  assert.deepEqual(
    leftovers,
    [],
    `these Python calls have no translation in this test (${leftovers.join(', ')}); teach the test the new spelling or the two formulas are no longer being compared`,
  )
  // eslint-disable-next-line no-new-func -- the point is to evaluate the worker's own text
  return { python, js, of: new Function('width', 'height', `return ${js}`) }
}

/** Every 32-aligned canvas in the legal window, as the grid both sides agree on. */
function alignedGrid() {
  const grid = []
  // `MIN_SIDE`–`MAX_SIDE` from src/ratio.ts: the whole window an explicit
  // width/height is allowed to land in, not a sample of it.
  for (let width = 256; width <= 4096; width += 32) {
    for (let height = 256; height <= 4096; height += 32) grid.push([width, height])
  }
  return grid
}

test('the TS budget formula is the same function as resources/worker.py', () => {
  const worker = workerReferenceBudget()
  console.log('worker.py `_reference_budget` returns:', worker.python)
  console.log('evaluated as JS:', worker.js)
  const grid = alignedGrid()
  const mismatches = grid.filter(([width, height]) => worker.of(width, height) !== referenceBudget(width, height))
  console.log('grid:', grid.length, 'sizes · mismatches:', mismatches.length)
  assert.deepEqual(mismatches.slice(0, 5), [], 'the TS formula and the worker formula disagree on these canvases')
  // Python's `round` is half-to-even, JS `Math.round` is half-up. They only differ on
  // an exact `.5`, so the equality above holds only while no tie exists on the grid
  // — asserted rather than assumed, so a future size table cannot quietly break it.
  const ties = grid.filter(([width, height]) => (Math.sqrt(width * height) / 32) % 1 === 0.5)
  assert.deepEqual(ties, [], 'a 32-aligned canvas hit the half-way rounding case; the two languages would round it differently')
})

test('the seven shipped canvases all land in the refused band', () => {
  const rows = []
  for (const whRatio of WH_RATIOS) {
    const [width, height] = DEFAULT_SIZES[whRatio]
    const budget = referenceBudget(width, height)
    rows.push({ wh_ratio: whRatio, canvas: `${width}x${height}`, budget, tier: localEditBudgetTier(budget) })
  }
  console.table(rows)
  const expected = { '1:1': 1248, '4:3': 1216, '3:4': 1216, '3:2': 1248, '2:3': 1248, '16:9': 1248, '9:16': 1248 }
  for (const [whRatio, budget] of Object.entries(expected)) {
    assert.equal(referenceBudget(...DEFAULT_SIZES[whRatio]), budget, `${whRatio} budget`)
  }
  // This is the finding the gate exists for: on this card class *no* default canvas
  // can be edited locally, so the refusal cannot be avoided by picking another tier.
  for (const row of rows) assert.equal(row.tier, 'over', `${row.wh_ratio} (${row.canvas}) must be refused`)
})

test('the tier boundaries sit on the measured lines', () => {
  assert.equal(LOCAL_EDIT_BUDGET_RELIABLE, 896)
  assert.equal(LOCAL_EDIT_BUDGET_EDGE, 960)
  for (const budget of [32, 704, 832, 896]) assert.equal(localEditBudgetTier(budget), 'reliable', `${budget} is reliable`)
  for (const budget of [928, 960]) assert.equal(localEditBudgetTier(budget), 'edge', `${budget} is the edge band`)
  for (const budget of [992, 1024, 1216, 1248]) assert.equal(localEditBudgetTier(budget), 'over', `${budget} is over`)
})

// ---------------------------------------------------------------------------
// The three bands, through the tool
// ---------------------------------------------------------------------------

/**
 * Ephemeral runtime for the whole file: a machine that already has
 * ~/.dsh-image-forge/venv must not make tests spawn that worker.
 */
const HERMETIC_RUNTIME = mkdtempSync(join(tmpdir(), 'forge-rt-'))

after(() => {
  rmSync(HERMETIC_RUNTIME, { recursive: true, force: true })
})

/** Register the plugin against a stub context and hand back the tool map. */
function register(config) {
  const tools = new Map()
  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    skills: { register: () => undefined },
  }
  plugin.apply(ctx, { ...plugin.Config({}), runtimeDir: HERMETIC_RUNTIME, ...config })
  return tools
}

/** Run one tool with a caller signal, the way the registry does. */
function run(tools, name, args) {
  return tools.get(name).execute(args, { signal: new AbortController().signal })
}

/** Run a tool and return the rejection instead of throwing. */
async function failure(tools, name, args) {
  return run(tools, name, args).then(
    () => undefined,
    (caught) => caught,
  )
}

/** A temp directory tree: references, output, runtime, and a weights stub. */
function fixture(prefix) {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`))
  const outputDir = join(root, 'out')
  const runtimeDir = join(root, 'runtime')
  const modelsDir = join(root, 'models')
  const refs = join(root, 'refs')
  for (const dir of [outputDir, runtimeDir, modelsDir, refs]) mkdirSync(dir, { recursive: true })
  for (const relative of ['model_index.json', 'transformer/config.json', 'text_encoder/config.json', 'vae/config.json']) {
    const path = join(modelsDir, ...relative.split('/'))
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '{}\n')
  }
  return {
    root,
    outputDir,
    runtimeDir,
    modelsDir,
    refs,
    ref: (name, bytes) => {
      const path = join(refs, name)
      writeFileSync(path, bytes)
      return path
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** Every event the fake worker recorded for this runtime directory. */
function workerEvents(runtimeDir) {
  const log = join(runtimeDir, 'fake-worker-events.jsonl')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

/** Kill the worker process the plugin started, so a temp dir can go away. */
function killWorkers(runtimeDir) {
  for (const pid of new Set(workerEvents(runtimeDir).map((entry) => entry.pid))) {
    if (typeof pid !== 'number' || !Number.isFinite(pid)) continue
    try {
      process.kill(pid)
    } catch {
      /* already gone */
    }
  }
}

/** A free port, so the fake worker can be reached at a known endpoint. */
async function freePort() {
  const { createServer } = await import('node:http')
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** A 1×1 PNG: enough for the reference loader, which only has to read a header. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

/** One local-backend runtime, wired to the node stand-in for the worker. */
async function localRuntime(fx, extra = {}) {
  const port = await freePort()
  const tools = register({
    backend: 'local',
    apiKey: '',
    pythonPath: process.execPath,
    workerScript: FAKE_WORKER,
    localEndpoint: `http://127.0.0.1:${port}`,
    workerPorts: `${port}-${port + 2}`,
    workerStartTimeoutMs: 15_000,
    idleUnloadMs: 0,
    manageWorker: true,
    minFreeVramMiB: 0,
    outputDir: fx.outputDir,
    runtimeDir: fx.runtimeDir,
    modelsDir: fx.modelsDir,
    ...extra,
  })
  return tools
}

test('the reliable band runs and reports the budget it was allowed at', async () => {
  const fx = fixture('forge-budget-reliable')
  try {
    const tools = await localRuntime(fx)
    const result = await run(tools, 'qwen_image_edit', {
      prompt: '把参考图里的招牌换成「夏日特惠」。',
      images: [fx.ref('a.png', TINY_PNG)],
      // 1216×672 is the canvas the report measured 3/3 at (budget 896, peak 7458 MiB).
      width: 1216,
      height: 672,
    })
    console.log('reliable band ->', JSON.stringify({ size: result.size, gate: result.local_edit_budget }))
    assert.equal(result.backend, 'local')
    assert.deepEqual(result.size, { width: 1216, height: 672 })
    assert.equal(result.local_edit_budget.budget, 896)
    assert.equal(result.local_edit_budget.budget, referenceBudget(result.size.width, result.size.height))
    assert.equal(result.local_edit_budget.tier, 'reliable')
    assert.equal(result.local_edit_budget.allowed, true)
    assert.equal(result.local_edit_budget.overridden, false)
    assert.equal(result.local_edit_budget.warning, null)
    assert.equal(result.local_edit_budget.reliable_max, LOCAL_EDIT_BUDGET_RELIABLE)
    assert.equal(result.local_edit_budget.edge_max, LOCAL_EDIT_BUDGET_EDGE)
    assert.equal(workerEvents(fx.runtimeDir).filter((entry) => entry.event === 'generate').length, 1)
  } finally {
    killWorkers(fx.runtimeDir)
    fx.cleanup()
  }
})

test('the edge band runs, but only with the warning attached', async () => {
  const fx = fixture('forge-budget-edge')
  try {
    const tools = await localRuntime(fx)
    const result = await run(tools, 'qwen_image_edit', {
      prompt: '把天空换成雪夜。',
      images: [fx.ref('a.png', TINY_PNG)],
      width: 960,
      height: 960,
    })
    console.log('edge band warning:\n' + result.local_edit_budget.warning)
    assert.equal(result.backend, 'local', 'the edge band must still run')
    assert.equal(result.local_edit_budget.budget, 960)
    assert.equal(result.local_edit_budget.tier, 'edge')
    assert.equal(result.local_edit_budget.allowed, true)
    assert.equal(result.local_edit_budget.overridden, false)
    assert.match(result.local_edit_budget.warning, /贴边通过/)
    assert.match(result.local_edit_budget.warning, /8492 MiB/)
    // The warning has to reach the human-readable line, not only the JSON.
    assert.match(result.summary, /贴边通过/)
    assert.equal(workerEvents(fx.runtimeDir).filter((entry) => entry.event === 'generate').length, 1)
  } finally {
    killWorkers(fx.runtimeDir)
    fx.cleanup()
  }
})

test('an over-budget local edit is refused before any worker exists', async () => {
  const fx = fixture('forge-budget-refused')
  try {
    const tools = await localRuntime(fx)
    // No width/height: the default tier table answers 1248×1248 for 1:1.
    const error = await failure(tools, 'qwen_image_edit', {
      prompt: '把背景换成雪夜。',
      images: [fx.ref('a.png', TINY_PNG)],
    })
    console.log('refusal:\n' + error.message)
    assert.ok(error instanceof Error)
    assert.match(error.message, /本地编辑尺寸门/)
    assert.match(error.message, /_reference_budget = 1248/)
    // The failure form, stated the way the measurement states it — because the
    // existing VRAM-gate advice (`POST /free`) cannot fix this one.
    assert.match(error.message, /访问违例/)
    assert.match(error.message, /worker 进程/)
    assert.match(error.message, /不是\*\*一条干净的「显存不足」/)
    assert.match(error.message, /POST \/free/)
    // The three ways out, all named.
    assert.match(error.message, /comfyui/)
    assert.match(error.message, /width\/height/)
    assert.match(error.message, /allowLocalEditOverBudget: true/)
    assert.match(error.message, /docs\/evidence\/r4b-local-edit-failures\.md/)
    // Nothing was started: the refusal happens before `runtime.ensure`.
    assert.deepEqual(workerEvents(fx.runtimeDir), [], 'a refused edit must not spawn a worker')
  } finally {
    killWorkers(fx.runtimeDir)
    fx.cleanup()
  }
})

test('the explicit opt-in lets the same over-budget call through, with the risk stated', async () => {
  const fx = fixture('forge-budget-override')
  try {
    const tools = await localRuntime(fx, { allowLocalEditOverBudget: true })
    const result = await run(tools, 'qwen_image_edit', {
      prompt: '把背景换成雪夜。',
      images: [fx.ref('a.png', TINY_PNG)],
    })
    console.log('over-budget, overridden ->', JSON.stringify({ size: result.size, gate: result.local_edit_budget }))
    assert.equal(result.backend, 'local')
    assert.deepEqual(result.size, { width: 1248, height: 1248 })
    assert.equal(result.local_edit_budget.budget, 1248)
    assert.equal(result.local_edit_budget.tier, 'over')
    assert.equal(result.local_edit_budget.allowed, true)
    assert.equal(result.local_edit_budget.overridden, true)
    assert.match(result.local_edit_budget.warning, /allowLocalEditOverBudget 为 true/)
    // 1248×1248 is *both* over the band and over 1.0 MP, so the override text and
    // the canvas-side advice travel in the same warning and must not contradict
    // each other (the override says "you asked for this", the canvas half says
    // "here is what that canvas measured").
    assert.match(result.local_edit_budget.warning, /画布侧警告/)
    assert.match(result.local_edit_budget.warning, /67 s\/步/)
    assert.match(result.local_edit_budget.warning, /109\.5 s/)
    assert.match(result.summary, /allowLocalEditOverBudget 为 true/)
    assert.match(result.summary, /画布侧警告/)
    assert.equal(workerEvents(fx.runtimeDir).filter((entry) => entry.event === 'generate').length, 1)
  } finally {
    killWorkers(fx.runtimeDir)
    fx.cleanup()
  }
})

test('the same canvas is not gated on the text-to-image path', async () => {
  const fx = fixture('forge-budget-t2i')
  try {
    const tools = await localRuntime(fx)
    // 1:1 is the canvas that was just refused for an edit: t2i measured 5700 MiB
    // reserved on it, so the gate must not leak into the other tool.
    const result = await run(tools, 'qwen_image_generate', { prompt: 'A brass compass.', wh_ratio: '1:1' })
    console.log('t2i on the refused edit canvas ->', JSON.stringify({ size: result.size, backend: result.backend }))
    assert.equal(result.backend, 'local')
    assert.deepEqual(result.size, { width: 1248, height: 1248 })
    assert.equal(result.local_edit_budget, undefined)
  } finally {
    killWorkers(fx.runtimeDir)
    fx.cleanup()
  }
})

// ---------------------------------------------------------------------------
// `localReferenceBudget`: the knob that moves the budget the gate bands
// ---------------------------------------------------------------------------

/** The `/generate` bodies the fake worker actually received, parsed. */
function generateBodies(runtimeDir) {
  return workerEvents(runtimeDir)
    .filter((entry) => entry.event === 'generate')
    .map((entry) => JSON.parse(entry.body))
}

test('the default sends no budget at all: the worker derives it, as it always has', async () => {
  const fx = fixture('forge-budget-default-body')
  try {
    const tools = await localRuntime(fx)
    const result = await run(tools, 'qwen_image_edit', {
      prompt: '把天空换成雪夜。',
      images: [fx.ref('a.png', TINY_PNG)],
      width: 1216,
      height: 672,
    })
    const bodies = generateBodies(fx.runtimeDir)
    console.log('default path /generate body keys:', JSON.stringify(bodies.map((body) => Object.keys(body))))
    assert.equal(bodies.length, 1)
    // Byte-for-byte the old request shape: a budget field here — even one that
    // happens to equal the derived value — would mean the worker is no longer the
    // authority on its own default.
    assert.ok(!('reference_budget' in bodies[0]), 'the default path must not put a budget on the wire')
    assert.equal(result.local_edit_budget.budget_source, 'canvas')
    assert.equal(result.local_edit_budget.canvas_budget, result.local_edit_budget.budget)
    assert.equal(result.local_edit_budget.configured_budget, 0)
  } finally {
    killWorkers(fx.runtimeDir)
    fx.cleanup()
  }
})

test('an explicit budget is what the gate bands and what the worker is told', async () => {
  const fx = fixture('forge-budget-explicit')
  try {
    // 1248×1248 is the canvas the test above proves is refused by default: this is
    // the whole point of the knob, so it must be *allowed* here rather than banded
    // by the 1248 its area implies.
    const tools = await localRuntime(fx, { localReferenceBudget: 512 })
    const result = await run(tools, 'qwen_image_edit', {
      prompt: '把背景换成雪夜。',
      images: [fx.ref('a.png', TINY_PNG)],
    })
    console.log('explicit 512 on the refused canvas ->', JSON.stringify({ size: result.size, gate: result.local_edit_budget }))
    assert.equal(result.backend, 'local')
    assert.deepEqual(result.size, { width: 1248, height: 1248 })
    assert.equal(result.local_edit_budget.budget, 512)
    assert.equal(result.local_edit_budget.budget_source, 'config')
    assert.equal(result.local_edit_budget.canvas_budget, 1248)
    assert.equal(result.local_edit_budget.configured_budget, 512)
    assert.equal(result.local_edit_budget.tier, 'reliable')
    assert.equal(result.local_edit_budget.allowed, true)
    assert.equal(result.local_edit_budget.overridden, false)
    assert.equal(result.local_edit_budget.warning, null)
    // And the worker really was told: the canvas stays 1248×1248, the conditioning
    // budget is 512.
    const bodies = generateBodies(fx.runtimeDir)
    console.log('explicit path /generate body:', JSON.stringify({ ...bodies[0], images: `<${bodies[0].images?.[0]?.length ?? 0} base64 chars>` }))
    assert.equal(bodies.length, 1)
    assert.equal(bodies[0].reference_budget, 512)
    assert.equal(bodies[0].width, 1248)
    assert.equal(bodies[0].height, 1248)
  } finally {
    killWorkers(fx.runtimeDir)
    fx.cleanup()
  }
})

test('the explicit budget wins in both directions: one that is itself over the line is still refused', async () => {
  const fx = fixture('forge-budget-explicit-over')
  try {
    // The canvas is the reliable 1216×672 (derived budget 896); the configured
    // budget is what runs, so the gate must refuse — a knob that could only lower
    // the band would hide a typo like 1248 behind an unrelated canvas.
    const tools = await localRuntime(fx, { localReferenceBudget: 1248 })
    const error = await failure(tools, 'qwen_image_edit', {
      prompt: '把天空换成雪夜。',
      images: [fx.ref('a.png', TINY_PNG)],
      width: 1216,
      height: 672,
    })
    console.log('explicit over-budget refusal:\n' + error.message)
    assert.ok(error instanceof Error)
    assert.match(error.message, /本地编辑尺寸门/)
    assert.match(error.message, /_reference_budget = 1248（来自配置 localReferenceBudget；这张画布本身会推出 896）/)
    assert.match(error.message, /localReferenceBudget/)
    assert.deepEqual(workerEvents(fx.runtimeDir), [], 'a refused edit must not spawn a worker')
  } finally {
    killWorkers(fx.runtimeDir)
    fx.cleanup()
  }
})

test('a budget that is not 32-aligned is rejected by name instead of silently honoured', async () => {
  const fx = fixture('forge-budget-misconfigured')
  try {
    const tools = await localRuntime(fx, { localReferenceBudget: 500 })
    const error = await failure(tools, 'qwen_image_edit', {
      prompt: '把天空换成雪夜。',
      images: [fx.ref('a.png', TINY_PNG)],
      width: 1216,
      height: 672,
    })
    console.log('misconfigured budget refusal:\n' + error.message)
    assert.ok(error instanceof Error)
    assert.match(error.message, /localReferenceBudget must be 0 .*multiple of 32/)
    assert.match(error.message, /got 500/)
    assert.deepEqual(workerEvents(fx.runtimeDir), [], 'nothing may be spawned for a rejected config value')
  } finally {
    killWorkers(fx.runtimeDir)
    fx.cleanup()
  }
})

test('the conditional-resolution knob is local-edit only: t2i never carries it', async () => {
  const fx = fixture('forge-budget-t2i-unaffected')
  try {
    const tools = await localRuntime(fx, { localReferenceBudget: 512 })
    const result = await run(tools, 'qwen_image_generate', { prompt: 'A brass compass.', wh_ratio: '1:1' })
    const bodies = generateBodies(fx.runtimeDir)
    console.log('t2i with a configured budget ->', JSON.stringify({ size: result.size, body: bodies[0] }))
    assert.equal(result.backend, 'local')
    // Text-to-image conditions on no reference at all, so the knob has nothing to
    // change there — and the request must not pretend otherwise.
    assert.ok(!('reference_budget' in bodies[0]), 'text-to-image must not carry a reference budget')
  } finally {
    killWorkers(fx.runtimeDir)
    fx.cleanup()
  }
})

// ---------------------------------------------------------------------------
// The canvas side: the three bands above band the **budget** alone
// ---------------------------------------------------------------------------

/**
 * One local edit, reduced to what the canvas-side rule is about.
 *
 * @param prefix - temp-directory prefix, so a leaked dir names its own test.
 * @param extra - config overrides (`localReferenceBudget`, …).
 * @param args - tool args (the canvas, when the test sets one explicitly).
 * @returns the resolved canvas, the gate verdict, the summary line, and the
 *   `/generate` bodies the fake worker received.
 */
async function editResult(prefix, extra, args = {}) {
  const fx = fixture(prefix)
  try {
    const tools = await localRuntime(fx, extra)
    const result = await run(tools, 'qwen_image_edit', {
      prompt: '把背景换成雪夜。',
      images: [fx.ref('a.png', TINY_PNG)],
      ...args,
    })
    return { size: result.size, gate: result.local_edit_budget, summary: result.summary, bodies: generateBodies(fx.runtimeDir) }
  } finally {
    killWorkers(fx.runtimeDir)
    fx.cleanup()
  }
}

test('a 1.5 MP canvas above budget 512 carries the canvas-side warning and still runs', async () => {
  // The knob's advertised case, and the one `docs/evidence/r5-budget-canvas-matrix.md` falsified: keep 1248×1248
  // (1.55 MP) and condition at 896. Budget-wise that is still the reliable band,
  // so the gate must let it through — with a warning, because the measurement on
  // that canvas is 67 s/step (≈28 min for 25 steps, no error).
  const big = await editResult('forge-canvas-big', { localReferenceBudget: 896 })
  console.log('1.5 MP canvas + 896 ->', JSON.stringify({ size: big.size, gate: big.gate }))
  assert.deepEqual(big.size, { width: 1248, height: 1248 })
  assert.equal(big.gate.budget, 896)
  assert.equal(big.gate.tier, 'reliable', 'the budget alone is still inside the reliable band')
  assert.equal(big.gate.allowed, true, 'the canvas-side warning must not refuse anything')
  assert.equal(big.gate.overridden, false)
  const warning = big.gate.warning
  assert.ok(warning !== null, 'a 1.5 MP canvas at budget 896 must carry the canvas-side warning')
  assert.match(warning, /画布侧警告/)
  assert.match(warning, /不是拒绝/, 'it must say it is advice, not a refusal')
  assert.match(warning, /1\.0 MP/)
  // Both measured endpoints, and the line between them named as interpolation.
  assert.match(warning, /1\.9 s\/步/)
  assert.match(warning, /67 s\/步/)
  assert.match(warning, /28 min/)
  assert.match(warning, /109\.5 s/)
  assert.match(warning, /6488/)
  assert.match(warning, /插值/)
  assert.match(warning, /513–895/, 'the unmeasured interval has to be stated, not implied')
  assert.match(warning, /docs\/evidence\/r5-budget-canvas-matrix\.md/)
  // The recommendation names the budget that was actually measured there.
  assert.match(warning, new RegExp(`\\b${LOCAL_EDIT_CANVAS_SAFE_BUDGET}\\b`))
  // Like the edge band's warning, it has to reach the human-readable line.
  assert.match(big.summary, /67 s\/步/)
  // And it changed nothing about the request itself: same canvas, same budget.
  assert.equal(big.bodies.length, 1)
  assert.equal(big.bodies[0].reference_budget, 896)
  assert.equal(big.bodies[0].width, 1248)
  assert.equal(big.bodies[0].height, 1248)
})

test('the canvas-side warning needs both a canvas over 1 MP and a budget over 512', async () => {
  // Below the area line: 1216×672 is 0.82 MP — the canvas the reliable line was
  // measured on (its derived budget is exactly 896).
  const smallCanvas = await editResult('forge-canvas-small', {}, { width: 1216, height: 672 })
  console.log('0.82 MP canvas + 896 ->', JSON.stringify({ size: smallCanvas.size, gate: smallCanvas.gate }))
  assert.deepEqual(smallCanvas.size, { width: 1216, height: 672 })
  assert.equal(smallCanvas.gate.budget, 896)
  assert.equal(smallCanvas.gate.tier, 'reliable')
  assert.equal(smallCanvas.gate.warning, null, 'at 0.82 MP the reliable band stays silent')

  // At the budget line: 512 is the one budget measured to finish on 1.5 MP.
  const cheap = await editResult('forge-canvas-512', { localReferenceBudget: LOCAL_EDIT_CANVAS_SAFE_BUDGET })
  console.log('1.5 MP canvas + 512 ->', JSON.stringify({ size: cheap.size, gate: cheap.gate }))
  assert.deepEqual(cheap.size, { width: 1248, height: 1248 })
  assert.equal(cheap.gate.budget, LOCAL_EDIT_CANVAS_SAFE_BUDGET)
  assert.equal(cheap.gate.tier, 'reliable')
  assert.equal(cheap.gate.warning, null, 'at 512 even a 1.5 MP canvas needs no canvas warning')

  // The line really is area-based rather than a list of the seven tiers: a canvas
  // in the interpolated region (1.25 MP, explicit size) at 896 also trips it —
  // and the warning reports *that* area, so the threshold is not decorative.
  assert.ok(1216 * 1024 > LOCAL_EDIT_CANVAS_WARN_AREA && 1216 * 672 < LOCAL_EDIT_CANVAS_WARN_AREA)
  const between = await editResult('forge-canvas-between', { localReferenceBudget: 896 }, { width: 1216, height: 1024 })
  console.log('1.25 MP canvas + 896 ->', JSON.stringify({ size: between.size, warning: between.gate.warning }))
  assert.deepEqual(between.size, { width: 1216, height: 1024 })
  assert.equal(between.gate.tier, 'reliable')
  assert.match(String(between.gate.warning), /1\.25 MP/)
  assert.match(String(between.gate.warning), /插值/)
})

// ---------------------------------------------------------------------------
// The falsified sentence must not come back
// ---------------------------------------------------------------------------

/** The composed skill body: the same string the skill registration ships. */
function composedSkillBody() {
  const skills = []
  const ctx = {
    tools: { register: () => undefined },
    skills: { register: (registration) => skills.push(registration) },
  }
  plugin.apply(ctx, { ...plugin.Config({}), outputDir: mkdtempSync(join(tmpdir(), 'forge-skill-body-')) })
  return skills[0].content
}

test('no shipped text pairs a ≤896 ceiling with "the canvas can stay at 1.5 MP" again', () => {
  // `docs/evidence/r5-budget-canvas-matrix.md` falsified the old copy: 896 was only ever measured on a
  // 0.82 MP canvas, and on a 1.5 MP one it means 67 s/step (≈28 min, no error).
  // Guard every surface that ships text: the shipped prose (the README plus
  // `docs/backends.md`, where the local backend's measurements moved when the
  // README was split), the skill body (`skill.md` is
  // read at runtime by `src/skill.ts`, so the *composed* string is the evidence),
  // and the built tool text (descriptions come from `lib/index.js`).
  const root = fileURLToPath(new URL('..', import.meta.url))
  const texts = {
    // The key keeps its old name — the assertion below keys off it, so renaming
    // would only move the churn. The entry itself is now the prose surface: the
    // README carries 109.5 / 1216×672, `docs/backends.md` carries 67 s/步 and the
    // interpolation caveat, and both are searched as one string.
    'README.md': ['README.md', join('docs', 'backends.md')]
      .map((file) => readFileSync(join(root, file), 'utf8'))
      .join('\n'),
    'skill body (composed)': composedSkillBody(),
    'lib/index.js (tool text)': readFileSync(join(root, 'lib', 'index.js'), 'utf8'),
  }
  const falsified = [
    // The two spellings of the withdrawn claim, next to the ceiling it named.
    /≤\s*896[\s\S]{0,200}画布(可以|可)保持\s*1\.5\s*MP/,
    /画布(可以|可)保持\s*1\.5\s*MP[\s\S]{0,200}≤\s*896/,
    // 512 and 896 lumped together as one option: on the same 1.5 MP canvas they
    // are 109.5 s and ≈28 min.
    /`?512`?\s*（或\s*`?896`?\s*）/,
  ]
  for (const [where, text] of Object.entries(texts)) {
    for (const pattern of falsified) {
      assert.ok(!pattern.test(text), `${where} still carries the falsified pairing: ${pattern}`)
    }
    // The corrected facts have to be there instead, with the canvas they were
    // measured on: 512's 109.5 s and 896's 67 s/step.
    assert.match(text, /67 s\/步/, `${where} must carry the 896-on-a-1.5MP-canvas measurement`)
    assert.match(text, /109\.5/, `${where} must carry the 512-on-a-1.5MP-canvas measurement`)
    assert.match(text, /1216×672/, `${where} must keep the canvas the 896 line was measured on`)
  }
  // The 1.0 MP line is interpolation between the two endpoints, and has to say so.
  assert.match(texts['README.md'], /插值/)
  assert.match(texts['skill body (composed)'], /插值/)
})
