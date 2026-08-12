import Database from 'better-sqlite3'
import * as fs from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import type { StorageInfo, StorageMigrationResult } from '../shared/types'

export const STORAGE_LOCATION_FILE = 'storage-location.json'

const STORAGE_POINTER_VERSION = 1
const STORAGE_DATA_ENTRIES = [
  'memos.db',
  'memos.db-shm',
  'memos.db-wal',
  'attachments',
  'settings.json',
  'window-state.json',
  'sync-config.json',
  'sync-repo'
]

interface StorageLocationPointer {
  version: 1
  path: string
  updatedAt: string
}

interface StorageValidationHooks {
  validateDatabase?: (dbPath: string) => void
  readAttachmentReferences?: (dbPath: string) => string[]
}

function comparePath(pathname: string): string {
  const resolved = resolve(pathname)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isSamePath(left: string, right: string): boolean {
  return comparePath(left) === comparePath(right)
}

function isInsidePath(candidate: string, parent: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate))
  return Boolean(relativePath)
    && !relativePath.startsWith('..')
    && !isAbsolute(relativePath)
}

function ensureDirectory(pathname: string): void {
  if (!fs.existsSync(pathname)) {
    fs.mkdirSync(pathname, { recursive: true })
  }
}

function isDirectoryWritable(pathname: string): boolean {
  try {
    if (!fs.existsSync(pathname) || !fs.statSync(pathname).isDirectory()) {
      return false
    }
    fs.accessSync(pathname, fs.constants.R_OK | fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

function pointerPath(defaultDir: string): string {
  return join(defaultDir, STORAGE_LOCATION_FILE)
}

function readStoragePointer(defaultDir: string): { path: string | null; error?: string } {
  try {
    const filepath = pointerPath(defaultDir)
    if (!fs.existsSync(filepath)) {
      return { path: null }
    }

    const parsed = JSON.parse(fs.readFileSync(filepath, 'utf-8')) as Partial<StorageLocationPointer>
    if (
      parsed.version !== STORAGE_POINTER_VERSION
      || typeof parsed.path !== 'string'
      || parsed.path.trim().length === 0
    ) {
      return { path: null, error: '数据位置配置文件格式无效' }
    }

    return { path: resolve(parsed.path) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { path: null, error: `读取数据位置配置失败：${message}` }
  }
}

export function writeStoragePointer(defaultDir: string, targetDir: string): void {
  ensureDirectory(defaultDir)
  const payload: StorageLocationPointer = {
    version: STORAGE_POINTER_VERSION,
    path: resolve(targetDir),
    updatedAt: new Date().toISOString()
  }
  fs.writeFileSync(pointerPath(defaultDir), JSON.stringify(payload, null, 2), 'utf-8')
}

export function resolveStorageInfo(defaultDir: string): StorageInfo {
  ensureDirectory(defaultDir)
  const resolvedDefaultDir = resolve(defaultDir)
  const pointer = readStoragePointer(resolvedDefaultDir)

  if (!pointer.path) {
    return {
      currentDir: resolvedDefaultDir,
      defaultDir: resolvedDefaultDir,
      isCustom: false,
      isAvailable: isDirectoryWritable(resolvedDefaultDir),
      ...(pointer.error ? { error: pointer.error } : {})
    }
  }

  const customDir = resolve(pointer.path)
  if (!isDirectoryWritable(customDir)) {
    return {
      currentDir: resolvedDefaultDir,
      defaultDir: resolvedDefaultDir,
      configuredDir: customDir,
      isCustom: false,
      isAvailable: false,
      error: `自定义数据目录不可用，已回退默认目录：${customDir}`
    }
  }

  return {
    currentDir: customDir,
    defaultDir: resolvedDefaultDir,
    configuredDir: customDir,
    isCustom: !isSamePath(customDir, resolvedDefaultDir),
    isAvailable: true
  }
}

export function validateStorageTarget(currentDir: string, targetDir: string): string | null {
  const trimmedTarget = targetDir.trim()
  if (!trimmedTarget) {
    return '请选择新的数据目录'
  }

  const sourceDir = resolve(currentDir)
  const destinationDir = resolve(trimmedTarget)

  if (isSamePath(sourceDir, destinationDir)) {
    return '目标目录不能和当前数据目录相同'
  }

  if (isInsidePath(destinationDir, sourceDir)) {
    return '目标目录不能放在当前数据目录里面'
  }

  if (fs.existsSync(destinationDir)) {
    if (!fs.statSync(destinationDir).isDirectory()) {
      return '目标路径不是文件夹'
    }

    if (fs.readdirSync(destinationDir).length > 0) {
      return '目标目录必须为空'
    }

    if (!isDirectoryWritable(destinationDir)) {
      return '目标目录不可读写'
    }

    return null
  }

  const parent = dirname(destinationDir)
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    return '目标目录的上级目录不存在'
  }

  if (!isDirectoryWritable(parent)) {
    return '目标目录的上级目录不可写'
  }

  return null
}

function copyStorageEntries(sourceDir: string, targetDir: string): void {
  STORAGE_DATA_ENTRIES.forEach((entryName) => {
    const sourcePath = join(sourceDir, entryName)
    if (!fs.existsSync(sourcePath)) {
      return
    }

    fs.cpSync(sourcePath, join(targetDir, entryName), {
      recursive: true,
      force: false,
      errorOnExist: true
    })
  })
}

function listFilesRecursive(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) {
    return []
  }

  const result: string[] = []
  const walk = (dir: string) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const fullPath = join(dir, entry.name)
      const relativePath = relative(rootDir, fullPath)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile()) {
        result.push(relativePath)
      }
    })
  }

  walk(rootDir)
  return result.sort()
}

function readAttachmentReferences(dbPath: string): string[] {
  if (!fs.existsSync(dbPath)) {
    return []
  }

  const db = new Database(dbPath, { readonly: true })
  try {
    const rows = db.prepare('SELECT attachments FROM memos').all() as Array<{ attachments: string }>
    return rows.flatMap((row) => {
      try {
        const parsed = JSON.parse(row.attachments)
        return Array.isArray(parsed)
          ? parsed.filter((item): item is string => typeof item === 'string')
          : []
      } catch {
        return []
      }
    })
  } finally {
    db.close()
  }
}

function validateDatabase(dbPath: string): void {
  if (!fs.existsSync(dbPath)) {
    return
  }

  const db = new Database(dbPath, { readonly: true })
  try {
    const result = db.pragma('quick_check') as Array<{ quick_check?: string }>
    const status = result[0]?.quick_check
    if (status && status !== 'ok') {
      throw new Error(`数据库校验失败：${status}`)
    }
  } finally {
    db.close()
  }
}

function validateCopiedStorage(
  sourceDir: string,
  targetDir: string,
  hooks: StorageValidationHooks = {}
): string[] {
  const warnings: string[] = []
  const sourceDbPath = join(sourceDir, 'memos.db')
  const targetDbPath = join(targetDir, 'memos.db')

  if (fs.existsSync(sourceDbPath) && !fs.existsSync(targetDbPath)) {
    throw new Error('数据库文件未复制成功')
  }

  const validateDatabaseFile = hooks.validateDatabase || validateDatabase
  const getAttachmentReferences = hooks.readAttachmentReferences || readAttachmentReferences
  validateDatabaseFile(targetDbPath)

  const sourceAttachmentFiles = listFilesRecursive(join(sourceDir, 'attachments'))
  const targetAttachmentFiles = listFilesRecursive(join(targetDir, 'attachments'))
  if (sourceAttachmentFiles.join('\n') !== targetAttachmentFiles.join('\n')) {
    throw new Error('附件文件复制不完整')
  }

  const sourceAttachmentDir = join(sourceDir, 'attachments')
  const targetAttachmentDir = join(targetDir, 'attachments')
  getAttachmentReferences(sourceDbPath).forEach((filename) => {
    if (basename(filename) !== filename) {
      warnings.push(`附件文件名无效，已跳过校验：${filename}`)
      return
    }

    const sourceFile = join(sourceAttachmentDir, filename)
    const targetFile = join(targetAttachmentDir, filename)
    if (!fs.existsSync(sourceFile)) {
      warnings.push(`原目录缺少附件：${filename}`)
    } else if (!fs.existsSync(targetFile)) {
      throw new Error(`附件未复制成功：${filename}`)
    }
  })

  return warnings
}

export function migrateStorageData(
  sourceDir: string,
  targetDir: string,
  defaultDir: string,
  hooks: StorageValidationHooks = {}
): StorageMigrationResult {
  const warnings: string[] = []

  try {
    const sourcePath = resolve(sourceDir)
    const targetPath = resolve(targetDir)
    const defaultPath = resolve(defaultDir)

    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
      return { success: false, error: '当前数据目录不存在', warnings }
    }

    const targetError = validateStorageTarget(sourcePath, targetPath)
    if (targetError) {
      return { success: false, error: targetError, targetDir: targetPath, warnings }
    }

    ensureDirectory(targetPath)
    copyStorageEntries(sourcePath, targetPath)
    warnings.push(...validateCopiedStorage(sourcePath, targetPath, hooks))
    writeStoragePointer(defaultPath, targetPath)

    return {
      success: true,
      targetDir: targetPath,
      warnings
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, error: message, targetDir: resolve(targetDir), warnings }
  }
}
