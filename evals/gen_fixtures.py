"""生成 20 题所需的全部 fixture。所有陷阱行为均已在 openpyxl 3.1.5 实测确认。"""
import os, csv, zipfile, shutil, random
from openpyxl import Workbook
from openpyxl.utils import get_column_letter
from openpyxl.workbook.defined_name import DefinedName

HERE = os.path.dirname(os.path.abspath(__file__))
FX = os.path.join(HERE, "fixtures")

def path(name): return os.path.join(FX, name)

# ============ 基础销售表（干净，用于 A/B 类） ============
DEPTS = ["华东","华北","华南","西南"]
def make_sales(fname, n=60, dup=0, dirty=False):
    wb = Workbook(); ws = wb.active; ws.title = "销售明细"
    ws.append(["部门","销售员","金额","日期","备注"])
    random.seed(42)
    for i in range(n):
        d = DEPTS[i % len(DEPTS)]
        amt = round(random.uniform(100, 9999), 2)
        ws.append([d, f"{d[:1]}{i:03d}", amt, f"2026-0{(i%8)+1}-{(i%27)+1:02d}", ""])
    if dirty:   # 表头带空格/换行 + 重复表头 + 类型混乱
        ws.cell(1,1).value = " 部门\n"
        ws.cell(1,4).value = "日期(YYYYMMDD)"
        for r in range(2, min(12, n+2)):
            ws.cell(r,4).value = 20260101 + r          # 日期被写成整数
        ws.cell(1,5).value = "备注"                     # 与 A 列同名场景另造
    for _ in range(dup):                               # 追加完全重复行
        src = random.randint(2, 5)
        ws.append([ws.cell(src,c).value for c in range(1,6)])
    wb.save(path(fname)); return path(fname)

# ============ D1: 合并单元格 + 按行汇总 ============
def make_merged():
    wb=Workbook(); ws=wb.active; ws.title="区域"
    ws.append(["区域","月份","销售额"])
    rows=[("华东","1月",100),("华东","2月",200),("华东","3月",300),
          ("华北","1月",400),("华北","2月",500),("华北","3月",600)]
    for r in rows: ws.append(list(r))
    ws.merge_cells("A2:A4"); ws.merge_cells("A5:A7")   # 值只在左上角，其余 None
    wb.save(path("merged.xlsx"))

# ============ D2: 含公式 + 缓存值陷阱 ============
def make_formula():
    wb=Workbook(); ws=wb.active; ws.title="财务"
    ws.append(["项目","金额","占比"])
    data=[("收入",10000),("成本",6000),("税费",800)]
    for i,(k,v) in enumerate(data, start=2):
        ws.cell(i,1,k); ws.cell(i,2,v); ws.cell(i,3,f"=B{i}/B5")
    ws.append(["合计","=SUM(B2:B4)","=SUM(C2:C4)"])
    wb.save(path("formula_nocache.xlsx"))            # 无缓存值：data_only 读到 None
    # 再造一个"有缓存值"的：用 LibreOffice/Excel 打开才会有，这里手工注入
    wb2=Workbook(); ws2=wb2.active; ws2.title="财务"
    ws2.append(["项目","金额","占比"])
    for i,(k,v,c) in enumerate([("收入",10000,1.0),("成本",6000,0.6),("税费",800,0.08)],start=2):
        ws2.cell(i,1,k); ws2.cell(i,2,v); ws2.cell(i,3,c)   # 只存值，无公式
    ws2.append(["合计",16800,1.68])
    wb2.save(path("formula_cached.xlsx"))

# ============ D3: 长数字 ID（写入即丢精度） ============
def make_longid():
    wb=Workbook(); ws=wb.active; ws.title="订单"
    ws.append(["订单号","客户","金额"])
    ids=["912345678901234567","912345678901234568","1234567890123456789",
         "6222020123456789012","912345678901234567"]
    for i,oid in enumerate(ids):
        ws.cell(i+2,1,oid)                            # 文本写入，正确姿势
        ws.cell(i+2,2,f"客户{i+1}"); ws.cell(i+2,3,(i+1)*100)
    wb.save(path("longid.xlsx"))
    # 反面教材：数字写入 → 精度已永久丢失
    wb2=Workbook(); ws2=wb2.active; ws2.title="订单"
    ws2.append(["订单号","客户","金额"])
    for i,oid in enumerate(ids):
        ws2.cell(i+2,1,int(oid) if len(oid)<19 else oid)
        ws2.cell(i+2,2,f"客户{i+1}"); ws2.cell(i+2,3,(i+1)*100)
    wb2.save(path("longid_broken.xlsx"))

# ============ D4: 中文sheet名 + 命名区域 + 隐藏列 + 插入列保真 ============
def make_struct():
    wb=Workbook(); ws=wb.active; ws.title="销售明细"
    ws.append(["单号","客户","金额"])
    for i in range(1,6): ws.append([f"S{i:03d}",f"客户{i}",i*1000])
    ws.column_dimensions["B"].hidden = True           # 隐藏列
    ws.freeze_panes = "A2"                            # 冻结窗格
    wb.defined_names.add(DefinedName("总额", attr_text="'销售明细'!$C$2:$C$6"))
    ws2=wb.create_sheet("参数表"); ws2.append(["税率"]); ws2.append([0.06])
    wb.save(path("struct.xlsx"))

# ============ C1: 模板 + 数据源 ============
def make_template():
    wb=Workbook(); ws=wb.active; ws.title="月报"
    ws["A1"]="{{月份}} 销售月报"; ws["A2"]="部门"; ws["B2"]="合计"; ws["C2"]="占比"
    for r in range(3,7): ws.cell(r,1,"{{部门}}"); ws.cell(r,2,"{{金额}}"); ws.cell(r,3,"{{占比}}")
    ws["A8"]="总计"; ws["B8"]="{{总计}}"
    wb.save(path("template.xlsx"))

# ============ B5/C3: csv ============
def make_csv():
    with open(path("orders.csv"),"w",newline="",encoding="utf-8-sig") as f:
        w=csv.writer(f); w.writerow(["商品","库存","单位"])
        for g,k,u in [("苹果",10,"公斤"),("香蕉",25,"箱"),("橙子",7,"瓶")]:
            w.writerow([g,k,u])

# ============ E1: 损坏的 xlsx ============
def make_corrupt():
    make_sales("e_good.xlsx", 10)
    p=path("corrupt.xlsx")
    with zipfile.ZipFile(p,"w") as z:                  # 合法 zip，但不是 xlsx
        z.writestr("readme.txt","this is not a workbook")
    # 更狠的一种：真 xlsx 但截断 sheetData
    src=path("e_good.xlsx"); dst=path("truncated.xlsx")
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst,"w",zipfile.ZIP_DEFLATED) as zout:
        for it in zin.infolist():
            data=zin.read(it.filename)
            if it.filename=="xl/worksheets/sheet1.xml":
                data=data[:len(data)//2]               # 半截 XML
            zout.writestr(it,data)

# ============ E2: 含 VBA 宏 ============
def make_macro():
    p=path("macro.xlsm")
    make_sales("e_src.xlsx",8)
    shutil.copy(path("e_src.xlsx"), p)                 # 伪装成 xlsm
    with zipfile.ZipFile(p) as z: names=z.namelist(); blobs={n:z.read(n) for n in names}
    blobs["xl/vbaProject.bin"]=b"PK\x03\x04fake-vba-binary-content"
    ct=blobs["[Content_Types].xml"]
    blobs["[Content_Types].xml"]=ct.replace(
        b"</Types>", b'<Override PartName="/xl/vbaProject.bin" '
        b'ContentType="application/vnd.ms-office.vbaProject"/></Types>')
    with zipfile.ZipFile(p,"w",zipfile.ZIP_DEFLATED) as z:
        for n,b in blobs.items(): z.writestr(n,b)

# ============ E3: 超大文件 ============
def make_huge(rows=400000):
    wb=Workbook(write_only=True); ws=wb.create_sheet("大表")
    ws.append(["部门","销售额","日期","备注"])
    depts = ["华东", "华北", "华南", "西南"]
    for i in range(rows):
        ws.append([depts[i % 4], (i % 500) + 10, "2026-03-01", ""])
    wb.save(path("huge.xlsx"))

def build_all(with_huge=True):
    os.makedirs(FX, exist_ok=True)
    make_sales("base.xlsx", 60)
    make_sales("dup.xlsx", 40, dup=8)
    make_sales("dirty.xlsx", 30, dirty=True)
    make_sales("month.xlsx", 45)
    make_merged(); make_formula(); make_longid(); make_struct()
    make_template(); make_csv(); make_corrupt(); make_macro()
    # 多文件合并用
    for i in (1,2,3):
        wb=Workbook(); ws=wb.active; ws.title="数据"
        ws.append(["部门","金额"])
        for r in range(3): ws.append([DEPTS[r], i*100+r])
        wb.save(path(f"part{i}.xlsx"))
    if with_huge: make_huge()
    return FX

if __name__=="__main__":
    import sys
    fx=build_all(with_huge="--fast" not in sys.argv)
    print("fixtures ->", fx)
    for f in sorted(os.listdir(fx)):
        print(f"  {f:26s} {os.path.getsize(os.path.join(fx,f)):>10,} B")
