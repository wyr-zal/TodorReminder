import test from 'node:test'
import assert from 'node:assert/strict'
import { isThemeMode, resolveThemeMode } from '../src/renderer/utils/theme.ts'

test('theme mode accepts only supported persisted values', () => {
  assert.equal(isThemeMode('system'), true)
  assert.equal(isThemeMode('light'), true)
  assert.equal(isThemeMode('dark'), true)
  assert.equal(isThemeMode('auto'), false)
  assert.equal(isThemeMode(null), false)
})

test('system mode follows the operating system preference', () => {
  assert.equal(resolveThemeMode('system', false), 'light')
  assert.equal(resolveThemeMode('system', true), 'dark')
})

test('manual light and dark modes override the operating system preference', () => {
  assert.equal(resolveThemeMode('light', true), 'light')
  assert.equal(resolveThemeMode('dark', false), 'dark')
})
