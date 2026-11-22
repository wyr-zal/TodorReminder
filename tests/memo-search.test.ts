import test from 'node:test'
import assert from 'node:assert/strict'
import type { Memo } from '../src/shared/types.ts'
import {
  getSearchableMemoContent,
  matchesMemoSearch,
  splitHighlightSegments,
  splitTagHighlightSegments
} from '../src/renderer/utils/memoSearch.ts'

function makeMemo(overrides: Partial<Memo> = {}): Memo {
  return {
    id: 'memo-1',
    content: '普通待办',
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

test('matchesMemoSearch matches content and tags case-insensitively and handles # prefix', () => {
  const contentMemo = makeMemo({ content: '买一个无线键盘', tags: ['工作'] })
  const tagMemo = makeMemo({ content: '桌面外设清单', tags: ['机械键盘', 'API'] })

  assert.equal(matchesMemoSearch(contentMemo, '键盘'), true)
  assert.equal(matchesMemoSearch(tagMemo, '键盘'), true)
  assert.equal(matchesMemoSearch(tagMemo, '#键盘'), true)
  assert.equal(matchesMemoSearch(tagMemo, 'api'), true)
  assert.equal(matchesMemoSearch(tagMemo, '鼠标'), false)
  assert.equal(matchesMemoSearch(tagMemo, '   '), true)

  // 仅输入 # 时不匹配所有标签，只在正文真正含 # 时命中
  assert.equal(matchesMemoSearch(tagMemo, '#'), false)
  assert.equal(matchesMemoSearch(makeMemo({ content: 'C# 语法整理', tags: ['学习'] }), '#'), true)
})

test('matchesMemoSearch excludes legacy placeholder content on image-only memos', () => {
  const imageMemo = makeMemo({
    type: 'image',
    content: '图片备忘',
    attachments: ['shot.png'],
    tags: ['截图键盘']
  })

  assert.equal(getSearchableMemoContent(imageMemo), '')
  assert.equal(matchesMemoSearch(imageMemo, '图片备忘'), false)
  assert.equal(matchesMemoSearch(imageMemo, '键盘'), true)
})

test('splitHighlightSegments and splitTagHighlightSegments preserve casing and escape regex chars', () => {
  assert.deepEqual(splitHighlightSegments('买一个Keyboard和keyboard', 'keyboard'), [
    { text: '买一个', matched: false },
    { text: 'Keyboard', matched: true },
    { text: '和', matched: false },
    { text: 'keyboard', matched: true }
  ])

  assert.deepEqual(splitHighlightSegments('学习 C++ (基础)', 'c++'), [
    { text: '学习 ', matched: false },
    { text: 'C++', matched: true },
    { text: ' (基础)', matched: false }
  ])

  assert.deepEqual(splitTagHighlightSegments('机械键盘', '键盘'), [
    { text: '#', matched: false },
    { text: '机械', matched: false },
    { text: '键盘', matched: true }
  ])

  assert.deepEqual(splitTagHighlightSegments('键盘', '#键盘'), [
    { text: '#键盘', matched: true }
  ])

  assert.deepEqual(splitTagHighlightSegments('机械键盘', '#键盘'), [
    { text: '#', matched: false },
    { text: '机械', matched: false },
    { text: '键盘', matched: true }
  ])

  assert.deepEqual(splitTagHighlightSegments('TODO', '#'), [
    { text: '#TODO', matched: false }
  ])
})
