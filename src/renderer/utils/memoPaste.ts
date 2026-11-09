import { parseMemoClipboardHtml } from '../../shared/memoClipboard'

export function readStructuredMemoClipboard(clipboardData: DataTransfer) {
  return parseMemoClipboardHtml(clipboardData.getData('text/html'))
}

export async function saveClipboardImages(images: string[]): Promise<string[]> {
  const filenames: string[] = []

  for (const image of images) {
    try {
      const filename = await window.electronAPI.image.save(image)
      if (filename) filenames.push(filename)
    } catch (error) {
      console.error('Failed to save clipboard image:', error)
    }
  }

  return filenames
}

export class ClipboardImageSaveError extends Error {
  constructor(message: string, readonly uncommittedFilenames: string[]) {
    super(message)
    this.name = 'ClipboardImageSaveError'
  }
}

export async function saveClipboardImagesStrict(images: string[]): Promise<string[]> {
  const filenames: string[] = []
  let failedCount = 0

  for (const image of images) {
    try {
      const filename = await window.electronAPI.image.save(image)
      if (filename) filenames.push(filename)
      else failedCount += 1
    } catch (error) {
      console.error('Failed to save clipboard image:', error)
      failedCount += 1
    }
  }

  if (failedCount > 0) {
    const cleanupResults = await Promise.all(filenames.map(async filename => {
      try {
        return await window.electronAPI.image.delete(filename)
      } catch (error) {
        console.error('Failed to remove partially saved clipboard image:', error)
        return false
      }
    }))
    const uncommittedFilenames = filenames.filter((_, index) => !cleanupResults[index])
    const cleanupMessage = uncommittedFilenames.length > 0 ? '部分已保存图片未能自动清理，请检查附件。' : ''
    throw new ClipboardImageSaveError(
      `${failedCount} 张图片保存失败，请重试粘贴。${cleanupMessage}`,
      uncommittedFilenames
    )
  }

  return filenames
}

export function restoreTextareaSelection(textarea: HTMLTextAreaElement, caret: number) {
  window.requestAnimationFrame(() => {
    textarea.focus()
    textarea.setSelectionRange(caret, caret)
  })
}
