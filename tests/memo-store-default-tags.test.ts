import test from 'node:test'
import assert from 'node:assert/strict'

test('new and explicitly retagged memos receive TODO only when tags are empty', async () => {
  const previousLocalStorage = globalThis.localStorage
  const previousWindow = globalThis.window
  const persisted: any[] = []

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => {} }
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        memo: {
          getAll: async () => [...persisted],
          add: async (memo: any) => { persisted.unshift(memo); return memo },
          update: async (id: string, updates: any) => {
            const index = persisted.findIndex(memo => memo.id === id)
            if (index < 0) return null
            persisted[index] = { ...persisted[index], ...updates }
            return persisted[index]
          }
        }
      }
    }
  })

  try {
    const { useMemoStore } = await import('../src/renderer/store/memoStore.ts')
    const store = useMemoStore.getState()

    await store.addMemo('无标签文本')
    assert.deepEqual(useMemoStore.getState().memos[0].tags, ['TODO'])

    await store.addMemo('显式标签', 'unimportant', ['BUG'])
    assert.deepEqual(useMemoStore.getState().memos[0].tags, ['BUG'])

    await store.addImageMemo('无标签图片', 'unimportant', ['image.png'])
    assert.deepEqual(useMemoStore.getState().memos[0].tags, ['TODO'])

    const legacyMemo = {
      ...useMemoStore.getState().memos[0],
      id: 'legacy-memo',
      content: '历史无标签待办',
      tags: []
    }
    persisted.push(legacyMemo)
    useMemoStore.setState({ memos: [legacyMemo] })
    await useMemoStore.getState().updateMemo('legacy-memo', { status: 'in_progress' })
    assert.deepEqual(useMemoStore.getState().memos.find(memo => memo.id === 'legacy-memo')?.tags, [])

    await useMemoStore.getState().updateMemo('legacy-memo', { tags: [] })
    assert.deepEqual(useMemoStore.getState().memos.find(memo => memo.id === 'legacy-memo')?.tags, ['TODO'])
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousLocalStorage })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})
