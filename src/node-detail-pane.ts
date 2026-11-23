/**
 * The node detail tab (U06, `../docs/usage-reference.md` §8).
 *
 * ## Why a tab, and not a bigger node
 *
 * A node on the canvas gets **simple** controls — the hover action row, the
 * right-click menu, the property drawer (`./node-inspector.ts`). The MOSS layout
 * node is the case that does not fit: its editor needs room, precise input and a
 * long stay. So the panel grows a third tab family (`node:<boardId>:<itemId>`,
 * state machine in `./workbench-tabs.ts`) and this module is what lives in it.
 *
 * Three node kinds, three views (§8.2):
 *
 * - **layout** — the full-size editor (`mountLayoutEditor`, `pointerScale` left
 *   at its default 1: there is no zoomed ancestor in a tab, and the editor's
 *   pointer deltas are measured against its own box). Toolbar: draft size, box
 *   count, the ratio tier the draft maps onto, 撤销, 保存, 生成, 返回画布.
 * - **image** — the picture at full size plus the facts a picture has, and
 *   「按这张继续」.
 * - **task** — the parameters it was started with, why it failed, and 重试.
 *
 * ## The split this file keeps
 *
 * Everything the pane *decides* is a pure function here — which view a kind has,
 * what a tab is called, what a draft maps onto, what a save body looks like, how
 * a draft becomes the MOSS request, how the undo stack moves — so
 * `test/studio.test.mjs` can assert it with no DOM, exactly like
 * `canvas-flow-model.ts` and `node-inspector.ts` before it. The component below
 * only draws what those functions returned.
 *
 * ## One editor per node (§8.4, WD10)
 *
 * A layout draft has exactly one editor at a time. The rule is driven by the tab
 * strip, not by mount order: while a node's detail tab is open the canvas paints
 * the node as a **read-only thumbnail** (`layoutEditorOwner` → `detail`), and
 * closing the tab gives the in-node editor back. {@link DetailEditorClaims} is
 * the second, instant-level guard for the case the strip cannot see: two mounts
 * of the same node in one page (a double mount, a future keep-alive canvas).
 *
 * ## What this module deliberately does not own
 *
 * The board store, the undo stack of the canvas and the generation path all stay
 * with the canvas tab. A detail tab therefore **reads** the board over the same
 * route the studio reads it from, writes its draft through `save-layout-node`
 * (the one writer §8.1 defines), and asks the canvas to run a generation through
 * an **intent** ({@link CanvasIntent}) instead of starting a second one — the
 * run has to land on the canvas as a task node, and only the canvas can do that.
 *
 * @module node-detail-pane
 */
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  STUDIO_BOARD_ROUTE,
  STUDIO_LAYOUT_RATIO_TOLERANCE,
  STUDIO_MAX_LAYOUT_CHARS,
  fitStudioRatio,
  studioFileUrl,
  type BoardDetail,
  type BoardItem,
  type BoardLayoutDraft,
  type BoardTaskParams,
} from './studio-shared.ts'
import {
  LAYOUT_NODE_DEFAULT_WIDTH,
  clampLayoutNodeWidth,
  compileLayout,
  draftToEditorState,
  layoutNodeHeight,
  mountLayoutEditor,
  stateToDraft,
  type LayoutDraft,
  type LayoutEditorHandle,
  type LayoutEditorState,
} from './layout-editor.ts'
import type { NodeDetailKind, TabDescriptor } from './workbench-tabs.ts'

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/** The copy a detail tab shows while it is still reading the board. */
export const NODE_DETAIL_LOADING_COPY = '正在读取节点…'

/** §8.2's three views, plus the defensive arm for anything else. */
export type DetailView = 'layout' | 'image' | 'task' | 'unknown'

/** A node kind no detail view exists for (§8.2's "三类之外"). */
export const NODE_DETAIL_UNKNOWN_COPY = '这类节点没有详情视图。'

/** A detail tab whose item is no longer in its board (deleted elsewhere). */
export const NODE_DETAIL_MISSING_COPY = '这个节点已经不在项目里了。'

/** §8.3's degraded breadcrumb: the source canvas is not open. */
export const NODE_DETAIL_ORPHAN_COPY = '来源画布没有打开，编辑会直接写回项目。'

/** What the pane calls a project it cannot name. */
export const NODE_DETAIL_UNNAMED_BOARD = '未命名项目'

/** One-word kind names, the first half of every §8.2 tab title. */
export const NODE_DETAIL_KIND_LABELS: Readonly<Record<NodeDetailKind, string>> = {
  layout: '布局',
  task: '任务',
  image: '图片',
}

/** How much of a prompt a tab title may show before it is clipped (§8.2). */
export const NODE_DETAIL_TITLE_MAX = 18

/** How long one draft edit waits before it is written (the canvas uses 700 ms). */
export const NODE_DETAIL_SAVE_DELAY_MS = 600

/** How many drafts the pane's 撤销 can walk back. */
export const NODE_DETAIL_HISTORY_LIMIT = 40

/** How many boxes a thumbnail draws; past this the count line is the summary. */
export const NODE_DETAIL_THUMB_BOX_LIMIT = 60

/* -------------------------------------------------------------------------- */
/* Kinds and titles (§8.2)                                                    */
/* -------------------------------------------------------------------------- */

/** Which view a `node:` tab hosts, from its stored kind — defensively. */
export function detailViewOf(kind: unknown): DetailView {
  return kind === 'layout' || kind === 'image' || kind === 'task' ? kind : 'unknown'
}

/**
 * The tab kind for a canvas node kind, or `undefined` when it has none.
 *
 * A `draft` node is the one kind without a detail view: it is not a board item
 * yet, so there is nothing for the tab to open. Every other node kind is one.
 */
export function detailKindOfNodeKind(kind: unknown): NodeDetailKind | undefined {
  const view = detailViewOf(kind)
  return view === 'unknown' ? undefined : view
}

/** What a tab title may say about its node (§8.2's `<项目名>` / `<首行>` / `<时间>`). */
export interface NodeDetailSubject {
  /** The project the node lives in. */
  readonly boardName?: string
  /** The node's prompt, of which the first line names it. */
  readonly prompt?: string
  /** The node's creation time, which is the only name an imported picture has. */
  readonly createdAt?: string
}

/** The first line of a name, clipped to {@link NODE_DETAIL_TITLE_MAX}. */
export function shortSubject(text: unknown, max: number = NODE_DETAIL_TITLE_MAX): string {
  if (typeof text !== 'string') return ''
  const line = text.split(/\r?\n/)[0]?.trim() ?? ''
  return line.length <= max ? line : `${line.slice(0, max)}…`
}

/**
 * `HH:MM` out of an ISO timestamp.
 *
 * Sliced out of the string rather than formatted through `Date`: the title must
 * read the same in a test as in the user's browser, and a local-time formatter
 * would make it depend on the machine's zone. No clock is read here (§ the
 * module note on purity).
 */
export function clockOf(createdAt: unknown): string | undefined {
  if (typeof createdAt !== 'string') return undefined
  const match = /T(\d{2}:\d{2})/.exec(createdAt)
  return match === null ? undefined : match[1]
}

/**
 * A detail tab's title (§8.2): `布局 · <项目名>`, `任务 · <prompt 首行>`,
 * `图片 · <时间>`.
 *
 * The parts are all optional because the strip renders before the pane has read
 * the board: with no subject at all the title is still `布局 · 未命名项目`
 * rather than an empty tab. The key never changes (§3.1), so a title that fills
 * in later only relabels a tab.
 */
export function nodeDetailTitle(kind: NodeDetailKind, subject: NodeDetailSubject = {}): string {
  const label = NODE_DETAIL_KIND_LABELS[kind] ?? '节点'
  const boardName = shortSubject(subject.boardName)
  if (kind === 'task') {
    const prompt = shortSubject(subject.prompt)
    if (prompt.length > 0) return `${label} · ${prompt}`
  }
  if (kind === 'image') {
    const clock = clockOf(subject.createdAt)
    if (clock !== undefined) return `${label} · ${clock}`
  }
  return `${label} · ${boardName.length > 0 ? boardName : NODE_DETAIL_UNNAMED_BOARD}`
}

/* -------------------------------------------------------------------------- */
/* The single editor (§8.4, WD10)                                             */
/* -------------------------------------------------------------------------- */

/** Which window owns a layout node's draft editor. */
export type LayoutEditorOwner = 'detail' | 'canvas'

/**
 * Whether the canvas may mount a node's editor, or has to draw the thumbnail.
 *
 * Derived from the tab strip — not from "who mounted last" — because that is
 * what makes the rule survive a canvas remount: as long as the node's detail tab
 * is open, the canvas stays read-only, whichever of the two is on screen.
 */
export function layoutEditorOwner(itemId: string, detailOpenIds: ReadonlySet<string> | undefined): LayoutEditorOwner {
  if (typeof itemId !== 'string' || itemId.length === 0) return 'canvas'
  return detailOpenIds?.has(itemId) === true ? 'detail' : 'canvas'
}

/** Every item id that already has a detail tab open on one board. */
export function openDetailItemIds(tabs: readonly TabDescriptor[], boardId: string): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const tab of tabs) {
    if (tab.kind !== 'node' || tab.boardId !== boardId) continue
    if (typeof tab.itemId !== 'string' || tab.itemId.length === 0) continue
    ids.add(tab.itemId)
  }
  return ids
}

/**
 * The in-page claim on one node's editor.
 *
 * §8.4's rule is one editor per node; the tab strip already makes the *second
 * tab* impossible (the key is the node), so this guards the other half — the
 * same node mounted twice in one page (a double mount, or the keep-alive canvas
 * a later phase brings). A claim is a plain set membership test, so it can be
 * asserted without a DOM.
 */
export class DetailEditorClaims {
  private readonly held = new Set<string>()

  /** Claim `key`; `false` when somebody else already holds it. */
  claim(key: string): boolean {
    if (typeof key !== 'string' || key.length === 0) return false
    if (this.held.has(key)) return false
    this.held.add(key)
    return true
  }

  /** Give `key` back; a release of something never claimed is a no-op. */
  release(key: string): void {
    this.held.delete(key)
  }

  /** Whether an editor is mounted on `key` right now. */
  has(key: string): boolean {
    return this.held.has(key)
  }

  /** How many editors are mounted — the number §8.4 says is at most one per node. */
  get size(): number {
    return this.held.size
  }
}

/** The page-wide registry the pane claims into, and §8.4's proof. */
export const detailEditorClaims = new DetailEditorClaims()

/* -------------------------------------------------------------------------- */
/* The layout draft: readout, generation, persistence                          */
/* -------------------------------------------------------------------------- */

/** What the layout toolbar prints, and what decides whether 生成 is available. */
export interface LayoutDetailSummary {
  /** `1536×1024` — the draft's own pixels, not the node's display box. */
  readonly size: string
  /** How many boxes the draft holds. */
  readonly boxes: number
  /** The official tier the draft maps onto, or `—`. */
  readonly ratio: string
  /** `fitStudioRatio`'s distance from that tier, 0..1. */
  readonly deviation: number
  /** Whether a run could be submitted at all (§8.4 forbids stretching). */
  readonly mappable: boolean
}

/** The draft's size line, or the placeholder an absent draft gets. */
export function layoutDetailSummary(draft: BoardLayoutDraft | undefined): LayoutDetailSummary {
  if (draft === undefined) {
    return { size: '—', boxes: 0, ratio: '—', deviation: 1, mappable: false }
  }
  const fit = fitStudioRatio(draft.width, draft.height)
  const mappable = fit !== undefined && fit.deviation <= STUDIO_LAYOUT_RATIO_TOLERANCE
  return {
    size: `${String(draft.width)}×${String(draft.height)}`,
    boxes: Array.isArray(draft.items) ? draft.items.length : 0,
    ratio: fit === undefined ? '—' : fit.ratio,
    deviation: fit === undefined ? 1 : fit.deviation,
    mappable,
  }
}

/**
 * The MOSS request a draft generates, or the reason it cannot (§8.4, C14).
 *
 * One implementation for both containers: the canvas node's 生成 and the detail
 * tab's 生成 have to submit the same thing, and a second copy of "is this draft
 * generatable" is exactly the kind of drift the report exists to prevent. The
 * reasons are the strings the canvas has always shown, so the copy did not move
 * with the code.
 */
export type LayoutGeneratePlan =
  | { readonly ok: true; readonly params: BoardTaskParams }
  | { readonly ok: false; readonly reason: string }

export function layoutGeneratePlan(draft: BoardLayoutDraft | undefined, referenceCount = 0): LayoutGeneratePlan {
  if (draft === undefined) return { ok: false, reason: '草稿缺失：这个布局节点没有可生成的内容。' }
  if (referenceCount > 0) {
    return {
      ok: false,
      reason: '这个布局节点接着 ' + String(referenceCount) + ' 张参考图，但 MOSS 的布局通路（compiled JSON 当正向编码文本）' +
        '没有参考图输入槽——布局 + 参考图改图的叠加行为官方未定义。请断开参考图，或复制一张图用「用作参考」单独改图。',
    }
  }
  if (!Array.isArray(draft.items) || draft.items.length === 0) {
    return { ok: false, reason: '布局至少需要一个画框：先在内嵌编辑器里拖出一个框，再生成。' }
  }
  const caption = typeof draft.summary?.caption === 'string' ? draft.summary.caption.trim() : ''
  if (caption.length === 0) {
    return {
      ok: false,
      reason: '布局缺少整图描述（summary.caption）；MOSS 把它当布局 prompt 的语义锚点，先写上。',
    }
  }
  let compiled: string
  try {
    compiled = compileLayout(draft as unknown as LayoutDraft)
  } catch (error) {
    return { ok: false, reason: '布局还不能生成：' + (error instanceof Error ? error.message : String(error)) }
  }
  if (compiled.length > STUDIO_MAX_LAYOUT_CHARS) {
    return { ok: false, reason: '布局 compiled 超过 ' + String(STUDIO_MAX_LAYOUT_CHARS) + ' 字符上限。' }
  }
  const fit = fitStudioRatio(draft.width, draft.height)
  if (fit === undefined) {
    return { ok: false, reason: '布局 draft 尺寸无效，无法映射到官方画幅比例。' }
  }
  if (fit.deviation > STUDIO_LAYOUT_RATIO_TOLERANCE) {
    return {
      ok: false,
      reason: '布局 draft 比例 ' + String(draft.width) + '×' + String(draft.height) +
        ' 不在官方七档内（最接近 ' + fit.ratio + '，偏差 ' + (fit.deviation * 100).toFixed(1) +
        '%）；请把 draft 尺寸改到七档比例，不静默拉伸。',
    }
  }
  return {
    ok: true,
    params: { prompt: caption, ratio: fit.ratio, count: 1, layout: compiled },
  }
}

/** One `save-layout-node` payload's geometry (§8.1). */
export interface LayoutWrite {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly draft: BoardLayoutDraft
}

/**
 * The geometry a draft write carries.
 *
 * The display width stays the item's (a resize is a canvas decision this tab
 * does not make), and the height follows the draft's proportion — the same rule
 * `updateLayoutDraft` applies on the canvas, so a draft edited here cannot leave
 * the node's box the wrong shape for its content.
 */
export function layoutWriteOf(
  item: { readonly x?: number | null; readonly y?: number | null; readonly w?: number | null } | undefined,
  draft: BoardLayoutDraft,
): LayoutWrite {
  const x = typeof item?.x === 'number' && Number.isFinite(item.x) ? item.x : 0
  const y = typeof item?.y === 'number' && Number.isFinite(item.y) ? item.y : 0
  const rawWidth = typeof item?.w === 'number' && Number.isFinite(item.w) ? item.w : LAYOUT_NODE_DEFAULT_WIDTH
  const w = clampLayoutNodeWidth(rawWidth)
  return { x, y, w, h: layoutNodeHeight(w, draft), draft }
}

/** The drafts a 撤销 can walk back, oldest first. */
export interface DraftHistory {
  readonly entries: readonly BoardLayoutDraft[]
}

/** A pane that has not been edited yet. */
export const EMPTY_DRAFT_HISTORY: DraftHistory = { entries: [] }

/** Record the draft a change replaced, keeping at most `limit` of them. */
export function pushDraftHistory(
  history: DraftHistory,
  draft: BoardLayoutDraft,
  limit: number = NODE_DETAIL_HISTORY_LIMIT,
): DraftHistory {
  const bounded = Math.max(1, Math.trunc(limit))
  const entries = [...history.entries, draft]
  return { entries: entries.length > bounded ? entries.slice(entries.length - bounded) : entries }
}

/** Pop the newest recorded draft; an empty stack answers `undefined`. */
export function undoDraftHistory(history: DraftHistory): { readonly history: DraftHistory; readonly draft?: BoardLayoutDraft } {
  const last = history.entries[history.entries.length - 1]
  if (last === undefined) return { history }
  return { history: { entries: history.entries.slice(0, -1) }, draft: last }
}

/** One box of {@link draftPreviewBoxes}, in the host rectangle's percentages. */
export interface DraftPreviewBox {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/**
 * A draft drawn as percentages, for the canvas node's read-only thumbnail.
 *
 * §8.4 option 3: the shell draws the preview from the draft data instead of
 * asking the editor for a read-only mode, so `layout-editor.ts` keeps its API.
 * Values are clamped into the rectangle and degenerate boxes are dropped — a
 * hand-edited board can hold a zero-size box, and a negative width would paint a
 * silhouette outside the node.
 */
export function draftPreviewBoxes(
  draft: BoardLayoutDraft | undefined,
  limit: number = NODE_DETAIL_THUMB_BOX_LIMIT,
): readonly DraftPreviewBox[] {
  if (draft === undefined || !Array.isArray(draft.items)) return []
  const width = typeof draft.width === 'number' && draft.width > 0 ? draft.width : 0
  const height = typeof draft.height === 'number' && draft.height > 0 ? draft.height : 0
  if (width === 0 || height === 0) return []
  const clamp = (value: number): number => Math.min(100, Math.max(0, value))
  const boxes: DraftPreviewBox[] = []
  for (const item of draft.items.slice(0, Math.max(0, limit))) {
    const bbox = item?.bbox
    if (!Array.isArray(bbox) || bbox.length < 4) continue
    const [x1, y1, x2, y2] = bbox
    if (![x1, y1, x2, y2].every((value) => typeof value === 'number' && Number.isFinite(value))) continue
    // Each *edge* is clamped into the rectangle, then the span is derived: a box
    // that hangs off the canvas shows its visible part rather than a rectangle
    // that pretends to be somewhere it is not.
    const left = clamp((Math.min(x1, x2) / width) * 100)
    const right = clamp((Math.max(x1, x2) / width) * 100)
    const top = clamp((Math.min(y1, y2) / height) * 100)
    const bottom = clamp((Math.max(y1, y2) / height) * 100)
    if (right - left <= 0 || bottom - top <= 0) continue
    boxes.push({ left, top, width: right - left, height: bottom - top })
  }
  return boxes
}

/* -------------------------------------------------------------------------- */
/* Asking the canvas to do something                                          */
/* -------------------------------------------------------------------------- */

/** The three things a detail tab can ask the canvas for. */
export type CanvasIntentKind = 'generate-layout' | 'continue-from' | 'retry'

/**
 * One request from a detail tab to the canvas tab, in flight.
 *
 * A detail tab cannot run a generation itself: the run has to land on the canvas
 * as a task node and stream into it (`startGeneration`), and only the canvas tab
 * owns that. So the pane asks, the shell activates the canvas, and the canvas
 * consumes the request exactly once — `token` is what makes a second click a
 * fresh request rather than a no-op.
 */
export interface CanvasIntent {
  readonly kind: CanvasIntentKind
  readonly boardId: string
  readonly nodeId: string
  readonly token: string
}

/** The one action a detail tab of this kind offers (§8.2). */
export function detailIntentOf(kind: NodeDetailKind): CanvasIntentKind | undefined {
  if (kind === 'layout') return 'generate-layout'
  if (kind === 'image') return 'continue-from'
  if (kind === 'task') return 'retry'
  return undefined
}

/** Whether a canvas intent is still worth running for the board on screen. */
export function intentAppliesTo(intent: CanvasIntent | undefined, boardId: string | undefined): boolean {
  if (intent === undefined) return false
  if (typeof boardId !== 'string' || boardId.length === 0) return false
  return intent.boardId === boardId && intent.nodeId.length > 0
}

/** Whether `kind` is one of {@link CanvasIntentKind} — used on a caller's string. */
export function isCanvasIntentKind(kind: unknown): kind is CanvasIntentKind {
  return kind === 'generate-layout' || kind === 'continue-from' || kind === 'retry'
}

/**
 * The request a detail toolbar's primary action mints.
 *
 * It takes the **action**, not the node kind: the shell has already been told
 * which action by the pane (`detailIntentOf`), and re-deriving it from the tab's
 * kind here would be a second mapping to keep in step. A malformed action or a
 * missing id yields no request, which reads as "nothing to run".
 */
export function intentFor(
  kind: unknown,
  boardId: string,
  nodeId: string,
  token: string,
): CanvasIntent | undefined {
  if (!isCanvasIntentKind(kind)) return undefined
  if (typeof boardId !== 'string' || boardId.length === 0) return undefined
  if (typeof nodeId !== 'string' || nodeId.length === 0) return undefined
  return { kind, boardId, nodeId, token }
}

/* -------------------------------------------------------------------------- */
/* Wire helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Read a JSON body defensively: a proxy error page is not JSON. */
async function readJsonBody(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = await response.json()
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** One board-route action; resolves to the host's refusal message, if any. */
async function postBoardRoute(body: Record<string, unknown>): Promise<{ error?: string }> {
  try {
    const response = await fetch(STUDIO_BOARD_ROUTE, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (response.ok) return {}
    const payload = await readJsonBody(response)
    return {
      error: typeof payload?.error === 'string' ? payload.error : `画板操作失败（HTTP ${String(response.status)}）`,
    }
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * Read one board, which is where a detail tab's node comes from.
 *
 * The pane is a separate mount from the canvas (§ the module note), so it reads
 * the board over the route the studio reads it from rather than reaching into
 * another component's state. A tab therefore always shows what the *file* says,
 * which is also what makes "edit here, go back, see it there" true.
 */
async function readBoardDetail(boardId: string): Promise<{ detail?: BoardDetail; error?: string }> {
  try {
    const response = await fetch(`${STUDIO_BOARD_ROUTE}?board=${encodeURIComponent(boardId)}`, {
      credentials: 'same-origin',
    })
    const payload = await readJsonBody(response)
    if (!response.ok || payload === undefined || !Array.isArray(payload['items'])) {
      return { error: typeof payload?.error === 'string' ? payload.error : '画板读取失败' }
    }
    return { detail: payload as unknown as BoardDetail }
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/* -------------------------------------------------------------------------- */
/* Rendering helpers                                                          */
/* -------------------------------------------------------------------------- */

/** One toolbar button, addressable by its action id. */
function detailButton(options: {
  readonly action: string
  readonly label: string
  readonly title: string
  readonly primary?: boolean
  readonly danger?: boolean
  readonly disabled?: boolean
  readonly onClick: () => void
}): ReactNode {
  const className = [
    'dsh-forge-btn',
    options.primary === true ? 'is-primary' : 'is-ghost',
    options.danger === true ? 'is-danger' : '',
  ].filter((part) => part.length > 0).join(' ')
  return createElement(
    'button',
    {
      type: 'button',
      className,
      title: options.title,
      disabled: options.disabled === true,
      'data-detail-action': options.action,
      onClick: options.onClick,
    },
    options.label,
  )
}

/** One read-only row of a detail view. */
function factRow(label: string, value: string, id?: string): ReactNode {
  return createElement(
    'div',
    { className: 'dsh-forge-detail-row', 'data-detail-field': id ?? label },
    createElement('span', { className: 'dsh-forge-label' }, label),
    createElement('span', { className: 'dsh-forge-detail-value', title: value }, value),
  )
}

/** The card a detail tab shows when it has no view to draw. */
function noticeCard(copy: string, onClose: () => void, retry?: () => void): ReactNode {
  return createElement('div', { className: 'dsh-forge-detail-notice' }, [
    createElement('p', { key: 'copy', className: 'dsh-forge-detail-copy' }, copy),
    createElement(
      'div',
      { key: 'actions', className: 'dsh-forge-detail-actions' },
      retry === undefined
        ? null
        : detailButton({ action: 'reload', label: '重试', title: '再读一次这个项目', onClick: retry }),
      detailButton({ action: 'close', label: '关闭页签', title: '关掉这个详情页签', onClick: onClose }),
    ),
  ])
}

/* -------------------------------------------------------------------------- */
/* The pane                                                                   */
/* -------------------------------------------------------------------------- */

/** What the shell hands a node detail tab. */
export interface NodeDetailPaneProps {
  /** The project the node lives in. */
  readonly boardId: string
  /** The board item. */
  readonly itemId: string
  /** The kind the tab was opened for (the key cannot carry it, §8.2). */
  readonly kind: NodeDetailKind
  /** The project's name, for the breadcrumb and the tab title. */
  readonly boardName?: string
  /** §8.3: the source canvas tab is not open. */
  readonly orphaned?: boolean
  /** Activate the source canvas tab (reopening it when it is gone). */
  readonly onBackToCanvas: () => void
  /** Close this detail tab. */
  readonly onClose: () => void
  /** Report what the strip should call this tab (§8.2's data-derived titles). */
  readonly onSubject?: (subject: NodeDetailSubject) => void
  /** Ask the canvas to run this kind's one action (生成 / 继续 / 重试). */
  readonly onIntent?: (kind: CanvasIntentKind) => void
}

/**
 * One node's detail tab (§8.2).
 *
 * Mounted by the shell in place of the canvas pane, for one `node:` key. It owns
 * no board state: it reads the item, edits a layout draft locally, writes
 * through `save-layout-node`, and asks the canvas to generate.
 */
export function NodeDetailPane(props: NodeDetailPaneProps): ReactNode {
  const latest = useRef(props)
  latest.current = props
  const hostRef = useRef<HTMLElement | null>(null)
  const editorRef = useRef<LayoutEditorHandle | undefined>(undefined)
  const appliedRef = useRef<BoardLayoutDraft | undefined>(undefined)
  const draftRef = useRef<BoardLayoutDraft | undefined>(undefined)
  const itemRef = useRef<BoardItem | undefined>(undefined)
  const savedRef = useRef<BoardLayoutDraft | undefined>(undefined)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pendingRef = useRef<BoardLayoutDraft | undefined>(undefined)
  const claimKeyRef = useRef<string | undefined>(undefined)
  const handlersRef = useRef<{ submitEdit: (state: LayoutEditorState) => void }>({ submitEdit: () => {} })

  const [detail, setDetail] = useState<BoardDetail | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [reloadToken, setReloadToken] = useState(0)
  const [draft, setDraft] = useState<BoardLayoutDraft | undefined>(undefined)
  const [savedDraft, setSavedDraft] = useState<BoardLayoutDraft | undefined>(undefined)
  const [history, setHistory] = useState<DraftHistory>(EMPTY_DRAFT_HISTORY)
  const [note, setNote] = useState<string | undefined>(undefined)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [mountError, setMountError] = useState<string | undefined>(undefined)

  const view = detailViewOf(props.kind)
  const row = useMemo(
    () => (detail === undefined ? undefined : detail.items.find((entry) => entry.id === props.itemId)),
    [detail, props.itemId],
  )

  /* ---- read the node (§8.1: one board read per mount) -------------------- */
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(undefined)
    void (async () => {
      const result = await readBoardDetail(latest.current.boardId)
      if (cancelled) return
      setLoading(false)
      if (result.error !== undefined) {
        setLoadError(result.error)
        return
      }
      setDetail(result.detail)
      const item = result.detail?.items.find((entry) => entry.id === latest.current.itemId)
      itemRef.current = item
      // A layout item without a draft is unreadable, and the canvas's own read
      // skips it too (`nodesFromBoard`) — the pane says so rather than mounting
      // an editor on nothing.
      if (item !== undefined && item.kind === 'layout' && item.draft !== undefined) {
        draftRef.current = item.draft
        setDraft(item.draft)
        setSavedDraft(item.draft)
        savedRef.current = item.draft
        setHistory(EMPTY_DRAFT_HISTORY)
        setNote(undefined)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [props.boardId, props.itemId, reloadToken])

  /* ---- tell the strip what this tab is about (§8.2 titles) --------------- */
  useEffect(() => {
    if (row === undefined) return
    const report = latest.current.onSubject
    if (report === undefined) return
    report({ prompt: row.prompt, createdAt: row.createdAt })
  }, [row])

  /* ---- write one draft back (§8.1's `save-layout-node`) ------------------ */
  const persistNow = useCallback(async (next: BoardLayoutDraft): Promise<boolean> => {
    const item = itemRef.current
    if (item === undefined) {
      setSaveError('节点还没读到，无法保存。')
      return false
    }
    const write = layoutWriteOf(item, next)
    const after = await postBoardRoute({
      action: 'save-layout-node',
      board: latest.current.boardId,
      item: latest.current.itemId,
      x: write.x,
      y: write.y,
      w: write.w,
      h: write.h,
      draft: write.draft,
      ...(item.parents.length === 0 ? {} : { parents: [...item.parents] }),
    })
    if (after.error !== undefined) {
      setSaveError(after.error)
      return false
    }
    setSaveError(undefined)
    setSavedDraft(next)
    savedRef.current = next
    return true
  }, [])

  /** Coalesce a burst of box drags into one write (`NODE_DETAIL_SAVE_DELAY_MS`). */
  const scheduleSave = useCallback((next: BoardLayoutDraft) => {
    pendingRef.current = next
    if (timerRef.current !== undefined) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined
      const pending = pendingRef.current
      pendingRef.current = undefined
      if (pending !== undefined) void persistNow(pending)
    }, NODE_DETAIL_SAVE_DELAY_MS)
  }, [persistNow])

  /** Write whatever the debounce still holds — before leaving, and on unmount. */
  const flushSave = useCallback(async (): Promise<void> => {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current)
      timerRef.current = undefined
    }
    const pending = pendingRef.current
    pendingRef.current = undefined
    if (pending !== undefined) await persistNow(pending)
  }, [persistNow])

  const flushRef = useRef(flushSave)
  flushRef.current = flushSave

  // Unmount: free the claim, drop the editor, and try to write the last edit.
  // A close is not allowed to lose what the user drew (§3.3's flush rule).
  useEffect(() => () => {
    if (timerRef.current !== undefined) clearTimeout(timerRef.current)
    timerRef.current = undefined
    const pending = pendingRef.current
    pendingRef.current = undefined
    if (pending !== undefined) void persistNow(pending)
  }, [persistNow])

  /* ---- one editor instance for this node (§8.4) -------------------------- */
  const readyForEditor = view === 'layout' && draft !== undefined
  useEffect(() => {
    if (!readyForEditor) return undefined
    const host = hostRef.current
    if (host === null || host === undefined) return undefined
    const claimKey = `${latest.current.boardId}:${latest.current.itemId}`
    // §8.4's second guard: the tab key already makes a second *tab* impossible,
    // this stops a second *mount* of the same node from opening a second editor.
    if (!detailEditorClaims.claim(claimKey)) {
      setMountError('这个节点已经有一个编辑器在运行；请先关闭另一个详情页签。')
      return undefined
    }
    claimKeyRef.current = claimKey
    const initial = draftRef.current
    appliedRef.current = initial
    let editor: LayoutEditorHandle | undefined
    try {
      editor = mountLayoutEditor(host, {
        draft: initial as unknown as LayoutDraft,
        // `pointerScale` stays at its default: a tab has no zoomed ancestor, and
        // the editor measures its own box, so passing a scale would double it.
        onChange: (state: LayoutEditorState) => { handlersRef.current.submitEdit(state) },
      })
      editorRef.current = editor
      setMountError(undefined)
    } catch (error) {
      setMountError(error instanceof Error ? error.message : String(error))
      detailEditorClaims.release(claimKey)
      claimKeyRef.current = undefined
      return undefined
    }
    return () => {
      editorRef.current = undefined
      const held = claimKeyRef.current
      claimKeyRef.current = undefined
      if (held !== undefined) detailEditorClaims.release(held)
      try {
        editor?.destroy()
      } catch {
        // A destroy failure must never run as an unhandled throw during unmount.
      }
    }
  }, [props.boardId, props.itemId, readyForEditor])

  // 撤销 (and a re-read) replaces the draft object; mirror it into the live
  // editor, exactly as the canvas's own mount does.
  useEffect(() => {
    const editor = editorRef.current
    if (editor === undefined || draft === undefined) return
    if (appliedRef.current === draft) return
    appliedRef.current = draft
    try {
      editor.setState(draftToEditorState(draft as unknown as LayoutDraft))
    } catch (error) {
      setMountError(error instanceof Error ? error.message : String(error))
    }
  }, [draft])

  /** One committed edit from the editor: undo step, canvas-shaped node, save. */
  handlersRef.current.submitEdit = (state: LayoutEditorState): void => {
    const next = stateToDraft(state) as unknown as BoardLayoutDraft
    const previous = draftRef.current
    appliedRef.current = next
    draftRef.current = next
    if (previous !== undefined && previous !== next) setHistory((current) => pushDraftHistory(current, previous))
    setDraft(next)
    scheduleSave(next)
  }

  /* ---- toolbar actions --------------------------------------------------- */
  const undo = (): void => {
    const step = undoDraftHistory(history)
    if (step.draft === undefined) return
    const next = step.draft
    setHistory(step.history)
    draftRef.current = next
    setDraft(next)
    scheduleSave(next)
  }

  const save = (): void => {
    const next = draftRef.current
    if (next === undefined) return
    setNote('正在保存…')
    void persistNow(next).then((ok) => {
      if (ok) setNote('已保存到项目文件。')
    })
  }

  const leaveForCanvas = (): void => {
    void flushSave().then(() => { latest.current.onBackToCanvas() })
  }

  const closePane = (): void => {
    void flushSave().then(() => { latest.current.onClose() })
  }

  /** The one action this kind offers, run by the canvas tab (§ the module note). */
  const runIntent = (): void => {
    const action = detailIntentOf(props.kind)
    if (action === undefined) {
      setNote('这类节点没有可以在画布上执行的动作。')
      return
    }
    const submit = latest.current.onIntent
    if (submit === undefined) {
      setNote('外壳没有接上画布动作。')
      return
    }
    // The draft is written first: the canvas re-reads the board when it takes
    // over, and a generation must not compile a draft the file does not have yet.
    void flushSave().then(() => { submit(action) })
  }

  /* ---- what the kind's view is ------------------------------------------- */
  const plan = useMemo(() => layoutGeneratePlan(draft), [draft])
  const summary = useMemo(() => layoutDetailSummary(draft), [draft])

  const head = createElement('div', { className: 'dsh-forge-detail-head' }, [
    createElement(
      'div',
      { key: 'crumb', className: 'dsh-forge-detail-crumb', 'data-detail-crumb': props.orphaned === true ? 'orphaned' : 'linked' },
      props.orphaned === true
        ? createElement('span', { className: 'dsh-forge-detail-crumb-text' }, shortSubject(props.boardName) || NODE_DETAIL_UNNAMED_BOARD)
        : createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-forge-detail-crumb-link',
            title: '回到这个项目的画布',
            'data-detail-action': 'back',
            onClick: leaveForCanvas,
          },
          shortSubject(props.boardName) || NODE_DETAIL_UNNAMED_BOARD,
        ),
      createElement('span', { className: 'dsh-forge-detail-sep' }, '›'),
      createElement('span', { className: 'dsh-forge-detail-crumb-text' }, '画布'),
      createElement('span', { className: 'dsh-forge-detail-sep' }, '›'),
      createElement('span', { className: 'dsh-forge-detail-kind' }, NODE_DETAIL_KIND_LABELS[props.kind] ?? '节点'),
    ),
    props.orphaned === true
      ? createElement('div', { key: 'orphan', className: 'dsh-forge-detail-hint', 'data-detail-orphan': 'true' }, NODE_DETAIL_ORPHAN_COPY)
      : null,
    createElement(
      'button',
      {
        key: 'close',
        type: 'button',
        className: 'dsh-forge-detail-close',
        title: '关闭这个详情页签',
        'aria-label': '关闭详情页签',
        'data-detail-action': 'close',
        onClick: closePane,
      },
      '×',
    ),
  ])

  /** The view body, or the card that says why there is none. */
  let body: ReactNode
  if (loading) {
    body = createElement('p', { className: 'dsh-forge-detail-copy' }, NODE_DETAIL_LOADING_COPY)
  } else if (loadError !== undefined) {
    body = noticeCard(loadError, closePane, () => { setReloadToken((current) => current + 1) })
  } else if (row === undefined) {
    body = noticeCard(NODE_DETAIL_MISSING_COPY, closePane, () => { setReloadToken((current) => current + 1) })
  } else if (view === 'unknown') {
    body = noticeCard(NODE_DETAIL_UNKNOWN_COPY, closePane)
  } else if (view === 'layout') {
    if (row.kind !== 'layout' || row.draft === undefined) {
      body = noticeCard(NODE_DETAIL_UNKNOWN_COPY, closePane, () => { setReloadToken((current) => current + 1) })
    } else {
      body = createElement('div', { className: 'dsh-forge-detail-layout' }, [
        createElement(
          'div',
          { key: 'facts', className: 'dsh-forge-detail-facts' },
          factRow('草稿尺寸', summary.size, 'size'),
          factRow('画框数量', String(summary.boxes), 'items'),
          factRow(
            '映射画幅',
            summary.mappable ? summary.ratio : `${summary.ratio}（偏差 ${(summary.deviation * 100).toFixed(1)}%，无法生成）`,
            'ratio',
          ),
        ),
        mountError === undefined
          ? createElement('div', { key: 'editor', className: 'dsh-forge-detail-editor', 'data-detail-editor': 'layout' }, createElement('div', { ref: hostRef, className: 'dsh-forge-detail-editor-host' }))
          : createElement('div', { key: 'editor-error', className: 'dsh-forge-detail-error' }, '布局编辑器加载失败：' + mountError),
      ])
    }
  } else if (view === 'image') {
    body = createElement('div', { className: 'dsh-forge-detail-image' }, [
      createElement('img', {
        key: 'img',
        className: 'dsh-forge-detail-picture',
        src: studioFileUrl(row.markdownPath ?? row.path),
        alt: shortSubject(row.prompt) || '图片',
        'data-detail-image': 'true',
      }),
      createElement(
        'div',
        { key: 'facts', className: 'dsh-forge-detail-facts' },
        factRow('提示词', row.prompt.length === 0 ? '（这张图没有记录提示词）' : row.prompt, 'prompt'),
        factRow('尺寸', `${String(row.width)}×${String(row.height)}`, 'size'),
        factRow('画幅', row.ratio ?? '—', 'ratio'),
        factRow('步数', typeof row.steps === 'number' ? String(row.steps) : '—', 'steps'),
        factRow('种子', typeof row.seed === 'number' ? String(row.seed) : '—', 'seed'),
        factRow('文件', row.markdownPath, 'file'),
        factRow('生成于', row.createdAt, 'createdAt'),
      ),
    ])
  } else {
    const task = row.kind === 'task' ? row.task : undefined
    body = task === undefined
      ? noticeCard(NODE_DETAIL_UNKNOWN_COPY, closePane)
      : createElement('div', { className: 'dsh-forge-detail-task' }, [
        createElement(
          'div',
          { key: 'facts', className: 'dsh-forge-detail-facts' },
          factRow('状态', task.status === 'interrupted' ? '已中断' : '失败', 'status'),
          factRow('提示词', task.params.prompt, 'prompt'),
          factRow('画幅', task.params.ratio ?? '—', 'ratio'),
          factRow('步数', typeof task.params.steps === 'number' ? String(task.params.steps) : '—', 'steps'),
          factRow('张数', String(task.params.count ?? 1), 'count'),
          factRow('种子', typeof task.params.seed === 'number' ? String(task.params.seed) : '—', 'seed'),
          factRow('布局参数', task.params.layout === undefined ? '—' : `${String(task.params.layout.length)} 字符`, 'layout'),
          factRow('失败原因', task.error ?? '—', 'error'),
        ),
      ])
  }

  /* ---- the toolbar, per kind -------------------------------------------- */
  const toolbar = createElement('div', { className: 'dsh-forge-detail-toolbar' }, [
    view === 'layout'
      ? detailButton({
        action: 'undo',
        label: '撤销',
        title: '撤销上一次画框改动',
        disabled: history.entries.length === 0,
        onClick: undo,
      })
      : null,
    view === 'layout'
      ? detailButton({
        action: 'save',
        label: draft !== undefined && savedDraft === draft ? '已保存' : '保存',
        title: '立即写入项目文件（失焦/暂停编辑时会自动保存）',
        disabled: draft === undefined,
        onClick: save,
      })
      : null,
    view === 'image'
      ? detailButton({
        action: 'open',
        label: '查看原图',
        title: '在新标签页打开原图',
        onClick: () => {
          const row2 = itemRef.current
          if (row2 === undefined) return
          if (typeof window.open === 'function') window.open(studioFileUrl(row2.markdownPath), '_blank', 'noreferrer')
        },
      })
      : null,
    detailButton({
      action: 'intent',
      label: view === 'layout' ? '生成' : view === 'image' ? '按这张继续' : '重试',
      title: view === 'layout'
        ? (plan.ok ? '把 compiled 布局作为 MOSS 的正向编码文本提交（回到画布执行）' : plan.reason)
        : view === 'image'
          ? '回到画布，建一个以这张图为参考的待生成节点'
          : '回到画布，用同一份参数原地重跑',
      primary: true,
      disabled: row === undefined || (view === 'layout' && !plan.ok),
      onClick: runIntent,
    }),
    detailButton({
      action: 'back',
      label: '返回画布',
      title: '回到这个项目的画布页签',
      onClick: leaveForCanvas,
    }),
  ])

  const alerts = [
    saveError === undefined
      ? null
      : createElement('div', { key: 'save-error', className: 'dsh-forge-studio-alert' }, saveError),
    note === undefined
      ? null
      : createElement('div', { key: 'note', className: 'dsh-forge-studio-hint', 'data-detail-note': 'true' }, note),
  ]

  return createElement(
    'section',
    {
      className: `dsh-forge-detail is-${view}`,
      'data-detail-kind': props.kind,
      'data-detail-board': props.boardId,
      'data-detail-item': props.itemId,
      'aria-label': `${NODE_DETAIL_KIND_LABELS[props.kind] ?? '节点'}详情`,
    },
    head,
    createElement(
      'div',
      { className: 'dsh-forge-detail-body' },
      body,
      alerts[0] === null ? null : alerts[0],
      alerts[1] === null ? null : alerts[1],
    ),
    toolbar,
  )
}
