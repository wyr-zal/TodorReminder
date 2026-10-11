import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../.omx/qa/cloud-config/', import.meta.url))
mkdirSync(root, { recursive: true })
function configModule() {
  const source = readFileSync(new URL('../src/main/cloudConfig.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} as Record<string, any> }
  const dependencies: Record<string, unknown> = {
    'node:fs': require('node:fs'),
    'node:path': require('node:path'),
    './cloudProtocol': { validateServerURL(value: string) {
      const url = new URL(value)
      if (url.protocol !== 'https:') throw new Error('invalid URL')
      return url.href.replace(/\/+$/, '')
    } }
  }
  const factory = runInNewContext(`(function(require,module,exports){${js}\n})`, { Error })
  factory((name: string) => {
    assert.ok(name in dependencies, `unexpected dependency: ${name}`)
    return dependencies[name]
  }, module, module.exports)
  return module.exports
}

test('cloud configuration needs only a URL and does not require Electron credential storage', () => {
  const config = configModule()
  const dir = mkdtempSync(join(root, 'url-only-'))
  assert.equal(config.loadCloudConfig(dir), null)
  config.saveCloudConfig(dir, { url: 'https://memo.example/' })
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'cloud-config.json'), 'utf8')), { version: 1, url: 'https://memo.example' })
  assert.equal(config.loadCloudConfig(dir).url, 'https://memo.example')
})

test('existing encrypted token is ignored without decrypting or rewriting the config', () => {
  const config = configModule()
  const dir = mkdtempSync(join(root, 'existing-'))
  const path = join(dir, 'cloud-config.json')
  const before = JSON.stringify({ version: 1, url: 'https://memo.example', tokenCipher: 'obsolete-invalid-cipher' })
  writeFileSync(path, before)
  assert.equal(config.loadCloudConfig(dir).url, 'https://memo.example')
  assert.equal(config.loadCloudConfig(dir).token, undefined)
  assert.equal(readFileSync(path, 'utf8'), before)
})

test('malformed cloud config is still rejected without exposing its contents', () => {
  const config = configModule()
  const dir = mkdtempSync(join(root, 'invalid-'))
  for (const value of [{ version: 2, url: 'https://memo.example' }, { version: 1, url: 'private-invalid-value' }]) {
    writeFileSync(join(dir, 'cloud-config.json'), JSON.stringify(value))
    assert.throws(() => config.loadCloudConfig(dir), /服务器配置不可用/)
  }
})
