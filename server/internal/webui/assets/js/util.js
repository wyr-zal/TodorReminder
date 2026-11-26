export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function highlight(text, query) {
  const source = String(text ?? '');
  const needle = String(query ?? '').trim().replace(/^#/, '');
  if (!needle) return escapeHtml(source);
  const lowerSource = source.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let out = '';
  let index = 0;
  for (;;) {
    const found = lowerSource.indexOf(lowerNeedle, index);
    if (found < 0) {
      out += escapeHtml(source.slice(index));
      return out;
    }
    out += escapeHtml(source.slice(index, found));
    out += `<mark>${escapeHtml(source.slice(found, found + needle.length))}</mark>`;
    index = found + needle.length;
  }
}

export function parseTags(value) {
  const tags = [];
  const seen = new Set();
  for (const raw of String(value ?? '').split(/[\s,，、]+/)) {
    const tag = raw.replace(/^#+/, '').trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

// 与桌面端保持一致：保存时删除所有空白行，非空行原样保留。
export function tidyContent(value) {
  const lines = String(value ?? '').split(/\r?\n/);
  const kept = lines.filter((line) => line.trim() !== '');
  return kept.join('\n').trim();
}

export function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDiff = Math.round((startOfToday - startOfDay) / 86_400_000);
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (dayDiff === 0) return `今天 ${hhmm}`;
  if (dayDiff === 1) return `昨天 ${hhmm}`;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export const STATUS_LABELS = {
  not_started: '未开始',
  in_progress: '进行中',
  completed: '已完成'
};

export const STATUS_ORDER = { in_progress: 0, not_started: 1, completed: 2 };

function timestamp(memo, order) {
  const raw = memo.status === 'completed' && memo.completedAt ? memo.completedAt : memo.updatedAt || memo.createdAt;
  const value = new Date(raw || 0).getTime();
  return Number.isNaN(value) ? 0 : value;
}

export function sortMemos(memos, order = 'desc') {
  const direction = order === 'asc' ? 1 : -1;
  return [...memos].sort((a, b) => {
    const groupDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (groupDiff !== 0) return groupDiff;
    if (a.status !== 'completed') {
      const priorityDiff = (a.priority === 'important' ? 0 : 1) - (b.priority === 'important' ? 0 : 1);
      if (priorityDiff !== 0) return priorityDiff;
    }
    const timeDiff = (timestamp(a) - timestamp(b)) * direction;
    if (timeDiff !== 0) return timeDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function matchesQuery(memo, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return true;
  const bare = needle.replace(/^#/, '');
  const haystacks = [memo.content || '', ...(memo.tags || [])];
  return haystacks.some((text) => text.toLowerCase().includes(bare));
}

export function statusCounts(memos) {
  const counts = { all: memos.length, not_started: 0, in_progress: 0, completed: 0 };
  for (const memo of memos) {
    if (counts[memo.status] !== undefined) counts[memo.status] += 1;
  }
  return counts;
}

export function topTags(memos, limit = 12) {
  const counts = new Map();
  for (const memo of memos) {
    for (const tag of memo.tags || []) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .slice(0, limit)
    .map(([tag]) => tag);
}

export function summary(content, fallback = '（无正文）') {
  const text = String(content ?? '').trim();
  return text || fallback;
}

export function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
