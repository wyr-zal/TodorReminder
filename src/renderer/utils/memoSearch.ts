import type { Memo } from '../../shared/types'

export interface HighlightSegment {
  text: string
  matched: boolean
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 获取参与搜索的可见正文，排除旧版纯图片待办的默认占位文本 */
export function getSearchableMemoContent(memo: Pick<Memo, 'type' | 'content'>): string {
  return memo.type === 'image' && memo.content === '图片备忘' ? '' : memo.content
}

/** 判断待办正文或标签是否包含搜索词（不区分大小写，支持带 # 前缀搜标签） */
export function matchesMemoSearch(
  memo: Pick<Memo, 'type' | 'content' | 'tags'>,
  rawQuery: string
): boolean {
  const query = rawQuery.trim().toLowerCase()
  if (!query) return true

  if (getSearchableMemoContent(memo).toLowerCase().includes(query)) {
    return true
  }

  const tags = memo.tags || []
  if (query.startsWith('#')) {
    const tagQuery = query.slice(1)
    if (!tagQuery) return false
    return tags.some((tag) => tag.toLowerCase().includes(tagQuery))
  }

  return tags.some((tag) => tag.toLowerCase().includes(query))
}

/** 按搜索词切分文本为普通/高亮片段，保留原始大小写 */
export function splitHighlightSegments(text: string, rawQuery: string): HighlightSegment[] {
  const query = rawQuery.trim()
  if (!text || !query) return [{ text, matched: false }]

  const pattern = new RegExp(escapeRegExp(query), 'gi')
  const segments: HighlightSegment[] = []
  let lastIndex = 0

  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0
    const matchedText = match[0]
    if (!matchedText) continue
    if (start > lastIndex) {
      segments.push({ text: text.slice(lastIndex, start), matched: false })
    }
    segments.push({ text: matchedText, matched: true })
    lastIndex = start + matchedText.length
  }

  if (lastIndex === 0) return [{ text, matched: false }]
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), matched: false })
  }
  return segments
}

/** 切分带 # 展示的标签高亮片段，与 matchesMemoSearch 规则一致 */
export function splitTagHighlightSegments(tag: string, rawQuery: string): HighlightSegment[] {
  const query = rawQuery.trim()
  const displayTag = `#${tag}`
  if (!query || query === '#') return [{ text: displayTag, matched: false }]

  if (query.startsWith('#')) {
    if (displayTag.toLowerCase().includes(query.toLowerCase())) {
      return splitHighlightSegments(displayTag, query)
    }
    return [{ text: '#', matched: false }, ...splitHighlightSegments(tag, query.slice(1))]
  }

  return [{ text: '#', matched: false }, ...splitHighlightSegments(tag, query)]
}
