<template>
  <div class="chat-panel">
    <!-- 顶部数据工作台：挂载 Excel 与脱敏配置 -->
    <DataDock v-if="store.currentSession" />

    <!-- 消息列表 -->
    <div class="messages" ref="messagesEl">
      <div v-if="!store.currentSession" class="empty-state">
        <p>👈 选择或创建一个会话开始使用</p>
      </div>
      <template v-else>
        <template
          v-for="msg in displayMessages"
          :key="msg.id"
        >
          <!-- 工具执行反馈（优雅胶囊展示，替代大段 JSON 刷屏） -->
          <div v-if="msg.role === 'tool'" class="message message--tool">
            <div class="message-role">🔧 工具预检</div>
            <div class="tool-summary-card">
              <span class="tool-icon">⚙️</span>
              <span class="tool-text">{{ formatToolSummary(msg.content) }}</span>
            </div>
          </div>

          <!-- 普通对话消息 (用户 / 助手) -->
          <div
            v-else
            :class="['message', `message--${msg.role}`]"
          >
            <div class="message-role">{{ roleLabel(msg.role) }}</div>
            <div class="message-content" v-html="renderContent(msg.content)"></div>
          </div>
        </template>
        <!-- 流式输出中 -->
        <div v-if="store.isStreaming" class="message message--assistant">
          <div class="message-role">🤖 助手</div>
          <!-- 思考过程卡片 (若模型输出思考流) -->
          <div v-if="store.reasoningText && !store.streamingText" class="thinking-card">
            <div class="thinking-header">
              <span class="pulse-indicator"></span>
              <span class="thinking-title">深度思考中...</span>
            </div>
            <div class="thinking-body">{{ store.reasoningText }}</div>
          </div>
          <!-- 正在思考提示 (等待首 token 或执行工具沙箱中) -->
          <div v-else-if="!store.streamingText" class="message-content thinking">
            <span class="pulse-indicator"></span>
            <span>正在思考<span class="dots">...</span></span>
          </div>
          <!-- 正式回答正文 -->
          <div v-if="store.streamingText" class="message-content">
            {{ store.streamingText }}<span class="cursor">▌</span>
          </div>
        </div>

        <!-- 停止生成后或最后一条对话操作栏：修改并重新编辑按钮 (类似 Antigravity) -->
        <div v-if="canEditLastMessage" class="last-msg-actions">
          <button class="btn-modify-prompt" @click="handleEditLastMessage" title="将此轮提问填回输入框并重新编辑">
            <svg class="icon-edit" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            <span>修改并重新输入</span>
          </button>
        </div>
      </template>
    </div>

    <!-- 输入区 -->
    <div class="input-area">
      <textarea
        ref="inputBoxEl"
        v-model="input"
        class="input-box"
        placeholder="描述你的 Excel 处理需求，例如：帮我写一个工具，把 Excel 中的手机号列脱敏处理... (Enter 发送，Shift + Enter 换行)"
        :disabled="store.isStreaming || !store.currentSession"
        @keydown="handleKeydown"
        rows="3"
      />
      <!-- 未在生成中：发送按钮 -->
      <button
        v-if="!store.isStreaming"
        class="btn-send"
        :disabled="!input.trim() || !store.currentSession"
        @click="submit"
      >
        发送 ↵
      </button>
      <!-- 正在生成中：停止生成按钮 -->
      <button
        v-else
        class="btn-stop"
        @click="handleStop"
        title="停止当前生成"
      >
        <span class="stop-square">■</span> 停止
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed, nextTick } from 'vue'
import { useChatStore } from '../stores/chat'
import DataDock from './DataDock.vue'

const store = useChatStore()
const input = ref('')
const messagesEl = ref<HTMLElement>()
const inputBoxEl = ref<HTMLTextAreaElement>()

// 是否显示“修改”按钮：仅在用户手动停止生成（或被中断）后，且会话中有 user 消息时显示
const canEditLastMessage = computed(() => {
  if (store.isStreaming) return false
  if (!store.wasAborted) return false
  const msgs = store.currentSession?.messages
  return Boolean(msgs && msgs.some((m) => m.role === 'user'))
})

async function handleStop() {
  await store.stopGeneration()
}

async function handleEditLastMessage() {
  const content = await store.popLastMessage()
  if (content !== null) {
    input.value = content
    await nextTick()
    inputBoxEl.value?.focus()
    // 光标移动到文本末尾
    if (inputBoxEl.value) {
      inputBoxEl.value.selectionStart = inputBoxEl.value.selectionEnd = input.value.length
    }
  }
}

function handleKeydown(e: KeyboardEvent) {
  // 中文输入法正在拼音上屏过程中，按回车不上屏提交
  if (e.isComposing) return

  if (e.key === 'Enter') {
    if (e.shiftKey) {
      // Shift + Enter: 保持原生换行行为，不拦截
      return
    }
    // 单独 Enter: 阻止换行并触发发送
    e.preventDefault()
    submit()
  }
}

async function submit() {
  const msg = input.value.trim()
  if (!msg || store.isStreaming) return
  input.value = ''
  await store.sendMessage(msg)
}

const displayMessages = computed(() => {
  const msgs = store.currentSession?.messages || []
  return msgs.filter((m) => {
    // 过滤掉只有 toolCalls 没有实际文本内容的空 assistant 消息
    if (m.role === 'assistant' && !m.content?.trim()) return false
    return true
  })
})

function formatToolSummary(content: string) {
  try {
    const data = JSON.parse(content)
    return data.message || data.status || '工具预检已完成'
  } catch {
    return content.slice(0, 120)
  }
}

function roleLabel(role: string) {
  return role === 'user' ? '👤 你' : role === 'tool' ? '🔧 工具' : '🤖 助手'
}

function renderContent(content?: string | null) {
  if (!content) return ''
  // 简单转义 + 换行处理
  return content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
}

// 自动滚动到底部
watch(
  () => [store.currentSession?.messages.length, store.streamingText, store.reasoningText, store.isStreaming],
  async () => {
    await nextTick()
    messagesEl.value?.scrollTo({ top: messagesEl.value.scrollHeight, behavior: 'smooth' })
  },
)
</script>

<style scoped>
.chat-panel { display: flex; flex-direction: column; height: 100%; background: #fff; }
.messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 16px; }
.empty-state { display: flex; align-items: center; justify-content: center; height: 100%; color: #999; font-size: 15px; }
.message { max-width: 85%; }
.message--user { align-self: flex-end; }
.message--assistant, .message--tool { align-self: flex-start; }
.message-role { font-size: 11px; color: #888; margin-bottom: 4px; }
.message-content {
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.message--user .message-content { background: #4f46e5; color: #fff; border-radius: 12px 12px 2px 12px; }
.message--assistant .message-content { background: #f3f4f6; color: #111; border-radius: 12px 12px 12px 2px; }
.message--tool .message-content { background: #fef9c3; color: #713f12; font-family: monospace; font-size: 12px; }
.tool-summary-card {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: #fefce8;
  border: 1px solid #fef08a;
  color: #854d0e;
  padding: 8px 14px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.5;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
}
.tool-icon { font-size: 14px; flex-shrink: 0; }
.tool-text { word-break: break-word; }
.cursor { animation: blink 1s infinite; }
@keyframes blink { 50% { opacity: 0; } }

.thinking {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: #6366f1;
  font-weight: 500;
}
.thinking-card {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 12px 12px 12px 2px;
  padding: 12px 14px;
  max-width: 100%;
}
.thinking-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: #6366f1;
  margin-bottom: 6px;
}
.thinking-body {
  font-size: 12px;
  color: #64748b;
  line-height: 1.6;
  white-space: pre-wrap;
  max-height: 200px;
  overflow-y: auto;
}
.pulse-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #6366f1;
  display: inline-block;
  animation: pulse-ring 1.5s cubic-bezier(0.215, 0.61, 0.355, 1) infinite;
}
@keyframes pulse-ring {
  0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.7); }
  70% { transform: scale(1.1); box-shadow: 0 0 0 6px rgba(99, 102, 241, 0); }
  100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(99, 102, 241, 0); }
}
.dots { animation: blink 1s infinite; }
.input-area { padding: 16px; border-top: 1px solid #e5e7eb; display: flex; gap: 10px; align-items: flex-end; background: #fff; }
.input-box {
  flex: 1; border: 1px solid #d1d5db; border-radius: 10px;
  padding: 10px 14px; font-size: 14px; resize: none; outline: none;
  font-family: inherit; line-height: 1.5;
}
.input-box:focus { border-color: #4f46e5; }
.input-box:disabled { background: #f9fafb; color: #9ca3af; }
.btn-send {
  background: #4f46e5; color: #fff; border: none; border-radius: 10px;
  padding: 10px 20px; font-size: 14px; cursor: pointer; white-space: nowrap;
  font-weight: 500;
}
.btn-send:hover:not(:disabled) { background: #4338ca; }
.btn-send:disabled { background: #a5b4fc; cursor: not-allowed; }

/* 停止生成按钮 (红色/深色警示风格) */
.btn-stop {
  background: #ef4444; color: #fff; border: none; border-radius: 10px;
  padding: 10px 18px; font-size: 14px; cursor: pointer; white-space: nowrap;
  font-weight: 500; display: inline-flex; align-items: center; gap: 6px;
  box-shadow: 0 1px 3px rgba(239, 68, 68, 0.25);
  transition: all 0.15s ease;
}
.btn-stop:hover { background: #dc2626; transform: translateY(-1px); }
.stop-square { font-size: 11px; line-height: 1; }

/* 类似 Antigravity 的操作按钮栏：修改并重新输入 */
.last-msg-actions {
  display: flex;
  justify-content: flex-start;
  margin-top: 4px;
  margin-bottom: 8px;
  padding-left: 2px;
}
.btn-modify-prompt {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: #f3f4f6;
  color: #4b5563;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}
.btn-modify-prompt:hover {
  background: #e5e7eb;
  color: #1f2937;
  border-color: #d1d5db;
  transform: translateY(-1px);
}
.icon-edit {
  width: 14px;
  height: 14px;
}
</style>
