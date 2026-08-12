import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { constrainWindowBounds, loadWindowState, saveWindowState } from '../src/main/window-state.ts'

const DEFAULT_BOUNDS = { x: 100, y: 100, width: 480, height: 720 }
const LIMITS = { minWidth: 280, minHeight: 300 }

test('loadWindowState returns saved bounds when state file is valid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'focus-memo-window-state-'))

  try {
    const filePath = join(dir, 'window-state.json')
    writeFileSync(filePath, JSON.stringify({ x: 320, y: 180, width: 640, height: 860 }), 'utf-8')

    const state = loadWindowState(filePath, DEFAULT_BOUNDS, LIMITS)

    assert.deepEqual(state, { x: 320, y: 180, width: 640, height: 860 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadWindowState falls back to defaults when saved bounds are invalid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'focus-memo-window-state-'))

  try {
    const filePath = join(dir, 'window-state.json')
    writeFileSync(filePath, JSON.stringify({ x: 20, y: 40, width: 100, height: 200 }), 'utf-8')

    const state = loadWindowState(filePath, DEFAULT_BOUNDS, LIMITS)

    assert.deepEqual(state, DEFAULT_BOUNDS)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('constrainWindowBounds pulls off-screen bounds back into visible work area', () => {
  const bounds = constrainWindowBounds(
    { x: 1800, y: -120, width: 900, height: 1200 },
    { x: 0, y: 0, width: 1600, height: 900 },
    LIMITS
  )

  assert.deepEqual(bounds, { x: 700, y: 0, width: 900, height: 900 })
})

test('saveWindowState persists full bounds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'focus-memo-window-state-'))

  try {
    const filePath = join(dir, 'window-state.json')

    saveWindowState(filePath, { x: 260, y: 140, width: 700, height: 900 })

    const saved = JSON.parse(readFileSync(filePath, 'utf-8'))
    assert.deepEqual(saved, { x: 260, y: 140, width: 700, height: 900 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
