import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import { useMemoStore } from '../store/memoStore'
import type { Memo, MemoStatus } from '../../shared/types'
import MemoItem from './MemoItem'
import FilterBar from './FilterBar'

// 列表状态分档：进行中置顶，未开始次之，已完成沉底
const STATUS_RANK: Record<MemoStatus, number> = { in_progress: 0, not_started: 1, completed: 2 }

interface MemoListProps {
  focusedMemoId: string | null
  onFocusMemoChange: (id: string | null) => void
}

function MemoList({ focusedMemoId, onFocusMemoChange }: MemoListProps) {
  const { memos, filter, priorityFilter, tagFilter } = useMemoStore()
  const listRef = useRef<HTMLDivElement>(null)
  const scrollStartAtRef = useRef<number | null>(null)
  const lastScrollTopRef = useRef(0)
  const hideTimerRef = useRef<number | null>(null)
  const [showScrollTop, setShowScrollTop] = useState(false)
  const [focusSnapshot, setFocusSnapshot] = useState<{ ids: string[]; scrollTop: number } | null>(null)
  const [editingMemos, setEditingMemos] = useState<Record<string, Memo>>({})
  const handleEditingChange = useCallback((memo: Memo | null, id: string) => {
    setEditingMemos(current => {
      if (memo) return { ...current, [id]: memo }
      const remaining = { ...current }
      delete remaining[id]
      return remaining
    })
  }, [])

  const filteredMemos = useMemo(() => {
    return memos.filter((memo) => {
      if (memo.deleted) return false
      if (filter !== 'all' && memo.status !== filter) return false
      if (priorityFilter !== 'all' && memo.priority !== priorityFilter) return false
      if (tagFilter && !(memo.tags || []).includes(tagFilter)) return false
      return true
    })
  }, [filter, memos, priorityFilter, tagFilter])

  const sortedMemos = useMemo(() => {
    return [...filteredMemos].sort((a, b) => {
      // 状态分档：进行中置顶，未开始次之，已完成沉底
      const rankDiff = STATUS_RANK[a.status] - STATUS_RANK[b.status]
      if (rankDiff !== 0) return rankDiff
      // 已完成记录按点击完成时间倒序，不再受优先级影响
      if (a.status === 'completed') {
        const completedTimeDiff = (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt)
        if (completedTimeDiff !== 0) return completedTimeDiff
        return b.createdAt.localeCompare(a.createdAt)
      }
      // 进行中 / 未开始：重要在前，再按创建时间倒序
      const priorityOrder = { important: 0, unimportant: 1 }
      if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
        return priorityOrder[a.priority] - priorityOrder[b.priority]
      }
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    })
  }, [filteredMemos])


  const visibleMemos = useMemo(() => {
    if (!focusedMemoId || !focusSnapshot) return sortedMemos
    const byId = new Map(memos.filter(memo => !memo.deleted).map(memo => [memo.id, memo]))
    return focusSnapshot.ids.flatMap(id => {
      const memo = byId.get(id)
      return memo ? [memo] : []
    })
  }, [focusedMemoId, focusSnapshot, sortedMemos, memos])
  const currentEditingMemos = useMemo(() => Object.values(editingMemos).map(editing => (
    memos.find(memo => memo.id === editing.id) ?? editing
  )), [editingMemos, memos])
  const displayedMemos = useMemo(() => {
    const visibleIds = new Set(visibleMemos.map(memo => memo.id))
    return [...visibleMemos, ...currentEditingMemos.filter(memo => !visibleIds.has(memo.id))]
  }, [currentEditingMemos, visibleMemos])
  const focusedIndex = displayedMemos.findIndex(memo => memo.id === focusedMemoId)
  const editingIndexes = useMemo(() => currentEditingMemos.map(editing => displayedMemos.findIndex(memo => memo.id === editing.id)).filter(index => index >= 0), [currentEditingMemos, displayedMemos])
  const editingOutsideFilter = currentEditingMemos.filter(editing => !sortedMemos.some(memo => memo.id === editing.id))
  const editingOutsideIndex = editingOutsideFilter.length
    ? displayedMemos.findIndex(memo => memo.id === editingOutsideFilter[editingOutsideFilter.length - 1].id)
    : -1
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const indexes = defaultRangeExtractor(range)
    for (const index of [focusedIndex, ...editingIndexes]) {
      if (index >= 0 && !indexes.includes(index)) indexes.push(index)
    }
    return indexes.sort((a, b) => a - b)
  }, [focusedIndex, editingIndexes])

  const openFocus = (id: string) => {
    setFocusSnapshot({ ids: sortedMemos.map(memo => memo.id), scrollTop: listRef.current?.scrollTop ?? 0 })
    onFocusMemoChange(id)
  }

  useLayoutEffect(() => {
    if (!focusedMemoId && focusSnapshot) {
      if (listRef.current) listRef.current.scrollTop = focusSnapshot.scrollTop
      setFocusSnapshot(null)
    }
  }, [focusedMemoId, focusSnapshot])

  const rowVirtualizer = useVirtualizer({
    count: displayedMemos.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 96,
    overscan: 8,
    getItemKey: (index) => displayedMemos[index].id,
    rangeExtractor
  })

  useEffect(() => {
    if (editingOutsideIndex >= 0) rowVirtualizer.scrollToIndex(editingOutsideIndex, { align: 'auto' })
  }, [editingOutsideIndex])

  const clearHideTimer = () => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }

  const resetScrollTopButton = () => {
    clearHideTimer()
    scrollStartAtRef.current = null
    setShowScrollTop(false)
  }

  const scheduleHideScrollTopButton = () => {
    clearHideTimer()
    hideTimerRef.current = window.setTimeout(() => {
      setShowScrollTop(false)
      hideTimerRef.current = null
    }, 2000)
  }

  const handleScroll = () => {
    const el = listRef.current
    if (!el) return

    const currentTop = el.scrollTop
    const isScrollable = el.scrollHeight > el.clientHeight + 1
    const isScrollingDown = currentTop > lastScrollTopRef.current

    if (!isScrollable || currentTop <= 0) {
      lastScrollTopRef.current = currentTop
      resetScrollTopButton()
      return
    }

    if (isScrollingDown) {
      const now = window.performance.now()
      scrollStartAtRef.current ??= now

      if (now - scrollStartAtRef.current >= 2000) {
        setShowScrollTop(true)
        scheduleHideScrollTopButton()
      }
    } else if (currentTop < lastScrollTopRef.current) {
      scrollStartAtRef.current = null
    }

    lastScrollTopRef.current = currentTop
  }

  const handleScrollToTop = () => {
    listRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    resetScrollTopButton()
  }

  useEffect(() => {
    const el = listRef.current
    if (el) {
      lastScrollTopRef.current = el.scrollTop
    }
    resetScrollTopButton()
  }, [filter, priorityFilter, tagFilter, sortedMemos.length])

  useEffect(() => {
    return () => clearHideTimer()
  }, [])

  return (
    <div className="memo-list-shell flex-1 flex flex-col overflow-hidden">
      <FilterBar />

      <div className="relative flex-1 min-h-0">
        <div ref={listRef} onScroll={handleScroll} className="h-full overflow-y-auto px-3 py-2.5">
          {displayedMemos.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 select-none">
              <svg className="w-10 h-10 text-slate-200" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="8" y="4" width="24" height="32" rx="3" />
                <path d="M14 12h12M14 18h12M14 24h8" />
              </svg>
              <p className="text-xs text-slate-400 tracking-wide">暂无记录</p>
            </div>
          ) : (
            <div
              className="relative w-full"
              style={{ height: rowVirtualizer.getTotalSize() }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  className="absolute top-0 left-0 w-full pb-1.5"
                  style={{
                    transform: virtualRow.index === focusedIndex ? undefined : `translateY(${virtualRow.start}px)`,
                    height: virtualRow.index === focusedIndex ? virtualRow.size : undefined
                  }}
                >
                  <MemoItem
                    memo={displayedMemos[virtualRow.index]}
                    isFocused={virtualRow.index === focusedIndex}
                    onToggleFocus={() => focusedMemoId
                      ? onFocusMemoChange(null)
                      : openFocus(displayedMemos[virtualRow.index].id)}
                    onEditingChange={handleEditingChange}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {showScrollTop && (
          <button
            type="button"
            onClick={handleScrollToTop}
            aria-label="返回顶部"
            title="返回顶部"
            className="absolute right-4 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-white/70 bg-white/90 text-slate-500 shadow-lg shadow-slate-200/70 backdrop-blur transition-all duration-200 hover:-translate-y-0.5 hover:bg-indigo-50 hover:text-indigo-600 hover:shadow-indigo-100 active:translate-y-0 cursor-pointer"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 19V5" />
              <path d="M5 12l7-7 7 7" />
            </svg>
          </button>
        )}
      </div>

      {memos.filter(m => !m.deleted).length > 0 && (
        <div className="px-3 py-1.5 text-[11px] text-slate-400 border-t border-slate-100 flex justify-between tracking-wide">
          <span>{filteredMemos.length} 项</span>
          <span>{memos.filter((m) => m.status === 'completed' && !m.deleted).length} 已完成</span>
        </div>
      )}
    </div>
  )
}

export default MemoList
