import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const CLI_PATH = fileURLToPath(new URL('../scripts/focus-memo-agent.mjs', import.meta.url))
const DATASET_ID = '11111111-1111-4111-8111-111111111111'
const MEMO_ID = '22222222-2222-4222-8222-222222222222'
const IDEMPOTENCY_ID = '33333333-3333-4333-8333-333333333333'

async function startMockServer(handler = () => ({ status: 200, body: {} })) {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      let body
      if (rawBody) {
        try { body = JSON.parse(rawBody) } catch { body = rawBody }
      }
      const request = {
        method: req.method,
        url: new URL(req.url, 'http://127.0.0.1'),
        headers: req.headers,
        body
      }
      requests.push(request)
      const result = request.url.pathname === '/api/v1/meta'
        ? { status: 200, body: { datasetId: DATASET_ID, schemaVersion: 1 } }
        : handler(request)
      res.statusCode = result.status ?? 200
      res.setHeader('Content-Type', 'application/json')
      res.end(result.raw ?? JSON.stringify(result.body ?? {}))
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

function makeDataDirs(root, apiUrl) {
  const dataDir = path.join(root, 'active-data')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(path.join(dataDir, 'cloud-config.json'), JSON.stringify({ version: 1, url: apiUrl }))
  return dataDir
}

function cleanEnv(extra = {}) {
  const env = { ...process.env }
  for (const name of [
    'FOCUS_MEMO_DATA_DIR', 'FOCUS_MEMO_USER_DATA_DIR', 'FOCUS_MEMO_CONFIG',
    'FOCUS_MEMO_BASE_URL', 'FOCUS_MEMO_DATASET_ID', 'FOCUS_MEMO_TEST_TMP'
  ]) delete env[name]
  return { ...env, ...extra }
}

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: cleanEnv(env),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function parseOutput(result) {
  assert.ok(result.stdout.trim(), `CLI returned no JSON; stderr: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

function tempRoot(t) {
  const scratchDir = process.env.FOCUS_MEMO_TEST_TMP || os.tmpdir()
  const root = mkdtempSync(path.join(scratchDir, 'focus-memo-agent-cli-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('list resolves the active storage pointer and sends dataset filters without auth', async (t) => {
  const server = await startMockServer(() => ({ status: 200, body: { memos: [{ id: MEMO_ID, content: 'Report' }] } }))
  t.after(server.close)
  const root = tempRoot(t)
  const userData = path.join(root, 'user-data')
  const dataDir = makeDataDirs(root, server.url)
  mkdirSync(userData, { recursive: true })
  writeFileSync(path.join(userData, 'storage-location.json'), JSON.stringify({ version: 1, path: dataDir }))

  const result = await runCli(['list', '--q', 'report', '--status', 'not_started', '--limit', '5'], {
    FOCUS_MEMO_USER_DATA_DIR: userData
  })
  assert.equal(result.code, 0, result.stderr)
  const output = parseOutput(result)
  assert.equal(output.ok, true)
  assert.equal(output.datasetId, DATASET_ID)
  assert.deepEqual(output.data.memos, [{ id: MEMO_ID, content: 'Report' }])
  assert.equal(server.requests.length, 2)
  assert.equal(server.requests[0].url.pathname, '/api/v1/meta')
  assert.equal(server.requests[0].headers.authorization, undefined)
  const listRequest = server.requests[1]
  assert.equal(listRequest.url.pathname, '/api/v1/memos')
  assert.equal(listRequest.url.searchParams.get('q'), 'report')
  assert.equal(listRequest.url.searchParams.get('status'), 'not_started')
  assert.equal(listRequest.url.searchParams.get('deleted'), 'false')
  assert.equal(listRequest.url.searchParams.get('limit'), '5')
  assert.equal(listRequest.url.searchParams.get('offset'), '0')
  assert.equal(listRequest.headers['x-focus-dataset-id'], DATASET_ID)
  assert.equal(listRequest.headers.authorization, undefined)
})

test('add sends the required idempotency key and API defaults', async (t) => {
  const server = await startMockServer((request) => request.method === 'POST'
    ? { status: 201, body: { id: MEMO_ID, appliedVersion: '1' } }
    : { status: 404, body: { error: { code: 'not_found', message: 'unexpected request' } } })
  t.after(server.close)
  const root = tempRoot(t)
  const dataDir = makeDataDirs(root, server.url)
  const result = await runCli(['add', '--data-dir', dataDir, '--content', 'Prepare report', '--tag', 'work'])
  assert.equal(result.code, 0, result.stderr)
  const output = parseOutput(result)
  assert.equal(output.ok, true)
  assert.match(output.idempotencyKey, /^[0-9a-f-]{36}$/)
  const request = server.requests[1]
  assert.equal(request.method, 'POST')
  assert.equal(request.url.pathname, '/api/v1/memos')
  assert.equal(request.headers['x-focus-dataset-id'], DATASET_ID)
  assert.equal(request.headers['idempotency-key'], output.idempotencyKey)
  assert.equal(request.headers.authorization, undefined)
  assert.deepEqual(request.body, {
    content: 'Prepare report',
    priority: 'unimportant',
    status: 'not_started',
    tags: ['work'],
    attachmentIds: []
  })
})

test('update carries the current version, supplied idempotency key, and changed fields', async (t) => {
  const server = await startMockServer(() => ({ status: 200, body: { id: MEMO_ID, appliedVersion: '4' } }))
  t.after(server.close)
  const root = tempRoot(t)
  const dataDir = makeDataDirs(root, server.url)
  const result = await runCli([
    'update', MEMO_ID, '--data-dir', dataDir, '--base-version', '3', '--priority', 'important',
    '--tag', 'work', '--tag', 'today', '--idempotency-key', IDEMPOTENCY_ID
  ])
  assert.equal(result.code, 0, result.stderr)
  const output = parseOutput(result)
  assert.equal(output.idempotencyKey, IDEMPOTENCY_ID)
  const request = server.requests[1]
  assert.equal(request.method, 'PATCH')
  assert.equal(request.url.pathname, `/api/v1/memos/${MEMO_ID}`)
  assert.equal(request.headers['idempotency-key'], IDEMPOTENCY_ID)
  assert.deepEqual(request.body, { baseVersion: '3', priority: 'important', tags: ['work', 'today'] })
})

test('delete is soft by default and only purges with an explicit flag', async (t) => {
  const server = await startMockServer(() => ({ status: 200, body: { id: MEMO_ID, appliedVersion: '5' } }))
  t.after(server.close)
  const root = tempRoot(t)
  const dataDir = makeDataDirs(root, server.url)
  const soft = await runCli(['delete', MEMO_ID, '--data-dir', dataDir, '--base-version', '4'])
  assert.equal(soft.code, 0, soft.stderr)
  const softRequest = server.requests[1]
  assert.equal(softRequest.method, 'DELETE')
  assert.equal(softRequest.url.searchParams.get('baseVersion'), '4')
  assert.equal(softRequest.url.searchParams.has('permanent'), false)

  const permanent = await runCli(['delete', MEMO_ID, '--data-dir', dataDir, '--base-version', '5', '--permanent'])
  assert.equal(permanent.code, 0, permanent.stderr)
  const permanentRequest = server.requests[3]
  assert.equal(permanentRequest.url.searchParams.get('baseVersion'), '5')
  assert.equal(permanentRequest.url.searchParams.get('permanent'), 'true')
})

test('version conflicts are reported as JSON and a failed write is not retried', async (t) => {
  const server = await startMockServer((request) => request.method === 'PATCH'
    ? { status: 409, body: { error: { code: 'version_conflict', message: 'Server version changed' } } }
    : { status: 200, body: { id: MEMO_ID, content: 'Task', version: '3' } })
  t.after(server.close)
  const root = tempRoot(t)
  const dataDir = makeDataDirs(root, server.url)
  const result = await runCli([
    'update', MEMO_ID, '--data-dir', dataDir, '--base-version', '2', '--content', 'Changed',
    '--idempotency-key', IDEMPOTENCY_ID
  ])
  assert.equal(result.code, 1)
  const output = parseOutput(result)
  assert.equal(output.ok, false)
  assert.equal(output.error.code, 'version_conflict')
  assert.equal(output.error.status, 409)
  assert.equal(output.error.idempotencyKey, IDEMPOTENCY_ID)
  assert.equal(server.requests.filter((request) => request.method === 'PATCH').length, 1)
})

test('get, complete, and restore use the expected read/write contracts', async (t) => {
  const server = await startMockServer((request) => request.method === 'GET'
    ? { status: 200, body: { id: MEMO_ID, content: 'Task', version: '7', deleted: true } }
    : { status: 200, body: { id: MEMO_ID, appliedVersion: '8' } })
  t.after(server.close)
  const root = tempRoot(t)
  const dataDir = makeDataDirs(root, server.url)

  const get = await runCli(['get', MEMO_ID, '--data-dir', dataDir])
  assert.equal(get.code, 0, get.stderr)
  assert.equal(server.requests[1].method, 'GET')
  assert.equal(server.requests[1].url.pathname, `/api/v1/memos/${MEMO_ID}`)
  assert.equal(server.requests[1].headers['x-focus-dataset-id'], DATASET_ID)

  const complete = await runCli(['complete', MEMO_ID, '--data-dir', dataDir, '--base-version', '7'])
  assert.equal(complete.code, 0, complete.stderr)
  assert.equal(server.requests[3].method, 'PATCH')
  assert.deepEqual(server.requests[3].body, { baseVersion: '7', status: 'completed' })
  assert.match(server.requests[3].headers['idempotency-key'], /^[0-9a-f-]{36}$/)

  const restore = await runCli(['restore', MEMO_ID, '--data-dir', dataDir, '--base-version', '8'])
  assert.equal(restore.code, 0, restore.stderr)
  assert.equal(server.requests[5].method, 'PATCH')
  assert.deepEqual(server.requests[5].body, { baseVersion: '8', deleted: false })
})

test('update refuses to write without a base version before making requests', async (t) => {
  const server = await startMockServer()
  t.after(server.close)
  const root = tempRoot(t)
  const dataDir = makeDataDirs(root, server.url)
  const result = await runCli(['update', MEMO_ID, '--data-dir', dataDir, '--content', 'Changed'])
  assert.equal(result.code, 2)
  assert.equal(parseOutput(result).error.code, 'invalid_arguments')
  assert.equal(server.requests.length, 0)
})
