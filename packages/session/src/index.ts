/**
 * @excel-harness/session
 * 会话管理服务 —— 负责创建、读取、持久化会话（对话历史）
 * 参考 dsh 的 append-only session log 设计
 */

import { Context, Service } from 'cordis'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
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

export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: SessionMessage[]
  /** 右侧沙箱最新的 UI Schema（JSON Schema 驱动表单） */
  uiSchema?: UiSchema
  /** 最新生成的 Python 脚本 */
  pythonCode?: string
}

export interface UiSchema {
  title: string
  fields: UiField[]
}

export interface UiField {
  name: string
  label: string
  type: 'text' | 'number' | 'file' | 'select' | 'checkbox'
  required?: boolean
  options?: string[]  // for select
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
  }
}
