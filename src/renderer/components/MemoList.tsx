import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import { useMemoStore } from '../store/memoStore'
import type { Memo } from '../../shared/types'
import { sortMemos } from '../utils/memoSort'
import { matchesMemoSearch } from '../utils/memoSearch'
import MemoItem from './MemoItem'
import FilterBar from './FilterBar'

const SCROLL_TOP_REVEAL_INDEX = 3

interface MemoListProps {
  focusedMemoId: string | null
  onFocusMemoChange: (id: string | null) => void
}

function MemoList({ focusedMemoId, onFocusMemoChange }: MemoListProps) {
  const {
    memos,
    filter,
    priorityFilter,
    tagFilter,
    sortOrder,
    isSearchOpen,
    searchQuery,
    searchFocusTick,
    setSearchQuery,
    closeSearch
  } = useMemoStore()
  const listRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [showScrollTop, setShowScrollTop] = useState(false)
  const [focusSnapshot, setFocusSnapshot] = useState<{ ids: string[]; scrollTop: number } | null>(null)
  const [editingMemos, setEditingMemos] = useState<Record<string, Memo>>({})
  const scrollAnimRef = useRef<number | null>(null)
  const prevSortOrderRef = useRef(sortOrder)
  const preSearchScrollTopRef = useRef<number | null>(null)
  const prevSearchStateRef = useRef({ active: false, query: '' })
  // 记录上一帧各行几何，行消失（删除/远端同步）时补偿 scrollTop 保持视口连续
  const prevRowsRef = useRef<{ ids: string[]; rects: Map<string, { top: number; height: number }>; scrollTop: number } | null>(null)

  const cancelScrollAnim = () => {
    if (scrollAnimRef.current !== null) {
      window.cancelAnimationFrame(scrollAnimRef.current)
      scrollAnimRef.current = null
    }
  }
  const handleEditingChange = useCallback((memo: Memo | null, id: string) => {
    setEditingMemos(current => {
      if (memo) return { ...current, [id]: memo }
      const remaining = { ...current }
      delete remaining[id]
      return remaining
    })
  }, [])

  const hasActiveSearch = isSearchOpen && searchQuery.trim().length > 0

  const filteredMemos = useMemo(() => {
    return memos.filter((memo) => {
      if (memo.deleted) return false
      if (hasActiveSearch) return matchesMemoSearch(memo, searchQuery)
      if (filter !== 'all' && memo.status !== filter) return false
      if (priorityFilter !== 'all' && memo.priority !== priorityFilter) return false
      if (tagFilter && !(memo.tags || []).includes(tagFilter)) return false
      return true
    })
  }, [filter, hasActiveSearch, memos, priorityFilter, searchQuery, tagFilter])

  const sortedMemos = useMemo(() => {
    return sortMemos(filteredMemos, sortOrder)
  }, [filteredMemos, sortOrder])


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

  const handleListScroll = () => {
    const el = listRef.current
    if (!el) return
    if (el.scrollTop <= 0) {
      setShowScrollTop(false)
      return
    }
    if ((rowVirtualizer.getVirtualItemForOffset(el.scrollTop)?.index ?? 0) >= SCROLL_TOP_REVEAL_INDEX) {
      setShowScrollTop(true)
    }
  }

  useEffect(() => {
    if (prevSortOrderRef.current !== sortOrder) {
      prevSortOrderRef.current = sortOrder
      cancelScrollAnim()
      if (listRef.current && !focusedMemoId) listRef.current.scrollTop = 0
    }
    setShowScrollTop(false)
  }, [filter, priorityFilter, tagFilter, sortOrder, focusedMemoId])

  useEffect(() => {
    if (editingOutsideIndex >= 0) rowVirtualizer.scrollToIndex(editingOutsideIndex, { align: 'auto' })
  }, [editingOutsideIndex])

  useEffect(() => {
    if (!isSearchOpen || focusedMemoId) return
    const input = searchInputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [isSearchOpen, searchFocusTick, focusedMemoId])

  useLayoutEffect(() => {
    const prev = prevSearchStateRef.current
    const normalized = hasActiveSearch ? searchQuery.trim() : ''
    if (prev.active === hasActiveSearch && prev.query === normalized) return
    prevSearchStateRef.current = { active: hasActiveSearch, query: normalized }

    const el = listRef.current
    // 搜索结果切换会导致大量行增删，重置行快照以免触发删除行补偿逻辑
    prevRowsRef.current = null
    cancelScrollAnim()

    if (!el || focusedMemoId) return
    if (!prev.active && hasActiveSearch) {
      preSearchScrollTopRef.current = el.scrollTop
      el.scrollTop = 0
      setShowScrollTop(false)
    } else if (hasActiveSearch) {
      el.scrollTop = 0
      setShowScrollTop(false)
    } else if (prev.active && !hasActiveSearch) {
      el.scrollTop = preSearchScrollTopRef.current ?? 0
      preSearchScrollTopRef.current = null
      setShowScrollTop(false)
    }
  }, [focusedMemoId, hasActiveSearch, searchQuery])

  // 删除/远端同步移除行后保持视口连续：被移除行原位于视口内或其上方时，
  // 把 scrollTop 收缩对应高度，防止下方内容突然上跳（absolute 布局浏览器无法自动锚定）
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const prev = prevRowsRef.current
    const rects = new Map<string, { top: number; height: number }>()
    for (const item of rowVirtualizer.getVirtualItems()) {
      const node = el.querySelector(`[data-index="${item.index}"]`)
      if (node) rects.set(String(displayedMemos[item.index]?.id), { top: node.getBoundingClientRect().top, height: node.getBoundingClientRect().height })
    }
    if (prev) {
      const ids = new Set(rects.keys())
      const removed = [...prev.rects.entries()].filter(([id]) => !ids.has(id))
      // 关键判定：行真的被移除（不是虚拟回收）。虚拟回收时 same-key 行仍在 displayedMemos
      const trulyRemoved = removed.filter(([id]) => displayedMemos.some(memo => memo.id === id) === false)
      if (trulyRemoved.length && !focusedMemoId) {
        const viewportTop = el.getBoundingClientRect().top
        let pull = 0
        for (const [, rect] of trulyRemoved) {
          if (rect.top >= viewportTop) continue
          // 行整体在视口顶边上方：下方内容被上抽该行全部高度（含行距）
          if (rect.top + rect.height <= viewportTop) pull += rect.height + 6
          // 行部分可见（跨视口顶边）：上方保留部分仍占位，只需补偿视口内消失的部分
          else pull += viewportTop - rect.top
        }
        if (pull > 1) {
          cancelScrollAnim()
          el.scrollTop = Math.max(0, el.scrollTop - pull)
        }
      }
    }
    prevRowsRef.current = { ids: [...rects.keys()], rects, scrollTop: el.scrollTop }
  })

  // 回到顶部：不用浏览器 smooth——虚拟列表深处的未测量行会让 smooth 中途被打断。
  // 用 rAF 手写缓动，避免动画被布局抖动打断。
  const handleScrollToTop = () => {
    const el = listRef.current
    if (!el) return
    cancelScrollAnim()
    const start = el.scrollTop
    if (start <= 0) return
    const duration = Math.min(600, Math.max(200, start * 0.35))
    const t0 = performance.now()
    const step = (now: number) => {
      const progress = Math.min(1, (now - t0) / duration)
      const eased = 1 - Math.pow(1 - progress, 3)
      el.scrollTop = start * (1 - eased)
      if (progress < 1) scrollAnimRef.current = window.requestAnimationFrame(step)
      else scrollAnimRef.current = null
    }
    scrollAnimRef.current = window.requestAnimationFrame(step)
  }

  useEffect(() => {
    return () => { cancelScrollAnim() }
  }, [])

  return (
    <div className="memo-list-shell flex-1 flex flex-col overflow-hidden">
      <FilterBar />

      {isSearchOpen && (
        <div className="memo-search-bar flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-100 bg-slate-50">
          <svg
            className="w-3.5 h-3.5 shrink-0 text-slate-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                e.stopPropagation()
                closeSearch()
              }
            }}
            aria-label="搜索待办内容或标签"
            placeholder="搜索全部正文或标签… (Esc 关闭)"
            className="flex-1 min-w-0 bg-transparent text-xs text-slate-700 placeholder-slate-400 focus:outline-none"
          />
          {hasActiveSearch && (
            <span className="shrink-0 text-[11px] text-slate-400 tabular-nums">
              {filteredMemos.length} 条
            </span>
          )}
          {searchQuery && (
            <button
              type="button"
              onClick={() => {
                setSearchQuery('')
                searchInputRef.current?.focus()
              }}
              aria-label="清空搜索词"
              title="清空搜索词"
              className="px-1 py-0.5 text-[11px] text-slate-400 hover:text-slate-600 rounded hover:bg-slate-200 transition-colors cursor-pointer"
            >
              清空
            </button>
          )}
          <button
            type="button"
            onClick={closeSearch}
            aria-label="关闭搜索"
            title="关闭搜索 (Esc)"
            className="p-0.5 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-200 transition-colors cursor-pointer"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      )}

      <div className="relative flex-1 min-h-0">
        <div ref={listRef} onScroll={handleListScroll} className="h-full overflow-y-auto px-3 py-2.5">
          {displayedMemos.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 select-none">
              <svg className="w-10 h-10 text-slate-200" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="8" y="4" width="24" height="32" rx="3" />
                <path d="M14 12h12M14 18h12M14 24h8" />
              </svg>
              <p className="text-xs text-slate-400 tracking-wide">
                {hasActiveSearch ? '未找到匹配的待办' : '暂无记录'}
              </p>
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
                    // Use layout offsets so sticky actions follow the scroll viewport.
                    top: virtualRow.start,
                    height: virtualRow.index === focusedIndex ? virtualRow.size : undefined
                  }}
                >
                  <MemoItem
                    memo={displayedMemos[virtualRow.index]}
                    isFocused={virtualRow.index === focusedIndex}
                    searchQuery={hasActiveSearch ? searchQuery : undefined}
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
            className="fixed right-4 bottom-10 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-white/70 bg-white/90 text-slate-500 shadow-lg shadow-slate-200/70 backdrop-blur transition-all duration-200 hover:-translate-y-0.5 hover:bg-indigo-50 hover:text-indigo-600 hover:shadow-indigo-100 active:translate-y-0 cursor-pointer"
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
