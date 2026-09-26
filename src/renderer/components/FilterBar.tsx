import { useRef, useState, useEffect, useLayoutEffect } from 'react'
import { useMemoStore, type StatusFilter } from '../store/memoStore'
import { Priority } from '../../shared/types'

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

// 状态循环切换：全部 → 未开始 → 进行中 → 已完成
const statusCycle = [
  { value: 'all', label: '全部' },
  { value: 'not_started', label: '未开始' },
  { value: 'in_progress', label: '进行中' },
  { value: 'completed', label: '已完成' }
] as const

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

// 状态图标：空心（全部/未开始）/ 播放（进行中）/ 勾选（已完成）
function StatusIcon({ filter }: { filter: StatusFilter }) {
  if (filter === 'completed') {
    return (
      <svg className="h-4 w-4" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="7" className="fill-emerald-500" />
        <path
          d="M4.6 8.3l2.3 2.3 4.5-5"
          fill="none"
          stroke="#fff"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (filter === 'in_progress') {
    return (
      <svg className="h-4 w-4 text-indigo-500" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="7" className="fill-current" />
        <path d="M6.5 4.8 11 8l-4.5 3.2z" className="fill-white" />
      </svg>
    )
  }
  if (filter === 'not_started') {
    return (
      <svg className="h-4 w-4 text-indigo-500" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" />
      </svg>
    )
  }
  return (
    <svg className="h-4 w-4 text-slate-400" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" />
      <path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" />
    </svg>
  )
}

const tagButtonBase =
  'inline-flex h-[22px] items-center align-top mr-1 px-2 text-[11px] rounded-md transition-colors cursor-pointer'

function FilterBar() {
  const {
    filter,
    setFilter,
    priorityFilter,
    setPriorityFilter,
    tagFilter,
    setTagFilter,
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

  // 循环切换状态：全部 → 未开始 → 进行中 → 已完成
  const handleStatusCycle = () => {
    const idx = statusCycle.findIndex((s) => s.value === filter)
    setFilter(statusCycle[(idx + 1) % statusCycle.length].value)
  }

  const priorityCurrent = priorityCycle.find((p) => p.value === priorityFilter) ?? priorityCycle[0]
  const statusCurrent = statusCycle.find((s) => s.value === filter) ?? statusCycle[0]

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
              title="单击显示全部标签，双击展开标签列表"
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
          title={`重要等级：${priorityCurrent.label}（点击切换）`}
          aria-label={`按重要等级筛选，当前${priorityCurrent.label}，点击切换`}
          aria-haspopup="true"
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded transition-colors cursor-pointer hover:bg-slate-100"
        >
          <PriorityBarsIcon filter={priorityFilter} />
        </button>

        {/* 状态循环切换：全部 → 未开始 → 进行中 → 已完成 */}
        <button
          type="button"
          onClick={handleStatusCycle}
          title={`状态：${statusCurrent.label}（点击切换）`}
          aria-label={`按状态筛选，当前${statusCurrent.label}，点击切换`}
          aria-haspopup="true"
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded transition-colors cursor-pointer hover:bg-slate-100"
        >
          <StatusIcon filter={filter} />
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
