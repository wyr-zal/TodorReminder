const { app, BrowserWindow, protocol } = require('electron')
const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const output = process.env.FOCUS_MEMO_TEST_OUTPUT
mkdirSync(join(output, 'profile'), { recursive: true })
app.setPath('userData', join(output, 'profile'))
app.disableHardwareAcceleration()
protocol.registerSchemesAsPrivileged([{ scheme: 'memo-img', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
const timeout = setTimeout(() => { console.error('UI smoke timed out'); app.exit(1) }, 25_000)

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
    throw new Error(`Timed out: ${expression}`)
  }
  const click = async selector => {
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`)
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  const escape = async () => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  await win.loadFile(resolve(__dirname, '../../dist/renderer/index.html'))
  win.showInactive()
  await wait(`document.querySelectorAll('[aria-label="全屏展开"]').length > 0`)
  await wait(`!!document.querySelector('[data-memo-id="memo-0"]')`)
  await wait(`document.querySelectorAll('[data-memo-id="memo-0"] img').length === 2`)
  const inputBeforeAttachments = await js(`(() => {
    const textarea = document.querySelector('.memo-input-panel textarea')
    const listShell = document.querySelector('.memo-list-shell')
    const listViewport = listShell.querySelector('.overflow-y-auto')
    return {
      top: textarea.getBoundingClientRect().top,
      height: textarea.getBoundingClientRect().height,
      filterTop: listShell.firstElementChild.getBoundingClientRect().top,
      filterText: listShell.firstElementChild.textContent,
      listTop: listShell.getBoundingClientRect().top,
      firstMemoTop: document.querySelector('[data-memo-id="memo-0"]').getBoundingClientRect().top,
      listViewportBottom: listViewport.getBoundingClientRect().bottom
    }
  })()`)
  const pasteImages = async count => js(`{
    const textarea = document.querySelector('.memo-input-panel textarea')
    for (let index = 0; index < ${count}; index += 1) {
      const clipboardData = new DataTransfer()
      clipboardData.items.add(new File(['image'], 'image.png', { type: 'image/png' }))
      textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
    }
  }`)
  const getAttachmentLayout = async () => js(`(() => {
    const textarea = document.querySelector('.memo-input-panel textarea')
    const composer = document.querySelector('.memo-composer')
    const listShell = document.querySelector('.memo-list-shell')
    const listViewport = listShell.querySelector('.overflow-y-auto')
    const previews = document.querySelector('.memo-pending-images')
    return {
      top: textarea.getBoundingClientRect().top,
      height: textarea.getBoundingClientRect().height,
      bottom: textarea.getBoundingClientRect().bottom,
      composerBottom: composer.getBoundingClientRect().bottom,
      previewScrollHeight: previews.scrollHeight,
      previewClientHeight: previews.clientHeight,
      filterTop: listShell.firstElementChild.getBoundingClientRect().top,
      filterText: listShell.firstElementChild.textContent,
      listTop: listShell.getBoundingClientRect().top,
      firstMemoTop: document.querySelector('[data-memo-id="memo-0"]').getBoundingClientRect().top,
      listViewportBottom: listViewport.getBoundingClientRect().bottom,
      viewportHeight: innerHeight
    }
  })()`)

  await pasteImages(1)
  await wait('document.querySelectorAll(".memo-pending-images img").length === 1')
  await wait('Array.from(document.querySelectorAll(".memo-pending-images img")).every(image => image.complete && image.naturalWidth > 0)')
  const inputWithOneAttachment = await getAttachmentLayout()
  assert.equal(inputWithOneAttachment.height, inputBeforeAttachments.height)
  assert.ok(inputWithOneAttachment.filterTop > inputBeforeAttachments.filterTop, JSON.stringify(inputWithOneAttachment))
  assert.ok(inputWithOneAttachment.listTop >= inputWithOneAttachment.composerBottom - 1, JSON.stringify(inputWithOneAttachment))
  assert.ok(inputWithOneAttachment.firstMemoTop > inputBeforeAttachments.firstMemoTop, JSON.stringify(inputWithOneAttachment))
  assert.ok(inputWithOneAttachment.firstMemoTop < inputWithOneAttachment.listViewportBottom, JSON.stringify(inputWithOneAttachment))
  assert.ok(inputWithOneAttachment.filterText.includes('work'), JSON.stringify(inputWithOneAttachment))

  await pasteImages(199)
  await wait('document.querySelectorAll(".memo-pending-images img").length === 200')
  await wait('Array.from(document.querySelectorAll(".memo-pending-images img")).every(image => image.complete && image.naturalWidth > 0)')
  const inputWithAttachments = await getAttachmentLayout()
  assert.equal(inputWithAttachments.height, inputBeforeAttachments.height)
  assert.ok(inputWithAttachments.top > inputBeforeAttachments.top + 350, JSON.stringify(inputWithAttachments))
  assert.ok(inputWithAttachments.previewScrollHeight > inputWithAttachments.previewClientHeight, JSON.stringify(inputWithAttachments))
  assert.ok(inputWithAttachments.bottom <= inputWithAttachments.viewportHeight, JSON.stringify(inputWithAttachments))
  assert.ok(inputWithAttachments.composerBottom <= inputWithAttachments.viewportHeight - 200, JSON.stringify(inputWithAttachments))
  assert.ok(inputWithAttachments.filterTop >= inputWithAttachments.composerBottom - 1, JSON.stringify(inputWithAttachments))
  assert.ok(inputWithAttachments.listTop >= inputWithAttachments.composerBottom - 1, JSON.stringify(inputWithAttachments))
  assert.ok(inputWithAttachments.firstMemoTop < inputWithAttachments.listViewportBottom, JSON.stringify(inputWithAttachments))
  assert.ok(inputWithAttachments.filterText.includes('work'), JSON.stringify(inputWithAttachments))
  await js(`document.querySelector('.memo-input-panel textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await wait('!document.querySelector(".memo-pending-images")')
  assert.equal(await js('Math.round(document.querySelector(".memo-input-panel textarea").getBoundingClientRect().height)'), inputBeforeAttachments.height)
  assert.equal(await js('Math.round(document.querySelector(".memo-input-panel textarea").getBoundingClientRect().top)'), Math.round(inputBeforeAttachments.top))
  assert.equal(await js('Math.round(document.querySelector(".memo-list-shell").getBoundingClientRect().top)'), Math.round(inputBeforeAttachments.listTop))
  await click('button[title="同步设置"]')
  await js(`Array.from(document.querySelectorAll('[data-modal] button')).find(button => button.textContent.trim() === '显示')?.click()`)
  await wait(`document.querySelector('[aria-label="固定位置：右侧居中"]')?.getAttribute('aria-pressed') === 'true'`)
  await click('button[aria-label="固定位置：左侧居中"]')
  await wait(`document.querySelector('[aria-label="固定位置：左侧居中"]')?.getAttribute('aria-pressed') === 'true'`)
  assert.equal(await js('window.memoTest.settings().fixedPosition'), 'left-center')
  await click('[data-modal] button')
  await wait('!document.querySelector("[data-modal]")')
  await click('button[title="同步设置"]')
  await js(`Array.from(document.querySelectorAll('[data-modal] button')).find(button => button.textContent.trim() === '显示')?.click()`)
  await wait(`document.querySelector('[aria-label="固定位置：左侧居中"]')?.getAttribute('aria-pressed') === 'true'`)
  await click('[data-modal] button')
  await wait('!document.querySelector("[data-modal]")')
  const bounds = win.getBounds()
  await js(`{
    const input = document.querySelector('.memo-input-panel textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'TOP_DRAFT');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    window.originalCard = document.querySelector('[data-memo-id="memo-0"]');
  }`)
  await click('[data-memo-id="memo-0"] [aria-label="全屏展开"]')
  await wait('!!document.querySelector(".memo-focus-card")')
  assert.deepEqual(win.getBounds(), bounds)
  const view = await js(`({
    same: document.querySelector('.memo-focus-card') === window.originalCard,
    top: document.querySelector('.memo-focus-card').getBoundingClientRect().top,
    bottom: document.querySelector('.memo-focus-card').getBoundingClientRect().bottom,
    height: innerHeight,
    hidden: getComputedStyle(document.querySelector('.memo-input-panel')).visibility,
    clamp: !!document.querySelector('.memo-focus-card .line-clamp-3'),
    count: document.querySelectorAll('.memo-focus-card').length
  })`)
  assert.equal(view.same, true)
  assert.equal(view.hidden, 'hidden')
  assert.equal(view.clamp, false)
  assert.equal(view.count, 1)
  assert.ok(view.top >= 35 && view.top <= 38 && Math.abs(view.bottom - view.height) <= 2, JSON.stringify(view))
  await new Promise(resolve => setTimeout(resolve, 150))
  writeFileSync(join(output, 'focused-light.png'), (await win.webContents.capturePage()).toPNG())
  await js(`document.querySelector('.memo-focus-card p').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await wait('!!document.querySelector(".memo-focus-card textarea")')
  await js(`{
    const input = document.querySelector('.memo-focus-card textarea');
    window.originalEditor = input;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'EDIT_KEEP');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }`)
  await click('[aria-label="返回列表"]')
  assert.equal(await js(`window.originalEditor === document.querySelector('[data-memo-id="memo-0"] textarea') && window.originalEditor.value === 'EDIT_KEEP'`), true)
  assert.equal(await js('document.querySelector(".memo-input-panel textarea").value'), 'TOP_DRAFT')
  await click('[aria-label="状态筛选：全部"]')
  await wait('!!document.querySelector(`[aria-label="状态筛选：未开始"]`)')
  await click('[aria-label="状态筛选：未开始"]')
  await wait('!!document.querySelector(`[aria-label="状态筛选：进行中"]`)')
  assert.equal(await js(`window.originalEditor === document.querySelector('[data-memo-id="memo-0"] textarea') && window.originalEditor.value === 'EDIT_KEEP'`), true)
  await click('[aria-label="状态筛选：进行中"]')
  await wait('!!document.querySelector(`[aria-label="状态筛选：已完成"]`)')
  await click('[aria-label="状态筛选：已完成"]')
  await wait('!!document.querySelector(`[aria-label="状态筛选：全部"]`)')
  await click('[data-memo-id="memo-0"] [aria-label="全屏展开"]')
  await js('document.querySelector(".memo-focus-card textarea").focus()')
  await escape()
  assert.equal(await js('!!document.querySelector(".memo-focus-card") && !document.querySelector(".memo-focus-card textarea")'), true)
  await escape()
  assert.equal(await js('!!document.querySelector(".memo-focus-card")'), false)
  assert.equal(await js('window.memoTest.calls().filter(call => call.kind === "hide").length'), 0)
  await click('[data-memo-id="memo-0"] [aria-label="全屏展开"]')
  await js('document.documentElement.classList.add("dark")')
  await new Promise(resolve => setTimeout(resolve, 150))
  writeFileSync(join(output, 'focused-dark.png'), (await win.webContents.capturePage()).toPNG())
  await js(`document.querySelector('.memo-focus-card p').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await wait('!!document.querySelector(".memo-focus-card textarea")')
  await js(`{
    const input = document.querySelector('.memo-focus-card textarea')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'REMOTE_DELETE_DRAFT')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    window.memoTest.replace(window.memoTest.memos().map(memo => memo.id === 'memo-0' ? { ...memo, deleted: true } : memo))
  }`)
  await wait(`document.querySelector('[data-memo-id="memo-0"] textarea')?.value === 'REMOTE_DELETE_DRAFT'`)
  assert.equal(await js(`document.querySelector('[data-memo-id="memo-0"] textarea').value`), 'REMOTE_DELETE_DRAFT')
  console.log('MEMO_FOCUS_UI_PASS: attachment layout, bounds, edit draft, remote delete, top draft and Esc priority')
  clearTimeout(timeout)
  app.exit(0)
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1) })
