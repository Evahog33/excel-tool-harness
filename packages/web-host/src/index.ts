/**
 * @excel-harness/web-host
 * Web 宿主服务插件 —— Koa HTTP + SSE 流式接口
 *
 * API 路由模块化拆分：
 *   - routes/sessions.ts: 会话管理、撤回、终止
 *   - routes/excel.ts: Excel 数据源上传、检查、脱敏配置
 *   - routes/chat.ts: SSE 流式问答
 *   - routes/sandbox.ts: 沙箱脚本运行、安全表单上传、安全产物下载
 */

import { Context, Service } from 'cordis'
import Koa from 'koa'
import Router from '@koa/router'
import cors from '@koa/cors'
import { koaBody } from 'koa-body'
import { createServer } from 'http'
import { existsSync, statSync, createReadStream } from 'fs'
import { resolve, join, extname } from 'path'
import { registerSessionRoutes } from './routes/sessions.js'
import { registerExcelRoutes } from './routes/excel.js'
import { registerChatRoutes } from './routes/chat.js'
import { registerSandboxRoutes } from './routes/sandbox.js'

export * from './routes/sandbox.js'

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
    this.koa.use(
      koaBody({
        multipart: true,
        formidable: {
          maxFileSize: 50 * 1024 * 1024, // 限制最大 50MB 上传，防范磁盘耗尽
        },
      }),
    )

    // 注册各领域子路由
    registerSessionRoutes(router, ctx)
    registerExcelRoutes(router, ctx)
    registerChatRoutes(router, ctx)
    registerSandboxRoutes(router, ctx)

    this.koa.use(router.routes())
    this.koa.use(router.allowedMethods())

    // 静态资源托管与 SPA 回退
    if (config.staticDir) {
      const staticRoot = resolve(config.staticDir)
      if (existsSync(staticRoot)) {
        ctx.logger('web-host').info(`📦 挂载静态资源目录: ${staticRoot}`)
        const MIME_TYPES: Record<string, string> = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.ico': 'image/x-icon',
          '.woff': 'font/woff',
          '.woff2': 'font/woff2',
          '.ttf': 'font/ttf',
        }

        this.koa.use(async (koaCtx, next) => {
          await next()
          if (
            koaCtx.status === 404 &&
            (koaCtx.method === 'GET' || koaCtx.method === 'HEAD') &&
            !koaCtx.path.startsWith('/api/')
          ) {
            const reqPath = koaCtx.path === '/' ? '/index.html' : koaCtx.path
            const filePath = resolve(staticRoot, '.' + reqPath)

            // 安全防穿越：必须在 staticRoot 内
            if (!filePath.startsWith(staticRoot)) return

            if (existsSync(filePath) && statSync(filePath).isFile()) {
              const ext = extname(filePath).toLowerCase()
              koaCtx.type = MIME_TYPES[ext] || 'application/octet-stream'
              koaCtx.body = createReadStream(filePath)
              return
            }

            // SPA History Fallback
            const indexPath = join(staticRoot, 'index.html')
            if (existsSync(indexPath)) {
              koaCtx.type = 'text/html; charset=utf-8'
              koaCtx.body = createReadStream(indexPath)
            }
          }
        })
      }
    }

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
