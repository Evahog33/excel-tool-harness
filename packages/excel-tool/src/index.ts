/**
 * @excel-harness/excel-tool
 * Excel 专属工具插件 —— 核心业务插件
 *
 * 注册两个工具：
 *   1. generate_excel_tool：让 LLM 生成 Python 代码 + UI Schema
 *   2. run_excel_tool：（右侧沙箱）执行已生成的 Python 脚本
 */

import { Context } from 'cordis'
import { resolve, dirname, extname, join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { runPython, inspectExcel, checkPythonSyntax, compareExcelFiles } from './python-runner.js'
import type { UiSchema, ToolRunParams, ExcelMeta } from '@excel-harness/session'

export { runPython, inspectExcel, checkPythonSyntax, compareExcelFiles }
export type { ExcelInspectionResult, SensitiveColumnDetection, OutputFileInfo, RunPythonResult } from './python-runner'

export * from './desensitizer'

export const inject = ['tools', 'sessions']

/** 辅助函数：剔除大模型在 Function Call 参数中偶尔包裹的外层 Markdown 围栏 */
function stripMarkdownCodeBlock(str: string): string {
  if (!str || typeof str !== 'string') return ''
  return str
    .trim()
    .replace(/^```[a-zA-Z0-9_-]*\r?\n/, '')
    .replace(/\r?\n```\s*$/, '')
    .trim()
}

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

        // 净化输入：剥离大模型偶尔添加的外层 ``` 代码围栏
        const pythonCode = stripMarkdownCodeBlock(input.python_code)
        const rawUiSchema = typeof input.ui_schema === 'string' ? stripMarkdownCodeBlock(input.ui_schema) : input.ui_schema

        let uiSchema: UiSchema
        try {
          uiSchema = typeof rawUiSchema === 'string' ? JSON.parse(rawUiSchema) : (rawUiSchema as UiSchema)
        } catch {
          return JSON.stringify({
            status: 'error',
            error: 'UI Schema 解析失败，请确保是合法的 JSON 格式。请修正后重新调用 generate_excel_tool。'
          })
        }

        // ── 自动化沙箱预检自测试 (Pre-flight Sandbox Run) ──
        const excelFiles = ctx.sessions.getExcelFiles(latestSession.id)
        let testStdout = ''
        let generatedFiles: string[] = []

        if (excelFiles.length > 0) {
          // ── 模式 A: 挂载了真实数据源，进行真实沙箱试跑自测试 ──
          const testParams: ToolRunParams = {}
          if (uiSchema.fields) {
            const usedFileIds = new Set<string>()
            for (const field of uiSchema.fields) {
              if (field.type === 'file') {
                const fieldText = `${field.name} ${field.label || ''} ${field.description || ''}`.toLowerCase()
                
                // 1. 尝试通过文件名/字段描述关键词进行匹配
                let matched = excelFiles.find(f => {
                  if (usedFileIds.has(f.fileId)) return false
                  const fname = f.filename.toLowerCase()
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
                  // 性能保障：对于超大文件采用微样本切片，几百毫秒内完成预检，防止 60s 超时死循环
                  testParams[field.name] = await getOrCreatePreflightSamplePath(matched)
                }
              } else if ((field as any).default !== undefined) {
                const def = (field as any).default
                testParams[field.name] = typeof def === 'object' && def !== null ? (def.value ?? def.label ?? '') : def
              } else if (field.type === 'select' && (field as any).options?.length) {
                const firstOpt = (field as any).options[0]
                testParams[field.name] = typeof firstOpt === 'object' && firstOpt !== null ? (firstOpt.value ?? firstOpt.label ?? '') : firstOpt
              } else if (field.type === 'checkbox') {
                testParams[field.name] = Boolean((field as any).default ?? false)
              }
            }
          }

          ctx.logger('excel-tool').info('执行代码自动预检试运行 (真实数据源微样本)...')
          const testRun = await runPython({
            code: pythonCode,
            params: testParams,
            pythonPath: process.env.PYTHON_PATH,
            isPreflight: true,
            timeoutMs: 12_000,
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

          testStdout = testRun.stdout.slice(0, 500)
          generatedFiles = testRun.outputFiles?.map((f) => f.filename) || []

          // 若会话挂载了标杆文件，进行自动标杆验收比对并出具简要指标
          let benchmarkNotice = ''
          if (latestSession.benchmarkFile && testRun.outputFiles && testRun.outputFiles.length > 0) {
            try {
              const diff = await compareExcelFiles(
                testRun.outputFiles[0].filepath,
                latestSession.benchmarkFile.filepath,
                process.env.PYTHON_PATH,
              )
              benchmarkNotice = `\n[标杆验收自动比对] 整体匹配率: ${diff.overallMatchRate}%。${diff.summaryText}`
            } catch (diffErr: any) {
              ctx.logger('excel-tool').warn('预检标杆比对失败:', diffErr)
            }
          }

          testStdout = (testStdout + benchmarkNotice).trim()
        } else {
          // ── 模式 B: 无挂载数据源，执行 Python 代码静态编译与语法检查，彻底杜绝假 Mock 数据引发 KeyError 死循环 ──
          ctx.logger('excel-tool').info('当前会话无挂载数据源，执行 Python 静态语法编译检查...')
          const syntaxCheck = await checkPythonSyntax(pythonCode, process.env.PYTHON_PATH)
          if (!syntaxCheck.success) {
            ctx.logger('excel-tool').warn(`代码静态语法检查未通过: ${syntaxCheck.stderr}`)
            return JSON.stringify({
              status: 'error',
              error: 'Python 代码静态编译语法检查失败',
              stderr: syntaxCheck.stderr,
              instruction: '请仔细阅读上方 Python 语法报错（关注语法错误、缩进错误、未闭合符号等），修复后重新调用 generate_excel_tool。'
            })
          }
          testStdout = 'Python 代码静态编译检查通过 (语法正确)'
        }

        // 预检通过！更新会话资产（Python 代码 + UI Schema）
        ctx.sessions.updateAssets(latestSession.id, {
          pythonCode,
          uiSchema,
        })

        return JSON.stringify({
          status: 'success',
          message: `代码已成功通过预检测试！${input.summary}`,
          uiSchema,
          testStdout,
          outputFiles: generatedFiles,
        })
      },
    })

    // ── 工具2: run_excel_tool ───────────────────────────────────────────────
    ctx.tools.register({
      name: 'run_excel_tool',
      internal: true,
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
      execute: async (input: { session_id: string; params?: ToolRunParams }) => {
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

/** 为大文件生成轻量微样本供自动化预检，将测试时间压缩至几百毫秒，彻底规避 60s 超时死循环 */
async function getOrCreatePreflightSamplePath(meta: ExcelMeta): Promise<string> {
  // 数据量较小无需采样，直接使用原文件
  if (meta.rowCount <= 150) return meta.filepath
  const dir = dirname(meta.filepath)
  const ext = extname(meta.filepath)
  const samplePath = join(dir, `_preflight_${meta.fileId}${ext}`)
  if (existsSync(samplePath)) return samplePath

  try {
    const isCsv = ext.toLowerCase() === '.csv'
    const pyCode = [
      'import pandas as pd',
      `src = ${JSON.stringify(meta.filepath)}`,
      `dst = ${JSON.stringify(samplePath)}`,
      isCsv
        ? 'df = pd.read_csv(src, nrows=80)'
        : `df = pd.read_excel(src, nrows=80${meta.headerLevels > 1 ? `, header=list(range(${meta.headerLevels}))` : ''})`,
      isCsv
        ? 'df.to_csv(dst, index=False)'
        : 'df.to_excel(dst, index=False)',
    ].join('\n')
    await runPython({ code: pyCode, isPreflight: true, timeoutMs: 10_000 })
    if (existsSync(samplePath)) return samplePath
  } catch {}
  return meta.filepath
}

/** 为未挂载数据源的会话生成或获取轻量基础 Mock Excel 垫片文件 */
async function getOrCreateMockExcelPath(): Promise<string> {
  const mockDir = resolve('.sessions', 'mock')
  if (!existsSync(mockDir)) mkdirSync(mockDir, { recursive: true })
  const mockFile = resolve(mockDir, 'mock_sample.xlsx')
  if (!existsSync(mockFile)) {
    const pyCode = [
      'import pandas as pd',
      'df = pd.DataFrame([',
      '    {"ID": "1001", "姓名": "张三", "部门": "技术部", "金额": 8500, "日期": "2026-01-01"},',
      '    {"ID": "1002", "姓名": "李四", "部门": "市场部", "金额": 9200, "日期": "2026-01-02"},',
      '])',
      `df.to_excel(${JSON.stringify(mockFile)}, index=False)`,
    ].join('\n')
    await runPython({ code: pyCode })
  }
  return mockFile
}
