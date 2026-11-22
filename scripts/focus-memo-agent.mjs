#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const STATUSES = new Set(['not_started', 'in_progress', 'completed'])
const PRIORITIES = new Set(['important', 'unimportant'])
const VALUE_OPTIONS = new Map([
  ['data-dir', 'dataDir'], ['user-data-dir', 'userDataDir'], ['config', 'config'],
  ['base-url', 'baseUrl'], ['dataset-id', 'datasetId'], ['timeout-ms', 'timeoutMs'],
  ['idempotency-key', 'idempotencyKey'], ['status', 'status'], ['priority', 'priority'],
  ['tag', 'tag'], ['q', 'q'], ['query', 'q'], ['deleted', 'deleted'], ['limit', 'limit'],
  ['offset', 'offset'], ['content', 'content'], ['type', 'type'], ['device-id', 'deviceId'],
  ['attachment-id', 'attachmentId'], ['base-version', 'baseVersion']
])
const MULTI_OPTIONS = new Set(['tag', 'attachmentId'])
const BOOLEAN_OPTIONS = new Map([
  ['permanent', 'permanent'], ['pretty', 'pretty'], ['clear-tags', 'clearTags']
])

class CliError extends Error {
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.status = options.status
    this.apiCode = options.apiCode
    this.idempotencyKey = options.idempotencyKey
  }
}

function parseArgs(argv) {
  const parsed = { command: null, positionals: [], options: { tags: [], attachmentIds: [] }, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '-h' || token === '--help') {
      parsed.help = true
      continue
    }
    if (token.startsWith('--')) {
      const equalAt = token.indexOf('=')
      const rawName = token.slice(2, equalAt < 0 ? undefined : equalAt)
      const inlineValue = equalAt < 0 ? undefined : token.slice(equalAt + 1)
      if (BOOLEAN_OPTIONS.has(rawName)) {
        if (inlineValue !== undefined) throw new CliError('invalid_arguments', `--${rawName} does not take a value`)
        parsed.options[BOOLEAN_OPTIONS.get(rawName)] = true
        continue
      }
      const optionName = VALUE_OPTIONS.get(rawName)
      if (!optionName) throw new CliError('invalid_arguments', `Unknown option: --${rawName}`)
      const value = inlineValue ?? argv[++i]
      if (value === undefined || value.startsWith('--')) {
        throw new CliError('invalid_arguments', `--${rawName} requires a value`)
      }
      if (MULTI_OPTIONS.has(optionName)) {
        const key = optionName === 'tag' ? 'tags' : 'attachmentIds'
        parsed.options[key].push(value)
      } else {
        if (Object.hasOwn(parsed.options, optionName)) {
          throw new CliError('invalid_arguments', `--${rawName} may only be supplied once`)
        }
        parsed.options[optionName] = value
      }
      continue
    }
    if (!parsed.command) parsed.command = token
    else parsed.positionals.push(token)
  }
  return parsed
}

function helpText() {
  return `Focus Memo Agent CLI\n\nUsage:\n  npm run memo:agent -- <command> [args] [options]\n\nCommands:\n  list                         List/search memos\n  get <id>                     Read one memo\n  add --content <text>         Create a memo\n  update <id>                  Update memo fields\n  complete <id>                Mark a memo completed\n  restore <id>                 Restore a soft-deleted memo\n  delete <id>                  Soft-delete (use --permanent explicitly to purge)\n\nCommon options:\n  --data-dir <path>            Use this active data directory directly\n  --user-data-dir <path>       Read storage-location.json from this directory\n  --config <path>              Read cloud-config.json from this path\n  --base-url <url>             Override configured API base URL\n  --dataset-id <uuid>          Pin a known dataset ID (otherwise read /meta)\n  --timeout-ms <n>             Request timeout (default: 15000)\n  --idempotency-key <uuid>     Reuse this key when retrying the same write\n  --pretty                     Pretty-print JSON output\n\nList options: --status, --priority, --tag, --q, --deleted true|false, --limit, --offset\nAdd options: --content, --status, --priority, --tag (repeatable), --type, --attachment-id\nUpdate options: --base-version, --content, --status, --priority, --tag (repeatable), --clear-tags, --type\nDelete options: --base-version, --permanent\n\nFor writes, always provide the current --base-version for update/complete/restore/delete.\nAll normal output is JSON. Tests use a local mock server; the CLI never reads or writes memos.db.\n`
}

function outputJson(value, pretty = false) {
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`)
}

function requireUuid(value, label) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new CliError('invalid_arguments', `${label} must be a lowercase UUID`)
  }
  return value
}

function requireVersion(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new CliError('invalid_arguments', '--base-version must be a positive version string')
  }
  return value
}

function requireChoice(value, choices, label) {
  if (value !== undefined && !choices.has(value)) {
    throw new CliError('invalid_arguments', `${label} must be one of: ${[...choices].join(', ')}`)
  }
  return value
}

function parseBoundedInteger(value, fallback, min, max, label) {
  if (value === undefined) return fallback
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) {
    throw new CliError('invalid_arguments', `${label} must be an integer`)
  }
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new CliError('invalid_arguments', `${label} must be between ${min} and ${max}`)
  }
  return number
}

function defaultUserDataDir(env) {
  const root = env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return join(root, 'focus-memo')
}

function resolveDataDirectory(options, env) {
  if (options.dataDir || env.FOCUS_MEMO_DATA_DIR) {
    return resolve(options.dataDir || env.FOCUS_MEMO_DATA_DIR)
  }
  const userDataDir = resolve(options.userDataDir || env.FOCUS_MEMO_USER_DATA_DIR || defaultUserDataDir(env))
  const pointerPath = join(userDataDir, 'storage-location.json')
  if (!existsSync(pointerPath)) return userDataDir
  let pointer
  try {
    pointer = JSON.parse(readFileSync(pointerPath, 'utf8'))
  } catch {
    throw new CliError('config_error', `Could not read storage pointer: ${pointerPath}`)
  }
  if (pointer?.version !== 1 || typeof pointer.path !== 'string' || !pointer.path.trim()) {
    throw new CliError('config_error', `Invalid storage pointer: ${pointerPath}`)
  }
  const activeDir = resolve(pointer.path)
  if (!existsSync(activeDir)) {
    throw new CliError('config_error', `Configured data directory does not exist: ${activeDir}`)
  }
  return activeDir
}

function validateBaseUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new CliError('config_error', 'API base URL is invalid')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.href.includes('@') || url.search || url.hash) {
    throw new CliError('config_error', 'API base URL must be HTTP(S) without credentials, query, or fragment')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/+$/, '')
}

function loadRuntimeConfig(options, env) {
  const baseUrlOverride = options.baseUrl || env.FOCUS_MEMO_BASE_URL
  let configPath = options.config || env.FOCUS_MEMO_CONFIG
  if (!baseUrlOverride && !configPath) {
    configPath = join(resolveDataDirectory(options, env), 'cloud-config.json')
  }
  let config = null
  if (!baseUrlOverride && configPath && existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch {
      throw new CliError('config_error', `Could not read cloud configuration: ${configPath}`)
    }
    if (config?.version !== 1 || typeof config.url !== 'string') {
      throw new CliError('config_error', `Invalid cloud configuration: ${configPath}`)
    }
  }
  const rawBaseUrl = baseUrlOverride || config?.url
  if (!rawBaseUrl) {
    throw new CliError('config_error', `No API URL found. Set --base-url or configure ${configPath || 'cloud-config.json'}`)
  }
  const timeoutMs = parseBoundedInteger(options.timeoutMs, 15000, 1000, 120000, '--timeout-ms')
  const datasetId = options.datasetId || env.FOCUS_MEMO_DATASET_ID || null
  if (datasetId) requireUuid(datasetId, 'dataset ID')
  return { baseUrl: validateBaseUrl(rawBaseUrl), datasetId, timeoutMs }
}

function endpointUrl(baseUrl, endpoint) {
  const base = new URL(`${baseUrl}/`)
  const relative = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint
  return new URL(relative, base)
}

async function requestJson(runtime, endpoint, request = {}) {
  const headers = { Accept: 'application/json' }
  if (request.datasetId) headers['X-Focus-Dataset-ID'] = request.datasetId
  if (request.idempotencyKey) headers['Idempotency-Key'] = request.idempotencyKey
  if (request.body !== undefined) headers['Content-Type'] = 'application/json'
  let response
  try {
    response = await fetch(endpointUrl(runtime.baseUrl, endpoint), {
      method: request.method || 'GET',
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: AbortSignal.timeout(runtime.timeoutMs)
    })
  } catch (error) {
    throw new CliError('network_error', error instanceof Error ? error.message : 'Network request failed', {
      idempotencyKey: request.idempotencyKey
    })
  }
  const text = await response.text()
  let payload = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      throw new CliError('invalid_response', `API returned non-JSON data (HTTP ${response.status})`, {
        status: response.status,
        idempotencyKey: request.idempotencyKey
      })
    }
  }
  if (!response.ok) {
    const apiError = payload?.error || {}
    throw new CliError(apiError.code || 'http_error', apiError.message || `HTTP ${response.status}`, {
      status: response.status,
      apiCode: apiError.code,
      idempotencyKey: request.idempotencyKey
    })
  }
  return payload
}

function validateCommand(parsed) {
  const { command, positionals, options } = parsed
  const allowed = new Set(['list', 'get', 'add', 'update', 'complete', 'restore', 'delete'])
  if (!command || !allowed.has(command)) {
    throw new CliError('invalid_arguments', `Command must be one of: ${[...allowed].join(', ')}`)
  }

  const commonOptions = ['dataDir', 'userDataDir', 'config', 'baseUrl', 'datasetId', 'timeoutMs', 'pretty']
  const commandOptions = {
    list: ['status', 'priority', 'tags', 'q', 'deleted', 'limit', 'offset'],
    get: [],
    add: ['idempotencyKey', 'content', 'status', 'priority', 'tags', 'type', 'deviceId', 'attachmentIds'],
    update: ['idempotencyKey', 'baseVersion', 'content', 'status', 'priority', 'tags', 'clearTags', 'type'],
    complete: ['idempotencyKey', 'baseVersion'],
    restore: ['idempotencyKey', 'baseVersion'],
    delete: ['idempotencyKey', 'baseVersion', 'permanent']
  }
  const accepted = new Set([...commonOptions, ...commandOptions[command]])
  for (const [key, value] of Object.entries(options)) {
    const present = Array.isArray(value) ? value.length > 0 : value !== undefined && value !== false
    if (present && !accepted.has(key)) throw new CliError('invalid_arguments', `--${key} is not valid with ${command}`)
  }

  const expected = command === 'list' || command === 'add' ? 0 : 1
  if (positionals.length !== expected) {
    throw new CliError('invalid_arguments', `${command} expects ${expected === 0 ? 'no' : 'one'} positional argument`)
  }
  if (['get', 'update', 'complete', 'restore', 'delete'].includes(command)) requireUuid(positionals[0], 'memo ID')
  if (options.tags.length > 1 && command === 'list') throw new CliError('invalid_arguments', 'list accepts only one --tag filter')
  for (const attachmentId of options.attachmentIds) requireUuid(attachmentId, 'attachment ID')
  requireChoice(options.status, STATUSES, '--status')
  requireChoice(options.priority, PRIORITIES, '--priority')
  if (options.type !== undefined && options.type !== 'text' && options.type !== 'image') {
    throw new CliError('invalid_arguments', '--type must be text or image')
  }
  if (options.deleted !== undefined && options.deleted !== 'true' && options.deleted !== 'false') {
    throw new CliError('invalid_arguments', '--deleted must be true or false')
  }
  if (options.baseVersion !== undefined) requireVersion(options.baseVersion)
  if (options.clearTags && options.tags.length) throw new CliError('invalid_arguments', '--clear-tags cannot be combined with --tag')
  if (command === 'list') {
    parseBoundedInteger(options.limit, 100, 1, 500, '--limit')
    parseBoundedInteger(options.offset, 0, 0, 1000000, '--offset')
  }
  if (command === 'add' && (typeof options.content !== 'string' || (!options.content.trim() && options.attachmentIds.length === 0))) {
    throw new CliError('invalid_arguments', 'add requires non-empty --content or at least one --attachment-id')
  }
  if (command === 'add' && options.type === 'image' && options.attachmentIds.length === 0) {
    throw new CliError('invalid_arguments', 'type image requires at least one --attachment-id')
  }
  if (command === 'add' && options.type === 'text' && options.attachmentIds.length > 0) {
    throw new CliError('invalid_arguments', 'type text cannot include image attachments')
  }
  if (options.deviceId !== undefined && (!options.deviceId || options.deviceId.length > 128)) {
    throw new CliError('invalid_arguments', '--device-id must contain 1 to 128 characters')
  }
  if (['update', 'complete', 'restore', 'delete'].includes(command) && !options.baseVersion) {
    throw new CliError('invalid_arguments', `${command} requires --base-version from the current memo`)
  }
  if (command === 'update' && !['content', 'status', 'priority', 'type'].some((key) => options[key] !== undefined)
    && !options.tags.length && !options.clearTags) {
    throw new CliError('invalid_arguments', 'update requires at least one field to change')
  }
}

async function runCommand(parsed, env = process.env) {
  validateCommand(parsed)
  const { command, positionals, options } = parsed
  const runtime = loadRuntimeConfig(options, env)
  let datasetId = runtime.datasetId
  if (!datasetId) {
    const meta = await requestJson(runtime, '/api/v1/meta')
    datasetId = requireUuid(meta?.datasetId, 'dataset ID returned by /api/v1/meta')
  }
  const id = positionals[0]
  const idempotencyKey = ['add', 'update', 'complete', 'restore', 'delete'].includes(command)
    ? requireUuid(options.idempotencyKey || randomUUID(), 'idempotency key')
    : undefined
  const common = { datasetId, idempotencyKey }
  let data
  if (command === 'list') {
    const params = new URLSearchParams({
      deleted: options.deleted || 'false',
      limit: String(parseBoundedInteger(options.limit, 100, 1, 500, '--limit')),
      offset: String(parseBoundedInteger(options.offset, 0, 0, 1000000, '--offset'))
    })
    if (options.status) params.set('status', options.status)
    if (options.priority) params.set('priority', options.priority)
    if (options.tags[0]) params.set('tag', options.tags[0])
    if (options.q) params.set('q', options.q)
    data = await requestJson(runtime, `/api/v1/memos?${params}`, { datasetId })
  } else if (command === 'get') {
    data = await requestJson(runtime, `/api/v1/memos/${id}`, { datasetId })
  } else if (command === 'add') {
    const body = {
      content: options.content,
      priority: options.priority || 'unimportant',
      status: options.status || 'not_started',
      tags: options.tags.length ? options.tags : ['TODO'],
      attachmentIds: options.attachmentIds
    }
    if (options.type) body.type = options.type
    if (options.deviceId) body.deviceId = options.deviceId
    data = await requestJson(runtime, '/api/v1/memos', { ...common, method: 'POST', body })
  } else if (command === 'update' || command === 'complete' || command === 'restore') {
    const body = { baseVersion: options.baseVersion }
    if (command === 'complete') body.status = 'completed'
    else if (command === 'restore') body.deleted = false
    else {
      for (const key of ['content', 'status', 'priority', 'type']) {
        if (options[key] !== undefined) body[key] = options[key]
      }
      if (options.clearTags) body.tags = []
      else if (options.tags.length) body.tags = options.tags
    }
    data = await requestJson(runtime, `/api/v1/memos/${id}`, { ...common, method: 'PATCH', body })
  } else {
    const params = new URLSearchParams({ baseVersion: options.baseVersion })
    if (options.permanent) params.set('permanent', 'true')
    data = await requestJson(runtime, `/api/v1/memos/${id}?${params}`, { ...common, method: 'DELETE' })
  }
  return {
    ok: true,
    command,
    datasetId,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    data
  }
}

async function main() {
  let parsed
  try {
    parsed = parseArgs(process.argv.slice(2))
    if (parsed.help || !parsed.command) {
      process.stdout.write(helpText())
      return
    }
    const result = await runCommand(parsed)
    outputJson(result, parsed.options.pretty)
  } catch (error) {
    const err = error instanceof CliError
      ? error
      : new CliError('internal_error', error instanceof Error ? error.message : String(error))
    const details = { code: err.code, message: err.message }
    if (err.status !== undefined) details.status = err.status
    if (err.apiCode) details.apiCode = err.apiCode
    if (err.idempotencyKey) details.idempotencyKey = err.idempotencyKey
    outputJson({ ok: false, error: details }, parsed?.options.pretty)
    process.exitCode = err.code === 'invalid_arguments' ? 2 : 1
  }
}

await main()
