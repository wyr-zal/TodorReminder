// memo-img:// 自定义协议 URL（主进程 registerImageProtocol 提供服务）
export function thumbImageUrl(filename: string): string {
  return `memo-img://thumb/${encodeURIComponent(filename)}`
}

export function fullImageUrl(filename: string): string {
  return `memo-img://full/${encodeURIComponent(filename)}`
}
