/**
 * Python 子进程执行器
 * 负责将生成的 Python 脚本写入临时文件并通过 child_process 执行
 */

import { spawn, execFile } from 'child_process'
import { writeFileSync, readFileSync, copyFileSync, statSync, mkdirSync, existsSync, unlinkSync, readdirSync, rmSync } from 'fs'
import { join, dirname, basename, resolve, extname } from 'path'
import { randomUUID, createHash } from 'crypto'
import { promisify } from 'util'
import { StringDecoder } from 'string_decoder'
import { fileURLToPath } from 'node:url'
import type { ToolRunParams, OutputFilePreview, WorkbookValidationReport } from '@excel-harness/shared'

const execFileAsync = promisify(execFile)

export const DEFAULT_PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3'

export interface OutputFileInfo {
  filename: string
  filepath: string
  preview?: OutputFilePreview
  validation?: WorkbookValidationReport
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

  // 0. 输入文件安全审计与指纹记录（防范大模型代码越权篡改原输入文件）
  interface MonitoredFile {
    filepath: string
    originalSha256: string
    snapshotPath: string
  }
  const monitoredFiles: MonitoredFile[] = []

  // 扫描 params 中所有指向本地现有文件的输入参数
  for (const [, val] of Object.entries(params)) {
    if (typeof val === 'string' && val.trim().length > 0) {
      try {
        const resolvedPath = resolve(val.trim())
        if (existsSync(resolvedPath) && statSync(resolvedPath).isFile()) {
          const originalSha256 = createHash('sha256').update(readFileSync(resolvedPath)).digest('hex')
          // 在 outputDir 中创建一份执行期快照，用作自愈回滚镜像
          const snapshotPath = join(outputDir, `.safety_snapshot_${randomUUID()}_${basename(resolvedPath)}`)
          copyFileSync(resolvedPath, snapshotPath)
          monitoredFiles.push({
            filepath: resolvedPath,
            originalSha256,
            snapshotPath,
          })
        }
      } catch {
        // 忽略非文件参数
      }
    }
  }

  // 1. 参数落盘为 input.json（彻底避开操作系统的环境变量长度上限 E2BIG）
  const inputJsonPath = join(outputDir, 'input.json')
  writeFileSync(inputJsonPath, JSON.stringify(params, null, 2), 'utf-8')

  // 2. 写入脚本前导代码：优先从 input.json 文件读取，同时兼容环境变量
  const preamble = `
import os, sys, json, warnings
warnings.filterwarnings('ignore', category=DeprecationWarning)
warnings.filterwarnings('ignore', category=FutureWarning)
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
        PYTHONWARNINGS: process.env.PYTHONWARNINGS || 'ignore::DeprecationWarning',
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

    // 5. 退出处理、安全审计与产物扫描
    pyProcess.on('close', async (code) => {
      if (!isFinished) {
        isFinished = true
        clearTimeout(timer)
        try { unlinkSync(scriptPath) } catch {}

        // flush 解码器尾部残留字节
        stdoutBuffer += stdoutDecoder.end()
        stderrBuffer += stderrDecoder.end()

        // ── 5.1 篡改审计与紧急自动回滚自愈 ──
        let hasTampering = false
        let tamperErrorMessage = ''
        for (const m of monitoredFiles) {
          try {
            if (existsSync(m.filepath)) {
              const currentSha256 = createHash('sha256').update(readFileSync(m.filepath)).digest('hex')
              if (currentSha256 !== m.originalSha256) {
                hasTampering = true
                // 立即执行秒级自动还原
                copyFileSync(m.snapshotPath, m.filepath)
                tamperErrorMessage += `\n❌ [安全隔离警报] 检测到 Python 代码非法修改了原始输入文件:「${basename(m.filepath)}」！\n系统已触发紧急熔断，并自动从安全备份中秒级恢复了原文件。\n【系统禁令】：大模型生成的脚本严禁在输入原路径上执行覆盖写入！所有处理结果必须写入到系统分配的 OUTPUT_DIR 目录下（如 os.path.join(OUTPUT_DIR, "result.xlsx")）。请修正代码中直接回写原文件的逻辑后重试。`
              }
            }
          } catch (err: any) {
            console.error(`核验/还原原文件失败: ${err.message}`)
          }
        }

        if (hasTampering) {
          stderrBuffer = (stderrBuffer + '\n' + tamperErrorMessage).trim()
        }

        const isSuccess = code === 0 && !hasTampering
        const primaryInputPath = monitoredFiles[0]?.filepath

        // ── 5.2 扫描实际产物，并对首批 Excel 产物自动提取前 N 行快速预览与出厂质检 ──
        const outputFiles: OutputFileInfo[] = []
        if (existsSync(outputDir)) {
          for (const fname of readdirSync(outputDir)) {
            // 排除 input.json、隐藏快照及临时文件，只识别实际产物
            if (!fname.startsWith('.') && fname !== 'input.json') {
              const filepath = join(outputDir, fname)
              let preview: OutputFilePreview | undefined = undefined
              let validation: WorkbookValidationReport | undefined = undefined
              const ext = extname(fname).toLowerCase()
              if (isSuccess && (ext === '.xlsx' || ext === '.csv')) {
                try {
                  const inspection = await inspectExcel(filepath, pythonPath)
                  preview = {
                    sheets: inspection.sheets,
                    activeSheet: inspection.activeSheet,
                    rowCount: inspection.rowCount,
                    columnCount: inspection.columnCount,
                    headers: inspection.headers,
                    sampleRows: inspection.sampleRows,
                  }
                } catch {
                  // 容错：解析预览失败不阻断产物下载
                }

                try {
                  validation = await validateWorkbook(filepath, primaryInputPath, pythonPath)
                } catch {
                  // 容错：质检异常不阻断产物下载
                }
              }

              outputFiles.push({
                filename: fname,
                filepath,
                preview,
                validation,
              })
            }
          }
        }

        if (opts.isPreflight) {
          try { rmSync(outputDir, { recursive: true, force: true }) } catch {}
        }

        resolve({
          success: isSuccess,
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

const DIFF_SCRIPT_PATH = resolve(fileURLToPath(import.meta.url), '../diff_excel.py')

/** 对比生成产物与预期标杆文件，出具对账/契约 DiffReport */
export async function compareExcelFiles(
  outputPath: string,
  benchmarkPath: string,
  pythonPath = process.env.PYTHON_PATH ?? DEFAULT_PYTHON_CMD,
  mode: 'auto' | 'template' | 'ground_truth' = 'auto',
): Promise<import('@excel-harness/shared').DiffReport> {
  const args = [DIFF_SCRIPT_PATH, outputPath, benchmarkPath, `--mode=${mode}`]
  const { stdout, stderr } = await execFileAsync(pythonPath, args, {
    timeout: 30_000,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  })

  if (!stdout.trim()) {
    throw new Error(stderr || 'Diff 对比脚本未产生输出')
  }

  const res = JSON.parse(stdout)
  if (!res.success) {
    throw new Error(res.error || 'Excel 对账对比失败')
  }

  return res as import('@excel-harness/shared').DiffReport
}

const VALIDATOR_SCRIPT_PATH = resolve(fileURLToPath(import.meta.url), '../validator.py')

/**
 * 运行出厂回读质检器 (validate_workbook)
 * 100% 本地纯代码运行，绝不调用任何外部模型或网络 API
 */
export async function validateWorkbook(
  outputPath: string,
  inputPath?: string,
  pythonPath = process.env.PYTHON_PATH ?? DEFAULT_PYTHON_CMD,
): Promise<WorkbookValidationReport> {
  const args = [VALIDATOR_SCRIPT_PATH, outputPath]
  if (inputPath && existsSync(inputPath)) {
    args.push(inputPath)
  }

  const { stdout, stderr } = await execFileAsync(pythonPath, args, {
    timeout: 30_000,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  })

  if (!stdout.trim()) {
    throw new Error(stderr || '质检器未产生任何输出')
  }

  const res = JSON.parse(stdout)
  if (!res.success) {
    throw new Error(res.error || '工作簿质检失败')
  }

  return res.data as WorkbookValidationReport
}

