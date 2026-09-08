<template>
  <div v-if="store.isOutputPreviewOpen && currentFile" class="modal-backdrop" @click.self="store.closeOutputPreview">
    <div class="modal-dialog">
      <!-- 弹窗顶部栏 -->
      <div class="modal-header">
        <div class="header-left">
          <span class="header-icon">📊</span>
          <div class="header-meta">
            <div class="title-row">
              <h3 class="header-title">{{ currentFile.filename }}</h3>
              <span v-if="previewData" class="badge-dim">
                约 {{ previewData.rowCount }} 行 × {{ previewData.columnCount }} 列
              </span>
              <span v-if="previewData?.activeSheet" class="badge-sheet">
                Sheet: {{ previewData.activeSheet }}
              </span>
            </div>
            <p class="header-desc">
              产物数据实时透析：前 15 行极速预览、维度健康度检查与标杆对账
            </p>
          </div>
        </div>

        <!-- 头部右侧操作区 -->
        <div class="header-actions">
          <!-- 多产物切换器 -->
          <div v-if="allOutputFiles.length > 1" class="file-switcher">
            <span class="switcher-label">产物列表：</span>
            <select v-model="selectedFilename" class="file-select" @change="handleFileSwitch">
              <option v-for="f in allOutputFiles" :key="f.filename" :value="f.filename">
                {{ f.filename }}
              </option>
            </select>
          </div>

          <!-- 关闭按钮 -->
          <button class="btn-close" title="关闭 (Esc)" @click="store.closeOutputPreview">✕</button>
        </div>
      </div>

      <!-- 选项卡导航 -->
      <div class="modal-tabs">
        <button
          class="tab-btn"
          :class="{ 'tab-btn--active': activeTab === 'data' }"
          @click="activeTab = 'data'"
        >
          <span>📊 数据预览</span>
          <span v-if="previewData" class="tab-count">前 {{ previewData.sampleRows.length }} 行</span>
        </button>

        <button
          class="tab-btn"
          :class="{ 'tab-btn--active': activeTab === 'health' }"
          @click="activeTab = 'health'"
        >
          <span>🩺 出厂质检</span>
          <span v-if="validationReport" class="tab-status-chip" :class="'chip--' + validationReport.status">
            {{ validationReport.statusLabel }}
          </span>
        </button>

        <button
          class="tab-btn"
          :class="{ 'tab-btn--active': activeTab === 'diff' }"
          @click="activeTab = 'diff'"
        >
          <span>🎯 样表/标杆核验</span>
          <span v-if="store.diffReport" class="tab-badge-score" :class="getScoreClass(store.diffReport.overallMatchRate)">
            {{ store.diffReport.overallMatchRate }}%
          </span>
        </button>

        <button
          class="tab-btn"
          :class="{ 'tab-btn--active': activeTab === 'logs' }"
          @click="activeTab = 'logs'"
        >
          <span>📝 运行日志</span>
          <span v-if="store.runResult?.durationMs" class="tab-duration">
            {{ store.runResult.durationMs }}ms
          </span>
        </button>
      </div>

      <!-- 弹窗主体内容区 -->
      <div class="modal-body">
        <!-- ── TAB 1: 数据预览 ───────────────────────────── -->
        <div v-if="activeTab === 'data'" class="tab-pane pane-data">
          <!-- 正在嗅探加载中 -->
          <div v-if="store.isLoadingPreview" class="loading-state">
            <span class="loading-spinner">⏳</span>
            <span>正在快速嗅探解析产物前 N 行结构…</span>
          </div>

          <!-- 预览数据就绪 -->
          <template v-else-if="previewData">
            <!-- 顶部工具小栏：多 Sheet 切换与说明 -->
            <div class="pane-toolbar">
              <div class="toolbar-left">
                <span class="hint-text">💡 提示：当前展示产物前 15 行样例数据，表格支持横向平滑滚动查看所有列。</span>
              </div>
              <div v-if="previewData.sheets && previewData.sheets.length > 1" class="sheet-tabs">
                <span class="sheet-tabs-label">工作表：</span>
                <span
                  v-for="s in previewData.sheets"
                  :key="s"
                  class="sheet-pill"
                  :class="{ 'sheet-pill--active': s === previewData.activeSheet }"
                >
                  {{ s }}
                </span>
              </div>
            </div>

            <!-- 数据表格容器 -->
            <div class="preview-table-wrap">
              <table class="preview-table">
                <thead>
                  <tr>
                    <th class="th-index">#</th>
                    <th v-for="col in previewData.headers" :key="col" class="th-col">
                      {{ col }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, rIdx) in previewData.sampleRows" :key="rIdx">
                    <td class="td-index">{{ rIdx + 1 }}</td>
                    <td v-for="col in previewData.headers" :key="col" class="td-cell">
                      <span v-if="row[col] === null || row[col] === undefined || row[col] === ''" class="cell-empty">—</span>
                      <span v-else>{{ row[col] }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>

          <!-- 无预览数据兜底 -->
          <div v-else class="empty-state">
            <span class="empty-icon">📁</span>
            <p>该产物文件暂无结构化表格预览（可能为非 Excel 格式或空文件）。</p>
            <a
              :href="`/api/download?filepath=${encodeURIComponent(currentFile.filepath)}&filename=${encodeURIComponent(currentFile.filename)}`"
              class="btn-download-primary"
              download
            >
              📥 点击直接下载该文件
            </a>
          </div>
        </div>

        <!-- ── TAB 2: 出厂质检 (Health) ──────────────────── -->
        <div v-if="activeTab === 'health'" class="tab-pane pane-health">
          <template v-if="validationReport">
            <!-- 质检结论大卡片 -->
            <div class="health-summary-banner" :class="'banner--' + validationReport.status">
              <div class="banner-left">
                <span class="banner-status-icon">
                  {{ validationReport.status === 'healthy' ? '🟢' : (validationReport.status === 'warning' ? '🟡' : '🔴') }}
                </span>
                <div class="banner-texts">
                  <div class="banner-title-row">
                    <span class="banner-status-title">出厂状态：{{ validationReport.statusLabel }}</span>
                    <span class="banner-dim-tag">
                      已扫描 {{ validationReport.sheetCount }} 个工作表 · {{ validationReport.rowCount }} 行数据 · {{ validationReport.columnCount }} 列
                    </span>
                  </div>
                  <p class="banner-summary-desc">{{ validationReport.summary }}</p>
                </div>
              </div>
              <div v-if="validationReport.status === 'critical'" class="banner-action">
                <button class="btn-heal-quick" @click="handleSendValidationToAi">
                  🤖 发送体检依据给 AI 自动修复
                </button>
              </div>
            </div>

            <!-- 客观依据核对清单 -->
            <div class="health-checklist-section">
              <div class="checklist-header">
                <span class="checklist-title">📋 客观检查依据与事实清单：</span>
                <span class="checklist-badge-local">🔒 100% 本地纯代码规则引擎扫描 · 零数据泄露</span>
              </div>

              <div class="checklist-items">
                <div
                  v-for="(chk, idx) in validationReport.checks"
                  :key="idx"
                  class="check-item-card"
                  :class="'item-card--' + chk.level"
                >
                  <div class="item-card-left">
                    <span class="item-status-tag" :class="'tag--' + chk.level">
                      {{ chk.level === 'success' ? '通过' : (chk.level === 'warning' ? '提醒' : '硬伤') }}
                    </span>
                    <div class="item-info">
                      <span class="item-title">{{ chk.title }}：{{ chk.detail }}</span>
                      <span class="item-evidence">事实依据：{{ chk.evidence }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <div v-else class="empty-state">
            <span class="empty-icon">🩺</span>
            <p>该产物暂未生成独立质检报告。</p>
          </div>
        </div>

        <!-- ── TAB 3: 样表/标杆契约核验 (Schema Conformance / Ground Truth Diff) ────────────────── -->
        <div v-if="activeTab === 'diff'" class="tab-pane pane-diff">
          <input
            ref="modalBenchmarkInput"
            type="file"
            accept=".xlsx,.csv,.xls"
            class="file-input-hidden"
            @change="handleBenchmarkFileSelect"
          />

          <!-- 样表/标杆控制条 -->
          <div class="diff-ctrl-bar">
            <div class="diff-ctrl-left">
              <span class="diff-title">🎯 期望参考基准：</span>
              <span v-if="store.benchmarkFile" class="diff-bench-name" :title="store.benchmarkFile.filename">
                已挂载「{{ store.benchmarkFile.filename }}」
              </span>
              <span
                v-if="store.benchmarkFile"
                class="diff-mode-badge"
                :class="'diff-mode--' + (store.benchmarkFile.benchmarkRole || 'template')"
              >
                {{ store.benchmarkFile.benchmarkRole === 'template' ? '📋 目标模板模式' : '🎯 真实标杆模式' }}
              </span>
              <span v-else class="diff-bench-tip">
                暂未挂载样表或标杆。上传格式模板（空表头/样表）或标准结果，系统将自适应核验表头契约或精确数值对账。
              </span>
            </div>
            <div class="diff-ctrl-actions">
              <button
                v-if="store.benchmarkFile"
                class="btn-diff-toggle-role"
                title="切换核验模式"
                @click="handleModalToggleRole"
              >
                {{ store.benchmarkFile.benchmarkRole === 'template' ? '⇄ 切换为数值对账' : '⇄ 切换为模板契约' }}
              </button>
              <button
                v-if="store.benchmarkFile"
                class="btn-diff-run"
                :disabled="store.isComparingBenchmark"
                @click="handleRunDiff"
              >
                {{ store.isComparingBenchmark ? '⏳ 核验比对中…' : (store.benchmarkFile.benchmarkRole === 'template' ? '🔍 重新核验模板契约' : '🔍 一键验收对账 (Diff)') }}
              </button>
              <button
                v-else
                class="btn-diff-upload"
                :disabled="store.isUploadingBenchmark"
                @click="triggerBenchmarkUpload"
              >
                {{ store.isUploadingBenchmark ? '⏳ 上传中…' : '＋ 上传样表 / 标杆' }}
              </button>
              <button
                v-if="store.benchmarkFile"
                class="btn-diff-replace"
                title="更换样表/标杆文件"
                @click="triggerBenchmarkUpload"
              >
                更换文件
              </button>
            </div>
          </div>

          <!-- 契约核验 / 对账报告 -->
          <div v-if="store.diffReport" class="diff-report-container">
            <div class="diff-summary-header" :class="'header--' + store.diffReport.mode">
              <div class="diff-score-badge" :class="getScoreClass(store.diffReport.overallMatchRate)">
                {{ store.diffReport.mode === 'template' ? '表头覆盖率' : '整体匹配率' }}: {{ store.diffReport.overallMatchRate }}%
              </div>
              <div class="diff-rows-info">
                {{ store.diffReport.mode === 'template'
                  ? `目标包含 ${store.diffReport.templateChecks?.columns.length ?? store.diffReport.columnStats.length} 个字段 · 产物已填充 ${store.diffReport.outputRowCount} 行`
                  : `产物 ${store.diffReport.outputRowCount} 行 vs 标杆 ${store.diffReport.benchmarkRowCount} 行` }}
              </div>
              <div class="diff-summary-text">
                {{ store.diffReport.summaryText }}
              </div>
            </div>

            <!-- 模式 A: 目标模板契约核验表 -->
            <div v-if="store.diffReport.mode === 'template' && store.diffReport.templateChecks" class="diff-table-wrap">
              <table class="diff-table">
                <thead>
                  <tr>
                    <th style="width: 220px;">模板目标字段名</th>
                    <th style="width: 130px;">字段覆盖状态</th>
                    <th style="width: 140px;">列序一致性</th>
                    <th style="width: 130px;">产物填充率</th>
                    <th>契约核验详情</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="col in store.diffReport.templateChecks.columns"
                    :key="col.column"
                    :class="{ 'tr-perfect': col.matched, 'tr-diff': !col.matched }"
                  >
                    <td class="col-name font-mono">{{ col.column }}</td>
                    <td>
                      <span class="rate-tag" :class="col.matched ? 'tag--match' : 'tag--missing'">
                        {{ col.matched ? '✅ 包含此字段' : '❌ 产物缺失' }}
                      </span>
                    </td>
                    <td>
                      <span v-if="col.matched" class="order-tag" :class="col.orderMatched ? 'order--ok' : 'order--warn'">
                        {{ col.orderMatched ? `第 ${col.expectedIndex + 1} 列 (顺序一致)` : `第 ${col.actualIndex != null ? col.actualIndex + 1 : '-'} 列 (预期第 ${col.expectedIndex + 1} 列)` }}
                      </span>
                      <span v-else class="text-muted">-</span>
                    </td>
                    <td>
                      <span v-if="col.matched" class="rate-tag" :class="col.populatedRate > 50 ? 'rate--good' : 'rate--warn'">
                        {{ col.populatedRate }}% 非空
                      </span>
                      <span v-else class="text-muted">0%</span>
                    </td>
                    <td class="col-detail">
                      <span v-if="col.matched && col.orderMatched" class="text-perfect">
                        ✅ 100% 严格符合模板设计
                      </span>
                      <span v-else-if="col.matched" class="text-warning">
                        ⚠️ 字段已覆盖，列顺序与模板略有差异
                      </span>
                      <span v-else class="text-danger">
                        ❌ 产物未输出该列，请提醒 AI 在 DataFrame 中包含此列
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- 模式 B: 标杆数值逐列对账表 -->
            <div v-else class="diff-table-wrap">
              <table class="diff-table">
                <thead>
                  <tr>
                    <th style="width: 220px;">目标列名</th>
                    <th style="width: 100px;">匹配率</th>
                    <th style="width: 100px;">对齐行数</th>
                    <th>差异详情与抽样</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="stat in store.diffReport.columnStats"
                    :key="stat.column"
                    :class="{ 'tr-diff': stat.matchRate < 99.99, 'tr-perfect': stat.matchRate >= 99.99 }"
                  >
                    <td class="col-name font-mono">{{ stat.column }}</td>
                    <td>
                      <span class="rate-tag" :class="getScoreClass(stat.matchRate)">
                        {{ stat.matchRate }}%
                      </span>
                    </td>
                    <td class="col-counts">{{ stat.matchCount }} / {{ stat.totalCount }}</td>
                    <td class="col-detail">
                      <span v-if="stat.matchRate >= 99.99" class="text-perfect">✅ 100% 精确对齐</span>
                      <template v-else>
                        <button class="btn-toggle-examples" @click="toggleColExpand(stat.column)">
                          {{ expandedCols[stat.column] ? '收起差异 ▲' : `展开 ${stat.mismatchExamples.length} 处差异样本 ▼` }}
                        </button>
                        <div v-if="expandedCols[stat.column]" class="diff-examples-box">
                          <div v-for="(ex, i) in stat.mismatchExamples" :key="i" class="diff-example-item">
                            <span class="ex-idx">#{{ ex.rowIdx }} {{ ex.keyValue ? `[${ex.keyValue}]` : '' }}</span>
                            <span class="ex-out">产物: {{ ex.outputVal === null ? '空(NaN)' : ex.outputVal }}</span>
                            <span class="ex-sep">vs</span>
                            <span class="ex-bench">标杆: {{ ex.benchmarkVal === null ? '空(NaN)' : ex.benchmarkVal }}</span>
                          </div>
                        </div>
                      </template>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div v-else class="diff-empty-tip">
            <span class="diff-empty-icon">🎯</span>
            <p>点击上方「上传样表 / 标杆」上传模板或标准答案，系统将自适应契约核验或智能对账。</p>
          </div>
        </div>

        <!-- ── TAB 3: 运行日志 ───────────────────────────── -->
        <div v-if="activeTab === 'logs'" class="tab-pane pane-logs">
          <div class="log-section">
            <div class="log-header">
              <span>🖥️ 标准输出 (stdout)</span>
            </div>
            <pre class="log-code">{{ store.runResult?.stdout || '（无标准输出）' }}</pre>
          </div>

          <div v-if="store.runResult?.stderr" class="log-section log-section--err">
            <div class="log-header log-header--err">
              <span>⚠️ 标准错误 / 告警日志 (stderr)</span>
            </div>
            <pre class="log-code log-code--err">{{ store.runResult.stderr }}</pre>
          </div>
        </div>
      </div>

      <!-- 底部操作栏 -->
      <div class="modal-footer">
        <div class="footer-left">
          <span class="file-path-hint" :title="currentFile.filepath">
            本地路径: {{ currentFile.filepath }}
          </span>
        </div>
        <div class="footer-right">
          <button class="btn-footer-close" @click="store.closeOutputPreview">关闭</button>
          <a
            :href="`/api/download?filepath=${encodeURIComponent(currentFile.filepath)}&filename=${encodeURIComponent(currentFile.filename)}`"
            class="btn-footer-download"
            download
          >
            📥 立即下载 Excel 结果
          </a>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useChatStore } from '../stores/chat'

const store = useChatStore()

const activeTab = ref<'data' | 'health' | 'diff' | 'logs'>('data')
const modalBenchmarkInput = ref<HTMLInputElement | null>(null)
const expandedCols = ref<Record<string, boolean>>({})

const allOutputFiles = computed(() => store.runResult?.outputFiles || [])

const selectedFilename = ref<string>('')

const currentFile = computed(() => {
  if (store.currentPreviewFile) return store.currentPreviewFile
  return allOutputFiles.value[0] || null
})

const previewData = computed(() => {
  return currentFile.value?.preview || null
})

const validationReport = computed(() => {
  return currentFile.value?.validation || null
})

function handleSendValidationToAi() {
  if (!validationReport.value) return
  const v = validationReport.value
  const failedChecks = v.checks.filter((c) => c.level !== 'success')
  const lines: string[] = []
  lines.push(`在运行工具后，生成的产物在出厂回读质检中被系统判定为【${v.statusLabel}】：`)
  lines.push(`- 诊断摘要: ${v.summary}`)
  lines.push(`- 检查到的异常依据：`)
  for (const c of failedChecks) {
    lines.push(`  * [${c.title}] ${c.detail} (事实依据: ${c.evidence})`)
  }
  lines.push(`\n请根据上述体检事实依据，帮我排查并修改 Python 处理代码，确保生成的文件格式健全、无数据丢失或公式坏值！`)
  store.closeOutputPreview()
  store.sendMessage(lines.join('\n'))
}

function handleFileSwitch() {
  const found = allOutputFiles.value.find((f) => f.filename === selectedFilename.value)
  if (found) {
    store.openOutputPreview(found)
  }
}

function getScoreClass(rate: number): string {
  if (rate >= 99) return 'score--high'
  if (rate >= 80) return 'score--mid'
  return 'score--low'
}

function toggleColExpand(col: string) {
  expandedCols.value[col] = !expandedCols.value[col]
}

function triggerBenchmarkUpload() {
  modalBenchmarkInput.value?.click()
}

async function handleBenchmarkFileSelect(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    await store.uploadBenchmark(file)
    // 上传后若有产物，直接自动运行对账
    if (currentFile.value?.filepath) {
      await store.compareBenchmark(currentFile.value.filepath)
    }
  } catch (err: any) {
    alert(err.message || '上传标杆失败')
  } finally {
    if (modalBenchmarkInput.value) modalBenchmarkInput.value.value = ''
  }
}

async function handleRunDiff() {
  if (!currentFile.value?.filepath) return
  try {
    await store.compareBenchmark(currentFile.value.filepath)
  } catch (err: any) {
    alert(err.message || '核验失败')
  }
}

async function handleModalToggleRole() {
  if (!store.benchmarkFile) return
  const currentRole = store.benchmarkFile.benchmarkRole || 'template'
  const newRole = currentRole === 'template' ? 'ground_truth' : 'template'
  try {
    await store.setBenchmarkRole(newRole)
    if (currentFile.value?.filepath) {
      await store.compareBenchmark(currentFile.value.filepath, newRole)
    }
  } catch (err: any) {
    alert(`切换模式失败: ${err.message}`)
  }
}
</script>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(15, 23, 42, 0.65);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.modal-dialog {
  background: #ffffff;
  border-radius: 14px;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
  width: 90vw;
  max-width: 1280px;
  height: 88vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #e2e8f0;
}

/* 顶部栏 */
.modal-header {
  padding: 16px 24px;
  border-bottom: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #f8fafc;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.header-icon {
  font-size: 28px;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-title {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  color: #0f172a;
}

.badge-dim {
  font-size: 11px;
  font-weight: 600;
  background: #e0e7ff;
  color: #3730a3;
  padding: 2px 8px;
  border-radius: 12px;
}

.badge-sheet {
  font-size: 11px;
  background: #f1f5f9;
  color: #475569;
  padding: 2px 8px;
  border-radius: 12px;
  border: 1px solid #cbd5e1;
}

.header-desc {
  margin: 4px 0 0;
  font-size: 12px;
  color: #64748b;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.file-switcher {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #475569;
}

.file-select {
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 12px;
  background: #fff;
  color: #1e293b;
}

.btn-close {
  background: none;
  border: none;
  font-size: 18px;
  cursor: pointer;
  color: #94a3b8;
  padding: 4px 8px;
  border-radius: 6px;
}
.btn-close:hover {
  background: #f1f5f9;
  color: #1e293b;
}

/* 选项卡栏 */
.modal-tabs {
  display: flex;
  background: #f1f5f9;
  border-bottom: 1px solid #e2e8f0;
  padding: 0 24px;
  gap: 8px;
}

.tab-btn {
  background: none;
  border: none;
  padding: 10px 16px;
  font-size: 13px;
  font-weight: 600;
  color: #64748b;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: all 0.15s;
}

.tab-btn:hover {
  color: #1e293b;
}

.tab-btn--active {
  color: #0284c7;
  border-bottom-color: #0284c7;
  background: #ffffff;
}

.tab-count {
  font-size: 11px;
  background: #e2e8f0;
  padding: 1px 6px;
  border-radius: 10px;
  color: #475569;
}

.tab-badge-score {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 10px;
  font-weight: 700;
}

.tab-status-chip {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 10px;
  font-weight: 700;
}
.chip--healthy {
  background: #dcfce7;
  color: #15803d;
}
.chip--warning {
  background: #fef9c3;
  color: #a16207;
}
.chip--critical {
  background: #fee2e2;
  color: #b91c1c;
}

.tab-duration {
  font-size: 11px;
  color: #94a3b8;
}

/* 主体容器 */
.modal-body {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: #ffffff;
}

.tab-pane {
  flex: 1;
  overflow: auto;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
}

/* ── TAB 1: 数据预览 ── */
.pane-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.hint-text {
  font-size: 12px;
  color: #64748b;
}

.sheet-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.sheet-pill {
  padding: 2px 10px;
  border-radius: 12px;
  background: #f1f5f9;
  border: 1px solid #cbd5e1;
  color: #475569;
  cursor: pointer;
}

.sheet-pill--active {
  background: #0284c7;
  color: #fff;
  border-color: #0284c7;
}

.preview-table-wrap {
  flex: 1;
  overflow: auto;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #ffffff;
}

.preview-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  text-align: left;
}

.preview-table th,
.preview-table td {
  padding: 8px 14px;
  border: 1px solid #e2e8f0;
  white-space: nowrap;
}

.th-index,
.td-index {
  width: 44px;
  text-align: center;
  background: #f8fafc;
  color: #94a3b8;
  font-weight: 600;
  position: sticky;
  left: 0;
  z-index: 2;
}

.preview-table th {
  background: #f8fafc;
  color: #334155;
  font-weight: 600;
  position: sticky;
  top: 0;
  z-index: 1;
}

.td-cell {
  color: #1e293b;
}

.cell-empty {
  color: #cbd5e1;
}

/* ── TAB 2: 出厂质检 (Health) ── */
.pane-health {
  gap: 16px;
}

.health-summary-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-radius: 10px;
  border: 1px solid #e2e8f0;
}

.banner--healthy {
  background: #f0fdf4;
  border-color: #bbf7d0;
}
.banner--warning {
  background: #fefce8;
  border-color: #fef08a;
}
.banner--critical {
  background: #fef2f2;
  border-color: #fecaca;
}

.banner-left {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}

.banner-status-icon {
  font-size: 26px;
  line-height: 1;
}

.banner-texts {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.banner-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.banner-status-title {
  font-size: 15px;
  font-weight: 700;
  color: #0f172a;
}

.banner-dim-tag {
  font-size: 11px;
  font-weight: 600;
  background: rgba(0, 0, 0, 0.05);
  padding: 2px 8px;
  border-radius: 6px;
  color: #475569;
}

.banner-summary-desc {
  margin: 0;
  font-size: 13px;
  color: #334155;
  line-height: 1.5;
}

.btn-heal-quick {
  background: #ef4444;
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
  white-space: nowrap;
}
.btn-heal-quick:hover {
  background: #dc2626;
}

.health-checklist-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.checklist-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.checklist-title {
  font-size: 13px;
  font-weight: 700;
  color: #1e293b;
}

.checklist-badge-local {
  font-size: 11px;
  color: #059669;
  background: #ecfdf5;
  border: 1px solid #a7f3d0;
  padding: 2px 8px;
  border-radius: 6px;
}

.checklist-items {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.check-item-card {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.item-card--success {
  border-left: 4px solid #10b981;
}
.item-card--warning {
  border-left: 4px solid #f59e0b;
  background: #fffdf5;
}
.item-card--critical {
  border-left: 4px solid #ef4444;
  background: #fff5f5;
}

.item-card-left {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  flex: 1;
}

.item-status-tag {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 4px;
  white-space: nowrap;
}

.tag--success {
  background: #dcfce7;
  color: #15803d;
}
.tag--warning {
  background: #fef9c3;
  color: #a16207;
}
.tag--critical {
  background: #fee2e2;
  color: #b91c1c;
}

.item-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.item-title {
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
}

.item-evidence {
  font-size: 12px;
  color: #64748b;
}

/* ── TAB 3: 标杆对账 ── */
.diff-ctrl-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #f8fafc;
  padding: 12px 16px;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
  margin-bottom: 16px;
}

.diff-title {
  font-weight: 600;
  font-size: 13px;
  color: #1e293b;
}

.diff-bench-name {
  font-size: 13px;
  color: #0284c7;
  font-weight: 600;
}

.diff-mode-badge {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 4px;
  margin-left: 8px;
}
.diff-mode--template {
  background: #e0f2fe;
  color: #0369a1;
  border: 1px solid #bae6fd;
}
.diff-mode--ground_truth {
  background: #ede9fe;
  color: #6d28d9;
  border: 1px solid #ddd6fe;
}

.diff-bench-tip {
  font-size: 12px;
  color: #64748b;
}

.diff-ctrl-actions {
  display: flex;
  gap: 8px;
}

.btn-diff-toggle-role {
  background: #f8fafc;
  border: 1px solid #cbd5e1;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  color: #475569;
  cursor: pointer;
  transition: all 0.15s;
}
.btn-diff-toggle-role:hover {
  background: #f1f5f9;
  color: #1e293b;
}

.btn-diff-run {
  background: #10b981;
  color: white;
  border: none;
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.btn-diff-run:hover {
  background: #059669;
}

.btn-diff-upload,
.btn-diff-replace {
  background: white;
  border: 1px solid #cbd5e1;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 12px;
  color: #334155;
  cursor: pointer;
}
.btn-diff-upload:hover,
.btn-diff-replace:hover {
  background: #f1f5f9;
}

.diff-report-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.diff-summary-header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 14px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
}

.diff-score-badge {
  font-size: 13px;
  font-weight: 700;
  padding: 4px 12px;
  border-radius: 6px;
}

.score--high {
  background: #dcfce7;
  color: #15803d;
}
.score--mid {
  background: #fef9c3;
  color: #a16207;
}
.score--low {
  background: #fee2e2;
  color: #b91c1c;
}

.diff-rows-info {
  font-size: 12px;
  color: #475569;
}

.diff-summary-text {
  font-size: 12px;
  color: #64748b;
  flex: 1;
}

.diff-table-wrap {
  overflow: auto;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
}

.diff-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  text-align: left;
}

.diff-table th,
.diff-table td {
  padding: 8px 12px;
  border: 1px solid #e2e8f0;
}

.diff-table th {
  background: #f8fafc;
  font-weight: 600;
  color: #334155;
}

.rate-tag {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
}

.tag--match {
  background: #dcfce7;
  color: #15803d;
}
.tag--missing {
  background: #fee2e2;
  color: #b91c1c;
}

.order-tag {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
}
.order--ok {
  background: #f0fdf4;
  color: #166534;
}
.order--warn {
  background: #fffbeb;
  color: #b45309;
}

.rate--good {
  background: #f0fdf4;
  color: #166534;
}
.rate--warn {
  background: #fffbeb;
  color: #b45309;
}

.text-warning {
  color: #b45309;
  font-weight: 500;
}
.text-danger {
  color: #b91c1c;
  font-weight: 500;
}
.text-muted {
  color: #94a3b8;
}

.tr-diff {
  background: #fffbeb;
}
.tr-perfect {
  background: #ffffff;
}

.text-perfect {
  color: #166534;
  font-weight: 600;
}

.btn-toggle-examples {
  background: none;
  border: none;
  color: #d97706;
  font-size: 11px;
  cursor: pointer;
  font-weight: 600;
  padding: 2px 0;
}

.diff-examples-box {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 140px;
  overflow: auto;
  background: #ffffff;
  padding: 6px;
  border: 1px solid #fed7aa;
  border-radius: 4px;
}

.diff-example-item {
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: monospace;
}

.ex-idx {
  color: #9a3412;
  font-weight: 600;
}
.ex-out {
  color: #dc2626;
}
.ex-sep {
  color: #94a3b8;
}
.ex-bench {
  color: #16a34a;
}

.diff-empty-tip {
  padding: 40px 0;
  text-align: center;
  color: #94a3b8;
}
.diff-empty-icon {
  font-size: 32px;
  display: block;
  margin-bottom: 8px;
}

/* ── TAB 3: 日志 ── */
.log-section {
  display: flex;
  flex-direction: column;
  margin-bottom: 16px;
}

.log-header {
  font-size: 12px;
  font-weight: 600;
  color: #334155;
  margin-bottom: 6px;
}

.log-code {
  background: #0f172a;
  color: #f8fafc;
  padding: 12px 16px;
  border-radius: 8px;
  font-size: 12px;
  font-family: monospace;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 240px;
  overflow: auto;
  margin: 0;
}

.log-section--err .log-header--err {
  color: #dc2626;
}

.log-code--err {
  background: #450a0a;
  color: #fca5a5;
}

/* 底部栏 */
.modal-footer {
  padding: 14px 24px;
  border-top: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #f8fafc;
}

.file-path-hint {
  font-size: 11px;
  color: #94a3b8;
  font-family: monospace;
  max-width: 600px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
}

.footer-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.btn-footer-close {
  background: white;
  border: 1px solid #cbd5e1;
  padding: 6px 16px;
  border-radius: 6px;
  font-size: 13px;
  color: #334155;
  cursor: pointer;
}
.btn-footer-close:hover {
  background: #f1f5f9;
}

.btn-footer-download {
  background: #0284c7;
  color: white;
  text-decoration: none;
  padding: 7px 18px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  transition: background 0.15s;
}
.btn-footer-download:hover {
  background: #0369a1;
}

.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 0;
  color: #64748b;
  gap: 12px;
}
.loading-spinner {
  font-size: 32px;
}
.empty-icon {
  font-size: 36px;
}
.btn-download-primary {
  background: #0284c7;
  color: white;
  text-decoration: none;
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
}

.file-input-hidden {
  display: none;
}

.font-mono {
  font-family: monospace;
}
</style>
