// Runs the real built main/preload/renderer; isolates OS integrations not changed by this task.
const electron = require('electron')
const { app, protocol, globalShortcut } = electron
const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const { randomUUID } = require('node:crypto')
const child = require('node:child_process')
const output = process.env.CLOUD_TEST_DIR
const root = resolve(__dirname, '../../..')
mkdirSync(output, { recursive: true })
app.setPath('userData', output)
app.disableHardwareAcceleration()
process.argv.push('--focus-memo-silent-startup')
app.getLoginItemSettings = () => ({ openAtLogin: false, executableWillLaunchAtLogin: false, wasOpenedAtLogin: false, wasOpenedAsHidden: false })
app.setLoginItemSettings = () => { throw new Error('OS login changes forbidden in fixture') }
app.requestSingleInstanceLock = () => true
const realExec = child.execFileSync
child.execFileSync = (file, ...args) => {
  if (String(file).toLowerCase().endsWith('reg.exe')) throw new Error('Registry access isolated by fixture')
  return realExec(file, ...args)
}
require('node:module').syncBuiltinESMExports()
globalShortcut.register = () => false
globalShortcut.unregisterAll = () => {}
protocol.registerSchemesAsPrivileged([{ scheme: 'memo-img', privileges: { standard: true, secure: true, stream: true } }])
protocol.registerSchemesAsPrivileged = () => {}
let done = false
const timeout = setTimeout(() => { console.error('Real app UI fixture timeout'); app.exit(1) }, 100000)
app.on('browser-window-created', (_, win) => {
  win.webContents.setBackgroundThrottling(false)
  win.webContents.once('did-finish-load', async () => {
    if (done) return
    done = true
    const js = code => win.webContents.executeJavaScript(code)
    const wait = async expression => {
      for (let i = 0; i < 250; i++) {
        if (await js(expression)) return
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error('UI condition timed out: ' + expression)
    }
    const clickText = text => js(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`)
    const input = (id, value) => js(`{ const el=document.getElementById(${JSON.stringify(id)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); }`)
    try {
      await wait('!!window.electronAPI && !!document.querySelector("[title=同步设置]")')
      const config = await js('window.electronAPI.sync.getConfig()')
      assert.equal(config.hasToken, false)
      const local = { id: randomUUID(), content: 'UI startup local memo', type: 'text', priority: 'unimportant', status: 'not_started', attachments: [], tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null, deviceId: 'ui-fixture', deleted: false }
      await js(`window.electronAPI.memo.add(${JSON.stringify(local)})`)
      await js('document.querySelector("[title=同步设置]").click()')
      await wait('!!document.getElementById("cloud-url")')
      assert.equal(await js('document.body.textContent.includes("GitHub 同步")'), false)
      for (const text of ['图片设置', '显示', '数据位置']) assert.equal(await js(`document.body.textContent.includes(${JSON.stringify(text)})`), true)
      await input('cloud-url', process.env.CLOUD_TEST_URL)
      await input('cloud-token', process.env.CLOUD_TEST_TOKEN)
      await clickText('保存配置')
      await wait('document.body.textContent.includes("配置已保存")')
      const saved = await js('window.electronAPI.sync.getConfig()')
      assert.equal(saved.hasToken, true); assert.equal(saved.token, undefined)
      assert.equal(await js('document.getElementById("cloud-token").value'), '')
      await clickText('预览接入')
      await wait('Array.from(document.querySelectorAll("button")).some(b => b.textContent === "备份并接入")')
      await new Promise(resolve => setTimeout(resolve, 350))
      writeFileSync(join(output, 'cloud-settings-light.png'), (await win.webContents.capturePage()).toPNG())
      await js('document.documentElement.classList.add("dark"); document.documentElement.dataset.theme="dark"')
      await new Promise(resolve => setTimeout(resolve, 350))
      writeFileSync(join(output, 'cloud-settings-dark.png'), (await win.webContents.capturePage()).toPNG())
      await js('document.documentElement.classList.remove("dark"); document.documentElement.dataset.theme="light"')
      await clickText('备份并接入')
      await wait('!document.querySelector("[data-modal]")')
      await wait('(async()=>{ const s=await window.electronAPI.sync.getStatus(); return !!s.lastSync && !s.isSyncing && s.pending===0 })()')
      const rows = await js('window.electronAPI.memo.getAll()')
      assert.ok(rows.some(m => m.id === local.id))
      await wait('document.body.textContent.includes("UI startup local memo")')
      // Existing local write routes now trigger the same background HTTP worker.
      await js(`window.electronAPI.memo.update(${JSON.stringify(local.id)},{content:'UI auto-sync edit'})`)
      await wait('(async()=>{const s=await window.electronAPI.sync.getStatus();return !s.isSyncing&&s.pending===0})()')
      await js('document.querySelector("[title=同步设置]").click()')
      await wait('!!document.getElementById("cloud-url")')
      assert.equal(await js('document.getElementById("cloud-token").value'), '')
      const status = await js('window.electronAPI.sync.getStatus()')
      assert.equal(status.connected, true)
      await js('document.querySelector("[data-modal] .flex.items-center.justify-between button").click()')
      const selector = `[data-memo-id="${local.id}"]`
      await js(`document.querySelector(${JSON.stringify(selector)}+' p').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
      await wait(`!!document.querySelector(${JSON.stringify(selector)}+' textarea')`)
      await js(`{ const el=document.querySelector(${JSON.stringify(selector)}+' textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'UNSAVED_OLD_DRAFT');el.dispatchEvent(new Event('input',{bubbles:true})); }`)
      const apiCall = async (path, init = {}) => {
        const response = await fetch(process.env.CLOUD_TEST_URL + path, { ...init, headers: { Authorization: 'Bearer ' + process.env.CLOUD_TEST_TOKEN, 'Content-Type': 'application/json', ...init.headers } })
        assert.ok(response.ok)
        return response.json()
      }
      const current = await apiCall('/api/v1/memos/' + local.id)
      await apiCall('/api/v1/memos/' + local.id, { method: 'PATCH', headers: { 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ baseVersion: current.version, content: 'PHONE_NEW_VERSION' }) })
      await js('window.electronAPI.sync.start()')
      assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}+' textarea').value`), 'UNSAVED_OLD_DRAFT')
      await js(`document.querySelector(${JSON.stringify(selector)}+' [aria-label="保存待办"]').click()`)
      await wait(`!!document.querySelector(${JSON.stringify(selector)}+' [role="alert"]')`)
      assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}+' textarea').value`), 'UNSAVED_OLD_DRAFT')
      assert.equal((await apiCall('/api/v1/memos/' + local.id)).content, 'PHONE_NEW_VERSION')
      writeFileSync(join(output, 'ui-result.json'), JSON.stringify({ status: 'passed', localMemoId: local.id, routes: ['real_main_startup', 'real_preload', 'settings_save', 'token_redaction', 'preview_confirm_backup', 'background_sync', 'local_write_trigger'], os_integrations: 'registry/login/global shortcuts isolated' }, null, 2))
      console.log('CLOUD_APP_UI_PASS')
      clearTimeout(timeout)
      app.quit()
    } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1) }
  })
})
import(pathToFileURL(join(root, 'dist/main/index.js')).href).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1) })
