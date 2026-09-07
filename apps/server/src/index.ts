/**
 * Excel Tool Harness — 服务入口
 *
 * 启动顺序（参考 dsh 的 Profile/Bundle 概念）:
 *   1. 加载环境变量
 *   2. 创建 Cordis Context（即"基座"）
 *   3. 按依赖顺序挂载插件
 *   4. 启动 Web 服务
 */

import 'dotenv/config'
import { Context } from 'cordis'

// ─── 插件导入 ─────────────────────────────────────────────────────────────────
import { apply as llmPlugin }       from '@excel-harness/llm'
import { apply as sessionPlugin }   from '@excel-harness/session'
import { apply as toolsPlugin }     from '@excel-harness/tools'
import { apply as agentLoopPlugin } from '@excel-harness/agent-loop'
import { apply as excelToolPlugin } from '@excel-harness/excel-tool'
import { apply as webHostPlugin }   from '@excel-harness/web-host'

// ─── 配置校验 ─────────────────────────────────────────────────────────────────
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
if (!DEEPSEEK_API_KEY) {
  console.error('❌ 缺少环境变量 DEEPSEEK_API_KEY，请复制 .env.example 为 .env 并填写')
  process.exit(1)
}

// ─── 基座启动 ─────────────────────────────────────────────────────────────────
const ctx = new Context()

// 1. LLM 服务（DeepSeek API 适配器）
ctx.plugin(llmPlugin, {
  apiKey: DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
  model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
})

// 2. 会话管理（append-only 日志 + JSON 持久化）
ctx.plugin(sessionPlugin, {
  sessionDir: process.env.SESSION_DIR ?? '.sessions',
})

// 3. 工具注册表
ctx.plugin(toolsPlugin)

// 4. Agent 驱动主循环
ctx.plugin(agentLoopPlugin, {
  maxSteps: 10,
})

// 5. Excel 专属工具（向工具注册表注册 generate_excel_tool / run_excel_tool）
ctx.plugin(excelToolPlugin)

// 6. Web 宿主（Koa HTTP 服务 + SSE 流式接口）
ctx.plugin(webHostPlugin, {
  port: Number(process.env.PORT ?? 3080),
  host: process.env.HOST ?? '127.0.0.1',
  staticDir: 'apps/web/dist',
})

// ─── 优雅退出 ─────────────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\n正在关闭服务...')
  await ctx.stop()
  process.exit(0)
})

await ctx.start()
console.log('✅ Excel Tool Harness 已启动')
console.log(`   后端 API : http://${process.env.HOST ?? '127.0.0.1'}:${process.env.PORT ?? 3080}`)
console.log(`   前端开发 : 运行 pnpm web:dev 后访问 http://localhost:5173`)
