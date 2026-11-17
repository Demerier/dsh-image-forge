/**
 * Model profiles: everything that changes when the checkpoint family behind
 * ComfyUI changes, kept in one table instead of scattered over the adapter.
 *
 * The plugin used to be Qwen-Image only, and that assumption was spread out:
 * `/qwen/i` was the hard gate that selected weights, `'qwen_image'` was the only
 * accepted `CLIPLoader.type`, the four graphs were module-level constants, and
 * the step/sampler numbers were literals inside each generation function. Adding
 * a second family (MOSS-Image) that way would have meant a second copy of the
 * weight selection, a second set of graphs and a second set of branches at every
 * call site — i.e. two adapters wearing one name.
 *
 * A profile is the **data** half of a family. It owns:
 *
 * - which weight files to look for (a matcher per loader field, with the example
 *   names that appear in error text),
 * - which `CLIPLoader.type` value the graph must use,
 * - the latent node and its alignment granularity,
 * - the sampler, scheduler, CFG, default step count and — when the checkpoint
 *   needs it — the explicit sigma schedule,
 * - the negative prompt the family recommends,
 * - and the workflow constructors (text-to-image always; image-to-image when the
 *   family has an edit graph).
 *
 * It deliberately does **not** own: pixel sizing (`ratio.ts` keeps that, and every
 * canvas it produces is aligned to at least 32), HTTP/loopback policy, retries,
 * error phrasing or the tool surface. Those stay in `comfyui.ts` / `tools.ts`, so
 * one code path serves every profile.
 *
 * Nothing here reads the network, the disk or the environment: the module is
 * pure data plus constructors, so it is directly testable offline.
 */

/** The canonical id of a model family/variant, as stored in `comfyModel`. */
export const COMFY_MODEL_IDS = ['qwen21-base', 'qwen21-turbo', 'moss-sft'] as const

/** One canonical profile id. */
export type ComfyModelId = (typeof COMFY_MODEL_IDS)[number]

/**
 * The two ids the config carried before profiles existed.
 *
 * They stay **accepted** forever: a profile patch, an old `cordis.yml` or a
 * saved settings document may still say `base` / `turbo`, and silently dropping
 * that to the default would change what a user already chose.
 */
export const LEGACY_COMFY_MODEL_IDS = ['base', 'turbo'] as const

/** One legacy `comfyModel` value. */
export type LegacyComfyModelId = (typeof LEGACY_COMFY_MODEL_IDS)[number]

/** Everything `comfyModel` accepts: the canonical ids plus the two legacy ones. */
export type ComfyModelChoice = ComfyModelId | LegacyComfyModelId

/** The id used when the config says nothing. */
export const DEFAULT_COMFY_MODEL: ComfyModelId = 'qwen21-base'

/** One node of a ComfyUI **API-format** graph. */
export interface ApiNode {
  /** ComfyUI node class, e.g. `KSampler`. */
  class_type: string
  /** Node inputs; `['<id>', <slot>]` tuples are links to other nodes. */
  inputs: Record<string, unknown>
}

/** A whole API-format graph, keyed by node id as a string. */
export type ApiGraph = Record<string, ApiNode>

// ---------------------------------------------------------------------------
// Qwen-Image 2.1 graphs (unchanged; moved here so a profile can own them)
// ---------------------------------------------------------------------------

/**
 * The Qwen-Image 2.1 text-to-image graph, in ComfyUI's API format.
 *
 * `{{name}}` placeholders are filled by `renderWorkflow` in `comfyui.ts`; the
 * three model file names are placeholders on purpose — they come from
 * `/object_info`.
 */
export const QWEN_IMAGE_WORKFLOW: ApiGraph = {
  '1': { class_type: 'UNETLoader', inputs: { unet_name: '{{unet_name}}', weight_dtype: '{{weight_dtype}}' } },
  '2': { class_type: 'CLIPLoader', inputs: { clip_name: '{{clip_name}}', type: '{{clip_type}}' } },
  '3': { class_type: 'VAELoader', inputs: { vae_name: '{{vae_name}}' } },
  '4': {
    class_type: 'TextEncodeQwenImage21',
    inputs: { clip: ['2', 0], prompt: '{{prompt}}', negative_prompt: '{{negative_prompt}}', resolution: 1024 },
  },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: '{{batch_size}}' } },
  '6': {
    class_type: 'KSampler',
    inputs: {
      model: ['1', 0],
      positive: ['4', 0],
      negative: ['4', 1],
      latent_image: ['5', 0],
      seed: '{{seed}}',
      steps: '{{steps}}',
      cfg: '{{cfg}}',
      sampler_name: '{{sampler_name}}',
      scheduler: '{{scheduler}}',
      denoise: 1,
    },
  },
  '7': { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['3', 0] } },
  '8': { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: '{{filename_prefix}}' } },
}

/**
 * The Qwen edit graph, which is the text-to-image graph with a different encode
 * node: `TextEncodeQwenImage21` additionally receives the VAE (it VAE-encodes
 * each reference into the condition) and a `resolution` pixel budget. The
 * reference slots themselves are added per call by {@link editWorkflow}.
 */
export const QWEN_IMAGE_EDIT_WORKFLOW: ApiGraph = {
  ...QWEN_IMAGE_WORKFLOW,
  '4': {
    class_type: 'TextEncodeQwenImage21',
    inputs: {
      clip: ['2', 0],
      vae: ['3', 0],
      prompt: '{{prompt}}',
      negative_prompt: '{{negative_prompt}}',
      resolution: '{{resolution}}',
    },
  },
}

/** How many reference images the edit graphs wire up (`<image1>`…`<image10>`). */
export const EDIT_MAX_REFERENCES = 10

/** First node id used for the Qwen edit graph's `LoadImage` nodes (ids 1–8 are the graph). */
export const EDIT_IMAGE_NODE_BASE = 11

/** First node id for the turbo edit graph's `LoadImage` nodes (ids 1–12 are the graph). */
export const TURBO_EDIT_IMAGE_NODE_BASE = 13

/**
 * Wire one `LoadImage` per reference into an edit graph's autogrow inputs.
 *
 * ComfyUI's schema DSL expands the autogrow `images` input into
 * `images.image_1` … `images.image_16`, all optional, and validates by those
 * dotted names — which is also how the official edit template refers to them.
 *
 * @param template - the edit graph to start from (Qwen base or turbo).
 * @param firstNodeId - the first `LoadImage` node id for that graph.
 * @param imageNames - file names inside ComfyUI's `input` folder, in prompt order.
 * @returns a fresh API-format graph with one loader per reference.
 * @throws When the list is empty or longer than {@link EDIT_MAX_REFERENCES}.
 */
export function wireReferenceSlots(
  template: ApiGraph,
  firstNodeId: number,
  imageNames: readonly string[],
): ApiGraph {
  if (imageNames.length === 0) throw new Error('comfyui backend: the edit graph needs at least one reference image')
  if (imageNames.length > EDIT_MAX_REFERENCES) {
    throw new Error(
      `comfyui backend: the edit graph wires ${EDIT_MAX_REFERENCES} reference slots, got ${imageNames.length}`,
    )
  }
  const graph: ApiGraph = { ...template }
  const encode = { class_type: 'TextEncodeQwenImage21', inputs: { ...template['4']!.inputs } }
  graph['4'] = encode
  for (const [position, name] of imageNames.entries()) {
    const id = String(firstNodeId + position)
    graph[id] = { class_type: 'LoadImage', inputs: { image: name } }
    encode.inputs[`images.image_${position + 1}`] = [id, 0]
  }
  return graph
}

/**
 * Wire one `LoadImage` per reference into the Qwen base edit graph.
 *
 * @param imageNames - file names inside ComfyUI's `input` folder, in prompt order.
 * @returns a fresh API-format graph with one loader per reference.
 */
export function editWorkflow(imageNames: readonly string[]): ApiGraph {
  return wireReferenceSlots(QWEN_IMAGE_EDIT_WORKFLOW, EDIT_IMAGE_NODE_BASE, imageNames)
}

/** Wire one `LoadImage` per reference into the Qwen turbo edit graph. */
export function editTurboWorkflow(imageNames: readonly string[]): ApiGraph {
  return wireReferenceSlots(QWEN_IMAGE_TURBO_EDIT_WORKFLOW, TURBO_EDIT_IMAGE_NODE_BASE, imageNames)
}

// ---------------------------------------------------------------------------
// Qwen-Image 2.1 turbo: the distilled checkpoint and its sigma schedule
// ---------------------------------------------------------------------------

/**
 * The sigma schedule the Turbo checkpoint was distilled for.
 *
 * Copied verbatim from the official `image_qwen_image_2_1_turbo_t2i.json`
 * template's `ManualSigmas` node. Raising the step count **without** swapping
 * this schedule in makes the result worse, not better.
 */
export const TURBO_SIGMAS = '1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0'

/** Steps the schedule above describes: one per remaining sigma. */
export const TURBO_STEPS = 8

/**
 * The Turbo text-to-image graph, in ComfyUI's API format.
 *
 * The Turbo templates do **not** use `KSampler`. They drive
 * `SamplerCustomAdvanced`, which takes the noise, guider, sampler and sigmas as
 * separate inputs — that separation is the only way to hand it a `ManualSigmas`
 * node, and the manual schedule is the whole point of the turbo checkpoint:
 *
 * ```
 * RandomNoise ─┐
 * CFGGuider ───┼→ SamplerCustomAdvanced → VAEDecode → SaveImage
 * KSamplerSelect┤
 * ManualSigmas ─┤
 * EmptyLatentImage ─┘
 * ```
 */
export const QWEN_IMAGE_TURBO_WORKFLOW: ApiGraph = {
  '1': { class_type: 'UNETLoader', inputs: { unet_name: '{{unet_name}}', weight_dtype: '{{weight_dtype}}' } },
  '2': { class_type: 'CLIPLoader', inputs: { clip_name: '{{clip_name}}', type: '{{clip_type}}' } },
  '3': { class_type: 'VAELoader', inputs: { vae_name: '{{vae_name}}' } },
  '4': {
    class_type: 'TextEncodeQwenImage21',
    inputs: { clip: ['2', 0], prompt: '{{prompt}}', negative_prompt: '{{negative_prompt}}', resolution: 1024 },
  },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: '{{batch_size}}' } },
  // The four ingredients SamplerCustomAdvanced consumes, one node each.
  '6': { class_type: 'RandomNoise', inputs: { noise_seed: '{{seed}}' } },
  '7': {
    class_type: 'CFGGuider',
    inputs: {
      model: ['1', 0],
      positive: ['4', 0],
      negative: ['4', 1],
      cfg: '{{cfg}}',
    },
  },
  '8': { class_type: 'KSamplerSelect', inputs: { sampler_name: '{{sampler_name}}' } },
  '9': { class_type: 'ManualSigmas', inputs: { sigmas: '{{sigmas}}' } },
  '10': {
    class_type: 'SamplerCustomAdvanced',
    inputs: {
      noise: ['6', 0],
      guider: ['7', 0],
      sampler: ['8', 0],
      sigmas: ['9', 0],
      latent_image: ['5', 0],
    },
  },
  '11': { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['3', 0] } },
  '12': { class_type: 'SaveImage', inputs: { images: ['11', 0], filename_prefix: '{{filename_prefix}}' } },
}

/**
 * The Turbo edit graph: the turbo skeleton plus the edit encode node plus the
 * reference slots that {@link editTurboWorkflow} wires per call.
 *
 * `cfg` is **1**, the same as the turbo t2i graph: at cfg 1 ComfyUI skips the
 * negative conditioning pass entirely, so an elevated cfg with an empty negative
 * prompt does not sharpen the edit; it degrades it.
 */
export const QWEN_IMAGE_TURBO_EDIT_WORKFLOW: ApiGraph = {
  ...QWEN_IMAGE_TURBO_WORKFLOW,
  '4': {
    class_type: 'TextEncodeQwenImage21',
    inputs: {
      clip: ['2', 0],
      vae: ['3', 0],
      prompt: '{{prompt}}',
      negative_prompt: '{{negative_prompt}}',
      resolution: '{{resolution}}',
    },
  },
}

// ---------------------------------------------------------------------------
// MOSS-Image: text-to-image (ComfyUI-native, not a custom node)
// ---------------------------------------------------------------------------

/**
 * The negative prompt MOSS-Image recommends, verbatim from the official
 * template's negative widget and its USERGUIDE.
 *
 * Unlike Qwen-Image, MOSS runs at CFG 2.5 (not 1), so the negative conditioning
 * pass is **not** skipped and this string actually steers the sample.
 */
export const MOSS_NEGATIVE_PROMPT = 'nsfw, worst quality, bad anatomy, watermark, jpeg artifact'

/**
 * The MOSS-Image text-to-image graph, in ComfyUI's API format.
 *
 * Node for node this is `verify/moss_image_t2i_api.json` (the sample that
 * produced this machine's verified MOSS renders), with the three weights and the
 * per-call numbers turned into placeholders:
 *
 * ```
 * UNETLoader → SkipLayerGuidanceDiTSimple(single_layers="22") ─┐
 * CLIPLoader(moss_image) → CLIPTextEncode(positive/negative) ──┼→ KSampler
 * EmptyFlux2LatentImage ──────────────────────────────────────┘   (er_sde/simple)
 * KSampler → VAEDecode → SaveImage
 * ```
 *
 * Cross-checked against the official UI template
 * (`comfyui_workflow_templates_json/templates/image_moss_image_t2i.json`), whose
 * `Text to Image (MOSS-Image)` subgraph carries exactly these nodes and widget
 * values: `CLIPTextEncode` (not `TextEncodeQwenImage21`), `EmptyFlux2LatentImage`,
 * `SkipLayerGuidanceDiTSimple` with `double_layers=""` / `single_layers="22"` /
 * `start_percent=0` / `end_percent=0.5`, and `KSampler` at 25 steps / CFG 2.5 /
 * `er_sde` / `simple` / denoise 1.
 *
 * What is deliberately **absent**, mirroring the Qwen path's own reductions:
 *
 * - the template's prompt-upsampler branch (`TextGenerate` + `ComfySwitchNode` +
 *   `PreviewAny`): this plugin never rewrites the caller's prompt — that is the
 *   skill's job — and the upsampler needs no weights beyond the ones we already
 *   require;
 * - its `ResolutionSelector`: the canvas is decided by `ratio.ts`, and every size
 *   it produces is 32-aligned, i.e. also a multiple of MOSS's 16 (see
 *   {@link MOSS_LATENT_MULTIPLE});
 * - any `ModelSampling*` node: shift 5 is MOSS's own model default, and the
 *   official template notes `ModelSamplingSD3` uses a different scale entirely.
 *
 * Note there is no `steps`-carrying sampler-select node here: MOSS uses a plain
 * `KSampler`, and its sigma behaviour is the model's default (no manual
 * schedule), which is why this profile has no `sigmas`.
 */
export const MOSS_IMAGE_WORKFLOW: ApiGraph = {
  '1': { class_type: 'UNETLoader', inputs: { unet_name: '{{unet_name}}', weight_dtype: '{{weight_dtype}}' } },
  '2': { class_type: 'CLIPLoader', inputs: { clip_name: '{{clip_name}}', type: '{{clip_type}}' } },
  '3': { class_type: 'VAELoader', inputs: { vae_name: '{{vae_name}}' } },
  '4': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['2', 0] } },
  '5': { class_type: 'CLIPTextEncode', inputs: { text: '{{negative_prompt}}', clip: ['2', 0] } },
  '6': {
    class_type: 'EmptyFlux2LatentImage',
    inputs: { width: '{{width}}', height: '{{height}}', batch_size: '{{batch_size}}' },
  },
  '7': {
    class_type: 'SkipLayerGuidanceDiTSimple',
    inputs: {
      model: ['1', 0],
      double_layers: '',
      single_layers: '22',
      start_percent: 0,
      end_percent: 0.5,
    },
  },
  '8': {
    class_type: 'KSampler',
    inputs: {
      model: ['7', 0],
      seed: '{{seed}}',
      steps: '{{steps}}',
      cfg: '{{cfg}}',
      sampler_name: '{{sampler_name}}',
      scheduler: '{{scheduler}}',
      denoise: 1,
      positive: ['4', 0],
      negative: ['5', 0],
      latent_image: ['6', 0],
    },
  },
  '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
  '10': { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: '{{filename_prefix}}' } },
}

/** Side length MOSS-Image's `EmptyFlux2LatentImage` requires a multiple of. */
export const MOSS_LATENT_MULTIPLE = 16

// ---------------------------------------------------------------------------
// The profile shape
// ---------------------------------------------------------------------------

/**
 * How to recognise one weight file in a loader's option list.
 *
 * The server is the only source of file names — nothing here is a *requirement*,
 * only a rule for choosing among what `/object_info` reported.
 */
export interface WeightRule {
  /** Loader node, e.g. `UNETLoader`. */
  readonly loader: string
  /** Loader input field, e.g. `unet_name`. */
  readonly field: string
  /** ComfyUI models folder the file belongs in (error text only). */
  readonly folder: string
  /** What this file is, for error text. */
  readonly what: string
  /** A name this family really ships under, for error text. */
  readonly example: string
  /** A candidate must match this to be considered at all. */
  readonly required: RegExp
  /** Extra preference, earlier patterns weigh more. */
  readonly bonus: readonly RegExp[]
  /** Candidates matching any of these are pushed to the bottom. */
  readonly avoid?: readonly RegExp[]
}

/** The latent node and how its sides must be aligned. */
export interface LatentSpec {
  /** Class name, e.g. `EmptyLatentImage`. */
  readonly classType: string
  /** Both sides must be a multiple of this. */
  readonly multiple: number
}

/** The sampler a family runs. */
export interface SamplerSpec {
  /** `KSampler` for a classic graph, `SamplerCustomAdvanced` for turbo. */
  readonly node: 'KSampler' | 'SamplerCustomAdvanced'
  /** `KSampler.sampler_name` / `KSamplerSelect.sampler_name`. */
  readonly name: string
  /** `KSampler.scheduler` (unused by the custom-advanced graphs). */
  readonly scheduler: string
  /** `cfg` for `KSampler` or `CFGGuider`. */
  readonly cfg: number
}

/** Step policy: the family's own default, plus a manual schedule when it needs one. */
export interface StepsSpec {
  /** Steps used when neither the call nor the config picks a number. */
  readonly default: number
  /** Explicit sigma schedule, for a distilled checkpoint. */
  readonly sigmas?: string
}

/**
 * One alternative sampling register a family can run.
 *
 * A family's sampler numbers are not one truth: MOSS-Image ships two documented
 * registers, and which one is "right" depends on whether you follow the ComfyUI
 * template (fast, 25 steps, `er_sde`, CFG 2.5) or OpenMOSS's own card (quality,
 * 50 steps, plain `euler`, CFG 3). Rather than three loose config fields, a
 * profile declares the registers **as data** and `comfyui.ts` reads the chosen
 * one, so adding a register is a table entry and never an `if` in the adapter.
 */
export interface SamplingPreset {
  /** Human label, for the settings page and reports. */
  readonly label: string
  /** Sampler settings this register runs. */
  readonly sampler: SamplerSpec
  /** Step default for this register. */
  readonly steps: StepsSpec
}

/**
 * The two MOSS-Image sampling registers.
 *
 * `comfy` is what the official ComfyUI template's `image_moss_image_t2i.json`
 * runs (it notes it uses kijai's faster settings from PR #17095), and it is what
 * produced this machine's verified sample (`verify/moss_image_t2i_api.json`).
 * `official` is OpenMOSS's own recommendation. Both keep the model's own shift
 * of 5 — no `ModelSampling*` node, no manual sigma schedule.
 */
export const MOSS_SAMPLING_PRESETS = ['comfy', 'official'] as const

/** One `mossSampling` value. */
export type MossSamplingPreset = (typeof MOSS_SAMPLING_PRESETS)[number]

/** The register used when the config says nothing: the verified one. */
export const DEFAULT_MOSS_SAMPLING: MossSamplingPreset = 'comfy'

/** An image-to-image graph plus the builder that wires its reference slots. */
export interface EditSpec {
  /** Encode node and slots base graph. */
  readonly template: ApiGraph
  /** Add one `LoadImage` per reference. */
  readonly build: (imageNames: readonly string[]) => ApiGraph
}

/** One model family/variant. */
export interface ModelProfile {
  /** Canonical id, as stored in `comfyModel`. */
  readonly id: ComfyModelId
  /** Human label, for reports and error text. */
  readonly label: string
  /** Family name, for reports. */
  readonly family: string
  /** `base` / `turbo` / `sft`: which sibling of the family this is. */
  readonly variant: 'base' | 'turbo' | 'sft'
  /** Legacy `comfyModel` values that map here. */
  readonly legacyIds: readonly LegacyComfyModelId[]
  /** The label the tool reports for this family (`base` / `turbo` / `moss`). */
  readonly legacyLabel: 'base' | 'turbo' | 'moss'
  /** The three weight files this family needs. */
  readonly weights: { readonly unet: WeightRule; readonly clip: WeightRule; readonly vae: WeightRule }
  /** Accepted `CLIPLoader.type` values, most preferred first. */
  readonly clipType: { readonly prefer: readonly string[]; readonly fallback?: RegExp }
  /** Latent node and alignment. */
  readonly latent: LatentSpec
  /** Sampler settings. */
  readonly sampler: SamplerSpec
  /** Step defaults and sigma schedule. */
  readonly steps: StepsSpec
  /**
   * Alternative sampling registers, keyed by the `mossSampling` value that
   * selects them. A profile without this table ignores the setting entirely —
   * both Qwen profiles do, so their sampler numbers cannot move.
   */
  readonly samplingPresets?: Readonly<Record<string, SamplingPreset>>
  /**
   * The register the profile's own `sampler` / `steps` fields already describe.
   *
   * That one is the family default, so its step count defers to the shared
   * `defaultSteps` exactly as before this table existed; a *different* register
   * brings its own count (see {@link presetSteps}).
   */
  readonly defaultPreset?: string
  /** Negative prompt this family recommends. */
  readonly negativePrompt: string
  /** `SaveImage.filename_prefix`. */
  readonly filenamePrefix: string
  /** The text-to-image graph. */
  readonly textToImage: ApiGraph
  /** The image-to-image graph, when the family has one wired up. */
  readonly imageToImage?: EditSpec
  /** Why a graph family is not wired up yet, when it is not. */
  readonly todo?: string
}

const QWEN_BASE_WEIGHTS: ModelProfile['weights'] = {
  unet: {
    loader: 'UNETLoader',
    field: 'unet_name',
    folder: 'unet',
    what: 'Qwen-Image 2.1 的 DiT（去噪主干）',
    example: 'qwen_image_2.1_int8_convrot.safetensors',
    required: /qwen/i,
    bonus: [/image/i, /2[._-]?1/, /int8/i],
    // With both checkpoints installed the plain bonuses tie and the server's own
    // order decides; `base` says which one that must not be.
    avoid: [/turbo/i],
  },
  clip: {
    loader: 'CLIPLoader',
    field: 'clip_name',
    folder: 'clip',
    what: 'Qwen-Image 2.1 的文本编码器（Qwen3-VL 8B）',
    example: 'qwen3vl_8b_int8_convrot.safetensors',
    required: /qwen/i,
    bonus: [/vl/i, /8b/i, /int8/i],
  },
  vae: {
    loader: 'VAELoader',
    field: 'vae_name',
    folder: 'vae',
    what: 'Qwen-Image 2.1 的 VAE',
    example: 'qwen_image_2.1_vae_bf16.safetensors',
    required: /qwen/i,
    bonus: [/vae/i, /2[._-]?1/, /bf16/i],
  },
}

const QWEN_TURBO_WEIGHTS: ModelProfile['weights'] = {
  ...QWEN_BASE_WEIGHTS,
  unet: {
    ...QWEN_BASE_WEIGHTS.unet,
    example: 'qwen_image_2.1_turbo_int8_convrot.safetensors',
    // The promotion that makes the turbo checkpoint reachable at all: without it
    // a turbo request ties with base and keeps the server's (base-first) order.
    bonus: [/turbo/i, /image/i, /2[._-]?1/, /int8/i],
    avoid: [],
  },
}

/**
 * MOSS-Image's weights.
 *
 * **None of the three matchers is `/qwen/i`** — that is the whole point of the
 * profile: the DiT is `moss_image_sft_*` and the VAE is `flux2-vae_small`, i.e.
 * exactly the two files the old hard gate could never accept. The text encoder
 * happens to be a Qwen3.5 file, so that matcher still keys on the version it
 * really ships as.
 */
const MOSS_WEIGHTS: ModelProfile['weights'] = {
  unet: {
    loader: 'UNETLoader',
    field: 'unet_name',
    folder: 'diffusion_models',
    what: 'MOSS-Image 的 DiT（去噪主干；SFT 与 Base 都可跑同一张图）',
    example: 'moss_image_sft_int8_convrot.safetensors',
    required: /moss/i,
    bonus: [/sft/i, /image/i, /int8/i],
  },
  clip: {
    loader: 'CLIPLoader',
    field: 'clip_name',
    folder: 'text_encoders',
    what: 'MOSS-Image 的文本编码器（Qwen3.5 9B，w4a8 GPTQ）',
    example: 'qwen3.5_9b_w4a8_gptq.safetensors',
    // Tight on purpose: Qwen-Image's prompt-enhancer encoders are also Qwen3.5
    // files, and picking one of those for MOSS would load a text encoder the
    // model was not trained against. Requiring the quantisation markers selects
    // the one file MOSS actually ships.
    required: /qwen3[._]?5.*(?:w4a8|gptq)/i,
    bonus: [/w4a8/i, /gptq/i, /9b/i],
  },
  vae: {
    loader: 'VAELoader',
    field: 'vae_name',
    folder: 'vae',
    what: 'MOSS-Image 的 VAE（FLUX.2 small）',
    example: 'flux2-vae_small.safetensors',
    required: /flux[._-]?2/i,
    bonus: [/vae/i, /small/i],
  },
}

/**
 * MOSS-Image's two sampling registers.
 *
 * `comfy` is the default and is the one the official ComfyUI template and this
 * machine's verified sample actually run: 25 steps / CFG 2.5 / `er_sde` /
 * `simple`. `official` is OpenMOSS's own card: 50 steps / CFG 3.0 / `euler` /
 * `simple`. The difference is a quality dial, not a correctness one, which is
 * why it is one select with two registers instead of three loose numbers.
 */
const MOSS_SAMPLING: Readonly<Record<MossSamplingPreset, SamplingPreset>> = {
  comfy: {
    label: 'ComfyUI 模板（25 步 / CFG 2.5 / er_sde）',
    sampler: { node: 'KSampler', name: 'er_sde', scheduler: 'simple', cfg: 2.5 },
    steps: { default: 25 },
  },
  official: {
    label: 'OpenMOSS 官方（50 步 / CFG 3 / euler）',
    sampler: { node: 'KSampler', name: 'euler', scheduler: 'simple', cfg: 3 },
    steps: { default: 50 },
  },
}

/** Every profile, keyed by its canonical id. */
export const MODEL_PROFILES: Readonly<Record<ComfyModelId, ModelProfile>> = {
  'qwen21-base': {
    id: 'qwen21-base',
    label: 'Qwen-Image 2.1（base，25 步）',
    family: 'qwen-image-2.1',
    variant: 'base',
    legacyIds: ['base'],
    legacyLabel: 'base',
    weights: QWEN_BASE_WEIGHTS,
    clipType: { prefer: ['qwen_image'], fallback: /qwen/i },
    latent: { classType: 'EmptyLatentImage', multiple: 32 },
    sampler: { node: 'KSampler', name: 'euler', scheduler: 'simple', cfg: 1 },
    steps: { default: 25 },
    negativePrompt: '',
    filenamePrefix: 'dsh-image-forge',
    textToImage: QWEN_IMAGE_WORKFLOW,
    imageToImage: { template: QWEN_IMAGE_EDIT_WORKFLOW, build: editWorkflow },
  },
  'qwen21-turbo': {
    id: 'qwen21-turbo',
    label: 'Qwen-Image 2.1（turbo，8 步蒸馏）',
    family: 'qwen-image-2.1',
    variant: 'turbo',
    legacyIds: ['turbo'],
    legacyLabel: 'turbo',
    weights: QWEN_TURBO_WEIGHTS,
    clipType: { prefer: ['qwen_image'], fallback: /qwen/i },
    latent: { classType: 'EmptyLatentImage', multiple: 32 },
    sampler: { node: 'SamplerCustomAdvanced', name: 'euler', scheduler: 'simple', cfg: 1 },
    steps: { default: TURBO_STEPS, sigmas: TURBO_SIGMAS },
    negativePrompt: '',
    filenamePrefix: 'dsh-image-forge-turbo',
    textToImage: QWEN_IMAGE_TURBO_WORKFLOW,
    imageToImage: { template: QWEN_IMAGE_TURBO_EDIT_WORKFLOW, build: editTurboWorkflow },
  },
  'moss-sft': {
    id: 'moss-sft',
    label: 'MOSS-Image（SFT，25/50 步）',
    family: 'moss-image',
    variant: 'sft',
    legacyIds: [],
    legacyLabel: 'moss',
    weights: MOSS_WEIGHTS,
    clipType: { prefer: ['moss_image'] },
    latent: { classType: 'EmptyFlux2LatentImage', multiple: MOSS_LATENT_MULTIPLE },
    // 25 steps / CFG 2.5 / er_sde / simple is what the official ComfyUI template
    // and the verified sample both run, so that register *is* this profile's own
    // `sampler` / `steps` (and `defaultPreset`), which keeps the shipped
    // behaviour byte-identical. The OpenMOSS register (50 / 3.0 / euler) is the
    // other entry of the table; select it with `mossSampling: 'official'`.
    sampler: MOSS_SAMPLING.comfy.sampler,
    steps: MOSS_SAMPLING.comfy.steps,
    samplingPresets: MOSS_SAMPLING,
    defaultPreset: 'comfy',
    negativePrompt: MOSS_NEGATIVE_PROMPT,
    filenamePrefix: 'dsh-image-forge-moss',
    textToImage: MOSS_IMAGE_WORKFLOW,
    imageToImage: undefined,
    // TODO(moss-edit): wire the edit graph — the official edit workflow is
    // `verify/moss_image_edit_api.json`; it needs the edit LoRA
    // (`moss_image_edit_lora_rank_64_bf16.safetensors` through
    // `LoraLoaderModelOnly` after the UNETLoader) and `TextEncodeMOSSImageEdit`
    // instead of the positive `CLIPTextEncode`, with references entering as
    // `LoadImage` nodes exactly like the Qwen edit path. Give this profile an
    // `imageToImage` and the adapter picks it up with no other change.
    // TODO(moss-layout): `MOSSImageLayoutPrompt` + `MOSSImageControl` (JSON
    // layout contract sample: `verify/layout_prompt.json`) are a separate,
    // unrequested feature.
    todo:
      'MOSS 改图未接入（本次只做文生图）。后续接入点：官方编辑图需要 edit LoRA ' +
      '`moss_image_edit_lora_rank_64_bf16.safetensors`（LoraLoaderModelOnly 接在 UNETLoader 之后）' +
      '并用 `TextEncodeMOSSImageEdit` 取代本图里的正向 CLIPTextEncode，参考图经 LoadImage 上传；' +
      'verify/moss_image_edit_api.json 是现成的 API 格式样本。布局（MOSSImageLayoutPrompt / ' +
      'MOSSImageControl）同样留待后续，样本见 verify/layout_prompt.json。',
  },
}

/**
 * Whether a value is a canonical profile id.
 *
 * @param value - anything, typically a config value.
 * @returns true for the three ids in {@link COMFY_MODEL_IDS}.
 */
export function isComfyModelId(value: unknown): value is ComfyModelId {
  return typeof value === 'string' && (COMFY_MODEL_IDS as readonly string[]).includes(value)
}

/**
 * Resolve a configured `comfyModel` value to its profile.
 *
 * Legacy values keep working: `base` → `qwen21-base`, `turbo` → `qwen21-turbo`.
 * Anything unrecognised (a typo, an older document) resolves to the default
 * rather than failing — a config typo must not make the plugin unusable, and the
 * resolved profile is reported back so the mismatch is visible.
 *
 * @param choice - the configured value, of any vintage.
 * @returns the profile; never undefined.
 */
export function resolveProfile(choice: ComfyModelChoice | string | undefined | null): ModelProfile {
  if (typeof choice === 'string') {
    const id = choice.trim()
    if (isComfyModelId(id)) return MODEL_PROFILES[id]
    for (const profile of Object.values(MODEL_PROFILES)) {
      if ((profile.legacyIds as readonly string[]).includes(id)) return profile
    }
  }
  return MODEL_PROFILES[DEFAULT_COMFY_MODEL]
}

/**
 * The sampler settings one run really uses, honouring a sampling register.
 *
 * A register only exists on the families that declare `samplingPresets` (today:
 * MOSS-Image), so both Qwen profiles return their own `sampler` / `steps`
 * untouched no matter what the config says — that is what keeps their behaviour
 * identical to before the setting existed. An unknown or absent value falls back
 * to the profile's own pair, so a stale settings document can never make a graph
 * unfillable.
 *
 * @param profile - the profile that will run.
 * @param preset - the configured register name, if any.
 * @returns the sampler/steps pair to fill the graph with, plus the register that
 *   supplied it (`undefined` when the profile's own pair did).
 */
export function resolveSampling(
  profile: ModelProfile,
  preset: string | undefined,
): { sampler: SamplerSpec; steps: StepsSpec; preset: string | undefined } {
  const table = profile.samplingPresets
  if (table !== undefined && typeof preset === 'string') {
    const chosen = table[preset]
    if (chosen !== undefined) return { sampler: chosen.sampler, steps: chosen.steps, preset }
  }
  return { sampler: profile.sampler, steps: profile.steps, preset: undefined }
}

/**
 * The step count a *non-default* register contributes.
 *
 * The register a profile's own `steps` already describes (`defaultPreset`) keeps
 * deferring to the shared `defaultSteps`, exactly as it did before registers
 * existed; any other register brings its own count, because its whole point is a
 * different working point (MOSS official: 50, not 25). `undefined` means "no
 * opinion" — a Qwen profile, an unknown value, or the default register.
 *
 * @param profile - the profile that will run.
 * @param preset - the configured register name, if any.
 * @returns the register's step count, or undefined when the shared default stands.
 */
export function presetSteps(profile: ModelProfile, preset: string | undefined): number | undefined {
  if (profile.samplingPresets === undefined || typeof preset !== 'string') return undefined
  if (preset === profile.defaultPreset) return undefined
  return profile.samplingPresets[preset]?.steps.default
}

/**
 * Assert a canvas satisfies a profile's latent alignment.
 *
 * `ratio.ts` produces 32-aligned sizes, which every profile accepts (32 is a
 * multiple of 16); this only guards an explicit size that somehow slipped past
 * `validateSize`, and it names the profile so the fix is obvious.
 *
 * @param profile - the profile that will run.
 * @param width - canvas width in pixels.
 * @param height - canvas height in pixels.
 * @throws When a side is not a multiple of the profile's alignment.
 */
export function assertLatentAligned(profile: ModelProfile, width: number, height: number): void {
  const multiple = profile.latent.multiple
  for (const [label, value] of [
    ['width', width],
    ['height', height],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0 || value % multiple !== 0) {
      throw new Error(
        `comfyui backend: ${profile.label} 的 latent 要求 ${label} 是 ${multiple} 的正整数倍，收到 ${value}。` +
          `（插件默认画幅是 32 对齐的，正常不会走到这里。）`,
      )
    }
  }
}
