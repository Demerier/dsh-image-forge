/**
 * Client half: keyed tool views for every `image_forge_*` tool, the Studio's
 * global-panel seats, and the `dsh-image-forge` first-level settings section.
 *
 * ## Tool views
 *
 * `tool.call.toolview` is a **keyed** slot, and the key must be the tool's wire
 * name for the card to own that call's row — a mismatched key silently
 * registers a view nothing ever dispatches to. All four tools are seated:
 * generate/edit show the landed images, status/env show a compact digest of the
 * JSON the tool already returned in full.
 *
 * Scope note: these cards are supplementary. The primary display path stays the
 * Markdown `![](absolute path)` lines the Host returns in the tool result — if
 * a card cannot render for any reason it renders nothing and the conversation
 * still shows the images. Everything here is defensive for exactly that reason.
 *
 * ## The settings section
 *
 * `settings.section` is a **list** slot (seated by `id`), and a seat there is a
 * first-level entry in the DSH settings page. The page the section renders is
 * bound to the Host's own shared config form for this plugin's profile entry —
 * see `./settings-section.ts` for the binding and save semantics. Field tables
 * live in `./settings-fields.ts`; layout CSS in `./client-styles.ts`. This file
 * is the React layer on top of those.
 *
 * Nothing here reaches for a service at activation time: `configForms` is looked
 * up optionally, and a page that serves none gets a notice in the section rather
 * than losing the plugin's client half (and with it the tool cards).
 *
 * ## The Studio panel
 *
 * The workbench is a **global panel**, not a settings tab: the layout shell's
 * root-scoped `main` keyed slot renders it, and a `sidebar.panellist` entry
 * puts it in the left sidebar. Both seats come from `registerStudioPanel` in
 * `./settings-section.ts`; the seated component is the tabbed shell in
 * `./workbench-view.ts` (whose canvas tabs still mount `StudioPanel` from
 * `./studio-view.ts` until U04 extracts a pane that takes a `boardId`), and the
 * sidebar glyph lives in `./studio-view.ts`. The settings section below is pure
 * configuration.
 */
import { createElement, type ReactNode } from 'react'
import { injectClientStyles } from './client-styles.ts'
import { studioFileUrl } from './studio-shared.ts'
import { ImageResultCard } from './image-result-card.ts'
import { toolPayloadFrom } from './image-result-model.ts'
import { openImageEditorTab, registerBetterSidebarTab, type BetterSidebarContextLike } from './better-sidebar.ts'
import { StudioPanelIcon } from './studio-view.ts'
import { WorkbenchShell } from './workbench-view.ts'
import { QwenImageSettingsSection } from './settings-view.ts'
import { registerSettingsSection, registerStudioPanel } from './settings-section.ts'
/**
 * Registration name inside the cordis client context.
 *
 * Deliberately **not exported**: the browser half publishes exactly `apply` and
 * `inject` — the shape the loader reads, and the shape the official template and
 * all ten reference client entries use — while the module identity comes from the
 * factory's `id` in `tsdown.client.config.ts`, not from an export.
 */
const name = 'dsh-image-forge-client'

/**
 * Client services required before `apply` runs.
 *
 * These are **cordis service names**, a different layer from `package.json`'s
 * `dsh.client.inject` (which takes client **module package names**). The two must
 * not be conflated: `slots` is correct here and would be a load failure there.
 *
 * `configForms` is declared because the settings section binds the Host's native
 * form for this entry through it, and every reference plugin that seats a
 * settings section declares it too. It is still read through `ctx.get`, so a page
 * that serves no such service gets the section's "unavailable" notice rather than
 * a crash.
 */
export const inject = ['slots', 'configForms']

/** Every tool this plugin registers, in the order the cards are seated. */
const TOOL_KEYS = [
  'image_forge_generate',
  'image_forge_edit',
  'image_forge_status',
] as const

/** Minimal shape of the host-provided image loader. */
type LoadImage = (path: string) => unknown

/**
 * One item of a tool-result `content` array: the Host renders execute() output
 * as text blocks carrying the JSON payload.
 */
interface ToolContentItem {
  readonly type?: string
  readonly text?: string
}

/**
 * The tool-result block the Host actually hands the view.
 *
 * Discovered on a real client (2026-10-17): the view is **not** given
 * `result.value`. It receives `toolName`, `phase`, `loadImage` and a `block`
 * of kind `tool-result` whose `content[].text` is the JSON that `execute()`
 * returned (after the tool layer validated it). Reading the wrong shape made
 * every card show its empty-state fallbacks in a real client while the Node
 * tests still passed — the live client confirmed it.
 */
interface ToolResultBlock {
  readonly kind?: string
  readonly name?: string
  readonly content?: readonly ToolContentItem[]
  readonly isError?: boolean
}

/** The row props this view reads; every field is optional by design. */
interface ToolRowProps {
  readonly phase?: string
  readonly toolName?: string
  readonly loadImage?: LoadImage
  readonly block?: ToolResultBlock
  /** Session owning the conversation row; supplied by the session-scoped tool slot. */
  readonly sessionId?: string
  /** Legacy/guessed shape kept as a fallback if the Host ever passes it. */
  readonly result?: {
    readonly value?: unknown
  }
}

/** Tolerant read of one nested object field from a tool payload. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/**
 * The tool payload, from the Host's tool-result block (or a `result.value`
 * fallback).
 *
 * @param props - the row props.
 * @returns the parsed JSON object `execute()` returned, if any.
 */
function payloadOf(props: ToolRowProps): Record<string, unknown> | undefined {
  return toolPayloadFrom(props.block?.content, props.result?.value)
}

/** Wire name of the tool this row is rendering. */
function toolNameOf(props: ToolRowProps): string {
  return props.toolName ?? props.block?.name ?? ''
}

/** One meta chip; `tone` maps onto the pill modifiers in the stylesheet. */
function pill(key: string, text: string, tone: 'ok' | 'warn' | 'bad' | 'neutral' = 'neutral'): ReactNode {
  const className =
    tone === 'neutral' ? 'dsh-image-forge-pill' : `dsh-image-forge-pill dsh-image-forge-pill-${tone}`
  return createElement('span', { key, className }, text)
}

/** Compact `1664×928` from a result `size` object, or null. */
function sizeChip(value: Record<string, unknown> | undefined): ReactNode {
  const size = asRecord(value?.['size'])
  const width = size?.['width']
  const height = size?.['height']
  if (typeof width !== 'number' || typeof height !== 'number') return null
  return pill('size', `${width}×${height}`)
}

/** Status / running / done line for the current lifecycle phase. */
function phaseLabel(props: ToolRowProps, done: string, running: string): string {
  const phase = props.phase ?? 'start'
  if (phase === 'preparing') return '准备参数…'
  if (phase === 'result') return done
  return running
}

/** Shared card shell: title, status line, optional pills, then children. */
function CardShell(props: {
  title: string
  status: string
  pills: ReactNode[]
  children: ReactNode[]
}): ReactNode {
  return createElement('div', { className: 'dsh-image-forge-row' }, [
    createElement('div', { key: 'head', className: 'dsh-image-forge-row-head' }, [
      createElement('h4', { key: 'title', className: 'dsh-image-forge-row-title' }, props.title),
      createElement('span', { key: 'status', className: 'dsh-image-forge-row-status' }, props.status),
    ]),
    props.pills.length > 0
      ? createElement('div', { key: 'meta', className: 'dsh-image-forge-row-meta' }, props.pills)
      : null,
    ...props.children,
  ])
}

/**
 * Generate / edit card: the landed images plus the facts that explain them.
 *
 * @param props - owner props supplied by ui-tool's dispatch.
 * @returns the card, or nothing on a presentation failure.
 */
function ImageResultRow(props: ToolRowProps, ctx: BetterSidebarContextLike): ReactNode {
  try {
    const payload = payloadOf(props)
    const sidebar = ctx.get?.('betterSidebar') as { readonly openTab?: unknown } | undefined
    const canOpenEditor = typeof sidebar?.openTab === 'function'
    return createElement(ImageResultCard, {
      phase: props.phase,
      toolName: toolNameOf(props) || (props.toolName ?? 'image_forge_generate'),
      payload,
      ...(typeof props.loadImage === 'function' ? { loadImage: props.loadImage } : {}),
      ...(props.sessionId === undefined ? {} : { sessionId: props.sessionId }),
      ...(canOpenEditor ? {
        onOpenEditor: (meta: {
          readonly imagePath: string
          readonly title: string
          readonly boardId?: string
          readonly itemId?: string
          readonly width?: number
          readonly height?: number
        }) => {
          openImageEditorTab(ctx, props.sessionId, meta)
        },
      } : {}),
    })
  } catch {
    // A presentation failure must never take down the conversation row.
    return null
  }
}
/** One checklist cell: a short label over a one-line verdict. */
function checkCell(key: string, label: string, text: string, tone: 'ok' | 'warn' | 'bad' | 'neutral'): ReactNode {
  return createElement('div', { key, className: 'dsh-image-forge-check' }, [
    createElement('span', { key: 'label', className: 'dsh-image-forge-check-label' }, label),
    createElement('span', { key: 'value', className: 'dsh-image-forge-check-value' }, text),
    pill('tone', tone === 'neutral' ? '—' : tone === 'ok' ? 'OK' : tone === 'warn' ? '注意' : '不可用', tone),
  ])
}

/**
 * Status card: a three-cell digest of the health probe.
 *
 * The full JSON stays in the tool result; this is the glanceable half.
 *
 * @param props - owner props supplied by ui-tool's dispatch.
 * @returns the card, or nothing on a presentation failure.
 */
function StatusRow(props: ToolRowProps): ReactNode {
  try {
    const payload = payloadOf(props)
    const status = phaseLabel(props, '探测完成', '正在探测后端…')
    const comfy = asRecord(payload?.['comfyui'])

    const comfyOk = comfy?.['reachable'] === true
    const models = asRecord(comfy?.['models'])
    const comfyTone: 'ok' | 'warn' | 'bad' = comfyOk ? (models?.['ok'] === true ? 'ok' : 'warn') : 'bad'
    const comfyText = !comfyOk
      ? '没找到在跑的实例'
      : models?.['ok'] === true
        ? '在跑，三个权重齐'
        : '在跑，但缺 Qwen 权重'

    // One GPU line, straight from ComfyUI's own `/system_stats`: the card that
    // matters is the one it loaded its weights onto.
    const devices = Array.isArray(comfy?.['devices']) ? comfy['devices'] : []
    const device = asRecord(devices[0])
    const vramFree = typeof device?.['vram_free_MiB'] === 'number' ? device['vram_free_MiB'] : null
    const vramTotal = typeof device?.['vram_total_MiB'] === 'number' ? device['vram_total_MiB'] : null
    const gpuText = vramTotal === null
      ? '未报告'
      : `${String(device?.['name'] ?? 'GPU')} · 空闲 ${String(vramFree ?? '?')} / ${String(vramTotal)} MiB`
    const output = asRecord(payload?.['output'])
    const outputWritable = output?.['writable'] === true

    return createElement(CardShell, {
      title: '后端健康',
      status,
      pills: [],
      children: [
        createElement(
          'div',
          { key: 'checks', className: 'dsh-image-forge-checklist' },
          [
            checkCell('comfy', 'ComfyUI', comfyText, comfyTone),
            checkCell('vram', '显卡', gpuText, vramTotal === null ? 'warn' : 'neutral'),
            checkCell('output', '输出目录', outputWritable ? '可写' : '不可写', outputWritable ? 'ok' : 'bad'),
          ],
        ),
      ],
    })
  } catch {
    return null
  }
}

/**
 * Build the tool row bound to one wire name.
 *
 * The Host does not guarantee `toolName` on the props, so the key is closed over
 * at registration time instead of being read back from the call.
 *
 * @param toolName - the tool's wire name.
 * @returns a component that renders that tool's card.
 */
function createToolRow(toolName: string, ctx: BetterSidebarContextLike): (props: ToolRowProps) => ReactNode {
  return function ImageForgeToolRow(props: ToolRowProps): ReactNode {
    const bound: ToolRowProps = { ...props, toolName: toolNameOf(props) || toolName }
    if (toolName === 'image_forge_status') return StatusRow(bound)
    return ImageResultRow(bound, ctx)
  }
}

// ---------------------------------------------------------------------------
/**
 * Register the keyed tool views, the Studio's global panel, and the
 * first-level settings section.
 *
 * @param ctx - cordis client context providing `slots`, and optionally `get`.
 */
export function apply(ctx: {
  slots: {
    inject(name: string, register: () => unknown): void
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  get?(name: string): unknown
  effect?(fn: () => () => void): unknown
  sessions?: { scope(sessionId: string): unknown }
}): void {
  injectClientStyles()
  registerBetterSidebarTab(ctx)
  // One inject, four keyed seats: each key is a separate toolview dispatch
  // target, and a single component factory keeps the defensive shell shared.
  ctx.slots.inject('tool.call.toolview', () => {
    const seats = TOOL_KEYS.map((toolName) =>
      ctx.slots.register({ name: 'tool.call.toolview', key: toolName }, createToolRow(toolName, ctx)),
    )
    return () => {
      for (const seat of seats) {
        try {
          if (typeof seat === 'function') (seat as () => void)()
        } catch {
          // The slot fiber is already gone during teardown.
        }
      }
    }
  })
  registerSettingsSection(ctx, QwenImageSettingsSection)
  // The workbench is a global panel, not a settings tab: the layout shell's
  // `main` keyed slot holds the surface, and the sidebar list entry puts it in
  // the left rail. Both registrations wait for their slot to be declared, so a
  // host whose shell has neither still gets the tools and the settings page.
  //
  // The seated component is the **tabbed shell** (U03), not the studio surface:
  // the panel now opens on the projects tab, and a project's canvas tab mounts
  // `StudioPanel` inside it until U04's `CanvasPane` takes over. Seat id, label
  // and order are untouched, so the sidebar row and the settings section keep
  // pointing at the same plugin entry (`test/settings.test.mjs` pins that).
  registerStudioPanel(ctx, { panel: WorkbenchShell, icon: StudioPanelIcon })
}

