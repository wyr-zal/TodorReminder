import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { getMissingPackagedRuntimeFiles } from '../src/main/login-startup.ts'

test('getMissingPackagedRuntimeFiles reports absent runtime files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'focus-memo-login-startup-'))

  try {
    mkdirSync(join(dir, 'resources'))
    writeFileSync(join(dir, 'resources', 'app.asar'), 'asar', 'utf-8')

    const missing = getMissingPackagedRuntimeFiles(dir)

    assert.deepEqual(missing, [
      'icudtl.dat',
      'locales',
      'resources.pak',
      'resources/app.asar.unpacked',
      'snapshot_blob.bin',
      'v8_context_snapshot.bin'
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('getMissingPackagedRuntimeFiles accepts a complete package', () => {
  const dir = mkdtempSync(join(tmpdir(), 'focus-memo-login-startup-'))

  try {
    mkdirSync(join(dir, 'resources'))
    mkdirSync(join(dir, 'resources', 'app.asar.unpacked'))
    mkdirSync(join(dir, 'locales'))
    for (const name of [
      'icudtl.dat',
      'resources.pak',
      'resources/app.asar',
      'snapshot_blob.bin',
      'v8_context_snapshot.bin'
    ]) {
      writeFileSync(join(dir, name), 'x', 'utf-8')
    }

    assert.deepEqual(getMissingPackagedRuntimeFiles(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
