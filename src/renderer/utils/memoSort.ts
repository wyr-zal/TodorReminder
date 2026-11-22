import type { Memo, MemoSortOrder, MemoStatus, Priority } from '../../shared/types'

// 列表状态分档：进行中置顶，未开始次之，已完成沉底
const STATUS_RANK: Record<MemoStatus, number> = { in_progress: 0, not_started: 1, completed: 2 }
const PRIORITY_RANK: Record<Priority, number> = { important: 0, unimportant: 1 }

function compareTime(a: string, b: string, sortOrder: MemoSortOrder): number {
  const diff = new Date(a).getTime() - new Date(b).getTime()
  if (diff !== 0 && !Number.isNaN(diff)) {
    return sortOrder === 'asc' ? diff : -diff
  }
  return sortOrder === 'asc' ? a.localeCompare(b) : b.localeCompare(a)
}

/** 按状态与重要度分组，组内根据 sortOrder 按时间顺序或倒序排列 */
export function sortMemos(memos: Memo[], sortOrder: MemoSortOrder = 'desc'): Memo[] {
  return [...memos].sort((a, b) => {
    const rankDiff = STATUS_RANK[a.status] - STATUS_RANK[b.status]
    if (rankDiff !== 0) return rankDiff
    // 已完成记录按点击完成时间排序，不再受优先级影响
    if (a.status === 'completed') {
      const completedTimeDiff = compareTime(a.completedAt ?? a.updatedAt, b.completedAt ?? b.updatedAt, sortOrder)
      if (completedTimeDiff !== 0) return completedTimeDiff
      return compareTime(a.createdAt, b.createdAt, sortOrder)
    }
    // 进行中 / 未开始：重要在前，再按创建时间正/倒序
    const priorityDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    if (priorityDiff !== 0) return priorityDiff
    return compareTime(a.createdAt, b.createdAt, sortOrder)
  })
}
