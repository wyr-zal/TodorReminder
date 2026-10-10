import { app } from 'electron'
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Memo } from '../shared/types'
import type { CloudOperation, CloudPullState, CloudRequest, MutationReceipt, RemoteMemo } from '../shared/cloudTypes'
import type { CloudDatabase, CloudBinding, CloudMeta, AttachmentMapping } from './cloudDatabase'

type WorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { name: string; message: string } }

type PendingRequest = { resolve(value: unknown): void; reject(error: Error): void }

class DatabaseWorkerChannel {
  private sequence = 0
  private closing = false
  private failure: Error | null = null
  private pending = new Map<number, PendingRequest>()

  constructor(private worker: Worker) {
    worker.on('message', (response: WorkerResponse) => {
      const request = this.pending.get(response.id)
      if (!request) return
      this.pending.delete(response.id)
      if (response.ok) {
        request.resolve(response.value)
        return
      }
      const error = new Error(response.error.message)
      error.name = response.error.name
      request.reject(error)
    })
    worker.on('error', error => this.fail(error))
    worker.on('exit', code => {
      if (!this.closing && code !== 0) this.fail(new Error(`Database worker exited with code ${code}`))
      if (!this.closing && code === 0) this.fail(new Error('Database worker exited unexpectedly'))
    })
  }

  request<T>(method: string, args: unknown[] = []): Promise<T> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.closing) return Promise.reject(new Error('Database worker is closing'))
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject })
      try {
        this.worker.postMessage({ id, method, args })
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error('Database worker request failed'))
      }
    })
  }

  async terminate(): Promise<void> {
    this.closing = true
    this.fail(new Error('Database worker closed'))
    await this.worker.terminate()
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }
}

let dbWorker: DatabaseWorkerChannel | null = null

function workerPath(): string {
  let path = fileURLToPath(new URL('./databaseWorker.mjs', import.meta.url))
  if (app.isPackaged) path = path.replace('app.asar', 'app.asar.unpacked')
  return path
}

function request<T>(method: string, args: unknown[] = []): Promise<T> {
  if (!dbWorker) return Promise.reject(new Error('Database not initialized'))
  return dbWorker.request<T>(method, args)
}

export async function initDatabase(): Promise<void> {
  if (dbWorker) return
  const worker = new DatabaseWorkerChannel(new Worker(workerPath()))
  dbWorker = worker
  try {
    await worker.request<void>('database.init', [join(app.getPath('userData'), 'memos.db')])
  } catch (error) {
    if (dbWorker === worker) dbWorker = null
    await worker.terminate()
    throw error
  }
}

export async function closeDatabase(): Promise<void> {
  const worker = dbWorker
  if (!worker) return
  dbWorker = null
  try {
    await worker.request<void>('database.close')
  } finally {
    await worker.terminate()
  }
}

export async function inspectDatabaseFile(dbPath: string): Promise<string[]> {
  const worker = new DatabaseWorkerChannel(new Worker(workerPath()))
  try {
    return await worker.request<string[]>('database.inspectFile', [dbPath])
  } finally {
    await worker.terminate()
  }
}

export const getCloudDatabase = (): CloudDatabase => cloudDatabase

const cloudDatabase: CloudDatabase = {
  binding: () => request<CloudBinding | null>('cloud.binding'),
  bind: (datasetId, url, memos) => request<void>('cloud.bind', [datasetId, url, memos]),
  pending: () => request<CloudOperation[]>('cloud.pending'),
  heads: () => request<CloudOperation[]>('cloud.heads'),
  metas: () => request<CloudMeta[]>('cloud.metas'),
  meta: id => request<CloudMeta | null>('cloud.meta', [id]),
  pullState: datasetId => request<CloudPullState | null>('cloud.pullState', [datasetId]),
  savePullState: (datasetId, cursor, lastPulledAt) => request<void>('cloud.savePullState', [datasetId, cursor, lastPulledAt]),
  enqueue: (memo, kind) => request<void>('cloud.enqueue', [memo, kind]),
  prepare: (operationId, value) => request<boolean>('cloud.prepare', [operationId, value]),
  mark: (operationId, state, error) => request<void>('cloud.mark', [operationId, state, error]),
  ack: (operationId, receipt) => request<void>('cloud.ack', [operationId, receipt]),
  applyRemote: (remote, filenames, conflictOperation) => request<boolean>('cloud.applyRemote', [remote, filenames, conflictOperation]),
  attachment: filename => request<AttachmentMapping>('cloud.attachment', [filename]),
  remoteAttachment: id => request<AttachmentMapping | null>('cloud.remoteAttachment', [id]),
  saveAttachment: (filename, remoteId, sha256) => request<void>('cloud.saveAttachment', [filename, remoteId, sha256]),
  isImageReferenced: filename => request<boolean>('cloud.isImageReferenced', [filename]),
  backup: destination => request<void>('cloud.backup', [destination])
}

export const getAllMemos = (): Promise<Memo[]> => request('memo.getAll')
export const getMemoById = (id: string): Promise<Memo | null> => request('memo.getById', [id])
export const createMemo = (memo: Memo): Promise<Memo> => request('memo.create', [memo])
export const updateMemo = (id: string, updates: Partial<Memo>, expected?: Memo): Promise<Memo | null> => request('memo.update', [id, updates, expected])
export const deleteMemo = (id: string): Promise<boolean> => request('memo.delete', [id])
export const getDeletedMemos = (): Promise<Memo[]> => request('memo.getDeleted')
export const restoreMemo = (id: string): Promise<boolean> => request('memo.restore', [id])
export const hardDeleteMemo = (id: string): Promise<boolean> => request('memo.hardDelete', [id])
export const exportToJSON = (): Promise<{ version: string; lastSync: string; memos: Memo[] }> => request('memo.export')
export const importFromJSON = (data: { memos: Memo[] }): Promise<void> => request('memo.import', [data])
