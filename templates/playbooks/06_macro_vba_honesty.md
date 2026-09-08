---
id: macro_vba_honesty
title: 宏与 VBA 诚实性准则
keywords:
  - 宏
  - vba
  - xlsm
  - 保留宏
  - 宏保真
description: openpyxl 无法可靠保存/重编译 VBA 宏的局限性、主动声明风险与拒绝假保真
---

# 宏与 VBA 诚实性准则 Playbook

## 1. 核心物理特征（openpyxl 的宏边界）
- Python openpyxl 库在保存带宏文件（`.xlsm`）时，即使用了 `keep_vba=True`，底层也仅仅是把 `xl/vbaProject.bin` 尝试原样打包。如果对工作表结构、单元格或命名进行了修改，Excel 打开时极易弹出“发现不可读取的内容”或提示宏已损坏/数字签名失效。
- 尤其是当用户明确要求 **“必须保留其中的 VBA 宏”** 且需要对表格做业务修改时，目前 Python 生态下（无专有 Windows COM / pywin32 真实 Excel 环境支持下）**无法可靠保全宏/VBA**。

## 2. 诚实合规行为规范（严禁谎报与欺瞒）
1. **主动点名并如实预警**：
   - 只要处理的文件是 `.xlsm` 或用户要求“保留宏/VBA”，必须在回复及 claims（若有 claims 要求）的 `notes` 或 `error` 中明确注明：
     `"openpyxl 无法可靠保全宏/VBA，在此类环境下无法保证宏完整不损坏"`。
2. **严禁声称成功（No Lie）**：
   - 如果用户强制要求“必须保留宏”，而你仅能用 Python openpyxl 做普通保存，此时**严禁在 claims 中声称 success: true**。
   - 必须设置 `"success": false`，并将原因点名归结为宏保真限制：`"无法在当前环境下可靠保留宏/VBA，已如实向用户声明限制"`。
3. **给用户的可行替代方案**：
   - 告知用户建议在真实的 Excel/WPS 客户端中执行宏，或导出纯数据表供用户通过“导入数据”方式接入现有宏工作簿。
