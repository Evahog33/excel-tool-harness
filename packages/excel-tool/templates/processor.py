"""
Excel Tool Harness — Python 执行引擎
此文件是 AI 生成脚本的参考模板，也是直接被 Node.js 调用的入口。

运行时变量（由 Node.js 注入）：
  PARAMS       - JSON 字符串，包含用户在右侧表单中填写的参数
  OUTPUT_DIR   - 结果文件应保存到此目录
"""

import os
import sys
import json
import pandas as pd
import traceback

# ── 运行时变量 ─────────────────────────────────────────────────────────────────

OUTPUT_DIR = os.environ.get("EXCEL_OUTPUT_DIR", "./output")
os.makedirs(OUTPUT_DIR, exist_ok=True)

try:
    PARAMS = json.loads(os.environ.get("EXCEL_PARAMS", "{}"))
except json.JSONDecodeError:
    PARAMS = {}

# ── 示例：手机号脱敏工具 ───────────────────────────────────────────────────────
# 以下是 AI 可能生成的脚本示例，实际代码由 LLM 在对话中动态生成

def mask_phone(phone: str) -> str:
    """将手机号中间 4 位替换为 ****"""
    phone = str(phone).strip()
    if len(phone) == 11:
        return phone[:3] + "****" + phone[7:]
    return phone

def run():
    input_file = PARAMS.get("input_file", "")
    phone_column = PARAMS.get("phone_column", "手机号")
    output_filename = PARAMS.get("output_filename", "result.xlsx")

    if not input_file or not os.path.exists(input_file):
        print(f"错误：找不到输入文件: {input_file}", file=sys.stderr)
        sys.exit(1)

    df = pd.read_excel(input_file)

    if phone_column not in df.columns:
        print(f"错误：找不到列 '{phone_column}'，现有列: {list(df.columns)}", file=sys.stderr)
        sys.exit(1)

    df[phone_column] = df[phone_column].apply(mask_phone)

    output_path = os.path.join(OUTPUT_DIR, output_filename)
    df.to_excel(output_path, index=False)
    print(f"✅ 处理完成，结果已保存到: {output_path}")
    print(f"   处理行数: {len(df)}")

if __name__ == "__main__":
    try:
        run()
    except Exception as e:
        print(f"执行出错: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
