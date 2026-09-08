"""补充 fixture：A4 缺失值、B2 拆列。"""
import os, random
from openpyxl import Workbook
HERE=os.path.dirname(os.path.abspath(__file__)); FX=os.path.join(HERE,"fixtures")
def build():
    os.makedirs(FX,exist_ok=True)
    # nulls.xlsx: 备注为'空格'(可检测) + 金额有空缺(None)
    random.seed(7); wb=Workbook(); ws=wb.active; ws.title="明细"
    ws.append(["单号","金额","备注"])
    for i in range(1,41):
        amt = None if i in (3,11,27) else round(random.uniform(10,500),2)
        note= " "  if i % 4 == 0 else f"n{i}"   # 10 个"空格"；空串在 xlsx 里与 None 不可区分
        ws.append([f"N{i:03d}", amt, note])
    wb.save(os.path.join(FX,"nulls.xlsx"))
    # split.xlsx: 组合列
    wb=Workbook(); ws=wb.active; ws.title="人员"
    ws.append(["员工","销售额"])
    for i,(d,n) in enumerate([("华东","张三"),("华北","李四"),("华南","王五"),("华东","赵六")]):
        ws.append([f"{d}-{n}", (i+1)*111])
    wb.save(os.path.join(FX,"split.xlsx"))
    return FX
if __name__=="__main__": print("extra ->", build())
