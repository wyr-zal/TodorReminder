// 共享类型定义

export type Priority = 'high' | 'medium' | 'low'
export type MemoStatus = 'pending' | 'completed' | 'deferred'
export type MemoType = 'text' | 'image'

export interface Memo {
  id: string
  content: string
  type: MemoType
  priority: Priority
  status: MemoStatus
  attachments: string[]
  tags: string[]
  createdAt: string
  updatedAt: string
  completedAt: string | null
  deviceId: string
  deleted: boolean
}

export interface MemoCopyRequest {
  content: string
  priority: Priority
  tags: string[]
  attachments: string[]
}

export interface MemoClipboardPayloadV1 {
  version: 1
  content: string
  priority: Priority
  tags: string[]
  imageCount: number
}

export interface ClipboardCopyResult {
  success: boolean
  copiedImageCount: number
  missingImageCount: number
  error?: string
}

export interface StorageInfo {
  currentDir: string
  defaultDir: string
  configuredDir?: string
  isCustom: boolean
  isAvailable: boolean
  error?: string
}

export interface StorageMigrationResult {
  success: boolean
  targetDir?: string
  error?: string
  warnings: string[]
}

export interface MemoData {
  version: string
  lastSync: string
  memos: Memo[]
}

export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  isHidden: boolean
  hiddenEdge: 'left' | 'right' | 'top' | null
}

// 应用设置
export interface AppSettings {
  imageCompression: boolean  // 是否压缩图片
  imageMaxSize: number       // 最大尺寸 KB
  imageMaxWidth: number      // 最大宽度 px
}

export const DEFAULT_SETTINGS: AppSettings = {
  imageCompression: true,
  imageMaxSize: 500,
  imageMaxWidth: 1200
}

export type TagSortMode = 'latest' | 'count' | 'alpha'

// IPC 通道名称
export const IPC_CHANNELS = {
  // 窗口操作
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_HIDE: 'window:hide',
  WINDOW_CLOSE: 'window:close',
  WINDOW_TOGGLE_PIN: 'window:toggle-pin',
  WINDOW_GET_STATE: 'window:get-state',
  WINDOW_SET_STATE: 'window:set-state',

  // 数据操作
  MEMO_GET_ALL: 'memo:get-all',
  MEMO_ADD: 'memo:add',
  MEMO_UPDATE: 'memo:update',
  MEMO_DELETE: 'memo:delete',
  CLIPBOARD_COPY_MEMO: 'clipboard:copy-memo',
  CLIPBOARD_COPY_MEMO_FOR_CLI: 'clipboard:copy-memo-for-cli',

  // 同步操作
  SYNC_START: 'sync:start',
  SYNC_START_BACKGROUND: 'sync:start-background',
  SYNC_STATUS: 'sync:status',
  SYNC_CONFIG: 'sync:config',
  SYNC_COMPLETE: 'sync:complete',

  // 设置
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  // 系统
  APP_GET_PATH: 'app:get-path',

  // 数据位置
  STORAGE_GET_INFO: 'storage:get-info',
  STORAGE_CHOOSE_DIRECTORY: 'storage:choose-directory',
  STORAGE_MIGRATE: 'storage:migrate'
} as const
