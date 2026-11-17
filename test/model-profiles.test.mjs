/**
 * Model profiles: the data half of a model family, pinned.
 *
 * `src/model-profiles.ts` is pure data plus a handful of resolvers, so the
 * registry contract is asserted here without a server. The two claims that only
 * the wire can settle — MOSS text-to-image reaching `/prompt`, and a MOSS edit
 * being refused before anything is sent — run against a fake ComfyUI of the same
 * shape `test/comfyui-e2e.test.mjs` uses, so those assertions are about requests
 * and graphs, not about a helper's return value.
 *
 * The task book (docs/EXECUTION-PLAN.md §4 T01) asks for six things; every test
 * below names the step it pins.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  COMFY_MODEL_IDS,
  DEFAULT_COMFY_MODEL,
  DEFAULT_MOSS_SAMPLING,
  LEGACY_COMFY_MODEL_IDS,
  MODEL_PROFILES,
  MOSS_IMAGE_WORKFLOW,
  MOSS_LATENT_MULTIPLE,
  MOSS_NEGATIVE_PROMPT,
  MOSS_SAMPLING_PRESETS,
  QWEN_IMAGE_WORKFLOW,
  TURBO_SIGMAS,
  TURBO_STEPS,
  assertLatentAligned,
  editWorkflow,
  generateViaComfyUi,
  generateViaComfyUiEdit,
  isComfyModelId,
  loadComfyModels,
  presetSteps,
  renderWorkflow,
  resolveProfile,
  resolveSampling,
} from '../testlib/comfyui.js'
import { resolveSteps, resolveTurboSteps } from '../testlib/tools.js'

/** A real 1×1 PNG: the fake server serves this and the adapter must return it byte for byte. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

/** MOSS's fake `/object_info`, with the Qwen family installed on the same machine too. */
const BOTH_FAMILIES_OBJECT_INFO = {
  UNETLoader: {
    input: {
      required: {
        unet_name: [
          [
            'qwen_image_2.1_int8_convrot.safetensors',
            'qwen_image_2.1_turbo_int8_convrot.safetensors',
            'moss_image_sft_int8_convrot.safetensors',
            'moss_image_sft_bf16.safetensors',
          ],
          {},
        ],
        weight_dtype: [['default', 'fp8_e4m3fn'], {}],
      },
    },
  },
  CLIPLoader: {
    input: {
      required: {
        clip_name: [
          [
            'qwen3vl_8b_int8_convrot.safetensors',
            // Qwen-Image's prompt enhancer is also a Qwen3.5 file; MOSS must not take it.
            'qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors',
            'qwen3.5_9b_w4a8_gptq.safetensors',
          ],
          {},
        ],
        type: [['stable_diffusion', 'qwen_image', 'moss_image'], {}],
      },
    },
  },
  VAELoader: {
    input: { required: { vae_name: [['qwen_image_2.1_vae_bf16.safetensors', 'flux2-vae_small.safetensors'], {}] } },
  },
}

const PROMPT_ID = 'profile-test-prompt'

/**
 * Start a fake ComfyUI that speaks the four endpoints the adapter uses and
 * records every request, so "nothing was sent" is observable.
 *
 * @param objectInfo - the `/object_info` bodies, keyed by node class.
 */
async function startFakeComfy(objectInfo) {
  const seen = []
  const state = { historyCalls: 0, graph: undefined }
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      const url = new URL(request.url, 'http://127.0.0.1')
      seen.push({ method: request.method, path: url.pathname, body })
      const send = (status, payload, type = 'application/json') => {
        response.writeHead(status, { 'Content-Type': type })
        response.end(payload)
      }
      if (url.pathname.startsWith('/object_info/')) {
        const node = url.pathname.slice('/object_info/'.length)
        return send(200, JSON.stringify(node in objectInfo ? { [node]: objectInfo[node] } : {}))
      }
      if (url.pathname === '/prompt' && request.method === 'POST') {
        state.graph = JSON.parse(body).prompt
        return send(200, JSON.stringify({ prompt_id: PROMPT_ID, number: 1, node_errors: {} }))
      }
      if (url.pathname === `/history/${PROMPT_ID}`) {
        state.historyCalls += 1
        if (state.historyCalls < 2) return send(200, JSON.stringify({}))
        return send(
          200,
          JSON.stringify({
            [PROMPT_ID]: {
              outputs: { '10': { images: [{ filename: 'dsh-image-forge-moss_00001_.png', subfolder: '', type: 'output' }] } },
              status: { status_str: 'success', completed: true, messages: [['execution_success', { prompt_id: PROMPT_ID }]] },
            },
          }),
        )
      }
      if (url.pathname === '/view') return send(200, PNG_1X1, 'image/png')
      return send(404, JSON.stringify({}))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const endpoint = `http://127.0.0.1:${port}`
  return {
    seen,
    state,
    port,
    endpoint,
    target: { endpoint, port, probed: [] },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** The adapter options one call needs; discovery is bypassed by passing the endpoint. */
function optionsFor(comfy, overrides = {}) {
  return { endpoint: comfy.endpoint, ports: [], modelsDir: 'D:\\models', timeoutMs: 5_000, pollIntervalMs: 1, ...overrides }
}

// ---------------------------------------------------------------------------
// T01 step 2: the registry contract.
// ---------------------------------------------------------------------------

test('the profile registry is total: three canonical ids, two legacy spellings, one default', () => {
  assert.deepEqual([...COMFY_MODEL_IDS], ['qwen21-base', 'qwen21-turbo', 'moss-sft'])
  assert.deepEqual([...LEGACY_COMFY_MODEL_IDS], ['base', 'turbo'])
  assert.equal(DEFAULT_COMFY_MODEL, 'qwen21-base')

  // Compatibility: a saved document that says `base` / `turbo` keeps meaning what it meant.
  assert.equal(resolveProfile('base').id, 'qwen21-base')
  assert.equal(resolveProfile('turbo').id, 'qwen21-turbo')
  assert.equal(resolveProfile(' base ').id, 'qwen21-base', 'surrounding space is config noise, not a new id')
  for (const id of COMFY_MODEL_IDS) assert.equal(resolveProfile(id).id, id, id)

  // A typo or a missing value resolves to the default instead of throwing: a bad
  // config must not make the plugin unusable.
  for (const bad of [undefined, null, '', 'qwne21-base', 'moss', 'MOSS-SFT']) {
    assert.equal(resolveProfile(bad).id, DEFAULT_COMFY_MODEL, `unexpected fallback for ${JSON.stringify(bad)}`)
  }

  // `isComfyModelId` guards the canonical three only; a legacy spelling is not canonical.
  assert.equal(isComfyModelId('moss-sft'), true)
  assert.equal(isComfyModelId('base'), false)
  assert.equal(isComfyModelId(0), false)
  assert.equal(isComfyModelId(undefined), false)

  for (const profile of Object.values(MODEL_PROFILES)) {
    assert.ok(isComfyModelId(profile.id), `${profile.id} is not a canonical id`)
    assert.ok(profile.label.length > 0)
    assert.ok(profile.legacyIds.every((legacy) => resolveProfile(legacy).id === profile.id))
  }
})

test('every profile declares its own latent node, clip type, sampler and filename prefix', () => {
  /** The per-family data table; a profile change should show up as a diff right here. */
  const CONTRACT = {
    'qwen21-base': {
      family: 'qwen-image-2.1',
      variant: 'base',
      legacyLabel: 'base',
      latent: { classType: 'EmptyLatentImage', multiple: 32 },
      clipTypes: ['qwen_image'],
      sampler: { node: 'KSampler', name: 'euler', scheduler: 'simple', cfg: 1 },
      steps: { default: 40 },
      negativePrompt: '',
      filenamePrefix: 'dsh-image-forge',
      edit: true,
    },
    'qwen21-turbo': {
      family: 'qwen-image-2.1',
      variant: 'turbo',
      legacyLabel: 'turbo',
      latent: { classType: 'EmptyLatentImage', multiple: 32 },
      clipTypes: ['qwen_image'],
      sampler: { node: 'SamplerCustomAdvanced', name: 'euler', scheduler: 'simple', cfg: 1 },
      steps: { default: TURBO_STEPS, sigmas: TURBO_SIGMAS },
      negativePrompt: '',
      filenamePrefix: 'dsh-image-forge-turbo',
      edit: true,
    },
    'moss-sft': {
      family: 'moss-image',
      variant: 'sft',
      legacyLabel: 'moss',
      latent: { classType: 'EmptyFlux2LatentImage', multiple: MOSS_LATENT_MULTIPLE },
      clipTypes: ['moss_image'],
      sampler: { node: 'KSampler', name: 'er_sde', scheduler: 'simple', cfg: 2.5 },
      steps: { default: 25 },
      negativePrompt: MOSS_NEGATIVE_PROMPT,
      filenamePrefix: 'dsh-image-forge-moss',
      edit: true,
    },
  }

  assert.equal(MOSS_LATENT_MULTIPLE, 16)

  for (const [id, expected] of Object.entries(CONTRACT)) {
    const profile = MODEL_PROFILES[id]
    assert.ok(profile !== undefined, `missing profile ${id}`)
    console.log('profile contract:', id, JSON.stringify({ latent: profile.latent, sampler: profile.sampler, steps: profile.steps }))
    assert.equal(profile.family, expected.family)
    assert.equal(profile.variant, expected.variant)
    assert.equal(profile.legacyLabel, expected.legacyLabel)
    assert.deepEqual({ classType: profile.latent.classType, multiple: profile.latent.multiple }, expected.latent)
    assert.deepEqual([...profile.clipType.prefer], expected.clipTypes)
    assert.deepEqual({ ...profile.sampler }, expected.sampler)
    assert.deepEqual({ ...profile.steps }, expected.steps)
    assert.equal(profile.negativePrompt, expected.negativePrompt)
    assert.equal(profile.filenamePrefix, expected.filenamePrefix)
    assert.equal(profile.imageToImage !== undefined, expected.edit, `${id} edit availability`)
    assert.ok(Object.keys(profile.textToImage).length > 0, `${id} has no text-to-image graph`)
    if (expected.edit) {
      assert.equal(typeof profile.imageToImage.build, 'function')
      assert.ok(Object.keys(profile.imageToImage.template).length > 0)
    }
  }

  // Qwen's cliptype accepts any `/qwen/i` fallback; MOSS deliberately has none, so
  // a Qwen-only ComfyUI can never be mistaken for a MOSS-capable one.
  assert.deepEqual(MODEL_PROFILES['qwen21-base'].clipType.fallback, /qwen/i)
  assert.equal(MODEL_PROFILES['moss-sft'].clipType.fallback, undefined)

  // Latent alignment is a per-profile contract, not a global 32: MOSS's latent node
  // accepts 16-multiples, and a canvas that is only 16-aligned is refused by Qwen.
  assertLatentAligned(MODEL_PROFILES['moss-sft'], 1040, 1040)
  assert.throws(() => assertLatentAligned(MODEL_PROFILES['qwen21-base'], 1040, 1040), /32/)
  assert.throws(() => assertLatentAligned(MODEL_PROFILES['moss-sft'], 1030, 1024), /16/)

  // MOSS offers an edit graph too, built from the same `{ template, build }`
  // contract as the Qwen profiles; T19 filled it in and the old refusal is gone.
  const mossEdit = MODEL_PROFILES['moss-sft'].imageToImage
  assert.notEqual(mossEdit, undefined)
  assert.equal(typeof mossEdit.build, 'function')
  const mossEditGraph = mossEdit.build(['ref-a.png'])
  const mossEditClasses = Object.values(mossEditGraph).map((node) => node.class_type)
  for (const present of ['LoraLoaderModelOnly', 'TextEncodeMOSSImageEdit', 'LoadImage', 'ImageScale']) {
    assert.ok(mossEditClasses.includes(present), `MOSS edit graph must carry ${present}`)
  }
  assert.equal(mossEditGraph['2'].inputs.lora_name, 'moss_image_edit_lora_rank_64_bf16.safetensors')
  assert.deepEqual(mossEditGraph['2'].inputs.model, ['1', 0])
  assert.equal(mossEditGraph['7'].inputs.edit_format, 'Moss-Image-Edit')
  assert.deepEqual(mossEditGraph['7'].inputs['images.image_0'], ['121', 0])
})

test('each profile owns a graph, and every placeholder in it is filled', () => {
  /** One value set serves every template: `renderWorkflow` touches declared placeholders only. */
  const values = {
    unet_name: 'u.safetensors',
    weight_dtype: 'default',
    clip_name: 'c.safetensors',
    clip_type: 'any',
    vae_name: 'v.safetensors',
    resolution: 1024,
    prompt: 'A brass compass on slate.',
    negative_prompt: 'nsfw',
    width: 1024,
    height: 768,
    batch_size: 2,
    seed: 42,
    steps: 25,
    cfg: 1,
    sampler_name: 'euler',
    scheduler: 'simple',
    sigmas: TURBO_SIGMAS,
    filename_prefix: 'x',
  }

  const moss = renderWorkflow(MOSS_IMAGE_WORKFLOW, values)
  const mossClasses = Object.values(moss).map((node) => node.class_type)
  console.log('MOSS workflow node classes:', JSON.stringify(mossClasses))
  for (const present of ['UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'EmptyFlux2LatentImage', 'SkipLayerGuidanceDiTSimple', 'KSampler', 'VAEDecode', 'SaveImage']) {
    assert.ok(mossClasses.includes(present), `MOSS graph must carry ${present}`)
  }
  // The MOSS graph must not smuggle in the Qwen nodes, and it has no manual sigma
  // schedule at all (MOSS runs the model's own shift, not a distilled one).
  for (const absent of ['TextEncodeQwenImage21', 'EmptyLatentImage', 'SamplerCustomAdvanced', 'ManualSigmas']) {
    assert.ok(!mossClasses.includes(absent), `MOSS graph must not carry ${absent}`)
  }
  assert.equal(moss['4'].class_type, 'CLIPTextEncode')
  assert.equal(moss['6'].class_type, 'EmptyFlux2LatentImage')
  assert.equal(moss['6'].inputs.width, 1024, 'whole-string placeholders keep their type')
  assert.equal(moss['6'].inputs.batch_size, 2)
  assert.equal(moss['8'].inputs.latent_image[0], '6')

  const qwen = renderWorkflow(QWEN_IMAGE_WORKFLOW, values)
  const qwenClasses = Object.values(qwen).map((node) => node.class_type)
  assert.equal(qwen['4'].class_type, 'TextEncodeQwenImage21')
  assert.equal(qwen['5'].class_type, 'EmptyLatentImage')
  assert.equal(qwen['6'].class_type, 'KSampler')
  assert.ok(!qwenClasses.includes('CLIPTextEncode'), 'the Qwen graph must keep its dual-output encoder')
  assert.ok(!qwenClasses.includes('EmptyFlux2LatentImage'))

  // An edit graph is the same skeleton plus one autogrow `LoadImage` slot per
  // reference; the profile's builder is the only thing that has to change.
  assert.equal(MODEL_PROFILES['qwen21-base'].imageToImage.build, editWorkflow)
  const edit = editWorkflow(['ref-a.png', 'ref-b.png'])
  assert.equal(edit['11'].class_type, 'LoadImage')
  assert.equal(edit['12'].class_type, 'LoadImage')
  assert.deepEqual(edit['4'].inputs['images.image_1'], ['11', 0])
  assert.deepEqual(edit['4'].inputs['images.image_2'], ['12', 0])
  // The MOSS edit graph renders against the same canvas: its latent node takes the
  // placeholder size, and each reference scaler targets that size too.
  const mossEditRendered = renderWorkflow(MODEL_PROFILES['moss-sft'].imageToImage.build(['ref-a.png']), values)
  const mossEditRenderedClasses = Object.values(mossEditRendered).map((node) => node.class_type)
  assert.ok(mossEditRenderedClasses.includes('LoraLoaderModelOnly'))
  assert.ok(mossEditRenderedClasses.includes('TextEncodeMOSSImageEdit'))
  assert.equal(mossEditRendered['5'].inputs.width, 1024)
  assert.equal(mossEditRendered['121'].inputs.width, 1024)
  assert.deepEqual(mossEditRendered['121'].inputs.image, ['101', 0])

  for (const graph of [moss, renderWorkflow(edit, values), mossEditRendered]) {
    for (const node of Object.values(graph)) {
      assert.ok(!JSON.stringify(node.inputs).includes('{{'), 'no placeholder may survive rendering')
    }
  }
})

// ---------------------------------------------------------------------------
// T01 step 3: MOSS's two sampling registers.
// ---------------------------------------------------------------------------

test('MOSS publishes two sampling registers; the Qwen profiles ignore the setting', () => {
  assert.deepEqual([...MOSS_SAMPLING_PRESETS], ['comfy', 'official'])
  assert.equal(DEFAULT_MOSS_SAMPLING, 'comfy')

  const moss = MODEL_PROFILES['moss-sft']
  // The profile's own pair *is* the default register, so the shipped behaviour cannot move.
  assert.equal(moss.defaultPreset, 'comfy')
  assert.deepEqual({ ...moss.samplingPresets.comfy.sampler }, { node: 'KSampler', name: 'er_sde', scheduler: 'simple', cfg: 2.5 })
  assert.deepEqual({ ...moss.samplingPresets.comfy.steps }, { default: 25 })
  assert.deepEqual({ ...moss.samplingPresets.official.sampler }, { node: 'KSampler', name: 'euler', scheduler: 'simple', cfg: 3 })
  assert.deepEqual({ ...moss.samplingPresets.official.steps }, { default: 50 })
  assert.deepEqual({ ...moss.sampler }, { ...moss.samplingPresets.comfy.sampler })
  assert.deepEqual({ ...moss.steps }, { ...moss.samplingPresets.comfy.steps })

  const shipped = resolveSampling(moss, 'comfy')
  console.log('MOSS comfy register:', JSON.stringify(shipped))
  assert.equal(shipped.preset, 'comfy')
  assert.deepEqual({ ...shipped.sampler }, { node: 'KSampler', name: 'er_sde', scheduler: 'simple', cfg: 2.5 })
  assert.equal(shipped.steps.default, 25)

  const official = resolveSampling(moss, 'official')
  console.log('MOSS official register:', JSON.stringify(official))
  assert.equal(official.preset, 'official')
  assert.deepEqual({ ...official.sampler }, { node: 'KSampler', name: 'euler', scheduler: 'simple', cfg: 3 })
  assert.equal(official.steps.default, 50)

  // Absent or stale values fall back to the profile's own pair, never to a half-filled graph.
  for (const preset of [undefined, 'karras']) {
    const fallback = resolveSampling(moss, preset)
    assert.equal(fallback.preset, undefined)
    assert.deepEqual({ ...fallback.sampler }, { ...moss.sampler })
    assert.equal(fallback.steps.default, 25)
  }

  // A published register owns its step count, the default one included: MOSS's
  // counts are model properties, so the Qwen-tuned `defaultSteps` never moves them.
  assert.equal(presetSteps(moss, 'comfy'), 25)
  assert.equal(presetSteps(moss, 'official'), 50)
  assert.equal(presetSteps(moss, undefined), undefined)
  assert.equal(presetSteps(moss, 'karras'), undefined)

  // Both Qwen profiles have no register table: any `mossSampling` is inert there.
  assert.equal(MODEL_PROFILES['qwen21-base'].samplingPresets, undefined)
  assert.equal(MODEL_PROFILES['qwen21-turbo'].samplingPresets, undefined)
  for (const id of ['qwen21-base', 'qwen21-turbo']) {
    const profile = MODEL_PROFILES[id]
    const selected = resolveSampling(profile, 'official')
    assert.equal(selected.preset, undefined, `${id} must not report a register`)
    assert.deepEqual({ ...selected.sampler }, { ...profile.sampler })
    assert.deepEqual({ ...selected.steps }, { ...profile.steps })
    assert.equal(presetSteps(profile, 'official'), undefined)
  }
  // Turbo keeps its distilled schedule whatever a register says.
  assert.equal(MODEL_PROFILES['qwen21-turbo'].steps.sigmas, TURBO_SIGMAS)
  assert.equal(MODEL_PROFILES['qwen21-turbo'].sampler.node, 'SamplerCustomAdvanced')
})

// ---------------------------------------------------------------------------
// T01 step 4: a MOSS edit used to be refused before anything was sent.
//
// T19 wired the edit graph, so the refusal is gone by construction: this now
// pins the *absence* of the old pre-flight rejection — the call gets as far as
// uploading the reference (where this deliberately upload-less fake stops)
// instead of throwing before any request.
// ---------------------------------------------------------------------------

test('a MOSS edit now reaches the reference upload instead of being refused', async () => {
  const comfy = await startFakeComfy(BOTH_FAMILIES_OBJECT_INFO)
  try {
    const mossModels = {
      unet: 'moss_image_sft_int8_convrot.safetensors',
      clip: 'qwen3.5_9b_w4a8_gptq.safetensors',
      vae: 'flux2-vae_small.safetensors',
      clipType: 'moss_image',
    }
    const request = {
      prompt: '只把标题换成「夏日特惠」。',
      width: 1024,
      height: 1024,
      count: 1,
      seed: 42,
      images: [{ bytes: PNG_1X1, mime: 'image/png', label: 'ref.png' }],
    }
    const error = await generateViaComfyUiEdit(comfy.target, mossModels, request, optionsFor(comfy, { comfyModel: 'moss-sft' })).then(
      () => undefined,
      (caught) => caught,
    )
    console.log('MOSS edit on a server without /upload/image:\n' + String(error && error.message))
    assert.equal(MODEL_PROFILES['moss-sft'].todo, undefined, 'the moss-edit TODO is gone')
    assert.notEqual(MODEL_PROFILES['moss-sft'].imageToImage, undefined)
    // It fails on the upload this fake does not serve, not on an upfront refusal.
    assert.ok(error instanceof Error)
    assert.match(error.message, /upload\/image/)
    assert.doesNotMatch(error.message, /未接入|换成 qwen21-base/)
    assert.deepEqual(
      comfy.seen.map((entry) => `${entry.method} ${entry.path}`),
      ['POST /upload/image'],
      'the only request is the reference upload, and no graph was submitted',
    )
    assert.equal(comfy.seen.filter((entry) => entry.path === '/prompt').length, 0)
  } finally {
    await comfy.close()
  }
})

// ---------------------------------------------------------------------------
// T01 step 5: MOSS text-to-image against a MOSS-capable fake server.
// ---------------------------------------------------------------------------

test('MOSS text-to-image: the profile selects its own weights with no "qwen" gate', async () => {
  const comfy = await startFakeComfy(BOTH_FAMILIES_OBJECT_INFO)
  try {
    const options = optionsFor(comfy, { comfyModel: 'moss-sft' })
    const models = await loadComfyModels(comfy.target, options)
    console.log('MOSS models:', JSON.stringify(models))
    assert.equal(models.unet, 'moss_image_sft_int8_convrot.safetensors')
    assert.equal(models.clip, 'qwen3.5_9b_w4a8_gptq.safetensors', 'the Qwen-Image prompt enhancer must not be taken')
    assert.equal(models.vae, 'flux2-vae_small.safetensors')
    assert.equal(models.clipType, 'moss_image')
    // The whole point of the profile: these are the files the old `/qwen/i` gate rejected.
    assert.ok(!/qwen/i.test(models.unet))
    assert.ok(!/qwen/i.test(models.vae))

    const images = await generateViaComfyUi(
      comfy.target,
      models,
      { prompt: 'A brass compass on slate.', width: 1024, height: 1024, count: 1, seed: 42 },
      options,
    )
    const graph = comfy.state.graph
    console.log('MOSS graph node classes:', JSON.stringify(Object.entries(graph).map(([id, node]) => [id, node.class_type])))
    const classes = Object.values(graph).map((node) => node.class_type)
    for (const present of ['EmptyFlux2LatentImage', 'SkipLayerGuidanceDiTSimple', 'KSampler', 'CLIPTextEncode', 'SaveImage']) {
      assert.ok(classes.includes(present), `MOSS graph must carry ${present}`)
    }
    for (const absent of ['TextEncodeQwenImage21', 'EmptyLatentImage', 'SamplerCustomAdvanced', 'ManualSigmas']) {
      assert.ok(!classes.includes(absent), `MOSS graph must not carry ${absent}`)
    }
    assert.equal(graph['2'].inputs.type, 'moss_image')
    assert.equal(graph['3'].inputs.vae_name, 'flux2-vae_small.safetensors')
    // MOSS's latent node wants a multiple of 16; the shared canvas policy's 32-aligned
    // sizes satisfy it without any family-specific pixel fork.
    assert.equal(graph['6'].class_type, 'EmptyFlux2LatentImage')
    assert.equal(graph['6'].inputs.width % MOSS_LATENT_MULTIPLE, 0)
    assert.equal(graph['6'].inputs.height % MOSS_LATENT_MULTIPLE, 0)
    assert.equal(graph['6'].inputs.width % 32, 0)
    // The default register's numbers, and MOSS's own negative prompt is the one wired in.
    assert.deepEqual(
      [graph['8'].inputs.steps, graph['8'].inputs.cfg, graph['8'].inputs.sampler_name, graph['8'].inputs.scheduler],
      [25, 2.5, 'er_sde', 'simple'],
    )
    assert.deepEqual(graph['8'].inputs.latent_image, ['6', 0])
    assert.equal(graph['5'].inputs.text, MOSS_NEGATIVE_PROMPT)
    assert.equal(graph['10'].inputs.filename_prefix, 'dsh-image-forge-moss')
    for (const node of Object.values(graph)) {
      assert.ok(!JSON.stringify(node.inputs).includes('{{'), 'no placeholder may survive rendering')
    }

    assert.equal(images.length, 1)
    assert.equal(images[0].mime, 'image/png')
    assert.deepEqual(Buffer.from(images[0].bytes), PNG_1X1)
    assert.equal(comfy.seen.filter((entry) => entry.path === '/prompt').length, 1)
    assert.equal(comfy.seen.filter((entry) => entry.path === '/view').length, 1)
  } finally {
    await comfy.close()
  }
})

// ---------------------------------------------------------------------------
// T01 step 6: step resolution under the MOSS profile.
// ---------------------------------------------------------------------------

test('step resolution: explicit > comfyuiSteps > register > defaultSteps, and turbo stays distilled', () => {
  /** The settings fields `resolveSteps` reads; `moss-sft` unless a case says otherwise. */
  const settingsFor = (overrides = {}) => ({
    comfyModel: 'moss-sft',
    defaultSteps: 25,
    comfyuiSteps: undefined,
    mossSampling: 'comfy',
    turboSteps: undefined,
    ...overrides,
  })

  // A published register owns the count: `defaultSteps` is the Qwen base default and
  // must not drag MOSS off its template's 25.
  assert.deepEqual(resolveSteps(undefined, settingsFor()), { steps: 25, source: 'default' })
  assert.deepEqual(resolveSteps(undefined, settingsFor({ defaultSteps: 40 })), { steps: 25, source: 'default' })
  // The other register brings its own working point (official: 50, not 25).
  console.log('MOSS official steps:', JSON.stringify(resolveSteps(undefined, settingsFor({ mossSampling: 'official' }))))
  assert.deepEqual(resolveSteps(undefined, settingsFor({ defaultSteps: 40, mossSampling: 'official' })), { steps: 50, source: 'default' })
  // ...but the caller's explicit count and the ComfyUI override still outrank it.
  assert.deepEqual(resolveSteps(12, settingsFor({ mossSampling: 'official' })), { steps: 12, source: 'explicit' })
  assert.deepEqual(resolveSteps(undefined, settingsFor({ mossSampling: 'official', comfyuiSteps: 30 })), { steps: 30, source: 'backend' })
  // An unset or unknown register falls back to `defaultSteps` (the Qwen base default).
  assert.deepEqual(
    resolveSteps(undefined, settingsFor({ mossSampling: undefined, defaultSteps: 40 })),
    { steps: 40, source: 'default' },
  )

  // A Qwen profile never sees the register: the setting only reaches families that publish one.
  assert.deepEqual(
    resolveSteps(undefined, settingsFor({ comfyModel: 'qwen21-base', defaultSteps: 40, mossSampling: 'official' })),
    { steps: 40, source: 'default' },
  )

  // Turbo: its own override, else the distilled 8 — never the base family's count
  // and never a register's. Handing 25 (or MOSS's 50) to a distilled checkpoint is
  // the classic way to make the picture worse while believing the config applied.
  assert.deepEqual(resolveTurboSteps(undefined, settingsFor({ comfyModel: 'qwen21-turbo' })), { steps: 8, source: 'default' })
  assert.deepEqual(
    resolveTurboSteps(undefined, settingsFor({ comfyModel: 'qwen21-turbo', defaultSteps: 40, mossSampling: 'official' })),
    { steps: 8, source: 'default' },
  )
  assert.deepEqual(resolveTurboSteps(undefined, settingsFor({ comfyModel: 'qwen21-turbo', turboSteps: 6 })), { steps: 6, source: 'backend' })
  assert.deepEqual(resolveTurboSteps(4, settingsFor({ comfyModel: 'qwen21-turbo', turboSteps: 6 })), { steps: 4, source: 'explicit' })
})
