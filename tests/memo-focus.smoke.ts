import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('window-local memo focus preserves bounds, drafts and Escape navigation', {
  skip: process.platform !== 'win32' ? 'Requires the project Windows Electron installation' : false,
  timeout: 180_000
}, () => {
  const runs = join(root, '.omx/qa/memo-fullscreen-expand/runs')
  mkdirSync(runs, { recursive: true })
  const output = mkdtempSync(join(runs, 'ui-'))
  const build = spawnSync(process.execPath, [join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build'], {
    cwd: root, encoding: 'utf8', timeout: 90_000
  })
  writeFileSync(join(output, 'build.log'), `${build.stdout ?? ''}\n${build.stderr ?? ''}`)
  assert.equal(build.status, 0, `UI fixture build failed: ${build.error ?? build.stderr}`)

  const env = { ...process.env, FOCUS_MEMO_TEST_OUTPUT: output, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(join(root, 'node_modules/electron/dist/electron.exe'), [
    join(root, 'tests/fixtures/memo-focus-electron.cjs')
  ], { cwd: root, env, encoding: 'utf8', timeout: 75_000 })
  const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  writeFileSync(join(output, 'ui.log'), log)
  assert.equal(result.status, 0, `Electron focus regression failed (${output}):\n${result.error ?? ''}\n${log}`)
  assert.match(log, /MEMO_FOCUS_UI_PASS/)
})
