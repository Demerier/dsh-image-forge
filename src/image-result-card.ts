/** The canonical interactive conversation result card. */
import { createElement, useEffect, useState, type ReactNode } from 'react'
import {
  boardItemIdForImage,
  imageBytesLabel,
  imageResultFacts,
  imageResultTitle,
  type ResultImageEntry,
} from './image-result-model.ts'
import { studioFileUrl } from './studio-shared.ts'

/** What the tool row contributes to the card. */
export interface ImageResultCardProps {
  readonly phase?: string
  readonly toolName: string
  readonly payload: Record<string, unknown> | undefined
  readonly loadImage?: (path: string) => unknown
  readonly sessionId?: string
  readonly onOpenEditor?: (meta: {
    readonly imagePath: string
    readonly title: string
    readonly boardId?: string
    readonly itemId?: string
    readonly width?: number
    readonly height?: number
  }) => void
}

/** Resolve the host loader, falling back to the plugin's same-origin route. */
function imageUrl(path: string, loader: ((path: string) => unknown) | undefined): string {
  const loaded = typeof loader === 'function' ? loader(path) : undefined
  return typeof loaded === 'string' && loaded.length > 0 ? loaded : studioFileUrl(path)
}

/** One-run rich card: a hero image, a gallery, metadata and semantic actions. */
export function ImageResultCard(props: ImageResultCardProps): ReactNode {
  const facts = imageResultFacts(props.payload)
  const [selected, setSelected] = useState(0)
  const [copied, setCopied] = useState<string | undefined>(undefined)
  const signature = facts.images.map((image) => image.path).join('|')
  useEffect(() => {
    setSelected(0)
    setCopied(undefined)
  }, [signature])
  if (facts.images.length === 0) return null
  const selectedIndex = Math.min(selected, facts.images.length - 1)
  const image = facts.images[selectedIndex] as ResultImageEntry
  const itemId = boardItemIdForImage(props.payload, selectedIndex)
  const title = imageResultTitle(facts.prompt, props.toolName === 'qwen_image_edit' ? '参考图编辑' : '生成的图片')
  const isEdit = props.toolName === 'qwen_image_edit'
  const running = props.phase !== 'result'
  const copy = (kind: 'path' | 'prompt', text: string): void => {
    try {
      void navigator.clipboard.writeText(text)
      setCopied(kind)
      setTimeout(() => setCopied(undefined), 1600)
    } catch {
      setCopied(undefined)
    }
  }
  const openEditor = (): void => {
    props.onOpenEditor?.({
      imagePath: image.path,
      title,
      ...(facts.boardId === undefined ? {} : { boardId: facts.boardId }),
      ...(itemId === undefined ? {} : { itemId }),
      ...(image.width === undefined ? {} : { width: image.width }),
      ...(image.height === undefined ? {} : { height: image.height }),
    })
  }
  const chips: ReactNode[] = []
  if (facts.model !== undefined) chips.push(createElement('span', { key: 'model', className: 'dsh-image-forge-result-chip' }, facts.model))
  if (facts.ratio !== undefined) chips.push(createElement('span', { key: 'ratio', className: 'dsh-image-forge-result-chip' }, facts.ratio))
  if (facts.size !== undefined) chips.push(createElement('span', { key: 'size', className: 'dsh-image-forge-result-chip' }, `${String(facts.size.width)}×${String(facts.size.height)}`))
  if (facts.steps !== undefined) chips.push(createElement('span', { key: 'steps', className: 'dsh-image-forge-result-chip' }, `${String(facts.steps)} steps`))
  if (facts.seed !== undefined) chips.push(createElement('span', { key: 'seed', className: 'dsh-image-forge-result-chip' }, `seed ${String(facts.seed)}`))
  const bytes = imageBytesLabel(image.bytes)
  if (bytes !== undefined) chips.push(createElement('span', { key: 'bytes', className: 'dsh-image-forge-result-chip' }, bytes))

  return createElement('article', {
    className: `dsh-image-forge-result-card${running ? ' is-running' : ''}`,
    'data-image-count': String(facts.images.length),
    'data-result-tool': props.toolName,
  }, [
    createElement('header', { key: 'head', className: 'dsh-image-forge-result-head' }, [
      createElement('div', { key: 'identity', className: 'dsh-image-forge-result-identity' }, [
        createElement('span', { key: 'mark', className: 'dsh-image-forge-result-mark', 'aria-hidden': 'true' }, 'F'),
        createElement('div', { key: 'copy', className: 'dsh-image-forge-result-copy' }, [
          createElement('span', { key: 'eyebrow', className: 'dsh-image-forge-result-eyebrow' }, isEdit ? '参考图编辑' : '生成结果'),
          createElement('strong', { key: 'title', className: 'dsh-image-forge-result-title' }, title),
        ]),
      ]),
      createElement('span', {
        key: 'status',
        className: 'dsh-image-forge-result-status',
        role: 'status',
        'data-running': running ? 'true' : 'false',
      }, running ? (isEdit ? '正在改图…' : '正在生成…') : `完成 · ${String(facts.images.length)} 张`),
    ]),
    createElement('div', {
      key: 'hero',
      className: 'dsh-image-forge-result-hero',
    }, [
      createElement('button', {
        key: 'image',
        type: 'button',
        className: 'dsh-image-forge-result-open',
        'aria-label': `打开 ${title} 的画面编辑侧栏`,
        disabled: props.onOpenEditor === undefined,
        onClick: openEditor,
      }, createElement('img', {
        src: imageUrl(image.path, props.loadImage),
        alt: title,
        loading: 'lazy',
      })),
      createElement('div', { key: 'badge', className: 'dsh-image-forge-result-variant' }, `第 ${String(selectedIndex + 1)} 版 · ${String(facts.images.length)}`),
      props.onOpenEditor === undefined
        ? null
        : createElement('button', {
            key: 'annotate',
            type: 'button',
            className: 'dsh-image-forge-result-annotate',
            onClick: openEditor,
          }, '在侧栏标注'),
      running
        ? createElement('div', { key: 'shimmer', className: 'dsh-image-forge-result-shimmer', 'aria-hidden': 'true' })
        : null,
    ]),
    chips.length === 0
      ? null
      : createElement('div', { key: 'chips', className: 'dsh-image-forge-result-chips' }, chips),
    facts.images.length > 1
      ? createElement('div', { key: 'thumbs', className: 'dsh-image-forge-result-thumbs', role: 'tablist', 'aria-label': '同一批次的图片' },
          ...facts.images.map((entry, index) => createElement('button', {
            key: `${String(index)}-${entry.path}`,
            type: 'button',
            role: 'tab',
            'aria-selected': index === selectedIndex,
            className: index === selectedIndex
              ? 'dsh-image-forge-result-thumb is-active'
              : 'dsh-image-forge-result-thumb',
            onClick: () => setSelected(index),
          }, createElement('img', {
            src: imageUrl(entry.path, props.loadImage),
            alt: `第 ${String(index + 1)} 张`,
            loading: 'lazy',
          }))))
      : null,
    createElement('footer', { key: 'foot', className: 'dsh-image-forge-result-foot' }, [
      props.onOpenEditor === undefined
        ? createElement('span', { key: 'fallback', className: 'dsh-image-forge-result-note' }, '结果卡已生成；当前宿主未安装 Better Sidebar。')
        : createElement('button', {
            key: 'primary',
            type: 'button',
            className: 'dsh-image-forge-result-primary',
            onClick: openEditor,
          }, '继续调整画面'),
      createElement('div', { key: 'secondary', className: 'dsh-image-forge-result-secondary' }, [
        createElement('button', {
          key: 'path',
          type: 'button',
          className: 'dsh-image-forge-result-link',
          onClick: () => copy('path', image.path),
        }, copied === 'path' ? '已复制路径' : '复制路径'),
        facts.prompt === undefined
          ? null
          : createElement('button', {
              key: 'prompt',
              type: 'button',
              className: 'dsh-image-forge-result-link',
              onClick: () => copy('prompt', facts.prompt ?? ''),
            }, copied === 'prompt' ? '已复制提示词' : '复制提示词'),
      ]),
    ]),
  ])
}