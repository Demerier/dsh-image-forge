/**
 * U08 — the global asset library: the projects tab's second view (§9.2).
 *
 * ## Why it is a sub-view and not a tab
 *
 * `../docs/usage-reference.md` §9.2 (Q7) decides this: the library is "the console
 * beside the projects", so it lives *inside* the `projects` tab as a second
 * view. A tab of its own would put a second non-project entry on the strip and
 * make "which tab am I in" read worse than "which view".
 *
 * ## Two scopes, one component
 *
 * The same pane serves both halves of §9.2:
 *
 * - **the global library** — every project's pictures, no `board` parameter;
 * - **one project's pictures** — the scope switch narrows the same list.
 *
 * Filtering is **local** (§9.4: the contract does not change): the shell reads
 * the library once through `/studio/assets` without a `board` query and this
 * pane filters and sorts in memory, so typing in the search box costs nothing
 * and a scope switch cannot race a request. `assetFilter` / `assetSort` are
 * pure for exactly that reason — they are what the tests pin.
 *
 * ## Presentational, like `./workbench-projects.ts`
 *
 * The pane owns the transient UI state only it cares about (the search text, the
 * scope, the sort, which card is choosing a destination, which one is asking
 * "really delete?"). Every mutation is a callback the shell owns, because the
 * shell is what has the network and the tab state.
 *
 * ## The cross-tab action
 *
 * 在画布中打开 needs a **destination board**, and the library lives in a tab
 * that is not a canvas. {@link canvasTargetBoard} resolves that from the tab
 * state: the active canvas tab when one is active, otherwise the canvas tab the
 * user looked at last (still open). No open canvas tab at all → the action is
 * `disabled` with the reason spelled out, never a button that silently does
 * nothing (§9.2's "先打开一个项目").
 *
 * @module workbench-assets
 */
import { createElement, useMemo, useState, type ReactNode } from 'react'
import { formatBytes, studioFileUrl, type BoardSummary, type StudioAsset } from './studio-shared.ts'
// U07's time text is reused, not reimplemented: one `3 分钟前` phrase in the
// product, one function that produces it (`./workbench-projects.ts`).
import { relativeTime } from './workbench-projects.ts'
import type { TabDescriptor, TabKey } from './workbench-tabs.ts'

/** Thumbnail width asked of the file route: the contact-sheet cell (§5.2). */
export const ASSET_THUMB_WIDTH = 256

/**
 * How many assets one read asks for.
 *
 * The route's own cap (`src/boards.ts` `listAssets` clamps `limit` to 1..500),
 * asked for explicitly so the client never silently shows the default page of
 * 200 and calls it "the whole library". Filtering then happens in memory.
 */
export const ASSET_PAGE_LIMIT = 500

/**
 * Sort orders the toolbar offers.
 *
 * `recent` is the default because "where is that picture I just made" is the
 * question a library answers (§9.1); `largest` answers "what is eating my disk";
 * `name` is the only one that stays put while you scan.
 */
export const ASSET_SORTS = ['recent', 'largest', 'name'] as const

/** One of {@link ASSET_SORTS}. */
export type AssetSort = (typeof ASSET_SORTS)[number]

/** How each sort reads in the picker. */
export const ASSET_SORT_LABELS: Readonly<Record<AssetSort, string>> = {
  recent: '最新',
  largest: '最大',
  name: '名称',
}

/**
 * The scope value that means "every project".
 *
 * Board ids are minted as `b<base36><4 hex>` (`src/boards.ts` `newBoardId`), so
 * a sentinel word can never collide with one; the tests pin that shape because
 * a collision would silently hide a project instead of failing loudly.
 */
export const ASSET_SCOPE_ALL = 'all'

/** 在画布中打开 is refused, with this reason, when no canvas tab is open. */
export const ASSET_NEEDS_PROJECT_COPY = '先打开一个项目，才能把素材放进它的画布。'

/** §11.4: the global library's empty state. */
export const ASSETS_EMPTY_TITLE = '还没有素材'
export const ASSETS_EMPTY_BODY = '所有项目产出的图都会出现在这里。'
export const ASSETS_EMPTY_ACTION = '新建项目'
/** One project's pictures, when that project has none. */
export const ASSETS_BOARD_EMPTY_COPY = '这个项目还没有素材。生成一张，或把图片拖进它的画布。'
/** A search or scope that matched nothing. */
export const ASSETS_NO_MATCH_COPY = '没有匹配的素材。'
/** First read, before anything is known. */
export const ASSETS_LOADING_COPY = '正在读取素材…'

/** Card actions (§9.3). One label per verb, kept here so tests name them once. */
export const ASSET_OPEN_LABEL = '在画布中打开'
/** One button, two verbs: the panel it opens has 复制 and 移动, and says which is which. */
export const ASSET_TRANSFER_LABEL = '复制 / 移动…'
export const ASSET_DELETE_LABEL = '删除文件'
/** Stand-in for a target board whose name the shell has not resolved. */
export const ASSET_OPEN_TARGET_UNNAMED = '当前项目'
export const ASSET_COPY_LABEL = '复制一份'
export const ASSET_MOVE_LABEL = '移动到那里'
export const ASSET_CANCEL_LABEL = '取消'
export const ASSET_RELOAD_LABEL = '刷新'
export const ASSET_BACK_LABEL = '返回项目'

/* -------------------------------------------------------------------------- */
/* Pure helpers (asserted directly by the tests)                              */
/* -------------------------------------------------------------------------- */

/** What the search box and the scope switch ask for. */
export interface AssetFilterOptions {
  /** Free text; matched against prompt, file name and project name (§9.1). */
  readonly query: string
  /** {@link ASSET_SCOPE_ALL}, or one board id. */
  readonly scope: string
}

/**
 * The title a card shows: the prompt's first line, or the file name.
 *
 * The same rule the asset page uses (`describeAsset` in `src/studio-view.ts`)
 * and the one §8.2 gives the task tab: the prompt *is* the picture's name until
 * the user renames it, and an imported file has no prompt at all.
 *
 * @param asset - one library entry.
 * @returns one line, never empty (falls back to the id).
 */
export function assetTitle(asset: Pick<StudioAsset, 'prompt' | 'path' | 'id'>): string {
  const line = asset.prompt.split('\n').map((part) => part.trim()).find((part) => part.length > 0)
  if (line !== undefined) return line
  const name = asset.path.split(/[\\/]/).pop() ?? ''
  return name.length > 0 ? name : asset.id
}

/** The thumbnail URL for one asset: the markdown path, else the raw path. */
export function assetThumbUrl(asset: Pick<StudioAsset, 'markdownPath' | 'path'>): string {
  const path = asset.markdownPath.length > 0 ? asset.markdownPath : asset.path
  return studioFileUrl(path, ASSET_THUMB_WIDTH)
}

/**
 * The size text, through `formatBytes` so the library and the project card
 * cannot disagree about how `86 MB` is spelled.
 *
 * @param asset - one library entry.
 * @returns e.g. `1.2 MB`; `0 B` for an entry the host stored without a size.
 */
export function assetSizeLabel(asset: Pick<StudioAsset, 'bytes'>): string {
  return formatBytes(asset.bytes)
}

/**
 * The time text, through `relativeTime` (U07's phrases).
 *
 * @param asset - one library entry.
 * @param now - the clock, injected so a phrase can be asserted exactly.
 * @returns `刚刚` / `3 分钟前` / `2026-11-01`, or `''` when unparsable.
 */
export function assetTimeLabel(asset: Pick<StudioAsset, 'createdAt'>, now: number = Date.now()): string {
  return relativeTime(asset.createdAt, now)
}

/**
 * `1024×1024`, or `''` when the host stored no geometry.
 *
 * A task or layout entry has zeroes in those fields; the route already filters
 * to pictures, but an older payload must not print `0×0` on a card.
 */
export function assetDimensions(asset: Pick<StudioAsset, 'width' | 'height'>): string {
  const ok = (value: number): boolean => Number.isFinite(value) && value > 0
  return ok(asset.width) && ok(asset.height) ? `${String(asset.width)}×${String(asset.height)}` : ''
}

/**
 * Filter the library in memory: scope first, then free text.
 *
 * The needle is matched against the same three fields the server's `q=` uses
 * (prompt, path, project name, `src/boards.ts` `listAssets`), so a search that
 * behaves one way in the library cannot behave another way in a reload.
 *
 * @param assets - the library as last read.
 * @param options - the search text and the scope.
 * @returns matching assets, in the order they came in (sorting is separate).
 */
export function assetFilter(assets: readonly StudioAsset[], options: AssetFilterOptions): StudioAsset[] {
  const scope = options.scope
  const scoped = scope === ASSET_SCOPE_ALL ? [...assets] : assets.filter((asset) => asset.boardId === scope)
  const needle = options.query.trim().toLowerCase()
  if (needle.length === 0) return scoped
  return scoped.filter((asset) => {
    const haystack = `${asset.prompt}\n${asset.path}\n${asset.boardName}`.toLowerCase()
    return haystack.includes(needle)
  })
}

/**
 * Sort a copy of the list, so a caller's array is never reordered in place.
 *
 * Ties fall back to newest-first in every mode: two pictures of the same size or
 * with the same prompt still have an order, and "whatever the server sent" is
 * not one a reader can predict.
 *
 * @param assets - the assets to order.
 * @param sort - one of {@link ASSET_SORTS}.
 * @returns a new, ordered array.
 */
export function assetSort(assets: readonly StudioAsset[], sort: AssetSort): StudioAsset[] {
  const copy = [...assets]
  const newestFirst = (left: StudioAsset, right: StudioAsset): number =>
    right.createdAt.localeCompare(left.createdAt)
  if (sort === 'name') {
    return copy.sort((left, right) => {
      const byName = assetTitle(left).localeCompare(assetTitle(right), 'zh-Hans-CN')
      return byName !== 0 ? byName : newestFirst(left, right)
    })
  }
  if (sort === 'largest') {
    return copy.sort((left, right) => {
      const bySize = (right.bytes ?? 0) - (left.bytes ?? 0)
      return bySize !== 0 ? bySize : newestFirst(left, right)
    })
  }
  return copy.sort(newestFirst)
}

/**
 * Which board 在画布中打开 should put the asset on (§9.2's cross-tab rule).
 *
 * Three cases, in order:
 *
 * 1. a canvas tab is active → that board (the ordinary case: the user is
 *    looking at a canvas and the library is one click away);
 * 2. the user is on the projects tab but a canvas tab is still open → the one
 *    they looked at last (`remembered`), because "in the canvas" has to mean
 *    something while the library itself is not on a canvas;
 * 3. no canvas tab at all → `undefined`, which is what makes the button
 *    `disabled` and the hint visible.
 *
 * `remembered` must still be **open**: a board whose tab was closed while the
 * library was in front of the user is not a destination any more.
 *
 * @param tabs - the current strip.
 * @param activeKey - the active tab's key.
 * @param remembered - the last canvas tab this shell activated, if any.
 * @returns the destination board id, or `undefined` when there is none.
 */
export function canvasTargetBoard(
  tabs: readonly TabDescriptor[],
  activeKey: TabKey,
  remembered?: string,
): string | undefined {
  const active = tabs.find((tab) => tab.key === activeKey)
  if (active !== undefined && active.kind === 'canvas' && typeof active.boardId === 'string') return active.boardId
  if (remembered === undefined || remembered.length === 0) return undefined
  const open = tabs.some((tab) => tab.kind === 'canvas' && tab.boardId === remembered)
  return open ? remembered : undefined
}

/**
 * The sentence above the grid while there is no canvas to open onto.
 *
 * @param boards - the library, for naming the project the asset would need.
 * @returns one line of instructions, never empty.
 */
export function assetsScopeHint(activeBoardName?: string): string {
  return activeBoardName === undefined || activeBoardName.length === 0
    ? ASSET_NEEDS_PROJECT_COPY
    : `在画布中打开 = 把选中的图放进「${activeBoardName}」的画布。`
}

/** What one card's 复制到…/移动到… does. */
export type AssetTransferMode = 'copy' | 'move'

/* -------------------------------------------------------------------------- */
/* The pane                                                                   */
/* -------------------------------------------------------------------------- */

/** Props of {@link AssetsPane}; every mutation is a callback, not a fetch. */
export interface AssetsPaneProps {
  /** Every asset the shell last read (already newest-first from the route). */
  readonly assets: readonly StudioAsset[]
  /** The library, for the scope picker and the transfer destinations. */
  readonly boards: readonly BoardSummary[]
  /** True until the first asset read finished. */
  readonly loading?: boolean
  /** A refusal from the last read or mutation, shown above the grid. */
  readonly error?: string
  /** The board 在画布中打开 would target; absent disables that action. */
  readonly activeBoardId?: string
  /** That board's name, for the hint line. */
  readonly activeBoardName?: string
  /** Re-read the library (`刷新`). */
  readonly onReload?: () => unknown
  /** Put this asset on the active canvas tab's board (§9.3). */
  readonly onOpenInCanvas?: (asset: StudioAsset) => unknown
  /** Copy or move this asset onto another board (`copy-item` / `move-item`). */
  readonly onTransfer?: (asset: StudioAsset, toBoard: string, mode: AssetTransferMode) => unknown
  /** The pane has already asked: remove the entry and unlink its file. */
  readonly onDelete?: (asset: StudioAsset) => unknown
  /** Leave the library and show the project grid again. */
  readonly onBack?: () => void
  /** The empty state's primary action (§11.4). */
  readonly onCreateProject?: () => unknown
}

/** One card's cover: the 256-px thumbnail, never the original. */
function Cover(props: { asset: StudioAsset; title: string }): ReactNode {
  return createElement('span', { className: 'dsh-forge-workbench-asset-cover' }, [
    createElement('img', {
      key: 'img',
      src: assetThumbUrl(props.asset),
      alt: props.title,
      loading: 'lazy',
    }),
  ])
}

/**
 * The global asset library.
 *
 * @param props - the library plus the callbacks the shell owns.
 * @returns the toolbar, the card grid (or one of the three states), and the
 *   per-card destination / delete panels.
 */
export function AssetsPane(props: AssetsPaneProps): ReturnType<typeof createElement> {
  const {
    assets,
    boards,
    loading,
    error,
    activeBoardId,
    activeBoardName,
    onReload,
    onOpenInCanvas,
    onTransfer,
    onDelete,
    onBack,
    onCreateProject,
  } = props
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<string>(ASSET_SCOPE_ALL)
  const [sort, setSort] = useState<AssetSort>('recent')
  const [transferring, setTransferring] = useState<string | undefined>(undefined)
  const [destination, setDestination] = useState('')
  const [confirming, setConfirming] = useState<string | undefined>(undefined)

  const visible = useMemo(
    () => assetSort(assetFilter(assets, { query, scope }), sort),
    [assets, query, scope, sort],
  )
  const now = Date.now()
  const canOpen = activeBoardId !== undefined && activeBoardId.length > 0
  const targetName = canOpen
    ? activeBoardName === undefined || activeBoardName.length === 0
      ? ASSET_OPEN_TARGET_UNNAMED
      : activeBoardName
    : undefined

  const toolbar = createElement('div', { key: 'toolbar', className: 'dsh-forge-workbench-toolbar' }, [
    createElement('input', {
      key: 'search',
      type: 'search',
      className: 'dsh-forge-workbench-input dsh-forge-workbench-search',
      placeholder: '搜提示词、文件名或项目名',
      'aria-label': '搜索素材',
      value: query,
      onChange: (event: { target: { value: string } }) => setQuery(event.target.value),
    }),
    createElement(
      'select',
      {
        key: 'scope',
        className: 'dsh-forge-workbench-select',
        'aria-label': '素材范围',
        value: scope,
        onChange: (event: { target: { value: string } }) => {
          setScope(event.target.value)
          setTransferring(undefined)
        },
      },
      [
        createElement('option', { key: ASSET_SCOPE_ALL, value: ASSET_SCOPE_ALL }, '全部项目'),
        ...boards.map((board) => createElement('option', { key: board.id, value: board.id }, board.name)),
      ],
    ),
    createElement(
      'select',
      {
        key: 'sort',
        className: 'dsh-forge-workbench-select',
        'aria-label': '素材排序',
        value: sort,
        onChange: (event: { target: { value: string } }) => {
          setSort(event.target.value === 'largest' ? 'largest' : event.target.value === 'name' ? 'name' : 'recent')
        },
      },
      ASSET_SORTS.map((choice) => createElement('option', { key: choice, value: choice }, ASSET_SORT_LABELS[choice])),
    ),
    createElement(
      'span',
      { key: 'count', className: 'dsh-forge-workbench-assets-count' },
      `${String(visible.length)} / ${String(assets.length)} 张`,
    ),
    onReload === undefined
      ? null
      : createElement(
          'button',
          {
            key: 'reload',
            type: 'button',
            className: 'dsh-forge-workbench-action',
            onClick: () => {
              void onReload()
            },
          },
          ASSET_RELOAD_LABEL,
        ),
    onBack === undefined
      ? null
      : createElement(
          'button',
          {
            key: 'back',
            type: 'button',
            className: 'dsh-forge-workbench-action dsh-forge-workbench-assets-back',
            onClick: () => {
              onBack()
            },
          },
          ASSET_BACK_LABEL,
        ),
  ])

  // The hint is a statement about the current target, not a warning: it is read
  // by a screen reader as a status, and it is always the same sentence whether or
  // not the action is available.
  const hint = createElement(
    'p',
    {
      key: 'hint',
      className: canOpen ? 'dsh-forge-workbench-asset-hint' : 'dsh-forge-workbench-asset-hint is-blocked',
      role: 'status',
    },
    assetsScopeHint(targetName),
  )

  const refusal =
    error === undefined || error.length === 0
      ? null
      : createElement('div', { key: 'error', className: 'dsh-forge-workbench-error', role: 'alert' }, error)

  let body: ReactNode
  if (visible.length > 0) {
    body = createElement(
      'div',
      { key: 'grid', className: 'dsh-forge-workbench-assets-grid' },
      visible.map((asset) => {
        const title = assetTitle(asset)
        // Destinations: every project except the one the picture already lives
        // in. Copying onto its own board is the canvas's own "duplicate", and
        // moving onto it is a reposition — neither is what this panel promises.
        const destinations = boards.filter((board) => board.id !== asset.boardId)
        const transferOpen = transferring === asset.id
        const confirmingThis = confirming === asset.id
        const dimensions = assetDimensions(asset)
        const size = assetSizeLabel(asset)
        const children: ReactNode[] = [
          createElement('div', { key: 'head', className: 'dsh-forge-workbench-asset-head' }, [
            createElement(Cover, { key: 'cover', asset, title }),
            createElement('span', { key: 'title', className: 'dsh-forge-workbench-asset-title' }, title),
            createElement('span', { key: 'meta', className: 'dsh-forge-workbench-asset-meta' }, [
              createElement('span', { key: 'board', className: 'dsh-forge-workbench-asset-board' }, asset.boardName),
              createElement('span', { key: 'dot1', className: 'dsh-forge-workbench-card-dot', 'aria-hidden': 'true' }, '·'),
              createElement('span', { key: 'size', className: 'dsh-forge-workbench-asset-size' }, size),
              dimensions.length === 0
                ? null
                : createElement('span', { key: 'dim', className: 'dsh-forge-workbench-asset-dim' }, [
                    createElement('span', { key: 'dot2', className: 'dsh-forge-workbench-card-dot', 'aria-hidden': 'true' }, '·'),
                    dimensions,
                  ]),
              createElement('span', { key: 'dot3', className: 'dsh-forge-workbench-card-dot', 'aria-hidden': 'true' }, '·'),
              createElement('span', { key: 'time', className: 'dsh-forge-workbench-asset-time' }, assetTimeLabel(asset, now)),
            ]),
          ]),
          createElement('div', { key: 'actions', className: 'dsh-forge-workbench-asset-actions' }, [
            createElement(
              'button',
              {
                key: 'open',
                type: 'button',
                className: 'dsh-forge-workbench-action',
                // §9.2: disabled with a reason rather than a button that does
                // nothing; the hint above the grid says the same thing once.
                disabled: !canOpen || onOpenInCanvas === undefined,
                title: canOpen ? `放进「${String(targetName)}」的画布` : ASSET_NEEDS_PROJECT_COPY,
                'aria-label': `${ASSET_OPEN_LABEL} ${title}`,
                onClick: () => {
                  if (!canOpen || onOpenInCanvas === undefined) return
                  setTransferring(undefined)
                  setConfirming(undefined)
                  void onOpenInCanvas(asset)
                },
              },
              ASSET_OPEN_LABEL,
            ),
            onTransfer === undefined
              ? null
              : createElement(
                  'button',
                  {
                    key: 'transfer',
                    type: 'button',
                    className: 'dsh-forge-workbench-action',
                    'aria-pressed': transferOpen,
                    disabled: destinations.length === 0,
                    title: destinations.length === 0 ? '没有别的项目可以放' : '复制或移动到另一个项目',
                    'aria-label': `${ASSET_TRANSFER_LABEL} ${title}`,
                    onClick: () => {
                      setConfirming(undefined)
                      setTransferring(transferOpen ? undefined : asset.id)
                      setDestination(destinations[0]?.id ?? '')
                    },
                  },
                  ASSET_TRANSFER_LABEL,
                ),
            onDelete === undefined
              ? null
              : createElement(
                  'button',
                  {
                    key: 'delete',
                    type: 'button',
                    className: 'dsh-forge-workbench-action is-danger',
                    'aria-label': `${ASSET_DELETE_LABEL} ${title}`,
                    onClick: () => {
                      setTransferring(undefined)
                      setConfirming(confirmingThis ? undefined : asset.id)
                    },
                  },
                  ASSET_DELETE_LABEL,
                ),
          ]),
        ]
        if (transferOpen) {
          const chosen = destinations.some((board) => board.id === destination) ? destination : (destinations[0]?.id ?? '')
          children.push(
            createElement('div', { key: 'transfer-panel', className: 'dsh-forge-workbench-asset-transfer', role: 'group' }, [
              createElement(
                'p',
                { key: 'copy', className: 'dsh-forge-workbench-asset-transfer-copy' },
                '复制 = 两个项目共用这张图；移动 = 它离开现在这个项目。',
              ),
              createElement(
                'select',
                {
                  key: 'target',
                  className: 'dsh-forge-workbench-select',
                  'aria-label': '目标项目',
                  value: chosen,
                  onChange: (event: { target: { value: string } }) => setDestination(event.target.value),
                },
                destinations.map((board) => createElement('option', { key: board.id, value: board.id }, board.name)),
              ),
              createElement('div', { key: 'buttons', className: 'dsh-forge-workbench-confirm-actions' }, [
                createElement(
                  'button',
                  {
                    key: 'copy',
                    type: 'button',
                    className: 'dsh-forge-workbench-action',
                    disabled: chosen.length === 0,
                    'aria-label': `${ASSET_COPY_LABEL} ${title}`,
                    onClick: () => {
                      if (chosen.length === 0) return
                      setTransferring(undefined)
                      void onTransfer?.(asset, chosen, 'copy')
                    },
                  },
                  '复制',
                ),
                createElement(
                  'button',
                  {
                    key: 'move',
                    type: 'button',
                    className: 'dsh-forge-workbench-action',
                    disabled: chosen.length === 0,
                    'aria-label': `${ASSET_MOVE_LABEL} ${title}`,
                    onClick: () => {
                      if (chosen.length === 0) return
                      setTransferring(undefined)
                      void onTransfer?.(asset, chosen, 'move')
                    },
                  },
                  '移动',
                ),
                createElement(
                  'button',
                  {
                    key: 'cancel',
                    type: 'button',
                    className: 'dsh-forge-workbench-action',
                    onClick: () => setTransferring(undefined),
                  },
                  ASSET_CANCEL_LABEL,
                ),
              ]),
            ]),
          )
        }
        if (confirmingThis) {
          // Deleting a file is the highest-risk action in this pane, so it is a
          // second, labelled click — never a hover menu — and the sentence says
          // both what goes and that a file another project shares stays put
          // (`removeItem`'s guard, `src/boards.ts`).
          children.push(
            createElement('div', { key: 'confirm', className: 'dsh-forge-workbench-asset-confirm', role: 'group' }, [
              createElement(
                'p',
                { key: 'copy', className: 'dsh-forge-workbench-confirm-copy' },
                `从「${asset.boardName}」移除这张图，并删除磁盘文件的 ${size}？此操作不可撤销。`,
              ),
              createElement(
                'p',
                { key: 'warn', className: 'dsh-forge-workbench-confirm-warn' },
                '别的项目也用了这张图时，文件会保留，只从本项目移除。',
              ),
              createElement('div', { key: 'buttons', className: 'dsh-forge-workbench-confirm-actions' }, [
                createElement(
                  'button',
                  {
                    key: 'confirm',
                    type: 'button',
                    className: 'dsh-forge-workbench-action is-danger',
                    'aria-label': `确认删除文件 ${title}`,
                    onClick: () => {
                      setConfirming(undefined)
                      void onDelete?.(asset)
                    },
                  },
                  '删除文件和条目',
                ),
                createElement(
                  'button',
                  {
                    key: 'cancel',
                    type: 'button',
                    className: 'dsh-forge-workbench-action',
                    onClick: () => setConfirming(undefined),
                  },
                  ASSET_CANCEL_LABEL,
                ),
              ]),
            ]),
          )
        }
        return createElement(
          'article',
          {
            key: `${asset.boardId}:${asset.id}`,
            className: 'dsh-forge-workbench-asset',
            'data-asset-id': asset.id,
            'data-asset-board': asset.boardId,
            title: `${title}\n${asset.markdownPath}`,
          },
          children,
        )
      }),
    )
  } else if (assets.length === 0 && loading === true) {
    body = createElement('p', { key: 'loading', className: 'dsh-forge-workbench-empty-note' }, ASSETS_LOADING_COPY)
  } else if (assets.length === 0 && scope !== ASSET_SCOPE_ALL) {
    body = createElement('p', { key: 'board-empty', className: 'dsh-forge-workbench-empty-note' }, ASSETS_BOARD_EMPTY_COPY)
  } else if (assets.length === 0) {
    body = createElement('div', { key: 'empty', className: 'dsh-forge-workbench-empty' }, [
      createElement('h3', { key: 'title', className: 'dsh-forge-workbench-empty-title' }, ASSETS_EMPTY_TITLE),
      createElement('p', { key: 'copy', className: 'dsh-forge-workbench-empty-body' }, ASSETS_EMPTY_BODY),
      onCreateProject === undefined
        ? null
        : createElement(
            'button',
            {
              key: 'action',
              type: 'button',
              className: 'dsh-forge-workbench-primary',
              onClick: () => {
                void onCreateProject()
              },
            },
            ASSETS_EMPTY_ACTION,
          ),
    ])
  } else {
    body = createElement('p', { key: 'nomatch', className: 'dsh-forge-workbench-empty-note' }, ASSETS_NO_MATCH_COPY)
  }

  return createElement('div', { className: 'dsh-forge-workbench-assets' }, [toolbar, hint, refusal, body])
}
