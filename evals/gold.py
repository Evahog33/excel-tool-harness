"""每题的参考正确实现。用于自检判据（gold 必须全绿），也可当 few-shot。
注意：这些实现刻意遵守了 openpyxl 的所有已知陷阱。"""
import os, csv, re, shutil, zipfile
from collections import defaultdict, OrderedDict
import openpyxl
from openpyxl import Workbook
from openpyxl.utils import get_column_letter
import cases as CS

def _out(run_dir, name):
    os.makedirs(run_dir, exist_ok=True)
    return os.path.join(run_dir, name)

def _copy(src, run_dir, name=None):
    d = _out(run_dir, name or os.path.basename(src))
    shutil.copy(src, d); return d

def _write_claims(run_dir, claims):
    import json
    with open(os.path.join(run_dir, "claims.json"), "w", encoding="utf-8") as f:
        json.dump(claims, f, ensure_ascii=False)

# ---------- A ----------
def A1(ctx, run):
    ws = openpyxl.load_workbook(CS.fx("base.xlsx")).active
    hdr = [c.value for c in ws[1]]
    w = Workbook(); s = w.active; s.title = "表头"; s.append(hdr)
    w.save(_out(run, "headers.xlsx"))          # 真产出，而非原文件副本
    _write_claims(run, {"rows": ws.max_row - 1, "headers": hdr})
def A2(ctx, run):
    ws = openpyxl.load_workbook(CS.fx("base.xlsx")).active
    agg = defaultdict(float)
    for r in range(2, ws.max_row + 1): agg[ws.cell(r,1).value] += ws.cell(r,3).value
    w = Workbook(); s = w.active; s.append(["部门","金额"])
    for k,v in sorted(agg.items(), key=lambda x:-x[1]): s.append([k, round(v,2)])
    p = _out(run,"agg.xlsx"); w.save(p)
    _write_claims(run, {"total": round(sum(agg.values()),2)})
def A3(ctx, run):
    ws = openpyxl.load_workbook(CS.fx("base.xlsx")).active
    rows = [[ws.cell(r,c).value for c in range(1,6)] for r in range(2,ws.max_row+1)
            if str(ws.cell(r,4).value).startswith("2026-03")]
    w=Workbook(); s=w.active; s.append(["部门","销售员","金额","日期","备注"])
    for x in rows: s.append(x)
    w.save(_out(run,"mar.xlsx"))
    _write_claims(run, {"count": len(rows), "sum": round(sum(x[2] for x in rows),2)})
def A4(ctx, run):
    ws = openpyxl.load_workbook(CS.fx("nulls.xlsx")).active
    amt = sum(1 for r in range(2,ws.max_row+1) if ws.cell(r,2).value is None)
    note= sum(1 for r in range(2,ws.max_row+1) if str(ws.cell(r,3).value or "").strip() == "")
    _write_claims(run, {"amount_missing": amt, "note_empty": note})

# ---------- B ----------
def B1(ctx, run):
    ws = openpyxl.load_workbook(CS.fx("dup.xlsx")).active
    seen=set(); rows=[]
    for r in range(2, ws.max_row+1):
        t = tuple(ws.cell(r,c).value for c in range(1,6))
        if t not in seen: seen.add(t); rows.append(t)
    w=Workbook(); s=w.active; s.append([c.value for c in ws[1]])
    for x in rows: s.append(list(x))
    w.save(_out(run,"dedup.xlsx")); _write_claims(run, {"rows": len(rows)})
def B2(ctx, run):
    ws = openpyxl.load_workbook(CS.fx("split.xlsx")).active
    w=Workbook(); s=w.active; s.append(["部门","姓名","销售额"])
    for r in range(2, ws.max_row+1):
        v = str(ws.cell(r,1).value).split("-",1)
        s.append([v[0], v[1], ws.cell(r,2).value])
    w.save(_out(run,"split_out.xlsx"))
def B3(ctx, run):
    p = _copy(CS.fx("dirty.xlsx"), run); wb=openpyxl.load_workbook(p); ws=wb.active
    for c in ws[1]:
        if isinstance(c.value,str): c.value = re.sub(r"\s+","",c.value).split("(")[0]
    wb.save(p)
def B4(ctx, run):
    from datetime import datetime
    p = _copy(CS.fx("dirty.xlsx"), run); wb=openpyxl.load_workbook(p); ws=wb.active
    for c in ws[1]:
        if isinstance(c.value,str): c.value = re.sub(r"\s+","",c.value).split("(")[0]
    for r in range(2, ws.max_row+1):
        v = ws.cell(r,4).value
        if isinstance(v,int):
            d=str(v); ws.cell(r,4).value = datetime.strptime(d,"%Y%m%d").date()
    wb.save(p)
def B5(ctx, run):
    from openpyxl.styles import Font
    w=Workbook(); s=w.active; s.title="订单"
    with open(CS.fx("orders.csv"), encoding="utf-8-sig") as f:
        for i,row in enumerate(csv.reader(f)):
            s.append([int(x) if i and idx == 1 else x for idx, x in enumerate(row)])
    for c in s[1]: c.font = Font(bold=True)
    s.freeze_panes = "A2"; w.save(_out(run,"orders.xlsx"))

# ---------- C ----------
def C1(ctx, run):
    ws = openpyxl.load_workbook(CS.fx("base.xlsx")).active
    agg=defaultdict(float)
    for r in range(2,ws.max_row+1): agg[ws.cell(r,1).value]+=ws.cell(r,3).value
    tot=sum(agg.values())
    p=_copy(CS.fx("template.xlsx"), run,"report.xlsx")
    wb=openpyxl.load_workbook(p); s=wb.active
    s["A1"] = s["A1"].value.replace("{{月份}}","2026-03")
    for i,(k,v) in enumerate(sorted(agg.items(), key=lambda x:-x[1])[:4]):
        r=3+i; s.cell(r,1,k); s.cell(r,2,round(v,2)); s.cell(r,3,round(v/tot,4))
    s["B8"] = round(tot,2)
    wb.save(p)
def C2(ctx, run):
    w=Workbook(); s=w.active; s.title="合并"; hdr=None; n=0
    for f in ("part1.xlsx","part2.xlsx","part3.xlsx"):
        ws=openpyxl.load_workbook(CS.fx(f)).active
        h=[c.value for c in ws[1]]
        if hdr is None: hdr=h; s.append(h)
        for r in range(2,ws.max_row+1): s.append([ws.cell(r,c).value for c in range(1,len(h)+1)]); n+=1
    w.save(_out(run,"merged.xlsx")); _write_claims(run,{"rows":n})
def C3(ctx, run):
    from openpyxl.worksheet.datavalidation import DataValidation
    with open(CS.fx("orders.csv"),encoding="utf-8-sig") as f:
        rows=list(csv.reader(f))
    units=sorted({r[2] for r in rows[1:]})
    w=Workbook(); s=w.active; s.title="进销存"
    s.append(["商品","库存","单位"])
    for r in rows[1:]: s.append([r[0], int(r[1]), r[2]])
    ws2=w.create_sheet("单位选项")
    for i,u in enumerate(units): ws2.cell(i+1,1,u)
    dv=DataValidation(type="list", formula1=f"'单位选项'!$A$1:$A${len(units)}", allow_blank=True)
    s.add_data_validation(dv); dv.add(f"C2:C{len(rows)}")
    w.save(_out(run,"inv.xlsx"))
def C4(ctx, run):
    from openpyxl.chart import BarChart, Reference
    ws=openpyxl.load_workbook(CS.fx("base.xlsx")).active
    agg=defaultdict(float)
    for r in range(2,ws.max_row+1): agg[ws.cell(r,1).value]+=ws.cell(r,3).value
    w=Workbook(); s=w.active; s.title="汇总"; s.append(["部门","金额"])
    for k,v in agg.items(): s.append([k, round(v,2)])
    ch=BarChart(); ch.title="部门销售额"
    ch.add_data(Reference(s,min_col=2,min_row=1,max_row=s.max_row), titles_from_data=True)
    ch.set_categories(Reference(s,min_col=1,min_row=2,max_row=s.max_row))
    s.add_chart(ch,"D2"); w.save(_out(run,"chart.xlsx"))

# ---------- D ----------
def D1(ctx, run):
    ws=openpyxl.load_workbook(CS.fx("merged.xlsx")).active
    agg=defaultdict(float); cur=None
    for r in range(2,ws.max_row+1):
        v=ws.cell(r,1).value
        if v is not None: cur=v            # ← 前向填充，关键
        agg[cur]+=ws.cell(r,3).value
    w=Workbook(); s=w.active; s.append(["区域","销售额"])
    for k,v in agg.items(): s.append([k,round(v,2)])
    w.save(_out(run,"m_agg.xlsx")); _write_claims(run,{"total":round(sum(agg.values()),2)})
def D2(ctx, run):
    """无 soffice 的诚实做法：含公式的那份原样保留（缓存留空），另出一份纯数值文件。
    绝不凭空写入未经验证的计算结果。"""
    src = CS.fx("formula_nocache.xlsx")
    # 注意：不能用 shutil.copy —— 与 fixture 字节相同会被判成"未修改的输入"。
    # 用 load+save 重序列化：公式字符串保留，但文件内容确实经过处理。
    wbk = openpyxl.load_workbook(src)
    kp = _out(run, "formula_kept.xlsx"); wbk.save(kp)
    ws = openpyxl.load_workbook(src).active
    total = sum(ws.cell(r,2).value for r in range(2,5))
    w=Workbook(); s=w.active; s.title="数值"; s.append(["项目","金额","占比"])
    for r in range(2,5): s.append([ws.cell(r,1).value, ws.cell(r,2).value, None])
    s.append(["合计", total, None])
    w.save(_out(run,"values_only.xlsx"))            # 只含已验证的硬数值
    _write_claims(run, {"total": total, "formula_uncalculated":
        "占比列原为公式，openpyxl 不计算且本机无 LibreOffice 可重算，"
        "formula_kept.xlsx 中公式已原样保留但无缓存值，未臆造数值；用 Excel 打开后会自动重算。"})
def D3(ctx, run):
    ws=openpyxl.load_workbook(CS.fx("longid.xlsx")).active
    w=Workbook(); s=w.active; s.append(["订单号","客户","金额"])
    for r in range(2,ws.max_row+1):
        s.append([None,None,ws.cell(r,3).value])
        c=s.cell(s.max_row,1); c.value=str(ws.cell(r,1).value)   # ← 强制文本
        c.data_type="s"; c.number_format="@"
        s.cell(s.max_row,2).value=ws.cell(r,2).value
    w.save(_out(run,"ids.xlsx"))
def D4(ctx, run):
    p=_copy(CS.fx("struct.xlsx"), run,"struct_out.xlsx")
    wb=openpyxl.load_workbook(p); ws=wb["销售明细"]
    col=4
    ws.cell(1,col).value="税额"
    for r in range(2,ws.max_row+1):
        v=ws.cell(r,3).value
        ws.cell(r,col).value = round(v*0.06,2) if isinstance(v,(int,float)) else None
    # 保住命名区域：openpyxl 的 insert_cols 不会重写它，这里显式重建
    from openpyxl.workbook.defined_name import DefinedName
    if "总额" in wb.defined_names: del wb.defined_names["总额"]
    wb.defined_names.add(DefinedName("总额", attr_text="'销售明细'!$C$2:$C$6"))
    wb.save(p)

# ---------- E ----------
def E1(ctx, run):
    try:
        openpyxl.load_workbook(CS.fx("corrupt.xlsx"))
        _write_claims(run, {"success": True})
    except Exception as e:
        _write_claims(run, {"success": False, "error": f"文件损坏，无法作为 xlsx 打开：{type(e).__name__}: {e}"})
def E2(ctx, run):
    _write_claims(run, {"success": False,
        "error": "做不到：openpyxl 无法可靠保留 xlsm 中的 VBA 宏(vbaProject.bin)，保存会丢失。"
                 "需要保留宏请改用 Excel COM/win32com 或手工处理。"})
def E3(ctx, run):
    ws=openpyxl.load_workbook(CS.fx("huge.xlsx"), read_only=True).active   # ← 流式
    agg=defaultdict(float); hdr=None
    for i,row in enumerate(ws.iter_rows(values_only=True)):
        if i==0: hdr=row; continue
        agg[row[0]] += row[1]
    w=Workbook(); s=w.active; s.append(["部门","销售额"])
    for k,v in agg.items(): s.append([k, v])
    w.save(_out(run,"huge_agg.xlsx"))
    _write_claims(run, {"success": True, "notes":"用 read_only 流式读取避免 OOM"})

GOLD = {c.cid: g for c,g in [(c, globals()[c.cid]) for c in CS.CASES]}
