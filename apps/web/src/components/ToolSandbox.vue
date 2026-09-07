<template>
  <div class="sandbox">
    <!-- 无工具状态 -->
    <div v-if="!store.uiSchema" class="sandbox-empty">
      <div class="sandbox-empty-icon">🛠️</div>
      <p class="sandbox-empty-title">工具沙箱</p>
      <p class="sandbox-empty-desc">在左侧对话中描述你的 Excel 处理需求，<br>AI 生成工具后会在这里自动渲染。</p>
    </div>

    <!-- 工具已生成 -->
    <template v-else>
      <div class="sandbox-header">
        <h2 class="sandbox-title">{{ store.uiSchema.title }}</h2>
        <span class="sandbox-badge">✅ 工具就绪</span>
      </div>

      <div class="sandbox-body">
        <FormRenderer :schema="store.uiSchema" @submit="handleRun" />
      </div>

      <!-- 执行结果 -->
      <div v-if="store.runResult" class="run-result" :class="store.runResult.success ? 'result--ok' : 'result--err'">
        <div class="result-header">
          <span>{{ store.runResult.success ? '✅ 执行成功' : '❌ 执行失败' }}</span>
          <span v-if="store.runResult.durationMs" class="result-duration">耗时 {{ store.runResult.durationMs }}ms</span>
        </div>

        <!-- 成功产物下载区 -->
        <div v-if="store.runResult.success && store.runResult.outputFiles && store.runResult.outputFiles.length > 0" class="result-downloads">
          <div class="downloads-header">
            <span class="downloads-title">🎉 产物生成就绪：</span>
          </div>
          <div class="downloads-list">
            <div v-for="file in store.runResult.outputFiles" :key="file.filename" class="download-item">
              <span class="download-file-icon">📊</span>
              <span class="download-file-name" :title="file.filename">{{ file.filename }}</span>
              <a
                :href="`/api/download?filepath=${encodeURIComponent(file.filepath)}&filename=${encodeURIComponent(file.filename)}`"
                class="btn-download-file"
                download
              >
                📥 下载 Excel 结果
              </a>
            </div>
          </div>
        </div>

        <!-- 日志与错误信息 -->
        <pre v-if="store.runResult.stdout" class="result-output">{{ store.runResult.stdout }}</pre>
        <pre v-if="store.runResult.stderr" class="result-stderr">{{ store.runResult.stderr }}</pre>

        <!-- 失败一键自愈修复按钮 -->
        <div v-if="!store.runResult.success" class="result-heal-bar">
          <button class="btn-self-heal" @click="handleAutoFix">
            🤖 发送此报错给 AI，让 AI 自动修复代码
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useChatStore } from '../stores/chat'
import FormRenderer from './FormRenderer.vue'

const store = useChatStore()

async function handleRun(params: Record<string, string>) {
  await store.runScript(params)
}

function handleAutoFix() {
  if (!store.runResult?.stderr) return
  const prompt = `刚才在右侧沙箱运行工具时遇到报错，请根据以下报错堆栈帮我自动分析原因并修复代码：\n\n\`\`\`\n${store.runResult.stderr}\n\`\`\``
  store.sendMessage(prompt)
}
</script>

<style scoped>
.sandbox { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
.sandbox-empty {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  padding: 32px; text-align: center; color: #9ca3af;
}
.sandbox-empty-icon { font-size: 48px; margin-bottom: 16px; }
.sandbox-empty-title { font-size: 16px; font-weight: 600; color: #374151; margin-bottom: 8px; }
.sandbox-empty-desc { font-size: 13px; line-height: 1.6; }
.sandbox-header {
  padding: 16px 20px; border-bottom: 1px solid #e5e7eb;
  display: flex; align-items: center; justify-content: space-between;
}
.sandbox-title { font-size: 15px; font-weight: 600; color: #111827; }
.sandbox-badge { font-size: 12px; background: #d1fae5; color: #065f46; padding: 3px 8px; border-radius: 12px; }
.sandbox-body { flex: 1; overflow-y: auto; padding: 20px; }
.run-result { margin: 0 20px 20px; border-radius: 8px; overflow: hidden; }
.result--ok { border: 1px solid #6ee7b7; }
.result--err { border: 1px solid #fca5a5; }
.result-header {
  padding: 8px 12px; font-size: 13px; font-weight: 600; background: #f9fafb;
  display: flex; align-items: center; justify-content: space-between;
}
.result--ok .result-header { color: #065f46; }
.result--err .result-header { color: #991b1b; }
.result-duration { font-size: 11px; font-weight: normal; color: #64748b; }

.result-downloads {
  background: #ecfdf5;
  padding: 12px;
  border-bottom: 1px solid #d1fae5;
}
.downloads-header { font-size: 12px; font-weight: 700; color: #065f46; margin-bottom: 8px; }
.downloads-list { display: flex; flex-direction: column; gap: 6px; }
.download-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fff;
  border: 1px solid #a7f3d0;
  padding: 6px 12px;
  border-radius: 6px;
  gap: 10px;
}
.download-file-icon { font-size: 16px; }
.download-file-name { font-size: 12px; font-weight: 600; color: #1e293b; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn-download-file {
  background: #10b981;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 4px;
  text-decoration: none;
  transition: background 0.15s;
  white-space: nowrap;
}
.btn-download-file:hover { background: #059669; }

.result-output, .result-stderr {
  margin: 0; padding: 10px 12px; font-size: 12px;
  font-family: 'Menlo', monospace; line-height: 1.5;
  max-height: 200px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;
}
.result-output { background: #f0fdf4; color: #166534; }
.result-stderr { background: #fef2f2; color: #991b1b; }

.result-heal-bar {
  padding: 10px 12px;
  background: #fff5f5;
  border-top: 1px solid #fecaca;
  display: flex;
  justify-content: flex-end;
}
.btn-self-heal {
  background: #ef4444;
  color: #fff;
  border: none;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
.btn-self-heal:hover { background: #dc2626; }
</style>
