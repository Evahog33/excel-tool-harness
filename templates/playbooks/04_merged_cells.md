---
id: merged_cells
title: 合并单元格避坑与安全汇总
keywords:
  - 合并单元格
  - merged
  - 区域
  - 汇总
  - 分组
description: 掌握合并单元格仅左上角有值的特征，使用向下填充安全聚合
---

# 合并单元格避坑与安全汇总 Playbook

## 1. 核心物理特征
- **致命陷阱**：在 Excel 中，一个合并区域（例如 A2:A4 代表华东区）中，**只有左上角单元格（A2）存储了真实值**，A3、A4 在 openpyxl 和 pandas 读取时数值全部为 `None`！
- 若直接执行 `df.groupby('区域')['销售额'].sum()`，华东区后两行的数据会被归入 `None` 组，导致严重漏算！

## 2. 正确处理范式
- **方法一：Pandas 向下填充（ffill）**
  ```python
  import pandas as pd
  df = pd.read_excel(file_path)
  # 将合并列中的 None 用上一行的有效值填补
  df['区域'] = df['区域'].ffill()
  # 此时再进行安全分组求和
  result = df.groupby('区域', as_index=False)['销售额'].sum()
  ```
- **方法二：openpyxl 解析合并区间**
  通过 `ws.merged_cells.ranges` 获取所有合并单元格边界，遍历单元格时根据边界还原所属父级值。
