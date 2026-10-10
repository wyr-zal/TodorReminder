const electron = require('electron')
const assert = require('node:assert/strict')
const { Worker } = require('node:worker_threads')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { randomUUID } = require('node:crypto')
const { app } = electron
const root = resolve(__dirname, '../..')
const userData = mkdtempSync(join(tmpdir(), 'focus-memo-worker-'))
const workerPath = process.env.DATABASE_WORKER_PATH || join(root, 'dist/main/databaseWorker.mjs')

function createChannel(worker) {
  let nextId = 0
  const pending = new Map()
  worker.on('message', response => {
    const request = pending.get(response.id)
    if (!request) return
    pending.delete(response.id)
    if (response.ok) request.resolve(response.value)
    else request.reject(new Error(response.error.message))
  })
  worker.on('error', error => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  })
  return (method, args = []) => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    worker.postMessage({ id, method, args })
  })
}

app.whenReady().then(async () => {
  let worker
  try {
    app.setPath('userData', userData)
    worker = new Worker(workerPath, { type: 'module' })
    const call = createChannel(worker)
    await call('database.init', [join(userData, 'memos.db')])
    const now = new Date().toISOString()
    const rows = Array.from({ length: 2000 }, (_, index) => ({
      id: randomUUID(),
      content: `worker memo ${index} ${'x'.repeat(200)}`,
      type: 'text',
      priority: 'unimportant',
      status: 'not_started',
      attachments: [],
      tags: [],
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      deviceId: 'worker-fixture',
      deleted: false
    }))
    await call('memo.import', [{ memos: rows }])
    let timerFired = false
    const read = call('memo.getAll')
    await new Promise(resolve => setTimeout(() => { timerFired = true; resolve() }, 0))
    assert.equal(timerFired, true, 'main event loop must progress during SQLite reads')
    assert.equal((await read).length, rows.length)

    const datasetId = '11111111-1111-4111-8111-111111111111'
    await call('cloud.bind', [datasetId, 'http://127.0.0.1:18080', [rows[0]]])
    assert.equal((await call('cloud.pending')).length, 1)
    const lastPulledAt = new Date().toISOString()
    await call('cloud.savePullState', [datasetId, '42', lastPulledAt])
    assert.deepEqual(await call('cloud.pullState', [datasetId]), { datasetId, cursor: '42', lastPulledAt })
    const rolledBack = { ...rows[1], id: randomUUID(), self: null }
    rolledBack.self = rolledBack
    await assert.rejects(call('memo.create', [rolledBack]))
    assert.equal(await call('memo.getById', [rolledBack.id]), null, 'memo/outbox transaction must rollback together')

    await call('database.close')
    await worker.terminate()
    worker = null
    console.log('DATABASE_WORKER_PASS')
    app.quit()
  } catch (error) {
    console.error(error)
    if (worker) await worker.terminate()
    app.exit(1)
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})
