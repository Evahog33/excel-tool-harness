/**
 * @excel-harness/session
 * 会话管理服务 —— 负责创建、读取、持久化会话（对话历史）
 * 参考 dsh 的 append-only session log 设计
 */

import { Context, Service } from 'cordis'
import { readFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, rmSync, promises as fsPromises } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type {
  MessageRole,
  ToolCall,
  SessionMessage,
  DesensitizationRuleConfig,
  SensitiveColumnInfo,
  ExcelMeta,
  Session,
  UiSchema,
  UiFieldOption,
  UiField,
} from '@excel-harness/shared'

export * from '@excel-harness/shared'

export interface SessionServiceConfig {
  sessionDir?: string
}

// ─── 服务实现 ─────────────────────────────────────────────────────────────────

export class SessionService extends Service<SessionServiceConfig> {
  static [Service.provide] = 'sessions'

  private sessionDir: string
  private cache = new Map<string, Session>()
  private writeQueues = new Map<string, Promise<void>>()

  constructor(ctx: Context, config: SessionServiceConfig = {}) {
    super(ctx, 'sessions')
    this.sessionDir = config.sessionDir ?? join(process.cwd(), '.sessions')
    this._ensureDir()
    this._loadAll()
  }

  /** 创建新会话 */
  create(title = '新对话'): Session {
    const now = Date.now()
    const session: Session = {
      id: randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
    }
    this.cache.set(session.id, session)
    this._persist(session)
    this.ctx.emit('session/created', session)
    return session
  }

  /** 获取会话，若不存在返回 undefined */
  get(id: string): Session | undefined {
    return this.cache.get(id)
  }

  /** 获取所有会话列表（按最后更新时间倒序） */
  list(): Session[] {
    return [...this.cache.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 删除会话及其磁盘持久化文件与上传目录 */
  delete(id: string): boolean {
    const session = this.cache.get(id)
    if (!session) return false

    this.cache.delete(id)
    this.writeQueues.delete(id)

    // 删除 session json 文件
    const jsonPath = join(this.sessionDir, `${id}.json`)
    if (existsSync(jsonPath)) {
      try { unlinkSync(jsonPath) } catch {}
    }

    // 删除 session 目录（如果存在上传文件目录等）
    const dirPath = join(this.sessionDir, id)
    if (existsSync(dirPath)) {
      try { rmSync(dirPath, { recursive: true, force: true }) } catch {}
    }

    this.ctx.emit('session/deleted', { sessionId: id })
    return true
  }

  /** 向会话追加一条消息 */
  appendMessage(sessionId: string, msg: Omit<SessionMessage, 'id' | 'createdAt'>): SessionMessage {
    const session = this.cache.get(sessionId)
    if (!session) throw new Error(`会话不存在: ${sessionId}`)

    const fullMsg: SessionMessage = {
      ...msg,
      id: randomUUID(),
      createdAt: Date.now(),
    }
    session.messages.push(fullMsg)
    session.updatedAt = Date.now()

    // 自动从第一条用户消息生成标题（去除多余换行和空格，更友好地截取）
    if (session.messages.length === 1 && msg.role === 'user') {
      const cleanContent = msg.content.replace(/\s+/g, ' ').trim()
      session.title = cleanContent.slice(0, 30) + (cleanContent.length > 30 ? '…' : '') || '新对话'
    }

    this._persist(session)
    this.ctx.emit('session/message', { sessionId, message: fullMsg })
    return fullMsg
  }

  /**
   * 弹出或撤回最后一条用户输入（包括它之后的所有中间生成/工具消息）
   * 用于用户点击“修改”按钮后，把最后一条用户消息填回输入框并在会话中撤销该轮对话
   */
  popLastUserMessage(sessionId: string): string | null {
    const session = this.cache.get(sessionId)
    if (!session || session.messages.length === 0) return null

    // 找到最后一条 user 消息的索引
    let lastUserIdx = -1
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i].role === 'user') {
        lastUserIdx = i
        break
      }
    }

    if (lastUserIdx === -1) return null

    const userMessageContent = session.messages[lastUserIdx].content
    // 移除从该用户消息开始及之后产生的所有消息（包括 tool / assistant 消息）
    session.messages.splice(lastUserIdx)
    session.updatedAt = Date.now()

    this._persist(session)
    this.ctx.emit('session/messages-truncated', { sessionId, remainingCount: session.messages.length })
    return userMessageContent
  }

  /** 更新会话的 UI Schema 和 Python 代码 */
  updateAssets(sessionId: string, assets: { uiSchema?: UiSchema; pythonCode?: string }) {
    const session = this.cache.get(sessionId)
    if (!session) throw new Error(`会话不存在: ${sessionId}`)
    if (assets.uiSchema) session.uiSchema = assets.uiSchema
    if (assets.pythonCode) session.pythonCode = assets.pythonCode
    session.updatedAt = Date.now()
    this._persist(session)
    this.ctx.emit('session/assets-updated', { sessionId, ...assets })
  }

  /** 获取会话挂载的所有 Excel 文件元数据 */
  getExcelFiles(sessionId: string): ExcelMeta[] {
    const session = this.cache.get(sessionId)
    if (!session) return []
    if (session.excelFiles && session.excelFiles.length > 0) {
      return session.excelFiles
    }
    if (session.excelMeta) {
      return [session.excelMeta]
    }
    return []
  }

  /** 向会话批量添加 Excel 文件 */
  addExcelFiles(sessionId: string, metas: ExcelMeta[]): ExcelMeta[] {
    const session = this.cache.get(sessionId)
    if (!session) throw new Error(`会话不存在: ${sessionId}`)
    if (!session.excelFiles) {
      session.excelFiles = session.excelMeta ? [session.excelMeta] : []
    }
    session.excelFiles.push(...metas)
    session.excelMeta = session.excelFiles[0]
    session.updatedAt = Date.now()
    this._persist(session)
    this.ctx.emit('session/excel-meta-updated', { sessionId, excelMeta: session.excelMeta, excelFiles: session.excelFiles } as any)
    return session.excelFiles
  }

  /** 更新指定 Excel 文件的脱敏规则与元数据 */
  updateExcelFile(sessionId: string, fileId: string, updates: Partial<ExcelMeta>): ExcelMeta[] {
    const session = this.cache.get(sessionId)
    if (!session) throw new Error(`会话不存在: ${sessionId}`)
    if (!session.excelFiles) {
      session.excelFiles = session.excelMeta ? [session.excelMeta] : []
    }
    const idx = session.excelFiles.findIndex((f) => f.fileId === fileId)
    if (idx >= 0) {
      session.excelFiles[idx] = { ...session.excelFiles[idx], ...updates }
    } else if (session.excelMeta?.fileId === fileId) {
      session.excelMeta = { ...session.excelMeta, ...updates }
      session.excelFiles = [session.excelMeta]
    }
    session.excelMeta = session.excelFiles[0]
    session.updatedAt = Date.now()
    this._persist(session)
    this.ctx.emit('session/excel-meta-updated', { sessionId, excelMeta: session.excelMeta, excelFiles: session.excelFiles } as any)
    return session.excelFiles
  }

  /** 移除指定的 Excel 文件并清理磁盘物理文件 */
  removeExcelFile(sessionId: string, fileId: string): ExcelMeta[] {
    const session = this.cache.get(sessionId)
    if (!session) throw new Error(`会话不存在: ${sessionId}`)
    if (!session.excelFiles) {
      session.excelFiles = session.excelMeta ? [session.excelMeta] : []
    }

    const target = session.excelFiles.find((f) => f.fileId === fileId)
    if (target && target.filepath && existsSync(target.filepath)) {
      try { unlinkSync(target.filepath) } catch {}
    }

    session.excelFiles = session.excelFiles.filter((f) => f.fileId !== fileId)
    session.excelMeta = session.excelFiles[0] || undefined
    session.updatedAt = Date.now()
    this._persist(session)
    this.ctx.emit('session/excel-meta-updated', { sessionId, excelMeta: session.excelMeta, excelFiles: session.excelFiles } as any)
    return session.excelFiles
  }

  /** 清空会话的所有 Excel 文件并清理磁盘物理文件 */
  clearExcelFiles(sessionId: string): void {
    const session = this.cache.get(sessionId)
    if (!session) throw new Error(`会话不存在: ${sessionId}`)
    const filesToClean = session.excelFiles || (session.excelMeta ? [session.excelMeta] : [])
    for (const f of filesToClean) {
      if (f.filepath && existsSync(f.filepath)) {
        try { unlinkSync(f.filepath) } catch {}
      }
    }
    session.excelFiles = []
    session.excelMeta = undefined
    session.updatedAt = Date.now()
    this._persist(session)
    this.ctx.emit('session/excel-meta-updated', { sessionId, excelMeta: undefined, excelFiles: [] } as any)
  }

  /** 更新或移除会话关联的 Excel 元数据与脱敏配置（单文件兼容） */
  updateExcelMeta(sessionId: string, excelMeta?: ExcelMeta) {
    const session = this.cache.get(sessionId)
    if (!session) throw new Error(`会话不存在: ${sessionId}`)
    session.excelMeta = excelMeta
    session.excelFiles = excelMeta ? [excelMeta] : []
    session.updatedAt = Date.now()
    this._persist(session)
    this.ctx.emit('session/excel-meta-updated', { sessionId, excelMeta, excelFiles: session.excelFiles } as any)
  }

  /** 获取会话挂载的预期标杆文件 */
  getBenchmarkFile(sessionId: string): ExcelMeta | undefined {
    const session = this.cache.get(sessionId)
    return session?.benchmarkFile
  }

  /** 设置或更新会话的预期标杆文件 */
  setBenchmarkFile(sessionId: string, benchmarkMeta?: ExcelMeta): ExcelMeta | undefined {
    const session = this.cache.get(sessionId)
    if (!session) throw new Error(`会话不存在: ${sessionId}`)
    session.benchmarkFile = benchmarkMeta
    session.updatedAt = Date.now()
    this._persist(session)
    this.ctx.emit('session/benchmark-updated', { sessionId, benchmarkFile: benchmarkMeta })
    return session.benchmarkFile
  }

  /** 修改已挂载标杆文件的角色模式 (template 或 ground_truth) */
  setBenchmarkRole(sessionId: string, role: 'template' | 'ground_truth'): ExcelMeta {
    const session = this.cache.get(sessionId)
    if (!session) throw new Error(`会话不存在: ${sessionId}`)
    if (!session.benchmarkFile) throw new Error('当前会话尚未挂载样表或标杆文件')
    session.benchmarkFile.benchmarkRole = role
    session.updatedAt = Date.now()
    this._persist(session)
    this.ctx.emit('session/benchmark-updated', { sessionId, benchmarkFile: session.benchmarkFile })
    return session.benchmarkFile
  }

  /** 清除会话的预期标杆文件并删除物理文件 */
  clearBenchmarkFile(sessionId: string): void {
    const session = this.cache.get(sessionId)
    if (!session) throw new Error(`会话不存在: ${sessionId}`)
    if (session.benchmarkFile?.filepath && existsSync(session.benchmarkFile.filepath)) {
      try { unlinkSync(session.benchmarkFile.filepath) } catch {}
    }
    session.benchmarkFile = undefined
    session.updatedAt = Date.now()
    this._persist(session)
    this.ctx.emit('session/benchmark-updated', { sessionId, benchmarkFile: undefined })
  }

  // ─── 私有方法 ───────────────────────────────────────────────────────────────

  private _ensureDir() {
    if (!existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true })
    }
  }

  private _persist(session: Session) {
    const path = join(this.sessionDir, `${session.id}.json`)
    const data = JSON.stringify(session, null, 2)
    const currentQueue = this.writeQueues.get(session.id) || Promise.resolve()
    const nextWrite = currentQueue
      .then(() => fsPromises.writeFile(path, data, 'utf-8'))
      .catch((err) => {
        this.ctx.logger('session').warn(`持久化会话失败 [${session.id}]:`, err)
      })
    this.writeQueues.set(session.id, nextWrite)
  }

  private _loadAll() {
    if (!existsSync(this.sessionDir)) return
    for (const file of readdirSync(this.sessionDir)) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = readFileSync(join(this.sessionDir, file), 'utf-8')
        const session: Session = JSON.parse(raw)
        if (!session.excelFiles && session.excelMeta) {
          session.excelFiles = [session.excelMeta]
        }
        this.cache.set(session.id, session)
      } catch {
        // 忽略损坏的文件
      }
    }
  }
}

// ─── 插件入口 ────────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: SessionServiceConfig = {}) {
  ctx.plugin(SessionService, config)
}

// ─── Context 类型扩展 ─────────────────────────────────────────────────────────

declare module 'cordis' {
  interface Context {
    sessions: SessionService
  }
  interface Events {
    'session/created': (session: Session) => void
    'session/message': (data: { sessionId: string; message: SessionMessage }) => void
    'session/assets-updated': (data: { sessionId: string; uiSchema?: UiSchema; pythonCode?: string }) => void
    'session/excel-meta-updated': (data: { sessionId: string; excelMeta?: ExcelMeta; excelFiles?: ExcelMeta[] }) => void
    'session/messages-truncated': (data: { sessionId: string; remainingCount: number }) => void
    'session/benchmark-updated': (data: { sessionId: string; benchmarkFile?: ExcelMeta }) => void
    'session/deleted': (data: { sessionId: string }) => void
  }
}
