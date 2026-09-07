/**
 * @excel-harness/tools
 * 工具注册表 —— 参考 dsh ctx.tools 设计
 * 插件通过 ctx.tools.register() 注册工具，Agent Loop 通过 ctx.tools.execute() 调用
 */

import { Context, Service } from 'cordis'
import { z } from 'zod'

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  description: string
  enum?: string[]
  required?: boolean
  properties?: Record<string, ToolParameter>
  items?: ToolParameter
}

export interface ToolDefinition<TInput = Record<string, unknown>> {
  name: string
  description: string
  parameters: Record<string, ToolParameter>
  /** 执行函数 */
  execute: (input: TInput, ctx: Context) => Promise<string>
}

export interface ToolResult {
  toolCallId: string
  toolName: string
  output: string
  error?: string
  durationMs: number
}

// ─── 工具注册表服务 ───────────────────────────────────────────────────────────

export class ToolRegistry extends Service {
  static [Service.provide] = 'tools'

  private tools = new Map<string, ToolDefinition>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
    ctx.logger('tools').info('工具注册表已初始化')
  }

  /** 注册工具 */
  register<T extends Record<string, unknown>>(tool: ToolDefinition<T>) {
    this.tools.set(tool.name, tool as ToolDefinition)
    this.ctx.logger('tools').debug(`已注册工具: ${tool.name}`)
  }

  /** 注销工具 */
  unregister(name: string) {
    this.tools.delete(name)
  }

  /** 获取所有工具的 OpenAI Function Calling 格式 schema */
  getOpenAIToolSchemas() {
    return [...this.tools.values()].map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(tool.parameters).map(([key, param]) => [
              key,
              {
                type: param.type,
                description: param.description,
                ...(param.enum ? { enum: param.enum } : {}),
                ...(param.properties ? { properties: param.properties } : {}),
              },
            ]),
          ),
          required: Object.entries(tool.parameters)
            .filter(([, p]) => p.required !== false)
            .map(([key]) => key),
        },
      },
    }))
  }

  /** 执行工具调用 */
  async execute(
    toolCallId: string,
    toolName: string,
    argsJson: string,
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolName)
    const start = Date.now()

    if (!tool) {
      return {
        toolCallId,
        toolName,
        output: '',
        error: `未知工具: ${toolName}`,
        durationMs: 0,
      }
    }

    try {
      const input = JSON.parse(argsJson)
      this.ctx.emit('tools/before-execute', { toolCallId, toolName, input })
      const output = await tool.execute(input, this.ctx)
      const durationMs = Date.now() - start
      this.ctx.emit('tools/after-execute', { toolCallId, toolName, output, durationMs })
      return { toolCallId, toolName, output, durationMs }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      return { toolCallId, toolName, output: '', error, durationMs: Date.now() - start }
    }
  }

  /** 列出已注册工具名 */
  list(): string[] {
    return [...this.tools.keys()]
  }
}

export function apply(ctx: Context) {
  ctx.plugin(ToolRegistry)
}

declare module 'cordis' {
  interface Context {
    tools: ToolRegistry
  }
  interface Events {
    'tools/before-execute': (data: { toolCallId: string; toolName: string; input: unknown }) => void
    'tools/after-execute': (data: { toolCallId: string; toolName: string; output: string; durationMs: number }) => void
  }
}
