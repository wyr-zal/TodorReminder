import { useState } from 'react'
import { useWindowStore } from '../store/windowStore'
import SyncSettings from './SyncSettings'
import TrashBin from './TrashBin'

function TitleBar() {
  const { isPinned, togglePin } = useWindowStore()
  const [showSyncSettings, setShowSyncSettings] = useState(false)
  const [showTrashBin, setShowTrashBin] = useState(false)

  const handleClose = () => {
    window.electronAPI.window.minimize()
  }

  return (
    <>
      <div className="drag-region flex items-center justify-between px-3 py-2 bg-[#1e1e2e] rounded-t-[11px]">
        {/* 品牌区域 */}
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-indigo-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="1" width="10" height="13" rx="1.5" />
            <path d="M5 5h6M5 8h6M5 11h4" />
            <path d="M12 4l2 2-4 4-2-1 1-2 3-3z" fill="currentColor" stroke="none" className="text-indigo-400" />
          </svg>
          <span className="text-[13px] font-medium text-white/80 tracking-tight select-none">专注备忘</span>
        </div>

        {/* 工具按钮组 */}
        <div className="no-drag flex items-center gap-0.5">
          {/* 回收站 */}
          <button
            onClick={() => setShowTrashBin(true)}
            className="p-1.5 rounded-md text-white/40 hover:text-white/80 hover:bg-white/10 transition-colors cursor-pointer"
            title="回收站"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
              <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
            </svg>
          </button>

          {/* 设置 */}
          <button
            onClick={() => setShowSyncSettings(true)}
            className="p-1.5 rounded-md text-white/40 hover:text-white/80 hover:bg-white/10 transition-colors cursor-pointer"
            title="同步设置"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.07 4.93l-1.41 1.41M4.93 4.93l1.41 1.41M12 2v2M12 20v2M20 12h2M2 12h2M19.07 19.07l-1.41-1.41M4.93 19.07l1.41-1.41" />
            </svg>
          </button>

          {/* 置顶 */}
          <button
            onClick={togglePin}
            className={`p-1.5 rounded-md hover:bg-white/10 transition-colors cursor-pointer ${
              isPinned ? 'text-indigo-400' : 'text-white/40 hover:text-white/80'
            }`}
            title={isPinned ? '取消置顶' : '始终置顶'}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2l2.4 6H20l-4.8 3.6 1.8 6L12 14.4 7 17.6l1.8-6L4 8h5.6z" />
            </svg>
          </button>

          {/* 隐藏到托盘 */}
          <button
            onClick={handleClose}
            className="p-1.5 rounded-md text-white/40 hover:text-white/80 hover:bg-white/10 transition-colors cursor-pointer"
            title="隐藏到托盘"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round">
              <path d="M5 12h14" />
            </svg>
          </button>
        </div>
      </div>

      {showSyncSettings && (
        <SyncSettings onClose={() => setShowSyncSettings(false)} />
      )}

      {showTrashBin && (
        <TrashBin
          onClose={() => setShowTrashBin(false)}
          onRestored={() => window.location.reload()}
        />
      )}
    </>
  )
}

export default TitleBar
