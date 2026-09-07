import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { AgentLoop } from '../index.ts'
import type { Session } from '@excel-harness/shared'

describe('Agent Loop 历史自愈与孤儿 tool_calls 防御', () => {
  test('自动清洗未闭合的孤儿 tool_calls，防止 DeepSeek 400 报错', () => {
    const ctx = new Context()
    const loop = new AgentLoop(ctx, {})

    const corruptedSession: Session = {
      id: 'test-session-orphan',
      title: '测试会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          content: '请帮我写一个 Excel 处理工具',
          createdAt: 1000,
        },
        {
          id: 'msg-2',
          role: 'assistant',
          content: '好的，正在为您生成工具...',
          toolCalls: [
            {
              id: 'call_orphan_123',
              name: 'generate_excel_tool',
              arguments: '{"python_code": "print(1)"}',
            },
          ],
          createdAt: 2000,
        },
        // 注意：这里缺少了与 call_orphan_123 对应的 role: 'tool' 消息（因用户点击停止生成或异常中断）
        {
          id: 'msg-3',
          role: 'user',
          content: '继续处理',
          createdAt: 3000,
        },
      ],
    }

    const history = (loop as any)._buildHistory(corruptedSession)

    // 检查装配给 LLM 的历史
    // 1. 系统提示词
    assert.equal(history[0].role, 'system')

    // 2. 第一条 user 消息
    assert.equal(history[1].role, 'user')
    assert.equal(history[1].content, '请帮我写一个 Excel 处理工具')

    // 3. 第二条 assistant 消息应被自愈清洗：保留文本回复，但孤儿 tool_calls 必须被剔除！
    assert.equal(history[2].role, 'assistant')
    assert.equal(history[2].content, '好的，正在为您生成工具...')
    assert.equal(history[2].tool_calls, undefined)

    // 4. 第三条 user 消息
    assert.equal(history[3].role, 'user')
    assert.equal(history[3].content, '继续处理')
  })

  test('正常配对的 tool_calls 和 tool 响应予以保留', () => {
    const ctx = new Context()
    const loop = new AgentLoop(ctx, {})

    const validSession: Session = {
      id: 'test-session-valid',
      title: '测试会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          content: '需求',
          createdAt: 1000,
        },
        {
          id: 'msg-2',
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'call_valid_456',
              name: 'generate_excel_tool',
              arguments: '{}',
            },
          ],
          createdAt: 2000,
        },
        {
          id: 'msg-3',
          role: 'tool',
          content: '{"status":"success"}',
          toolCallId: 'call_valid_456',
          toolName: 'generate_excel_tool',
          createdAt: 2500,
        },
        {
          id: 'msg-4',
          role: 'user',
          content: '下一步',
          createdAt: 3000,
        },
      ],
    }

    const history = (loop as any)._buildHistory(validSession)
    assert.equal(history[1].role, 'user')
    assert.equal(history[2].role, 'assistant')
    assert.equal(history[2].tool_calls?.length, 1)
    assert.equal(history[2].tool_calls[0].id, 'call_valid_456')
    assert.equal(history[3].role, 'tool')
    assert.equal(history[3].tool_call_id, 'call_valid_456')
    assert.equal(history[4].role, 'user')
  })
})
