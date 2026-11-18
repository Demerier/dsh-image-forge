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
import { createElement, useMemo, useState, type ReactNode } from 'react'
import { studioFileUrl, type BoardSummary } from './studio-shared.ts'

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

/** Copy of the assets sub-view, which U08 fills in (§9.2). */
export const PROJECTS_ASSETS_COPY = '全局素材库会在这里列出所有项目产出的图（U08 落地）。'

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

/* -------------------------------------------------------------------------- */
/* The pane                                                                   */
/* -------------------------------------------------------------------------- */

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
  /** Delete a project — the pane has already confirmed it. */
  readonly onDelete: (boardId: string) => unknown
  /** Re-read the library and the environment (`重新检测`). */
  readonly onRefresh?: () => void
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
 * @returns the toolbar, the card grid (or the empty state), and the assets
 *   sub-view when it is open.
 */
export function ProjectsPane(props: ProjectsPaneProps): ReturnType<typeof createElement> {
  const { boards, loading, environment, error, onCreate, onOpen, onRename, onDelete, onRefresh } = props
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<ProjectSort>('recent')
  const [draftName, setDraftName] = useState('')
  const [renaming, setRenaming] = useState<string | undefined>(undefined)
  const [renameValue, setRenameValue] = useState('')
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const [assetsOpen, setAssetsOpen] = useState(false)

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
    createElement(
      'button',
      {
        key: 'assets',
        type: 'button',
        className: 'dsh-forge-workbench-action dsh-forge-workbench-assets-entry',
        'aria-pressed': assetsOpen,
        title: '全局素材库',
        onClick: () => setAssetsOpen((open) => !open),
      },
      assetsOpen ? '返回项目' : '全局素材',
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

  if (assetsOpen) {
    return createElement('div', { className: 'dsh-forge-workbench-projects' }, [
      toolbar,
      environmentHint,
      createElement('div', { key: 'assets', className: 'dsh-forge-workbench-assets' }, [
        createElement('h3', { key: 'title', className: 'dsh-forge-workbench-empty-title' }, '全局素材'),
        createElement('p', { key: 'copy', className: 'dsh-forge-workbench-empty-body' }, PROJECTS_ASSETS_COPY),
      ]),
    ])
  }

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
              createElement('span', { key: 'dot', className: 'dsh-forge-workbench-card-dot', 'aria-hidden': 'true' }, '·'),
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
          cardChildren.push(
            createElement('div', { key: 'actions', className: 'dsh-forge-workbench-card-actions' }, [
              createElement(
                'button',
                {
                  key: 'rename',
                  type: 'button',
                  className: 'dsh-forge-workbench-action',
                  'aria-label': `重命名 ${board.name}`,
                  onClick: () => {
                    setRenaming(board.id)
                    setRenameValue(board.name)
                    setConfirming(undefined)
                  },
                },
                '重命名',
              ),
              createElement(
                'button',
                {
                  key: 'delete',
                  type: 'button',
                  className: 'dsh-forge-workbench-action is-danger',
                  'aria-label': `删除 ${board.name}`,
                  onClick: () => setConfirming(confirmingThis ? undefined : board.id),
                },
                '删除',
              ),
            ]),
          )
        }
        if (confirmingThis) {
          // §5.4: the confirmation names what is about to go. The two-option
          // split (keep the files / delete them too) is U07's `deleteFile` line;
          // today every delete keeps the files, and the copy says so.
          cardChildren.push(
            createElement('div', { key: 'confirm', className: 'dsh-forge-workbench-confirm', role: 'group' }, [
              createElement(
                'p',
                { key: 'copy', className: 'dsh-forge-workbench-confirm-copy' },
                board.itemCount === 0
                  ? `删除「${board.name}」？此操作不可撤销。`
                  : `删除「${board.name}」？它的 ${String(board.itemCount)} 个节点会一起消失，图片文件仍留在素材库。`,
              ),
              createElement('div', { key: 'actions', className: 'dsh-forge-workbench-confirm-actions' }, [
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
                  '确认删除',
                ),
                createElement(
                  'button',
                  {
                    key: 'cancel',
                    type: 'button',
                    className: 'dsh-forge-workbench-action',
                    onClick: () => setConfirming(undefined),
                  },
                  '取消',
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

  return createElement('div', { className: 'dsh-forge-workbench-projects' }, [
    toolbar,
    environmentHint,
    refusal,
    body,
  ])
}
