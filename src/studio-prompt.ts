/**
 * Prompt optimisation for the Studio, driven by the **conversation model**.
 *
 * The Studio's job is to take a half-formed idea ("做个赛博朋克街景，竖构图") and
 * turn it into a generation. The house style here is long observational prose
 * rather than a keyword stack — that is a **choice made in this repo**, not a
 * transcription of Qwen's official rewriting prompt (see `PROSE_SYSTEM_PROMPT` below
 * for the provenance). A user staring at an empty textarea has no reason to
 * know either convention, so this module borrows whatever model the current
 * conversation is already talking to — through the host's `llm` service — and
 * rewrites the text into that shape.
 *
 * Three constraints shape the implementation:
 *
 * 1. **Never a hard dependency.** `llm` is looked up at call time. A host that
 *    does not mount it (or a profile with no model configured) still gets a
 *    working Studio; the optimise button simply reports itself unavailable. A
 *    missing optimiser must not take generation down with it.
 * 2. **One shot, bounded.** A single non-streaming request with a small token
 *    budget. This runs while a human waits with a cursor in the box, so a slow
 *    or chatty model is worse than no model.
 * 3. **The caller's words win.** The optimiser is asked to preserve intent and
 *    every concrete detail, including the exact text that must appear *inside*
 *    the image. The prose around it is written in English by house rule, but
 *    the words the user wants rendered are never translated. Its output lands
 *    in an **editable** field — the user always gets the last word before an
 *    image is spent.
 *
 * @module studio-prompt
 */
import type { Context } from '@deepseek-ai/cordis'
import type {
  StudioOptimizeRequest,
  StudioOptimizeResponse,
  StudioOptimizeTurn,
  StudioPromptStyle,
} from './studio-shared.ts'

/** Minimal shape of the host's chunk assembler, loaded lazily (see below). */
interface AssemblerLike {
  push(chunk: never): void
  blocks(): readonly unknown[]
  readonly finish: unknown
}

/**
 * Load `BlockAssembler` on demand.
 *
 * The import is deliberately dynamic. `llm` is an optional service on this host,
 * so a profile that never mounts it also never installs `@deepseek-ai/dsh-llm`;
 * a static import would then fail at module load and take the whole plugin —
 * generation included — down with an optimiser nobody asked for. A rejected
 * import means "no optimiser", which is exactly what `undefined` says.
 *
 * @returns the constructor, or `undefined` when the package is not installed.
 */
async function loadAssembler(): Promise<(new () => AssemblerLike) | undefined> {
  try {
    const module = await import('@deepseek-ai/dsh-llm')
    const constructor = (module as { BlockAssembler?: new () => AssemblerLike }).BlockAssembler
    return typeof constructor === 'function' ? constructor : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether prompt optimisation can actually run: both the service and the
 * assembler package must be present, because either one missing means a button
 * that fails on click rather than a button that explains itself.
 *
 * @param ctx - host context.
 * @returns true when a rewrite could be attempted.
 */
export async function optimizerAvailable(ctx: Context): Promise<boolean> {
  const model = await resolveOptimizerModel(llmOf(ctx))
  if (model === undefined) return false
  return (await loadAssembler()) !== undefined
}

/**
 * Token ceiling for one rewrite; a prompt longer than this is not an improvement.
 *
 * 900 was enough for the old "one paragraph" shape. The house skeleton in
 * `references/t2i_rules.md` asks for ~20 English sentences / 400–500 words,
 * which is roughly 700–800 tokens on its own — counting tokens for the model
 * (~800) and leaving nothing for the trailing `注：` line.
 */
const MAX_TOKENS = 1600

/** Turns of conversation history forwarded at most. */
const MAX_CONTEXT_TURNS = 6

/** Longest single history turn forwarded, in characters. */
const MAX_CONTEXT_TURN_CHARS = 1200

/** Shape of the `llm` service this module actually uses, kept structural. */
interface LlmFace {
  listProviders(): Array<{ name?: string; id?: string; label?: string }>
  listModels(provider: string): Promise<Array<{ id?: string; name?: string; model?: string }>>
  stream(options: Record<string, unknown>): AsyncIterable<unknown>
}

/** Just enough of the assembled block shape to read the text back out. */
interface TextLikeBlock {
  readonly type: string
  readonly text?: unknown
}

/** Just enough of the finish reason to tell success from failure. */
interface FinishLike {
  readonly kind?: string
}

/**
 * The system prompt handed to the conversation model.
 *
 * **This is not Qwen's official rewriting prompt.** Qwen ships its own
 * `system_prompt_t2i.txt` / `guide_t2i.md` / `guide_edit.md`, which this package
 * deliberately does not redistribute (see `docs/license-and-limits.md`). What is
 * below is the plugin's own house style, authored against the same output
 * contract so a Studio rewrite and an Agent rewrite are interchangeable: either
 * one can be pasted into the other, and either can be handed straight to
 * `qwen_image_generate`. Where the two schools disagree — the house style bans
 * `4K` / `masterpiece` and wants long observational prose, while Alibaba's
 * published formula is a `主体+场景+风格+镜头+氛围+细节` keyword stack that
 * actively invites those quality words — this file follows the house style.
 *
 * Exported only so the test suite can pin the rules that must survive an edit:
 * the house skeleton (sentence count, the single closing sentence), the banned
 * filler words, and the "no ratio in the prose" rule. The wording itself is
 * free to change; those properties are not.
 *
 * The `formula` variant below is the other school — see {@link FORMULA_SYSTEM_PROMPT}.
 */
export const PROSE_SYSTEM_PROMPT = `你是 Qwen-Image 2.1 的生图提示词改写器。你只做一件事：把用户的口语需求改写成一幅**画面上有什么**的描述性散文。

这套规则与插件自带的 skill 规则（references/t2i_rules.md、references/edit_rules.md）同源，改写结果必须能直接互换使用。

一、先分拣用户的输入
1. 画面事实：必须原样保留——要显示的文字原文（逐字符照抄，连标点空格，是中文就留中文）、指定物件、数量、颜色、位置。
2. 对任务的要求：「不要糊」「要高清」「用双引号」是给你看的指令，不是画面内容。散文里不出现「确保」「不要」「请你画」这类字眼。
3. 用户没说、由你定的：三字需求与三百字需求，最终都要写成同等篇幅的完整画面。需求越短，你要自己定的越多——不是写得更短。

二、画幅
绝不把比例、分辨率、像素数写进正文。「4K」「高清」是画质形容，不是比例线索；比例由工作台的画幅选择器负责。

三、散文骨架（文生图）
1. 一段话，不换行分节，约 20 句、400–500 词。第一句是锚定句（约 20 词）：媒介、风格、主体、背景/主色，通常连朝向一起说。媒介名词（photograph / poster / illustration / infographic / logo…）不可省。
2. 中间走一遍画面：先在心里列出空间清单，用 8–14 个方位短语，必须够到四角、边缘与中心，不要全挤在中间。约三分之一的句子直接以方位短语开头（"On the right side of the frame, …"）。
   分区型（海报、页面、多物宽景）：背景与承托面 → 顶部带 → 主体左→中→右 → 底部带。
   单主体型（肖像、特写、单个物件）：背景与景深衰减 → 主体姿态与落位 → 头脸 → 身体与每件衣料曲面 → 手里或贴着它的东西 → 边缘小物。
3. 画面里的文字：没有就跳过，别硬加招牌。有则按阅读顺序逐个交代「位置 + 字重/颜色/大小写 + 内容」，如 a bold black headline across the top reads "夏日特惠"。换行说成「第二行」，不要把真换行塞进字符串。
4. 光照必须单独成句：光源、方向、质感，以及它留下的阴影与高光。
5. 最后**只准一句**退回整幅（"The overall composition …"）：平衡、配色、风格、情绪。不要接第二句总结。

四、用词纪律
1. 观察者口吻：现在时、第三人称、陈述句。不出现 "you"、"create"、"make sure"。
2. 禁止空话：8K、masterpiece、award-winning、highly detailed、photorealistic masterpiece。
3. 颜色带修饰（deep navy、muted olive、warm terracotta）；给材质不只给名词（frosted glass、coarse linen、condensation）。
4. 枚举不概括："several items" 不算描述；小数字写英文单词（three、five）。
5. 人是可见表面：体格、姿态、视线、表情、发型、肤色、每件衣物的颜色与材质。年龄用生命阶段（a child、middle-aged、in her thirties），不写具体岁数。脸被挡住就写挡住。
6. 物件按类别写不按品牌（silver laptop、compact hatchback），用户点名品牌时才写品牌。
7. 物理自洽：影子背离光源，反射与面前的东西对应，相邻物体比例一致。
8. 不确定就留余地（appears to be、a notebook or a tablet），用户钉死的部分才用确定语气。

五、编辑模式（给了参考图）
不重新描述整张画面，写成「在保持…的前提下，把…改为…」式改动指令；用 <image1>、<image2> 指代参考图。改动之外的部分一句话带过，节省注意力。

六、语言
用户用中文提问时，散文正文也写英文——Qwen-Image 的英文描述更稳；但画面里要显示的文字保持原文语言。用户明确要求中文提示词时才写中文。

输出格式：
第一行是改写后的提示词（一整段）。
第二行以「注：」开头，用不超过 40 字的中文说明这次做的关键判断（补了什么光线、定了什么构图）。没有就省略第二行。
不要解释、不要前言、不要引号包裹、不要分点编号。`

/**
 * The `formula` school: Alibaba's published prompt formula, as a keyword stack.
 *
 * This is the convention the Qianwen/Wan image docs describe — `主体 + 场景 +
 * 风格 + 镜头 + 氛围 + 细节修饰` — and it is deliberately the *opposite* of the
 * house prose style: short, comma-separated, and it treats `4K` /
 * `高分辨率` / `逆光` as legitimate detail modifiers instead of banned filler.
 * It exists because which school wins is an empirical question on 2.1, not a
 * settled one, and the panel should let a user try both on the same idea.
 *
 * Note what does *not* change: the ratio still belongs to the picker, on-image
 * text is still copied verbatim, and the answer is still one line plus an
 * optional `注：` note — the panel parses that shape either way.
 */
export const FORMULA_SYSTEM_PROMPT = `你是 Qwen-Image 2.1 的生图提示词改写器，按「关键词公式」改写。

公式：提示词 = 主体 + 场景 + 风格 + 镜头 + 氛围 + 细节修饰

一、六个槽位各写什么
1. 主体：谁/什么，带外形、服饰、动作。人物写年龄阶段、性别、面部特征、衣着。
2. 场景：环境、季节、天气、时间、周围有什么。
3. 风格：写实摄影 / 水彩 / 皮克斯 / 羊毛毡 / 平面设计 / 油画…，可给一到两个。
4. 镜头：景别（特写、半身、全身、远景）+ 角度（平视、俯拍、仰拍）+ 镜头类型（广角、微距、35mm）。
5. 氛围：情绪词，如 梦幻、孤寂、壮阔、童趣、温暖。
6. 细节修饰：光源位置、材质、道具搭配、环境细节、画质词（4K、高分辨率、锐利边缘、逆光）。

二、硬规则
1. 输出**一行**，用中文顿号「、」或英文逗号分隔短语，不写完整句子，不写「请你画」。
2. 只保留与画面有关的短语，不解释、不编号、不加引号。
3. 画面里要显示的文字用双引号原样夹住，逐字符照抄，不翻译。
4. 不写画幅比例、不写像素尺寸——比例由工作台的画幅选择器负责。
5. 用户没说、但画面需要的槽位由你补足；宁可补齐六个槽位，也不要只交三个。
6. 编辑模式（给了参考图）：主体槽写「保持 <image1> 的…」，其余槽写要新增或改动的内容。

三、语言
跟随用户语言：中文需求给中文关键词，英文需求给英文关键词。画面内文字保持原文语言。

输出格式：
第一行是关键词串。
第二行以「注：」开头，用不超过 40 字的中文说明补了哪些槽位。没有就省略第二行。`

/** Pick the system prompt for one rewriting convention. */
export function systemPromptFor(style: StudioPromptStyle | undefined): string {
  return style === 'formula' ? FORMULA_SYSTEM_PROMPT : PROSE_SYSTEM_PROMPT
}

/**
 * Resolve a usable provider/model pair from the host's LLM service.
 *
 * Model selection is the one genuinely ambiguous step: a host may mount several
 * providers and the list endpoint is async, so this probes the first provider
 * that advertises any model and takes its first entry. That is the same model
 * the conversation starts on, which is what "seamless" means here — no second
 * configuration surface for the user to keep in sync.
 *
 * @param llm - the service, or `undefined` when the host mounts none.
 * @returns the pair to call, or `undefined` when nothing usable was found.
 */
export async function resolveOptimizerModel(
  llm: LlmFace | undefined,
): Promise<{ provider: string; model: string } | undefined> {
  if (llm === undefined) return undefined
  let providers: Array<{ name?: string; id?: string }>
  try {
    providers = llm.listProviders()
  } catch {
    return undefined
  }
  for (const entry of providers) {
    const name = entry.name ?? entry.id
    if (typeof name !== 'string' || name.length === 0) continue
    try {
      const models = await llm.listModels(name)
      const first = models.find((candidate) => {
        const id = candidate.id ?? candidate.model ?? candidate.name
        return typeof id === 'string' && id.length > 0
      })
      const id = first === undefined ? undefined : (first.id ?? first.model ?? first.name)
      if (typeof id === 'string' && id.length > 0) return { provider: name, model: id }
    } catch {
      // A provider that cannot enumerate models is not necessarily broken, but
      // without an id there is nothing to call, so move on to the next one.
    }
  }
  return undefined
}

/** Read the `llm` service off a context, treating every failure as "absent". */
export function llmOf(ctx: Context): LlmFace | undefined {
  try {
    const candidate = (ctx as unknown as { get?: (name: string) => unknown }).get?.('llm')
    if (candidate === undefined || candidate === null) return undefined
    const face = candidate as Partial<LlmFace>
    if (typeof face.listProviders !== 'function' || typeof face.stream !== 'function') return undefined
    if (typeof face.listModels !== 'function') return undefined
    return face as LlmFace
  } catch {
    return undefined
  }
}

/** Clamp history to a bounded, well-formed block. */
function contextBlock(turns: readonly StudioOptimizeTurn[] | undefined): string {
  if (turns === undefined || turns.length === 0) return ''
  const recent = turns.slice(-MAX_CONTEXT_TURNS)
  const lines = recent.map((turn) => {
    const text = turn.text.trim().slice(0, MAX_CONTEXT_TURN_CHARS)
    if (text.length === 0) return undefined
    return `${turn.role === 'user' ? '用户' : '助手'}：${text}`
  }).filter((line): line is string => line !== undefined)
  if (lines.length === 0) return ''
  return `\n\n最近对话（用于理解上文语境，不要复述）：\n${lines.join('\n')}`
}

/** Assemble the user turn: the request, the canvas, the mode, and the context. */
export function buildOptimizeUserText(input: StudioOptimizeRequest): string {
  const mode = input.editing
    ? '这是一次图像编辑：用户会同时提供参考图，提示词应当描述「要改什么」，而不是重新画一张。'
    : '这是一次文生图：从零开始画。'
  const ratio = typeof input.ratio === 'string' && input.ratio.trim().length > 0
    ? `目标画幅比例：${input.ratio.trim()}。`
    : ''
  return `用户需求：${input.prompt.trim()}\n\n${mode}${ratio.length > 0 ? `\n${ratio}` : ''}${contextBlock(input.context)}`
}

/**
 * Split the model's answer into the prompt and the optional note.
 *
 * The model is told to put a `注：` line second; this parses that convention
 * rather than trusting it, and falls back to "the whole answer is the prompt"
 * when no note line is present.
 *
 * @param text - the assembled text blocks.
 * @returns the prompt (never empty) and the note when one was produced.
 */
export function splitOptimizerAnswer(text: string): { prompt: string; note?: string } {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { prompt: '' }
  const lines = trimmed.split(/\r?\n/)
  const noteIndex = lines.findIndex((line, index) => index > 0 && /^注[:：]/.test(line.trim()))
  if (noteIndex === -1) return { prompt: trimmed }
  const prompt = lines.slice(0, noteIndex).join('\n').trim()
  const note = lines.slice(noteIndex).join(' ').replace(/^注[:：]\s*/, '').trim()
  return note.length > 0 ? { prompt, note } : { prompt }
}

/** Strip a surrounding quote pair the model sometimes adds despite being told not to. */
export function stripWrappingQuotes(text: string): string {
  const pairs: Array<[string, string]> = [['"', '"'], ['“', '”'], ['「', '」'], ["'", "'"]]
  for (const [open, close] of pairs) {
    if (text.length > 2 && text.startsWith(open) && text.endsWith(close)) {
      const inner = text.slice(open.length, text.length - close.length)
      // Only unwrap when the quotes are the outer pair and do not close early.
      if (!inner.includes(close)) return inner.trim()
    }
  }
  return text
}

/**
 * Ask the conversation model to rewrite one Studio prompt.
 *
 * @param ctx - host context; `llm` is looked up here, never injected statically.
 * @param input - the user's text plus whatever context the panel could supply.
 * @param signal - aborts the upstream call when the panel cancels.
 * @returns the rewritten prompt and its provenance.
 * @throws When no model is reachable, or the model produced nothing usable —
 *   both phrased for the user, since this surfaces in the panel's note line.
 */
export async function optimizeStudioPrompt(
  ctx: Context,
  input: StudioOptimizeRequest,
  signal: AbortSignal,
): Promise<StudioOptimizeResponse> {
  const llm = llmOf(ctx)
  const target = await resolveOptimizerModel(llm)
  if (target === undefined || llm === undefined) {
    throw new Error('提示词优化不可用：当前会话没有可调用的对话模型。')
  }
  const Assembler = await loadAssembler()
  if (Assembler === undefined) {
    throw new Error('提示词优化不可用：宿主没有安装 @deepseek-ai/dsh-llm。')
  }
  const assembler = new Assembler()
  for await (const chunk of llm.stream({
    provider: target.provider,
    model: target.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: buildOptimizeUserText(input) }] }],
    system: systemPromptFor(input.style),
    maxTokens: MAX_TOKENS,
    temperature: 0.7,
    signal,
  })) {
    // The assembler's chunk union and the structural `unknown` this module
    // consumes are the same wire vocabulary; the cast is the seam, not a lie.
    assembler.push(chunk as never)
  }
  if (signal.aborted) throw new Error('提示词优化已取消')

  // `finish.kind === 'aborted' | 'error'` both mean no usable answer. Checked
  // through a structural shape because the failure payload is provider-specific
  // and must never be echoed here: it can carry the endpoint and request id.
  const finish = assembler.finish as FinishLike | undefined
  const failed = finish?.kind === 'error' || finish?.kind === 'aborted'

  const text = (assembler.blocks() as readonly TextLikeBlock[])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
  const split = splitOptimizerAnswer(text)
  const prompt = stripWrappingQuotes(split.prompt)
  if (prompt.length === 0) {
    throw new Error(failed || text.trim().length === 0
      ? '对话模型没有返回可用内容，请重试或换一个模型。'
      : '对话模型没有返回提示词，请重试或换一个模型。')
  }
  return {
    prompt,
    model: target.model,
    ...(split.note === undefined ? {} : { note: split.note }),
  }
}
