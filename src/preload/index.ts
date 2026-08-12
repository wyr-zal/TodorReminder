import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_CHANNELS,
  Memo,
  WindowState,
  AppSettings,
  MemoCopyRequest,
  ClipboardCopyResult,
  StorageInfo,
  StorageMigrationResult
} from '../shared/types'

// 暴露给渲染进程的 API
const electronAPI = {
  // 窗口操作
  window: {
    minimize: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MINIMIZE),
    close: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE),
    togglePin: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_TOGGLE_PIN),
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_GET_STATE) as Promise<WindowState>,
    showFromEdge: () => ipcRenderer.send('window:show-from-edge'),
    snapToEdge: () => ipcRenderer.invoke('window:snap-to-edge') as Promise<boolean>,
    onFocusInput: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('window:focus-input', handler)
      return () => ipcRenderer.removeListener('window:focus-input', handler)
    },
    onResizeState: (callback: (isResizing: boolean) => void) => {
      const handler = (_: unknown, isResizing: boolean) => callback(isResizing)
      ipcRenderer.on(IPC_CHANNELS.WINDOW_RESIZE_STATE, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WINDOW_RESIZE_STATE, handler)
    }
  },

  // 备忘录操作
  memo: {
    getAll: () => ipcRenderer.invoke(IPC_CHANNELS.MEMO_GET_ALL) as Promise<Memo[]>,
    add: (memo: Memo) => ipcRenderer.invoke(IPC_CHANNELS.MEMO_ADD, memo) as Promise<Memo>,
    update: (id: string, updates: Partial<Memo>) =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMO_UPDATE, { id, updates }) as Promise<Memo>,
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.MEMO_DELETE, id) as Promise<boolean>,
    export: () => ipcRenderer.invoke('memo:export'),
    // 回收站
    getDeleted: () => ipcRenderer.invoke('memo:get-deleted') as Promise<Memo[]>,
    restore: (id: string) => ipcRenderer.invoke('memo:restore', id) as Promise<boolean>,
    hardDelete: (id: string) => ipcRenderer.invoke('memo:hard-delete', id) as Promise<boolean>
  },

  clipboard: {
    copyMemo: (request: MemoCopyRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.CLIPBOARD_COPY_MEMO, request) as Promise<ClipboardCopyResult>,
    copyMemoForCli: (request: MemoCopyRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.CLIPBOARD_COPY_MEMO_FOR_CLI, request) as Promise<ClipboardCopyResult>
  },

  // 同步操作
  sync: {
    start: () => ipcRenderer.invoke(IPC_CHANNELS.SYNC_START),
    startBackground: () => ipcRenderer.invoke(IPC_CHANNELS.SYNC_START_BACKGROUND),
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SYNC_STATUS),
    setConfig: (config: { token: string; repo: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.SYNC_CONFIG, config),
    getConfig: () => ipcRenderer.invoke('sync:get-config'),
    onComplete: (callback: (result: { success: boolean; error?: string }) => void) => {
      const handler = (_: unknown, result: { success: boolean; error?: string }) => callback(result)
      ipcRenderer.on(IPC_CHANNELS.SYNC_COMPLETE, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SYNC_COMPLETE, handler)
    }
  },

  // 设置
  settings: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET) as Promise<AppSettings>,
    set: (settings: AppSettings) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, settings) as Promise<boolean>
  },

  // 系统
  app: {
    getPath: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_PATH, name) as Promise<string>
  },

  storage: {
    getInfo: () =>
      ipcRenderer.invoke(IPC_CHANNELS.STORAGE_GET_INFO) as Promise<StorageInfo>,
    chooseDirectory: () =>
      ipcRenderer.invoke(IPC_CHANNELS.STORAGE_CHOOSE_DIRECTORY) as Promise<string | null>,
    migrate: (targetDir: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.STORAGE_MIGRATE, targetDir) as Promise<StorageMigrationResult>
  },

  // 图片操作
  image: {
    save: (base64: string) => ipcRenderer.invoke('image:save', base64) as Promise<string>,
    get: (filename: string) => ipcRenderer.invoke('image:get', filename) as Promise<string | null>,
    delete: (filename: string) => ipcRenderer.invoke('image:delete', filename) as Promise<boolean>,
    copy: (filename: string) => ipcRenderer.invoke('image:copy', filename) as Promise<boolean>,
    copyPath: (filename: string) => ipcRenderer.invoke('image:copy-path', filename) as Promise<boolean>,
    pasteFromClipboard: () => ipcRenderer.invoke('image:paste-from-clipboard') as Promise<string | null>,
    saveToFile: (filename: string) => ipcRenderer.invoke('image:save-to-file', filename) as Promise<boolean>
  }
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

// 类型声明
export type ElectronAPI = typeof electronAPI
