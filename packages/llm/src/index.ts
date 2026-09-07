/**
 * @excel-harness/llm
 * LLM 服务插件 —— 封装对 DeepSeek (OpenAI-兼容) API 的调用
 */

import { Context, Service } from 'cordis'
import OpenAI from 'openai'
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources'

export interface LlmConfig {
  apiKey: string
  baseURL?: string
  model?: string
}

// ─── 服务定义 ────────────────────────────────────────────────────────────────

export class LlmService extends Service {
  static [Service.provide] = 'llm'
  static [Service.immediate] = true

  private client: OpenAI
  public readonly model: string

  constructor(ctx: Context, config: LlmConfig) {
    super(ctx, 'llm')
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL ?? 'https://api.deepseek.com/v1',
    })
    this.model = config.model ?? 'deepseek-chat'
    ctx.logger('llm').info(`LLM 服务已初始化，模型: ${this.model}`)
  }

  /** 流式调用，逐 chunk yield */
  async *stream(
    messages: ChatCompletionMessageParam[],
    tools?: ChatCompletionTool[],
  ) {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      tools: tools?.length ? tools : undefined,
      tool_choice: tools?.length ? 'auto' : undefined,
      stream: true,
    })
    for await (const chunk of response) {
      yield chunk
    }
  }

  /** 非流式调用 */
  async complete(
    messages: ChatCompletionMessageParam[],
    tools?: ChatCompletionTool[],
  ) {
    return this.client.chat.completions.create({
      model: this.model,
      messages,
      tools: tools?.length ? tools : undefined,
      tool_choice: tools?.length ? 'auto' : undefined,
      stream: false,
    })
  }
}

// ─── 插件入口（不要设置 apply.Config，直接透传 config） ──────────────────────

export function apply(ctx: Context, config: LlmConfig) {
  ctx.plugin(LlmService, config)
}

// ─── Context 类型扩展 ─────────────────────────────────────────────────────────

declare module 'cordis' {
  interface Context {
    llm: LlmService
  }
}
