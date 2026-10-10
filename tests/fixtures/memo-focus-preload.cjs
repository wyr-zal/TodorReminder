const { contextBridge } = require('electron')

let memos = Array.from({ length: 120 }, (_, index) => ({
  id: `memo-${index}`,
  content: index === 0 ? 'FOCUS_TARGET\n' + Array.from({ length: 36 }, (_, line) => `长内容第 ${line + 1} 行，验证完整阅读和滚动。`).join('\n') : index === 1 ? '图片备忘' : `普通待办 ${index}`,
  type: index < 2 ? 'image' : 'text',
  attachments: index === 0 ? ['first.png', 'second.png'] : index === 1 ? ['only.png'] : [],
  priority: 'unimportant', status: 'not_started', tags: ['work'],
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 120 - index)).toISOString(),
  updatedAt: '2026-01-01T00:00:00.000Z', completedAt: null, deviceId: 'test', deleted: false
}))
const calls = []
let syncComplete
let failDelete = false
const record = (kind, detail) => calls.push({ kind, detail })
const ok = async () => true
const unsubscribe = () => () => {}
const api = {
  window: {
    getState: async () => ({ isPinned: false, isHidden: false, edgeState: null }),
    onFocusInput: unsubscribe,
    hide: async () => { record('hide') }, minimize: ok, close: ok, togglePin: ok, snapToEdge: ok
  },
  memo: {
    getAll: async () => memos,
    add: async memo => { memos.unshift(memo); return memo },
    update: async (id, updates) => { record('update', { id, updates }); memos = memos.map(m => m.id === id ? { ...m, ...updates } : m); return memos.find(m => m.id === id) },
    delete: async id => { record('delete', id); if (failDelete) throw new Error('fixture delete failure'); memos = memos.filter(m => m.id !== id); return true },
    getDeleted: async () => [], restore: ok, hardDelete: ok
  },
  clipboard: {
    copyMemoForCli: async request => { record('copy-cli', request); return { success: true } },
    copyMemo: async request => { record('copy-rich', request); return { success: true } }
  },
  image: {
    preview: async filename => { record('preview', filename); return true },
    pasteFromClipboard: async () => 'draft.png', save: async () => 'draft.png', delete: ok,
    copy: ok, copyPath: ok, get: async () => null
  },
  sync: { onComplete: callback => { syncComplete = callback; return () => {} }, getConfig: async () => ({ token: '', repo: '' }) },
  settings: { get: async () => ({ autoLaunch: false, syncEnabled: false }), set: ok },
  storage: { getInfo: async () => ({ dataDir: 'fixture', attachmentsDir: 'fixture' }) }
}
contextBridge.exposeInMainWorld('electronAPI', api)
contextBridge.exposeInMainWorld('memoTest', {
  calls: () => calls,
  memos: () => memos,
  failDelete: value => { failDelete = value },
  replace: next => { memos = next; syncComplete?.({ success: true }) }
})
