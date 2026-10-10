import { createHash, randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs'
import type { Memo } from '../shared/types'
import type { CloudConfigView, CloudPreview, CloudStatus, CloudSnapshot } from '../shared/cloudTypes'
import { CloudApi } from './cloudApi'
import type { CloudDatabase } from './cloudDatabase'
import { loadCloudConfig, saveCloudConfig } from './cloudConfig'
import { assertSnapshotProgress } from './cloudProtocol'
import { CloudSync, type CloudSyncResult } from './cloudSync'

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export class CloudController {
  private worker: CloudSync | null = null
  private configError: string | null = null
  private lifecycle: Promise<unknown> = Promise.resolve()
  private migrating = false
  private windowVisible = true
  private ticket: { id: string; url: string; localHash: string; remoteHash: string; expires: number; missing: boolean } | null = null

  constructor(
    private db: CloudDatabase,
    private localMemos: () => Promise<Memo[]>,
    private root: string,
    private onComplete: (result: CloudSyncResult) => void = () => {}
  ) {}

  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(action)
    this.lifecycle = next.catch(() => {})
    return next
  }

  async view(): Promise<CloudConfigView> {
    try {
      const config = loadCloudConfig(this.root)
      const binding = await this.db.binding()
      return { url: config?.url ?? '', hasToken: !!config?.token, connected: !!config && binding?.url === config.url }
    } catch {
      return { url: '', hasToken: false, connected: false }
    }
  }

  private assertAvailable(): void {
    if (this.migrating) throw new Error('数据目录迁移中，暂不能更改服务器配置')
  }

  async status(): Promise<CloudStatus> {
    if (this.migrating) return { isSyncing: false, lastSync: null, error: '数据目录迁移中', configured: false, connected: false, pending: 0 }
    if (this.worker) return this.worker.status()
    const [view, pending] = await Promise.all([this.view(), this.db.pending()])
    return { isSyncing: false, lastSync: null, error: this.configError, configured: view.hasToken, connected: view.connected, pending: pending.length }
  }

  async resume(): Promise<void> {
    if (this.migrating || this.worker) return
    try {
      const config = loadCloudConfig(this.root)
      const binding = await this.db.binding()
      if (config && binding?.url === config.url) {
        const api = new CloudApi(config.url, config.token)
        api.expectDataset(binding.datasetId)
        const worker = new CloudSync(this.db, api, join(this.root, 'attachments'), this.onComplete)
        this.worker = worker
        await worker.start(this.windowVisible)
      }
      this.configError = null
    } catch (error) {
      this.worker = null
      this.configError = error instanceof Error ? error.message : '服务器配置不可用'
    }
  }

  async stop(): Promise<void> { await this.serialized(() => this.stopWorker()) }

  async beginStorageMigration(): Promise<void> {
    return this.serialized(async () => {
      if (this.migrating) throw new Error('数据目录迁移已开始')
      this.migrating = true
      try {
        await this.stopWorker()
      } catch (error) {
        this.migrating = false
        await this.resume()
        throw error
      }
    })
  }

  private async stopWorker(): Promise<void> {
    if (this.worker) await this.worker.stop()
    this.worker = null
  }

  setWindowVisible(visible: boolean): void {
    this.windowVisible = visible
    this.worker?.setVisible(visible)
  }

  schedule(): void { if (!this.migrating) this.worker?.schedule() }

  async save(input: { url: string; token: string }): Promise<void> {
    return this.serialized(() => this.saveExclusive(input))
  }

  private async saveExclusive(input: { url: string; token: string }): Promise<void> {
    this.assertAvailable()
    let token = input.token.trim()
    if (!token) token = loadCloudConfig(this.root)?.token ?? ''
    const api = new CloudApi(input.url, token)
    await this.stopWorker()
    try {
      saveCloudConfig(this.root, { url: api.url, token })
    } catch (error) {
      await this.resume()
      throw error
    }
    this.ticket = null
    await this.resume()
  }

  private api(): CloudApi {
    const config = loadCloudConfig(this.root)
    if (!config) throw new Error('请先保存服务器地址和Token')
    return new CloudApi(config.url, config.token)
  }

  private remoteHash(snapshot: CloudSnapshot): string {
    return fingerprint({ datasetId: snapshot.datasetId, memos: snapshot.memos.map(m => [m.id, m.version]) })
  }

  async preview(): Promise<CloudPreview> {
    return this.serialized(() => this.previewExclusive())
  }

  private async previewExclusive(): Promise<CloudPreview> {
    this.assertAvailable()
    const api = this.api()
    const snapshot = await api.snapshot()
    const bound = await this.db.binding()
    if (bound) assertSnapshotProgress(snapshot, bound.datasetId, await this.db.metas())
    const local = await this.localMemos()
    const ids = new Set(snapshot.memos.map(m => m.id))
    const missing = [...new Set(local.flatMap(m => m.attachments).filter(name => basename(name) !== name || !existsSync(join(this.root, 'attachments', name))))]
    const id = randomUUID()
    this.ticket = { id, url: api.url, localHash: fingerprint(local), remoteHash: this.remoteHash(snapshot), expires: Date.now() + 5 * 60 * 1000, missing: !!missing.length }
    return { ticket: id, localCount: local.length, remoteCount: snapshot.memos.length, conflicts: local.filter(m => ids.has(m.id)).length, missingImages: missing }
  }

  async confirm(id: string): Promise<void> {
    return this.serialized(() => this.confirmExclusive(id))
  }

  private async confirmExclusive(id: string): Promise<void> {
    this.assertAvailable()
    const ticket = this.ticket
    if (!ticket || ticket.id !== id || ticket.expires < Date.now()) throw new Error('接入预览已过期，请重新预览')
    if (ticket.missing) throw new Error('本地附件缺失，未开始接入')
    const api = this.api()
    await this.stopWorker()
    const snapshot = await api.snapshot()
    const local = await this.localMemos()
    if (ticket.url !== api.url || ticket.localHash !== fingerprint(local) || ticket.remoteHash !== this.remoteHash(snapshot)) throw new Error('预览后数据发生变化，请重新预览')
    const bound = await this.db.binding()
    if (bound) assertSnapshotProgress(snapshot, bound.datasetId, await this.db.metas())
    const backup = join(this.root, 'cloud-backups', Date.now() + '-' + randomUUID())
    mkdirSync(backup, { recursive: true })
    await this.db.backup(join(backup, 'memos.db'))
    const images = join(this.root, 'attachments')
    if (existsSync(images)) cpSync(images, join(backup, 'attachments'), { recursive: true, errorOnExist: true })
    if (existsSync(join(this.root, 'cloud-config.json'))) copyFileSync(join(this.root, 'cloud-config.json'), join(backup, 'cloud-config.json'))
    if (ticket.localHash !== fingerprint(await this.localMemos())) throw new Error('备份期间数据发生变化，请重新预览')
    await this.db.bind(snapshot.datasetId, api.url, local)
    this.ticket = null
    await this.resume()
  }

  async sync(manual = true): Promise<CloudSyncResult> {
    if (this.migrating) return { success: false, changed: false, error: '数据目录迁移中，已暂停同步' }
    if (!this.worker) return { success: false, changed: false, error: this.configError ?? '请先在设置中预览并确认服务器接入' }
    return this.worker.sync(manual)
  }
}
