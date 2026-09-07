<template>
  <form class="form" @submit.prevent="handleSubmit">
    <div v-for="field in schema.fields" :key="field.name" class="form-field">
      <label class="field-label">
        {{ field.label }}
        <span v-if="field.required" class="required">*</span>
      </label>
      <p v-if="field.description" class="field-desc">{{ field.description }}</p>

      <!-- 文件上传 -->
      <div v-if="field.type === 'file'" class="file-input-wrap">
        <input
          type="file"
          :accept="field.accept"
          class="file-input"
          @change="onFileChange(field.name, $event)"
        />
        <span v-if="filePreviews[field.name]" class="file-name">📎 {{ filePreviews[field.name] }}</span>
      </div>

      <!-- 下拉选择 -->
      <select
        v-else-if="field.type === 'select'"
        v-model="values[field.name]"
        class="field-input"
      >
        <option value="" disabled>请选择…</option>
        <option v-for="opt in field.options" :key="opt" :value="opt">{{ opt }}</option>
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

    <button type="submit" class="btn-run" :disabled="isRunning">
      {{ isRunning ? '⏳ 执行中…' : '▶ 执行' }}
    </button>
  </form>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue'
import type { UiSchema } from '../stores/chat'

const props = defineProps<{ schema: UiSchema }>()
const emit = defineEmits<{ submit: [params: Record<string, string>] }>()

const values = reactive<Record<string, any>>({})
const filePreviews = reactive<Record<string, string>>({})
const isRunning = ref(false)

function onFileChange(fieldName: string, event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  filePreviews[fieldName] = file.name
  // 将文件路径（仅文件名）传给后端；真实场景需先上传文件到服务器
  values[fieldName] = file.name
}

async function handleSubmit() {
  isRunning.value = true
  try {
    const params: Record<string, string> = {}
    for (const [key, val] of Object.entries(values)) {
      params[key] = String(val ?? '')
    }
    emit('submit', params)
  } finally {
    // isRunning 由父组件控制重置
    setTimeout(() => { isRunning.value = false }, 500)
  }
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
.file-input-wrap { display: flex; flex-direction: column; gap: 6px; }
.file-input {
  border: 2px dashed #d1d5db; border-radius: 8px;
  padding: 12px; font-size: 13px; cursor: pointer; background: #f9fafb;
}
.file-input:hover { border-color: #4f46e5; background: #eef2ff; }
.file-name { font-size: 12px; color: #4f46e5; }
.checkbox-label { display: flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; }
.btn-run {
  background: #10b981; color: #fff; border: none; border-radius: 10px;
  padding: 12px; font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 8px;
}
.btn-run:hover:not(:disabled) { background: #059669; }
.btn-run:disabled { background: #6ee7b7; cursor: not-allowed; }
</style>
