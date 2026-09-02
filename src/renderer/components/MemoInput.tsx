import { useState, useRef, useEffect, RefObject, KeyboardEvent, ClipboardEvent } from 'react'
import { useMemoStore } from '../store/memoStore'
import { Priority } from '../../shared/types'
import { formatMemoText, insertTextAtSelection } from '../../shared/memoClipboard'
import {
  readStructuredMemoClipboard,
  restoreTextareaSelection,
  saveClipboardImages
} from '../utils/memoPaste'
import { thumbImageUrl } from '../utils/imageUrl'

interface MemoInputProps {
  inputRef: RefObject<HTMLTextAreaElement>
  textareaMaxHeight?: number
}

const priorityConfig: Record<Priority, { label: string; barClass: string; textClass: string }> = {
  high:   { label: '高优先', barClass: 'priority-bar-high',   textClass: 'text-rose-500' },
  medium: { label: '中优先', barClass: 'priority-bar-medium', textClass: 'text-amber-500' },
  low:    { label: '低优先', barClass: 'priority-bar-low',    textClass: 'text-emerald-500' }
}

function parseTagsFromContent(text: string): { content: string; tags: string[] } {
  const tagRegex = /#([一-龥\w]+)/g
  const tags: string[] = []
  let match
  while ((match = tagRegex.exec(text)) !== null) {
    tags.push(match[1])
  }
  const content = text.replace(tagRegex, '').trim()
  return { content, tags: [...new Set(tags)] }
}

function MemoInput({ inputRef, textareaMaxHeight = 120 }: MemoInputProps) {
  const [content, setContent] = useState('')
  const [priority, setPriority] = useState<Priority>('medium')
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const { addMemo, addImageMemo } = useMemoStore()

  const handleSubmit = async () => {
    if (!content.trim() && pendingImages.length === 0) return

    const { content: cleanContent, tags } = parseTagsFromContent(content)

    if (pendingImages.length > 0) {
      await addImageMemo(cleanContent, priority, pendingImages, tags)
      setPendingImages([])
    } else {
      addMemo(cleanContent, priority, tags)
    }
    setContent('')
    inputRef.current?.focus()
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      cyclePriority()
    } else if (e.key === 'Escape') {
      setContent('')
      setPendingImages([])
      inputRef.current?.blur()
    }
  }

  const handlePaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const textarea = e.currentTarget
    const selectionStart = textarea.selectionStart
    const selectionEnd = textarea.selectionEnd
    const structuredMemo = readStructuredMemoClipboard(e.clipboardData)

    if (structuredMemo) {
      e.preventDefault()
      const pastedText = formatMemoText(
        structuredMemo.payload.content,
        structuredMemo.payload.tags
      )
      const insertion = insertTextAtSelection(
        content,
        pastedText,
        selectionStart,
        selectionEnd
      )
      const shouldRestorePriority = content.trim().length === 0 && pendingImages.length === 0

      setContent(insertion.value)
      if (shouldRestorePriority) {
        setPriority(structuredMemo.payload.priority)
      }
      restoreTextareaSelection(textarea, insertion.caret)

      const filenames = await saveClipboardImages(structuredMemo.images)
      if (filenames.length > 0) {
        setPendingImages((previous) => [...previous, ...filenames])
      }
      return
    }

    const types = e.clipboardData?.types || []
    const hasImage = types.some(type =>
      type === 'image/png' || type === 'image/jpeg' || type === 'image/gif' || type === 'Files'
    )
    if (!hasImage) return

    e.preventDefault()
    const pastedText = e.clipboardData.getData('text/plain')
    const insertion = insertTextAtSelection(
      content,
      pastedText,
      selectionStart,
      selectionEnd
    )
    if (pastedText) {
      setContent(insertion.value)
      restoreTextareaSelection(textarea, insertion.caret)
    }

    const filename = await window.electronAPI.image.pasteFromClipboard()
    if (filename) {
      setPendingImages(prev => [...prev, filename])
    }
  }

  const cyclePriority = () => {
    const priorities: Priority[] = ['high', 'medium', 'low']
    const currentIndex = priorities.indexOf(priority)
    setPriority(priorities[(currentIndex + 1) % 3])
  }

  const removePendingImage = (filename: string) => {
    window.electronAPI.image.delete(filename)
    setPendingImages(prev => prev.filter(f => f !== filename))
  }

  const openPendingImage = (filename: string) => {
    window.electronAPI.image.openExternal(filename)
  }

  const cfg = priorityConfig[priority]

  return (
    <div className="h-full flex flex-col px-3 py-2.5 border-b border-slate-100 bg-white">
      {/* 待添加的图片预览 */}
      {pendingImages.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5 flex-shrink-0">
          {pendingImages.map((filename) => (
            <div key={filename} className="relative inline-block">
              <ImagePreview
                filename={filename}
                className="max-h-11 rounded-md object-cover cursor-pointer hover:opacity-85 transition-opacity"
                onClick={() => openPendingImage(filename)}
              />
              <button
                onClick={() => removePendingImage(filename)}
                className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-slate-700 text-white rounded-full text-[10px] flex items-center justify-center hover:bg-slate-900 transition-colors cursor-pointer"
              >
                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-stretch gap-2 flex-1 min-h-0">
        {/* 优先级竖条 + 点击切换 */}
        <button
          onClick={cyclePriority}
          className="flex-shrink-0 flex flex-col items-center justify-start pt-2 cursor-pointer group"
          title={`优先级: ${cfg.label}（Tab 切换）`}
        >
          <div className={`w-1 h-6 rounded-full ${cfg.barClass} transition-all duration-200 group-hover:h-7`} />
        </button>

        {/* 输入框：撑满整个面板高度 */}
        <textarea
          ref={inputRef as RefObject<HTMLTextAreaElement>}
          value={content}
          onChange={(e) => {
            const cleaned = e.target.value.replace(/\n{2,}/g, '\n')
            setContent(cleaned)
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={pendingImages.length > 0 ? '添加说明… Enter 保存' : '记录想法… Tab 切换优先级'}
          className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/25 focus:border-indigo-400 focus:bg-white transition-all resize-none font-inter w-full"
          style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        />

        {/* 提交按钮 */}
        {(content || pendingImages.length > 0) && (
          <button
            onClick={handleSubmit}
            className="flex-shrink-0 w-8 h-8 mt-0.5 bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 active:scale-95 transition-all flex items-center justify-center cursor-pointer"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 4v16m8-8H4" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}

function ImagePreview({
  filename,
  className,
  onClick
}: {
  filename: string
  className?: string
  onClick?: () => void
}) {
  return <img src={thumbImageUrl(filename)} alt="" className={className} onClick={onClick} />
}

export default MemoInput
