import { safeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateServerURL } from './cloudProtocol'

export interface CloudConfig { url: string; token: string }
export function loadCloudConfig(root: string): CloudConfig | null {
  const path = join(root, 'cloud-config.json')
  if (!existsSync(path)) return null
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (value.version !== 1 || typeof value.tokenCipher !== 'string' || !safeStorage.isEncryptionAvailable()) throw new Error('Invalid credential storage')
    return { url: validateServerURL(value.url), token: safeStorage.decryptString(Buffer.from(value.tokenCipher, 'base64')) }
  } catch { throw new Error('本机服务器凭证不可用，请重新配置；本地数据不受影响') }
}
export function saveCloudConfig(root: string, config: CloudConfig): void {
  const url = validateServerURL(config.url)
  if (config.token.length < 32 || /\s/.test(config.token)) throw new Error('Token至少需要32个非空白字符')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，未保存Token')
  const tokenCipher = safeStorage.encryptString(config.token).toString('base64')
  const path = join(root, 'cloud-config.json')
  writeFileSync(path + '.tmp', JSON.stringify({ version: 1, url, tokenCipher }), { mode: 0o600 })
  renameSync(path + '.tmp', path)
}
