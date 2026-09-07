/**
 * 前端脱敏引擎
 * 核心算法与类型复用 @excel-harness/shared
 */

import type { MaskRuleType } from '@excel-harness/shared'
export * from '@excel-harness/shared'

export interface DesensitizationRuleOption {
  value: MaskRuleType
  label: string
  desc: string
}

export const RULE_OPTIONS: DesensitizationRuleOption[] = [
  { value: 'id_card_mask', label: '18位身份证脱敏', desc: '保留前6后4位 (如 110101********1234)' },
  { value: 'phone_mask', label: '手机号掩码', desc: '保留前3后4位 (如 138****5678)' },
  { value: 'name_mask', label: '姓名脱敏', desc: '保留姓氏 (如 李*、张*明)' },
  { value: 'email_mask', label: '电子邮箱脱敏', desc: '保留首字母及域名 (如 z***@corp.com)' },
  { value: 'bank_card_mask', label: '银行卡号脱敏', desc: '保留前4后4位 (如 622202******1234)' },
  { value: 'amount_mask', label: '薪资金额掩码', desc: '保留最高位数量级 (如 2****.00)' },
  { value: 'exclude', label: '彻底剔除此列', desc: '发给大模型时完全忽略该列' },
]
