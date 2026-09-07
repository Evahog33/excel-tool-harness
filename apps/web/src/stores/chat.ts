import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import axios from 'axios'

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  createdAt: number
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
  options?: (string | UiFieldOption)[]
  default?: any
  accept?: string
  description?: string
}

export interface UiSchema {
  title: string
  fields: UiField[]
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
  messages: Message[]
  excelMeta?: ExcelMeta
  excelFiles?: ExcelMeta[]
  uiSchema?: UiSchema
  pythonCode?: string
}

export const useChatStore = defineStore('chat', () => {
  const sessions = ref<Session[]>([])
  const currentSessionId = ref<string | null>(null)
  const isStreaming = ref(false)
  const streamingText = ref('')
  const reasoningText = ref('')
  const uiSchema = ref<UiSchema | null>(null)
  const pythonCode = ref<string | null>(null)
  const excelFiles = ref<ExcelMeta[]>([])
  const excelMeta = computed(() => excelFiles.value[0] || null)
  const isUploadingExcel = ref(false)
  const runResult = ref<{
    success: boolean
    stdout: string
    stderr: string
    durationMs?: number
    outputFiles?: { filename: string; filepath: string }[]
  } | null>(null)

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

  /** 删除会话 */
  async function deleteSession(id: string) {
    await axios.delete(`/api/sessions/${id}`)
    sessions.value = sessions.value.filter((s) => s.id !== id)
    if (currentSessionId.value === id) {
      if (sessions.value.length > 0) {
        await selectSession(sessions.value[0].id)
      } else {
        currentSessionId.value = null
        uiSchema.value = null
        pythonCode.value = null
        excelFiles.value = []
        runResult.value = null
      }
    }
  }

  /** 切换会话 */
  async function selectSession(id: string) {
    currentSessionId.value = id
    const { data } = await axios.get(`/api/sessions/${id}`)
    const idx = sessions.value.findIndex((s) => s.id === id)
    if (idx >= 0) sessions.value[idx] = data.session

    // 加载最新资产与 Excel 元数据列表
    const { data: assets } = await axios.get(`/api/sessions/${id}/assets`)
    uiSchema.value = assets.uiSchema
    pythonCode.value = assets.pythonCode
    excelFiles.value = assets.excelFiles || (assets.excelMeta ? [assets.excelMeta] : []) || data.session?.excelFiles || (data.session?.excelMeta ? [data.session.excelMeta] : [])
    runResult.value = null
  }

  /** 上传一个或多个 Excel 文件并智能解析 */
  async function uploadExcel(files: File | File[]): Promise<ExcelMeta[]> {
    if (!currentSessionId.value) throw new Error('未选择会话')
    isUploadingExcel.value = true
    try {
      const formData = new FormData()
      const fileList = Array.isArray(files) ? files : [files]
      for (const file of fileList) {
        formData.append('file', file)
      }
      const { data } = await axios.post(`/api/sessions/${currentSessionId.value}/upload-excel`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      if (!data.ok) throw new Error(data.error || '上传失败')
      excelFiles.value = data.excelFiles || []
      if (currentSession.value) {
        currentSession.value.excelFiles = data.excelFiles
        currentSession.value.excelMeta = data.excelFiles?.[0]
      }
      return data.newFiles || data.excelFiles || []
    } finally {
      isUploadingExcel.value = false
    }
  }

  /** 保存指定文件的脱敏规则配置 */
  async function saveDesensitizeConfig(fileId: string, rules: DesensitizationRuleConfig[]): Promise<ExcelMeta> {
    if (!currentSessionId.value) throw new Error('未选择会话')
    const { data } = await axios.post(`/api/sessions/${currentSessionId.value}/excel/${fileId}/desensitize-config`, { rules })
    if (!data.ok) throw new Error(data.error || '保存脱敏配置失败')
    excelFiles.value = data.excelFiles || []
    if (currentSession.value) {
      currentSession.value.excelFiles = data.excelFiles
      currentSession.value.excelMeta = data.excelFiles?.[0]
    }
    return data.excelMeta
  }

  /** 移除指定单个 Excel 文件 */
  async function removeExcelFile(fileId: string): Promise<void> {
    if (!currentSessionId.value) return
    const { data } = await axios.delete(`/api/sessions/${currentSessionId.value}/excel/${fileId}`)
    excelFiles.value = data.excelFiles || []
    if (currentSession.value) {
      currentSession.value.excelFiles = data.excelFiles
      currentSession.value.excelMeta = data.excelFiles?.[0]
    }
  }

  /** 移除所有 Excel 文件挂载 */
  async function removeExcel(): Promise<void> {
    if (!currentSessionId.value) return
    await axios.delete(`/api/sessions/${currentSessionId.value}/excel`)
    excelFiles.value = []
    if (currentSession.value) {
      currentSession.value.excelFiles = []
      currentSession.value.excelMeta = undefined
    }
  }

  let activeAbortController: AbortController | null = null
  const wasAborted = ref(false)

  /** 发送消息（SSE 流式） */
  async function sendMessage(message: string) {
    if (!currentSessionId.value || isStreaming.value) return

    isStreaming.value = true
    streamingText.value = ''
    reasoningText.value = ''
    wasAborted.value = false
    activeAbortController = new AbortController()

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
        signal: activeAbortController.signal,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error || `HTTP ${response.status}`)
      }

      const reader = response.body?.getReader()
      if (!reader) return
      const decoder = new TextDecoder()
      let assistantMsg = ''
      let buffer = ''
      const handleLine = (line: string) => {
        const trimmed = line.trim()
        if (!trimmed) {
          currentEvent = 'message'
          return
        }
        if (trimmed.startsWith('event: ')) {
          currentEvent = trimmed.slice(7).trim()
          return
        }
        if (trimmed.startsWith('data: ')) {
          try {
            const payload = JSON.parse(trimmed.slice(6))
            if (currentEvent === 'error') {
              const errMsg = payload.message || payload.error || '执行出错'
              assistantMsg = `⚠️ 出错: ${errMsg}`
              streamingText.value = assistantMsg
            } else if (currentEvent === 'reasoning') {
              if (payload.text !== undefined) {
                reasoningText.value += payload.text
              }
            } else if (currentEvent === 'chunk' || payload.text !== undefined) {
              assistantMsg += payload.text
              streamingText.value = assistantMsg
            }
            if (payload.uiSchema !== undefined) {
              uiSchema.value = payload.uiSchema
            }
            if (payload.pythonCode !== undefined) {
              pythonCode.value = payload.pythonCode
            }
            if (payload.session && session) {
              session.messages = payload.session.messages
            }
          } catch {}
        }
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          if (buffer.trim()) {
            handleLine(buffer)
            buffer = ''
          }
          break
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          handleLine(line)
        }
      }

      // 如果未收到 session 全量同步但收到了 assistantMsg，兜底追加
      if (session && assistantMsg && !session.messages.some((m) => m.content === assistantMsg)) {
        session.messages.push({
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: assistantMsg,
          createdAt: Date.now(),
        })
      }
    } catch (e: any) {
      if (e.name === 'AbortError') {
        wasAborted.value = true
      } else {
        console.error('SSE chat error:', e)
        if (session && !session.messages.some((m) => m.content.startsWith('⚠️'))) {
          session.messages.push({
            id: (Date.now() + 1).toString(),
            role: 'assistant',
            content: `⚠️ 发送失败: ${e.message}`,
            createdAt: Date.now(),
          })
        }
      }
    } finally {
      // 权威同步：先刷新当前会话全部最新状态（确保最新回答与资产落盘生效），再关闭流式状态
      if (currentSessionId.value) {
        try {
          await selectSession(currentSessionId.value)
        } catch (err) {
          console.error('Failed to sync session after chat:', err)
        }
      }
      streamingText.value = ''
      reasoningText.value = ''
      isStreaming.value = false
      activeAbortController = null
    }
  }

  /** 手动停止生成 */
  async function stopGeneration() {
    if (activeAbortController) {
      activeAbortController.abort()
      activeAbortController = null
    }
    if (currentSessionId.value) {
      try {
        await axios.post(`/api/sessions/${currentSessionId.value}/abort`)
      } catch {}
    }
    wasAborted.value = true
    isStreaming.value = false
    streamingText.value = ''
    reasoningText.value = ''
  }

  /** 撤回最后一条用户输入并填回输入框 */
  async function popLastMessage(): Promise<string | null> {
    if (!currentSessionId.value) return null
    try {
      const { data } = await axios.post(`/api/sessions/${currentSessionId.value}/pop-message`)
      if (data.ok) {
        // 同步前端会话中的 messages
        const session = sessions.value.find((s) => s.id === currentSessionId.value)
        if (session && data.session) {
          session.messages = data.session.messages
        }
        wasAborted.value = false
        return data.content ?? null
      }
    } catch (err) {
      console.error('Failed to pop last message:', err)
    }
    return null
  }

  /** 表单运行时上传新待处理文件 */
  async function uploadRuntimeFile(file: File): Promise<{ filepath: string; filename: string }> {
    if (!currentSessionId.value) throw new Error('未选择会话')
    const formData = new FormData()
    formData.append('file', file)
    const { data } = await axios.post(`/api/sessions/${currentSessionId.value}/form-upload`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    if (!data.ok) throw new Error(data.error || '文件上传失败')
    return { filepath: data.filepath, filename: data.filename }
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
    reasoningText,
    uiSchema,
    pythonCode,
    excelMeta,
    excelFiles,
    isUploadingExcel,
    runResult,
    loadSessions,
    createSession,
    deleteSession,
    selectSession,
    uploadExcel,
    saveDesensitizeConfig,
    removeExcelFile,
    removeExcel,
    sendMessage,
    stopGeneration,
    popLastMessage,
    wasAborted,
    uploadRuntimeFile,
    runScript,
  }
})
