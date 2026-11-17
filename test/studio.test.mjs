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
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  parseBoardAction,
  parseGenerate,
  parseOptimize,
} from '../testlib/studio-routes.js'
import {
  resolveStudioSteps,
  studioSize,
  studioSizeTable,
  studioSettingsOf,
} from '../testlib/studio-service.js'
import {
  DEFAULT_MOSS_SAMPLING,
  MODEL_PROFILES,
  MOSS_SAMPLING_PRESETS,
  TURBO_SIGMAS,
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
import { STUDIO_EVENTS_ROUTE, STUDIO_MAX_COUNT, STUDIO_MAX_PROMPT_CHARS, STUDIO_RATIOS } from '../testlib/studio-shared.js'
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
function clientEntry() {
  if (loadedClient !== undefined) return loadedClient
  const loaded = []
  const fakeWindow = {
    __ModuleLoader__: {
      load(spec) {
        loaded.push(spec)
      },
    },
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
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, method: init === undefined || init.method === undefined ? 'GET' : init.method })
    if (url.indexOf(STUDIO_CONFIG_ROUTE) === 0) return fakeResponse(HARNESS_CONFIG, 200)
    if (url.indexOf(STUDIO_BOARD_ROUTE) === 0) return fakeResponse({ error: 'no board in this harness' }, 404)
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

