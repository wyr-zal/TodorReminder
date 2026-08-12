import type { ClipboardCopyResult, MemoClipboardPayloadV1, Priority } from './types'

export const MEMO_CLIPBOARD_MARKER = 'focus-memo:v1'

export interface ClipboardImageData {
  dataUrl: string
  pngHex: string
  width: number
  height: number
}

export interface MemoClipboardFormats {
  text: string
  html: string
  rtf: string
}

export interface ParsedMemoClipboard {
  payload: MemoClipboardPayloadV1
  images: string[]
}

export interface TextInsertionResult {
  value: string
  caret: number
}

const priorities: Priority[] = ['high', 'medium', 'low']

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeRtf(value: string): string {
  let output = ''

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    const code = value.charCodeAt(index)

    if (char === '\\' || char === '{' || char === '}') {
      output += `\\${char}`
    } else if (char === '\r' && value[index + 1] === '\n') {
      output += '\\par\n'
      index += 1
    } else if (char === '\n' || char === '\r') {
      output += '\\par\n'
    } else if (code >= 0x20 && code <= 0x7e) {
      output += char
    } else {
      const signedCode = code > 0x7fff ? code - 0x10000 : code
      output += `\\u${signedCode}?`
    }
  }

  return output
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))]
}

export function formatMemoText(content: string, tags: string[]): string {
  const tagText = normalizeTags(tags).map((tag) => `#${tag}`).join(' ')
  return [content.trim(), tagText].filter(Boolean).join('\n')
}

export function insertTextAtSelection(
  currentValue: string,
  insertedText: string,
  selectionStart: number,
  selectionEnd: number
): TextInsertionResult {
  const start = Math.max(0, Math.min(selectionStart, currentValue.length))
  const end = Math.max(start, Math.min(selectionEnd, currentValue.length))

  return {
    value: `${currentValue.slice(0, start)}${insertedText}${currentValue.slice(end)}`,
    caret: start + insertedText.length
  }
}

export function createMemoClipboardPayload(
  content: string,
  priority: Priority,
  tags: string[],
  imageCount: number
): MemoClipboardPayloadV1 {
  return {
    version: 1,
    content,
    priority,
    tags: normalizeTags(tags),
    imageCount: Math.max(0, Math.floor(imageCount))
  }
}

export function createClipboardCopyResult(
  requestedImageCount: number,
  copiedImageCount: number,
  error?: string
): ClipboardCopyResult {
  const requested = Math.max(0, Math.floor(requestedImageCount))
  const copied = Math.max(0, Math.min(requested, Math.floor(copiedImageCount)))

  return {
    success: !error,
    copiedImageCount: copied,
    missingImageCount: requested - copied,
    ...(error ? { error } : {})
  }
}

function encodePayload(payload: MemoClipboardPayloadV1): string {
  return encodeURIComponent(JSON.stringify(payload))
}

function decodePayload(value: string): MemoClipboardPayloadV1 | null {
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Partial<MemoClipboardPayloadV1>
    if (
      parsed.version !== 1
      || typeof parsed.content !== 'string'
      || !priorities.includes(parsed.priority as Priority)
      || !Array.isArray(parsed.tags)
      || parsed.tags.some((tag) => typeof tag !== 'string')
      || typeof parsed.imageCount !== 'number'
      || !Number.isInteger(parsed.imageCount)
      || parsed.imageCount < 0
    ) {
      return null
    }

    return createMemoClipboardPayload(
      parsed.content,
      parsed.priority as Priority,
      parsed.tags as string[],
      parsed.imageCount
    )
  } catch {
    return null
  }
}

function buildMemoHtml(payload: MemoClipboardPayloadV1, images: ClipboardImageData[]): string {
  const text = formatMemoText(payload.content, payload.tags)
  const encodedPayload = encodePayload(payload)
  const imageHtml = images
    .map((image, index) => (
      `<div><img data-focus-memo-image="${index}" src="${image.dataUrl}" alt="" style="max-width:100%;height:auto;" /></div>`
    ))
    .join('')

  return [
    `<!--${MEMO_CLIPBOARD_MARKER}:${encodedPayload}-->`,
    `<div data-focus-memo-root="v1" data-focus-memo-payload="${encodedPayload}">`,
    `<div style="white-space:pre-wrap;">${escapeHtml(text)}</div>`,
    imageHtml,
    '</div>'
  ].join('')
}

function buildRtfImage(image: ClipboardImageData): string {
  const width = Math.max(1, image.width)
  const height = Math.max(1, image.height)
  const naturalWidthTwips = width * 15
  const widthGoal = Math.min(9000, naturalWidthTwips)
  const heightGoal = Math.max(1, Math.round(height * (widthGoal / width)))

  return [
    '{\\pict\\pngblip',
    `\\picw${width}\\pich${height}`,
    `\\picwgoal${widthGoal}\\pichgoal${heightGoal}`,
    `\n${image.pngHex}\n`,
    '}\\par\n'
  ].join('')
}

function buildMemoRtf(payload: MemoClipboardPayloadV1, images: ClipboardImageData[]): string {
  const text = escapeRtf(formatMemoText(payload.content, payload.tags))
  const imageRtf = images.map(buildRtfImage).join('')
  return `{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1 ${text}\\par\n${imageRtf}}`
}

export function buildMemoClipboardFormats(
  payload: MemoClipboardPayloadV1,
  images: ClipboardImageData[]
): MemoClipboardFormats {
  return {
    text: formatMemoText(payload.content, payload.tags),
    html: buildMemoHtml(payload, images),
    rtf: buildMemoRtf(payload, images)
  }
}

export function shouldIncludeNativeClipboardImage(text: string, imageCount: number): boolean {
  return text.trim().length === 0 && imageCount > 0
}

export function buildMemoCliText(content: string, tags: string[], imagePaths: string[]): string {
  const text = formatMemoText(content, tags)
  const validPaths = imagePaths.map((path) => path.trim()).filter(Boolean)

  if (validPaths.length === 0) {
    return text
  }

  return [text, ['图片路径:', ...validPaths].join('\n')].filter(Boolean).join('\n\n')
}

export function parseMemoClipboardHtml(html: string): ParsedMemoClipboard | null {
  const markerPattern = new RegExp(`<!--${MEMO_CLIPBOARD_MARKER.replace(':', '\\:')}:([^]*?)-->`)
  const markerMatch = html.match(markerPattern)
  const attributeMatch = html.match(/\bdata-focus-memo-payload=["']([^"']+)["']/i)
  const encodedPayload = markerMatch?.[1] || attributeMatch?.[1]
  if (!encodedPayload) return null

  const payload = decodePayload(encodedPayload)
  if (!payload) return null

  const indexedImages: Array<{ index: number; dataUrl: string }> = []
  const imageTags = html.match(/<img\b[^>]*>/gi) || []

  imageTags.forEach((tag) => {
    const indexMatch = tag.match(/\bdata-focus-memo-image=["'](\d+)["']/i)
    const sourceMatch = tag.match(/\bsrc=["'](data:image\/(?:png|jpeg);base64,[a-z0-9+/=]+)["']/i)
    if (!indexMatch || !sourceMatch) return

    indexedImages.push({
      index: Number.parseInt(indexMatch[1], 10),
      dataUrl: sourceMatch[1]
    })
  })

  indexedImages.sort((left, right) => left.index - right.index)

  return {
    payload,
    images: indexedImages
      .slice(0, payload.imageCount)
      .map((image) => image.dataUrl)
  }
}
