---
id: large_file_streaming
title: 超大文件只读流式处理与内存防爆
keywords:
  - 超大文件
  - 大表
  - 流式
  - read_only
  - 内存
  - 超时
  - 40万
description: 海量数据使用 read_only=True 流式迭代，避免 OOM 内存溢出与进程超时
---

# 超大文件只读流式处理与内存防爆 Playbook

## 1. 核心物理特征
- 当 Excel 文件达到数十万行（如 40 万行、数百 MB XML）时，若使用 `openpyxl.load_workbook(path)` 默认全量加载，会将全部 XML 节点反序列化为数十倍大小的 Python DOM 对象，瞬间吞噬数 GB 内存导致系统 OOM 崩溃或严重超时！

## 2. 正确流式处理规范
- **只读流式模式（read_only=True）**：
  ```python
  import openpyxl

  # 必须开启 read_only=True 且关闭 data_only 带来的多余解析
  wb = openpyxl.load_workbook(file_path, read_only=True)
  ws = wb.active

  # 获取表头
  rows_iter = ws.iter_rows(values_only=True)
  headers = next(rows_iter)
  dept_idx = headers.index('部门')
  amount_idx = headers.index('销售额')

  # 流式增量累加（极度节省内存）
  dept_totals = {}
  for row in rows_iter:
      dept = row[dept_idx]
      amount = row[amount_idx]
      if dept and amount is not None:
          dept_totals[dept] = dept_totals.get(dept, 0.0) + float(amount)

  wb.close()
  ```
- **超时与进度诚实说明**：
  若由于文件过大在限时内无法完成，必须在输出及 claims 中诚实说明原因（如“文件过大，触发超时保护，建议采用流式读取分块处理”）。
