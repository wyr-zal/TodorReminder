import test from 'node:test'
import assert from 'node:assert/strict'
import type { Memo } from '../src/shared/types.ts'
import { sortMemos } from '../src/renderer/utils/memoSort.ts'

function makeMemo(overrides: Partial<Memo> & { id: string }): Memo {
  return {
    content: overrides.id,
    type: 'text',
    priority: 'unimportant',
    status: 'not_started',
    attachments: [],
    tags: ['TODO'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    deviceId: 'test',
    deleted: false,
    ...overrides
  }
}

test('sortMemos keeps status and priority buckets while reversing intra-group time order', () => {
  const memos: Memo[] = [
    makeMemo({ id: 'todo-unimp-old', status: 'not_started', priority: 'unimportant', createdAt: '2026-01-01T08:00:00.000Z' }),
    makeMemo({ id: 'todo-unimp-new', status: 'not_started', priority: 'unimportant', createdAt: '2026-01-03T08:00:00.000Z' }),
    makeMemo({ id: 'todo-imp-old', status: 'not_started', priority: 'important', createdAt: '2026-01-01T09:00:00.000Z' }),
    makeMemo({ id: 'todo-imp-new', status: 'not_started', priority: 'important', createdAt: '2026-01-04T09:00:00.000Z' }),
    makeMemo({ id: 'prog-unimp-old', status: 'in_progress', priority: 'unimportant', createdAt: '2026-01-01T07:00:00.000Z' }),
    makeMemo({ id: 'prog-imp-old', status: 'in_progress', priority: 'important', createdAt: '2026-01-01T06:00:00.000Z' }),
    makeMemo({ id: 'prog-imp-new', status: 'in_progress', priority: 'important', createdAt: '2026-01-05T06:00:00.000Z' }),
    makeMemo({
      id: 'done-imp-old',
      status: 'completed',
      priority: 'important',
      createdAt: '2026-01-01T10:00:00.000Z',
      completedAt: '2026-01-02T10:00:00.000Z'
    }),
    makeMemo({
      id: 'done-unimp-new',
      status: 'completed',
      priority: 'unimportant',
      createdAt: '2026-01-01T11:00:00.000Z',
      completedAt: '2026-01-06T10:00:00.000Z'
    })
  ]

  const snapshot = memos.map(m => m.id)

  assert.deepEqual(
    sortMemos(memos, 'desc').map(m => m.id),
    [
      'prog-imp-new',
      'prog-imp-old',
      'prog-unimp-old',
      'todo-imp-new',
      'todo-imp-old',
      'todo-unimp-new',
      'todo-unimp-old',
      'done-unimp-new',
      'done-imp-old'
    ]
  )

  assert.deepEqual(
    sortMemos(memos, 'asc').map(m => m.id),
    [
      'prog-imp-old',
      'prog-imp-new',
      'prog-unimp-old',
      'todo-imp-old',
      'todo-imp-new',
      'todo-unimp-old',
      'todo-unimp-new',
      'done-imp-old',
      'done-unimp-new'
    ]
  )

  // 不篡改原数组顺序
  assert.deepEqual(memos.map(m => m.id), snapshot)
})

test('sortMemos compares completedAt ties by createdAt in matching direction', () => {
  const memos: Memo[] = [
    makeMemo({
      id: 'done-earlier-created',
      status: 'completed',
      createdAt: '2026-01-01T08:00:00.000Z',
      completedAt: '2026-01-05T12:00:00.000Z'
    }),
    makeMemo({
      id: 'done-later-created',
      status: 'completed',
      createdAt: '2026-01-02T08:00:00.000Z',
      completedAt: '2026-01-05T12:00:00.000Z'
    }),
    makeMemo({
      id: 'done-fallback-updated',
      status: 'completed',
      createdAt: '2026-01-01T07:00:00.000Z',
      updatedAt: '2026-01-03T12:00:00.000Z',
      completedAt: null
    })
  ]

  assert.deepEqual(
    sortMemos(memos, 'desc').map(m => m.id),
    ['done-later-created', 'done-earlier-created', 'done-fallback-updated']
  )
  assert.deepEqual(
    sortMemos(memos, 'asc').map(m => m.id),
    ['done-fallback-updated', 'done-earlier-created', 'done-later-created']
  )
})

test('memoStore persists sortOrder and status filter to localStorage', async () => {
  const previousLocalStorage = globalThis.localStorage
  const previousWindow = globalThis.window
  const storage = new Map<string, string>()

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) }
    }
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { electronAPI: {} }
  })

  try {
    const { useMemoStore } = await import(`../src/renderer/store/memoStore.ts?t=${Date.now()}`)
    assert.equal(useMemoStore.getState().sortOrder, 'desc')
    assert.equal(useMemoStore.getState().filter, 'all')

    useMemoStore.getState().setSortOrder('asc')
    useMemoStore.getState().setFilter('in_progress')

    assert.equal(useMemoStore.getState().sortOrder, 'asc')
    assert.equal(useMemoStore.getState().filter, 'in_progress')
    assert.equal(storage.get('memo-sort-order'), 'asc')
    assert.equal(storage.get('memo-status-filter'), 'in_progress')
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousLocalStorage })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})
