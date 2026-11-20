import test from 'node:test'
import assert from 'node:assert/strict'
import { removeBlankLines } from '../src/renderer/utils/memoContent.ts'
import { extractTrailingTags } from '../src/renderer/utils/memoTags.ts'

test('删除头尾和中间的连续空行，保留有效行之间的一次换行', () => {
  assert.equal(removeBlankLines('\n\n第一行\n\n\n第二行\n\n'), '第一行\n第二行')
})

test('兼容 LF、CRLF 和混合换行，不残留回车', () => {
  for (const newline of ['\n', '\r\n']) {
    assert.equal(removeBlankLines(`${newline}第一行${newline}${newline}第二行${newline}`), '第一行\n第二行')
  }
  assert.equal(removeBlankLines('第一行\r\n\n第二行\n\r\n第三行'), '第一行\n第二行\n第三行')
})

test('删除只含空格、制表符和常见 Unicode 空白的行', () => {
  assert.equal(removeBlankLines('第一行\n \t\n 　\n﻿\n第二行'), '第一行\n第二行')
})

test('非空行的缩进、尾部空格、顺序及正文原样保留', () => {
  const content = '  第一行  \n\t缩进行\t\n正文 #BUG 和 空格'
  assert.equal(removeBlankLines(`\n${content}\n\t\n`), content)
})

test('全空白和空正文返回空字符串，供原有空待办检查和纯图片保存使用', () => {
  for (const content of ['', '\n\r\n', ' \t\n 　\r\n']) {
    assert.equal(removeBlankLines(content), '')
  }
})

test('编辑保存先解析末尾标签，再清理正文，不改变标签边界', () => {
  const parsed = extractTrailingTags('\n  正文 #BUG  \r\n\r\n#中间\r\n\t继续\r\n \t\r\n#工作-01 #TODO\r\n')
  assert.deepEqual(parsed.tags, ['工作-01', 'TODO'])
  assert.equal(removeBlankLines(parsed.content), '  正文 #BUG  \n#中间\n\t继续')
})
