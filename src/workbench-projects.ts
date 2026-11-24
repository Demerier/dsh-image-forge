/**
 * The `projects` tab: the grid of canvases the workbench knows about.
 *
 * This is the one tab that can never close (§3.1), so it is also the tab the
 * panel lands on and the place every "nothing here yet" story is told (§11).
 *
 * ## What it reads, and what it hands back
 *
 * The pane is **presentational on purpose**: it owns the transient UI state that
 * only it cares about — the search box, the sort order, which card is being
 * renamed, which one is asking "really delete?" — and reports every mutation up
 * to the shell (`./workbench-view.ts`), which owns the network and the tab
 * state. That split is what lets the card grid be asserted without a live host,
 * and what keeps the delete confirmation next to the item count it has to show
 * (§5.4): a shell-level dialog would not know whether the project is empty.
 *
 * ## Fields and where they come from (§5.2, WD6)
 *
 * `BoardSummary` (`src/studio-shared.ts:518`) already carries everything the
 * card needs: name, item count, cover (the newest image's `markdownPath`), the
 * timestamps, and the conversation it came from. The cover is served through
 * the plugin's own file route at the 256-px contact-sheet width — one image per
 * card, never a contact sheet, because a mosaic would cost a server-side render
 * per card (§5.2's decision note).
 *
 * @module workbench-projects
 */
import { createElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { formatBytes, studioFileUrl, type BoardSummary } from './studio-shared.ts'

/** Sort orders the toolbar offers (§5.3). `recent` is the default. */
export const PROJECT_SORTS = ['recent', 'name'] as const

/** One of {@link PROJECT_SORTS}. */
export type ProjectSort = (typeof PROJECT_SORTS)[number]

/** How each sort reads in the picker. */
export const PROJECT_SORT_LABELS: Readonly<Record<ProjectSort, string>> = {
  recent: '最近修改',
  name: '名称',
}

/** Cover width asked of the file route (`STUDIO_THUMB_WIDTHS` entry, §5.2). */
export const PROJECT_COVER_WIDTH = 256

/** Copy of the first-run empty state (§11.1). */
export const PROJECTS_EMPTY_TITLE = '还没有项目'
export const PROJECTS_EMPTY_BODY = '项目 = 一块无限画布，你的图、布局和迭代都在里面。'
export const PROJECTS_EMPTY_ACTION = '新建项目'
export const PROJECTS_NO_MATCH_COPY = '没有匹配的项目。'

/**
 * The toolbar entry to the global asset library (U08).
 *
 * The library itself is **not** this module's business any more: it is
 * `AssetsPane` (`./workbench-assets.ts`), and the shell swaps it in as the
 * projects tab's second view (§9.2 — a view, never a tab of its own). This pane
 * only offers the entry, because the entry belongs to the toolbar the user is
 * looking at when they think "where did that picture go".
 */
export const PROJECTS_ASSETS_ENTRY = '全局素材'

/* -------------------------------------------------------------------------- */
/* Pure helpers (asserted directly by the tests)                              */
/* -------------------------------------------------------------------------- */

/** One minute, in milliseconds. */
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * A timestamp as "3 分钟前"-style text, or a date once it is older than a week.
 *
 * @param iso - an ISO timestamp from a board summary.
 * @param now - the clock, injected so the phrases can be asserted exactly.
 * @returns relative text, or `''` when the timestamp is unusable.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const delta = now - at
  if (delta < MINUTE) return '刚刚'
  if (delta < HOUR) return `${String(Math.floor(delta / MINUTE))} 分钟前`
  if (delta < DAY) return `${String(Math.floor(delta / HOUR))} 小时前`
  if (delta < 7 * DAY) return `${String(Math.floor(delta / DAY))} 天前`
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${String(date.getFullYear())}-${month}-${day}`
}

/** The absolute timestamp a card shows on hover, local to the reader. */
export function absoluteTime(iso: string): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  try {
    return new Date(at).toLocaleString()
  } catch {
    return new Date(at).toISOString()
  }
}

/** Substring filter over project names (§5.3: no server round trip). */
export function filterProjects(boards: readonly BoardSummary[], query: string): BoardSummary[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return [...boards]
  return boards.filter((board) => board.name.toLowerCase().includes(needle))
}

/** Local sort, on a copy: `recent` by `updatedAt` descending, `name` A→Z. */
export function sortProjects(boards: readonly BoardSummary[], sort: ProjectSort): BoardSummary[] {
  const copy = [...boards]
  if (sort === 'name') return copy.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'))
  return copy.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
}

/** The one-line count under a card's title (§5.2). */
export function itemCountLabel(count: number): string {
  return count === 0 ? '空项目' : `${String(count)} 个节点`
}

/**
 * How much disk a project's pictures take, for the card's meta line (U07).
 *
 * `''` when the host did not report a size — an older payload or a fixture —
 * because "· 0 B" next to a full project would be a lie, and the empty-cover
 * branch already says "空项目" for a genuinely empty one.
 *
 * @param board - the summary the card is rendering.
 * @returns `86 MB` / `1.2 GB` / `0 B`, or `''` when unknown.
 */
export function boardSizeLabel(board: Pick<BoardSummary, 'bytes'>): string {
  return typeof board.bytes === 'number' && Number.isFinite(board.bytes) ? formatBytes(board.bytes) : ''
}

/**
 * The line inside the destructive delete confirmation (§5.4): what goes, and
 * that it does not come back.
 *
 * Counts **pictures**, not nodes: `itemCount` includes a failed task and a
 * layout draft, and neither is a file the user could lose. Falls back to
 * `itemCount` when an older payload carries no `imageCount`.
 *
 * @param board - the project about to be deleted.
 * @returns e.g. `将删除 3 张图片 · 86 MB，无法恢复。`
 */
export function deleteFilesWarning(board: Pick<BoardSummary, 'imageCount' | 'itemCount' | 'bytes'>): string {
  const images = typeof board.imageCount === 'number' ? board.imageCount : board.itemCount
  return `连图片一起删除：将删除 ${String(images)} 张图片 · ${formatBytes(board.bytes)}，无法恢复。`
}

/* -------------------------------------------------------------------------- */
/* The pane                                                                   */
/* -------------------------------------------------------------------------- */

/** What a confirmed delete should do with the pictures (§5.4). */
export type ProjectDeleteMode = 'keep' | 'files'

/** The labels of the two delete choices, kept here so a test can name them once. */
export const PROJECT_DELETE_KEEP_LABEL = '只删项目（图片留在素材库）'
export const PROJECT_DELETE_FILES_LABEL = '连图片一起删除'
export const PROJECT_DELETE_EMPTY_LABEL = '确认删除'
export const PROJECT_CANCEL_LABEL = '取消'
/** The card action that copies a project (§5.3). */
export const PROJECT_DUPLICATE_LABEL = '复制'

/** Props of {@link ProjectsPane}; every mutation is a callback, not a fetch. */
export interface ProjectsPaneProps {
  /** The library as the shell last read it (config snapshot). */
  readonly boards: readonly BoardSummary[]
  /** True until the first library read finished. */
  readonly loading?: boolean
  /** Capability snapshot, only for the §11.1 environment hint. */
  readonly environment?: { readonly ready: boolean; readonly reason?: string }
  /** A refusal from the last board mutation, shown above the grid. */
  readonly error?: string
  /** Create a project; an empty name lets the host auto-name it (§5.3). */
  readonly onCreate: (name?: string) => unknown
  /** Open (or re-activate) a project's canvas tab. */
  readonly onOpen: (boardId: string) => void
  /** Commit a rename. */
  readonly onRename: (boardId: string, name: string) => unknown
  /** Copy a project: same entries and layout, new board (§5.3). */
  readonly onDuplicate?: (boardId: string) => unknown
  /**
   * Delete a project — the pane has already confirmed it, including *which*
   * delete: `keep` (default) leaves the pictures on disk, `files` also unlinks
   * them (§5.4). The mode is passed, not inferred, so the destructive path is
   * always the result of a click the user made on a labelled button.
   */
  readonly onDelete: (boardId: string, mode?: ProjectDeleteMode) => unknown
  /** Re-read the library and the environment (`重新检测`). */
  readonly onRefresh?: () => void
  /**
   * Show the global asset library (U08, §9.2).
   *
   * The pane does **not** render that view itself: the shell owns which of the
   * projects tab's two views is on screen, so the switch survives a tab change
   * and so this component keeps its "presentational, assertable alone" shape.
   * Absent means the entry is not offered at all.
   */
  readonly onOpenAssets?: () => void
}

/** One card's cover: the newest image at 256 px, or a glyph when there is none. */
function Cover(props: { board: BoardSummary }): ReactNode {
  const { board } = props
  if (board.cover === null || board.cover.length === 0) {
    return createElement(
      'span',
      { className: 'dsh-forge-workbench-cover dsh-forge-workbench-cover-empty', 'aria-hidden': 'true' },
      board.itemCount === 0 ? '＋' : '🖼',
    )
  }
  return createElement('span', { className: 'dsh-forge-workbench-cover' }, [
    createElement('img', {
      key: 'img',
      src: studioFileUrl(board.cover, PROJECT_COVER_WIDTH),
      alt: '',
      loading: 'lazy',
    }),
  ])
}

/**
 * The projects pane.
 *
 * @param props - the library plus the mutation callbacks the shell owns.
 * @returns the toolbar (whose last entry is a request to switch views), the
 *   environment hint, and the card grid — or the first-run / no-match state.
 */
export function ProjectsPane(props: ProjectsPaneProps): ReturnType<typeof createElement> {
  const { boards, loading, environment, error, onCreate, onOpen, onRename, onDuplicate, onDelete, onRefresh, onOpenAssets } = props
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<ProjectSort>('recent')
  const [draftName, setDraftName] = useState('')
  const [renaming, setRenaming] = useState<string | undefined>(undefined)
  const [renameValue, setRenameValue] = useState('')
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const [menuFor, setMenuFor] = useState<string | undefined>(undefined)
  const projectsRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (menuFor === undefined || typeof document === 'undefined') return undefined
    const close = (event: Event): void => {
      const target = event.target
      if (target instanceof Element && target.closest(`[data-project-menu="${menuFor}"]`) !== null) return
      setMenuFor(undefined)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menuFor])

  const visible = useMemo(() => sortProjects(filterProjects(boards, query), sort), [boards, query, sort])
  const now = Date.now()

  const toolbar = createElement('div', { key: 'toolbar', className: 'dsh-forge-workbench-toolbar' }, [
    createElement('input', {
      key: 'new-name',
      type: 'text',
      className: 'dsh-forge-workbench-input dsh-forge-workbench-new-name',
      placeholder: '新项目名称（留空自动命名）',
      'aria-label': '新项目名称',
      value: draftName,
      onChange: (event: { target: { value: string } }) => setDraftName(event.target.value),
      onKeyDown: (event: { key?: string; preventDefault?: () => void }) => {
        if (event.key !== 'Enter') return
        event.preventDefault?.()
        void onCreate(draftName)
        setDraftName('')
      },
    }),
    createElement(
      'button',
      {
        key: 'new',
        type: 'button',
        className: 'dsh-forge-workbench-primary',
        onClick: () => {
          void onCreate(draftName)
          setDraftName('')
        },
      },
      PROJECTS_EMPTY_ACTION,
    ),
    createElement('input', {
      key: 'search',
      type: 'search',
      className: 'dsh-forge-workbench-input dsh-forge-workbench-search',
      placeholder: '搜索项目',
      'aria-label': '搜索项目',
      value: query,
      onChange: (event: { target: { value: string } }) => setQuery(event.target.value),
    }),
    createElement(
      'select',
      {
        key: 'sort',
        className: 'dsh-forge-workbench-select',
        'aria-label': '排序',
        value: sort,
        onChange: (event: { target: { value: string } }) => {
          setSort(event.target.value === 'name' ? 'name' : 'recent')
        },
      },
      PROJECT_SORTS.map((choice) =>
        createElement('option', { key: choice, value: choice }, PROJECT_SORT_LABELS[choice]),
      ),
    ),
    onOpenAssets === undefined
      ? null
      : createElement(
          'button',
          {
            key: 'assets',
            type: 'button',
            className: 'dsh-forge-workbench-action dsh-forge-workbench-assets-entry',
            title: '全局素材库：这个工作台所有项目产出的图',
            onClick: () => {
              onOpenAssets()
            },
          },
          PROJECTS_ASSETS_ENTRY,
        ),
  ])

  const environmentHint =
    environment !== undefined && environment.ready === false
      ? createElement('div', { key: 'env', className: 'dsh-forge-workbench-env', role: 'status' }, [
          createElement(
            'span',
            { key: 'text', className: 'dsh-forge-workbench-env-text' },
            environment.reason === undefined || environment.reason.length === 0
              ? 'ComfyUI 还没连上，现在还不能出图；画布编辑不受影响。'
              : `ComfyUI 还没连上：${environment.reason}`,
          ),
          onRefresh === undefined
            ? null
            : createElement(
                'button',
                {
                  key: 'retry',
                  type: 'button',
                  className: 'dsh-forge-workbench-action',
                  onClick: () => {
                    onRefresh()
                  },
                },
                '重新检测',
              ),
        ])
      : null

  let body: ReactNode
  if (boards.length === 0 && loading === true) {
    body = createElement('p', { key: 'loading', className: 'dsh-forge-workbench-empty-note' }, '正在读取项目…')
  } else if (boards.length === 0) {
    // §11.1: the first-run card. The primary action is the same one the toolbar
    // offers, because "nothing here" is exactly when a user needs it explained.
    body = createElement('div', { key: 'empty', className: 'dsh-forge-workbench-empty' }, [
      createElement('h3', { key: 'title', className: 'dsh-forge-workbench-empty-title' }, PROJECTS_EMPTY_TITLE),
      createElement('p', { key: 'copy', className: 'dsh-forge-workbench-empty-body' }, PROJECTS_EMPTY_BODY),
      createElement(
        'button',
        {
          key: 'action',
          type: 'button',
          className: 'dsh-forge-workbench-primary',
          onClick: () => {
            void onCreate('')
          },
        },
        PROJECTS_EMPTY_ACTION,
      ),
    ])
  } else if (visible.length === 0) {
    body = createElement('p', { key: 'nomatch', className: 'dsh-forge-workbench-empty-note' }, PROJECTS_NO_MATCH_COPY)
  } else {
    body = createElement(
      'div',
      { key: 'grid', className: 'dsh-forge-workbench-grid' },
      visible.map((board) => {
        const renamingThis = renaming === board.id
        const confirmingThis = confirming === board.id
        const size = boardSizeLabel(board)
        const cardChildren: ReactNode[] = [
          createElement('button', {
            key: 'open',
            type: 'button',
            className: 'dsh-forge-workbench-card-open',
            title: `打开 ${board.name}`,
            onClick: () => onOpen(board.id),
          }, [
            createElement(Cover, { key: 'cover', board }),
            createElement('span', { key: 'title', className: 'dsh-forge-workbench-card-title' }, board.name),
            createElement('span', { key: 'meta', className: 'dsh-forge-workbench-card-meta' }, [
              createElement('span', { key: 'count', className: 'dsh-forge-workbench-card-count' }, itemCountLabel(board.itemCount)),
              // U07: the size sits next to the count (`12 个节点 · 86 MB`). It is
              // omitted rather than shown as `0 B` when the host did not report it.
              size.length === 0
                ? null
                : createElement('span', { key: 'size', className: 'dsh-forge-workbench-card-size' }, [
                    createElement('span', { key: 'dot', className: 'dsh-forge-workbench-card-dot', 'aria-hidden': 'true' }, '·'),
                    size,
                  ]),
              createElement('span', { key: 'dot-time', className: 'dsh-forge-workbench-card-dot', 'aria-hidden': 'true' }, '·'),
              createElement(
                'span',
                { key: 'time', className: 'dsh-forge-workbench-card-time', title: absoluteTime(board.updatedAt) },
                relativeTime(board.updatedAt, now),
              ),
            ]),
          ]),
        ]
        if (renamingThis) {
          cardChildren.push(
            createElement('div', { key: 'rename', className: 'dsh-forge-workbench-rename' }, [
              createElement('input', {
                key: 'input',
                type: 'text',
                className: 'dsh-forge-workbench-input',
                'aria-label': `重命名 ${board.name}`,
                value: renameValue,
                onChange: (event: { target: { value: string } }) => setRenameValue(event.target.value),
                onBlur: () => {
                  void onRename(board.id, renameValue)
                  setRenaming(undefined)
                },
                onKeyDown: (event: { key?: string; preventDefault?: () => void; target?: { value?: string } }) => {
                  if (event.key === 'Enter') {
                    event.preventDefault?.()
                    void onRename(board.id, renameValue)
                    setRenaming(undefined)
                  } else if (event.key === 'Escape') {
                    event.preventDefault?.()
                    setRenaming(undefined)
                  }
                },
              }),
            ]),
          )
        } else {
          const menuOpen = menuFor === board.id
          cardChildren.push(
            createElement('div', {
              key: 'actions',
              className: 'dsh-forge-workbench-card-actions',
              'data-project-menu': board.id,
            }, [
              createElement('button', {
                key: 'menu',
                type: 'button',
                className: menuOpen
                  ? 'dsh-forge-workbench-menu-toggle is-open'
                  : 'dsh-forge-workbench-menu-toggle',
                'aria-label': `管理 ${board.name}`,
                'aria-haspopup': 'menu',
                'aria-expanded': menuOpen,
                onClick: (event?: { stopPropagation?(): void }) => {
                  event?.stopPropagation?.()
                  setMenuFor(menuOpen ? undefined : board.id)
                  setConfirming(undefined)
                },
              }, '•••'),
              menuOpen
                ? createElement('div', { key: 'menu', className: 'dsh-forge-workbench-card-menu', role: 'menu' }, [
                    createElement('button', {
                      key: 'rename',
                      type: 'button',
                      role: 'menuitem',
                      className: 'dsh-forge-workbench-action',
                      'aria-label': `重命名 ${board.name}`,
                      onClick: () => {
                        setRenaming(board.id)
                        setRenameValue(board.name)
                        setConfirming(undefined)
                        setMenuFor(undefined)
                      },
                    }, '重命名'),
                    onDuplicate === undefined
                      ? null
                      : createElement('button', {
                          key: 'duplicate',
                          type: 'button',
                          role: 'menuitem',
                          className: 'dsh-forge-workbench-action',
                          'aria-label': `复制 ${board.name}`,
                          title: '复制一份：条目、位置与血缘都复制，图片文件不复制',
                          onClick: () => {
                            setConfirming(undefined)
                            setMenuFor(undefined)
                            void onDuplicate(board.id)
                          },
                        }, PROJECT_DUPLICATE_LABEL),
                    createElement('button', {
                      key: 'delete',
                      type: 'button',
                      role: 'menuitem',
                      className: 'dsh-forge-workbench-action is-danger',
                      'aria-label': `删除 ${board.name}`,
                      onClick: () => {
                        setMenuFor(undefined)
                        setConfirming(board.id)
                      },
                    }, '删除'),
                  ])
                : null,
            ]),
          )
        }
        if (confirmingThis) {
          // §5.4: the confirmation names what is about to go, and — for a project
          // with pictures — the two modes are *two labelled buttons*, never one
          // button plus a checkbox. The destructive one spells out the count, the
          // size and that it cannot be undone, so "连图片一起删除" is always a click
          // on a sentence the user has read.
          const empty = board.itemCount === 0
          const options: ReactNode[] = empty
            ? [
                createElement(
                  'button',
                  {
                    key: 'confirm',
                    type: 'button',
                    className: 'dsh-forge-workbench-action is-danger',
                    onClick: () => {
                      void onDelete(board.id)
                      setConfirming(undefined)
                    },
                  },
                  PROJECT_DELETE_EMPTY_LABEL,
                ),
              ]
            : [
                createElement(
                  'button',
                  {
                    key: 'keep',
                    type: 'button',
                    className: 'dsh-forge-workbench-action is-danger',
                    'aria-label': `只删项目 ${board.name}`,
                    title: '项目条目会消失，图片文件留在素材库，仍可从素材库找回',
                    onClick: () => {
                      void onDelete(board.id, 'keep')
                      setConfirming(undefined)
                    },
                  },
                  PROJECT_DELETE_KEEP_LABEL,
                ),
                createElement(
                  'button',
                  {
                    key: 'files',
                    type: 'button',
                    className: 'dsh-forge-workbench-action is-danger',
                    'aria-label': `连图片一起删除 ${board.name}`,
                    onClick: () => {
                      void onDelete(board.id, 'files')
                      setConfirming(undefined)
                    },
                  },
                  PROJECT_DELETE_FILES_LABEL,
                ),
              ]
          cardChildren.push(
            createElement('div', { key: 'confirm', className: 'dsh-forge-workbench-confirm', role: 'group' }, [
              createElement(
                'p',
                { key: 'copy', className: 'dsh-forge-workbench-confirm-copy' },
                empty
                  ? `删除空项目「${board.name}」？此操作不可撤销。`
                  : `删除「${board.name}」？它的 ${String(board.itemCount)} 个节点会一起消失。`,
              ),
              empty
                ? null
                : createElement(
                    'p',
                    { key: 'warn', className: 'dsh-forge-workbench-confirm-warn' },
                    deleteFilesWarning(board),
                  ),
              createElement('div', { key: 'actions', className: 'dsh-forge-workbench-confirm-actions' }, [
                ...options,
                createElement(
                  'button',
                  {
                    key: 'cancel',
                    type: 'button',
                    className: 'dsh-forge-workbench-action',
                    onClick: () => setConfirming(undefined),
                  },
                  PROJECT_CANCEL_LABEL,
                ),
              ]),
            ]),
          )
        }
        return createElement('article', { key: board.id, className: 'dsh-forge-workbench-card', 'data-board-id': board.id }, cardChildren)
      }),
    )
  }

  const refusal =
    error === undefined || error.length === 0
      ? null
      : createElement('div', { key: 'error', className: 'dsh-forge-workbench-error', role: 'alert' }, error)

  const hero = createElement('section', { key: 'hero', className: 'dsh-forge-workbench-hero' }, [
    createElement('div', { key: 'copy', className: 'dsh-forge-workbench-hero-copy' }, [
      createElement('span', { key: 'eyebrow', className: 'dsh-forge-workbench-hero-eyebrow' }, 'FORGE · 创作工作台'),
      createElement('h2', { key: 'title', className: 'dsh-forge-workbench-hero-title' }, '把想法放上画布，继续把它做深。'),
      createElement('p', { key: 'body', className: 'dsh-forge-workbench-hero-body' }, '一张图、一组版式、一次修改都留在同一个无限画板里。'),
    ]),
    createElement('span', { key: 'badge', className: 'dsh-forge-workbench-hero-badge' }, `${String(visible.length)} 个项目`),
  ])
  return createElement('div', { ref: projectsRef, className: 'dsh-forge-workbench-projects' }, [
    hero,
    toolbar,
    environmentHint,
    refusal,
    body,
  ])
}
