/**
 * Step-scan of the ComfyUI backend's text-to-image path, over the same HTTP API the
 * plugin uses (`/prompt` then poll `/history`).
 *
 * Dev-only instrument. It exists to produce the *other* half of the comparison in
 * `bench-t2i-attribution.py`: the same canvas, the same prompt, the same step scan,
 * so the per-step slope can be fitted on both sides from wall-clock alone. ComfyUI
 * never reports a per-step time, but with steps in {1,2,4,8} its fixed cost (text
 * encode on GPU, VAE decode, first-call staging) falls out as the intercept.
 *
 *   node test/bench-t2i-comfyui.mjs [--endpoint http://127.0.0.1:8188]
 *                                   [--steps 1,2,4,8] [--width 992] [--height 992]
 *                                   [--seed 0] [--tag comfyui]
 *
 * The workflow mirrors `_comfyui_ref/verified_workflow_api.json` (the one already
 * verified against this install): UNETLoader(qwen_image_2.1_int8_convrot) →
 * KSampler(euler/simple, cfg 1) → VAEDecode → SaveImage. `cfg: 1` is deliberate:
 * it makes ComfyUI do one model evaluation per step, matching the diffusers side,
 * which runs without a negative prompt.
 *
 * Prints one JSON object per line. Nothing here is imported by the plugin.
 */

const DEFAULTS = {
  endpoint: 'http://127.0.0.1:8188',
  steps: '1,2,4,8',
  width: 992,
  height: 992,
  seed: 0,
  tag: 'comfyui',
}

function parseArgs(argv) {
  const args = { ...DEFAULTS }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (key === '--endpoint') args.endpoint = value
    else if (key === '--steps') args.steps = value
    else if (key === '--width') args.width = Number(value)
    else if (key === '--height') args.height = Number(value)
    else if (key === '--seed') args.seed = Number(value)
    else if (key === '--tag') args.tag = value
    else if (key === '--dry-run') {
      args.dryRun = true
      continue
    } else continue
    index += 1
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

function emit(kind, payload) {
  console.log(JSON.stringify({ kind, ...payload }))
}

/**
 * The verified workflow, with the canvas, step count and seed substituted in.
 *
 * The seed is a parameter because ComfyUI caches a node's output when its inputs are
 * unchanged: a warm-up that ran the identical graph made the following steps=1 run
 * return from cache in 0.27 s instead of actually sampling. Every measured run now
 * carries the caller's seed and the warm-up carries a different one, so no measured
 * run can be served from the cache.
 */
function workflow(steps, seed = args.seed) {
  return {
    1: {
      class_type: 'UNETLoader',
      inputs: { unet_name: 'qwen_image_2.1_int8_convrot.safetensors', weight_dtype: 'default' },
    },
    2: {
      class_type: 'CLIPLoader',
      inputs: { clip_name: 'qwen3vl_8b_int8_convrot.safetensors', type: 'qwen_image' },
    },
    3: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_2.1_vae_bf16.safetensors' } },
    4: {
      class_type: 'TextEncodeQwenImage21',
      inputs: {
        clip: ['2', 0],
        prompt:
          'A wide realistic photograph of a harbour at dawn, moored wooden boats along a stone quay, low warm sunlight raking across wet planks, soft mist over the water.',
        negative_prompt: '',
        resolution: 1024,
      },
    },
    5: {
      class_type: 'EmptyLatentImage',
      inputs: { width: args.width, height: args.height, batch_size: 1 },
    },
    6: {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        positive: ['4', 0],
        negative: ['4', 1],
        latent_image: ['5', 0],
        seed,
        steps,
        cfg: 1,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1,
      },
    },
    7: { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['3', 0] } },
    8: { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'bench-t2i' } },
  }
}

async function jsonOrThrow(response, what) {
  if (!response.ok) {
    throw new Error(`${what}: HTTP ${response.status} ${(await response.text()).slice(0, 400)}`)
  }
  return response.json()
}

/** One generation, timed from POST /prompt to the history entry being complete. */
async function runOnce(steps, label, seed = args.seed) {
  const clientId = `bench-${process.pid}-${steps}`
  const started = Date.now()
  const posted = await jsonOrThrow(
    await fetch(`${args.endpoint}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow(steps, seed), client_id: clientId }),
    }),
    'POST /prompt',
  )
  const promptId = posted.prompt_id
  if (!promptId) throw new Error(`POST /prompt returned no prompt_id: ${JSON.stringify(posted).slice(0, 300)}`)

  // Poll until the entry carries outputs (or an error traceback).
  let entry = null
  for (let attempt = 0; attempt < 6000; attempt += 1) {
    const history = await jsonOrThrow(await fetch(`${args.endpoint}/history/${promptId}`), 'GET /history')
    entry = history[promptId]
    if (entry && entry.status && entry.status.completed) break
    if (entry && entry.status && entry.status.status_str === 'error') break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const wallSeconds = (Date.now() - started) / 1000
  const failed = !entry || !entry.outputs || entry.status?.status_str === 'error'
  if (failed) throw new Error(`generation failed: ${JSON.stringify(entry?.status ?? {}).slice(0, 600)}`)

  const images = Object.values(entry.outputs).flatMap((output) => output.images ?? [])
  emit('run', {
    label,
    tag: args.tag,
    width: args.width,
    height: args.height,
    steps,
    seed,
    sampler: 'euler/simple',
    cfg: 1,
    wall_seconds: Number(wallSeconds.toFixed(2)),
    per_step_seconds: Number((wallSeconds / steps).toFixed(3)),
    images: images.length,
  })
  return wallSeconds
}

async function main() {
  // `--dry-run` prints what would be sent and touches nothing: it is the check that
  // the workflow still matches `_comfyui_ref/verified_workflow_api.json`, and the
  // guard against starting a GPU job by accident.
  if (args.dryRun) {
    emit('dry_run', {
      endpoint: args.endpoint,
      canvas: [args.width, args.height],
      steps: args.steps.split(',').map(Number),
      seed: args.seed,
      workflows: args.steps.split(',').map(Number).map((steps) => ({ steps, prompt: workflow(steps) })),
    })
    return
  }

  const stats = await jsonOrThrow(await fetch(`${args.endpoint}/system_stats`), 'GET /system_stats')
  const device = stats.devices?.[0] ?? {}
  emit('env', {
    tag: args.tag,
    endpoint: args.endpoint,
    comfyui_version: stats.system?.comfyui_version,
    python: stats.system?.python_version?.split(' ')[0],
    device: device.name,
    vram_total_MiB: Math.round((device.vram_total ?? 0) / 2 ** 20),
    vram_free_MiB: Math.round((device.vram_free ?? 0) / 2 ** 20),
    canvas: [args.width, args.height],
    steps: args.steps.split(',').map(Number),
  })

  const stepCounts = args.steps.split(',').map(Number)
  // Warm-up: the first call stages the weights from disk (ComfyUI logs "prepared for
  // dynamic VRAM loading"), and folding that into steps=1 would poison the intercept.
  // It carries a seed no measured run uses, so ComfyUI's output cache cannot serve a
  // measured run from it.
  await runOnce(stepCounts[0], 'warmup', args.seed + 999999)
  for (const steps of stepCounts) {
    await runOnce(steps, `${args.tag}_steps${steps}`)
  }
}

main().catch((error) => {
  emit('fatal', { tag: args.tag, error: String(error && error.message ? error.message : error) })
  process.exitCode = 1
})
