import test from 'node:test'
import assert from 'node:assert/strict'
import { extractTrailingTags } from '../src/renderer/utils/memoTags.ts'

test('末尾单独标签行转为标签，保留正文中部的井号内容', () => {
  assert.deepEqual(extractTrailingTags('正文 #BUG\n继续处理\n#01 #TODO'), {
    content: '正文 #BUG\n继续处理', tags: ['01', 'TODO']
  })
})

test('末尾多行标签按原顺序合并去重，支持中文和连字符', () => {
  assert.deepEqual(extractTrailingTags('任务\n  #工作-01 #TODO\n\n#TODO #tag_name\n\n'), {
    content: '任务', tags: ['工作-01', 'TODO', 'tag_name']
  })
})

test('非末尾标签行、混合正文和无效标签行原样保留', () => {
  for (const text of [
    '正文\n#BUG\n这是后续正文',
    '正文 #01 #TODO',
    '正文\n# 标题',
    '正文\n#tag 有待处理',
    '正文\n#tag.name',
    '正文\n#tag,',
    '正文\n\n'
  ]) {
    assert.deepEqual(extractTrailingTags(text), { content: text, tags: [] })
  }
})

test('只提取末尾标签块，保留正文空行和原有空格', () => {
  assert.deepEqual(extractTrailingTags('  正文  \n\n#保留\n后续\n\n\n#新增\n'), {
    content: '  正文  \n\n#保留\n后续\n\n', tags: ['新增']
  })
})

test('Windows 换行保留在正文内，不留下孤立回车', () => {
  assert.deepEqual(extractTrailingTags('正文\r\n\r\n继续\r\n#01\r\n#TODO\r\n'), {
    content: '正文\r\n\r\n继续', tags: ['01', 'TODO']
  })
})

test('仅有标签时返回空正文，供保存逻辑检查正文或附件', () => {
  assert.deepEqual(extractTrailingTags('#01 #TODO'), { content: '', tags: ['01', 'TODO'] })
  assert.deepEqual(extractTrailingTags(''), { content: '', tags: [] })
})
