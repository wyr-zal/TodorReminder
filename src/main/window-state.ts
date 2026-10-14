import * as fs from 'node:fs'
import { dirname } from 'node:path'
import type { FixedWindowPosition } from '../shared/types'

export interface WindowBoundsState {
  x: number
  y: number
  width: number
  height: number
}

interface WindowBoundsLimits {
  minWidth: number
  minHeight: number
}

interface WorkAreaBounds {
  x: number
  y: number
  width: number
  height: number
}

function clamp(value: number, min: number, max: number): number {
  if (min > max) {
    return min
  }

  return Math.min(Math.max(value, min), max)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isValidWindowBounds(value: unknown, limits: WindowBoundsLimits): value is WindowBoundsState {
  if (!value || typeof value !== 'object') {
    return false
  }

  const { x, y, width, height } = value as Partial<WindowBoundsState>

  return isFiniteNumber(x)
    && isFiniteNumber(y)
    && isFiniteNumber(width)
    && isFiniteNumber(height)
    && width >= limits.minWidth
    && height >= limits.minHeight
}

export function constrainWindowBounds(
  bounds: WindowBoundsState,
  workArea: WorkAreaBounds,
  limits: WindowBoundsLimits
): WindowBoundsState {
  const maxWidth = Math.max(workArea.width, limits.minWidth)
  const maxHeight = Math.max(workArea.height, limits.minHeight)
  const width = clamp(bounds.width, limits.minWidth, maxWidth)
  const height = clamp(bounds.height, limits.minHeight, maxHeight)
  const maxX = workArea.x + Math.max(workArea.width - width, 0)
  const maxY = workArea.y + Math.max(workArea.height - height, 0)

  return {
    x: clamp(bounds.x, workArea.x, maxX),
    y: clamp(bounds.y, workArea.y, maxY),
    width,
    height
  }
}

export function getFixedPositionBounds(
  position: FixedWindowPosition,
  bounds: WindowBoundsState,
  workArea: WorkAreaBounds
): Pick<WindowBoundsState, 'x' | 'y'> {
  const centerX = Math.round(workArea.x + (workArea.width - bounds.width) / 2)
  const centerY = Math.round(workArea.y + (workArea.height - bounds.height) / 2)
  let x = workArea.x + workArea.width - bounds.width - 20
  let y = centerY

  switch (position) {
    case 'left-center':
      x = workArea.x + 20
      break
    case 'right-center':
      break
    case 'top-center':
      x = centerX
      y = workArea.y + 20
      break
    case 'bottom-center':
      x = centerX
      y = workArea.y + workArea.height - bounds.height - 20
      break
    default:
      break
  }

  return {
    x: clamp(Math.round(x), workArea.x, workArea.x + Math.max(workArea.width - bounds.width, 0)),
    y: clamp(Math.round(y), workArea.y, workArea.y + Math.max(workArea.height - bounds.height, 0))
  }
}

export function loadWindowState(
  filePath: string,
  defaults: WindowBoundsState,
  limits: WindowBoundsLimits
): WindowBoundsState {
  try {
    if (!fs.existsSync(filePath)) {
      return defaults
    }

    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed: unknown = JSON.parse(raw)

    if (isValidWindowBounds(parsed, limits)) {
      return {
        x: parsed.x,
        y: parsed.y,
        width: parsed.width,
        height: parsed.height
      }
    }
  } catch (error) {
    console.error('Failed to load window state:', error)
  }

  return defaults
}

export function saveWindowState(filePath: string, bounds: WindowBoundsState): void {
  try {
    fs.mkdirSync(dirname(filePath), { recursive: true })
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height
        },
        null,
        2
      )
    )
  } catch (error) {
    console.error('Failed to save window state:', error)
  }
}
