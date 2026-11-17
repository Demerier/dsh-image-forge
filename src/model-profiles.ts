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
  // The official t2i template chains this shim after the UNETLoader: it caches the
  // text/reference KV prefix across sampling steps, which is where most of the edit
  // speedup comes from. `auto` keeps it out of VRAM when it does not fit and
  // `default` is the lossless dtype — the `gpu` device has known corruption bugs
  // (#16879/#16900). Node id 9 is free in this graph (the edit graph's LoadImage
  // nodes start at 11). Old ComfyUI builds lack the node; `comfyui.ts` strips it
  // via {@link withoutQwenCache} after reading /object_info.
  '9': { class_type: 'QwenImage21Cache', inputs: { model: ['1', 0], device: 'auto', dtype: 'default' } },
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
      model: ['9', 0],
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
  // The same prefix-cache shim the base graph carries (see QWEN_IMAGE_WORKFLOW).
  // Node id 23 is outside both this graph's 1–12 and the turbo edit graph's
  // LoadImage ids, so the template can be spread into the edit graph unchanged.
  '23': { class_type: 'QwenImage21Cache', inputs: { model: ['1', 0], device: 'auto', dtype: 'default' } },
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
      model: ['23', 0],
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

/** Node id of the `QwenImage21Cache` shim in the base Qwen graphs. */
export const QWEN_CACHE_NODE_ID = '9'

/** Node id of the shim in the turbo Qwen graphs (1–12 are the graph itself). */
export const TURBO_CACHE_NODE_ID = '23'

/**
 * Drop the `QwenImage21Cache` shim from a graph, rewiring its consumer to the
 * UNETLoader directly.
 *
 * The shim is a runtime speedup, not a correctness requirement: an older ComfyUI
 * (< 0.37.0) rejects the whole graph when a node class is unknown, so when
 * `/object_info` does not list it the adapter removes it and keeps the image
 * instead of failing the run. A graph without a shim is returned as a fresh copy
 * unchanged, so the caller can render either result.
 *
 * @param graph - an API-format graph, possibly carrying one cache shim.
 * @returns a graph with every cache node removed and every consumer rewired.
 */
export function withoutQwenCache(graph: ApiGraph): ApiGraph {
  const cacheIds = new Set(
    Object.entries(graph)
      .filter(([, node]) => node.class_type === 'QwenImage21Cache')
      .map(([id]) => id),
  )
  if (cacheIds.size === 0) return { ...graph }
  const out: ApiGraph = {}
  for (const [id, node] of Object.entries(graph)) {
    if (!cacheIds.has(id)) out[id] = { class_type: node.class_type, inputs: { ...node.inputs } }
  }
  for (const cacheId of cacheIds) {
    const upstream = graph[cacheId]?.inputs.model
    if (!Array.isArray(upstream)) continue
    for (const node of Object.values(out)) {
      for (const [name, value] of Object.entries(node.inputs)) {
        if (Array.isArray(value) && value[0] === cacheId) node.inputs[name] = [...upstream]
      }
    }
  }
  return out
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

// ---------------------------------------------------------------------------
// MOSS-Image: layout-conditioned generation (native nodes, T21)
// ---------------------------------------------------------------------------

/**
 * One item of a compiled MOSS layout prompt.
 *
 * `verify/layout_prompt.json` and the `*_draft.json` ⇄ compiled pairs under
 * `verify/` are the format authority. `bbox` is `[y1, x1, y2, x2]` in the
 * centred coordinate space the official compiler emits (`abs_centralized`),
 * which is why the compiled document carries that tag and the order.
 */
export interface MossLayoutItem {
  /** `object` / `character` / `text`; absent means the compiler's default. */
  readonly label?: string
  /** What to draw inside the box (the caption, not the whole-image prompt). */
  readonly caption: string
  /** Literal text, for `text` items. */
  readonly text?: string
  /** `[y1, x1, y2, x2]` in centred absolute pixels. */
  readonly bbox: readonly number[]
}

/** A compiled layout prompt document (what the layout editor exports). */
export interface MossLayoutPromptDocument {
  readonly summary?: { readonly caption?: string }
  readonly items: readonly MossLayoutItem[]
  readonly bbox_coord_space: string
  readonly bbox_format: string
}

/** A validated layout prompt, ready to fill the graph placeholders. */
export interface ParsedMossLayout {
  /** The parsed document. */
  readonly document: MossLayoutPromptDocument
  /** The exact JSON string handed to the positive encode node, verbatim. */
  readonly json: string
}

/** Item labels the official compiler emits; anything else is a typo. */
const MOSS_LAYOUT_LABELS = ['object', 'character', 'text'] as const

/**
 * Parse and validate a compiled layout prompt.
 *
 * The layout is prompt text, not workflow wiring: the compiled JSON is handed to
 * ComfyUI's `CreateBoundingBoxes` node as a string. Validation therefore fails
 * loudly on anything the node would choke on — malformed JSON, the wrong
 * coordinate space or order, an empty item list, a box that is not four finite
 * numbers — instead of submitting a graph that silently ignores the layout.
 *
 * @param input - the compiled JSON string (the layout editor's "compiled" export).
 * @returns the parsed document plus the strings the layout graph needs.
 * @throws When the JSON is not a valid compiled layout prompt.
 */
export function parseMossLayout(input: string): ParsedMossLayout {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    throw new Error('moss layout: 布局不是合法 JSON。请传布局编辑器导出的 compiled 文本（abs_centralized / yxyx）。')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('moss layout: 布局必须是一个 JSON 对象（含 summary / items / bbox_coord_space / bbox_format）。')
  }
  const document = parsed as Partial<MossLayoutPromptDocument> & Record<string, unknown>
  if (document.bbox_coord_space !== 'abs_centralized') {
    throw new Error(
      'moss layout: bbox_coord_space 必须是 abs_centralized，收到 ' + String(document.bbox_coord_space) +
        '。请用布局编辑器导出的 compiled 文本，不要手改坐标空间。',
    )
  }
  if (document.bbox_format !== 'yxyx') {
    throw new Error(
      'moss layout: bbox_format 必须是 yxyx，收到 ' + String(document.bbox_format) +
        '。compiled 布局的 bbox 顺序是 [y1, x1, y2, x2]。',
    )
  }
  if (!Array.isArray(document.items) || document.items.length === 0) {
    throw new Error('moss layout: items 必须是非空数组（至少一个画框）。')
  }
  const items: MossLayoutItem[] = document.items.map((raw, index) => {
    const position = 'items[' + String(index) + ']'
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('moss layout: ' + position + ' 必须是对象（label / caption / bbox）。')
    }
    const item = raw as Record<string, unknown>
    if (typeof item.caption !== 'string' || item.caption.trim().length === 0) {
      throw new Error('moss layout: ' + position + '.caption 必须是非空字符串。')
    }
    if (item.label !== undefined && !(MOSS_LAYOUT_LABELS as readonly unknown[]).includes(item.label)) {
      throw new Error('moss layout: ' + position + '.label 只能是 object / character / text。')
    }
    if (!Array.isArray(item.bbox) || item.bbox.length !== 4 || !item.bbox.every((value) => Number.isFinite(value))) {
      throw new Error('moss layout: ' + position + '.bbox 必须是 [y1, x1, y2, x2] 四个有限数字。')
    }
    return {
      label: typeof item.label === 'string' ? item.label : undefined,
      caption: item.caption,
      text: typeof item.text === 'string' ? item.text : undefined,
      bbox: item.bbox as number[],
    }
  })
  const caption = document.summary?.caption
  if (typeof caption !== 'string' || caption.trim().length === 0) {
    throw new Error(
      'moss layout: summary.caption 必须是非空字符串——它是整图描述，MOSS 的布局 prompt 把它作为整体语义；' +
        '只画框不给整图描述时，布局和提示词会互相打架。',
    )
  }
  return {
    document: {
      summary: document.summary as MossLayoutPromptDocument['summary'],
      items,
      bbox_coord_space: 'abs_centralized',
      bbox_format: 'yxyx',
    },
    json: input,
  }
}

/**
 * The layout-conditioned MOSS-Image graph.
 *
 * Identical to {@link MOSS_IMAGE_WORKFLOW} except that the positive encoder's
 * text is the compiled layout prompt instead of the caller's prose. That is what
 * the native nodes would ultimately produce: `MOSSImageLayoutPrompt.execute`
 * compiles drawn boxes into exactly this JSON shape (`{summary:{caption},
 * items,bbox_coord_space:'abs_centralized',bbox_format:'yxyx'}`) and the official
 * template feeds that string into the positive `CLIPTextEncode`. Compiling in the
 * editor and passing the compiled text keeps the graph to one extra value, with
 * no element-array round trip that the API cannot express (see the comment
 * inside the graph).
 *
 * The no-layout path keeps using {@link MOSS_IMAGE_WORKFLOW} unchanged — a
 * request without a layout must stay byte-identical.
 */
export const MOSS_IMAGE_LAYOUT_WORKFLOW: ApiGraph = {
  ...MOSS_IMAGE_WORKFLOW,
  // The compiled layout prompt *is* what MOSS conditions on: the native
  // `MOSSImageLayoutPrompt` node's whole job is to turn drawn boxes into exactly
  // this JSON string (verify its `execute` in comfy_extras/nodes_moss_image.py),
  // and the official template feeds that string straight into the positive
  // `CLIPTextEncode`. The plugin already produces the same string from its layout
  // editor, so the layout path replaces the positive prompt text and nothing else —
  // same model, same sampler, byte-identical graph minus one value.
  //
  // Why not wire `MOSSImageLayoutPrompt` itself: its `element` input takes the
  // `CreateBoundingBoxes` element array (0-1000 normalised boxes), which ComfyUI
  // cannot be handed as a literal list over the API (every list is treated as a
  // linked input, and `CreateBoundingBoxes.editor_state` is a required widget with
  // no producer). Pre-compiling locally is the same transformation done one layer
  // earlier, with no lossy round trip.
  '4': { class_type: 'CLIPTextEncode', inputs: { text: '{{layout_json}}', clip: ['2', 0] } },
}

/** Side length MOSS-Image's `EmptyFlux2LatentImage` requires a multiple of. */
export const MOSS_LATENT_MULTIPLE = 16

// ---------------------------------------------------------------------------
// MOSS-Image: reference-image editing (community edit LoRA, native nodes)
// ---------------------------------------------------------------------------

/**
 * The community edit LoRA that turns MOSS-Image into an instructable editor.
 *
 * Not part of the base checkpoint: it is a separate file under `models/loras/`
 * (`verify/fetch_moss_weights.py` lists it next to the three weights). The graph
 * wires it through `LoraLoaderModelOnly` immediately after `UNETLoader`, which is
 * how the official `image_moss_image_edit.json` template does it.
 */
export const MOSS_EDIT_LORA = 'moss_image_edit_lora_rank_64_bf16.safetensors'

/**
 * The `edit_format` value the LoRA above was trained with.
 *
 * `TextEncodeMOSSImageEdit` also accepts the two ai-toolkit formats, but those are
 * a different training regime (`verify/results.json` gotchas): pairing them with
 * this LoRA hands the encoder a condition it was never trained against.
 */
export const MOSS_EDIT_FORMAT = 'Moss-Image-Edit'

/** First node id for the MOSS edit graph's per-reference `LoadImage` nodes. */
export const MOSS_EDIT_IMAGE_NODE_BASE = 101

/** First node id for the `ImageScale` nodes that bring each reference to the canvas. */
export const MOSS_EDIT_SCALE_NODE_BASE = 121

/**
 * The MOSS-Image edit graph, in ComfyUI's API format.
 *
 * Node for node this is `verify/moss_image_edit_api.json` — the sample that
 * produced this machine's verified edit render — with two deliberate differences:
 *
 * 1. the sampler numbers are placeholders instead of the sample's literals
 *    (30 steps / CFG 4 / `euler` / `normal`). A profile owns its sampler, so an
 *    edit runs the same `mossSampling` register as its text-to-image graph
 *    instead of a second, silently different working point;
 * 2. the sample derives the canvas from `ImageScaleToTotalPixels` +
 *    `GetImageSize`; here the canvas is the one `ratio.ts` already picked and each
 *    reference is scaled **to that canvas** (see {@link mossEditWorkflow}). The
 *    edit LoRA conditions on reference latents, so reference and target have to
 *    agree on size — and taking the canvas from the plugin keeps the reported
 *    size, the filename size and the pixels on disk the same numbers.
 *
 * Everything else is the sample's shape, kept verbatim: the LoRA after the
 * `UNETLoader`, one `TextEncodeMOSSImageEdit` per polarity (the negative node
 * takes the profile's negative prompt and the same references), `Moss-Image-Edit`
 * as the format, `SkipLayerGuidanceDiTSimple` across the whole schedule
 * (`end_percent` 1, unlike the t2i graph's 0.5) and `denoise` 1.
 *
 * The reference slots are added per call by {@link mossEditWorkflow}; there are
 * none in this template.
 */
export const MOSS_IMAGE_EDIT_WORKFLOW: ApiGraph = {
  '1': { class_type: 'UNETLoader', inputs: { unet_name: '{{unet_name}}', weight_dtype: '{{weight_dtype}}' } },
  '2': {
    class_type: 'LoraLoaderModelOnly',
    inputs: { model: ['1', 0], lora_name: MOSS_EDIT_LORA, strength_model: 1 },
  },
  '3': { class_type: 'CLIPLoader', inputs: { clip_name: '{{clip_name}}', type: '{{clip_type}}', device: 'default' } },
  '4': { class_type: 'VAELoader', inputs: { vae_name: '{{vae_name}}' } },
  '5': {
    class_type: 'EmptyFlux2LatentImage',
    inputs: { width: '{{width}}', height: '{{height}}', batch_size: '{{batch_size}}' },
  },
  '6': {
    class_type: 'SkipLayerGuidanceDiTSimple',
    inputs: {
      model: ['2', 0],
      double_layers: '',
      single_layers: '22',
      start_percent: 0,
      end_percent: 1,
    },
  },
  '7': {
    class_type: 'TextEncodeMOSSImageEdit',
    inputs: {
      clip: ['3', 0],
      prompt: '{{prompt}}',
      edit_format: MOSS_EDIT_FORMAT,
      image_strength: 1,
      vae: ['4', 0],
    },
  },
  '8': {
    class_type: 'TextEncodeMOSSImageEdit',
    inputs: {
      clip: ['3', 0],
      prompt: '{{negative_prompt}}',
      edit_format: MOSS_EDIT_FORMAT,
      image_strength: 1,
      vae: ['4', 0],
    },
  },
  '9': {
    class_type: 'KSampler',
    inputs: {
      model: ['6', 0],
      seed: '{{seed}}',
      steps: '{{steps}}',
      cfg: '{{cfg}}',
      sampler_name: '{{sampler_name}}',
      scheduler: '{{scheduler}}',
      denoise: 1,
      positive: ['7', 0],
      negative: ['8', 0],
      latent_image: ['5', 0],
    },
  },
  '10': { class_type: 'VAEDecode', inputs: { samples: ['9', 0], vae: ['4', 0] } },
  '11': { class_type: 'SaveImage', inputs: { images: ['10', 0], filename_prefix: '{{filename_prefix}}' } },
}

/**
 * Wire one reference into the MOSS edit graph.
 *
 * Each reference becomes `LoadImage` → `ImageScale` (to the canvas passed in
 * `{{width}}`/`{{height}}`, aspect preserved by a centre crop) → one autogrow
 * slot on **both** `TextEncodeMOSSImageEdit` nodes. That is the same per-call
 * shape as the Qwen edit path (`wireReferenceSlots`), with the MOSS reference
 * slots named `images.image_0` … `images.image_9` — the autogrow input is declared
 * with `prefix: image_` and a 0-based index, unlike Qwen's 1-based
 * `images.image_1` (verified against ComfyUI 0.45.3's `/object_info`).
 *
 * @param imageNames - file names inside ComfyUI's `input` folder, in prompt order.
 * @returns a fresh API-format graph with one loader and one scaler per reference.
 * @throws When the list is empty or longer than {@link EDIT_MAX_REFERENCES}.
 */
export function mossEditWorkflow(imageNames: readonly string[]): ApiGraph {
  if (imageNames.length === 0) {
    throw new Error('comfyui backend: the MOSS edit graph needs at least one reference image')
  }
  if (imageNames.length > EDIT_MAX_REFERENCES) {
    throw new Error(`comfyui backend: the MOSS edit graph wires ${EDIT_MAX_REFERENCES} reference slots, got ${imageNames.length}`)
  }
  const graph: ApiGraph = { ...MOSS_IMAGE_EDIT_WORKFLOW }
  const positive = { class_type: 'TextEncodeMOSSImageEdit', inputs: { ...MOSS_IMAGE_EDIT_WORKFLOW['7']!.inputs } }
  const negative = { class_type: 'TextEncodeMOSSImageEdit', inputs: { ...MOSS_IMAGE_EDIT_WORKFLOW['8']!.inputs } }
  graph['7'] = positive
  graph['8'] = negative
  for (const [position, name] of imageNames.entries()) {
    const loadId = String(MOSS_EDIT_IMAGE_NODE_BASE + position)
    const scaleId = String(MOSS_EDIT_SCALE_NODE_BASE + position)
    graph[loadId] = { class_type: 'LoadImage', inputs: { image: name } }
    graph[scaleId] = {
      class_type: 'ImageScale',
      inputs: {
        image: [loadId, 0],
        upscale_method: 'lanczos',
        width: '{{width}}',
        height: '{{height}}',
        crop: 'center',
      },
    }
    positive.inputs[`images.image_${position}`] = [scaleId, 0]
    negative.inputs[`images.image_${position}`] = [scaleId, 0]
  }
  return graph
}

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
   * It stays meaningful in two places: `resolveSampling` falls back to that pair
   * for an unknown value, and the default register reports this pair's step count.
   * The shared `defaultSteps` is the fallback for families **without** a register
   * table (both Qwen profiles), never for a registered one — see
   * {@link presetSteps}.
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
  /**
   * The layout-conditioned graph, when the family can consume a compiled layout
   * prompt. Only MOSS-Image ships the native `MOSSImageLayoutPrompt` /
   * `MOSSImageControl` nodes; a layout request on a profile without this field is
   * refused rather than silently dropped.
   */
  readonly layoutTemplate?: ApiGraph
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
    // The 8 GB-friendly TE is w4a8 (5.88 GiB) rather than int8_convrot (8.71 GiB),
    // so it must outrank int8: the earlier a bonus pattern sits, the more it weighs
    // (see pickModelFile). Both files match /vl/ and /8b/, so the tie-breaker is the
    // quantisation marker — w4a8 matches its own pattern and int8 matches the one
    // after it, which is what makes w4a8 win when both are installed. With no w4a8
    // file installed int8 still wins, and a full bf16 encoder (16.33 GiB, no room on
    // an 8 GB card) stays last. The DiT's own int8_convrot preference is untouched.
    bonus: [/vl/i, /8b/i, /w4a8/i, /int8/i],
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
    label: 'Qwen-Image 2.1（base，40 步）',
    family: 'qwen-image-2.1',
    variant: 'base',
    legacyIds: ['base'],
    legacyLabel: 'base',
    weights: QWEN_BASE_WEIGHTS,
    clipType: { prefer: ['qwen_image'], fallback: /qwen/i },
    latent: { classType: 'EmptyLatentImage', multiple: 32 },
    sampler: { node: 'KSampler', name: 'euler', scheduler: 'simple', cfg: 1 },
    // The official GitHub card recommends 40 (docs/qwen21-optimization.md §四-2);
    // the ComfyUI template's 25 is a starting point, not the target.
    steps: { default: 40 },
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
    // `sampler` / `steps` (and `defaultPreset`). The register also owns the step
    // count: the shared `defaultSteps` is tuned for Qwen base and must never drag
    // MOSS off its template's 25. The OpenMOSS register (50 / 3.0 / euler) is the
    // other entry of the table; select it with `mossSampling: 'official'`.
    sampler: MOSS_SAMPLING.comfy.sampler,
    steps: MOSS_SAMPLING.comfy.steps,
    samplingPresets: MOSS_SAMPLING,
    defaultPreset: 'comfy',
    negativePrompt: MOSS_NEGATIVE_PROMPT,
    filenamePrefix: 'dsh-image-forge-moss',
    textToImage: MOSS_IMAGE_WORKFLOW,
    imageToImage: { template: MOSS_IMAGE_EDIT_WORKFLOW, build: mossEditWorkflow },
    // T21: a compiled layout prompt conditions the text-to-image graph through
    // the native MOSSImageLayoutPrompt + MOSSImageControl nodes; the plain
    // MOSS_IMAGE_WORKFLOW stays the no-layout path, byte-identical.
    layoutTemplate: MOSS_IMAGE_LAYOUT_WORKFLOW,
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
 * The step count a published sampling register contributes.
 *
 * A family that publishes registers owns its working points: the selected
 * register's count outranks the shared `defaultSteps` (MOSS comfy: 25, official:
 * 50). That is deliberate — MOSS's counts are model properties, so raising
 * `defaultSteps` for the Qwen base path must not silently move MOSS off its
 * template's 25. The default register reports the profile's own `steps.default`
 * (the pair the profile's `sampler` / `steps` mirror).
 *
 * `undefined` means "no opinion" — a Qwen profile (no table) or an unknown value.
 * The shared `defaultSteps` stands for those, exactly as it did before registers
 * existed.
 *
 * @param profile - the profile that will run.
 * @param preset - the configured register name, if any.
 * @returns the register's step count, or undefined when the shared default stands.
 */
export function presetSteps(profile: ModelProfile, preset: string | undefined): number | undefined {
  if (profile.samplingPresets === undefined || typeof preset !== 'string') return undefined
  const chosen = profile.samplingPresets[preset]
  if (chosen === undefined) return undefined
  return preset === profile.defaultPreset ? profile.steps.default : chosen.steps.default
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
