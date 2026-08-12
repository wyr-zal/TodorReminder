import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import * as fs from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { MemoData } from '../shared/types'

interface SyncConfig {
  token: string
  repo: string  // format: owner/repo
  branch: string
}

interface SyncStatus {
  lastSync: string | null
  isSyncing: boolean
  error: string | null
}

let syncConfig: SyncConfig | null = null
let syncStatus: SyncStatus = {
  lastSync: null,
  isSyncing: false,
  error: null
}

const CONFIG_FILE = 'sync-config.json'
const DATA_FILE = 'data/memos.json'

function getRepoDir(): string {
  return join(app.getPath('userData'), 'sync-repo')
}

function getConfigPath(): string {
  return join(app.getPath('userData'), CONFIG_FILE)
}

// 加载同步配置
export function loadSyncConfig(): SyncConfig | null {
  try {
    const configPath = getConfigPath()
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf-8')
      syncConfig = JSON.parse(data)
      return syncConfig
    }
  } catch (error) {
    console.error('Failed to load sync config:', error)
  }
  return null
}

// 保存同步配置
export function saveSyncConfig(config: SyncConfig): void {
  try {
    const configPath = getConfigPath()
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
    syncConfig = config
  } catch (error) {
    console.error('Failed to save sync config:', error)
  }
}

// 获取同步状态
export function getSyncStatus(): SyncStatus {
  return { ...syncStatus }
}

// 初始化或克隆仓库
export async function initRepo(): Promise<boolean> {
  if (!syncConfig) {
    syncStatus.error = '未配置同步'
    return false
  }

  const dir = getRepoDir()
  const url = `https://github.com/${syncConfig.repo}.git`

  try {
    // 检查目录是否已存在
    if (fs.existsSync(join(dir, '.git'))) {
      // 确保 remote 存在
      const remotes = await git.listRemotes({ fs, dir })
      if (!remotes.find(r => r.remote === 'origin')) {
        await git.addRemote({ fs, dir, remote: 'origin', url })
      }
      return true
    }

    // 创建目录
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    // 尝试克隆
    await git.clone({
      fs,
      http,
      dir,
      url,
      ref: syncConfig.branch || 'main',
      singleBranch: true,
      depth: 1,
      onAuth: () => ({ username: syncConfig!.token, password: 'x-oauth-basic' })
    })

    return true
  } catch (error: any) {
    // 如果仓库为空或不存在，初始化新仓库
    console.log('Clone failed, initializing local repo:', error.message)
    try {
      // 清理目录重新初始化
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true })
      }
      fs.mkdirSync(dir, { recursive: true })

      await git.init({ fs, dir, defaultBranch: syncConfig.branch || 'main' })

      // 添加 remote origin
      await git.addRemote({ fs, dir, remote: 'origin', url })

      // 创建初始文件结构
      const dataDir = join(dir, 'data')
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true })
      }

      const initialData: MemoData = {
        version: '1.0',
        lastSync: new Date().toISOString(),
        memos: []
      }
      fs.writeFileSync(join(dir, DATA_FILE), JSON.stringify(initialData, null, 2))

      // 创建 .gitignore
      fs.writeFileSync(join(dir, '.gitignore'), 'node_modules\n.DS_Store\n')

      // 添加并提交
      await git.add({ fs, dir, filepath: '.' })
      await git.commit({
        fs,
        dir,
        message: 'Initial commit',
        author: { name: 'Focus Memo', email: 'focusmemo@local' }
      })

      return true
    } catch (initError) {
      syncStatus.error = `初始化仓库失败: ${initError}`
      console.error('Init repo failed:', initError)
      return false
    }
  }
}

// 拉取远程更新
export async function pull(): Promise<MemoData | null> {
  if (!syncConfig) return null

  const dir = getRepoDir()

  try {
    await git.pull({
      fs,
      http,
      dir,
      ref: syncConfig.branch || 'main',
      singleBranch: true,
      author: { name: 'Focus Memo', email: 'focusmemo@local' },
      onAuth: () => ({ username: syncConfig!.token, password: 'x-oauth-basic' })
    })

    // 读取数据文件
    const dataPath = join(dir, DATA_FILE)
    if (fs.existsSync(dataPath)) {
      const data = fs.readFileSync(dataPath, 'utf-8')
      return JSON.parse(data)
    }

    return null
  } catch (error: any) {
    syncStatus.error = `拉取失败: ${error.message}`
    return null
  }
}

// 推送到远程
export async function push(data: MemoData): Promise<boolean> {
  if (!syncConfig) return false

  const dir = getRepoDir()
  syncStatus.isSyncing = true
  syncStatus.error = null

  try {
    // 写入数据文件
    const dataPath = join(dir, DATA_FILE)
    const dataDir = join(dir, 'data')

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }

    data.lastSync = new Date().toISOString()
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2))

    // 添加到暂存区
    await git.add({ fs, dir, filepath: DATA_FILE })

    // 检查是否有变更
    const status = await git.status({ fs, dir, filepath: DATA_FILE })
    if (status === 'unmodified') {
      syncStatus.isSyncing = false
      syncStatus.lastSync = new Date().toISOString()
      return true
    }

    // 提交
    await git.commit({
      fs,
      dir,
      message: `Sync: ${new Date().toLocaleString()}`,
      author: { name: 'Focus Memo', email: 'focusmemo@local' }
    })

    // 推送
    await git.push({
      fs,
      http,
      dir,
      remote: 'origin',
      ref: syncConfig.branch || 'main',
      onAuth: () => ({ username: syncConfig!.token, password: 'x-oauth-basic' })
    })

    syncStatus.lastSync = new Date().toISOString()
    syncStatus.isSyncing = false
    return true
  } catch (error: any) {
    syncStatus.error = `推送失败: ${error.message}`
    syncStatus.isSyncing = false
    return false
  }
}

// 完整同步流程
export async function sync(localData: MemoData): Promise<MemoData | null> {
  syncStatus.isSyncing = true
  syncStatus.error = null

  try {
    // 1. 初始化仓库
    const initialized = await initRepo()
    if (!initialized) {
      syncStatus.isSyncing = false
      return null
    }

    // 2. 拉取远程数据
    const remoteData = await pull()

    // 3. 合并数据 (简单策略：以更新时间为准)
    let mergedData: MemoData
    if (remoteData) {
      mergedData = mergeData(localData, remoteData)
    } else {
      mergedData = localData
    }

    // 4. 推送合并后的数据
    await push(mergedData)

    syncStatus.isSyncing = false
    syncStatus.lastSync = new Date().toISOString()
    return mergedData
  } catch (error: any) {
    syncStatus.error = `同步失败: ${error.message}`
    syncStatus.isSyncing = false
    return null
  }
}

// 合并数据 (以 updatedAt 时间为准)
function mergeData(local: MemoData, remote: MemoData): MemoData {
  const memoMap = new Map<string, any>()

  // 先添加远程数据
  for (const memo of remote.memos) {
    memoMap.set(memo.id, memo)
  }

  // 用本地数据覆盖（如果更新时间更晚）
  for (const memo of local.memos) {
    const existing = memoMap.get(memo.id)
    if (!existing || new Date(memo.updatedAt) > new Date(existing.updatedAt)) {
      memoMap.set(memo.id, memo)
    }
  }

  return {
    version: '1.0',
    lastSync: new Date().toISOString(),
    memos: Array.from(memoMap.values())
  }
}
