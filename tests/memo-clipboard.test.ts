import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildMemoClipboardFormats,
  buildMemoCliText,
  createClipboardCopyResult,
  createMemoClipboardPayload,
  formatMemoText,
  insertTextAtSelection,
  parseMemoClipboardHtml,
  shouldIncludeNativeClipboardImage
} from '../src/shared/memoClipboard.ts'

const image = (index: number) => ({
  dataUrl: `data:image/png;base64,${Buffer.from(`image-${index}`).toString('base64')}`,
  pngHex: Buffer.from(`image-${index}`).toString('hex'),
  width: 120 + index,
  height: 80 + index
})

test('clipboard metadata round-trips Chinese, newlines and escaped HTML safely', () => {
  const payload = createMemoClipboardPayload(
    '第一行 <重点> & "引号"\n第二行 \\ {测试}',
    'high',
    ['工作', '工作', '明天'],
    1
  )
  const formats = buildMemoClipboardFormats(payload, [image(0)])
  const parsed = parseMemoClipboardHtml(formats.html)

  assert.ok(formats.html.includes('&lt;重点&gt;'))
  assert.ok(formats.html.includes('&amp;'))
  assert.ok(!formats.html.includes('<重点>'))
  assert.deepEqual(parsed, {
    payload: {
      version: 1,
      content: '第一行 <重点> & "引号"\n第二行 \\ {测试}',
      priority: 'high',
      tags: ['工作', '明天'],
      imageCount: 1
    },
    images: [image(0).dataUrl]
  })
  assert.match(formats.rtf, /\\u-?\d+\?/)
  assert.ok(formats.rtf.includes('\\\\'))
  assert.ok(formats.rtf.includes('\\{'))
})

test('clipboard protocol preserves zero, one and three image order', () => {
  for (const count of [0, 1, 3]) {
    const images = Array.from({ length: count }, (_, index) => image(index))
    const payload = createMemoClipboardPayload('多图测试', 'medium', [], count)
    const parsed = parseMemoClipboardHtml(buildMemoClipboardFormats(payload, images).html)

    assert.deepEqual(parsed?.images, images.map((item) => item.dataUrl))
    assert.equal(parsed?.payload.imageCount, count)
  }
})

test('plain text contains content and de-duplicated tags', () => {
  assert.equal(
    formatMemoText('完成报告', ['工作', '工作', '今天']),
    '完成报告\n#工作 #今天'
  )
})

test('native image clipboard is skipped when memo has text', () => {
  assert.equal(shouldIncludeNativeClipboardImage('待办内容', 1), false)
  assert.equal(shouldIncludeNativeClipboardImage('#标签', 1), false)
  assert.equal(shouldIncludeNativeClipboardImage('   ', 1), true)
  assert.equal(shouldIncludeNativeClipboardImage('', 0), false)
})

test('CLI text includes memo text, tags and ordered Windows image paths', () => {
  assert.equal(
    buildMemoCliText(
      '第一行\n第二行',
      ['工作', '工作', '截图'],
      [
        'C:\\Users\\12704\\AppData\\Roaming\\focus-memo\\attachments\\a.png',
        'C:\\Users\\12704\\AppData\\Roaming\\focus-memo\\attachments\\b.png'
      ]
    ),
    [
      '第一行\n第二行',
      '#工作 #截图',
      '图片路径:',
      'C:\\Users\\12704\\AppData\\Roaming\\focus-memo\\attachments\\a.png',
      'C:\\Users\\12704\\AppData\\Roaming\\focus-memo\\attachments\\b.png'
    ].join('\n').replace('#工作 #截图\n图片路径:', '#工作 #截图\n\n图片路径:')
  )
})

test('CLI text falls back to text and tags when there are no image paths', () => {
  assert.equal(
    buildMemoCliText('纯文字', ['标签'], []),
    '纯文字\n#标签'
  )
})

test('text insertion replaces selection and returns the next caret', () => {
  assert.deepEqual(
    insertTextAtSelection('前面[旧内容]后面', '新内容', 2, 7),
    {
      value: '前面新内容后面',
      caret: 5
    }
  )
})

test('missing images produce partial success without blocking copied text', () => {
  assert.deepEqual(createClipboardCopyResult(3, 2), {
    success: true,
    copiedImageCount: 2,
    missingImageCount: 1
  })

  assert.deepEqual(createClipboardCopyResult(3, 0, 'clipboard unavailable'), {
    success: false,
    copiedImageCount: 0,
    missingImageCount: 3,
    error: 'clipboard unavailable'
  })
})

test('invalid or unrelated HTML is ignored', () => {
  assert.equal(parseMemoClipboardHtml('<p>普通内容</p>'), null)
  assert.equal(parseMemoClipboardHtml('<!--focus-memo:v1:not-json-->'), null)
})

test('metadata remains readable when an external HTML pipeline strips comments', () => {
  const payload = createMemoClipboardPayload('保留元数据', 'low', ['兼容'], 1)
  const html = buildMemoClipboardFormats(payload, [image(0)]).html
  const withoutComments = html.replace(/<!--[^]*?-->/g, '')

  assert.deepEqual(parseMemoClipboardHtml(withoutComments), {
    payload,
    images: [image(0).dataUrl]
  })
})
