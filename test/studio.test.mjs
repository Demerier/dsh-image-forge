/**
 * The Studio's pure contract: what the panel is allowed to send, what the host
 * resolves it to, and how the optimiser's answer is taken apart.
 *
 * Everything here runs against the `testlib/` logic bundles rather than a live
 * socket, because the interesting failures are all *before* the wire: a ratio
 * the panel invented, a step count past the clamp, a body that carries a
 * megabyte of JSON pretending to be a reference image. The HTTP framing
 * (`readBody`'s cap, the heartbeat, the 500 guard) is exercised by the e2e
 * harnesses instead; asserting it here would mostly test `node:http`.
 *
 * The one thing this file deliberately does *not* do is generate. A real draw
 * needs ComfyUI, and a fake one would assert that a mock returns what the mock
 * was given. The split points that make generation deterministic — the resolved
 * canvas and the resolved step count — are covered directly instead.
 *
 * The T18 section at the bottom is the one exception to "logic bundles only":
 * the workbench now consumes the plugin's SSE progress stream, and that path
 * (event → state → rendered text) is worth executing rather than grepping. It
 * runs the real §lib/client.js§ through a fake module loader, a minimal React
 * and a fake EventSource; see the section note for what that does and does not
 * prove.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decodeImportData,
  parseBoardAction,
  parseGenerate,
  parseImport,
  parseOptimize,
  registerStudioRoutes,
} from '../testlib/studio-routes.js'
import {
  resolveStudioSteps,
  studioSettingsOf,
  studioSize,
  studioSizeTable,
  studioTextToImageRequestOf,
} from '../testlib/studio-service.js'
import {
  DEFAULT_MOSS_SAMPLING,
  MODEL_PROFILES,
  MOSS_SAMPLING_PRESETS,
  TURBO_SIGMAS,
  renderTextToImage,
  TURBO_STEPS,
  effectiveProfile,
  presetSteps,
  resolveProfile,
  resolveSampling,
  turboUnetOf,
} from '../testlib/comfyui.js'
import {
  FORMULA_SYSTEM_PROMPT,
  PROSE_SYSTEM_PROMPT,
  buildOptimizeUserText,
  systemPromptFor,
  llmOf,
  resolveOptimizerFor,
  splitOptimizerAnswer,
  stripWrappingQuotes,
} from '../testlib/studio-prompt.js'
import {
  STUDIO_BOARD_ROUTE,
  STUDIO_CLIENT_ID_MAX_CHARS,
  STUDIO_CONFIG_ROUTE,
  STUDIO_ENVIRONMENT_ROUTE,
  STUDIO_EVENTS_ROUTE,
  STUDIO_GENERATE_ROUTE,
  STUDIO_IMPORT_MAX_ITEM_BYTES,
  STUDIO_IMPORT_ROUTE,
  STUDIO_LAYOUT_RATIO_TOLERANCE,
  STUDIO_MAX_COUNT,
  STUDIO_MAX_PROMPT_CHARS,
  STUDIO_RATIOS,
  fitStudioRatio,
  isStudioClientId,
  stepperStepsOf,
} from '../testlib/studio-shared.js'
import { compileLayout } from '../src/layout-editor.ts'

/** The authoritative compiled-layout sample (T21's format authority). */
const LAYOUT_SAMPLE = readFileSync(fileURLToPath(new URL('../verify/layout_prompt.json', import.meta.url)), 'utf8')
import { resolveDefaultSize } from '../testlib/ratio.js'

// The published surface is exactly `Config, apply, inject, name` (asserted in
// settings.test.mjs), so the Studio constants are deliberately *not* re-exported
// from the plugin entry — importing them above reads the same module the host
// and the panel both compile against.

// ---------------------------------------------------------------------------
// Request validation: the panel is not trusted, even though we wrote it.
// ---------------------------------------------------------------------------

test('a generated body is narrowed to exactly the fields the pipeline reads', () => {
  const parsed = parseGenerate({ prompt: '  一只橘猫坐在窗台上  ', ratio: '16:9', steps: 24, count: 2, seed: 7 })
  assert.deepEqual(parsed, { prompt: '一只橘猫坐在窗台上', ratio: '16:9', steps: 24, count: 2, seed: 7 })
  // Omitted fields stay absent rather than becoming 0 or NaN: `undefined` is the
  // signal that lets the host fall back to its configured default.
  const minimal = parseGenerate({ prompt: '猫', ratio: '1:1' })
  assert.deepEqual(minimal, { prompt: '猫', ratio: '1:1' })
  assert.ok(!('steps' in minimal), 'an omitted step count must not appear as a key')
})

test('the ratio must be one the picker actually offered', () => {
  // A ratio is the one field that becomes pixels, so an unknown one is refused
  // here rather than silently coerced into a square.
  assert.throws(() => parseGenerate({ prompt: '猫', ratio: '5:4' }), /不支持的画幅比例：5:4/)
  assert.throws(() => parseGenerate({ prompt: '猫', ratio: '16x9' }), /不支持的画幅比例/)
  // Surrounding whitespace is trimmed before the comparison, so a trailing space
  // from the DOM is not a refusal.
  assert.equal(parseGenerate({ prompt: '猫', ratio: ' 16:9 ' }).ratio, '16:9')
  for (const ratio of STUDIO_RATIOS) {
    assert.equal(parseGenerate({ prompt: '猫', ratio }).ratio, ratio)
  }
})

test('an empty or oversized prompt is refused with a message the panel can show', () => {
  assert.throws(() => parseGenerate({ ratio: '1:1' }), /请输入提示词/)
  assert.throws(() => parseGenerate({ prompt: '   ', ratio: '1:1' }), /请输入提示词/)
  assert.throws(() => parseGenerate({ prompt: 'x'.repeat(STUDIO_MAX_PROMPT_CHARS + 1), ratio: '1:1' }), /最多 4000 个字符/)
  // Exactly at the cap is legal — an off-by-one here would reject a prompt the
  // optimiser itself can produce.
  assert.equal(parseGenerate({ prompt: 'x'.repeat(STUDIO_MAX_PROMPT_CHARS), ratio: '1:1' }).prompt.length, STUDIO_MAX_PROMPT_CHARS)
})

test('a non-numeric step, seed or count is a refusal, not a silent zero', () => {
  for (const field of ['steps', 'seed', 'count']) {
    assert.throws(() => parseGenerate({ prompt: '猫', ratio: '1:1', [field]: 'many' }), /必须是数字/, `${field} as a string`)
    assert.throws(() => parseGenerate({ prompt: '猫', ratio: '1:1', [field]: Number.NaN }), /必须是数字/, `${field} as NaN`)
    assert.throws(() => parseGenerate({ prompt: '猫', ratio: '1:1', [field]: Infinity }), /必须是数字/, `${field} as Infinity`)
  }
  // Fractions truncate; the clamp in `resolveStudioSteps` handles the rest.
  assert.equal(parseGenerate({ prompt: '猫', ratio: '1:1', steps: 23.9 }).steps, 23)
})

test('a body that is not an object is refused', () => {
  for (const body of [undefined, null, 'a string', 42, []]) {
    assert.throws(() => parseGenerate(body), /请求格式无效/)
  }
})

test('reference images carry base64 and are rejected when empty', () => {
  const parsed = parseGenerate({
    prompt: '把背景换成夜景',
    ratio: '4:3',
    references: [{ data: 'AAAA', mediaType: 'image/jpeg', name: '  base.png  ' }],
  })
  assert.deepEqual(parsed.references, [{ data: 'AAAA', mediaType: 'image/jpeg', name: 'base.png' }])

  // An absent mediaType falls back to PNG rather than reaching a filename empty.
  const noType = parseGenerate({ prompt: 'x', ratio: '1:1', references: [{ data: 'AAAA' }] })
  assert.equal(noType.references[0].mediaType, 'image/png')

  assert.throws(() => parseGenerate({ prompt: 'x', ratio: '1:1', references: 'nope' }), /参考图格式无效/)
  assert.throws(() => parseGenerate({ prompt: 'x', ratio: '1:1', references: [{ data: '' }] }), /第 1 张参考图内容为空/)
  // An empty list is normalised away so the pipeline sees "no references" and
  // takes the text-to-image path, not the edit path with an empty gallery.
  assert.ok(!('references' in parseGenerate({ prompt: 'x', ratio: '1:1', references: [] })))
})

test('a reference may point at a file this host wrote, but never at both channels', () => {
  // The canvas hands back a path instead of bytes: the browser never had them.
  const byPath = parseGenerate({
    prompt: 'x',
    ratio: '1:1',
    references: [{ path: 'D:/out/studio_1.png', mediaType: 'image/png' }],
  })
  assert.equal(byPath.references?.[0]?.path, 'D:/out/studio_1.png')
  assert.equal(byPath.references?.[0]?.data, undefined)

  // Both at once is ambiguous about which one wins, so it is refused.
  assert.throws(
    () => parseGenerate({
      prompt: 'x',
      ratio: '1:1',
      references: [{ path: 'D:/out/a.png', data: 'AAAA', mediaType: 'image/png' }],
    }),
    /同时给了 path 和 data/,
  )

  // Neither is still the old "empty reference" error.
  assert.throws(
    () => parseGenerate({ prompt: 'x', ratio: '1:1', references: [{}] }),
    /内容为空/,
  )
})

test('a generation body carries its board, and a blank one means "new board"', () => {
  assert.equal(parseGenerate({ prompt: '猫', ratio: '1:1', board: '  b1234567  ' }).board, 'b1234567')
  // Absent and blank are both "the host decides", which for the panel is the
  // active board — never an empty-string board id.
  assert.ok(!('board' in parseGenerate({ prompt: '猫', ratio: '1:1' })))
  assert.ok(!('board' in parseGenerate({ prompt: '猫', ratio: '1:1', board: '   ' })))
  assert.ok(!('board' in parseGenerate({ prompt: '猫', ratio: '1:1', board: 42 })))
  assert.equal(parseGenerate({ prompt: '猫', ratio: '1:1', board: 'x'.repeat(200) }).board.length, 80)
})

test('a generation body carries an optional canvas clientId, and a malformed one is refused', () => {
  // Absent is the old wire: the parsed body is exactly the pre-DD7 shape, so a
  // tab that predates the canvas behaves identically.
  assert.deepEqual(parseGenerate({ prompt: '猫', ratio: '1:1' }), { prompt: '猫', ratio: '1:1' })
  assert.ok(!('clientId' in parseGenerate({ prompt: '猫', ratio: '1:1' })))

  // Present is the canvas wire: `c` + base36, bounded at 32 characters.
  assert.deepEqual(
    parseGenerate({ prompt: '猫', ratio: '1:1', clientId: 'c1a2b3' }),
    { prompt: '猫', ratio: '1:1', clientId: 'c1a2b3' },
  )
  assert.equal(
    parseGenerate({ prompt: '猫', ratio: '1:1', clientId: 'c' + 'z'.repeat(31) }).clientId.length,
    STUDIO_CLIENT_ID_MAX_CHARS,
  )
  // A single-value field is refused when malformed, unlike the board route's
  // per-entry coordinate lists: a typo here would silently detach a task node
  // from every event of its own run.
  for (const clientId of ['', 'abc', 'Cabc123', 'cABC123', 'c-123', 'c' + 'z'.repeat(32), 42, {}]) {
    assert.throws(
      () => parseGenerate({ prompt: '猫', ratio: '1:1', clientId }),
      /clientId 格式无效/,
      'malformed clientId must be refused: ' + JSON.stringify(clientId),
    )
  }
  // The validator is shared with the panel's id generator, so both halves agree
  // on what a canonical id is.
  assert.equal(isStudioClientId('c1a2b3'), true)
  assert.equal(isStudioClientId('c'), false)
  assert.equal(isStudioClientId('x123'), false)
  assert.equal(isStudioClientId(42), false)
})

test('a board mutation is a closed action set with bounded payloads', () => {
  const layout = parseBoardAction({
    action: 'layout',
    board: ' b1 ',
    items: [{ id: 'i1', x: 12, y: -4 }, { id: 'bad' }, { id: 'i2', x: Number.NaN, y: 1 }, null],
    camera: { x: 1, y: 2, zoom: 0.5 },
  })
  assert.equal(layout.action, 'layout')
  assert.equal(layout.board, 'b1')
  // Only fully specified positions survive; one malformed entry must not fail
  // the whole save (the user just dragged twenty nodes).
  assert.deepEqual(layout.items, [{ id: 'i1', x: 12, y: -4 }])
  assert.deepEqual(layout.camera, { x: 1, y: 2, zoom: 0.5 })

  // A typo in the panel must look like a refusal, not a successful save.
  assert.throws(() => parseBoardAction({ action: 'nope' }), /未知的画板操作/)
  assert.throws(() => parseBoardAction(null), /请求格式无效/)
  assert.throws(() => parseBoardAction({}), /未知的画板操作/)

  assert.equal(parseBoardAction({ action: 'remove-item', item: 'i9', deleteFile: true }).deleteFile, true)
  // Deleting the file is opt-in: only the literal boolean counts.
  assert.equal(parseBoardAction({ action: 'remove-item', item: 'i9', deleteFile: 'yes' }).deleteFile, undefined)

  // A camera the store cannot use is dropped rather than written as NaN.
  assert.equal(parseBoardAction({ action: 'layout', camera: { x: Number.NaN, y: 0, zoom: 1 } }).camera, undefined)
  assert.equal(parseBoardAction({ action: 'layout', camera: { x: 0, y: 0, zoom: 0 } }).camera, undefined)
})

test('the optimise body keeps context but truncates it instead of refusing', () => {
  const parsed = parseOptimize({
    prompt: '  做个赛博朋克街景  ',
    editing: true,
    ratio: '3:4',
    context: [
      { role: 'user', text: ' 想想画面 ' },
      { role: 'assistant', text: '好的' },
      { role: 'system', text: 'ignored' },
      { role: 'user', text: '   ' },
    ],
  })
  assert.equal(parsed.prompt, '做个赛博朋克街景')
  assert.equal(parsed.editing, true)
  assert.equal(parsed.ratio, '3:4')
  // The system turn and the blank turn are dropped, not forwarded as context.
  assert.deepEqual(parsed.context, [
    { role: 'user', text: '想想画面' },
    { role: 'assistant', text: '好的' },
  ])

  // An unknown ratio is not a refusal here: the optimiser only uses it for
  // wording, so a bad one costs nothing.
  assert.equal(parseOptimize({ prompt: 'x', ratio: 'weird' }).ratio, 'weird')
  // `editing` defaults to false rather than being truthy-coerced.
  assert.equal(parseOptimize({ prompt: 'x', editing: 'yes' }).editing, false)
  assert.throws(() => parseOptimize({ prompt: '' }), /请输入提示词/)
})

// ---------------------------------------------------------------------------
// The two resolutions that decide what reaches the GPU.
// ---------------------------------------------------------------------------

/** Settings with only the fields `resolveStudioSteps` reads. */
function stepsSettings(defaultSteps, comfyuiSteps) {
  return { defaultSteps, comfyuiSteps }
}

test('a requested step count is clamped, and an absent one falls back to the config', () => {
  // Explicit request wins, inside the clamp.
  assert.equal(resolveStudioSteps(stepsSettings(25, 12), 30), 30)
  assert.equal(resolveStudioSteps(stepsSettings(25, 12), 1), 1)
  assert.equal(resolveStudioSteps(stepsSettings(25, 12), 1000), 200)
  assert.equal(resolveStudioSteps(stepsSettings(25, 12), -5), 1)
  // Absent or unusable → the ComfyUI override, then the global default.
  assert.equal(resolveStudioSteps(stepsSettings(25, 12), undefined), 12)
  assert.equal(resolveStudioSteps(stepsSettings(25, undefined), undefined), 25)
  assert.equal(resolveStudioSteps(stepsSettings(25, 12), Number.NaN), 12)
  // Rounded, so a slider that produces 23.6 cannot put a fraction on the wire.
  assert.equal(resolveStudioSteps(stepsSettings(25, 12), 23.6), 24)
})

test('every advertised ratio resolves, and to the same canvas the Agent tool uses', () => {
  const table = studioSizeTable()
  assert.deepEqual(table.map((entry) => entry.ratio), [...STUDIO_RATIOS])
  for (const entry of table) {
    const resolved = studioSize(entry.ratio)
    assert.ok(resolved !== undefined, `${entry.ratio} must resolve`)
    assert.equal(resolved.width, entry.width)
    assert.equal(resolved.height, entry.height)
    // 32-alignment is what Qwen-Image's VAE requires; a picker label that lied
    // about it would produce the wrong aspect on every draw.
    assert.equal(resolved.width % 32, 0, `${entry.ratio} width must be 32-aligned`)
    assert.equal(resolved.height % 32, 0, `${entry.ratio} height must be 32-aligned`)
    // And the Studio must agree with the ratio module, not merely with itself.
    const shared = resolveDefaultSize(entry.ratio)
    assert.equal(entry.width, shared.width, `${entry.ratio} must match resolveDefaultSize`)
    assert.equal(entry.height, shared.height, `${entry.ratio} must match resolveDefaultSize`)
  }
  assert.equal(studioSize('5:4'), undefined)
  assert.equal(studioSize(''), undefined)
})

test('the studio reads the same config fields the Agent tools do', () => {
  const settings = studioSettingsOf({
    comfyEndpoint: 'http://127.0.0.1:8188',
    comfyPorts: '8188, 8189 8190',
    comfyModelsDir: '/models',
    timeoutMs: 150_000,
    outputDir: '/out',
    defaultSteps: 25,
    comfyuiSteps: 12,
    comfyModel: 'turbo',
    mossSampling: 'official',
    turboSteps: 6,
  })
  assert.deepEqual(settings, {
    comfyEndpoint: 'http://127.0.0.1:8188',
    comfyPorts: [8188, 8189, 8190],
    comfyModelsDir: '/models',
    timeoutMs: 150_000,
    outputDir: '/out',
    defaultSteps: 25,
    comfyuiSteps: 12,
    comfyModel: 'turbo',
    mossSampling: 'official',
    turboSteps: 6,
  })
  // A malformed port list falls back to the defaults rather than yielding `[]`,
  // which would leave the probe with no port to try at all.
  assert.ok(studioSettingsOf({ ...settings, comfyPorts: '' }).comfyPorts.length > 0)
  assert.ok(studioSettingsOf({ ...settings, comfyPorts: 'nope, -1, 99999' }).comfyPorts.length > 0)
})

// ---------------------------------------------------------------------------
// The optimiser: prompt assembly and answer parsing.
// ---------------------------------------------------------------------------

test('the optimiser turn tells the model the mode and the canvas', () => {
  const t2i = buildOptimizeUserText({ prompt: '  橘猫  ', editing: false, ratio: '1:1' })
  assert.match(t2i, /用户需求：橘猫/)
  assert.match(t2i, /文生图/)
  assert.match(t2i, /目标画幅比例：1:1/)
  assert.ok(!t2i.includes('用户需求：  橘猫'), 'the prompt must be trimmed before it is embedded')

  const edit = buildOptimizeUserText({ prompt: '换成夜景', editing: true })
  assert.match(edit, /图像编辑/)
  assert.ok(!edit.includes('目标画幅比例'), 'no ratio means no ratio line, not an empty one')
})

test('the prose system prompt carries the house skeleton, not just a tone', () => {
  // The Studio rewrites prompts on the same contract as skill.md, so the four
  // properties that make a prompt "Qwen-Image shaped" must be stated, and the
  // ones that silently degrade output must be banned by name.
  assert.match(PROSE_SYSTEM_PROMPT, /20 句/, 'the prose length target must be explicit')
  assert.match(PROSE_SYSTEM_PROMPT, /方位短语/, 'spatial phrases are what stop the subject floating in the centre')
  assert.match(PROSE_SYSTEM_PROMPT, /光照必须单独成句/)
  assert.match(PROSE_SYSTEM_PROMPT, /只准一句/, 'the closing sentence must be capped at one')
  assert.match(PROSE_SYSTEM_PROMPT, /8K/)
  assert.match(PROSE_SYSTEM_PROMPT, /masterpiece/)
  assert.match(PROSE_SYSTEM_PROMPT, /绝不把比例/, 'ratio belongs to the picker, never to the prose')
  assert.match(PROSE_SYSTEM_PROMPT, /<image1>/, 'edit mode must name its references')
  // The old instruction to "keep the user's language" fought the skeleton: a
  // Chinese request now yields English prose with the on-image text untouched.
  assert.ok(!/用中文就写中文/.test(PROSE_SYSTEM_PROMPT), 'the prose language rule must not contradict the skeleton')
})

test('the formula style is the other school, and the two are never interchangeable', () => {
  // The keyword formula must keep the six slots and its own output shape.
  assert.match(FORMULA_SYSTEM_PROMPT, /主体\s*\+\s*场景\s*\+\s*风格\s*\+\s*镜头\s*\+\s*氛围\s*\+\s*细节修饰/)
  assert.match(FORMULA_SYSTEM_PROMPT, /一行/, 'a formula answer is one line, not a paragraph')
  assert.match(FORMULA_SYSTEM_PROMPT, /4K/, 'the formula school treats 4K as a legitimate detail modifier')
  assert.match(FORMULA_SYSTEM_PROMPT, /不写画幅比例/, 'the ratio still belongs to the picker in both schools')

  // Load-bearing difference: what prose bans by name, formula invites.
  assert.ok(!/masterpiece/.test(PROSE_SYSTEM_PROMPT) === false, 'prose bans masterpiece')
  assert.ok(!/禁止空话[^\n]*4K/.test(FORMULA_SYSTEM_PROMPT), 'formula must not ban the words it lists as modifiers')

  // Dispatch: absent means prose, and an unknown value must never select formula.
  assert.equal(systemPromptFor(undefined), PROSE_SYSTEM_PROMPT)
  assert.equal(systemPromptFor('prose'), PROSE_SYSTEM_PROMPT)
  assert.equal(systemPromptFor('formula'), FORMULA_SYSTEM_PROMPT)
  assert.equal(systemPromptFor('v2'), PROSE_SYSTEM_PROMPT)
})

test('the optimise route keeps a known style and silently drops an unknown one', () => {
  assert.equal(parseOptimize({ prompt: 'x', editing: false, style: 'formula' }).style, 'formula')
  assert.equal(parseOptimize({ prompt: 'x', editing: false, style: 'prose' }).style, 'prose')
  assert.equal(parseOptimize({ prompt: 'x', editing: false, style: 'v2' }).style, undefined)
  assert.equal(parseOptimize({ prompt: 'x', editing: false }).style, undefined)
  // A non-string style (an older panel sending a boolean) must not crash.
  assert.equal(parseOptimize({ prompt: 'x', editing: false, style: true }).style, undefined)
})

test('conversation history is bounded and labelled by role', () => {
  const context = Array.from({ length: 10 }, (unused, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `第${String(index)}句`,
  }))
  const text = buildOptimizeUserText({ prompt: 'x', editing: false, context })
  assert.match(text, /最近对话/)
  // The tail is kept, the head is dropped: recent turns carry the subject.
  assert.match(text, /第9句/)
  assert.ok(!text.includes('第0句'), 'only the most recent turns may be forwarded')
  assert.match(text, /用户：第8句/)
  assert.match(text, /助手：第9句/)
})

test('a bare answer is the prompt, and a 注 line becomes the note', () => {
  assert.deepEqual(splitOptimizerAnswer('一只橘猫坐在窗台上，午后侧光。'), {
    prompt: '一只橘猫坐在窗台上，午后侧光。',
  })
  assert.deepEqual(splitOptimizerAnswer('一只橘猫。\n注：补全了光线描述'), {
    prompt: '一只橘猫。',
    note: '补全了光线描述',
  })
  // Full-width colon, which the model uses about as often as the ASCII one.
  assert.deepEqual(splitOptimizerAnswer('一只橘猫。\n注：补全了光线'), {
    prompt: '一只橘猫。',
    note: '补全了光线',
  })
  // A `注` on the *first* line is not a note — the prompt itself must survive.
  assert.deepEqual(splitOptimizerAnswer('注：这是一个测试'), { prompt: '注：这是一个测试' })
  // A note whose body is empty is dropped rather than rendered as "注：".
  assert.deepEqual(splitOptimizerAnswer('一只橘猫。\n注：'), { prompt: '一只橘猫。\n注：'.split('\n')[0] })
  assert.deepEqual(splitOptimizerAnswer('   '), { prompt: '' })
})

test('wrapping quotes are stripped only when they are the outer pair', () => {
  assert.equal(stripWrappingQuotes('"一只橘猫"'), '一只橘猫')
  assert.equal(stripWrappingQuotes('“一只橘猫”'), '一只橘猫')
  assert.equal(stripWrappingQuotes('「一只橘猫」'), '一只橘猫')
  // Quotes that close early are content, not wrapping — stripping them would
  // truncate a prompt that legitimately contains a quoted phrase.
  assert.equal(stripWrappingQuotes('"猫"和"狗"'), '"猫"和"狗"')
  assert.equal(stripWrappingQuotes('一只橘猫'), '一只橘猫')
  // Too short to be a pair.
  assert.equal(stripWrappingQuotes('""'), '""')
})

/** A context whose `get` serves exactly the services a test names. */
const ctxOf = (services) => ({ get: (name) => services[name] })

/** The smallest `llm` face that passes the shape check. */
const llmFace = (overrides = {}) => ({ listProviders: () => [], prepareCall: async () => ({}), ...overrides })

test('a host without the llm service reports llm-missing instead of throwing', async () => {
  // Every shape a context can take: no `get` at all, `get` returning nothing,
  // `get` returning something that is not an LLM, and `get` itself throwing.
  // All mean the same stage — and the stage is the point.
  for (const ctx of [
    {},
    { get: () => undefined },
    { get: () => null },
    { get: () => ({ stream: () => {} }) },
    { get: () => { throw new Error('service not mounted') } },
  ]) {
    assert.equal(llmOf(ctx), undefined)
    const resolution = await resolveOptimizerFor(ctx)
    assert.equal(resolution.ok, false)
    assert.equal(resolution.stage, 'llm-missing')
    assert.ok(resolution.detail.length > 0, 'the failure has to say something')
  }
})

test('agentDefaultModel wins over enumerating providers', async () => {
  // The conversation's own selection is the answer even when a second provider
  // would have enumerated fine: "seamless" means the model the chat is using.
  const ctx = ctxOf({
    agentDefaultModel: { currentSelection: () => ({ provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' }) },
    llm: llmFace({ listProviders: () => [{ name: 'somebody-else' }], listModels: async () => [{ id: 'other-model' }] }),
  })
  assert.deepEqual(await resolveOptimizerFor(ctx), {
    ok: true,
    provider: 'dsh-opencode-go',
    model: 'deepseek-v4.1-flash',
    via: 'agentDefaultModel',
  })
})

test('each resolution failure names its own stage, with the upstream words kept', async () => {
  // 1. `listProviders` throws.
  let resolution = await resolveOptimizerFor(ctxOf({
    llm: llmFace({ listProviders: () => { throw new Error('registry exploded') } }),
  }))
  assert.equal(resolution.stage, 'list-providers-failed')
  assert.match(resolution.detail, /registry exploded/)

  // 2. It returns nothing at all.
  resolution = await resolveOptimizerFor(ctxOf({ llm: llmFace({ listProviders: () => [] }) }))
  assert.equal(resolution.stage, 'list-providers-empty')

  // 3. Every provider fails to list models: each error is quoted, not merged.
  resolution = await resolveOptimizerFor(ctxOf({
    llm: llmFace({
      listProviders: () => [{ name: 'alpha' }, { id: 'beta' }],
      listModels: async () => { throw new Error('401 unauthorized') },
    }),
  }))
  assert.equal(resolution.stage, 'list-models-failed')
  assert.match(resolution.detail, /alpha: 401 unauthorized/)
  assert.match(resolution.detail, /beta: 401 unauthorized/)

  // 4. `listModels` absent — the typert remote façade only exposes listProviders.
  resolution = await resolveOptimizerFor(ctxOf({ llm: llmFace({ listProviders: () => [{ name: 'alpha' }] }) }))
  assert.equal(resolution.stage, 'list-models-failed')
  assert.match(resolution.detail, /listModels 不可用/)

  // 5. The old fallback still works when no default selection exists: one broken
  //    provider must not stop the search for a working one.
  resolution = await resolveOptimizerFor(ctxOf({
    llm: llmFace({
      listProviders: () => [{ name: 'broken' }, { id: 'second' }, { name: '' }],
      listModels: async (provider) => {
        if (provider === 'broken') throw new Error('nope')
        return [{ id: 'qwen-max' }]
      },
    }),
  }))
  assert.deepEqual(resolution, { ok: true, provider: 'second', model: 'qwen-max', via: 'listModels' })
})

// ---------------------------------------------------------------------------
// The built artifacts and the published surface.
// ---------------------------------------------------------------------------

test('the Studio routes are registered on the host, and the constants ship with them', () => {
  const host = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  // The routes are the whole host-side surface of the Studio; if one name
  // blurts, the panel 404s with no other symptom.
  const routes = [
    '/plugins/dsh-image-forge/studio/config',
    '/plugins/dsh-image-forge/studio/generate',
    '/plugins/dsh-image-forge/studio/optimize',
    '/plugins/dsh-image-forge/studio/boards',
    '/plugins/dsh-image-forge/studio/board',
    '/plugins/dsh-image-forge/studio/assets',
    '/plugins/dsh-image-forge/studio/import',
  ]
  for (const route of routes) {
    assert.ok(host.includes(route), `${route} must be present in the host bundle`)
  }
  // `dsh-llm` is reached only through a dynamic import: a static one would make
  // the whole plugin fail to load on a host that never installed it.
  assert.ok(host.includes('await import("@deepseek-ai/dsh-llm")'), 'the assembler must be loaded dynamically')
  assert.ok(!/^import [^;]*from "@deepseek-ai\/dsh-llm"/m.test(host), 'dsh-llm must not be statically imported')

  // And the panel half must carry the same paths, or it posts into the void.
  // `studio/boards` is host-only: the panel gets the board list inside the
  // capability snapshot, so it never calls that route itself.
  const clientRoutes = routes.filter((route) => !route.endsWith('/studio/boards'))
  const client = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
  for (const route of clientRoutes) {
    assert.ok(client.includes(route), `${route} must be present in the client bundle`)
  }
})

test('the workbench still ships in the client bundle, now as a main panel', () => {
  const client = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
  // The panel is no longer mounted from the settings section; its surface and
  // the seat that mounts it must still be in the bundle, or the sidebar row
  // would switch the main column to nothing.
  assert.match(client, /function StudioPanel\(\)/, 'the workbench component must stay in the bundle')
  assert.ok(client.includes('"图像工作台"'), 'the panel title must stay')
  assert.match(client, /icon: StudioPanelIcon/, 'the sidebar glyph must be handed to the seat')
  assert.match(client, /registerStudioPanel\(ctx, \{/, 'the panel seats must be wired into apply()')
})

test('the constants the panel and the host must agree on are shared, not restated', () => {
  // These are exported so the panel's limits come from one place; a mismatch
  // here is a form that submits a body the host refuses.
  assert.equal(STUDIO_MAX_COUNT, 4)
  assert.deepEqual([...STUDIO_RATIOS], ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'])
})

// ---------------------------------------------------------------------------
// Turbo: the distilled checkpoint is a different sampler graph, and its step
// default must never borrow the base checkpoint's 25.
// ---------------------------------------------------------------------------

test('the turbo schedule is the official one, and describes exactly its own step count', () => {
  // Copied verbatim from the official template's ManualSigmas node; changing it
  // silently would invalidate the "8 steps" contract the whole turbo path leans on.
  assert.equal(TURBO_SIGMAS, '1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0')
  // 9 entries = 8 intervals = 8 steps.
  assert.equal(TURBO_SIGMAS.split(',').length, TURBO_STEPS + 1)
  assert.equal(TURBO_STEPS, 8)
})

test('turbo steps never borrow the base checkpoint defaults', () => {
  // NB: this feeds the **legacy** `'turbo'` / `'base'` spellings, i.e. what an
  // old config document says — not what production hands the Studio, which is
  // always a canonical profile id (see the regression test at the bottom of this
  // section). It covers `resolveProfile`'s legacy mapping, nothing more.
  const base = { defaultSteps: 25, comfyuiSteps: 12, turboSteps: undefined, comfyModel: 'turbo' }
  // An omitted count means 8, NOT the 25/12 the base family would resolve to —
  // handing 25 steps to a checkpoint distilled for 8 makes the picture worse.
  assert.equal(resolveStudioSteps(base, undefined), 8)
  // The turbo override applies before the distilled default.
  assert.equal(resolveStudioSteps({ ...base, turboSteps: 6 }, undefined), 6)
  // An explicit request still wins, inside the shared clamp.
  assert.equal(resolveStudioSteps(base, 4), 4)
  assert.equal(resolveStudioSteps(base, 1000), 200)
  assert.equal(resolveStudioSteps(base, 23.6), 24)
  // And the base family keeps its own fallback unchanged.
  const notTurbo = { defaultSteps: 25, comfyuiSteps: 12, turboSteps: undefined, comfyModel: 'base' }
  assert.equal(resolveStudioSteps(notTurbo, undefined), 12)
  assert.equal(resolveStudioSteps({ ...notTurbo, comfyuiSteps: undefined }, undefined), 25)
})

test('turbo is a preference, not a requirement: only a turbo unet name matches', () => {
  assert.equal(turboUnetOf({ unet: 'qwen_image_2.1_turbo_int8_convrot.safetensors', clip: '', vae: '', clipType: '' }), 'qwen_image_2.1_turbo_int8_convrot.safetensors')
  assert.equal(turboUnetOf({ unet: 'qwen_image_2.1_int8_convrot.safetensors', clip: '', vae: '', clipType: '' }), undefined)
  // Renamed but keeping the marker still matches; the name is only ever an
  // example in error text.
  assert.equal(turboUnetOf({ unet: 'my-turbo-copy.safetensors', clip: '', vae: '', clipType: '' }), 'my-turbo-copy.safetensors')
  assert.equal(turboUnetOf({ unet: '', clip: '', vae: '', clipType: '' }), undefined)
})

test('the turbo graphs use the advanced sampler, and the edit graph is wired for references', async () => {
  const { editTurboWorkflow, QWEN_IMAGE_TURBO_WORKFLOW, QWEN_IMAGE_TURBO_EDIT_WORKFLOW } = await import('../testlib/comfyui.js')
  // The turbo skeleton drives SamplerCustomAdvanced, not KSampler — that
  // separation is the only way to hand it the manual sigma schedule.
  assert.equal(QWEN_IMAGE_TURBO_WORKFLOW['10'].class_type, 'SamplerCustomAdvanced')
  assert.equal(QWEN_IMAGE_TURBO_WORKFLOW['9'].class_type, 'ManualSigmas')
  assert.ok(!Object.values(QWEN_IMAGE_TURBO_WORKFLOW).some((n) => n.class_type === 'KSampler'))
  // And the ingredients are actually connected.
  assert.deepEqual(QWEN_IMAGE_TURBO_WORKFLOW['10'].inputs, {
    noise: ['6', 0], guider: ['7', 0], sampler: ['8', 0], sigmas: ['9', 0], latent_image: ['5', 0],
  })

  // The edit variant swaps the encode node and takes a reference slot per image.
  const graph = editTurboWorkflow(['ref-a.png', 'ref-b.png'])
  assert.equal(graph['4'].class_type, 'TextEncodeQwenImage21')
  assert.deepEqual(graph['4'].inputs['images.image_1'], ['13', 0])
  assert.deepEqual(graph['4'].inputs['images.image_2'], ['14', 0])
  assert.equal(graph['13'].class_type, 'LoadImage')
  assert.equal(graph['13'].inputs.image, 'ref-a.png')
  // The skeleton the references hang off is the turbo one, not the base one.
  assert.equal(graph['10'].class_type, 'SamplerCustomAdvanced')
  // Empty or over-long reference lists are refused before any upload happens.
  assert.throws(() => editTurboWorkflow([]), /至少一张|needs at least one/)
})

// ---------------------------------------------------------------------------
// Regression: the Studio used to compare `comfyModel` against the literal
// `'turbo'`, a value `resolveConfig` never hands it (it normalises to
// `qwen21-turbo`), so the turbo step branch was dead and `turboSteps` never
// applied. Everything below therefore starts from the *normalised* config value,
// exactly like production, instead of the legacy spelling.
// ---------------------------------------------------------------------------

/** What `resolveConfig` writes into `comfyModel` before anything downstream runs. */
const asConfigured = (raw) => resolveProfile(raw).id

/** The settled settings a production activation would hand the Studio. */
function configuredSettings(comfyModel, overrides = {}) {
  return studioSettingsOf({
    comfyEndpoint: 'http://127.0.0.1:8188',
    comfyPorts: '8188',
    comfyModelsDir: '/models',
    timeoutMs: 150_000,
    outputDir: '/out',
    defaultSteps: 25,
    comfyuiSteps: 12,
    comfyModel: asConfigured(comfyModel),
    mossSampling: 'comfy',
    turboSteps: undefined,
    ...overrides,
  })
}

const TURBO_MODELS = { unet: 'qwen_image_2.1_turbo_int8_convrot.safetensors', clip: 'qwen3vl_8b.safetensors', vae: 'qwen_image_2.1_vae_bf16.safetensors', clipType: 'qwen_image' }
const BASE_MODELS = { unet: 'qwen_image_2.1_int8_convrot.safetensors', clip: 'qwen3vl_8b.safetensors', vae: 'qwen_image_2.1_vae_bf16.safetensors', clipType: 'qwen_image' }
const MOSS_MODELS = { unet: 'moss_image_sft_int8_convrot.safetensors', clip: 'qwen3.5_9b_w4a8_gptq.safetensors', vae: 'flux2-vae_small.safetensors', clipType: 'moss_image' }

test('a canonical turbo id resolves the turbo step default, not the base one', () => {
  // Pin the normalisation this test depends on: `resolveConfig` stores the
  // canonical id, so `'turbo'` is a value the Studio never receives in production.
  assert.equal(asConfigured('turbo'), 'qwen21-turbo')
  assert.equal(asConfigured('base'), 'qwen21-base')

  const settings = configuredSettings('qwen21-turbo')
  assert.equal(settings.comfyModel, 'qwen21-turbo')
  // 8, not `comfyuiSteps` 12 and not `defaultSteps` 25 — the whole point of
  // `turboSteps` existing. On the pre-fix code this returned 12 (the base
  // fallback), because the branch compared against the literal `'turbo'`.
  assert.equal(resolveStudioSteps(settings, undefined), 8)
  // The configured override still wins over the distilled default.
  assert.equal(resolveStudioSteps(configuredSettings('qwen21-turbo', { turboSteps: 6 }), undefined), 6)
  // An explicit request still wins over both, inside the shared clamp.
  assert.equal(resolveStudioSteps(settings, 5), 5)
})

test('the turbo step default follows the profile that actually runs, not just the request', () => {
  const settings = configuredSettings('qwen21-turbo')
  // Turbo requested *and* a turbo checkpoint installed: the turbo graph runs, so
  // the turbo step default is right.
  const onTurbo = effectiveProfile(settings.comfyModel, TURBO_MODELS)
  assert.equal(onTurbo.variant, 'turbo')
  assert.equal(resolveStudioSteps(settings, undefined, onTurbo), 8)
  // Turbo requested but only base weights installed: the run degrades to the base
  // graph (same rule as `tools.ts`), so it must take the base default — handing a
  // base checkpoint the turbo 8 would be the mirror image of the bug.
  const degraded = effectiveProfile(settings.comfyModel, BASE_MODELS)
  assert.equal(degraded.variant, 'base')
  assert.equal(resolveStudioSteps(settings, undefined, degraded), 12)
})

test('a MOSS profile is never mistaken for turbo', () => {
  // `moss-sft` is a third variant, not a turbo in disguise: it runs a plain
  // KSampler at 25 steps, has no manual sigma schedule, and must keep the ordinary
  // `comfyuiSteps` / `defaultSteps` fallback.
  assert.equal(asConfigured('moss-sft'), 'moss-sft')
  assert.equal(resolveProfile('moss-sft').variant, 'sft')
  assert.equal(resolveProfile('moss-sft').steps.sigmas, undefined)

  const settings = configuredSettings('moss-sft')
  assert.equal(settings.comfyModel, 'moss-sft')
  assert.notEqual(resolveStudioSteps(settings, undefined), 8)
  assert.equal(resolveStudioSteps(settings, undefined), 12)
  assert.equal(resolveStudioSteps(configuredSettings('moss-sft', { comfyuiSteps: undefined }), undefined), 25)

  // And once the weights are known the effective profile is still MOSS, so the
  // step fallback stays the ordinary one.
  const effective = effectiveProfile(settings.comfyModel, MOSS_MODELS)
  assert.equal(effective.id, 'moss-sft')
  assert.equal(resolveStudioSteps(settings, undefined, effective), 12)
  // A `turboSteps` sitting in the config must not leak into a MOSS run.
  assert.equal(resolveStudioSteps(configuredSettings('moss-sft', { turboSteps: 6 }), undefined), 12)
})

// ---------------------------------------------------------------------------
// MOSS-Image's two sampling registers: a table, not an `if` in the adapter.
//
// Both registers are real and both are documented — the ComfyUI template's
// faster settings (which the verified sample ran) and OpenMOSS's own card. The
// tests below pin each pair verbatim, prove the register selects a *whole* pair
// rather than one field, and prove neither Qwen profile can be moved by it.
// ---------------------------------------------------------------------------

test('the MOSS sampling registers carry the two published pairs, verbatim', () => {
  const moss = MODEL_PROFILES['moss-sft']
  assert.deepEqual([...MOSS_SAMPLING_PRESETS], ['comfy', 'official'])
  assert.equal(DEFAULT_MOSS_SAMPLING, 'comfy')

  // Register 1 — the ComfyUI template (`image_moss_image_t2i.json`, which notes
  // it uses kijai's faster settings): 25 steps / CFG 2.5 / er_sde / simple. It is
  // also the profile's own pair, so the default run cannot drift from it.
  assert.deepEqual(moss.samplingPresets.comfy.sampler, {
    node: 'KSampler',
    name: 'er_sde',
    scheduler: 'simple',
    cfg: 2.5,
  })
  assert.equal(moss.samplingPresets.comfy.steps.default, 25)
  assert.equal(moss.sampler, moss.samplingPresets.comfy.sampler, 'the profile pair must be the default register')
  assert.equal(moss.steps, moss.samplingPresets.comfy.steps)
  assert.equal(moss.defaultPreset, 'comfy')

  // Register 2 — OpenMOSS's own card: 50 steps / CFG 3 / euler / simple. The
  // scheduler is `simple` in both registers; that is not part of the difference.
  assert.deepEqual(moss.samplingPresets.official.sampler, {
    node: 'KSampler',
    name: 'euler',
    scheduler: 'simple',
    cfg: 3,
  })
  assert.equal(moss.samplingPresets.official.steps.default, 50)

  // Neither register carries a manual sigma schedule: MOSS runs the model's own
  // default shift of 5, which is why there is no `ModelSampling*` node either.
  assert.equal(moss.steps.sigmas, undefined)
  assert.equal(moss.samplingPresets.official.steps.sigmas, undefined)
})

test('the register selects a whole pair, steps and sampler together', () => {
  const moss = MODEL_PROFILES['moss-sft']
  const comfy = resolveSampling(moss, 'comfy')
  assert.equal(comfy.preset, 'comfy')
  assert.equal(comfy.sampler.cfg, 2.5)
  assert.equal(comfy.sampler.name, 'er_sde')
  assert.equal(comfy.steps.default, 25)

  const official = resolveSampling(moss, 'official')
  assert.equal(official.preset, 'official')
  assert.equal(official.sampler.name, 'euler')
  assert.equal(official.sampler.cfg, 3)
  assert.equal(official.steps.default, 50)

  // An unknown value falls back to the profile's own pair: a stale settings
  // document must never produce a graph with an undefined sampler.
  const unknown = resolveSampling(moss, 'karras')
  assert.equal(unknown.preset, undefined)
  assert.equal(unknown.sampler, moss.sampler)
  assert.equal(unknown.steps, moss.steps)
})

test('the sampling register never moves either Qwen profile', () => {
  for (const id of ['qwen21-base', 'qwen21-turbo']) {
    const profile = MODEL_PROFILES[id]
    assert.equal(profile.samplingPresets, undefined, `${id} must not publish a register table`)
    for (const preset of ['comfy', 'official', undefined]) {
      const sampling = resolveSampling(profile, preset)
      assert.equal(sampling.sampler, profile.sampler, `${id} sampler moved under ${String(preset)}`)
      assert.equal(sampling.steps, profile.steps, `${id} steps moved under ${String(preset)}`)
      assert.equal(sampling.preset, undefined)
    }
    // ...and no register contributes a step count either, so the shared
    // `comfyuiSteps` → `defaultSteps` chain is what still decides.
    assert.equal(presetSteps(profile, 'official'), undefined)
    assert.equal(presetSteps(profile, 'comfy'), undefined)
  }
})

test('a published register owns its step count, the default one included', () => {
  const moss = MODEL_PROFILES['moss-sft']
  // MOSS's counts are model properties, so the Qwen-tuned shared `defaultSteps`
  // never moves MOSS off its template's 25 — the register always answers.
  assert.equal(presetSteps(moss, 'comfy'), 25)
  assert.equal(presetSteps(moss, undefined), undefined)
  assert.equal(presetSteps(moss, 'official'), 50)
  assert.equal(presetSteps(moss, 'karras'), undefined)
})

test('the Studio step chain honours the register and still lets comfyuiSteps win', () => {
  const official = configuredSettings('moss-sft', { mossSampling: 'official', comfyuiSteps: undefined })
  // No explicit request and no `comfyuiSteps`: the selected register decides.
  assert.equal(resolveStudioSteps(official, undefined), 50)
  // `comfyuiSteps` still overrides the register in the official mode, exactly as
  // it overrides the shared default in the comfy one.
  assert.equal(
    resolveStudioSteps(configuredSettings('moss-sft', { mossSampling: 'official', comfyuiSteps: 30 }), undefined),
    30,
  )
  // An explicit request wins over everything, inside the shared clamp.
  assert.equal(resolveStudioSteps(official, 12), 12)
  assert.equal(resolveStudioSteps(official, 10_000), 200)
  // The comfy register owns 25 even when `defaultSteps` (Qwen's default) was raised:
  // MOSS never inherits a step count tuned for the other family.
  assert.equal(
    resolveStudioSteps(
      configuredSettings('moss-sft', { mossSampling: 'comfy', comfyuiSteps: undefined, defaultSteps: 40 }),
      undefined,
    ),
    25,
  )
  // And neither Qwen profile is affected by the setting at all.
  assert.equal(
    resolveStudioSteps(configuredSettings('qwen21-base', { mossSampling: 'official', comfyuiSteps: undefined }), undefined),
    25,
  )
})

// ---------------------------------------------------------------------------
// T18: live progress in the workbench.
//
// `lib/client.js` cannot be imported here: its single bare dependency,
// `react`, is resolved by the web client and is deliberately not a dependency
// of this package (see the note in `settings.test.mjs`). So this section runs
// the real built bundle the way the web loader does — evaluate it against a
// fake `window.__ModuleLoader__`, hand the factory a minimal React (element
// descriptors plus a hook runtime), and take the workbench component back out
// of the slot registry through `apply`. The component is then mounted against
// stubbed `fetch` / `EventSource`: no DOM, no browser, but the real
// event → state → rendered-text path.
//
// What this cannot prove: the browser's own EventSource retry cadence, actual
// paint, or a run against a live ComfyUI. Those stay unverified in the report.
// ---------------------------------------------------------------------------

/** The built browser half, read as text for the bundle assertions below. */
const CLIENT_SOURCE = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

/** The capability snapshot the fake host serves to a mounting panel. */
const HARNESS_CONFIG = {
  ready: true,
  endpoint: 'http://127.0.0.1:8188',
  models: { unet: 'qwen.safetensors', clip: 'clip.safetensors', vae: 'vae.safetensors' },
  defaultSteps: 40,
  outputDir: 'C:/out',
  sizes: [{ ratio: '1:1', width: 1024, height: 1024 }],
  optimizeAvailable: false,
  boards: [],
  activeBoard: null,
}

/**
 * A board with three 1:1 nodes, for the interaction section.
 *
 * The x positions are far enough apart that a marquee can sweep exactly one node:
 * a 1024×1024 picture is a 200×240 node (`nodeDisplaySize`), so these sit at
 * 0–200, 600–800 and 1200–1400 world units.
 */
const HARNESS_BOARD = {
  id: 'cbrdharness',
  name: '交互测试板',
  camera: { x: 0, y: 0, zoom: 1 },
  items: ['iaaa1', 'ibbb2', 'iccc3'].map((id, index) => ({
    id,
    path: `C:/out/${id}.png`,
    markdownPath: `C:/out/${id}.png`,
    width: 1024,
    height: 1024,
    bytes: 1024,
    mediaType: 'image/png',
    batchId: 'bharness',
    prompt: '一只橘猫坐在窗台上',
    ratio: '1:1',
    steps: 8,
    seed: index + 1,
    mode: 'generate',
    backend: 'studio',
    parents: [],
    x: index * 600,
    y: 0,
  })),
}

/** A fetch-shaped response; the panel only ever asks for `json()`. */
function fakeResponse(payload, status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

/** Collect text out of a fake element tree (strings and numbers only). */
function fakeText(node) {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) {
    let text = ''
    for (const child of node) text += fakeText(child)
    return text
  }
  if (node === null || node === undefined || typeof node !== 'object') return ''
  let text = ''
  for (const child of node.children) text += fakeText(child)
  return text
}

/** Depth-first visit of every fake element (an object with a string `type`). */
function fakeVisit(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) fakeVisit(child, visit)
    return
  }
  if (typeof node.type !== 'string') return
  visit(node)
  for (const child of node.children) fakeVisit(child, visit)
}

/** The first element carrying exactly `className`, or `undefined`. */
function fakeElementWithClass(tree, className) {
  let found
  fakeVisit(tree, (entry) => {
    if (found === undefined && entry.props.className === className) found = entry
  })
  return found
}

/** Same deps, element-wise — React's own comparison, close enough here. */
function sameDeps(left, right) {
  if (left === undefined || right === undefined) return false
  if (left.length !== right.length) return false
  return left.every((value, index) => Object.is(value, right[index]))
}

/** Flatten `createElement` children the way React does, dropping holes. */
function collectChildren(child, out) {
  if (child === null || child === undefined || child === true || child === false) return
  if (Array.isArray(child)) {
    for (const entry of child) collectChildren(entry, out)
    return
  }
  out.push(child)
}

/**
 * A hook runtime just large enough for `StudioPanel`.
 *
 * Call order is identity, exactly like React; effects are queued after render
 * and run by the caller, so they observe the committed tree. `settle` drives
 * render → effects → microtasks until quiet, which is what lets the mount
 * effect's two awaited fetches finish.
 */
function createHookRuntime(active) {
  const hooks = []
  let cursor = 0
  let dirty = false
  let pending = []
  let rendered
  let panel

  const runtime = {
    useState(initial) {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) {
        hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const slot = hooks[index]
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        dirty = true
      }]
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) hooks[index] = { current: initial }
      return hooks[index]
    },
    useMemo(factory, deps) {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) hooks[index] = { value: factory(), deps }
      else if (!sameDeps(hooks[index].deps, deps)) {
        hooks[index].value = factory()
        hooks[index].deps = deps
      }
      return hooks[index].value
    },
    useCallback(callback, deps) {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) hooks[index] = { value: callback, deps }
      else if (!sameDeps(hooks[index].deps, deps)) {
        hooks[index].value = callback
        hooks[index].deps = deps
      }
      return hooks[index].value
    },
    useEffect(effect, deps) {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) hooks[index] = { deps: undefined, cleanup: undefined }
      const slot = hooks[index]
      const changed = !sameDeps(slot.deps, deps)
      slot.deps = deps
      if (changed) pending.push({ index, effect })
    },
  }
  active.runtime = runtime

  function renderOnce() {
    cursor = 0
    pending = []
    dirty = false
    rendered = panel({})
  }

  return {
    render() {
      renderOnce()
    },
    get tree() {
      return rendered
    },
    get dirty() {
      return dirty
    },
    get pendingEffects() {
      return pending.length
    },
    mount(nextPanel) {
      panel = nextPanel
      renderOnce()
    },
    takeEffects() {
      const effects = pending
      pending = []
      return effects
    },
    runEffect(entry) {
      const slot = hooks[entry.index]
      if (typeof slot.cleanup === 'function') slot.cleanup()
      const cleanup = entry.effect()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    },
    unmount() {
      for (const slot of hooks) {
        if (slot !== undefined && typeof slot.cleanup === 'function') slot.cleanup()
      }
    },
  }
}

/** Run render/effects/microtasks until the panel is quiet. */
async function settle(panel) {
  for (let round = 0; round < 250; round += 1) {
    if (panel.dirty) {
      panel.render()
      continue
    }
    const effects = panel.takeEffects()
    if (effects.length > 0) {
      for (const entry of effects) panel.runEffect(entry)
      continue
    }
    if (panel.dirty) continue
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!panel.dirty && panel.pendingEffects === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (!panel.dirty && panel.pendingEffects === 0) return
    }
  }
  throw new Error('the workbench panel did not settle after 250 rounds')
}

/** Load the built client bundle the way `window.__ModuleLoader__` does. */
let loadedClient
/**
 * What the panel's `window.confirm` answers.
 *
 * The bundle is evaluated with a *parameter* named `window` (that is how the real
 * loader shapes it), so the panel's `window.confirm` resolves to this fake window,
 * not to `globalThis`. Tests flip this before a click that must be cancelled.
 */
let harnessConfirm = () => true
function clientEntry() {
  if (loadedClient !== undefined) return loadedClient
  const loaded = []
  const fakeWindow = {
    __ModuleLoader__: {
      load(spec) {
        loaded.push(spec)
      },
    },
    confirm: (message) => harnessConfirm(message),
  }
  // The bundle is plain CJS wrapped by the loader; it is evaluated, not
  // imported, because `require("react")` is what the web client resolves.
  new Function('window', CLIENT_SOURCE)(fakeWindow)
  assert.equal(loaded.length, 1, 'the client bundle must register exactly one factory')
  assert.equal(loaded[0].id, 'dsh-image-forge')
  const active = { runtime: undefined }
  const react = {
    createElement(type, props, ...children) {
      const flat = []
      for (const child of children) collectChildren(child, flat)
      return { type, props: props === null || props === undefined ? {} : props, children: flat }
    },
    useState(initial) {
      return active.runtime.useState(initial)
    },
    useRef(initial) {
      return active.runtime.useRef(initial)
    },
    useMemo(factory, deps) {
      return active.runtime.useMemo(factory, deps)
    },
    useCallback(callback, deps) {
      return active.runtime.useCallback(callback, deps)
    },
    useEffect(effect, deps) {
      active.runtime.useEffect(effect, deps)
    },
  }
  const exports = loaded[0].factory((name) => {
    if (name === 'react') return react
    throw new Error('lib/client.js requested an unexpected module: ' + name)
  })
  loadedClient = { exports, active }
  return loadedClient
}

/** Run `apply` and return the component seated in the `main` keyed slot. */
function studioPanelComponent(exports) {
  const events = []
  const slots = {
    inject(name, register) {
      events.push({ kind: 'inject', name, register })
    },
    register(options, component) {
      events.push({ kind: 'register', options, component })
      return () => {}
    },
  }
  exports.apply({ slots, get: () => undefined })
  // Declaring a slot is what runs its `inject` body, exactly like the shell.
  for (const event of events) {
    if (event.kind === 'inject') event.register()
  }
  const seat = events.find((event) => event.kind === 'register' && event.options.name === 'main')
  assert.ok(seat, 'the workbench must be seated in the main keyed slot')
  return seat.component
}

/**
 * Stub the two globals the panel reaches for: `fetch` (capability snapshot
 * only; the board list is empty in this harness) and `EventSource`.
 */
function installFakeNetwork(options) {
  const previousFetch = globalThis.fetch
  const previousEventSource = globalThis.EventSource
  const calls = []
  const sources = []
  // C09: a stubbed board (and a config that names it as the active one) is what
  // lets the interaction section mount a canvas with nodes on it. Without one the
  // harness serves exactly what it always did: an empty library and a 404.
  const board = options === undefined ? undefined : options.board
  // C11: generation is stubbed per test — the panel's POST is the conversion
  // authority, so a test owns when (and whether) the response arrives.
  const generate = options === undefined ? undefined : options.generate
  const baseConfig = board === undefined
    ? HARNESS_CONFIG
    : {
      ...HARNESS_CONFIG,
      boards: [{
        id: board.id,
        name: board.name,
        itemCount: board.items.length,
        createdAt: '2026-11-17T00:00:00.000Z',
        updatedAt: '2026-11-17T00:00:00.000Z',
      }],
      activeBoard: board.id,
    }
  // T22: tests need snapshots that are *not* ready (stepper failure states).
  const overrides = options === undefined ? undefined : options.configOverrides
  const config = overrides === undefined ? baseConfig : { ...baseConfig, ...overrides }
  // P2: the environment line is its own route. A test owns the answer, so the
  // start/stop/owned cases are deterministic; the default is a plain read.
  const environment = options === undefined ? undefined : options.environment
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({
      url,
      method: init === undefined || init.method === undefined ? 'GET' : init.method,
      body: init === undefined ? undefined : init.body,
    })
    if (url.indexOf(STUDIO_CONFIG_ROUTE) === 0) return fakeResponse(config, 200)
    if (url.indexOf(STUDIO_ENVIRONMENT_ROUTE) === 0) {
      let body = {}
      try {
        body = init !== undefined && typeof init.body === 'string' ? JSON.parse(init.body) : {}
      } catch {
        body = {}
      }
      const answer = environment === undefined
        ? { environment: { state: config.ready === true ? 'ready' : 'not-running', owned: false } }
        : environment(body)
      return fakeResponse(answer, 200)
    }
    if (url.indexOf(STUDIO_GENERATE_ROUTE) === 0) {
      if (generate === undefined) return fakeResponse({ error: 'no generate stub' }, 500)
      return generate(init === undefined ? {} : init)
    }
    if (url.indexOf(STUDIO_BOARD_ROUTE) === 0) {
      // A board mutation is accepted: the wiring section asserts the canvas, not
      // the store. C14's two node writers answer even without a fixture board —
      // that is how the empty-library "a failure creates the board" path is
      // exercised — and echo the item they would have stored, so the panel can
      // adopt the id and later remove the right board entry.
      if (init !== undefined && init.method === 'POST') {
        let action
        try {
          action = JSON.parse(init.body)
        } catch {
          action = undefined
        }
        if (action !== undefined && (action.action === 'save-task' || action.action === 'save-layout-node')) {
          const kind = action.action === 'save-task' ? 'task' : 'layout'
          const id = typeof action.item === 'string' && action.item.length > 0
            ? action.item
            : kind === 'task' ? 'itask1' : 'ilayout1'
          return fakeResponse({
            ok: true,
            item: {
              id,
              kind,
              x: typeof action.x === 'number' ? action.x : 0,
              y: typeof action.y === 'number' ? action.y : 0,
              parents: Array.isArray(action.parents) ? action.parents : [],
              ...(kind === 'task' ? { task: action.task } : { draft: action.draft, w: action.w, h: action.h }),
            },
            board: {
              id: board === undefined ? 'cbrdauto' : board.id,
              name: board === undefined ? '自动画板' : board.name,
              itemCount: board === undefined ? 1 : board.items.length,
              cover: null,
              createdAt: '2026-11-17T00:00:00.000Z',
              updatedAt: '2026-11-17T00:00:00.000Z',
              sessionId: null,
            },
          }, 200)
        }
        return fakeResponse({ ok: true }, 200)
      }
      if (board === undefined) return fakeResponse({ error: 'no board in this harness' }, 404)
      return fakeResponse(board, 200)
    }
    return fakeResponse({ error: 'unstubbed fetch: ' + url }, 500)
  }
  class FakeEventSource {
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.closed = false
      this.listeners = new Map()
      sources.push(this)
    }
    addEventListener(type, listener) {
      const list = this.listeners.get(type) === undefined ? [] : this.listeners.get(type)
      list.push(listener)
      this.listeners.set(type, list)
    }
    close() {
      this.closed = true
      this.readyState = 2
    }
    emit(type, payload) {
      if (this.closed) return
      const list = this.listeners.get(type)
      if (list === undefined) return
      for (const listener of list) {
        if (type === 'message') listener({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) })
        else listener({ type })
      }
    }
  }
  if (options !== undefined && options.eventSource === false) globalThis.EventSource = undefined
  else globalThis.EventSource = FakeEventSource
  return {
    calls,
    sources,
    /** The one stream the mounted panel should have opened. */
    open() {
      assert.equal(sources.length, 1, 'the panel must open exactly one SSE stream')
      return sources[0]
    },
    restore() {
      globalThis.fetch = previousFetch
      if (previousEventSource === undefined) delete globalThis.EventSource
      else globalThis.EventSource = previousEventSource
    },
  }
}

/** The rendered live-progress line: phase, bridge state and its text. */
function progressView(panel) {
  const element = fakeElementWithClass(panel.tree, 'dsh-forge-progress')
  assert.ok(element !== undefined, 'the panel must render a live-progress line')
  return {
    phase: element.props['data-phase'],
    bridge: element.props['data-bridge'],
    text: fakeText(element),
  }
}

/** Width of the rendered progress bar, e.g. `34%`. */
function progressFillWidth(panel) {
  const fill = fakeElementWithClass(panel.tree, 'dsh-forge-progress-fill')
  return fill === undefined ? undefined : fill.props.style.width
}

/** Mount a fresh workbench against a fresh network stub. */
async function mountWorkbench(networkOptions) {
  const harness = clientEntry()
  const network = installFakeNetwork(networkOptions)
  const panel = createHookRuntime(harness.active)
  panel.mount(studioPanelComponent(harness.exports))
  await settle(panel)
  return { network, panel }
}

// ---------------------------------------------------------------------------
// The bundle contract: subscribe same-origin, never open ComfyUI's socket.
// ---------------------------------------------------------------------------

test('the workbench streams from the plugin route and never opens ComfyUI itself', () => {
  assert.ok(CLIENT_SOURCE.includes(STUDIO_EVENTS_ROUTE), 'the same-origin SSE route must be in the client bundle')
  assert.ok(CLIENT_SOURCE.includes('new EventSource(STUDIO_EVENTS_ROUTE)'), 'the panel must subscribe with EventSource')
  assert.ok(CLIENT_SOURCE.includes('实时进度已连接'), 'the live-progress copy must ship')
  assert.ok(!CLIENT_SOURCE.includes('new WebSocket('), 'the browser must not open a WebSocket')
  assert.ok(!CLIENT_SOURCE.includes('ws://'), 'the browser bundle must not carry a ws:// URL')
  assert.ok(!CLIENT_SOURCE.includes('/ws?clientId='), 'the browser must not know ComfyUI socket ids')
})

// ---------------------------------------------------------------------------
// The state sequence: queue → start → progress → done, asserted on the
// rendered text and on the element attributes the CSS/tests can address.
// ---------------------------------------------------------------------------

test('queue, start, 17/50 progress and done drive the rendered progress line', async () => {
  const { network, panel } = await mountWorkbench()
  try {
    const source = network.open()
    assert.equal(source.url, STUDIO_EVENTS_ROUTE)

    const phases = []
    const record = () => {
      const view = progressView(panel)
      phases.push(view.phase)
      return view
    }

    const idle = record()
    assert.equal(idle.phase, 'idle')
    assert.equal(idle.bridge, 'connecting')
    assert.ok(idle.text.includes('等待生成'))
    assert.ok(idle.text.includes('实时进度连接中'))

    source.emit('message', { type: 'state', state: 'connected', endpoint: 'http://127.0.0.1:8188' })
    await settle(panel)
    assert.equal(record().bridge, 'connected')
    assert.ok(progressView(panel).text.includes('实时进度已连接 · http://127.0.0.1:8188'))

    source.emit('message', { type: 'queue', remaining: 3 })
    await settle(panel)
    assert.equal(record().phase, 'queued')
    assert.ok(progressView(panel).text.includes('排队中 · 前面还有 3 个任务'))

    source.emit('message', { type: 'start', promptId: 'prompt-1' })
    await settle(panel)
    assert.equal(record().phase, 'running')
    assert.ok(progressView(panel).text.includes('生成中…（等待第一步）'))
    assert.equal(progressFillWidth(panel), '0%')

    source.emit('message', { type: 'progress', promptId: 'prompt-1', value: 17, max: 50, percent: 34, label: '17/50' })
    await settle(panel)
    assert.equal(record().phase, 'running')
    assert.ok(progressView(panel).text.includes('第 17/50 步'))
    assert.equal(progressFillWidth(panel), '34%')

    source.emit('message', { type: 'progress', promptId: 'prompt-1', value: 25, max: 50, percent: 50, label: '25/50' })
    await settle(panel)
    assert.ok(record().text.includes('第 25/50 步'))
    assert.equal(progressFillWidth(panel), '50%')

    source.emit('message', { type: 'done', promptId: 'prompt-1' })
    await settle(panel)
    assert.equal(record().phase, 'done')
    assert.ok(progressView(panel).text.includes('本次生成完成（25/50）'))
    assert.equal(progressFillWidth(panel), '100%')

    // ComfyUI broadcasts the queue on every change, including after this run
    // ends. That must not turn a finished run back into "queued".
    source.emit('message', { type: 'queue', remaining: 0 })
    await settle(panel)
    assert.equal(record().phase, 'done')
    assert.equal(progressView(panel).phase, 'done')

    assert.deepEqual(phases, ['idle', 'idle', 'queued', 'running', 'running', 'running', 'done', 'done'])
  } finally {
    network.restore()
  }
})

// ---------------------------------------------------------------------------
// Failures and a stopped ComfyUI: visible, friendly, never a hang.
// ---------------------------------------------------------------------------

test('failures, interruption and a stopped ComfyUI stay visible and friendly', async () => {
  const { network, panel } = await mountWorkbench()
  try {
    const source = network.open()
    source.emit('message', { type: 'state', state: 'connected', endpoint: 'http://127.0.0.1:8188' })
    await settle(panel)

    source.emit('message', { type: 'error', promptId: 'prompt-2', node: '5', nodeType: 'KSampler', message: 'CUDA out of memory' })
    await settle(panel)
    const failed = progressView(panel)
    assert.equal(failed.phase, 'error')
    assert.ok(failed.text.includes('生成失败：CUDA out of memory'))

    source.emit('message', { type: 'interrupted', promptId: 'prompt-2' })
    await settle(panel)
    assert.equal(progressView(panel).phase, 'interrupted')
    assert.ok(progressView(panel).text.includes('生成已中断'))

    // ComfyUI goes away: the bridge says why, and that HTTP generation still
    // works. The run's own phase is untouched.
    source.emit('message', { type: 'state', state: 'disconnected', reason: 'ComfyUI 的 /ws 连接已断开' })
    await settle(panel)
    const broken = progressView(panel)
    assert.equal(broken.bridge, 'disconnected')
    assert.ok(broken.text.includes('实时进度断开：ComfyUI 的 /ws 连接已断开'))
    assert.ok(broken.text.includes('出图仍会走 HTTP'))
    assert.equal(broken.phase, 'interrupted')

    // The host's own stream drops: EventSource retries by itself, and the
    // panel says "reconnecting" instead of freezing on the last step.
    source.emit('error')
    await settle(panel)
    assert.equal(progressView(panel).bridge, 'reconnecting')
    assert.ok(progressView(panel).text.includes('正在重连'))

    // A later state frame clears it: the message is not sticky.
    source.emit('message', { type: 'state', state: 'connected', endpoint: 'http://127.0.0.1:8188' })
    await settle(panel)
    assert.equal(progressView(panel).bridge, 'connected')
  } finally {
    network.restore()
  }
})

test('a malformed or unknown frame is dropped, not allowed to break the panel', async () => {
  const { network, panel } = await mountWorkbench()
  try {
    const source = network.open()
    source.emit('message', 'not json at all')
    source.emit('message', '{"type":42}')
    source.emit('message', { type: 'cached', promptId: 'prompt-3', nodes: ['1'] })
    source.emit('message', { type: 'cam.monitor', data: { cpu: 0 } })
    await settle(panel)
    assert.equal(progressView(panel).phase, 'idle')

    source.emit('message', { type: 'progress', promptId: 'prompt-3', value: 2, max: 4, percent: 50, label: '2/4' })
    await settle(panel)
    assert.ok(progressView(panel).text.includes('第 2/4 步'))
  } finally {
    network.restore()
  }
})

// ---------------------------------------------------------------------------
// Degraded hosts: no EventSource still renders; leaving the panel cleans up.
// ---------------------------------------------------------------------------

test('a host without EventSource shows the reason and keeps working', async () => {
  const { network, panel } = await mountWorkbench({ eventSource: false })
  try {
    const view = progressView(panel)
    assert.equal(view.bridge, 'disconnected')
    assert.ok(view.text.includes('实时进度断开：当前环境不支持 EventSource'))
    assert.ok(view.text.includes('出图仍会走 HTTP'))
    assert.equal(network.sources.length, 0)
  } finally {
    network.restore()
  }
})

test('unmounting the panel closes the stream and late frames do nothing', async () => {
  const { network, panel } = await mountWorkbench()
  try {
    const source = network.open()
    source.emit('message', { type: 'start', promptId: 'prompt-4' })
    await settle(panel)
    assert.equal(progressView(panel).phase, 'running')

    panel.unmount()
    assert.equal(source.closed, true, 'the panel must close its SSE stream on unmount')
    assert.equal(network.sources.length, 1)
    assert.doesNotThrow(() => source.emit('message', { type: 'progress', promptId: 'prompt-4', value: 1, max: 2, percent: 50, label: '1/2' }))
  } finally {
    network.restore()
  }
})

// ---------------------------------------------------------------------------
// C09: canvas interactions — selection, marquee, keys, undo, menus.
//
// The T18 harness below drives the *real* bundle: the handlers a pointer or a key
// would call are called directly, so selection state, the marquee's screen→world
// arithmetic, the §6.3 dispatch, the undo stack's effect on the canvas and the
// §6.4 menus are all executed rather than grepped. Pointer capture, paint and the
// feel of a drag stay manual spot checks (§14.5) — no DOM, no browser here.
// ---------------------------------------------------------------------------

/** The canvas element the interaction handlers are attached to. */
function canvasElement(panel) {
  let found
  fakeVisit(panel.tree, (entry) => {
    if (found !== undefined) return
    if (typeof entry.props.className !== 'string') return
    // `dsh-forge-canvas` gains `is-pan` while Space is held.
    if (entry.props.className.split(' ')[0] === 'dsh-forge-canvas') found = entry
  })
  assert.ok(found !== undefined, 'the panel must render the canvas')
  return found
}

/** Every rendered node, in render order (`dsh-forge-node`, not its children). */
function nodeElements(panel) {
  const nodes = []
  fakeVisit(panel.tree, (entry) => {
    if (typeof entry.props.className !== 'string') return
    if (entry.props.className.split(' ')[0] === 'dsh-forge-node') nodes.push(entry)
  })
  return nodes
}

/** Board-route POST bodies this panel sent, parsed (C14 persistence checks). */
function boardMutations(network) {
  return network.calls
    .filter((call) => call.method === 'POST' && call.url.indexOf(STUDIO_BOARD_ROUTE) === 0 && typeof call.body === 'string')
    .map((call) => JSON.parse(call.body))
}

/** Every rendered hint/note line, joined — the panel's user-facing copy. */
function noteText(panel) {
  const notes = []
  fakeVisit(panel.tree, (entry) => {
    if (typeof entry.props.className === 'string' && entry.props.className.split(' ')[0] === 'dsh-forge-studio-hint') {
      notes.push(fakeText(entry))
    }
  })
  return notes.join('\n')
}
/** The ids of the nodes painted as selected. */
function selectedIds(panel) {
  return nodeElements(panel)
    .filter((entry) => entry.props.className.split(' ').includes('is-selected'))
    .map((entry) => entry.props['data-node-id'])
}

/** Shaped like the pointer events the canvas reads. */
function pointerEvent(options = {}) {
  const box = { left: 0, top: 0, width: 800, height: 600 }
  return {
    button: 0,
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault() {},
    stopPropagation() {},
    ...options,
    currentTarget: {
      focus() {},
      setPointerCapture() {},
      getBoundingClientRect: () => box,
    },
    target: options.target === undefined ? { closest: () => null } : options.target,
  }
}

/** Shaped like the keyboard events the canvas reads. */
function keyEvent(key, modifiers = {}, targetFlags = {}) {
  const event = {
    key,
    prevented: false,
    ctrlKey: modifiers.ctrl === true,
    metaKey: modifiers.meta === true,
    shiftKey: modifiers.shift === true,
    target: {
      tagName: targetFlags.tagName ?? 'DIV',
      isContentEditable: targetFlags.contentEditable === true,
      closest: () => null,
    },
    preventDefault() { event.prevented = true },
  }
  return event
}

/** The first button whose text is exactly `text`. */
function buttonWithText(panel, text) {
  let found
  fakeVisit(panel.tree, (entry) => {
    if (found !== undefined || entry.type !== 'button') return
    if (fakeText(entry) === text) found = entry
  })
  return found
}

/** The open context menu's entries, or `undefined` when no menu is open. */function menuEntries(panel) {
  const menu = fakeElementWithClass(panel.tree, 'dsh-forge-context')
  if (menu === undefined) return undefined
  const entries = []
  fakeVisit(menu, (entry) => {
    if (typeof entry.props.className !== 'string') return
    if (entry.props.className.split(' ')[0] === 'dsh-forge-context-item') entries.push(entry)
  })
  return entries
}

/** Mount the workbench with the three-node board, and give Node a rAF. */
async function mountCanvasWorkbench() {
  // §10.3 coalesces pointer moves into one animation frame; Node has none, so the
  // test frames immediately. This is the only browser API the wiring needs here.
  const requestFrame = globalThis.requestAnimationFrame
  const cancelFrame = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1 }
  globalThis.cancelAnimationFrame = () => {}
  const mounted = await mountWorkbench({ board: HARNESS_BOARD })
  mounted.restoreFrames = () => {
    if (requestFrame === undefined) delete globalThis.requestAnimationFrame
    else globalThis.requestAnimationFrame = requestFrame
    if (cancelFrame === undefined) delete globalThis.cancelAnimationFrame
    else globalThis.cancelAnimationFrame = cancelFrame
  }
  return mounted
}

test('the canvas selects a node, toggles with Ctrl, and a blank drag boxes a selection', async () => {
  const { network, panel, restoreFrames } = await mountCanvasWorkbench()
  try {
    const canvas = canvasElement(panel)
    assert.equal(nodeElements(panel).length, 3, 'every board item renders as a node')
    assert.deepEqual(selectedIds(panel), [], 'nothing is selected on load')

    // A plain click selects exactly that node.
    nodeElements(panel)[0].props.onPointerDown(pointerEvent({ clientX: 10, clientY: 10 }))
    await settle(panel)
    assert.deepEqual(selectedIds(panel), ['iaaa1'])
    canvasElement(panel).props.onPointerUp({})

    // Ctrl+click adds a member; a click that does not move pushes no undo step.
    nodeElements(panel)[1].props.onPointerDown(pointerEvent({ clientX: 610, clientY: 10, ctrlKey: true }))
    await settle(panel)
    assert.deepEqual([...selectedIds(panel)].sort(), ['iaaa1', 'ibbb2'], 'Ctrl+click adds to the selection')
    canvasElement(panel).props.onPointerUp({})

    // Ctrl+click on a member takes it back out.
    nodeElements(panel)[1].props.onPointerDown(pointerEvent({ clientX: 610, clientY: 10, ctrlKey: true }))
    await settle(panel)
    assert.deepEqual(selectedIds(panel), ['iaaa1'], 'Ctrl+click on a member removes it')
    canvasElement(panel).props.onPointerUp({})

    // A blank drag is a marquee (§6.6's changed default) and it starts by
    // clearing what was selected — the box is a fresh statement.
    canvasElement(panel).props.onPointerDown(pointerEvent({ clientX: 1150, clientY: 20 }))
    canvasElement(panel).props.onPointerMove(pointerEvent({ clientX: 1450, clientY: 260 }))
    await settle(panel)
    assert.ok(fakeElementWithClass(panel.tree, 'dsh-forge-marquee') !== undefined, 'the box paints while dragging')
    assert.deepEqual(selectedIds(panel), ['iccc3'], 'the marquee highlights its hits live')
    canvasElement(panel).props.onPointerUp({})
    await settle(panel)
    assert.equal(fakeElementWithClass(panel.tree, 'dsh-forge-marquee'), undefined, 'releasing removes the box')
    assert.deepEqual(selectedIds(panel), ['iccc3'], 'the release settles the same selection')
    assert.equal(nodeElements(panel).length, 3, 'selecting never removes anything')

    // A Shift marquee adds to the existing selection instead of replacing it.
    canvasElement(panel).props.onPointerDown(pointerEvent({ clientX: 10, clientY: 20, shiftKey: true }))
    canvasElement(panel).props.onPointerMove(pointerEvent({ clientX: 210, clientY: 260, shiftKey: true }))
    await settle(panel)
    canvasElement(panel).props.onPointerUp({})
    await settle(panel)
    assert.deepEqual([...selectedIds(panel)].sort(), ['iaaa1', 'iccc3'], 'Shift+marquee unions')
  } finally {
    restoreFrames()
    network.restore()
  }
})

test('Delete removes the selection, Ctrl+Z restores it, and Ctrl+Shift+Z redoes', async () => {
  const { network, panel, restoreFrames } = await mountCanvasWorkbench()
  try {
    canvasElement(panel)
    canvasElement(panel).props.onKeyDown(keyEvent('a', { ctrl: true }))
    await settle(panel)
    assert.equal(selectedIds(panel).length, 3, 'Ctrl+A selects the whole board')

    const removal = keyEvent('Delete')
    canvasElement(panel).props.onKeyDown(removal)
    await settle(panel)
    assert.equal(removal.prevented, true, 'a handled key is swallowed')
    assert.equal(nodeElements(panel).length, 0, 'Del unplaces every selected node')

    canvasElement(panel).props.onKeyDown(keyEvent('z', { ctrl: true }))
    await settle(panel)
    assert.equal(nodeElements(panel).length, 3, 'Ctrl+Z puts them back')

    canvasElement(panel).props.onKeyDown(keyEvent('z', { ctrl: true, shift: true }))
    await settle(panel)
    assert.equal(nodeElements(panel).length, 0, 'Ctrl+Shift+Z is the second redo binding')

    canvasElement(panel).props.onKeyDown(keyEvent('y', { ctrl: true }))
    await settle(panel)
    assert.equal(nodeElements(panel).length, 0, 'Ctrl+Y on an empty redo tail is a no-op')

    canvasElement(panel).props.onKeyDown(keyEvent('z', { ctrl: true }))
    await settle(panel)
    assert.equal(nodeElements(panel).length, 3)
  } finally {
    restoreFrames()
    network.restore()
  }
})

test('the shortcut table yields inside a text field, and Escape clears the selection', async () => {
  const { network, panel, restoreFrames } = await mountCanvasWorkbench()
  try {
    canvasElement(panel).props.onKeyDown(keyEvent('a', { ctrl: true }))
    await settle(panel)
    assert.equal(selectedIds(panel).length, 3)

    // §6.3: inside an input the canvas takes nothing back — Delete must edit text.
    const inField = keyEvent('Delete', {}, { tagName: 'TEXTAREA' })
    canvasElement(panel).props.onKeyDown(inField)
    await settle(panel)
    assert.equal(inField.prevented, false, 'the canvas must not swallow a key it yielded')
    assert.equal(nodeElements(panel).length, 3, 'Delete inside the form does not delete nodes')

    // Arrow keys nudge, the Shift variant nudge further, and Escape clears.
    canvasElement(panel).props.onKeyDown(keyEvent('ArrowRight'))
    await settle(panel)
    assert.deepEqual(
      nodeElements(panel).map((entry) => entry.props.style.left),
      ['1px', '601px', '1201px'],
      'one world unit at zoom 1',
    )
    canvasElement(panel).props.onKeyDown(keyEvent('ArrowRight', { shift: true }))
    await settle(panel)
    assert.deepEqual(
      nodeElements(panel).map((entry) => entry.props.style.left),
      ['11px', '611px', '1211px'],
      'Shift nudges by ten',
    )

    // One run, one undo step: Ctrl+Z takes back both keys at once (§6.3's merge).
    canvasElement(panel).props.onKeyDown(keyEvent('z', { ctrl: true }))
    await settle(panel)
    assert.deepEqual(
      nodeElements(panel).map((entry) => entry.props.style.left),
      ['0px', '600px', '1200px'],
      'consecutive nudges are one command, so one undo restores the start',
    )

    canvasElement(panel).props.onKeyDown(keyEvent('Escape'))
    await settle(panel)
    assert.deepEqual(selectedIds(panel), [], 'Escape clears the selection')

    // Space is the held pan modifier (§6.3, §6.6): while down, the canvas says so.
    canvasElement(panel).props.onKeyDown(keyEvent(' '))
    await settle(panel)
    assert.equal(canvasElement(panel).props.className, 'dsh-forge-canvas is-pan', 'Space switches the canvas to pan')
    canvasElement(panel).props.onKeyUp(keyEvent(' '))
    await settle(panel)
    assert.equal(canvasElement(panel).props.className, 'dsh-forge-canvas', 'releasing Space restores marquee')

    // The toolbar toggle is the third pan entry: sticky, no key to hold.
    const before = fakeElementWithClass(panel.tree, 'dsh-forge-canvas-layer').props.style.transform
    const hand = buttonWithText(panel, '平移')
    assert.ok(hand !== undefined, 'the canvas toolbar must offer a pan toggle')
    assert.equal(hand.props['aria-pressed'], false)
    hand.props.onClick()
    await settle(panel)
    assert.equal(canvasElement(panel).props.className, 'dsh-forge-canvas is-pan', 'hand mode is sticky')

    canvasElement(panel).props.onPointerDown(pointerEvent({ clientX: 120, clientY: 80 }))
    canvasElement(panel).props.onPointerMove(pointerEvent({ clientX: 180, clientY: 120 }))
    await settle(panel)
    canvasElement(panel).props.onPointerUp({})
    await settle(panel)
    assert.equal(fakeElementWithClass(panel.tree, 'dsh-forge-marquee'), undefined, 'hand mode never boxes a selection')
    assert.notEqual(
      fakeElementWithClass(panel.tree, 'dsh-forge-canvas-layer').props.style.transform,
      before,
      'a blank drag in hand mode moves the camera',
    )
  } finally {
    restoreFrames()
    network.restore()
  }
})

test('right-click offers the §6.4 menu for blank canvas and for an image node', async () => {
  const { network, panel, restoreFrames } = await mountCanvasWorkbench()
  try {
    canvasElement(panel).props.onContextMenu(pointerEvent({ clientX: 40, clientY: 40 }))
    await settle(panel)
    let entries = menuEntries(panel)
    assert.ok(entries !== undefined, 'right-click opens a menu')
    assert.deepEqual(
      entries.filter((entry) => entry.props.disabled !== true).map((entry) => fakeText(entry)),
      ['新建布局节点', '粘贴', '全选', '适应视图', '导出画板 JSON…', '导出拼版 PNG…'],
      'C15 activated the blank menu: every entry has a handler now',
    )

    // The menu's 全选 runs.
    entries.find((entry) => fakeText(entry) === '全选').props.onClick()
    await settle(panel)
    assert.equal(selectedIds(panel).length, 3)
    assert.equal(menuEntries(panel), undefined, 'running an item closes the menu')

    // §6.4: with a multi-selection the menu acts on the selection, so it is the
    // batch menu — not one node's image menu.
    canvasElement(panel).props.onContextMenu(pointerEvent({
      clientX: 700,
      clientY: 60,
      target: { closest: (selector) => (selector === '.dsh-forge-node' ? { dataset: { nodeId: 'ibbb2' } } : null) },
    }))
    await settle(panel)
    assert.deepEqual(
      menuEntries(panel).map((entry) => fakeText(entry)),
      ['从画布移除所选 3 张（不删文件）', '复制所选到画板…', '移动所选到画板…', '删除所选 3 个文件…'],
      'a selected node keeps the selection, and the menu is the batch one',
    )

    // With nothing selected, the same right-click selects just that node and
    // offers the full image menu (§6.4).
    canvasElement(panel).props.onKeyDown(keyEvent('Escape'))
    await settle(panel)
    canvasElement(panel).props.onContextMenu(pointerEvent({
      clientX: 700,
      clientY: 60,
      target: { closest: (selector) => (selector === '.dsh-forge-node' ? { dataset: { nodeId: 'ibbb2' } } : null) },
    }))
    await settle(panel)
    assert.deepEqual(selectedIds(panel), ['ibbb2'], 'a right-click on an unselected node selects it')
    entries = menuEntries(panel)
    assert.deepEqual(
      entries.map((entry) => fakeText(entry)),
      ['用作参考', '按这张图迭代（预填表单）', '查看原图（新窗）', '复制到画板…', '移动到画板…', '从画布移除（不删文件）', '删除文件…'],
    )
    // Cross-board entries are visible but not yet wired (C12).
    assert.deepEqual(
      entries.filter((entry) => entry.props.disabled !== true).map((entry) => fakeText(entry)),
      ['用作参考', '按这张图迭代（预填表单）', '查看原图（新窗）', '从画布移除（不删文件）', '删除文件…'],
    )

    // "Remove" acts on the right-clicked node and takes it off the canvas.
    entries.find((entry) => fakeText(entry) === '从画布移除（不删文件）').props.onClick()
    await settle(panel)
    assert.equal(nodeElements(panel).length, 2, 'the removal is local to the canvas')
    assert.ok(!selectedIds(panel).includes('ibbb2'))
  } finally {
    restoreFrames()
    network.restore()
  }
})

// ---------------------------------------------------------------------------
// T22: the install → first picture stepper (P6).
// ---------------------------------------------------------------------------

test('T22: the stepper maps snapshot + live phase onto four steps', () => {
  const models = { unet: 'unet.safetensors', clip: 'clip.safetensors', vae: 'vae.safetensors' }
  assert.deepEqual(
    stepperStepsOf({ ready: true, models, endpoint: 'http://127.0.0.1:8188', itemCount: 0 }).map((step) => step.id),
    ['runtime', 'install', 'weights', 'first-run'],
  )
  assert.deepEqual(
    stepperStepsOf({ ready: true, models, endpoint: 'http://127.0.0.1:8188', itemCount: 0 }).map((step) => step.state),
    ['done', 'done', 'done', 'pending'],
    'ready on a fresh board: everything installed, first picture still to do',
  )

  // Not installed: the runtime step fails with the reason's first line only.
  const off = stepperStepsOf({ ready: false, reason: 'ComfyUI 未连接：探了 8188\n第二行不展示', itemCount: 0 })
  assert.equal(off[0].state, 'failed')
  assert.ok(off[0].detail.includes('ComfyUI 未连接'))
  assert.ok(!off[0].detail.includes('第二行'), 'only the headline reaches the row')
  assert.equal(off[2].state, 'pending')

  // Connected but weights missing is a distinct failure (the T14 download step).
  const noWeights = stepperStepsOf({ ready: true, itemCount: 0 })
  assert.equal(noWeights[2].state, 'failed')
  assert.ok(noWeights[2].detail.includes('qwen_image_setup'), 'the row names the managed download entry')

  // The live SSE phase drives the last step.
  const running = stepperStepsOf({ ready: true, models, itemCount: 0, livePhase: 'running', livePercent: 34 })
  assert.equal(running[3].state, 'active')
  assert.ok(running[3].detail.includes('34%'))
  const failed = stepperStepsOf({ ready: true, models, itemCount: 0, livePhase: 'error', liveMessage: 'CUDA out of memory' })
  assert.equal(failed[3].state, 'failed')
  assert.ok(failed[3].detail.includes('CUDA out of memory'))
  assert.equal(stepperStepsOf({ ready: true, models, itemCount: 2 }).at(-1).state, 'done', 'an existing picture finishes the ladder')
})

test('T22: the panel renders the stepper, and 重新检测 re-reads the snapshot', async () => {
  const { network, panel } = await mountWorkbench()
  try {
    const steps = []
    fakeVisit(panel.tree, (entry) => {
      if (typeof entry.props.className === 'string' && entry.props.className.split(' ')[0] === 'dsh-forge-step') steps.push(entry)
    })
    assert.deepEqual(steps.map((step) => step.props['data-step']), ['runtime', 'install', 'weights', 'first-run'])
    assert.deepEqual(steps.map((step) => step.props['data-step-state']), ['done', 'done', 'done', 'pending'])

    const configCalls = () => network.calls.filter((call) => call.url.indexOf(STUDIO_CONFIG_ROUTE) === 0).length
    const before = configCalls()
    const retry = buttonWithText(panel, '重新检测')
    assert.ok(retry !== undefined, 'the stepper must offer a recheck entry')
    retry.props.onClick()
    await settle(panel)
    assert.ok(configCalls() > before, '重新检测 re-reads the capability snapshot')

    // The live stream advances the last step to active with its percent.
    const source = network.open()
    source.emit('message', { type: 'start', promptId: 'p-stepper' })
    source.emit('message', { type: 'progress', promptId: 'p-stepper', value: 17, max: 50, percent: 34, label: '17/50' })
    await settle(panel)
    let firstRun
    fakeVisit(panel.tree, (entry) => {
      if (entry.props['data-step'] === 'first-run') firstRun = entry
    })
    assert.equal(firstRun.props['data-step-state'], 'active')
    assert.ok(fakeText(firstRun).includes('34%'))
  } finally {
    network.restore()
  }
})

test('T22: a not-ready snapshot puts its reason on the failed step', async () => {
  const { network, panel } = await mountWorkbench({
    configOverrides: { ready: false, reason: 'ComfyUI 未连接：探了 8188 等端口', models: undefined },
  })
  try {
    let runtime
    let weights
    fakeVisit(panel.tree, (entry) => {
      if (entry.props['data-step'] === 'runtime') runtime = entry
      if (entry.props['data-step'] === 'weights') weights = entry
    })
    assert.equal(runtime.props['data-step-state'], 'failed')
    assert.ok(fakeText(runtime).includes('ComfyUI 未连接'))
    assert.equal(weights.props['data-step-state'], 'pending', 'weights cannot be checked before the runtime is up')
  } finally {
    network.restore()
  }
})

// ---------------------------------------------------------------------------
// C11: task nodes — generate drops one, SSE drives it, the response converts it.
//
// The panel's generate is a fetch whose response the test resolves by hand:
// that is what makes the "done frame before the response" race observable, and
// it is C11's stop-condition plan asserted rather than hoped for. What still
// needs a browser: pointer capture, paint, and a live ComfyUI run.
// ---------------------------------------------------------------------------

/** A response the test resolves when it chooses (the POST outlives the run). */
function deferredResponse() {
  let settleResponse
  const promise = new Promise((resolve) => { settleResponse = resolve })
  return {
    promise,
    resolve(payload, status = 200) { settleResponse(fakeResponse(payload, status)) },
  }
}

/** One generated image in the shape the panel expects back. */
function resultImage(id, overrides = {}) {
  return {
    id,
    path: `C:/out/${id}.png`,
    markdownPath: `C:/out/${id}.png`,
    width: 1024,
    height: 1024,
    bytes: 2048,
    mediaType: 'image/png',
    ...overrides,
  }
}

/** A full `StudioGenerateResponse` with one or more pictures. */
function generateResult(images, overrides = {}) {
  return {
    images,
    prompt: '一只橘猫坐在窗台上',
    ratio: '1:1',
    width: 1024,
    height: 1024,
    steps: 8,
    seed: 7,
    elapsedMs: 1200,
    endpoint: 'http://127.0.0.1:8188',
    mode: 'generate',
    turboFallback: false,
    ...overrides,
  }
}

/** Every painted node of one kind. */
function nodesOfKind(panel, kind) {
  return nodeElements(panel).filter((entry) => entry.props['data-node-kind'] === kind)
}

/** The single task node on the canvas. */
function taskNodeElement(panel) {
  const tasks = nodesOfKind(panel, 'task')
  assert.equal(tasks.length, 1, 'exactly one task node is expected')
  return tasks[0]
}

/** The edge keys (`parent->child`) the canvas drew. */
function edgeKeys(panel) {
  const keys = []
  fakeVisit(panel.tree, (entry) => {
    if (entry.type === 'path' && typeof entry.props.key === 'string') keys.push(entry.props.key)
  })
  return keys
}

/** Type into the form's prompt box, the way the user would. */
async function typePrompt(panel, text) {
  fakeElementWithClass(panel.tree, 'dsh-forge-textarea').props.onChange({ target: { value: text } })
  await settle(panel)
}

/** Mount the canvas board with a generation stub; the stub sees each body. */
async function mountGeneration(generate, board = HARNESS_BOARD) {
  const requests = []
  const mounted = await mountWorkbench({
    board,
    generate: (init) => {
      requests.push(JSON.parse(init.body))
      return generate(requests.length - 1)
    },
  })
  return { ...mounted, requests }
}

test('C11: generation drops a task node carrying its clientId, and the response converts it in place', async () => {
  const pending = deferredResponse()
  const { network, panel, requests } = await mountGeneration(() => pending.promise)
  try {
    // A picture becomes the reference, which is also the edge's source.
    nodeElements(panel)[0].props.onPointerDown(pointerEvent({ clientX: 10, clientY: 10 }))
    await settle(panel)
    canvasElement(panel).props.onPointerUp({})
    buttonWithText(panel, '用作参考').props.onClick()
    await settle(panel)
    await typePrompt(panel, '一只橘猫坐在窗台上')

    buttonWithText(panel, '生成改图').props.onClick()
    await settle(panel)

    // §4.3 step 1: the wire carries a host-valid clientId, the board and the
    // form values; the task node is keyed by it and lands where a result would.
    assert.equal(requests.length, 1, 'one POST per generation')
    const body = requests[0]
    assert.ok(isStudioClientId(body.clientId), 'the request carries a canonical clientId')
    assert.equal(body.prompt, '一只橘猫坐在窗台上')
    assert.equal(body.ratio, '1:1')
    assert.equal(body.board, HARNESS_BOARD.id)
    const clientId = body.clientId
    const task = taskNodeElement(panel)
    assert.equal(task.props['data-node-id'], clientId, 'the task node id is the clientId')
    assert.equal(task.props['data-task-status'], 'idle')
    assert.equal(task.props.style.left, '1440px', 'landing clears the widest right-most node')
    assert.equal(task.props.style.width, '208px', 'a task node is the fixed default box')
    assert.ok(fakeText(task).includes('一只橘猫坐在窗台上'), 'the node shows the prompt')
    assert.ok(fakeText(task).includes('1:1 · 40 步 · 1 张'), 'the node shows the parameter summary')

    // §4.2: run → queued, start → running, progress → label and percent.
    const source = network.open()
    source.emit('message', { type: 'run', promptId: 'prompt-1', clientId })
    await settle(panel)
    assert.equal(taskNodeElement(panel).props['data-task-status'], 'queued')
    source.emit('message', { type: 'start', promptId: 'prompt-1', clientId })
    await settle(panel)
    assert.equal(taskNodeElement(panel).props['data-task-status'], 'running')
    source.emit('message', { type: 'progress', promptId: 'prompt-1', clientId, value: 17, max: 50, percent: 34, label: '17/50' })
    await settle(panel)
    const running = taskNodeElement(panel)
    assert.equal(running.props['data-task-status'], 'running')
    assert.ok(fakeText(running).includes('第 17/50 步'))
    assert.equal(fakeElementWithClass(panel.tree, 'dsh-forge-task-fill').props.style.width, '34%')

    // §4.2's queue rule: a broadcast queue change never pushes a started run back.
    source.emit('message', { type: 'queue', remaining: 0 })
    await settle(panel)
    assert.equal(taskNodeElement(panel).props['data-task-status'], 'running', 'queue frames are not retrograde')

    // A done frame moves the status only; the node stays a task until the
    // response says which pictures replace it (C11's race plan).
    source.emit('message', { type: 'done', promptId: 'prompt-1', clientId })
    await settle(panel)
    assert.equal(taskNodeElement(panel).props['data-task-status'], 'done')
    assert.equal(nodesOfKind(panel, 'image').length, 3, 'a frame alone converts nothing')
    assert.equal(nodesOfKind(panel, 'task').length, 1)

    pending.resolve(generateResult([resultImage('iimg1')]))
    await settle(panel)

    // DD5: the first image takes the task node's exact position and parents —
    // the lineage edge survives the conversion.
    assert.equal(nodesOfKind(panel, 'task').length, 0, 'the task node is gone')
    const converted = nodesOfKind(panel, 'image').find((entry) => entry.props['data-node-id'] === 'iimg1')
    assert.ok(converted !== undefined, 'the result is an image node keyed by the board item id')
    assert.equal(converted.props.style.left, '1440px')
    assert.equal(converted.props.style.top, '0px')
    assert.ok(edgeKeys(panel).includes('iaaa1->iimg1'), 'parents crossed the conversion as a drawn edge')
    assert.equal(nodeElements(panel).length, 4, 'three board pictures plus the new one')
    assert.equal(progressView(panel).phase, 'done')
  } finally {
    network.restore()
  }
})

test('C11: a failed task stays for retry, and the retry replaces it in place with a new clientId', async () => {
  const retry = deferredResponse()
  const { network, panel, requests } = await mountGeneration((index) => (index === 0
    ? fakeResponse({ error: 'CUDA out of memory\nTraceback (most recent call last): ...' }, 500)
    : retry.promise))
  try {
    await typePrompt(panel, '一只橘猫坐在窗台上')
    buttonWithText(panel, '生成').props.onClick()
    await settle(panel)

    assert.equal(requests.length, 1)
    const firstId = requests[0].clientId
    const failed = taskNodeElement(panel)
    assert.equal(failed.props['data-task-status'], 'failed')
    assert.ok(fakeText(failed).includes('失败：CUDA out of memory'), 'the first line of the reason is shown')
    assert.ok(!fakeText(failed).includes('Traceback'), 'the traceback stays out of the node')
    assert.ok(fakeElementWithClass(panel.tree, 'dsh-forge-studio-alert') !== undefined, 'the form also reports the refusal')
    const position = { left: failed.props.style.left, top: failed.props.style.top }

    // §4.5 retry: a fresh clientId, the same snapshot, the same position.
    buttonWithText(panel, '重试').props.onClick()
    await settle(panel)
    assert.equal(requests.length, 2)
    const secondId = requests[1].clientId
    assert.ok(isStudioClientId(secondId))
    assert.notEqual(secondId, firstId, 'a retry is a new run, so a new clientId')
    assert.equal(requests[1].prompt, '一只橘猫坐在窗台上', 'the params snapshot is re-sent verbatim')
    const restarted = taskNodeElement(panel)
    assert.equal(restarted.props['data-node-id'], secondId, 'the node is replaced, not duplicated')
    assert.equal(restarted.props.style.left, position.left)
    assert.equal(restarted.props.style.top, position.top)
    assert.equal(nodesOfKind(panel, 'task').length, 1, 'a failed intent does not pile up')

    retry.resolve(generateResult([resultImage('iimg2')]))
    await settle(panel)
    assert.equal(nodesOfKind(panel, 'task').length, 0)
    assert.deepEqual(edgeKeys(panel), [], 'no reference was held, so no edge is drawn')
  } finally {
    network.restore()
  }
})

test('C11: events without this clientId cannot touch a task node', async () => {
  const pending = deferredResponse()
  const { network, panel, requests } = await mountGeneration(() => pending.promise)
  try {
    await typePrompt(panel, '一只橘猫坐在窗台上')
    buttonWithText(panel, '生成').props.onClick()
    await settle(panel)
    const source = network.open()

    // A conversation-tool run carries no clientId: its frames are not this task's.
    source.emit('message', { type: 'start', promptId: 'prompt-other' })
    source.emit('message', { type: 'progress', promptId: 'prompt-other', value: 1, max: 4, percent: 25, label: '1/4' })
    source.emit('message', { type: 'error', promptId: 'prompt-other', message: '别的任务失败' })
    await settle(panel)
    assert.equal(taskNodeElement(panel).props['data-task-status'], 'idle', 'clientId-less events are isolated')
    assert.ok(!fakeText(taskNodeElement(panel)).includes('别的任务失败'))

    // Another canvas task's frames are isolated by clientId too.
    source.emit('message', { type: 'start', promptId: 'prompt-b', clientId: 'cothertask' })
    await settle(panel)
    assert.equal(taskNodeElement(panel).props['data-task-status'], 'idle')

    // The global status bar still follows the unlinked run (pre-DD7 behaviour).
    assert.equal(progressView(panel).phase, 'running')
  } finally {
    network.restore()
  }
})

test('C11: an interrupt lands on the node, and edit-params refills the form to replace it', async () => {
  const first = deferredResponse()
  const second = deferredResponse()
  const { network, panel, requests } = await mountGeneration((index) => (index === 0 ? first.promise : second.promise))
  try {
    await typePrompt(panel, '一只橘猫坐在窗台上')
    buttonWithText(panel, '生成').props.onClick()
    await settle(panel)
    const clientId = requests[0].clientId
    const source = network.open()
    source.emit('message', { type: 'run', promptId: 'prompt-1', clientId })
    source.emit('message', { type: 'start', promptId: 'prompt-1', clientId })
    await settle(panel)
    assert.equal(taskNodeElement(panel).props['data-task-status'], 'running')

    source.emit('message', { type: 'interrupted', promptId: 'prompt-1', clientId })
    await settle(panel)
    // The run's own POST settles after the interrupt; a cancelled run's refusal
    // must not relabel the node (the interrupt is the terminal truth).
    first.resolve({ error: '已中断' }, 500)
    await settle(panel)
    const interrupted = taskNodeElement(panel)
    assert.equal(interrupted.props['data-task-status'], 'interrupted')
    assert.ok(fakeText(interrupted).includes('已中断'))
    assert.ok(buttonWithText(panel, '编辑参数') !== undefined)

    // §4.5 edit: the snapshot goes back into the form, and the node is marked
    // for replacement rather than removed before the user has decided.
    buttonWithText(panel, '编辑参数').props.onClick()
    await settle(panel)
    assert.equal(fakeElementWithClass(panel.tree, 'dsh-forge-textarea').props.value, '一只橘猫坐在窗台上')
    assert.equal(nodesOfKind(panel, 'task').length, 1, 'the failed node stays until the next generate')

    // The next generate replaces that node slot instead of adding a second one.
    buttonWithText(panel, '生成').props.onClick()
    await settle(panel)
    assert.equal(requests.length, 2)
    assert.notEqual(requests[1].clientId, clientId)
    assert.equal(nodesOfKind(panel, 'task').length, 1)
    assert.equal(taskNodeElement(panel).props['data-node-id'], requests[1].clientId)
  } finally {
    network.restore()
  }
})

test('C11: a persisted failure is rebuilt from the board and its retry is wired', async () => {
  // A v2 board with one picture and one terminal task entry (§4.6).
  const board = {
    id: 'cbrdtask',
    name: '失败重试板',
    camera: { x: 0, y: 0, zoom: 1 },
    items: [
      {
        id: 'iaaa1',
        path: 'C:/out/iaaa1.png',
        markdownPath: 'C:/out/iaaa1.png',
        width: 1024,
        height: 1024,
        bytes: 1024,
        mediaType: 'image/png',
        batchId: 'b1',
        prompt: '一只橘猫',
        ratio: '1:1',
        steps: 8,
        seed: 1,
        mode: 'generate',
        backend: 'studio',
        parents: [],
        x: 0,
        y: 0,
      },
      {
        id: 'ctaskrec1',
        kind: 'task',
        batchId: 'b0',
        x: 600,
        y: 0,
        parents: ['iaaa1'],
        task: {
          status: 'failed',
          error: '权重加载失败',
          params: { prompt: '一只橘猫', ratio: '3:4', steps: 8, count: 2 },
        },
      },
    ],
  }
  const pending = deferredResponse()
  const { network, panel, requests } = await mountGeneration(() => pending.promise, board)
  try {
    // §4.6: a board task entry comes back as a retryable node; there is no live
    // clientId, so the board item id stands in until a retry mints a fresh one.
    assert.equal(nodesOfKind(panel, 'image').length, 1)
    const rebuilt = taskNodeElement(panel)
    assert.equal(rebuilt.props['data-task-status'], 'failed')
    assert.equal(rebuilt.props.style.left, '600px')
    assert.ok(fakeText(rebuilt).includes('权重加载失败'))
    assert.ok(fakeText(rebuilt).includes('3:4 · 8 步 · 2 张'))

    // The inline retry row is single-selection by design: select the node first.
    rebuilt.props.onPointerDown(pointerEvent({ clientX: 610, clientY: 10 }))
    await settle(panel)
    canvasElement(panel).props.onPointerUp({})
    buttonWithText(panel, '重试').props.onClick()
    await settle(panel)
    assert.equal(requests.length, 1)
    assert.ok(isStudioClientId(requests[0].clientId))
    assert.equal(requests[0].ratio, '3:4')
    assert.equal(requests[0].steps, 8)
    assert.equal(requests[0].count, 2)
    assert.equal(taskNodeElement(panel).props['data-node-id'], requests[0].clientId)
    assert.equal(taskNodeElement(panel).props.style.left, '600px', 'a retry keeps the stored position')
  } finally {
    network.restore()
  }
})

test('C11: count>1 keeps the first image in place and fans the rest out to the right', async () => {
  const pending = deferredResponse()
  const { network, panel, requests } = await mountGeneration(() => pending.promise)
  try {
    await typePrompt(panel, '两只橘猫')
    // The second number input is the count; set it the way the form does.
    const numbers = []
    fakeVisit(panel.tree, (entry) => {
      if (entry.type === 'input' && entry.props.type === 'number') numbers.push(entry)
    })
    numbers[1].props.onChange({ target: { value: '2' } })
    await settle(panel)

    buttonWithText(panel, '生成').props.onClick()
    await settle(panel)
    assert.equal(requests[0].count, 2)
    const task = taskNodeElement(panel)
    const left = task.props.style.left
    const top = task.props.style.top

    pending.resolve(generateResult([resultImage('i41'), resultImage('i42')]))
    await settle(panel)
    assert.equal(nodesOfKind(panel, 'task').length, 0)
    const first = nodesOfKind(panel, 'image').find((entry) => entry.props['data-node-id'] === 'i41')
    const second = nodesOfKind(panel, 'image').find((entry) => entry.props['data-node-id'] === 'i42')
    assert.ok(first !== undefined && second !== undefined)
    assert.equal(first.props.style.left, left, 'the first picture takes the task position')
    assert.equal(first.props.style.top, top)
    // The first picture is 200 wide at 1440, so the fan-out clears 1640 + 40.
    assert.equal(second.props.style.left, '1680px', 'the extra picture lands to the right of every node')
    assert.equal(nodeElements(panel).length, 5)
  } finally {
    network.restore()
  }
})

// ---------------------------------------------------------------------------
// C12: asset flow — cross-board copy/move, OS-file import, locate camera.
//
// The drag gestures themselves have no DOM automation (§14.5); asserted here
// is every contract they call: the closed board action set, the import route
// end to end (real socket, real files), and the bundle both halves must carry.
// The side effects live in boards.test.mjs; the camera maths in
// studio-canvas.test.mjs.
// ---------------------------------------------------------------------------

test('C12: the board action set is closed at eight, and copy/move need a destination', () => {
  const actions = ['create', 'rename', 'layout', 'remove-item', 'delete', 'active', 'copy-item', 'move-item']
  // `toBoard` is ignored by the other actions and required by these two.
  for (const action of actions) assert.equal(parseBoardAction({ action, toBoard: 'b2' }).action, action)
  assert.throws(() => parseBoardAction({ action: 'copy' }), /未知的画板操作/, 'still a closed set')
  assert.throws(() => parseBoardAction({ action: 'copy-item', item: 'i1' }), /toBoard/)
  assert.throws(() => parseBoardAction({ action: 'move-item', item: 'i1' }), /toBoard/)

  const parsed = parseBoardAction({ action: 'copy-item', board: 'b1', item: 'i1', toBoard: ' b2 ', x: 10, y: -20 })
  assert.equal(parsed.board, 'b1')
  assert.equal(parsed.toBoard, 'b2')
  assert.deepEqual({ x: parsed.x, y: parsed.y }, { x: 10, y: -20 })
  // A malformed coordinate is dropped, and the pair goes with it — the same
  // per-entry leniency the layout coordinates already have.
  const dropped = parseBoardAction({ action: 'move-item', board: 'b1', item: 'i1', toBoard: 'b2', x: 'nope', y: 20 })
  assert.equal(dropped.x, undefined)
  assert.equal(dropped.y, undefined)
})

test('C12: the import body is shape-checked and base64-bounded before allocation', () => {
  assert.throws(() => parseImport({}), /缺少文件名/)
  assert.throws(() => parseImport({ name: 'a.png' }), /缺少图片内容/)
  assert.throws(() => parseImport('nope'), /请求格式无效/)
  const parsed = parseImport({ name: ' a.png ', data: 'AAAA', board: ' b1 ', x: 1, y: 2, mediaType: 'image/png' })
  assert.equal(parsed.name, 'a.png')
  assert.equal(parsed.board, 'b1')
  assert.deepEqual({ x: parsed.x, y: parsed.y }, { x: 1, y: 2 })

  assert.throws(() => decodeImportData(''), /缺少图片内容/)
  assert.throws(() => decodeImportData('not*b_a$se64!'), /base64/)
  // The 32 MB cap is enforced on the string before decoding: a body that could
  // never fit is refused without allocating the image.
  const maxBase64 = Math.ceil(STUDIO_IMPORT_MAX_ITEM_BYTES / 3) * 4
  assert.throws(() => decodeImportData('A'.repeat(maxBase64 + 4)), /上限/)
  assert.equal(decodeImportData(Buffer.from([137, 80]).toString('base64')).byteLength, 2)
})

/** A minimal PNG header with real dimensions: enough for sniffing and sizing. */
function pngHeader(width, height) {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'latin1')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

/** Mount the Studio routes on a throwaway server over one temp output dir. */
async function withStudioServer(run) {
  const registered = []
  const fakeWebServer = { register: (route) => { registered.push(route); return () => {} } }
  const fakeCtx = { webServer: fakeWebServer, logger: { warn() {} } }
  const dir = mkdtempSync(join(tmpdir(), 'forge-c12-'))
  try {
    registerStudioRoutes(fakeCtx, { settings: () => ({ outputDir: dir }), ctx: fakeCtx })
    const route = registered.find((entry) => entry.path === STUDIO_IMPORT_ROUTE)
    assert.ok(route, 'the import route must be registered')
    const server = createServer((req, res) => { void route.handler(req, res) })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    try {
      return await run({ base, dir })
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** POST the import route the way the panel does, with a browser-like Origin. */
function postImport(base, body, options = {}) {
  return fetch(base + STUDIO_IMPORT_ROUTE, {
    method: options.method ?? 'POST',
    headers: {
      'content-type': options.contentType ?? 'application/json',
      ...(options.origin === null ? {} : { origin: options.origin ?? `http://${new URL(base).host}` }),
    },
    ...(options.method === 'GET' ? {} : { body: options.raw ?? JSON.stringify(body) }),
  })
}

test('C12: importing a dropped file records a board item and writes the bytes', async () => {
  await withStudioServer(async ({ base }) => {
    const bytes = pngHeader(1024, 768)
    const res = await postImport(base, {
      name: '窗台橘猫.png',
      mediaType: 'image/png',
      data: bytes.toString('base64'),
      x: 260,
      y: 44,
    })
    assert.equal(res.status, 200)
    const payload = await res.json()
    assert.equal(payload.item.width, 1024)
    assert.equal(payload.item.height, 768)
    assert.equal(payload.item.mediaType, 'image/png')
    assert.equal(payload.item.prompt, '', 'an imported file was not generated by a prompt')
    assert.equal(payload.item.mode, 'generate')
    assert.equal(payload.item.backend, 'studio')
    assert.equal(payload.item.x, 260)
    assert.equal(payload.item.y, 44)
    assert.equal(payload.board.itemCount, 1)
    assert.ok(existsSync(payload.item.path), 'the decoded bytes are on disk')
    // A non-ASCII file name collapses to the documented fallback prefix; the
    // size suffix comes from the sniffed dimensions, not from the claim.
    assert.match(payload.item.path.split(/[\\/]/).pop(), /^import_1024x768_1\.png$/)
  })
})

test('C12: the import route refuses cross-origin, wrong method/type and non-images', async () => {
  await withStudioServer(async ({ base }) => {
    const goodBody = { name: 'a.png', data: pngHeader(32, 32).toString('base64') }

    const cross = await postImport(base, goodBody, { origin: 'http://evil.example' })
    assert.equal(cross.status, 403, 'cross-origin is refused')

    const wrongMethod = await postImport(base, goodBody, { method: 'GET' })
    assert.equal(wrongMethod.status, 405, 'GET is not an import')

    const wrongType = await postImport(base, goodBody, { contentType: 'text/plain' })
    assert.equal(wrongType.status, 415, 'only JSON bodies are accepted')

    const notImage = await postImport(base, { name: 'notes.png', data: Buffer.from('不是图片').toString('base64') })
    assert.equal(notImage.status, 400)
    assert.match((await notImage.json()).error, /PNG \/ JPEG \/ WebP/)

    const malformed = await postImport(base, { name: 'a.png', data: '!!not base64!!' })
    assert.equal(malformed.status, 400)
    assert.match((await malformed.json()).error, /base64/)
  })
})

test('C12: the import contract and the drag MIME ship to both halves', () => {
  const host = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  assert.ok(host.includes(STUDIO_IMPORT_ROUTE), 'the host must register the import route')
  const client = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
  assert.ok(client.includes(STUDIO_IMPORT_ROUTE), 'the panel must post to the import route')
  assert.ok(client.includes('application/x-dsh-forge-asset'), 'the private drag MIME must ship')
  assert.ok(client.includes('copy-item'), 'the cross-board copy action must ship')
  assert.ok(client.includes('move-item'), 'the cross-board move action must ship')
})

// ---------------------------------------------------------------------------
// C13: layout nodes on the canvas — board rebuild, creation and its undo.
// The editor's DOM mount cannot be driven here (§14.5); what is asserted is
// the node contract around it (data/geometry/footnote) that C14 consumes.
// ---------------------------------------------------------------------------

test('C13: a persisted layout node rebuilds with its draft and display box', async () => {
  const board = {
    id: 'cbrdlayout',
    name: '布局板',
    camera: { x: 0, y: 0, zoom: 1 },
    items: [
      {
        id: 'ilayout1',
        kind: 'layout',
        x: 120,
        y: 60,
        parents: [],
        w: 480,
        draft: {
          width: 1536,
          height: 1024,
          bbox_coord_space: 'abs',
          bbox_format: 'xyxy',
          summary: { caption: '黄昏的山谷' },
          items: [{ label: 'object', caption: '山', bbox: [10, 20, 300, 400] }],
        },
      },
    ],
  }
  const { network, panel } = await mountWorkbench({ board })
  try {
    const layouts = nodesOfKind(panel, 'layout')
    assert.equal(layouts.length, 1, 'a v2 layout entry becomes a layout node')
    const node = layouts[0]
    assert.equal(node.props['data-node-id'], 'ilayout1')
    assert.equal(node.props.style.left, '120px')
    assert.equal(node.props.style.width, '480px')
    assert.equal(node.props.style.height, '420px', 'height follows the draft ratio plus chrome')
    assert.ok(fakeText(node).includes('MOSS 布局'))
    assert.ok(fakeText(node).includes('1 框 · 1536×1024'), 'the footnote carries the draft state')
    assert.equal(nodesOfKind(panel, 'image').length, 0)
  } finally {
    network.restore()
  }
})

test('C13: the toolbar creates a default layout node, and creation is undoable', async () => {
  const { network, panel } = await mountWorkbench()
  try {
    assert.equal(nodesOfKind(panel, 'layout').length, 0)
    const create = buttonWithText(panel, '新建布局')
    assert.ok(create !== undefined, 'the canvas toolbar must offer the layout entry')
    create.props.onClick()
    await settle(panel)

    const layouts = nodesOfKind(panel, 'layout')
    assert.equal(layouts.length, 1)
    assert.equal(layouts[0].props.style.width, '480px')
    assert.equal(layouts[0].props.style.height, '420px')
    assert.ok(fakeText(layouts[0]).includes('0 框 · 1536×1024'), 'the default draft is 1536×1024')

    // §6.5: creation is an undoable command.
    canvasElement(panel).props.onKeyDown(keyEvent('z', { ctrl: true }))
    await settle(panel)
    assert.equal(nodesOfKind(panel, 'layout').length, 0, 'Ctrl+Z takes the new node back')

    // C14: creation schedules a debounced board write, and an undo inside that
    // window cancels it — an add-then-undo must leave no board entry behind.
    buttonWithText(panel, '新建布局').props.onClick()
    await settle(panel)
    canvasElement(panel).props.onKeyDown(keyEvent('z', { ctrl: true }))
    await settle(panel)
    assert.equal(nodesOfKind(panel, 'layout').length, 0)
    await new Promise((resolve) => setTimeout(resolve, 650))
    await settle(panel)
    assert.equal(
      boardMutations(network).filter((call) => call.action === 'save-layout-node').length,
      0,
      'an undone creation never reaches the board',
    )
  } finally {
    network.restore()
  }
})

// ---------------------------------------------------------------------------
// C14: the layout loop — ratio mapping, T21 request seam, generation from a
// layout node, and the persisted task/layout entries (save-task /
// save-layout-node). The adapter itself is exercised through the same graph
// builder a real ComfyUI receives; a live GPU run is the manual evidence.
// ---------------------------------------------------------------------------

test('C14: a draft maps onto the official ratio ladder, and a stretched draft is detectable', () => {
  // Exact drafts used by the layout editor's own presets.
  assert.deepEqual(
    (({ ratio, deviation }) => ({ ratio, deviation }))(fitStudioRatio(1536, 1024)),
    { ratio: '3:2', deviation: 0 },
    'the default 1536x1024 draft is exactly 3:2',
  )
  // Every official ratio resolves from a 16-aligned draft.
  const cases = [
    [1024, 1024, '1:1'],
    [1024, 768, '4:3'],
    [768, 1024, '3:4'],
    [1024, 683, '3:2'],
    [683, 1024, '2:3'],
    [1024, 576, '16:9'],
    [576, 1024, '9:16'],
  ]
  for (const [width, height, ratio] of cases) {
    assert.equal(fitStudioRatio(width, height).ratio, ratio, String(width) + 'x' + String(height))
  }

  // An unofficial aspect maps to the nearest rung and reports how far off it is;
  // §8.4's rule is that a deviation past the tolerance is prompted, not stretched.
  const stretched = fitStudioRatio(1536, 1000)
  assert.equal(stretched.ratio, '3:2')
  assert.ok(stretched.deviation > STUDIO_LAYOUT_RATIO_TOLERANCE, 'a 1.536 aspect is not silently 3:2')
  assert.equal(fitStudioRatio(0, 100), undefined)
})

test('C14: the layout request is T21-shaped, and the no-layout graph stays byte-identical', () => {
  const resolved = { width: 1248, height: 832, count: 1, steps: 25, seed: 7 }
  const plain = studioTextToImageRequestOf({ prompt: '  A minimalist poster.  ' }, resolved)
  assert.deepEqual(
    plain,
    { prompt: 'A minimalist poster.', width: 1248, height: 832, count: 1, steps: 25, seed: 7 },
    'without layout the adapter request has exactly the pre-T21 keys',
  )
  assert.equal('layout' in plain, false)

  const withLayout = studioTextToImageRequestOf({ prompt: 'A minimalist poster.', layout: LAYOUT_SAMPLE }, resolved)
  assert.equal(withLayout.layout, LAYOUT_SAMPLE, 'the compiled text is forwarded verbatim')

  // The graph builder is the fake server here: no layout must not change a byte.
  const control = renderTextToImage(MODEL_PROFILES['moss-sft'], MOSS_MODELS, {
    prompt: 'A minimalist poster.',
    width: 1248,
    height: 832,
    count: 1,
    steps: 25,
    seed: 7,
  })
  assert.equal(JSON.stringify(renderTextToImage(MODEL_PROFILES['moss-sft'], MOSS_MODELS, plain)), JSON.stringify(control))
  const conditioned = renderTextToImage(MODEL_PROFILES['moss-sft'], MOSS_MODELS, withLayout)
  assert.equal(conditioned['4'].inputs.text, LAYOUT_SAMPLE, 'MOSS positive encoder text = compiled layout')
  assert.equal(JSON.stringify(conditioned['5']), JSON.stringify(control['5']), 'the negative prompt is untouched')
  assert.deepEqual(Object.keys(conditioned).sort(), Object.keys(control).sort(), 'no extra nodes are injected')
})

test('C14: the generate route accepts layout and canvas parents, and refuses a bad layout', () => {
  const parsed = parseGenerate({
    prompt: '按布局出图',
    ratio: '3:2',
    layout: LAYOUT_SAMPLE,
    parents: ['i1', 'i2', 3, '  '],
  })
  assert.equal(parsed.layout, LAYOUT_SAMPLE)
  assert.deepEqual(parsed.parents, ['i1', 'i2'], 'only usable ids survive')

  // Backwards compatibility: the plain body gains no new keys.
  const plain = parseGenerate({ prompt: 'x', ratio: '1:1' })
  assert.equal('layout' in plain, false)
  assert.equal('parents' in plain, false)

  assert.throws(
    () => parseGenerate({ prompt: 'x', ratio: '1:1', layout: '{"bbox_coord_space":"abs"}' }),
    /abs_centralized/,
    'the shared MOSS parser names the failing field',
  )
  assert.throws(() => parseGenerate({ prompt: 'x', ratio: '1:1', layout: 'not json' }), /布局不是合法 JSON/)
  assert.throws(() => parseGenerate({ prompt: 'x', ratio: '1:1', parents: 'i1' }), /parents 必须是数组/)
})

test('C14: the board action set reaches ten and the node writers validate their payloads', () => {
  const actions = [
    'create', 'rename', 'layout', 'remove-item', 'delete', 'active',
    'copy-item', 'move-item', 'save-task', 'save-layout-node',
  ]
  const payloads = {
    'save-task': { task: { status: 'failed', params: { prompt: 'p' } } },
    'save-layout-node': { draft: { width: 1536, height: 1024, items: [] }, w: 480, h: 420 },
  }
  for (const action of actions) {
    assert.equal(parseBoardAction({ action, toBoard: 'b2', ...(payloads[action] ?? {}) }).action, action)
  }
  assert.throws(() => parseBoardAction({ action: 'save-task' }), /缺少 task/)
  assert.throws(
    () => parseBoardAction({ action: 'save-task', task: { status: 'running', params: { prompt: 'p' } } }),
    /failed 或 interrupted/,
    'a running task is never stored (DD6)',
  )

  const task = parseBoardAction({
    action: 'save-task',
    item: 'ct1',
    x: 10,
    y: 20,
    parents: ['i1'],
    task: { status: 'failed', error: 'boom', params: { prompt: 'p', layout: '{"x":1}' } },
  })
  assert.deepEqual(task.task, { status: 'failed', error: 'boom', params: { prompt: 'p', layout: '{"x":1}' } })
  assert.deepEqual(task.parents, ['i1'])

  const layout = parseBoardAction({
    action: 'save-layout-node',
    item: 'il1',
    draft: { width: 1536, height: 1024, items: [] },
    w: 480,
    h: 420,
  })
  assert.equal(layout.w, 480)
  assert.throws(
    () => parseBoardAction({ action: 'save-layout-node', draft: { width: 1536, height: 1024, items: [] } }),
    /w \/ h/,
  )
  assert.throws(
    () => parseBoardAction({ action: 'save-layout-node', draft: { width: 'x', items: [] }, w: 1, h: 1 }),
    /draft.width/,
  )
})

/** Mount a board holding exactly one layout node with `draft`. */
function layoutBoard(draft, extra = {}) {
  return {
    id: 'cbrdloop',
    name: '布局闭环板',
    camera: { x: 0, y: 0, zoom: 1 },
    items: [
      {
        id: 'ilayout1',
        kind: 'layout',
        x: 120,
        y: 60,
        parents: [],
        w: 480,
        draft,
        ...extra,
      },
    ],
  }
}

/** The layout node's own 生成 button (the form has a 生成 button too). */
function layoutGenerateButton(panel) {
  const node = nodesOfKind(panel, 'layout')[0]
  assert.ok(node !== undefined, 'the layout node must render')
  let found
  fakeVisit(node, (entry) => {
    if (found === undefined && entry.type === 'button' && fakeText(entry) === '生成') found = entry
  })
  return found
}

test('C14: a layout node generates with its compiled text, ratio and layout parent', async () => {
  const draft = {
    width: 1536,
    height: 1024,
    bbox_coord_space: 'abs',
    bbox_format: 'xyxy',
    summary: { caption: '黄昏的山谷' },
    items: [{ label: 'object', caption: '山', bbox: [10, 20, 300, 400] }],
  }
  const pending = deferredResponse()
  const { network, panel, requests } = await mountGeneration(() => pending.promise, layoutBoard(draft))
  try {
    const button = layoutGenerateButton(panel)
    assert.ok(button !== undefined, 'a layout node must offer 生成')
    button.props.onClick()
    await settle(panel)

    assert.equal(requests.length, 1, 'one MOSS request')
    assert.equal(requests[0].layout, compileLayout(draft), 'compiled export goes out verbatim')
    assert.equal(requests[0].prompt, '黄昏的山谷', 'summary.caption is the prompt')
    assert.equal(requests[0].ratio, '3:2', 'the default draft is an exact official ratio')
    assert.deepEqual(requests[0].parents, ['ilayout1'], 'the layout node is the result parent')
    assert.equal(requests[0].count, 1)

    const task = taskNodeElement(panel)
    assert.ok(fakeText(task).includes('布局'), 'the task node says it is layout-conditioned')
    pending.resolve(generateResult([resultImage('iimg9')]))
    await settle(panel)
    assert.ok(edgeKeys(panel).includes('ilayout1->iimg9'), 'the layout edge survives the conversion')
  } finally {
    network.restore()
  }
})

test('C14: an empty, caption-less or stretched draft never submits a request', async () => {
  const base = {
    width: 1536,
    height: 1024,
    bbox_coord_space: 'abs',
    bbox_format: 'xyxy',
    summary: { caption: '黄昏的山谷' },
    items: [{ label: 'object', caption: '山', bbox: [10, 20, 300, 400] }],
  }
  const variants = [
    ['empty draft', { ...base, items: [] }, /画框/],
    ['missing caption', { ...base, summary: { caption: '   ' } }, /summary\.caption/],
    // 992 is a legal draft side (multiple of 16) but 1536/992 is 3.2% off 3:2.
    ['stretched draft', { ...base, height: 992 }, /七档/],
  ]
  for (const [label, draft, expected] of variants) {
    const { network, panel, requests } = await mountGeneration(() => Promise.resolve(fakeResponse({ error: 'no' }, 500)), layoutBoard(draft))
    try {
      layoutGenerateButton(panel).props.onClick()
      await settle(panel)
      assert.equal(requests.length, 0, label + ': nothing may be submitted')
      assert.match(noteText(panel), expected, label + ': the refusal explains the fix')
    } finally {
      network.restore()
    }
  }
})

test('C14: a failed task is stored on the board and removed again when retried', async () => {
  const retry = deferredResponse()
  const { network, panel } = await mountGeneration((index) => (index === 0
    ? fakeResponse({ error: 'CUDA out of memory' }, 500)
    : retry.promise))
  try {
    await typePrompt(panel, '一只橘猫')
    buttonWithText(panel, '生成').props.onClick()
    await settle(panel)

    const saves = boardMutations(network).filter((call) => call.action === 'save-task')
    assert.equal(saves.length, 1, 'the terminal failure is written (§4.6)')
    assert.equal(saves[0].task.status, 'failed')
    assert.equal(saves[0].task.error, 'CUDA out of memory')
    assert.equal(typeof saves[0].x, 'number')
    assert.equal(typeof saves[0].y, 'number')
    const storedId = taskNodeElement(panel).props['data-node-id']
    assert.equal(saves[0].item, storedId, 'the node id is offered to the store')

    // Retry removes the stored failure first: a running task is never persisted,
    // so a reload after the retry must not show yesterday's node next to it.
    buttonWithText(panel, '重试').props.onClick()
    await settle(panel)
    const removals = boardMutations(network).filter((call) => call.action === 'remove-item')
    assert.ok(removals.some((call) => call.item === storedId), 'the stale board entry is removed before the retry')
  } finally {
    network.restore()
  }
})

test('C14: a new layout node is written after the debounce and removed with its entry', async () => {
  const { network, panel } = await mountWorkbench()
  try {
    buttonWithText(panel, '新建布局').props.onClick()
    await settle(panel)
    assert.equal(boardMutations(network).filter((call) => call.action === 'save-layout-node').length, 0, 'the write is debounced')

    await new Promise((resolve) => setTimeout(resolve, 650))
    await settle(panel)
    const saves = boardMutations(network).filter((call) => call.action === 'save-layout-node')
    assert.equal(saves.length, 1, 'one write per editing burst')
    assert.equal(saves[0].draft.width, 1536)
    assert.equal(saves[0].draft.height, 1024)
    assert.equal(saves[0].w, 480)
    assert.equal(saves[0].h, 420)
    const nodeId = nodesOfKind(panel, 'layout')[0].props['data-node-id']
    assert.equal(saves[0].item, nodeId, 'the first write keeps the canvas id')

    // C14: removal now targets that stored entry (it is no longer canvas-only).
    canvasElement(panel).props.onKeyDown(keyEvent('Delete'))
    await settle(panel)
    assert.equal(nodesOfKind(panel, 'layout').length, 0)
    const removals = boardMutations(network).filter((call) => call.action === 'remove-item')
    assert.ok(removals.some((call) => call.item === nodeId), 'the stored layout entry is removed')
  } finally {
    network.restore()
  }
})

// ---------------------------------------------------------------------------
// C15: incremental layout save (DD12) and the activated §6.4 entries.
// ---------------------------------------------------------------------------

test('C15: a layout save carries only the dirty nodes, and the camera only when it moved', async () => {
  const { network, panel, restoreFrames } = await mountCanvasWorkbench()
  try {
    // Drag one node: the debounced flush must send that node alone.
    nodeElements(panel)[0].props.onPointerDown(pointerEvent({ clientX: 10, clientY: 10 }))
    await settle(panel)
    canvasElement(panel).props.onPointerMove(pointerEvent({ clientX: 60, clientY: 40 }))
    await settle(panel)
    canvasElement(panel).props.onPointerUp({})
    await settle(panel)
    await new Promise((resolve) => setTimeout(resolve, 750))
    await settle(panel)

    // Stale debounce timers from earlier panels may fire into this test's stub
    // (they carry their own board id); only this board's writes are this test's.
    const canvasLayouts = () => boardMutations(network)
      .filter((call) => call.action === 'layout' && call.board === HARNESS_BOARD.id)
    let layouts = canvasLayouts()
    assert.equal(layouts.length, 1, 'one debounced write')
    assert.deepEqual(layouts[0].items.map((entry) => entry.id), ['iaaa1'], 'only the dragged node is sent')
    assert.equal('camera' in layouts[0], false, 'an unchanged camera is not resent')

    // Pan in hand mode: only the camera changed, so the body is an empty diff + camera.
    buttonWithText(panel, '平移').props.onClick()
    await settle(panel)
    canvasElement(panel).props.onPointerDown(pointerEvent({ clientX: 100, clientY: 100 }))
    canvasElement(panel).props.onPointerMove(pointerEvent({ clientX: 160, clientY: 130 }))
    await settle(panel)
    canvasElement(panel).props.onPointerUp({})
    await settle(panel)
    await new Promise((resolve) => setTimeout(resolve, 750))
    await settle(panel)

    layouts = canvasLayouts()
    assert.equal(layouts.length, 2)
    assert.deepEqual(layouts[1].items, [], 'a pan dirties no node')
    assert.deepEqual(layouts[1].camera, { x: -60, y: -30, zoom: 1 }, 'the moved camera is saved')

    // The next drag carries only its own node and no camera: the previous write
    // cleared both the dirty set and the sent-camera baseline.
    nodeElements(panel)[1].props.onPointerDown(pointerEvent({ clientX: 610, clientY: 10 }))
    await settle(panel)
    canvasElement(panel).props.onPointerMove(pointerEvent({ clientX: 640, clientY: 10 }))
    await settle(panel)
    canvasElement(panel).props.onPointerUp({})
    await settle(panel)
    await new Promise((resolve) => setTimeout(resolve, 750))
    await settle(panel)
    layouts = canvasLayouts()
    assert.equal(layouts.length, 3)
    assert.deepEqual(layouts[2].items.map((entry) => entry.id), ['ibbb2'])
    assert.equal('camera' in layouts[2], false)
  } finally {
    restoreFrames()
    network.restore()
  }
})

test('C15: the blank menu creates a layout node from its now-live entry', async () => {
  const { network, panel } = await mountWorkbench()
  try {
    assert.equal(nodesOfKind(panel, 'layout').length, 0)
    canvasElement(panel).props.onContextMenu(pointerEvent({ clientX: 40, clientY: 40 }))
    await settle(panel)
    const create = menuEntries(panel).find((entry) => fakeText(entry) === '新建布局节点')
    assert.ok(create !== undefined, 'the blank menu must offer the layout entry')
    assert.notEqual(create.props.disabled, true, 'C15 activated it')
    create.props.onClick()
    await settle(panel)
    assert.equal(nodesOfKind(panel, 'layout').length, 1)
    assert.equal(menuEntries(panel), undefined, 'running a menu item closes the menu')
  } finally {
    network.restore()
  }
})

// ---------------------------------------------------------------------------
// P2: start / stop ComfyUI from the workbench.
//
// Two layers, tested separately on purpose: the *route* owns the guards (origin,
// single-flight, ownership) and is exercised through a fake web server with
// injected machine seams, so nothing here spawns Python or kills anything; the
// *panel* is exercised through the built client bundle with a stubbed fetch.
// ---------------------------------------------------------------------------

/** A minimal Comfy Desktop fixture: a usable install plus the registry naming it. */
function makeEnvironmentMachine() {
  const root = mkdtempSync(join(tmpdir(), 'forge-studio-env-'))
  const installPath = join(root, 'ComfyUI-Installs', 'ComfyUI')
  const mainPy = join(installPath, 'ComfyUI', 'main.py')
  mkdirSync(dirname(mainPy), { recursive: true })
  writeFileSync(mainPy, '# fake ComfyUI main.py\n')
  const venv = join(installPath, 'ComfyUI', '.venv')
  const python = join(venv, 'Scripts', 'python.exe')
  mkdirSync(dirname(python), { recursive: true })
  writeFileSync(python, '')
  mkdirSync(join(venv, 'Lib', 'site-packages', 'torch'), { recursive: true })
  const desktop = join(root, 'Comfy Desktop')
  mkdirSync(desktop, { recursive: true })
  writeFileSync(join(desktop, 'installations.json'), JSON.stringify([
    { id: 'inst-p2', name: 'ComfyUI', status: 'installed', installPath, port: 18188, launchArgs: '', envVars: {} },
  ]))
  return { root, installPath, mainPy, python }
}

/** The settings shape the routes read; the environment route never asks for more. */
function environmentRouteSettings(machine) {
  return {
    comfyEndpoint: '',
    comfyPorts: [18188],
    comfyModelsDir: '',
    timeoutMs: 500,
    outputDir: machine.root,
    defaultSteps: 20,
    comfyuiSteps: undefined,
    comfyModel: 'qwen21-base',
    turboSteps: undefined,
  }
}

/** Register the routes against a fake web server and return them by path. */
function routeHandlers(deps) {
  const routes = new Map()
  const ctx = {
    webServer: { register: ({ path, handler }) => { routes.set(path, handler); return () => {} } },
    get: () => undefined,
    logger: { warn() {} },
  }
  registerStudioRoutes(ctx, { ...deps, ctx })
  return routes
}

/** One POST through a registered handler, captured as `{ status, body }`. */
async function exchange(handler, body) {
  const payload = Buffer.from(JSON.stringify(body))
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1:51791', origin: 'http://127.0.0.1:51791' },
    async *[Symbol.asyncIterator]() { yield payload },
    once() {},
  }
  const res = {
    status: 0,
    headers: {},
    text: '',
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    writeHead(status, headers) { this.status = status; this.headers = headers ?? {}; this.headersSent = true; return this },
    write(chunk) { this.text += String(chunk); return true },
    end(chunk) { if (chunk !== undefined) this.text += String(chunk); this.writableEnded = true; return this },
    once() {},
    on() {},
    removeListener() {},
  }
  await handler(req, res)
  return { status: res.status, headers: res.headers, text: res.text, body: res.text.length > 0 ? JSON.parse(res.text) : undefined }
}

test('P2: the environment route answers status, and a second start in flight is refused', async () => {
  const machine = makeEnvironmentMachine()
  try {
    const routes = routeHandlers({
      settings: () => environmentRouteSettings(machine),
      environment: {
        options: () => ({ endpoint: '', ports: [18188], probeTimeoutMs: 60, installTimeoutMs: 120, waitIntervalMs: 20 }),
        deps: {
          env: {},
          platform: 'win32',
          appData: machine.root,
          scanRoots: [],
          fetchImpl: async () => { throw new Error('connect ECONNREFUSED') },
          spawn: () => ({ pid: 3131, exitCode: null, unref() {} }),
          // Blocks long enough for a second click to arrive, then reports free.
          portProbe: () => new Promise((resolve) => setTimeout(() => resolve(false), 200)),
          commandLineOf: () => null,
          kill: () => {},
        },
      },
    })
    const handler = routes.get(STUDIO_ENVIRONMENT_ROUTE)
    assert.equal(typeof handler, 'function', 'the environment route must be registered')

    const status = await exchange(handler, { action: 'status' })
    assert.equal(status.status, 200)
    assert.equal(status.body.environment.state, 'not-running')
    assert.equal(status.body.environment.owned, false, 'a record-less install owns nothing')
    assert.match(String(status.body.environment.note), /安装/)

    // Click twice: the second must be refused instead of spawning a second Python.
    const first = exchange(handler, { action: 'start' })
    await new Promise((resolve) => setTimeout(resolve, 60))
    const second = await exchange(handler, { action: 'start' })
    assert.equal(second.status, 409, 'one start at a time, even from a double click')
    assert.match(String(second.body.error), /正在启动/)
    const finished = await first
    assert.equal(finished.status, 200)
    assert.equal(finished.body.environment.state, 'timeout', 'the fake renderer never answers')
    assert.equal(finished.body.environment.owned, false)

    // An unknown action is a refusal, not a silent read.
    const typo = await exchange(handler, { action: 'restart' })
    assert.equal(typo.status, 400)
    assert.match(String(typo.body.error), /未知的环境操作/)

    // A stop after a failed start: the record from the failed attempt exists, but
    // its pid cannot be proved to be ours (no command line), so nothing is killed.
    // The refusal crosses the wire instead of the plugin guessing.
    const stop = await exchange(handler, { action: 'stop' })
    assert.equal(stop.status, 200)
    assert.equal(stop.body.stop.stopped, false)
    assert.equal(stop.body.stop.reason, 'unverified')
    assert.match(String(stop.body.stop.note), /无法确认/)
    assert.equal(stop.body.environment.state, 'not-running')
  } finally {
    rmSync(machine.root, { recursive: true, force: true })
  }
})

test('P2: a not-ready panel offers 启动, and clicking it posts the action', async () => {
  const { network, panel } = await mountWorkbench({
    configOverrides: { ready: false, reason: 'ComfyUI 没在跑（connect ECONNREFUSED）' },
    environment: (body) => (body.action === 'start'
      ? { environment: { state: 'ready', owned: true, pid: 4242, endpoint: 'http://127.0.0.1:8188', note: '已后台拉起 ComfyUI' } }
      : { environment: { state: 'not-running', owned: false, note: '找到安装，可以启动' } }),
  })
  try {
    const start = buttonWithText(panel, '启动')
    assert.ok(start !== undefined, 'a not-ready status line must offer 启动')
    assert.equal(start.props.disabled, undefined, 'the start button is enabled')

    start.props.onClick()
    await settle(panel)

    const posts = network.calls.filter((call) => call.url.indexOf(STUDIO_ENVIRONMENT_ROUTE) === 0 && call.method === 'POST')
    // The mount already posted one `status`; the click must add a `start`.
    const starts = posts.filter((call) => call.body === JSON.stringify({ action: 'start' }))
    assert.equal(starts.length, 1, 'the click must post exactly one start')
    // `loadConfig` re-reads the snapshot afterwards, so the line follows the host.
    assert.ok(
      posts.slice(posts.indexOf(starts[0]) + 1).some((call) => String(call.body).includes('"status"')),
      'a start is followed by a status re-read',
    )
  } finally {
    network.restore()
  }
})

test('P2: a failed start prints the host note and the log path verbatim', async () => {
  const { network, panel } = await mountWorkbench({
    configOverrides: { ready: false, reason: '未就绪' },
    environment: (body) => (body.action === 'start'
      ? { environment: { state: 'launch-failed', owned: false, note: '端口被占：18188 上已有进程在监听', logPath: 'C:/logs/launch-x.log' } }
      : { environment: { state: 'not-running', owned: false } }),
  })
  try {
    const start = buttonWithText(panel, '启动')
    assert.ok(start !== undefined)
    start.props.onClick()
    await settle(panel)

    const hints = noteText(panel)
    assert.ok(hints.includes('端口被占'), 'the host note must be shown: ' + hints)
    assert.ok(hints.includes('C:/logs/launch-x.log'), 'the log path is what makes a failure actionable')
  } finally {
    network.restore()
  }
})

test('P2: a running instance the plugin started offers 停止, and confirm gates it', async () => {
  const answers = []
  let confirmed = false
  harnessConfirm = () => confirmed
  const { network, panel } = await mountWorkbench({
    environment: (body) => {
      answers.push(body.action)
      return body.action === 'stop'
        ? { environment: { state: 'not-running', owned: false }, stop: { stopped: true, pid: 4242, exitCode: 0, note: '已停止本插件拉起的 pid 4242' } }
        : { environment: { state: 'ready', owned: true, pid: 4242, endpoint: 'http://127.0.0.1:8188', note: 'ComfyUI 在跑' } }
    },
  })
  try {
    const endpointLine = fakeElementWithClass(panel.tree, 'dsh-forge-studio-endpoint')
    assert.ok(endpointLine !== undefined)
    assert.ok(fakeText(endpointLine).includes('本次由插件拉起'), 'the panel must say the process outlives it')
    assert.ok(fakeText(endpointLine).includes('pid 4242'))

    const stop = buttonWithText(panel, '停止')
    assert.ok(stop !== undefined, 'an owned instance offers 停止')
    assert.notEqual(stop.props.disabled, true)

    const stopPosts = () => network.calls.filter((call) => call.url.indexOf(STUDIO_ENVIRONMENT_ROUTE) === 0 && String(call.body).includes('"stop"'))
    confirmed = false
    stop.props.onClick()
    await settle(panel)
    assert.equal(stopPosts().length, 0, 'a declined confirm must not stop anything')

    confirmed = true
    buttonWithText(panel, '停止').props.onClick()
    await settle(panel)
    assert.equal(stopPosts().length, 1, 'a confirmed stop is posted once')
    assert.ok(answers.includes('stop'))
  } finally {
    harnessConfirm = () => true
    network.restore()
  }
})

test('P2: an instance the user started is not offered a stop button', async () => {
  const { network, panel } = await mountWorkbench({
    environment: () => ({ environment: { state: 'ready', owned: false, pid: 9001, endpoint: 'http://127.0.0.1:8188' } }),
  })
  try {
    const stop = buttonWithText(panel, '停止')
    assert.ok(stop !== undefined, 'the button stays visible, so the absence of an action is explicit')
    assert.equal(stop.props.disabled, true, 'the plugin never offers to kill a process it cannot claim')
    assert.ok(noteText(panel).includes('由你自己启动的实例'), 'the reason is printed next to it')
  } finally {
    network.restore()
  }
})


