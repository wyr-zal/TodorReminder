import { createHash, randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { existsSync, readFileSync, mkdirSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync } from 'node:fs'
import type { RemoteAttachment, RemoteMemo } from '../shared/cloudTypes'
import type { CloudDatabase } from './cloudDatabase'
import type { CloudApi } from './cloudApi'

const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
export class CloudAttachmentError extends Error {}
export class CloudAttachments {
  constructor(private db: CloudDatabase, private api: CloudApi, private root: string) { mkdirSync(root, { recursive: true }) }
  path(filename: string): string {
    if (!filename || basename(filename) !== filename || filename.includes('\\') || filename.includes('/') || filename === '.' || filename === '..') throw new CloudAttachmentError('附件文件名无效')
    return join(this.root, filename)
  }
  async upload(filenames: string[]): Promise<string[]> {
    const ids: string[] = []
    for (const filename of filenames) {
      const path = this.path(filename)
      if (!existsSync(path)) throw new CloudAttachmentError('本地附件缺失，未提交该待办')
      const data = readFileSync(path)
      if (data.length > 20 << 20) throw new CloudAttachmentError('本地附件超过20MB限制')
      const mapping = await this.db.attachment(filename)
      const digest = hash(data)
      if (mapping.remoteId) {
        if (mapping.sha256 !== digest) throw new CloudAttachmentError('已同步附件内容改变，未复用旧附件标识')
        ids.push(mapping.remoteId)
      } else {
        const uploaded = await this.api.upload(data, filename, mapping.operationId)
        if (uploaded.sha256 !== digest) throw new Error('图片上传哈希不匹配')
        await this.db.saveAttachment(filename, uploaded.id, digest)
        ids.push(uploaded.id)
      }
    }
    return ids
  }
  async download(memo: RemoteMemo, descriptions: RemoteAttachment[]): Promise<string[]> {
    const index = new Map(descriptions.map(a => [a.id, a]))
    const filenames: string[] = []
    for (const id of memo.attachmentIds) {
      const a = index.get(id)
      if (!a) throw new Error('服务器缺少附件描述，保留本地待办')
      const existing = await this.db.remoteAttachment(id)
      const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as Record<string, string>)[a.mimeType]
      const filename = existing?.filename ?? `cloud-${id}.${extension}`
      const path = this.path(filename)
      if (existsSync(path)) {
        if (hash(readFileSync(path)) !== a.sha256) throw new Error('本地图片校验失败，不覆盖已有文件')
      } else {
        const data = await this.api.download(a)
        if (hash(data) !== a.sha256) throw new Error('下载图片哈希校验失败')
        const temporary = this.path(`.cloud-${randomUUID()}.tmp`)
        writeFileSync(temporary, data, { flag: 'wx' })
        const fd = openSync(temporary, 'r+')
        try { fsyncSync(fd) } finally { closeSync(fd) }
        renameSync(temporary, path)
      }
      await this.db.saveAttachment(filename, id, a.sha256)
      filenames.push(filename)
    }
    return filenames
  }
}
