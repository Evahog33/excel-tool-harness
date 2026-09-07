import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  maskIdCard,
  maskPhone,
  maskName,
  maskEmail,
  maskBankCard,
  maskAmount,
  applyMaskRule,
  sanitizeSampleRows,
} from '../desensitize.ts'

describe('脱敏算法核心库', () => {
  test('身份证脱敏 (18位与15位)', () => {
    assert.equal(maskIdCard('110101199003072345'), '110101********2345')
    assert.equal(maskIdCard('110101900307234'), '110101******234')
  })

  test('手机号脱敏', () => {
    assert.equal(maskPhone('13812345678'), '138****5678')
    assert.equal(maskPhone('+86 13812345678'), '138****5678')
  })

  test('姓名脱敏', () => {
    assert.equal(maskName('张三'), '张*')
    assert.equal(maskName('李四五'), '李*五')
    assert.equal(maskName('欧阳六七'), '欧阳*七')
  })

  test('电子邮箱脱敏', () => {
    assert.equal(maskEmail('alice@corp.com'), 'al***@corp.com')
    assert.equal(maskEmail('a@corp.com'), 'a***@corp.com')
  })

  test('银行卡号脱敏', () => {
    assert.equal(maskBankCard('6222021234567890'), '6222******7890')
  })

  test('金额脱敏', () => {
    assert.equal(maskAmount('25000.50'), '2****.00')
    assert.equal(maskAmount('-1200'), '-1***.00')
  })

  test('批量样本行脱敏与列剔除', () => {
    const sampleRows = [
      { name: '张三', phone: '13812345678', salary: '20000', notes: '测试用户' },
    ]
    const rules = [
      { column: 'name', enabled: true, ruleType: 'name_mask' as const, label: '姓名' },
      { column: 'phone', enabled: true, ruleType: 'phone_mask' as const, label: '手机' },
      { column: 'notes', enabled: true, ruleType: 'exclude' as const, label: '备注' },
      { column: 'salary', enabled: false, ruleType: 'amount_mask' as const, label: '薪资' },
    ]
    const result = sanitizeSampleRows(sampleRows, rules)
    assert.equal(result[0].name, '张*')
    assert.equal(result[0].phone, '138****5678')
    assert.equal(result[0].notes, '[已排除]')
    assert.equal(result[0].salary, '20000') // 未启用的规则保留原值
  })
})
