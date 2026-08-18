import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useMemoStore } from '../store/memoStore'
import MemoItem from './MemoItem'
import FilterBar from './FilterBar'

function MemoList() {
  const { memos, filter, priorityFilter, tagFilter } = useMemoStore()
  const listRef = useRef<HTMLDivElement>(null)
  const scrollStartAtRef = useRef<number | null>(null)
  const lastScrollTopRef = useRef(0)
  const hideTimerRef = useRef<number | null>(null)
  const [showScrollTop, setShowScrollTop] = useState(false)

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
      // 已完成的统一沉底
      const aCompleted = a.status === 'completed' ? 1 : 0
      const bCompleted = b.status === 'completed' ? 1 : 0
      if (aCompleted !== bCompleted) return aCompleted - bCompleted
      // 同组内按优先级 + 时间排序
      const priorityOrder = { high: 0, medium: 1, low: 2 }
      if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
        return priorityOrder[a.priority] - priorityOrder[b.priority]
      }
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    })
  }, [filteredMemos])


  const rowVirtualizer = useVirtualizer({
    count: sortedMemos.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 96,
    overscan: 8,
    getItemKey: (index) => sortedMemos[index].id
  })

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
    <div className="flex-1 flex flex-col overflow-hidden">
      <FilterBar />

      <div className="relative flex-1 min-h-0">
        <div ref={listRef} onScroll={handleScroll} className="h-full overflow-y-auto px-3 py-2.5">
          {sortedMemos.length === 0 ? (
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
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <MemoItem memo={sortedMemos[virtualRow.index]} />
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
