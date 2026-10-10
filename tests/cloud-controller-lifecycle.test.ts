import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const nativeRequire = createRequire(import.meta.url)
const rootPath = fileURLToPath(new URL('..', import.meta.url))

function loadController() {
  const source = readFileSync(new URL('../src/main/cloudController.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} as Record<string, any> }
  let config: { url: string; token: string } | null = null
  let workerStops = 0
  let workerStarts = 0
  let failNextConfigSave = false

  class CloudApi {
    url: string
    token: string
    constructor(url: string, token: string) { this.url = url; this.token = token }
    expectDataset(_id: string) {}
  }
  class CloudSync {
    constructor() {}
    start() { workerStarts++ }
    schedule() {}
    async stop() { workerStops++ }
    status() { return { isSyncing: false, lastSync: null, error: null, configured: true, connected: true, pending: 0 } }
    async sync() { return { success: true, changed: false } }
  }
  const dependencies: Record<string, unknown> = {
    'node:crypto': nativeRequire('node:crypto'),
    'node:fs': { copyFileSync() {}, cpSync() {}, existsSync() { return false }, mkdirSync() {} },
    'node:path': nativeRequire('node:path'),
    './cloudApi': { CloudApi },
    './cloudDatabase': {},
    './cloudConfig': {
      loadCloudConfig: () => config,
      saveCloudConfig: (_root: string, next: typeof config) => {
        if (failNextConfigSave) {
          failNextConfigSave = false
          throw new Error('simulated config write failure')
        }
        config = next
      }
    },
    './cloudProtocol': { assertSnapshotProgress() {}, validateServerURL: (url: string) => url },
    './cloudSync': { CloudSync }
  }
  const loadDependency = (name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected import ${name}`)
    return dependencies[name]
  }
  const factory = runInNewContext(`(function(require,module,exports){${js}\n})`, { Error, Date, URL, BigInt }) as (require: (name: string) => unknown, module: { exports: Record<string, any> }, exports: Record<string, any>) => void
  factory(loadDependency, module, module.exports)
  return {
    CloudController: module.exports.CloudController,
    getWorkerStops: () => workerStops,
    getWorkerStarts: () => workerStarts,
    failNextConfigSave: () => { failNextConfigSave = true }
  }
}

test('migration gate rejects cloud lifecycle requests after stopping the worker', async () => {
  const { CloudController, getWorkerStops } = loadController()
  const database = { binding: async () => ({ datasetId: '11111111-1111-4111-8111-111111111111', url: 'https://memo.example' }), pending: async () => [] }
  const controller = new CloudController(database as any, async () => [], rootPath)

  await controller.save({ url: 'https://memo.example', token: 'x'.repeat(40) })
  await controller.beginStorageMigration()

  assert.equal(getWorkerStops(), 1)
  await assert.rejects(controller.save({ url: 'https://other.example', token: 'x'.repeat(40) }), /迁移中/)
  await assert.rejects(controller.preview(), /迁移中/)
  await assert.rejects(controller.confirm('ticket'), /迁移中/)
  assert.equal((await controller.sync()).success, false)
  await controller.resume()
  controller.schedule()
  assert.equal((await controller.status()).connected, false)
})

test('save restores the previous worker when config persistence fails', async () => {
  const { CloudController, failNextConfigSave, getWorkerStarts, getWorkerStops } = loadController()
  const database = { binding: async () => ({ datasetId: '11111111-1111-4111-8111-111111111111', url: 'https://memo.example' }), pending: async () => [] }
  const controller = new CloudController(database as any, async () => [], rootPath)
  const token = 'x'.repeat(40)

  await controller.save({ url: 'https://memo.example', token })
  assert.equal(getWorkerStarts(), 1)

  failNextConfigSave()
  await assert.rejects(controller.save({ url: 'https://other.example', token }), /simulated config write failure/)

  assert.equal((await controller.view()).url, 'https://memo.example')
  assert.equal(getWorkerStops(), 1)
  assert.equal(getWorkerStarts(), 2)
})
