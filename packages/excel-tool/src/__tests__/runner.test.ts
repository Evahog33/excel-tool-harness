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

  test('runPython 防篡改机制：检测到恶意/误操作覆盖原输入文件时自动熔断并秒级还原', async () => {
    const originalFile = resolve('.sessions', 'test_original_input.csv')
    const originalContent = '姓名,年龄\n张三,18\n李四,20\n'
    writeFileSync(originalFile, originalContent, 'utf-8')

    try {
      // 模拟大模型编写的非法脚本：直接往原文件写入垃圾数据
      const maliciousCode = `
import os
input_path = PARAMS.get("input_file")
with open(input_path, "w", encoding="utf-8") as f:
    f.write("HACKED_CORRUPTED_DATA")
`
      const result = await runPython({
        code: maliciousCode,
        params: { input_file: originalFile },
      })

      // 1. 验证系统阻断：强制判定失败
      assert.equal(result.success, false)
      // 2. 验证告警信息已进入 stderr
      assert.match(result.stderr, /安全隔离警报/)
      assert.match(result.stderr, /检测到 Python 代码非法修改了原始输入文件/)
      // 3. 验证原文件已被秒级自动还原回初始内容
      const { readFileSync } = await import('fs')
      const restoredContent = readFileSync(originalFile, 'utf-8')
      assert.equal(restoredContent, originalContent, '原输入文件必须被自动还原，原数据绝不能丢失')
    } finally {
      try { unlinkSync(originalFile) } catch {}
    }
  })

  test('compareExcelFiles 目标模板模式：空模板或少量样表能精准识别并进行表头与结构契约核验', async () => {
    const outCsv = resolve('.sessions', 'test_template_out.csv')
    const benchCsv = resolve('.sessions', 'test_template_bench.csv')

    // 标杆为空模板（仅有表头，0行数据）
    writeFileSync(benchCsv, '部门,姓名,实发工资,绩效评级\n', 'utf-8')
    // 产物包含 6 行数据且完全对齐表头与顺序
    const outData = '部门,姓名,实发工资,绩效评级\n' +
      '研发部,张三,15000,A\n' +
      '研发部,李四,18000,S\n' +
      '市场部,王五,12000,B\n' +
      '市场部,赵六,14000,A\n' +
      '财务部,孙七,11000,A\n' +
      '财务部,周八,13000,B\n'
    writeFileSync(outCsv, outData, 'utf-8')

    try {
      const report = await compareExcelFiles(outCsv, benchCsv)
      assert.equal(report.success, true)
      assert.equal(report.mode, 'template', '应自动识别为模板契约核验模式')
      assert.equal(report.overallMatchRate, 100)
      assert.equal(report.templateChecks?.orderMatched, true)
      assert.equal(report.templateChecks?.missingColumns.length, 0)
      assert.equal(report.templateChecks?.columns.length, 4)
      assert.equal(report.templateChecks?.columns[0].populatedRate, 100)
      assert.match(report.summaryText, /100% 契合/)
    } finally {
      try { unlinkSync(outCsv) } catch {}
      try { unlinkSync(benchCsv) } catch {}
    }
  })

  test('compareExcelFiles 目标模板模式：当产物缺少模板关键列时准确定位并列出 missingColumns', async () => {
    const outCsv = resolve('.sessions', 'test_missing_col_out.csv')
    const benchCsv = resolve('.sessions', 'test_missing_col_bench.csv')

    // 标杆期望 4 列
    writeFileSync(benchCsv, '部门,姓名,实发工资,绩效评级\n', 'utf-8')
    // 产物缺少「实发工资」列
    writeFileSync(outCsv, '部门,姓名,绩效评级\n研发部,张三,A\n', 'utf-8')

    try {
      const report = await compareExcelFiles(outCsv, benchCsv, undefined, 'template')
      assert.equal(report.success, true)
      assert.equal(report.mode, 'template')
      assert.equal(report.overallMatchRate, 75) // 3/4 = 75%
      assert.equal(report.templateChecks?.missingColumns.includes('实发工资'), true)
      assert.match(report.summaryText, /缺少目标模板要求的 1 个字段/)
    } finally {
      try { unlinkSync(outCsv) } catch {}
      try { unlinkSync(benchCsv) } catch {}
    }
  })
})
