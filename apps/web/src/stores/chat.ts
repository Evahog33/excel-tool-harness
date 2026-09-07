import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import axios from 'axios'

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  createdAt: number
}

export interface UiField {
  name: string
  label: string
  type: 'text' | 'number' | 'file' | 'select' | 'checkbox'
  required?: boolean
  options?: string[]
  accept?: string
  description?: string
}

export interface UiSchema {
  title: string
  fields: UiField[]
}

export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: Message[]
  uiSchema?: UiSchema
  pythonCode?: string
}

export const useChatStore = defineStore('chat', () => {
  const sessions = ref<Session[]>([])
  const currentSessionId = ref<string | null>(null)
  const isStreaming = ref(false)
  const streamingText = ref('')
  const uiSchema = ref<UiSchema | null>(null)
  const pythonCode = ref<string | null>(null)
  const runResult = ref<{ success: boolean; stdout: string; stderr: string } | null>(null)

  const currentSession = computed(() =>
    sessions.value.find((s) => s.id === currentSessionId.value) ?? null,
  )

  /** 加载所有会话 */
  async function loadSessions() {
    const { data } = await axios.get('/api/sessions')
    sessions.value = data.sessions
    if (sessions.value.length > 0 && !currentSessionId.value) {
      await selectSession(sessions.value[0].id)
    }
  }

  /** 创建新会话 */
  async function createSession() {
    const { data } = await axios.post('/api/sessions', { title: '新会话' })
    sessions.value.unshift(data.session)
    await selectSession(data.session.id)
  }

  /** 切换会话 */
  async function selectSession(id: string) {
    currentSessionId.value = id
    const { data } = await axios.get(`/api/sessions/${id}`)
    const idx = sessions.value.findIndex((s) => s.id === id)
    if (idx >= 0) sessions.value[idx] = data.session

    // 加载最新资产
    const { data: assets } = await axios.get(`/api/sessions/${id}/assets`)
    uiSchema.value = assets.uiSchema
    pythonCode.value = assets.pythonCode
    runResult.value = null
  }

  /** 发送消息（SSE 流式） */
  async function sendMessage(message: string) {
    if (!currentSessionId.value || isStreaming.value) return

    isStreaming.value = true
    streamingText.value = ''

    // 乐观更新：先在本地追加用户消息
    const session = sessions.value.find((s) => s.id === currentSessionId.value)
    if (session) {
      session.messages.push({
        id: Date.now().toString(),
        role: 'user',
        content: message,
        createdAt: Date.now(),
      })
    }

    try {
      const response = await fetch(`/api/sessions/${currentSessionId.value}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      })

      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let assistantMsg = ''
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const payload = JSON.parse(line.slice(6))
              if (payload.text !== undefined) {
                assistantMsg += payload.text
                streamingText.value = assistantMsg
              }
              if (payload.uiSchema !== undefined) {
                uiSchema.value = payload.uiSchema
              }
              if (payload.pythonCode !== undefined) {
                pythonCode.value = payload.pythonCode
              }
            } catch {}
          }
        }
      }

      // 追加完整的 assistant 消息
      if (session && assistantMsg) {
        session.messages.push({
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: assistantMsg,
          createdAt: Date.now(),
        })
      }
    } finally {
      streamingText.value = ''
      isStreaming.value = false
    }
  }

  /** 执行 Python 脚本（沙箱触发） */
  async function runScript(params: Record<string, string>) {
    if (!currentSessionId.value) return
    runResult.value = null
    const { data } = await axios.post(`/api/sessions/${currentSessionId.value}/run`, { params })
    runResult.value = data
  }

  return {
    sessions,
    currentSessionId,
    currentSession,
    isStreaming,
    streamingText,
    uiSchema,
    pythonCode,
    runResult,
    loadSessions,
    createSession,
    selectSession,
    sendMessage,
    runScript,
  }
})
