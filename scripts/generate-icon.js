import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function generateIcon() {
  const size = 256
  const data = Buffer.alloc(size * size * 4) // RGBA

  // 蓝色 #3B82F6
  const blueR = 59, blueG = 130, blueB = 246

  // 圆角半径
  const radius = 40

  // 辅助函数：检查点是否在圆角矩形内
  function inRoundedRect(x, y, left, top, right, bottom, r) {
    if (x < left + r && y < top + r) {
      const dx = x - (left + r)
      const dy = y - (top + r)
      return dx * dx + dy * dy <= r * r
    }
    if (x > right - r && y < top + r) {
      const dx = x - (right - r)
      const dy = y - (top + r)
      return dx * dx + dy * dy <= r * r
    }
    if (x < left + r && y > bottom - r) {
      const dx = x - (left + r)
      const dy = y - (bottom - r)
      return dx * dx + dy * dy <= r * r
    }
    if (x > right - r && y > bottom - r) {
      const dx = x - (right - r)
      const dy = y - (bottom - r)
      return dx * dx + dy * dy <= r * r
    }
    return x >= left && x < right && y >= top && y < bottom
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4

      const margin = 16
      const inMain = inRoundedRect(x, y, margin, margin, size - margin, size - margin, radius)

      const line1 = y >= 64 && y <= 80 && x >= 48 && x < 192
      const line2 = y >= 104 && y <= 120 && x >= 48 && x < 160
      const line3 = y >= 144 && y <= 160 && x >= 48 && x < 176

      if (inMain) {
        if (line1 || line2 || line3) {
          data[idx] = 255
          data[idx + 1] = 255
          data[idx + 2] = 255
          data[idx + 3] = 255
        } else {
          data[idx] = blueR
          data[idx + 1] = blueG
          data[idx + 2] = blueB
          data[idx + 3] = 255
        }
      } else {
        data[idx] = 0
        data[idx + 1] = 0
        data[idx + 2] = 0
        data[idx + 3] = 0
      }
    }
  }

  const resourcesDir = path.join(__dirname, '../resources')
  const pngPath = path.join(resourcesDir, 'icon.png')
  const icoPath = path.join(resourcesDir, 'icon.ico')

  // 生成 256x256 PNG
  await sharp(data, {
    raw: { width: size, height: size, channels: 4 }
  }).png().toFile(pngPath)

  console.log('PNG generated:', pngPath)

  // 生成多尺寸图标用于 ICO
  const sizes = [16, 32, 48, 256]
  const pngBuffers = await Promise.all(
    sizes.map(s =>
      sharp(data, { raw: { width: size, height: size, channels: 4 } })
        .resize(s, s)
        .png()
        .toBuffer()
    )
  )

  // 转换为 ICO
  const icoBuffer = await pngToIco(pngBuffers)
  fs.writeFileSync(icoPath, icoBuffer)

  console.log('ICO generated:', icoPath)
}

generateIcon().catch(console.error)
