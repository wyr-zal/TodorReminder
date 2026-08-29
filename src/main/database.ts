import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { Memo } from '../shared/types'

let db: Database.Database | null = null

export function initDatabase(): void {
  const dbPath = join(app.getPath('userData'), 'memos.db')
  db = new Database(dbPath)

  // 创建表
  db.exec(`
    CREATE TABLE IF NOT EXISTS memos (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      type TEXT DEFAULT 'text',
      priority TEXT DEFAULT 'medium',
      status TEXT DEFAULT 'pending',
      attachments TEXT DEFAULT '[]',
      tags TEXT DEFAULT '[]',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      completedAt TEXT,
      deviceId TEXT,
      deleted INTEGER DEFAULT 0
    )
  `)

  // 迁移：添加 tags 列（如果不存在）
  try {
    db.exec(`ALTER TABLE memos ADD COLUMN tags TEXT DEFAULT '[]'`)
  } catch (e) {
    // 列已存在，忽略错误
  }

  // 迁移：添加 completedAt 列，并用最后更新时间近似回填历史完成记录
  try {
    db.exec(`ALTER TABLE memos ADD COLUMN completedAt TEXT`)
  } catch (e) {
    // 列已存在，忽略错误
  }
  db.exec(`
    UPDATE memos
    SET completedAt = updatedAt
    WHERE status = 'completed' AND completedAt IS NULL
  `)

  // 创建索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memos_status ON memos(status);
    CREATE INDEX IF NOT EXISTS idx_memos_priority ON memos(priority);
    CREATE INDEX IF NOT EXISTS idx_memos_deleted ON memos(deleted);
  `)
}

export function getAllMemos(): Memo[] {
  if (!db) return []

  const rows = db.prepare(`
    SELECT * FROM memos
    WHERE deleted = 0
    ORDER BY
      CASE priority
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 3
      END,
      createdAt DESC
  `).all() as any[]

  return rows.map(row => ({
    ...row,
    attachments: JSON.parse(row.attachments),
    tags: JSON.parse(row.tags || '[]'),
    deleted: Boolean(row.deleted)
  }))
}

export function getMemoById(id: string): Memo | null {
  if (!db) return null

  const row = db.prepare('SELECT * FROM memos WHERE id = ?').get(id) as any
  if (!row) return null

  return {
    ...row,
    attachments: JSON.parse(row.attachments),
    tags: JSON.parse(row.tags || '[]'),
    deleted: Boolean(row.deleted)
  }
}

export function createMemo(memo: Memo): Memo {
  if (!db) throw new Error('Database not initialized')

  const stmt = db.prepare(`
    INSERT INTO memos (id, content, type, priority, status, attachments, tags, createdAt, updatedAt, completedAt, deviceId, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  stmt.run(
    memo.id,
    memo.content,
    memo.type,
    memo.priority,
    memo.status,
    JSON.stringify(memo.attachments),
    JSON.stringify(memo.tags || []),
    memo.createdAt,
    memo.updatedAt,
    memo.completedAt,
    memo.deviceId,
    memo.deleted ? 1 : 0
  )

  return memo
}

export function updateMemo(id: string, updates: Partial<Memo>): Memo | null {
  if (!db) return null

  const existing = getMemoById(id)
  if (!existing) return null

  const updated: Memo = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString()
  }

  const stmt = db.prepare(`
    UPDATE memos
    SET content = ?, type = ?, priority = ?, status = ?, attachments = ?, tags = ?, updatedAt = ?, completedAt = ?, deleted = ?
    WHERE id = ?
  `)

  stmt.run(
    updated.content,
    updated.type,
    updated.priority,
    updated.status,
    JSON.stringify(updated.attachments),
    JSON.stringify(updated.tags || []),
    updated.updatedAt,
    updated.completedAt,
    updated.deleted ? 1 : 0,
    id
  )

  return updated
}

export function deleteMemo(id: string): boolean {
  if (!db) return false

  // 软删除
  const stmt = db.prepare(`
    UPDATE memos SET deleted = 1, updatedAt = ? WHERE id = ?
  `)

  const result = stmt.run(new Date().toISOString(), id)
  return result.changes > 0
}

export function getDeletedMemos(): Memo[] {
  if (!db) return []

  const rows = db.prepare(`
    SELECT * FROM memos
    WHERE deleted = 1
    ORDER BY updatedAt DESC
  `).all() as any[]

  return rows.map(row => ({
    ...row,
    attachments: JSON.parse(row.attachments),
    tags: JSON.parse(row.tags || '[]'),
    deleted: Boolean(row.deleted)
  }))
}

export function restoreMemo(id: string): boolean {
  if (!db) return false

  const stmt = db.prepare(`
    UPDATE memos SET deleted = 0, updatedAt = ? WHERE id = ?
  `)

  const result = stmt.run(new Date().toISOString(), id)
  return result.changes > 0
}

export function hardDeleteMemo(id: string): boolean {
  if (!db) return false

  const stmt = db.prepare('DELETE FROM memos WHERE id = ?')
  const result = stmt.run(id)
  return result.changes > 0
}

// 导出为 JSON (用于 Git 同步)
export function exportToJSON(): { version: string; lastSync: string; memos: Memo[] } {
  const memos = getAllMemos()
  return {
    version: '1.0',
    lastSync: new Date().toISOString(),
    memos
  }
}

// 从 JSON 导入 (用于 Git 同步)
export function importFromJSON(data: { memos: Memo[] }): void {
  if (!db) return

  const insertOrUpdate = db.prepare(`
    INSERT OR REPLACE INTO memos (id, content, type, priority, status, attachments, tags, createdAt, updatedAt, completedAt, deviceId, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const transaction = db.transaction((memos: Memo[]) => {
    for (const memo of memos) {
      const completedAt = memo.status === 'completed'
        ? memo.completedAt ?? memo.updatedAt
        : null

      insertOrUpdate.run(
        memo.id,
        memo.content,
        memo.type,
        memo.priority,
        memo.status,
        JSON.stringify(memo.attachments),
        JSON.stringify(memo.tags || []),
        memo.createdAt,
        memo.updatedAt,
        completedAt,
        memo.deviceId,
        memo.deleted ? 1 : 0
      )
    }
  })

  transaction(data.memos)
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
