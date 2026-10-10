import { app } from 'electron'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as database from '../../src/main/database'
import { CloudController } from '../../src/main/cloudController'
import { migrateStorageData } from '../../src/main/storage'

const dir = process.env.CLOUD_TEST_DIR!
mkdirSync(dir, { recursive: true })
app.setPath('userData', dir)

app.whenReady().then(async () => {
  try {
    await database.initDatabase()
    const local = { id: randomUUID(), content: 'initial import', type: 'image' as const, priority: 'important' as const, status: 'completed' as const, attachments: ['initial.png'], tags: ['initial'], createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-02-01T00:00:00.000Z', completedAt: '2020-02-01T00:00:00.000Z', deviceId: 'fixture', deleted: false }
    await database.createMemo(local)
    const controller = new CloudController(database.getCloudDatabase(), async () => {
      const [active, deleted] = await Promise.all([database.getAllMemos(), database.getDeletedMemos()])
      return [...active, ...deleted]
    }, dir)
    await controller.save({ url: process.env.CLOUD_TEST_URL!, token: process.env.CLOUD_TEST_TOKEN! })
    assert.equal((await controller.view()).hasToken, true)
    assert.equal((await controller.view()).connected, false)
    assert.equal((await controller.view() as any).token, undefined)
    assert.ok(!readFileSync(join(dir, 'cloud-config.json'), 'utf8').includes(process.env.CLOUD_TEST_TOKEN!))

    let preview = await controller.preview()
    assert.deepEqual(preview.missingImages, ['initial.png'])
    await assert.rejects(controller.confirm(preview.ticket))
    mkdirSync(join(dir, 'attachments'), { recursive: true })
    copyFileSync(process.env.CLOUD_TEST_IMAGE!, join(dir, 'attachments', 'initial.png'))
    preview = await controller.preview()
    await database.updateMemo(local.id, { content: 'changed during preview' })
    await assert.rejects(controller.confirm(preview.ticket), /变化/)
    preview = await controller.preview()
    await controller.confirm(preview.ticket)
    assert.equal((await controller.view()).connected, true)
    assert.equal((await controller.sync()).success, true)
    assert.ok(readdirSync(join(dir, 'cloud-backups')).length)
    const backup = join(dir, 'cloud-backups', readdirSync(join(dir, 'cloud-backups'))[0])
    assert.ok(existsSync(join(backup, 'memos.db')))
    assert.ok(existsSync(join(backup, 'attachments', 'initial.png')))
    assert.equal(Date.parse((await database.getMemoById(local.id))!.createdAt), Date.parse(local.createdAt), 'initial migration preserves historical creation time')
    assert.equal(Date.parse((await database.getMemoById(local.id))!.completedAt!), Date.parse(local.completedAt), 'initial migration preserves historical completion time')

    await controller.save({ url: process.env.CLOUD_TEST_URL!, token: '' })
    assert.equal((await controller.view()).hasToken, true)
    await Promise.all([
      controller.save({ url: process.env.CLOUD_TEST_URL!, token: '' }),
      controller.save({ url: 'http://127.0.0.1:1', token: '' })
    ])
    assert.equal((await controller.view()).url, 'http://127.0.0.1:1')
    assert.equal((await controller.status()).connected, false, 'last config must not leave an old worker running')
    await controller.save({ url: process.env.CLOUD_TEST_URL!, token: '' })
    const dataset = (await database.getCloudDatabase().binding())!.datasetId
    await controller.stop()
    await database.closeDatabase()

    const restored = join(dir, 'restored')
    cpSync(backup, restored, { recursive: true, errorOnExist: true })
    app.setPath('userData', restored)
    await database.initDatabase()
    assert.equal((await database.getMemoById(local.id))?.content, 'changed during preview')
    assert.equal((await database.getMemoById(local.id))?.createdAt, local.createdAt)
    assert.deepEqual(readFileSync(join(restored, 'attachments', 'initial.png')), readFileSync(process.env.CLOUD_TEST_IMAGE!))
    assert.equal(await database.getCloudDatabase().binding(), null, 'restored pre-import backup must not upload automatically')
    await database.getCloudDatabase().bind(dataset, process.env.CLOUD_TEST_URL!, [(await database.getMemoById(local.id))!])
    await database.updateMemo(local.id, { content: 'pending during directory migration' })
    const queue = await database.getCloudDatabase().pending()
    await database.closeDatabase()

    const migrated = join(dir, 'migrated')
    const result = await migrateStorageData(restored, migrated, join(dir, 'pointer'), { inspectDatabase: database.inspectDatabaseFile })
    assert.equal(result.success, true, result.error)
    assert.ok(existsSync(join(migrated, 'cloud-config.json')))
    app.setPath('userData', migrated)
    await database.initDatabase()
    assert.deepEqual(await database.getCloudDatabase().pending(), queue)
    assert.equal((await database.getMemoById(local.id))?.content, 'pending during directory migration')
    await database.closeDatabase()
    console.log(JSON.stringify({ status: 'passed', fixture: 'encrypted config / preview approval / backup restore / historical dates / Worker database-directory migration' }))
    app.exit(0)
  } catch (error) {
    console.error(error)
    await database.closeDatabase().catch(() => {})
    app.exit(1)
  }
})
