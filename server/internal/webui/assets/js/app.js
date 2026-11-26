import { api, ApiError, onUnauthorized } from './api.js';
import {
  escapeHtml,
  matchesQuery,
  parseTags,
  sortMemos,
  statusCounts,
  summary,
  tidyContent,
  topTags
} from './util.js';
import { attachmentsEditor, composerHTML, listHTML, trashHTML } from './views.js';

const $ = (selector) => document.querySelector(selector);

const state = {
  authenticated: false,
  memos: [],
  deleted: [],
  status: readPref('fm-web-status', 'all'),
  tag: '',
  query: '',
  sort: readPref('fm-web-sort', 'desc'),
  metaLoaded: false
};

let draft = null;
let refreshSeq = 0;
let toastTimer = 0;

const el = {
  boot: $('#boot'),
  login: $('#login'),
  loginForm: $('#login-form'),
  loginError: $('#login-error'),
  loginNote: $('#login-note'),
  loginSubmit: $('#login-submit'),
  password: $('#password'),
  app: $('#app'),
  list: $('#list'),
  empty: $('#empty'),
  emptyTitle: $('#empty-title'),
  emptySub: $('#empty-sub'),
  statusChips: $('#status-chips'),
  tagChips: $('#tag-chips'),
  search: $('#search'),
  sortLabel: $('#sort-label'),
  sync: $('#sync-status'),
  syncText: $('#sync-text'),
  sheet: $('#sheet'),
  backdrop: $('#backdrop'),
  viewer: $('#viewer'),
  viewerImg: $('#viewer-img'),
  toast: $('#toast')
};

function readPref(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch (_) {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_) {
    /* storage may be disabled in private mode */
  }
}

function hideApp(showLogin) {
  el.boot.classList.add('hidden');
  el.app.classList.add('hidden');
  el.login.classList.toggle('hidden', !showLogin);
}

function showLogin(message) {
  state.authenticated = false;
  closeSheet();
  hideApp(true);
  el.loginError.textContent = message || '';
  el.loginError.classList.toggle('hidden', !message);
  el.loginNote.classList.add('hidden');
  setTimeout(() => el.password.focus(), 60);
}

async function enterApp() {
  state.authenticated = true;
  el.login.classList.add('hidden');
  el.boot.classList.add('hidden');
  el.app.classList.remove('hidden');
  el.sortLabel.textContent = state.sort === 'asc' ? '最早' : '最新';
  await refresh();
}

function setSync(kind, text) {
  el.sync.classList.toggle('busy', kind === 'busy');
  el.sync.classList.toggle('offline', kind === 'offline');
  el.syncText.textContent = text;
}

function toast(message, kind = 'info') {
  el.toast.textContent = message;
  el.toast.classList.toggle('error', kind === 'error');
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), kind === 'error' ? 3800 : 2400);
}

async function refresh(options = {}) {
  if (!state.authenticated) return;
  const seq = ++refreshSeq;
  if (!options.silent) setSync('busy', '同步中…');
  try {
    if (!state.metaLoaded) {
      await api.meta();
      state.metaLoaded = true;
    }
    const memos = await api.listMemos(false);
    if (seq !== refreshSeq) return;
    state.memos = sortMemos(memos, state.sort);
    render();
    const now = new Date();
    setSync('ok', `已同步 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    if (seq !== refreshSeq) return;
    setSync('offline', '同步失败');
    if (!options.silent) toast(err.message || '同步失败', 'error');
  }
}

function filteredMemos() {
  let list = state.memos.filter((memo) => matchesQuery(memo, state.query));
  if (state.tag) list = list.filter((memo) => (memo.tags || []).includes(state.tag));
  return list;
}

function render() {
  const base = filteredMemos();
  const counts = statusCounts(base);
  const { html, count } = listHTML(base, { query: state.query, status: state.status, tag: state.tag });
  el.list.innerHTML = html;
  el.empty.classList.toggle('hidden', count > 0);

  if (!count) {
    if (state.query) {
      el.emptyTitle.textContent = '没有找到匹配的待办';
      el.emptySub.textContent = '换个关键词，或点标签清除筛选';
    } else if (state.tag) {
      el.emptyTitle.textContent = `#${state.tag} 下暂无待办`;
      el.emptySub.textContent = '点上方标签可取消筛选';
    } else if (state.status !== 'all') {
      el.emptyTitle.textContent = '当前状态下暂无待办';
      el.emptySub.textContent = '切换上方状态看看';
    } else {
      el.emptyTitle.textContent = '还没有待办';
      el.emptySub.textContent = '点右下角 + 新建一条';
    }
  }

  for (const chip of el.statusChips.querySelectorAll('.chip')) {
    const key = chip.dataset.status;
    chip.setAttribute('aria-pressed', String(state.status === key));
    const badge = chip.querySelector('b');
    if (badge) badge.textContent = String(counts[key] ?? 0);
  }

  const tags = topTags(state.memos.filter((memo) => matchesQuery(memo, state.query)));
  el.tagChips.innerHTML = tags
    .map(
      (tag) =>
        `<button class="chip" type="button" data-tag="${escapeHtml(tag)}" aria-pressed="${state.tag === tag}">#${escapeHtml(tag)}</button>`
    )
    .join('');
}

/* ---------------- sheet ---------------- */

function openSheet(html) {
  el.sheet.innerHTML = html;
  el.sheet.classList.remove('hidden');
  el.backdrop.classList.remove('hidden');
  document.body.classList.add('sheet-open');
}

function closeSheet() {
  el.sheet.classList.add('hidden');
  el.sheet.innerHTML = '';
  el.backdrop.classList.add('hidden');
  document.body.classList.remove('sheet-open');
  draft = null;
}

function openConfirm({ title, message, confirmLabel = '确定' }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'confirm-wrap';
    wrap.innerHTML = `<div class="confirm-card" role="dialog" aria-modal="true">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(message)}</p>
      <div class="confirm-actions">
        <button class="btn ghost" type="button" data-answer="no">取消</button>
        <button class="btn danger" type="button" data-answer="yes">${escapeHtml(confirmLabel)}</button>
      </div>
    </div>`;
    const finish = (answer) => {
      wrap.remove();
      resolve(answer);
    };
    wrap.addEventListener('click', (event) => {
      if (event.target === wrap) return finish(false);
      const button = event.target.closest('[data-answer]');
      if (button) finish(button.dataset.answer === 'yes');
    });
    document.body.appendChild(wrap);
  });
}

function openComposer(memo) {
  draft = {
    memo: memo || null,
    content: memo ? memo.content : '',
    tags: memo ? (memo.tags || []).join(' ') : '',
    priority: memo ? memo.priority : 'unimportant',
    status: memo ? memo.status : 'not_started',
    attachments: memo ? (memo.attachmentIds || []).map((id) => ({ id, uploading: false })) : []
  };
  openSheet(composerHTML(draft));
  const textarea = $('#compose-content');
  const tagsInput = $('#compose-tags');
  const autoGrow = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, window.innerHeight * 0.42)}px`;
  };
  textarea.addEventListener('input', () => {
    draft.content = textarea.value;
    autoGrow();
  });
  tagsInput.addEventListener('input', () => {
    draft.tags = tagsInput.value;
  });
  autoGrow();
  if (!memo) setTimeout(() => textarea.focus(), 80);
}

async function openTrash() {
  openSheet(`<div class="sheet-head"><h2>回收站</h2>
    <button class="icon-btn" type="button" data-action="close-sheet" aria-label="关闭"><svg><use href="#i-close"/></svg></button>
  </div><div class="sheet-body"><p class="sheet-note">正在读取…</p></div>`);
  try {
    const memos = await api.listMemos(true);
    state.deleted = memos.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    el.sheet.innerHTML = trashHTML(state.deleted);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    el.sheet.innerHTML = trashHTML([]);
    toast(err.message || '读取回收站失败', 'error');
  }
}

/* ---------------- mutations ---------------- */

function invalidateRefresh() {
  refreshSeq += 1;
}

function applyReceipt(id, receipt, patch) {
  invalidateRefresh();
  const memo = state.memos.find((item) => item.id === id);
  if (!memo) return;
  if (patch) Object.assign(memo, patch);
  memo.version = receipt.appliedVersion;
  memo.updatedAt = receipt.updatedAt;
  memo.completedAt = receipt.completedAt ?? null;
  memo.deleted = receipt.deleted;
  if (receipt.deleted) {
    state.memos = state.memos.filter((item) => item.id !== id);
  }
  state.memos = sortMemos(state.memos, state.sort);
  render();
}

async function patchMemo(memo, patch, successText) {
  try {
    const receipt = await api.patchMemo(memo.id, { baseVersion: memo.version, ...patch });
    applyReceipt(memo.id, receipt, patch);
    if (successText) toast(successText);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    if (err.status === 409) {
      toast('该待办已在其他设备更新，正在刷新…', 'error');
      await refresh({ silent: true });
      return;
    }
    toast(err.message || '保存失败', 'error');
  }
}

async function cycleStatus(memo) {
  const next = { not_started: 'in_progress', in_progress: 'completed', completed: 'not_started' }[memo.status];
  await patchMemo(memo, { status: next }, next === 'completed' ? '已完成' : next === 'in_progress' ? '进行中' : '已重置');
}

async function togglePriority(memo) {
  const next = memo.priority === 'important' ? 'unimportant' : 'important';
  await patchMemo(memo, { priority: next }, next === 'important' ? '已标为重要' : '已取消重要');
}

async function removeMemo(memo) {
  const ok = await openConfirm({
    title: '删除这条待办？',
    message: '会先放进回收站，之后仍可恢复。',
    confirmLabel: '删除'
  });
  if (!ok) return;
  try {
    await api.deleteMemo(memo.id, memo.version, false);
    invalidateRefresh();
    state.memos = state.memos.filter((item) => item.id !== memo.id);
    render();
    toast('已移入回收站');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    if (err.status === 409) {
      toast('该待办已在其他设备更新，正在刷新…', 'error');
      await refresh({ silent: true });
      return;
    }
    toast(err.message || '删除失败', 'error');
  }
}

async function restoreMemo(memo) {
  try {
    await api.patchMemo(memo.id, { baseVersion: memo.version, deleted: false });
    invalidateRefresh();
    toast('已恢复');
    await refresh({ silent: true });
    await openTrash();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    toast(err.message || '恢复失败', 'error');
  }
}

async function purgeMemo(memo) {
  const ok = await openConfirm({
    title: '彻底删除？',
    message: '删除后无法恢复，也不能再同步回桌面端。',
    confirmLabel: '彻底删除'
  });
  if (!ok) return;
  try {
    await api.deleteMemo(memo.id, memo.version, true);
    invalidateRefresh();
    toast('已彻底删除');
    await openTrash();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    toast(err.message || '删除失败', 'error');
  }
}

/* ---------------- composer actions ---------------- */

function renderAttachments() {
  const row = document.getElementById('attach-row');
  if (!row || !draft) return;
  row.outerHTML = attachmentsEditor(draft.attachments);
}

async function addFiles(files) {
  if (!draft || !files || !files.length) return;
  for (const file of files) {
    if (!file.type.startsWith('image/')) {
      toast('只能添加图片文件', 'error');
      continue;
    }
    const entry = { id: null, uploading: true };
    draft.attachments.push(entry);
    renderAttachments();
    try {
      const attachment = await api.uploadAttachment(file);
      entry.id = attachment.id;
      entry.uploading = false;
    } catch (err) {
      const index = draft.attachments.indexOf(entry);
      if (index >= 0) draft.attachments.splice(index, 1);
      toast(err.message || '图片上传失败', 'error');
    }
    renderAttachments();
  }
}

async function saveDraft() {
  if (!draft) return;
  if (draft.attachments.some((item) => item.uploading)) {
    toast('图片还在上传，请稍候', 'error');
    return;
  }
  const content = tidyContent(draft.content);
  const attachmentIds = draft.attachments.map((item) => item.id).filter(Boolean);
  if (!content && !attachmentIds.length) {
    toast('请先写点内容或添加图片', 'error');
    return;
  }
  const tags = parseTags(draft.tags);
  const button = $('#compose-save');
  if (button) {
    button.disabled = true;
    button.textContent = '保存中…';
  }
  try {
    if (draft.memo) {
      const receipt = await api.patchMemo(draft.memo.id, {
        baseVersion: draft.memo.version,
        content,
        priority: draft.priority,
        status: draft.status,
        attachmentIds,
        tags: tags.length ? tags : ['TODO']
      });
      applyReceipt(draft.memo.id, receipt, { content, priority: draft.priority, status: draft.status, attachmentIds, tags: tags.length ? tags : ['TODO'] });
      closeSheet();
      toast('已保存');
      refresh({ silent: true });
    } else {
      const payload = { content, priority: draft.priority, status: draft.status, attachmentIds };
      if (tags.length) payload.tags = tags;
      await api.createMemo(payload);
      invalidateRefresh();
      closeSheet();
      toast('已添加');
      await refresh({ silent: true });
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    if (err.status === 409 && draft && draft.memo) {
      toast('该待办已在其他设备更新，正在同步最新版本…', 'error');
      await refresh({ silent: true });
      const fresh = state.memos.find((item) => item.id === draft.memo.id);
      if (!fresh) {
        closeSheet();
        toast('这条待办已被删除', 'error');
        return;
      }
      draft.memo = fresh;
      if (button) {
        button.disabled = false;
        button.textContent = '保存';
      }
      toast('已载入最新版本，请再点一次保存');
      return;
    }
    toast(err.message || '保存失败', 'error');
    if (button) {
      button.disabled = false;
      button.textContent = '保存';
    }
  }
}

/* ---------------- events ---------------- */

function bindEvents() {
  el.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = el.password.value;
    if (!password) {
      el.loginError.textContent = '请输入访问口令。';
      el.loginError.classList.remove('hidden');
      return;
    }
    el.loginSubmit.disabled = true;
    el.loginSubmit.textContent = '验证中…';
    el.loginError.classList.add('hidden');
    try {
      await api.login(password);
      el.password.value = '';
      await enterApp();
    } catch (err) {
      el.loginError.textContent = err.message || '登录失败';
      el.loginError.classList.remove('hidden');
    } finally {
      el.loginSubmit.disabled = false;
      el.loginSubmit.textContent = '进入';
    }
  });

  el.statusChips.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    state.status = chip.dataset.status;
    writePref('fm-web-status', state.status);
    render();
  });

  el.tagChips.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    state.tag = state.tag === chip.dataset.tag ? '' : chip.dataset.tag;
    render();
  });

  el.search.addEventListener('input', () => {
    state.query = el.search.value;
    render();
  });

  $('#btn-sort').addEventListener('click', () => {
    state.sort = state.sort === 'desc' ? 'asc' : 'desc';
    writePref('fm-web-sort', state.sort);
    el.sortLabel.textContent = state.sort === 'asc' ? '最早' : '最新';
    state.memos = sortMemos(state.memos, state.sort);
    render();
  });

  $('#btn-new').addEventListener('click', () => openComposer(null));
  $('#btn-trash').addEventListener('click', openTrash);
  $('#btn-logout').addEventListener('click', async () => {
    try {
      await api.logout();
    } catch (_) {
      /* ignore, still show login */
    }
    state.metaLoaded = false;
    showLogin('已退出登录。');
  });
  el.sync.addEventListener('click', () => refresh());

  el.list.addEventListener('click', async (event) => {
    const actionEl = event.target.closest('[data-action]');
    const card = event.target.closest('.memo');
    if (!actionEl || !card) return;
    const memo = state.memos.find((item) => item.id === card.dataset.id);
    if (!memo) return;
    switch (actionEl.dataset.action) {
      case 'cycle':
        await cycleStatus(memo);
        break;
      case 'edit':
        openComposer(memo);
        break;
      case 'priority':
        await togglePriority(memo);
        break;
      case 'delete':
        await removeMemo(memo);
        break;
      case 'tag':
        state.tag = state.tag === actionEl.dataset.tag ? '' : actionEl.dataset.tag;
        render();
        break;
      case 'expand': {
        const text = card.querySelector('.content-text');
        const clamped = text.classList.toggle('clamped');
        actionEl.textContent = clamped ? '展开全文' : '收起';
        break;
      }
      case 'preview':
        el.viewerImg.src = actionEl.dataset.src;
        el.viewer.classList.remove('hidden');
        break;
      default:
        break;
    }
  });

  el.sheet.addEventListener('click', async (event) => {
    const actionEl = event.target.closest('[data-action]');
    const segment = event.target.closest('.segmented button');
    if (segment) {
      const group = segment.closest('.segmented').dataset.group;
      if (draft && (group === 'priority' || group === 'status')) {
        draft[group] = segment.dataset.value;
        for (const button of segment.closest('.segmented').querySelectorAll('button')) {
          button.setAttribute('aria-pressed', String(button === segment));
        }
      }
      return;
    }
    if (!actionEl) return;
    switch (actionEl.dataset.action) {
      case 'close-sheet':
        closeSheet();
        break;
      case 'save':
        await saveDraft();
        break;
      case 'add-attachment': {
        const input = document.getElementById('attach-input');
        if (input) input.click();
        break;
      }
      case 'remove-attachment': {
        const holder = actionEl.closest('.attach');
        const index = Number(holder.dataset.index);
        if (draft && draft.attachments[index]) {
          if (draft.attachments[index].uploading) {
            toast('图片正在上传，稍等一下', 'error');
          } else {
            draft.attachments.splice(index, 1);
            renderAttachments();
          }
        }
        break;
      }
      case 'restore': {
        const item = actionEl.closest('.trash-item');
        const memo = state.deleted.find((entry) => entry.id === item.dataset.id);
        if (memo) await restoreMemo(memo);
        break;
      }
      case 'purge': {
        const item = actionEl.closest('.trash-item');
        const memo = state.deleted.find((entry) => entry.id === item.dataset.id);
        if (memo) await purgeMemo(memo);
        break;
      }
      default:
        break;
    }
  });

  el.sheet.addEventListener('change', (event) => {
    if (event.target.id === 'attach-input') {
      addFiles([...event.target.files]);
      event.target.value = '';
    }
  });

  el.backdrop.addEventListener('click', closeSheet);
  $('#viewer-close').addEventListener('click', () => el.viewer.classList.add('hidden'));
  el.viewer.addEventListener('click', (event) => {
    if (event.target === el.viewer) el.viewer.classList.add('hidden');
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!el.viewer.classList.contains('hidden')) {
      el.viewer.classList.add('hidden');
    } else if (!el.sheet.classList.contains('hidden')) {
      closeSheet();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.authenticated) refresh({ silent: true });
  });

  setInterval(() => {
    if (document.visibilityState === 'visible' && state.authenticated) refresh({ silent: true });
  }, 60_000);
}

onUnauthorized(() => showLogin('登录已过期，请重新输入口令。'));

async function boot() {
  bindEvents();
  try {
    const session = await api.session();
    if (!session.enabled) {
      hideApp(true);
      el.loginError.classList.add('hidden');
      el.loginNote.textContent = session.note || '网页端尚未启用。';
      el.loginNote.classList.remove('hidden');
      el.loginSubmit.disabled = true;
      return;
    }
    if (!session.authenticated) {
      showLogin('');
      return;
    }
    await enterApp();
  } catch (err) {
    hideApp(true);
    el.loginError.textContent = `无法连接服务器：${err.message || '未知错误'}`;
    el.loginError.classList.remove('hidden');
  }
}

boot();
