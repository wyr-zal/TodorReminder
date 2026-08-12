import sharp from 'sharp'
import { app } from 'electron'
import { basename, join } from 'path'
import * as fs from 'fs'
import { v4 as uuidv4 } from 'uuid'

const ATTACHMENTS_DIR = 'attachments'

export interface ImageSaveOptions {
  compress: boolean
  maxSize: number      // KB
  maxWidth: number     // px
}

const DEFAULT_OPTIONS: ImageSaveOptions = {
  compress: true,
  maxSize: 500,
  maxWidth: 1200
}

function getAttachmentsDir(): string {
  const dir = join(app.getPath('userData'), ATTACHMENTS_DIR)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return dir
}

export async function saveImage(buffer: Buffer, options: Partial<ImageSaveOptions> = {}): Promise<string> {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const maxSizeBytes = opts.maxSize * 1024

  const id = uuidv4()
  const ext = 'png'
  const filename = `${id}.${ext}`
  const filepath = join(getAttachmentsDir(), filename)

  try {
    let processedBuffer: Buffer

    if (opts.compress) {
      // 获取图片信息
      const metadata = await sharp(buffer).metadata()

      // 如果图片太大，进行压缩
      if (buffer.length > maxSizeBytes || (metadata.width && metadata.width > opts.maxWidth)) {
        processedBuffer = await sharp(buffer)
          .resize(opts.maxWidth, undefined, {
            fit: 'inside',
            withoutEnlargement: true
          })
          .png({ quality: 80, compressionLevel: 9 })
          .toBuffer()

        // 如果 PNG 压缩后仍然太大，转为 JPEG
        if (processedBuffer.length > maxSizeBytes) {
          processedBuffer = await sharp(buffer)
            .resize(opts.maxWidth, undefined, {
              fit: 'inside',
              withoutEnlargement: true
            })
            .jpeg({ quality: 75 })
            .toBuffer()
        }
      } else {
        processedBuffer = buffer
      }
    } else {
      // 不压缩，直接保存
      processedBuffer = buffer
    }

    // 写入文件
    fs.writeFileSync(filepath, processedBuffer)

    return filename
  } catch (error) {
    console.error('Failed to save image:', error)
    throw error
  }
}

export function getImagePath(filename: string): string {
  return join(getAttachmentsDir(), filename)
}

export function getExistingImagePath(filename: string): string | null {
  if (typeof filename !== 'string' || basename(filename) !== filename) {
    return null
  }

  const filepath = getImagePath(filename)
  return fs.existsSync(filepath) ? filepath : null
}

export function getImageBuffer(filename: string): Buffer | null {
  const filepath = getExistingImagePath(filename)
  if (filepath) {
    return fs.readFileSync(filepath)
  }
  return null
}

export function deleteImage(filename: string): boolean {
  const filepath = getImagePath(filename)
  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath)
    return true
  }
  return false
}

export function getImageBase64(filename: string): string | null {
  const buffer = getImageBuffer(filename)
  if (buffer) {
    const ext = filename.split('.').pop() || 'png'
    const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png'
    return `data:${mimeType};base64,${buffer.toString('base64')}`
  }
  return null
}

export function exportImage(filename: string, targetPath: string): boolean {
  const buffer = getImageBuffer(filename)
  if (buffer) {
    fs.writeFileSync(targetPath, buffer)
    return true
  }
  return false
}
