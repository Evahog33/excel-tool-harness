/**
 * @excel-harness/web-host
 * Web 宿主服务插件 —— Koa HTTP + SSE 流式接口
 *
 * API:
 *   POST /api/sessions             创建会话
 *   GET  /api/sessions             列出会话
 *   GET  /api/sessions/:id         获取会话详情
 *   GET  /api/sessions/:id/assets  获取 uiSchema + pythonCode
 *   POST /api/sessions/:id/chat    发送消息（SSE 流式）
 *   POST /api/sessions/:id/run     执行 Python 脚本（沙箱触发）
 */

import { Context, Service } from 'cordis'
import Koa from 'koa'
import Router from '@koa/router'
import cors from '@koa/cors'
import { koaBody } from 'koa-body'
import { createServer } from 'http'
import { existsSync, mkdirSync, copyFileSync, createReadStream } from 'fs'
import { join, basename, resolve } from 'path'
import { randomUUID } from 'crypto'
import { inspectExcel, sanitizeSampleRows } from '@excel-harness/excel-tool'
import type { ExcelMeta, DesensitizationRuleConfig } from '@excel-harness/session'

export interface WebHostConfig {
  port?: number
  host?: string
  staticDir?: string
}

export class WebHostService extends Service<WebHostConfig> {
  static [Service.provide] = 'webHost'
  static inject = ['sessions', 'agentLoop', 'tools']

  private koa: Koa
  private server: ReturnType<typeof createServer>

  constructor(ctx: Context, config: WebHostConfig) {
    super(ctx, 'webHost')
    this.koa = new Koa()
    this.server = createServer(this.koa.callback())
    this._setup(config)
  }

  private _setup(config: WebHostConfig) {
    const { port = 3080, host = '127.0.0.1' } = config
    const ctx = this.ctx
    const router = new Router()

    this.koa.use(cors())
    this.koa.use(koaBody({ multipart: true }))

    // ── 会话 CRUD ────────────────────────────────────────────────────────────

    router.post('/api/sessions', (koaCtx) => {
      const { title } = (koaCtx.request.body as any) ?? {}
      const session = ctx.sessions.create(title)
      koaCtx.body = { ok: true, session }
    })

    router.get('/api/sessions', (koaCtx) => {
      koaCtx.body = { sessions: ctx.sessions.list() }
    })

    router.get('/api/sessions/:id', (koaCtx) => {
      const session = ctx.sessions.get(koaCtx.params.id)
      if (!session) { koaCtx.status = 404; return }
      koaCtx.body = { session }
    })

    router.delete('/api/sessions/:id', (koaCtx) => {
      const ok = ctx.sessions.delete(koaCtx.params.id)
      if (!ok) {
        koaCtx.status = 404
        koaCtx.body = { error: '会话不存在' }
        return
      }
      koaCtx.body = { ok: true, deletedId: koaCtx.params.id }
    })

    router.get('/api/sessions/:id/assets', (koaCtx) => {
      const session = ctx.sessions.get(koaCtx.params.id)
      if (!session) { koaCtx.status = 404; return }
      const excelFiles = ctx.sessions.getExcelFiles(session.id)
      koaCtx.body = {
        uiSchema: session.uiSchema ?? null,
        pythonCode: session.pythonCode ?? null,
        excelMeta: excelFiles[0] ?? null,
        excelFiles,
      }
    })

    // ── Excel 数据源管理与脱敏配置 ──────────────────────────────────────────

    router.post('/api/sessions/:id/upload-excel', async (koaCtx) => {
      const session = ctx.sessions.get(koaCtx.params.id)
      if (!session) { koaCtx.status = 404; koaCtx.body = { error: '会话不存在' }; return }

      const rawFile = (koaCtx.request.files as any)?.file
      if (!rawFile) {
        koaCtx.status = 400
        koaCtx.body = { error: '未接收到上传的文件' }
        return
      }

      const files = Array.isArray(rawFile) ? rawFile : [rawFile]
      const uploadDir = resolve('.sessions', session.id, 'uploads')
      if (!existsSync(uploadDir)) {
        mkdirSync(uploadDir, { recursive: true })
      }

      const newMetas: ExcelMeta[] = []

      for (const file of files) {
        const originalName = file.originalFilename || file.newFilename || 'data.xlsx'
        const fileId = randomUUID()
        const targetPath = resolve(uploadDir, `${fileId}_${originalName}`)
        const tempPath = file.filepath || file.path

        copyFileSync(tempPath, targetPath)

        try {
          const inspection = await inspectExcel(targetPath)

          // 默认初始化脱敏规则：敏感列默认启用推荐规则，其他列不脱敏
          const sensitiveMap = new Map(inspection.sensitiveColumns.map((c) => [c.column, c]))
          const desensitizationRules: DesensitizationRuleConfig[] = inspection.headers.map((col) => {
            const sensitive = sensitiveMap.get(col)
            if (sensitive) {
              return {
                column: col,
                enabled: true,
                ruleType: sensitive.rule as any,
                label: sensitive.label,
              }
            }
            return {
              column: col,
              enabled: false,
              ruleType: 'id_card_mask',
              label: '未脱敏',
            }
          })

          const sanitizedSamples = sanitizeSampleRows(inspection.sampleRows, desensitizationRules)

          const excelMeta: ExcelMeta = {
            fileId,
            filename: originalName,
            filepath: targetPath,
            fileSizeBytes: file.size ?? 0,
            uploadedAt: Date.now(),
            sheets: inspection.sheets,
            activeSheet: inspection.activeSheet,
            rowCount: inspection.rowCount,
            columnCount: inspection.columnCount,
            headerLevels: inspection.headerLevels,
            headerStartRow: inspection.headerStartRow,
            headerEndRow: inspection.headerEndRow,
            dataStartRow: inspection.dataStartRow,
            headers: inspection.headers,
            sampleRows: inspection.sampleRows,
            sensitiveColumns: inspection.sensitiveColumns,
            desensitizationRules,
            sanitizedSamples,
          }

          newMetas.push(excelMeta)
        } catch (err: any) {
          koaCtx.status = 500
          koaCtx.body = { ok: false, error: `${originalName} 解析失败: ${err.message}` }
          return
        }
      }

      const allFiles = ctx.sessions.addExcelFiles(session.id, newMetas)
      koaCtx.body = {
        ok: true,
        excelFiles: allFiles,
        excelMeta: allFiles[0],
        newFiles: newMetas,
      }
    })

    // 针对指定 fileId 保存脱敏规则
    router.post('/api/sessions/:id/excel/:fileId/desensitize-config', async (koaCtx) => {
      const session = ctx.sessions.get(koaCtx.params.id)
      if (!session) { koaCtx.status = 404; koaCtx.body = { error: '会话不存在' }; return }
      const { fileId } = koaCtx.params
      const excelFiles = ctx.sessions.getExcelFiles(session.id)
      const target = excelFiles.find((f) => f.fileId === fileId)
      if (!target) {
        koaCtx.status = 404
        koaCtx.body = { error: '未找到指定的文件元数据' }
        return
      }

      const { rules } = (koaCtx.request.body as any) ?? {}
      if (!Array.isArray(rules)) {
        koaCtx.status = 400
        koaCtx.body = { error: 'rules 必须为数组' }
        return
      }

      const sanitizedSamples = sanitizeSampleRows(target.sampleRows, rules as any)
      const updatedFiles = ctx.sessions.updateExcelFile(session.id, fileId, {
        desensitizationRules: rules,
        sanitizedSamples,
      })
      const updatedTarget = updatedFiles.find((f) => f.fileId === fileId)

      koaCtx.body = { ok: true, excelMeta: updatedTarget, excelFiles: updatedFiles }
    })

    // 兼容原单文件脱敏路由
    router.post('/api/sessions/:id/desensitize-config', async (koaCtx) => {
      const session = ctx.sessions.get(koaCtx.params.id)
      if (!session) { koaCtx.status = 404; koaCtx.body = { error: '会话不存在' }; return }
      const excelFiles = ctx.sessions.getExcelFiles(session.id)
      const { fileId, rules } = (koaCtx.request.body as any) ?? {}
      const target = fileId ? excelFiles.find((f) => f.fileId === fileId) : excelFiles[0]
      if (!target) {
        koaCtx.status = 400
        koaCtx.body = { error: '当前会话未挂载 Excel 文件' }
        return
      }
      if (!Array.isArray(rules)) {
        koaCtx.status = 400
        koaCtx.body = { error: 'rules 必须为数组' }
        return
      }

      const sanitizedSamples = sanitizeSampleRows(target.sampleRows, rules as any)
      const updatedFiles = ctx.sessions.updateExcelFile(session.id, target.fileId, {
        desensitizationRules: rules,
        sanitizedSamples,
      })
      const updatedTarget = updatedFiles.find((f) => f.fileId === target.fileId)
      koaCtx.body = { ok: true, excelMeta: updatedTarget, excelFiles: updatedFiles }
    })

    // 删除指定文件
    router.delete('/api/sessions/:id/excel/:fileId', async (koaCtx) => {
      const session = ctx.sessions.get(koaCtx.params.id)
      if (!session) { koaCtx.status = 404; koaCtx.body = { error: '会话不存在' }; return }

      const updatedFiles = ctx.sessions.removeExcelFile(session.id, koaCtx.params.fileId)
      koaCtx.body = { ok: true, excelFiles: updatedFiles, excelMeta: updatedFiles[0] || null }
    })

    // 清空所有文件
    router.delete('/api/sessions/:id/excel', async (koaCtx) => {
      const session = ctx.sessions.get(koaCtx.params.id)
      if (!session) { koaCtx.status = 404; koaCtx.body = { error: '会话不存在' }; return }

      ctx.sessions.clearExcelFiles(session.id)
      koaCtx.body = { ok: true, excelFiles: [], excelMeta: null }
    })

    // ── 对话（SSE 流式） ────────────────────────────────────────────────────

    router.post('/api/sessions/:id/chat', async (koaCtx) => {
      const session = ctx.sessions.get(koaCtx.params.id)
      if (!session) { koaCtx.status = 404; return }

      const { message } = (koaCtx.request.body as any) ?? {}
      if (!message?.trim()) {
        koaCtx.status = 400
        koaCtx.body = { error: '缺少 message' }
        return
      }

      koaCtx.set('Content-Type', 'text/event-stream; charset=utf-8')
      koaCtx.set('Cache-Control', 'no-cache')
      koaCtx.set('Connection', 'keep-alive')
      koaCtx.status = 200

      const send = (event: string, data: unknown) => {
        koaCtx.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }

      let isCompleted = false
      // 仅当客户端异常中断连接时触发后台 Agent 中止
      const onClose = () => {
        if (!isCompleted) {
          ctx.agentLoop.abort(session.id)
        }
      }
      koaCtx.req.on('close', onClose)

      try {
        await ctx.agentLoop.run({
          sessionId: session.id,
          userMessage: message,
          onChunk: (chunk) => send('chunk', { text: chunk }),
          onReasoningChunk: (reasoning) => send('reasoning', { text: reasoning }),
          onToolResult: (toolName, result) => send('tool', { toolName, result }),
        })

        const updated = ctx.sessions.get(session.id)!
        send('done', {
          uiSchema: updated.uiSchema ?? null,
          pythonCode: updated.pythonCode ?? null,
          session: updated,
        })
      } catch (err) {
        send('error', { message: err instanceof Error ? err.message : String(err) })
      } finally {
        isCompleted = true
        koaCtx.req.removeListener('close', onClose)
        koaCtx.res.end()
      }
    })

    // ── 手动停止生成（Abort） ────────────────────────────────────────────────
    router.post('/api/sessions/:id/abort', async (koaCtx) => {
      const session = ctx.sessions.get(koaCtx.params.id)
      if (!session) { koaCtx.status = 404; koaCtx.body = { error: '会话不存在' }; return }

      const aborted = ctx.agentLoop.abort(session.id)
      koaCtx.body = { ok: true, aborted }
    })

    // ── 撤回最后一条消息并重新编辑（Pop Last User Message） ──────────────────
    router.post('/api/sessions/:id/pop-message', async (koaCtx) => {
      const session = ctx.sessions.get(koaCtx.params.id)
      if (!session) { koaCtx.status = 404; koaCtx.body = { error: '会话不存在' }; return }

      // 如果当前正在生成，先中断
      ctx.agentLoop.abort(session.id)

      const lastUserContent = ctx.sessions.popLastUserMessage(session.id)
      const updatedSession = ctx.sessions.get(session.id)

      koaCtx.body = {
        ok: true,
        content: lastUserContent,
        session: updatedSession,
      }
    })

    // ── 执行脚本（通过工具系统调用，不直接 import python-runner） ───────────

    router.post('/api/sessions/:id/run', async (koaCtx) => {
      const session = ctx.sessions.get(koaCtx.params.id)
      if (!session) { koaCtx.status = 404; return }
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

    // ── 表单运行时文件上传 ──────────────────────────────────────────────────
    router.post('/api/sessions/:id/form-upload', async (koaCtx) => {
      const session = ctx.sessions.get(koaCtx.params.id)
      if (!session) { koaCtx.status = 404; koaCtx.body = { error: '会话不存在' }; return }

      const file = (koaCtx.request.files as any)?.file
      if (!file) {
        koaCtx.status = 400
        koaCtx.body = { error: '未接收到上传的文件' }
        return
      }

      const originalName = file.originalFilename || file.newFilename || 'upload.xlsx'
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

    // ── 产物文件下载 ────────────────────────────────────────────────────────
    router.get('/api/download', (koaCtx) => {
      const filepath = koaCtx.query.filepath as string
      if (!filepath) {
        koaCtx.status = 400
        koaCtx.body = { error: '缺少 filepath' }
        return
      }

      if (!existsSync(filepath)) {
        koaCtx.status = 404
        koaCtx.body = { error: '文件不存在或已被清理' }
        return
      }

      const filename = (koaCtx.query.filename as string) || basename(filepath)
      koaCtx.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
      koaCtx.set('Content-Type', 'application/octet-stream')
      koaCtx.body = createReadStream(filepath)
    })

    this.koa.use(router.routes())
    this.koa.use(router.allowedMethods())

    this.server.listen(port, host, () => {
      ctx.logger('web-host').info(`✅ 服务已启动: http://${host}:${port}`)
    })
  }

  async stop() {
    return new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

export function apply(ctx: Context, config: WebHostConfig = {}) {
  ctx.plugin(WebHostService, config)
}

declare module 'cordis' {
  interface Context {
    webHost: WebHostService
  }
}
