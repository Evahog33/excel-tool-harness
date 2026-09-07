import type { MaskRuleType, DesensitizationRuleConfig } from './types.js'

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
  let digits = str.replace(/\D/g, '')
  if (digits.length === 13 && digits.startsWith('86')) {
    digits = digits.slice(2)
  }
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

export function sanitizeSampleRows(
  sampleRows: Record<string, any>[],
  rules: (DesensitizationRuleConfig | { column: string; enabled: boolean; ruleType: MaskRuleType })[],
): Record<string, any>[] {
  const ruleMap = new Map(rules.filter((r) => r.enabled).map((r) => [r.column, r.ruleType]))

  return sampleRows.map((row) => {
    const sanitizedRow: Record<string, any> = {}
    for (const [col, val] of Object.entries(row)) {
      if (ruleMap.has(col)) {
        sanitizedRow[col] = applyMaskRule(val, ruleMap.get(col)!)
      } else {
        sanitizedRow[col] = val
      }
    }
    return sanitizedRow
  })
}
