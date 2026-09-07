/**
 * @excel-harness/agent-loop
 * Agent 驱动主循环 —— 参考 dsh core/agent-loop 设计
 * 流程: 用户输入 → 组装 Prompt → LLM 流式输出 → 解析 Tool Call → 执行工具 → 继续循环
 */

import { Context, Service } from 'cordis'
import type { LlmService } from '@excel-harness/llm'
import type { SessionService, SessionMessage } from '@excel-harness/session'
import type { ToolRegistry } from '@excel-harness/tools'
import type { ChatCompletionMessageParam, ChatCompletionChunk } from 'openai/resources'

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

export interface AgentRunOptions {
  sessionId: string
  userMessage: string
  /** 流式输出回调，每收到 token 时触发 */
  onChunk?: (chunk: string) => void
  /** 工具执行完成回调 */
  onToolResult?: (toolName: string, result: string) => void
}

export interface AgentLoopConfig {
  /** 最大连续工具调用轮数，防止无限循环 */
  maxSteps?: number
  /** 系统提示词 */
  systemPrompt?: string
}

// ─── Agent Loop 服务 ──────────────────────────────────────────────────────────

export class AgentLoop extends Service<AgentLoopConfig> {
  static [Service.provide] = 'agentLoop'
  static inject = ['llm', 'sessions', 'tools']

  private maxSteps: number
  private systemPrompt: string

  constructor(ctx: Context, config: AgentLoopConfig) {
    super(ctx, 'agentLoop')
    this.maxSteps = config.maxSteps ?? 10
    this.systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
  }

  /**
   * 运行一次 Agent 交互：接收用户消息，驱动 LLM + 工具调用，直到得到最终回答
   */
  async run(opts: AgentRunOptions): Promise<void> {
    const { sessionId, userMessage, onChunk, onToolResult } = opts
    const logger = this.ctx.logger('agent-loop')

    // 1. 追加用户消息到会话
    this.ctx.sessions.appendMessage(sessionId, {
      role: 'user',
      content: userMessage,
    })

    // 2. 构建历史消息
    const session = this.ctx.sessions.get(sessionId)!
    const history = this._buildHistory(session.messages)

    // 3. 获取已注册工具的 schema
    const toolSchemas = this.ctx.tools.getOpenAIToolSchemas()

    // 4. 进入 Agent 步骤循环
    let steps = 0
    while (steps < this.maxSteps) {
      steps++
      logger.debug(`Step ${steps}/${this.maxSteps}`)

      this.ctx.emit('agent/step-start', { sessionId, step: steps })

      // 5. 调用 LLM（流式）
      const { assistantContent, toolCalls } = await this._streamLlm(
        history,
        toolSchemas,
        onChunk,
      )

      // 6. 将 Assistant 消息追加到会话
      const assistantMsg = this.ctx.sessions.appendMessage(sessionId, {
        role: 'assistant',
        content: assistantContent,
        toolCalls: toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        })),
      })

      // 将 assistant 消息加入本轮历史
      history.push({
        role: 'assistant',
        content: assistantContent || null,
        tool_calls: toolCalls.length
          ? toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.function.name, arguments: tc.function.arguments },
            }))
          : undefined,
      })

      // 7. 若无工具调用，本轮结束
      if (toolCalls.length === 0) {
        this.ctx.emit('agent/turn-end', { sessionId })
        break
      }

      // 8. 执行所有工具调用
      for (const tc of toolCalls) {
        logger.info(`执行工具: ${tc.function.name}`)
        const result = await this.ctx.tools.execute(tc.id, tc.function.name, tc.function.arguments)
        const output = result.error ? `错误: ${result.error}` : result.output

        onToolResult?.(tc.function.name, output)

        // 追加 tool result 消息到会话
        this.ctx.sessions.appendMessage(sessionId, {
          role: 'tool',
          content: output,
          toolCallId: tc.id,
          toolName: tc.function.name,
        })

        // 加入本轮历史
        history.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: output,
        })
      }
    }

    if (steps >= this.maxSteps) {
      logger.warn(`已达到最大步骤数 ${this.maxSteps}，强制结束`)
    }
  }

  // ─── 私有方法 ────────────────────────────────────────────────────────────────

  private _buildHistory(messages: SessionMessage[]): ChatCompletionMessageParam[] {
    const history: ChatCompletionMessageParam[] = [
      { role: 'system', content: this.systemPrompt },
    ]

    for (const msg of messages) {
      if (msg.role === 'user') {
        history.push({ role: 'user', content: msg.content })
      } else if (msg.role === 'assistant') {
        history.push({
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.toolCalls?.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        })
      } else if (msg.role === 'tool') {
        history.push({
          role: 'tool',
          tool_call_id: msg.toolCallId!,
          content: msg.content,
        })
      }
    }
    return history
  }

  private async _streamLlm(
    history: ChatCompletionMessageParam[],
    toolSchemas: ReturnType<ToolRegistry['getOpenAIToolSchemas']>,
    onChunk?: (chunk: string) => void,
  ): Promise<{ assistantContent: string; toolCalls: ParsedToolCall[] }> {
    let assistantContent = ''
    const toolCallAccumulator = new Map<number, ParsedToolCall>()

    for await (const chunk of this.ctx.llm.stream(history, toolSchemas)) {
      const delta = chunk.choices[0]?.delta
      if (!delta) continue

      // 累积文本内容
      if (delta.content) {
        assistantContent += delta.content
        onChunk?.(delta.content)
      }

      // 累积工具调用（OpenAI 流式 tool_calls 是分片的）
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCallAccumulator.has(tc.index)) {
            toolCallAccumulator.set(tc.index, {
              id: '',
              function: { name: '', arguments: '' },
            })
          }
          const existing = toolCallAccumulator.get(tc.index)!
          if (tc.id) existing.id += tc.id
          if (tc.function?.name) existing.function.name += tc.function.name
          if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
        }
      }
    }

    return {
      assistantContent,
      toolCalls: [...toolCallAccumulator.values()],
    }
  }
}

interface ParsedToolCall {
  id: string
  function: { name: string; arguments: string }
}

const DEFAULT_SYSTEM_PROMPT = `你是一个专业的 Excel 数据处理专家。
当用户描述 Excel 处理需求时，你必须调用 \`generate_excel_tool\` 工具来生成处理方案。
你生成的方案包含两部分：
1. Python 代码：基于 pandas/openpyxl 的数据处理脚本
2. UI Schema：描述用户需要填写的参数表单（JSON 格式）

生成完成后，向用户确认方案并说明如何在右侧沙箱中使用。`

export function apply(ctx: Context, config: AgentLoopConfig = {}) {
  ctx.plugin(AgentLoop, config)
}

declare module 'cordis' {
  interface Context {
    agentLoop: AgentLoop
  }
  interface Events {
    'agent/step-start': (data: { sessionId: string; step: number }) => void
    'agent/turn-end': (data: { sessionId: string }) => void
  }
}
