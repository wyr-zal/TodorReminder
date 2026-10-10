import type { Memo } from '../shared/types'
import type { CloudOperation, CloudOperationKind, CloudPullState, CloudRequest, MutationReceipt, RemoteMemo } from '../shared/cloudTypes'

export type CloudBinding = { datasetId: string; url: string }
export type CloudMeta = { memoId: string; version: string; purged: number }
export type AttachmentMapping = { filename: string; operationId: string; remoteId: string | null; sha256: string | null }

export interface CloudDatabase {
  binding(): Promise<CloudBinding | null>
  bind(datasetId: string, url: string, memos: Memo[]): Promise<void>
  pending(): Promise<CloudOperation[]>
  heads(): Promise<CloudOperation[]>
  metas(): Promise<CloudMeta[]>
  meta(id: string): Promise<CloudMeta | null>
  enqueue(memo: Memo, kind: CloudOperationKind): Promise<void>
  prepare(operationId: string, request: CloudRequest): Promise<boolean>
  mark(operationId: string, state: 'invalid' | 'conflict', error: string): Promise<void>
  ack(operationId: string, receipt: MutationReceipt): Promise<void>
  applyRemote(remote: RemoteMemo, filenames: string[], conflictOperation?: string): Promise<boolean>
  attachment(filename: string): Promise<AttachmentMapping>
  remoteAttachment(id: string): Promise<AttachmentMapping | null>
  saveAttachment(filename: string, remoteId: string, sha256: string): Promise<void>
  isImageReferenced(filename: string): Promise<boolean>
  pullState(datasetId: string): Promise<CloudPullState | null>
  savePullState(datasetId: string, cursor: string, lastPulledAt: string): Promise<void>
  backup(destination: string): Promise<void>
}
