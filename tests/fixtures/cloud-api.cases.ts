import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CloudApi, CloudHttpError } from '../../src/main/cloudApi'
const token = 'fixture-0123456789abcdef0123456789abcdef'
async function listen(server: Server): Promise<string> {
 await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
 return 'http://127.0.0.1:' + (server.address() as AddressInfo).port
}
async function stop(server: Server): Promise<void> {
 server.closeAllConnections()
 await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
test('HTTP redirects never forward credentials to another origin', async () => {
 let received = false
 const target = createServer((_, res) => { received = true; res.end('{}') })
 const targetURL = await listen(target)
 const source = createServer((_, res) => { res.writeHead(307, { Location: targetURL + '/private' }); res.end() })
 const sourceURL = await listen(source)
 try { await assert.rejects(new CloudApi(sourceURL, token).meta()); assert.equal(received, false) }
 finally { await stop(source); await stop(target) }
})
test('raw error bodies and malformed JSON cannot leak secrets or be accepted', async () => {
 const server = createServer((req, res) => {
  if (req.url === '/api/v1/meta') { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'unavailable', message: token + ' private-db-secret' } })) }
  else res.end('<html>not a snapshot</html>')
 })
 const url = await listen(server)
 try {
  await assert.rejects(new CloudApi(url, token).meta(), error => error instanceof CloudHttpError && !error.message.includes(token) && !error.message.includes('private-db-secret'))
  await assert.rejects(new CloudApi(url, token).snapshot())
 } finally { await stop(server) }
})
test('incremental changes request is dataset-bound and validates empty high-water pages', async () => {
 const datasetId = '11111111-1111-4111-8111-111111111111'
 let authorizedDataset = ''
 const server = createServer((req, res) => {
  authorizedDataset = String(req.headers['x-focus-dataset-id'] ?? '')
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ datasetId, schemaVersion: 1, cursor: '0', highWater: '0', hasMore: false, changes: [], attachments: [] }))
 })
 const url = await listen(server)
 try {
  const api = new CloudApi(url, token)
  api.expectDataset(datasetId)
  const page = await api.changes('0')
  assert.equal(page.cursor, '0')
  assert.equal(page.highWater, '0')
  assert.equal(authorizedDataset, datasetId)
 } finally { await stop(server) }
})
test('stopping sync aborts an outstanding HTTP request', async () => {
 let seen!: () => void
 const requested = new Promise<void>(resolve => { seen = resolve })
 const server = createServer(() => seen())
 const url = await listen(server)
 try {
  const api = new CloudApi(url, token)
  const outcome = api.meta().then(() => null, error => error)
  await requested; api.abort()
  assert.ok(await outcome instanceof CloudHttpError)
 } finally { await stop(server) }
})
