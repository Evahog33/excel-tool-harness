/**
 * @excel-harness/excel-tool
 * Excel 专属工具插件 —— 核心业务插件
 *
 * 注册两个工具：
 *   1. generate_excel_tool：让 LLM 生成 Python 代码 + UI Schema
 *   2. run_excel_tool：（右侧沙箱）执行已生成的 Python 脚本
 */

import { Context } from 'cordis'
import { runPython } from './python-runner'
import type { UiSchema } from '@excel-harness/session'

export function apply(ctx: Context) {
  ctx.inject(['tools', 'sessions'], (ctx) => {
    // ── 工具1: generate_excel_tool ──────────────────────────────────────────
    ctx.tools.register({
      name: 'generate_excel_tool',
      description:
        '根据用户的 Excel 处理需求，生成 Python 处理脚本和 UI 参数表单 Schema。' +
        '每当用户描述一个新的 Excel 处理任务时，必须调用此工具。',
      parameters: {
        python_code: {
          type: 'string',
          description:
            '完整的 Python 脚本。脚本可通过 PARAMS 字典获取用户填写的参数（如文件路径），' +
            '处理结果应保存到 OUTPUT_DIR 目录下。必须 import pandas, openpyxl 等所需库。',
          required: true,
        },
        ui_schema: {
          type: 'string',
          description:
            'JSON 字符串，描述右侧沙箱表单。格式示例：' +
            '{"title":"工具名称","fields":[{"name":"input_file","label":"上传 Excel","type":"file","accept":".xlsx,.xls","required":true}]}' +
            '。字段类型可以是: text | number | file | select | checkbox。',
          required: true,
        },
        summary: {
          type: 'string',
          description: '向用户展示的简短说明，描述该工具的用途和使用方法。',
          required: true,
        },
      },
      execute: async (input: { python_code: string; ui_schema: string; summary: string }, ctx) => {
        // 找到当前会话（通过事件系统或注入的 sessionId）
        const sessions = ctx.sessions.list()
        const latestSession = sessions[0]
        if (!latestSession) return '❌ 未找到活动会话'

        let uiSchema: UiSchema
        try {
          uiSchema = typeof input.ui_schema === 'string' ? JSON.parse(input.ui_schema) : (input.ui_schema as UiSchema)
        } catch {
          return '❌ UI Schema 解析失败，请确保是合法的 JSON 格式'
        }

        // 更新会话资产（Python 代码 + UI Schema）
        ctx.sessions.updateAssets(latestSession.id, {
          pythonCode: input.python_code,
          uiSchema,
        })

        return JSON.stringify({
          status: 'success',
          message: `工具已生成并发布到右侧沙箱。${input.summary}`,
          uiSchema,
        })
      },
    })

    // ── 工具2: run_excel_tool ───────────────────────────────────────────────
    ctx.tools.register({
      name: 'run_excel_tool',
      description:
        '（内部工具）在服务器端执行已生成的 Python 脚本。通常由右侧沙箱的"执行"按钮触发，而非 LLM 直接调用。',
      parameters: {
        session_id: {
          type: 'string',
          description: '会话 ID，用于获取已生成的 Python 脚本',
          required: true,
        },
        params: {
          type: 'object',
          description: '用户填写的参数（键值对），将通过 PARAMS 环境变量传入 Python 脚本',
          required: false,
        },
      },
      execute: async (input: { session_id: string; params?: Record<string, string> }) => {
        const session = ctx.sessions.get(input.session_id)
        if (!session) return JSON.stringify({ error: '会话不存在' })
        if (!session.pythonCode) return JSON.stringify({ error: '该会话尚未生成 Python 脚本' })

        const result = await runPython({
          code: session.pythonCode,
          params: input.params ?? {},
          pythonPath: process.env.PYTHON_PATH,
        })

        return JSON.stringify({
          success: result.success,
          stdout: result.stdout.slice(0, 2000),
          stderr: result.stderr.slice(0, 1000),
          durationMs: result.durationMs,
        })
      },
    })

    ctx.logger('excel-tool').info('Excel 工具已注册: generate_excel_tool, run_excel_tool')
  })
}
