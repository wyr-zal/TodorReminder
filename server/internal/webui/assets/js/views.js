import { escapeHtml, formatTime, highlight, STATUS_LABELS } from './util.js';

const ATTACHMENT_ROOT = '/web/api/v1/attachments/';

function attachmentURL(id) {
  return ATTACHMENT_ROOT + encodeURIComponent(id);
}

function statusCircle(memo) {
  if (memo.status === 'completed') {
    return `<button class="check" type="button" data-action="cycle" aria-label="标记为未开始"><svg><use href="#i-check"/></svg></button>`;
  }
  if (memo.status === 'in_progress') {
    return `<button class="check" type="button" data-action="cycle" aria-label="标记为已完成"><svg><use href="#i-dot"/></svg></button>`;
  }
  return `<button class="check" type="button" data-action="cycle" aria-label="标记为进行中"><svg><use href="#i-check"/></svg></button>`;
}

function attachmentStrip(memo) {
  const ids = memo.attachmentIds || [];
  if (!ids.length) return '';
  const thumbs = ids
    .map(
      (id) =>
        `<button class="thumb" type="button" data-action="preview" data-src="${escapeHtml(attachmentURL(id))}">` +
        `<img loading="lazy" decoding="async" src="${escapeHtml(attachmentURL(id))}" alt="附件图片"></button>`
    )
    .join('');
  return `<div class="thumbs">${thumbs}</div>`;
}

function contentBlock(memo, query) {
  const text = String(memo.content ?? '');
  if (!text.trim() && (memo.attachmentIds || []).length) {
    return `<p class="content-text placeholder-text">图片备忘</p>`;
  }
  const long = text.length > 170 || text.split('\n').length > 7;
  const body = `<p class="content-text${long ? ' clamped' : ''}">${highlight(text, query)}</p>`;
  const toggle = long ? `<button class="expand-btn" type="button" data-action="expand">展开全文</button>` : '';
  return body + toggle;
}

export function memoCardHTML(memo, options = {}) {
  const { query = '', trash = false } = options;
  const classes = ['memo', memo.status, memo.priority === 'important' ? 'important' : ''].filter(Boolean).join(' ');
  const tags = (memo.tags || [])
    .map((tag) => `<button class="tag" type="button" data-action="tag" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</button>`)
    .join('');
  const important = memo.priority === 'important' ? '<span class="badge important">重要</span>' : '';
  const time = formatTime(memo.status === 'completed' && memo.completedAt ? memo.completedAt : memo.updatedAt);
  const actions = trash
    ? `<div class="memo-foot">
         <button class="foot-btn" type="button" data-action="restore"><svg><use href="#i-restore"/></svg>恢复</button>
         <button class="foot-btn danger" type="button" data-action="purge"><svg><use href="#i-trash"/></svg>彻底删除</button>
       </div>`
    : `<div class="memo-foot">
         <button class="foot-btn" type="button" data-action="edit"><svg><use href="#i-edit"/></svg>编辑</button>
         <button class="foot-btn${memo.priority === 'important' ? ' active' : ''}" type="button" data-action="priority">
           <svg><use href="#i-flag"/></svg>${memo.priority === 'important' ? '重要' : '标为重要'}
         </button>
         <button class="foot-btn danger" type="button" data-action="delete"><svg><use href="#i-trash"/></svg>删除</button>
       </div>`;
  return `<article class="${classes}" data-id="${escapeHtml(memo.id)}">
    ${trash ? '' : statusCircle(memo)}
    <div class="memo-body">
      <div class="content" data-action="${trash ? 'noop' : 'edit'}">
        ${contentBlock(memo, query)}
        ${attachmentStrip(memo)}
        <div class="meta">
          ${tags}${important}
          <time datetime="${escapeHtml(memo.updatedAt || '')}">${escapeHtml(time)}</time>
        </div>
      </div>
      ${actions}
    </div>
  </article>`;
}

export function listHTML(memos, options = {}) {
  const { query = '', status = 'all', tag = '' } = options;
  const visible = memos.filter((memo) => {
    if (status !== 'all' && memo.status !== status) return false;
    if (tag && !(memo.tags || []).includes(tag)) return false;
    return true;
  });
  if (!visible.length) return { html: '', count: 0 };
  const groups = [
    ['in_progress', '进行中'],
    ['not_started', '未开始'],
    ['completed', '已完成']
  ];
  let html = '';
  for (const [key, label] of groups) {
    const items = visible.filter((memo) => memo.status === key);
    if (!items.length) continue;
    if (status === 'all') html += `<h2 class="group-label">${label} · ${items.length}</h2>`;
    html += items.map((memo) => memoCardHTML(memo, { query })).join('');
  }
  return { html, count: visible.length };
}

function segmented(name, current, options) {
  return `<div class="segmented" data-group="${name}">${options
    .map(
      ([value, label, tone]) =>
        `<button type="button" data-value="${value}" data-tone="${tone || ''}" aria-pressed="${value === current}">${label}</button>`
    )
    .join('')}</div>`;
}

export function attachmentsEditor(drafts) {
  const items = drafts
    .map(
      (draft, index) => `<div class="attach${draft.uploading ? ' uploading' : ''}" data-index="${index}">
        ${draft.uploading ? '<span class="spinner"></span>' : `<img src="${escapeHtml(attachmentURL(draft.id))}" alt="待保存图片">`}
        <button class="remove" type="button" data-action="remove-attachment" aria-label="移除图片"><svg><use href="#i-close"/></svg></button>
      </div>`
    )
    .join('');
  return `<div class="attach-row" id="attach-row">
    ${items}
    <button class="attach add" type="button" data-action="add-attachment" aria-label="添加图片">
      <svg><use href="#i-image"/></svg><span>照片</span>
    </button>
    <input id="attach-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
  </div>`;
}

export function composerHTML(draft) {
  const { memo, content, tags, priority, status, attachments } = draft;
  const title = memo ? '编辑待办' : '新建待办';
  return `<div class="sheet-head">
      <h2>${title}</h2>
      <button class="icon-btn" type="button" data-action="close-sheet" aria-label="关闭"><svg><use href="#i-close"/></svg></button>
    </div>
    <div class="sheet-body">
      <div class="field">
        <textarea id="compose-content" class="compose" placeholder="写点什么… 支持换行" enterkeyhint="enter">${escapeHtml(content)}</textarea>
        <p class="field-hint">保存时会自动去掉空白行</p>
      </div>
      <div class="field">
        <label class="field-label" for="compose-tags">标签</label>
        <input id="compose-tags" class="text-input" type="text" value="${escapeHtml(tags)}" placeholder="工作 生活（空格分隔，留空自动加 TODO）" autocomplete="off">
      </div>
      <div class="field">
        <span class="field-label">重要程度</span>
        ${segmented('priority', priority, [
          ['unimportant', '不重要', ''],
          ['important', '重要', 'important']
        ])}
      </div>
      <div class="field">
        <span class="field-label">状态</span>
        ${segmented('status', status, [
          ['not_started', '未开始', ''],
          ['in_progress', '进行中', 'progress'],
          ['completed', '已完成', 'done']
        ])}
      </div>
      <div class="field">
        <span class="field-label">图片</span>
        ${attachmentsEditor(attachments)}
      </div>
      ${memo ? `<p class="field-hint">创建于 ${escapeHtml(formatTime(memo.createdAt))} · 版本 ${escapeHtml(memo.version)}</p>` : ''}
    </div>
    <div class="sheet-foot">
      <button class="btn ghost" type="button" data-action="close-sheet">取消</button>
      <button class="btn primary" type="button" data-action="save" id="compose-save">保存</button>
    </div>`;
}

export function trashHTML(memos) {
  const items = memos.length
    ? memos
        .map(
          (memo) => `<div class="trash-item" data-id="${escapeHtml(memo.id)}">
            <div class="memo-body">
              <p class="content-text">${escapeHtml(memo.content || '图片备忘')}</p>
              <div class="meta"><time>${escapeHtml(formatTime(memo.updatedAt))}</time></div>
            </div>
            <div class="trash-actions">
              <button class="btn ghost" type="button" data-action="restore"><svg><use href="#i-restore"/></svg>恢复</button>
              <button class="btn danger" type="button" data-action="purge">彻底删除</button>
            </div>
          </div>`
        )
        .join('')
    : '<p class="sheet-note">回收站是空的。</p>';
  return `<div class="sheet-head">
      <h2>回收站</h2>
      <button class="icon-btn" type="button" data-action="close-sheet" aria-label="关闭"><svg><use href="#i-close"/></svg></button>
    </div>
    <div class="sheet-body">
      <p class="sheet-note">删除的待办会先放到这里，可恢复；彻底删除后无法找回。</p>
      ${items}
    </div>
    <div class="sheet-foot">
      <button class="btn ghost" type="button" data-action="close-sheet">关闭</button>
    </div>`;
}

export function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}
