import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'path'
import { isPathSafe } from '../utils/security.ts'

describe('Web-Host 安全路径校验防御', () => {
  const allowedRoots = [
    resolve('.sessions'),
    resolve('output'),
  ]

  test('允许合法子目录下的产物文件访问', () => {
    const validFile1 = resolve('.sessions', 'session-123', 'output.xlsx')
    assert.equal(isPathSafe(validFile1, allowedRoots), true)

    const validFile2 = resolve('output', 'result.csv')
    assert.equal(isPathSafe(validFile2, allowedRoots), true)
  })

  test('Windows 路径大小写不敏感匹配', (t) => {
    if (process.platform !== 'win32') {
      t.skip('非 Windows 环境跳过大小写测试')
      return
    }
    const root = resolve('.sessions')
    const lowerFile = root.toLowerCase() + '\\sub\\test.xlsx'
    const upperFile = root.toUpperCase() + '\\sub\\test.xlsx'
    assert.equal(isPathSafe(lowerFile, [root]), true)
    assert.equal(isPathSafe(upperFile, [root]), true)
  })

  test('拦截使用 ../ 进行路径穿越攻击', () => {
    // 试图通过相对路径跳出会话目录
    const attack1 = resolve('.sessions', '..', 'package.json')
    assert.equal(isPathSafe(attack1, allowedRoots), false)

    const attack2 = resolve('.sessions', '123', '..', '..', 'Windows', 'System32')
    assert.equal(isPathSafe(attack2, allowedRoots), false)
  })

  test('拦截直接请求系统核心敏感文件', () => {
    const systemPathWin = 'C:\\Windows\\System32\\drivers\\etc\\hosts'
    const systemPathUnix = '/etc/passwd'
    assert.equal(isPathSafe(systemPathWin, allowedRoots), false)
    assert.equal(isPathSafe(systemPathUnix, allowedRoots), false)
  })

  test('空路径或非字符串拒绝访问', () => {
    assert.equal(isPathSafe('', allowedRoots), false)
    assert.equal(isPathSafe(null as any, allowedRoots), false)
  })
})
