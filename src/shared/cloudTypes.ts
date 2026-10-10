import type { Memo } from './types'

export interface RemoteMemo extends Omit<Memo, 'attachments'> {
  attachmentIds: string[]
  version: string
  purged: boolean
}
export interface RemoteAttachment {
  id: string
  mimeType: string
  size: number
  sha256: string
  createdAt: string
}
export interface CloudSnapshot {
  datasetId: string
  schemaVersion: number
  changeCursor: string
  complete: boolean
  totalRows: number
  memos: RemoteMemo[]
  attachments: RemoteAttachment[]
}
export interface CloudChange {
  sequence: string
  memo: RemoteMemo
}
export interface CloudChangesPage {
  datasetId: string
  schemaVersion: number
  cursor: string
  highWater: string
  hasMore: boolean
  changes: CloudChange[]
  attachments: RemoteAttachment[]
}
export interface CloudPullState {
  datasetId: string
  cursor: string
  lastPulledAt: string
}
export interface MutationReceipt {
  id: string
  appliedVersion: string
  createdAt: string
  updatedAt: string
  completedAt: string | null
  deleted: boolean
  purged: boolean
}
export interface CloudRequest {
  method: 'POST' | 'PATCH' | 'DELETE'
  path: string
  body?: Record<string, unknown>
}
export type CloudOperationKind = 'create' | 'update' | 'delete' | 'restore' | 'purge'
export interface CloudOperation {
  seq: number
  operationId: string
  memoId: string
  kind: CloudOperationKind
  payload: Memo
  baseVersion: string | null
  predecessor: string | null
  state: 'queued' | 'sending' | 'invalid' | 'conflict'
  request: CloudRequest | null
  error: string | null
}
export interface CloudStatus {
  isSyncing: boolean
  lastSync: string | null
  error: string | null
  configured: boolean
  connected: boolean
  pending: number
}
export interface CloudConfigView { url: string; hasToken: boolean; connected: boolean }
export interface CloudPreview { ticket: string; localCount: number; remoteCount: number; conflicts: number; missingImages: string[] }
