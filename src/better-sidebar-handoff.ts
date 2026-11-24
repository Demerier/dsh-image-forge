/** Main-conversation handoff for annotations and MOSS layouts. */
import { annotationHandoffPrompt, type AnnotationDraft } from './image-annotation.ts'
import type { ImageEditorTabMeta } from './better-sidebar-model.ts'

/** Snapshot members this plugin reads from the host composer. */
export interface ComposerSnapshotLike {
  readonly draft?: string
  readonly phase?: string
  readonly attachmentIds?: readonly string[]
}

/** Session input surface used by the handoff. */
export interface SessionInputLike {
  readonly state: {
    readonly getSnapshot: () => ComposerSnapshotLike
    readonly subscribe?: (listener: () => void) => () => void
  }
  setDraft(text: string): void
  addAttachments(ids: readonly string[]): boolean
  removeAttachment(id: string): boolean
  submit(mode?: string, source?: 'click' | 'enter'): void
  notify?(level: 'info' | 'error', text: string): void
}

/** Runtime-only methods on DSH's conversation service. */
export interface ConversationHandoffLike {
  readonly input: { for(context: unknown): SessionInputLike }
  createDrafts?(sessionId: string, files: readonly File[], uploadImages: boolean): readonly { readonly id: string }[]
  releaseDraftAttachments?(attachments: readonly unknown[]): void
}

/** A disabled reason is explicit so the UI never silently does nothing. */
export function composerHandoffGate(input: SessionInputLike | undefined): { readonly ready: boolean; readonly reason?: string } {
  if (input === undefined) return { ready: false, reason: '主会话输入机尚未就绪。' }
  const snapshot = input.state.getSnapshot()
  if (snapshot.phase !== undefined && snapshot.phase !== 'plain') {
    return { ready: false, reason: '主会话正在处理上一条消息，请等它结束后再继续。' }
  }
  if ((snapshot.draft ?? '').trim().length > 0) {
    return { ready: false, reason: '主会话草稿里已有内容；为避免覆盖，请先发送或清空草稿。' }
  }
  return { ready: true }
}

/** Resolve a session input through public `conversation.input.for`. */
export function sessionInputOf(conversation: ConversationHandoffLike, context: unknown): SessionInputLike {
  return conversation.input.for(context)
}

/** Wait until the submitted draft is cleared, or fail closed after a timeout. */
export function watchComposerAccepted(input: SessionInputLike, timeoutMs = 15_000): Promise<boolean> {
  const initial = input.state.getSnapshot()
  if (initial.phase === 'plain' && (initial.draft ?? '').trim().length === 0) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    let settled = false
    let unsubscribe: (() => void) | undefined
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe?.()
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), Math.max(200, timeoutMs))
    const inspect = (): void => {
      const next = input.state.getSnapshot()
      if ((next.phase === undefined || next.phase === 'plain') && (next.draft ?? '').trim().length === 0) finish(true)
      else if (next.phase !== 'sending' && next.phase !== 'submitting' && next.phase !== 'adjudicating') {
        const restored = (next.draft ?? '').trim()
        if (restored.length > 0) finish(false)
      }
    }
    unsubscribe = input.state.subscribe?.(inspect)
    inspect()
  })
}

/** Draw numbered orange bubbles and short captions onto a temporary PNG. */
export async function buildAnnotatedPreview(
  meta: ImageEditorTabMeta,
  annotations: readonly AnnotationDraft[],
): Promise<File> {
  const response = await fetch(studioImageUrl(meta.imagePath), { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`读取原图失败（HTTP ${String(response.status)}）`)
  const source = await response.blob()
  const bitmap = await imageBitmapOf(source)
  const width = bitmap.width
  const height = bitmap.height
  const max = 2048
  const scale = Math.min(1, max / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('浏览器没有提供 Canvas 2D，无法生成标注预览。')
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const unit = Math.max(18, Math.min(42, Math.round(Math.min(canvas.width, canvas.height) / 28)))
  for (const annotation of annotations) {
    const x = annotation.x * canvas.width
    const y = annotation.y * canvas.height
    const radius = unit * 0.62
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.fillStyle = '#e66a3a'
    context.fill()
    context.lineWidth = Math.max(2, unit * 0.09)
    context.strokeStyle = 'rgba(255,255,255,.94)'
    context.stroke()
    context.fillStyle = '#fff'
    context.font = `700 ${String(Math.round(unit * 0.72))}px system-ui, sans-serif`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(String(annotation.number), x, y + 1)
    const label = annotation.text.trim().slice(0, 28)
    if (label.length > 0) {
      context.font = `500 ${String(Math.round(unit * 0.58))}px system-ui, sans-serif`
      const padding = unit * 0.35
      const labelWidth = Math.min(canvas.width * 0.38, context.measureText(label).width + padding * 2)
      const labelHeight = unit * 0.86
      const left = Math.min(canvas.width - labelWidth - 8, Math.max(8, x + radius + 5))
      const top = Math.min(canvas.height - labelHeight - 8, Math.max(8, y - labelHeight / 2))
      context.fillStyle = 'rgba(34,33,29,.88)'
      context.beginPath()
      if (typeof context.roundRect === 'function') context.roundRect(left, top, labelWidth, labelHeight, labelHeight / 2)
      else context.rect(left, top, labelWidth, labelHeight)
      context.fill()
      context.fillStyle = '#fff'
      context.textAlign = 'left'
      context.textBaseline = 'middle'
      context.fillText(label, left + padding, top + labelHeight / 2)
    }
  }
  if (typeof bitmap.close === 'function') bitmap.close()
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value === null ? reject(new Error('标注预览编码失败')) : resolve(value), 'image/png')
  })
  return new File([blob], `annotated-${meta.itemId ?? 'image'}.png`, { type: 'image/png' })
}

/** Resolve the annotated bitmap without assuming `createImageBitmap` exists. */
async function imageBitmapOf(blob: Blob): Promise<CanvasImageSource & { width: number; height: number; close?: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob) } catch { /* fall back to <img> */ }
  }
  const url = URL.createObjectURL(blob)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('原图解码失败'))
      element.src = url
    })
    return image
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }
}

/** The plugin's same-origin image route, duplicated locally to keep this module browser-only. */
function studioImageUrl(path: string): string {
  return `/plugins/dsh-image-forge/studio/file?path=${encodeURIComponent(path)}`
}

/** Submit one annotated edit and report whether the composer accepted it. */
export async function sendAnnotatedEdit(input: {
  readonly conversation: ConversationHandoffLike
  readonly context: unknown
  readonly sessionId: string
  readonly meta: ImageEditorTabMeta
  readonly annotations: readonly AnnotationDraft[]
}): Promise<void> {
  const gate = composerHandoffGate(input.conversation.input.for(input.context))
  if (!gate.ready) throw new Error(gate.reason)
  if (typeof input.conversation.createDrafts !== 'function') throw new Error('当前 DSH 主会话不支持图片草稿。')
  const file = await buildAnnotatedPreview(input.meta, input.annotations)
  const drafts = input.conversation.createDrafts(input.sessionId, [file], true)
  const sessionInput = input.conversation.input.for(input.context)
  const ids = drafts.map((draft) => draft.id)
  if (ids.length !== 1 || !sessionInput.addAttachments(ids)) {
    input.conversation.releaseDraftAttachments?.(drafts)
    throw new Error('主会话拒绝了图片附件；标注仍然保留。')
  }
  sessionInput.setDraft(annotationHandoffPrompt({
    imagePath: input.meta.imagePath,
    ...(input.meta.boardId === undefined ? {} : { boardId: input.meta.boardId }),
    ...(input.meta.itemId === undefined ? {} : { itemId: input.meta.itemId }),
    ...(input.meta.width === undefined ? {} : { imageWidth: input.meta.width }),
    ...(input.meta.height === undefined ? {} : { imageHeight: input.meta.height }),
    annotations: input.annotations,
  }))
  sessionInput.submit('queue', 'click')
  if (!await watchComposerAccepted(sessionInput)) throw new Error('主会话没有确认提交；标注仍然保留。')
}

/** Send a compiled MOSS layout through the same main conversation. */
export async function sendLayoutGeneration(input: {
  readonly conversation: ConversationHandoffLike
  readonly context: unknown
  readonly boardId: string
  readonly layoutId: string
  readonly compiled: string
}): Promise<void> {
  const sessionInput = input.conversation.input.for(input.context)
  const gate = composerHandoffGate(sessionInput)
  if (!gate.ready) throw new Error(gate.reason)
  sessionInput.setDraft([
    '请使用下面已经编译好的 MOSS 布局提示词生成新图。',
    `画板：${JSON.stringify(input.boardId)}`,
    `布局节点：${JSON.stringify(input.layoutId)}`,
    '',
    input.compiled,
    '',
    '做两件事：1. 先把 compiled JSON 转成 qwen_image_generate 需要的完整成品提示词；2. 调用 qwen_image_generate，board 使用上面的画板 id，comfyModel 使用 moss-sft，count 保持 1。不要直接开始后端请求。',
  ].join('\n'))
  sessionInput.submit('queue', 'click')
  if (!await watchComposerAccepted(sessionInput)) throw new Error('主会话没有确认提交；布局已保存但未发送。')
}