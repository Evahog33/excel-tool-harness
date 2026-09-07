import Router from '@koa/router'
import type { Context } from 'cordis'

export function registerSessionRoutes(router: Router, ctx: Context) {
  // 创建会话
  router.post('/api/sessions', (koaCtx) => {
    const { title } = (koaCtx.request.body as any) ?? {}
    const session = ctx.sessions.create(title)
    koaCtx.body = { ok: true, session }
  })

  // 列出会话
  router.get('/api/sessions', (koaCtx) => {
    koaCtx.body = { sessions: ctx.sessions.list() }
  })

  // 会话详情
  router.get('/api/sessions/:id', (koaCtx) => {
    const session = ctx.sessions.get(koaCtx.params.id)
    if (!session) {
      koaCtx.status = 404
      return
    }
    koaCtx.body = { session }
  })

  // 删除会话（同时强制中止正在运行的 Agent 任务）
  router.delete('/api/sessions/:id', (koaCtx) => {
    ctx.agentLoop.abort(koaCtx.params.id)
    const ok = ctx.sessions.delete(koaCtx.params.id)
    if (!ok) {
      koaCtx.status = 404
      koaCtx.body = { error: '会话不存在' }
      return
    }
    koaCtx.body = { ok: true, deletedId: koaCtx.params.id }
  })

  // 获取会话生成的资产
  router.get('/api/sessions/:id/assets', (koaCtx) => {
    const session = ctx.sessions.get(koaCtx.params.id)
    if (!session) {
      koaCtx.status = 404
      return
    }
    const excelFiles = ctx.sessions.getExcelFiles(session.id)
    koaCtx.body = {
      uiSchema: session.uiSchema ?? null,
      pythonCode: session.pythonCode ?? null,
      excelMeta: excelFiles[0] ?? null,
      excelFiles,
      benchmarkFile: session.benchmarkFile ?? null,
    }
  })

  // 手动停止生成（Abort）
  router.post('/api/sessions/:id/abort', async (koaCtx) => {
    const session = ctx.sessions.get(koaCtx.params.id)
    if (!session) {
      koaCtx.status = 404
      koaCtx.body = { error: '会话不存在' }
      return
    }

    const aborted = ctx.agentLoop.abort(session.id)
    koaCtx.body = { ok: true, aborted }
  })

  // 撤回最后一条消息并重新编辑
  router.post('/api/sessions/:id/pop-message', async (koaCtx) => {
    const session = ctx.sessions.get(koaCtx.params.id)
    if (!session) {
      koaCtx.status = 404
      koaCtx.body = { error: '会话不存在' }
      return
    }

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
}
