import { resolve } from 'path'

/**
 * 校验文件下载路径是否在安全允许的根目录之内
 * 严格防范 ../ 目录穿越或读取系统盘其他敏感文件
 */
export function isPathSafe(filepath: string, allowedRoots: string[]): boolean {
  if (!filepath || typeof filepath !== 'string') return false

  // resolve 会处理 ../ 并将路径规范化为无冗余段的绝对路径
  const normalizedPath = resolve(filepath)
  const isWindows = process.platform === 'win32'
  const comparePath = isWindows ? normalizedPath.toLowerCase() : normalizedPath

  return allowedRoots.some((root) => {
    const normalizedRoot = resolve(root)
    const compareRoot = isWindows ? normalizedRoot.toLowerCase() : normalizedRoot
    if (comparePath === compareRoot) return true
    const prefixWithSep = compareRoot.endsWith('\\') || compareRoot.endsWith('/')
      ? compareRoot
      : compareRoot + (isWindows ? '\\' : '/')
    return comparePath.startsWith(prefixWithSep)
  })
}
