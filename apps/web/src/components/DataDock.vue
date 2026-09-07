<template>
  <div
    class="data-dock"
    :class="{ 'data-dock--dragging': isDragging }"
    @dragover.prevent="isDragging = true"
    @dragleave.prevent="isDragging = false"
    @drop.prevent="handleDrop"
  >
    <input
      ref="fileInputRef"
      type="file"
      multiple
      accept=".xlsx,.csv"
      class="file-input-hidden"
      @change="handleFileSelect"
    />

    <!-- 状态 1: 未上传任何文件 -->
    <div
      v-if="store.excelFiles.length === 0"
      :class="['upload-zone', { 'upload-zone--dragging': isDragging, 'upload-zone--loading': store.isUploadingExcel }]"
      @click="triggerFileInput"
    >
      <div v-if="store.isUploadingExcel" class="upload-loading">
        <span class="spinner">⏳</span>
        <span>正在深度解析 Excel 结构、多层表头与隐私特征…</span>
      </div>
      <div v-else class="upload-prompt">
        <span class="upload-icon">📁</span>
        <div class="upload-text">
          <span class="upload-title">挂载 Excel 数据源（支持单选或多选批量挂载）</span>
          <span class="upload-sub">支持多表关联与智能表头识别，在本地安全脱敏后再发送给大模型</span>
        </div>
        <span class="btn-upload-hint">上传 Excel ↵</span>
      </div>
    </div>

    <!-- 状态 2: 已挂载 1 个或多个文件 -->
    <div v-else class="dock-multi-wrap">
      <!-- 顶部控制条 -->
      <div class="dock-toolbar">
        <div class="toolbar-left">
          <span class="toolbar-title">
            📊 已挂载 Excel 数据源 (共 {{ store.excelFiles.length }} 个文件)
          </span>
          <span v-if="isDragging" class="drag-hint">松开鼠标即可添加文件</span>
        </div>
        <div class="toolbar-actions">
          <button class="tool-btn btn-add-more" :disabled="store.isUploadingExcel" @click="triggerFileInput">
            {{ store.isUploadingExcel ? '⏳ 解析中…' : '➕ 添加 Excel' }}
          </button>
          <button class="tool-btn btn-preview-all" @click="showPromptPreview = true">
            👁️ 查看发给 AI 的数据
          </button>
          <button class="tool-btn btn-clear-all" title="清空全部已挂载文件" @click="handleRemoveAll">
            🗑️ 清空
          </button>
        </div>
      </div>

      <!-- 文件卡片列表 -->
      <div class="dock-cards-list">
        <div
          v-for="file in store.excelFiles"
          :key="file.fileId"
          class="dock-card"
        >
          <div class="card-left">
            <div class="file-icon-wrap">📄</div>
            <div class="file-info">
              <div class="file-title-row">
                <span class="file-name" :title="file.filename">
                  {{ file.filename }}
                </span>
                <span class="tag-sheet">Sheet: {{ file.activeSheet }}</span>
                <span v-if="file.headerLevels > 1" class="tag-levels">
                  {{ file.headerLevels }} 层复合表头
                </span>
              </div>
              <div class="file-meta-row">
                <span>{{ formatFileSize(file.fileSizeBytes) }}</span>
                <span>·</span>
                <span>约 {{ file.rowCount }} 行</span>
                <span>·</span>
                <span>{{ file.columnCount }} 列</span>
                <span>·</span>
                <span v-if="getMaskedCount(file) > 0" class="meta-masked">
                  🛡️ 已脱敏 {{ getMaskedCount(file) }} 列
                </span>
                <span v-if="getUnprotectedSensitiveCount(file) > 0" class="meta-warning">
                  ⚠️ 待保护敏感列 {{ getUnprotectedSensitiveCount(file) }} 项
                </span>
                <span v-else-if="getMaskedCount(file) === 0" class="meta-normal">未配置脱敏</span>
              </div>
            </div>
          </div>

          <div class="card-actions">
            <button class="dock-btn btn-desensitize" @click="openModalFor(file)">
              🛡️ 配置脱敏
            </button>
            <button class="dock-btn btn-remove" title="移除此文件" @click="handleRemoveFile(file)">
              ✕
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 预期标杆 Excel 挂载区 (Ground Truth) -->
    <div class="dock-benchmark-section">
      <input
        ref="benchmarkInputRef"
        type="file"
        accept=".xlsx,.csv,.xls"
        class="file-input-hidden"
        @change="handleBenchmarkSelect"
      />
      <!-- 未上传标杆 -->
      <div v-if="!store.benchmarkFile" class="benchmark-bar-empty">
        <div class="benchmark-hint-left">
          <span class="benchmark-icon">🎯</span>
          <span class="benchmark-label">预期结果标杆 (选填)：</span>
          <span class="benchmark-desc">上传标准结果样本，AI 将严格按其列结构与口径生成工具，并在沙箱提供秒级对账验收</span>
        </div>
        <button class="btn-upload-benchmark" :disabled="store.isUploadingBenchmark" @click="triggerBenchmarkInput">
          {{ store.isUploadingBenchmark ? '⏳ 解析标杆中…' : '＋ 上传标杆 Excel 验证' }}
        </button>
      </div>
      <!-- 已挂载标杆 -->
      <div v-else class="benchmark-card">
        <div class="benchmark-card-left">
          <div class="benchmark-badge">🎯 预期标杆样本</div>
          <div class="benchmark-info">
            <span class="benchmark-name" :title="store.benchmarkFile.filename">{{ store.benchmarkFile.filename }}</span>
            <span class="benchmark-meta">
              {{ store.benchmarkFile.columnCount }} 列结构 · 约 {{ store.benchmarkFile.rowCount }} 行标准数据 (仅作验收对账，不作为输入源)
            </span>
          </div>
        </div>
        <div class="benchmark-card-actions">
          <button class="benchmark-action-btn" title="重新上传替换标杆" @click="triggerBenchmarkInput">
            🔄 替换标杆
          </button>
          <button class="benchmark-action-btn btn-remove" title="移除此标杆文件" @click="handleRemoveBenchmark">
            ✕ 移除
          </button>
        </div>
      </div>
    </div>


    <!-- 脱敏配置弹窗 -->
    <DesensitizeModal
      v-if="activeModalMeta"
      v-model:show="showModal"
      :meta="activeModalMeta"
      @saved="handleSavedRules"
    />

    <!-- 发送给 AI 的全部数据预览弹窗 -->
    <div v-if="showPromptPreview && store.excelFiles.length > 0" class="preview-prompt-backdrop" @click.self="showPromptPreview = false">
      <div class="preview-prompt-dialog">
        <div class="preview-prompt-header">
          <div class="prompt-title">
            <span>👁️ 预览将被注入大模型 Prompt 的多表脱敏上下文</span>
          </div>
          <button class="btn-close" @click="showPromptPreview = false">✕</button>
        </div>
        <div class="preview-prompt-body">
          <pre class="prompt-code">{{ generatedPromptText }}</pre>
        </div>
        <div class="preview-prompt-footer">
          <span class="prompt-tip">✅ 绝不泄露真实全量数据。仅向大模型注入各表的结构定义及脱敏后的少量真实样本。</span>
          <button class="btn btn-secondary" @click="showPromptPreview = false">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useChatStore, type ExcelMeta } from '../stores/chat'
import DesensitizeModal from './DesensitizeModal.vue'

const store = useChatStore()
const fileInputRef = ref<HTMLInputElement>()
const isDragging = ref(false)
const showModal = ref(false)
const activeModalMeta = ref<ExcelMeta | null>(null)
const showPromptPreview = ref(false)

function getMaskedCount(file: ExcelMeta) {
  return (file.desensitizationRules || []).filter((r) => r.enabled).length
}

function getUnprotectedSensitiveCount(file: ExcelMeta) {
  const maskedCols = new Set(
    (file.desensitizationRules || []).filter((r) => r.enabled).map((r) => r.column),
  )
  return file.sensitiveColumns.filter((c) => !maskedCols.has(c.column)).length
}

function triggerFileInput() {
  fileInputRef.value?.click()
}

const benchmarkInputRef = ref<HTMLInputElement | null>(null)

function triggerBenchmarkInput() {
  benchmarkInputRef.value?.click()
}

async function handleBenchmarkSelect(e: Event) {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  try {
    await store.uploadBenchmark(file)
  } catch (err: any) {
    alert(`上传标杆文件失败: ${err.message}`)
  } finally {
    target.value = ''
    if (benchmarkInputRef.value) benchmarkInputRef.value.value = ''
  }
}

async function handleRemoveBenchmark() {
  if (confirm(`确认移除标杆文件「${store.benchmarkFile?.filename}」吗？`)) {
    await store.removeBenchmark()
  }
}

async function handleFileSelect(e: Event) {
  const target = e.target as HTMLInputElement
  const files = target.files
  if (!files || files.length === 0) return
  await uploadFiles(Array.from(files))
  target.value = ''
  if (fileInputRef.value) fileInputRef.value.value = ''
}

async function handleDrop(e: DragEvent) {
  isDragging.value = false
  const files = e.dataTransfer?.files
  if (!files || files.length === 0) return
  await uploadFiles(Array.from(files))
}

async function uploadFiles(files: File[]) {
  try {
    const res = await store.uploadExcel(files)
    const newFiles = res?.newFiles || []
    // 如果有识别出敏感列的文件，自动打开第一个文件的脱敏配置弹窗
    const firstSensitive = newFiles.find((f: ExcelMeta) => f.sensitiveColumns && f.sensitiveColumns.length > 0)
    if (firstSensitive) {
      openModalFor(firstSensitive)
    }
  } catch (err: any) {
    alert(`上传失败: ${err.message}`)
  }
}

function openModalFor(file: ExcelMeta) {
  activeModalMeta.value = file
  showModal.value = true
}

async function handleSavedRules(updatedMeta: ExcelMeta) {
  if (updatedMeta.desensitizationRules) {
    await store.saveDesensitizeConfig(updatedMeta.fileId, updatedMeta.desensitizationRules)
  }
}

async function handleRemoveFile(file: ExcelMeta) {
  if (confirm(`确认移除文件「${file.filename}」吗？`)) {
    await store.removeExcelFile(file.fileId)
    if (activeModalMeta.value?.fileId === file.fileId) {
      activeModalMeta.value = null
      showModal.value = false
    }
  }
}

async function handleRemoveAll() {
  if (confirm(`确认清空当前挂载的全部 ${store.excelFiles.length} 个 Excel 文件吗？`)) {
    await store.removeExcel()
    activeModalMeta.value = null
    showModal.value = false
  }
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

// 预览构建出的多表 Prompt 文本
const generatedPromptText = computed(() => {
  const files = store.excelFiles
  if (!files || files.length === 0) return ''
  const lines: string[] = []
  lines.push(`## 用户当前已挂载并脱敏的 Excel 数据源上下文（共 ${files.length} 个文件）`)

  files.forEach((meta, idx) => {
    lines.push(`\n### 数据源 ${idx + 1}: ${meta.filename}`)
    lines.push(`- 文件路径: ${meta.filepath}`)
    lines.push(`- 工作表: ${meta.activeSheet} (包含工作表: ${meta.sheets.join(', ')})`)
    lines.push(`- 数据规模: 约 ${meta.rowCount} 行数据，${meta.columnCount} 列`)
    lines.push(`- 表头层级: ${meta.headerLevels} 层表头结构 (数据起始于第 ${meta.dataStartRow} 行)`)
    lines.push(`- 列结构与脱敏声明:`)

    const rulesMap = new Map((meta.desensitizationRules ?? []).map((r) => [r.column, r]))
    for (const col of meta.headers) {
      const r = rulesMap.get(col)
      if (r && r.enabled) {
        lines.push(`  * 列「${col}」: 【已脱敏: ${r.label}】 (保留原数据语义)`)
      } else {
        lines.push(`  * 列「${col}」: 正常业务字段`)
      }
    }

    const samples = meta.sanitizedSamples?.slice(0, 5) || meta.sampleRows.slice(0, 5)
    if (samples.length > 0) {
      lines.push(`\n- 脱敏样例数据 (前 ${samples.length} 行真实结构):`)
      lines.push('| ' + meta.headers.join(' | ') + ' |')
      lines.push('| ' + meta.headers.map(() => '---').join(' | ') + ' |')
      for (const s of samples) {
        lines.push('| ' + meta.headers.map((h) => String(s[h] ?? '').replace(/\n/g, ' ')).join(' | ') + ' |')
      }
    }
  })
  return lines.join('\n')
})
</script>

<style scoped>
.data-dock {
  padding: 10px 16px;
  background: #f8fafc;
  border-bottom: 1px solid #e2e8f0;
  transition: background 0.2s;
}

.data-dock--dragging {
  background: #eef2ff;
}

.upload-zone {
  border: 2px dashed #cbd5e1;
  border-radius: 10px;
  padding: 12px 16px;
  background: #fff;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.upload-zone:hover {
  border-color: #6366f1;
  background: #f5f3ff;
}

.upload-zone--dragging {
  border-color: #4f46e5;
  background: #eef2ff;
}

.upload-zone--loading {
  cursor: wait;
  background: #f8fafc;
}

.file-input-hidden { display: none; }

.upload-prompt {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.upload-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #4f46e5;
  font-weight: 500;
}

.upload-icon { font-size: 24px; }
.upload-text { display: flex; flex-direction: column; flex: 1; }
.upload-title { font-size: 13px; font-weight: 600; color: #1e293b; }
.upload-sub { font-size: 11px; color: #64748b; margin-top: 1px; }

.btn-upload-hint {
  font-size: 11px;
  color: #4f46e5;
  background: #eef2ff;
  padding: 4px 10px;
  border-radius: 6px;
  font-weight: 600;
}

/* 多文件包裹区 */
.dock-multi-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dock-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toolbar-title {
  font-size: 12px;
  font-weight: 700;
  color: #334155;
}

.drag-hint {
  font-size: 11px;
  color: #4f46e5;
  font-weight: 600;
  background: #e0e7ff;
  padding: 1px 6px;
  border-radius: 4px;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tool-btn {
  border: 1px solid #cbd5e1;
  background: #fff;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
  color: #334155;
}

.tool-btn:hover {
  background: #f1f5f9;
  border-color: #94a3b8;
}

.btn-add-more {
  background: #eef2ff;
  border-color: #c7d2fe;
  color: #4338ca;
}
.btn-add-more:hover {
  background: #e0e7ff;
  border-color: #a5b4fc;
}

.btn-preview-all {
  background: #f8fafc;
  color: #334155;
}
.btn-preview-all:hover {
  background: #f1f5f9;
}

.btn-clear-all {
  color: #94a3b8;
  border-color: transparent;
  background: transparent;
}
.btn-clear-all:hover {
  background: #fee2e2;
  color: #dc2626;
}

/* 卡片列表 */
.dock-cards-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 180px;
  overflow-y: auto;
  padding-right: 2px;
}

.dock-card {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 8px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
}

.card-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
.file-icon-wrap { font-size: 24px; }
.file-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }

.file-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: nowrap;
}

.file-name {
  font-size: 13px;
  font-weight: 700;
  color: #0f172a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;
}

.tag-sheet {
  font-size: 11px;
  background: #f1f5f9;
  color: #475569;
  padding: 1px 6px;
  border-radius: 4px;
}

.tag-levels {
  font-size: 11px;
  background: #e0e7ff;
  color: #3730a3;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 600;
}

.file-meta-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #64748b;
}

.meta-masked { color: #059669; font-weight: 600; }
.meta-warning { color: #d97706; font-weight: 600; }
.meta-normal { color: #94a3b8; }

.card-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

.dock-btn {
  border: none;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.btn-desensitize { background: #d1fae5; color: #065f46; }
.btn-desensitize:hover { background: #a7f3d0; }

.btn-preview { background: #f1f5f9; color: #334155; }
.btn-preview:hover { background: #e2e8f0; }

.btn-remove {
  background: none;
  color: #94a3b8;
  font-size: 14px;
  padding: 4px 8px;
  border-radius: 4px;
}
.btn-remove:hover { background: #fee2e2; color: #dc2626; }

/* Prompt 预览弹窗 */
.preview-prompt-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.preview-prompt-dialog {
  background: #fff;
  width: 90vw;
  max-width: 800px;
  max-height: 80vh;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
  overflow: hidden;
}

.preview-prompt-header {
  padding: 14px 18px;
  border-bottom: 1px solid #e2e8f0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 14px;
  font-weight: 700;
}

.btn-close { background: none; border: none; font-size: 16px; cursor: pointer; color: #94a3b8; }
.btn-close:hover { color: #334155; }

.preview-prompt-body {
  padding: 16px;
  overflow-y: auto;
  flex: 1;
  background: #0f172a;
}

.prompt-code {
  color: #38bdf8;
  font-family: 'Menlo', monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
}

.preview-prompt-footer {
  padding: 12px 18px;
  border-top: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #f8fafc;
}

.prompt-tip { font-size: 11px; color: #166534; font-weight: 500; }
.btn-secondary {
  background: #e2e8f0;
  border: none;
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  color: #334155;
  font-weight: 600;
}
.btn-secondary:hover { background: #cbd5e1; }

/* ── 预期标杆挂载区样式 ── */
.dock-benchmark-section {
  margin-top: 8px;
}

.benchmark-bar-empty {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  background: #f5f3ff;
  border: 1px dashed #c4b5fd;
  border-radius: 8px;
  gap: 12px;
}

.benchmark-hint-left {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.benchmark-icon {
  font-size: 14px;
}

.benchmark-label {
  font-weight: 700;
  color: #6d28d9;
}

.benchmark-desc {
  color: #7c3aed;
  opacity: 0.85;
}

.btn-upload-benchmark {
  flex-shrink: 0;
  background: #7c3aed;
  color: #ffffff;
  border: none;
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.btn-upload-benchmark:hover {
  background: #6d28d9;
}

.benchmark-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  background: #faf5ff;
  border: 1px solid #d8b4fe;
  border-radius: 8px;
}

.benchmark-card-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.benchmark-badge {
  font-size: 11px;
  font-weight: 700;
  background: #ede9fe;
  color: #6d28d9;
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px solid #ddd6fe;
}

.benchmark-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.benchmark-name {
  font-size: 13px;
  font-weight: 600;
  color: #4c1d95;
}

.benchmark-meta {
  font-size: 11px;
  color: #7c3aed;
}

.benchmark-card-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.benchmark-action-btn {
  background: #ffffff;
  border: 1px solid #c4b5fd;
  color: #6d28d9;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.benchmark-action-btn:hover {
  background: #f5f3ff;
  border-color: #a78bfa;
}

.benchmark-action-btn.btn-remove {
  color: #b91c1c;
  border-color: #fecaca;
}

.benchmark-action-btn.btn-remove:hover {
  background: #fef2f2;
  border-color: #fca5a5;
}
</style>
