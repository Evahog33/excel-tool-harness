import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PYTHON_CMD, runPython, inspectExcel, checkPythonSyntax, compareExcelFiles } from '../python-runner.ts'
import { writeFileSync, unlinkSync } from 'fs'

import { resolve } from 'path'

describe('Python Runner 与 Inspector 运行环境验证', () => {
  test('平台 Python 命令自适应', () => {
    if (process.platform === 'win32') {
      assert.equal(DEFAULT_PYTHON_CMD, 'python')
    } else {
      assert.equal(DEFAULT_PYTHON_CMD, 'python3')
    }
  })

  test('runPython 执行基础计算与输出捕获', async () => {
    const result = await runPython({
      code: 'print("HELLO_EXCEL_TOOL_HARNESS")',
    })
    assert.equal(result.success, true)
    assert.match(result.stdout, /HELLO_EXCEL_TOOL_HARNESS/)
  })

  test('checkPythonSyntax 识别合法代码与语法错误', async () => {
    const validCode = 'import pandas as pd\ndef process(x):\n    return x * 2\n'
    const validResult = await checkPythonSyntax(validCode)
    assert.equal(validResult.success, true)

    const invalidCode = 'import pandas as pd\ndef invalid_syntax(x:\n    return x\n'
    const invalidResult = await checkPythonSyntax(invalidCode)
    assert.equal(invalidResult.success, false)
    assert.match(invalidResult.stderr, /SyntaxError/)
  })

  test('inspectExcel 解析 CSV 文件与敏感列特征识别', async () => {
    const testCsv = resolve('.sessions', 'test_runner_sample.csv')
    const csvContent = [
      '姓名,手机号,身份证号,部门,金额',
      '张三,13800000000,110101199003072345,研发部,15000',
      '李四,13900000000,110101199205011234,设计部,18000',
    ].join('\n')
    writeFileSync(testCsv, csvContent, 'utf-8')

    try {
      const result = await inspectExcel(testCsv)
      assert.equal(result.rowCount, 2)
      assert.equal(result.columnCount, 5)
      assert.deepEqual(result.headers, ['姓名', '手机号', '身份证号', '部门', '金额'])
      assert.ok(result.sensitiveColumns.length >= 3)
    } finally {
      try { unlinkSync(testCsv) } catch {}
    }
  })

  test('runPython 支持 ToolRunParams 原生布尔值与数值保真', async () => {
    const result = await runPython({
      code: [
        'is_asc = PARAMS.get("ascending")',
        'limit = PARAMS.get("limit")',
        '# 核心断言：原生 False 在 Python 中必须是 bool 类型且判定为假',
        'print(f"TYPE_ASC:{type(is_asc).__name__}|VAL_ASC:{is_asc}")',
        'print(f"TYPE_LIMIT:{type(limit).__name__}|VAL_LIMIT:{limit}")',
        'if is_asc:',
        '    print("BRANCH:TRUE")',
        'else:',
        '    print("BRANCH:FALSE")',
      ].join('\n'),
      params: {
        ascending: false,
        limit: 100,
      },
    })
    assert.equal(result.success, true)
    assert.match(result.stdout, /TYPE_ASC:bool\|VAL_ASC:False/)
    assert.match(result.stdout, /TYPE_LIMIT:int\|VAL_LIMIT:100/)
    assert.match(result.stdout, /BRANCH:FALSE/)
  })

  test('runPython 开启 isPreflight 时自动彻底清理瞬态产物目录', async () => {
    const result = await runPython({
      code: 'import os; print("TEST_PREFLIGHT")',
      isPreflight: true,
    })
    assert.equal(result.success, true)
    if (result.outputDir) {
      const { existsSync } = await import('fs')
      assert.equal(existsSync(result.outputDir), false, 'isPreflight 结束后 outputDir 必须被静默销毁')
    }
  })

  test('compareExcelFiles 对齐主键对比两个数据表并出具准确率报告', async () => {
    const csv1 = resolve('.sessions', 'test_diff_out.csv')
    const csv2 = resolve('.sessions', 'test_diff_bench.csv')
    const content1 = '供应商名称,金额,负责人\n公司A,100,张三\n公司B,200,李四\n'
    const content2 = '供应商名称,金额,负责人\n公司A,100,张三\n公司B,250,王五\n'
    writeFileSync(csv1, content1, 'utf-8')
    writeFileSync(csv2, content2, 'utf-8')
    try {
      const report = await compareExcelFiles(csv1, csv2)
      assert.equal(report.success, true)
      assert.equal(report.outputRowCount, 2)
      assert.equal(report.benchmarkRowCount, 2)
      assert.equal(report.commonColumns.length, 3)
      const supStat = report.columnStats.find((c) => c.column === '供应商名称')
      assert.equal(supStat?.matchRate, 100)
      const amtStat = report.columnStats.find((c) => c.column === '金额')
      assert.equal(amtStat?.matchRate, 50)
      assert.equal(amtStat?.mismatchExamples.length, 1)
      assert.equal(amtStat?.mismatchExamples[0].outputVal, 200)
      assert.equal(amtStat?.mismatchExamples[0].benchmarkVal, 250)
    } finally {
      try { unlinkSync(csv1) } catch {}
      try { unlinkSync(csv2) } catch {}
    }
  })
})
