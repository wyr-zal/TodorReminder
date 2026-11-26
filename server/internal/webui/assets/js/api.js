const API_ROOT = '/web/api/v1';

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || '';
  }
}

let datasetId = '';
let unauthorizedHandler = () => {};

export function onUnauthorized(handler) {
  unauthorizedHandler = handler;
}

export function newId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function friendlyStatus(status) {
  if (status === 413) return '图片或内容太大，服务器拒绝了这次请求。';
  if (status === 415) return '图片格式不支持，请换一张 JPG/PNG 图片。';
  if (status === 409) return '数据已在别处更新，请刷新后重试。';
  if (status === 503) return '服务器暂时不可用，请稍后再试。';
  if (status === 429) return '操作太频繁，请稍后再试。';
  return `请求失败（HTTP ${status}）`;
}

async function failure(res) {
  let detail = {};
  try {
    const body = await res.json();
    detail = (body && body.error) || {};
  } catch (_) {
    /* ignore malformed error bodies */
  }
  if (res.status === 401) unauthorizedHandler();
  return new ApiError(detail.message || friendlyStatus(res.status), res.status, detail.code);
}

async function request(path, options = {}) {
  const { method = 'GET', body, isForm = false, timeout = 30_000, idempotencyKey } = options;
  const headers = new Headers();
  if (datasetId) headers.set('X-Focus-Dataset-ID', datasetId);
  if (method !== 'GET' && method !== 'HEAD') headers.set('X-Focus-Web', '1');
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
  let payload = body;
  if (body !== undefined && !isForm) {
    headers.set('Content-Type', 'application/json');
    payload = JSON.stringify(body);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetch(API_ROOT + path, {
      method,
      headers,
      body: payload,
      credentials: 'same-origin',
      signal: controller.signal,
      cache: 'no-store'
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new ApiError('请求超时，请检查网络后重试。', 0, 'timeout');
    throw new ApiError('网络连接失败，请检查网络后重试。', 0, 'network');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw await failure(res);
  if (res.status === 204) return null;
  return res.json();
}

async function webRequest(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Focus-Web': '1' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: 'same-origin',
    cache: 'no-store'
  });
  if (!res.ok) throw await failure(res);
  return res.json();
}

export const api = {
  session: () => webRequest('/web/session'),
  login: (password) => webRequest('/web/login', { method: 'POST', body: { password } }),
  logout: () => webRequest('/web/logout', { method: 'POST' }),

  async meta() {
    const meta = await request('/meta');
    datasetId = meta.datasetId || '';
    return meta;
  },

  async listMemos(deleted = false) {
    const all = [];
    const limit = 500;
    for (let offset = 0; offset < 20_000; offset += limit) {
      const page = await request(`/memos?limit=${limit}&offset=${offset}${deleted ? '&deleted=true' : ''}`);
      const memos = page.memos || [];
      all.push(...memos);
      if (memos.length < limit) break;
    }
    return all;
  },

  createMemo(fields) {
    return request('/memos', { method: 'POST', body: fields, idempotencyKey: newId() });
  },

  patchMemo(id, patch) {
    return request(`/memos/${id}`, { method: 'PATCH', body: patch, idempotencyKey: newId() });
  },

  deleteMemo(id, baseVersion, permanent = false) {
    const query = `?baseVersion=${encodeURIComponent(baseVersion)}${permanent ? '&permanent=true' : ''}`;
    return request(`/memos/${id}${query}`, { method: 'DELETE', idempotencyKey: newId() });
  },

  uploadAttachment(file) {
    const form = new FormData();
    form.append('file', file, file.name || 'image.jpg');
    return request('/attachments', { method: 'POST', body: form, isForm: true, timeout: 90_000, idempotencyKey: newId() });
  },

  attachmentURL(id) {
    return `${API_ROOT}/attachments/${id}`;
  }
};
