import { create } from 'zustand'

type EdgeState = 'left' | 'right' | 'top' | null

interface WindowState {
  isPinned: boolean
  edgeState: EdgeState
  isHidden: boolean

  // Actions
  togglePin: () => Promise<void>
  setEdgeState: (edge: EdgeState) => void
  setIsHidden: (hidden: boolean) => void
  showFromEdge: () => void
}

export const useWindowStore = create<WindowState>((set) => ({
  isPinned: true,
  edgeState: null,
  isHidden: false,

  togglePin: async () => {
    const newState = await window.electronAPI.window.togglePin()
    set({ isPinned: newState })
  },

  setEdgeState: (edge: EdgeState) => {
    set({ edgeState: edge })
  },

  setIsHidden: (hidden: boolean) => {
    set({ isHidden: hidden })
  },

  showFromEdge: () => {
    window.electronAPI.window.showFromEdge()
    set({ isHidden: false })
  }
}))
