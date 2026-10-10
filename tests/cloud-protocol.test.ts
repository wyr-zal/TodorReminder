import test from 'node:test'
import assert from 'node:assert/strict'
import { validateChangesPage, validateSnapshot, validateServerURL, assertSnapshotProgress, makeRequest } from '../src/main/cloudProtocol.ts'
const id = '11111111-1111-4111-8111-111111111111'
const memo = { id, content: 'x', type: 'text', priority: 'unimportant', status: 'not_started', tags: [], attachmentIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', completedAt: null, deviceId: 'x', deleted: false, purged: false, version: '9007199254740993' }
const snapshot = () => ({ datasetId: id, schemaVersion: 1, changeCursor: '0', complete: true, totalRows: 1, memos: [{ ...memo }], attachments: [] })
test('snapshot validates exact completeness and version strings', () => {
 assert.equal(validateSnapshot(snapshot()).memos[0].version, '9007199254740993')
 for (const patch of [{ complete: false }, { totalRows: 2 }, { schemaVersion: 2 }, { datasetId: 'bad' }]) assert.throws(() => validateSnapshot({ ...snapshot(), ...patch }))
 for (const version of ['0', '01', '18446744073709551616', 2]) assert.throws(() => validateSnapshot({ ...snapshot(), memos: [{ ...memo, version }] }))
})
test('snapshot reports an unavailable incremental API without mutating local state', () => {
 assert.throws(() => validateSnapshot({ ...snapshot(), changeCursor: undefined }), /服务器尚未升级到增量同步接口/)
})
test('missing image descriptors and duplicate IDs rejected before applying', () => {
 assert.throws(() => validateSnapshot({ ...snapshot(), memos: [{ ...memo, attachmentIds: [id] }] }))
 assert.throws(() => validateSnapshot({ ...snapshot(), totalRows: 2, memos: [memo, memo] }))
})
test('snapshot refuses rollback or missing known records without rebasing queued changes', () => {
 const value = validateSnapshot(snapshot())
 assert.doesNotThrow(() => assertSnapshotProgress(value, id, [{ memoId: id, version: '9007199254740992', purged: 0 }]))
 assert.throws(() => assertSnapshotProgress(value, id, [{ memoId: id, version: '9007199254740994', purged: 0 }]))
 assert.throws(() => assertSnapshotProgress({ ...value, memos: [], totalRows: 0 }, id, [{ memoId: id, version: '1', purged: 0 }]))
 assert.throws(() => assertSnapshotProgress(value, '22222222-2222-4222-8222-222222222222', []))
})
test('incremental cursor pages preserve high-water and tombstones', () => {
 const first = { datasetId: id, schemaVersion: 1, cursor: '1', highWater: '3', hasMore: true, changes: [{ sequence: '1', memo: { ...memo } }], attachments: [] }
 assert.equal(validateChangesPage(first, id, '0').changes[0].memo.version, memo.version)
 const last = { ...first, cursor: '3', hasMore: false, changes: [{ sequence: '2', memo: { ...memo, deleted: true, purged: true, content: '', tags: [], attachmentIds: [] } }] }
 assert.equal(validateChangesPage(last, id, '1', '3').cursor, '3')
 assert.throws(() => validateChangesPage({ ...first, cursor: '2' }, id, '0'))
 assert.throws(() => validateChangesPage({ ...first, changes: [{ sequence: '0', memo: { ...memo } }] }, id, '0'))
 assert.throws(() => validateChangesPage({ ...first, highWater: '4' }, id, '0', '3'))
})
test('server URL allows HTTPS or loopback HTTP only; no userinfo or URL secrets', () => {
 assert.equal(validateServerURL('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080')
 assert.equal(validateServerURL('https://example.com/memo/'), 'https://example.com/memo')
 for (const url of ['http://example.com', 'https://u:p@example.com', 'https://example.com?token=x', 'file:///a', 'https://example.com#x']) assert.throws(() => validateServerURL(url))
})
test('request uses predecessor receipt version, not any fetched version; DELETE uses query', () => {
 const op: any = { kind: 'update', memoId: id, baseVersion: '9007199254740993', payload: { ...memo, attachments: [] } }
 assert.equal(makeRequest(op, []).body?.baseVersion, '9007199254740993')
 assert.deepEqual(makeRequest({ ...op, kind: 'purge' }, []), { method: 'DELETE', path: '/api/v1/memos/' + id + '?baseVersion=9007199254740993&permanent=true' })
 assert.throws(() => makeRequest({ ...op, baseVersion: null }, []))
})
test('empty live memo and inconsistent purge receipts are rejected', async () => {
 assert.throws(() => validateSnapshot({ ...snapshot(), memos: [{ ...memo, content: '  ', attachmentIds: [] }] }))
 const { validateReceipt } = await import('../src/main/cloudProtocol.ts')
 assert.throws(() => validateReceipt({ id, appliedVersion: '1', createdAt: memo.createdAt, updatedAt: memo.updatedAt, completedAt: null, deleted: false, purged: true }, id))
})
