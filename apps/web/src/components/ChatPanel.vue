<template>
  <div class="chat-panel">
    <!-- 消息列表 -->
    <div class="messages" ref="messagesEl">
      <div v-if="!store.currentSession" class="empty-state">
        <p>👈 选择或创建一个会话开始使用</p>
      </div>
      <template v-else>
        <div
          v-for="msg in store.currentSession.messages"
          :key="msg.id"
          :class="['message', `message--${msg.role}`]"
        >
          <div class="message-role">{{ roleLabel(msg.role) }}</div>
          <div class="message-content" v-html="renderContent(msg.content)"></div>
        </div>
        <!-- 流式输出中 -->
        <div v-if="store.isStreaming && store.streamingText" class="message message--assistant">
          <div class="message-role">🤖 助手</div>
          <div class="message-content">{{ store.streamingText }}<span class="cursor">▌</span></div>
        </div>
        <div v-if="store.isStreaming && !store.streamingText" class="message message--assistant">
          <div class="message-role">🤖 助手</div>
          <div class="message-content thinking">正在思考<span class="dots">...</span></div>
        </div>
      </template>
    </div>

    <!-- 输入区 -->
    <div class="input-area">
      <textarea
        v-model="input"
        class="input-box"
        placeholder="描述你的 Excel 处理需求，例如：帮我写一个工具，把 Excel 中的手机号列脱敏处理..."
        :disabled="store.isStreaming || !store.currentSession"
        @keydown.enter.prevent="submit"
        rows="3"
      />
      <button
        class="btn-send"
        :disabled="store.isStreaming || !input.trim() || !store.currentSession"
        @click="submit"
      >
        {{ store.isStreaming ? '生成中…' : '发送 ↵' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useChatStore } from '../stores/chat'

const store = useChatStore()
const input = ref('')
const messagesEl = ref<HTMLElement>()

async function submit() {
  const msg = input.value.trim()
  if (!msg || store.isStreaming) return
  input.value = ''
  await store.sendMessage(msg)
}

function roleLabel(role: string) {
  return role === 'user' ? '👤 你' : role === 'tool' ? '🔧 工具' : '🤖 助手'
}

function renderContent(content: string) {
  // 简单转义 + 换行处理
  return content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
}

// 自动滚动到底部
watch(
  () => [store.currentSession?.messages.length, store.streamingText],
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
.cursor { animation: blink 1s infinite; }
@keyframes blink { 50% { opacity: 0; } }
.thinking { color: #888; }
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
</style>
