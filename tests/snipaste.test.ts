import test from 'node:test'
import assert from 'node:assert/strict'
import { createSnipastePreview, preserveSnipastePath } from '../src/main/snipaste.ts'

const executable = 'C:\\工具 & 资料\\Snipaste.exe'
const image = 'E:\\备忘 附件\\参考 & $说明.png'
const otherImage = 'E:\\备忘 附件\\第二张.png'

function makeHarness() {
  const state = {
    savedPath: executable as string | undefined,
    runningPath: executable,
    selectedPath: executable as string | null,
    files: new Set([executable, image, otherImage]),
    findError: null as Error | null,
    readyError: null as Error | null,
    pasteError: null as Error | null,
    firstPasteError: null as Error | null,
    waitForReady: async () => {},
    chooseCount: 0,
    saved: [] as string[],
    calls: [] as { file: string; args: string[]; env?: NodeJS.ProcessEnv }[],
    events: [] as string[]
  }
  const api = createSnipastePreview({
    readPath: () => state.savedPath,
    savePath: path => {
      state.savedPath = path
      state.saved.push(path)
    },
    choosePath: async () => {
      state.chooseCount += 1
      return state.selectedPath
    }
  }, {
    isFile: path => state.files.has(path),
    run: async (file, args, env) => {
      state.calls.push({ file, args, env })
      if (args[0] === 'paste') {
        state.events.push(`paste:${args[2]}`)
        if (state.firstPasteError) {
          const error = state.firstPasteError
          state.firstPasteError = null
          throw error
        }
        if (state.pasteError) throw state.pasteError
        return ''
      }
      if (env?.FOCUS_MEMO_SNIPASTE_PATH) {
        state.events.push('waiting')
        await state.waitForReady()
        if (state.readyError) throw state.readyError
        state.events.push('ready')
        return ''
      }
      state.events.push('find')
      if (state.findError) throw state.findError
      return state.runningPath
    }
  })
  return { state, preview: api.preview, prewarm: api.prewarm }
}

test('preview passes the original Unicode path as one unquoted file argument', async () => {
  const { state, preview } = makeHarness()
  assert.equal(await preview(image), true)
  const call = state.calls.find(call => call.args[0] === 'paste')!
  assert.equal(call.file, executable)
  assert.deepEqual(call.args, ['paste', '--files', image])
  assert.deepEqual(state.events, ['waiting', 'ready', `paste:${image}`])
  assert.equal(state.chooseCount, 0)
  assert.deepEqual(state.saved, [])
})

test('PowerShell receives the executable path as data rather than script interpolation', async () => {
  const { state, preview } = makeHarness()
  await preview(image)
  const call = state.calls[0]
  assert.match(call.file, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/)
  assert.deepEqual(call.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand'])
  const script = Buffer.from(call.args[3], 'base64').toString('utf16le')
  assert.ok(!script.includes(executable))
  assert.ok(!script.includes(image))
  assert.equal(call.env?.FOCUS_MEMO_SNIPASTE_PATH, executable)
})

test('first preview discovers and remembers a running Snipaste installation', async () => {
  const { state, preview } = makeHarness()
  state.savedPath = undefined
  assert.equal(await preview(image), true)
  assert.deepEqual(state.events, ['find', 'waiting', 'ready', `paste:${image}`])
  assert.deepEqual(state.saved, [executable])
  assert.equal(state.chooseCount, 0)
})

test('a stale saved path can be replaced by a running installation', async () => {
  const { state, preview } = makeHarness()
  state.savedPath = 'C:\\Removed\\Snipaste.exe'
  assert.equal(await preview(image), true)
  assert.equal(state.savedPath, executable)
})

test('without a running installation the chosen executable is ready before paste', async () => {
  const { state, preview } = makeHarness()
  state.savedPath = undefined
  state.runningPath = ''
  assert.equal(await preview(image), true)
  assert.equal(state.chooseCount, 1)
  assert.deepEqual(state.events, ['find', 'waiting', 'ready', `paste:${image}`])
  assert.equal(state.savedPath, executable)
})

test('discovery failure still allows selecting Snipaste', async () => {
  const { state, preview } = makeHarness()
  state.savedPath = undefined
  state.findError = new Error('discovery failed')
  assert.equal(await preview(image), true)
  assert.equal(state.chooseCount, 1)
})

test('cancelling executable selection does not launch or paste and permits another try', async () => {
  const { state, preview } = makeHarness()
  state.savedPath = undefined
  state.runningPath = ''
  state.selectedPath = null
  assert.equal(await preview(image), false)
  assert.deepEqual(state.events, ['find'])
  assert.deepEqual(state.saved, [])
  state.selectedPath = executable
  assert.equal(await preview(image), true)
  assert.equal(state.chooseCount, 2)
})

test('rejects an unrelated executable without launching it', async () => {
  const { state, preview } = makeHarness()
  state.savedPath = undefined
  state.runningPath = ''
  state.selectedPath = 'C:\\Tools\\other.exe'
  state.files.add(state.selectedPath)
  await assert.rejects(preview(image), /请选择 Snipaste.exe/)
  assert.deepEqual(state.events, ['find'])
})

test('rejects relative or missing executable paths', async () => {
  for (const selectedPath of ['Snipaste.exe', 'C:\\Missing\\Snipaste.exe']) {
    const { state, preview } = makeHarness()
    state.savedPath = undefined
    state.runningPath = ''
    state.selectedPath = selectedPath
    await assert.rejects(preview(image), /请选择 Snipaste.exe/)
    assert.deepEqual(state.events, ['find'])
  }
})

test('a missing image does not even resolve or start Snipaste', async () => {
  const { state, preview } = makeHarness()
  state.files.delete(image)
  await assert.rejects(preview(image), /图片不存在/)
  assert.deepEqual(state.calls, [])
})

test('readiness timeout prevents paste and is retryable', async () => {
  const { state, preview } = makeHarness()
  const timeout = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
  state.readyError = timeout
  await assert.rejects(preview(image), error => {
    assert.equal((error as Error).message, 'Snipaste 启动失败')
    assert.equal((error as Error & { cause: Error }).cause, timeout)
    return true
  })
  assert.deepEqual(state.events, ['waiting'])
  state.readyError = null
  assert.equal(await preview(image), true)
})

test('failed startup does not persist a newly selected executable', async () => {
  const { state, preview } = makeHarness()
  state.savedPath = undefined
  state.runningPath = ''
  state.readyError = new Error('process exited')
  await assert.rejects(preview(image), /Snipaste 启动失败/)
  assert.deepEqual(state.saved, [])
  assert.ok(!state.calls.some(call => call.args[0] === 'paste'))
})

test('a rejected paste command is reported as failure', async () => {
  const { state, preview } = makeHarness()
  state.pasteError = new Error('command failed')
  await assert.rejects(preview(image), /预览失败/)
  state.pasteError = null
  assert.equal(await preview(image), true)
})

test('concurrent previews share readiness but each paste their own image', async () => {
  const { state, preview } = makeHarness()
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  state.waitForReady = () => waiting
  const first = preview(image)
  const second = preview(otherImage)
  assert.deepEqual(state.events, ['waiting'])
  release()
  assert.deepEqual(await Promise.all([first, second]), [true, true])
  assert.deepEqual(state.events, ['waiting', 'ready', `paste:${image}`, `paste:${otherImage}`])
})

test('concurrent first previews share executable selection', async () => {
  const { state, preview } = makeHarness()
  state.savedPath = undefined
  state.runningPath = ''
  assert.deepEqual(await Promise.all([preview(image), preview(otherImage)]), [true, true])
  assert.equal(state.chooseCount, 1)
  assert.equal(state.events.filter(event => event === 'waiting').length, 1)
  assert.deepEqual(state.saved, [executable])
})

test('concurrent failed readiness settles every request and allows retry', async () => {
  const { state, preview } = makeHarness()
  state.readyError = new Error('startup failed')
  const results = await Promise.allSettled([preview(image), preview(otherImage)])
  assert.ok(results.every(result => result.status === 'rejected'))
  assert.equal(state.events.filter(event => event === 'waiting').length, 1)
  state.readyError = null
  assert.equal(await preview(image), true)
})

test('a warmed-up preview goes straight to pasting without probing again', async () => {
  const { state, preview, prewarm } = makeHarness()
  await prewarm()
  assert.deepEqual(state.events, ['waiting', 'ready'])

  state.events.length = 0
  state.calls.length = 0
  assert.equal(await preview(image), true)
  assert.deepEqual(state.calls.map(call => call.args[0]), ['paste'])
  assert.deepEqual(state.events, [`paste:${image}`])
})

test('repeat previews reuse the cached readiness', async () => {
  const { state, preview } = makeHarness()
  assert.equal(await preview(image), true)
  assert.equal(await preview(otherImage), true)
  assert.deepEqual(state.events, ['waiting', 'ready', `paste:${image}`, `paste:${otherImage}`])
})

test('warming up never opens the executable picker', async () => {
  const { state, preview, prewarm } = makeHarness()
  state.savedPath = undefined
  state.runningPath = ''
  await prewarm()
  assert.equal(state.chooseCount, 0)
  assert.deepEqual(state.events, ['find'])
  assert.deepEqual(state.saved, [])

  // 真正预览时才允许询问用户
  assert.equal(await preview(image), true)
  assert.equal(state.chooseCount, 1)
})

test('a failing warm-up stays silent and does not block the next preview', async () => {
  const { state, preview, prewarm } = makeHarness()
  state.readyError = new Error('startup failed')
  await prewarm()
  assert.deepEqual(state.events, ['waiting'])

  state.readyError = null
  assert.equal(await preview(image), true)
})

test('a preview racing a warm-up waits for it instead of probing in parallel', async () => {
  const { state, preview, prewarm } = makeHarness()
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  state.waitForReady = () => waiting

  const warming = prewarm()
  const clicked = preview(image)
  assert.deepEqual(state.events, ['waiting'])

  release()
  await warming
  assert.equal(await clicked, true)
  assert.deepEqual(state.events, ['waiting', 'ready', `paste:${image}`])
})

test('a failed paste invalidates the cache, restarts Snipaste and retries once', async () => {
  const { state, preview } = makeHarness()
  assert.equal(await preview(image), true)

  state.events.length = 0
  state.firstPasteError = new Error('Snipaste is gone')
  assert.equal(await preview(otherImage), true)
  assert.deepEqual(state.events, [
    `paste:${otherImage}`, 'waiting', 'ready', `paste:${otherImage}`
  ])

  // 重试成功后缓存恢复，下一次预览重新走直连
  state.events.length = 0
  assert.equal(await preview(image), true)
  assert.deepEqual(state.events, [`paste:${image}`])
})

test('saving image settings preserves the latest main-process Snipaste path', () => {
  const current = { imageCompression: true, imageMaxSize: 500, imageMaxWidth: 1200, snipastePath: executable }
  const incoming = { imageCompression: false, imageMaxSize: 200, imageMaxWidth: 800 }
  assert.deepEqual(preserveSnipastePath(current, incoming), { ...incoming, snipastePath: executable })
  assert.deepEqual(preserveSnipastePath(current, { ...incoming, snipastePath: 'C:\\Old\\Snipaste.exe' }), {
    ...incoming, snipastePath: executable
  })
  assert.equal(current.imageCompression, true)
})
