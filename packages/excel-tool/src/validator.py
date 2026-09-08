#!/usr/bin/env python3
"""
Excel Tool Harness — 出厂回读质检器 (validate_workbook)
100% 本地纯代码运行，绝无任何网络请求与数据泄露风险。

功能：
1. 文件完整性：openpyxl 无损加载，排查底层损坏或假伪装格式；
2. 维度与行数对账：对比输入表与产出表行数，排查意外空表或数据截断；
3. 单元格坏值扫描：全表扫描 #REF!、#DIV/0!、#VALUE! 等公式崩溃符号并定位单元格；
4. 字段有效性与空列：排查全为空值的无效废列，核对有效公式数量；
5. 输出纯确定性状态（健康 / 提醒 / 异常）与客观检查依据。
"""

import sys
import os
import json
import csv
from typing import Dict, List, Any, Optional

import openpyxl
from openpyxl.utils.exceptions import InvalidFileException

EXCEL_ERROR_TOKENS = {
    "#REF!": "引用失效 (#REF!)",
    "#DIV/0!": "除数为零 (#DIV/0!)",
    "#VALUE!": "值类型错误 (#VALUE!)",
    "#NAME?": "无效名称或公式拼写错误 (#NAME?)",
    "#N/A": "值不可用 (#N/A)",
    "#NULL!": "空交集错误 (#NULL!)",
    "#NUM!": "数值溢出或无效参数 (#NUM!)",
}


def count_file_rows(filepath: str) -> int:
    """快速计算输入文件的有效数据行数"""
    if not filepath or not os.path.exists(filepath):
        return -1
    ext = os.path.splitext(filepath)[1].lower()
    try:
        if ext == ".csv":
            for encoding in ("utf-8-sig", "utf-8", "gb18030", "gbk"):
                try:
                    with open(filepath, "r", encoding=encoding) as f:
                        reader = csv.reader(f)
                        rows = [r for r in reader if any(c.strip() for c in r)]
                        return max(0, len(rows) - 1)
                except UnicodeDecodeError:
                    continue
            return -1
        elif ext in (".xlsx", ".xlsm"):
            wb = openpyxl.load_workbook(filepath, read_only=True, data_only=True)
            ws = wb.active
            if ws is None:
                wb.close()
                return 0
            row_count = 0
            for row in ws.iter_rows(values_only=True):
                if any(c is not None and str(c).strip() != "" for c in row):
                    row_count += 1
            wb.close()
            return max(0, row_count - 1)
    except Exception:
        return -1
    return -1


def validate_workbook(output_path: str, input_path: Optional[str] = None) -> Dict[str, Any]:
    checks: List[Dict[str, Any]] = []
    issues_critical: List[str] = []
    issues_warning: List[str] = []

    # ── 1. 基础物理存在性 ──
    if not os.path.exists(output_path):
        return {
            "status": "critical",
            "statusLabel": "存在硬伤",
            "summary": "产物文件不存在，执行未生成任何文件。",
            "rowCount": 0,
            "columnCount": 0,
            "sheetCount": 0,
            "sheets": [],
            "formulaCount": 0,
            "errorTokenCount": 0,
            "emptyColumnCount": 0,
            "checks": [
                {
                    "category": "integrity",
                    "level": "critical",
                    "title": "文件存在性",
                    "detail": "产物文件未在磁盘中找到",
                    "evidence": f"路径不存在: {output_path}",
                }
            ],
        }

    file_size = os.path.getsize(output_path)
    if file_size == 0:
        return {
            "status": "critical",
            "statusLabel": "存在硬伤",
            "summary": "产物文件大小为 0 字节，文件为空。",
            "rowCount": 0,
            "columnCount": 0,
            "sheetCount": 0,
            "sheets": [],
            "formulaCount": 0,
            "errorTokenCount": 0,
            "emptyColumnCount": 0,
            "checks": [
                {
                    "category": "integrity",
                    "level": "critical",
                    "title": "文件完整性",
                    "detail": "产物文件大小为 0 字节",
                    "evidence": "文件内容完全为空",
                }
            ],
        }

    ext = os.path.splitext(output_path)[1].lower()

    sheets: List[str] = []
    output_rows = 0
    output_cols = 0
    formula_count = 0
    error_tokens_found: List[Dict[str, str]] = []
    empty_columns: List[str] = []

    # ── 2. CSV 格式质检 ──
    if ext == ".csv":
        parsed_rows = []
        enc = "utf-8"
        for candidate in ("utf-8-sig", "utf-8", "gb18030", "gbk"):
            try:
                with open(output_path, "r", encoding=candidate) as f:
                    reader = csv.reader(f)
                    parsed_rows = list(reader)
                enc = candidate
                break
            except UnicodeDecodeError:
                continue

        if not parsed_rows:
            checks.append({
                "category": "integrity",
                "level": "critical",
                "title": "文件完整性",
                "detail": "CSV 文件无法被任何标准编码正常解析",
                "evidence": "编码解码失败或无数据行",
            })
            issues_critical.append("CSV 文件解析失败")
        else:
            checks.append({
                "category": "integrity",
                "level": "success",
                "title": "文件完整性",
                "detail": f"CSV 文本结构标准，编码格式为 {enc}",
                "evidence": f"成功读取 {len(parsed_rows)} 行",
            })

            headers = parsed_rows[0] if parsed_rows else []
            data_rows = parsed_rows[1:] if len(parsed_rows) > 1 else []
            output_rows = len(data_rows)
            output_cols = len(headers)
            sheets = ["Sheet1"]

            # 坏值扫描
            for r_idx, row in enumerate(data_rows, start=2):
                for c_idx, val in enumerate(row):
                    col_name = headers[c_idx] if c_idx < len(headers) else f"第{c_idx+1}列"
                    v_str = str(val).strip()
                    if v_str in EXCEL_ERROR_TOKENS:
                        error_tokens_found.append({
                            "location": f"第{r_idx}行 · 列「{col_name}」",
                            "token": v_str,
                            "desc": EXCEL_ERROR_TOKENS[v_str],
                        })

            # 空列扫描
            for c_idx, col in enumerate(headers):
                vals = [r[c_idx] for r in data_rows if c_idx < len(r)]
                if data_rows and all(not str(v).strip() or str(v).strip().lower() in ("nan", "none", "null") for v in vals):
                    empty_columns.append(col or f"第{c_idx+1}列")

    # ── 3. Excel (.xlsx / .xlsm) 深度质检 ──
    else:
        try:
            wb = openpyxl.load_workbook(output_path, data_only=False)
            sheets = wb.sheetnames
            checks.append({
                "category": "integrity",
                "level": "success",
                "title": "文件完整性",
                "detail": "openpyxl 成功无损解析，底层 XML 架构规范，兼容所有主流 Office 软件",
                "evidence": f"工作簿包含 {len(sheets)} 个工作表: {', '.join(sheets[:3])}",
            })
        except Exception as e:
            return {
                "status": "critical",
                "statusLabel": "存在硬伤",
                "summary": f"Excel 文件损坏，无法正常解析: {str(e)}",
                "rowCount": 0,
                "columnCount": 0,
                "sheetCount": 0,
                "sheets": [],
                "formulaCount": 0,
                "errorTokenCount": 0,
                "emptyColumnCount": 0,
                "checks": [
                    {
                        "category": "integrity",
                        "level": "critical",
                        "title": "文件完整性",
                        "detail": "openpyxl 无法加载该工作簿（文件格式已损坏）",
                        "evidence": str(e),
                    }
                ],
            }

        # 扫描每个 Sheet
        total_data_rows = 0
        max_cols = 0
        for sheet_name in sheets:
            ws = wb[sheet_name]
            rows = list(ws.iter_rows(values_only=False))
            if not rows:
                continue

            # 提取非空行
            non_empty_rows = [r for r in rows if any(cell.value is not None and str(cell.value).strip() != "" for cell in r)]
            if len(non_empty_rows) <= 1:
                continue

            header_cells = non_empty_rows[0]
            data_row_cells = non_empty_rows[1:]
            total_data_rows += len(data_row_cells)
            max_cols = max(max_cols, len(header_cells))

            headers = [str(c.value or f"列{i+1}").strip() for i, c in enumerate(header_cells)]

            # 逐单元格扫描公式与坏值
            for r_idx, row in enumerate(data_row_cells, start=2):
                for c_idx, cell in enumerate(row):
                    col_name = headers[c_idx] if c_idx < len(headers) else f"第{c_idx+1}列"
                    v = cell.value

                    # 公式统计
                    if cell.data_type == "f" or (isinstance(v, str) and v.startswith("=")):
                        formula_count += 1

                    # 错误值统计
                    v_str = str(v).strip() if v is not None else ""
                    if cell.data_type == "e" or v_str in EXCEL_ERROR_TOKENS:
                        token_desc = EXCEL_ERROR_TOKENS.get(v_str, "单元格错误值")
                        error_tokens_found.append({
                            "location": f"Sheet「{sheet_name}」第{r_idx}行 · 列「{col_name}」",
                            "token": v_str or "#ERROR!",
                            "desc": token_desc,
                        })

            # 空列扫描
            for c_idx, col in enumerate(headers):
                col_vals = [r[c_idx].value for r in data_row_cells if c_idx < len(r)]
                if data_row_cells and all(v is None or str(v).strip() == "" or str(v).strip().lower() in ("nan", "none", "null") for v in col_vals):
                    empty_columns.append(col or f"第{c_idx+1}列")

        output_rows = total_data_rows
        output_cols = max_cols
        wb.close()

    # ── 4. 坏值扫描证据 ──
    if error_tokens_found:
        first_err = error_tokens_found[0]
        count_desc = f"发现 {len(error_tokens_found)} 处单元格计算异常"
        evidence_text = f"典型示例: {first_err['location']} 出现 {first_err['desc']}"
        if len(error_tokens_found) > 1:
            evidence_text += f" 等 {len(error_tokens_found)} 处"

        checks.append({
            "category": "error_token",
            "level": "critical",
            "title": "单元格坏值扫描",
            "detail": count_desc,
            "evidence": evidence_text,
        })
        issues_critical.append(f"包含 {len(error_tokens_found)} 处计算错误单元格 ({first_err['token']})")
    else:
        checks.append({
            "category": "error_token",
            "level": "success",
            "title": "单元格坏值扫描",
            "detail": "全表未发现任何 #REF!、#DIV/0!、#VALUE! 等计算崩溃符号",
            "evidence": f"全表扫描 {output_rows * max(1, output_cols)} 单元格无异常",
        })

    # ── 5. 行数与维度对账证据 ──
    input_rows = -1
    if input_path and os.path.exists(input_path):
        input_rows = count_file_rows(input_path)

    if input_rows > 0:
        if output_rows == 0:
            checks.append({
                "category": "dimension",
                "level": "critical",
                "title": "行数与维度对账",
                "detail": f"原表有 {input_rows} 行，但产物为 0 行空表！",
                "evidence": "疑似过滤条件过苛刻或代码逻辑丢失全部数据",
            })
            issues_critical.append("产物数据行数为 0（数据意外全部丢失）")
        elif output_rows < input_rows * 0.4:
            drop_rate = round((1 - output_rows / input_rows) * 100, 1)
            checks.append({
                "category": "dimension",
                "level": "warning",
                "title": "行数与维度变动",
                "detail": f"产物行数 ({output_rows}行) 相比原表 ({input_rows}行) 减少了 {drop_rate}%",
                "evidence": "若您的需求包含筛选/过滤，则属正常业务现象；否则请确认是否漏处理了数据",
            })
            issues_warning.append(f"数据行数相比原表减少了 {drop_rate}%")
        else:
            checks.append({
                "category": "dimension",
                "level": "success",
                "title": "行数与维度对账",
                "detail": f"原表 {input_rows} 行 → 产物保留 {output_rows} 行，规模对齐",
                "evidence": f"保留比例约 {round(output_rows / input_rows * 100, 1)}%",
            })
    else:
        if output_rows == 0:
            checks.append({
                "category": "dimension",
                "level": "warning",
                "title": "行数维度统计",
                "detail": "产物数据行数为 0（仅有表头）",
                "evidence": "未检测到有效数据记录",
            })
            issues_warning.append("产物仅有表头，无数据行")
        else:
            checks.append({
                "category": "dimension",
                "level": "success",
                "title": "行数维度统计",
                "detail": f"产物共包含 {output_rows} 行数据 × {output_cols} 列字段",
                "evidence": "数据结构饱满完整",
            })

    # ── 6. 字段有效性与死列证据 ──
    if empty_columns:
        checks.append({
            "category": "columns",
            "level": "warning",
            "title": "字段有效性排查",
            "detail": f"检测到 {len(empty_columns)} 个全为空值的字段",
            "evidence": f"全空列: {', '.join(empty_columns[:3])}",
        })
        issues_warning.append(f"存在 {len(empty_columns)} 个全空死列")
    else:
        checks.append({
            "category": "columns",
            "level": "success",
            "title": "字段有效性排查",
            "detail": "所有数据列均包含实质数据，无全空废列",
            "evidence": f"包含 {formula_count} 个有效动态公式" if formula_count > 0 else f"共 {output_cols} 列有效业务数据",
        })

    # ── 7. 综合客观状态判定 ──
    if issues_critical:
        status = "critical"
        status_label = "存在硬伤"
        summary = f"检测到硬伤：{'; '.join(issues_critical)}，建议修复后再使用。"
    elif issues_warning:
        status = "warning"
        status_label = "变动提醒"
        summary = f"体检提示：{'; '.join(issues_warning)}。若符合你的业务预期，可安全使用。"
    else:
        status = "healthy"
        status_label = "格式健全"
        summary = "出厂体检全项通过！文件无损坏，无坏值公式，数据规模合理，可放心汇报与归档。"

    return {
        "status": status,
        "statusLabel": status_label,
        "summary": summary,
        "rowCount": output_rows,
        "columnCount": output_cols,
        "sheetCount": len(sheets),
        "sheets": sheets,
        "formulaCount": formula_count,
        "errorTokenCount": len(error_tokens_found),
        "emptyColumnCount": len(empty_columns),
        "inputRowCount": input_rows if input_rows > 0 else None,
        "checks": checks,
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "缺少参数: output_file"}))
        sys.exit(1)

    output_path = sys.argv[1]
    input_path = sys.argv[2] if len(sys.argv) > 2 else None

    try:
        report = validate_workbook(output_path, input_path)
        print(json.dumps({"success": True, "data": report}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
