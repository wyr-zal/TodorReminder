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
    clamp: !!document.querySelector('.memo-focus-card .line-clamp-4'),
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
  console.log('MEMO_FOCUS_UI_PASS: bounds, edit draft, remote delete, top draft and Esc priority')
  clearTimeout(timeout)
  app.exit(0)
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1) })
