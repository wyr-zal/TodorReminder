import { MouseEvent, MutableRefObject } from 'react'

export type ImageCopyState = 'idle' | 'copying' | 'success' | 'error'
export type ImageCopyKind = 'path' | 'image'

export interface ImageCopyFeedback {
  state: ImageCopyState
  kind: ImageCopyKind
}

// 默认点击复制的是图片路径，所以空闲态以 path 呈现
export const IDLE_IMAGE_COPY: ImageCopyFeedback = { state: 'idle', kind: 'path' }

const FEEDBACK_RESET_MS = 1500

export function getImageCopyTitle({ state, kind }: ImageCopyFeedback): string {
  if (state === 'copying') return '复制中'
  if (state === 'success') return kind === 'path' ? '路径已复制' : '图片已复制'
  if (state === 'error') return '复制失败'
  return '复制路径｜Shift 图片'
}

/** 默认复制图片路径（带引号），Shift 点击复制图片本身 */
export async function copyImageFromEvent(
  filename: string,
  event: MouseEvent,
  setFeedback: (feedback: ImageCopyFeedback) => void,
  timerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>
) {
  event.stopPropagation()

  if (timerRef.current) {
    clearTimeout(timerRef.current)
    timerRef.current = null
  }

  const kind: ImageCopyKind = event.shiftKey ? 'image' : 'path'
  setFeedback({ state: 'copying', kind })

  try {
    const success = kind === 'image'
      ? await window.electronAPI.image.copy(filename)
      : await window.electronAPI.image.copyPath(filename)
    setFeedback({ state: success ? 'success' : 'error', kind })
  } catch (error) {
    console.error('Failed to copy image:', error)
    setFeedback({ state: 'error', kind })
  }

  timerRef.current = setTimeout(() => {
    setFeedback(IDLE_IMAGE_COPY)
    timerRef.current = null
  }, FEEDBACK_RESET_MS)
}

export function ImageCopyIcon({
  state,
  kind,
  iconClassName = 'w-3.5 h-3.5'
}: ImageCopyFeedback & { iconClassName?: string }) {
  if (state === 'success') {
    return (
      <svg className={iconClassName} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 13l4 4L19 7" />
      </svg>
    )
  }

  if (state === 'error') {
    return (
      <svg className={iconClassName} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    )
  }

  // Shift 复制的是图片本身，换成图片图标与默认的复制图标区分
  if (kind === 'image') {
    return (
      <svg className={iconClassName} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="M21 15l-5-5L5 21" />
      </svg>
    )
  }

  return (
    <svg className={iconClassName} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V5a2 2 0 00-2-2H5a2 2 0 00-2 2v9a2 2 0 002 2h3" />
    </svg>
  )
}
