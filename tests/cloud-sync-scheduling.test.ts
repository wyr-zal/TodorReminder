import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const datasetId = '11111111-1111-4111-8111-111111111111'
const sourcePath = new URL('../src/main/cloudSync.ts', import.meta.url)

function loadCloudSync() {
  const source = readFileSync(sourcePath, 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} as Record<string, any> }
  const timers = {
    nextId: 0,
    timeouts: new Map<number, { callback: () => void; delay: number }>(),
    intervals: new Map<number, { callback: () => void; delay: number }>()
  }
  class CloudHttpError extends Error {
    status = 0
    code = 'unavailable'
  }
  class CloudAttachmentError extends Error {}
  class CloudAttachments {
    constructor() {}
    async upload() { return [] }
    async download() { return [] }
  }
  const dependencies: Record<string, unknown> = {
    './cloudApi': { CloudApi: class {}, CloudHttpError },
    './cloudAttachments': { CloudAttachments, CloudAttachmentError },
    './cloudDatabase': {},
    './cloudProtocol': {
      assertSnapshotProgress() {},
      makeRequest() { return { method: 'POST', path: '/api/v1/memos', body: {} } },
      validateReceipt(value: unknown) { return value }
    }
  }
  const factory = runInNewContext(`(function(require,module,exports){${js}\n})`, {
    Error,
    Date,
    Promise,
    Set,
    Map,
    BigInt,
    setTimeout(callback: () => void, delay: number) {
      const id = ++timers.nextId
      timers.timeouts.set(id, { callback, delay })
      return id
    },
    clearTimeout(id: number) { timers.timeouts.delete(id) },
    setInterval(callback: () => void, delay: number) {
      const id = ++timers.nextId
      timers.intervals.set(id, { callback, delay })
      return id
    },
    clearInterval(id: number) { timers.intervals.delete(id) }
  }) as (require: (name: string) => unknown, module: { exports: Record<string, any> }, exports: Record<string, any>) => void
  factory(name => {
    if (!(name in dependencies)) throw new Error(`Unexpected import ${name}`)
    return dependencies[name]
  }, module, module.exports)
  return { CloudSync: module.exports.CloudSync, timers }
}

function database() {
  const calls = { saved: [] as Array<{ datasetId: string; cursor: string }> }
  return {
    calls,
    db: {
      async binding() { return { datasetId, url: 'https://memo.example' } },
      async pending() { return [] },
      async heads() { return [] },
      async metas() { return [] },
      async pullState() { return { datasetId, cursor: '0', lastPulledAt: '2026-01-01T00:00:00.000Z' } },
      async savePullState(currentDataset: string, cursor: string) { calls.saved.push({ datasetId: currentDataset, cursor }) }
    }
  }
}

function api() {
  return {
    url: 'https://memo.example',
    abortCount: 0,
    changesCalls: 0,
    async changes(cursor: string) {
      this.changesCalls++
      return { datasetId, schemaVersion: 1, cursor, highWater: cursor, hasMore: false, changes: [], attachments: [] }
    },
    abort() { this.abortCount++ }
  }
}

test('automatic sync waits while visible; explicit manual sync is allowed', async () => {
  const { CloudSync } = loadCloudSync()
  const { db, calls } = database()
  const remote = api()
  const sync = new CloudSync(db, remote as any, 'unused')
  await sync.start(true)
  sync.schedule()
  assert.equal((await sync.sync(false)).success, false)
  assert.equal(remote.changesCalls, 0)
  assert.equal((await sync.sync(true)).success, true)
  assert.equal(remote.changesCalls, 1)
  assert.equal(calls.saved.length, 1)
  await sync.stop()
})

test('hiding starts background work and sets ten-minute cadence', async () => {
  const { CloudSync, timers } = loadCloudSync()
  const { db, calls } = database()
  const remote = api()
  let completed!: (result: { success: boolean }) => void
  const done = new Promise<{ success: boolean }>(resolve => { completed = resolve })
  const sync = new CloudSync(db, remote as any, 'unused', completed)
  await sync.start(true)
  sync.setVisible(false)
  assert.equal([...timers.intervals.values()][0]?.delay, 600000)
  const pendingTimer = [...timers.timeouts.entries()].find(([, value]) => value.delay === 500)
  assert.ok(pendingTimer)
  timers.timeouts.delete(pendingTimer![0])
  pendingTimer![1].callback()
  assert.equal((await done).success, true)
  assert.equal(calls.saved.length, 1)
  sync.setVisible(true)
  assert.equal(timers.intervals.size, 0)
  await sync.stop()
})

test('show aborts an automatic pull and leaves the cursor unchanged', async () => {
  const { CloudSync } = loadCloudSync()
  const { db, calls } = database()
  let rejectPull!: (error: Error) => void
  let signalStarted!: () => void
  const started = new Promise<void>(resolve => { signalStarted = resolve })
  const remote = {
    url: 'https://memo.example',
    abortCount: 0,
    async changes() {
      signalStarted()
      return new Promise((_resolve, reject) => { rejectPull = reject })
    },
    abort() {
      this.abortCount++
      rejectPull?.(new Error('aborted'))
    }
  }
  const sync = new CloudSync(db, remote as any, 'unused')
  await sync.start(false)
  const run = sync.sync(false)
  await started
  sync.setVisible(true)
  const result = await run
  assert.equal(result.success, false)
  assert.equal(remote.abortCount, 1)
  assert.equal(calls.saved.length, 0)
  await sync.stop()
})
