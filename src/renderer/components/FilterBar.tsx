import { useRef, useState, useEffect, useLayoutEffect } from 'react'
import { useMemoStore } from '../store/memoStore'
import { MemoSortOrder, Priority } from '../../shared/types'

type TagExpandLevel = 'collapsed' | 'preview' | 'full'

const TAGS_LINE_HEIGHT = 26
const TAGS_COLLAPSED_MAX_HEIGHT = TAGS_LINE_HEIGHT
const TAGS_PREVIEW_MAX_HEIGHT = TAGS_LINE_HEIGHT * 3

// 重要等级循环切换：信号条颜色即当前筛选态
const priorityCycle: { value: Priority | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'important', label: '重要' },
  { value: 'unimportant', label: '不重要' }
]

// 单个方格用颜色表示重要等级筛选状态
function PriorityBarsIcon({ filter }: { filter: Priority | 'all' }) {
  const color = filter === 'important'
    ? 'fill-red-500'
    : filter === 'unimportant'
      ? 'fill-green-500'
      : 'fill-slate-400'
  return (
    <svg className="h-4 w-4" viewBox="0 0 14 14" aria-hidden="true">
      <rect x="2" y="2" width="10" height="10" rx="2.5" className={color} />
    </svg>
  )
}

// 排序图标：倒序（向下箭头 + 上宽下窄） / 顺序（向上箭头 + 上窄下宽）
function SortOrderIcon({ order }: { order: MemoSortOrder }) {
  if (order === 'asc') {
    return (
      <svg className="h-4 w-4 text-indigo-500" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4.5 13V3" />
        <path d="M2.3 5.5 4.5 3l2.2 2.5" />
        <path d="M8.5 4h2" />
        <path d="M8.5 8h3.5" />
        <path d="M8.5 12h5" />
      </svg>
    )
  }
  return (
    <svg className="h-4 w-4 text-slate-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 3v10" />
      <path d="M2.3 10.5 4.5 13l2.2-2.5" />
      <path d="M8.5 4h5" />
      <path d="M8.5 8h3.5" />
      <path d="M8.5 12h2" />
    </svg>
  )
}

const tagButtonBase =
  'inline-flex h-[22px] items-center align-top mr-1 px-2 text-[11px] rounded-md transition-colors cursor-pointer'

function FilterBar() {
  const {
    priorityFilter,
    setPriorityFilter,
    tagFilter,
    setTagFilter,
    sortOrder,
    setSortOrder,
    getAllTags
  } = useMemoStore()
  const allTags = getAllTags()
  const allTagsKey = allTags.join('\u0000')
  const [tagExpandLevel, setTagExpandLevel] = useState<TagExpandLevel>('collapsed')
  const [tagOverflow, setTagOverflow] = useState({ needsPreview: false, needsFull: false })
  const [controlsWidth, setControlsWidth] = useState(0)
  const tagsRef = useRef<HTMLDivElement>(null)
  const controlsRef = useRef<HTMLDivElement>(null)

  const showExpandControls = tagExpandLevel !== 'collapsed'

  // 收起态：控件浮在右上角，标签需要为它让位；展开态：控件独占标签下方一行
  useLayoutEffect(() => {
    const el = controlsRef.current
    if (el && !showExpandControls) setControlsWidth(el.offsetWidth)
  }, [showExpandControls])

  useEffect(() => {
    const el = tagsRef.current
    if (el) {
      const fullHeight = el.scrollHeight
      // 收起态含让位块，只据此判断能否展开；展开态铺满整宽，只据此判断能否再展开全部
      setTagOverflow(prev => {
        const next = showExpandControls
          ? { ...prev, needsFull: fullHeight > TAGS_PREVIEW_MAX_HEIGHT + 2 }
          : { ...prev, needsPreview: fullHeight > TAGS_COLLAPSED_MAX_HEIGHT + 2 }
        return next.needsPreview === prev.needsPreview && next.needsFull === prev.needsFull
          ? prev
          : next
      })
    }
  }, [allTagsKey, showExpandControls, tagExpandLevel, controlsWidth])

  useEffect(() => {
    setTagExpandLevel('collapsed')
  }, [allTagsKey])

  // 双击「全部」标签展开一级
  const handleAllTagDoubleClick = () => {
    if (tagOverflow.needsPreview && tagExpandLevel === 'collapsed') {
      setTagExpandLevel('preview')
    }
  }

  // 循环切换重要等级：全部 → 重要 → 不重要
  const handlePriorityCycle = () => {
    const idx = priorityCycle.findIndex((p) => p.value === priorityFilter)
    setPriorityFilter(priorityCycle[(idx + 1) % priorityCycle.length].value)
  }

  // 切换组内时间顺序：倒序（最新在前） ↔ 顺序（最早在前）
  const handleSortOrderToggle = () => {
    setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc')
  }

  const priorityCurrent = priorityCycle.find((p) => p.value === priorityFilter) ?? priorityCycle[0]
  const sortLabel = sortOrder === 'desc' ? '倒序（最新在前）' : '顺序（最早在前）'

  const tagContainerMaxHeight =
    tagExpandLevel === 'full'
      ? undefined
      : tagExpandLevel === 'preview'
        ? TAGS_PREVIEW_MAX_HEIGHT
        : TAGS_COLLAPSED_MAX_HEIGHT

  return (
    <div className="relative px-3 py-1.5 border-b border-slate-100 min-h-[38px]">
      {/* 标签筛选：收起态环绕右上角控件，展开态铺满整行 */}
      <div
        ref={tagsRef}
        className="overflow-hidden"
        style={{ maxHeight: tagContainerMaxHeight, lineHeight: `${TAGS_LINE_HEIGHT}px` }}
      >
        {/* 收起态为右上角控件让位的占位块 */}
        {!showExpandControls && (
          <div
            className="float-right"
            style={{ width: controlsWidth + 8, height: TAGS_LINE_HEIGHT }}
            aria-hidden="true"
          />
        )}
        {allTags.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setTagFilter(null)}
              onDoubleClick={handleAllTagDoubleClick}
              title="单击显示全部，双击展开"
              className={`${tagButtonBase} ${
                tagFilter === null
                  ? 'bg-violet-50 text-violet-600 border border-violet-200'
                  : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
              }`}
            >
              全部
            </button>
            {allTags.map(tag => (
              <button
                type="button"
                key={tag}
                onClick={() => setTagFilter(tag)}
                className={`${tagButtonBase} ${
                  tagFilter === tag
                    ? 'bg-violet-50 text-violet-600 border border-violet-200'
                    : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
                }`}
              >
                #{tag}
              </button>
            ))}
          </>
        )}
      </div>

      {/* 优先级筛选 + 展开控制：收起态浮在右上角，展开态独占标签下方一行 */}
      <div
        ref={controlsRef}
        className={
          showExpandControls
            ? 'mt-1 flex items-center justify-end gap-1'
            : 'absolute right-3 top-1.5 flex items-center gap-1'
        }
      >
        {/* 重要等级循环切换 */}
        <button
          type="button"
          onClick={handlePriorityCycle}
          title={`重要等级：${priorityCurrent.label}`}
          aria-label={`重要等级筛选：${priorityCurrent.label}`}
          aria-haspopup="true"
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded transition-colors cursor-pointer hover:bg-slate-100"
        >
          <PriorityBarsIcon filter={priorityFilter} />
        </button>

        {/* 组内时间排序切换：倒序（最新在前） ↔ 顺序（最早在前） */}
        <button
          type="button"
          onClick={handleSortOrderToggle}
          title={`排序：${sortLabel}`}
          aria-label={`列表排序：${sortLabel}`}
          aria-pressed={sortOrder === 'asc'}
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded transition-colors cursor-pointer hover:bg-slate-100"
        >
          <SortOrderIcon order={sortOrder} />
        </button>

        {showExpandControls && (
          <div className="flex items-center gap-1 shrink-0">
            {tagExpandLevel === 'preview' && tagOverflow.needsFull && (
              <button
                type="button"
                onClick={() => setTagExpandLevel('full')}
                className="px-1.5 py-0.5 text-[11px] text-slate-400 hover:text-slate-600 cursor-pointer"
                aria-expanded={false}
              >
                展开全部
              </button>
            )}
            <button
              type="button"
              onClick={() => setTagExpandLevel('collapsed')}
              className="px-1.5 py-0.5 text-[11px] text-slate-400 hover:text-slate-600 cursor-pointer"
              aria-expanded={tagExpandLevel === 'full'}
            >
              收起
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default FilterBar
