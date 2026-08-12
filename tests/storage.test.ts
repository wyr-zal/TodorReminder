import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'

import {
  migrateStorageData,
  resolveStorageInfo,
  validateStorageTarget,
  writeStoragePointer
} from '../src/main/storage.ts'

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'focus-memo-storage-'))
}

function createMemoDb(dbPath: string, attachments: string[] = []) {
  writeFileSync(dbPath, JSON.stringify({ attachments }), 'utf-8')
}

test('storage info uses default directory when pointer is missing', () => {
  const defaultDir = makeTempDir()

  try {
    assert.deepEqual(resolveStorageInfo(defaultDir), {
      currentDir: defaultDir,
      defaultDir,
      isCustom: false,
      isAvailable: true
    })
  } finally {
    rmSync(defaultDir, { recursive: true, force: true })
  }
})

test('storage info uses custom directory when pointer is valid', () => {
  const defaultDir = makeTempDir()
  const customDir = makeTempDir()

  try {
    writeStoragePointer(defaultDir, customDir)
    assert.deepEqual(resolveStorageInfo(defaultDir), {
      currentDir: customDir,
      defaultDir,
      configuredDir: customDir,
      isCustom: true,
      isAvailable: true
    })
  } finally {
    rmSync(defaultDir, { recursive: true, force: true })
    rmSync(customDir, { recursive: true, force: true })
  }
})

test('storage info falls back to default when pointer target is unavailable', () => {
  const defaultDir = makeTempDir()
  const customDir = join(defaultDir, 'missing-custom')

  try {
    writeStoragePointer(defaultDir, customDir)
    const info = resolveStorageInfo(defaultDir)

    assert.equal(info.currentDir, defaultDir)
    assert.equal(info.defaultDir, defaultDir)
    assert.equal(info.configuredDir, customDir)
    assert.equal(info.isCustom, false)
    assert.equal(info.isAvailable, false)
    assert.match(info.error || '', /回退默认目录/)
  } finally {
    rmSync(defaultDir, { recursive: true, force: true })
  }
})

test('migration copies database and attachments then writes pointer', () => {
  const defaultDir = makeTempDir()
  const sourceDir = makeTempDir()
  const targetDir = join(defaultDir, 'target-data')

  try {
    mkdirSync(join(sourceDir, 'attachments'))
    writeFileSync(join(sourceDir, 'attachments', 'a.png'), 'image-a')
    writeFileSync(join(sourceDir, 'settings.json'), '{"imageCompression":true}')
    createMemoDb(join(sourceDir, 'memos.db'), ['a.png'])

    const result = migrateStorageData(sourceDir, targetDir, defaultDir, {
      validateDatabase: (dbPath) => {
        assert.equal(existsSync(dbPath), true)
      },
      readAttachmentReferences: () => ['a.png']
    })

    assert.equal(result.success, true)
    assert.equal(existsSync(join(targetDir, 'memos.db')), true)
    assert.equal(readFileSync(join(targetDir, 'attachments', 'a.png'), 'utf-8'), 'image-a')
    assert.equal(resolveStorageInfo(defaultDir).currentDir, targetDir)
  } finally {
    rmSync(defaultDir, { recursive: true, force: true })
    rmSync(sourceDir, { recursive: true, force: true })
  }
})

test('migration rejects non-empty target and target inside current directory', () => {
  const defaultDir = makeTempDir()
  const sourceDir = makeTempDir()
  const nonEmptyTarget = makeTempDir()

  try {
    writeFileSync(join(nonEmptyTarget, 'existing.txt'), 'data')

    assert.match(
      validateStorageTarget(sourceDir, nonEmptyTarget) || '',
      /必须为空/
    )
    assert.match(
      validateStorageTarget(sourceDir, join(sourceDir, 'child-target')) || '',
      /不能放在当前数据目录里面/
    )
  } finally {
    rmSync(defaultDir, { recursive: true, force: true })
    rmSync(sourceDir, { recursive: true, force: true })
    rmSync(nonEmptyTarget, { recursive: true, force: true })
  }
})

test('failed migration does not rewrite pointer', () => {
  const defaultDir = makeTempDir()
  const sourceDir = makeTempDir()
  const originalCustomDir = makeTempDir()
  const nonEmptyTarget = makeTempDir()

  try {
    writeStoragePointer(defaultDir, originalCustomDir)
    writeFileSync(join(nonEmptyTarget, 'existing.txt'), 'data')

    const result = migrateStorageData(sourceDir, nonEmptyTarget, defaultDir)

    assert.equal(result.success, false)
    const pointer = JSON.parse(readFileSync(join(defaultDir, 'storage-location.json'), 'utf-8'))
    assert.equal(pointer.path, originalCustomDir)
  } finally {
    rmSync(defaultDir, { recursive: true, force: true })
    rmSync(sourceDir, { recursive: true, force: true })
    rmSync(originalCustomDir, { recursive: true, force: true })
    rmSync(nonEmptyTarget, { recursive: true, force: true })
  }
})
