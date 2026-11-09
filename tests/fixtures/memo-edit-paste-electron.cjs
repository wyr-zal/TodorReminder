const { app, BrowserWindow, protocol } = require('electron')
const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const output = process.env.FOCUS_MEMO_TEST_OUTPUT
mkdirSync(join(output, 'profile'), { recursive: true })
app.setPath('userData', join(output, 'profile'))
app.disableHardwareAcceleration()
protocol.registerSchemesAsPrivileged([{ scheme: 'memo-img', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
const timeout = setTimeout(() => { console.error('EDIT_PASTE smoke timed out'); app.exit(1) }, 40_000)

app.whenReady().then(async () => {
  protocol.handle('memo-img', () => new Response('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#c7d2fe"/></svg>', { headers: { 'content-type': 'image/svg+xml' } }))
  const win = new BrowserWindow({ width: 648, height: 900, show: false, webPreferences: {
    preload: join(__dirname, 'memo-focus-preload.cjs'), contextIsolation: true, backgroundThrottling: false
  } })
  const js = async code => {
    try { return await win.webContents.executeJavaScript(code) }
    catch (error) { throw new Error(`${code}\n${error.message}`) }
  }
  const wait = async expression => {
    for (let i = 0; i < 100; i++) {
      if (await js(expression)) return
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    const debug = await js(`JSON.stringify({ alerts: [...document.querySelectorAll('[data-memo-id="memo-0"] [role="alert"]')].map(node => node.textContent), deletes: window.memoTest.imageDeletes(), pendingImages: window.memoTest.pendingImageSaves(), saves: window.memoTest.calls().filter(call => call.kind === 'update') })`)
    throw new Error(`Timed out: ${expression}; state=${debug}`)
  }
  await win.loadFile(resolve(__dirname, '../../dist/renderer/index.html'))
  win.showInactive()
  await wait(`!!document.querySelector('[data-memo-id="memo-0"]')`)

  // 编辑态正文不带标签，标签在卡片底部独立管理
  await js(`document.querySelector('[data-memo-id="memo-0"] p').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await wait(`!!document.querySelector('[data-memo-id="memo-0"] textarea')`)
  const initialEdit = await js(`({
    text: document.querySelector('[data-memo-id="memo-0"] textarea').value,
    tags: [...document.querySelectorAll('[data-memo-id="memo-0"] [data-tag-chip]')].map(node => node.getAttribute('data-tag-chip')),
    todoActions: document.querySelectorAll('[data-memo-id="memo-0"] [aria-label*="标签 TODO"]').length
  })`)
  assert.ok(!initialEdit.text.includes('#work') && !initialEdit.text.includes('#TODO'), '编辑正文不能包含现有标签')
  assert.deepEqual(initialEdit.tags.slice(0, 2), ['work', 'TODO'], JSON.stringify(initialEdit))
  assert.equal(initialEdit.todoActions, 0, 'TODO 不显示改名/删除入口')
  assert.equal(await js(`document.querySelector('[data-memo-id="memo-0"] .memo-state-actions button').disabled`), true, '编辑期间应禁用状态修改')
  assert.equal(await js(`document.querySelector('[data-memo-id="memo-0"] [aria-label="进度与重要等级"]').disabled`), true, '编辑期间应禁用优先级修改')

  // 添加、重命名、删除为编辑草稿；取消后不落库
  await js(`document.querySelector('[data-memo-id="memo-0"] [aria-label="添加标签"]').click()`)
  await js(`(() => { const input = document.querySelector('[data-memo-id="memo-0"] input[aria-label="添加标签"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, '#TODO'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`)
  await wait(`document.querySelector('[data-memo-id="memo-0"] [role="alert"]')`)
  await js(`(() => { const input = document.querySelector('[data-memo-id="memo-0"] input[aria-label="添加标签"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, '#临时'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`)
  await wait(`document.querySelector('[data-memo-id="memo-0"] [data-tag-chip="临时"]')`)
  await js(`document.querySelector('[data-memo-id="memo-0"] [aria-label="取消编辑"]').click()`)
  await wait(`!document.querySelector('[data-memo-id="memo-0"] textarea')`)
  assert.ok(!(await js(`window.memoTest.memos().find(m => m.id === 'memo-0').tags.includes('临时')`)), '取消应撤销标签草稿')

  // 重新编辑，验证标签改名/删除及正文中 #BUG 按普通文本保存
  await js(`document.querySelector('[data-memo-id="memo-0"] p').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await wait(`!!document.querySelector('[data-memo-id="memo-0"] textarea')`)
  await js(`document.querySelector('[data-memo-id="memo-0"] [aria-label="修改标签 work"]').click()`)
  await wait(`!!document.querySelector('[data-memo-id="memo-0"] input[aria-label="修改标签 work"]')`)
  await js(`(() => { const input = document.querySelector('[data-memo-id="memo-0"] input[aria-label="修改标签 work"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, 'renamed'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`)
  await wait(`!!document.querySelector('[data-memo-id="memo-0"] [data-tag-chip="renamed"]')`)
  await js(`document.querySelector('[data-memo-id="memo-0"] [aria-label="添加标签"]').click()`)
  await wait(`!!document.querySelector('[data-memo-id="memo-0"] input[aria-label="添加标签"]')`)
  await js(`(() => { const input = document.querySelector('[data-memo-id="memo-0"] input[aria-label="添加标签"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, '临时'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`)
  await wait(`!!document.querySelector('[data-memo-id="memo-0"] [aria-label="删除标签 临时"]')`)
  await js(`document.querySelector('[data-memo-id="memo-0"] [aria-label="删除标签 临时"]').click()`)
  await wait(`!!document.querySelector('[data-memo-id="memo-0"] [data-tag-chip="renamed"]')`)
  await js(`document.querySelector('[data-memo-id="memo-0"] [aria-label="添加标签"]').click()`)
  await wait(`!!document.querySelector('[data-memo-id="memo-0"] input[aria-label="添加标签"]')`)
  await js(`(() => { const root = document.querySelector('[data-memo-id="memo-0"]'); const input = root.querySelector('input[aria-label="添加标签"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, 'savedDirect'); input.dispatchEvent(new Event('input', { bubbles: true })); const textarea = root.querySelector('textarea'); const taSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; taSetter.call(textarea, '正文中的 #BUG 保持原样'); textarea.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await js(`document.querySelector('[data-memo-id="memo-0"] [aria-label="保存待办"]').click()`)
  await wait(`!document.querySelector('[data-memo-id="memo-0"] textarea')`)
  const savedMemo = await js(`window.memoTest.memos().find(m => m.id === 'memo-0')`)
  assert.equal(savedMemo.content, '正文中的 #BUG 保持原样')
  assert.deepEqual(savedMemo.tags, ['renamed', 'TODO', 'savedDirect'])

  // 结构化剪贴板图片不完整时禁止普通 HTML 回退，并明确提示
  await js(`document.querySelector('[data-memo-id="memo-0"] p').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await wait(`!!document.querySelector('[data-memo-id="memo-0"] textarea')`)
  const beforeIncompletePaste = await js(`document.querySelector('[data-memo-id="memo-0"] textarea').value`)
  await js(`(() => {
    const textarea = document.querySelector('[data-memo-id="memo-0"] textarea')
    const payload = { version: 1, content: '不可丢失正文', priority: 'unimportant', tags: [], imageCount: 2 }
    const data = new DataTransfer()
    const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk2cAAAAASUVORK5CYII='
    data.setData('text/html', '<!--focus-memo:v1:' + encodeURIComponent(JSON.stringify(payload)) + '--><img data-focus-memo-image="0" src="' + imageData + '">')
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })()`)
  await wait(`[...document.querySelectorAll('[data-memo-id="memo-0"] [role="alert"]')].some(node => node.textContent.includes('剪贴板图片数据不完整'))`)
  assert.equal(await js(`document.querySelector('[data-memo-id="memo-0"] textarea').value`), beforeIncompletePaste, '不完整的结构化剪贴板不能静默丢弃图片后粘贴正文')

  // 单张剪贴板图片保存失败时显示错误，并恢复编辑器焦点
  await js(`(() => {
    window.memoTest.failImageSaves(1)
    const textarea = document.querySelector('[data-memo-id="memo-0"] textarea')
    textarea.focus()
    textarea.setSelectionRange(3, 3)
    const payload = { version: 1, content: '失败粘贴', priority: 'unimportant', tags: [], imageCount: 1 }
    const data = new DataTransfer()
    const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk2cAAAAASUVORK5CYII='
    data.setData('text/html', '<!--focus-memo:v1:' + encodeURIComponent(JSON.stringify(payload)) + '--><img data-focus-memo-image="0" src="' + imageData + '">')
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })()`)
  await wait(`document.querySelector('[data-memo-id="memo-0"] [role="alert"]')?.textContent.includes('1 张图片保存失败')`)
  await wait(`document.activeElement === document.querySelector('[data-memo-id="memo-0"] textarea')`)
  await js('window.memoTest.resetImageFixtures()')

  await js(`document.querySelector('.memo-input-panel textarea').focus()`)
  const beforeIncompleteCreatePaste = await js(`document.querySelector('.memo-input-panel textarea').value`)
  await js(`(() => {
    const textarea = document.querySelector('.memo-input-panel textarea')
    const payload = { version: 1, content: '新建正文不可丢失', priority: 'unimportant', tags: [], imageCount: 1 }
    const data = new DataTransfer()
    data.setData('text/html', '<!--focus-memo:v1:' + encodeURIComponent(JSON.stringify(payload)) + '-->')
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })()`)
  await wait(`document.querySelector('.memo-input-panel [role="alert"]')?.textContent.includes('剪贴板图片数据不完整')`)
  assert.equal(await js(`document.querySelector('.memo-input-panel textarea').value`), beforeIncompleteCreatePaste, '新建框也应拒绝不完整结构化剪贴板')
  await js(`document.querySelector('.memo-input-panel textarea').value = ''; document.querySelector('.memo-input-panel textarea').dispatchEvent(new Event('input', { bubbles: true }))`)
  await js('window.memoTest.resetImageFixtures()')

  await js(`(() => {
    window.memoTest.failImageSaves(1)
    const textarea = document.querySelector('.memo-input-panel textarea')
    const payload = { version: 1, content: '新建正文保留', priority: 'unimportant', tags: ['newtag'], imageCount: 1 }
    const data = new DataTransfer()
    const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk2cAAAAASUVORK5CYII='
    data.setData('text/html', '<!--focus-memo:v1:' + encodeURIComponent(JSON.stringify(payload)) + '--><img data-focus-memo-image="0" src="' + imageData + '">')
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })()`)
  await wait(`document.querySelector('.memo-input-panel [role="alert"]')?.textContent.includes('粘贴图片失败')`)
  assert.ok((await js(`document.querySelector('.memo-input-panel textarea').value.includes('新建正文保留')`)), '图片保存失败时应保留已插入正文')
  assert.ok((await js(`document.querySelector('.memo-input-panel textarea').value.includes('#newtag')`)), '图片保存失败时应保留已插入标签文本')
  await js(`(() => { const textarea = document.querySelector('.memo-input-panel textarea'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(textarea, ''); textarea.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await js('window.memoTest.resetImageFixtures()')

  await js(`(() => {
    window.memoTest.failImageSaves(1)
    window.memoTest.failDelete(true)
    const textarea = document.querySelector('.memo-input-panel textarea')
    const payload = { version: 1, content: '新建清理重试', priority: 'unimportant', tags: [], imageCount: 2 }
    const data = new DataTransfer()
    const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk2cAAAAASUVORK5CYII='
    data.setData('text/html', '<!--focus-memo:v1:' + encodeURIComponent(JSON.stringify(payload)) + '--><img data-focus-memo-image="0" src="' + imageData + '"><img data-focus-memo-image="1" src="' + imageData + '">')
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })()`)
  await wait(`document.querySelector('.memo-input-panel [role="alert"]')?.textContent.includes('未能清理的图片')`)
  await js(`window.memoTest.failDelete(false); document.querySelector('.memo-input-panel [aria-label="重试清理"]').click()`)
  await wait(`!document.querySelector('.memo-input-panel [role="alert"]')`)
  await js(`(() => { const textarea = document.querySelector('.memo-input-panel textarea'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(textarea, ''); textarea.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await js('window.memoTest.resetImageFixtures()')

  // 结构化图片部分保存失败时清理已保存部分并显示错误
  await js(`(() => {
    window.memoTest.failImageSaves(1)
    const textarea = document.querySelector('[data-memo-id="memo-0"] textarea')
    const payload = { version: 1, content: '部分失败', priority: 'unimportant', tags: [], imageCount: 2 }
    const data = new DataTransfer()
    const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk2cAAAAASUVORK5CYII='
    data.setData('text/html', '<!--focus-memo:v1:' + encodeURIComponent(JSON.stringify(payload)) + '--><img data-focus-memo-image="0" src="' + imageData + '"><img data-focus-memo-image="1" src="' + imageData + '">')
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })()`)
  await wait(`window.memoTest.imageDeletes().length === 1`)
  await wait(`[...document.querySelectorAll('[data-memo-id="memo-0"] [role="alert"]')].some(node => node.textContent.includes('1 张图片保存失败'))`)
  assert.ok((await js('window.memoTest.imageDeletes()')).includes('structured-pasted-1.png'), '部分成功的图片应被清理')
  await js(`document.querySelector('[data-memo-id="memo-0"] textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await wait(`!document.querySelector('[data-memo-id="memo-0"] textarea')`)
  await js(`document.querySelector('[data-memo-id="memo-0"] p').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await wait(`!!document.querySelector('[data-memo-id="memo-0"] textarea')`)

  // 部分成功图片清理失败时，取消后仍提示并可重试
  await js(`window.memoTest.failImageSaves(1); window.memoTest.failDelete(true)`)
  await js(`(() => {
    const textarea = document.querySelector('[data-memo-id="memo-0"] textarea')
    const payload = { version: 1, content: '部分清理失败', priority: 'unimportant', tags: [], imageCount: 2 }
    const data = new DataTransfer()
    const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk2cAAAAASUVORK5CYII='
    data.setData('text/html', '<!--focus-memo:v1:' + encodeURIComponent(JSON.stringify(payload)) + '--><img data-focus-memo-image="0" src="' + imageData + '"><img data-focus-memo-image="1" src="' + imageData + '">')
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })()`)
  await wait(`[...document.querySelectorAll('[data-memo-id="memo-0"] [role="alert"]')].some(node => node.textContent.includes('剪贴板图片清理失败，请检查附件'))`)
  await js(`document.querySelector('[data-memo-id="memo-0"] [aria-label="取消编辑"]').click()`)
  await wait(`!document.querySelector('[data-memo-id="memo-0"] textarea')`)
  await wait(`[...document.querySelectorAll('[data-memo-id="memo-0"] [role="alert"]')].some(node => node.textContent.includes('清理失败'))`)
  await js(`document.querySelector('.memo-list-shell .overflow-y-auto').scrollTop = document.querySelector('.memo-list-shell .overflow-y-auto').scrollHeight`)
  await wait(`!document.querySelector('[data-memo-id="memo-0"]')`)
  await js(`document.querySelector('.memo-list-shell .overflow-y-auto').scrollTop = 0`)
  await wait(`!!document.querySelector('[data-memo-id="memo-0"]')`)
  await wait(`[...document.querySelectorAll('[data-memo-id="memo-0"] [role="alert"]')].some(node => node.textContent.includes('清理失败'))`)
  await js(`window.memoTest.failDelete(false); document.querySelector('[data-memo-id="memo-0"] [aria-label="重试清理"]').click()`)
  await wait(`!document.querySelector('[data-memo-id="memo-0"] [role="alert"]')`)
  await js('window.memoTest.resetImageFixtures()')

  await js(`document.querySelector('[data-memo-id="memo-0"] p').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await wait(`!!document.querySelector('[data-memo-id="memo-0"] textarea')`)
  await js(`(() => {
    window.memoTest.delayImageSave(true)
    const textarea = document.querySelector('[data-memo-id="memo-0"] textarea')
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    window.clipPasteCardTop = document.querySelector('[data-memo-id="memo-0"]').getBoundingClientRect().top
    const payload = { version: 1, content: '剪贴板正文', priority: 'unimportant', tags: ['cliptag', 'TODO'], imageCount: 1 }
    const data = new DataTransfer()
    const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk2cAAAAASUVORK5CYII='
    const html = '<!--focus-memo:v1:' + encodeURIComponent(JSON.stringify(payload)) + '--><img data-focus-memo-image="0" src="' + imageData + '">'
    data.setData('text/html', html)
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })()`)
  await wait(`document.querySelector('[data-memo-id="memo-0"] textarea').value.includes('剪贴板正文')`)
  assert.ok(!(await js(`document.querySelector('[data-memo-id="memo-0"] textarea').value.includes('#cliptag')`)), '结构化粘贴的标签不能混入正文')
  await wait(`document.querySelector('[data-memo-id="memo-0"] [data-tag-chip="cliptag"]')`)
  await wait(`document.querySelector('[data-memo-id="memo-0"] [aria-label="保存待办"]').disabled`)
  await js(`document.querySelector('[data-memo-id="memo-0"] [aria-label="保存待办"]').click()`)
  await js(`document.querySelector('[data-memo-id="memo-0"] [aria-label="取消编辑"]').click()`)
  assert.equal(await js(`!!document.querySelector('[data-memo-id="memo-0"] textarea')`), true, '附件处理期间应阻止保存和取消')
  await js('window.memoTest.resolveImageSaveDelay()')
  await wait(`document.querySelector('[data-memo-id="memo-0"] img[src^="memo-img://thumb/structured-pasted-1.png"]')`)
  const clipPasteCardAfter = await js(`document.querySelector('[data-memo-id="memo-0"]').getBoundingClientRect().top`)
  assert.ok(Math.abs(clipPasteCardAfter - await js('window.clipPasteCardTop')) < 5, '结构化粘贴图片后卡片应保持视口位置')
  await js(`document.querySelector('[data-memo-id="memo-0"] [aria-label="保存待办"]').click()`)
  await wait(`!document.querySelector('[data-memo-id="memo-0"] textarea')`)
  const pastedMemo = await js(`window.memoTest.memos().find(m => m.id === 'memo-0')`)
  assert.deepEqual(pastedMemo.attachments, ['first.png', 'second.png', 'structured-pasted-1.png'])
  assert.deepEqual(pastedMemo.tags, ['renamed', 'TODO', 'savedDirect', 'cliptag'])
  assert.ok(pastedMemo.content.includes('剪贴板正文') && !pastedMemo.content.includes('#cliptag'))
  await js(`document.querySelector('[data-memo-id="memo-0"] p').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await wait(`!!document.querySelector('[data-memo-id="memo-0"] textarea')`)
  await new Promise(resolve => setTimeout(resolve, 120))

  // 普通剪贴板图片也应在附件预览增高后保持卡片视口位置
  const imagePasteBefore = await js(`(() => {
    const viewport = document.querySelector('.memo-list-shell .overflow-y-auto')
    const card = document.querySelector('[data-memo-id="memo-0"]')
    const viewportTop = viewport.getBoundingClientRect().top + viewport.clientTop
    viewport.scrollTop += card.getBoundingClientRect().top - (viewportTop + 120)
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
      cardTop: card.getBoundingClientRect().top,
      cardHeight: card.getBoundingClientRect().height
    }))))
  })()`)
  await js(`(async () => {
    const textarea = document.querySelector('[data-memo-id="memo-0"] textarea')
    textarea.focus()
    for (let index = 0; index < 20; index += 1) {
      const data = new DataTransfer()
      data.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'clipboard.png', { type: 'image/png' }))
      textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  })()`)
  await wait(`document.querySelector('[data-memo-id="memo-0"] img[src^="memo-img://thumb/clipboard-pasted-20.png"]')`)
  await new Promise(resolve => setTimeout(resolve, 80))
  const imagePasteAfter = await js(`(() => {
    const card = document.querySelector('[data-memo-id="memo-0"]')
    return { cardTop: card.getBoundingClientRect().top, cardHeight: card.getBoundingClientRect().height }
  })()`)
  assert.ok(imagePasteAfter.cardHeight > imagePasteBefore.cardHeight + 80, `附件预览应增高卡片: before=${imagePasteBefore.cardHeight}, after=${imagePasteAfter.cardHeight}`)
  const imagePasteCardAfter = imagePasteAfter.cardTop
  assert.ok(Math.abs(imagePasteCardAfter - imagePasteBefore.cardTop) < 5, `普通图片粘贴后卡片应保持视口位置: before=${imagePasteBefore.cardTop}, after=${imagePasteCardAfter}`)

  // 滚动列表使目标卡片位于视口中部，记录锚点
  const anchor = await js(`(() => {
    const viewport = document.querySelector('.memo-list-shell .overflow-y-auto')
    viewport.scrollTop = 300
    return new Promise(resolve => requestAnimationFrame(() => resolve({
      scrollTop: viewport.scrollTop,
      cardTop: document.querySelector('[data-memo-id="memo-0"]').getBoundingClientRect().top
    })))
  })()`)
  await new Promise(resolve => setTimeout(resolve, 120))
  const before = await js(`({
    scrollTop: document.querySelector('.memo-list-shell .overflow-y-auto').scrollTop,
    cardTop: document.querySelector('[data-memo-id="memo-0"]').getBoundingClientRect().top,
    editing: !!document.querySelector('[data-memo-id="memo-0"] textarea')
  })`)
  assert.ok(before.editing, '编辑态应保持')
  assert.ok(Math.abs(before.scrollTop - 300) < 30, `滚动位置应接近300: ${before.scrollTop}`)

  // 记录编辑卡片当前值句柄，模拟贴入 100+ 行长文本（绕过 React value 只读）
  await js(`(() => {
    const textarea = document.querySelector('[data-memo-id="memo-0"] textarea')
    const longText = Array.from({ length: 120 }, (_, i) => '粘贴行内容' + i).join('\\n')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(textarea, textarea.value + '\\n' + longText)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await new Promise(resolve => setTimeout(resolve, 250))
  await wait(`document.querySelector('[data-memo-id="memo-0"] textarea').value.includes('粘贴行内容119')`)

  // 高度变化后校验：卡片顶边不跳（保持在视口内接近原位），scrollTop 不被甩走
  const after = await js(`(() => {
    const viewport = document.querySelector('.memo-list-shell .overflow-y-auto')
    const card = document.querySelector('[data-memo-id="memo-0"]')
    const ta = document.querySelector('[data-memo-id="memo-0"] textarea')
    return {
      scrollTop: viewport.scrollTop,
      cardTop: card.getBoundingClientRect().top,
      cardBottom: card.getBoundingClientRect().bottom,
      viewportHeight: viewport.clientHeight,
      textareaHeight: ta.getBoundingClientRect().height,
      stillEditing: !!ta
    }
  })()`)
  assert.ok(after.stillEditing, '贴入后应仍在编辑态')
  assert.ok(after.textareaHeight > 300, `textarea 应被撑高: ${after.textareaHeight}`)
  // 核心断言：卡片顶边仍在视口内（不跳到"不知道什么地方"）
  assert.ok(after.cardTop >= 0 && after.cardTop < after.viewportHeight, `卡片顶边应留在视口内: cardTop=${after.cardTop}, viewport=${after.viewportHeight}`)
  assert.ok(Math.abs(after.cardTop - before.cardTop) < after.viewportHeight * 0.6, `卡片不应大幅跳动: before=${before.cardTop}, after=${after.cardTop}`)
  assert.ok(Math.abs(after.scrollTop - before.scrollTop) < 400, `scrollTop 不应被甩走: before=${before.scrollTop}, after=${after.scrollTop}`)

  // 文件选择图片处理中锁定编辑并恢复焦点，保存后清理移除的新增附件
  await js(`document.querySelector('[data-memo-id="memo-0"] p').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await wait(`!!document.querySelector('[data-memo-id="memo-0"] textarea')`)
  await js(`(() => {
    window.memoTest.delayImageSave(1)
    const input = document.querySelector('[data-memo-id="memo-0"] input[type="file"]')
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'selected.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await wait(`window.memoTest.pendingImageSaves() === 1`)
  assert.equal(await js(`document.querySelector('[data-memo-id="memo-0"] textarea').disabled`), true, '文件选择保存期间应锁住正文编辑')
  assert.equal(await js(`document.querySelector('[data-memo-id="memo-0"] [aria-label="进度与重要等级"]').disabled`), true, '图片处理中应锁住优先级操作')
  assert.equal(await js(`document.querySelector('[data-memo-id="memo-0"] [aria-label*="未开始"], [data-memo-id="memo-0"] .memo-state-actions button').disabled`), true, '图片处理中应锁住状态操作')
  await js('window.memoTest.resolveImageSaveDelay()')
  await wait(`document.querySelector('[data-memo-id="memo-0"] img[src^="memo-img://thumb/structured-pasted-2.png"]')`)
  await wait(`document.activeElement === document.querySelector('[data-memo-id="memo-0"] textarea')`)
  await js(`document.querySelector('[data-memo-id="memo-0"] [aria-label="移除附件 structured-pasted-2.png"]').click()`)
  await wait(`!document.querySelector('[data-memo-id="memo-0"] img[src^="memo-img://thumb/structured-pasted-2.png"]')`)
  await js(`window.memoTest.delayUpdate(true); document.querySelector('[data-memo-id="memo-0"] [aria-label="保存待办"]').click()`)
  await wait(`document.querySelector('[data-memo-id="memo-0"] textarea')?.disabled`)
  await js('window.memoTest.resolveUpdateDelay()')
  await wait(`!document.querySelector('[data-memo-id="memo-0"] textarea')`)
  const removedAttachmentState = await js(`JSON.stringify({ deletes: window.memoTest.imageDeletes(), memo: window.memoTest.memos().find(m => m.id === 'memo-0') })`)
  assert.ok(JSON.parse(removedAttachmentState).deletes.includes('structured-pasted-2.png'), `保存移除附件后应清理未引用图片: ${removedAttachmentState}`)
  await js('window.memoTest.resetImageFixtures()')

  // 保存期间锁定草稿控件，避免请求发出后继续编辑导致新输入丢失
  await js(`document.querySelector('[data-memo-id="memo-0"] p').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await wait(`!!document.querySelector('[data-memo-id="memo-0"] textarea')`)
  writeFileSync(join(output, 'edit-paste.png'), (await win.webContents.capturePage()).toPNG())
  await js('window.memoTest.delayUpdate(true)')
  await js(`document.querySelector('[data-memo-id="memo-0"] [aria-label="保存待办"]').click()`)
  await wait(`document.querySelector('[data-memo-id="memo-0"] textarea')?.disabled`)
  assert.equal(await js(`document.querySelector('[data-memo-id="memo-0"] [aria-label="取消编辑"]').disabled`), true)
  assert.equal(await js(`document.querySelector('[data-memo-id="memo-0"] [aria-label="添加标签"]').disabled`), true)
  await js('window.memoTest.resolveUpdateDelay()')
  await wait(`!document.querySelector('[data-memo-id="memo-0"] textarea')`)
  const longTextMemo = await js(`window.memoTest.memos().find(m => m.id === 'memo-0')`)
  assert.ok(longTextMemo.content.includes('粘贴行内容119'), '保存期间锁定编辑后仍应提交原草稿')
  assert.deepEqual(await js('window.memoTest.imageDeletes()'), [], '下一轮保存不能重复清理上一轮已删除的新增附件')

  // 保存移除原有附件时清理文件；取消编辑保留原有附件，其他待办引用时保留并可重试
  await js(`document.querySelector('[data-memo-id="memo-0"] p').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await wait(`!!document.querySelector('[data-memo-id="memo-0"] textarea')`)
  await js(`document.querySelector('[data-memo-id="memo-0"] [aria-label="移除附件 first.png"]').click()`)
  await js(`document.querySelector('[data-memo-id="memo-0"] [aria-label="保存待办"]').click()`)
  await wait(`!document.querySelector('[data-memo-id="memo-0"] textarea')`)
  assert.ok((await js('window.memoTest.imageDeletes()')).includes('first.png'), '保存移除原有附件后应清理原图')
  assert.ok(!(await js(`window.memoTest.memos().find(m => m.id === 'memo-0').attachments.includes('first.png')`)), '已移除原有附件应从待办关系中消失')
  await js('window.memoTest.resetImageFixtures()')

  await js('window.memoTest.clearImageDeleteCalls()')
  await js(`document.querySelector('[data-memo-id="memo-0"] p').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await wait(`!!document.querySelector('[data-memo-id="memo-0"] textarea')`)
  await js(`document.querySelector('[data-memo-id="memo-0"] [aria-label="移除附件 second.png"]').click()`)
  await js(`document.querySelector('[data-memo-id="memo-0"] [aria-label="取消编辑"]').click()`)
  await wait(`!document.querySelector('[data-memo-id="memo-0"] textarea')`)
  assert.deepEqual(await js(`window.memoTest.imageDeletes()`), [], '取消编辑不能删除已有附件')
  const attachmentsAfterCancel = await js(`window.memoTest.memos().find(m => m.id === 'memo-0').attachments`)
  assert.ok(attachmentsAfterCancel.includes('second.png') && !attachmentsAfterCancel.includes('first.png'), '取消移除附件后应保留未移除的已有附件')

  await js(`document.querySelector('[data-memo-id="memo-0"] p').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await wait(`!!document.querySelector('[data-memo-id="memo-0"] textarea')`)
  await js(`window.memoTest.clearImageDeleteCalls(); window.memoTest.referenceImage('second.png', true); document.querySelector('[data-memo-id="memo-0"] [aria-label="移除附件 second.png"]').click()`)
  await js(`document.querySelector('[data-memo-id="memo-0"] [aria-label="保存待办"]').click()`)
  await wait(`!document.querySelector('[data-memo-id="memo-0"] textarea')`)
  await wait(`[...document.querySelectorAll('[data-memo-id="memo-0"] [role="alert"]')].some(node => node.textContent.includes('仍被待办或同步记录引用'))`)
  const attachmentsAfterReferencedRemoval = await js(`window.memoTest.memos().find(m => m.id === 'memo-0').attachments`)
  assert.ok(!attachmentsAfterReferencedRemoval.includes('second.png'), '保存应移除待办对已删除附件的引用')
  assert.deepEqual(await js('window.memoTest.imageDeletes()'), ['second.png'], '被引用文件应被 IPC 拒绝且保留重试记录')
  await js(`window.memoTest.referenceImage('second.png', false); window.memoTest.delayImageDelete(1); document.querySelector('[data-memo-id="memo-0"] [aria-label="重试清理"]').click()`)
  await wait(`window.memoTest.pendingImageDeletes() === 1`)
  await js(`document.querySelector('[data-memo-id="memo-0"] [aria-label="重试清理"]').click()`)
  assert.equal(await js(`window.memoTest.imageDeletes().filter(filename => filename === 'second.png').length`), 2, '清理过程中重复点击不能并发删除')
  await js('window.memoTest.resolveImageDeleteDelay()')
  await wait(`!document.querySelector('[data-memo-id="memo-0"] [role="alert"]')`)
  assert.equal(await js(`window.memoTest.imageDeletes().filter(filename => filename === 'second.png').length`), 2, '解除引用后重试清理一次且不并发')
  await js('window.memoTest.resetImageFixtures()')

  console.log('EDIT_PASTE_STABILITY_PASS: 标签与图片定位、异步保存竞态和长文本定位')
  clearTimeout(timeout)
  app.exit(0)
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1) })
