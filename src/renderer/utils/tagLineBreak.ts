const TAG_PATTERN = /#([一-龥\w-]+)/g

export interface TagLineBreakResult {
  value: string
  caret: number
}

// 把正文行内（前面已有非空白内容）的 #标签 移到下一行，并返回修正后的光标位置。
// 标签已在行首时保持不变，因此可重复调用。
export function breakInlineTags(text: string, caret: number): TagLineBreakResult {
  const segments: string[] = []
  let lastIndex = 0
  let nextCaret = caret
  let changed = false

  TAG_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TAG_PATTERN.exec(text)) !== null) {
    const tagStart = match.index
    const lineStart = text.lastIndexOf('\n', tagStart - 1) + 1
    if (text.slice(lineStart, tagStart).trim().length === 0) continue

    // 连同标签前的空白一起换成换行，避免行尾留下空格
    let breakAt = tagStart
    while (breakAt > lineStart && (text[breakAt - 1] === ' ' || text[breakAt - 1] === '\t')) {
      breakAt -= 1
    }

    segments.push(text.slice(lastIndex, breakAt), '\n')
    if (breakAt < caret) {
      nextCaret = Math.max(breakAt, nextCaret + 1 - (tagStart - breakAt))
    }
    lastIndex = tagStart
    changed = true
  }

  if (!changed) return { value: text, caret }

  segments.push(text.slice(lastIndex))
  return { value: segments.join(''), caret: nextCaret }
}