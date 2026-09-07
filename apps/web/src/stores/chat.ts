import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import axios from 'axios'
import type {
  SessionMessage,
  UiFieldOption,
  UiField,
  UiSchema,
  DesensitizationRuleConfig,
  SensitiveColumnInfo,
  ExcelMeta,
  Session as SharedSession,
  OutputFileMeta,
  ToolExecutionResult,
  ToolRunParams,
  FormFieldValue,
} from '@excel-harness/shared'

export type Message = SessionMessage
export type {
  UiFieldOption,
  UiField,
  UiSchema,
  DesensitizationRuleConfig,
  SensitiveColumnInfo,
  ExcelMeta,
  OutputFileMeta,
  ToolExecutionResult,
  ToolRunParams,
  FormFieldValue,
}

export type Session = SharedSession

export const useChatStore = defineStore('chat', () => {
  const sessions = ref<Session[]>([])
  const currentSessionId = ref<string | null>(null)
  const isStreaming = ref(false)
  const isRunningScript = ref(false)
  const streamingText = ref('')
  const reasoningText = ref('')
  const uiSchema = ref<UiSchema | null>(null)
  const pythonCode = ref<string | null>(null)
  const excelFiles = ref<ExcelMeta[]>([])
  const excelMeta = computed(() => excelFiles.value[0] || null)
  const isUploadingExcel = ref(false)
  const runResult = ref<ToolExecutionResult | null>(null)

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

  /** 选中会话，加载资产与元数据 */
  async function selectSession(id: string) {
    currentSessionId.value = id
    runResult.value = null

    // 优先从 sessions 列表中获取本地已有数据
    const session = sessions.value.find((s) => s.id === id)
    if (session) {
      uiSchema.value = session.uiSchema ?? null
      pythonCode.value = session.pythonCode ?? null
      excelFiles.value = session.excelFiles || (session.excelMeta ? [session.excelMeta] : [])
    }

    // 后台拉取最新资产全量同步
    try {
      const { data } = await axios.get(`/api/sessions/${id}/assets`)
      uiSchema.value = data.uiSchema
      pythonCode.value = data.pythonCode
      if (data.excelFiles && Array.isArray(data.excelFiles)) {
        excelFiles.value = data.excelFiles
      } else if (data.excelMeta) {
        excelFiles.value = [data.excelMeta]
      } else {
        excelFiles.value = []
      }
    } catch {}
  }

  /** 上传一个或多个 Excel 文件到当前会话 */
  async function uploadExcel(files: File[]): Promise<{
    ok: boolean
    newFiles: ExcelMeta[]
    excelFiles: ExcelMeta[]
    excelMeta?: ExcelMeta
  } | undefined> {
    if (!currentSessionId.value) return
    isUploadingExcel.value = true
    try {
      const formData = new FormData()
      for (const file of files) {
        formData.append('file', file)
      }
      const { data } = await axios.post(
        `/api/sessions/${currentSessionId.value}/upload-excel`,
        formData,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      )
      if (data.ok) {
        if (data.excelFiles) {
          excelFiles.value = data.excelFiles
        }
        const session = sessions.value.find((s) => s.id === currentSessionId.value)
        if (session) {
          session.excelFiles = excelFiles.value
          session.excelMeta = excelFiles.value[0] || undefined
        }
      }
      return data
    } finally {
      isUploadingExcel.value = false
    }
  }

  /** 保存指定 Excel 文件的脱敏规则配置 */
  async function saveDesensitizeConfig(fileId: string, rules: DesensitizationRuleConfig[]) {
    if (!currentSessionId.value) return
    const { data } = await axios.post(
      `/api/sessions/${currentSessionId.value}/excel/${fileId}/desensitize-config`,
      { rules },
    )
    if (data.ok) {
      if (data.excelFiles) {
        excelFiles.value = data.excelFiles
      }
      const session = sessions.value.find((s) => s.id === currentSessionId.value)
      if (session) {
        session.excelFiles = excelFiles.value
        session.excelMeta = excelFiles.value[0] || undefined
      }
    }
    return data
  }

  /** 从当前会话移除指定的 Excel 文件 */
  async function removeExcelFile(fileId: string) {
    if (!currentSessionId.value) return
    const { data } = await axios.delete(
      `/api/sessions/${currentSessionId.value}/excel/${fileId}`,
    )
    if (data.ok) {
      excelFiles.value = data.excelFiles || []
      const session = sessions.value.find((s) => s.id === currentSessionId.value)
      if (session) {
        session.excelFiles = excelFiles.value
        session.excelMeta = excelFiles.value[0] || undefined
      }
    }
    return data
  }

  /** 清空当前会话挂载的所有 Excel 文件 */
  async function removeExcel() {
    if (!currentSessionId.value) return
    const { data } = await axios.delete(`/api/sessions/${currentSessionId.value}/excel`)
    if (data.ok) {
      excelFiles.value = []
      const session = sessions.value.find((s) => s.id === currentSessionId.value)
      if (session) {
        session.excelFiles = []
        session.excelMeta = undefined
      }
    }
    return data
  }

  let activeAbortController: AbortController | null = null
  const wasAborted = ref(false)

  /** 发送消息，通过 fetch 处理 SSE 流式响应 */
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
      let currentEvent = 'message' // 补全声明，防止严格模式下未声明变量报错

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
      // 权威同步：先刷新当前会话全部最新状态，再关闭流式状态
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
  async function runScript(params: ToolRunParams) {
    if (!currentSessionId.value) return
    isRunningScript.value = true
    runResult.value = null
    try {
      const { data } = await axios.post(`/api/sessions/${currentSessionId.value}/run`, { params })
      runResult.value = data
    } finally {
      isRunningScript.value = false
    }
  }

  return {
    sessions,
    currentSessionId,
    currentSession,
    isStreaming,
    isRunningScript,
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
