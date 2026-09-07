/**
 * @excel-harness/excel-tool
 * Excel 专属工具插件 —— 核心业务插件
 *
 * 注册两个工具：
 *   1. generate_excel_tool：让 LLM 生成 Python 代码 + UI Schema
 *   2. run_excel_tool：（右侧沙箱）执行已生成的 Python 脚本
 */

import { Context } from 'cordis'
import { runPython, inspectExcel } from './python-runner'
import type { UiSchema } from '@excel-harness/session'

export { runPython, inspectExcel }
export type { ExcelInspectionResult, SensitiveColumnDetection, OutputFileInfo, RunPythonResult } from './python-runner'
export * from './desensitizer'

export const inject = ['tools', 'sessions']

export function apply(ctx: Context) {
  ctx.inject(['tools', 'sessions'], (ctx) => {
    // ── 工具1: generate_excel_tool ──────────────────────────────────────────
    ctx.tools.register({
      name: 'generate_excel_tool',
      description:
        '根据用户的 Excel 处理需求，生成 Python 处理脚本和 UI 参数表单 Schema。' +
        '每当用户描述一个新的 Excel 处理任务时，必须调用此工具。' +
        '后台将自动在沙箱中进行代码预检试运行，若报错将返回堆栈供你修正。',
      parameters: {
        python_code: {
          type: 'string',
          description:
            '完整的 Python 脚本。脚本可通过 PARAMS 字典获取用户填写的参数（如文件路径），' +
            '处理结果必须保存到 OUTPUT_DIR 目录下（如 os.path.join(OUTPUT_DIR, "result.xlsx")）。必须 import pandas, openpyxl 等所需库。',
          required: true,
        },
        ui_schema: {
          type: 'string',
          description:
            'JSON 字符串，描述右侧沙箱表单。必须包含 title 和 fields。' +
            '对于需要处理的输入文件，必须在 fields 前置声明 type 为 "file" 的项（如 name="input_file_1"），' +
            '并配置 description 指明该槽位对应哪类数据。其他提炼出的排序、过滤条件等作为 text/select/checkbox 参数。',
          required: true,
        },
        summary: {
          type: 'string',
          description: '向用户展示的简短说明，描述该工具的用途和使用方法。',
          required: true,
        },
        session_id: {
          type: 'string',
          description: '当前会话 ID（可选）',
          required: false,
        },
      },
      execute: async (input: { python_code: string; ui_schema: string; summary: string; session_id?: string }, ctx) => {
        // 找到当前会话
        const latestSession = input.session_id ? ctx.sessions.get(input.session_id) : ctx.sessions.list()[0]
        if (!latestSession) return '❌ 未找到活动会话'

        let uiSchema: UiSchema
        try {
          uiSchema = typeof input.ui_schema === 'string' ? JSON.parse(input.ui_schema) : (input.ui_schema as UiSchema)
        } catch {
          return JSON.stringify({
            status: 'error',
            error: 'UI Schema 解析失败，请确保是合法的 JSON 格式。请修正后重新调用 generate_excel_tool。'
          })
        }

        // ── 自动化沙箱预检自测试 (Pre-flight Sandbox Run) ──
        const testParams: Record<string, string> = {}
        const excelFiles = ctx.sessions.getExcelFiles(latestSession.id)

        // 预填测试参数：如果是 file 槽位，智能匹配当前会话已挂载的对应测试文件
        if (uiSchema.fields) {
          const usedFileIds = new Set<string>()
          for (const field of uiSchema.fields) {
            if (field.type === 'file') {
              const fieldText = `${field.name} ${field.label || ''} ${field.description || ''}`.toLowerCase()
              
              // 1. 尝试通过文件名/字段描述关键词进行匹配
              let matched = excelFiles.find(f => {
                if (usedFileIds.has(f.fileId)) return false
                const fname = f.filename.toLowerCase()
                // 检查文件名关键词是否在字段描述中，或字段名在文件名中
                return fieldText.includes(fname.replace(/\.[^/.]+$/, '')) || 
                       fname.includes(field.name.toLowerCase())
              })

              // 2. 若未匹配，检查列名与字段文本的匹配度
              if (!matched) {
                matched = excelFiles.find(f => {
                  if (usedFileIds.has(f.fileId)) return false
                  return f.headers.some(h => fieldText.includes(h.toLowerCase()))
                })
              }

              // 3. 兜底策略：取第一个未使用的文件，或第一个文件
              if (!matched) {
                matched = excelFiles.find(f => !usedFileIds.has(f.fileId)) || excelFiles[0]
              }

              if (matched) {
                usedFileIds.add(matched.fileId)
                testParams[field.name] = matched.filepath
              }
            } else if ((field as any).default !== undefined) {
              const def = (field as any).default
              testParams[field.name] = typeof def === 'object' && def !== null ? String(def.value ?? def.label ?? '') : String(def)
            } else if (field.type === 'select' && (field as any).options?.length) {
              const firstOpt = (field as any).options[0]
              testParams[field.name] = typeof firstOpt === 'object' && firstOpt !== null ? String(firstOpt.value ?? firstOpt.label ?? '') : String(firstOpt)
            }
          }
        }

        ctx.logger('excel-tool').info('执行代码自动预检试运行...')
        const testRun = await runPython({
          code: input.python_code,
          params: testParams,
          pythonPath: process.env.PYTHON_PATH,
        })

        // 若预检运行失败，将错误 Traceback 直接反哺喂回 Agent Loop，由大模型自动纠错自愈！
        if (!testRun.success) {
          ctx.logger('excel-tool').warn(`代码预检试运行未通过: ${testRun.stderr}`)
          return JSON.stringify({
            status: 'error',
            error: 'Python 代码自动预检运行失败',
            stderr: testRun.stderr,
            instruction: '请仔细阅读上方 Python 报错 Traceback（关注报错行号、KeyError、列名拼写、空值除零或缺失文件处理等），自我反思并修正 python_code 后重新调用 generate_excel_tool。'
          })
        }

        // 预检通过！更新会话资产（Python 代码 + UI Schema）
        ctx.sessions.updateAssets(latestSession.id, {
          pythonCode: input.python_code,
          uiSchema,
        })

        const generatedFiles = testRun.outputFiles?.map((f) => f.filename) || []

        return JSON.stringify({
          status: 'success',
          message: `代码已成功通过沙箱预检测试！${input.summary}`,
          uiSchema,
          testStdout: testRun.stdout.slice(0, 500),
          outputFiles: generatedFiles,
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
          outputFiles: result.outputFiles || [],
        })
      },
    })

    ctx.logger('excel-tool').info('Excel 工具已注册: generate_excel_tool, run_excel_tool (带预检自愈与产物扫描)')
  })
}
