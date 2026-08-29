import { useState, useEffect } from 'react'

interface Memo {
  id: string
  content: string
  type: 'text' | 'image'
  priority: 'high' | 'medium' | 'low'
  updatedAt: string
  attachments: string[]
}

interface TrashBinProps {
  onClose: () => void
  onRestored: () => void
}

function TrashBin({ onClose, onRestored }: TrashBinProps) {
  const [deletedMemos, setDeletedMemos] = useState<Memo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadDeletedMemos()
  }, [])

  const loadDeletedMemos = async () => {
    setLoading(true)
    const memos = await window.electronAPI.memo.getDeleted()
    setDeletedMemos(memos)
    setLoading(false)
  }

  const handleRestore = async (id: string) => {
    await window.electronAPI.memo.restore(id)
    setDeletedMemos(prev => prev.filter(m => m.id !== id))
    onRestored()
  }

  const handleHardDelete = async (id: string) => {
    if (confirm('确定永久删除？此操作不可恢复。')) {
      await window.electronAPI.memo.hardDelete(id)
      setDeletedMemos(prev => prev.filter(m => m.id !== id))
    }
  }

  const handleClearAll = async () => {
    if (confirm('确定清空回收站？此操作不可恢复。')) {
      for (const memo of deletedMemos) {
        await window.electronAPI.memo.hardDelete(memo.id)
      }
      setDeletedMemos([])
    }
  }

  const priorityColors = {
    high: 'border-l-red-500',
    medium: 'border-l-yellow-500',
    low: 'border-l-green-500'
  }

  return (
    <div data-modal className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-80 max-h-[80vh] flex flex-col">
        <div className="flex justify-between items-center p-4 border-b">
          <h2 className="text-lg font-semibold">回收站</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <p className="text-center text-gray-400 py-8">加载中...</p>
          ) : deletedMemos.length === 0 ? (
            <p className="text-center text-gray-400 py-8">回收站为空</p>
          ) : (
            <div className="space-y-2">
              {deletedMemos.map(memo => (
                <div
                  key={memo.id}
                  className={`p-2 bg-gray-50 rounded border-l-4 ${priorityColors[memo.priority]}`}
                >
                  <p className="text-sm text-gray-600 truncate mb-1">
                    {memo.type === 'image' ? '[图片]' : memo.content}
                  </p>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-gray-400">
                      {new Date(memo.updatedAt).toLocaleDateString()}
                    </span>
                    <div className="flex gap-1">
                      <button
                        onClick={() => handleRestore(memo.id)}
                        className="px-2 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600"
                        title="恢复"
                      >
                        恢复
                      </button>
                      <button
                        onClick={() => handleHardDelete(memo.id)}
                        className="px-2 py-1 text-xs bg-red-500 text-white rounded hover:bg-red-600"
                        title="永久删除"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {deletedMemos.length > 0 && (
          <div className="p-3 border-t">
            <button
              onClick={handleClearAll}
              className="w-full px-3 py-2 text-sm text-red-500 hover:bg-red-50 rounded"
            >
              清空回收站
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default TrashBin
