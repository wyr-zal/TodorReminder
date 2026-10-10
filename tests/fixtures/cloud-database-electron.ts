import { app } from 'electron'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import * as database from '../../src/main/database'
import type { Memo } from '../../src/shared/types'

const dir = process.env.CLOUD_TEST_DIR!
assert.ok(dir, 'isolated CLOUD_TEST_DIR is required')
mkdirSync(dir, { recursive: true })
app.setPath('userData', dir)
const memo = (id = randomUUID()): Memo => ({ id, content: 'offline', type: 'text', priority: 'unimportant', status: 'not_started', attachments: [], tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null, deviceId: 'fixture', deleted: false })

app.whenReady().then(async () => {
  try {
    await database.initDatabase()
    let cloud = database.getCloudDatabase()
    const before = memo()
    await database.createMemo(before)
    assert.equal((await cloud.pending()).length, 0, 'unconfigured remains local')
    await cloud.bind('11111111-1111-4111-8111-111111111111', 'http://127.0.0.1:18080', [before])
    await cloud.savePullState('11111111-1111-4111-8111-111111111111', '3', new Date().toISOString())
    assert.equal((await cloud.pending()).length, 1)

    let first = (await cloud.heads())[0]
    await cloud.prepare(first.operationId, { method: 'POST', path: '/api/v1/memos', body: { id: before.id, content: 'offline' } })
    await database.updateMemo(before.id, { content: 'second edit' })
    let pending = await cloud.pending()
    const second = pending[1]
    assert.equal(second.predecessor, first.operationId)
    await cloud.ack(first.operationId, { id: before.id, appliedVersion: '1', updatedAt: before.updatedAt, createdAt: before.createdAt, completedAt: null, deleted: false, purged: false })
    assert.equal((await cloud.pending()).length, 1, 'old ack must preserve new edit')
    assert.equal((await cloud.heads())[0].baseVersion, '1')
    assert.equal((await database.getMemoById(before.id))?.content, 'second edit')

    await database.closeDatabase()
    await database.initDatabase()
    cloud = database.getCloudDatabase()
    assert.equal((await cloud.pending()).length, 1, 'restart keeps queue')
    assert.equal((await cloud.pullState('11111111-1111-4111-8111-111111111111'))?.cursor, '3', 'restart keeps the dataset pull cursor')
    await assert.rejects(cloud.savePullState('11111111-1111-4111-8111-111111111111', '2', new Date().toISOString()), /倒退/)
    first = (await cloud.heads())[0]
    await cloud.prepare(first.operationId, { method: 'PATCH', path: '/api/v1/memos/' + before.id, body: { baseVersion: '1', content: 'second edit' } })
    await cloud.prepare(first.operationId, { method: 'PATCH', path: '/wrong', body: {} })
    assert.equal((await cloud.heads())[0].request?.path, '/api/v1/memos/' + before.id, 'retry request remains immutable')

    const remote = { ...before, content: 'server wins', attachmentIds: [], version: '3', purged: false }
    assert.equal(await cloud.applyRemote(remote, []), false, 'snapshot cannot overwrite pending edits')
    await cloud.mark(first.operationId, 'conflict', 'version_conflict')
    await database.updateMemo(before.id, { content: 'still old branch' })
    assert.equal((await cloud.pending()).length, 2)
    await cloud.applyRemote(remote, [], first.operationId)
    assert.equal((await cloud.pending()).length, 0)
    assert.equal((await database.getMemoById(before.id))?.content, 'server wins')

    const oldDraft = (await database.getMemoById(before.id))!
    await cloud.applyRemote({ ...remote, content: 'remote edit while draft open', version: '4' }, [])
    await assert.rejects(database.updateMemo(before.id, { content: 'stale draft' }, oldDraft), /变化/)
    assert.equal((await cloud.pending()).length, 0, 'stale draft must not become a rebased operation')
    await database.updateMemo(before.id, { content: 'new branch' })
    assert.equal((await cloud.heads())[0].baseVersion, '4')
    await cloud.mark((await cloud.heads())[0].operationId, 'invalid', 'invalid_request')
    await database.updateMemo(before.id, { content: 'corrected' })
    assert.equal((await cloud.pending()).length, 1)
    assert.equal((await cloud.heads())[0].state, 'queued')
    assert.equal((await cloud.heads())[0].baseVersion, '4')
    await database.deleteMemo(before.id)
    await cloud.mark((await cloud.heads())[0].operationId, 'invalid', 'invalid_request')
    await database.hardDeleteMemo(before.id)
    assert.deepEqual((await cloud.pending()).filter(x => x.memoId === before.id).map(x => x.kind), ['delete', 'purge'], 'rejected remote branch must retain delete before purge')

    const local = memo()
    await database.createMemo(local)
    await database.deleteMemo(local.id)
    await database.hardDeleteMemo(local.id)
    assert.equal((await cloud.pending()).some(x => x.memoId === local.id), false, 'never sent branch can be cancelled')

    const uncertain = memo()
    await database.createMemo(uncertain)
    const sending = (await cloud.heads()).find(x => x.memoId === uncertain.id)!
    await cloud.prepare(sending.operationId, { method: 'POST', path: '/api/v1/memos', body: {} })
    await database.deleteMemo(uncertain.id)
    await database.hardDeleteMemo(uncertain.id)
    assert.equal((await cloud.pending()).filter(x => x.memoId === uncertain.id).length, 3, 'uncertain create must not be cancelled')

    const files = memo()
    files.attachments = ['fixture.png']
    await database.createMemo(files)
    assert.equal(await cloud.isImageReferenced('fixture.png'), true)
    await database.updateMemo(files.id, { attachments: [] })
    assert.equal(await cloud.isImageReferenced('fixture.png'), true, 'pending payload protects image')

    const rejected = memo()
    await database.createMemo(rejected)
    await cloud.mark((await cloud.heads()).find(x => x.memoId === rejected.id)!.operationId, 'invalid', 'invalid_request')
    await database.deleteMemo(rejected.id)
    assert.deepEqual((await cloud.pending()).filter(x => x.memoId === rejected.id).map(x => x.kind), ['create', 'delete'], 'deleting a rejected create must not resurrect it as active')

    const rejectedPurge = memo()
    await database.createMemo(rejectedPurge)
    await cloud.mark((await cloud.heads()).find(x => x.memoId === rejectedPurge.id)!.operationId, 'invalid', 'invalid_request')
    await database.hardDeleteMemo(rejectedPurge.id)
    assert.equal((await cloud.pending()).some(x => x.memoId === rejectedPurge.id), false, 'purging a rejected create must cancel the branch')

    const rolledBack = memo() as Memo & { self?: unknown }
    rolledBack.self = rolledBack
    await assert.rejects(database.createMemo(rolledBack))
    assert.equal(await database.getMemoById(rolledBack.id), null, 'memo save must rollback when outbox serialization fails')

    await cloud.backup(join(dir, 'local-backup.db'))
    await database.closeDatabase()
    console.log(JSON.stringify({ status: 'passed', fixture: 'Worker-owned SQLite + atomic outbox' }))
    app.exit(0)
  } catch (error) {
    console.error(error)
    await database.closeDatabase().catch(() => {})
    app.exit(1)
  }
})
