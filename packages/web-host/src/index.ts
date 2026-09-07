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
import { existsSync } from 'fs'
import { join } from 'path'

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

    router.get('/api/sessions/:id/assets', (koaCtx) => {
      const session = ctx.sessions.get(koaCtx.params.id)
      if (!session) { koaCtx.status = 404; return }
      koaCtx.body = {
        uiSchema: session.uiSchema ?? null,
        pythonCode: session.pythonCode ?? null,
      }
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

      try {
        await ctx.agentLoop.run({
          sessionId: session.id,
          userMessage: message,
          onChunk: (chunk) => send('chunk', { text: chunk }),
          onToolResult: (toolName, result) => send('tool', { toolName, result }),
        })

        const updated = ctx.sessions.get(session.id)!
        send('done', {
          uiSchema: updated.uiSchema ?? null,
          pythonCode: updated.pythonCode ?? null,
        })
      } catch (err) {
        send('error', { message: err instanceof Error ? err.message : String(err) })
      } finally {
        koaCtx.res.end()
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
