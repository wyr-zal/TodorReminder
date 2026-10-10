import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
test('cloud HTTP transport rejects redirects, sanitizes errors, and aborts pending calls', { timeout: 30000 }, () => {
  const runs = join(root, '.omx/qa/server-memo-api/runs')
  mkdirSync(runs, { recursive: true })
  const output = mkdtempSync(join(runs, 'transport-'))
  const bundle = join(output, 'transport.test.cjs')
  const options = { entryPoints: [join(root, 'tests/fixtures/cloud-api.cases.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle }
  const build = spawnSync(process.execPath, ['-e', `require('esbuild').buildSync(${JSON.stringify(options)})`], { cwd: root, encoding: 'utf8', timeout: 15000 })
  assert.equal(build.status, 0, build.stderr)
  const result = spawnSync(process.execPath, ['--test', bundle], { cwd: root, encoding: 'utf8', timeout: 15000 })
  writeFileSync(join(output, 'transport.log'), (result.stdout ?? '') + (result.stderr ?? ''))
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
