/**
 * @excel-harness/session
 * 会话管理服务 —— 负责创建、读取、持久化会话（对话历史）
 * 参考 dsh 的 append-only session log 设计
 */

import { Context, Service } from 'cordis'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, rmSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'tool'

export interface SessionMessage {
  id: string
  role: MessageRole
  content: string
  /** 工具调用时使用 */
  toolCalls?: ToolCall[]
  /** 工具结果时使用 */
  toolCallId?: string
  toolName?: string
  createdAt: number
}

export interface ToolCall {
  id: string
  name: string
  arguments: string // JSON string
}

export interface DesensitizationRuleConfig {
  column: string
  enabled: boolean
  ruleType: 'id_card_mask' | 'phone_mask' | 'name_mask' | 'email_mask' | 'bank_card_mask' | 'amount_mask' | 'exclude'
  label: string
}

export interface SensitiveColumnInfo {
  column: string
  type: string
  rule: string
  label: string
  reason: string
  desc: string
}

export interface ExcelMeta {
  fileId: string
  filename: string
  filepath: string
  fileSizeBytes: number
  uploadedAt: number
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
  sensitiveColumns: SensitiveColumnInfo[]
  desensitizationRules?: DesensitizationRuleConfig[]
  sanitizedSamples?: Record<string, any>[]
}

export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: SessionMessage[]
  /** 挂载的 Excel 数据源及其脱敏元数据（旧版单文件兼容） */
  excelMeta?: ExcelMeta
  /** 挂载的多个 Excel 数据源列表 */
  excelFiles?: ExcelMeta[]
  /** 右侧沙箱最新的 UI Schema（JSON Schema 驱动表单） */
  uiSchema?: UiSchema
  /** 最新生成的 Python 脚本 */
  pythonCode?: string
}

export interface UiSchema {
  title: string
  fields: UiField[]
}

export interface UiFieldOption {
  label: string
  value: string
}

export interface UiField {
  name: string
  label: string
  type: 'text' | 'number' | 'file' | 'select' | 'checkbox'
  required?: boolean
  options?: (string | UiFieldOption)[]  // for select
  default?: any
  accept?: string     // for file, e.g. '.xlsx,.xls'
  description?: string
}

export interface SessionServiceConfig {
  sessionDir?: string
}

// ─── 服务实现 ─────────────────────────────────────────────────────────────────

export class SessionService extends Service<SessionServiceConfig> {
  static [Service.provide] = 'sessions'

  private sessionDir: string
  private cache = new Map<string, Session>()

  constructor(ctx: Context, config: SessionServiceConfig) {
    super(ctx, 'sessions')
    this.sessionDir = config.sessionDir ?? '.sessions'
    this._ensureDir()
    this._loadAll()
    ctx.logger('session').info(`会话服务已初始化，存储目录: ${this.sessionDir}`)
  }

  /** 创建新会话 */
  create(title = '新会话'): Session {
    const session: Session = {
      id: randomUUID(),
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    }
    this.cache.set(session.id, session)
    this._persist(session)
    this.ctx.emit('session/created', session)
    return session
  }

  /** 获取会话 */
  get(id: string): Session | undefined {
    return this.cache.get(id)
  }

  /** 列出所有会话（按更新时间倒序） */
  list(): Session[] {
    return [...this.cache.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 删除会话及其磁盘持久化文件与上传目录 */
  delete(id: string): boolean {
    const session = this.cache.get(id)
    if (!session) return false

    this.cache.delete(id)

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

    // 自动从第一条用户消息生成标题
    if (session.messages.length === 1 && msg.role === 'user') {
      session.title = msg.content.slice(0, 30) + (msg.content.length > 30 ? '…' : '')
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

  /** 移除指定的 Excel 文件 */
  removeExcelFile(sessionId: string, fileId: string): ExcelMeta[] {
    const session = this.cache.get(sessionId)
    if (!session) throw new Error(`会话不存在: ${sessionId}`)
    if (!session.excelFiles) {
      session.excelFiles = session.excelMeta ? [session.excelMeta] : []
    }
    session.excelFiles = session.excelFiles.filter((f) => f.fileId !== fileId)
    session.excelMeta = session.excelFiles[0] || undefined
    session.updatedAt = Date.now()
    this._persist(session)
    this.ctx.emit('session/excel-meta-updated', { sessionId, excelMeta: session.excelMeta, excelFiles: session.excelFiles } as any)
    return session.excelFiles
  }

  /** 清空会话的所有 Excel 文件 */
  clearExcelFiles(sessionId: string): void {
    const session = this.cache.get(sessionId)
    if (!session) throw new Error(`会话不存在: ${sessionId}`)
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

  // ─── 私有方法 ───────────────────────────────────────────────────────────────

  private _ensureDir() {
    if (!existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true })
    }
  }

  private _persist(session: Session) {
    const path = join(this.sessionDir, `${session.id}.json`)
    writeFileSync(path, JSON.stringify(session, null, 2), 'utf-8')
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
    'session/created': (session: import('./index.ts').Session) => void
    'session/message': (data: { sessionId: string; message: import('./index.ts').SessionMessage }) => void
    'session/assets-updated': (data: { sessionId: string; uiSchema?: import('./index.ts').UiSchema; pythonCode?: string }) => void
    'session/excel-meta-updated': (data: { sessionId: string; excelMeta?: import('./index.ts').ExcelMeta; excelFiles?: import('./index.ts').ExcelMeta[] }) => void
    'session/messages-truncated': (data: { sessionId: string; remainingCount: number }) => void
    'session/deleted': (data: { sessionId: string }) => void
  }
}
