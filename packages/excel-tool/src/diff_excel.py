#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Excel 标杆比对与对账引擎 (Ground Truth Diff Engine)
输入：output_path, benchmark_path
输出：标准结构化 JSON 报告，包含各列匹配率、缺失列、多余列与具体差异单元格范例
"""

import sys
import os
import json
import io
import math
from typing import Dict, List, Any, Optional, Tuple

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')


import pandas as pd
import numpy as np

def load_excel_flexible(file_path: str) -> pd.DataFrame:
    """鲁棒加载 Excel / CSV，兼容 .xlsx / .csv / .xls"""
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"文件不存在: {file_path}")
    
    ext = os.path.splitext(file_path)[1].lower()
    if ext == '.csv':
        try:
            return pd.read_csv(file_path, encoding='utf-8')
        except UnicodeDecodeError:
            return pd.read_csv(file_path, encoding='gbk')

    # 先尝试直接读取
    try:
        return pd.read_excel(file_path)
    except Exception as e1:
        # 如果是 .xls 但底层实为 ooxml(zip) 格式，使用字节流 openpyxl 读取
        try:
            import openpyxl
            with open(file_path, 'rb') as f:
                content = f.read()
            if content.startswith(b'PK\x03\x04'):
                return pd.read_excel(io.BytesIO(content), engine='openpyxl')
        except Exception:
            pass

        # 尝试 calamine 引擎
        try:
            return pd.read_excel(file_path, engine='calamine')
        except Exception:
            pass

        raise e1

def clean_col_name(c: Any) -> str:
    return str(c).strip() if c is not None else ""

def is_empty_val(v: Any) -> bool:
    if v is None:
        return True
    if isinstance(v, (float, int)) and (math.isnan(v) or np.isnan(v)):
        return True
    s = str(v).strip()
    return s == "" or s.lower() in ("nan", "none", "null", "#n/a")

def values_match(val_out: Any, val_bench: Any, float_tol: float = 0.05) -> bool:
    out_empty = is_empty_val(val_out)
    bench_empty = is_empty_val(val_bench)

    if out_empty and bench_empty:
        return True
    if out_empty != bench_empty:
        return False

    # 尝试按数值对比
    try:
        f_out = float(val_out)
        f_bench = float(val_bench)
        diff = abs(f_out - f_bench)
        if diff <= float_tol:
            return True
        # 相对误差
        if abs(f_bench) > 1e-4 and diff / abs(f_bench) <= 0.001:
            return True
        return False
    except (ValueError, TypeError):
        pass

    # 字符串精确对比（去前后空白）
    s_out = str(val_out).strip()
    s_bench = str(val_bench).strip()
    return s_out == s_bench

def compare_excel(output_path: str, benchmark_path: str) -> Dict[str, Any]:
    df_out = load_excel_flexible(output_path)
    df_bench = load_excel_flexible(benchmark_path)

    # 过滤末尾全空行与多余备注行（若某行只有第 1 列有超长备注文本且其他列全为空，则剔除）
    def filter_junk_rows(df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy()
        # 剔除全空行
        df = df.dropna(how='all')
        if len(df) > 0 and df.shape[1] > 2:
            last_row = df.iloc[-1]
            non_na_count = last_row.notna().sum()
            # 只有 1 列有值且以备注/说明开头
            if non_na_count == 1:
                first_val = str(last_row.dropna().iloc[0]).strip()
                if first_val.startswith(('备注', '说明', '注：', '注:')):
                    df = df.iloc[:-1]
        return df.reset_index(drop=True)

    df_out = filter_junk_rows(df_out)
    df_bench = filter_junk_rows(df_bench)

    df_out.columns = [clean_col_name(c) for c in df_out.columns]
    df_bench.columns = [clean_col_name(c) for c in df_bench.columns]

    # 过滤掉类似 Unnamed: 7 这种无名辅助列
    cols_out = [c for c in df_out.columns if c and not c.startswith('Unnamed:')]
    cols_bench = [c for c in df_bench.columns if c and not c.startswith('Unnamed:')]

    common_cols = [c for c in cols_bench if c in cols_out]
    missing_cols = [c for c in cols_bench if c not in cols_out]
    extra_cols = [c for c in cols_out if c not in cols_bench]

    output_rows = len(df_out)
    benchmark_rows = len(df_bench)

    # 自动探测主键列进行精准对齐
    key_candidates = [
        c for c in common_cols
        if any(k in c for k in ['名称', 'ID', 'id', '编号', '编码', '姓名', '卡号', '订单号'])
    ]
    key_col = None
    for cand in key_candidates:
        # 检查主键在标杆表中是否唯一
        s = df_bench[cand].dropna()
        if len(s) == s.nunique() and len(s) > 0:
            key_col = cand
            break

    # 若公共列第 1 列也是唯一的，可用作 key
    if not key_col and len(common_cols) > 0:
        first_col = common_cols[0]
        s = df_bench[first_col].dropna()
        if len(s) == s.nunique() and len(s) > 0:
            key_col = first_col

    # 构建对齐映射
    aligned_pairs: List[Tuple[Optional[pd.Series], Optional[pd.Series], int, Optional[str]]] = []
    if key_col:
        out_map = {str(row[key_col]).strip(): row for _, row in df_out.iterrows() if not is_empty_val(row[key_col])}
        for idx, row_b in df_bench.iterrows():
            k = str(row_b[key_col]).strip() if not is_empty_val(row_b[key_col]) else None
            row_o = out_map.get(k) if k else None
            aligned_pairs.append((row_o, row_b, idx + 1, k))
    else:
        max_len = max(output_rows, benchmark_rows)
        for i in range(max_len):
            row_o = df_out.iloc[i] if i < output_rows else None
            row_b = df_bench.iloc[i] if i < benchmark_rows else None
            aligned_pairs.append((row_o, row_b, i + 1, None))

    # 逐列统计
    column_stats = []
    total_cells = 0
    matched_cells = 0

    for col in common_cols:
        col_match = 0
        col_total = len(aligned_pairs)
        mismatches = []

        for row_o, row_b, row_idx, key_val in aligned_pairs:
            vo = row_o.get(col) if row_o is not None else None
            vb = row_b.get(col) if row_b is not None else None

            if values_match(vo, vb):
                col_match += 1
            else:
                if len(mismatches) < 8:
                    mismatches.append({
                        "rowIdx": row_idx,
                        "keyValue": key_val,
                        "outputVal": None if is_empty_val(vo) else (round(float(vo), 4) if isinstance(vo, (int, float)) else str(vo)[:80]),
                        "benchmarkVal": None if is_empty_val(vb) else (round(float(vb), 4) if isinstance(vb, (int, float)) else str(vb)[:80]),
                    })

        rate = round((col_match / col_total * 100), 2) if col_total > 0 else 100.0
        total_cells += col_total
        matched_cells += col_match

        column_stats.append({
            "column": col,
            "matchCount": col_match,
            "totalCount": col_total,
            "matchRate": rate,
            "mismatchExamples": mismatches
        })

    overall_rate = round((matched_cells / total_cells * 100), 2) if total_cells > 0 else 0.0

    # 生成文字摘要
    perfect_cols = [c["column"] for c in column_stats if c["matchRate"] >= 99.99]
    imperfect_cols = [c for c in column_stats if c["matchRate"] < 99.99]

    summary_parts = []
    summary_parts.append(f"共对账 {len(aligned_pairs)} 行数据，包含 {len(common_cols)} 个公共对比字段。")
    if key_col:
        summary_parts.append(f"（已按主键「{key_col}」自动匹配）")
    if missing_cols:
        summary_parts.append(f"⚠️ 标杆缺失列: {', '.join(missing_cols)}；")
    if extra_cols:
        summary_parts.append(f"ℹ️ 产物扩展列: {', '.join(extra_cols)}；")
    if perfect_cols:
        summary_parts.append(f"✅ 满分列 ({len(perfect_cols)} 个): {', '.join(perfect_cols)}；")
    if imperfect_cols:
        diff_desc = [f"「{c['column']}」({c['matchRate']}%)" for c in imperfect_cols]
        summary_parts.append(f"❌ 存在差异列: {', '.join(diff_desc)}。")
    else:
        summary_parts.append("🎉 所有公共字段匹配率 100%！")

    return {
        "success": True,
        "outputFilename": os.path.basename(output_path),
        "benchmarkFilename": os.path.basename(benchmark_path),
        "outputRowCount": output_rows,
        "benchmarkRowCount": benchmark_rows,
        "commonColumns": common_cols,
        "missingColumns": missing_cols,
        "extraColumns": extra_cols,
        "columnStats": column_stats,
        "overallMatchRate": overall_rate,
        "summaryText": "".join(summary_parts),
    }

def main():
    if len(sys.argv) < 3:
        print(json.dumps({
            "success": False,
            "error": "参数不足，用法: python diff_excel.py <output_excel> <benchmark_excel>"
        }, ensure_ascii=False))
        sys.exit(1)

    out_file = sys.argv[1]
    bench_file = sys.argv[2]

    try:
        report = compare_excel(out_file, bench_file)
        print(json.dumps(report, ensure_ascii=False, indent=2))
    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": f"执行对比失败: {str(e)}"
        }, ensure_ascii=False))
        sys.exit(1)

if __name__ == '__main__':
    main()
