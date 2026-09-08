---
id: template_filling
title: 模板填充与样式保真
keywords:
  - 模板
  - 填充
  - 占位符
  - 保留样式
  - 格式
  - 月报
description: 动态获取sheet名、占位符精准替换、保留原始单元格公式与样式
---

# 模板填充与样式保真 Playbook

## 1. 动态获取工作表名（黄金准则）
- **核心风险**：绝对不要猜测或硬编码 sheet 名（如硬编码 `sheet_name='销售明细'`）！
- **正确规范**：
  ```python
  import openpyxl
  wb = openpyxl.load_workbook(template_path)
  ws = wb.active # 默认使用当前激活工作表，或 wb[wb.sheetnames[0]]
  ```

## 2. 占位符精准替换
- 模板表头或说明常包含类似 `{{月份}}`、`{{日期}}` 的占位符。
- 遍历定位并替换，严禁覆盖整行或清除原单元格样式：
  ```python
  for row in ws.iter_rows():
      for cell in row:
          if cell.value and isinstance(cell.value, str) and '{{' in cell.value:
              cell.value = cell.value.replace('{{月份}}', report_month)
  ```

## 3. 按行填入聚合明细与更新汇总单元格
- 保持模板原有的表头颜色、字体大小与边框；
- 将部门合计按模板既定位置（如从第 3 行开始）逐行填入，并将总计金额填入预留单元格（如 B8），确保不会破坏周围既有公式。
