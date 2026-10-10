import { app } from 'electron'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'
import * as database from '../../src/main/database'
import { CloudApi, CloudHttpError } from '../../src/main/cloudApi'
import { CloudSync } from '../../src/main/cloudSync'
import type { Memo } from '../../src/shared/types'

const root = process.env.CLOUD_TEST_DIR!
assert.ok(root && process.env.CLOUD_TEST_URL && process.env.CLOUD_TEST_TOKEN)
mkdirSync(root, { recursive: true })
app.setPath('userData', root)
const value = (id = randomUUID()): Memo => ({ id, content: 'offline create', type: 'text', priority: 'unimportant', status: 'not_started', attachments: [], tags: [], createdAt: '2021-01-02T03:04:05.000Z', updatedAt: '2021-01-02T03:04:05.000Z', completedAt: null, deviceId: 'fixture', deleted: false })

app.whenReady().then(async () => {
  try {
    await database.initDatabase()
    let db = database.getCloudDatabase()
    const api = new CloudApi(process.env.CLOUD_TEST_URL!, process.env.CLOUD_TEST_TOKEN!)
    const meta = await api.meta()
    api.expectDataset(meta.datasetId)
    await db.bind(meta.datasetId, api.url, [])
    mkdirSync(join(root, 'attachments'), { recursive: true })
    copyFileSync(process.env.CLOUD_TEST_IMAGE!, join(root, 'attachments', 'offline.png'))

    const local = value()
    local.attachments = ['offline.png']
    local.type = 'image'
    await database.createMemo(local)
    await database.updateMemo(local.id, { content: 'offline second', status: 'in_progress' })
    let worker = new CloudSync(db, api, join(root, 'attachments'))
    assert.equal((await worker.sync()).success, true)
    assert.equal((await db.pending()).length, 0)
    let saved = (await api.snapshot()).memos.find(m => m.id === local.id)!
    assert.equal(saved.content, 'offline second')
    assert.equal(saved.status, 'in_progress')
    assert.equal(saved.attachmentIds.length, 1)

    await api.mutate({ method: 'PATCH', path: '/api/v1/memos/' + local.id, body: { baseVersion: saved.version, content: 'phone wins' } }, randomUUID())
    await database.updateMemo(local.id, { content: 'offline stale' })
    await database.updateMemo(local.id, { content: 'offline stale child' })
    assert.equal((await worker.sync()).success, true)
    assert.equal((await database.getMemoById(local.id))?.content, 'phone wins')
    assert.equal((await db.pending()).length, 0)

    await database.updateMemo(local.id, { content: 'response loss test' })
    const operation = (await db.heads())[0].operationId
    const mutate = api.mutate.bind(api)
    let lose = true
    api.mutate = async (request, id) => {
      const result = await mutate(request, id)
      if (lose) { lose = false; throw new CloudHttpError(0, 'unavailable') }
      return result
    }
    assert.equal((await worker.sync()).success, false)
    assert.equal((await db.heads())[0].operationId, operation)
    assert.ok((await db.heads())[0].request)
    await worker.stop()
    await database.closeDatabase()
    await database.initDatabase()
    db = database.getCloudDatabase()
    api.mutate = mutate
    worker = new CloudSync(db, api, join(root, 'attachments'))
    assert.equal((await worker.sync()).success, true)
    assert.equal((await db.pending()).length, 0)
    assert.equal((await database.getMemoById(local.id))?.content, 'response loss test')

    await database.updateMemo(local.id, { content: 'older in-flight' })
    let later = true
    api.mutate = async (request, id) => {
      const result = await mutate(request, id)
      if (later) { later = false; await database.updateMemo(local.id, { content: 'new local edit' }) }
      return result
    }
    assert.equal((await worker.sync()).success, true)
    api.mutate = mutate
    assert.equal((await database.getMemoById(local.id))?.content, 'new local edit')

    const triggerMemo = value()
    await database.createMemo(triggerMemo)
    assert.equal((await worker.sync()).success, true)
    const triggerRemote = (await api.snapshot()).memos.find(m => m.id === triggerMemo.id)!
    await api.mutate({ method: 'PATCH', path: '/api/v1/memos/' + triggerMemo.id, body: { baseVersion: triggerRemote.version, content: 'server update during pull' } }, randomUUID())
    const changes = api.changes.bind(api)
    let changeCalls = 0
    api.changes = async (cursor, through) => {
      const page = await changes(cursor, through)
      if (++changeCalls === 1) await database.updateMemo(local.id, { content: 'saved during pull' })
      return page
    }
    const pullResult = await worker.sync()
    api.changes = changes
    assert.equal(pullResult.success, false)
    assert.equal((await database.getMemoById(local.id))?.content, 'saved during pull')
    assert.ok((await db.pending()).some(op => op.memoId === local.id))
    assert.equal((await worker.sync()).success, true)

    const socket = createServer()
    await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve))
    const unusedPort = (socket.address() as { port: number }).port
    await new Promise<void>(resolve => socket.close(() => resolve()))
    const offlineMemo = value()
    await database.createMemo(offlineMemo)
    const offlineApi = new CloudApi(`http://127.0.0.1:${unusedPort}`, process.env.CLOUD_TEST_TOKEN!)
    offlineApi.expectDataset(meta.datasetId)
    const offline = new CloudSync(db, offlineApi, join(root, 'attachments'))
    assert.equal((await offline.sync()).success, false)
    assert.ok(await database.getMemoById(offlineMemo.id))
    assert.ok((await db.pending()).some(op => op.memoId === offlineMemo.id))
    await offline.stop()
    assert.equal((await worker.sync()).success, true)

    const missing = value()
    missing.attachments = ['missing-fixture.png']
    await database.createMemo(missing)
    const independent = value()
    await database.createMemo(independent)
    const partial = await worker.sync()
    assert.equal(partial.success, false)
    assert.equal(partial.changed, true)
    assert.ok((await api.snapshot()).memos.some(m => m.id === independent.id))
    assert.ok((await db.pending()).some(op => op.memoId === missing.id))
    await database.updateMemo(missing.id, { attachments: [] })
    assert.equal((await worker.sync()).success, true, 'correcting a locally rejected attachment must unblock the queue')

    const cancelled = value()
    cancelled.type = 'image'
    copyFileSync(process.env.CLOUD_TEST_IMAGE!, join(root, 'attachments', 'cancel-upload.png'))
    cancelled.attachments = ['cancel-upload.png']
    await database.createMemo(cancelled)
    const upload = api.upload.bind(api)
    api.upload = async (...args) => {
      const result = await upload(...args)
      await database.deleteMemo(cancelled.id)
      await database.hardDeleteMemo(cancelled.id)
      return result
    }
    assert.equal((await worker.sync()).success, true)
    api.upload = upload
    assert.equal(await database.getMemoById(cancelled.id), null)
    assert.equal((await api.snapshot()).memos.some(m => m.id === cancelled.id), false, 'cancelled upload branch must never create a remote memo')

    await database.deleteMemo(local.id)
    assert.equal((await worker.sync()).success, true)
    await database.restoreMemo(local.id)
    assert.equal((await worker.sync()).success, true)

    await worker.stop()
    await database.closeDatabase()
    const secondRoot = join(root, 'second-device')
    mkdirSync(secondRoot, { recursive: true })
    app.setPath('userData', secondRoot)
    await database.initDatabase()
    db = database.getCloudDatabase()
    await db.bind(meta.datasetId, api.url, [])
    worker = new CloudSync(db, api, join(secondRoot, 'attachments'))
    assert.equal((await worker.sync()).success, true)
    const downloaded = (await database.getMemoById(local.id))!
    assert.equal(downloaded.content, 'saved during pull')
    assert.equal(downloaded.attachments.length, 1)
    assert.ok(existsSync(join(secondRoot, 'attachments', downloaded.attachments[0])))
    assert.deepEqual(readFileSync(join(secondRoot, 'attachments', downloaded.attachments[0])), readFileSync(process.env.CLOUD_TEST_IMAGE!))
    await database.deleteMemo(local.id)
    await database.hardDeleteMemo(local.id)
    assert.equal((await worker.sync()).success, true)
    assert.equal(await database.getMemoById(local.id), null)
    assert.equal((await db.meta(local.id))?.purged, 1)
    saved = (await api.snapshot()).memos.find(m => m.id === local.id)!
    assert.equal(saved.purged, true)
    assert.equal(saved.content, '')
    await worker.stop()
    await database.closeDatabase()
    console.log(JSON.stringify({ status: 'passed', fixture: 'real Electron SQLite + Windows MySQL + HTTP', cases: ['offline_fifo', 'image_upload', 'server_wins', 'lost_ack_restart', 'edit_during_send', 'edit_during_pull', 'delete_restore_purge', 'second_device_image_download', 'real_connection_refused', 'partial_success_and_attachment_correction'] }))
    app.exit(0)
  } catch (error) {
    console.error(error)
    await database.closeDatabase().catch(() => {})
    app.exit(1)
  }
})
