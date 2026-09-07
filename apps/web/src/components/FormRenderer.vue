<template>
  <form class="form" @submit.prevent="handleSubmit">
    <div v-for="field in schema.fields" :key="field.name" class="form-field">
      <label class="field-label">
        {{ field.label }}
        <span v-if="field.required" class="required">*</span>
      </label>
      <p v-if="field.description" class="field-desc">{{ field.description }}</p>

      <!-- 文件上传槽位 -->
      <div v-if="field.type === 'file'" class="file-slot-wrap">
        <div v-if="filePreviews[field.name]" class="file-badge">
          <span class="file-badge-icon">📄</span>
          <span class="file-badge-text" :title="filePreviews[field.name]">
            {{ filePreviews[field.name] }}
          </span>
          <button type="button" class="btn-replace" @click="triggerFieldInput(field.name)">
            更换新文件
          </button>
        </div>

        <input
          :ref="(el) => { if (el) fileInputRefs[field.name] = el as HTMLInputElement }"
          type="file"
          :accept="field.accept || '.xlsx,.csv'"
          class="file-input"
          :class="{ 'file-input--hidden': !!filePreviews[field.name] }"
          @change="onFileChange(field.name, $event)"
        />

        <div v-if="uploadingFields[field.name]" class="upload-status">
          <span class="spinner">⏳</span> 正在上传新文件到沙箱…
        </div>
      </div>

      <!-- 下拉选择 -->
      <select
        v-else-if="field.type === 'select'"
        v-model="values[field.name]"
        class="field-input"
      >
        <option value="" disabled>请选择…</option>
        <option
          v-for="(opt, oIdx) in field.options"
          :key="oIdx"
          :value="getOptionValue(opt)"
        >
          {{ getOptionLabel(opt) }}
        </option>
      </select>

      <!-- 复选框 -->
      <label v-else-if="field.type === 'checkbox'" class="checkbox-label">
        <input type="checkbox" v-model="values[field.name]" />
        <span>{{ field.label }}</span>
      </label>

      <!-- 数字 -->
      <input
        v-else-if="field.type === 'number'"
        type="number"
        v-model="values[field.name]"
        class="field-input"
        :required="field.required"
      />

      <!-- 文本（默认） -->
      <input
        v-else
        type="text"
        v-model="values[field.name]"
        class="field-input"
        :placeholder="`请输入 ${field.label}`"
        :required="field.required"
      />
    </div>

    <button type="submit" class="btn-run" :disabled="effectiveRunning || isAnyUploading">
      {{ effectiveRunning ? '⏳ 正在执行 Python 工具…' : isAnyUploading ? '⏳ 等待文件上传…' : '▶ 执行' }}
    </button>
  </form>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { useChatStore, type UiSchema, type ToolRunParams } from '../stores/chat'

const props = withDefaults(
  defineProps<{
    schema: UiSchema
    loading?: boolean
  }>(),
  {
    loading: false,
  },
)
const emit = defineEmits<{ submit: [params: ToolRunParams] }>()

const store = useChatStore()
const values = reactive<Record<string, any>>({})
const filePreviews = reactive<Record<string, string>>({})
const uploadingFields = reactive<Record<string, boolean>>({})
const fileInputRefs = reactive<Record<string, HTMLInputElement>>({})
const runtimeUploadedPaths = new Set<string>()

const effectiveRunning = computed(() => props.loading)
const isAnyUploading = computed(() => Object.values(uploadingFields).some(Boolean))

function getOptionValue(opt: any): string {
  if (typeof opt === 'object' && opt !== null) {
    return String(opt.value ?? opt.label ?? '')
  }
  return String(opt ?? '')
}

function getOptionLabel(opt: any): string {
  if (typeof opt === 'object' && opt !== null) {
    return String(opt.label ?? opt.value ?? '')
  }
  return String(opt ?? '')
}

function initDefaults() {
  if (!props.schema?.fields) return
  const validMountedPaths = new Set(store.excelFiles.map((f) => f.filepath))
  let fileIdx = 0
  for (const field of props.schema.fields) {
    if (field.type === 'file') {
      const curr = values[field.name]
      // 响应式失效守卫：若当前绑定的路径已不在已挂载列表中（且不是沙箱运行时上传），清空幽灵路径
      if (curr && !validMountedPaths.has(curr) && !runtimeUploadedPaths.has(curr)) {
        delete values[field.name]
        delete filePreviews[field.name]
      }

      if (!values[field.name]) {
        const mapped = store.excelFiles[fileIdx] || store.excelFiles[0]
        if (mapped) {
          values[field.name] = mapped.filepath
          filePreviews[field.name] = `${mapped.filename} (使用当前示例)`
          fileIdx++
        }
      }
    } else if (values[field.name] === undefined) {
      if (field.type === 'checkbox') {
        values[field.name] = Boolean((field as any).default ?? false)
      } else if ((field as any).default !== undefined) {
        const def = (field as any).default
        values[field.name] = typeof def === 'object' && def !== null ? getOptionValue(def) : (field.type === 'number' ? Number(def) : String(def))
      } else if (field.type === 'select' && field.options && field.options.length > 0) {
        values[field.name] = getOptionValue(field.options[0])
      }
    }
  }
}

onMounted(initDefaults)
watch(() => [props.schema, store.excelFiles], initDefaults, { deep: true })

function triggerFieldInput(fieldName: string) {
  fileInputRefs[fieldName]?.click()
}

async function onFileChange(fieldName: string, event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return

  uploadingFields[fieldName] = true
  try {
    const res = await store.uploadRuntimeFile(file)
    values[fieldName] = res.filepath
    runtimeUploadedPaths.add(res.filepath)
    filePreviews[fieldName] = `${res.filename} (新上传文件)`
  } catch (err: any) {
    alert(`文件上传失败: ${err.message}`)
  } finally {
    uploadingFields[fieldName] = false
    target.value = '' // 重置 input 确保重新选择同名同路径文件仍能触发变更
  }
}

function handleSubmit() {
  // 1. 客户端前置必填校验（阻止文件或输入为空时静默提交）
  if (props.schema?.fields) {
    for (const field of props.schema.fields) {
      if (field.required) {
        const val = values[field.name]
        if (val === undefined || val === null || val === '') {
          alert(`请完善必填项: 「${field.label || field.name}」`)
          return
        }
      }
    }
  }

  // 2. 类型保真序列化（保留 boolean / number / string 原生类型，杜绝 Python 端 bool("false") 翻转）
  const params: ToolRunParams = {}
  for (const field of props.schema?.fields || []) {
    const rawVal = values[field.name]
    if (rawVal === undefined || rawVal === null || rawVal === '') {
      params[field.name] = null
      continue
    }
    if (field.type === 'checkbox') {
      params[field.name] = Boolean(rawVal)
    } else if (field.type === 'number') {
      const num = Number(rawVal)
      params[field.name] = isNaN(num) ? rawVal : num
    } else {
      params[field.name] = String(rawVal)
    }
  }
  emit('submit', params)
}
</script>

<style scoped>
.form { display: flex; flex-direction: column; gap: 18px; }
.form-field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 13px; font-weight: 600; color: #374151; }
.required { color: #ef4444; margin-left: 2px; }
.field-desc { font-size: 12px; color: #6b7280; }
.field-input {
  border: 1px solid #d1d5db; border-radius: 8px;
  padding: 8px 12px; font-size: 14px; outline: none; width: 100%;
}
.field-input:focus { border-color: #4f46e5; }

.file-slot-wrap { display: flex; flex-direction: column; gap: 6px; }

.file-badge {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  padding: 8px 12px;
  border-radius: 8px;
  gap: 8px;
}
.file-badge-icon { font-size: 16px; }
.file-badge-text {
  font-size: 12px;
  color: #166534;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.btn-replace {
  background: #fff;
  border: 1px solid #86efac;
  color: #15803d;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 5px;
  cursor: pointer;
  font-weight: 600;
}
.btn-replace:hover { background: #dcfce7; }

.file-input {
  border: 2px dashed #d1d5db; border-radius: 8px;
  padding: 10px 12px; font-size: 13px; cursor: pointer; background: #f9fafb;
}
.file-input:hover { border-color: #4f46e5; background: #eef2ff; }
.file-input--hidden { display: none; }

.upload-status {
  font-size: 11px;
  color: #4f46e5;
  font-weight: 500;
}

.checkbox-label { display: flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; }
.btn-run {
  background: #10b981; color: #fff; border: none; border-radius: 10px;
  padding: 12px; font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 8px;
  transition: all 0.2s;
}
.btn-run:hover:not(:disabled) { background: #059669; }
.btn-run:disabled { background: #9ca3af; cursor: not-allowed; }
</style>
