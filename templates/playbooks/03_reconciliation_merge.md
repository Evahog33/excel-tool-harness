---
id: reconciliation_merge
title: 多表合并与跨表对账
keywords:
  - 合并
  - 多文件
  - 纵向合并
  - 横向合并
  - 对账
  - 匹配
  - vlookup
description: 多文件结构对齐、仅保留首行表头、跨表关联与差异核对
---

# 多表合并与跨表对账 Playbook

## 1. 多表纵向合并（表头仅保留一次）
- **核心风险**：直接追加文件可能导致重复的表头行混入数据区。
- **正确规范**：
  ```python
  import pandas as pd
  dfs = []
  for f in file_list:
      df = pd.read_excel(f)
      dfs.append(df)
  merged_df = pd.concat(dfs, ignore_index=True)
  ```
- **表头保真（严禁新增非必要列）**：除非用户明确要求标记来源，否则合并后的表格必须严格保持原表的列结构，**绝对禁止私自添加“数据来源”、“来源文件”、“file_name”等未经请求的额外列**！

## 2. 跨表 VLOOKUP 与关联对账
- 使用主键进行对齐，若存在未匹配项（NaN）必须明确标记并在控制台输出统计。
- 对账模式下，输出两表的差异明细与比对结果。
