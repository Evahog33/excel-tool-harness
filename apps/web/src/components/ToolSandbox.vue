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
        <FormRenderer :schema="store.uiSchema" :loading="store.isRunningScript" @submit="handleRun" />
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

        <!-- 🎯 标杆文件对账与 Diff 验收区 -->
        <div v-if="store.runResult.success && store.runResult.outputFiles && store.runResult.outputFiles.length > 0" class="diff-section">
          <input
            ref="benchmarkUploadInput"
            type="file"
            accept=".xlsx,.csv,.xls"
            class="file-input-hidden"
            @change="handleDirectBenchmarkSelect"
          />

          <!-- 标杆对比控制条 -->
          <div class="diff-ctrl-bar">
            <div class="diff-ctrl-left">
              <span class="diff-title">🎯 标杆对账验收：</span>
              <span v-if="store.benchmarkFile" class="diff-bench-name" :title="store.benchmarkFile.filename">
                已挂载「{{ store.benchmarkFile.filename }}」
              </span>
              <span v-else class="diff-bench-tip">
                暂未挂载标杆，上传标准结果后可秒级对账
              </span>
            </div>
            <div class="diff-ctrl-actions">
              <button
                v-if="store.benchmarkFile"
                class="btn-diff-run"
                :disabled="store.isComparingBenchmark"
                @click="handleCompare"
              >
                {{ store.isComparingBenchmark ? '⏳ 对账中…' : '🔍 一键验收对账 (Diff)' }}
              </button>
              <button
                v-else
                class="btn-diff-upload"
                :disabled="store.isUploadingBenchmark"
                @click="triggerDirectBenchmarkUpload"
              >
                {{ store.isUploadingBenchmark ? '⏳ 上传中…' : '＋ 上传标杆 Excel 验证' }}
              </button>
              <button
                v-if="store.benchmarkFile"
                class="btn-diff-replace"
                title="更换标杆文件"
                @click="triggerDirectBenchmarkUpload"
              >
                更换标杆
              </button>
            </div>
          </div>

          <!-- Diff 报告卡片 -->
          <div v-if="store.diffReport" class="diff-report-card">
            <div class="diff-summary-header">
              <div class="diff-score-badge" :class="getScoreClass(store.diffReport.overallMatchRate)">
                整体匹配率: {{ store.diffReport.overallMatchRate }}%
              </div>
              <div class="diff-rows-info">
                产物 {{ store.diffReport.outputRowCount }} 行 vs 标杆 {{ store.diffReport.benchmarkRowCount }} 行
              </div>
              <button class="btn-diff-close" title="收起对账单" @click="store.clearDiffReport">✕</button>
            </div>

            <div class="diff-summary-desc">
              {{ store.diffReport.summaryText }}
            </div>

            <!-- 列级详细对账表 -->
            <div class="diff-table-wrap">
              <table class="diff-table">
                <thead>
                  <tr>
                    <th>目标列名</th>
                    <th style="width: 90px;">匹配率</th>
                    <th style="width: 80px;">对齐数</th>
                    <th>状态与差异详情</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="stat in store.diffReport.columnStats"
                    :key="stat.column"
                    :class="{ 'tr-diff': stat.matchRate < 99.99, 'tr-perfect': stat.matchRate >= 99.99 }"
                  >
                    <td class="col-name">{{ stat.column }}</td>
                    <td>
                      <span class="rate-tag" :class="getScoreClass(stat.matchRate)">
                        {{ stat.matchRate }}%
                      </span>
                    </td>
                    <td class="col-counts">{{ stat.matchCount }}/{{ stat.totalCount }}</td>
                    <td class="col-detail">
                      <span v-if="stat.matchRate >= 99.99" class="text-perfect">✅ 100% 对齐</span>
                      <template v-else>
                        <button class="btn-toggle-examples" @click="toggleColExpand(stat.column)">
                          {{ expandedCols[stat.column] ? '收起样本 ▲' : `查看 ${stat.mismatchExamples.length} 处差异样本 ▼` }}
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

            <!-- 一键自愈闭环按钮 -->
            <div v-if="store.diffReport.overallMatchRate < 99.99" class="diff-heal-bar">
              <button class="btn-send-diff" @click="handleSendDiffToAi">
                🤖 一键发送差异给 AI 自动分析修复代码
              </button>
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
import { ref } from 'vue'
import { useChatStore, type ToolRunParams } from '../stores/chat'
import FormRenderer from './FormRenderer.vue'

const store = useChatStore()
const benchmarkUploadInput = ref<HTMLInputElement | null>(null)
const expandedCols = ref<Record<string, boolean>>({})

function toggleColExpand(col: string) {
  expandedCols.value[col] = !expandedCols.value[col]
}

function getScoreClass(rate: number) {
  if (rate >= 99.9) return 'score--perfect'
  if (rate >= 80) return 'score--warning'
  return 'score--danger'
}

async function handleRun(params: ToolRunParams) {
  store.clearDiffReport()
  await store.runScript(params)
  // 如果挂载了标杆文件且执行成功生成产物，自动进行标杆对账比对！
  if (store.runResult?.success && store.benchmarkFile) {
    try {
      await store.compareBenchmark()
    } catch {}
  }
}

function triggerDirectBenchmarkUpload() {
  benchmarkUploadInput.value?.click()
}

async function handleDirectBenchmarkSelect(e: Event) {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  try {
    await store.uploadBenchmark(file)
    if (store.runResult?.success) {
      await store.compareBenchmark()
    }
  } catch (err: any) {
    alert(`上传标杆文件失败: ${err.message}`)
  } finally {
    target.value = ''
  }
}

async function handleCompare() {
  try {
    await store.compareBenchmark()
  } catch (err: any) {
    alert(err.message)
  }
}

function handleSendDiffToAi() {
  const diff = store.diffReport
  if (!diff) return
  const imperfectCols = diff.columnStats.filter((c) => c.matchRate < 99.99)
  const lines: string[] = []
  lines.push(`我使用标杆文件「${diff.benchmarkFilename}」对当前生成的产物「${diff.outputFilename}」进行了验收对账比对：`)
  lines.push(`- 整体匹配率: ${diff.overallMatchRate}%`)
  lines.push(`- 产物行数: ${diff.outputRowCount} 行 vs 标杆行数: ${diff.benchmarkRowCount} 行`)
  if (diff.missingColumns.length) lines.push(`- ⚠️ 缺失列: ${diff.missingColumns.join(', ')}`)
  if (diff.extraColumns.length) lines.push(`- ℹ️ 多余列: ${diff.extraColumns.join(', ')}`)
  lines.push(`- 对账摘要: ${diff.summaryText}`)

  if (imperfectCols.length > 0) {
    lines.push(`\n存在差异的字段明细与前几行对比样本：`)
    for (const c of imperfectCols) {
      lines.push(`\n* 列「${c.column}」(匹配率 ${c.matchRate}%，不一致 ${c.totalCount - c.matchCount} 项):`)
      for (const ex of c.mismatchExamples.slice(0, 5)) {
        const keyDesc = ex.keyValue ? ` [${ex.keyValue}]` : ''
        lines.push(`  - 第 ${ex.rowIdx} 行${keyDesc}: 产物值=${ex.outputVal} vs 标杆值=${ex.benchmarkVal}`)
      }
    }
  }

  lines.push(`\n请仔细分析上述差异原因（如计算公式、备付倍数、是否含预警金额、空值/0值处理、人员匹配缺失等），并直接优化 Python 处理代码使其 100% 对齐标杆标准！`)
  store.sendMessage(lines.join('\n'))
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

/* ── 标杆对账与 Diff 验收样式 ── */
.diff-section {
  background: #faf5ff;
  border-bottom: 1px solid #e9d5ff;
  padding: 12px;
}

.diff-ctrl-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.diff-ctrl-left {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  overflow: hidden;
}

.diff-title {
  font-weight: 700;
  color: #6b21a8;
  flex-shrink: 0;
}

.diff-bench-name {
  color: #7e22ce;
  font-weight: 600;
  background: #f3e8ff;
  padding: 2px 6px;
  border-radius: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diff-bench-tip {
  color: #9333ea;
  font-size: 11px;
}

.diff-ctrl-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.btn-diff-run {
  background: #7e22ce;
  color: #fff;
  border: none;
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.btn-diff-run:hover:not(:disabled) {
  background: #6b21a8;
}

.btn-diff-upload {
  background: #9333ea;
  color: #fff;
  border: none;
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.btn-diff-upload:hover:not(:disabled) {
  background: #7e22ce;
}

.btn-diff-replace {
  background: #fff;
  border: 1px solid #d8b4fe;
  color: #7e22ce;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
}

.btn-diff-replace:hover {
  background: #f3e8ff;
}

.diff-report-card {
  margin-top: 10px;
  background: #fff;
  border: 1px solid #d8b4fe;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(126, 34, 206, 0.08);
}

.diff-summary-header {
  padding: 8px 12px;
  background: #fdf4ff;
  border-bottom: 1px solid #fae8ff;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.diff-score-badge {
  font-size: 12px;
  font-weight: 700;
  padding: 3px 8px;
  border-radius: 12px;
}

.score--perfect {
  background: #dcfce7;
  color: #15803d;
}

.score--warning {
  background: #fef9c3;
  color: #a16207;
}

.score--danger {
  background: #fee2e2;
  color: #b91c1c;
}

.diff-rows-info {
  font-size: 11px;
  color: #64748b;
}

.btn-diff-close {
  background: none;
  border: none;
  font-size: 13px;
  color: #94a3b8;
  cursor: pointer;
}

.btn-diff-close:hover {
  color: #334155;
}

.diff-summary-desc {
  padding: 8px 12px;
  font-size: 12px;
  color: #475569;
  line-height: 1.5;
  background: #faf5ff;
  border-bottom: 1px solid #f3e8ff;
}

.diff-table-wrap {
  max-height: 220px;
  overflow-y: auto;
}

.diff-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}

.diff-table th {
  background: #f8fafc;
  padding: 6px 10px;
  text-align: left;
  font-weight: 600;
  color: #475569;
  border-bottom: 1px solid #e2e8f0;
}

.diff-table td {
  padding: 6px 10px;
  border-bottom: 1px solid #f1f5f9;
  vertical-align: top;
}

.tr-diff {
  background: #fffbeb;
}

.tr-perfect {
  background: #ffffff;
}

.col-name {
  font-weight: 600;
  color: #1e293b;
}

.rate-tag {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
}

.col-counts {
  color: #64748b;
}

.text-perfect {
  color: #16a34a;
  font-weight: 600;
}

.btn-toggle-examples {
  background: none;
  border: none;
  color: #7e22ce;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
  text-decoration: underline;
}

.btn-toggle-examples:hover {
  color: #581c87;
}

.diff-examples-box {
  margin-top: 6px;
  background: #fff;
  border: 1px solid #fed7aa;
  border-radius: 4px;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.diff-example-item {
  font-size: 10px;
  font-family: 'Menlo', monospace;
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
}

.ex-idx {
  font-weight: 600;
  color: #b45309;
}

.ex-out {
  color: #dc2626;
  background: #fee2e2;
  padding: 1px 4px;
  border-radius: 2px;
}

.ex-sep {
  color: #94a3b8;
}

.ex-bench {
  color: #15803d;
  background: #dcfce7;
  padding: 1px 4px;
  border-radius: 2px;
}

.diff-heal-bar {
  padding: 8px 12px;
  background: #faf5ff;
  border-top: 1px solid #f3e8ff;
  display: flex;
  justify-content: flex-end;
}

.btn-send-diff {
  background: #7e22ce;
  color: #fff;
  border: none;
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.btn-send-diff:hover {
  background: #6b21a8;
}
</style>
