export const THEME_MODES = ['system', 'light', 'dark'] as const

export type ThemeMode = (typeof THEME_MODES)[number]
export type ResolvedTheme = Exclude<ThemeMode, 'system'>

const THEME_STORAGE_KEY = 'focus-memo-theme-mode'
const THEME_CHANGE_EVENT = 'focus-memo:theme-change'
const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'

export function isThemeMode(value: string | null): value is ThemeMode {
  return THEME_MODES.includes(value as ThemeMode)
}

export function getThemeMode(): ThemeMode {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  return isThemeMode(stored) ? stored : 'system'
}

export function resolveThemeMode(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === 'system') return systemPrefersDark ? 'dark' : 'light'
  return mode
}

export function applyThemeMode(mode: ThemeMode = getThemeMode()): ResolvedTheme {
  const resolved = resolveThemeMode(mode, window.matchMedia(SYSTEM_DARK_QUERY).matches)
  const root = document.documentElement

  root.classList.toggle('dark', resolved === 'dark')
  root.dataset.theme = resolved
  root.style.colorScheme = resolved

  return resolved
}

export function saveThemeMode(mode: ThemeMode): void {
  window.localStorage.setItem(THEME_STORAGE_KEY, mode)
  applyThemeMode(mode)
  window.dispatchEvent(new CustomEvent<ThemeMode>(THEME_CHANGE_EVENT, { detail: mode }))
}

export function subscribeThemeMode(): () => void {
  const media = window.matchMedia(SYSTEM_DARK_QUERY)
  const syncTheme = () => applyThemeMode(getThemeMode())
  const handleSystemChange = () => {
    if (getThemeMode() === 'system') syncTheme()
  }

  media.addEventListener('change', handleSystemChange)
  window.addEventListener(THEME_CHANGE_EVENT, syncTheme)
  window.addEventListener('storage', syncTheme)

  return () => {
    media.removeEventListener('change', handleSystemChange)
    window.removeEventListener(THEME_CHANGE_EVENT, syncTheme)
    window.removeEventListener('storage', syncTheme)
  }
}
