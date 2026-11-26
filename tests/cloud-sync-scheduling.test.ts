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
    status: number
    code: string
    constructor(status = 0, code = 'unavailable') {
      super('http error')
      this.status = status
      this.code = code
    }
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
  return { CloudSync: module.exports.CloudSync, timers, CloudHttpError }
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

const pushedMemoId = '22222222-2222-4222-8222-222222222222'

function receipt(id: string) {
  return { id, appliedVersion: '1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', completedAt: null, deleted: false, purged: false }
}

function operation(seq: number, operationId: string): any {
  return {
    seq,
    operationId,
    memoId: pushedMemoId,
    kind: 'create',
    payload: {
      id: pushedMemoId,
      content: 'x',
      type: 'text',
      priority: 'unimportant',
      status: 'not_started',
      attachments: [],
      tags: ['TODO'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      completedAt: null,
      deviceId: 'desktop',
      deleted: false
    },
    baseVersion: null,
    predecessor: null,
    state: 'queued',
    request: null,
    error: null
  }
}

function pushDatabase(initial: any[] = [operation(1, 'op-1')]) {
  const queue = [...initial]
  const calls = {
    acked: [] as string[],
    marked: [] as Array<{ id: string; state: string }>,
    prepared: [] as string[],
    saved: [] as string[]
  }
  const db = {
    async binding() { return { datasetId, url: 'https://memo.example' } },
    async pending() { return queue },
    async heads() { return queue.length ? [queue[0]] : [] },
    async metas() { return [] },
    async meta() { return null },
    async prepare(id: string, request: unknown) {
      calls.prepared.push(id)
      const target = queue.find(item => item.operationId === id)
      if (target) target.request = request
      return true
    },
    async ack(id: string) {
      calls.acked.push(id)
      const index = queue.findIndex(item => item.operationId === id)
      if (index >= 0) queue.splice(index, 1)
    },
    async mark(id: string, state: string) {
      calls.marked.push({ id, state })
      const target = queue.find(item => item.operationId === id)
      if (target) target.state = state
    },
    async pullState() { return { datasetId, cursor: '0', lastPulledAt: '2026-01-01T00:00:00.000Z' } },
    async savePullState(_datasetId: string, cursor: string) { calls.saved.push(cursor) },
    async attachment() { return { filename: 'unused', operationId: 'attachment-op', remoteId: 'remote-id', sha256: 'sha' } }
  }
  return { db, queue, calls }
}

function pushApi(handler: (request: unknown, operationId: string) => Promise<unknown>) {
  const calls = { mutate: [] as string[], changes: 0, abort: 0 }
  const api = {
    url: 'https://memo.example',
    async mutate(request: unknown, operationId: string) {
      calls.mutate.push(operationId)
      return handler(request, operationId)
    },
    async changes(cursor: string) {
      calls.changes++
      return { datasetId, schemaVersion: 1, cursor, highWater: cursor, hasMore: false, changes: [], attachments: [] }
    },
    abort() { calls.abort++ }
  }
  return { api, calls }
}

async function flush(rounds = 200) {
  for (let index = 0; index < rounds; index++) await Promise.resolve()
}

function takeTimer(timers: any, delay: number): { callback: () => void } {
  const entries = [...timers.timeouts.entries()] as Array<[number, { callback: () => void; delay: number }]>
  const entry = entries.find(([, value]) => value.delay === delay)
  assert.ok(entry, `expected a ${delay}ms timer`)
  timers.timeouts.delete(entry![0])
  return entry![1]
}

test('local change while visible pushes immediately without pulling', async () => {
  const { CloudSync, timers } = loadCloudSync()
  const { db, calls } = pushDatabase()
  const { api, calls: apiCalls } = pushApi(async (_request, operationId) => receipt(operationId))
  const sync = new CloudSync(db, api as any, 'unused')
  await sync.start(true)
  sync.noteLocalChange()
  takeTimer(timers, 300).callback()
  await flush()
  assert.deepEqual(calls.acked, ['op-1'])
  assert.deepEqual(apiCalls.mutate, ['op-1'])
  assert.equal(apiCalls.changes, 0)
  await sync.stop()
})

test('rapid local changes are merged into one push', async () => {
  const { CloudSync, timers } = loadCloudSync()
  const { db, calls } = pushDatabase()
  const { api, calls: apiCalls } = pushApi(async (_request, operationId) => receipt(operationId))
  const sync = new CloudSync(db, api as any, 'unused')
  await sync.start(true)
  sync.noteLocalChange()
  sync.noteLocalChange()
  sync.noteLocalChange()
  assert.equal(timers.timeouts.size, 1)
  takeTimer(timers, 300).callback()
  await flush()
  assert.deepEqual(apiCalls.mutate, ['op-1'])
  assert.deepEqual(calls.acked, ['op-1'])
  await sync.stop()
})

test('failed push retries with capped backoff', async () => {
  const { CloudSync, timers, CloudHttpError } = loadCloudSync()
  const { db } = pushDatabase()
  const { api, calls } = pushApi(async () => { throw new CloudHttpError(0, 'unavailable') })
  const sync = new CloudSync(db, api as any, 'unused')
  await sync.start(true)
  sync.noteLocalChange()
  takeTimer(timers, 300).callback()
  await flush()
  for (const delay of [2000, 5000, 15000, 30000, 60000]) {
    takeTimer(timers, delay).callback()
    await flush()
  }
  assert.equal(calls.mutate.length, 6)
  const delays = [...timers.timeouts.values()].map((value: any) => value.delay)
  assert.deepEqual(delays, [60000])
  await sync.stop()
})

test('consecutive writes for one memo keep queue order', async () => {
  const { CloudSync, timers } = loadCloudSync()
  const { db, calls } = pushDatabase([operation(1, 'op-1'), operation(2, 'op-2')])
  const { api, calls: apiCalls } = pushApi(async (_request, operationId) => receipt(operationId))
  const sync = new CloudSync(db, api as any, 'unused')
  await sync.start(true)
  sync.noteLocalChange()
  takeTimer(timers, 300).callback()
  await flush()
  assert.deepEqual(apiCalls.mutate, ['op-1', 'op-2'])
  assert.deepEqual(calls.acked, ['op-1', 'op-2'])
  await sync.stop()
})

test('409 conflict marks the operation and pulls the server version', async () => {
  const { CloudSync, timers, CloudHttpError } = loadCloudSync()
  const { db, calls } = pushDatabase()
  const { api, calls: apiCalls } = pushApi(async () => { throw new CloudHttpError(409, 'version_conflict') })
  const sync = new CloudSync(db, api as any, 'unused')
  await sync.start(true)
  sync.noteLocalChange()
  takeTimer(timers, 300).callback()
  await flush()
  assert.deepEqual(calls.marked, [{ id: 'op-1', state: 'conflict' }])
  assert.equal(apiCalls.changes, 0)
  takeTimer(timers, 300).callback()
  await flush()
  assert.equal(apiCalls.changes, 1)
  assert.equal(calls.saved.length, 1)
  await sync.stop()
})

test('showing the window does not abort an in-flight push', async () => {
  const { CloudSync, timers } = loadCloudSync()
  const { db, calls } = pushDatabase()
  let resolveMutate!: (value: unknown) => void
  const { api, calls: apiCalls } = pushApi(() => new Promise(resolve => { resolveMutate = resolve }))
  const sync = new CloudSync(db, api as any, 'unused')
  await sync.start(false)
  timers.intervals.clear()
  timers.timeouts.clear()
  sync.noteLocalChange()
  takeTimer(timers, 300).callback()
  await flush()
  assert.deepEqual(apiCalls.mutate, ['op-1'])
  sync.setVisible(true)
  assert.equal(apiCalls.abort, 0)
  resolveMutate(receipt(pushedMemoId))
  await flush()
  assert.deepEqual(calls.acked, ['op-1'])
  await sync.stop()
})
