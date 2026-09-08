---
id: data_cleaning
title: 数据清洗与长数字规范
keywords:
  - 清洗
  - 去空格
  - 换行
  - 表头
  - 长数字
  - 身份证
  - 订单号
  - 格式
  - 空值
  - 缺失值
description: 表头去污、空串与缺失值判定、长数字ID避免科学计数法与尾数抹零
---

# 数据清洗与长数字规范 Playbook

## 1. 长数字 ID 绝对保真（订单号 / 身份证 / 银行卡号）
- **核心风险**：Excel 内部对数字只有 15 位有效浮点精度。18~19 位订单号若作为数字读取或写入，最后几位会被永久篡改为 0 或出现碰撞！
- **正确规范**：
  1. 读取时必须强转为字符串：`df['订单号'] = df['订单号'].astype(str)` 或在 openpyxl 中按字符串读取。
  2. 写入 openpyxl 时，必须将单元格设为文本类型并写入字符串：
     ```python
     cell.number_format = '@'
     cell.value = str(raw_id)
     ```
  3. 使用 pandas 导出时，若包含超长数字，建议以字符串格式写入或使用 openpyxl 进行显式文本格式标注。

## 2. 表头去污与规范化
- 表头中常含前后空格、换行符（`\n`）、制表符或括号说明。
- 清洗范式：
  ```python
  import re
  def clean_header(col_name):
      if not isinstance(col_name, str):
          col_name = str(col_name)
      clean = col_name.replace('\n', '').replace('\r', '').strip()
      return clean
  df.columns = [clean_header(c) for c in df.columns]
  ```

## 3. 缺失值与空白字符串判定
- 明确区分 `None / NaN`（空值）与 `"" / "   "`（空文本/空白字符）：
  ```python
  # 纯空值判定 (None / np.nan)
  is_missing = df['金额'].isna()
  # 空白文本判定 (包含空串与全空格字符串)
  is_blank_str = df['备注'].apply(lambda x: isinstance(x, str) and x.strip() == '')
  ```
