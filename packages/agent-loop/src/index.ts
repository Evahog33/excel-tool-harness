/**
 * @excel-harness/agent-loop
 * Agent 驱动主循环 —— 参考 dsh core/agent-loop 设计
 * 流程: 用户输入 → 组装 Prompt → LLM 流式输出 → 解析 Tool Call → 执行工具 → 继续循环
 */

import { Context, Service } from 'cordis'
import type { LlmService } from '@excel-harness/llm'
import type { SessionService, SessionMessage, Session, ExcelMeta } from '@excel-harness/session'
import type { ToolRegistry } from '@excel-harness/tools'
import type { ChatCompletionMessageParam, ChatCompletionChunk } from 'openai/resources'

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

export interface AgentRunOptions {
  sessionId: string
  userMessage: string
  /** 流式输出回调，每收到 token 时触发 */
  onChunk?: (chunk: string) => void
  /** 推理/思考流式输出回调 */
  onReasoningChunk?: (chunk: string) => void
  /** 工具执行完成回调 */
  onToolResult?: (toolName: string, result: string) => void
  /** 可选的中断信号 */
  signal?: AbortSignal
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
  private runningControllers = new Map<string, AbortController>()

  constructor(ctx: Context, config: AgentLoopConfig) {
    super(ctx, 'agentLoop')
    this.maxSteps = config.maxSteps ?? 10
    this.systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
  }

  /**
   * 中止指定会话中正在运行的 Agent 任务
   */
  abort(sessionId: string): boolean {
    const controller = this.runningControllers.get(sessionId)
    if (controller) {
      controller.abort()
      this.runningControllers.delete(sessionId)
      this.ctx.logger('agent-loop').info(`会话 ${sessionId} 任务已手动中止`)
      return true
    }
    return false
  }

  /**
   * 运行一次 Agent 交互：接收用户消息，驱动 LLM + 工具调用，直到得到最终回答
   */
  async run(opts: AgentRunOptions): Promise<void> {
    const { sessionId, userMessage, onChunk, onReasoningChunk, onToolResult } = opts
    const logger = this.ctx.logger('agent-loop')

    // 绑定内部 AbortController
    const controller = new AbortController()
    this.runningControllers.set(sessionId, controller)

    // 若传入了外部 signal，则监听联动
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => controller.abort())
    }

    const signal = controller.signal

    try {
      const existingSession = this.ctx.sessions.get(sessionId)
      const lastMsg = existingSession?.messages[existingSession.messages.length - 1]
      // 避免重复追加相同的最后一条用户消息
      if (!lastMsg || lastMsg.role !== 'user' || lastMsg.content !== userMessage) {
        this.ctx.sessions.appendMessage(sessionId, {
          role: 'user',
          content: userMessage,
        })
      }

      // 2. 构建历史消息
      const session = this.ctx.sessions.get(sessionId)!
      const history = this._buildHistory(session)

      // 3. 获取已注册工具的 schema
      const toolSchemas = this.ctx.tools.getOpenAIToolSchemas()

      // 4. 进入 Agent 步骤循环
      let steps = 0
      while (steps < this.maxSteps) {
        if (signal.aborted) {
          logger.info(`会话 ${sessionId} 收到中止信号，退出 Agent 循环`)
          break
        }

        steps++
        logger.debug(`Step ${steps}/${this.maxSteps}`)

        this.ctx.emit('agent/step-start', { sessionId, step: steps })

        // 5. 调用 LLM（流式）
        const { assistantContent, toolCalls } = await this._streamLlm(
          history,
          toolSchemas,
          onChunk,
          onReasoningChunk,
          signal,
        )

        if (signal.aborted) {
          logger.info(`会话 ${sessionId} 流式生成过程中被中止`)
          break
        }

        // 6. 将 Assistant 消息追加到会话
        this.ctx.sessions.appendMessage(sessionId, {
          role: 'assistant',
          content: assistantContent,
          toolCalls: toolCalls.length
            ? toolCalls.map((tc) => ({
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments,
              }))
            : undefined,
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
          if (signal.aborted) break

          logger.info(`执行工具: ${tc.function.name}`)
          let argsJson = tc.function.arguments
          try {
            const parsed = JSON.parse(argsJson)
            if (!parsed.session_id) {
              parsed.session_id = sessionId
              argsJson = JSON.stringify(parsed)
            }
          } catch {}

          const result = await this.ctx.tools.execute(tc.id, tc.function.name, argsJson)
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
    } finally {
      this.runningControllers.delete(sessionId)
    }
  }

  // ─── 私有方法 ────────────────────────────────────────────────────────────────

  private _buildHistory(session: Session): ChatCompletionMessageParam[] {
    const history: ChatCompletionMessageParam[] = [
      { role: 'system', content: this.systemPrompt },
    ]

    // 若当前会话挂载了 Excel 文件，注入结构化脱敏数据源说明与样本
    const excelFiles = session.excelFiles?.length ? session.excelFiles : (session.excelMeta ? [session.excelMeta] : [])
    if (excelFiles.length > 0) {
      history.push({
        role: 'system',
        content: this._formatExcelFilesContext(excelFiles),
      })
    }

    for (const msg of session.messages) {
      if (msg.role === 'user') {
        const last = history[history.length - 1]
        if (last && last.role === 'user') {
          // 合并连续 user 消息，避免部分模型因连续 user 消息抛错
          last.content = `${last.content}\n${msg.content}`
        } else {
          history.push({ role: 'user', content: msg.content })
        }
      } else if (msg.role === 'assistant') {
        const hasToolCalls = Boolean(msg.toolCalls && msg.toolCalls.length > 0)
        history.push({
          role: 'assistant',
          content: msg.content || null,
          tool_calls: hasToolCalls
            ? msg.toolCalls!.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: tc.arguments },
              }))
            : undefined,
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

  private _formatExcelFilesContext(files: ExcelMeta[]): string {
    const lines: string[] = []
    lines.push(`## 用户当前已挂载并脱敏的 Excel 数据源上下文（共 ${files.length} 个文件）`)

    files.forEach((meta, idx) => {
      lines.push(`\n### 数据源 ${idx + 1}: ${meta.filename}`)
      lines.push(`- 文件路径: ${meta.filepath}`)
      lines.push(`- 工作表: ${meta.activeSheet} (包含工作表: ${meta.sheets.join(', ')})`)
      lines.push(`- 数据规模: 约 ${meta.rowCount} 行数据，${meta.columnCount} 列`)
      lines.push(`- 表头层级: ${meta.headerLevels} 层表头结构 (数据起始行: 第 ${meta.dataStartRow} 行)`)

      lines.push(`- 列结构与隐私脱敏说明:`)
      const rulesMap = new Map((meta.desensitizationRules ?? []).map((r) => [r.column, r]))
      for (const col of meta.headers) {
        const r = rulesMap.get(col)
        if (r && r.enabled) {
          let ruleDesc = '已脱敏处理'
          if (r.ruleType === 'id_card_mask') ruleDesc = '18位身份证脱敏 (保留前6后4位及18位格式，确认为身份证)'
          else if (r.ruleType === 'phone_mask') ruleDesc = '11位手机号脱敏 (保留前3后4位，中间4位掩码)'
          else if (r.ruleType === 'name_mask') ruleDesc = '姓名脱敏 (保留姓氏)'
          else if (r.ruleType === 'email_mask') ruleDesc = '电子邮箱脱敏 (保留首字母与真实域名)'
          else if (r.ruleType === 'bank_card_mask') ruleDesc = '银行卡号脱敏 (保留前4后4位)'
          else if (r.ruleType === 'amount_mask') ruleDesc = '薪资/金额脱敏 (保留数量级)'
          else if (r.ruleType === 'exclude') ruleDesc = '此列已被安全剔除'

          lines.push(`  * 列「${col}」: 【${ruleDesc}】`)
        } else {
          lines.push(`  * 列「${col}」: 未脱敏 (正常业务字段)`)
        }
      }

      const samples = meta.sanitizedSamples?.slice(0, 5) || meta.sampleRows.slice(0, 5)
      if (samples.length > 0) {
        lines.push(`- 样例数据 (前 ${samples.length} 行真实结构脱敏样本):`)
        lines.push('| ' + meta.headers.join(' | ') + ' |')
        lines.push('| ' + meta.headers.map(() => '---').join(' | ') + ' |')
        for (const s of samples) {
          lines.push('| ' + meta.headers.map((h) => String(s[h] ?? '').replace(/\n/g, ' ')).join(' | ') + ' |')
        }
      }
    })

    lines.push(`\n重要指引：`)
    lines.push(`1. 当存在多个 Excel 文件时，用户需求通常涉及多表关联（如基于工号、姓名或 ID 等主键进行 pd.merge / VLOOKUP 匹配关联）、跨表计算或拼接。`)
    lines.push(`2. 编写 Python 脚本时必须使用上述真实列名与多层表头结构。`)
    lines.push(`3. 可在 Python 中通过上述文件的真实本地路径直接加载，也可在 UI Schema 中为每个文件设计参数输入项。`)
    lines.push(`4. 右侧沙箱执行时，Python 将在用户本地沙箱对完整原始数据运行，输出保存到 OUTPUT_DIR。`)
    return lines.join('\n')
  }

  private async _streamLlm(
    history: ChatCompletionMessageParam[],
    toolSchemas: ReturnType<ToolRegistry['getOpenAIToolSchemas']>,
    onChunk?: (chunk: string) => void,
    onReasoningChunk?: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<{ assistantContent: string; toolCalls: ParsedToolCall[] }> {
    let assistantContent = ''
    const toolCallAccumulator = new Map<number, ParsedToolCall>()

    for await (const chunk of this.ctx.llm.stream(history, toolSchemas, signal)) {
      if (signal?.aborted) break
      const delta = chunk.choices[0]?.delta
      if (!delta) continue

      // 累积推理/思考内容（如 Qwen, DeepSeek 等模型）
      const reasoning = (delta as any).reasoning_content
      if (reasoning) {
        onReasoningChunk?.(reasoning)
      }

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
当用户描述 Excel 处理需求时，你必须调用 \`generate_excel_tool\` 工具来生成自动化处理工具。

【规范要求】：
1. UI Schema（工具运行态表单）：
   - 必须在 fields 最顶部，为每一个需要处理的输入文件配置独立的 "file" 类型槽位：
     例如：
     {"name": "input_file_1", "label": "待处理员工信息表", "type": "file", "accept": ".xlsx,.xls", "required": true, "description": "包含工号、姓名、组别的 Excel 文件"},
     {"name": "input_file_2", "label": "待处理员工薪资表", "type": "file", "accept": ".xlsx,.xls", "required": true, "description": "包含工号、工资的 Excel 文件"}
   - 紧接着配置从用户对话中提炼出的业务参数（如排序字段 select、升降序 checkbox、输出文件名 text、阈值筛选 number 等）。

2. Python 代码（数据清洗与处理脚本）：
   - 必须通过 PARAMS 获取文件路径，若用户未传则兜底使用上下文中的已挂载真实路径：
     file1 = PARAMS.get('input_file_1') or '<当前挂载文件1真实路径>'
     file2 = PARAMS.get('input_file_2') or '<当前挂载文件2真实路径>'
   - 必须使用真实复合列名进行合并（如 pd.merge(df1, df2, on='工号', how='inner')）。
   - 处理结果必须保存到系统注入的 OUTPUT_DIR 目录下：
     output_filename = PARAMS.get('output_filename', '处理结果') + '.xlsx'
     output_path = os.path.join(OUTPUT_DIR, output_filename)
     df_result.to_excel(output_path, index=False)
   - 打印清晰的处理统计信息到控制台（stdout），便于用户了解执行进度。

3. 自动化预检与自愈闭环（Self-Correction Loop）：
   - 当你调用 \`generate_excel_tool\` 时，系统会自动在后台沙箱中用当前挂载的真实 Excel 数据执行预检测试。
   - 【严禁在预检失败时放弃】：如果工具返回 \`{"status": "error"}\`，代表测试运行失败抛出了 Python 异常。**你绝对不允许向用户汇报错误或停止调用**！你必须把报错视为内部测试失败，立即深入分析错误 Traceback（重点检查列名拼写、缺失列、合并键、类型转换、空值、除零等问题），修正 Python 代码后**在当前轮次内立即再次调用 \`generate_excel_tool\`**！
   - 重复修正直至返回 \`{"status": "success"}\` 为止。
   - 只有在预检成功（\`status: "success"\`）后，方可向用户输出简短总结与使用说明。`

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
