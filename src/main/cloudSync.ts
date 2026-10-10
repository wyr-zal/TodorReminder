import type { CloudChangesPage, CloudOperation, CloudSnapshot, CloudStatus, CloudPullState } from '../shared/cloudTypes'
import type { Memo } from '../shared/types'
import { CloudApi, CloudHttpError } from './cloudApi'
import { CloudAttachments, CloudAttachmentError } from './cloudAttachments'
import type { CloudDatabase } from './cloudDatabase'
import { assertSnapshotProgress, makeRequest, validateReceipt } from './cloudProtocol'

export type CloudSyncResult = { success: boolean; changed: boolean; error?: string }

export class CloudSync {
  private active: Promise<CloudSyncResult> | null = null
  private activeManual = false
  private stopped = false
  private started = false
  private visible = true
  private generation = 0
  private interval: ReturnType<typeof setInterval> | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null
  private deferred = false
  private lastSync: string | null = null
  private error: string | null = null
  private files: CloudAttachments

  constructor(private db: CloudDatabase, private api: CloudApi, imagesDir: string, private onComplete: (result: CloudSyncResult) => void = () => {}) {
    this.files = new CloudAttachments(db, api, imagesDir)
  }

  async status(): Promise<CloudStatus> {
    const [binding, pending] = await Promise.all([this.db.binding(), this.db.pending()])
    return { isSyncing: !!this.active, lastSync: this.lastSync, error: this.error, configured: true, connected: !!binding, pending: pending.length }
  }

  async start(windowVisible = true): Promise<void> {
    if (this.started) return
    this.started = true
    this.stopped = false
    this.visible = windowVisible
    const binding = await this.db.binding()
    if (binding) this.lastSync = (await this.db.pullState(binding.datasetId))?.lastPulledAt ?? null
    if (!this.visible) this.startBackgroundSchedule()
  }

  setVisible(visible: boolean): void {
    if (this.stopped || this.visible === visible) return
    this.visible = visible
    if (visible) {
      this.generation++
      this.deferred = true
      if (this.interval) clearInterval(this.interval)
      if (this.debounce) clearTimeout(this.debounce)
      this.interval = null
      this.debounce = null
      if (this.active && !this.activeManual) this.api.abort()
      return
    }
    if (this.started) this.startBackgroundSchedule()
  }

  schedule(): void {
    if (this.stopped) return
    this.deferred = true
    if (this.visible) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      this.deferred = false
      void this.sync(false)
    }, 500)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.generation++
    if (this.interval) clearInterval(this.interval)
    if (this.debounce) clearTimeout(this.debounce)
    this.interval = null
    this.debounce = null
    this.api.abort()
    if (this.active) await this.active
  }

  private startBackgroundSchedule(): void {
    if (this.stopped || this.visible) return
    if (!this.interval) this.interval = setInterval(() => { void this.sync(false) }, 10 * 60 * 1000)
    this.schedule()
  }

  private guard(manual: boolean, generation: number): void {
    if (this.stopped) throw new Error('同步已停止，本地操作已保留')
    if (!manual && (this.visible || generation !== this.generation)) throw new Error('窗口已显示，后台同步已暂停')
  }

  private paused(manual: boolean, generation: number): boolean {
    return !manual && (this.visible || generation !== this.generation)
  }

  sync(manual = true): Promise<CloudSyncResult> {
    if (this.stopped) return Promise.resolve({ success: false, changed: false, error: '同步已停止' })
    if (!manual && this.visible) {
      this.deferred = true
      return Promise.resolve({ success: false, changed: false, error: '窗口显示期间，后台同步已延后' })
    }
    if (this.active) {
      if (!manual) this.deferred = true
      if (manual && !this.activeManual) {
        const active = this.active
        this.api.abort()
        return active.then(() => this.sync(true))
      }
      return this.active
    }
    const generation = this.generation
    this.activeManual = manual
    this.active = this.run(manual, generation).then(result => {
      this.error = result.error ?? null
      if (result.success) this.lastSync = new Date().toISOString()
      return result
    }).finally(() => {
      this.active = null
      this.activeManual = false
      if (!this.stopped && !this.visible && this.deferred) {
        this.deferred = false
        this.schedule()
      }
    })
    const task = this.active
    void task.then(result => { if (!this.stopped) this.onComplete(result) })
    return task
  }

  private async inspect(snapshot: CloudSnapshot, manual: boolean, generation: number): Promise<void> {
    this.guard(manual, generation)
    const binding = await this.db.binding()
    if (!binding || binding.url !== this.api.url) throw new Error('服务器尚未确认接入，未同步本地数据')
    assertSnapshotProgress(snapshot, binding.datasetId, await this.db.metas())
  }

  private async applyBootstrap(snapshot: CloudSnapshot, conflicts: Map<string, string>, manual: boolean, generation: number): Promise<{ changed: boolean; complete: boolean }> {
    await this.inspect(snapshot, manual, generation)
    let changed = false
    let complete = true
    const pending = new Set((await this.db.pending()).map(operation => operation.memoId))
    for (const remote of snapshot.memos) {
      this.guard(manual, generation)
      const conflictOperation = conflicts.get(remote.id)
      if (!conflictOperation && pending.has(remote.id)) {
        complete = false
        continue
      }
      try {
        const filenames = await this.files.download(remote, snapshot.attachments)
        this.guard(manual, generation)
        const applied = await this.db.applyRemote(remote, filenames, conflictOperation)
        if (!applied) {
          complete = false
          continue
        }
        if (conflictOperation) conflicts.delete(remote.id)
        changed = true
      } catch (error) {
        this.guard(manual, generation)
        complete = false
        this.error = error instanceof Error ? error.message : '附件拉取失败'
      }
    }
    return { changed, complete }
  }

  private async applyChanges(binding: { datasetId: string; url: string }, state: CloudPullState, conflicts: Map<string, string>, manual: boolean, generation: number): Promise<{ changed: boolean; complete: boolean }> {
    let cursor = state.cursor
    let through: string | undefined
    let changed = false
    while (true) {
      this.guard(manual, generation)
      const page: CloudChangesPage = await this.api.changes(cursor, through)
      if (page.datasetId !== binding.datasetId) throw new Error('服务器数据集已改变，已停止同步')
      if (through !== undefined && page.highWater !== through) throw new Error('服务器变更页高水位发生变化')
      through ??= page.highWater
      const pending = new Set((await this.db.pending()).map(operation => operation.memoId))
      let complete = true
      for (const change of page.changes) {
        this.guard(manual, generation)
        const conflictOperation = conflicts.get(change.memo.id)
        if (!conflictOperation && pending.has(change.memo.id)) {
          complete = false
          continue
        }
        try {
          const filenames = await this.files.download(change.memo, page.attachments)
          this.guard(manual, generation)
          const applied = await this.db.applyRemote(change.memo, filenames, conflictOperation)
          if (!applied) {
            complete = false
            continue
          }
          if (conflictOperation) conflicts.delete(change.memo.id)
          changed = true
        } catch (error) {
          this.guard(manual, generation)
          complete = false
          this.error = error instanceof Error ? error.message : '附件拉取失败'
        }
      }
      if (!complete) return { changed, complete: false }
      this.guard(manual, generation)
      const pulledAt = new Date().toISOString()
      await this.db.savePullState(binding.datasetId, page.cursor, pulledAt)
      this.lastSync = pulledAt
      cursor = page.cursor
      if (!page.hasMore) return { changed, complete: true }
    }
  }

  private async run(manual: boolean, generation: number): Promise<CloudSyncResult> {
    let changed = false
    const errors: string[] = []
    const failed = new Set<string>()
    const conflicts = new Map<string, string>()
    try {
      const binding = await this.db.binding()
      if (!binding || binding.url !== this.api.url) throw new Error('服务器尚未确认接入，未同步本地数据')
      let operations = 0
      while (operations < 200) {
        this.guard(manual, generation)
        const heads = (await this.db.heads()).filter(operation => !failed.has(operation.memoId))
        if (!heads.length) break
        for (const operation of heads) {
          if (operations++ >= 200) break
          if (operation.state === 'invalid') {
            failed.add(operation.memoId)
            errors.push('部分待办或图片不合法，请修正后重试')
            continue
          }
          if (operation.state === 'conflict') {
            failed.add(operation.memoId)
            conflicts.set(operation.memoId, operation.operationId)
            continue
          }
          try {
            let request = operation.request
            if (!request) {
              const attachmentIds = ['create', 'update', 'restore'].includes(operation.kind) ? await this.files.upload(operation.payload.attachments) : []
              this.guard(manual, generation)
              request = makeRequest(operation, attachmentIds)
              if (!(await this.db.prepare(operation.operationId, request))) continue
            }
            const receipt = validateReceipt(await this.api.mutate(request, operation.operationId), operation.memoId)
            this.guard(manual, generation)
            await this.db.ack(operation.operationId, receipt)
            changed = true
          } catch (error) {
            this.guard(manual, generation)
            if (error instanceof CloudHttpError && error.code === 'dataset_mismatch') throw new Error('服务器数据集已改变，本地操作已保留，已停止同步')
            if (error instanceof CloudHttpError && error.status === 409 && ['version_conflict', 'memo_exists', 'memo_purged'].includes(error.code)) {
              await this.db.mark(operation.operationId, 'conflict', error.code)
              conflicts.set(operation.memoId, operation.operationId)
              failed.add(operation.memoId)
              continue
            }
            if (error instanceof CloudHttpError && [413, 415, 422].includes(error.status)) await this.db.mark(operation.operationId, 'invalid', error.code)
            if (!operation.request && error instanceof CloudAttachmentError) await this.db.mark(operation.operationId, 'invalid', 'invalid_attachment')
            failed.add(operation.memoId)
            errors.push(error instanceof Error ? error.message : '同步失败，已保留本地数据')
          }
        }
      }

      this.guard(manual, generation)
      const currentBinding = await this.db.binding()
      if (!currentBinding || currentBinding.datasetId !== binding.datasetId || currentBinding.url !== this.api.url) throw new Error('服务器尚未确认接入，未同步本地数据')
      const pullState = await this.db.pullState(binding.datasetId)
      if (!pullState) {
        const snapshot = await this.api.snapshot()
        this.guard(manual, generation)
        const result = await this.applyBootstrap(snapshot, conflicts, manual, generation)
        changed = result.changed || changed
        if (result.complete) {
          this.guard(manual, generation)
          const pulledAt = new Date().toISOString()
          await this.db.savePullState(binding.datasetId, snapshot.changeCursor, pulledAt)
          this.lastSync = pulledAt
        } else errors.push('首次数据拉取未完成，已保留同步游标并将在后台重试')
      } else {
        const result = await this.applyChanges(binding, pullState, conflicts, manual, generation)
        changed = result.changed || changed
        if (!result.complete) errors.push('部分远端变更暂未应用，已保留同步游标并将在后台重试')
      }
      const pending = await this.db.pending()
      return errors.length || pending.length
        ? { success: false, changed, error: errors[0] ?? `仍有${pending.length}条操作等待同步` }
        : { success: true, changed }
    } catch (error) {
      if (this.paused(manual, generation)) return { success: false, changed, error: '窗口已显示，后台同步已暂停' }
      return { success: false, changed, error: error instanceof Error ? error.message : '同步失败，已保留本地数据' }
    }
  }
}
