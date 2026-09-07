<template>
  <div v-if="show" class="modal-backdrop" @click.self="handleClose">
    <div class="modal-dialog">
      <!-- 头部 -->
      <div class="modal-header">
        <div class="header-left">
          <span class="header-icon">🛡️</span>
          <div>
            <h3 class="header-title">数据脱敏与隐私保护配置 — {{ meta.filename }}</h3>
            <p class="header-desc">
              在发送给大模型前完成本地脱敏，确保真实数据零泄漏。脱敏后仍保持业务特征认知。
            </p>
          </div>
        </div>
        <button class="btn-close" @click="handleClose">✕</button>
      </div>

      <!-- 主体内容 -->
      <div class="modal-body">
        <!-- 顶部操作栏与列多选区 -->
        <div class="config-section">
          <div class="section-title-bar">
            <span class="section-title">
              📋 选择脱敏列（共 {{ meta.columnCount }} 列，已保护 {{ enabledCount }} 列）
            </span>
            <div class="quick-actions">
              <button class="btn-action btn-recommend" @click="applyRecommended">
                ✨ 一键应用推荐脱敏
              </button>
              <button class="btn-action" @click="selectAll">全部勾选</button>
              <button class="btn-action" @click="clearAll">全部取消</button>
            </div>
          </div>

          <!-- 列选择卡片网格 -->
          <div class="column-grid">
            <div
              v-for="colRule in localRules"
              :key="colRule.column"
              :class="[
                'col-card',
                {
                  'col-card--enabled': colRule.enabled,
                  'col-card--sensitive': isRecommended(colRule.column) && !colRule.enabled,
                },
              ]"
            >
              <label class="col-card-header">
                <input
                  type="checkbox"
                  v-model="colRule.enabled"
                  class="col-checkbox"
                />
                <span class="col-name" :title="colRule.column">{{ colRule.column }}</span>
                <span
                  v-if="isRecommended(colRule.column)"
                  class="badge-sensitive"
                  :title="getSensitiveReason(colRule.column)"
                >
                  🛡️ 推荐: {{ getSensitiveLabel(colRule.column) }}
                </span>
              </label>

              <!-- 规则选择器（仅当勾选时展示） -->
              <div v-if="colRule.enabled" class="rule-selector-wrap">
                <select v-model="colRule.ruleType" class="rule-select">
                  <option
                    v-for="opt in RULE_OPTIONS"
                    :key="opt.value"
                    :value="opt.value"
                  >
                    {{ opt.label }}
                  </option>
                </select>
              </div>
            </div>
          </div>
        </div>

        <!-- 实时数据预览表格 -->
        <div class="preview-section">
          <div class="section-title-bar">
            <span class="section-title">
              👁️ 实时脱敏效果预览（前 {{ displayRows.length }} 行样本，即时响应）
            </span>
            <div class="preview-legend">
              <span class="legend-item legend--sanitized">🟢 绿色：已脱敏保护</span>
              <span class="legend-item legend--raw">⚪ 白色：未脱敏原始数据</span>
            </div>
          </div>

          <div class="table-container">
            <table class="preview-table">
              <thead>
                <tr>
                  <th class="th-index">#</th>
                  <th
                    v-for="col in meta.headers"
                    :key="col"
                    :class="[
                      'th-col',
                      {
                        'th--masked': isColMasked(col),
                        'th--warning': isRecommended(col) && !isColMasked(col),
                      },
                    ]"
                  >
                    <div class="th-content">
                      <span class="th-name" :title="col">{{ col }}</span>
                      <span v-if="isColMasked(col)" class="th-tag-masked">🛡️ 已保护</span>
                      <span v-else-if="isRecommended(col)" class="th-tag-warning">⚠️ 敏感未保护</span>
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, idx) in displayRows" :key="idx">
                  <td class="td-index">{{ idx + 1 }}</td>
                  <td
                    v-for="col in meta.headers"
                    :key="col"
                    :class="[
                      'td-cell',
                      {
                        'td--masked': isColMasked(col),
                        'td--warning': isRecommended(col) && !isColMasked(col),
                      },
                    ]"
                  >
                    <span :title="String(row[col] ?? '')">{{ row[col] ?? '-' }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- 底部操作栏 -->
      <div class="modal-footer">
        <div class="footer-tip">
          <span>💡 提示：点击保存后，发给大模型的仅为上述已脱敏的样本，真实全量数据保留在本地。</span>
        </div>
        <div class="footer-btns">
          <button class="btn btn-secondary" @click="handleClose">取消</button>
          <button class="btn btn-primary" :disabled="isSaving" @click="handlePreSubmit">
            {{ isSaving ? '保存中…' : '✓ 保存并应用脱敏' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ⚠️ 敏感列未保护风险确认弹窗 -->
    <div v-if="showWarningDialog" class="warning-backdrop" @click.self="showWarningDialog = false">
      <div class="warning-modal">
        <div class="warning-header">
          <span class="warning-icon">⚠️</span>
          <h4 class="warning-title">数据安全风险提示</h4>
        </div>
        <div class="warning-body">
          <p class="warning-text">
            系统检测到以下 <strong>{{ unmaskedSensitiveColumns.length }} 个敏感列</strong> 没有启用脱敏保护：
          </p>
          <ul class="warning-list">
            <li v-for="c in unmaskedSensitiveColumns" :key="c">
              <strong>{{ c }}</strong>
              <span class="warning-reason">（包含疑似 {{ getSensitiveLabel(c) }} 数据）</span>
            </li>
          </ul>
          <p class="warning-alert">
            🚨 若继续提交，这些敏感列的真实样例数据将直接发送给大模型，可能存在<strong>数据泄露风险</strong>。确认不脱敏并继续提交吗？
          </p>
        </div>
        <div class="warning-footer">
          <button class="btn btn-secondary" @click="showWarningDialog = false">
            ← 返回继续配置
          </button>
          <button class="btn btn-danger" @click="confirmSubmit">
            已知晓风险，强制提交
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue'
import type { ExcelMeta, DesensitizationRuleConfig } from '../stores/chat'
import { RULE_OPTIONS, applyMaskRule, type MaskRuleType } from '../utils/desensitize'

const props = defineProps<{
  show: boolean
  meta: ExcelMeta
}>()

const emit = defineEmits<{
  'update:show': [val: boolean]
  saved: [meta: ExcelMeta]
}>()

const isSaving = ref(false)
const showWarningDialog = ref(false)

// 本地草稿规则配置
const localRules = reactive<DesensitizationRuleConfig[]>([])

// 推荐的敏感列集合
const recommendedCols = computed(() => {
  return new Set(props.meta.sensitiveColumns.map((c) => c.column))
})

// 初始化本地规则
watch(
  () => [props.show, props.meta],
  () => {
    if (!props.show || !props.meta) return
    localRules.splice(0, localRules.length)

    // 如果已有配置则加载，否则根据推荐自动初始化
    const existingMap = new Map((props.meta.desensitizationRules || []).map((r) => [r.column, r]))
    const sensitiveMap = new Map(props.meta.sensitiveColumns.map((c) => [c.column, c]))

    for (const col of props.meta.headers) {
      if (existingMap.has(col)) {
        const existing = existingMap.get(col)!
        localRules.push({
          column: existing.column,
          enabled: existing.enabled,
          ruleType: existing.ruleType,
          label: existing.label,
        })
      } else {
        const sens = sensitiveMap.get(col)
        localRules.push({
          column: col,
          enabled: !!sens,
          ruleType: (sens ? sens.rule : 'id_card_mask') as MaskRuleType,
          label: sens ? sens.label : '未脱敏',
        })
      }
    }
  },
  { immediate: true, deep: true },
)

const enabledCount = computed(() => localRules.filter((r) => r.enabled).length)

function isRecommended(col: string): boolean {
  return recommendedCols.value.has(col)
}

function getSensitiveLabel(col: string): string {
  const s = props.meta.sensitiveColumns.find((c) => c.column === col)
  return s ? s.label : '敏感信息'
}

function getSensitiveReason(col: string): string {
  const s = props.meta.sensitiveColumns.find((c) => c.column === col)
  return s ? s.reason : ''
}

function isColMasked(col: string): boolean {
  const r = localRules.find((rule) => rule.column === col)
  return !!(r && r.enabled)
}

// 快捷操作
function applyRecommended() {
  const sensMap = new Map(props.meta.sensitiveColumns.map((c) => [c.column, c]))
  for (const r of localRules) {
    const s = sensMap.get(r.column)
    if (s) {
      r.enabled = true
      r.ruleType = s.rule as MaskRuleType
    } else {
      r.enabled = false
    }
  }
}

function selectAll() {
  for (const r of localRules) {
    r.enabled = true
  }
}

function clearAll() {
  for (const r of localRules) {
    r.enabled = false
  }
}

// 实时前端脱敏计算（零延迟）
const displayRows = computed(() => {
  const ruleMap = new Map(localRules.filter((r) => r.enabled).map((r) => [r.column, r.ruleType]))
  return props.meta.sampleRows.map((rawRow) => {
    const newRow: Record<string, any> = {}
    for (const [col, val] of Object.entries(rawRow)) {
      if (ruleMap.has(col)) {
        newRow[col] = applyMaskRule(val, ruleMap.get(col)!)
      } else {
        newRow[col] = val
      }
    }
    return newRow
  })
})

// 寻找未脱敏的系统推荐列
const unmaskedSensitiveColumns = computed(() => {
  return [...recommendedCols.value].filter((col) => !isColMasked(col))
})

// 提交前校验：是否有系统推荐但被取消勾选的敏感列
function handlePreSubmit() {
  if (unmaskedSensitiveColumns.value.length > 0) {
    showWarningDialog.value = true
    return
  }
  doSubmit()
}

function confirmSubmit() {
  showWarningDialog.value = false
  doSubmit()
}

async function doSubmit() {
  isSaving.value = true
  try {
    // 触发保存
    const finalRules = localRules.map((r) => ({
      column: r.column,
      enabled: r.enabled,
      ruleType: r.ruleType,
      label: r.enabled ? (RULE_OPTIONS.find((o) => o.value === r.ruleType)?.label ?? '已脱敏') : '未脱敏',
    }))
    emit('saved', {
      ...props.meta,
      desensitizationRules: finalRules,
    })
    handleClose()
  } finally {
    isSaving.value = false
  }
}

function handleClose() {
  emit('update:show', false)
}
</script>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-dialog {
  background: #fff;
  width: 92vw;
  max-width: 1080px;
  max-height: 88vh;
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
  overflow: hidden;
}

.modal-header {
  padding: 16px 20px;
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #fcfcfd;
}

.header-left { display: flex; align-items: center; gap: 12px; }
.header-icon { font-size: 26px; }
.header-title { margin: 0; font-size: 16px; font-weight: 700; color: #111827; }
.header-desc { margin: 2px 0 0; font-size: 12px; color: #6b7280; }
.btn-close { background: none; border: none; font-size: 18px; color: #9ca3af; cursor: pointer; padding: 4px 8px; border-radius: 6px; }
.btn-close:hover { background: #f3f4f6; color: #374151; }

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.section-title-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.section-title { font-size: 13px; font-weight: 700; color: #374151; }
.quick-actions { display: flex; gap: 8px; }
.btn-action {
  background: #f3f4f6; border: 1px solid #d1d5db; color: #374151;
  padding: 4px 10px; font-size: 12px; border-radius: 6px; cursor: pointer;
  transition: all 0.15s;
}
.btn-action:hover { background: #e5e7eb; }
.btn-recommend { background: #eff6ff; border-color: #93c5fd; color: #1d4ed8; font-weight: 600; }
.btn-recommend:hover { background: #dbeafe; }

.column-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
  max-height: 200px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid #f3f4f6;
  border-radius: 8px;
  background: #fafafa;
}

.col-card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: all 0.15s;
}
.col-card--enabled { border-color: #10b981; background: #f0fdf4; }
.col-card--sensitive { border-color: #f59e0b; background: #fffbeb; }

.col-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: #1f2937;
}
.col-checkbox { cursor: pointer; accent-color: #10b981; }
.col-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.badge-sensitive {
  font-size: 10px;
  background: #fef3c7;
  color: #b45309;
  padding: 1px 6px;
  border-radius: 4px;
  white-space: nowrap;
}

.rule-selector-wrap { margin-top: 2px; }
.rule-select {
  width: 100%;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  font-size: 11px;
  padding: 3px 6px;
  background: #fff;
  color: #334155;
  outline: none;
}
.rule-select:focus { border-color: #10b981; }

.preview-section { display: flex; flex-direction: column; }
.preview-legend { display: flex; gap: 12px; font-size: 11px; color: #6b7280; }
.legend--sanitized { color: #059669; font-weight: 600; }
.legend--raw { color: #6b7280; }

.table-container {
  overflow: auto;
  max-height: 260px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
}

.preview-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  text-align: left;
}

.preview-table th, .preview-table td {
  padding: 8px 12px;
  border: 1px solid #e5e7eb;
  white-space: nowrap;
}

.th-index, .td-index { width: 36px; text-align: center; background: #f9fafb; color: #9ca3af; }
.th-col { background: #f8fafc; color: #475569; font-weight: 600; }
.th-content { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.th-tag-masked { font-size: 10px; background: #d1fae5; color: #065f46; padding: 1px 5px; border-radius: 4px; }
.th-tag-warning { font-size: 10px; background: #fef3c7; color: #b45309; padding: 1px 5px; border-radius: 4px; }

.th--masked, .td--masked { background: #f0fdf4 !important; color: #166534; font-family: monospace; }
.th--warning, .td--warning { background: #fffbeb !important; color: #92400e; }

.modal-footer {
  padding: 14px 20px;
  border-top: 1px solid #e5e7eb;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fcfcfd;
}

.footer-tip { font-size: 12px; color: #64748b; }
.footer-btns { display: flex; gap: 10px; }

.btn {
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  border: none;
  transition: all 0.15s;
}
.btn-secondary { background: #f3f4f6; color: #374151; }
.btn-secondary:hover { background: #e5e7eb; }
.btn-primary { background: #10b981; color: #fff; }
.btn-primary:hover:not(:disabled) { background: #059669; }
.btn-primary:disabled { background: #a7f3d0; cursor: not-allowed; }
.btn-danger { background: #ef4444; color: #fff; }
.btn-danger:hover { background: #dc2626; }

/* 风险确认弹窗 */
.warning-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
}

.warning-modal {
  background: #fff;
  width: 90vw;
  max-width: 480px;
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
}

.warning-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.warning-icon { font-size: 24px; }
.warning-title { margin: 0; font-size: 16px; font-weight: 700; color: #b91c1c; }
.warning-body { font-size: 13px; color: #374151; line-height: 1.6; }
.warning-list {
  background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px;
  padding: 10px 24px; margin: 10px 0; max-height: 120px; overflow-y: auto;
}
.warning-reason { font-size: 12px; color: #991b1b; }
.warning-alert { font-size: 12px; color: #b91c1c; margin-top: 8px; }
.warning-footer { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
</style>
