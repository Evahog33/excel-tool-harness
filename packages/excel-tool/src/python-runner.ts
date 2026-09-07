/**
 * Python 子进程执行器
 * 负责将生成的 Python 脚本写入临时文件并通过 child_process 执行
 */

import { spawn, execFile } from 'child_process'
import { writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, rmSync } from 'fs'
import { join, dirname, basename, resolve } from 'path'
import { randomUUID } from 'crypto'
import { promisify } from 'util'
import { StringDecoder } from 'string_decoder'
import { fileURLToPath } from 'node:url'
import type { ToolRunParams } from '@excel-harness/shared'

const execFileAsync = promisify(execFile)

export const DEFAULT_PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3'

export interface OutputFileInfo {
  filename: string
  filepath: string
}

export interface RunPythonOptions {
  /** Python 脚本内容 */
  code: string
  /** 传入脚本的参数（将落盘为 input.json） */
  params?: ToolRunParams
  /** 超时时间（ms），默认 60000 */
  timeoutMs?: number
  /** 是否为预检试跑（试跑完成后会自动销毁临时测试目录） */
  isPreflight?: boolean
  /** 临时文件目录 */
  tmpDir?: string
  /** Python 可执行文件路径 */
  pythonPath?: string
  /** 最大日志缓冲捕获字节数（防止模型死循环打印导致 Node 内存 OOM），默认 2MB */
  maxLogBytes?: number
  /** 可选的实时 stdout 块流式回调 */
  onStdout?: (chunk: string) => void
  /** 可选的实时 stderr 块流式回调 */
  onStderr?: (chunk: string) => void
}

export interface RunPythonResult {
  success: boolean
  stdout: string
  stderr: string
  durationMs: number
  outputDir?: string
  /** 输出文件列表（若脚本生成了结果文件） */
  outputFiles?: OutputFileInfo[]
}

/** 运行 Python 脚本（基于 spawn 流式执行与 input.json 参数落盘） */
export async function runPython(opts: RunPythonOptions): Promise<RunPythonResult> {
  const {
    code,
    params = {},
    timeoutMs = 60_000,
    pythonPath = process.env.PYTHON_PATH ?? DEFAULT_PYTHON_CMD,
    maxLogBytes = 2 * 1024 * 1024, // 默认最大捕获 2MB 日志，防 OOM
    onStdout,
    onStderr,
  } = opts
  const tmpDir = resolve(opts.tmpDir ?? '.sessions/tmp')

  if (!existsSync(tmpDir)) {
    mkdirSync(tmpDir, { recursive: true })
  }

  const scriptId = randomUUID()
  const scriptPath = join(tmpDir, `${scriptId}.py`)
  const outputDir = join(tmpDir, scriptId)
  mkdirSync(outputDir, { recursive: true })

  // 1. 参数落盘为 input.json（彻底避开操作系统的环境变量长度上限 E2BIG）
  const inputJsonPath = join(outputDir, 'input.json')
  writeFileSync(inputJsonPath, JSON.stringify(params, null, 2), 'utf-8')

  // 2. 写入脚本前导代码：优先从 input.json 文件读取，同时兼容环境变量
  const preamble = `
import os, sys, json
OUTPUT_DIR = ${JSON.stringify(outputDir)}
INPUT_JSON_PATH = ${JSON.stringify(inputJsonPath)}

if os.path.exists(INPUT_JSON_PATH):
    try:
        with open(INPUT_JSON_PATH, 'r', encoding='utf-8') as _f:
            PARAMS = json.load(_f)
    except Exception:
        PARAMS = {}
else:
    PARAMS = json.loads(os.environ.get('EXCEL_PARAMS', '{}'))
`
  writeFileSync(scriptPath, preamble + '\n' + code, 'utf-8')

  const start = Date.now()

  return new Promise<RunPythonResult>((resolve) => {
    let stdoutBuffer = ''
    let stderrBuffer = ''
    let isStdoutTruncated = false
    let isStderrTruncated = false
    let isFinished = false

    // UTF-8 跨 chunk 增量解码器，避免多字节中文在流边缘碎字导致乱码 \ufffd
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')

    // 3. 使用 spawn 进行流式执行；开启 detached: true 创建独立进程组（解决孤儿进程问题）
    const isWindows = process.platform === 'win32'
    const pyProcess = spawn(pythonPath, [scriptPath, inputJsonPath], {
      cwd: outputDir,
      detached: !isWindows, // Unix/macOS 下作为进程组 Leader，支持组级连根销毁
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1', // 禁用 Python C 级输出缓冲，确保实时输出
        EXCEL_OUTPUT_DIR: outputDir,
        EXCEL_INPUT_JSON: inputJsonPath,
        EXCEL_PARAMS: JSON.stringify(params),
      },
    })

    // 统一安全的进程组拆卸函数（两段式：SIGTERM 宽限 -> SIGKILL 兜底）
    const killProcessGroup = (forceKill = false) => {
      const pid = pyProcess.pid
      if (!pid) return

      try {
        if (isWindows) {
          // Windows 上通过 taskkill 递归终结整棵进程树
          if (forceKill) {
            spawn('taskkill', ['/pid', String(pid), '/t', '/f'])
          } else {
            pyProcess.kill('SIGTERM')
          }
        } else {
          // Unix/macOS 上向负 PID 广播信号，彻底清理所有子孙进程
          process.kill(-pid, forceKill ? 'SIGKILL' : 'SIGTERM')
        }
      } catch {
        // 进程组已自然退出（ESRCH），忽略错误
      }
    }

    // 超时保护定时器（先发 SIGTERM 优雅退出，2000ms 后强制 SIGKILL）
    const timer = setTimeout(() => {
      if (!isFinished) {
        isFinished = true
        killProcessGroup(false)

        const graceTimer = setTimeout(() => {
          killProcessGroup(true)
        }, 2000)
        graceTimer.unref()

        try { unlinkSync(scriptPath) } catch {}
        if (opts.isPreflight) {
          try { rmSync(outputDir, { recursive: true, force: true }) } catch {}
        }
        resolve({
          success: false,
          stdout: stdoutBuffer + stdoutDecoder.end(),
          stderr: `执行超时（超过 ${timeoutMs}ms）进程组已被安全回收`,
          durationMs: Date.now() - start,
          outputDir,
        })
      }
    }, timeoutMs)

    // 4. 流式安全监听 stdout（含中文解码与最大字节预算防 OOM）
    pyProcess.stdout.on('data', (chunk: Buffer) => {
      const text = typeof chunk === 'string' ? chunk : stdoutDecoder.write(chunk)
      onStdout?.(text)

      if (!isStdoutTruncated) {
        if (Buffer.byteLength(stdoutBuffer, 'utf8') + Buffer.byteLength(text, 'utf8') <= maxLogBytes) {
          stdoutBuffer += text
        } else {
          isStdoutTruncated = true
          stdoutBuffer += `\n[stdout 日志输出已超过 ${Math.round(maxLogBytes / 1024)}KB 上限，后续内容已自动截断以保护内存安全]`
        }
      }
    })

    // 4. 流式安全监听 stderr（含中文解码与最大字节预算防 OOM）
    pyProcess.stderr.on('data', (chunk: Buffer) => {
      const text = typeof chunk === 'string' ? chunk : stderrDecoder.write(chunk)
      onStderr?.(text)

      if (!isStderrTruncated) {
        if (Buffer.byteLength(stderrBuffer, 'utf8') + Buffer.byteLength(text, 'utf8') <= maxLogBytes) {
          stderrBuffer += text
        } else {
          isStderrTruncated = true
          stderrBuffer += `\n[stderr 报错日志输出已超过 ${Math.round(maxLogBytes / 1024)}KB 上限，后续内容已自动截断以保护内存安全]`
        }
      }
    })

    // 启动错误捕获
    pyProcess.on('error', (err) => {
      if (!isFinished) {
        isFinished = true
        clearTimeout(timer)
        try { unlinkSync(scriptPath) } catch {}
        if (opts.isPreflight) {
          try { rmSync(outputDir, { recursive: true, force: true }) } catch {}
        }
        resolve({
          success: false,
          stdout: stdoutBuffer + stdoutDecoder.end(),
          stderr: `无法启动 Python 进程: ${err.message}`,
          durationMs: Date.now() - start,
          outputDir,
        })
      }
    })

    // 5. 退出处理与产物扫描
    pyProcess.on('close', (code) => {
      if (!isFinished) {
        isFinished = true
        clearTimeout(timer)
        try { unlinkSync(scriptPath) } catch {}

        // flush 解码器尾部残留字节
        stdoutBuffer += stdoutDecoder.end()
        stderrBuffer += stderrDecoder.end()

        const outputFiles: OutputFileInfo[] = []
        if (existsSync(outputDir)) {
          for (const fname of readdirSync(outputDir)) {
            // 排除 input.json 及隐藏文件，只识别实际产物
            if (!fname.startsWith('.') && fname !== 'input.json') {
              outputFiles.push({
                filename: fname,
                filepath: join(outputDir, fname),
              })
            }
          }
        }

        if (opts.isPreflight) {
          try { rmSync(outputDir, { recursive: true, force: true }) } catch {}
        }

        resolve({
          success: code === 0,
          stdout: stdoutBuffer,
          stderr: stderrBuffer,
          durationMs: Date.now() - start,
          outputDir,
          outputFiles,
        })
      }
    })
  })
}

export interface SensitiveColumnDetection {
  column: string
  type: 'id_card' | 'phone' | 'email' | 'bank_card' | 'name' | 'amount'
  rule: string
  label: string
  reason: string
  desc: string
}

export interface ExcelInspectionResult {
  filename: string
  filepath: string
  fileSizeBytes: number
  sheets: string[]
  activeSheet: string
  rowCount: number
  columnCount: number
  headerLevels: number
  headerStartRow: number
  headerEndRow: number
  dataStartRow: number
  headers: string[]
  sampleRows: Record<string, any>[]
  sensitiveColumns: SensitiveColumnDetection[]
}

/** 检查 Excel 结构与智能嗅探敏感字段 */
export async function inspectExcel(filepath: string, pythonPath = process.env.PYTHON_PATH ?? DEFAULT_PYTHON_CMD): Promise<ExcelInspectionResult> {
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const inspectorScript = join(currentDir, 'inspector.py')
  const { stdout, stderr } = await execFileAsync(pythonPath, [inspectorScript, filepath], {
    timeout: 30_000,
  })

  if (!stdout.trim()) {
    throw new Error(`Excel 检查器执行无输出: ${stderr}`)
  }

  const res = JSON.parse(stdout)
  if (!res.success) {
    throw new Error(res.error || 'Excel 检查失败')
  }

  return res.data
}

/** 静态检查 Python 代码语法是否正确，防范无挂载数据源时的预检死循环 */
export async function checkPythonSyntax(
  code: string,
  pythonPath = process.env.PYTHON_PATH ?? DEFAULT_PYTHON_CMD,
): Promise<{ success: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(pythonPath, ['-c', 'import sys, ast\nast.parse(sys.stdin.read())'])
    let stderr = ''
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf-8')
    })
    child.on('close', (exitCode) => {
      resolve({
        success: exitCode === 0,
        stderr: stderr.trim(),
      })
    })
    child.on('error', (err) => {
      resolve({
        success: false,
        stderr: err.message,
      })
    })
    child.stdin.write(code, 'utf-8')
    child.stdin.end()
  })
}
