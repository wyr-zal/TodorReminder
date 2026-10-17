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
    throw new Error(`Timed out: ${expression}`)
  }
  await win.loadFile(resolve(__dirname, '../../dist/renderer/index.html'))
  win.showInactive()
  await wait(`!!document.querySelector('[data-memo-id="memo-0"]')`)

  // 进入编辑态，textarea 出现
  await js(`document.querySelector('[data-memo-id="memo-0"] p').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await wait(`!!document.querySelector('[data-memo-id="memo-0"] textarea')`)
  await new Promise(resolve => setTimeout(resolve, 120))

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

  // 窗口内展开态同样验证
  writeFileSync(join(output, 'edit-paste.png'), (await win.webContents.capturePage()).toPNG())
  console.log('EDIT_PASTE_STABILITY_PASS: 长文本贴入后卡片保持原位')
  clearTimeout(timeout)
  app.exit(0)
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1) })
