import { parentPort } from 'node:worker_threads'
import {
  closeDatabase,
  createMemo,
  deleteMemo,
  exportToJSON,
  getAllMemos,
  getDeletedMemos,
  getMemoById,
  getCloudDatabase,
  hardDeleteMemo,
  importFromJSON,
  initDatabase,
  inspectDatabaseFile,
  restoreMemo,
  updateMemo
} from './databaseCore'
import type { Memo } from '../shared/types'
import type { CloudOperationKind, CloudRequest, MutationReceipt, RemoteMemo } from '../shared/cloudTypes'

const port = parentPort
if (!port) throw new Error('Database worker requires a parent port')

type Request = { id: number; method: string; args: unknown[] }
type Response = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: { name: string; message: string } }

const databaseMethods: Record<string, (...args: any[]) => unknown> = {
  'database.init': initDatabase,
  'database.close': closeDatabase,
  'database.inspectFile': inspectDatabaseFile,
  'memo.getAll': getAllMemos,
  'memo.getById': getMemoById,
  'memo.create': createMemo,
  'memo.update': updateMemo,
  'memo.delete': deleteMemo,
  'memo.getDeleted': getDeletedMemos,
  'memo.restore': restoreMemo,
  'memo.hardDelete': hardDeleteMemo,
  'memo.export': exportToJSON,
  'memo.import': importFromJSON,
  'cloud.binding': () => getCloudDatabase().binding(),
  'cloud.bind': (datasetId: string, url: string, memos: Memo[]) => getCloudDatabase().bind(datasetId, url, memos),
  'cloud.pending': () => getCloudDatabase().pending(),
  'cloud.heads': () => getCloudDatabase().heads(),
  'cloud.metas': () => getCloudDatabase().metas(),
  'cloud.meta': (id: string) => getCloudDatabase().meta(id),
  'cloud.pullState': (datasetId: string) => getCloudDatabase().pullState(datasetId),
  'cloud.savePullState': (datasetId: string, cursor: string, lastPulledAt: string) => getCloudDatabase().savePullState(datasetId, cursor, lastPulledAt),
  'cloud.enqueue': (memo: Memo, kind: CloudOperationKind) => getCloudDatabase().enqueue(memo, kind),
  'cloud.prepare': (operationId: string, request: CloudRequest) => getCloudDatabase().prepare(operationId, request),
  'cloud.mark': (operationId: string, state: 'invalid' | 'conflict', error: string) => getCloudDatabase().mark(operationId, state, error),
  'cloud.ack': (operationId: string, receipt: MutationReceipt) => getCloudDatabase().ack(operationId, receipt),
  'cloud.applyRemote': (remote: RemoteMemo, filenames: string[], conflictOperation?: string) => getCloudDatabase().applyRemote(remote, filenames, conflictOperation),
  'cloud.attachment': (filename: string) => getCloudDatabase().attachment(filename),
  'cloud.remoteAttachment': (id: string) => getCloudDatabase().remoteAttachment(id),
  'cloud.saveAttachment': (filename: string, remoteId: string, sha256: string) => getCloudDatabase().saveAttachment(filename, remoteId, sha256),
  'cloud.isImageReferenced': (filename: string) => getCloudDatabase().isImageReferenced(filename),
  'cloud.backup': (destination: string) => getCloudDatabase().backup(destination)
}

function responseError(id: number, error: unknown): Response {
  const value = error instanceof Error ? error : new Error('Database operation failed')
  return { id, ok: false, error: { name: value.name, message: value.message } }
}

port.on('message', (request: Request) => {
  const operation = databaseMethods[request.method]
  if (!operation) {
    port.postMessage(responseError(request.id, new Error('Unknown database operation')))
    return
  }
  try {
    Promise.resolve(operation(...request.args as any[])).then(
      value => port.postMessage({ id: request.id, ok: true, value } satisfies Response),
      error => port.postMessage(responseError(request.id, error))
    )
  } catch (error) {
    port.postMessage(responseError(request.id, error))
  }
})
