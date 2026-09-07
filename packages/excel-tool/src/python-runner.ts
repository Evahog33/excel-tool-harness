/**
 * Python 子进程执行器
 * 负责将生成的 Python 脚本写入临时文件并通过 child_process 执行
 */

import { execFile } from 'child_process'
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface RunPythonOptions {
  /** Python 脚本内容 */
  code: string
  /** 传入脚本的参数（通过环境变量传递） */
  params?: Record<string, string>
  /** 超时时间（ms），默认 60000 */
  timeoutMs?: number
  /** 临时文件目录 */
  tmpDir?: string
  /** Python 可执行文件路径 */
  pythonPath?: string
}

export interface RunPythonResult {
  success: boolean
  stdout: string
  stderr: string
  durationMs: number
  /** 输出文件路径（若脚本生成了结果文件） */
  outputFiles?: string[]
}

/** 运行 Python 脚本 */
export async function runPython(opts: RunPythonOptions): Promise<RunPythonResult> {
  const {
    code,
    params = {},
    timeoutMs = 60_000,
    tmpDir = '.sessions/tmp',
    pythonPath = process.env.PYTHON_PATH ?? 'python3',
  } = opts

  if (!existsSync(tmpDir)) {
    mkdirSync(tmpDir, { recursive: true })
  }

  const scriptId = randomUUID()
  const scriptPath = join(tmpDir, `${scriptId}.py`)
  const outputDir = join(tmpDir, scriptId)
  mkdirSync(outputDir, { recursive: true })

  // 写入脚本，注入工具变量
  const preamble = `
import os, sys, json
OUTPUT_DIR = ${JSON.stringify(outputDir)}
PARAMS = json.loads(os.environ.get('EXCEL_PARAMS', '{}'))
`
  writeFileSync(scriptPath, preamble + '\n' + code, 'utf-8')

  const start = Date.now()

  try {
    const { stdout, stderr } = await execFileAsync(pythonPath, [scriptPath], {
      timeout: timeoutMs,
      env: {
        ...process.env,
        EXCEL_PARAMS: JSON.stringify(params),
        EXCEL_OUTPUT_DIR: outputDir,
      },
    })

    return {
      success: true,
      stdout,
      stderr,
      durationMs: Date.now() - start,
    }
  } catch (err: any) {
    return {
      success: false,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message,
      durationMs: Date.now() - start,
    }
  } finally {
    // 清理脚本文件（保留输出目录）
    try { unlinkSync(scriptPath) } catch {}
  }
}
