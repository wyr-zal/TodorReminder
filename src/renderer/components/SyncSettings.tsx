import { useState, useEffect } from 'react'
import { StorageInfo, TagSortMode } from '../../shared/types'
import { useMemoStore } from '../store/memoStore'
import { getThemeMode, saveThemeMode, ThemeMode } from '../utils/theme'

interface SyncConfig {
  token: string
  repo: string
}

interface AppSettings {
  imageCompression: boolean
  imageMaxSize: number
  imageMaxWidth: number
}

interface SyncSettingsProps {
  onClose: () => void
}

type TabKey = 'sync' | 'image' | 'display' | 'storage'

const tabs: { key: TabKey; label: string }[] = [
  { key: 'sync', label: 'GitHub 同步' },
  { key: 'image', label: '图片设置' },
  { key: 'display', label: '显示' },
  { key: 'storage', label: '数据位置' }
]

const sortOptions: { value: TagSortMode; label: string; desc: string }[] = [
  { value: 'latest', label: '最新优先', desc: '按最近更新时间排序' },
  { value: 'count', label: '数量优先', desc: '按未完成任务数排序' },
  { value: 'alpha', label: '字母排序', desc: '按标签名称升序排列' }
]

const themeOptions: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
]

function ThemeIcon({ mode }: { mode: ThemeMode }) {
  if (mode === 'light') {
    return (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
    )
  }

  if (mode === 'dark') {
    return (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20.5 14.1A8.4 8.4 0 019.9 3.5 8.5 8.5 0 1020.5 14.1z" />
      </svg>
    )
  }

  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      className={`relative w-10 h-5 rounded-full transition-colors cursor-pointer ${checked ? 'bg-indigo-500' : 'bg-slate-200'}`}
    >
      <div className={`theme-toggle-knob absolute top-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  )
}

function SyncSettings({ onClose }: SyncSettingsProps) {
  const [config, setConfig] = useState<SyncConfig>({ token: '', repo: '' })
  const [settings, setSettings] = useState<AppSettings>({
    imageCompression: true,
    imageMaxSize: 500,
    imageMaxWidth: 1200
  })
  const [status, setStatus] = useState<{ lastSync: string | null; isSyncing: boolean; error: string | null }>({
    lastSync: null,
    isSyncing: false,
    error: null
  })
  const [message, setMessage] = useState('')
  const [activeTab, setActiveTab] = useState<TabKey>('sync')
  const [themeMode, setThemeModeState] = useState<ThemeMode>(getThemeMode)
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null)
  const [selectedStorageDir, setSelectedStorageDir] = useState('')
  const [storageMessage, setStorageMessage] = useState('')
  const [isMigratingStorage, setIsMigratingStorage] = useState(false)
  const { tagSort, setTagSort } = useMemoStore()

  useEffect(() => {
    loadConfig()
    loadStatus()
    loadSettings()
    loadStorageInfo()
  }, [])

  const loadConfig = async () => {
    const savedConfig = await window.electronAPI.sync.getConfig()
    if (savedConfig) setConfig({ token: savedConfig.token, repo: savedConfig.repo })
  }

  const loadStatus = async () => {
    const s = await window.electronAPI.sync.getStatus()
    setStatus(s)
  }

  const loadSettings = async () => {
    const s = await window.electronAPI.settings.get()
    setSettings(s)
  }

  const loadStorageInfo = async () => {
    const info = await window.electronAPI.storage.getInfo()
    setStorageInfo(info)
    if (info.error) {
      setStorageMessage(info.error)
    }
  }

  const showMessage = (msg: string) => {
    setMessage(msg)
    setTimeout(() => setMessage(''), 2000)
  }

  const handleSave = async () => {
    if (!config.token || !config.repo) { showMessage('请填写 Token 和仓库名'); return }
    await window.electronAPI.sync.setConfig(config)
    showMessage('配置已保存')
  }

  const handleSync = async () => {
    if (!config.token || !config.repo) { showMessage('请先配置 Token 和仓库名'); return }
    await window.electronAPI.sync.startBackground()
    onClose()
  }

  const handleSettingsSave = async () => {
    await window.electronAPI.settings.set(settings)
    showMessage('设置已保存')
  }

  const handleThemeChange = (mode: ThemeMode) => {
    setThemeModeState(mode)
    saveThemeMode(mode)
  }

  const handleChooseStorageDir = async () => {
    const dir = await window.electronAPI.storage.chooseDirectory()
    if (dir) {
      setSelectedStorageDir(dir)
      setStorageMessage('')
    }
  }

  const handleStorageMigration = async () => {
    if (!selectedStorageDir) {
      setStorageMessage('请先选择新的空目录')
      return
    }

    setIsMigratingStorage(true)
    setStorageMessage('正在迁移数据，请不要关闭软件...')

    try {
      const result = await window.electronAPI.storage.migrate(selectedStorageDir)
      if (result.success) {
        const warningText = result.warnings.length > 0 ? `；${result.warnings.join('；')}` : ''
        setStorageMessage(`迁移完成，正在重启${warningText}`)
      } else {
        setStorageMessage(result.error || '迁移失败')
        setIsMigratingStorage(false)
        await loadStorageInfo()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStorageMessage(`迁移失败：${message}`)
      setIsMigratingStorage(false)
      await loadStorageInfo()
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 backdrop-blur-[2px]">
      <div className="bg-white rounded-2xl shadow-2xl w-[360px] overflow-hidden border border-slate-100">
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4">
          <h2 className="text-[15px] font-semibold text-slate-800 tracking-tight">设置</h2>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-md transition-colors cursor-pointer"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5" strokeLinecap="round">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tab 导航 */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-slate-100 px-5">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`pb-2.5 text-[12px] font-medium transition-colors cursor-pointer border-b-2 -mb-px ${
                activeTab === tab.key
                  ? 'border-indigo-500 text-indigo-600'
                  : 'border-transparent text-slate-400 hover:text-slate-600'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab 内容 */}
        <div className="px-5 py-4">

          {/* ── GitHub 同步 ── */}
          {activeTab === 'sync' && (
            <div className="space-y-3.5">
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1.5 tracking-wide uppercase">Personal Access Token</label>
                <input
                  type="password"
                  value={config.token}
                  onChange={(e) => setConfig(prev => ({ ...prev, token: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/25 focus:border-indigo-400 focus:bg-white transition-all"
                  placeholder="ghp_xxxxxxxxxxxx"
                />
                <p className="text-[11px] text-slate-400 mt-1">需要 repo 权限</p>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1.5 tracking-wide uppercase">仓库名称</label>
                <input
                  type="text"
                  value={config.repo}
                  onChange={(e) => setConfig(prev => ({ ...prev, repo: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/25 focus:border-indigo-400 focus:bg-white transition-all"
                  placeholder="username/repo-name"
                />
              </div>

              {status.lastSync && (
                <p className="text-[11px] text-slate-400">
                  上次同步：{new Date(status.lastSync).toLocaleString('zh-CN')}
                </p>
              )}

              {message && (
                <p className={`text-[12px] font-medium ${message.includes('失败') || message.includes('请') ? 'text-rose-500' : 'text-emerald-600'}`}>
                  {message}
                </p>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleSave}
                  className="flex-1 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-[12px] font-medium transition-colors cursor-pointer"
                >
                  保存配置
                </button>
                <button
                  onClick={handleSync}
                  disabled={!config.token || !config.repo}
                  className="flex-1 px-3 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-[12px] font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  立即同步
                </button>
              </div>
            </div>
          )}

          {/* ── 图片设置 ── */}
          {activeTab === 'image' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-700">启用图片压缩</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">减小图片文件大小</p>
                </div>
                <Toggle
                  checked={settings.imageCompression}
                  onChange={() => setSettings(prev => ({ ...prev, imageCompression: !prev.imageCompression }))}
                />
              </div>

              {settings.imageCompression && (
                <div className="space-y-3 pt-1 border-t border-slate-100">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1.5 tracking-wide uppercase">最大文件大小 (KB)</label>
                    <input
                      type="number"
                      value={settings.imageMaxSize}
                      onChange={(e) => setSettings(prev => ({ ...prev, imageMaxSize: parseInt(e.target.value) || 500 }))}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/25 focus:border-indigo-400 focus:bg-white transition-all"
                      min={100} max={5000}
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1.5 tracking-wide uppercase">最大宽度 (px)</label>
                    <input
                      type="number"
                      value={settings.imageMaxWidth}
                      onChange={(e) => setSettings(prev => ({ ...prev, imageMaxWidth: parseInt(e.target.value) || 1200 }))}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/25 focus:border-indigo-400 focus:bg-white transition-all"
                      min={400} max={4000}
                    />
                  </div>
                </div>
              )}

              <p className="text-[11px] text-slate-400">
                {settings.imageCompression
                  ? `超过 ${settings.imageMaxSize} KB 或宽度超过 ${settings.imageMaxWidth} px 的图片会被自动压缩`
                  : '图片将以原始大小保存'}
              </p>

              {message && (
                <p className={`text-[12px] font-medium ${message.includes('失败') ? 'text-rose-500' : 'text-emerald-600'}`}>
                  {message}
                </p>
              )}

              <button
                onClick={handleSettingsSave}
                className="w-full px-3 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-[12px] font-medium transition-colors cursor-pointer"
              >
                保存设置
              </button>
            </div>
          )}

          {/* ── 显示设置 ── */}
          {activeTab === 'display' && (
            <div className="space-y-4">
              <div className="pb-4 border-b border-slate-100">
                <p className="text-[11px] font-medium text-slate-500 mb-2.5 tracking-wide uppercase">界面主题</p>
                <div className="grid grid-cols-3 gap-1.5">
                  {themeOptions.map(option => {
                    const active = themeMode === option.value
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => handleThemeChange(option.value)}
                        aria-pressed={active}
                        className={`flex flex-col items-center justify-center gap-1.5 px-2 py-2.5 rounded-lg border text-[11px] font-medium transition-colors cursor-pointer ${
                          active
                            ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                            : 'bg-white border-slate-100 text-slate-500 hover:border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <ThemeIcon mode={option.value} />
                        <span>{option.label}</span>
                      </button>
                    )
                  })}
                </div>
                <p className="text-[11px] text-slate-400 mt-2">跟随系统会在 Windows 切换主题时自动更新</p>
              </div>

              <div>
                <p className="text-[11px] font-medium text-slate-500 mb-3 tracking-wide uppercase">标签排序方式</p>
                <div className="space-y-2">
                  {sortOptions.map(opt => {
                    const active = tagSort === opt.value
                    return (
                      <button
                        key={opt.value}
                        onClick={() => setTagSort(opt.value)}
                        className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                          active
                            ? 'bg-indigo-50 border-indigo-200'
                            : 'bg-white border-slate-100 hover:border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        {/* 单选圆点 */}
                        <div className={`flex-shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors ${
                          active ? 'border-indigo-500' : 'border-slate-300'
                        }`}>
                          {active && <div className="w-2 h-2 rounded-full bg-indigo-500" />}
                        </div>
                        <div>
                          <p className={`text-[13px] font-medium leading-tight ${active ? 'text-indigo-700' : 'text-slate-700'}`}>
                            {opt.label}
                          </p>
                          <p className="text-[11px] text-slate-400 mt-0.5">{opt.desc}</p>
                        </div>
                        {active && (
                          <svg className="w-3.5 h-3.5 text-indigo-400 ml-auto flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>

              <p className="text-[11px] text-slate-400 pt-1">切换后立即生效，自动保存</p>
            </div>
          )}

          {/* ── 数据位置 ── */}
          {activeTab === 'storage' && (
            <div className="space-y-4">
              <div className="space-y-3">
                <div>
                  <p className="text-[11px] font-medium text-slate-500 mb-1.5 tracking-wide uppercase">当前数据目录</p>
                  <p className="px-3 py-2 text-[11px] leading-relaxed break-all bg-slate-50 border border-slate-100 rounded-lg text-slate-600">
                    {storageInfo?.currentDir || '正在读取...'}
                  </p>
                </div>

                <div>
                  <p className="text-[11px] font-medium text-slate-500 mb-1.5 tracking-wide uppercase">默认数据目录</p>
                  <p className="px-3 py-2 text-[11px] leading-relaxed break-all bg-slate-50 border border-slate-100 rounded-lg text-slate-500">
                    {storageInfo?.defaultDir || '正在读取...'}
                  </p>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-100 space-y-3">
                <div>
                  <p className="text-sm font-medium text-slate-700">迁移到新的空目录</p>
                  <p className="text-[11px] text-slate-400 mt-1">
                    会复制文字数据库、图片附件、设置和同步数据；原目录不会删除。迁移完成后软件会自动重启。
                  </p>
                </div>

                {selectedStorageDir && (
                  <p className="px-3 py-2 text-[11px] leading-relaxed break-all bg-indigo-50 border border-indigo-100 rounded-lg text-indigo-700">
                    {selectedStorageDir}
                  </p>
                )}

                {storageMessage && (
                  <p className={`text-[12px] font-medium leading-relaxed ${
                    storageMessage.includes('失败')
                    || storageMessage.includes('不可')
                    || storageMessage.includes('必须')
                    || storageMessage.includes('不能')
                    || storageMessage.includes('请选择')
                      ? 'text-rose-500'
                      : 'text-emerald-600'
                  }`}>
                    {storageMessage}
                  </p>
                )}

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleChooseStorageDir}
                    disabled={isMigratingStorage}
                    className="flex-1 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-[12px] font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    选择目录
                  </button>
                  <button
                    type="button"
                    onClick={handleStorageMigration}
                    disabled={!selectedStorageDir || isMigratingStorage}
                    className="flex-1 px-3 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-[12px] font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {isMigratingStorage ? '迁移中...' : '开始迁移'}
                  </button>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}

export default SyncSettings
