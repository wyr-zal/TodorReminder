import test from 'node:test'
import assert from 'node:assert/strict'

import { breakInlineTags } from '../src/renderer/utils/tagLineBreak.ts'

test('行内标签自动换到下一行', () => {
  const text = '1.Hermes标签-》HermesHome\n2. #工作区映射'
  const result = breakInlineTags(text, text.length)
  assert.equal(result.value, '1.Hermes标签-》HermesHome\n2.\n#工作区映射')
  assert.equal(result.caret, result.value.length)
})

test('行首和带缩进的标签保持不变', () => {
  const text = '#TODO\n正文\n  #标签'
  assert.deepEqual(breakInlineTags(text, 5), { value: text, caret: 5 })
})

test('同一行多个标签各自换行', () => {
  const result = breakInlineTags('a #b c #d', 'a #b c #d'.length)
  assert.equal(result.value, 'a\n#b c\n#d')
  assert.equal(result.caret, result.value.length)
})

test('重复调用结果保持稳定', () => {
  const first = breakInlineTags('任务 #magpie-phone', 16)
  assert.deepEqual(breakInlineTags(first.value, first.caret), first)
})

test('光标在标签前时位置不变', () => {
  const result = breakInlineTags('abc #tag', 0)
  assert.equal(result.value, 'abc\n#tag')
  assert.equal(result.caret, 0)
})

test('中文与连字符标签都能识别', () => {
  const result = breakInlineTags('处理 #Hermes-Home 映射', 16)
  assert.equal(result.value, '处理\n#Hermes-Home 映射')
})

test('单独的井号不是标签', () => {
  for (const text of ['# 标题', 'C# 语言', '结尾 #']) {
    assert.deepEqual(breakInlineTags(text, text.length), { value: text, caret: text.length })
  }
})