import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { Memo, MemoStatus, Priority } from '../../shared/types'
import { formatMemoText, insertTextAtSelection } from '../../shared/memoClipboard'
import { useMemoStore } from '../store/memoStore'
import {
  readStructuredMemoClipboard,
  restoreTextareaSelection,
  saveClipboardImages
} from '../utils/memoPaste'
import { thumbImageUrl, fullImageUrl } from '../utils/imageUrl'

interface MemoItemProps {
  memo: Memo
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

const priorityBar: Record<Priority, string> = {
  high:   'priority-bar-high',
  medium: 'priority-bar-medium',
  low:    'priority-bar-low'
}

const priorityText: Record<Priority, string> = {
  high:   'text-rose-500',
  medium: 'text-amber-500',
  low:    'text-emerald-500'
}

const priorityLabel: Record<Priority, string> = {
  high: '高', medium: '中', low: '低'
}

type CopyState = 'idle' | 'copying' | 'success' | 'partial' | 'error'
type ImageCopyState = 'idle' | 'copying' | 'success' | 'error'

function StatusIcon({ status }: { status: MemoStatus }) {
  if (status === 'completed') {
    return (
      <div className="w-5 h-5 rounded-full bg-indigo-500 border-2 border-indigo-500 flex items-center justify-center">
        <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 13l4 4L19 7" />
        </svg>
      </div>
    )
  }
  if (status === 'deferred') {
    return (
      <div className="w-5 h-5 rounded-full border-2 border-amber-400 bg-amber-50 flex items-center justify-center">
        <svg className="w-2.5 h-2.5 text-amber-500" fill="currentColor" viewBox="0 0 24 24">
          <rect x="6" y="5" width="4" height="14" rx="1" />
          <rect x="14" y="5" width="4" height="14" rx="1" />
        </svg>
      </div>
    )
  }
  return (
    <div className="w-5 h-5 rounded-full border-2 border-slate-300 hover:border-indigo-400 transition-colors" />
  )
}

function MemoItem({ memo }: MemoItemProps) {
  const memoContent = memo.type === 'image' && memo.content === '图片备忘' ? '' : memo.content
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState(memoContent)
  const [editAttachments, setEditAttachments] = useState<string[]>(memo.attachments || [])
  const [showImagePreview, setShowImagePreview] = useState(false)
  const [previewImageIndex, setPreviewImageIndex] = useState(0)
  const [showPriorityMenu, setShowPriorityMenu] = useState(false)
  const [menuAbove, setMenuAbove] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(false)
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const priorityMenuRef = useRef<HTMLDivElement>(null)
  const priorityBtnRef = useRef<HTMLButtonElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const editTextareaRef = useRef<HTMLTextAreaElement>(null)
  const { toggleStatus, updateMemo, deleteMemo } = useMemoStore()

  // pendingDelete 3秒后自动取消
  useEffect(() => {
    if (pendingDelete) {
      deleteTimerRef.current = setTimeout(() => setPendingDelete(false), 3000)
    }
    return () => {
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    }
  }, [pendingDelete])

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    }
  }, [])

  const getScrollParent = (element: HTMLElement | null) => {
    let parent = element?.parentElement
    while (parent) {
      const { overflowY } = window.getComputedStyle(parent)
      if ((overflowY === 'auto' || overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) {
        return parent
      }
      parent = parent.parentElement
    }
    return null
  }

  const adjustEditHeight = () => {
    const textarea = editTextareaRef.current
    if (!textarea) return

    const scrollParent = getScrollParent(textarea)
    const scrollTop = scrollParent?.scrollTop ?? 0

    textarea.style.height = 'auto'
    const nextHeight = `${Math.max(32, textarea.scrollHeight)}px`
    if (textarea.style.height !== nextHeight) {
      textarea.style.height = nextHeight
    }

    if (scrollParent && scrollParent.scrollTop !== scrollTop) {
      scrollParent.scrollTop = scrollTop
    }
  }

  useLayoutEffect(() => {
    if (isEditing) adjustEditHeight()
  }, [isEditing, editContent])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (priorityMenuRef.current && !priorityMenuRef.current.contains(e.target as Node)) {
        setShowPriorityMenu(false)
      }
    }
    if (showPriorityMenu) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showPriorityMenu])

  const handlePriorityChange = (p: Priority) => {
    updateMemo(memo.id, { priority: p })
    setShowPriorityMenu(false)
  }

  const handlePriorityClick = () => {
    if (!showPriorityMenu && priorityBtnRef.current) {
      const rect = priorityBtnRef.current.getBoundingClientRect()
      setMenuAbove(window.innerHeight - rect.bottom < 120)
    }
    setShowPriorityMenu(!showPriorityMenu)
  }

  const handleSave = () => {
    if (editContent.trim() || editAttachments.length > 0) {
      const { content, tags } = parseTagsFromContent(editContent)
      updateMemo(memo.id, {
        content: editAttachments.length > 0 ? content : content || memo.content,
        tags,
        attachments: editAttachments,
        type: editAttachments.length > 0 ? 'image' : 'text'
      })
    }
    setIsEditing(false)
  }

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      const base64 = reader.result as string
      const filename = await window.electronAPI.image.save(base64)
      if (filename) setEditAttachments(prev => [...prev, filename])
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const handlePasteImage = async () => {
    const filename = await window.electronAPI.image.pasteFromClipboard()
    if (filename) setEditAttachments(prev => [...prev, filename])
  }

  const removeEditAttachment = (filename: string) => {
    setEditAttachments(prev => prev.filter(f => f !== filename))
  }

  const handleEditPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
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
        editContent,
        pastedText,
        selectionStart,
        selectionEnd
      )

      setEditContent(insertion.value)
      restoreTextareaSelection(textarea, insertion.caret)

      const filenames = await saveClipboardImages(structuredMemo.images)
      if (filenames.length > 0) {
        setEditAttachments((previous) => [...previous, ...filenames])
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
      editContent,
      pastedText,
      selectionStart,
      selectionEnd
    )
    if (pastedText) {
      setEditContent(insertion.value)
      restoreTextareaSelection(textarea, insertion.caret)
    }

    const filename = await window.electronAPI.image.pasteFromClipboard()
    if (filename) setEditAttachments(prev => [...prev, filename])
  }

  const handleCopy = async (event: React.MouseEvent<HTMLButtonElement>) => {
    if (copyState === 'copying') return
    const copyForCli = event.shiftKey

    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current)
      copyTimerRef.current = null
    }
    setCopyState('copying')

    try {
      const request = {
        content: memoContent,
        priority: memo.priority,
        tags: memo.tags || [],
        attachments: memo.attachments || []
      }
      const result = copyForCli
        ? await window.electronAPI.clipboard.copyMemoForCli(request)
        : await window.electronAPI.clipboard.copyMemo(request)

      if (!result.success) {
        setCopyState('error')
      } else if (result.missingImageCount > 0) {
        setCopyState('partial')
      } else {
        setCopyState('success')
      }
    } catch (error) {
      console.error('Failed to copy memo:', error)
      setCopyState('error')
    }

    copyTimerRef.current = setTimeout(() => {
      setCopyState('idle')
      copyTimerRef.current = null
    }, 1500)
  }

  const cancelEditing = () => {
    setEditContent(memoContent)
    setEditAttachments(memo.attachments || [])
    setIsEditing(false)
  }

  const startEditing = () => {
    const tagsStr = (memo.tags || []).map(t => `#${t}`).join(' ')
    setEditContent(memoContent + (tagsStr ? ' ' + tagsStr : ''))
    setEditAttachments(memo.attachments || [])
    setIsEditing(true)
  }

  const formatTime = (isoString: string) => {
    const date = new Date(isoString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)
    if (diffMins < 1) return '刚刚'
    if (diffMins < 60) return `${diffMins}m`
    if (diffHours < 24) return `${diffHours}h`
    if (diffDays < 7) return `${diffDays}d`
    return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
  }

  const hasImage = memo.type === 'image' && memo.attachments.length > 0
  // 虚拟列表滚动时条目会重新挂载，入场动画只给新建的备忘播放
  const isFreshMemo = Date.now() - new Date(memo.createdAt).getTime() < 1500
  const copyLabel = copyState === 'copying'
    ? '正在复制待办'
    : copyState === 'success'
      ? '待办已复制'
      : copyState === 'partial'
        ? '待办已复制，部分图片不可用'
        : copyState === 'error'
          ? '复制待办失败'
          : '复制整条待办'
  const copyTitle = `${copyLabel}；Shift 点击复制图片路径给 CLI`
  const copyButtonClass = copyState === 'success'
    ? 'text-emerald-500 bg-emerald-50'
    : copyState === 'partial'
      ? 'text-amber-500 bg-amber-50'
      : copyState === 'error'
        ? 'text-rose-500 bg-rose-50'
        : 'text-slate-400 hover:text-indigo-500 hover:bg-indigo-50'

  return (
    <>
      <div
        className={`group relative flex gap-2.5 px-3 py-2.5 bg-white rounded-xl border border-slate-100 shadow-card hover:border-slate-200 hover:shadow-card-hover transition-all duration-200 ${
          isFreshMemo ? 'animate-card-in' : ''
        } ${
          memo.status === 'completed' ? 'opacity-55' : ''
        }`}
      >
        {/* 左侧优先级竖条 */}
        <div className={`absolute left-0 top-3 bottom-3 w-0.5 rounded-full ${priorityBar[memo.priority]}`} />

        {/* 状态按钮 */}
        <button
          onClick={() => toggleStatus(memo.id)}
          className="flex-shrink-0 mt-0.5 cursor-pointer"
          title="切换状态"
        >
          <StatusIcon status={memo.status} />
        </button>

        {/* 内容区域 */}
        <div className="flex-1 min-w-0">
          {isEditing ? (
            <div className="space-y-2">
              <div className="flex items-start gap-2">
                <textarea
                  ref={editTextareaRef}
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSave() }
                    else if (e.key === 'Escape') cancelEditing()
                  }}
                  onPaste={handleEditPaste}
                  className="flex-1 min-w-0 px-2.5 py-1.5 text-sm text-slate-800 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/25 focus:border-indigo-400 resize-none overflow-hidden"
                  style={{ minHeight: '32px', whiteSpace: 'pre-wrap' }}
                  autoFocus
                />
                <div className="flex-shrink-0 flex flex-col items-center gap-0.5">
                  <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageSelect} className="hidden" />
                  <button
                    type="button"
                    onClick={handleSave}
                    className="p-1.5 text-indigo-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-colors cursor-pointer"
                    aria-label="保存待办"
                    title="保存"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="p-1.5 text-slate-400 hover:text-indigo-500 hover:bg-indigo-50 rounded-md transition-colors cursor-pointer"
                    aria-label="添加图片"
                    title="添加图片"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <path d="M21 15l-5-5L5 21" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={cancelEditing}
                    className="p-1.5 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-md transition-colors cursor-pointer"
                    aria-label="取消编辑"
                    title="取消"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>
              </div>
              {editAttachments.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {editAttachments.map((filename) => (
                    <EditImagePreview key={filename} filename={filename} onRemove={() => removeEditAttachment(filename)} />
                  ))}
                </div>
              )}
            </div>
          ) : memoContent ? (
            <p
              className={`text-sm leading-relaxed break-words cursor-pointer whitespace-pre-wrap ${
                memo.status === 'completed' ? 'line-through text-slate-400' : 'text-slate-800'
              }`}
              onDoubleClick={startEditing}
            >
              {memoContent}
            </p>
          ) : null}

          {/* 图片附件 */}
          {!isEditing && hasImage && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {memo.attachments.map((filename, index) => (
                <ImageThumbnail
                  key={filename}
                  filename={filename}
                  onPreview={() => { setPreviewImageIndex(index); setShowImagePreview(true) }}
                />
              ))}
            </div>
          )}

          {/* 标签 */}
          {memo.tags && memo.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {memo.tags.map(tag => (
                <span
                  key={tag}
                  className="px-1.5 py-0.5 text-[11px] bg-slate-100 text-slate-500 rounded-md tracking-wide"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}

          {/* 时间 */}
          <p className="text-[11px] text-slate-400 mt-1 tracking-wide">
            {formatTime(memo.updatedAt)}
          </p>
        </div>

        {/* 右侧操作区（常驻显示） */}
        <div className="flex-shrink-0 flex flex-col items-end gap-0.5">
          {pendingDelete ? (
            // 删除确认态
            <div className="flex flex-col gap-1 items-end">
              <button
                onClick={() => deleteMemo(memo.id)}
                className="px-2 py-0.5 text-[11px] bg-rose-500 hover:bg-rose-600 text-white rounded-md transition-colors cursor-pointer whitespace-nowrap"
              >
                确认删除
              </button>
              <button
                onClick={() => setPendingDelete(false)}
                className="px-2 py-0.5 text-[11px] text-slate-400 hover:text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors cursor-pointer"
              >
                取消
              </button>
            </div>
          ) : (
            <>
              {/* 复制整条待办 */}
              <button
                type="button"
                onClick={handleCopy}
                disabled={copyState === 'copying'}
                aria-label={copyLabel}
                title={copyTitle}
                className={`p-1.5 rounded-md transition-colors active:scale-95 cursor-pointer disabled:cursor-wait disabled:active:scale-100 ${copyButtonClass}`}
              >
                {copyState === 'success' ? (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                ) : copyState === 'partial' ? (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v6M12 17h.01" />
                  </svg>
                ) : copyState === 'error' ? (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="8" y="8" width="11" height="11" rx="2" />
                    <path d="M16 8V5a2 2 0 00-2-2H5a2 2 0 00-2 2v9a2 2 0 002 2h3" />
                  </svg>
                )}
              </button>

              {/* 优先级 */}
              <div className="relative" ref={priorityMenuRef}>
                <button
                  ref={priorityBtnRef}
                  onClick={handlePriorityClick}
                  className={`p-1.5 rounded-md hover:bg-slate-100 transition-colors cursor-pointer ${priorityText[memo.priority]}`}
                  aria-label="修改优先级"
                  title="修改优先级"
                >
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16">
                    <rect x="2" y="2" width="3" height="12" rx="1" />
                    <rect x="7" y="5" width="3" height="9" rx="1" />
                    <rect x="12" y="8" width="3" height="6" rx="1" />
                  </svg>
                </button>

                {showPriorityMenu && (
                  <div className={`absolute right-0 bg-white rounded-xl shadow-lg border border-slate-100 py-1 z-20 min-w-[72px] ${menuAbove ? 'bottom-6' : 'top-6'}`}>
                    {(['high', 'medium', 'low'] as Priority[]).map((p) => (
                      <button
                        key={p}
                        onClick={() => handlePriorityChange(p)}
                        className={`w-full px-3 py-1.5 text-left text-[12px] hover:bg-slate-50 flex items-center gap-2 cursor-pointer ${
                          memo.priority === p ? 'bg-slate-50' : ''
                        }`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${priorityBar[p]}`} />
                        <span className={priorityText[p]}>{priorityLabel[p]}</span>
                        {memo.priority === p && (
                          <svg className="w-3 h-3 text-indigo-400 ml-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* 删除（进入确认态） */}
              <button
                onClick={() => setPendingDelete(true)}
                className="p-1.5 text-slate-400 hover:text-rose-500 rounded-md hover:bg-rose-50 transition-colors cursor-pointer"
                aria-label="删除待办"
                title="删除"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                </svg>
              </button>
            </>
          )}
          <span className="sr-only" aria-live="polite">{copyState === 'idle' ? '' : copyLabel}</span>
        </div>
      </div>

      {/* 图片大图预览 */}
      {showImagePreview && hasImage && (
        <ImageModal
          attachments={memo.attachments}
          initialIndex={previewImageIndex}
          onClose={() => setShowImagePreview(false)}
        />
      )}
    </>
  )
}

function ImageCopyIcon({ state }: { state: ImageCopyState }) {
  if (state === 'success') {
    return (
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 13l4 4L19 7" />
      </svg>
    )
  }

  if (state === 'error') {
    return (
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    )
  }

  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V5a2 2 0 00-2-2H5a2 2 0 00-2 2v9a2 2 0 002 2h3" />
    </svg>
  )
}

function PreviewInWindowIcon() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </svg>
  )
}

function SaveImageIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  )
}

function getImageCopyTitle(state: ImageCopyState): string {
  if (state === 'copying') return '正在复制图片'
  if (state === 'success') return '图片已复制'
  if (state === 'error') return '复制图片失败'
  return '复制图片；Shift 点击复制图片路径给 CLI'
}

async function copyImageFromEvent(
  filename: string,
  event: React.MouseEvent,
  setState: (state: ImageCopyState) => void,
  timerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>
) {
  event.stopPropagation()

  if (timerRef.current) {
    clearTimeout(timerRef.current)
    timerRef.current = null
  }

  setState('copying')

  try {
    const success = event.shiftKey
      ? await window.electronAPI.image.copyPath(filename)
      : await window.electronAPI.image.copy(filename)
    setState(success ? 'success' : 'error')
  } catch (error) {
    console.error('Failed to copy image:', error)
    setState('error')
  }

  timerRef.current = setTimeout(() => {
    setState('idle')
    timerRef.current = null
  }, 1500)
}

function ImageThumbnail({ filename, onPreview }: { filename: string; onPreview: () => void }) {
  const [imageCopyState, setImageCopyState] = useState<ImageCopyState>('idle')
  const imageCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (imageCopyTimerRef.current) clearTimeout(imageCopyTimerRef.current)
    }
  }, [])

  const handleOpenExternal = async () => {
    const opened = await window.electronAPI.image.openExternal(filename)
    if (!opened) onPreview()
  }

  const copyTitle = getImageCopyTitle(imageCopyState)
  const copyClass = imageCopyState === 'success'
    ? 'bg-emerald-500 text-white opacity-100'
    : imageCopyState === 'error'
      ? 'bg-rose-500 text-white opacity-100'
      : 'bg-slate-900/70 text-white opacity-0 group-hover/img:opacity-100 hover:bg-indigo-500'
  const actionClass = 'w-6 h-6 rounded-full shadow-md flex items-center justify-center transition-all active:scale-95 cursor-pointer opacity-0 group-hover/img:opacity-100'

  return (
    <div className="relative group/img inline-flex">
      <img
        src={thumbImageUrl(filename)}
        alt=""
        className="max-h-16 rounded-lg cursor-pointer hover:opacity-85 transition-opacity object-cover"
        onClick={handleOpenExternal}
      />
      <div className="absolute -top-1 -right-1 flex flex-col gap-1">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onPreview()
          }}
          aria-label="在窗口内预览图片"
          title="在窗口内预览图片"
          className={`${actionClass} bg-white text-slate-600 hover:text-indigo-600 hover:bg-white`}
        >
          <PreviewInWindowIcon />
        </button>
        <button
          type="button"
          onClick={(event) => copyImageFromEvent(filename, event, setImageCopyState, imageCopyTimerRef)}
          disabled={imageCopyState === 'copying'}
          aria-label={copyTitle}
          title={copyTitle}
          className={`${actionClass} disabled:cursor-wait ${copyClass}`}
        >
          <ImageCopyIcon state={imageCopyState} />
        </button>
      </div>
    </div>
  )
}

function EditImagePreview({ filename, onRemove }: { filename: string; onRemove: () => void }) {
  return (
    <div className="relative group/img">
      <img src={thumbImageUrl(filename)} alt="" className="w-12 h-12 object-cover rounded-lg" />
      <button
        type="button"
        onClick={onRemove}
        className="absolute -top-1 -right-1 w-4 h-4 bg-slate-700 text-white rounded-full text-[10px] flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity cursor-pointer"
      >
        <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3" strokeLinecap="round">
          <path d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

function ImageModal({ attachments, initialIndex, onClose }: { attachments: string[]; initialIndex: number; onClose: () => void }) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex)
  const [imageCopyState, setImageCopyState] = useState<ImageCopyState>('idle')
  const imageCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentFilename = attachments[currentIndex]
  const hasMultiple = attachments.length > 1

  useEffect(() => {
    setImageCopyState('idle')
  }, [currentFilename])

  useEffect(() => {
    return () => {
      if (imageCopyTimerRef.current) clearTimeout(imageCopyTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') setCurrentIndex(prev => prev > 0 ? prev - 1 : attachments.length - 1)
      else if (e.key === 'ArrowRight') setCurrentIndex(prev => prev < attachments.length - 1 ? prev + 1 : 0)
      else if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [attachments.length, onClose])

  const handleSave = async (e: React.MouseEvent) => {
    e.stopPropagation()
    await window.electronAPI.image.saveToFile(currentFilename)
  }

  const handleCopy = async (e: React.MouseEvent) => {
    await copyImageFromEvent(currentFilename, e, setImageCopyState, imageCopyTimerRef)
  }

  const handlePrev = (e: React.MouseEvent) => {
    e.stopPropagation()
    setCurrentIndex(prev => prev > 0 ? prev - 1 : attachments.length - 1)
  }

  const handleNext = (e: React.MouseEvent) => {
    e.stopPropagation()
    setCurrentIndex(prev => prev < attachments.length - 1 ? prev + 1 : 0)
  }

  return (
    <div
      data-modal
      className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="relative max-w-[90%] max-h-[90%]" onClick={e => e.stopPropagation()}>
        <img src={fullImageUrl(currentFilename)} alt="" className="max-w-full max-h-full rounded-xl shadow-2xl" />

        {hasMultiple && (
          <button
            onClick={handlePrev}
            className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-12 w-9 h-9 bg-white/90 rounded-full shadow-lg flex items-center justify-center text-slate-700 hover:bg-white transition-colors cursor-pointer"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        )}

        {hasMultiple && (
          <button
            onClick={handleNext}
            className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-12 w-9 h-9 bg-white/90 rounded-full shadow-lg flex items-center justify-center text-slate-700 hover:bg-white transition-colors cursor-pointer"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}

        {hasMultiple && (
          <div className="absolute -top-9 left-1/2 -translate-x-1/2 px-3 py-1 bg-black/50 text-white text-xs rounded-full tracking-wider">
            {currentIndex + 1} / {attachments.length}
          </div>
        )}

        <div className="absolute -bottom-12 left-1/2 -translate-x-1/2 flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopy}
            disabled={imageCopyState === 'copying'}
            aria-label={getImageCopyTitle(imageCopyState)}
            title={getImageCopyTitle(imageCopyState)}
            className={`w-8 h-8 rounded-full shadow-lg flex items-center justify-center transition-colors active:scale-95 cursor-pointer disabled:cursor-wait ${
              imageCopyState === 'success'
                ? 'bg-emerald-500 text-white'
                : imageCopyState === 'error'
                  ? 'bg-rose-500 text-white'
                  : 'bg-white/90 text-slate-600 hover:text-indigo-600 hover:bg-white'
            }`}
          >
            <ImageCopyIcon state={imageCopyState} />
          </button>

          <button
            type="button"
            onClick={handleSave}
            aria-label="保存图片"
            title="保存图片"
            className="w-8 h-8 rounded-full bg-white/90 text-slate-600 shadow-lg flex items-center justify-center hover:text-indigo-600 hover:bg-white transition-colors active:scale-95 cursor-pointer"
          >
            <SaveImageIcon />
          </button>
        </div>

        <button
          onClick={onClose}
          className="absolute -top-3 -right-3 w-7 h-7 bg-white rounded-full shadow-lg flex items-center justify-center text-slate-500 hover:text-slate-800 transition-colors cursor-pointer"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5" strokeLinecap="round">
            <path d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  )
}

export default MemoItem
