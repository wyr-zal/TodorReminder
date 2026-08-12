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

export function restoreTextareaSelection(textarea: HTMLTextAreaElement, caret: number) {
  window.requestAnimationFrame(() => {
    textarea.focus()
    textarea.setSelectionRange(caret, caret)
  })
}
