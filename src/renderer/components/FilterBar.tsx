import { useRef, useState, useEffect } from 'react'
import { useMemoStore } from '../store/memoStore'
import { MemoStatus, Priority } from '../../shared/types'

type TagExpandLevel = 'collapsed' | 'preview' | 'full'

const TAGS_COLLAPSED_MAX_HEIGHT = 22
const TAGS_PREVIEW_MAX_HEIGHT = 74

const filters: { value: MemoStatus | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待处理' },
  { value: 'completed', label: '已完成' },
  { value: 'deferred', label: '延后' }
]

const priorityFilters: { value: Priority | 'all'; label: string }[] = [
  { value: 'all', label: '全部优先级' },
  { value: 'high', label: '高优先' },
  { value: 'medium', label: '中优先' },
  { value: 'low', label: '低优先' }
]

function FilterBar() {
  const { filter, setFilter, priorityFilter, setPriorityFilter, tagFilter, setTagFilter, getAllTags } = useMemoStore()
  const allTags = getAllTags()
  const allTagsKey = allTags.join('\u0000')
  const [tagExpandLevel, setTagExpandLevel] = useState<TagExpandLevel>('collapsed')
  const [tagOverflow, setTagOverflow] = useState({ needsPreview: false, needsFull: false })
  const tagsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = tagsRef.current
    if (el) {
      const fullHeight = el.scrollHeight
      const nextOverflow = {
        needsPreview: fullHeight > TAGS_COLLAPSED_MAX_HEIGHT + 2,
        needsFull: fullHeight > TAGS_PREVIEW_MAX_HEIGHT + 2
      }
      setTagOverflow(nextOverflow)
      setTagExpandLevel(prev => {
        if (!nextOverflow.needsPreview) return 'collapsed'
        if (prev === 'full' && !nextOverflow.needsFull) return 'preview'
        return prev
      })
    }
  }, [allTagsKey, tagExpandLevel])

  useEffect(() => {
    setTagExpandLevel('collapsed')
  }, [allTagsKey])

  const tagContainerHeightClass =
    tagExpandLevel === 'full'
      ? ''
      : tagExpandLevel === 'preview'
        ? 'max-h-[74px] overflow-hidden'
        : 'max-h-[22px] overflow-hidden'

  return (
    <div className="px-3 py-1.5 border-b border-slate-100 space-y-1.5">
      {/* 状态 + 优先级筛选 */}
      <div className="flex flex-wrap items-center gap-1">
        {filters.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`px-2.5 py-1 text-[11px] rounded-md transition-colors cursor-pointer font-medium ${
              filter === f.value
                ? 'bg-indigo-50 text-indigo-600 border border-indigo-200'
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
            }`}
          >
            {f.label}
          </button>
        ))}

        <div className="relative ml-auto">
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
      </div>

      {/* 标签筛选 */}
      {allTags.length > 0 && (
        <div className="flex items-end gap-1">
          <div
            ref={tagsRef}
            className={`flex flex-wrap gap-1 flex-1 ${tagContainerHeightClass}`}
          >
            <button
              type="button"
              onClick={() => setTagFilter(null)}
              className={`px-2 py-0.5 text-[11px] rounded-md transition-colors cursor-pointer ${
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
                className={`px-2 py-0.5 text-[11px] rounded-md transition-colors cursor-pointer ${
                  tagFilter === tag
                    ? 'bg-violet-50 text-violet-600 border border-violet-200'
                    : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
                }`}
              >
                #{tag}
              </button>
            ))}
          </div>
          {(tagOverflow.needsPreview || tagExpandLevel !== 'collapsed') && (
            <div className="flex gap-1 shrink-0">
              {tagExpandLevel === 'collapsed' && (
                <button
                  type="button"
                  onClick={() => setTagExpandLevel('preview')}
                  className="px-1.5 py-0.5 text-[11px] text-slate-400 hover:text-slate-600 cursor-pointer"
                  aria-expanded={false}
                >
                  展开
                </button>
              )}
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
              {tagExpandLevel !== 'collapsed' && (
                <button
                  type="button"
                  onClick={() => setTagExpandLevel('collapsed')}
                  className="px-1.5 py-0.5 text-[11px] text-slate-400 hover:text-slate-600 cursor-pointer"
                  aria-expanded={tagExpandLevel === 'full'}
                >
                  收起
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default FilterBar
