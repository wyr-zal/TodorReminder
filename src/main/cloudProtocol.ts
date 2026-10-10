import type { CloudChange, CloudChangesPage, CloudOperation, CloudRequest, CloudSnapshot, MutationReceipt, RemoteMemo, RemoteAttachment } from '../shared/cloudTypes'

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')
const timestamp = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v))
const maxUnsigned = 18446744073709551615n

export function validVersion(v: unknown): v is string {
  return typeof v === 'string' && /^[1-9][0-9]{0,19}$/.test(v) && BigInt(v) <= maxUnsigned
}

export function validChangeCursor(v: unknown): v is string {
  return typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= maxUnsigned
}

export function validateServerURL(value: string): string {
  const url = new URL(value.trim())
  if (url.username || url.password || url.search || url.hash) throw new Error('服务器地址不能包含账号、查询参数或片段')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('服务器必须使用HTTPS；本机测试可使用回环HTTP')
  return url.href.replace(/\/+$/, '')
}

export function validateMemo(v: unknown): RemoteMemo {
  if (!record(v) || !uuidPattern.test(v.id) || !validVersion(v.version) || typeof v.content !== 'string' || !['text', 'image'].includes(v.type) || !['important', 'unimportant'].includes(v.priority) || !['not_started', 'in_progress', 'completed'].includes(v.status) || !strings(v.tags) || !strings(v.attachmentIds) || !v.attachmentIds.every(x => uuidPattern.test(x)) || !timestamp(v.createdAt) || !timestamp(v.updatedAt) || !(v.completedAt === null || timestamp(v.completedAt)) || typeof v.deviceId !== 'string' || typeof v.deleted !== 'boolean' || typeof v.purged !== 'boolean') throw new Error('服务器待办格式不完整，已停止同步')
  if (v.purged && (!v.deleted || v.content !== '' || v.tags.length || v.attachmentIds.length)) throw new Error('服务器永久删除墓碑无效')
  if (!v.purged && !v.content.trim() && v.attachmentIds.length === 0) throw new Error('服务器返回了空待办')
  if ((v.status === 'completed') !== (v.completedAt !== null)) throw new Error('服务器完成时间与状态不一致')
  return v as RemoteMemo
}

function validateAttachments(raw: unknown): RemoteAttachment[] {
  if (!Array.isArray(raw) || raw.length > 50000) throw new Error('服务器附件元数据无效')
  const ids = new Set<string>()
  for (const attachment of raw) {
    if (!record(attachment) || !uuidPattern.test(attachment.id) || ids.has(attachment.id) || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(attachment.mimeType) || !Number.isSafeInteger(attachment.size) || attachment.size <= 0 || attachment.size > 20 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(attachment.sha256) || !timestamp(attachment.createdAt)) throw new Error('服务器附件元数据无效')
    ids.add(attachment.id)
  }
  return raw as RemoteAttachment[]
}

export function validateSnapshot(raw: unknown): CloudSnapshot {
  if (!record(raw) || !uuidPattern.test(raw.datasetId) || raw.schemaVersion !== 1 || raw.complete !== true || !Array.isArray(raw.memos) || raw.memos.length > 10000 || raw.totalRows !== raw.memos.length) throw new Error('服务器快照不完整或版本不兼容')
  if (!validChangeCursor(raw.changeCursor)) throw new Error('服务器尚未升级到增量同步接口，本地待办和队列已保留')
  const attachments = validateAttachments(raw.attachments)
  const ids = new Set(attachments.map(a => a.id))
  const memoIds = new Set<string>()
  for (const value of raw.memos) {
    const memo = validateMemo(value)
    if (memoIds.has(memo.id) || memo.attachmentIds.some(id => !ids.has(id))) throw new Error('服务器快照包含重复待办或缺失附件')
    memoIds.add(memo.id)
  }
  return raw as CloudSnapshot
}

export function validateChangesPage(raw: unknown, datasetId: string, after: string, through?: string): CloudChangesPage {
  if (!record(raw) || raw.datasetId !== datasetId || raw.schemaVersion !== 1 || !validChangeCursor(raw.cursor) || !validChangeCursor(raw.highWater) || typeof raw.hasMore !== 'boolean' || !Array.isArray(raw.changes) || raw.changes.length > 10) throw new Error('服务器增量变更页格式无效')
  if (!validChangeCursor(after) || (through !== undefined && !validChangeCursor(through))) throw new Error('本地增量同步游标无效')
  const afterValue = BigInt(after)
  const highWaterValue = BigInt(raw.highWater)
  const nextValue = BigInt(raw.cursor)
  if (highWaterValue < afterValue || nextValue < afterValue || nextValue > highWaterValue || (through !== undefined && raw.highWater !== through)) throw new Error('服务器增量同步游标倒退或越界')

  const changes = raw.changes as unknown[]
  const memoIds = new Set<string>()
  let previousSequence = afterValue
  for (const item of changes) {
    if (!record(item) || !validChangeCursor(item.sequence)) throw new Error('服务器变更序号无效')
    const sequence = BigInt(item.sequence)
    const memo = validateMemo(item.memo)
    if (sequence <= previousSequence || sequence > highWaterValue || memoIds.has(memo.id)) throw new Error('服务器变更页顺序或记录无效')
    previousSequence = sequence
    memoIds.add(memo.id)
  }
  const attachments = validateAttachments(raw.attachments)
  const attachmentIds = new Set(attachments.map(attachment => attachment.id))
  for (const item of changes as CloudChange[]) {
    if (item.memo.attachmentIds.some(id => !attachmentIds.has(id))) throw new Error('服务器变更页缺少附件描述')
  }
  if (raw.hasMore) {
    if (!changes.length || raw.cursor !== (changes[changes.length - 1] as { sequence: string }).sequence || nextValue >= highWaterValue) throw new Error('服务器分页游标无效')
  } else if (raw.cursor !== raw.highWater) {
    throw new Error('服务器完整页未推进到高水位')
  }
  return raw as CloudChangesPage
}

export function assertSnapshotProgress(snapshot: CloudSnapshot, datasetId: string, metas: { memoId: string; version: string; purged: number }[]): void {
  if (snapshot.datasetId !== datasetId) throw new Error('服务器数据集已改变，已停止同步')
  const rows = new Map(snapshot.memos.map(m => [m.id, m]))
  for (const meta of metas) {
    const row = rows.get(meta.memoId)
    if (!row || BigInt(row.version) < BigInt(meta.version) || (meta.purged && !row.purged)) throw new Error('服务器记录缺失或版本倒退，已停止同步')
  }
}

export function validateReceipt(raw: unknown, id: string): MutationReceipt {
  if (!record(raw) || raw.id !== id || !validVersion(raw.appliedVersion) || !timestamp(raw.createdAt) || !timestamp(raw.updatedAt) || !(raw.completedAt === null || timestamp(raw.completedAt)) || typeof raw.deleted !== 'boolean' || typeof raw.purged !== 'boolean') throw new Error('服务器回执不完整，保留原操作重试')
  if (raw.purged && (!raw.deleted || raw.completedAt !== null)) throw new Error('服务器永久删除回执无效')
  return raw as MutationReceipt
}

export function makeRequest(op: CloudOperation, attachmentIds: string[]): CloudRequest {
  const memo = op.payload
  const fields = { content: memo.content, type: memo.type, priority: memo.priority, status: memo.status, tags: memo.tags, attachmentIds }
  if (op.kind === 'create') return { method: 'POST', path: '/api/v1/memos', body: { id: op.memoId, ...fields, createdAt: memo.createdAt, updatedAt: memo.updatedAt, completedAt: memo.completedAt, deviceId: memo.deviceId } }
  if (!validVersion(op.baseVersion)) throw new Error('待同步操作缺少已确认的服务器版本')
  const path = '/api/v1/memos/' + op.memoId
  if (op.kind === 'delete' || op.kind === 'purge') return { method: 'DELETE', path: path + '?baseVersion=' + op.baseVersion + (op.kind === 'purge' ? '&permanent=true' : '') }
  return { method: 'PATCH', path, body: { ...fields, baseVersion: op.baseVersion, ...(op.kind === 'restore' ? { deleted: false } : {}) } }
}
