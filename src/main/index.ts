import { app, BrowserWindow, screen, ipcMain, globalShortcut, Tray, Menu, nativeImage, clipboard, Notification, dialog } from 'electron'
import { execFileSync } from 'child_process'
import { basename, dirname, join } from 'path'
import * as fs from 'fs'
import {
  IPC_CHANNELS,
  WindowState,
  Memo,
  AppSettings,
  DEFAULT_SETTINGS,
  MemoCopyRequest,
  ClipboardCopyResult,
  StorageInfo,
  StorageMigrationResult
} from '../shared/types'
import {
  buildMemoClipboardFormats,
  buildMemoCliText,
  createClipboardCopyResult,
  createMemoClipboardPayload,
  shouldIncludeNativeClipboardImage
} from '../shared/memoClipboard'
import { initDatabase, closeDatabase, getAllMemos, createMemo, updateMemo, deleteMemo, getDeletedMemos, restoreMemo, hardDeleteMemo, exportToJSON, importFromJSON } from './database'
import { loadSyncConfig, saveSyncConfig, getSyncStatus, sync } from './sync'
import { saveImage, getImageBase64, getImageBuffer, getExistingImagePath, deleteImage, exportImage } from './image'
import { constrainWindowBounds, loadWindowState, saveWindowState } from './window-state'
import { migrateStorageData, resolveStorageInfo } from './storage'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let defaultUserDataPath = ''
let storageInfo: StorageInfo | null = null
let isAlwaysOnTop = true
let savedBounds: Electron.Rectangle | null = null  // 保存隐藏前的位置
let moveTimeout: NodeJS.Timeout | null = null  // 防抖定时器
let resizeTimeout: NodeJS.Timeout | null = null
let isWindowResizing = false
let lastClickTime = 0  // 用于检测双击
const DEFAULT_WINDOW_WIDTH = 480
const DEFAULT_WINDOW_HEIGHT = 720
const WINDOW_MIN_WIDTH = 280
const WINDOW_MIN_HEIGHT = 300
const DEFAULT_WINDOW_TOP_OFFSET = 100
const DEFAULT_WINDOW_RIGHT_OFFSET = 20
let windowState: WindowState = {
  x: 100,
  y: 100,
  width: DEFAULT_WINDOW_WIDTH,
  height: DEFAULT_WINDOW_HEIGHT,
  isHidden: false,
  hiddenEdge: null
}

const HIDDEN_VISIBLE_WIDTH = 8
const ALWAYS_ON_TOP_LEVEL = 'screen-saver' as const
const RESIZE_SETTLE_DELAY = 80
const SILENT_STARTUP_ARG = '--focus-memo-silent-startup'
const LOGIN_ITEM_NAME = 'FocusMemo'
const LEGACY_LOGIN_ITEM_NAMES = ['electron.app.Electron', 'Electron']
const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const PACKAGED_EXE_NAME = '专注备忘录.exe'

function getRegExePath(): string {
  return process.env.SystemRoot
    ? join(process.env.SystemRoot, 'System32', 'reg.exe')
    : 'reg.exe'
}

function isDevelopmentElectronExecutable(executablePath: string): boolean {
  return executablePath
    .replace(/\//g, '\\')
    .replace(/^"|"$/g, '')
    .toLowerCase()
    .endsWith('\\node_modules\\electron\\dist\\electron.exe')
}

function getCommandExecutable(command: string): string {
  const trimmed = command.trim()
  if (trimmed.startsWith('"')) {
    const closingQuoteIndex = trimmed.indexOf('"', 1)
    return closingQuoteIndex > 1 ? trimmed.slice(1, closingQuoteIndex) : trimmed
  }

  return trimmed.split(/\s+/)[0] || trimmed
}

function getPackagedExecutablePath(): string | null {
  if (!isDevelopmentElectronExecutable(process.execPath)) {
    return process.execPath
  }

  const desktopDir = join(dirname(process.execPath), '..', '..', '..')
  const packagedExecutable = join(desktopDir, 'release', 'win-unpacked', PACKAGED_EXE_NAME)
  return fs.existsSync(packagedExecutable) ? packagedExecutable : null
}

function isDevelopmentElectronStartupCommand(value: string | null): boolean {
  return Boolean(value && isDevelopmentElectronExecutable(getCommandExecutable(value)))
}

function getSilentStartupCommand(): string | null {
  const executablePath = getPackagedExecutablePath()
  return executablePath ? `"${executablePath}" ${SILENT_STARTUP_ARG}` : null
}

function readWindowsRunValue(name: string): string | null {
  try {
    const output = execFileSync(
      getRegExePath(),
      ['query', WINDOWS_RUN_KEY, '/v', name],
      { encoding: 'utf8', windowsHide: true }
    )
    const valueLine = output
      .split(/\r?\n/)
      .find(line => line.trimStart().startsWith(name))

    if (!valueLine) {
      return null
    }

    const match = valueLine.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s*(.*)$`))
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

function writeWindowsRunValue(name: string, value: string): void {
  execFileSync(
    getRegExePath(),
    ['add', WINDOWS_RUN_KEY, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'],
    { stdio: 'ignore', windowsHide: true }
  )
}

function deleteWindowsRunValue(name: string): void {
  try {
    execFileSync(
      getRegExePath(),
      ['delete', WINDOWS_RUN_KEY, '/v', name, '/f'],
      { stdio: 'ignore', windowsHide: true }
    )
  } catch {
    // Missing Run values are already disabled.
  }
}

function removeEmptyLegacyWindowsRunValues(): void {
  LEGACY_LOGIN_ITEM_NAMES.forEach(name => {
    if (readWindowsRunValue(name) === '') {
      deleteWindowsRunValue(name)
    }
  })
}

function removeDevelopmentElectronWindowsRunValues(): void {
  ;[LOGIN_ITEM_NAME, ...LEGACY_LOGIN_ITEM_NAMES].forEach(name => {
    if (isDevelopmentElectronStartupCommand(readWindowsRunValue(name))) {
      deleteWindowsRunValue(name)
    }
  })
}

function hasEmptyWindowsRunStartup(): boolean {
  return readWindowsRunValue(LOGIN_ITEM_NAME) === ''
    || LEGACY_LOGIN_ITEM_NAMES.some(name => readWindowsRunValue(name) === '')
}

function hasDevelopmentElectronWindowsRunStartup(): boolean {
  return [LOGIN_ITEM_NAME, ...LEGACY_LOGIN_ITEM_NAMES]
    .some(name => isDevelopmentElectronStartupCommand(readWindowsRunValue(name)))
}

function hasWindowsRunStartup(): boolean {
  const value = readWindowsRunValue(LOGIN_ITEM_NAME)
  return Boolean(
    value
    && value.includes(SILENT_STARTUP_ARG)
    && !isDevelopmentElectronStartupCommand(value)
  )
}

function setWindowsRunStartup(enabled: boolean): void {
  removeEmptyLegacyWindowsRunValues()
  removeDevelopmentElectronWindowsRunValues()

  if (enabled) {
    const command = getSilentStartupCommand()
    if (!command) {
      console.warn('Skip login startup: packaged Focus Memo executable was not found.')
      deleteWindowsRunValue(LOGIN_ITEM_NAME)
      return
    }

    writeWindowsRunValue(LOGIN_ITEM_NAME, command)
    return
  }

  deleteWindowsRunValue(LOGIN_ITEM_NAME)
}

function createLoginItemOptions(args: string[] = []): Electron.LoginItemSettingsOptions {
  return {
    path: process.execPath,
    args
  }
}

function getDefaultLoginItemSettings() {
  return app.getLoginItemSettings(createLoginItemOptions())
}

function getSilentLoginItemSettings() {
  return app.getLoginItemSettings(createLoginItemOptions([SILENT_STARTUP_ARG]))
}

function isOpenAtLoginEnabled(): boolean {
  const defaultSettings = getDefaultLoginItemSettings()
  const silentSettings = getSilentLoginItemSettings()
  const electronSettingsEnabled = defaultSettings.openAtLogin
    || defaultSettings.executableWillLaunchAtLogin
    || silentSettings.openAtLogin
    || silentSettings.executableWillLaunchAtLogin

  if (process.platform === 'win32') {
    return hasWindowsRunStartup()
      || hasEmptyWindowsRunStartup()
      || electronSettingsEnabled
  }

  return electronSettingsEnabled
}

function setOpenAtLogin(enabled: boolean): void {
  if (process.platform === 'win32') {
    setWindowsRunStartup(enabled)
    return
  }

  app.setLoginItemSettings({
    openAtLogin: false,
    name: LOGIN_ITEM_NAME,
    path: process.execPath
  })
  app.setLoginItemSettings({
    openAtLogin: false,
    name: LOGIN_ITEM_NAME,
    path: process.execPath,
    args: [SILENT_STARTUP_ARG]
  })

  if (enabled) {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true,
      name: LOGIN_ITEM_NAME,
      path: process.execPath,
      args: [SILENT_STARTUP_ARG]
    })
  }
}

function normalizeOpenAtLoginForSilentStartup(): void {
  const shouldKeepStartup = isOpenAtLoginEnabled() || hasDevelopmentElectronWindowsRunStartup()

  if (process.platform === 'win32') {
    removeEmptyLegacyWindowsRunValues()
    removeDevelopmentElectronWindowsRunValues()
  }

  if (shouldKeepStartup) {
    setOpenAtLogin(true)
  }
}

function shouldStartSilently(): boolean {
  const defaultSettings = getDefaultLoginItemSettings()
  const silentSettings = getSilentLoginItemSettings()

  return process.argv.includes(SILENT_STARTUP_ARG)
    || defaultSettings.wasOpenedAtLogin
    || defaultSettings.wasOpenedAsHidden
    || silentSettings.wasOpenedAtLogin
    || silentSettings.wasOpenedAsHidden
}

function isSilentStartupArgv(argv: string[]): boolean {
  return argv.includes(SILENT_STARTUP_ARG)
}

function showMainWindowFromUserAction(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }

  if (windowState.isHidden) {
    showFromEdge()
  }

  safeShow()
  safeFocus()
}

// 确保窗口不出现在任务栏
function ensureSkipTaskbar() {
  if (mainWindow) {
    mainWindow.setSkipTaskbar(true)
  }
}

function syncAlwaysOnTop(moveToTop = false) {
  if (!mainWindow) {
    return
  }

  if (isAlwaysOnTop) {
    mainWindow.setAlwaysOnTop(true, ALWAYS_ON_TOP_LEVEL)
    if (moveToTop && mainWindow.isVisible()) {
      mainWindow.moveTop()
    }
  } else {
    mainWindow.setAlwaysOnTop(false)
  }

  ensureSkipTaskbar()
}

function emitResizeState(isResizing: boolean) {
  if (!mainWindow || mainWindow.isDestroyed() || isWindowResizing === isResizing) {
    return
  }

  isWindowResizing = isResizing
  mainWindow.webContents.send(IPC_CHANNELS.WINDOW_RESIZE_STATE, isResizing)
}

function markResizeStart() {
  if (resizeTimeout) {
    clearTimeout(resizeTimeout)
    resizeTimeout = null
  }

  emitResizeState(true)
}

function updateWindowStateBounds(bounds: Electron.Rectangle) {
  windowState = {
    ...windowState,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height
  }
}

function getPersistableBounds(): Electron.Rectangle | null {
  if (windowState.isHidden && savedBounds) {
    return savedBounds
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    return null
  }

  return mainWindow.getBounds()
}

function scheduleResizeEnd() {
  if (resizeTimeout) {
    clearTimeout(resizeTimeout)
  }

  resizeTimeout = setTimeout(() => {
    resizeTimeout = null
    const bounds = getPersistableBounds()
    if (bounds) {
      updateWindowStateBounds(bounds)
      persistWindowBounds(bounds)
    }
    emitResizeState(false)
  }, RESIZE_SETTLE_DELAY)
}

function scheduleMoveEnd() {
  if (moveTimeout) {
    clearTimeout(moveTimeout)
  }

  moveTimeout = setTimeout(() => {
    moveTimeout = null
    const bounds = getPersistableBounds()
    if (!bounds) {
      return
    }

    updateWindowStateBounds(bounds)
    persistWindowBounds(bounds)
  }, RESIZE_SETTLE_DELAY)
}

// 安全地显示窗口（显示后重新隐藏任务栏图标）
function safeShow() {
  if (mainWindow) {
    mainWindow.show()
    syncAlwaysOnTop(true)
  }
}

function safeFocus() {
  if (mainWindow) {
    mainWindow.focus()
    syncAlwaysOnTop(true)
  }
}

function configureStorageDirectory(): void {
  defaultUserDataPath = app.getPath('userData')
  storageInfo = resolveStorageInfo(defaultUserDataPath)

  if (storageInfo.currentDir !== defaultUserDataPath) {
    app.setPath('userData', storageInfo.currentDir)
  }

  if (storageInfo.error) {
    console.warn(storageInfo.error)
  }
}

// 设置存储
function getSettingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function loadSettings(): AppSettings {
  try {
    const path = getSettingsPath()
    if (fs.existsSync(path)) {
      const data = fs.readFileSync(path, 'utf-8')
      return { ...DEFAULT_SETTINGS, ...JSON.parse(data) }
    }
  } catch (error) {
    console.error('Failed to load settings:', error)
  }
  return { ...DEFAULT_SETTINGS }
}

function saveSettings(settings: AppSettings): void {
  try {
    fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2))
  } catch (error) {
    console.error('Failed to save settings:', error)
  }
}

function getWindowStatePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function getDefaultWindowBounds(workArea: Electron.Rectangle) {
  return constrainWindowBounds(
    {
      x: workArea.x + workArea.width - DEFAULT_WINDOW_WIDTH - DEFAULT_WINDOW_RIGHT_OFFSET,
      y: workArea.y + DEFAULT_WINDOW_TOP_OFFSET,
      width: DEFAULT_WINDOW_WIDTH,
      height: DEFAULT_WINDOW_HEIGHT
    },
    workArea,
    {
      minWidth: WINDOW_MIN_WIDTH,
      minHeight: WINDOW_MIN_HEIGHT
    }
  )
}

function persistWindowBounds(bounds: Electron.Rectangle): void {
  if (windowState.isHidden) {
    return
  }

  savedBounds = { ...bounds }
  saveWindowState(getWindowStatePath(), bounds)
}

function persistCurrentWindowBounds(): void {
  const bounds = getPersistableBounds()
  if (!bounds) {
    return
  }

  updateWindowStateBounds(bounds)
  savedBounds = { ...bounds }
  saveWindowState(getWindowStatePath(), bounds)
}

function createWindow(options: { showOnCreate?: boolean } = {}) {
  const showOnCreate = options.showOnCreate ?? true
  const primaryDisplay = screen.getPrimaryDisplay()
  const defaultBounds = getDefaultWindowBounds(primaryDisplay.workArea)
  const persistedWindowBounds = loadWindowState(
    getWindowStatePath(),
    defaultBounds,
    {
      minWidth: WINDOW_MIN_WIDTH,
      minHeight: WINDOW_MIN_HEIGHT
    }
  )
  const targetDisplay = screen.getDisplayMatching(persistedWindowBounds)
  const restoredBounds = constrainWindowBounds(
    persistedWindowBounds,
    targetDisplay.workArea,
    {
      minWidth: WINDOW_MIN_WIDTH,
      minHeight: WINDOW_MIN_HEIGHT
    }
  )

  savedBounds = { ...restoredBounds }
  updateWindowStateBounds(restoredBounds)

  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    frame: false,
    transparent: false,
    show: showOnCreate,
    alwaysOnTop: isAlwaysOnTop,
    skipTaskbar: true,
    resizable: true,
    roundedCorners: false,
    backgroundColor: '#F8FAFC',
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  syncAlwaysOnTop()

  // 开发环境加载本地服务器
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    // 仅在开发环境打开 DevTools
    // mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // 窗口移动结束 - 自动边缘吸附功能已禁用
  // mainWindow.on('moved', () => { ... })

  // 双击窗口弹出（通过 focus 事件检测）
  mainWindow.on('focus', () => {
    syncAlwaysOnTop(true)

    if (windowState.isHidden) {
      const now = Date.now()
      if (now - lastClickTime < 400) {
        // 双击检测成功，弹出窗口
        showFromEdge()
      }
      lastClickTime = now
    }
  })

  mainWindow.on('show', () => {
    syncAlwaysOnTop(true)
  })

  mainWindow.on('move', () => {
    scheduleMoveEnd()
  })

  mainWindow.on('will-resize', () => {
    markResizeStart()
  })

  mainWindow.on('resize', () => {
    scheduleResizeEnd()
  })

  mainWindow.on('close', () => {
    persistCurrentWindowBounds()
  })

  mainWindow.on('closed', () => {
    if (moveTimeout) {
      clearTimeout(moveTimeout)
      moveTimeout = null
    }
    if (resizeTimeout) {
      clearTimeout(resizeTimeout)
      resizeTimeout = null
    }
    isWindowResizing = false
    mainWindow = null
  })
}

function showFromEdge() {
  if (!mainWindow || !windowState.isHidden) return

  const display = screen.getPrimaryDisplay()
  const { x: screenX, y: screenY, width: screenWidth } = display.workArea

  windowState.isHidden = false

  // 恢复到之前保存的位置，或默认位置
  if (savedBounds) {
    switch (windowState.hiddenEdge) {
      case 'left':
        mainWindow.setBounds({ x: screenX + 20 })
        break
      case 'right':
        mainWindow.setBounds({ x: screenX + screenWidth - savedBounds.width - 20 })
        break
      case 'top':
        mainWindow.setBounds({ y: screenY + 20 })
        break
    }
  }
  windowState.hiddenEdge = null
}

function createTrayIcon(): Electron.NativeImage {
  // 创建 16x16 蓝色备忘录图标
  // 使用 Buffer 创建简单的蓝色方块带白色线条
  const size = 16
  const data = Buffer.alloc(size * size * 4) // RGBA

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4

      // 圆角矩形边界检测
      const inRect = x >= 2 && x < 14 && y >= 1 && y < 15
      const isCorner = (
        (x === 2 && y === 1) || (x === 13 && y === 1) ||
        (x === 2 && y === 14) || (x === 13 && y === 14)
      )

      // 白色横线（模拟文本行）
      const isLine1 = y >= 4 && y <= 5 && x >= 4 && x < 12
      const isLine2 = y >= 7 && y <= 8 && x >= 4 && x < 10
      const isLine3 = y >= 10 && y <= 11 && x >= 4 && x < 11

      if (inRect && !isCorner) {
        if (isLine1 || isLine2 || isLine3) {
          // 白色线条
          data[idx] = 255     // R
          data[idx + 1] = 255 // G
          data[idx + 2] = 255 // B
          data[idx + 3] = 255 // A
        } else {
          // 蓝色背景 (#3B82F6)
          data[idx] = 59      // R
          data[idx + 1] = 130 // G
          data[idx + 2] = 246 // B
          data[idx + 3] = 255 // A
        }
      } else {
        // 透明
        data[idx] = 0
        data[idx + 1] = 0
        data[idx + 2] = 0
        data[idx + 3] = 0
      }
    }
  }

  return nativeImage.createFromBuffer(data, { width: size, height: size })
}

function createTray() {
  const icon = createTrayIcon()
  tray = new Tray(icon)

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示/隐藏',
      click: () => {
        if (mainWindow) {
          if (!windowState.isHidden && mainWindow.isVisible()) {
            mainWindow.hide()
          } else {
            showMainWindowFromUserAction()
          }
        }
      }
    },
    {
      label: '始终置顶',
      type: 'checkbox',
      checked: isAlwaysOnTop,
      click: (menuItem) => {
        isAlwaysOnTop = menuItem.checked
        syncAlwaysOnTop(true)
      }
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: isOpenAtLoginEnabled(),
      click: (menuItem) => {
        setOpenAtLogin(menuItem.checked)
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit()
      }
    }
  ])

  tray.setToolTip('专注备忘录')
  tray.setContextMenu(contextMenu)

  tray.on('click', () => {
    if (mainWindow) {
      showMainWindowFromUserAction()
    }
  })
}

function registerShortcuts() {
  // 全局快捷键呼出/隐藏窗口
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    if (mainWindow) {
      const display = screen.getPrimaryDisplay()
      const { width: screenWidth, height: screenHeight } = display.workArea
      const bounds = mainWindow.getBounds()
      const targetX = screenWidth - bounds.width - 20
      const targetY = Math.round((screenHeight - bounds.height) / 2)

      // 判断窗口是否已在固定位置且可见且聚焦
      const isAtFixedPosition = !windowState.isHidden
        && mainWindow.isVisible()
        && mainWindow.isFocused()
        && Math.abs(bounds.x - targetX) < 5
        && Math.abs(bounds.y - targetY) < 5

      if (isAtFixedPosition) {
        // 已激活且在固定位置，隐藏窗口
        mainWindow.hide()
        return
      }

      // 重置隐藏状态
      if (windowState.isHidden) {
        windowState.isHidden = false
        windowState.hiddenEdge = null
      }

      // 移动到屏幕右侧中间位置
      mainWindow.setBounds({ x: targetX, y: targetY })

      safeShow()
      safeFocus()
      mainWindow.webContents.send('window:focus-input')
    }
  })
}

function setupIPC() {
  // 窗口操作
  ipcMain.handle(IPC_CHANNELS.WINDOW_MINIMIZE, () => {
    mainWindow?.minimize()
  })

  ipcMain.handle(IPC_CHANNELS.WINDOW_CLOSE, () => {
    app.quit()
  })

  ipcMain.handle(IPC_CHANNELS.WINDOW_TOGGLE_PIN, () => {
    isAlwaysOnTop = !isAlwaysOnTop
    syncAlwaysOnTop(true)
    return isAlwaysOnTop
  })

  ipcMain.handle(IPC_CHANNELS.WINDOW_GET_STATE, () => {
    return windowState
  })

  // 双击弹出窗口
  ipcMain.on('window:show-from-edge', () => {
    showFromEdge()
  })

  // 手动吸附到右边缘
  ipcMain.handle('window:snap-to-edge', () => {
    if (!mainWindow || windowState.isHidden) return false

    const bounds = mainWindow.getBounds()
    const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y })
    const { x: screenX, width: screenWidth } = display.workArea

    // 保存当前位置用于恢复
    savedBounds = { ...bounds }

    // 吸附到右边缘
    windowState.hiddenEdge = 'right'
    windowState.isHidden = true
    mainWindow.setBounds({ x: screenX + screenWidth - HIDDEN_VISIBLE_WIDTH })
    return true
  })

  // 获取应用路径
  ipcMain.handle(IPC_CHANNELS.APP_GET_PATH, (_, name: string) => {
    return app.getPath(name as any)
  })

  // 数据库操作
  ipcMain.handle(IPC_CHANNELS.MEMO_GET_ALL, () => {
    return getAllMemos()
  })

  ipcMain.handle(IPC_CHANNELS.MEMO_ADD, (_, memo: Memo) => {
    return createMemo(memo)
  })

  ipcMain.handle(IPC_CHANNELS.MEMO_UPDATE, (_, { id, updates }: { id: string; updates: Partial<Memo> }) => {
    return updateMemo(id, updates)
  })

  ipcMain.handle(IPC_CHANNELS.MEMO_DELETE, (_, id: string) => {
    return deleteMemo(id)
  })

  ipcMain.handle(
    IPC_CHANNELS.CLIPBOARD_COPY_MEMO,
    (_, request: MemoCopyRequest): ClipboardCopyResult => {
      try {
        const validImages: Array<{
          nativeImage: Electron.NativeImage
          dataUrl: string
          pngHex: string
          width: number
          height: number
        }> = []
        let missingImageCount = 0

        request.attachments.forEach((filename) => {
          if (typeof filename !== 'string' || basename(filename) !== filename) {
            missingImageCount += 1
            return
          }

          const sourceBuffer = getImageBuffer(filename)
          if (!sourceBuffer) {
            missingImageCount += 1
            return
          }

          const image = nativeImage.createFromBuffer(sourceBuffer)
          if (image.isEmpty()) {
            missingImageCount += 1
            return
          }

          const pngBuffer = image.toPNG()
          const size = image.getSize()
          validImages.push({
            nativeImage: image,
            dataUrl: `data:image/png;base64,${pngBuffer.toString('base64')}`,
            pngHex: pngBuffer.toString('hex'),
            width: size.width,
            height: size.height
          })
        })

        const payload = createMemoClipboardPayload(
          request.content,
          request.priority,
          request.tags,
          validImages.length
        )
        const formats = buildMemoClipboardFormats(payload, validImages)
        const clipboardData: Electron.Data = {
          text: formats.text,
          html: formats.html,
          rtf: formats.rtf
        }

        if (validImages[0] && shouldIncludeNativeClipboardImage(formats.text, validImages.length)) {
          clipboardData.image = validImages[0].nativeImage
        }

        clipboard.write(clipboardData)

        return createClipboardCopyResult(
          validImages.length + missingImageCount,
          validImages.length
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('Failed to copy memo to clipboard:', error)
        return createClipboardCopyResult(request.attachments.length, 0, message)
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CLIPBOARD_COPY_MEMO_FOR_CLI,
    (_, request: MemoCopyRequest): ClipboardCopyResult => {
      try {
        const imagePaths: string[] = []
        let missingImageCount = 0

        request.attachments.forEach((filename) => {
          const imagePath = getExistingImagePath(filename)
          if (imagePath) {
            imagePaths.push(imagePath)
          } else {
            missingImageCount += 1
          }
        })

        clipboard.writeText(buildMemoCliText(
          request.content,
          request.tags,
          imagePaths
        ))

        return createClipboardCopyResult(
          imagePaths.length + missingImageCount,
          imagePaths.length
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('Failed to copy memo for CLI:', error)
        return createClipboardCopyResult(request.attachments.length, 0, message)
      }
    }
  )

  // 回收站操作
  ipcMain.handle('memo:get-deleted', () => {
    return getDeletedMemos()
  })

  ipcMain.handle('memo:restore', (_, id: string) => {
    return restoreMemo(id)
  })

  ipcMain.handle('memo:hard-delete', (_, id: string) => {
    return hardDeleteMemo(id)
  })

  // 导出数据
  ipcMain.handle('memo:export', () => {
    return exportToJSON()
  })

  // 同步操作
  ipcMain.handle(IPC_CHANNELS.SYNC_START, async () => {
    const localData = exportToJSON()
    const result = await sync(localData)
    if (result) {
      // 导入同步后的数据
      importFromJSON(result)
      return { success: true, data: result }
    }
    return { success: false, error: getSyncStatus().error }
  })

  // 后台同步（不阻塞UI，完成后发通知）
  ipcMain.handle(IPC_CHANNELS.SYNC_START_BACKGROUND, async () => {
    // 立即返回，告诉渲染进程同步已开始
    setImmediate(async () => {
      try {
        const localData = exportToJSON()
        const result = await sync(localData)

        if (result) {
          // 导入同步后的数据
          importFromJSON(result)

          // 发送成功通知（保持显示直到用户点击）
          new Notification({
            title: '专注备忘',
            body: '同步成功！',
            timeoutType: 'never'
          }).show()

          // 通知渲染进程刷新数据
          mainWindow?.webContents.send(IPC_CHANNELS.SYNC_COMPLETE, { success: true })
        } else {
          const error = getSyncStatus().error || '未知错误'
          // 发送失败通知（保持显示直到用户点击）
          new Notification({
            title: '专注备忘',
            body: `同步失败: ${error}`,
            timeoutType: 'never'
          }).show()

          mainWindow?.webContents.send(IPC_CHANNELS.SYNC_COMPLETE, { success: false, error })
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : '同步过程出错'
        new Notification({
          title: '专注备忘',
          body: `同步失败: ${errorMsg}`,
          timeoutType: 'never'
        }).show()

        mainWindow?.webContents.send(IPC_CHANNELS.SYNC_COMPLETE, { success: false, error: errorMsg })
      }
    })

    return { started: true }
  })

  ipcMain.handle(IPC_CHANNELS.SYNC_STATUS, () => {
    return getSyncStatus()
  })

  ipcMain.handle(IPC_CHANNELS.SYNC_CONFIG, (_, config: { token: string; repo: string }) => {
    saveSyncConfig({ ...config, branch: 'main' })
    return true
  })

  ipcMain.handle('sync:get-config', () => {
    return loadSyncConfig()
  })

  // 设置操作
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, () => {
    return loadSettings()
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, (_, settings: AppSettings) => {
    saveSettings(settings)
    return true
  })

  // 图片操作
  ipcMain.handle('image:save', async (_, base64: string) => {
    const settings = loadSettings()
    // 移除 data URL 前缀
    const base64Data = base64.replace(/^data:image\/\w+;base64,/, '')
    const buffer = Buffer.from(base64Data, 'base64')
    return await saveImage(buffer, {
      compress: settings.imageCompression,
      maxSize: settings.imageMaxSize,
      maxWidth: settings.imageMaxWidth
    })
  })

  ipcMain.handle('image:get', (_, filename: string) => {
    return getImageBase64(filename)
  })

  ipcMain.handle('image:delete', (_, filename: string) => {
    return deleteImage(filename)
  })

  ipcMain.handle('image:copy', (_, filename: string) => {
    try {
      const buffer = getImageBuffer(filename)
      if (!buffer) {
        return false
      }

      const image = nativeImage.createFromBuffer(buffer)
      if (image.isEmpty()) {
        return false
      }

      clipboard.writeImage(image)
      return true
    } catch (error) {
      console.error('Failed to copy image:', error)
      return false
    }
  })

  ipcMain.handle('image:copy-path', (_, filename: string) => {
    try {
      const imagePath = getExistingImagePath(filename)
      if (!imagePath) {
        return false
      }

      clipboard.writeText(imagePath)
      return true
    } catch (error) {
      console.error('Failed to copy image path:', error)
      return false
    }
  })

  ipcMain.handle('image:paste-from-clipboard', async () => {
    const settings = loadSettings()
    const image = clipboard.readImage()
    if (image.isEmpty()) {
      return null
    }
    const buffer = image.toPNG()
    return await saveImage(buffer, {
      compress: settings.imageCompression,
      maxSize: settings.imageMaxSize,
      maxWidth: settings.imageMaxWidth
    })
  })

  // 保存图片到本地
  ipcMain.handle('image:save-to-file', async (_, filename: string) => {
    const ext = filename.split('.').pop() || 'png'
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '保存图片',
      defaultPath: `图片_${Date.now()}.${ext}`,
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg'] }
      ]
    })

    if (result.canceled || !result.filePath) {
      return false
    }

    return exportImage(filename, result.filePath)
  })

  ipcMain.handle(IPC_CHANNELS.STORAGE_GET_INFO, (): StorageInfo => {
    storageInfo = resolveStorageInfo(defaultUserDataPath || app.getPath('userData'))
    return storageInfo
  })

  ipcMain.handle(IPC_CHANNELS.STORAGE_CHOOSE_DIRECTORY, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择新的数据目录',
      properties: ['openDirectory', 'createDirectory']
    })

    if (result.canceled || !result.filePaths[0]) {
      return null
    }

    return result.filePaths[0]
  })

  ipcMain.handle(
    IPC_CHANNELS.STORAGE_MIGRATE,
    async (_, targetDir: string): Promise<StorageMigrationResult> => {
      const sourceDir = app.getPath('userData')
      const defaultDir = defaultUserDataPath || sourceDir

      closeDatabase()
      const result = migrateStorageData(sourceDir, targetDir, defaultDir)

      if (!result.success) {
        initDatabase()
        return result
      }

      setTimeout(() => {
        app.relaunch()
        app.exit(0)
      }, 300)
      return result
    }
  )
}

function startApp(): void {
  const startSilently = shouldStartSilently()
  configureStorageDirectory()
  normalizeOpenAtLoginForSilentStartup()
  initDatabase()
  createWindow({ showOnCreate: !startSilently })
  createTray()
  registerShortcuts()
  setupIPC()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (isSilentStartupArgv(argv)) {
      return
    }

    showMainWindowFromUserAction()
  })

  app.whenReady().then(startApp)
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  closeDatabase()
})
