import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Memo, MemoStatus, Priority } from '../../shared/types'
import { insertTextAtSelection } from '../../shared/memoClipboard'
import { useMemoStore } from '../store/memoStore'
import {
  ClipboardImageSaveError,
  readStructuredMemoClipboard,
  restoreTextareaSelection,
  saveClipboardImagesStrict
} from '../utils/memoPaste'
import { thumbImageUrl } from '../utils/imageUrl'
import {
  IDLE_IMAGE_COPY,
  ImageCopyFeedback,
  ImageCopyIcon,
  copyImageFromEvent,
  getImageCopyTitle
} from '../utils/imageCopy'

interface MemoItemProps {
  memo: Memo
  isFocused: boolean
  onToggleFocus: () => void
  onEditingChange: (memo: Memo | null, id: string) => void
}

const DEFAULT_TAG = 'TODO'
const TAG_PATTERN = /^[一-龥\w-]+$/

function normalizeTagName(value: string): string | null {
  const tag = value.trim().replace(/^#/, '')
  return TAG_PATTERN.test(tag) ? tag : null
}

const priorityBar: Record<Priority, string> = {
  important: 'priority-bar-important',
  unimportant: 'priority-bar-unimportant'
}

const priorityText: Record<Priority, string> = {
  important: 'text-red-500',
  unimportant: 'text-green-500'
}

const priorityLabel: Record<Priority, string> = {
  important: '重要', unimportant: '不重要'
}

// 长内容默认收起为 3 行，第三行由渐隐层半隐藏
// 展开状态记在模块级，避免虚拟列表滚动重挂载后丢失
const CONTENT_CLAMP_LINES = 3
const expandedMemoIds = new Set<string>()

interface AttachmentCleanupRecord {
  filenames: Set<string>
  error: string
}

const attachmentCleanupRetries = new Map<string, AttachmentCleanupRecord>()
const attachmentCleanupInProgress = new Set<string>()
const attachmentCleanupListeners = new Map<string, Set<() => void>>()

function getAttachmentCleanupRecord(memoId: string) {
  return attachmentCleanupRetries.get(memoId)
}

function notifyAttachmentCleanupChanged(memoId: string) {
  attachmentCleanupListeners.get(memoId)?.forEach(listener => listener())
}

function setAttachmentCleanupRecord(memoId: string, filenames: Iterable<string>, error: string) {
  const pendingFiles = new Set(filenames)
  if (pendingFiles.size === 0 && !error) {
    attachmentCleanupRetries.delete(memoId)
  } else {
    const record = attachmentCleanupRetries.get(memoId) ?? { filenames: new Set<string>(), error: '' }
    record.filenames = pendingFiles
    record.error = error
    attachmentCleanupRetries.set(memoId, record)
  }
  notifyAttachmentCleanupChanged(memoId)
}

type CopyState = 'idle' | 'copying' | 'success' | 'partial' | 'error'

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
  if (status === 'in_progress') {
    return (
      <div className="w-5 h-5 rounded-full border-2 border-indigo-400 bg-indigo-50 flex items-center justify-center">
        <svg className="w-2.5 h-2.5 text-indigo-500" fill="currentColor" viewBox="0 0 24 24">
          <path d="M8 5v14l11-7z" />
        </svg>
      </div>
    )
  }
  return (
    <div className="w-5 h-5 rounded-full border-2 border-slate-300 hover:border-indigo-400 transition-colors" />
  )
}

function MemoItem({ memo, isFocused, onToggleFocus, onEditingChange }: MemoItemProps) {
  const memoContent = memo.type === 'image' && memo.content === '图片备忘' ? '' : memo.content
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState(memoContent)
  const [editTags, setEditTags] = useState<string[]>(memo.tags || [])
  const [tagDraft, setTagDraft] = useState('')
  const [renamingTag, setRenamingTag] = useState<string | null>(null)
  const [isAddingTag, setIsAddingTag] = useState(false)
  const [tagError, setTagError] = useState('')
  const [editAttachments, setEditAttachments] = useState<string[]>(memo.attachments || [])
  const editBaseline = useRef<Memo | null>(null)
  const [editError, setEditError] = useState('')
  const [attachmentCleanupError, setAttachmentCleanupError] = useState(() => getAttachmentCleanupRecord(memo.id)?.error ?? '')
  const [editSaving, setEditSaving] = useState(false)
  const editSavingRef = useRef(false)
  const [pendingAttachmentOps, setPendingAttachmentOps] = useState(0)
  const [attachmentFocusRestoreTick, setAttachmentFocusRestoreTick] = useState(0)
  const [attachmentCleanupPending, setAttachmentCleanupPending] = useState(attachmentCleanupInProgress.has(memo.id))
  const pendingAttachmentOpsRef = useRef(0)
  const attachmentFocusRef = useRef<{ start: number; end: number } | null>(null)
  const attachmentFocusRestoreRef = useRef<{ start: number; end: number } | null>(null)
  const attachmentFocusMovedRef = useRef(false)
  const addedEditAttachmentsRef = useRef(new Set<string>())
  const discardedEditAttachmentsRef = useRef(new Set<string>())
  const [showPriorityMenu, setShowPriorityMenu] = useState(false)
  const [menuStyle, setMenuStyle] = useState<{ top?: number; bottom?: number; right: number } | null>(null)
  const [pendingDelete, setPendingDelete] = useState(false)
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const [copyKind, setCopyKind] = useState<'cli' | 'rich'>('cli')
  const [isExpanded, setIsExpanded] = useState(() => expandedMemoIds.has(memo.id))
  const [needsClamp, setNeedsClamp] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const pendingCardAnchorRef = useRef<{
    card: HTMLDivElement
    scrollParent: HTMLElement
    viewportTop: number
  } | null>(null)
  const contentRef = useRef<HTMLParagraphElement>(null)
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const priorityMenuRef = useRef<HTMLDivElement>(null)
  const priorityPopRef = useRef<HTMLDivElement>(null)
  const priorityBtnRef = useRef<HTMLButtonElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const editTextareaRef = useRef<HTMLTextAreaElement>(null)
  const lastTextareaSelectionRef = useRef<{ start: number; end: number } | null>(null)
  const { updateMemo, deleteMemo } = useMemoStore()

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

  // 记录卡片顶边在滚动视口内的位置，布局变化后对齐回原位
  const captureCardAnchor = () => {
    if (cardRef.current) {
      const scrollParent = getScrollParent(cardRef.current)
      if (scrollParent) {
        const parentRect = scrollParent.getBoundingClientRect()
        const parentStyle = window.getComputedStyle(scrollParent)
        const viewportTop = parentRect.top + scrollParent.clientTop + (parseFloat(parentStyle.paddingTop) || 0)
        pendingCardAnchorRef.current = {
          card: cardRef.current,
          scrollParent,
          viewportTop: Math.max(cardRef.current.getBoundingClientRect().top, viewportTop)
        }
      }
    }
  }

  const beginAttachmentOperation = (selection?: { start: number; end: number }) => {
    if (pendingAttachmentOpsRef.current === 0) {
      attachmentFocusMovedRef.current = false
      const requestedSelection = selection
      const textarea = editTextareaRef.current
      if (requestedSelection) {
        attachmentFocusRef.current = requestedSelection
      } else if (textarea && document.activeElement === textarea) {
        attachmentFocusRef.current = {
          start: textarea.selectionStart,
          end: textarea.selectionEnd
        }
      } else {
        attachmentFocusRef.current = lastTextareaSelectionRef.current
      }
    }
    pendingAttachmentOpsRef.current += 1
    setPendingAttachmentOps(pendingAttachmentOpsRef.current)
  }

  const endAttachmentOperation = (error?: string) => {
    const wasPending = pendingAttachmentOpsRef.current > 0
    pendingAttachmentOpsRef.current = Math.max(0, pendingAttachmentOpsRef.current - 1)
    setPendingAttachmentOps(pendingAttachmentOpsRef.current)
    if (error) setEditError(error)
    if (wasPending && pendingAttachmentOpsRef.current === 0) {
      const selection = attachmentFocusRef.current
      attachmentFocusRef.current = null
      const shouldRestoreFocus = selection && !attachmentFocusMovedRef.current
      attachmentFocusMovedRef.current = false
      if (shouldRestoreFocus && isEditing && !editSavingRef.current) {
        attachmentFocusRestoreRef.current = selection
        setAttachmentFocusRestoreTick(previous => previous + 1)
      }
    }
  }

  const deleteUncommittedAttachments = async (filenames: string[]) => {
    const results = await Promise.all(filenames.map(async filename => {
      try {
        return { filename, result: await window.electronAPI.image.delete(filename) }
      } catch (error) {
        console.error('Failed to remove uncommitted attachment:', error)
        return { filename, result: null }
      }
    }))
    return {
      deleted: results.filter(item => item.result === true).map(item => item.filename),
      retained: results.filter(item => item.result === false).map(item => item.filename),
      failed: results.filter(item => item.result === null).map(item => item.filename)
    }
  }

  // 编辑态内容高度变化（如贴入长文本）时锁住卡片视口位置：
  // 先记录卡片顶边锚点，布局后对齐，防止长内容撑高导致页面跳走
  useLayoutEffect(() => {
    const selection = attachmentFocusRestoreRef.current
    const textarea = editTextareaRef.current
    if (!selection || !textarea || pendingAttachmentOpsRef.current > 0 || editSavingRef.current) return
    attachmentFocusRestoreRef.current = null
    textarea.focus()
    textarea.setSelectionRange(selection.start, selection.end)
    lastTextareaSelectionRef.current = selection
  }, [attachmentFocusRestoreTick, isEditing, pendingAttachmentOps, editSaving])

  useLayoutEffect(() => {
    if (!isEditing) return
    const card = cardRef.current
    if (!card) return
    const heightBefore = card.getBoundingClientRect().height
    adjustEditHeight()
    const heightAfter = card.getBoundingClientRect().height
    if (Math.abs(heightAfter - heightBefore) > 1) captureCardAnchor()
  }, [isEditing, editContent])

  // 内容超过 3 行时截断：clamp 下 scrollHeight 仍是完整内容高度，统一按行高判定
  const measureClamp = () => {
    const el = contentRef.current
    if (!el) return
    const lineHeight = parseFloat(window.getComputedStyle(el).lineHeight)
    if (Number.isNaN(lineHeight)) return
    setNeedsClamp(el.scrollHeight > lineHeight * CONTENT_CLAMP_LINES + 2)
  }

  useLayoutEffect(() => {
    measureClamp()
  }, [memoContent, isEditing, isFocused])

  useLayoutEffect(() => {
    const anchor = pendingCardAnchorRef.current
    if (!anchor) return
    pendingCardAnchorRef.current = null
    if (!anchor.card.isConnected || !anchor.scrollParent.isConnected) return

    const alignCard = () => {
      if (!anchor.card.isConnected || !anchor.scrollParent.isConnected) return
      const delta = anchor.card.getBoundingClientRect().top - anchor.viewportTop
      if (Math.abs(delta) < 1) return
      anchor.scrollParent.scrollTop += delta
    }

    alignCard()
    const frame = window.requestAnimationFrame(alignCard)
    return () => window.cancelAnimationFrame(frame)
  }, [isExpanded, isEditing, editContent, editTags, editAttachments, isAddingTag, renamingTag])

  // 窗口宽度变化会改变换行数，跟随元素尺寸重测
  useEffect(() => {
    const el = contentRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measureClamp())
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const scrollToEnd = () => {
    const card = cardRef.current
    if (!card) return
    if (isFocused) {
      card.scrollTo({ top: card.scrollHeight, behavior: 'instant' })
      return
    }
    const scrollParent = getScrollParent(card)
    if (!scrollParent) return
    const viewportBottom = scrollParent.getBoundingClientRect().top + scrollParent.clientTop + scrollParent.clientHeight
    const paddingBottom = parseFloat(window.getComputedStyle(scrollParent).paddingBottom) || 0
    scrollParent.scrollTo({
      top: scrollParent.scrollTop + card.getBoundingClientRect().bottom - viewportBottom + paddingBottom,
      behavior: 'instant'
    })
  }

  const toggleExpanded = () => {
    if (isExpanded) captureCardAnchor()
    setIsExpanded(prev => {
      if (prev) expandedMemoIds.delete(memo.id)
      else expandedMemoIds.add(memo.id)
      return !prev
    })
  }

  useEffect(() => {
    let listeners = attachmentCleanupListeners.get(memo.id)
    if (!listeners) {
      listeners = new Set()
      attachmentCleanupListeners.set(memo.id, listeners)
    }
    const refreshCleanupState = () => {
      setAttachmentCleanupError(getAttachmentCleanupRecord(memo.id)?.error ?? '')
      setAttachmentCleanupPending(attachmentCleanupInProgress.has(memo.id))
    }
    listeners.add(refreshCleanupState)
    refreshCleanupState()
    return () => {
      listeners?.delete(refreshCleanupState)
      if (listeners?.size === 0) attachmentCleanupListeners.delete(memo.id)
    }
  }, [memo.id])

  useEffect(() => {
    const markFocusMoved = (event: PointerEvent) => {
      const target = event.target
      if (
        pendingAttachmentOpsRef.current > 0
        && target instanceof Node
        && target !== editTextareaRef.current
        && target !== fileInputRef.current
      ) {
        attachmentFocusMovedRef.current = true
      }
    }
    document.addEventListener('pointerdown', markFocusMoved, true)
    return () => document.removeEventListener('pointerdown', markFocusMoved, true)
  }, [])

  useEffect(() => {
    if (!showPriorityMenu) return
    // 菜单已 portal 到 body，需同时排除按钮区与菜单本身，否则 mousedown 会先关掉菜单导致选不中
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      const insideBtn = priorityMenuRef.current?.contains(target)
      const insidePop = priorityPopRef.current?.contains(target)
      if (!insideBtn && !insidePop) setShowPriorityMenu(false)
    }
    // fixed 菜单不随列表滚动，滚动/缩放时直接关闭避免错位（capture 捕获内层滚动容器）
    const close = () => setShowPriorityMenu(false)
    document.addEventListener('mousedown', handleClickOutside)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [showPriorityMenu])

  const handlePriorityChange = (p: Priority) => {
    if (isEditing || editSavingRef.current || pendingAttachmentOpsRef.current > 0) return
    updateMemo(memo.id, { priority: p })
    setShowPriorityMenu(false)
  }

  const handleSetNotStarted = () => {
    if (isEditing || editSavingRef.current || pendingAttachmentOpsRef.current > 0) return
    updateMemo(memo.id, { status: 'not_started', completedAt: null })
    setShowPriorityMenu(false)
  }

  const handlePriorityClick = () => {
    if (isEditing || editSavingRef.current || pendingAttachmentOpsRef.current > 0) return
    if (!showPriorityMenu && priorityBtnRef.current) {
      const rect = priorityBtnRef.current.getBoundingClientRect()
      const MENU_HEIGHT = 150
      const right = window.innerWidth - rect.right
      // 下方空间不足则向上弹出，菜单右缘对齐按钮右缘
      setMenuStyle(
        window.innerHeight - rect.bottom < MENU_HEIGHT
          ? { right, bottom: window.innerHeight - rect.top + 4 }
          : { right, top: rect.bottom + 4 }
      )
    }
    setShowPriorityMenu(!showPriorityMenu)
  }

  const handleSave = async () => {
    if (editSavingRef.current) return
    if (pendingAttachmentOpsRef.current > 0) return
    if (attachmentCleanupInProgress.has(memo.id)) {
      setEditError('图片清理正在处理中，请稍后保存。')
      return
    }
    if (!editContent.trim() && editAttachments.length === 0) {
      setEditError('待办内容和图片不能同时为空。')
      return
    }

    let tagsToSave = editTags
    if (isAddingTag || renamingTag) {
      const nextTag = normalizeTagName(tagDraft)
      if (!nextTag) {
        setTagError('标签只支持中文、字母、数字、下划线和连字符（-）。')
        return
      }
      if (isAddingTag) {
        if (editTags.includes(nextTag)) {
          setTagError('该标签已存在。')
          return
        }
        tagsToSave = [...editTags, nextTag]
      } else if (renamingTag) {
        if (renamingTag === DEFAULT_TAG) return
        if (nextTag !== renamingTag && editTags.includes(nextTag)) {
          setTagError('该标签已存在。')
          return
        }
        tagsToSave = editTags.map(tag => tag === renamingTag ? nextTag : tag)
      }
    }

    editSavingRef.current = true
    setEditSaving(true)
    try {
      let saved = false
      try {
        saved = await updateMemo(memo.id, {
          content: editContent,
          tags: tagsToSave,
          attachments: editAttachments,
          type: editAttachments.length > 0 ? 'image' : 'text'
        }, editBaseline.current ?? undefined)
      } catch (error) {
        const reason = error instanceof Error ? error.message : '未知错误'
        setEditError(`保存失败：${reason}。草稿仍在编辑框中，请先复制再取消。`)
        return
      }
      if (!saved) { setEditError('待办不存在或已删除；草稿仍在编辑框中，请先复制。'); return }

      const savedAttachmentNames = new Set(editAttachments)
      const baselineAttachments = editBaseline.current?.attachments ?? memo.attachments
      const discardedAttachments = [...new Set([
        ...baselineAttachments.filter(filename => !savedAttachmentNames.has(filename)),
        ...discardedEditAttachmentsRef.current,
        ...addedEditAttachmentsRef.current,
        ...(getAttachmentCleanupRecord(memo.id)?.filenames ?? [])
      ])].filter(filename => !savedAttachmentNames.has(filename))
      captureCardAnchor()
      setEditTags(tagsToSave)
      cancelTagDraft()
      const cleanup = await deleteUncommittedAttachments(discardedAttachments)
      const pendingCleanup = [...cleanup.retained, ...cleanup.failed]
      const combinedCleanup = new Set([...pendingCleanup])
      for (const filename of savedAttachmentNames) combinedCleanup.delete(filename)
      const cleanupError = combinedCleanup.size > 0
        ? `${cleanup.retained.length > 0 ? `${cleanup.retained.length} 张仍被待办或同步记录引用` : ''}${cleanup.retained.length > 0 && cleanup.failed.length > 0 ? '，' : ''}${cleanup.failed.length > 0 ? `${cleanup.failed.length} 张清理失败` : ''}，请检查附件或重试清理。`
        : ''
      setAttachmentCleanupRecord(memo.id, combinedCleanup, cleanupError)
      addedEditAttachmentsRef.current.clear()
      discardedEditAttachmentsRef.current.clear()
      setAttachmentCleanupError(cleanupError)
      setIsEditing(false)
      onEditingChange(null, memo.id)
    } finally {
      editSavingRef.current = false
      setEditSaving(false)
    }
  }

  const retryAttachmentCleanup = async () => {
    const record = getAttachmentCleanupRecord(memo.id)
    if (attachmentCleanupInProgress.has(memo.id) || !record || record.filenames.size === 0) return
    attachmentCleanupInProgress.add(memo.id)
    notifyAttachmentCleanupChanged(memo.id)
    try {
      const cleanup = await deleteUncommittedAttachments([...record.filenames])
      cleanup.deleted.forEach(filename => record.filenames.delete(filename))
      const cleanupError = cleanup.retained.length > 0 || cleanup.failed.length > 0
        ? `${cleanup.retained.length > 0 ? `${cleanup.retained.length} 张仍被待办或同步记录引用` : ''}${cleanup.retained.length > 0 && cleanup.failed.length > 0 ? '，' : ''}${cleanup.failed.length > 0 ? `${cleanup.failed.length} 张清理失败` : ''}，请检查附件或重试清理。`
        : ''
      setAttachmentCleanupRecord(memo.id, record.filenames, cleanupError)
      setAttachmentCleanupError(cleanupError)
    } finally {
      attachmentCleanupInProgress.delete(memo.id)
      notifyAttachmentCleanupChanged(memo.id)
    }
  }

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || isEditing === false || editSavingRef.current || pendingAttachmentOpsRef.current > 0) return
    const textarea = editTextareaRef.current
    beginAttachmentOperation(textarea ? {
      start: textarea.selectionStart,
      end: textarea.selectionEnd
    } : undefined)
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const base64 = reader.result as string
        const filename = await window.electronAPI.image.save(base64)
        if (!filename) {
          endAttachmentOperation('添加图片失败：未能保存图片。')
          return
        }
        addEditAttachment(filename)
      } catch (error) {
        endAttachmentOperation(`添加图片失败：${error instanceof Error ? error.message : '未知错误'}`)
        return
      }
      endAttachmentOperation()
    }
    reader.onerror = () => {
      endAttachmentOperation('读取图片失败。')
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const addEditAttachment = (filename: string) => {
    addedEditAttachmentsRef.current.add(filename)
    captureCardAnchor()
    setEditAttachments(previous => [...previous, filename])
  }

  const removeEditAttachment = (filename: string) => {
    if (editSavingRef.current || pendingAttachmentOpsRef.current > 0) return
    captureCardAnchor()
    if (addedEditAttachmentsRef.current.has(filename)) {
      discardedEditAttachmentsRef.current.add(filename)
    }
    setEditAttachments(prev => prev.filter(f => f !== filename))
  }

  const beginAddTag = () => {
    if (editSavingRef.current || pendingAttachmentOpsRef.current > 0) return
    captureCardAnchor()
    setTagDraft('')
    setTagError('')
    setRenamingTag(null)
    setIsAddingTag(true)
  }

  const beginRenameTag = (tag: string) => {
    if (tag === DEFAULT_TAG || editSavingRef.current || pendingAttachmentOpsRef.current > 0) return
    captureCardAnchor()
    setTagDraft(tag)
    setTagError('')
    setIsAddingTag(false)
    setRenamingTag(tag)
  }

  const cancelTagDraft = () => {
    setTagDraft('')
    setTagError('')
    setIsAddingTag(false)
    setRenamingTag(null)
  }

  const commitTagDraft = () => {
    if (editSavingRef.current || pendingAttachmentOpsRef.current > 0) return
    const nextTag = normalizeTagName(tagDraft)
    if (!nextTag) {
      setTagError('标签只支持中文、字母、数字、下划线和连字符（-）。')
      return
    }

    if (isAddingTag) {
      if (editTags.includes(nextTag)) {
        setTagError('该标签已存在。')
        return
      }
      captureCardAnchor()
      setEditTags(previous => [...previous, nextTag])
    } else if (renamingTag) {
      if (renamingTag === DEFAULT_TAG) return
      if (nextTag !== renamingTag && editTags.includes(nextTag)) {
        setTagError('该标签已存在。')
        return
      }
      captureCardAnchor()
      setEditTags(previous => previous.map(tag => tag === renamingTag ? nextTag : tag))
    }

    cancelTagDraft()
  }

  const removeEditTag = (tag: string) => {
    if (tag === DEFAULT_TAG || editSavingRef.current || pendingAttachmentOpsRef.current > 0) return
    captureCardAnchor()
    setEditTags(previous => previous.filter(item => item !== tag))
  }

  const handleEditPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (editSavingRef.current || pendingAttachmentOpsRef.current > 0) {
      e.preventDefault()
      return
    }
    const textarea = e.currentTarget
    const selectionStart = textarea.selectionStart
    const selectionEnd = textarea.selectionEnd
    const structuredMemo = readStructuredMemoClipboard(e.clipboardData)

    if (structuredMemo?.imageSetIncomplete) {
      e.preventDefault()
      setEditError('剪贴板图片数据不完整，内容未粘贴。请重新复制后重试。')
      return
    }

    if (structuredMemo) {
      e.preventDefault()
      setEditError('')
      const insertion = insertTextAtSelection(
        editContent,
        structuredMemo.payload.content,
        selectionStart,
        selectionEnd
      )

      const clipboardTags = structuredMemo.payload.tags.map(normalizeTagName)
      const validClipboardTags = [...new Set(clipboardTags.filter((tag): tag is string => tag !== null))]
      setTagError(clipboardTags.some(tag => tag === null) ? '剪贴板中有不支持的标签，已跳过。' : '')
      setEditContent(insertion.value)
      restoreTextareaSelection(textarea, insertion.caret)
      captureCardAnchor()
      setEditTags(previous => [...new Set([...previous, ...validClipboardTags])])

      if (structuredMemo.images.length > 0) {
        beginAttachmentOperation({ start: insertion.caret, end: insertion.caret })
      } else {
        lastTextareaSelectionRef.current = { start: insertion.caret, end: insertion.caret }
      }
      let operationError: string | undefined
      try {
        const filenames = await saveClipboardImagesStrict(structuredMemo.images)
        filenames.forEach(addEditAttachment)
      } catch (error) {
        const reason = error instanceof Error ? error.message : '未知错误'
        operationError = `粘贴图片失败：${reason}`
        if (error instanceof ClipboardImageSaveError && error.uncommittedFilenames.length > 0) {
          const record = getAttachmentCleanupRecord(memo.id)
          const pendingFiles = new Set([...(record?.filenames ?? []), ...error.uncommittedFilenames])
          const cleanupError = `剪贴板图片清理失败，请检查附件：${error.uncommittedFilenames.join(', ')}`
          setAttachmentCleanupRecord(memo.id, pendingFiles, cleanupError)
          setAttachmentCleanupError(cleanupError)
        }
      } finally {
        if (structuredMemo.images.length > 0) endAttachmentOperation(operationError)
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

    beginAttachmentOperation({ start: insertion.caret, end: insertion.caret })
    try {
      const filename = await window.electronAPI.image.pasteFromClipboard()
      if (filename) addEditAttachment(filename)
      else setEditError('剪贴板中没有可添加的图片。')
    } catch (error) {
      setEditError(`粘贴图片失败：${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      endAttachmentOperation()
    }
  }

  const handleCopy = async (event: React.MouseEvent<HTMLButtonElement>) => {
    if (copyState === 'copying') return
    // 默认复制纯文本与图片路径（便于直接喂 CLI），Shift 复制富文本与图片
    const copyRich = event.shiftKey
    setCopyKind(copyRich ? 'rich' : 'cli')

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
      const result = copyRich
        ? await window.electronAPI.clipboard.copyMemo(request)
        : await window.electronAPI.clipboard.copyMemoForCli(request)

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

  const cancelEditing = async () => {
    if (editSavingRef.current) return
    if (attachmentCleanupInProgress.has(memo.id)) {
      setEditError('图片清理正在处理中，请稍后取消。')
      return
    }
    if (pendingAttachmentOpsRef.current > 0) {
      setEditError('图片正在处理中，请稍后取消。')
      return
    }
    setEditContent(memoContent)
    setEditTags(memo.tags || [])
    setEditAttachments(memo.attachments || [])
    cancelTagDraft()
    setEditError('')
    setIsEditing(false)
    onEditingChange(null, memo.id)
    const currentAttachments = new Set(memo.attachments || [])
    const discardedAttachments = [...new Set([
      ...addedEditAttachmentsRef.current,
      ...discardedEditAttachmentsRef.current,
      ...(getAttachmentCleanupRecord(memo.id)?.filenames ?? [])
    ])].filter(filename => !currentAttachments.has(filename))
    addedEditAttachmentsRef.current.clear()
    discardedEditAttachmentsRef.current.clear()
    const cleanup = await deleteUncommittedAttachments(discardedAttachments)
    const pendingCleanup = [...cleanup.retained, ...cleanup.failed]
    const cleanupError = pendingCleanup.length > 0
      ? `${cleanup.retained.length > 0 ? `${cleanup.retained.length} 张仍被待办或同步记录引用` : ''}${cleanup.retained.length > 0 && cleanup.failed.length > 0 ? '，' : ''}${cleanup.failed.length > 0 ? `${cleanup.failed.length} 张清理失败` : ''}，请检查附件或重试清理。`
      : ''
    setAttachmentCleanupRecord(memo.id, pendingCleanup, cleanupError)
    setAttachmentCleanupError(cleanupError)
  }

  const startEditing = () => {
    editBaseline.current = structuredClone(memo)
    setEditError('')
    setEditContent(memoContent)
    setEditTags(memo.tags || [])
    setEditAttachments(memo.attachments || [])
    addedEditAttachmentsRef.current.clear()
    discardedEditAttachmentsRef.current.clear()
    cancelTagDraft()
    setIsEditing(true)
    onEditingChange(memo, memo.id)
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

  const hasImage = memo.attachments.length > 0
  // 虚拟列表滚动时条目会重新挂载，入场动画只给新建的备忘播放
  const isFreshMemo = Date.now() - new Date(memo.createdAt).getTime() < 1500
  const copyLabel = copyState === 'copying'
    ? '复制中'
    : copyState === 'success'
      ? (copyKind === 'rich' ? '已复制富文本图片' : '已复制文本路径')
      : copyState === 'partial'
        ? '已复制（部分图片缺失）'
        : copyState === 'error'
          ? '复制失败'
          : '复制整条待办｜Shift 富文本'
  const copyTitle = copyLabel
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
        ref={cardRef}
        data-memo-id={memo.id}
        style={{ overflowAnchor: 'none' }}
        className={`group relative flex gap-2.5 px-3 py-2.5 bg-white rounded-xl border border-slate-100 shadow-card hover:border-slate-200 hover:shadow-card-hover transition-all duration-200 ${
          isFocused ? 'memo-focus-card' : isFreshMemo ? 'animate-card-in' : ''
        } ${
          memo.status === 'completed' ? 'opacity-55' : ''
        }`}
      >
        {/* 左侧优先级竖条 */}
        <div className={`absolute left-0 top-3 bottom-3 w-0.5 rounded-full ${priorityBar[memo.priority]}`} />

        {/* 左侧状态与窗口内展开入口 */}
        <div className="memo-state-actions sticky top-2 self-start flex-shrink-0 flex flex-col items-center justify-center gap-2">
          <button
            onClick={() => {
              if (isEditing || editSavingRef.current || pendingAttachmentOpsRef.current > 0) return
              const nextStatus: Record<MemoStatus, MemoStatus> = {
                not_started: 'in_progress',
                in_progress: 'completed',
                completed: 'not_started'
              }
              const status = nextStatus[memo.status]
              updateMemo(memo.id, { status, completedAt: status === 'completed' ? new Date().toISOString() : null })
            }}
            disabled={isEditing || editSaving || pendingAttachmentOps > 0}
            className="flex-shrink-0 mt-0.5 cursor-pointer disabled:cursor-not-allowed"
            title={memo.status === 'not_started'
              ? '未开始'
              : memo.status === 'in_progress'
                ? '进行中'
                : '已完成'}
          >
            <StatusIcon status={memo.status} />
          </button>
          <button
            type="button"
            onClick={onToggleFocus}
            aria-label={isFocused ? '返回列表' : '全屏展开'}
            aria-expanded={isFocused}
            title={isFocused ? '返回列表' : '全屏展开'}
            className="p-1 rounded-md text-slate-400 hover:text-indigo-500 hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 cursor-pointer"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {isFocused
                ? <path d="M19 12H5m7-7-7 7 7 7" />
                : <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />}
            </svg>
          </button>
          {needsClamp && isExpanded && !isFocused && (
            <button
              type="button"
              onClick={toggleExpanded}
              aria-label="收起待办内容"
              aria-expanded="true"
              title="收起"
              className="p-1 rounded-md text-indigo-500 hover:text-indigo-600 hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 cursor-pointer"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12l5-5 5 5" />
              </svg>
            </button>
          )}
          {needsClamp && (isExpanded || isFocused) && !isEditing && (
            <button
              type="button"
              onClick={scrollToEnd}
              aria-label="跳到当前待办末尾"
              title="跳到末尾"
              className="p-1 rounded-md text-indigo-500 hover:text-indigo-600 hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 cursor-pointer"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3v12m-5-5 5 5 5-5M5 21h14" />
              </svg>
            </button>
          )}
        </div>

        {/* 内容区域 */}
        <div className="flex-1 min-w-0">
          {attachmentCleanupError && !isEditing && (
            <div role="alert" className="mb-1.5 flex items-center gap-2 text-[11px] text-rose-500">
              <span>{attachmentCleanupError}</span>
              <button
                type="button"
                onClick={retryAttachmentCleanup}
                disabled={attachmentCleanupPending}
                aria-label="重试清理"
                className="underline cursor-pointer disabled:cursor-wait"
              >
                {attachmentCleanupPending ? '清理中…' : '重试清理'}
              </button>
            </div>
          )}
          {isEditing ? (
            <div className="space-y-2">
              {editError && <p role="alert" className="text-[12px] text-rose-500">{editError}</p>}
              {attachmentCleanupError && (
                <p role="alert" className="flex items-center gap-2 text-[12px] text-rose-500">
                  <span>{attachmentCleanupError}</span>
                  <button type="button" onClick={retryAttachmentCleanup} disabled={attachmentCleanupPending || editSaving || pendingAttachmentOps > 0} className="underline cursor-pointer disabled:cursor-wait">{attachmentCleanupPending ? '清理中…' : '重试清理'}</button>
                </p>
              )}
              {pendingAttachmentOps > 0 && <p role="status" className="text-[12px] text-slate-400">图片处理中，请稍候。</p>}
              <textarea
                ref={editTextareaRef}
                aria-label="编辑待办正文"
                value={editContent}
                disabled={editSaving || pendingAttachmentOps > 0}
                onChange={(e) => setEditContent(e.target.value)}
                onSelect={(e) => {
                  const selection = {
                    start: e.currentTarget.selectionStart,
                    end: e.currentTarget.selectionEnd
                  }
                  lastTextareaSelectionRef.current = selection
                  if (pendingAttachmentOpsRef.current === 0) attachmentFocusRef.current = selection
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); handleSave() }
                  else if (e.key === 'Escape') cancelEditing()
                }}
                onPaste={handleEditPaste}
                className="w-full min-w-0 px-2.5 py-1.5 text-sm text-slate-800 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/25 focus:border-indigo-400 resize-none overflow-hidden"
                style={{ minHeight: '32px', whiteSpace: 'pre-wrap' }}
                autoFocus
              />
              {editAttachments.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {editAttachments.map((filename) => (
                    <EditImagePreview key={filename} filename={filename} disabled={editSaving || pendingAttachmentOps > 0} onRemove={() => removeEditAttachment(filename)} />
                  ))}
                </div>
              )}
            </div>
          ) : memoContent ? (
            <div className="relative">
              <p
                ref={contentRef}
                className={`text-sm leading-relaxed break-words cursor-pointer whitespace-pre-wrap ${
                  memo.status === 'completed' ? 'line-through text-slate-400' : 'text-slate-800'
                } ${needsClamp && !isExpanded && !isFocused ? 'line-clamp-3' : ''}`}
                onDoubleClick={startEditing}
              >
                {memoContent}
              </p>
              {needsClamp && !isExpanded && !isFocused && (
                <div
                  className="absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-white via-white/80 to-transparent pointer-events-none"
                  aria-hidden="true"
                />
              )}
              {needsClamp && !isFocused && !isExpanded && (
                <button
                  type="button"
                  onClick={toggleExpanded}
                  aria-expanded={isExpanded}
                  className="absolute right-0 bottom-0 flex items-center gap-0.5 bg-white pl-2 text-[11px] text-indigo-500 hover:text-indigo-600 cursor-pointer"
                >
                  展开
                  <svg
                    className="h-3 w-3"
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M5 8l5 5 5-5" />
                  </svg>
                </button>
              )}
            </div>
          ) : null}

          {/* 图片附件 */}
          {!isEditing && hasImage && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {memo.attachments.map((filename) => (
                <ImageThumbnail
                  key={filename}
                  filename={filename}
                  onEdit={!memoContent ? startEditing : undefined}
                />
              ))}
            </div>
          )}

          {/* 标签 */}
          {(isEditing || (memo.tags?.length ?? 0) > 0) && (
            <div className="flex flex-wrap items-center gap-1 mt-1.5">
              {(isEditing ? editTags : memo.tags || []).map(tag => (
                <span
                  key={tag}
                  data-tag-chip={tag}
                  className={`group/tag inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded-md tracking-wide ${tag === DEFAULT_TAG ? 'bg-indigo-50 text-indigo-500' : 'bg-slate-100 text-slate-500'}`}
                >
                  {isEditing && renamingTag === tag ? (
                    <input
                      autoFocus
                      value={tagDraft}
                      disabled={editSaving || pendingAttachmentOps > 0}
                      aria-label={`修改标签 ${tag}`}
                      onChange={event => { setTagDraft(event.target.value); setTagError('') }}
                      onKeyDown={event => {
                        if (event.key === 'Enter') { event.preventDefault(); commitTagDraft() }
                        else if (event.key === 'Escape') cancelTagDraft()
                      }}
                      onBlur={event => {
                        const next = event.relatedTarget
                        if (next instanceof HTMLButtonElement && next.getAttribute('aria-label') === '保存待办') return
                        if (renamingTag) cancelTagDraft()
                      }}
                      className="w-20 min-w-0 bg-transparent outline-none"
                    />
                  ) : (
                    <span>#{tag}</span>
                  )}
                  {isEditing && renamingTag !== tag && tag !== DEFAULT_TAG && (
                    <span className="inline-flex items-center gap-0.5 opacity-0 group-hover/tag:opacity-100 focus-within:opacity-100 transition-opacity">
                      <button
                        type="button"
                        disabled={editSaving || pendingAttachmentOps > 0}
                        onClick={() => beginRenameTag(tag)}
                        aria-label={`修改标签 ${tag}`}
                        title="修改标签"
                        className="text-slate-400 hover:text-indigo-500 cursor-pointer"
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        disabled={editSaving || pendingAttachmentOps > 0}
                        onClick={() => removeEditTag(tag)}
                        aria-label={`删除标签 ${tag}`}
                        title="删除标签"
                        className="text-slate-400 hover:text-rose-500 cursor-pointer"
                      >
                        ×
                      </button>
                    </span>
                  )}
                </span>
              ))}
              {isEditing && isAddingTag && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] bg-slate-100 text-slate-500 rounded-md">
                  <input
                    autoFocus
                    value={tagDraft}
                    disabled={editSaving || pendingAttachmentOps > 0}
                    aria-label="添加标签"
                    placeholder="#标签"
                    onChange={event => { setTagDraft(event.target.value); setTagError('') }}
                    onKeyDown={event => {
                      if (event.key === 'Enter') { event.preventDefault(); commitTagDraft() }
                      else if (event.key === 'Escape') cancelTagDraft()
                    }}
                    onBlur={event => {
                      const next = event.relatedTarget
                      if (next instanceof HTMLButtonElement && next.getAttribute('aria-label') === '保存待办') return
                      if (isAddingTag) cancelTagDraft()
                    }}
                    className="w-20 min-w-0 bg-transparent outline-none"
                  />
                </span>
              )}
              {isEditing && !isAddingTag && renamingTag === null && (
                <button
                  type="button"
                  disabled={editSaving || pendingAttachmentOps > 0}
                  onClick={beginAddTag}
                  aria-label="添加标签"
                  title="添加标签"
                  className="px-1.5 py-0.5 text-[11px] text-indigo-500 hover:bg-indigo-50 rounded-md cursor-pointer"
                >
                  + 添加标签
                </button>
              )}
              {isEditing && tagError && <span role="alert" className="w-full text-[11px] text-rose-500">{tagError}</span>}
            </div>
          )}

          {/* 时间 */}
          <p className="text-[11px] text-slate-400 mt-1 tracking-wide">
            {formatTime(memo.updatedAt)}
          </p>
        </div>

        {/* 右侧操作区（常驻显示） */}
        <div className="memo-item-actions sticky top-2 self-start flex-shrink-0 flex flex-col items-end gap-0.5">
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
                  disabled={isEditing || editSaving || pendingAttachmentOps > 0}
                  className={`p-1.5 rounded-md hover:bg-slate-100 transition-colors cursor-pointer disabled:cursor-not-allowed ${priorityText[memo.priority]}`}
                  aria-label="进度与重要等级"
                  title="进度与重要等级"
                >
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16">
                    <rect x="2" y="2" width="3" height="12" rx="1" />
                    <rect x="7" y="5" width="3" height="9" rx="1" />
                    <rect x="12" y="8" width="3" height="6" rx="1" />
                  </svg>
                </button>

                {showPriorityMenu && menuStyle && createPortal(
                  <div
                    ref={priorityPopRef}
                    style={{ position: 'fixed', ...menuStyle }}
                    className="bg-white rounded-xl shadow-lg border border-slate-100 py-1 z-50 min-w-[104px]"
                  >
                    <button
                      onClick={handleSetNotStarted}
                      className={`w-full px-3 py-1.5 text-left text-[12px] hover:bg-slate-50 flex items-center gap-2 cursor-pointer ${
                        memo.status === 'not_started' ? 'bg-slate-50' : ''
                      }`}
                    >
                      <span className="w-1.5 h-1.5 rounded-full border border-slate-400" />
                      <span className="text-slate-600">未开始</span>
                      {memo.status === 'not_started' && (
                        <svg className="w-3 h-3 text-indigo-400 ml-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                    <div className="my-1 border-t border-slate-100" />
                    {(['important', 'unimportant'] as Priority[]).map((p) => (
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
                  </div>,
                  document.body
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
          {isEditing && (
            <>
              <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageSelect} disabled={editSaving || pendingAttachmentOps > 0} className="hidden" />
              <button
                type="button"
                onClick={handleSave}
                disabled={editSaving || pendingAttachmentOps > 0}
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
                disabled={editSaving || pendingAttachmentOps > 0}
                className="p-1.5 text-slate-400 hover:text-indigo-500 hover:bg-indigo-50 rounded-md transition-colors cursor-pointer disabled:cursor-wait"
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
                disabled={editSaving || pendingAttachmentOps > 0}
                className="p-1.5 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-md transition-colors cursor-pointer disabled:cursor-wait"
                aria-label="取消编辑"
                title="取消"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </>
          )}
          <span className="sr-only" aria-live="polite">{copyState === 'idle' ? '' : copyLabel}</span>
        </div>
      </div>
    </>
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

function ImageThumbnail({ filename, onEdit }: { filename: string; onEdit?: () => void }) {
  const [isPreviewing, setIsPreviewing] = useState(false)
  const previewPendingRef = useRef(false)
  const [copyFeedback, setCopyFeedback] = useState<ImageCopyFeedback>(IDLE_IMAGE_COPY)
  const imageCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const singleClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (imageCopyTimerRef.current) clearTimeout(imageCopyTimerRef.current)
      if (singleClickTimerRef.current) clearTimeout(singleClickTimerRef.current)
    }
  }, [])

  const handlePreview = async (event?: React.MouseEvent<HTMLButtonElement>) => {
    event?.stopPropagation()
    if (previewPendingRef.current) return
    previewPendingRef.current = true
    setIsPreviewing(true)
    try {
      await window.electronAPI.image.preview(filename)
    } catch (error) {
      console.error('Failed to request image preview:', error)
    } finally {
      previewPendingRef.current = false
      setIsPreviewing(false)
    }
  }

  // 可编辑（纯图片条目）时区分单击/双击：单击延迟 250ms 看图，双击直接进编辑
  const handleImageClick = () => {
    if (!onEdit) {
      void handlePreview()
      return
    }
    if (singleClickTimerRef.current) {
      clearTimeout(singleClickTimerRef.current)
      singleClickTimerRef.current = null
      onEdit()
    } else {
      singleClickTimerRef.current = setTimeout(() => {
        singleClickTimerRef.current = null
        void handlePreview()
      }, 250)
    }
  }

  const copyTitle = getImageCopyTitle(copyFeedback)
  const copyClass = copyFeedback.state === 'success'
    ? 'bg-emerald-500 text-white opacity-100'
    : copyFeedback.state === 'error'
      ? 'bg-rose-500 text-white opacity-100'
      : 'bg-slate-900/70 text-white opacity-0 group-hover/img:opacity-100 hover:bg-indigo-500'
  const actionClass = 'w-6 h-6 rounded-full shadow-md flex items-center justify-center transition-all active:scale-95 cursor-pointer opacity-0 group-hover/img:opacity-100'

  return (
    <div className="relative group/img inline-flex">
      <img
        src={thumbImageUrl(filename)}
        alt=""
        className="max-h-16 rounded-lg cursor-pointer hover:opacity-85 transition-opacity object-cover"
        onClick={handleImageClick}
        title={onEdit ? '单击预览，双击编辑' : '预览'}
      />
      <div className="absolute -top-1 -right-1 flex flex-col gap-1">
        <button
          type="button"
          onClick={handlePreview}
          disabled={isPreviewing}
          aria-label="预览"
          title="预览"
          className={`${actionClass} bg-white text-slate-600 hover:text-indigo-600 hover:bg-white disabled:cursor-wait`}
        >
          <PreviewInWindowIcon />
        </button>
        <button
          type="button"
          onClick={(event) => copyImageFromEvent(filename, event, setCopyFeedback, imageCopyTimerRef)}
          disabled={copyFeedback.state === 'copying'}
          aria-label={copyTitle}
          title={copyTitle}
          className={`${actionClass} disabled:cursor-wait ${copyClass}`}
        >
          <ImageCopyIcon state={copyFeedback.state} kind={copyFeedback.kind} />
        </button>
      </div>
    </div>
  )
}

function EditImagePreview({ filename, disabled, onRemove }: { filename: string; disabled: boolean; onRemove: () => void }) {
  const [copyFeedback, setCopyFeedback] = useState<ImageCopyFeedback>(IDLE_IMAGE_COPY)
  const imageCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (imageCopyTimerRef.current) clearTimeout(imageCopyTimerRef.current)
    }
  }, [])

  const copyTitle = getImageCopyTitle(copyFeedback)
  const copyClass = copyFeedback.state === 'success'
    ? 'bg-emerald-500 text-white opacity-100'
    : copyFeedback.state === 'error'
      ? 'bg-rose-500 text-white opacity-100'
      : 'bg-slate-900/70 text-white opacity-0 group-hover/img:opacity-100 hover:bg-indigo-500'

  return (
    <div className="relative group/img">
      <img src={thumbImageUrl(filename)} alt="" className="w-12 h-12 object-cover rounded-lg" />
      <div className="absolute -top-1 -right-1 flex flex-col gap-0.5">
        <button
          type="button"
          onClick={(event) => copyImageFromEvent(filename, event, setCopyFeedback, imageCopyTimerRef)}
          disabled={disabled || copyFeedback.state === 'copying'}
          aria-label={copyTitle}
          title={copyTitle}
          className={`w-4 h-4 rounded-full shadow-md flex items-center justify-center transition-all active:scale-95 cursor-pointer disabled:cursor-wait ${copyClass}`}
        >
          <ImageCopyIcon state={copyFeedback.state} kind={copyFeedback.kind} iconClassName="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`移除附件 ${filename}`}
          title="移除附件"
          className="w-4 h-4 bg-slate-700 text-white rounded-full text-[10px] flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity cursor-pointer disabled:cursor-wait"
        >
          <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3" strokeLinecap="round">
            <path d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  )
}

export default MemoItem
