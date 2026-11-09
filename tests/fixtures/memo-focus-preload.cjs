const { contextBridge } = require('electron')

let memos = Array.from({ length: 120 }, (_, index) => ({
  id: `memo-${index}`,
  content: index === 0 ? 'FOCUS_TARGET\n' + Array.from({ length: 36 }, (_, line) => `长内容第 ${line + 1} 行，验证完整阅读和滚动。`).join('\n') : index === 1 ? '图片备忘' : `普通待办 ${index}`,
  type: index === 1 ? 'image' : 'text',
  attachments: index === 0 ? ['first.png', 'second.png'] : index === 1 ? ['only.png'] : [],
  priority: 'unimportant', status: 'not_started', tags: index === 0 ? ['work', 'TODO'] : ['work'],
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 120 - index)).toISOString(),
  updatedAt: '2026-01-01T00:00:00.000Z', completedAt: null, deviceId: 'test', deleted: false
}))
let appSettings = { imageCompression: true, imageMaxSize: 500, imageMaxWidth: 1200, fixedPosition: 'right-center' }
const calls = []
let syncComplete
let failDelete = false
let pastedImageCount = 0
let savedImageCount = 0
let imageSaveDelays = 0
let failImageSaveCount = 0
let emptyImageSaveCount = 0
const imageSaveResolvers = []
let updateDelay
const updateResolvers = []
const imageDeleteCalls = []
const imageReferences = new Set()
const imageDeleteResolvers = []
let imageDeleteDelays = 0
let failImageDeleteCount = 0
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
    update: async (id, updates) => {
      record('update', { id, updates })
      if (updateDelay > 0) {
        updateDelay -= 1
        await new Promise(resolve => updateResolvers.push(resolve))
      }
      const update = memos.find(memo => memo.id === id)
      if (!update) return undefined
      memos = memos.map(memo => memo.id === id ? { ...memo, ...updates } : memo)
      return memos.find(memo => memo.id === id)
    },
    delete: async id => { record('delete', id); if (failDelete) throw new Error('fixture delete failure'); memos = memos.filter(m => m.id !== id); return true },
    getDeleted: async () => [], restore: ok, hardDelete: ok
  },
  clipboard: {
    copyMemoForCli: async request => { record('copy-cli', request); return { success: true } },
    copyMemo: async request => { record('copy-rich', request); return { success: true } }
  },
  image: {
    preview: async filename => { record('preview', filename); return true },
    pasteFromClipboard: async () => {
      if (imageSaveDelays > 0) {
        imageSaveDelays -= 1
        await new Promise(resolve => imageSaveResolvers.push(resolve))
      }
      return `clipboard-pasted-${++pastedImageCount}.png`
    }, save: async () => {
      if (imageSaveDelays > 0) {
        imageSaveDelays -= 1
        await new Promise(resolve => imageSaveResolvers.push(resolve))
      }
      if (failImageSaveCount > 0) {
        failImageSaveCount -= 1
        throw new Error('fixture image save failure')
      }
      if (emptyImageSaveCount > 0) {
        emptyImageSaveCount -= 1
        return ''
      }
      return `structured-pasted-${++savedImageCount}.png`
    }, delete: async filename => {
      imageDeleteCalls.push(filename)
      if (imageDeleteDelays > 0) {
        imageDeleteDelays -= 1
        await new Promise(resolve => imageDeleteResolvers.push(resolve))
      }
      if (imageReferences.has(filename)) return false
      if (failDelete || failImageDeleteCount > 0) {
        if (failImageDeleteCount > 0) failImageDeleteCount -= 1
        throw new Error('fixture delete failure')
      }
      return true
    },
    copy: ok, copyPath: ok, get: async filename => filename.startsWith('clipboard-pasted-') || filename.startsWith('structured-pasted-') ? `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="#c7d2fe"/></svg>').toString('base64')}` : null
  },
  sync: { onComplete: callback => { syncComplete = callback; return () => {} }, getConfig: async () => ({ token: '', repo: '' }) },
  settings: { get: async () => ({ ...appSettings }), set: async settings => { appSettings = { ...settings }; return true } },
  storage: { getInfo: async () => ({ dataDir: 'fixture', attachmentsDir: 'fixture' }) }
}
contextBridge.exposeInMainWorld('electronAPI', api)
contextBridge.exposeInMainWorld('memoTest', {
  calls: () => calls,
  settings: () => ({ ...appSettings }),
  memos: () => memos,
  failDelete: value => { failDelete = value },
  failImageSaves: count => { failImageSaveCount = count },
  emptyImageSaves: count => { emptyImageSaveCount = count },
  failImageDeletes: count => { failImageDeleteCount = count },
  referenceImage: (filename, referenced) => {
    if (referenced) imageReferences.add(filename)
    else imageReferences.delete(filename)
  },
  delayImageDelete: count => { imageDeleteDelays = count },
  resolveImageDeleteDelay: () => { imageDeleteResolvers.shift()?.() },
  pendingImageDeletes: () => imageDeleteResolvers.length,
  delayImageSave: count => { imageSaveDelays = count },
  resolveImageSaveDelay: () => { imageSaveResolvers.shift()?.() },
  pendingImageSaves: () => imageSaveResolvers.length,
  pastedImageCount: () => pastedImageCount,
  resetImageFixtures: () => {
    pastedImageCount = 0
    savedImageCount = 0
    imageSaveDelays = 0
    failImageSaveCount = 0
    emptyImageSaveCount = 0
    failImageDeleteCount = 0
    imageDeleteDelays = 0
    failDelete = false
    imageReferences.clear()
    imageSaveResolvers.length = 0
    imageDeleteResolvers.length = 0
    imageDeleteCalls.length = 0
  },
  imageDeletes: () => imageDeleteCalls,
  clearImageDeleteCalls: () => { imageDeleteCalls.length = 0 },
  delayUpdate: count => { updateDelay = count },
  resolveUpdateDelay: () => { updateResolvers.shift()?.() },
  pendingUpdates: () => updateResolvers.length,
  replace: next => { memos = next; syncComplete?.({ success: true }) }
})
