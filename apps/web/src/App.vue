<template>
  <div class="app-layout">
    <!-- 左侧：会话列表 + 对话区 -->
    <aside class="sidebar">
      <div class="sidebar-header">
        <span class="logo">⚡ Excel Harness</span>
        <button class="btn-new" @click="store.createSession()">+ 新会话</button>
      </div>
      <ul class="session-list">
        <li
          v-for="s in store.sessions"
          :key="s.id"
          :class="['session-item', { active: s.id === store.currentSessionId }]"
          @click="store.selectSession(s.id)"
        >
          <div class="session-info">
            <span class="session-title" :title="s.title">{{ s.title }}</span>
            <span class="session-time">{{ formatDate(s.updatedAt) }}</span>
          </div>
          <button
            class="btn-delete-session"
            title="删除此会话"
            @click.stop="confirmDelete(s.id, s.title)"
          >
            🗑
          </button>
        </li>
      </ul>
    </aside>

    <!-- 中间：对话区 -->
    <main class="chat-panel">
      <ChatPanel />
    </main>

    <!-- 右侧：工具沙箱 -->
    <aside class="sandbox-panel">
      <ToolSandbox />
    </aside>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useChatStore } from './stores/chat'
import ChatPanel from './components/ChatPanel.vue'
import ToolSandbox from './components/ToolSandbox.vue'

const store = useChatStore()

onMounted(() => store.loadSessions())

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

async function confirmDelete(id: string, title: string) {
  if (window.confirm(`确定要删除对话「${title}」及其所有相关数据吗？`)) {
    await store.deleteSession(id)
  }
}
</script>

<style>
.app-layout {
  display: flex;
  height: 100vh;
  background: #f5f5f5;
}
.sidebar {
  width: 220px;
  background: #1a1a2e;
  color: #fff;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}
.sidebar-header {
  padding: 16px 12px;
  border-bottom: 1px solid #2a2a4e;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.logo { font-weight: 700; font-size: 14px; }
.btn-new {
  background: #4f46e5;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
}
.btn-new:hover { background: #4338ca; }
.session-list { flex: 1; overflow-y: auto; padding: 8px 0; list-style: none; }
.session-item {
  padding: 10px 12px;
  cursor: pointer;
  border-left: 3px solid transparent;
  transition: background 0.15s;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.session-item:hover { background: #2a2a4e; }
.session-item.active { background: #2a2a4e; border-left-color: #4f46e5; }
.session-info {
  flex: 1;
  min-width: 0;
}
.session-title { display: block; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.session-time { font-size: 11px; color: #888; }
.btn-delete-session {
  background: transparent;
  border: none;
  color: #666;
  font-size: 13px;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s, background 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
.session-item:hover .btn-delete-session {
  opacity: 1;
  color: #a0a0b0;
}
.btn-delete-session:hover {
  color: #ef4444 !important;
  background: rgba(239, 68, 68, 0.15);
}
.chat-panel { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.sandbox-panel { width: 420px; border-left: 1px solid #e0e0e0; background: #fff; flex-shrink: 0; }
</style>
