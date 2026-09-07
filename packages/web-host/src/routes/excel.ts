import Router from '@koa/router'
import type { Context } from 'cordis'
import { existsSync, mkdirSync, copyFileSync } from 'fs'
import { resolve, extname } from 'path'
import { randomUUID } from 'crypto'
import { inspectExcel, sanitizeSampleRows, compareExcelFiles } from '@excel-harness/excel-tool'
import type { ExcelMeta, DesensitizationRuleConfig } from '@excel-harness/shared'


const ALLOWED_EXCEL_EXTS = new Set(['.xlsx', '.csv'])

export function registerExcelRoutes(router: Router, ctx: Context) {
  // 上传并解析 Excel 数据源
  router.post('/api/sessions/:id/upload-excel', async (koaCtx) => {
    const session = ctx.sessions.get(koaCtx.params.id)
    if (!session) {
      koaCtx.status = 404
      koaCtx.body = { error: '会话不存在' }
      return
    }

    const rawFile = (koaCtx.request.files as any)?.file
    if (!rawFile) {
      koaCtx.status = 400
      koaCtx.body = { error: '未接收到上传的文件' }
      return
    }

    const files = Array.isArray(rawFile) ? rawFile : [rawFile]
    const uploadDir = resolve('.sessions', session.id, 'uploads')
    if (!existsSync(uploadDir)) {
      mkdirSync(uploadDir, { recursive: true })
    }

    const newMetas: ExcelMeta[] = []

    for (const file of files) {
      const originalName = file.originalFilename || file.newFilename || 'data.xlsx'
      const ext = extname(originalName).toLowerCase()
      if (ext === '.xls') {
        koaCtx.status = 400
        koaCtx.body = { error: `暂不支持旧版 Excel 97-2003 (.xls) 二进制格式，请在 Excel 中将其「另存为」.xlsx 格式后再上传` }
        return
      }
      if (!ALLOWED_EXCEL_EXTS.has(ext)) {
        koaCtx.status = 400
        koaCtx.body = { error: `不支持的文件格式: ${ext}，仅支持 .xlsx 与 .csv 数据文件` }
        return
      }

      const fileId = randomUUID()
      const targetPath = resolve(uploadDir, `${fileId}_${originalName}`)
      const tempPath = file.filepath || file.path

      copyFileSync(tempPath, targetPath)

      try {
        const inspection = await inspectExcel(targetPath)

        // 默认初始化脱敏规则：敏感列默认启用推荐规则，其他列不脱敏
        const sensitiveMap = new Map(inspection.sensitiveColumns.map((c) => [c.column, c]))
        const desensitizationRules: DesensitizationRuleConfig[] = inspection.headers.map((col) => {
          const sensitive = sensitiveMap.get(col)
          if (sensitive) {
            return {
              column: col,
              enabled: true,
              ruleType: sensitive.rule as any,
              label: sensitive.label,
            }
          }
          return {
            column: col,
            enabled: false,
            ruleType: 'id_card_mask',
            label: '未脱敏',
          }
        })

        const sanitizedSamples = sanitizeSampleRows(inspection.sampleRows, desensitizationRules)

        const excelMeta: ExcelMeta = {
          fileId,
          filename: originalName,
          filepath: targetPath,
          fileSizeBytes: file.size ?? 0,
          uploadedAt: Date.now(),
          sheets: inspection.sheets,
          activeSheet: inspection.activeSheet,
          rowCount: inspection.rowCount,
          columnCount: inspection.columnCount,
          headerLevels: inspection.headerLevels,
          headerStartRow: inspection.headerStartRow,
          headerEndRow: inspection.headerEndRow,
          dataStartRow: inspection.dataStartRow,
          headers: inspection.headers,
          sampleRows: inspection.sampleRows,
          sensitiveColumns: inspection.sensitiveColumns,
          desensitizationRules,
          sanitizedSamples,
        }

        newMetas.push(excelMeta)
      } catch (err: any) {
        koaCtx.status = 500
        koaCtx.body = { ok: false, error: `${originalName} 解析失败: ${err.message}` }
        return
      }
    }

    const allFiles = ctx.sessions.addExcelFiles(session.id, newMetas)
    koaCtx.body = {
      ok: true,
      excelFiles: allFiles,
      excelMeta: allFiles[0],
      newFiles: newMetas,
    }
  })

  // 针对指定 fileId 保存脱敏规则
  router.post('/api/sessions/:id/excel/:fileId/desensitize-config', async (koaCtx) => {
    const session = ctx.sessions.get(koaCtx.params.id)
    if (!session) {
      koaCtx.status = 404
      koaCtx.body = { error: '会话不存在' }
      return
    }
    const { fileId } = koaCtx.params
    const excelFiles = ctx.sessions.getExcelFiles(session.id)
    const target = excelFiles.find((f) => f.fileId === fileId)
    if (!target) {
      koaCtx.status = 404
      koaCtx.body = { error: '未找到指定的文件元数据' }
      return
    }

    const { rules } = (koaCtx.request.body as any) ?? {}
    if (!Array.isArray(rules)) {
      koaCtx.status = 400
      koaCtx.body = { error: 'rules 必须为数组' }
      return
    }

    const sanitizedSamples = sanitizeSampleRows(target.sampleRows, rules as any)
    const updatedFiles = ctx.sessions.updateExcelFile(session.id, fileId, {
      desensitizationRules: rules,
      sanitizedSamples,
    })
    const updatedTarget = updatedFiles.find((f) => f.fileId === fileId)

    koaCtx.body = { ok: true, excelMeta: updatedTarget, excelFiles: updatedFiles }
  })

  // 兼容单文件脱敏路由
  router.post('/api/sessions/:id/desensitize-config', async (koaCtx) => {
    const session = ctx.sessions.get(koaCtx.params.id)
    if (!session) {
      koaCtx.status = 404
      koaCtx.body = { error: '会话不存在' }
      return
    }
    const excelFiles = ctx.sessions.getExcelFiles(session.id)
    const { fileId, rules } = (koaCtx.request.body as any) ?? {}
    const target = fileId ? excelFiles.find((f) => f.fileId === fileId) : excelFiles[0]
    if (!target) {
      koaCtx.status = 400
      koaCtx.body = { error: '当前会话未挂载 Excel 文件' }
      return
    }
    if (!Array.isArray(rules)) {
      koaCtx.status = 400
      koaCtx.body = { error: 'rules 必须为数组' }
      return
    }

    const sanitizedSamples = sanitizeSampleRows(target.sampleRows, rules as any)
    const updatedFiles = ctx.sessions.updateExcelFile(session.id, target.fileId, {
      desensitizationRules: rules,
      sanitizedSamples,
    })
    const updatedTarget = updatedFiles.find((f) => f.fileId === target.fileId)
    koaCtx.body = { ok: true, excelMeta: updatedTarget, excelFiles: updatedFiles }
  })

  // 删除指定文件
  router.delete('/api/sessions/:id/excel/:fileId', async (koaCtx) => {
    const session = ctx.sessions.get(koaCtx.params.id)
    if (!session) {
      koaCtx.status = 404
      koaCtx.body = { error: '会话不存在' }
      return
    }

    const updatedFiles = ctx.sessions.removeExcelFile(session.id, koaCtx.params.fileId)
    koaCtx.body = { ok: true, excelFiles: updatedFiles, excelMeta: updatedFiles[0] || null }
  })

  // 清空所有文件
  router.delete('/api/sessions/:id/excel', async (koaCtx) => {
    const session = ctx.sessions.get(koaCtx.params.id)
    if (!session) {
      koaCtx.status = 404
      koaCtx.body = { error: '会话不存在' }
      return
    }

    ctx.sessions.clearExcelFiles(session.id)
    koaCtx.body = { ok: true, excelFiles: [], excelMeta: null }
  })

  // 上传并解析预期标杆 Excel (Ground Truth)
  router.post('/api/sessions/:id/upload-benchmark', async (koaCtx) => {
    const session = ctx.sessions.get(koaCtx.params.id)
    if (!session) {
      koaCtx.status = 404
      koaCtx.body = { error: '会话不存在' }
      return
    }

    const rawFile = (koaCtx.request.files as any)?.file
    if (!rawFile) {
      koaCtx.status = 400
      koaCtx.body = { error: '未接收到标杆文件' }
      return
    }

    const file = Array.isArray(rawFile) ? rawFile[0] : rawFile
    const originalName = file.originalFilename || file.newFilename || 'benchmark.xlsx'
    const ext = extname(originalName).toLowerCase()
    if (!ALLOWED_EXCEL_EXTS.has(ext) && ext !== '.xls') {
      koaCtx.status = 400
      koaCtx.body = { error: `不支持的文件格式: ${ext}，仅支持 .xlsx, .csv 或 .xls` }
      return
    }

    const uploadDir = resolve('.sessions', session.id, 'uploads')
    if (!existsSync(uploadDir)) {
      mkdirSync(uploadDir, { recursive: true })
    }

    const fileId = randomUUID()
    const targetPath = resolve(uploadDir, `${fileId}_benchmark_${originalName}`)
    const tempPath = file.filepath || file.path
    copyFileSync(tempPath, targetPath)

    try {
      const inspection = await inspectExcel(targetPath)
      const benchmarkMeta: ExcelMeta = {
        fileId,
        filename: originalName,
        filepath: targetPath,
        fileSizeBytes: file.size ?? 0,
        uploadedAt: Date.now(),
        sheets: inspection.sheets,
        activeSheet: inspection.activeSheet,
        rowCount: inspection.rowCount,
        columnCount: inspection.columnCount,
        headerLevels: inspection.headerLevels,
        headerStartRow: inspection.headerStartRow,
        headerEndRow: inspection.headerEndRow,
        dataStartRow: inspection.dataStartRow,
        headers: inspection.headers,
        sampleRows: inspection.sampleRows,
        sensitiveColumns: [],
      }

      ctx.sessions.setBenchmarkFile(session.id, benchmarkMeta)
      koaCtx.body = { ok: true, benchmarkFile: benchmarkMeta }
    } catch (err: any) {
      koaCtx.status = 500
      koaCtx.body = { ok: false, error: `标杆文件解析失败: ${err.message}` }
    }
  })

  // 删除已挂载的标杆文件
  router.delete('/api/sessions/:id/benchmark', async (koaCtx) => {
    const session = ctx.sessions.get(koaCtx.params.id)
    if (!session) {
      koaCtx.status = 404
      koaCtx.body = { error: '会话不存在' }
      return
    }

    ctx.sessions.clearBenchmarkFile(session.id)
    koaCtx.body = { ok: true }
  })

  // 执行产物与标杆文件的验收对比 (Diff 对账)
  router.post('/api/sessions/:id/compare-benchmark', async (koaCtx) => {
    const session = ctx.sessions.get(koaCtx.params.id)
    if (!session) {
      koaCtx.status = 404
      koaCtx.body = { error: '会话不存在' }
      return
    }

    const benchmark = session.benchmarkFile
    if (!benchmark || !benchmark.filepath || !existsSync(benchmark.filepath)) {
      koaCtx.status = 400
      koaCtx.body = { error: '当前会话未挂载预期标杆文件，请先上传标杆 Excel' }
      return
    }

    const { outputFilepath } = (koaCtx.request.body as any) ?? {}
    if (!outputFilepath || !existsSync(outputFilepath)) {
      koaCtx.status = 400
      koaCtx.body = { error: '未找到待对比的输出产物文件，请先运行工具生成产物' }
      return
    }

    try {
      const diff = await compareExcelFiles(outputFilepath, benchmark.filepath, process.env.PYTHON_PATH)
      koaCtx.body = { ok: true, diff }
    } catch (err: any) {
      koaCtx.status = 500
      koaCtx.body = { ok: false, error: `标杆对账比对失败: ${err.message}` }
    }
  })
}

