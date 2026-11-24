/** Pure annotation vocabulary shared by the Better Sidebar tab and its tests. */

/** One transient numbered bubble. Coordinates are normalized to the image box. */
export interface AnnotationDraft {
  readonly id: string
  /** One-based number shown in the bubble and in the generated prompt. */
  readonly number: number
  /** Horizontal position, `0..1`, left to right. */
  readonly x: number
  /** Vertical position, `0..1`, top to bottom. */
  readonly y: number
  readonly text: string
}

/** The most bubbles one handoff accepts. More than this becomes a wall of text. */
export const MAX_IMAGE_ANNOTATIONS = 20

/** Clamp one normalized coordinate into the image. */
export function clampAnnotationCoordinate(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

/** Normalize a click point inside a rendered image rectangle. */
export function annotationPointFromClient(
  clientX: number,
  clientY: number,
  rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number } {
  const width = Math.max(1, rect.width)
  const height = Math.max(1, rect.height)
  return {
    x: clampAnnotationCoordinate((clientX - rect.left) / width),
    y: clampAnnotationCoordinate((clientY - rect.top) / height),
  }
}

/** Renumber a list in visual/array order, preserving ids and text. */
export function renumberAnnotations(annotations: readonly AnnotationDraft[]): AnnotationDraft[] {
  return annotations.map((annotation, index) => ({ ...annotation, number: index + 1 }))
}

/** Move one bubble and keep it inside the image. */
export function moveAnnotation(
  annotations: readonly AnnotationDraft[],
  id: string,
  x: number,
  y: number,
): AnnotationDraft[] {
  const nextX = clampAnnotationCoordinate(x)
  const nextY = clampAnnotationCoordinate(y)
  let changed = false
  const next = annotations.map((annotation) => {
    if (annotation.id !== id || (annotation.x === nextX && annotation.y === nextY)) return annotation
    changed = true
    return { ...annotation, x: nextX, y: nextY }
  })
  return changed ? next : [...annotations]
}

/** Edit one bubble's text. */
export function editAnnotationText(
  annotations: readonly AnnotationDraft[],
  id: string,
  text: string,
): AnnotationDraft[] {
  let changed = false
  const next = annotations.map((annotation) => {
    if (annotation.id !== id || annotation.text === text) return annotation
    changed = true
    return { ...annotation, text }
  })
  return changed ? next : [...annotations]
}

/** Percent coordinates make the prompt readable without leaking screen pixels. */
export function annotationCoordinateLabel(annotation: Pick<AnnotationDraft, 'x' | 'y'>): string {
  return `${Math.round(annotation.x * 100)}% / ${Math.round(annotation.y * 100)}%`
}

/** Inputs for the semantic handoff prompt. */
export interface AnnotationHandoffInput {
  readonly imagePath: string
  readonly boardId?: string
  readonly itemId?: string
  readonly imageWidth?: number
  readonly imageHeight?: number
  readonly annotations: readonly AnnotationDraft[]
}

/**
 * Build the text that rides the main conversation together with the transient
 * annotated preview. The original image path — never the preview — is the edit
 * target, and the vision model is asked to rewrite before calling the tool.
 */
export function annotationHandoffPrompt(input: AnnotationHandoffInput): string {
  const annotations = renumberAnnotations(input.annotations)
  const lines = annotations.map((annotation) => {
    const text = annotation.text.trim() || '请根据气泡位置和画面内容推断修改意图。'
    return `${String(annotation.number)}. 位置 ${annotationCoordinateLabel(annotation)}：${text}`
  })
  const board = input.boardId === undefined || input.boardId.length === 0
    ? '- 画板：沿用当前目标图所在画板'
    : `- 画板：${JSON.stringify(input.boardId)}`
  const item = input.itemId === undefined || input.itemId.length === 0
    ? '- 画板节点：未知（按图片路径处理）'
    : `- 画板节点：${JSON.stringify(input.itemId)}`
  const dimensions = typeof input.imageWidth === 'number' && typeof input.imageHeight === 'number'
    ? `- 原图尺寸：${String(input.imageWidth)}×${String(input.imageHeight)}`
    : '- 原图尺寸：以附件与文件实际尺寸为准'
  return [
    '请根据我附上的编号标注图理解修改意图。标注图只用于视觉定位，不是编辑目标，也不要把气泡、编号或文字生成到结果里。',
    '',
    `原始编辑目标：${JSON.stringify(input.imagePath)}`,
    board,
    item,
    dimensions,
    '',
    '标注：',
    ...lines,
    '',
    '执行要求：',
    '1. 先用视觉能力理解每个编号所指的区域，以及未标注区域必须保持不变的约束。',
    '2. 按 qwen-image-forge 的改图规则，把上述意图改写成一段完整的 Qwen 图像编辑提示词，不要直接照抄气泡文字。',
    '3. 改写完成后调用 qwen_image_edit：images 只使用上面的原始编辑目标路径，不要使用标注预览；count 设为 1。',
    '4. 如果画板 id 已给出，调用时带上同一个 board id，让新图落在原画板并保留来源关系。',
  ].join('\n')
}

/** Copy/fallback text when the host cannot create a conversation image draft. */
export function annotationClipboardPrompt(input: AnnotationHandoffInput): string {
  return annotationHandoffPrompt(input)
}