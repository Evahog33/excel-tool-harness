/**
 * 前端脱敏引擎
 * 保持数据长度、格式与语义，大模型依然能够感知数据特征
 */

export type MaskRuleType =
  | 'id_card_mask'
  | 'phone_mask'
  | 'name_mask'
  | 'email_mask'
  | 'bank_card_mask'
  | 'amount_mask'
  | 'exclude'

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

export function maskIdCard(val: string): string {
  const str = String(val ?? '').trim()
  if (!str) return str
  if (str.length === 18) {
    return str.slice(0, 6) + '********' + str.slice(14)
  }
  if (str.length === 15) {
    return str.slice(0, 6) + '******' + str.slice(12)
  }
  const keep = Math.max(2, Math.floor(str.length / 4))
  return str.slice(0, keep) + '*'.repeat(Math.max(4, str.length - keep * 2)) + str.slice(-keep)
}

export function maskPhone(val: string): string {
  const str = String(val ?? '').trim()
  if (!str) return str
  const digits = str.replace(/\D/g, '')
  if (digits.length === 11) {
    return digits.slice(0, 3) + '****' + digits.slice(7)
  }
  if (digits.length >= 7) {
    return digits.slice(0, 3) + '***' + digits.slice(-3)
  }
  return str.slice(0, 1) + '***' + str.slice(-1)
}

export function maskName(val: string): string {
  const str = String(val ?? '').trim()
  if (!str) return str
  if (str.length === 2) {
    return str[0] + '*'
  }
  if (str.length === 3) {
    return str[0] + '*' + str[2]
  }
  if (str.length === 4) {
    return str.slice(0, 2) + '*' + str.slice(3)
  }
  if (str.length > 4) {
    return str.slice(0, 2) + '*'.repeat(str.length - 3) + str.slice(-1)
  }
  return str + '*'
}

export function maskEmail(val: string): string {
  const str = String(val ?? '').trim()
  if (!str || !str.includes('@')) return str
  const [username, domain] = str.split('@')
  const maskedUser = username.length <= 2 ? username[0] + '***' : username.slice(0, 2) + '***'
  return `${maskedUser}@${domain || 'example.com'}`
}

export function maskBankCard(val: string): string {
  const str = String(val ?? '').trim()
  if (!str) return str
  if (str.length >= 12) {
    return str.slice(0, 4) + '******' + str.slice(-4)
  }
  return str.slice(0, 2) + '****' + str.slice(-2)
}

export function maskAmount(val: string): string {
  const str = String(val ?? '').trim()
  if (!str) return str
  const num = parseFloat(str)
  if (isNaN(num)) return '****'
  const intPart = Math.floor(Math.abs(num)).toString()
  const maskedInt = intPart.length <= 1 ? '*' : intPart[0] + '*'.repeat(intPart.length - 1)
  return `${num < 0 ? '-' : ''}${maskedInt}.00`
}

export function applyMaskRule(val: any, ruleType: MaskRuleType): string {
  if (val === null || val === undefined || val === '') return ''
  const str = String(val)

  switch (ruleType) {
    case 'id_card_mask':
      return maskIdCard(str)
    case 'phone_mask':
      return maskPhone(str)
    case 'name_mask':
      return maskName(str)
    case 'email_mask':
      return maskEmail(str)
    case 'bank_card_mask':
      return maskBankCard(str)
    case 'amount_mask':
      return maskAmount(str)
    case 'exclude':
      return '[已排除]'
    default:
      return str
  }
}
