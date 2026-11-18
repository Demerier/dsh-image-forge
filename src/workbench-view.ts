/**
 * The workbench shell: a browser-style tab strip over the panes it hosts.
 *
 * ## Why a shell and not a bigger `studio-view.ts`
 *
 * `./studio-view.ts` is one component that carries the generation form, the
 * canvas, the result list and the board manager, all in one column. That was the
 * right shape while a project *was* the panel; it stops being right as soon as
 * the panel has to hold more than one project at a time. The tab state machine
 * already exists as pure data in `./workbench-tabs.ts` (U01) and the workspace
 * file already exists on disk (U02) — this module is the seam that makes both
 * visible: a strip of `role="tab"` entries, one `role="tabpanel"` for the tab
 * that is active, and a projects pane for the one tab that can never close.
 *
 * ## What the canvas tab is now (U04 step 1b)
 *
 * The canvas tab mounts `CanvasPane` (`./canvas-pane.ts`), and hands it the
 * **tab's** `boardId` — so a tab shows the project it was opened for instead of
 * whichever board the profile last had active. The pane owns the engine: the
 * canvas area is React Flow 12, and the board-to-flow mapping is the pure module
 * `./canvas-flow-model.ts`. The studio's form, result list and asset page ride
 * along inside the pane until U05 replaces the form with the node inspector
 * (§14.5, D12); that is why `CanvasPane` composes `StudioPanel` rather than
 * rendering a bare canvas.
 *
 * The shell still mounts **only the active** canvas pane: a hidden pane per tab
 * would mean one SSE stream and one capability probe per open project, and
 * §10.2's keep-alive-not-render rule belongs with the store (U04 step 2).
 *
 * ## Persistence
 *
 * Reading the workspace happens once, on mount (`workspace-get`), and it never
 * writes anything back — a stale or legacy document is normalised in memory
 * (§4.3 WD5). Writing happens only after a **user** changed the strip, debounced
 * so a burst of clicks becomes one `workspace-set` instead of one per frame.
 * The one exception still follows the same rule: a `state.json`-only install is
 * migrated into an open canvas tab in memory (§4.4), and that migration is
 * written only when the user's next strip action commits it.
 *
 * @module workbench-view
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
  STUDIO_CONFIG_ROUTE,
  type BoardSummary,
  type StudioConfigResponse,
} from './studio-shared.ts'
import { CanvasPane } from './canvas-pane.ts'
import { ProjectsPane } from './workbench-projects.ts'
// U06: the node detail tab (§8). Everything it decides — which view a kind has,
// what the strip calls it, which nodes still have an editor — is a pure function
// there, so the shell stays the seam it is and not a second implementation.
import {
  NodeDetailPane,
  intentFor,
  nodeDetailTitle,
  openDetailItemIds,
  type CanvasIntent,
  type CanvasIntentKind,
  type NodeDetailSubject,
} from './node-detail-pane.ts'
import {
  MAX_CANVAS_TABS,
  MAX_TABS,
  PROJECTS_TAB,
  activateTab,
  canvasTabKey,
  closeTab,
  emptyState,
  listTabs,
  openCanvas,
  openNodeDetail,
  parseTabKey,
  stateFromWorkspace,
  toWorkspaceJson,
  touchRecentProjects,
  type NodeDetailKind,
  type TabDescriptor,
  type TabKey,
  type WorkbenchTabsState,
} from './workbench-tabs.ts'

/** Label of the one tab that is always present (§3.1). */
export const WORKBENCH_PROJECTS_LABEL = '项目管理'

/** Accessible name of the strip itself. */
export const WORKBENCH_TABLIST_LABEL = '工作台页签'

/**
 * How long a strip change waits before it is written (§4.1).
 *
 * A delay, not a frame: opening three projects in a row is three `setState`
 * calls in under 200 ms and must become one file write. Short enough that a
 * user who closes the panel right after a click still gets the state saved
 * (the unmount path flushes whatever is still pending).
 */
export const WORKBENCH_WRITE_DELAY_MS = 300

/** Copy for a canvas tab whose board is gone (§3.3 "invalid" state). */
export const WORKBENCH_DELETED_COPY = '这个项目已经被删除了。'

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
async function postBoardRoute(body: Record<string, unknown>): Promise<{
  error?: string
  payload?: Record<string, unknown>
}> {
  try {
    const response = await fetch(STUDIO_BOARD_ROUTE, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = await readJsonBody(response)
    if (response.ok) return payload === undefined ? {} : { payload }
    return { error: typeof payload?.error === 'string' ? payload.error : `画板操作失败（HTTP ${String(response.status)}）` }
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * Read the capability snapshot, which is also where the board library rides
 * (`StudioConfigResponse.boards`, `activeBoard`).
 *
 * The panel deliberately does **not** call `/studio/boards`: that route is
 * host-only, and the snapshot is the one place the client is given the library
 * (asserted by `test/studio.test.mjs`, "the panel gets the board list inside the
 * capability snapshot").
 */
async function readConfigSnapshot(signal?: AbortSignal): Promise<StudioConfigResponse | undefined> {
  try {
    const response = await fetch(STUDIO_CONFIG_ROUTE, {
      credentials: 'same-origin',
      ...(signal === undefined ? {} : { signal }),
    })
    const payload = await readJsonBody(response)
    if (!response.ok || payload === undefined) return undefined
    return payload as unknown as StudioConfigResponse
  } catch {
    return undefined
  }
}

/**
 * Read the stored workspace, or `null` when the host has no file yet.
 *
 * `undefined` means "the read itself failed", which is a different fact from
 * "there is no document": the first keeps the in-memory state alone, the second
 * is what triggers §4.4's `state.json` migration.
 */
async function readWorkspaceDocument(): Promise<{ workspace?: unknown; ok: boolean }> {
  const result = await postBoardRoute({ action: 'workspace-get' })
  if (result.error !== undefined) return { ok: false }
  const raw = result.payload?.['workspace']
  if (raw === undefined || raw === null) return { ok: true, workspace: null }
  return { ok: true, workspace: raw }
}

/** Write the whole workspace document (§4.5 `workspace-set`). Failures stay quiet. */
async function writeWorkspaceDocument(state: WorkbenchTabsState): Promise<boolean> {
  const result = await postBoardRoute({ action: 'workspace-set', workspace: toWorkspaceJson(state) })
  return result.error === undefined
}

/* -------------------------------------------------------------------------- */
/* Rendering helpers                                                          */
/* -------------------------------------------------------------------------- */

/** DOM id segment for a tab key: keys carry `:`, ids are safer without it. */
function idSegment(key: TabKey): string {
  return key.replace(/[^A-Za-z0-9_-]+/g, '-')
}

/** DOM id of a tab's button, so its panel can point back at it (§12.3). */
export function tabButtonId(key: TabKey): string {
  return `dsh-forge-workbench-tab-${idSegment(key)}`
}

/** DOM id of a tab's panel. */
export function tabPanelId(key: TabKey): string {
  return `dsh-forge-workbench-panel-${idSegment(key)}`
}

/** A board's display name, or a readable stand-in while the library is unknown. */
function boardNameOf(boardId: string, boards: readonly BoardSummary[]): string | undefined {
  return boards.find((board) => board.id === boardId)?.name
}

/**
 * What a tab says on the strip (§3.1: labels come from data, keys never do).
 *
 * A canvas tab is its project's name. A node detail tab is named by §8.2's rule
 * — `布局 · <项目名>`, `任务 · <prompt 首行>`, `图片 · <时间>` — with the parts the
 * shell does not have yet omitted; the detail pane reports its node's prompt and
 * time once it has read it, and the title fills in without the key moving.
 */
export function tabLabelFor(
  tab: TabDescriptor,
  boards: readonly BoardSummary[],
  subjects?: Readonly<Record<TabKey, NodeDetailSubject>>,
): string {
  if (tab.kind === 'projects') return WORKBENCH_PROJECTS_LABEL
  const name = tab.boardId === undefined ? undefined : boardNameOf(tab.boardId, boards)
  const label = name === undefined || name.length === 0 ? (tab.boardId ?? '未命名项目') : name
  if (tab.kind === 'canvas') return label
  const kind: NodeDetailKind = tab.detailKind ?? 'task'
  const subject = subjects?.[tab.key]
  return nodeDetailTitle(kind, {
    boardName: label,
    ...(subject?.prompt === undefined ? {} : { prompt: subject.prompt }),
    ...(subject?.createdAt === undefined ? {} : { createdAt: subject.createdAt }),
  })
}

/** Whether a tab may be closed at all: `projects` never may (§3.1, §12.3). */
export function isClosableTab(tab: TabDescriptor): boolean {
  return tab.kind !== 'projects'
}

/* -------------------------------------------------------------------------- */
/* The shell                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The workbench surface: the tab strip plus the pane of the active tab.
 *
 * Mounted by the `main` keyed slot in place of `StudioPanel` (`./client.ts`);
 * the seat's id, label and order are unchanged, so the sidebar row and the
 * settings page keep pointing at the same plugin entry.
 *
 * @returns the strip and the active pane.
 */
export function WorkbenchShell(): ReturnType<typeof createElement> {
  // Tab state is the pure module's own shape: this component never invents
  // ordering or activation rules, it only feeds user actions through them.
  const [state, setState] = useState<WorkbenchTabsState>(emptyState)
  const [boards, setBoards] = useState<readonly BoardSummary[]>([])
  const [boardsLoaded, setBoardsLoaded] = useState(false)
  const [config, setConfig] = useState<StudioConfigResponse | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  // Roving focus for arrow-key navigation (§12.3). An index, not a key, so a
  // closing tab cannot leave focus pointing at a vanished entry.
  const [focusIndex, setFocusIndex] = useState(0)
  // U06 (§8.2): what each detail tab is about, as far as its node has said. This
  // is *label* data, not tab state: it never reaches `workspace.json`, and a tab
  // re-learns it from the node every time it is reopened.
  const [detailSubjects, setDetailSubjects] = useState<Readonly<Record<TabKey, NodeDetailSubject>>>({})
  // U06 (§8.2): one request from a detail tab for the canvas to execute. Held
  // here because the shell is what swaps the panes; cleared once consumed.
  const [intent, setIntent] = useState<CanvasIntent | undefined>(undefined)
  const intentSeqRef = useRef(0)
  const stateRef = useRef(state)
  const pendingRef = useRef<WorkbenchTabsState | undefined>(undefined)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const tabs = listTabs(state)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  /** Coalesce strip changes into one write (§4.1). */
  const queueWrite = useCallback((next: WorkbenchTabsState) => {
    pendingRef.current = next
    if (timerRef.current !== undefined) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined
      const pending = pendingRef.current
      pendingRef.current = undefined
      if (pending !== undefined) void writeWorkspaceDocument(pending)
    }, WORKBENCH_WRITE_DELAY_MS)
  }, [])

  /** Apply a tab-state change and schedule its write. */
  const commit = useCallback(
    (next: WorkbenchTabsState) => {
      if (next === stateRef.current) return
      stateRef.current = next
      setState(next)
      queueWrite(next)
    },
    [queueWrite],
  )

  /** Reload the capability snapshot, which carries the library with it. */
  const refreshLibrary = useCallback(async (): Promise<readonly BoardSummary[]> => {
    const snapshot = await readConfigSnapshot()
    if (snapshot === undefined) {
      setError('读取项目列表失败：宿主没有回答。')
      return []
    }
    const library = Array.isArray(snapshot.boards) ? snapshot.boards : []
    setConfig(snapshot)
    setBoards(library)
    setBoardsLoaded(true)
    return library
  }, [])

  // Mount: the snapshot and the stored workspace load together, because the
  // workspace can only be validated against the boards that still exist (§4.3).
  useEffect(() => {
    let cancelled = false
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined
    void (async () => {
      const [snapshot, stored] = await Promise.all([readConfigSnapshot(controller?.signal), readWorkspaceDocument()])
      if (cancelled) return
      const library = snapshot !== undefined && Array.isArray(snapshot.boards) ? snapshot.boards : []
      if (snapshot !== undefined) {
        setConfig(snapshot)
        setBoards(library)
        setBoardsLoaded(true)
      }
      let restored = emptyState()
      if (stored.ok && stored.workspace !== null && stored.workspace !== undefined) {
        // `boardIds` is passed only when the library is known: an empty list
        // would drop every reference as "deleted" and open an empty workspace.
        restored = stateFromWorkspace(
          stored.workspace,
          snapshot === undefined ? {} : { boardIds: library.map((board) => board.id) },
        )
      } else if (stored.ok) {
        // §4.4's one-shot migration: a `state.json`-only install keeps its old
        // behaviour by turning the active board into an open canvas tab. It is
        // memory-only until the user's next strip action writes it.
        const active = snapshot?.activeBoard
        if (typeof active === 'string' && active.length > 0 && library.some((board) => board.id === active)) {
          restored = touchRecentProjects(openCanvas(emptyState(), active).state, active, new Date().toISOString())
        }
      }
      setState(restored)
      stateRef.current = restored
      setLoading(false)
    })()
    return () => {
      cancelled = true
      controller?.abort()
    }
  }, [])

  // Unmount: flush whatever the debounce still holds, so a close is not a loss.
  useEffect(
    () => () => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current)
      timerRef.current = undefined
      const pending = pendingRef.current
      pendingRef.current = undefined
      if (pending !== undefined) void writeWorkspaceDocument(pending)
    },
    [],
  )

  /** Open (or re-activate) a project's canvas tab (§3.2 rules 2 and 5). */
  const openProject = useCallback(
    (boardId: string) => {
      const result = openCanvas(stateRef.current, boardId)
      if (result.rejected === 'canvas-limit') {
        setNotice(`同时最多打开 ${String(MAX_CANVAS_TABS)} 个项目，请先关闭一个页签。`)
        return
      }
      if (result.rejected === 'tab-limit') {
        setNotice(`同时最多打开 ${String(MAX_TABS)} 个页签，请先关闭一个。`)
        return
      }
      setNotice(undefined)
      commit(touchRecentProjects(result.state, boardId, new Date().toISOString()))
    },
    [commit],
  )

  /** Select a tab that is already on the strip. */
  const activate = useCallback(
    (key: TabKey) => {
      setNotice(undefined)
      commit(activateTab(stateRef.current, key))
    },
    [commit],
  )

  /** Forget the label data of tabs that are going away (session state, §4.1). */
  const forgetSubjects = useCallback((keys: readonly TabKey[]) => {
    if (keys.length === 0) return
    setDetailSubjects((current) => {
      const next: Record<TabKey, NodeDetailSubject> = {}
      let changed = false
      for (const [key, subject] of Object.entries(current)) {
        if (keys.includes(key)) {
          changed = true
          continue
        }
        next[key] = subject
      }
      return changed ? next : current
    })
  }, [])

  /** Close one tab, cascading to a board's node tabs (§3.3, WD2). */
  const close = useCallback(
    (key: TabKey) => {
      const result = closeTab(stateRef.current, key)
      if (result.rejected !== undefined) return
      setNotice(undefined)
      forgetSubjects(result.closed ?? [key])
      commit(result.state)
    },
    [commit, forgetSubjects],
  )

  /**
   * Open (or re-activate) one node's detail tab (U06, §8.2).
   *
   * The kind comes from the canvas because it is not encodable in the key; the
   * placement, the caps and the "already open" rule are the state machine's
   * (`openNodeDetail`), never this component's.
   */
  const openNodeDetailTab = useCallback(
    (boardId: string, nodeId: string, kind: NodeDetailKind) => {
      const result = openNodeDetail(stateRef.current, boardId, nodeId, kind)
      if (result.rejected === 'tab-limit') {
        setNotice(`同时最多打开 ${String(MAX_TABS)} 个页签，请先关闭一个。`)
        return
      }
      if (result.rejected !== undefined) {
        setNotice('这个节点打不开详情页签。')
        return
      }
      setNotice(undefined)
      commit(result.state)
    },
    [commit],
  )

  /**
   * The detail tab's breadcrumb, both directions of it (§8.3).
   *
   * When the source canvas is still on the strip this is an activation; when it
   * has been closed, the degraded breadcrumb's "reopen the project" is the same
   * call — `openProject` re-checks the caps and re-opens it.
   */
  const backToCanvas = useCallback(
    (boardId: string) => {
      const key = canvasTabKey(boardId)
      if (stateRef.current.tabOrder.includes(key)) activate(key)
      else openProject(boardId)
    },
    [activate, openProject],
  )

  /**
   * A detail tab asked the canvas to run something (§8.2).
   *
   * The request is held here, the canvas tab is activated, and the canvas
   * consumes it once. Nothing is executed in the shell: the run has to become a
   * task node on the canvas, and that is the canvas tab's own path.
   */
  const runCanvasIntent = useCallback(
    (kind: CanvasIntentKind, boardId: string, nodeId: string) => {
      intentSeqRef.current += 1
      const request = intentFor(kind, boardId, nodeId, `u06-${String(intentSeqRef.current)}`)
      if (request === undefined) return
      setNotice(undefined)
      setIntent(request)
      const opened = openCanvas(stateRef.current, boardId)
      commit(opened.state)
      if (opened.rejected === 'canvas-limit') {
        setNotice(`同时最多打开 ${String(MAX_CANVAS_TABS)} 个项目，请先关闭一个页签。`)
        setIntent(undefined)
        return
      }
      if (opened.rejected === 'tab-limit') {
        setNotice(`同时最多打开 ${String(MAX_TABS)} 个页签，请先关闭一个。`)
        setIntent(undefined)
        return
      }
      commit(opened.state)
    },
    [commit],
  )

  /** The canvas ran the request; it must not run twice (§8.2). */
  const consumeIntent = useCallback(() => {
    setIntent(undefined)
  }, [])

  /** Create a project and open it, the primary action of §5.3. */
  const createProject = useCallback(
    async (name?: string) => {
      const trimmed = typeof name === 'string' ? name.trim() : ''
      const result = await postBoardRoute(trimmed.length === 0 ? { action: 'create' } : { action: 'create', name: trimmed })
      if (result.error !== undefined) {
        setError(result.error)
        return
      }
      const created = result.payload?.['board'] as BoardSummary | undefined
      setError(undefined)
      await refreshLibrary()
      if (created !== undefined && typeof created.id === 'string' && created.id.length > 0) openProject(created.id)
    },
    [openProject, refreshLibrary],
  )

  /** Rename a project in place. */
  const renameProject = useCallback(async (boardId: string, name: string) => {
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    const result = await postBoardRoute({ action: 'rename', board: boardId, name: trimmed })
    if (result.error !== undefined) {
      setError(result.error)
      return
    }
    setError(undefined)
    setBoards((current) => current.map((board) => (board.id === boardId ? { ...board, name: trimmed } : board)))
  }, [])

  /**
   * Delete a project, and close its canvas tab with it (§5.4).
   *
   * The confirmation itself lives in the pane, because whether to ask at all
   * depends on the item count the pane is already showing.
   */
  const deleteProject = useCallback(
    async (boardId: string) => {
      const result = await postBoardRoute({ action: 'delete', board: boardId })
      if (result.error !== undefined) {
        setError(result.error)
        return
      }
      setError(undefined)
      setBoards((current) => current.filter((board) => board.id !== boardId))
      const closed = closeTab(stateRef.current, canvasTabKey(boardId))
      if (closed.rejected === undefined) {
        // §3.3 (WD2): the board's detail tabs went with it, so their labels go
        // too — a deleted board must not leave a title behind for a dead tab.
        forgetSubjects(closed.closed ?? [])
        setState(closed.state)
        stateRef.current = closed.state
        queueWrite(closed.state)
      }
    },
    [forgetSubjects, queueWrite],
  )

  /**
   * Strip keyboard handling (§12.2, §12.3).
   *
   * Arrow keys move the roving focus, `Enter`/`Space` activate, `Home`/`End`
   * jump, and `Esc` closes the focused tab when it is closable. Typing inside a
   * field of the active pane must never be swallowed, so anything aimed at an
   * input owns its own keys.
   */
  const onStripKeyDown = useCallback(
    (event: {
      key?: string
      preventDefault?: () => void
      target?: { tagName?: string; isContentEditable?: boolean }
      ctrlKey?: boolean
      altKey?: boolean
    }) => {
      const target = event.target
      const tag = typeof target?.tagName === 'string' ? target.tagName.toUpperCase() : ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable === true) return
      const order = listTabs(stateRef.current)
      if (order.length === 0) return
      const index = Math.min(Math.max(focusIndex, 0), order.length - 1)
      const focused = order[index]
      const take = (at: number): void => {
        event.preventDefault?.()
        const bounded = ((at % order.length) + order.length) % order.length
        setFocusIndex(bounded)
      }
      switch (event.key) {
        case 'ArrowRight':
          take(index + 1)
          return
        case 'ArrowLeft':
          take(index - 1)
          return
        case 'Home':
          take(0)
          return
        case 'End':
          take(order.length - 1)
          return
        case 'Enter':
        case ' ':
          if (focused !== undefined) {
            event.preventDefault?.()
            activate(focused.key)
          }
          return
        case 'Escape':
          // §12.2 closes a tab on Escape only from the strip itself: inside the
          // canvas, Escape stays "cancel the selection", because that handler
          // lives in the pane and never reaches this one. `projects` is not
          // closable, so it falls through untouched.
          if (focused !== undefined && isClosableTab(focused)) {
            event.preventDefault?.()
            close(focused.key)
          }
          return
        case '1':
          if (event.ctrlKey === true && event.altKey === true) {
            event.preventDefault?.()
            activate(PROJECTS_TAB)
          }
          return
        default:
          return
      }
    },
    [activate, close, focusIndex],
  )

  const activeTab = tabs.find((tab) => tab.key === state.activeTab)
  const activeRef = parseTabKey(state.activeTab)
  const activeBoardId = activeRef !== null && activeRef.kind !== 'projects' ? activeRef.boardId : undefined
  /**
   * §8.4 (WD10): the nodes the canvas must paint as read-only thumbnails.
   *
   * The strip is the source of truth (`openDetailItemIds`), not "who mounted
   * last": while a layout node's detail tab is open the canvas stays read-only
   * whichever of the two panes is on screen. Only the *canvas* tab needs it, so
   * it is computed for that one board and left undefined everywhere else.
   */
  const detailOpen = useMemo(
    () => (activeBoardId === undefined ? undefined : openDetailItemIds(tabs, activeBoardId)),
    [activeBoardId, tabs],
  )
  // §3.3's "invalid" state: the library loaded and this tab's board is not in
  // it, so the pane has nothing to draw. Never shown while the library is still
  // unknown — that would flash "deleted" over every restored tab on a slow read.
  const missingBoard =
    boardsLoaded && activeBoardId !== undefined && !boards.some((board) => board.id === activeBoardId)

  const environment = useMemo(
    () => (config === undefined ? undefined : { ready: config.ready === true, reason: config.reason }),
    [config],
  )

  let panel: ReactNode = null
  if (activeTab === undefined) {
    panel = createElement('p', { className: 'dsh-forge-workbench-empty-note' }, '没有可显示的页签。')
  } else if (activeTab.kind === 'projects') {
    panel = createElement(ProjectsPane, {
      boards,
      loading,
      environment,
      error,
      onCreate: createProject,
      onOpen: openProject,
      onRename: renameProject,
      onDelete: deleteProject,
      onRefresh: () => {
        void refreshLibrary()
      },
    })
  } else if (activeTab.kind === 'canvas') {
    panel = missingBoard
      ? createElement('div', { className: 'dsh-forge-workbench-deleted' }, [
          createElement('p', { key: 'copy', className: 'dsh-forge-workbench-empty-note' }, WORKBENCH_DELETED_COPY),
          createElement(
            'button',
            {
              key: 'close',
              type: 'button',
              className: 'dsh-forge-workbench-action',
              onClick: () => close(activeTab.key),
            },
            '关闭页签',
          ),
        ])
      : // U04 step 1b: the tab owns its board and the canvas engine. `CanvasPane`
        // composes them, and since U06 it also carries the two facts the detail
        // tab needs: how to open one (`onOpenNode`), and which nodes already have
        // one open (`detailOpen` — §8.4's read-only thumbnail).
        createElement(CanvasPane, {
          boardId: activeBoardId,
          boards,
          onOpenNode: openNodeDetailTab,
          ...(detailOpen === undefined ? {} : { detailOpen }),
          ...(intent === undefined ? {} : { intent }),
          onIntentDone: consumeIntent,
        })
  } else {
    // U06 (§8.2): the node detail tab lives here. The key decides *which* node;
    // the kind decides which of the three views, and it lives beside the key in
    // the state (`nodeKinds`) because §3.1 keeps the key shape-free.
    const detailBoardId = activeTab.boardId ?? ''
    const detailItemId = activeTab.itemId ?? ''
    const detailKind: NodeDetailKind = activeTab.detailKind ?? 'task'
    panel = missingBoard
      ? createElement('div', { className: 'dsh-forge-workbench-deleted' }, [
          createElement('p', { key: 'copy', className: 'dsh-forge-workbench-empty-note' }, WORKBENCH_DELETED_COPY),
          createElement(
            'button',
            {
              key: 'close',
              type: 'button',
              className: 'dsh-forge-workbench-action',
              onClick: () => close(activeTab.key),
            },
            '关闭页签',
          ),
        ])
      : createElement(NodeDetailPane, {
          boardId: detailBoardId,
          itemId: detailItemId,
          kind: detailKind,
          ...(boardNameOf(detailBoardId, boards) === undefined
            ? {}
            : { boardName: boardNameOf(detailBoardId, boards) }),
          orphaned: activeTab.orphaned,
          onBackToCanvas: () => backToCanvas(detailBoardId),
          onClose: () => close(activeTab.key),
          onSubject: (subject: NodeDetailSubject) => {
            // §8.2: the title fills in once the node has been read. Skipped when
            // it says nothing new, so a re-read cannot re-render the strip.
            const current = detailSubjects[activeTab.key]
            if (
              current !== undefined &&
              current.prompt === subject.prompt &&
              current.createdAt === subject.createdAt
            ) return
            setDetailSubjects((previous) => ({ ...previous, [activeTab.key]: subject }))
          },
          onIntent: (action: CanvasIntentKind) => { runCanvasIntent(action, detailBoardId, detailItemId) },
        })
  }

  const stripTabs = tabs.map((tab, index) => {
    const active = tab.key === state.activeTab
    const label = tabLabelFor(tab, boards, detailSubjects)
    const entries: ReactNode[] = [
      createElement('span', { key: 'label', className: 'dsh-forge-workbench-tab-label' }, label),
    ]
    if (isClosableTab(tab)) {
      // §12.3: a real button with its own label — `projects` renders none at
      // all (not a disabled one), so "why does this not work" never comes up.
      entries.push(
        createElement(
          'button',
          {
            key: 'close',
            type: 'button',
            className: 'dsh-forge-workbench-tab-close',
            'aria-label': `关闭 ${label}`,
            title: `关闭 ${label}`,
            onClick: (event: { stopPropagation?: () => void }) => {
              event.stopPropagation?.()
              close(tab.key)
            },
          },
          '×',
        ),
      )
    }
    return createElement(
      'div',
      {
        key: tab.key,
        role: 'tab',
        id: tabButtonId(tab.key),
        className: active
          ? 'dsh-forge-workbench-tab dsh-forge-workbench-tab-active'
          : 'dsh-forge-workbench-tab',
        'aria-selected': active,
        'aria-controls': tabPanelId(tab.key),
        tabIndex: index === Math.min(Math.max(focusIndex, 0), tabs.length - 1) ? 0 : -1,
        'data-tab-key': tab.key,
        'data-tab-kind': tab.kind,
        onClick: () => activate(tab.key),
        onKeyDown: onStripKeyDown,
      },
      entries,
    )
  })

  return createElement('div', { className: 'dsh-forge-workbench', 'data-tabs': tabs.length }, [
    createElement(
      'div',
      {
        key: 'strip',
        className: 'dsh-forge-workbench-strip',
        role: 'tablist',
        'aria-label': WORKBENCH_TABLIST_LABEL,
        onKeyDown: onStripKeyDown,
      },
      stripTabs,
    ),
    notice === undefined
      ? null
      : createElement('div', { key: 'notice', className: 'dsh-forge-workbench-notice', role: 'status' }, notice),
    createElement(
      'div',
      {
        key: 'panel',
        className: 'dsh-forge-workbench-panel',
        role: 'tabpanel',
        id: activeTab === undefined ? undefined : tabPanelId(activeTab.key),
        'aria-labelledby': activeTab === undefined ? undefined : tabButtonId(activeTab.key),
      },
      panel,
    ),
  ])
}
