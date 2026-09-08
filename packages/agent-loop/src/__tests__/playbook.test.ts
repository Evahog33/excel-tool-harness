import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { PlaybookManager } from '../playbook-loader.ts'

describe('Playbook 知识库与动态注入引擎', () => {
  test('成功加载 Playbook 模板并解析 Frontmatter 元数据', () => {
    const manager = new PlaybookManager()
    const macroMatches = manager.matchPlaybooks('把 macro.xlsm 的金额列乘以 1.1，必须保留其中的 VBA 宏', ['macro.xlsm'])
    assert.ok(macroMatches.length > 0, '应成功匹配到宏相关 Playbook')
    assert.strictEqual(macroMatches[0].id, 'macro_vba_honesty')
  })

  test('匹配长数字与清洗场景', () => {
    const manager = new PlaybookManager()
    const matches = manager.matchPlaybooks('清洗表头并保留 18 位身份证号码与订单号', ['users.xlsx'])
    assert.ok(matches.some((m) => m.id === 'data_cleaning'))
  })

  test('生成注入 System Prompt 的知识片段', () => {
    const manager = new PlaybookManager()
    const prompt = manager.formatPlaybookPrompt('合并单元格汇总销售额', ['merged.xlsx'])
    assert.ok(prompt.includes('合并单元格避坑与安全汇总'))
    assert.ok(prompt.includes('ffill'))
  })
})
