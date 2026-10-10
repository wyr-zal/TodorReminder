import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { Memo } from '../shared/types'
import type { CloudOperation, CloudOperationKind, CloudRequest, MutationReceipt, RemoteMemo } from '../shared/cloudTypes'

type Meta = { memoId: string; version: string; purged: number }
type AttachmentMapping = { filename: string; operationId: string; remoteId: string | null; sha256: string | null }
export class CloudDatabaseCore {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cloud_binding (id INTEGER PRIMARY KEY CHECK(id=1), datasetId TEXT NOT NULL, url TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memo_sync_meta (memoId TEXT PRIMARY KEY, version TEXT NOT NULL, purged INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sync_outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, operationId TEXT NOT NULL UNIQUE, memoId TEXT NOT NULL,
        kind TEXT NOT NULL, payload TEXT NOT NULL, baseVersion TEXT, predecessor TEXT,
        state TEXT NOT NULL DEFAULT 'queued', request TEXT, error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_memo ON sync_outbox(memoId, seq);
      CREATE TABLE IF NOT EXISTS attachment_sync (filename TEXT PRIMARY KEY, operationId TEXT NOT NULL UNIQUE, remoteId TEXT UNIQUE, sha256 TEXT);
      CREATE TABLE IF NOT EXISTS cloud_pull_state (id INTEGER PRIMARY KEY CHECK(id=1), datasetId TEXT NOT NULL, cursor TEXT NOT NULL, lastPulledAt TEXT NOT NULL);
    `)
  }
  binding(): { datasetId: string; url: string } | null {
    return this.db.prepare('SELECT datasetId,url FROM cloud_binding WHERE id=1').get() as { datasetId: string; url: string } | undefined ?? null
  }
  bind(datasetId: string, url: string, memos: Memo[]): void {
    this.db.transaction(() => {
      const current = this.binding()
      if (current) {
        if (current.datasetId !== datasetId) throw new Error('服务器数据集已改变，不能自动覆盖本地数据')
        this.db.prepare('UPDATE cloud_binding SET url=? WHERE id=1').run(url)
        return
      }
      this.db.prepare('INSERT INTO cloud_binding VALUES(1,?,?)').run(datasetId, url)
      for (const memo of memos) {
        this.enqueue(memo, 'create')
        if (memo.deleted) this.enqueue(memo, 'delete')
      }
    })()
  }
  pending(): CloudOperation[] {
    return (this.db.prepare('SELECT * FROM sync_outbox ORDER BY seq').all() as any[]).map(row => ({ ...row, payload: JSON.parse(row.payload), request: row.request ? JSON.parse(row.request) : null }))
  }
  heads(): CloudOperation[] {
    const seen = new Set<string>()
    return this.pending().filter(op => { if (seen.has(op.memoId)) return false; seen.add(op.memoId); return true })
  }
  metas(): Meta[] { return this.db.prepare('SELECT * FROM memo_sync_meta').all() as Meta[] }
  meta(id: string): Meta | null { return this.db.prepare('SELECT * FROM memo_sync_meta WHERE memoId=?').get(id) as Meta | undefined ?? null }
  pullState(datasetId: string): { datasetId: string; cursor: string; lastPulledAt: string } | null {
    return this.db.prepare('SELECT datasetId,cursor,lastPulledAt FROM cloud_pull_state WHERE id=1 AND datasetId=?').get(datasetId) as { datasetId: string; cursor: string; lastPulledAt: string } | undefined ?? null
  }
  savePullState(datasetId: string, cursor: string, lastPulledAt: string): void {
    if (!/^(0|[1-9][0-9]{0,19})$/.test(cursor) || BigInt(cursor) > 18446744073709551615n || !Number.isFinite(Date.parse(lastPulledAt))) throw new Error('增量同步游标无效')
    this.db.transaction(() => {
      const binding = this.binding()
      if (!binding || binding.datasetId !== datasetId) throw new Error('服务器数据集已改变，不能推进同步游标')
      const current = this.pullState(datasetId)
      if (current && BigInt(cursor) < BigInt(current.cursor)) throw new Error('服务器变更游标倒退')
      this.db.prepare('INSERT INTO cloud_pull_state(id,datasetId,cursor,lastPulledAt) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET datasetId=excluded.datasetId,cursor=excluded.cursor,lastPulledAt=excluded.lastPulledAt').run(datasetId, cursor, lastPulledAt)
    })()
  }
  // Must run in the same SQLite transaction as the corresponding local memo mutation.
  enqueue(memo: Memo, kind: CloudOperationKind): void {
    if (!this.binding()) return
    const requestedKind = kind
    let branch = this.pending().filter(op => op.memoId === memo.id)
    const meta = this.meta(memo.id)
    const rejectedCreate = branch[0]?.kind === 'create' && branch[0].state === 'invalid' && branch.slice(1).every(op => op.state === 'queued' && !op.request)
    if (kind === 'purge' && !meta && branch.length && (rejectedCreate || branch.every(op => op.state === 'queued' && !op.request))) {
      this.db.prepare('DELETE FROM sync_outbox WHERE memoId=?').run(memo.id)
      return
    }
    let baseVersion = meta?.version ?? null
    let needsDeleteBeforePurge = kind === 'purge' && !memo.deleted
    if (branch[0]?.state === 'invalid') {
      if (meta && kind === 'purge' && branch.some(op => op.kind === 'delete')) needsDeleteBeforePurge = true
      baseVersion = branch[0].baseVersion
      this.db.prepare('DELETE FROM sync_outbox WHERE memoId=?').run(memo.id)
      branch = []
      if (!meta) kind = 'create'
    }
    if (needsDeleteBeforePurge) this.enqueue({ ...memo, deleted: true }, 'delete')
    branch = this.pending().filter(op => op.memoId === memo.id)
    const predecessor = branch[branch.length - 1]?.operationId ?? null
    if (!meta && !predecessor && kind !== 'create') kind = 'create'
    this.db.prepare('INSERT INTO sync_outbox(operationId,memoId,kind,payload,baseVersion,predecessor) VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), memo.id, kind, JSON.stringify(memo), predecessor ? null : baseVersion, predecessor)
    if (!meta && kind === 'create' && requestedKind !== 'create' && memo.deleted) this.enqueue(memo, 'delete')
  }
  prepare(operationId: string, request: CloudRequest): boolean {
    return this.db.prepare("UPDATE sync_outbox SET request=?,state='sending' WHERE operationId=? AND request IS NULL AND state='queued'").run(JSON.stringify(request), operationId).changes === 1
  }
  mark(operationId: string, state: 'invalid' | 'conflict', error: string): void {
    this.db.prepare('UPDATE sync_outbox SET state=?,error=? WHERE operationId=?').run(state, error, operationId)
  }
  ack(operationId: string, receipt: MutationReceipt): void {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM sync_outbox WHERE operationId=?').get(operationId) as any
      if (!row) return
      if (row.memoId !== receipt.id) throw new Error('同步回执与请求不匹配')
      const meta = this.meta(receipt.id)
      if (meta && BigInt(receipt.appliedVersion) < BigInt(meta.version)) throw new Error('服务器版本倒退')
      this.db.prepare('INSERT OR REPLACE INTO memo_sync_meta(memoId,version,purged) VALUES(?,?,?)').run(receipt.id, receipt.appliedVersion, Number(receipt.purged))
      this.db.prepare('UPDATE sync_outbox SET baseVersion=?,predecessor=NULL WHERE predecessor=?').run(receipt.appliedVersion, operationId)
      this.db.prepare('DELETE FROM sync_outbox WHERE operationId=?').run(operationId)
    })()
  }
  applyRemote(remote: RemoteMemo, filenames: string[], conflictOperation?: string): boolean {
    return this.db.transaction(() => {
      const branch = this.pending().filter(op => op.memoId === remote.id)
      if (conflictOperation) {
        if (branch[0]?.operationId !== conflictOperation || branch[0].state !== 'conflict') return false
      } else if (branch.length) return false
      const meta = this.meta(remote.id)
      if (meta && BigInt(remote.version) < BigInt(meta.version)) throw new Error('服务器版本倒退，已停止同步')
      if (conflictOperation) this.db.prepare('DELETE FROM sync_outbox WHERE memoId=?').run(remote.id)
      this.db.prepare('INSERT OR REPLACE INTO memo_sync_meta(memoId,version,purged) VALUES(?,?,?)').run(remote.id, remote.version, Number(remote.purged))
      if (remote.purged) this.db.prepare('DELETE FROM memos WHERE id=?').run(remote.id)
      else this.db.prepare(`INSERT OR REPLACE INTO memos(id,content,type,priority,status,attachments,tags,createdAt,updatedAt,completedAt,deviceId,deleted) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(remote.id, remote.content, remote.type, remote.priority, remote.status, JSON.stringify(filenames), JSON.stringify(remote.tags), remote.createdAt, remote.updatedAt, remote.completedAt, remote.deviceId, Number(remote.deleted))
      return true
    })()
  }
  attachment(filename: string): AttachmentMapping {
    this.db.prepare('INSERT OR IGNORE INTO attachment_sync(filename,operationId) VALUES(?,?)').run(filename, randomUUID())
    return this.db.prepare('SELECT * FROM attachment_sync WHERE filename=?').get(filename) as AttachmentMapping
  }
  remoteAttachment(id: string): AttachmentMapping | null {
    return this.db.prepare('SELECT * FROM attachment_sync WHERE remoteId=?').get(id) as AttachmentMapping | undefined ?? null
  }
  saveAttachment(filename: string, remoteId: string, sha256: string): void {
    this.attachment(filename)
    this.db.prepare('UPDATE attachment_sync SET remoteId=?,sha256=? WHERE filename=?').run(remoteId, sha256, filename)
  }
  isImageReferenced(filename: string): boolean {
    const rows = this.db.prepare('SELECT attachments FROM memos').all() as { attachments: string }[]
    return rows.some(row => (JSON.parse(row.attachments) as string[]).includes(filename)) || this.pending().some(op => op.payload.attachments.includes(filename))
  }
  async backup(destination: string): Promise<void> { await this.db.backup(destination) }
}
