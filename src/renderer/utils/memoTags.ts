const TAG_LINE_PATTERN = /^#[一-龥\w-]+(?:[ \t]+#[一-龥\w-]+)*$/

export function extractTrailingTags(text: string): { content: string; tags: string[] } {
  const lines = text.split('\n')
  let firstTagLine = lines.length
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line) continue
    if (!TAG_LINE_PATTERN.test(line)) break
    firstTagLine = index
  }
  if (firstTagLine === lines.length) return { content: text, tags: [] }

  const tags = Array.from(
    lines.slice(firstTagLine).join('\n').matchAll(/#([一-龥\w-]+)/g),
    match => match[1]
  )
  return {
    content: lines.slice(0, firstTagLine).join('\n').replace(/\r$/, ''),
    tags: [...new Set(tags)]
  }
}
