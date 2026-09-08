/**
 * Agent 自动化评测驱动脚本
 * 连接真实 Agent Loop 执行 evals/ 下的 20 个评测任务，产出到 results/agent_eval/<CASE_ID>/ 并调用 run_eval.py 阅卷
 */

import { existsSync, mkdirSync, copyFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'fs'
import { resolve, join, basename } from 'path'

try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(resolve(process.cwd(), '.env'))
  }
} catch (e) {
  // .env file might be absent or already loaded
}
import { execFile } from 'child_process'
import { promisify } from 'util'
import { Context } from 'cordis'
import { randomUUID } from 'crypto'

import { apply as llmPlugin } from '@excel-harness/llm'
import { apply as sessionPlugin } from '@excel-harness/session'
import { apply as toolsPlugin } from '@excel-harness/tools'
import { apply as agentLoopPlugin } from '@excel-harness/agent-loop'
import { apply as excelToolPlugin } from '@excel-harness/excel-tool'
import { inspectExcel, runPython } from '@excel-harness/excel-tool'
import type { ExcelMeta, ToolRunParams } from '@excel-harness/shared'

const execFileAsync = promisify(execFile)

interface EvalCase {
  id: string
  tier: string
  title: string
  prompt: string
  inputs: string[]
  note: string
}

async function main() {
  const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
  if (!DEEPSEEK_API_KEY) {
    console.error('❌ 缺少环境变量 DEEPSEEK_API_KEY')
    process.exit(1)
  }

  // 获取要运行的题号列表（默认可以通过参数指定，如: npx tsx scripts/eval_agent.ts A1 A2）
  const args = process.argv.slice(2)
  const onlyList = args.length > 0 ? args : null

  // 1. 获取任务清单
  const { stdout: promptsJson } = await execFileAsync('python3', ['evals/run_eval.py', '--prompts'])
  const allCases: EvalCase[] = JSON.parse(promptsJson)
  const targetCases = onlyList ? allCases.filter((c) => onlyList.includes(c.id)) : allCases

  console.log(`🚀 开始评测 Agent，共 ${targetCases.length} 个任务...`)

  // 2. 初始化基座环境
  const ctx = new Context()
  ctx.plugin(llmPlugin, {
    apiKey: DEEPSEEK_API_KEY,
    baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
    model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
  })
  ctx.plugin(sessionPlugin, { sessionDir: '.sessions_eval' })
  ctx.plugin(toolsPlugin)
  ctx.plugin(agentLoopPlugin, { maxSteps: 8 })
  ctx.plugin(excelToolPlugin)
  await ctx.start()

  const resultsBase = resolve('results/agent_eval')
  if (!existsSync(resultsBase)) {
    mkdirSync(resultsBase, { recursive: true })
  }

  for (let i = 0; i < targetCases.length; i++) {
    const c = targetCases[i]
    console.log(`\n------------------------------------------------------------`)
    console.log(`[${i + 1}/${targetCases.length}] 正在运行 ${c.id} [${c.tier}] ${c.title}...`)

    const caseDir = join(resultsBase, c.id)
    if (existsSync(caseDir)) {
      rmSync(caseDir, { recursive: true, force: true })
    }
    mkdirSync(caseDir, { recursive: true })

    // 创建隔离会话
    const session = ctx.sessions.create(`eval_${c.id}`)
    const mountedFiles: ExcelMeta[] = []

    // 挂载输入文件
    for (const inName of c.inputs) {
      const srcPath = resolve('evals/fixtures', inName)
      if (!existsSync(srcPath)) continue
      const targetDir = resolve('.sessions_eval', session.id, 'uploads')
      mkdirSync(targetDir, { recursive: true })
      const targetPath = join(targetDir, inName)
      copyFileSync(srcPath, targetPath)

      try {
        const insp = await inspectExcel(targetPath)
        const meta: ExcelMeta = {
          fileId: randomUUID(),
          filename: inName,
          filepath: targetPath,
          fileSizeBytes: insp.fileSizeBytes ?? 0,
          uploadedAt: Date.now(),
          sheets: insp.sheets,
          activeSheet: insp.activeSheet,
          rowCount: insp.rowCount,
          columnCount: insp.columnCount,
          headerLevels: insp.headerLevels,
          headerStartRow: insp.headerStartRow,
          headerEndRow: insp.headerEndRow,
          dataStartRow: insp.dataStartRow,
          headers: insp.headers,
          sampleRows: insp.sampleRows,
          sensitiveColumns: [],
        }
        mountedFiles.push(meta)
      } catch (e: any) {
        // 对于故意损坏的文件（如 corrupt.xlsx），保留基础元数据
        mountedFiles.push({
          fileId: randomUUID(),
          filename: inName,
          filepath: targetPath,
          fileSizeBytes: 0,
          uploadedAt: Date.now(),
          sheets: [],
          activeSheet: '',
          rowCount: 0,
          columnCount: 0,
          headerLevels: 1,
          headerStartRow: 1,
          headerEndRow: 1,
          dataStartRow: 2,
          headers: [],
          sampleRows: [],
          sensitiveColumns: [],
        })
      }
    }

    ctx.sessions.addExcelFiles(session.id, mountedFiles)

    // 组装 Prompt，引导模型在需要时输出 claims.json
    const augmentedPrompt = `${c.prompt}

【系统指引要求】：
1. 若需生成文件，最终 Excel 或 CSV 结果必须导出到 OUTPUT_DIR 目录下。
2. 若题干要求在 claims 报告统计数字或说明（如 rows, total, count, sum, notes 等），请务必在 OUTPUT_DIR 目录下写入 claims.json 文件（示例：with open(os.path.join(OUTPUT_DIR, 'claims.json'), 'w') as f: json.dump({"total": 1234}, f)），或者在最终答复中输出形如 \`\`\`json:claims { ... } \`\`\` 的数据块。`

    let assistantResponse = ''
    try {
      await ctx.agentLoop.run({
        sessionId: session.id,
        userMessage: augmentedPrompt,
        onChunk: (chunk) => {
          assistantResponse += chunk
        },
      })
    } catch (err: any) {
      console.warn(`  ⚠️ Agent Loop 运行出错: ${err.message}`)
      assistantResponse += ` [Error: ${err.message}]`
    }

    // 检查是否生成了 Python 代码并运行
    const latestSession = ctx.sessions.get(session.id)
    const pythonCode = latestSession?.pythonCode

    let claimsData: Record<string, any> = {}

    if (pythonCode) {
      console.log(`  ⚙️ 执行生成工具代码...`)
      const defaultParams: ToolRunParams = {}
      if (latestSession?.uiSchema?.fields) {
        let fileIdx = 0
        for (const f of latestSession.uiSchema.fields) {
          if (f.default !== undefined) {
            defaultParams[f.name] = f.default as any
          } else if (f.type === 'file' && mountedFiles.length > 0) {
            const matched = mountedFiles.find((m) =>
              f.name.toLowerCase().includes(m.filename.toLowerCase().replace(/\.[^/.]+$/, '')) ||
              (f.label && f.label.toLowerCase().includes(m.filename.toLowerCase())) ||
              (f.description && f.description.toLowerCase().includes(m.filename.toLowerCase()))
            )
            if (matched) {
              defaultParams[f.name] = matched.filepath
            } else {
              defaultParams[f.name] = mountedFiles[Math.min(fileIdx, mountedFiles.length - 1)].filepath
            }
            fileIdx++
          }
        }
      }

      // 如果 params 为空但有挂载文件，默认传入 input_file / input_files
      if (Object.keys(defaultParams).length === 0 && mountedFiles.length > 0) {
        defaultParams['input_file'] = mountedFiles[0].filepath
        defaultParams['input_files'] = mountedFiles.map((m) => m.filepath).join(',')
      }

      const runRes = await runPython({
        code: pythonCode,
        params: defaultParams,
        timeoutMs: 60_000,
        tmpDir: resolve('.sessions_eval', session.id, 'tmp'),
      })

      if (runRes.outputDir && existsSync(runRes.outputDir)) {
        // 递归扫描收集产物（兼容 Agent 将输出写入 output/ 等子目录的情况）
        const collectFiles = (dir: string) => {
          for (const item of readdirSync(dir)) {
            if (item.startsWith('.')) continue
            const fullPath = join(dir, item)
            const st = statSync(fullPath)
            if (st.isDirectory()) {
              collectFiles(fullPath)
            } else if (st.isFile()) {
              copyFileSync(fullPath, join(caseDir, item))
            }
          }
        }
        collectFiles(runRes.outputDir)
      }

      if (!runRes.success) {
        claimsData['success'] = false
        claimsData['error'] = runRes.stderr || 'Python 执行失败'
      }
    } else {
      // 未生成工具（可能是拒答题目如 E1, E2，或模型纯文本回复）
      console.log(`  ℹ️ Agent 未生成工具代码（可能为拒答题或直接分析）`)
      claimsData['success'] = false
      claimsData['error'] = assistantResponse
      claimsData['notes'] = assistantResponse
    }

    // 从输出目录寻找是否已有 Python 生成的 claims.json
    const claimsFilePath = join(caseDir, 'claims.json')
    if (existsSync(claimsFilePath)) {
      try {
        const { readFileSync } = await import('fs')
        claimsData = { ...claimsData, ...JSON.parse(readFileSync(claimsFilePath, 'utf-8')) }
      } catch {}
    } else {
      // 尝试从助手回复中提取 ```json:claims 或 ```json 中的声明字段
      const jsonMatch = assistantResponse.match(/```json(?:[:\w]*)\s*([\s\S]*?)\s*```/)
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1])
          claimsData = { ...claimsData, ...parsed }
        } catch {}
      }
    }

    // 写入最终的 claims.json
    writeFileSync(claimsFilePath, JSON.stringify(claimsData, null, 2), 'utf-8')
    console.log(`  📁 产出就绪，claims:`, Object.keys(claimsData))
  }

  await ctx.stop()

  // 3. 运行阅卷评分器
  console.log(`\n============================================================`)
  console.log(`📊 正在调用 evals/run_eval.py 阅卷出具成绩报告...`)
  console.log(`============================================================\n`)

  const pyArgs = ['evals/run_eval.py', '--dir', 'results/agent_eval']
  if (onlyList) {
    pyArgs.push('--only', ...onlyList)
  }

  try {
    const { stdout, stderr } = await execFileAsync('python3', pyArgs)
    console.log(stdout)
    if (stderr) console.error(stderr)
  } catch (err: any) {
    console.log(err.stdout || '')
    console.error(err.stderr || err.message)
  }
}

main().catch((err) => {
  console.error('Fatal Error:', err)
  process.exit(1)
})
