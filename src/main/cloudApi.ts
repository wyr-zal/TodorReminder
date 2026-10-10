import type { CloudChangesPage, CloudRequest, CloudSnapshot, RemoteAttachment } from '../shared/cloudTypes'
import { validateChangesPage, validateServerURL, uuidPattern, validateSnapshot } from './cloudProtocol'

export class CloudHttpError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string) {
    super(status === 401 ? '服务器凭证无效' : status === 413 ? '请求或图片超过服务器限制' : status === 422 || status === 415 ? '待办或图片内容不合法，请修正后重试' : status === 409 ? '服务器拒绝了当前版本的请求' : '无法完成服务器请求，已保留本地数据')
    this.status = status
    this.code = code
  }
}
export class CloudApi {
  readonly url: string
  private token: string
  private datasetId: string | null = null
  expectDataset(id: string): void {
    if (!uuidPattern.test(id) || (this.datasetId !== null && this.datasetId !== id)) throw new Error('服务器数据集绑定不一致')
    this.datasetId = id
  }
  private controllers = new Set<AbortController>()
  abort(): void { for (const controller of this.controllers) controller.abort() }
  constructor(url: string, token: string) {
    this.url = validateServerURL(url)
    if (token.length < 32 || /\s/.test(token)) throw new Error('Token至少需要32个非空白字符')
    this.token = token
  }
  private async bytes(path: string, init: RequestInit = {}, maxBytes = 32 << 20): Promise<{ data: Uint8Array; headers: Headers }> {
    const controller = new AbortController()
    this.controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), 65000)
    try {
      const res = await fetch(this.url + path, { ...init, redirect: 'error', signal: controller.signal, headers: { ...init.headers, Authorization: 'Bearer ' + this.token, ...(this.datasetId ? { 'X-Focus-Dataset-ID': this.datasetId } : {}) } })
      const chunks: Uint8Array[] = []
      let length = 0
      const reader = res.body?.getReader()
      if (!reader) throw new Error('Missing response body')
      while (true) {
        const item = await reader.read()
        if (item.done) break
        length += item.value.byteLength
        if (length > maxBytes) { await reader.cancel(); throw new Error('Response exceeds limit') }
        chunks.push(item.value)
      }
      const data = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
      if (!res.ok) {
        let code = 'unavailable'
        try { const body = JSON.parse(new TextDecoder().decode(data)); if (typeof body.error?.code === 'string') code = body.error.code } catch { /* No raw server error is exposed. */ }
        throw new CloudHttpError(res.status, code)
      }
      return { data, headers: res.headers }
    } catch (error) {
      if (error instanceof CloudHttpError) throw error
      throw new CloudHttpError(0, 'unavailable')
    } finally { clearTimeout(timer); this.controllers.delete(controller) }
  }
  private async json(path: string, init: RequestInit = {}): Promise<any> {
    const { data } = await this.bytes(path, init)
    try { return JSON.parse(new TextDecoder().decode(data)) } catch { throw new Error('服务器返回的JSON无效，保留本地状态') }
  }
  async snapshot(): Promise<CloudSnapshot> { return validateSnapshot(await this.json('/api/v1/sync/snapshot')) }
  async changes(cursor: string, through?: string): Promise<CloudChangesPage> {
    if (!this.datasetId) throw new Error('增量同步尚未绑定数据集')
    const query = new URLSearchParams({ cursor, limit: '10' })
    if (through !== undefined) query.set('through', through)
    return validateChangesPage(await this.json('/api/v1/sync/changes?' + query.toString()), this.datasetId, cursor, through)
  }
  async meta(): Promise<{ datasetId: string; schemaVersion: number }> {
    const meta = await this.json('/api/v1/meta')
    if (meta.schemaVersion !== 1 || !uuidPattern.test(meta.datasetId)) throw new Error('服务器数据集格式无效')
    return meta
  }
  async mutate(request: CloudRequest, operationId: string): Promise<unknown> {
    return this.json(request.path, { method: request.method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': operationId }, ...(request.body ? { body: JSON.stringify(request.body) } : {}) })
  }
  async upload(data: Uint8Array, filename: string, operationId: string): Promise<RemoteAttachment> {
    const form = new FormData()
    form.append('file', new Blob([Uint8Array.from(data)]), filename)
    const result = await this.json('/api/v1/attachments', { method: 'POST', headers: { 'Idempotency-Key': operationId }, body: form })
    if (!uuidPattern.test(result.id) || !/^[a-f0-9]{64}$/.test(result.sha256) || result.size !== data.byteLength) throw new Error('图片上传回执无效')
    return result
  }
  async download(attachment: RemoteAttachment): Promise<Uint8Array> {
    const { data, headers } = await this.bytes('/api/v1/attachments/' + attachment.id, {}, 20 << 20)
    if (data.byteLength !== attachment.size || headers.get('Content-Type')?.split(';')[0] !== attachment.mimeType) throw new Error('图片大小或格式校验失败')
    return data
  }
}
