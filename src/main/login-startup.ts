import * as fs from 'fs'
import { join } from 'path'

export const PACKAGED_RUNTIME_FILES = [
  'icudtl.dat',
  'locales',
  'resources.pak',
  'resources/app.asar',
  'resources/app.asar.unpacked',
  'snapshot_blob.bin',
  'v8_context_snapshot.bin'
] as const

export function getMissingPackagedRuntimeFiles(dir: string): string[] {
  return PACKAGED_RUNTIME_FILES.filter(name => !fs.existsSync(join(dir, ...name.split('/'))))
}
