import { useEffect, useRef, useState } from 'react'
import TitleBar from './components/TitleBar'
import MemoInput from './components/MemoInput'
import MemoList from './components/MemoList'
import { useMemoStore } from './store/memoStore'
import { subscribeThemeMode } from './utils/theme'

declare global {
  interface Window {
    electronAPI: import('../preload/index').ElectronAPI
  }
}

const INPUT_PANEL_HEIGHT_KEY = 'memo-input-panel-height'
const DEFAULT_INPUT_PANEL_HEIGHT = 90

function getSavedInputPanelHeight(): number {
  const saved = localStorage.getItem(INPUT_PANEL_HEIGHT_KEY)
  if (saved) {
    const n = parseInt(saved, 10)
    if (n >= 60 && n <= 300) return n
  }
  return DEFAULT_INPUT_PANEL_HEIGHT
}

function App() {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const { loadMemos } = useMemoStore()
  const [inputPanelHeight, setInputPanelHeight] = useState(getSavedInputPanelHeight)

  useEffect(() => {
    loadMemos()
    const unsubscribeTheme = subscribeThemeMode()

    const unsubscribeFocus = window.electronAPI.window.onFocusInput(() => {
      inputRef.current?.focus()
    })

    const unsubscribeSync = window.electronAPI.sync.onComplete((result) => {
      if (result.success) loadMemos()
    })

    return () => {
      unsubscribeTheme()
      unsubscribeFocus()
      unsubscribeSync()
    }
  }, [loadMemos])

  const handleSnapToEdge = () => {
    window.electronAPI.window.snapToEdge()
  }

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = inputPanelHeight

    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'ns-resize'

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientY - startY
      const newH = Math.min(300, Math.max(60, startH + delta))
      setInputPanelHeight(newH)
    }

    const onUp = (ev: MouseEvent) => {
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      const delta = ev.clientY - startY
      const newH = Math.min(300, Math.max(60, startH + delta))
      localStorage.setItem(INPUT_PANEL_HEIGHT_KEY, String(newH))
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div className="window-shell">
      <TitleBar />

      {/* 输入区域（高度可拖拽） */}
      <div style={{ height: inputPanelHeight, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        <MemoInput inputRef={inputRef} textareaMaxHeight={inputPanelHeight - 28} />
      </div>

      {/* 拖拽分隔条 */}
      <div
        onMouseDown={handleResizeStart}
        className="h-1.5 flex-shrink-0 bg-slate-100 hover:bg-indigo-100 flex items-center justify-center transition-colors group"
        style={{ cursor: 'ns-resize' }}
        title="拖动调整输入区大小"
      >
        <div className="w-8 h-0.5 rounded-full bg-slate-300 group-hover:bg-indigo-400 transition-colors" />
      </div>

      <MemoList />

      {/* 吸附按钮 */}
      <button
        onClick={handleSnapToEdge}
        className="absolute bottom-2 left-2 p-1 rounded-md text-slate-300 hover:text-slate-500 hover:bg-slate-100 transition-colors cursor-pointer"
        title="吸附到边缘"
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13 5l7 7-7 7M5 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  )
}

export default App
