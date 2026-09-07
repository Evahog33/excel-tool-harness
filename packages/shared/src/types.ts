export type MessageRole = 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  name: string
  arguments: string // JSON string
}

export interface SessionMessage {
  id: string
  role: MessageRole
  content: string
  /** 工具调用时使用 */
  toolCalls?: ToolCall[]
  /** 工具结果时使用 */
  toolCallId?: string
  toolName?: string
  createdAt: number
}

export type MaskRuleType =
  | 'id_card_mask'
  | 'phone_mask'
  | 'name_mask'
  | 'email_mask'
  | 'bank_card_mask'
  | 'amount_mask'
  | 'exclude'

export interface DesensitizationRuleConfig {
  column: string
  enabled: boolean
  ruleType: MaskRuleType
  label: string
}

export interface SensitiveColumnInfo {
  column: string
  type: string
  rule: string
  label: string
  reason: string
  desc: string
}

export interface ExcelMeta {
  fileId: string
  filename: string
  filepath: string
  fileSizeBytes: number
  uploadedAt: number
  sheets: string[]
  activeSheet: string
  rowCount: number
  columnCount: number
  headerLevels: number
  headerStartRow: number
  headerEndRow: number
  dataStartRow: number
  headers: string[]
  sampleRows: Record<string, any>[]
  sensitiveColumns: SensitiveColumnInfo[]
  desensitizationRules?: DesensitizationRuleConfig[]
  sanitizedSamples?: Record<string, any>[]
}

export type FormFieldValue = string | number | boolean | null | undefined

export type ToolRunParams = Record<string, FormFieldValue>

export interface UiFieldOption {
  label: string
  value: string
}

export type UiFieldType = 'text' | 'number' | 'file' | 'select' | 'checkbox'

export interface UiField {
  name: string
  label: string
  type: UiFieldType
  required?: boolean
  options?: (string | UiFieldOption)[]
  default?: string | number | boolean | UiFieldOption | null
  accept?: string
  description?: string
}

export interface UiSchema {
  title: string
  fields: UiField[]
}

export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: SessionMessage[]
  excelMeta?: ExcelMeta
  excelFiles?: ExcelMeta[]
  benchmarkFile?: ExcelMeta
  uiSchema?: UiSchema
  pythonCode?: string
}

export interface OutputFileMeta {
  filename: string
  filepath: string
}

export interface ToolExecutionResult {
  success: boolean
  durationMs?: number
  stdout?: string
  stderr?: string
  outputFiles?: OutputFileMeta[]
  error?: string
}

export interface MismatchExample {
  rowIdx: number
  keyValue?: string
  outputVal: any
  benchmarkVal: any
}

export interface ColumnDiffStat {
  column: string
  matchCount: number
  totalCount: number
  matchRate: number // 0 - 100
  mismatchExamples: MismatchExample[]
}

export interface DiffReport {
  success: boolean
  outputFilename: string
  benchmarkFilename: string
  outputRowCount: number
  benchmarkRowCount: number
  commonColumns: string[]
  missingColumns: string[] // 标杆有但产物缺少
  extraColumns: string[] // 产物有但标杆没有
  columnStats: ColumnDiffStat[]
  overallMatchRate: number // 0 - 100
  summaryText: string
  error?: string
}

