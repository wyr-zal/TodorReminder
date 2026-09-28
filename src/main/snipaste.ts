import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { win32 } from 'node:path'

interface SnipasteOptions {
  readPath: () => string | undefined
  savePath: (path: string) => void
  choosePath: () => Promise<string | null>
}

type CommandRunner = (file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<string>

interface SnipasteRuntime {
  isFile: (path: string) => boolean
  run: CommandRunner
}

const COMMAND_TIMEOUT_MS = 15000
const POWERSHELL_PREAMBLE = `
$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
`

const FIND_RUNNING_SCRIPT = `
$p = Get-Process -Name Snipaste -ErrorAction SilentlyContinue |
  Where-Object { $_.Path } | Select-Object -First 1
if ($p) { [Console]::Write($p.Path) }
`

const ENSURE_READY_SCRIPT = `
$path = $env:FOCUS_MEMO_SNIPASTE_PATH
$p = Get-Process -Name Snipaste -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -ieq $path } | Select-Object -First 1
if (!$p) {
  $info = [System.Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $path
  $info.WorkingDirectory = [System.IO.Path]::GetDirectoryName($path)
  $info.UseShellExecute = $false
  $p = [System.Diagnostics.Process]::Start($info)
}
if (!$p.WaitForInputIdle(10000)) { throw 'Snipaste startup timeout' }
$p.Refresh()
if ($p.HasExited) { throw 'Snipaste exited before ready' }
`

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const runCommand: CommandRunner = (file, args, env) => new Promise((resolve, reject) => {
  execFile(file, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: COMMAND_TIMEOUT_MS,
    env: { ...process.env, ...env }
  }, (error, stdout) => {
    if (error) reject(error)
    else resolve(stdout)
  })
})

export function preserveSnipastePath<T extends { snipastePath?: string }>(current: T, incoming: T): T {
  return { ...incoming, snipastePath: current.snipastePath }
}

export interface SnipastePreview {
  preview: (imagePath: string) => Promise<boolean>
  prewarm: () => Promise<void>
}

export function createSnipastePreview(
  options: SnipasteOptions,
  runtime: SnipasteRuntime = { isFile, run: runCommand }
): SnipastePreview {
  // 就绪状态缓存：命中后直接调用 Snipaste，省掉约 1 秒的 PowerShell 探测。
  let readyPath: string | null = null
  let preparing: { promise: Promise<string | null>; allowChoose: boolean } | null = null

  const isExecutable = (path: unknown): path is string => (
    typeof path === 'string'
    && win32.isAbsolute(path)
    && win32.basename(path).toLowerCase() === 'snipaste.exe'
    && runtime.isFile(path)
  )

  const runPowerShell = (script: string, path?: string) => {
    const executable = win32.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
    )
    const encoded = Buffer.from(POWERSHELL_PREAMBLE + script, 'utf16le').toString('base64')
    return runtime.run(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      FOCUS_MEMO_SNIPASTE_PATH: path || ''
    })
  }

  const prepare = async (allowChoose: boolean): Promise<string | null> => {
    let path = options.readPath()
    if (!isExecutable(path)) {
      // 探测不可用时仍可由用户选择程序，无需扫描磁盘或写死安装目录。
      path = await runPowerShell(FIND_RUNNING_SCRIPT).then(value => value.trim()).catch(() => '')
    }
    if (!isExecutable(path)) {
      // 预热无权打断用户：找不到就静默放弃，等真正预览时再询问。
      if (!allowChoose) return null
      const selected = await options.choosePath()
      if (selected === null) return null
      if (!isExecutable(selected)) throw new Error('请选择 Snipaste.exe')
      path = selected
    }

    try {
      await runPowerShell(ENSURE_READY_SCRIPT, path)
    } catch (error) {
      throw Object.assign(new Error('Snipaste 启动失败'), { cause: error })
    }
    if (options.readPath() !== path) options.savePath(path)
    return path
  }

  const ensureReady = async (allowChoose: boolean): Promise<string | null> => {
    if (readyPath) return readyPath

    if (preparing) {
      // 已有定位/启动流程在跑：搭车即可；若它无权弹选择框而本次需要，就等它结束后重来。
      if (preparing.allowChoose || !allowChoose) return preparing.promise
      await preparing.promise.catch(() => {})
      if (readyPath) return readyPath
      if (preparing) return preparing.promise
    }

    const promise = prepare(allowChoose)
    const entry = { promise, allowChoose }
    preparing = entry
    promise
      .then((path) => { if (path) readyPath = path })
      .catch(() => {})
      .then(() => { if (preparing === entry) preparing = null })
    return promise
  }

  const paste = async (executable: string, imagePath: string, mayRetry: boolean): Promise<void> => {
    try {
      await runtime.run(executable, ['paste', '--files', imagePath])
    } catch (error) {
      if (!mayRetry) throw Object.assign(new Error('预览失败'), { cause: error })
      // Snipaste 可能已被关闭：让缓存失效，重新定位/启动后再试一次。
      readyPath = null
      const restarted = await ensureReady(true)
      if (!restarted) throw Object.assign(new Error('预览失败'), { cause: error })
      return paste(restarted, imagePath, false)
    }
  }

  return {
    preview: async (imagePath) => {
      if (!runtime.isFile(imagePath)) throw new Error('图片不存在')

      // 仅合并定位/启动过程，每次预览仍发送各自的原图路径。
      const executable = await ensureReady(true)
      if (!executable) return false
      await paste(executable, imagePath, true)
      return true
    },
    prewarm: async () => {
      // 预热失败静默：真正的错误留到用户触发预览时再反馈。
      await ensureReady(false).catch(() => {})
    }
  }
}
