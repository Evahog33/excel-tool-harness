import Router from '@koa/router'
import type { Context } from 'cordis'
import { existsSync, mkdirSync, copyFileSync, createReadStream, statSync } from 'fs'
import { resolve, basename, extname } from 'path'
import { randomUUID } from 'crypto'

import { isPathSafe } from '../utils/security.js'

export { isPathSafe }
const ALLOWED_RUNTIME_EXTS = new Set(['.xlsx', '.csv'])

export function registerSandboxRoutes(router: Router, ctx: Context) {
  // ── 执行脚本（通过工具系统调用） ─────────────────────────────────────────
  router.post('/api/sessions/:id/run', async (koaCtx) => {
    const session = ctx.sessions.get(koaCtx.params.id)
    if (!session) {
      koaCtx.status = 404
      return
    }
    if (!session.pythonCode) {
      koaCtx.status = 400
      koaCtx.body = { error: '该会话还没有生成 Python 脚本，请先在左侧对话中描述需求' }
      return
    }

    const params = (koaCtx.request.body as any)?.params ?? {}
    const result = await ctx.tools.execute(
      `run-${Date.now()}`,
      'run_excel_tool',
      JSON.stringify({ session_id: session.id, params }),
    )

    koaCtx.body = result.error
      ? { success: false, error: result.error }
      : { success: true, ...JSON.parse(result.output) }
  })

  // ── 表单运行时文件上传（安全校验） ────────────────────────────────────────
  router.post('/api/sessions/:id/form-upload', async (koaCtx) => {
    const session = ctx.sessions.get(koaCtx.params.id)
    if (!session) {
      koaCtx.status = 404
      koaCtx.body = { error: '会话不存在' }
      return
    }

    const file = (koaCtx.request.files as any)?.file
    if (!file) {
      koaCtx.status = 400
      koaCtx.body = { error: '未接收到上传的文件' }
      return
    }

    const originalName = file.originalFilename || file.newFilename || 'upload.xlsx'
    const ext = extname(originalName).toLowerCase()

    if (ext === '.xls') {
      koaCtx.status = 400
      koaCtx.body = { error: `暂不支持旧版 Excel 97-2003 (.xls) 二进制格式，请在 Excel 中将其「另存为」.xlsx 格式后再上传` }
      return
    }

    // 安全防御：限制扩展名白名单，禁止上传脚本与可执行文件
    if (!ALLOWED_RUNTIME_EXTS.has(ext)) {
      koaCtx.status = 400
      koaCtx.body = { error: `不支持的文件格式: ${ext}，仅允许上传 Excel/CSV 数据文件 (.xlsx, .csv)` }
      return
    }

    const uploadDir = resolve('.sessions', session.id, 'runtime_uploads')
    if (!existsSync(uploadDir)) {
      mkdirSync(uploadDir, { recursive: true })
    }

    const fileId = randomUUID()
    const targetPath = resolve(uploadDir, `${fileId}_${originalName}`)
    const tempPath = file.filepath || file.path

    copyFileSync(tempPath, targetPath)

    koaCtx.body = {
      ok: true,
      filepath: targetPath,
      filename: originalName,
    }
  })

  // ── 产物文件下载（安全防穿越加固） ────────────────────────────────────────
  router.get('/api/download', (koaCtx) => {
    const rawFilepath = koaCtx.query.filepath as string
    if (!rawFilepath) {
      koaCtx.status = 400
      koaCtx.body = { error: '缺少 filepath' }
      return
    }

    // 允许下载的根目录：仅限会话目录及项目输出目录
    const allowedRoots = [
      resolve('.sessions'),
      resolve('output'),
    ]

    if (!isPathSafe(rawFilepath, allowedRoots)) {
      koaCtx.status = 403
      koaCtx.body = { error: '越权访问被拦截：禁止下载允许目录之外的文件' }
      return
    }

    const filepath = resolve(rawFilepath)

    if (!existsSync(filepath)) {
      koaCtx.status = 404
      koaCtx.body = { error: '文件不存在或已被清理' }
      return
    }

    // 防御：只允许下载普通文件，拒绝下载目录
    try {
      const stat = statSync(filepath)
      if (!stat.isFile()) {
        koaCtx.status = 400
        koaCtx.body = { error: '目标路径不是普通文件' }
        return
      }
    } catch {
      koaCtx.status = 404
      koaCtx.body = { error: '无法读取文件信息' }
      return
    }

    const filename = (koaCtx.query.filename as string) || basename(filepath)
    const encoded = encodeURIComponent(filename)
    koaCtx.set('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`)
    koaCtx.set('Content-Type', 'application/octet-stream')
    koaCtx.body = createReadStream(filepath)
  })
}
