import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { validateWorkbook } from '../python-runner.ts'

describe('validate_workbook 出厂回读质检引擎验证', () => {
  test('正常 CSV 文件：全项通过，判定为格式健全', async () => {
    const testFile = resolve('.sessions', 'test_valid_ok.csv')
    const content = '工号,姓名,部门,实发工资\n101,张三,技术部,15000\n102,李四,产品部,18000\n'
    writeFileSync(testFile, content, 'utf-8')

    try {
      const report = await validateWorkbook(testFile)
      assert.equal(report.status, 'healthy')
      assert.equal(report.statusLabel, '格式健全')
      assert.equal(report.rowCount, 2)
      assert.equal(report.columnCount, 4)
      assert.equal(report.errorTokenCount, 0)
      assert.equal(report.emptyColumnCount, 0)
      assert.ok(report.checks.every((c) => c.level === 'success'))
    } finally {
      try { unlinkSync(testFile) } catch {}
    }
  })

  test('包含 #DIV/0! 坏值单元格：精准捕获并判定为存在硬伤', async () => {
    const testFile = resolve('.sessions', 'test_error_div0.csv')
    const content = '指标,分子,分母,比率\n项目A,100,20,5\n项目B,200,0,#DIV/0!\n'
    writeFileSync(testFile, content, 'utf-8')

    try {
      const report = await validateWorkbook(testFile)
      assert.equal(report.status, 'critical')
      assert.equal(report.statusLabel, '存在硬伤')
      assert.equal(report.errorTokenCount, 1)

      const errorCheck = report.checks.find((c) => c.category === 'error_token')
      assert.equal(errorCheck?.level, 'critical')
      assert.match(errorCheck?.evidence || '', /#DIV\/0!/)
    } finally {
      try { unlinkSync(testFile) } catch {}
    }
  })

  test('输入表有数据但产物为 0 行空表：维度对账精准拦截致命硬伤', async () => {
    const inputFile = resolve('.sessions', 'test_input_500.csv')
    const outputFile = resolve('.sessions', 'test_output_empty.csv')
    writeFileSync(inputFile, '姓名,年龄\n张三,18\n李四,20\n王五,25\n', 'utf-8')
    writeFileSync(outputFile, '姓名,年龄\n', 'utf-8') // 仅有表头，无数据行

    try {
      const report = await validateWorkbook(outputFile, inputFile)
      assert.equal(report.status, 'critical')
      assert.equal(report.statusLabel, '存在硬伤')
      assert.equal(report.rowCount, 0)

      const dimCheck = report.checks.find((c) => c.category === 'dimension')
      assert.equal(dimCheck?.level, 'critical')
      assert.match(dimCheck?.detail || '', /原表有 3 行，但产物为 0 行空表/)
    } finally {
      try { unlinkSync(inputFile) } catch {}
      try { unlinkSync(outputFile) } catch {}
    }
  })

  test('数据全为空的废列：触发变动提醒 (Warning)', async () => {
    const testFile = resolve('.sessions', 'test_empty_col.csv')
    const content = '姓名,部门,空死列\n张三,技术部,\n李四,产品部,\n'
    writeFileSync(testFile, content, 'utf-8')

    try {
      const report = await validateWorkbook(testFile)
      assert.equal(report.status, 'warning')
      assert.equal(report.statusLabel, '变动提醒')
      assert.equal(report.emptyColumnCount, 1)

      const colCheck = report.checks.find((c) => c.category === 'columns')
      assert.equal(colCheck?.level, 'warning')
      assert.match(colCheck?.evidence || '', /空死列/)
    } finally {
      try { unlinkSync(testFile) } catch {}
    }
  })
})
