import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateServerURL } from './cloudProtocol'

export interface CloudConfig { url: string }
export function loadCloudConfig(root: string): CloudConfig | null {
  const path = join(root, 'cloud-config.json')
  if (!existsSync(path)) return null
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (value.version !== 1 || typeof value.url !== 'string') throw new Error('Invalid server configuration')
    return { url: validateServerURL(value.url) }
  } catch { throw new Error('本机服务器配置不可用，请重新配置；本地数据不受影响') }
}
export function saveCloudConfig(root: string, config: CloudConfig): void {
  const url = validateServerURL(config.url)
  const path = join(root, 'cloud-config.json')
  writeFileSync(path + '.tmp', JSON.stringify({ version: 1, url }), { mode: 0o600 })
  renameSync(path + '.tmp', path)
}
