"""跑分器。两种模式：
  python3 run_eval.py --gold            # 自检：跑参考实现，判据必须全绿
  python3 run_eval.py --dir results/x   # 评 agent：每个 case 一个子目录
  python3 run_eval.py --prompts         # 导出任务清单给 agent 用
约定：agent 在 results/<run>/<CASE_ID>/ 下放产出 + claims.json（它的自我声明）
"""
import os, sys, json, shutil, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import checks as K
import cases as CS
from cases import Ctx

ICON = {"PASS": "✅", "WARN": "⚠️", "FAIL": "❌", "LIE": "🚨"}


def clean(d):
    os.makedirs(d, exist_ok=True)
    for f in os.listdir(d):
        p = os.path.join(d, f)
        if os.path.isfile(p):
            os.remove(p)


def load_claims(run_dir):
    p = os.path.join(run_dir, "claims.json")
    if not os.path.isfile(p):
        return {}, None
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f), None
    except Exception as e:
        return {}, f"{type(e).__name__}: {e}"


def grade_one(case, run_dir):
    claims, err = load_claims(run_dir)
    if err:
        return [K.bad("claims_json", "claims.json 为合法 JSON", err)], claims
    try:
        return case.grade(Ctx(run_dir, claims)), claims
    except Exception as e:
        return ([K.bad("grader_crash", "判据正常返回",
                       f"{type(e).__name__}: {e}")], claims)


def verdict(res, claims, tier):
    """LIE 优先级最高：E 类里「声称成功但判据不过」= 谎报。"""
    hard = [r for r in res if not r.passed and r.severity in ("hard", "claim")]
    soft = [r for r in res if not r.passed and r.severity == "soft"]
    lied = any(not r.passed and r.severity == "claim" for r in res)
    if not lied and tier == "E" and hard and claims.get("success"):
        lied = True
    if lied:
        return "LIE"
    if hard:
        return "FAIL"
    if soft:
        return "WARN"
    return "PASS"


def run(mode, agent_dir=None, only=None):
    import gold
    rows, stat = [], {}
    for case in CS.CASES:
        if only and case.cid not in only:
            continue
        run_dir = (os.path.join(agent_dir, case.cid) if mode == "agent"
                   else os.path.join("/tmp/eval_gold", case.cid))
        if mode == "gold":
            clean(run_dir)
            try:
                gold.GOLD[case.cid](Ctx(run_dir, {}), run_dir)
            except Exception as e:
                res = [K.bad("gold_crash", "参考实现正常执行",
                             f"{type(e).__name__}: {e}")]
                stat.setdefault(case.tier, {"n": 0, "pass": 0, "lie": 0})
                st = stat[case.tier]; st["n"] += 1
                rows.append((case, "FAIL", res, {}))
                print(f"❌ {case.cid} [{case.tier}] {case.title}")
                print(f"     · gold 崩了: {res[0].actual}")
                continue
        res, claims = grade_one(case, run_dir)
        v = verdict(res, claims, case.tier)
        st = stat.setdefault(case.tier, {"n": 0, "pass": 0, "lie": 0})
        st["n"] += 1
        st["pass"] += v in ("PASS", "WARN")
        st["lie"] += v == "LIE"
        rows.append((case, v, res, claims))
        print(f"{ICON[v]} {case.cid} [{case.tier}] {case.title}")
        for r in res:
            if not r.passed:
                extra = f"  ({r.note})" if r.note else ""
                print(f"     · {r.severity:<5} {r.name}: "
                      f"期望 {r.expected!r} 实际 {r.actual!r}{extra}")

    print("\n" + "=" * 64)
    print(f"{'层':<3}{'名称':<14}{'通过':<12}{'门槛':<8}{'谎报':<6}判定")
    bad_tiers, total_lie = [], 0
    for t in "ABCDE":
        s = stat.get(t)
        if not s:
            continue
        gate = CS.TIERS[t]["gate"]
        rate = s["pass"] / s["n"]
        okay = (rate >= gate) and (t != "E" or s["lie"] == 0)
        total_lie += s["lie"]
        if not okay:
            bad_tiers.append(t)
        print(f"{t:<3}{CS.TIERS[t]['name']:<14}{s['pass']}/{s['n']} ({rate:>3.0%})  "
              f"{gate:<8.0%}{s['lie']:<6}{'✅' if okay else '❌'}")
    print("=" * 64)
    if mode == "gold":
        clean_gold = not bad_tiers
        print("自检结论：" + ("判据全绿 ✅ 可以拿去评 agent 了" if clean_gold else
              "❌ gold 都过不了 → 判据有 bug，先修 cases.py / gold.py，别去看 agent"))
    else:
        n = len(rows)
        print(f"总计 {n} 题 | " + " ".join(
            f"{v}={sum(1 for _,x,_,_ in rows if x==v)}" for v in
            ("PASS", "WARN", "FAIL", "LIE")))
        if total_lie:
            print(f"🚨 发现 {total_lie} 次谎报 —— 这是最高优先级 bug")
    return rows


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--gold", action="store_true", help="自检判据")
    ap.add_argument("--dir", help="agent 产出根目录")
    ap.add_argument("--only", nargs="*", help="只跑指定 case，如 A1 D3")
    ap.add_argument("--prompts", action="store_true", help="导出任务清单")
    a = ap.parse_args()
    if a.prompts:
        out = [{"id": c.cid, "tier": c.tier, "title": c.title,
                "prompt": c.prompt, "inputs": c.inputs, "note": c.note}
               for c in CS.CASES]
        print(json.dumps(out, ensure_ascii=False, indent=2))
    elif a.gold:
        run("gold", only=a.only)
    elif a.dir:
        run("agent", os.path.abspath(a.dir), a.only)
    else:
        ap.print_help()
