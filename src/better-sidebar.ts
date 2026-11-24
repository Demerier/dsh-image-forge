/** Optional DSH Better Sidebar tab: annotations and MOSS layout editing. */
import { createElement, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  IMAGE_EDITOR_TAB_TITLE,
  IMAGE_EDITOR_TAB_TYPE,
  conversationImageHandoffCapability,
  imageEditorDedupeKey,
  imageEditorTabInstanceId,
  layoutAncestorOf,
  readImageEditorTabMeta,
  type BetterSidebarServiceLike,
  type BetterSidebarTabLike,
  type ImageEditorTabMeta,
} from './better-sidebar-model.ts'
import {
  annotationPointFromClient,
  annotationClipboardPrompt,
  clampAnnotationCoordinate,
  editAnnotationText,
  moveAnnotation,
  renumberAnnotations,
  type AnnotationDraft,
} from './image-annotation.ts'
import {
  buildAnnotatedPreview,
  composerHandoffGate,
  sendAnnotatedEdit,
  sendLayoutGeneration,
  type ConversationHandoffLike,
  type SessionInputLike,
} from './better-sidebar-handoff.ts'
import {
  STUDIO_BOARD_ROUTE,
  notifyStudioBoardChange,
  studioFileUrl,
  type BoardDetail,
  type BoardItem,
  type BoardLayoutDraft,
} from './studio-shared.ts'
import {
  LAYOUT_CANVAS_LABEL_TEXT,
  LAYOUT_CANVAS_PRESETS,
  LAYOUT_CANVAS_VALUES,
  LAYOUT_ITEM_LABEL_TEXT,
  LAYOUT_ITEM_LABELS,
  LAYOUT_TEMPLATES,
  addBox,
  compileLayout,
  deleteBox,
  draftToEditorState,
  layoutRatioLabel,
  mountLayoutEditor,
  selectBox,
  setBoxCaption,
  setBoxLabel,
  setBoxName,
  setCanvasSize,
  setSummary,
  stateToDraft,
  updateBox,
  type LayoutCanvasValue,
  type LayoutDraft,
  type LayoutEditorHandle,
  type LayoutEditorState,
  type LayoutItemLabel,
} from './layout-editor.ts'

/** Root context surface this module touches; optional so other hosts stay safe. */
export interface BetterSidebarContextLike {
  get?(name: string): unknown
  effect?(fn: () => () => void): unknown
  sessions?: { scope(sessionId: string): unknown }
}

/** Runtime props supplied by Better Sidebar. */
interface ImageEditorTabProps {
  readonly ctx: BetterSidebarContextLike
  readonly scope: { readonly sessionId: string }
  readonly tab: { readonly meta?: unknown }
  readonly visible?: boolean
}

/** Register the tab when Better Sidebar is present; otherwise do nothing. */
export function registerBetterSidebarTab(ctx: BetterSidebarContextLike): void {
  const service = ctx.get?.('betterSidebar') as BetterSidebarServiceLike | undefined
  if (service === undefined || typeof service.registerTab !== 'function') return
  const descriptor: BetterSidebarTabLike = {
    id: IMAGE_EDITOR_TAB_TYPE,
    title: IMAGE_EDITOR_TAB_TITLE,
    description: '气泡标注、MOSS 布局与按标注继续生成',
    order: 48,
    icon: () => createElement('span', { className: 'dsh-image-forge-sidebar-icon', 'aria-hidden': 'true' }, 'F'),
    dedupeKey: (tab) => {
      const meta = readImageEditorTabMeta(tab.meta)
      return meta === undefined ? undefined : imageEditorDedupeKey(meta)
    },
    component: (props) => createElement(ImageEditorTab, props as unknown as ImageEditorTabProps),
  }
  const register = (): (() => void) => service.registerTab(descriptor)
  if (typeof ctx.effect === 'function') ctx.effect(register)
  else register()
}

/** Open (or focus) the editor tab for one result image. */
export function openImageEditorTab(
  ctx: BetterSidebarContextLike,
  sessionId: string | undefined,
  meta: ImageEditorTabMeta,
): boolean {
  const service = ctx.get?.('betterSidebar') as BetterSidebarServiceLike | undefined
  if (service === undefined || typeof service.openTab !== 'function') return false
  const scope = sessionId === undefined ? undefined : ctx.sessions?.scope(sessionId)
  service.openTab({
    type: IMAGE_EDITOR_TAB_TYPE,
    id: imageEditorTabInstanceId(meta),
    title: `${IMAGE_EDITOR_TAB_TITLE} · ${meta.title}`,
    meta,
    target: 'right',
  }, scope)
  return true
}

/** Defensive response reader. */
async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = await response.json()
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Read one board detail. */
async function readBoard(boardId: string): Promise<BoardDetail> {
  const response = await fetch(`${STUDIO_BOARD_ROUTE}?board=${encodeURIComponent(boardId)}`, { credentials: 'same-origin' })
  const payload = await readJson(response)
  if (!response.ok || payload === undefined) throw new Error(`读取画板失败（HTTP ${String(response.status)}）`)
  return payload as unknown as BoardDetail
}

/** Persist one layout node through the existing board action. */
async function saveLayoutNode(boardId: string, item: BoardItem, draft: BoardLayoutDraft): Promise<void> {
  const response = await fetch(STUDIO_BOARD_ROUTE, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'save-layout-node',
      board: boardId,
      item: item.id,
      draft,
      w: item.w,
      h: item.h,
      references: item.references ?? [],
      parents: item.parents,
      layoutMode: item.layoutMode ?? 'layout',
    }),
  })
  const payload = await readJson(response)
  if (!response.ok) throw new Error(typeof payload?.['error'] === 'string' ? payload['error'] : `保存布局失败（HTTP ${String(response.status)}）`)
  notifyStudioBoardChange(boardId, 'sidebar')
}

/** Mount the shared editor and mirror external draft swaps into it. */
function LayoutEditorPanel(props: {
  readonly draft: BoardLayoutDraft
  readonly theme?: 'auto' | 'light' | 'dark'
  readonly onChange: (draft: BoardLayoutDraft) => void
  readonly onEditor?: (editor: LayoutEditorHandle | undefined) => void
  readonly onBoxActivate?: (id: string, anchor?: { readonly clientX: number; readonly clientY: number }) => void
}): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<LayoutEditorHandle | undefined>(undefined)
  const appliedRef = useRef<BoardLayoutDraft>(props.draft)
  const latestRef = useRef(props)
  latestRef.current = props
  const [error, setError] = useState<string | undefined>(undefined)
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return undefined
    let editor: LayoutEditorHandle | undefined
    appliedRef.current = latestRef.current.draft
    try {
      editor = mountLayoutEditor(host, {
        draft: latestRef.current.draft as unknown as LayoutDraft,
        canvasOnly: true,
        theme: latestRef.current.theme ?? 'auto',
        onChange: (state: LayoutEditorState) => {
          const next = stateToDraft(state) as unknown as BoardLayoutDraft
          appliedRef.current = next
          latestRef.current.onChange(next)
        },
        onBoxActivate: (id, anchor) => { latestRef.current.onBoxActivate?.(id, anchor) },
      })
      editorRef.current = editor
      latestRef.current.onEditor?.(editor)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    return () => {
      editorRef.current = undefined
      latestRef.current.onEditor?.(undefined)
      try { editor?.destroy() } catch { /* teardown must stay local */ }
    }
  }, [])
  useEffect(() => {
    const editor = editorRef.current
    if (editor === undefined || appliedRef.current === props.draft) return
    appliedRef.current = props.draft
    try { editor.setState(draftToEditorState(props.draft as unknown as LayoutDraft)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }, [props.draft])
  return error === undefined
    ? createElement('div', { ref: hostRef, className: 'dsh-image-forge-sidebar-layout-host' })
    : createElement('p', { className: 'dsh-image-forge-sidebar-error', role: 'alert' }, error)
}

function sidebarListValue(text: string): string[] {
  return text.split(/[,，\n]/u).map((entry) => entry.trim()).filter((entry) => entry.length > 0)
}

/** The Better Sidebar adaptation of the layout detail page. */
function SidebarLayoutWorkbench(props: {
  readonly draft: BoardLayoutDraft
  readonly theme?: 'auto' | 'light' | 'dark'
  readonly saving: boolean
  readonly busy: boolean
  readonly gateReady: boolean
  readonly gateReason: string
  readonly status?: string
  readonly error?: string
  readonly onDraftChange: (draft: BoardLayoutDraft) => void
  readonly onSave: (draft: BoardLayoutDraft) => Promise<void>
  readonly onGenerate: (draft: BoardLayoutDraft) => Promise<void>
}): ReactNode {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<LayoutEditorHandle | undefined>(undefined)
  const dragRef = useRef<{ readonly startX: number; readonly startY: number; readonly originX: number; readonly originY: number } | undefined>(undefined)
  const [selectedBoxId, setSelectedBoxId] = useState<string | null>(null)
  const [boxOpen, setBoxOpen] = useState(false)
  const [boxPosition, setBoxPosition] = useState({ x: 18, y: 54 })
  const boxes = useMemo(() => {
    try { return draftToEditorState(props.draft as unknown as LayoutDraft).items }
    catch { return [] }
  }, [props.draft])
  const selectedBox = selectedBoxId === null ? undefined : boxes.find((box) => box.id === selectedBoxId)
  const coordinateKeys = [['x1', '左'], ['y1', '上'], ['x2', '右'], ['y2', '下']] as const

  const closeBox = (): void => {
    const editor = editorRef.current
    if (editor !== undefined) editor.setState(selectBox(editor.getState(), null))
    setSelectedBoxId(null)
    setBoxOpen(false)
  }

  const openBox = (id: string, anchor?: { readonly clientX: number; readonly clientY: number }): void => {
    const editor = editorRef.current
    if (editor === undefined) return
    editor.setState(selectBox(editor.getState(), id))
    setSelectedBoxId(id)
    const root = rootRef.current?.getBoundingClientRect()
    if (anchor !== undefined && root !== undefined) {
      setBoxPosition({
        x: Math.max(8, Math.min(anchor.clientX - root.left + 12, root.width - 360)),
        y: Math.max(44, Math.min(anchor.clientY - root.top + 12, root.height - 190)),
      })
    }
    setBoxOpen(true)
  }

  const commit = (mutate: (state: LayoutEditorState) => LayoutEditorState): void => {
    const editor = editorRef.current
    if (editor === undefined) return
    const next = mutate(editor.getState())
    editor.setState(next)
    props.onDraftChange(stateToDraft(next) as unknown as BoardLayoutDraft)
  }

  const patchBox = (patch: { label?: LayoutItemLabel; caption?: string; text?: string; tags?: string[]; palette?: string[]; bbox?: { x1: number; y1: number; x2: number; y2: number } }): void => {
    if (selectedBoxId === null) return
    commit((state) => updateBox(state, selectedBoxId, patch))
  }

  const selectRailBox = (id: string): void => {
    const editor = editorRef.current
    if (editor === undefined) return
    editor.setState(selectBox(editor.getState(), id))
    setSelectedBoxId(id)
  }

  const beginBoxDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const target = event.target as Element | null
    if (target?.closest('button, input, textarea, select') != null) return
    event.preventDefault()
    dragRef.current = { startX: event.clientX, startY: event.clientY, originX: boxPosition.x, originY: boxPosition.y }
    const move = (next: PointerEvent): void => {
      const drag = dragRef.current
      if (drag === undefined) return
      setBoxPosition({
        x: Math.max(8, drag.originX + next.clientX - drag.startX),
        y: Math.max(44, drag.originY + next.clientY - drag.startY),
      })
    }
    const end = (): void => {
      dragRef.current = undefined
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
  }

  useEffect(() => {
    if (!boxOpen) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeBox()
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true) }
  }, [boxOpen])

  const section = (key: string, title: string, children: ReactNode[], collapsed = false): ReactNode => createElement(
    'details',
    { key, className: 'dsh-image-forge-sidebar-layout-section', open: !collapsed },
    createElement('summary', { className: 'dsh-image-forge-sidebar-layout-section-title' }, title),
    ...children,
  )

  const propertyPanel = boxOpen && selectedBox !== undefined
    ? createElement(
      'aside',
      {
        className: 'dsh-image-forge-sidebar-box-float',
        'aria-label': '布局框属性',
        'data-box-editor': selectedBox.id,
        style: { left: `${String(boxPosition.x)}px`, top: `${String(boxPosition.y)}px` },
      },
      createElement(
        'div',
        { key: 'head', className: 'dsh-image-forge-sidebar-box-head', onPointerDown: beginBoxDrag },
        createElement('strong', {}, `框属性 · ${selectedBox.name ?? selectedBox.id}`),
        createElement('button', { type: 'button', className: 'dsh-image-forge-sidebar-box-close', 'aria-label': '关闭框属性', onClick: closeBox }, '×'),
      ),
      createElement(
        'div',
        { key: 'body', className: 'dsh-image-forge-sidebar-box-body' },
        createElement('label', { className: 'dsh-forge-field' },
          createElement('span', { className: 'dsh-forge-label' }, '框名'),
          createElement('input', { value: selectedBox.name ?? '', placeholder: '仅面板显示，不进入模型', onChange: (event: { target: { value: string } }) => { commit((state) => setBoxName(state, selectedBox.id, event.target.value)) } }),
        ),
        createElement('label', { className: 'dsh-forge-field' },
          createElement('span', { className: 'dsh-forge-label' }, '框类型'),
          createElement('select', { value: selectedBox.label, onChange: (event: { target: { value: string } }) => { commit((state) => setBoxLabel(state, selectedBox.id, event.target.value as LayoutItemLabel)) } },
            ...LAYOUT_ITEM_LABELS.map((label) => createElement('option', { key: label, value: label }, LAYOUT_ITEM_LABEL_TEXT[label]))),
        ),
        createElement('label', { className: 'dsh-forge-field' },
          createElement('span', { className: 'dsh-forge-label' }, '画面描述'),
          createElement('textarea', { rows: 3, value: selectedBox.caption, onChange: (event: { target: { value: string } }) => { commit((state) => setBoxCaption(state, selectedBox.id, event.target.value)) } }),
        ),
        createElement('label', { className: 'dsh-forge-field' },
          createElement('span', { className: 'dsh-forge-label' }, '文字内容'),
          createElement('textarea', { rows: 2, value: selectedBox.text ?? '', onChange: (event: { target: { value: string } }) => { patchBox({ text: event.target.value }) } }),
        ),
        createElement('label', { className: 'dsh-forge-field' },
          createElement('span', { className: 'dsh-forge-label' }, '内容标签'),
          createElement('input', { value: selectedBox.tags?.join(', ') ?? '', placeholder: '逗号分隔', onChange: (event: { target: { value: string } }) => { patchBox({ tags: sidebarListValue(event.target.value) }) } }),
        ),
        createElement('label', { className: 'dsh-forge-field' },
          createElement('span', { className: 'dsh-forge-label' }, '配色词'),
          createElement('input', { value: selectedBox.palette?.join(', ') ?? '', placeholder: '逗号分隔', onChange: (event: { target: { value: string } }) => { patchBox({ palette: sidebarListValue(event.target.value) }) } }),
        ),
        createElement('div', { className: 'dsh-image-forge-sidebar-box-coordinates' },
          ...coordinateKeys.map(([key, label]) => createElement('label', { key, className: 'dsh-forge-field' },
            createElement('span', { className: 'dsh-forge-label' }, label),
            createElement('input', {
              type: 'number',
              value: String(selectedBox.bbox[key]),
              onChange: (event: { target: { value: string } }) => {
                const value = Number(event.target.value)
                if (Number.isFinite(value)) patchBox({ bbox: { ...selectedBox.bbox, [key]: Math.round(value) } })
              },
            }),
          )),
        ),
      ),
      createElement('div', { key: 'actions', className: 'dsh-image-forge-sidebar-box-actions' },
        createElement('button', { type: 'button', className: 'dsh-image-forge-sidebar-remove is-danger', onClick: () => { commit((state) => deleteBox(state, selectedBox.id)); closeBox() } }, '删除这个框'),
      ),
    )
    : null

  return createElement('div', { ref: rootRef, className: 'dsh-image-forge-sidebar-layout-workbench' }, [
    createElement('div', { key: 'canvas', className: 'dsh-image-forge-sidebar-layout-canvas' },
      createElement(LayoutEditorPanel, {
        draft: props.draft,
        theme: props.theme ?? 'auto',
        onChange: props.onDraftChange,
        onEditor: (editor) => { editorRef.current = editor },
        onBoxActivate: openBox,
      }),
    ),
    createElement('div', { key: 'rail', className: 'dsh-image-forge-sidebar-layout-rail' }, [
      section('overview', '布局概览', [
        createElement('div', { key: 'facts', className: 'dsh-image-forge-sidebar-layout-facts' },
          createElement('span', {}, `${String(props.draft.width)} × ${String(props.draft.height)}`),
          createElement('span', {}, `${String(boxes.length)} 个布局框`),
          createElement('span', {}, layoutRatioLabel(props.draft.width, props.draft.height)),
        ),
      ]),
      section('summary', '整图描述', [
        createElement('textarea', {
          key: 'caption', rows: 3, value: props.draft.summary.caption ?? '', placeholder: '整张图的统一描述，生成必需',
          onChange: (event: { target: { value: string } }) => commit((state) => setSummary(state, { caption: event.target.value })),
        }),
      ]),
      section('canvas', '画布与画幅', [
        createElement('div', { key: 'size', className: 'dsh-forge-layout-size-row' },
          createElement('input', {
            type: 'number', value: String(props.draft.width), 'aria-label': '布局画布宽度',
            onChange: (event: { target: { value: string } }) => {
              const width = Number(event.target.value)
              if (Number.isFinite(width)) commit((state) => setCanvasSize(state, Math.round(width), state.height))
            },
          }),
          createElement('span', {}, '×'),
          createElement('input', {
            type: 'number', value: String(props.draft.height), 'aria-label': '布局画布高度',
            onChange: (event: { target: { value: string } }) => {
              const height = Number(event.target.value)
              if (Number.isFinite(height)) commit((state) => setCanvasSize(state, state.width, Math.round(height)))
            },
          }),
        ),
        createElement('select', {
          key: 'preset', value: `${String(props.draft.width)}x${String(props.draft.height)}`, 'aria-label': '画布比例预设',
          onChange: (event: { target: { value: string } }) => {
            const preset = LAYOUT_CANVAS_PRESETS.find((entry) => `${String(entry.width)}x${String(entry.height)}` === event.target.value)
            if (preset !== undefined) commit((state) => setCanvasSize(state, preset.width, preset.height))
          },
        }, ...LAYOUT_CANVAS_PRESETS.map((preset) => createElement('option', { key: preset.label, value: `${String(preset.width)}x${String(preset.height)}` }, preset.label))),
        createElement('select', {
          key: 'kind', value: props.draft.summary.canvas ?? '', 'aria-label': '画布类型',
          onChange: (event: { target: { value: string } }) => {
            commit((state) => setSummary(state, { canvas: event.target.value === '' ? undefined : event.target.value as LayoutCanvasValue }))
          },
        }, createElement('option', { value: '' }, '未指定布局类型'), ...LAYOUT_CANVAS_VALUES.map((value) => createElement('option', { key: value, value }, LAYOUT_CANVAS_LABEL_TEXT[value]))),
      ]),
      section('boxes', `布局框（共 ${String(boxes.length)} 个）`, boxes.length === 0
        ? [createElement('p', { key: 'empty', className: 'dsh-image-forge-sidebar-hint' }, '还没有布局框。在画布拖动创建。')]
        : [createElement('div', { key: 'list', className: 'dsh-forge-layout-box-list' },
            ...boxes.map((item) => createElement('div', {
              key: item.id,
              className: item.id === selectedBoxId ? 'dsh-forge-layout-box-row is-active' : 'dsh-forge-layout-box-row',
              onClick: () => selectRailBox(item.id),
            },
            createElement('span', { className: 'dsh-forge-layout-box-name' }, item.name ?? (item.caption || item.id)),
            createElement('span', { className: 'dsh-forge-layout-box-kind' }, LAYOUT_ITEM_LABEL_TEXT[item.label]),
            createElement('button', { type: 'button', className: 'dsh-forge-layout-box-edit', onClick: (event: { stopPropagation(): void }) => { event.stopPropagation(); openBox(item.id) } }, '属性'),
            )),
          )]),
      section('meta', '题材与配色', [
        createElement('label', { key: 'meta', className: 'dsh-forge-field' },
          createElement('span', { className: 'dsh-forge-label' }, '题材标签'),
          createElement('input', { value: props.draft.summary.meta?.join(', ') ?? '', placeholder: '逗号分隔', onChange: (event: { target: { value: string } }) => commit((state) => setSummary(state, { meta: sidebarListValue(event.target.value) })) }),
        ),
        createElement('label', { key: 'palette', className: 'dsh-forge-field' },
          createElement('span', { className: 'dsh-forge-label' }, '配色词'),
          createElement('input', { value: props.draft.summary.palette?.join(', ') ?? '', placeholder: '逗号分隔', onChange: (event: { target: { value: string } }) => commit((state) => setSummary(state, { palette: sidebarListValue(event.target.value) })) }),
        ),
      ], true),
      section('template', '版式模板', [
        createElement('select', {
          key: 'select', defaultValue: '', 'aria-label': '选择版式模板',
          onChange: (event: { target: { value: string; selectedIndex: number } }) => {
            const template = LAYOUT_TEMPLATES.find((entry) => entry.id === event.target.value)
            if (template !== undefined) {
              commit((state) => {
                let next = state
                for (const box of template.boxes) {
                  next = addBox(next, {
                    label: box.label,
                    caption: '',
                    bbox: { x1: box.x1 * next.width, y1: box.y1 * next.height, x2: box.x2 * next.width, y2: box.y2 * next.height },
                  })
                }
                return next
              })
            }
            event.target.selectedIndex = 0
          },
        }, createElement('option', { value: '' }, '选择模板…'), ...LAYOUT_TEMPLATES.map((template) => createElement('option', { key: template.id, value: template.id }, template.label))),
      ], true),
    ]),
    propertyPanel,
    createElement('div', { key: 'status', className: 'dsh-image-forge-sidebar-layout-status' },
      props.error === undefined
        ? (props.status === undefined ? null : createElement('p', { className: 'dsh-image-forge-sidebar-status', role: 'status' }, props.status))
        : createElement('p', { className: 'dsh-image-forge-sidebar-error', role: 'alert' }, props.error),
    ),
    createElement('div', { key: 'commit', className: 'dsh-image-forge-sidebar-commit' },
      createElement('button', { type: 'button', className: 'dsh-image-forge-sidebar-copy', disabled: props.saving || props.busy, onClick: () => { void props.onSave(props.draft) } }, props.saving ? '正在保存…' : '保存布局'),
      createElement('button', { type: 'button', className: 'dsh-image-forge-sidebar-primary', disabled: props.saving || props.busy || !props.gateReady, title: props.gateReason, onClick: () => { void props.onGenerate(props.draft) } }, props.busy ? '正在交接…' : '应用布局并生成'),
    ),
    !props.gateReady ? createElement('p', { key: 'gate', className: 'dsh-image-forge-sidebar-gate' }, props.gateReason) : null,
  ])
}
/** One consistent trash glyph for bubble and list deletion. */
function TrashIcon(): ReactNode {
  return createElement('svg', { className: 'dsh-image-forge-sidebar-trash', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
    createElement('path', { d: 'M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5' }),
  )
}

/** The actual Better Sidebar tab content. */
export function ImageEditorTab(props: ImageEditorTabProps): ReactNode {
  const meta = readImageEditorTabMeta(props.tab.meta)
  const [board, setBoard] = useState<BoardDetail | undefined>(undefined)
  const [boardError, setBoardError] = useState<string | undefined>(undefined)
  const [mode, setMode] = useState<'annotate' | 'layout'>('annotate')
  const [annotations, setAnnotations] = useState<AnnotationDraft[]>([])
  const [selectedAnnotation, setSelectedAnnotation] = useState<string | undefined>(undefined)
  const [draggingAnnotation, setDraggingAnnotation] = useState<string | undefined>(undefined)
  const imageFrameRef = useRef<HTMLDivElement | null>(null)
  const suppressImageClick = useRef(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [layoutDraft, setLayoutDraft] = useState<BoardLayoutDraft | undefined>(undefined)
  const [layoutSaving, setLayoutSaving] = useState(false)
  const [composerRevision, setComposerRevision] = useState(0)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (meta?.boardId === undefined) return undefined
    let cancelled = false
    void readBoard(meta.boardId).then((next) => {
      if (cancelled) return
      setBoard(next)
      setBoardError(undefined)
      const layoutId = meta.layoutId
      const item = layoutId === undefined
        ? undefined
        : next.items.find((entry) => entry.id === layoutId && (entry.kind ?? 'image') === 'layout')
      const ancestor = item ?? layoutAncestorOf(next, meta.itemId)
      if (ancestor?.draft !== undefined) setLayoutDraft(ancestor.draft)
    }).catch((cause: unknown) => {
      if (!cancelled) setBoardError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { cancelled = true }
  }, [meta?.boardId, meta?.itemId, meta?.layoutId])

  useEffect(() => {
    if (draggingAnnotation === undefined || typeof window === 'undefined') return undefined
    const move = (event: PointerEvent): void => {
      const frame = imageFrameRef.current
      if (frame === null) return
      suppressImageClick.current = true
      const point = annotationPointFromClient(event.clientX, event.clientY, frame.getBoundingClientRect())
      setAnnotations((current) => moveAnnotation(current, draggingAnnotation, point.x, point.y))
    }
    const end = (): void => {
      setDraggingAnnotation(undefined)
      setTimeout(() => { suppressImageClick.current = false }, 0)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
    window.addEventListener('pointercancel', end, { once: true })
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [draggingAnnotation])

  const layoutItem = useMemo(() => {
    if (board === undefined || meta === undefined) return undefined
    if (meta.layoutId !== undefined) {
      const direct = board.items.find((entry) => entry.id === meta.layoutId && (entry.kind ?? 'image') === 'layout')
      if (direct !== undefined) return direct
    }
    return layoutAncestorOf(board, meta.itemId)
  }, [board, meta])
  const layoutAvailable = layoutItem?.draft !== undefined

  const conversation = props.ctx.get?.('conversation') as ConversationHandoffLike | undefined
  const capability = conversationImageHandoffCapability(conversation)
  const scopeContext = props.ctx.sessions?.scope(props.scope.sessionId) ?? props.ctx
  const input: SessionInputLike | undefined = conversation === undefined
    ? undefined
    : conversation.input.for(scopeContext)
  useEffect(() => {
    if (input?.state.subscribe === undefined) return undefined
    const unsubscribe = input.state.subscribe(() => setComposerRevision((value) => value + 1))
    return unsubscribe
  }, [input])
  const gate = composerHandoffGate(input)
  void composerRevision

  useEffect(() => () => {
    if (saveTimer.current !== undefined) clearTimeout(saveTimer.current)
  }, [])

  if (meta === undefined) {
    return createElement('div', { className: 'dsh-image-forge-sidebar-empty' }, '这个侧栏页缺少图片信息。')
  }

  const annotationPrompt = annotationClipboardPrompt({
    imagePath: meta.imagePath,
    ...(meta.boardId === undefined ? {} : { boardId: meta.boardId }),
    ...(meta.itemId === undefined ? {} : { itemId: meta.itemId }),
    ...(meta.width === undefined ? {} : { imageWidth: meta.width }),
    ...(meta.height === undefined ? {} : { imageHeight: meta.height }),
    annotations,
  })
  const copyAnnotationPrompt = (): void => {
    void navigator.clipboard.writeText(annotationPrompt)
    setStatus('完整提示词已复制。')
  }
  const selectMode = (next: 'annotate' | 'layout'): void => {
    setMode(next)
    setActionError(undefined)
    setStatus(undefined)
  }
  const scheduleLayoutSave = (next: BoardLayoutDraft): void => {
    setLayoutDraft(next)
    if (layoutItem === undefined || meta.boardId === undefined) return
    if (saveTimer.current !== undefined) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      setLayoutSaving(true)
      saveLayoutNode(meta.boardId as string, layoutItem, next).then(
        () => { setLayoutSaving(false); setStatus('布局已保存到画板。') },
        (cause: unknown) => { setLayoutSaving(false); setActionError(cause instanceof Error ? cause.message : String(cause)) },
      )
    }, 700)
  }
  const saveLayoutNow = async (next: BoardLayoutDraft): Promise<void> => {
    if (layoutItem === undefined || meta.boardId === undefined) throw new Error('当前图片没有关联的 MOSS 布局节点。')
    if (saveTimer.current !== undefined) { clearTimeout(saveTimer.current); saveTimer.current = undefined }
    setLayoutSaving(true)
    try { await saveLayoutNode(meta.boardId, layoutItem, next); setStatus('布局已保存到画板。') }
    finally { setLayoutSaving(false) }
  }
  const generateFromLayout = async (nextDraft: BoardLayoutDraft = layoutDraft as BoardLayoutDraft): Promise<void> => {
    if (layoutItem === undefined || meta.boardId === undefined || nextDraft === undefined) return
    setBusy(true); setActionError(undefined)
    try {
      await saveLayoutNow(nextDraft)
      if (!gate.ready || conversation === undefined) throw new Error(gate.reason ?? '主会话不可用。')
      const compiled = compileLayout(nextDraft as unknown as LayoutDraft)
      await sendLayoutGeneration({ conversation, context: scopeContext, boardId: meta.boardId, layoutId: layoutItem.id, compiled })
      setStatus('布局已交给主会话生成。')
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const continueFromAnnotations = async (): Promise<void> => {
    if (annotations.length === 0) return
    setBusy(true); setActionError(undefined); setStatus(undefined)
    try {
      if (!gate.ready || conversation === undefined) throw new Error(gate.reason ?? '主会话不可用。')
      if (!capability.available) throw new Error(capability.reason)
      await sendAnnotatedEdit({ conversation, context: scopeContext, sessionId: props.scope.sessionId, meta, annotations })
      setAnnotations([])
      setSelectedAnnotation(undefined)
      setStatus('标注已交给主会话；临时气泡已清空。')
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  const image = board?.items.find((entry) => entry.id === meta.itemId)
  const imageWidth = image?.width ?? meta.width
  const imageHeight = image?.height ?? meta.height

  return createElement('div', {
    className: 'dsh-image-forge-sidebar-editor',
    'data-mode': mode,
  }, [
    createElement('div', { key: 'tabs', className: 'dsh-image-forge-sidebar-tabs', role: 'tablist' }, [
      createElement('button', {
        key: 'annotate',
        type: 'button',
        role: 'tab',
        'aria-selected': mode === 'annotate',
        className: mode === 'annotate' ? 'dsh-image-forge-sidebar-tab is-active' : 'dsh-image-forge-sidebar-tab',
        onClick: () => selectMode('annotate'),
      }, '标注', annotations.length > 0 ? createElement('span', { className: 'dsh-image-forge-sidebar-count' }, String(annotations.length)) : null),
      layoutAvailable
        ? createElement('button', {
            key: 'layout',
            type: 'button',
            role: 'tab',
            'aria-selected': mode === 'layout',
            className: mode === 'layout' ? 'dsh-image-forge-sidebar-tab is-active' : 'dsh-image-forge-sidebar-tab',
            onClick: () => selectMode('layout'),
          }, 'MOSS 布局')
        : null,
    ]),
    boardError === undefined ? null : createElement('p', { key: 'board-error', className: 'dsh-image-forge-sidebar-error', role: 'alert' }, boardError),
    mode === 'annotate'
      ? createElement('div', { key: 'annotate-panel', className: 'dsh-image-forge-sidebar-panel' }, [
          createElement('div', { key: 'image-shell', className: 'dsh-image-forge-sidebar-image-shell' }, [
            createElement('div', {
              key: 'image-frame',
              ref: imageFrameRef,
              className: 'dsh-image-forge-sidebar-image is-annotating',
              style: imageWidth !== undefined && imageHeight !== undefined && imageWidth > 0 && imageHeight > 0
                ? { aspectRatio: `${String(imageWidth)} / ${String(imageHeight)}` }
                : undefined,
              onClick: (event: { currentTarget: { getBoundingClientRect(): DOMRect }; clientX: number; clientY: number }) => {
                if (suppressImageClick.current) {
                  suppressImageClick.current = false
                  return
                }
                const point = annotationPointFromClient(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect())
                const next: AnnotationDraft = {
                  id: `${String(Date.now())}-${String(annotations.length + 1)}`,
                  number: annotations.length + 1,
                  x: point.x,
                  y: point.y,
                  text: '',
                }
                setAnnotations((current) => renumberAnnotations([...current, next]))
                setSelectedAnnotation(next.id)
              },
            }, [
              createElement('img', { key: 'img', src: studioFileUrl(meta.imagePath), alt: meta.title }),
              ...annotations.map((annotation) => createElement('div', {
                key: annotation.id,
                className: selectedAnnotation === annotation.id
                  ? 'dsh-image-forge-sidebar-pin-wrap is-selected'
                  : 'dsh-image-forge-sidebar-pin-wrap',
                style: { left: `${String(annotation.x * 100)}%`, top: `${String(annotation.y * 100)}%` },
              },
              createElement('button', {
                type: 'button',
                className: 'dsh-image-forge-sidebar-pin',
                'aria-label': `拖动或编辑标注 ${String(annotation.number)}`,
                onPointerDown: (event: { button?: number; stopPropagation(): void }) => {
                  if (event.button !== undefined && event.button !== 0) return
                  event.stopPropagation()
                  setSelectedAnnotation(annotation.id)
                  setDraggingAnnotation(annotation.id)
                },
                onClick: (event: { stopPropagation(): void }) => { event.stopPropagation(); setSelectedAnnotation(annotation.id) },
                onKeyDown: (event: { key: string; preventDefault(): void }) => {
                  if (event.key !== 'Delete' && event.key !== 'Backspace') return
                  event.preventDefault()
                  setAnnotations((current) => renumberAnnotations(current.filter((entry) => entry.id !== annotation.id)))
                  setSelectedAnnotation(undefined)
                },
              }, createElement('span', { className: 'dsh-image-forge-sidebar-pin-number' }, String(annotation.number))),
              createElement('button', {
                type: 'button',
                className: 'dsh-image-forge-sidebar-pin-delete',
                'aria-label': `删除标注 ${String(annotation.number)}`,
                title: '删除这个标注',
                onClick: (event: { stopPropagation(): void }) => {
                  event.stopPropagation()
                  setAnnotations((current) => renumberAnnotations(current.filter((entry) => entry.id !== annotation.id)))
                  setSelectedAnnotation(undefined)
                },
              }, '×'))),
            ]),
            createElement('div', { key: 'tools', className: 'dsh-image-forge-sidebar-image-tools' },
              createElement('span', { className: 'dsh-image-forge-sidebar-image-tip' }, '点画面添加标注'),
            ),
          ]),
          createElement('p', { key: 'hint', className: 'dsh-image-forge-sidebar-hint' }, '点击画面添加编号；拖动编号调整位置；文字只用于下一轮理解。'),
          annotations.length === 0
            ? createElement('div', { key: 'empty', className: 'dsh-image-forge-sidebar-empty-bubbles' }, '还没有标注。点一下画面开始。')
            : createElement('div', { key: 'list', className: 'dsh-image-forge-sidebar-annotation-list' },
                ...annotations.map((annotation) => createElement('div', {
                  key: annotation.id,
                  className: selectedAnnotation === annotation.id
                    ? 'dsh-image-forge-sidebar-annotation is-selected'
                    : 'dsh-image-forge-sidebar-annotation',
                  tabIndex: 0,
                  onClick: () => setSelectedAnnotation(annotation.id),
                  onKeyDown: (event: { key: string; target: { tagName?: string }; preventDefault(): void }) => {
                    if (event.target.tagName === 'TEXTAREA') return
                    if (event.key !== 'Delete' && event.key !== 'Backspace') return
                    event.preventDefault()
                    setAnnotations((current) => renumberAnnotations(current.filter((entry) => entry.id !== annotation.id)))
                    setSelectedAnnotation(undefined)
                  },
                }, [
                  createElement('span', { key: 'n', className: 'dsh-image-forge-sidebar-annotation-number' }, String(annotation.number)),
                  createElement('textarea', {
                    key: 'text',
                    rows: 2,
                    value: annotation.text,
                    placeholder: '例如：把外套改成半透明琥珀色，其他保持不变',
                    'aria-label': `标注 ${String(annotation.number)} 的说明`,
                    onFocus: () => setSelectedAnnotation(annotation.id),
                    onChange: (event: { target: { value: string } }) => {
                      setAnnotations((current) => editAnnotationText(current, annotation.id, event.target.value))
                    },
                  }),
                  createElement('button', {
                    key: 'remove',
                    type: 'button',
                    className: 'dsh-image-forge-sidebar-remove',
                    'aria-label': `删除标注 ${String(annotation.number)}`,
                    title: '删除这个标注',
                    onClick: (event: { stopPropagation(): void }) => {
                      event.stopPropagation()
                      setAnnotations((current) => renumberAnnotations(current.filter((entry) => entry.id !== annotation.id)))
                      setSelectedAnnotation(undefined)
                    },
                  }, TrashIcon(), createElement('span', {}, '删除')),
                ]))),
          status === undefined ? null : createElement('p', { key: 'status', className: 'dsh-image-forge-sidebar-status', role: 'status' }, status),
          actionError === undefined ? null : createElement('p', { key: 'action-error', className: 'dsh-image-forge-sidebar-error', role: 'alert' }, actionError),
          createElement('div', { key: 'commit', className: 'dsh-image-forge-sidebar-commit' }, [
            createElement('button', {
              key: 'continue',
              type: 'button',
              className: 'dsh-image-forge-sidebar-primary',
              disabled: busy || annotations.length === 0 || !capability.available || !gate.ready,
              title: !capability.available ? capability.reason : gate.reason,
              onClick: () => { void continueFromAnnotations() },
            }, busy ? '正在交接…' : `根据 ${String(annotations.length)} 条标注继续生成`),
            createElement('button', {
              key: 'copy',
              type: 'button',
              className: 'dsh-image-forge-sidebar-copy',
              disabled: annotations.length === 0,
              onClick: copyAnnotationPrompt,
            }, '复制提示词'),
          ]),
          !gate.ready ? createElement('p', { key: 'gate', className: 'dsh-image-forge-sidebar-gate' }, gate.reason) : null,
          !capability.available ? createElement('p', { key: 'capability', className: 'dsh-image-forge-sidebar-gate' }, capability.reason) : null,
        ])
      : createElement('div', { key: 'layout-panel', className: 'dsh-image-forge-sidebar-panel is-layout' }, layoutDraft === undefined
        ? createElement('p', { key: 'empty', className: 'dsh-image-forge-sidebar-empty' }, '这个图片没有可编辑的 MOSS 布局父节点。')
        : createElement(SidebarLayoutWorkbench, {
          key: 'editor',
          draft: layoutDraft,
          theme: meta.theme ?? 'auto',
          saving: layoutSaving,
          busy,
          gateReady: gate.ready,
          gateReason: gate.reason ?? '',
          ...(status === undefined ? {} : { status }),
          ...(actionError === undefined ? {} : { error: actionError }),
          onDraftChange: scheduleLayoutSave,
          onSave: async (nextDraft) => {
            try { await saveLayoutNow(nextDraft) }
            catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)) }
          },
          onGenerate: generateFromLayout,
        }))  ])
}