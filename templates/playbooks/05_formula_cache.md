---
id: formula_cache
title: 无缓存公式保真与零伪造
keywords:
  - 公式
  - 无缓存
  - formula
  - 未计算
  - 诚实
description: openpyxl data_only 返回 None 的陷阱、原样保留公式表达式、禁止伪造假数据
---

# 无缓存公式保真与零伪造 Playbook

## 1. 核心物理特征（data_only 陷阱）
- 当一个包含公式的 Excel 文件从未被 Microsoft Excel 或 WPS 实际打开并重新保存过时，文件内部不包含任何公式预计算结果缓存（Cached Value）。
- 此时若使用 `openpyxl.load_workbook(..., data_only=True)` 读取公式单元格，将直接读到 `None`！

## 2. 诚实性与保真红线
1. **绝不凭空造数**：在没有外部独立且可靠的公式计算引擎（如 LibreOffice Calc 无头环境）介入时，绝对不允许虚构/伪造假数值。
2. **完整保留公式**：在生成或导出结果文件时，必须完整保留原公式字符串（例如 `=C2/SUM($C$2:$C$10)`）。
3. **清晰声明**：在 claims 或向用户回复中，明确报告公式属于“未计算/无缓存状态（formula_uncalculated）”，做到 100% 诚实。
