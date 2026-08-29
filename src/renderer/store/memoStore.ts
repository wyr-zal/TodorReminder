import { create } from 'zustand'
import { Memo, Priority, MemoStatus, TagSortMode } from '../../shared/types'
import { v4 as uuidv4 } from 'uuid'

const TAG_SORT_KEY = 'memo-tag-sort'

function getSavedTagSort(): TagSortMode {
  const v = localStorage.getItem(TAG_SORT_KEY)
  if (v === 'latest' || v === 'count' || v === 'alpha') return v
  return 'latest'
}

interface MemoState {
  memos: Memo[]
  filter: MemoStatus | 'all'
  priorityFilter: Priority | 'all'
  tagFilter: string | null
  tagSort: TagSortMode
  isLoading: boolean

  loadMemos: () => Promise<void>
  addMemo: (content: string, priority?: Priority, tags?: string[]) => Promise<void>
  addImageMemo: (content: string, priority: Priority, imageFilenames: string[], tags?: string[]) => Promise<void>
  updateMemo: (id: string, updates: Partial<Memo>) => Promise<void>
  deleteMemo: (id: string) => Promise<void>
  toggleStatus: (id: string) => void
  setFilter: (filter: MemoStatus | 'all') => void
  setPriorityFilter: (priority: Priority | 'all') => void
  setTagFilter: (tag: string | null) => void
  setTagSort: (mode: TagSortMode) => void
  getAllTags: () => string[]
}

export const useMemoStore = create<MemoState>((set, get) => ({
  memos: [],
  filter: 'all',
  priorityFilter: 'all',
  tagFilter: null,
  tagSort: getSavedTagSort(),
  isLoading: false,

  loadMemos: async () => {
    set({ isLoading: true })
    try {
      const memos = await window.electronAPI.memo.getAll()
      set({ memos, isLoading: false })
    } catch (error) {
      console.error('Failed to load memos:', error)
      set({ isLoading: false })
    }
  },

  addMemo: async (content: string, priority: Priority = 'medium', tags: string[] = []) => {
    const now = new Date().toISOString()
    const newMemo: Memo = {
      id: uuidv4(),
      content,
      type: 'text',
      priority,
      status: 'pending',
      attachments: [],
      tags,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      deviceId: 'desktop',
      deleted: false
    }
    set((state) => ({ memos: [newMemo, ...state.memos] }))
    try {
      await window.electronAPI.memo.add(newMemo)
    } catch (error) {
      console.error('Failed to add memo:', error)
      set((state) => ({ memos: state.memos.filter((m) => m.id !== newMemo.id) }))
    }
  },

  addImageMemo: async (content: string, priority: Priority, imageFilenames: string[], tags: string[] = []) => {
    const now = new Date().toISOString()
    const newMemo: Memo = {
      id: uuidv4(),
      content,
      type: 'image',
      priority,
      status: 'pending',
      attachments: imageFilenames,
      tags,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      deviceId: 'desktop',
      deleted: false
    }
    set((state) => ({ memos: [newMemo, ...state.memos] }))
    try {
      await window.electronAPI.memo.add(newMemo)
    } catch (error) {
      console.error('Failed to add image memo:', error)
      set((state) => ({ memos: state.memos.filter((m) => m.id !== newMemo.id) }))
    }
  },

  updateMemo: async (id: string, updates: Partial<Memo>) => {
    const oldMemos = get().memos
    set((state) => ({
      memos: state.memos.map((memo) =>
        memo.id === id
          ? { ...memo, ...updates, updatedAt: new Date().toISOString() }
          : memo
      )
    }))
    try {
      await window.electronAPI.memo.update(id, updates)
    } catch (error) {
      console.error('Failed to update memo:', error)
      set({ memos: oldMemos })
    }
  },

  deleteMemo: async (id: string) => {
    const oldMemos = get().memos
    set((state) => ({ memos: state.memos.filter((memo) => memo.id !== id) }))
    try {
      await window.electronAPI.memo.delete(id)
    } catch (error) {
      console.error('Failed to delete memo:', error)
      set({ memos: oldMemos })
    }
  },

  toggleStatus: (id: string) => {
    const memo = get().memos.find((m) => m.id === id)
    if (!memo) return
    const nextStatus: Record<MemoStatus, MemoStatus> = {
      pending: 'completed',
      completed: 'deferred',
      deferred: 'pending'
    }
    const status = nextStatus[memo.status]
    get().updateMemo(id, {
      status,
      completedAt: status === 'completed' ? new Date().toISOString() : null
    })
  },

  setFilter: (filter: MemoStatus | 'all') => set({ filter }),

  setPriorityFilter: (priority: Priority | 'all') => set({ priorityFilter: priority }),

  setTagFilter: (tag: string | null) => set({ tagFilter: tag }),

  setTagSort: (mode: TagSortMode) => {
    localStorage.setItem(TAG_SORT_KEY, mode)
    set({ tagSort: mode })
  },

  getAllTags: () => {
    const { memos, tagSort } = get()
    const activeMemos = memos.filter(m => !m.deleted)

    // 收集每个 tag 的信息
    const tagInfo = new Map<string, { count: number; latestUpdatedAt: string }>()

    activeMemos.forEach(memo => {
      const isIncomplete = memo.status !== 'completed'
      ;(memo.tags || []).forEach(tag => {
        const cur = tagInfo.get(tag) || { count: 0, latestUpdatedAt: '' }
        tagInfo.set(tag, {
          count: cur.count + (isIncomplete ? 1 : 0),
          latestUpdatedAt: memo.updatedAt > cur.latestUpdatedAt ? memo.updatedAt : cur.latestUpdatedAt
        })
      })
    })

    // 只保留有未完成任务的标签
    const entries = Array.from(tagInfo.entries()).filter(([, info]) => info.count > 0)

    if (tagSort === 'latest') {
      entries.sort((a, b) => b[1].latestUpdatedAt.localeCompare(a[1].latestUpdatedAt))
    } else if (tagSort === 'count') {
      entries.sort((a, b) => {
        const diff = b[1].count - a[1].count
        return diff !== 0 ? diff : a[0].localeCompare(b[0])
      })
    } else {
      // alpha
      entries.sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))
    }

    return entries.map(([tag]) => tag)
  }
}))
