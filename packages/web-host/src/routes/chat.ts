import Router from '@koa/router'
import type { Context } from 'cordis'

/** 记录当前正在进行流式生成任务的会话集合（会话级请求互斥锁） */
const activeChatSessions = new Set<string>()

export function registerChatRoutes(router: Router, ctx: Context) {
  // 对话（SSE 流式接口）
  router.post('/api/sessions/:id/chat', async (koaCtx) => {
    const session = ctx.sessions.get(koaCtx.params.id)
    if (!session) {
      koaCtx.status = 404
      return
    }

    const { message } = (koaCtx.request.body as any) ?? {}
    if (!message?.trim()) {
      koaCtx.status = 400
      koaCtx.body = { error: '缺少 message' }
      return
    }

    // 会话级并发互斥控制：防止同一会话被并发调用导致上下文写错位
    if (activeChatSessions.has(session.id)) {
      koaCtx.status = 409
      koaCtx.body = { error: '当前会话已有正在运行的生成任务，请等待完成或点击停止' }
      return
    }

    activeChatSessions.add(session.id)

    koaCtx.set('Content-Type', 'text/event-stream; charset=utf-8')
    koaCtx.set('Cache-Control', 'no-cache')
    koaCtx.set('Connection', 'keep-alive')
    koaCtx.status = 200

    const send = (event: string, data: unknown) => {
      try {
        koaCtx.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      } catch {}
    }

    let isCompleted = false
    let wasAborted = false

    // 仅当客户端异常中断连接时触发后台 Agent 中止
    const onClose = () => {
      if (!isCompleted) {
        wasAborted = true
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

      // 精准状态同步：如果已中止，不发送 done 事件，避免前端状态误覆盖
      if (wasAborted) {
        send('aborted', { message: '生成已中止' })
      } else {
        const updated = ctx.sessions.get(session.id)
        if (updated) {
          send('done', {
            uiSchema: updated.uiSchema ?? null,
            pythonCode: updated.pythonCode ?? null,
            session: updated,
          })
        }
      }
    } catch (err) {
      send('error', { message: err instanceof Error ? err.message : String(err) })
    } finally {
      isCompleted = true
      activeChatSessions.delete(session.id)
      koaCtx.req.removeListener('close', onClose)
      koaCtx.res.end()
    }
  })
}
