import type { CloudChangesPage, CloudOperation, CloudSnapshot, CloudStatus, CloudPullState, CloudSyncResult } from '../shared/cloudTypes'
import type { Memo } from '../shared/types'
import { CloudApi, CloudHttpError } from './cloudApi'
import { CloudAttachments, CloudAttachmentError } from './cloudAttachments'
import type { CloudDatabase } from './cloudDatabase'
import { assertSnapshotProgress, makeRequest, validateReceipt } from './cloudProtocol'

export type { CloudSyncResult }

type SyncKind = 'push' | 'pull' | 'full'
type PushOutcome = { changed: boolean; errors: string[]; retryable: boolean; conflicted: boolean }
type PullOutcome = { changed: boolean; errors: string[] }

const PUSH_DEBOUNCE_MS = 300
const PUSH_BACKOFF_MS = [2000, 5000, 15000, 30000, 60000]
const MAX_PUSH_OPERATIONS = 200
const HIDDEN_SYNC_DEBOUNCE_MS = 500
const HIDDEN_SYNC_INTERVAL_MS = 10 * 60 * 1000
const CONFLICT_PULL_DELAY_MS = 300

export class CloudSync {
  private active: Promise<CloudSyncResult> | null = null
  private activeKind: SyncKind | null = null
  private activeManual = false
  private stopped = false
  private started = false
  private visible = true
  private generation = 0
  private interval: ReturnType<typeof setInterval> | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private pullTimer: ReturnType<typeof setTimeout> | null = null
  private deferred = false
  private queuedPush = false
  private needConflictPull = false
  private pushSucceeded = false
  private pushRetryable = false
  private retryIndex = 0
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
      // 前台只暂停拉取；本地写入的推送继续执行并保留退避重试。
      if (this.active && !this.activeManual && this.activeKind !== 'push') this.api.abort()
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
      void this.startTask('full', false)
    }, HIDDEN_SYNC_DEBOUNCE_MS)
  }

  noteLocalChange(): void {
    if (this.stopped) return
    this.schedulePush(PUSH_DEBOUNCE_MS)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.generation++
    if (this.interval) clearInterval(this.interval)
    if (this.debounce) clearTimeout(this.debounce)
    if (this.pushTimer) clearTimeout(this.pushTimer)
    if (this.pullTimer) clearTimeout(this.pullTimer)
    this.interval = null
    this.debounce = null
    this.pushTimer = null
    this.pullTimer = null
    this.api.abort()
    if (this.active) await this.active
  }

  private startBackgroundSchedule(): void {
    if (this.stopped || this.visible) return
    if (!this.interval) this.interval = setInterval(() => { void this.startTask('full', false) }, HIDDEN_SYNC_INTERVAL_MS)
    this.schedule()
  }

  private assertRunning(): void {
    if (this.stopped) throw new Error('同步已停止，本地操作已保留')
  }

  private guard(manual: boolean, generation: number): void {
    this.assertRunning()
    if (!manual && (this.visible || generation !== this.generation)) throw new Error('窗口已显示，后台同步已暂停')
  }

  private isRetryable(error: unknown): boolean {
    return error instanceof CloudHttpError && (error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500)
  }

  private schedulePush(delay: number): void {
    if (this.stopped) return
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      void this.pushNow()
    }, delay)
  }

  pushNow(): Promise<CloudSyncResult> {
    if (this.stopped) return Promise.resolve({ success: false, changed: false, error: '同步已停止' })
    if (this.active) {
      this.queuedPush = true
      return this.active
    }
    return this.startTask('push', false)
  }

  sync(manual = true): Promise<CloudSyncResult> {
    return this.startTask('full', manual)
  }

  private startTask(kind: SyncKind, manual: boolean): Promise<CloudSyncResult> {
    if (this.stopped) return Promise.resolve({ success: false, changed: false, error: '同步已停止' })
    if (!manual && kind !== 'push' && this.visible) {
      this.deferred = true
      return Promise.resolve({ success: false, changed: false, error: '窗口显示期间，后台同步已延后' })
    }
    if (this.active) {
      if (kind === 'push') {
        this.queuedPush = true
        return this.active
      }
      if (!manual) {
        this.deferred = true
        return this.active
      }
      if (!this.activeManual) {
        const active = this.active
        this.api.abort()
        return active.then(() => this.startTask(kind, manual))
      }
      return this.active
    }
    const generation = this.generation
    this.activeKind = kind
    this.activeManual = manual
    this.pushSucceeded = false
    this.pushRetryable = false
    this.active = this.run(kind, manual, generation).then(result => {
      this.error = result.error ?? null
      if (result.success) {
        this.lastSync = new Date().toISOString()
        if (kind === 'push') this.pushSucceeded = true
      }
      return result
    }).finally(() => {
      this.active = null
      this.activeKind = null
      this.activeManual = false
      if (!this.stopped) this.finishTask(kind)
    })
    const task = this.active
    void task.then(result => { if (!this.stopped) this.onComplete(result) })
    return task
  }

  private finishTask(kind: SyncKind): void {
    if (kind === 'push') {
      if (this.pushSucceeded) {
        this.retryIndex = 0
      } else if (this.pushRetryable) {
        this.retryIndex = Math.min(this.retryIndex + 1, PUSH_BACKOFF_MS.length)
        this.schedulePush(PUSH_BACKOFF_MS[this.retryIndex - 1])
      } else {
        this.retryIndex = 0
      }
    }
    if (this.needConflictPull) {
      this.needConflictPull = false
      this.pullTimer = setTimeout(() => {
        this.pullTimer = null
        void this.startTask('full', true)
      }, CONFLICT_PULL_DELAY_MS)
    }
    if (this.queuedPush) {
      this.queuedPush = false
      if (!this.pushTimer && !this.pullTimer) this.schedulePush(0)
    }
    if (!this.visible && this.deferred) {
      this.deferred = false
      this.schedule()
    }
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

  private async pushPending(conflicts: Map<string, string>): Promise<PushOutcome> {
    let changed = false
    const errors: string[] = []
    const failed = new Set<string>()
    let retryable = false
    let conflicted = false
    let operations = 0
    while (operations < MAX_PUSH_OPERATIONS) {
      this.assertRunning()
      const heads = (await this.db.heads()).filter(operation => !failed.has(operation.memoId))
      if (!heads.length) break
      for (const operation of heads) {
        if (operations++ >= MAX_PUSH_OPERATIONS) {
          retryable = true
          break
        }
        this.assertRunning()
        if (operation.state === 'invalid') {
          failed.add(operation.memoId)
          errors.push('部分待办或图片不合法，请修正后重试')
          continue
        }
        if (operation.state === 'conflict') {
          failed.add(operation.memoId)
          conflicts.set(operation.memoId, operation.operationId)
          conflicted = true
          continue
        }
        try {
          let request = operation.request
          if (!request) {
            const attachmentIds = ['create', 'update', 'restore'].includes(operation.kind) ? await this.files.upload(operation.payload.attachments) : []
            this.assertRunning()
            request = makeRequest(operation, attachmentIds)
            if (!(await this.db.prepare(operation.operationId, request))) continue
          }
          const receipt = validateReceipt(await this.api.mutate(request, operation.operationId), operation.memoId)
          this.assertRunning()
          await this.db.ack(operation.operationId, receipt)
          changed = true
        } catch (error) {
          this.assertRunning()
          if (error instanceof CloudHttpError && error.code === 'dataset_mismatch') throw new Error('服务器数据集已改变，本地操作已保留，已停止同步')
          if (error instanceof CloudHttpError && error.status === 409 && ['version_conflict', 'memo_exists', 'memo_purged'].includes(error.code)) {
            await this.db.mark(operation.operationId, 'conflict', error.code)
            conflicts.set(operation.memoId, operation.operationId)
            failed.add(operation.memoId)
            conflicted = true
            continue
          }
          if (error instanceof CloudHttpError && [413, 415, 422].includes(error.status)) await this.db.mark(operation.operationId, 'invalid', error.code)
          if (!operation.request && error instanceof CloudAttachmentError) await this.db.mark(operation.operationId, 'invalid', 'invalid_attachment')
          failed.add(operation.memoId)
          errors.push(error instanceof Error ? error.message : '同步失败，已保留本地数据')
          if (this.isRetryable(error)) retryable = true
        }
      }
    }
    if (!retryable) {
      const remaining = (await this.db.heads()).filter(operation => !failed.has(operation.memoId))
      if (remaining.length) retryable = true
    }
    return { changed, errors, retryable, conflicted }
  }

  private async pullAll(binding: { datasetId: string; url: string }, conflicts: Map<string, string>, manual: boolean, generation: number): Promise<PullOutcome> {
    const errors: string[] = []
    const pullState = await this.db.pullState(binding.datasetId)
    if (!pullState) {
      const snapshot = await this.api.snapshot()
      this.guard(manual, generation)
      const result = await this.applyBootstrap(snapshot, conflicts, manual, generation)
      if (result.complete) {
        this.guard(manual, generation)
        const pulledAt = new Date().toISOString()
        await this.db.savePullState(binding.datasetId, snapshot.changeCursor, pulledAt)
        this.lastSync = pulledAt
      } else errors.push('首次数据拉取未完成，已保留同步游标并将在后台重试')
      return { changed: result.changed, errors }
    }
    const result = await this.applyChanges(binding, pullState, conflicts, manual, generation)
    if (!result.complete) errors.push('部分远端变更暂未应用，已保留同步游标并将在后台重试')
    return { changed: result.changed, errors }
  }

  private async run(kind: SyncKind, manual: boolean, generation: number): Promise<CloudSyncResult> {
    let changed = false
    let pulled = false
    const errors: string[] = []
    const conflicts = new Map<string, string>()
    this.pushRetryable = false
    try {
      const binding = await this.db.binding()
      if (!binding || binding.url !== this.api.url) throw new Error('服务器尚未确认接入，未同步本地数据')
      if (kind !== 'pull') {
        const pushed = await this.pushPending(conflicts)
        changed = pushed.changed || changed
        errors.push(...pushed.errors)
        this.pushRetryable = pushed.retryable
        if (kind === 'push' && pushed.conflicted) this.needConflictPull = true
      }
      if (kind !== 'push') {
        const currentBinding = await this.db.binding()
        if (!currentBinding || currentBinding.datasetId !== binding.datasetId || currentBinding.url !== this.api.url) throw new Error('服务器尚未确认接入，未同步本地数据')
        const result = await this.pullAll(binding, conflicts, manual, generation)
        changed = result.changed || changed
        pulled = result.changed
        errors.push(...result.errors)
      }
      const pending = await this.db.pending()
      return errors.length || pending.length
        ? { success: false, changed, pulled, error: errors[0] ?? `仍有${pending.length}条操作等待同步` }
        : { success: true, changed, pulled }
    } catch (error) {
      if (this.stopped) return { success: false, changed, pulled, error: '同步已停止' }
      if (kind !== 'push' && !manual && (this.visible || generation !== this.generation)) return { success: false, changed, pulled, error: '窗口已显示，后台同步已暂停' }
      if (kind === 'push') this.pushRetryable = this.pushRetryable || this.isRetryable(error)
      return { success: false, changed, pulled, error: error instanceof Error ? error.message : '同步失败，已保留本地数据' }
    }
  }
}
