import { useRef, useState, useEffect, useLayoutEffect } from 'react'
import { useMemoStore } from '../store/memoStore'
import { Priority } from '../../shared/types'

type TagExpandLevel = 'collapsed' | 'preview' | 'full'

const TAGS_LINE_HEIGHT = 26
const TAGS_COLLAPSED_MAX_HEIGHT = TAGS_LINE_HEIGHT
const TAGS_PREVIEW_MAX_HEIGHT = TAGS_LINE_HEIGHT * 3

const priorityFilters: { value: Priority | 'all'; label: string }[] = [
  { value: 'all', label: '全部优先级' },
  { value: 'high', label: '高优先' },
  { value: 'medium', label: '中优先' },
  { value: 'low', label: '低优先' }
]

const tagButtonBase =
  'inline-flex h-[22px] items-center align-top mr-1 px-2 text-[11px] rounded-md transition-colors cursor-pointer'

function FilterBar() {
  const { priorityFilter, setPriorityFilter, tagFilter, setTagFilter, getAllTags } = useMemoStore()
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
        <div className="relative shrink-0">
          <select
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value as Priority | 'all')}
            aria-label="按优先级筛选"
            title="按优先级筛选"
            className="h-[26px] appearance-none rounded-md border border-slate-200 bg-white pl-2.5 pr-6 text-[11px] font-medium text-slate-500 outline-none transition-colors cursor-pointer hover:border-indigo-200 hover:bg-slate-50 hover:text-slate-700 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-500/20"
          >
            {priorityFilters.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <svg
            className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-400"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
              clipRule="evenodd"
            />
          </svg>
        </div>

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
