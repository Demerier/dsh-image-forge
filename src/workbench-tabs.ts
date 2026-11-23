/**
 * Workbench tab state machine (U01, `../docs/usage-reference.md` §3).
 *
 * The tabbed shell decides a handful of things without any DOM: which key a tab
 * has, where a newly opened tab lands, which tab takes over when one closes, and
 * what a saved `workspace.json` means after a spread of deletions. All of that
 * lives here as plain functions over an immutable state object, so it can be
 * asserted in Node (`test/workbench-tabs.test.mjs`, §15.1) instead of through a
 * rendered panel — the same split `canvas-interactions.ts` uses for gestures.
 *
 * Two rules hold for every function in this module:
 *
 * - **No DOM, no React, no clock, no IO.** Timestamps arrive as arguments
 *   (§4.4's `<now>` is `refs.now`), and the workspace codec only reads and
 *   builds plain JSON. That is what lets the file be imported directly from
 *   `src/`.
 * - **Nothing is mutated.** Every change returns a fresh state, and a no-op
 *   (unknown key, duplicate open, refused by a cap) returns the *same* object so
 *   a React caller can skip the re-render.
 *
 * What this module deliberately does **not** do: it does not know board names
 * (§3.1/§8.2 derive every label from data at render time), it does not flush
 * dirty boards (§3.3 — the caller flushes before {@link closeTab}), and it does
 * not read or write `workspace.json` (U02 owns the file; §4.5/§4.6).
 *
 * @module workbench-tabs
 */

/* -------------------------------------------------------------------------- */
/* Limits and literal keys (§3.1, §3.4, §4.2)                                  */
/* -------------------------------------------------------------------------- */

/**
 * How many `canvas:` tabs may be open at once (§3.4, WD3).
 *
 * Reaching it **refuses** a new tab; the shell shows the toast and focuses the
 * already-open target instead. No LRU eviction: closing a tab the user did not
 * close is a data-loss risk.
 */
export const MAX_CANVAS_TABS = 8

/** How many tabs may exist at all, `projects` included (§3.4). */
export const MAX_TABS = 16

/** `recentProjects` keeps at most this many entries (§4.2). */
export const MAX_RECENT_PROJECTS = 20

/** The single tab that is always present, always leftmost and never closable (§3.1). */
export const PROJECTS_TAB = 'projects'

/**
 * Session-only utility tab for the ComfyUI log page.
 *
 * The strip's 看日志 button opens it like any other tab, but it is never written
 * to workspace.json: a reload must not reopen a diagnostic page on its own.
 */
export const LOGS_TAB = 'logs'

/** The only `version` this module writes (§4.2: 只写 1). */
export const WORKSPACE_VERSION = 1

/** The three detail kinds a `node:` tab can carry (§8.2; `§4.2` `kind`). */
export const NODE_DETAIL_KINDS: readonly NodeDetailKind[] = ['layout', 'task', 'image']

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** Tab key: the string identity used by `tabOrder`, React keys and the URL (§3.1). */
export type TabKey = string

/** The three tab families (§3.1). */
export type TabKind = 'projects' | 'logs' | 'canvas' | 'node'

/** Which editor a `node:` tab hosts (§8.2). Not encodable in the key, so stored alongside. */
export type NodeDetailKind = 'layout' | 'task' | 'image'

/** A key decomposed into its parts; `null` when the key is not a tab we can build. */
export type TabRef =
  | { readonly kind: 'projects'; readonly key: TabKey }
  | { readonly kind: 'logs'; readonly key: TabKey }
  | { readonly kind: 'canvas'; readonly key: TabKey; readonly boardId: string }
  | { readonly kind: 'node'; readonly key: TabKey; readonly boardId: string; readonly itemId: string }

/** One strip entry, ready to render (§3.1/§8.2). */
export interface TabDescriptor {
  readonly key: TabKey
  readonly kind: TabKind
  /** Set for `canvas:` and `node:` tabs. */
  readonly boardId?: string
  /** Set for `node:` tabs. */
  readonly itemId?: string
  /** Set for `node:` tabs; the editor to mount (§8.2). */
  readonly detailKind?: NodeDetailKind
  /**
   * `node:` tab whose source canvas is not open (§3.2 rule 3 / §8.3): the
   * breadcrumb degrades to text plus a "reopen project" button.
   */
  readonly orphaned: boolean
}

/** One `recentProjects` entry, newest first (§4.2). */
export interface RecentProject {
  readonly boardId: string
  /** ISO timestamp; an unparseable one drops the entry (§4.2). */
  readonly openedAt: string
}

/**
 * The whole tab state — pure data, and the only thing the shell has to hold.
 *
 * `openProjects` and `nodeDetailTabs` from the `workspace.json` schema are *not*
 * duplicated here: both are exactly the `canvas:` / `node:` keys of
 * {@link WorkbenchTabsState.tabOrder}, so the two views cannot drift. The codec
 * rebuilds them on the way out ({@link toWorkspaceJson}) and repairs the
 * inconsistency on the way in ({@link rebuildOrder}, §4.3).
 */
export interface WorkbenchTabsState {
  /** Strip order; always starts with {@link PROJECTS_TAB} (§3.2 rule 1). */
  readonly tabOrder: readonly TabKey[]
  /** The key currently selected; always a member of `tabOrder` (§3.2 rule 4). */
  readonly activeTab: TabKey
  /** `node:` key → detail kind (§4.2 `nodeDetailTabs[].kind`). */
  readonly nodeKinds: Readonly<Record<TabKey, NodeDetailKind>>
  /** Recent-project ordering for the projects tab, newest first (§4.2). */
  readonly recentProjects: readonly RecentProject[]
  /**
   * Session-only per-board selection buckets, keyed by `boardId` (§4.1, §10.1).
   *
   * Never persisted, and never the undo stack: each canvas gets its own
   * `CommandStack` in the store (U04). Dropped when its canvas tab closes.
   */
  readonly selections: Readonly<Record<string, readonly string[]>>
}

/** Why an open/close was refused; the values are for the caller's message (§3.4). */
export type TabRejection = 'invalid' | 'canvas-limit' | 'tab-limit' | 'not-closable' | 'unknown-key'

/** Result of an open: the new state, or the reason nothing changed. */
export interface OpenResult {
  readonly state: WorkbenchTabsState
  readonly rejected?: TabRejection
  /**
   * `true` when the target was already open and only got activated (§3.2 rule 5):
   * the shell centers the camera instead of creating a tab.
   */
  readonly reused?: boolean
}

/** Result of a close: the new state plus every key that went away with it (§3.3). */
export interface CloseResult {
  readonly state: WorkbenchTabsState
  readonly rejected?: TabRejection
  /** Keys removed, including node tabs cascaded by a canvas close (§3.3, WD2). */
  readonly closed?: readonly TabKey[]
}

/** Options for {@link openTab}. */
export interface OpenTabOptions {
  /** Required for a `node:` key (§8.2): the detail kind is not part of the key. */
  readonly detailKind?: NodeDetailKind
}

/* -------------------------------------------------------------------------- */
/* Keys (§3.1)                                                                 */
/* -------------------------------------------------------------------------- */

/*
 * `boardId` and `itemId` never contain a colon (`src/boards.ts:286-296` builds
 * them from a prefix plus base36/hex), so `split(':')` is unambiguous — that is
 * the whole reason the key is a string and not an object (§3.1).
 */

/** Key of a board's canvas tab. */
export function canvasTabKey(boardId: string): TabKey {
  return `canvas:${boardId}`
}

/** Key of a node detail tab. */
export function nodeTabKey(boardId: string, itemId: string): TabKey {
  return `node:${boardId}:${itemId}`
}

/**
 * Decompose a tab key.
 *
 * Tolerant on purpose: anything that is not one of the three shapes — a stale
 * key from an older build, a hand-edited `workspace.json`, a `null` from JSON —
 * returns `null` instead of throwing. §3.3's "invalid" tab state and §4.3's
 * "drop unknown key shapes" both hinge on this not exploding.
 */
export function parseTabKey(key: unknown): TabRef | null {
  if (typeof key !== 'string') return null
  if (key === PROJECTS_TAB) return { kind: 'projects', key }
  if (key === LOGS_TAB) return { kind: 'logs', key }
  const parts = key.split(':')
  if (parts.length === 2 && parts[0] === 'canvas' && parts[1].length > 0) {
    return { kind: 'canvas', key, boardId: parts[1] }
  }
  if (parts.length === 3 && parts[0] === 'node' && parts[1].length > 0 && parts[2].length > 0) {
    return { kind: 'node', key, boardId: parts[1], itemId: parts[2] }
  }
  return null
}

/** Build a key from its parts — the inverse of {@link parseTabKey}. */
export function formatTabKey(ref: { readonly kind: TabKind; readonly boardId?: string; readonly itemId?: string }): TabKey {
  if (ref.kind === 'logs') return LOGS_TAB
  if (ref.kind === 'canvas' && typeof ref.boardId === 'string') return canvasTabKey(ref.boardId)
  if (ref.kind === 'node' && typeof ref.boardId === 'string' && typeof ref.itemId === 'string') {
    return nodeTabKey(ref.boardId, ref.itemId)
  }
  // §3.3: an unbuildable key is not a reason to crash the shell — it degrades to
  // the one tab that always exists.
  return PROJECTS_TAB
}

/* -------------------------------------------------------------------------- */
/* State (§3.2 rule 1)                                                        */
/* -------------------------------------------------------------------------- */

/** The state a fresh workspace starts in: one projects tab, nothing else (§3.1). */
export function emptyState(): WorkbenchTabsState {
  return {
    tabOrder: [PROJECTS_TAB],
    activeTab: PROJECTS_TAB,
    nodeKinds: {},
    recentProjects: [],
    selections: {},
  }
}

/** The open canvas boards, in strip order — `workspace.json`'s `openProjects` (§4.2). */
export function openBoardIds(state: WorkbenchTabsState): string[] {
  const ids: string[] = []
  for (const key of state.tabOrder) {
    const ref = parseTabKey(key)
    if (ref !== null && ref.kind === 'canvas') ids.push(ref.boardId)
  }
  return ids
}

/** Every strip entry in order, with the parts a renderer needs (§3.1/§8.2). */
export function listTabs(state: WorkbenchTabsState): TabDescriptor[] {
  const openBoards = new Set(openBoardIds(state))
  const tabs: TabDescriptor[] = []
  for (const key of state.tabOrder) {
    const ref = parseTabKey(key)
    // A key we cannot read is not renderable; `stateFromWorkspace` drops those,
    // this is only a guard against a caller building state by hand.
    if (ref === null) continue
    if (ref.kind === 'projects') {
      tabs.push({ key, kind: 'projects', orphaned: false })
    } else if (ref.kind === 'logs') {
      tabs.push({ key, kind: 'logs', orphaned: false })
    } else if (ref.kind === 'canvas') {
      tabs.push({ key, kind: 'canvas', boardId: ref.boardId, orphaned: false })
    } else {
      tabs.push({
        key,
        kind: 'node',
        boardId: ref.boardId,
        itemId: ref.itemId,
        detailKind: state.nodeKinds[key] ?? 'task',
        orphaned: !openBoards.has(ref.boardId),
      })
    }
  }
  return tabs
}

/* -------------------------------------------------------------------------- */
/* Limits (§3.4)                                                              */
/* -------------------------------------------------------------------------- */

/** Whether another canvas tab fits under {@link MAX_CANVAS_TABS}. */
export function canOpenCanvas(state: WorkbenchTabsState): boolean {
  return openBoardIds(state).length < MAX_CANVAS_TABS
}

/** Whether another tab of any kind fits under {@link MAX_TABS}. */
export function canOpenTab(state: WorkbenchTabsState): boolean {
  return state.tabOrder.length < MAX_TABS
}

/**
 * Would opening `key` be allowed right now? (§3.4)
 *
 * A tab that is already open is always "allowed" — opening it again is an
 * activation, not an insert (§3.2 rule 5), so the caps do not apply to it.
 */
export function isTabAllowed(state: WorkbenchTabsState, key: TabKey): boolean {
  const ref = parseTabKey(key)
  if (ref === null) return false
  if (ref.kind === 'projects' || state.tabOrder.includes(key)) return true
  if (!canOpenTab(state)) return false
  return ref.kind === 'node' || ref.kind === 'logs' || canOpenCanvas(state)
}

/* -------------------------------------------------------------------------- */
/* Activation (§3.2 rule 4)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Select an already-open tab.
 *
 * An unknown key is a no-op returning the same state, not a throw: §3.3 lists
 * tabs whose board was deleted elsewhere, and the shell must survive a click on
 * one.
 */
export function activateTab(state: WorkbenchTabsState, key: TabKey): WorkbenchTabsState {
  if (!state.tabOrder.includes(key)) return state
  if (state.activeTab === key) return state
  return { ...state, activeTab: key }
}

/* -------------------------------------------------------------------------- */
/* Opening (§3.2 rules 2, 3, 5)                                               */
/* -------------------------------------------------------------------------- */

/**
 * Open a tab by key — the one entry point the strip's own click handler needs.
 *
 * A `node:` key needs `options.detailKind` (§8.2): the key cannot carry it, and
 * a detail tab without an editor to mount is not representable.
 */
export function openTab(state: WorkbenchTabsState, key: TabKey, options: OpenTabOptions = {}): OpenResult {
  const ref = parseTabKey(key)
  if (ref === null) return { state, rejected: 'invalid' }
  if (ref.kind === 'projects') return { state: activateTab(state, PROJECTS_TAB), reused: true }
  if (ref.kind === 'logs') {
    if (state.tabOrder.includes(LOGS_TAB)) return { state: activateTab(state, LOGS_TAB), reused: true }
    if (!canOpenTab(state)) return { state, rejected: 'tab-limit' }
    return { state: { ...state, tabOrder: [...state.tabOrder, LOGS_TAB], activeTab: LOGS_TAB } }
  }
  if (ref.kind === 'node') {
    const detailKind = options.detailKind
    if (detailKind === undefined) return { state, rejected: 'invalid' }
    return openNodeDetail(state, ref.boardId, ref.itemId, detailKind)
  }
  return openCanvas(state, ref.boardId)
}

/**
 * Open a board's canvas tab, or activate it when it is already open (§3.2 rule 5).
 *
 * New canvas tabs append in open order (§3.2 rule 2) — never in board-list
 * order. At the cap the open is refused and the state is returned untouched
 * (§3.4): the caller shows the toast and may activate an existing tab instead.
 */
export function openCanvas(state: WorkbenchTabsState, boardId: string): OpenResult {
  if (boardId.length === 0) return { state, rejected: 'invalid' }
  const key = canvasTabKey(boardId)
  if (state.tabOrder.includes(key)) return { state: activateTab(state, key), reused: true }
  if (!canOpenCanvas(state)) return { state, rejected: 'canvas-limit' }
  if (!canOpenTab(state)) return { state, rejected: 'tab-limit' }
  return { state: { ...state, tabOrder: [...state.tabOrder, key], activeTab: key } }
}

/**
 * Open a node's detail tab (§8.2), or activate the one already open.
 *
 * Placement follows §3.2 rule 3: immediately right of the **tab group** of the
 * source board (its canvas tab plus that board's node tabs), so a board's detail
 * tabs stay together and arrive in the order the user opened them. When the
 * source canvas is closed the tab appends at the end and is flagged
 * `orphaned` by {@link listTabs} (§3.2 rule 3 / §8.3).
 */
export function openNodeDetail(
  state: WorkbenchTabsState,
  boardId: string,
  itemId: string,
  detailKind: NodeDetailKind,
): OpenResult {
  if (boardId.length === 0 || itemId.length === 0) return { state, rejected: 'invalid' }
  if (!isNodeDetailKind(detailKind)) return { state, rejected: 'invalid' }
  const key = nodeTabKey(boardId, itemId)
  if (state.tabOrder.includes(key)) {
    // Same node, different editor: the node's kind changed under us. The key is
    // stable (§3.1), so the tab is reused and only its kind is refreshed.
    const sameKind = state.nodeKinds[key] === detailKind
    const next = sameKind ? state : { ...state, nodeKinds: { ...state.nodeKinds, [key]: detailKind } }
    return { state: activateTab(next, key), reused: true }
  }
  if (!canOpenTab(state)) return { state, rejected: 'tab-limit' }
  const insertAfter = groupEndIndex(state.tabOrder, boardId)
  const tabOrder = insertAfter < 0
    ? [...state.tabOrder, key]
    : [...state.tabOrder.slice(0, insertAfter + 1), key, ...state.tabOrder.slice(insertAfter + 1)]
  return {
    state: { ...state, tabOrder, activeTab: key, nodeKinds: { ...state.nodeKinds, [key]: detailKind } },
  }
}

/** Whether `kind` is one of {@link NODE_DETAIL_KINDS} — used on untrusted JSON. */
export function isNodeDetailKind(kind: unknown): kind is NodeDetailKind {
  return typeof kind === 'string' && (NODE_DETAIL_KINDS as readonly string[]).includes(kind)
}

/* -------------------------------------------------------------------------- */
/* Closing (§3.2 rule 4, §3.3)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Close one tab and decide who is selected afterwards (§3.3).
 *
 * - `projects` is not closable (`not-closable`); an unknown key is a no-op.
 * - Closing a `canvas:` tab closes that board's node tabs with it (WD2) — the
 *   caller flushes dirty data *before* calling, per §3.3.
 * - Closing a `node:` tab leaves the canvas alone (§3.3).
 * - The selection goes left, then right, then back to `projects`
 *   ({@link reorderAfterClose}).
 */
export function closeTab(state: WorkbenchTabsState, key: TabKey): CloseResult {
  const ref = parseTabKey(key)
  if (ref === null) return { state, rejected: 'invalid' }
  if (ref.kind === 'projects') return { state, rejected: 'not-closable' }
  if (!state.tabOrder.includes(key)) return { state, rejected: 'unknown-key' }
  const removed = ref.kind === 'canvas' ? [key, ...nodeKeysForBoard(state.tabOrder, ref.boardId)] : [key]
  const next = reorderAfterClose(state.tabOrder, removed, state.activeTab)
  const nodeKinds = { ...state.nodeKinds }
  for (const removedKey of removed) delete nodeKinds[removedKey]
  // §4.1: selection is session state, and a board's session ends with its tab.
  const selections = { ...state.selections }
  if (ref.kind === 'canvas') delete selections[ref.boardId]
  return {
    state: { ...state, tabOrder: next.tabOrder, activeTab: next.activeTab, nodeKinds, selections },
    closed: removed,
  }
}

/**
 * The strip and the selection after `removed` keys disappear (§3.2 rule 4).
 *
 * Selection rule, verbatim: the **left** neighbour first, the right one when
 * there is no left one, and `projects` when the strip has nothing left. The
 * search skips removed keys, so closing a canvas tab and its detail tabs
 * together still lands on a live neighbour rather than on a tab that is going
 * away in the same operation.
 */
export function reorderAfterClose(
  order: readonly TabKey[],
  removed: readonly TabKey[],
  active: TabKey,
): { readonly tabOrder: readonly TabKey[]; readonly activeTab: TabKey } {
  const gone = new Set(removed)
  const tabOrder = order.filter((key) => !gone.has(key))
  const index = order.indexOf(active)
  if (index >= 0 && !gone.has(active)) return { tabOrder, activeTab: active }
  const left = index < 0 ? undefined : neighbourOf(order, gone, index - 1, -1)
  const right = index < 0 ? undefined : neighbourOf(order, gone, index + 1, 1)
  const fallback = tabOrder.includes(PROJECTS_TAB) ? PROJECTS_TAB : (tabOrder[0] ?? PROJECTS_TAB)
  return { tabOrder, activeTab: left ?? right ?? fallback }
}

/**
 * Repair `tabOrder` against the set of tabs that must exist (§4.3).
 *
 * Used on the read path only: `workspace.json` stores the order *and* the open
 * sets, and they can disagree after a crash. The rule is §4.3's — `projects`
 * first, surviving keys in their original relative order, then whatever is
 * missing appended — and the result is capped at {@link MAX_TABS}. Unknown key
 * shapes are dropped, exactly like {@link parseTabKey} does for one key.
 */
export function rebuildOrder(order: readonly TabKey[], required: readonly TabKey[]): readonly TabKey[] {
  const allowed: TabKey[] = [PROJECTS_TAB]
  for (const key of required) {
    if (key === PROJECTS_TAB || parseTabKey(key) === null || allowed.includes(key)) continue
    allowed.push(key)
  }
  const wanted = new Set(allowed)
  const result: TabKey[] = [PROJECTS_TAB]
  for (const key of order) {
    if (key === PROJECTS_TAB || !wanted.has(key) || result.includes(key)) continue
    if (result.length >= MAX_TABS) break
    result.push(key)
  }
  for (const key of allowed) {
    if (key === PROJECTS_TAB || result.includes(key)) continue
    if (result.length >= MAX_TABS) break
    result.push(key)
  }
  return result
}

/* -------------------------------------------------------------------------- */
/* workspace.json v1 (§4.2, §4.3, §4.4)                                       */
/* -------------------------------------------------------------------------- */

/**
 * `workspace.json`'s `activeTab` object (§4.2).
 *
 * The stored names are the schema's (`boardId`, `nodeId`), not this module's
 * internal ones: `itemId` matches `BoardItem.id`, while the file calls it
 * `nodeId`. The conversion is confined to {@link toWorkspaceJson} and
 * {@link stateFromWorkspace} so the wire shape stays exactly what §4.2 shows.
 */
export interface WorkspaceActiveRef {
  readonly kind: TabKind
  /** Set for `canvas` and `node`. */
  readonly boardId?: string
  /** Set for `node`. */
  readonly nodeId?: string
}

/** One `nodeDetailTabs[]` entry (§4.2). */
export interface WorkspaceNodeTab {
  readonly boardId: string
  readonly nodeId: string
  readonly kind: NodeDetailKind
}

/** The `workspace.json` v1 document (§4.2) — plain JSON, nothing else. */
export interface WorkspaceFile {
  readonly version: number
  readonly openProjects: readonly string[]
  readonly activeTab: WorkspaceActiveRef
  readonly nodeDetailTabs: readonly WorkspaceNodeTab[]
  readonly tabOrder: readonly TabKey[]
  readonly recentProjects: readonly RecentProject[]
}

/**
 * What the caller knows about the library when reading a workspace file (§4.3).
 *
 * Omitted lists mean "cannot tell", which turns that particular check off rather
 * than dropping every reference: the codec is also used before the board list
 * has loaded, and losing the whole workspace because of a missing list would be
 * worse than keeping a reference that may be stale.
 */
export interface WorkspaceRefs {
  /** Board ids that still exist. */
  readonly boardIds?: readonly string[]
  /** Item ids per board; used for the "board is alive but the item is not" case (§4.3). */
  readonly items?: Readonly<Record<string, readonly string[]>>
  /** §4.4's `<now>` for the one-shot `state.json` migration; this module has no clock. */
  readonly now?: string
}

/**
 * Serialise the state as a `workspace.json` v1 document (§4.2).
 *
 * `openProjects` is the canvas keys in strip order, `nodeDetailTabs` the node
 * keys — both derived from `tabOrder`, so the three views cannot disagree.
 * Session state (selection) is never written (§4.1), and titles never exist in
 * this module at all (§3.1/§8.2: labels are computed from data).
 */
export function toWorkspaceJson(state: WorkbenchTabsState): WorkspaceFile {
  const openProjects: string[] = []
  const nodeDetailTabs: WorkspaceNodeTab[] = []
  for (const tab of listTabs(state)) {
    if (tab.kind === 'canvas' && tab.boardId !== undefined) openProjects.push(tab.boardId)
    else if (tab.kind === 'node' && tab.boardId !== undefined && tab.itemId !== undefined) {
      nodeDetailTabs.push({ boardId: tab.boardId, nodeId: tab.itemId, kind: tab.detailKind ?? 'task' })
    }
  }
  const active = parseTabKey(state.activeTab)
  let activeTab: WorkspaceActiveRef = { kind: 'projects' }
  if (active !== null && active.kind === 'canvas') activeTab = { kind: 'canvas', boardId: active.boardId }
  else if (active !== null && active.kind === 'node') {
    activeTab = { kind: 'node', boardId: active.boardId, nodeId: active.itemId }
  }
  return {
    version: WORKSPACE_VERSION,
    openProjects,
    activeTab,
    nodeDetailTabs,
    tabOrder: state.tabOrder.filter((key) => key !== LOGS_TAB),
    recentProjects: state.recentProjects.map((entry) => ({ boardId: entry.boardId, openedAt: entry.openedAt })),
  }
}

/**
 * Read a `workspace.json` that may be anything at all (§4.3, WD5).
 *
 * Degrades **item by item**, never as a whole:
 *
 * - not a document at all → empty state (that is also what a missing or
 *   unparseable file becomes, §4.3);
 * - `version` from a newer build → empty state, the one documented whole-file
 *   fallback (§4.3 point 2);
 * - `version` absent → treated as the old `state.json` shape, `{active}` (§4.4);
 * - a board that no longer exists, an item that is gone, an unknown detail kind,
 *   an unparseable timestamp, an unknown key shape → that entry is dropped and
 *   everything else survives;
 * - over the caps → truncated to {@link MAX_CANVAS_TABS} / {@link MAX_TABS} /
 *   {@link MAX_RECENT_PROJECTS}, never refused;
 * - `tabOrder` disagreeing with the open sets → rebuilt by {@link rebuildOrder};
 * - `activeTab` pointing at something that did not survive → `projects`.
 */
export function stateFromWorkspace(raw: unknown, refs: WorkspaceRefs = {}): WorkbenchTabsState {
  if (typeof raw !== 'object' || raw === null) return emptyState()
  const record = raw as Record<string, unknown>
  const version = record.version
  if (version === undefined) return stateFromLegacy(record, refs)
  // §4.3 point 2: a version we do not recognise (a newer build's file) opens an
  // empty workspace; 0 and negatives are equally unrecognisable.
  if (typeof version !== 'number' || !Number.isInteger(version) || version !== WORKSPACE_VERSION) {
    return emptyState()
  }

  const boardAllowed = (id: unknown): id is string =>
    typeof id === 'string' && id.length > 0 && (refs.boardIds === undefined || refs.boardIds.includes(id))
  const itemAllowed = (boardId: string, itemId: unknown): itemId is string => {
    if (typeof itemId !== 'string' || itemId.length === 0) return false
    const known = refs.items
    if (known === undefined) return true
    return known[boardId]?.includes(itemId) === true
  }

  const openProjects: string[] = []
  for (const entry of asArray(record.openProjects)) {
    if (!boardAllowed(entry) || openProjects.includes(entry)) continue
    if (openProjects.length >= MAX_CANVAS_TABS) break
    openProjects.push(entry)
  }

  const nodeKeys: TabKey[] = []
  const nodeKinds: Record<TabKey, NodeDetailKind> = {}
  for (const entry of asArray(record.nodeDetailTabs)) {
    if (typeof entry !== 'object' || entry === null) continue
    const tab = entry as Record<string, unknown>
    const boardId = tab.boardId
    const nodeId = tab.nodeId
    const kind = tab.kind
    if (!boardAllowed(boardId) || !itemAllowed(boardId, nodeId) || !isNodeDetailKind(kind)) continue
    const key = nodeTabKey(boardId, nodeId)
    if (nodeKinds[key] !== undefined) continue
    // `+ 2` accounts for the projects tab itself and the entry being added.
    if (openProjects.length + nodeKeys.length + 2 > MAX_TABS) break
    nodeKinds[key] = kind
    nodeKeys.push(key)
  }

  // §4.3 rebuilds `tabOrder` from the two open sets. The required list is built
  // board by board — canvas, then that board's detail tabs — so the appended
  // tabs land in the same groups §3.2 rule 3 would have created. A detail tab
  // whose board is not open is an orphan and appends at the very end (§3.2/§8.3).
  const nodeKeysByBoard = new Map<string, TabKey[]>()
  for (const key of nodeKeys) {
    const ref = parseTabKey(key)
    if (ref === null || ref.kind !== 'node') continue
    const bucket = nodeKeysByBoard.get(ref.boardId)
    if (bucket === undefined) nodeKeysByBoard.set(ref.boardId, [key])
    else bucket.push(key)
  }
  const required: TabKey[] = [PROJECTS_TAB]
  for (const boardId of openProjects) {
    required.push(canvasTabKey(boardId))
    const bucket = nodeKeysByBoard.get(boardId)
    if (bucket !== undefined) required.push(...bucket)
  }
  for (const key of nodeKeys) if (!required.includes(key)) required.push(key)
  const wanted: TabKey[] = []
  for (const entry of asArray(record.tabOrder)) {
    if (typeof entry !== 'string' || !required.includes(entry) || wanted.includes(entry)) continue
    wanted.push(entry)
  }
  const tabOrder = rebuildOrder(wanted, required)
  // A kind without a surviving tab is dead weight the strip can never reach.
  for (const key of Object.keys(nodeKinds)) if (!tabOrder.includes(key)) delete nodeKinds[key]

  const candidate = activeKeyFrom(record.activeTab)
  const activeTab = candidate !== undefined && tabOrder.includes(candidate) ? candidate : PROJECTS_TAB
  return {
    tabOrder,
    activeTab,
    nodeKinds,
    recentProjects: normalizeRecent(record.recentProjects, boardAllowed),
    // §4.1: selection is never restored — a restored selection is an accident.
    selections: {},
  }
}

/* -------------------------------------------------------------------------- */
/* Recent projects (§4.2)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Move a board to the front of `recentProjects` (§4.2, newest first, cap 20).
 *
 * `openedAt` is an argument rather than `Date.now()`: keeping the clock out of
 * this module is what lets the ordering be asserted with fixed strings. An
 * unparseable timestamp is refused (the entry could not be ordered), which is
 * the same rule {@link stateFromWorkspace} applies when reading.
 */
export function touchRecentProjects(
  state: WorkbenchTabsState,
  boardId: string,
  openedAt: string,
): WorkbenchTabsState {
  if (typeof boardId !== 'string' || boardId.length === 0) return state
  if (typeof openedAt !== 'string' || !Number.isFinite(Date.parse(openedAt))) return state
  const recentProjects = [
    { boardId, openedAt },
    ...state.recentProjects.filter((entry) => entry.boardId !== boardId),
  ].slice(0, MAX_RECENT_PROJECTS)
  return { ...state, recentProjects }
}

/* -------------------------------------------------------------------------- */
/* Per-board session buckets (§4.1, §10.1)                                    */
/* -------------------------------------------------------------------------- */

/** Shared empty selection, so a board with nothing selected allocates nothing. */
const NO_SELECTION: readonly string[] = []

/**
 * The selected item ids of one board's canvas (§4.1: session memory, never
 * written). Every canvas tab keeps its own bucket — switching tabs must not lose
 * what was selected there (§10.1).
 */
export function selectionFor(state: WorkbenchTabsState, boardId: string): readonly string[] {
  return state.selections[boardId] ?? NO_SELECTION
}

/**
 * Replace one board's selection.
 *
 * The bucket only exists while the board has an open canvas tab: a selection for
 * a closed board has nowhere to be shown, and {@link closeTab} drops it with the
 * tab anyway (§3.3, §4.1). Duplicates and empty ids are dropped, and an
 * unchanged selection returns the same state object.
 */
export function setSelectionFor(
  state: WorkbenchTabsState,
  boardId: string,
  itemIds: readonly string[],
): WorkbenchTabsState {
  if (typeof boardId !== 'string' || boardId.length === 0) return state
  if (!state.tabOrder.includes(canvasTabKey(boardId))) return state
  const next: string[] = []
  for (const id of itemIds) {
    if (typeof id !== 'string' || id.length === 0 || next.includes(id)) continue
    next.push(id)
  }
  if (sameStrings(selectionFor(state, boardId), next)) return state
  const selections = { ...state.selections }
  if (next.length === 0) delete selections[boardId]
  else selections[boardId] = next
  return { ...state, selections }
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/** `value` as an array, or an empty one — JSON fields are untrusted. */
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/** The key a stored `activeTab` object names, if it names one at all. */
function activeKeyFrom(raw: unknown): TabKey | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (record.kind === 'projects') return PROJECTS_TAB
  if (record.kind === 'canvas' && typeof record.boardId === 'string' && record.boardId.length > 0) {
    return canvasTabKey(record.boardId)
  }
  if (
    record.kind === 'node' &&
    typeof record.boardId === 'string' && record.boardId.length > 0 &&
    typeof record.nodeId === 'string' && record.nodeId.length > 0
  ) {
    return nodeTabKey(record.boardId, record.nodeId)
  }
  return undefined
}

/** Valid, deduplicated, unknown-board-free `recentProjects`, newest first (§4.2). */
function normalizeRecent(raw: unknown, boardAllowed: (id: unknown) => id is string): RecentProject[] {
  const entries: RecentProject[] = []
  for (const entry of asArray(raw)) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const boardId = record.boardId
    const openedAt = record.openedAt
    if (!boardAllowed(boardId)) continue
    if (typeof openedAt !== 'string' || !Number.isFinite(Date.parse(openedAt))) continue
    if (entries.some((known) => known.boardId === boardId)) continue
    if (entries.length >= MAX_RECENT_PROJECTS) break
    entries.push({ boardId, openedAt })
  }
  return entries
}

/**
 * §4.4's one-shot migration: a `{active}` file without a `version` becomes "that
 * board's canvas tab is the one open tab".
 *
 * This is the read-time, in-memory half only — writing `workspace.json` belongs
 * to U02. Without a known board list the reference cannot be checked, so it is
 * kept; with a list that no longer contains it, the workspace opens empty.
 */
function stateFromLegacy(raw: Record<string, unknown>, refs: WorkspaceRefs): WorkbenchTabsState {
  const boardId = raw.active
  if (typeof boardId !== 'string' || boardId.length === 0) return emptyState()
  if (refs.boardIds !== undefined && !refs.boardIds.includes(boardId)) return emptyState()
  const key = canvasTabKey(boardId)
  const now = typeof refs.now === 'string' && Number.isFinite(Date.parse(refs.now)) ? refs.now : undefined
  return {
    tabOrder: [PROJECTS_TAB, key],
    // §4.4 keeps the old "open straight into the last board" behaviour for this
    // first upgrade; the user's first trip back to the project list ends it.
    activeTab: key,
    nodeKinds: {},
    recentProjects: now === undefined ? [] : [{ boardId, openedAt: now }],
    selections: {},
  }
}

/** Element-wise equality of two id lists. */
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false
  return true
}

/** The first surviving key walking `step` from `from`, or `undefined`. */
function neighbourOf(order: readonly TabKey[], gone: ReadonlySet<TabKey>, from: number, step: 1 | -1): TabKey | undefined {
  for (let i = from; i >= 0 && i < order.length; i += step) {
    const key = order[i]
    if (!gone.has(key)) return key
  }
  return undefined
}

/** Every `node:` key of one board, in strip order. */
function nodeKeysForBoard(order: readonly TabKey[], boardId: string): TabKey[] {
  return order.filter((key) => {
    const ref = parseTabKey(key)
    return ref !== null && ref.kind === 'node' && ref.boardId === boardId
  })
}

/**
 * Index of the last tab belonging to `boardId`'s group, or `-1` when the board
 * has no canvas tab (its node tabs are orphans and land at the end).
 */
function groupEndIndex(order: readonly TabKey[], boardId: string): number {
  const canvasIndex = order.indexOf(canvasTabKey(boardId))
  if (canvasIndex < 0) return -1
  let end = canvasIndex
  for (let i = canvasIndex + 1; i < order.length; i += 1) {
    const ref = parseTabKey(order[i])
    if (ref !== null && ref.kind === 'node' && ref.boardId === boardId) end = i
  }
  return end
}
